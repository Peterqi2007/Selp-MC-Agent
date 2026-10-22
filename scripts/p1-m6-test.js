'use strict';

/**
 * `npm run p1:m6:test` - offline contracts for the M6 live chat wiring.
 *
 * It covers the pieces that were previously only tested in isolation:
 *   - ordinary-chat participation can speak or deliberately stay silent;
 *   - duplicate incoming lines are dropped before a model call;
 *   - a reply to a superseded message is refused by the request lifecycle;
 *   - the single reply() path still applies ConversationState rate/duplicate rules;
 *   - a pending proposal accepts/rejects only a standalone explicit yes/no.
 *
 * No client, no network, no model calls.
 */

const assert = require('assert');
const http = require('http');
const { ConversationState } = require('../src/chat/conversation');
const { reply } = require('../src/chat/reply');
const { DialogueRouter } = require('../src/chat/dialogueRouter');
const { LlmCore } = require('../src/llm');
const { startStatusServer } = require('../src/web/statusServer');
const {
  ChatParticipation,
  parseParticipation,
  participationPrompt
} = require('../src/chat/chatParticipation');
const { ProposalChat, classifyAnswer } = require('../src/chat/proposalChat');

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const results = [];

function check(name, fn) {
  try {
    const outcome = fn();
    if (outcome && typeof outcome.then === 'function') {
      return outcome.then(
        () => {
          results.push({ name, ok: true });
          process.stdout.write(`  PASS  ${name}\n`);
        },
        (err) => {
          results.push({ name, ok: false, detail: err.message });
          process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
        }
      );
    }
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
  }
  return Promise.resolve();
}

function request(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {}
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* plain text */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeReplyContext(conversation) {
  const sent = [];
  const ctx = {
    cfg: { agent: { chat: { replyInGame: true, maxChars: 100, minReplyGapMs: 0 } } },
    body: { chat: async (text) => sent.push(text) },
    conversation,
    log: silent
  };
  return { ctx, sent, reply: (text, options) => reply(ctx, text, options) };
}

function makeParticipation(options = {}) {
  const conversation = options.conversation || new ConversationState({ minGapMs: 0, dedupeMs: 30000 });
  const { ctx, sent, reply: replyFn } = makeReplyContext(conversation);
  const calls = [];
  const complete = async (request) => {
    calls.push(request);
    if (typeof options.complete === 'function') return options.complete(request, calls.length);
    return '{"respond":true,"text":"收到"}';
  };
  const participation = new ChatParticipation({
    ctx,
    enabled: true,
    conversation,
    reply: replyFn,
    complete,
    persona: 'Test persona',
    maxChars: 100,
    historyLimit: 4,
    log: silent
  });
  return { participation, conversation, sent, calls };
}

(async () => {
  process.stdout.write('P1 M6 chat wiring test\n\n');

  process.stdout.write('1. participation speak / silence\n');
  {
    const fixture = makeParticipation();
    await check('a respond=true decision goes through reply with a conversation request id', async () => {
      const handled = fixture.participation.handle({ from: 'Alice', text: '有人一起挖矿吗' });
      assert(handled.queued);
      await fixture.participation.queue;
      assert.deepStrictEqual(fixture.sent, ['收到']);
      assert(fixture.calls[0].system.includes('cannot execute tasks'));
      assert(fixture.calls[0].system.includes('stay silent'));
      assert.strictEqual(fixture.participation.stats.replied, 1);
    });

    const silentFixture = makeParticipation({ complete: async () => '{"respond":false}' });
    await check('respond=false is a deliberate silence and sends nothing', async () => {
      silentFixture.participation.handle({ from: 'Bob', text: '今天天气不错' });
      await silentFixture.participation.queue;
      assert.deepStrictEqual(silentFixture.sent, []);
      assert.strictEqual(silentFixture.participation.stats.silent, 1);
    });

    const malformedFixture = makeParticipation({ complete: async () => 'not json' });
    await check('malformed model output is silence, never a guessed action', async () => {
      malformedFixture.participation.handle({ from: 'Bob', text: '你好' });
      await malformedFixture.participation.queue;
      assert.deepStrictEqual(malformedFixture.sent, []);
      assert.strictEqual(malformedFixture.participation.stats.silent, 1);
    });

    await check('the participation prompt exposes no action tool surface', () => {
      const prompt = participationPrompt({
        persona: 'p',
        memories: [],
        recent: [],
        from: 'Alice',
        maxChars: 80
      });
      assert(prompt.includes('may only speak or stay silent'));
      assert(!/do_task|do_skill|go_to|"stop"/.test(prompt));
      assert(parseParticipation('{"respond":true,"text":"x"}').respond === true);
      assert(parseParticipation('```json\n{"respond":false}\n```').respond === false);
    });
  }

  process.stdout.write('\n2. dedupe and stale request\n');
  {
    const fixture = makeParticipation();
    await check('a duplicate incoming line is dropped before any model call', async () => {
      assert(fixture.participation.handle({ from: 'Alice', text: 'hi' }).queued);
      assert.strictEqual(fixture.participation.handle({ from: 'Alice', text: 'hi' }).reason, 'duplicate');
      await fixture.participation.queue;
      assert.strictEqual(fixture.calls.length, 1);
      assert.strictEqual(fixture.participation.stats.deduped, 1);
    });

    const gate = deferred();
    const staleFixture = makeParticipation({
      complete: async (request, callNumber) => {
        if (callNumber === 1) return gate.promise;
        return '{"respond":true,"text":"第二条"}';
      }
    });
    staleFixture.participation.handle({ from: 'Alice', text: '第一条' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    staleFixture.participation.handle({ from: 'Alice', text: '第二条' });
    gate.resolve('{"respond":true,"text":"第一条"}');
    await staleFixture.participation.queue;
    await check('a reply whose request was superseded is refused', () => {
      assert.deepStrictEqual(staleFixture.sent, ['第二条']);
      assert(staleFixture.participation.stats.stale >= 1);
    });
  }

  process.stdout.write('\n3. single reply guard\n');
  {
    const fixture = makeParticipation({
      complete: async (request, callNumber) => `{"respond":true,"text":"同一句"}` 
    });
    await check('identical replies are deduped by ConversationState, not sent twice', async () => {
      fixture.participation.handle({ from: 'Alice', text: '一' });
      await fixture.participation.queue;
      fixture.participation.handle({ from: 'Alice', text: '二' });
      await fixture.participation.queue;
      assert.deepStrictEqual(fixture.sent, ['同一句']);
      assert.strictEqual(fixture.participation.stats.dropped, 1);
    });
  }

  process.stdout.write('\n4. proposal chat answers\n');
  {
    const accepted = [];
    const rejected = [];
    const brain = {
      proposals: {
        pending: () => ({ id: 'p1', candidate: { type: 'task' } })
      },
      acceptProposal: async () => {
        accepted.push('accepted');
        return { ok: true };
      },
      rejectProposal: async () => {
        rejected.push('rejected');
        return { ok: true };
      }
    };
    const proposal = new ProposalChat({ brain, log: silent });
    await check('an explicit standalone yes accepts through the existing lifecycle', async () => {
      assert.strictEqual(classifyAnswer('好').answer, 'accept');
      assert.strictEqual(classifyAnswer('不要').answer, 'reject');
      assert.strictEqual(classifyAnswer('好，去吧').answer, null);
      const handled = proposal.handle({ from: 'Alice', text: '好的' });
      assert(handled.handled);
      assert.strictEqual(handled.answer, 'accept');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepStrictEqual(accepted, ['accepted']);
    });

    await check('an explicit no rejects; ambiguous chat does not consent', async () => {
      proposal.handle({ from: 'Alice', text: '不' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepStrictEqual(rejected, ['rejected']);
      const unclear = proposal.handle({ from: 'Alice', text: '再说吧' });
      assert.strictEqual(unclear.handled, false);
    });

    await check('with no pending proposal, chat is not an answer surface', () => {
      const empty = new ProposalChat({
        brain: { proposals: { pending: () => null }, acceptProposal: async () => ({ ok: true }) },
        log: silent
      });
      assert.strictEqual(empty.handle({ from: 'A', text: '好' }).reason, 'no-pending');
    });
  }

  process.stdout.write('\n5. dialogue routing (harness / planner-first)\n');
  {
    const makeCtx = () => {
      const said = [];
      const ctx = {
        cfg: { agent: { chat: { maxChars: 100 } } },
        body: { snapshot: () => ({ position: { x: 1, y: 64, z: 2 } }) },
        reply: async (text, options) => {
          said.push({ text, options });
          return true;
        },
        llm: { handle: async (text, options) => ({ kind: 'input', text, options }) }
      };
      return { ctx, said };
    };
    const makeBridge = (results) => {
      const forwards = [];
      const binds = [];
      return {
        forwards,
        binds,
        async forward(text, meta) {
          forwards.push({ text, meta });
          return results.shift() || { ok: true, forwarded: true };
        },
        async bind(agentId) {
          binds.push(agentId);
          return { ok: true, agentId };
        }
      };
    };

    {
      const { ctx } = makeCtx();
      let local = 0;
      ctx.llm.handle = async () => {
        local += 1;
        return { kind: 'input' };
      };
      const bridge = makeBridge([]);
      const router = new DialogueRouter({ ctx, mode: 'harness', bridge, log: silent });
      const routed = await router.route('挖 4 个泥土', {
        source: 'chat',
        speaker: '玩家',
        agentPosition: { x: 1, y: 64, z: 2 }
      });
      await check('harness mode forwards the line to the action brain and never calls the local planner', () => {
        assert.strictEqual(routed.ok, true);
        assert.strictEqual(routed.mode, 'harness');
        assert.strictEqual(local, 0);
        assert.strictEqual(bridge.forwards.length, 1);
        assert.match(bridge.forwards[0].text, /\[MINECRAFT PLAYER REQUEST\]/);
        assert.match(bridge.forwards[0].text, /text: "挖 4 个泥土"/);
        assert.match(bridge.forwards[0].text, /agentPosition: 1,64,2/);
        assert.strictEqual(ctx.lastDialogueRoute.mode, 'harness');
      });
    }

    {
      const { ctx } = makeCtx();
      ctx.llm.handle = async () => {
        throw new Error('the local planner must not run in harness mode');
      };
      const bridge = makeBridge([{ ok: false, reason: 'no-live-agent' }, { ok: true, forwarded: true }]);
      const router = new DialogueRouter({ ctx, mode: 'harness', bridge, agentId: 'session-x', log: silent });
      const routed = await router.route('hi', { source: 'chat' });
      await check('a lost action-brain binding is retried once for the configured id', () => {
        assert.strictEqual(routed.ok, true);
        assert.deepStrictEqual(bridge.binds, ['session-x']);
        assert.strictEqual(bridge.forwards.length, 2);
      });
    }

    {
      const { ctx, said } = makeCtx();
      const bridge = makeBridge([{ ok: false, reason: 'no-live-agent' }]);
      const router = new DialogueRouter({ ctx, mode: 'harness', bridge, log: silent });
      const routed = await router.route('hi', { source: 'chat' });
      await check('an unbound action brain is reported and never falls back to local execution', () => {
        assert.strictEqual(routed.ok, false);
        assert.match(said[0].text, /未绑定/);
        assert.strictEqual(bridge.forwards.length, 1);
      });
    }

    {
      const { ctx } = makeCtx();
      let local = 0;
      ctx.llm.handle = async (text, options) => {
        local += 1;
        return { kind: 'input', text, options, action: { type: 'task' } };
      };
      const bridge = makeBridge([]);
      const router = new DialogueRouter({ ctx, mode: 'planner-first', bridge, log: silent });
      const routed = await router.route('砍 8 根木头', { source: 'chat' });
      await check('planner-first keeps an understood local task local', () => {
        assert.strictEqual(routed.mode, 'planner-first');
        assert.strictEqual(local, 1);
        assert.strictEqual(bridge.forwards.length, 0);
      });
    }

    {
      const { ctx, said } = makeCtx();
      ctx.llm.handle = async () => ({ kind: 'understood-nothing', handoff: true });
      const bridge = makeBridge([]);
      const router = new DialogueRouter({ ctx, mode: 'planner-first', bridge, log: silent });
      const routed = await router.route('帮我建个红石自动门', { source: 'chat' });
      await check('planner-first hands an unresolved line to the action brain', () => {
        assert.strictEqual(routed.handoff, true);
        assert.strictEqual(routed.ok, true);
        assert.strictEqual(bridge.forwards.length, 1);
        assert.match(bridge.forwards[0].text, /红石自动门/);
        assert.strictEqual(said.length, 0, 'no "did not understand" line when handing off');
      });
    }

    {
      const { ctx } = makeCtx();
      let local = 0;
      ctx.llm.handle = async () => {
        local += 1;
        return { kind: 'input' };
      };
      const bridge = makeBridge([]);
      const router = new DialogueRouter({ ctx, mode: 'planner', bridge, log: silent });
      const routed = await router.route('hi', { source: 'chat' });
      await check('planner mode keeps the legacy local-only route', () => {
        assert.strictEqual(routed.mode, 'planner');
        assert.strictEqual(local, 1);
        assert.strictEqual(bridge.forwards.length, 0);
      });
    }

    {
      const { ctx } = makeCtx();
      const llm = new LlmCore(ctx, { enabled: false }, { log: silent });
      const record = await llm.handle('zzzzzz', { onUnresolved: 'defer' });
      await check('llm.handle(onUnresolved:defer) returns handoff without saying "did not understand"', () => {
        assert.strictEqual(record.kind, 'understood-nothing');
        assert.strictEqual(record.handoff, true);
      });
    }
  }

  process.stdout.write('\n6. /say + panel dialogue route\n');
  {
    const said = [];
    const routed = [];
    const ctx = {
      cfg: { agent: { chat: { maxChars: 100, dialogueTrigger: '@T' } } },
      body: { snapshot: () => ({ position: { x: 1, y: 64, z: 2 } }) },
      reply: async (text, options) => {
        said.push({ text, options });
        return true;
      },
      dialogueRouter: {
        async route(text, meta) {
          routed.push({ text, meta });
          return { ok: true, mode: 'harness', forwarded: { ok: true } };
        }
      },
      chat: { handle: async () => ({ ok: true, command: 'stub' }) }
    };
    const started = startStatusServer(ctx, { port: 0, host: '127.0.0.1' });
    await new Promise((resolve, reject) => {
      if (started.server.listening) return resolve();
      started.server.once('listening', resolve);
      started.server.once('error', reject);
    });
    const port = started.server.address().port;
    try {
      const sent = await request(port, 'POST', '/say', { text: '收到，开始挖' });
      const empty = await request(port, 'POST', '/say', {});
      const panel = await request(port, 'POST', '/command', { command: '@T 挖 4 个泥土' });
      await check('POST /say speaks through reply() and rejects empty text', () => {
        assert.strictEqual(sent.status, 200);
        assert.strictEqual(sent.body.sent, true);
        assert.deepStrictEqual(said[0].text, '收到，开始挖');
        assert.strictEqual(empty.status, 400);
      });
      await check('the panel dialogue route uses the same DialogueRouter', () => {
        assert.strictEqual(panel.status, 200);
        assert.strictEqual(panel.body.routed, 'dialogue');
        assert.strictEqual(panel.body.mode, 'harness');
        assert.strictEqual(routed.length, 1);
        assert.strictEqual(routed[0].text, '挖 4 个泥土');
      });
    } finally {
      await new Promise((resolve) => started.server.close(resolve));
    }
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`P1 M6 chat wiring: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const failure of failed) process.stdout.write(`  FAILED: ${failure.name} - ${failure.detail}\n`);
    process.exitCode = 1;
  }
})().catch((err) => {
  process.stderr.write(`p1-m6-test crashed: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
