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
const { ConversationState } = require('../src/chat/conversation');
const { reply } = require('../src/chat/reply');
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
