'use strict';

/**
 * `npm run p1:m7:test` - the remaining M7 wiring contracts.
 *
 * Two gaps were left after M3:
 *   - R3: the TaskSlot failure ledger (strikes/quarantine/blocked goal) was not persisted;
 *   - A30: usage was aggregated, and a missing provider usage object was silently counted
 *     as 0 instead of `unknown`.
 *
 * This suite proves the persistence round-trip and that the per-request JSONL ledger
 * distinguishes ok / missing-usage / error without inventing zeros.
 *
 * No client, no network: the LLM transport is an injected fake.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { TaskSlot } = require('../src/core/taskSlot');
const { captureState, restoreState } = require('../src/core/sessionState');
const { UsageLedger, normalizeUsage } = require('../src/llm/usageLedger');
const { LlmClient } = require('../src/llm/client');

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

function fakeFetch(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  });
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

(async () => {
  process.stdout.write('P1 M7 wiring test\n\n');

  process.stdout.write('1. TaskSlot failure ledger persistence\n');
  {
    const slot = new TaskSlot({}, { log: silent });
    slot.failCounts.set('mine:stone', 2);
    slot.quarantine.set('mine:stone', 1234567890);
    slot.blockedGoal = { name: 'mine:stone', at: 1000, reason: 'noPath' };
    slot._progressSeen.set('mine:stone', 4);
    slot._stalls.set('mine:stone', 1);
    const snapshot = slot.toJSON();
    const restored = new TaskSlot({}, { log: silent });
    const restoredOk = restored.restore(snapshot);

    await check('strikes, quarantine, blocked goal and progress counters round-trip', () => {
      assert(restoredOk);
      assert.strictEqual(restored.failCounts.get('mine:stone'), 2);
      assert.strictEqual(restored.quarantine.get('mine:stone'), 1234567890);
      assert.deepStrictEqual(restored.blockedGoal, { name: 'mine:stone', at: 1000, reason: 'noPath' });
      assert.strictEqual(restored._progressSeen.get('mine:stone'), 4);
      assert.strictEqual(restored._stalls.get('mine:stone'), 1);
    });

    await check('malformed ledger entries are dropped, not trusted', () => {
      const bad = new TaskSlot({}, { log: silent });
      bad.restore({
        failCounts: [['ok', 1], ['bad', 'x'], ['negative', -1]],
        quarantine: [['ok', 10], ['bad', 'later']],
        progressSeen: [['ok', 2]],
        stalls: [['ok', 1]]
      });
      assert.strictEqual(bad.failCounts.get('ok'), 1);
      assert.strictEqual(bad.failCounts.has('bad'), false);
      assert.strictEqual(bad.failCounts.has('negative'), false);
      assert.strictEqual(bad.quarantine.has('bad'), false);
    });

    await check('sessionState captures and restores the slot ledger', () => {
      const fakeBrain = { slot: new TaskSlot({}, { log: silent }) };
      fakeBrain.slot.failCounts.set('chop-wood', 3);
      const captured = captureState(fakeBrain);
      assert(captured.taskSlot, 'taskSlot must be captured');
      assert.strictEqual(captured.taskSlot.failCounts[0][0], 'chop-wood');
      const target = { slot: new TaskSlot({}, { log: silent }) };
      const restoredState = restoreState(target, captured);
      assert.strictEqual(restoredState.restored.taskSlot, true);
      assert.strictEqual(target.slot.failCounts.get('chop-wood'), 3);
    });
  }

  process.stdout.write('\n2. usage ledger: ok / missing / error\n');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-m7-usage-'));
    const file = path.join(dir, 'usage.jsonl');
    const ledger = new UsageLedger({ file, now: () => 1000, log: silent });

    await check('normalizeUsage keeps absent fields null and never invents zeros', () => {
      assert.deepStrictEqual(normalizeUsage({ prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }), {
        promptTokens: 3,
        completionTokens: 4,
        totalTokens: 7
      });
      assert.strictEqual(normalizeUsage({}), null);
      assert.strictEqual(normalizeUsage(null), null);
      const partial = normalizeUsage({ total_tokens: 5 });
      assert.strictEqual(partial.promptTokens, null);
      assert.strictEqual(partial.completionTokens, null);
      assert.strictEqual(partial.totalTokens, 5);
    });

    await check('a successful call with usage is attributable and recorded as ok', async () => {
      const client = new LlmClient({
        baseUrl: 'http://fake',
        apiKey: 'test-key',
        model: 'fake-model',
        fetchImpl: fakeFetch({
          model: 'fake-model',
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 }
        }),
        usageLedger: ledger
      });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'hi' }],
        usageContext: { requestId: 'req-1', kind: 'chat' }
      });
      assert(result.ok);
      const lines = readLines(file);
      const entry = lines.find((line) => line.requestId === 'req-1');
      assert(entry, 'requestId must appear in the ledger');
      assert.strictEqual(entry.kind, 'chat');
      assert.strictEqual(entry.status, 'ok');
      assert.deepStrictEqual(entry.usage, { promptTokens: 3, completionTokens: 4, totalTokens: 7 });
      assert.strictEqual(entry.model, 'fake-model');
    });

    await check('a successful response without usage is missing-usage/unknown, not zero', async () => {
      const client = new LlmClient({
        baseUrl: 'http://fake',
        apiKey: 'test-key',
        model: 'fake-model',
        fetchImpl: fakeFetch({
          choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
          usage: {}
        }),
        usageLedger: ledger
      });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'hi' }],
        usageContext: { requestId: 'req-missing', kind: 'proactive:test' }
      });
      assert(result.ok);
      const entry = readLines(file).find((line) => line.requestId === 'req-missing');
      assert.strictEqual(entry.status, 'missing-usage');
      assert.strictEqual(entry.usage, null);
    });

    await check('an HTTP failure is recorded as error with no fabricated usage', async () => {
      const client = new LlmClient({
        baseUrl: 'http://fake',
        apiKey: 'test-key',
        model: 'fake-model',
        fetchImpl: fakeFetch({ error: 'quota' }, 429),
        usageLedger: ledger
      });
      const result = await client.complete({
        messages: [{ role: 'user', content: 'hi' }],
        usageContext: { requestId: 'req-error', kind: 'judge' }
      });
      assert.strictEqual(result.ok, false);
      const entry = readLines(file).find((line) => line.requestId === 'req-error');
      assert.strictEqual(entry.status, 'error');
      assert.strictEqual(entry.usage, null);
      assert(entry.error.includes('HTTP 429'));
    });

    await check('the ledger can be disabled without writing a file', async () => {
      const disabledFile = path.join(dir, 'disabled.jsonl');
      const disabled = new UsageLedger({ file: disabledFile, enabled: false, log: silent });
      disabled.record({ requestId: 'x', ok: true, usage: { total_tokens: 1 } });
      assert.strictEqual(fs.existsSync(disabledFile), false);
      assert.strictEqual(disabled.status().records, 0);
    });

    await check('the live LlmCore status exposes the ledger counters', async () => {
      const { LlmCore } = require('../src/llm');
      const core = new LlmCore(
        { cfg: {}, memory: { summary: () => ({}) }, chatListener: { recent: [] } },
        { apiKey: 'x', baseUrl: 'http://fake', model: 'fake' },
        { client: new LlmClient({ baseUrl: 'http://fake', apiKey: 'x', model: 'fake', fetchImpl: fakeFetch({ choices: [] }), usageLedger: ledger }), usageLedger: ledger }
      );
      assert.strictEqual(core.status().usage.records >= 1, true);
      assert.strictEqual(core.status().usage.file, file);
    });

    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`P1 M7 wiring: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const failure of failed) process.stdout.write(`  FAILED: ${failure.name} - ${failure.detail}\n`);
    process.exitCode = 1;
  }
})().catch((err) => {
  process.stderr.write(`p1-m7-test crashed: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
