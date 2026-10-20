'use strict';

/**
 * `npm run p1:m4:test` - M4 live wiring contracts.
 *
 * Covers the parts that were only dry-run/offline before 2026-10-18:
 *   - the extended permission list (search/generate/subprocess);
 *   - real candidate code written to disk, real trial in the permissioned child;
 *   - capability RPC, timeout, call budget, cleanup and evidence;
 *   - DeepSeek Search request shape, cache and privacy filter;
 *   - store persistence + generate -> trial -> promote -> rollback.
 *
 * No live Minecraft client and no real model/network: the generation backend and search
 * transport are injected fakes. The sandbox itself is real Node child code.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateManifest } = require('../src/codeSkills/manifest');
const { CodeSkillStore } = require('../src/codeSkills/store');
const { CodeSkillGeneration } = require('../src/codeSkills/generation');
const { SandboxRunner } = require('../src/codeSkills/sandboxRunner');
const { CodeSkillService } = require('../src/codeSkills/service');
const { WebSearch, unsafeQuery } = require('../src/llm/knowledge/webSearch');

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

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function manifestFor(name, permissions = ['read_state']) {
  return { name, version: '1.0.0', apiVersion: 1, entry: 'index.js', permissions };
}

function fakeSearchResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

(async () => {
  process.stdout.write('P1 M4 sandbox/live-loop test\n\n');

  process.stdout.write('1. manifest + store\n');
  await check('the authorized 2026-10-18 permission set is accepted; raw net/fs/exec is not', () => {
    const manifest = manifestFor('agent.all', [
      'read_state',
      'submit_task',
      'chat',
      'wait',
      'search',
      'generate',
      'subprocess'
    ]);
    assert(validateManifest(manifest).ok);
    assert(!validateManifest({ ...manifest, permissions: ['fs'] }).ok);
    assert(!validateManifest({ ...manifest, permissions: ['net'] }).ok);
    assert(!validateManifest({ ...manifest, permissions: ['exec'] }).ok);
  });

  await check('candidate lifecycle metadata survival a restart', () => {
    const store = new CodeSkillStore({ now: () => 1000 });
    const manifest = manifestFor('agent.persist');
    store.addCandidate(manifest);
    store.recordTrial(manifest.name, manifest.version, { ok: true, report: { calls: 1 } });
    store.promote(manifest.name, manifest.version);
    const restored = new CodeSkillStore();
    assert(restored.restore(store.toJSON()));
    assert.strictEqual(restored.getCandidate(manifest.name, manifest.version).status, 'promoted');
    assert.strictEqual(restored.getPromoted(manifest.name).version, manifest.version);
  });

  process.stdout.write('\n2. generation + search backends\n');
  await check('the generation backend parses the JSON envelope and rejects malformed output', async () => {
    const manifest = manifestFor('agent.gen');
    const generation = new CodeSkillGeneration({
      complete: async () => JSON.stringify({ manifest, code: 'module.exports = { run: async () => ({ ok: true }) };' }),
      log: silent
    });
    const good = await generation.generate({ prompt: 'probe' });
    assert(good.ok);
    assert.strictEqual(good.manifest.name, 'agent.gen');
    const bad = new CodeSkillGeneration({ complete: async () => 'not json', log: silent });
    assert.strictEqual((await bad.generate({ prompt: 'x' })).reason, 'malformed-envelope');
  });

  await check('DeepSeek Search posts the documented schema and caches the result', async () => {
    const root = tempRoot('p1-m4-search-');
    const calls = [];
    const service = new WebSearch({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'test-key',
      cacheFile: path.join(root, 'cache.json'),
      fetchImpl: async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return fakeSearchResponse({
          results: [{ title: 'Crafting table', url: 'https://minecraft.wiki/x', summary: '4 planks', content: 'body' }]
        });
      },
      log: silent
    });
    const first = await service.search('minecraft crafting table', { count: 3, needContent: true });
    assert(first.ok);
    assert.strictEqual(calls[0].url, 'https://api.deepseek.com/v1/tools/search');
    assert.strictEqual(calls[0].body.query, 'minecraft crafting table');
    assert.strictEqual(calls[0].body.count, 3);
    assert.strictEqual(calls[0].body.need_content, true);
    assert(calls[0].options.headers.authorization === 'Bearer test-key');
    assert.strictEqual(first.results[0].untrusted, true);
    const second = await service.search('minecraft crafting table', { count: 3, needContent: true });
    assert(second.cached);
    assert.strictEqual(calls.length, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  await check('WebSearch.lookup is the behavior-brain name and marks results untrusted', async () => {
    const service = new WebSearch({
      apiKey: 'k',
      fetchImpl: async () =>
        fakeSearchResponse({
          results: [{ title: 'Mod block', url: 'https://example.invalid/mod', summary: 'a block', content: 'body' }]
        }),
      log: silent
    });
    const result = await service.lookup('mod block', { count: 1 });
    assert(result.ok);
    assert.strictEqual(result.source, 'deepseek-web-search');
    assert.strictEqual(result.results[0].untrusted, true);
  });

  await check('MC百科 and Minecraft Wiki are ranked first, without dropping other sources', async () => {
    const service = new WebSearch({
      apiKey: 'k',
      fetchImpl: async () =>
        fakeSearchResponse({
          results: [
            { title: 'Other', url: 'https://example.invalid/mod', summary: 'other' },
            { title: 'Minecraft Wiki', url: 'https://minecraft.wiki/w/Furnace', summary: 'wiki' },
            { title: 'MC百科', url: 'https://www.mcmod.cn/item/1.html', summary: 'mcmod' }
          ]
        }),
      log: silent
    });
    const result = await service.lookup('mod content', { count: 3 });
    assert(result.ok);
    assert.strictEqual(result.results[0].url, 'https://www.mcmod.cn/item/1.html');
    assert.strictEqual(result.results[0].preferredSource, 'MC百科');
    assert.strictEqual(result.results[1].url, 'https://minecraft.wiki/w/Furnace');
    assert.strictEqual(result.results[1].preferredSource, 'Minecraft Wiki');
    assert.strictEqual(result.results[2].preferred, false, 'other sources stay available');
  });

  await check('preferred:false keeps backend order for the language-brain supplement', async () => {
    const service = new WebSearch({
      apiKey: 'k',
      fetchImpl: async () =>
        fakeSearchResponse({
          results: [
            { title: 'Other', url: 'https://example.invalid/mod', summary: 'other' },
            { title: 'Minecraft Wiki', url: 'https://minecraft.wiki/w/Furnace', summary: 'wiki' },
            { title: 'MC百科', url: 'https://www.mcmod.cn/item/1.html', summary: 'mcmod' }
          ]
        }),
      log: silent
    });
    const result = await service.lookup('language knowledge', { count: 3, preferred: false });
    assert(result.ok);
    assert.deepStrictEqual(
      result.results.map((entry) => entry.url),
      [
        'https://example.invalid/mod',
        'https://minecraft.wiki/w/Furnace',
        'https://www.mcmod.cn/item/1.html'
      ]
    );
    assert.strictEqual(result.results[0].preferred, undefined);
  });

  await check('search refuses coordinates/IPs before any request', async () => {
    let called = false;
    const service = new WebSearch({
      apiKey: 'k',
      fetchImpl: async () => {
        called = true;
        return fakeSearchResponse({ results: [] });
      },
      log: silent
    });
    const result = await service.search('come to 12, 64, -3');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'privacy-filtered');
    assert.strictEqual(called, false);
    assert.strictEqual(unsafeQuery('server 1.2.3.4'), 'ip-address');
  });

  process.stdout.write('\n3. real sandbox child\n');
  {
    const sandboxRoot = path.join(tempRoot('p1-m4-sandbox-'), 'runs');
    const runner = new SandboxRunner({ sandboxRoot, timeoutMs: 5000, log: silent });
    const manifest = manifestFor('agent.sandbox', ['read_state', 'chat', 'search', 'wait']);
    const code = `
module.exports = {
  async run(ctx, params) {
    const state = await ctx.read_state();
    await ctx.wait(5);
    const search = await ctx.search({ query: params.q, count: 2 });
    await ctx.chat({ text: 'sandbox says hi' });
    return { position: state.position, results: search.results.length, q: params.q };
  }
};
`;
    await check('read_state/wait/search/chat run through the parent broker', async () => {
      const calls = [];
      const result = await runner.run({
        name: manifest.name,
        version: manifest.version,
        entry: manifest.entry,
        code,
        manifest,
        params: { q: 'crafting table' },
        timeoutMs: 5000,
        host: {
          read_state: async () => ({ position: { x: 4, y: 70, z: -2 } }),
          search: async (args) => ({ ok: true, results: [{ title: args.query }] }),
          chat: async (args) => {
            calls.push(args.text);
            return { ok: true };
          }
        }
      });
      assert(result.ok);
      assert.deepStrictEqual(result.result, { position: { x: 4, y: 70, z: -2 }, results: 1, q: 'crafting table' });
      assert.deepStrictEqual(calls, ['sandbox says hi']);
      assert.strictEqual(result.callCount, 3);
      assert(!fs.existsSync(sandboxRoot) || fs.readdirSync(sandboxRoot).length === 0);
    });

    await check('a declared capability with no host handler is denied and visible in the call log', async () => {
      const deniedManifest = manifestFor('agent.denied', ['chat']);
      const result = await runner.run({
        name: deniedManifest.name,
        version: deniedManifest.version,
        entry: deniedManifest.entry,
        code: `
module.exports = { async run(ctx) {
  try { await ctx.chat({ text: 'x' }); return { spoke: true }; }
  catch (err) { return { denied: String(err.message) }; }
} };`,
        manifest: deniedManifest,
        timeoutMs: 3000,
        host: {}
      });
      assert(result.ok);
      assert(result.result.denied.includes('capability-unavailable'));
      assert(result.calls.some((call) => call.capability === 'chat' && call.denied === 'no-host-handler'));
    });

    await check('the hard timeout kills a non-returning run', async () => {
      const loopManifest = manifestFor('agent.loop', []);
      const result = await runner.run({
        name: loopManifest.name,
        version: loopManifest.version,
        entry: loopManifest.entry,
        code: 'module.exports = { async run() { while (true) {} } };',
        manifest: loopManifest,
        timeoutMs: 250,
        host: {}
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.timeout, true);
      assert.strictEqual(result.reason, 'timeout');
    });

    await check('an abort signal revokes a running sandbox and cleans up', async () => {
      const loopManifest = manifestFor('agent.cancel', []);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 120);
      const result = await runner.run({
        name: loopManifest.name,
        version: loopManifest.version,
        entry: loopManifest.entry,
        code: 'module.exports = { async run() { while (true) {} } };',
        manifest: loopManifest,
        timeoutMs: 5000,
        signal: controller.signal,
        host: {}
      });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.cancelled, true);
      assert(!fs.existsSync(sandboxRoot) || fs.readdirSync(sandboxRoot).length === 0);
    });

    await check('generated code runs in the child, not in this Node process', async () => {
      const marker = `__p1_m4_${Date.now()}`;
      global[marker] = false;
      const isolated = manifestFor('agent.isolated', []);
      const result = await runner.run({
        name: isolated.name,
        version: isolated.version,
        entry: isolated.entry,
        code: `module.exports = { async run() { globalThis.${marker} = true; return { touched: true }; } };`,
        manifest: isolated,
        timeoutMs: 3000,
        host: {}
      });
      assert(result.ok);
      assert.strictEqual(global[marker], false);
      delete global[marker];
    });

    fs.rmSync(path.dirname(sandboxRoot), { recursive: true, force: true });
  }

  process.stdout.write('\n4. service loop + evidence + subprocess\n');
  {
    const root = tempRoot('p1-m4-cancel-');
    const manifest = manifestFor('agent.cancel-service', []);
    const fakeSandbox = {
      timeoutMs: 1000,
      maxCalls: 10,
      run: (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener(
            'abort',
            () => resolve({ ok: false, cancelled: true, executed: true, runId: 'cancel-run', reason: 'cancelled' }),
            { once: true }
          );
        })
    };
    const service = new CodeSkillService({
      root,
      evidenceDir: path.join(root, 'evidence'),
      sandbox: fakeSandbox,
      ctx: {},
      generation: { generate: async () => ({ ok: true, manifest, code: 'module.exports = { run: async () => ({ ok: true }) };' }) },
      log: silent
    });
    await check('the service cancel() aborts a running trial without quarantining it', async () => {
      const generated = await service.generateCandidate({ prompt: 'cancel probe' });
      assert(generated.ok);
      const running = service.trial(manifest.name, manifest.version, { timeoutMs: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.strictEqual(service.status().active.length, 1);
      assert(service.cancel(manifest.name, manifest.version).ok);
      const result = await running;
      assert.strictEqual(result.cancelled, true);
      assert.strictEqual(service.get(manifest.name, manifest.version).status, 'candidate');
    });
    fs.rmSync(root, { recursive: true, force: true });
  }

  {
    const root = tempRoot('p1-m4-service-');
    const sandboxRoot = path.join(root, 'sandbox');
    const evidenceDir = path.join(root, 'evidence');
    const manifest = manifestFor('agent.live', ['read_state', 'chat', 'subprocess']);
    const code = `
module.exports = {
  async run(ctx) {
    const state = await ctx.read_state();
    const child = await ctx.subprocess({ code: 'console.log("child-ok")' });
    await ctx.chat({ text: 'trial passed' });
    return { ok: state.ok, child: child.ok, stdout: child.stdout };
  }
};
`;
    const ctx = {
      body: {
        snapshot: () => ({
          position: { x: 0, y: 64, z: 0 },
          health: 20,
          food: 20,
          dimension: 'overworld',
          inventory: {},
          hostiles: []
        }),
        freshness: () => ({ ageMs: 1 })
      },
      reply: async () => true
    };
    const service = new CodeSkillService({
      root,
      sandboxRoot,
      evidenceDir,
      ctx,
      brain: { submitExternalTask: async () => ({ ok: true, accepted: true }) },
      generation: { generate: async () => ({ ok: true, manifest, code }) },
      search: { search: async () => ({ ok: true, results: [] }) },
      log: silent
    });

    await check('generate -> candidate -> real trial -> evidence -> promote -> rollback', async () => {
      const generated = await service.generateCandidate({ prompt: 'probe' });
      assert(generated.ok);
      assert(fs.existsSync(path.join(root, 'candidates', 'agent', 'live', '1.0.0', 'index.js')));
      const trial = await service.trial(manifest.name, manifest.version, { timeoutMs: 5000 });
      assert(trial.ok, JSON.stringify(trial.result));
      assert(trial.result.result.child === true);
      assert(trial.result.result.stdout.includes('child-ok'));
      assert(trial.evidencePath && fs.existsSync(trial.evidencePath));
      const promoted = service.promote(manifest.name, manifest.version);
      assert(promoted.ok);
      assert(fs.existsSync(path.join(root, 'promoted', 'agent', 'live', '1.0.0', 'index.js')));
      const dispatched = await service.runPromoted(manifest.name, {}, { timeoutMs: 5000 });
      assert(dispatched.ok, JSON.stringify(dispatched.result));
      assert(dispatched.result.result.child === true);
      const rolled = service.rollback(manifest.name);
      assert(rolled.ok);
      assert.strictEqual(service.store.getPromoted(manifest.name), null);
    });

    fs.rmSync(root, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`P1 M4 sandbox/live loop: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const failure of failed) process.stdout.write(`  FAILED: ${failure.name} - ${failure.detail}\n`);
    process.exitCode = 1;
  }
})().catch((err) => {
  process.stderr.write(`p1-m4-test crashed: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
