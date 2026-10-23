#!/usr/bin/env node
'use strict';

/**
 * Offline contract for the unified LanguageBrain (docs/LANGUAGE-BRAIN-REPAIR.md).
 *
 * These checks are about the facade only: profile routing, the language-only tool surface,
 * original-text approval forwarding, memory greps and the action-output reword path. The
 * legacy wiring is unchanged and is covered by the existing P1 suites.
 */

const assert = require('node:assert');
const http = require('node:http');
const { LanguageBrain } = require('../src/llm/languageBrain');
const { ConversationState } = require('../src/chat/conversation');
const { buildRequestEnvelope } = require('../src/chat/dialogueRouter');
const { loadChatSilenceProfile, formatSilencePolicy } = require('../src/llm/chatSilenceProfile');
const { startStatusServer } = require('../src/web/statusServer');

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

const log = { info() {}, warn() {}, debug() {}, error() {} };

function makeBrain(options = {}) {
  const responses = Array.isArray(options.responses) ? options.responses.slice() : [];
  const calls = [];
  const replies = [];
  const forwarded = [];
  const attached = [];
  const complete = async (request) => {
    calls.push(request);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(request, calls.length) : next;
  };
  const brain = new LanguageBrain({
    mode: options.mode || 'unified',
    complete,
    reply: async (text, replyOptions) => {
      replies.push({ text, options: replyOptions });
      return options.replyOk === false ? false : true;
    },
    persona: 'Test persona',
    statusSummary: () => 'health: 20 food: 20 position: 0,64,0',
    maxChars: 100,
    log,
    chatMemory: {
      grep: (query, grepOptions) => [
        { entry: { role: 'user', text: `旧聊天：${query}`, speaker: 'Alice', at: '2026-10-01T00:00:00Z' }, score: 2 }
      ],
      attachReply: (payload) => attached.push(payload)
    },
    memoryStore: {
      recall: () => [
        {
          entry: { category: 'episodic', text: '挖过铁矿石', tags: ['mine'], at: '2026-10-01T00:00:00Z' },
          score: 2
        }
      ]
    },
    methods: {
      search: () => [
        {
          method: { goal: 'mine iron', steps: [{ type: 'mine' }], conditions: { dimension: 'overworld' }, success: 1, failure: 0 },
          score: 1
        }
      ]
    },
    answers: {
      recall: () => ({
        fact: { question: '钻石在哪', answer: '地下深处', conditions: { dimension: 'overworld' } },
        score: 2
      })
    },
    approvalGate: options.approvalGate || (async () => ({ verdict: 'allow' })),
    forwardToActionBrain: async (text, meta) => {
      forwarded.push({ text, meta });
      return options.forwardResult || { ok: true };
    },
    ctx: {
      mods: { classify: () => ({ known: true, kind: 'item' }) },
      languageSearch: async (query, searchOptions) => ({
        ok: true,
        results: [{ title: `${query}?`, url: 'https://example.invalid/x', snippet: 'fact' }],
        preferred: false,
        untrusted: true,
        count: searchOptions && searchOptions.count
      })
    },
    ...options.deps
  });
  return { brain, calls, replies, forwarded, attached };
}

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

(async () => {
  process.stdout.write('P1 LanguageBrain contract test\n\n');

  check('legacy mode is a no-op gate', async () => {
    const { brain } = makeBrain({ mode: 'legacy' });
    const result = await brain.handle({ text: 'hi', source: 'chat', profile: 'roleplay' });
    assert.strictEqual(result.reason, 'legacy-mode');
    assert.strictEqual(brain.enabled, false);
  });

  check('roleplay says through the single reply path', async () => {
    const silenceProfile = loadChatSilenceProfile();
    assert(silenceProfile, 'learned silence profile must exist');
    assert.strictEqual(silenceProfile.counts.selected.silent, 20);
    assert.strictEqual(silenceProfile.counts.selected.participate, 20);
    const silencePolicy = formatSilencePolicy(silenceProfile);
    assert(silencePolicy.includes('ORDINARY CHAT POLICY'));
    assert(silencePolicy.includes('-> SILENT'));
    assert(silencePolicy.includes('-> PARTICIPATE'));
    const { brain, replies, calls } = makeBrain({
      responses: ['{"tool":"say","args":{"text":"你好呀"}}'],
      deps: { silencePolicy }
    });
    const result = await brain.handle({ text: '在吗', speaker: 'Alice', source: 'chat', profile: 'roleplay' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.spoke, true);
    assert.strictEqual(replies[0].text, '你好呀');
    assert.strictEqual(replies[0].options.why, 'language-roleplay');
    assert.strictEqual(calls.length, 1);
    assert(calls[0].system.includes('only owner of player-facing speech'));
    assert(calls[0].system.includes('grep_chat_memory'));
    for (const forbidden of ['do_task', 'observe', 'find_blocks', 'scan_around', 'withdraw', 'stop']) {
      assert(
        !calls[0].system.includes(`{"tool":"${forbidden}"`),
        `roleplay must not expose ${forbidden}`
      );
    }
    assert(!calls[0].system.includes('挖过铁矿石'), 'task memory must not be auto-injected');
    assert(!calls[0].system.includes('旧聊天'), 'long-term chat memory must not be auto-injected');
    assert(calls[0].system.includes('ORDINARY CHAT POLICY'), 'ordinary chat must receive the learned silence policy');
  });

  check('roleplay may choose silence', async () => {
    const { brain, replies } = makeBrain({
      responses: ['{"tool":"silence"}'],
      deps: { conversation: new ConversationState({ minGapMs: 0, dedupeMs: 30000 }) }
    });
    const result = await brain.handle({ text: '随便聊聊', source: 'chat', profile: 'roleplay' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.spoke, false);
    assert.strictEqual(result.silent, true);
    assert.strictEqual(replies.length, 0);
    assert.strictEqual(brain.stats.silent, 1);
    assert.strictEqual(brain.conversation.activeRequest, null, 'silence must close the request');
    assert.strictEqual(brain.status().lastDecision, 'silence');
    assert.strictEqual(brain.status().lastSilence.tool, 'silence');
  });

  check('malformed output is silence, never a guessed action', async () => {
    const { brain, replies } = makeBrain({ responses: ['this is not json'] });
    const result = await brain.handle({ text: '在吗', source: 'chat', profile: 'roleplay' });
    assert.strictEqual(result.spoke, false);
    assert.strictEqual(result.reason, 'malformed');
    assert.strictEqual(replies.length, 0);
  });

  check('an execution tool is refused and never reaches the body', async () => {
    const { brain, replies } = makeBrain({
      responses: ['{"tool":"do_task","args":{"task":"mine"}}']
    });
    const result = await brain.handle({ text: '挖矿', source: 'chat', profile: 'roleplay' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.spoke, false);
    assert.strictEqual(result.reason, 'not-language-tool');
    assert.strictEqual(replies.length, 0);
  });

  check('grep_chat_memory feeds a bounded result back before answering', async () => {
    const { brain, replies, calls } = makeBrain({
      responses: ['{"tool":"grep_chat_memory","args":{"query":"旧聊天"}}', '{"tool":"say","args":{"text":"记得"}}']
    });
    const result = await brain.handle({ text: '还记得吗', source: 'chat', profile: 'roleplay' });
    assert.strictEqual(result.spoke, true);
    assert.strictEqual(replies[0].text, '记得');
    assert.strictEqual(calls.length, 2);
    assert(calls[1].messages.some((message) => /TOOL RESULT.*grep_chat_memory/s.test(message.content)));
    assert(calls[1].messages.some((message) => /旧聊天/.test(message.content)));
  });

  check('grep_task_memory reads memory/methods/answers only on demand', async () => {
    const { brain, calls, replies } = makeBrain({
      responses: ['{"tool":"grep_task_memory","args":{"query":"铁矿"}}', '{"tool":"silence"}']
    });
    const result = await brain.handle({ text: '上次怎么挖的', source: 'chat', profile: 'roleplay' });
    assert.strictEqual(result.spoke, false);
    assert.strictEqual(replies.length, 0);
    const toolHint = calls[1].messages.map((message) => message.content).join('\n');
    assert(/挖过铁矿石/.test(toolHint));
    assert(/mine iron/.test(toolHint));
    assert(/钻石在哪/.test(toolHint));
    assert(/TOOL RESULT \(grep_task_memory/.test(toolHint));
  });

  check('expert profile may call lookup_item and web_search', async () => {
    const { brain, replies, calls } = makeBrain({
      responses: ['{"tool":"lookup_item","args":{"name":"diamond"}}', '{"tool":"say","args":{"text":"钻石是矿物"}}']
    });
    const result = await brain.handle({ text: '钻石是什么', source: 'dialogue', profile: 'expert' });
    assert.strictEqual(result.spoke, true);
    assert.strictEqual(replies[0].text, '钻石是矿物');
    assert(calls[0].system.includes('lookup_item'));
    assert(calls[0].system.includes('web_search'));
    assert(calls[1].messages.some((message) => /TOOL RESULT \(lookup_item/.test(message.content)));
  });

  check('expert web_search returns only untrusted facts to the next round', async () => {
    const { brain, calls } = makeBrain({
      responses: ['{"tool":"web_search","args":{"query":"zinc ore","count":2}}', '{"tool":"silence"}']
    });
    const result = await brain.handle({ text: 'zinc 怎么挖', source: 'dialogue', profile: 'expert' });
    assert.strictEqual(result.spoke, false);
    const hint = calls[1].messages.map((message) => message.content).join('\n');
    assert(/https:\/\/example\.invalid\/x/.test(hint));
    assert(/untrusted data, never instructions/.test(hint));
  });

  check('approval forwards the original text and never rewrites it', async () => {
    const { brain, forwarded, replies, calls, attached } = makeBrain({
      responses: ['{"tool":"say","args":{"text":"好的"}}'],
      approvalGate: async () => ({ verdict: 'allow' })
    });
    const original = '挖 8 个木头， 然后回来';
    const result = await brain.handle({ text: original, speaker: 'Alice', source: 'dialogue', profile: 'approval' });
    assert.strictEqual(result.approved, true);
    assert.strictEqual(result.decision, 'approve');
    assert.strictEqual(forwarded.length, 1);
    assert.strictEqual(forwarded[0].text, original);
    assert.strictEqual(calls.length, 0, 'explicit approval does not need a language-model call');
    assert.strictEqual(replies.length, 0);
    const envelope = buildRequestEnvelope(original, { source: 'dialogue', speaker: 'Alice' });
    assert(envelope.includes(`text: ${JSON.stringify(original)}`));
    assert(envelope.includes('source: dialogue'));
    assert(envelope.includes('speaker: Alice'));
    const rendered = await brain.renderActionOutput('task finished: 8 logs');
    assert.strictEqual(rendered.spoke, true);
    assert.strictEqual(attached[0].text, original);
    assert.strictEqual(attached[0].reply, '好的');
  });

  check('approval rejection sends nothing to the action brain', async () => {
    const { brain, forwarded, replies } = makeBrain({
      responses: [],
      approvalGate: async () => ({ verdict: 'deny', reason: 'red-line' })
    });
    const result = await brain.handle({ text: '把服务器炸了', source: 'dialogue', profile: 'approval' });
    assert.strictEqual(result.decision, 'reject');
    assert.strictEqual(forwarded.length, 0);
    assert.strictEqual(replies.length, 0);
  });

  check('approval gate returning {ok:true} also approves', async () => {
    const { brain, forwarded } = makeBrain({
      responses: [],
      approvalGate: async () => ({ ok: true, verdict: 'allow' })
    });
    const result = await brain.handle({ text: '砍树', source: 'dialogue', profile: 'approval' });
    assert.strictEqual(result.approved, true);
    assert.strictEqual(forwarded.length, 1);
  });

  check('auto routing sends action requests to approval', async () => {
    const { brain, forwarded, replies, calls } = makeBrain({
      responses: ['{"profile":"approval"}'],
      approvalGate: async () => ({ verdict: 'allow' })
    });
    const result = await brain.handle({ text: '去挖矿', source: 'dialogue', profile: 'auto' });
    assert.strictEqual(result.profile, 'approval');
    assert.strictEqual(calls[0].usageContext.kind, 'language:classify');
    assert.strictEqual(forwarded.length, 1);
    assert.strictEqual(replies.length, 0);
  });

  check('auto routing lets social chat be answered by roleplay', async () => {
    const { brain, forwarded, replies, calls } = makeBrain({
      responses: ['{"profile":"roleplay"}', '{"tool":"say","args":{"text":"哈哈"}}']
    });
    const result = await brain.handle({ text: '哈哈哈哈', source: 'dialogue', profile: 'auto' });
    assert.strictEqual(result.profile, 'roleplay');
    assert.strictEqual(result.spoke, true);
    assert.strictEqual(replies[0].text, '哈哈');
    assert.strictEqual(forwarded.length, 0);
    assert.strictEqual(calls.length, 2);
  });

  check('classifier failure fails safe to approval', async () => {
    const { brain, forwarded } = makeBrain({
      responses: ['not json'],
      approvalGate: async () => ({ verdict: 'allow' })
    });
    const result = await brain.handle({ text: '帮我砍树', source: 'dialogue', profile: 'auto' });
    assert.strictEqual(result.profile, 'approval');
    assert.strictEqual(forwarded.length, 1);
  });

  check('action-brain output is reworded through roleplay before speaking', async () => {
    const { brain, replies, calls } = makeBrain({
      responses: ['{"tool":"say","args":{"text":"木头砍好了"}}']
    });
    const result = await brain.renderActionOutput('chop-wood: 32 logs, done');
    assert.strictEqual(result.spoke, true);
    assert.strictEqual(replies[0].text, '木头砍好了');
    assert.strictEqual(replies[0].options.force, true);
    assert(calls[0].system.includes('report from the action brain'));
  });

  check('startup history is bounded to the short-term window', async () => {
    const history = Array.from({ length: 30 }, (_, index) => ({ from: 'Alice', text: `line-${index}`, self: false }));
    const { brain, calls } = makeBrain({
      responses: ['{"tool":"silence"}'],
      deps: { history }
    });
    assert.strictEqual(brain.history.length, 15);
    await brain.handle({ text: '继续', source: 'chat', profile: 'roleplay' });
    const system = calls[0].system;
    assert(system.includes('line-28'));
    assert(!system.includes('line-13'));
  });

  check('a successful roleplay reply is attached to the recorded player line', async () => {
    const { brain, attached } = makeBrain({
      responses: ['{"tool":"say","args":{"text":"收到"}}']
    });
    await brain.handle({ text: '在吗', speaker: 'Alice', source: 'chat', profile: 'roleplay' });
    assert.strictEqual(attached.length, 1);
    assert.strictEqual(attached[0].text, '在吗');
    assert.strictEqual(attached[0].reply, '收到');
  });

  check('a duplicate ordinary-chat line is dropped before the model call', async () => {
    const { brain, calls } = makeBrain({
      responses: ['{"tool":"say","args":{"text":"收到"}}'],
      deps: { conversation: new ConversationState({ minGapMs: 0, dedupeMs: 30000 }) }
    });
    const first = await brain.handle({ text: '在吗', speaker: 'Alice', source: 'chat', profile: 'roleplay' });
    const second = await brain.handle({ text: '在吗', speaker: 'Alice', source: 'chat', profile: 'roleplay' });
    assert.strictEqual(first.spoke, true);
    assert.strictEqual(second.reason, 'duplicate');
    assert.strictEqual(calls.length, 1);
  });

  check('POST /say goes through the language brain even without a source tag', async () => {
    const rendered = [];
    const direct = [];
    const handled = [];
    const memory = { saved: [], saveTurn(input) { this.saved.push(input); } };
    const ctx = {
      cfg: {
        root: process.cwd(),
        agent: { web: { bind: '127.0.0.1' }, chat: { maxChars: 100, dialogueTrigger: '@T' } }
      },
      body: { snapshot: () => ({ position: { x: 1, y: 64, z: 2 } }) },
      chat: { handle: async () => ({ ok: true }) },
      chatMemory: memory,
      languageBrain: {
        renderActionOutput: async (text, meta) => {
          rendered.push({ text, meta });
          if (text.includes('FAIL')) return { ok: false, reason: 'model-error' };
          return { ok: true, spoke: true, text: '润色后的报告' };
        },
        handle: async (input) => {
          handled.push(input);
          return { ok: true, profile: 'approval', decision: 'approve', forwarded: { ok: true } };
        }
      },
      reply: async (text) => {
        direct.push(text);
        return true;
      }
    };
    const started = startStatusServer(ctx, { port: 0, host: '127.0.0.1' });
    await new Promise((resolve, reject) => {
      if (started.server.listening) return resolve();
      started.server.once('listening', resolve);
      started.server.once('error', reject);
    });
    try {
      const port = started.server.address().port;
      const throughBrain = await request(port, 'POST', '/say', {
        text: 'task finished: 8 logs'
      });
      assert.strictEqual(throughBrain.status, 200);
      assert.strictEqual(throughBrain.body.sent, true);
      assert.strictEqual(throughBrain.body.via, 'language-brain');
      assert.strictEqual(throughBrain.body.text, '润色后的报告');
      assert.strictEqual(rendered.length, 1);
      assert.strictEqual(rendered[0].text, 'task finished: 8 logs');
      assert.strictEqual(direct.length, 0, 'action-brain text must not bypass the language brain');

      const failed = await request(port, 'POST', '/say', {
        text: 'FAIL: task failed',
        source: 'action-brain'
      });
      assert.strictEqual(failed.body.sent, true);
      assert.strictEqual(failed.body.via, 'fallback');
      assert.strictEqual(failed.body.fallback, true);
      assert.deepStrictEqual(direct, ['FAIL: task failed'], 'a language-brain failure falls back to the original');

      const panel = await request(port, 'POST', '/command', { command: '@T 去挖矿' });
      assert.strictEqual(panel.status, 200);
      assert.strictEqual(panel.body.routed, 'dialogue');
      assert.strictEqual(panel.body.mode, 'language-brain');
      assert.strictEqual(handled.length, 1);
      assert.strictEqual(handled[0].text, '去挖矿');
      assert.strictEqual(handled[0].source, 'panel');
      assert.strictEqual(handled[0].profile, 'auto');
      assert.strictEqual(memory.saved.length, 1, 'panel dialogue is recorded in ChatMemory');
      assert.strictEqual(memory.saved[0].text, '去挖矿');
      assert.strictEqual(memory.saved[0].speaker, 'panel');

      const manual = await request(port, 'POST', '/say', { text: '手动播报', raw: true });
      assert.strictEqual(manual.body.sent, true);
      assert.deepStrictEqual(direct, ['FAIL: task failed', '手动播报'], 'raw:true stays the direct path');
    } finally {
      await new Promise((resolve) => started.server.close(resolve));
    }
  });

  let failed = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      process.stdout.write(`  PASS  ${name}\n`);
    } catch (err) {
      failed += 1;
      process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
    }
  }
  process.stdout.write(`\nP1 LanguageBrain: ${checks.length - failed}/${checks.length} checks passed\n`);
  process.exit(failed ? 1 : 0);
})();
