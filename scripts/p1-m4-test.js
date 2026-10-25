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
const { CodeSkillTask } = require('../src/tasks/codeSkill');
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

  await check('promote/rollback keep exactly one promoted record per name', () => {
    const store = new CodeSkillStore({ now: () => 1000 });
    const v1 = manifestFor('agent.two', ['read_state']);
    const v2 = { ...manifestFor('agent.two', ['read_state']), version: '1.0.1' };
    store.addCandidate(v1);
    store.addCandidate(v2);
    store.recordTrial(v1.name, '1.0.0', { ok: true, report: {} });
    store.recordTrial(v1.name, '1.0.1', { ok: true, report: {} });
    store.promote(v1.name, '1.0.0');
    store.promote(v1.name, '1.0.1');
    assert.strictEqual(store.getCandidate(v1.name, '1.0.1').status, 'promoted');
    assert.strictEqual(store.getCandidate(v1.name, '1.0.0').status, 'trialled', 'the superseded version is no longer "promoted"');
    const rolled = store.rollback(v1.name);
    assert.strictEqual(rolled.version, '1.0.0');
    assert.strictEqual(store.getCandidate(v1.name, '1.0.0').status, 'promoted');
    assert.strictEqual(store.getCandidate(v1.name, '1.0.1').status, 'trialled', 'the rolled-back version can be promoted again');
    assert(store.promote(v1.name, '1.0.1').ok);
  });

  await check('startup sweeps run-* sandbox dirs left by a killed host', () => {
    const root = tempRoot('p1-m4-sweep-');
    const sandboxRoot = path.join(root, 'sandbox');
    fs.mkdirSync(path.join(sandboxRoot, 'run-dead'), { recursive: true });
    fs.writeFileSync(path.join(sandboxRoot, 'run-dead', 'index.js'), 'module.exports = {};\n');
    fs.mkdirSync(path.join(sandboxRoot, 'keep-me'), { recursive: true });
    new CodeSkillService({
      root,
      sandboxRoot,
      evidenceDir: path.join(root, 'evidence'),
      ctx: {},
      log: silent
    });
    assert.strictEqual(fs.existsSync(path.join(sandboxRoot, 'run-dead')), false, 'stale run-* dir removed');
    assert.strictEqual(fs.existsSync(path.join(sandboxRoot, 'keep-me')), true, 'unrelated dirs untouched');
    fs.rmSync(root, { recursive: true, force: true });
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

    /**
     * A19 live 2026-10-25: `console.log.constructor('return globalThis')()` escapes the vm
     * and reaches the WORKER's process (vm is not a boundary). The second layer must still
     * deny every module, so file/child/net access stays closed. This test pins both halves:
     * the documented residual (host process reachable) and the enforced boundary.
     */
    await check('a vm escape reaches the worker process but cannot load any module', async () => {
      const probe = manifestFor('agent.escape', []);
      const result = await runner.run({
        name: probe.name,
        version: probe.version,
        entry: probe.entry,
        code: `
module.exports = {
  async run() {
    const g = console.log.constructor('return globalThis')();
    const p = g && g.process;
    const out = { hostProcess: !!p, requireType: typeof (g && g.require) };
    for (const name of ['fs', 'child_process', 'module', 'vm', 'net', 'repl', 'crypto']) {
      try { p.getBuiltinModule(name); out[name] = 'LOADED'; }
      catch (e) { out[name] = 'DENIED'; }
    }
    return out;
  }
};`,
        manifest: probe,
        timeoutMs: 3000,
        host: {}
      });
      assert(result.ok);
      assert.strictEqual(result.result.hostProcess, true, 'vm is not a boundary (documented residual)');
      assert.strictEqual(result.result.requireType, 'undefined');
      for (const name of ['fs', 'child_process', 'module', 'vm', 'net', 'repl', 'crypto']) {
        assert.strictEqual(result.result[name], 'DENIED', `${name} must be denied after an escape`);
      }
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

    /**
     * A19 2026-10-25: Node's permission model has no network flag. The subprocess child is
     * started with a preload guard that denies every require, deletes fetch/WebSocket and
     * clears process escape hatches; fs/child_process stay denied by --permission too.
     */
    await check('subprocess network and modules are denied by the preload guard', async () => {
      const sandboxDir = path.join(root, 'subproc');
      fs.mkdirSync(sandboxDir, { recursive: true });
      const code = `
const out = {};
(async () => {
  try { const r = await fetch('https://api.deepseek.com/', { method: 'HEAD' }); out.fetch = 'OK:' + r.status; }
  catch (e) { out.fetch = 'DENIED:' + (e && e.name ? e.name : e); }
  try { require('net'); out.net = 'LOADED'; } catch (e) { out.net = 'DENIED'; }
  try { require('fs').readFileSync('C:/Windows/win.ini', 'utf8'); out.fs = 'READ'; }
  catch (e) { out.fs = 'DENIED:' + (e.code || e.message); }
  try { require('child_process'); out.child = 'LOADED'; } catch (e) { out.child = 'DENIED'; }
  process.stdout.write(JSON.stringify(out));
})();
`;
      const res = await service._subprocess({ code, timeoutMs: 8000 }, { sandboxDir });
      assert(res.ok, JSON.stringify(res));
      const parsed = JSON.parse(res.stdout);
      assert(/^DENIED/.test(parsed.fetch), `fetch must be denied: ${parsed.fetch}`);
      assert.strictEqual(parsed.net, 'DENIED');
      assert(/^DENIED/.test(parsed.fs), `fs must stay denied by the permission flags: ${parsed.fs}`);
      assert.strictEqual(parsed.child, 'DENIED');
    });

    fs.rmSync(root, { recursive: true, force: true });
  }

  {
    process.stdout.write('\n6. live entry: !code-skill + code_skill task\n');

    await check('the code_skill task dispatches only the promoted version and forwards params', async () => {
      let seen = null;
      const ctx = {
        codeSkills: {
          runPromoted: async (name, params, options) => {
            seen = { name, params, options };
            return { ok: true, name, version: '1.2.3', result: { ok: true }, evidencePath: '/tmp/evidence.json' };
          }
        }
      };
      const task = new CodeSkillTask(ctx, { name: 'agent.status_report', params: { threshold: 8 } });
      const result = await task.execute();
      assert.strictEqual(result.ok, true, JSON.stringify(result));
      assert.strictEqual(task.name, 'code_skill');
      assert.strictEqual(task.progress(), null, 'no constant progress value (B1 stall false positive)');
      assert.strictEqual(seen.name, 'agent.status_report');
      assert.deepStrictEqual(seen.params, { threshold: 8 });
      assert(seen.options && typeof seen.options.signal === 'object', 'the sandbox signal is forwarded');
      assert.strictEqual(typeof seen.options.timeoutMs, 'number');
      assert.strictEqual(result.version, '1.2.3');
      assert.strictEqual(result.evidencePath, '/tmp/evidence.json');
    });

    await check('an unpromoted or unknown skill fails honestly and runs nothing', async () => {
      let called = 0;
      const ctx = {
        codeSkills: {
          runPromoted: async () => {
            called += 1;
            return { ok: false, reason: 'not-promoted' };
          }
        }
      };
      const task = new CodeSkillTask(ctx, { name: 'agent.missing' });
      const result = await task.execute();
      assert.strictEqual(called, 1);
      assert.strictEqual(result.ok, false);
      assert(/not-promoted/.test(result.reason), result.reason);
    });

    await check('cancel aborts the sandbox through the forwarded signal', async () => {
      let signal = null;
      const ctx = {
        codeSkills: {
          runPromoted: (name, params, options) =>
            new Promise((resolve) => {
              signal = options.signal;
              options.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }), { once: true });
            })
        }
      };
      const task = new CodeSkillTask(ctx, { name: 'agent.slow' });
      const running = task.execute();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert(signal, 'the service received a signal');
      task.cancel();
      const result = await running;
      assert.strictEqual(signal.aborted, true);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.status, 'cancelled');
    });

    await check('read_state derives isDay from the shared clock rule', () => {
      const root = tempRoot('p1-m4-state-');
      const ctx = {
        body: {
          snapshot: () => ({
            position: { x: 0, y: 64, z: 0 },
            health: 20,
            food: 20,
            dimension: 'overworld',
            time: { isDay: false, timeOfDay: 1000, day: 1 },
            inventory: { dirt: 2 },
            hostiles: []
          })
        }
      };
      const service = new CodeSkillService({
        root,
        sandboxRoot: path.join(root, 'sandbox'),
        evidenceDir: path.join(root, 'evidence'),
        ctx,
        log: silent
      });
      const day = service._readState();
      assert.strictEqual(day.isDay, true, 'timeOfDay 1000 is daytime even when isDay says false');
      ctx.body.snapshot = () => ({
        position: { x: 0, y: 64, z: 0 },
        health: 20,
        food: 20,
        dimension: 'overworld',
        time: { isDay: true, timeOfDay: 15000, day: 1 },
        inventory: { dirt: 2 },
        hostiles: []
      });
      const night = service._readState();
      assert.strictEqual(night.isDay, false, 'timeOfDay 15000 is night even when isDay says true');
      fs.rmSync(root, { recursive: true, force: true });
    });

    await check('!code-skill and code_skill are wired into the command table and TASK_BUILDERS', () => {
      const commands = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'commands.js'), 'utf8');
      const brain = fs.readFileSync(path.join(__dirname, '..', 'src', 'brain.js'), 'utf8');
      assert(/'code-skill':\s*async/.test(commands), 'the !code-skill handler is missing');
      assert(/new CodeSkillTask/.test(commands), '!code-skill does not enqueue CodeSkillTask');
      assert(
        /code_skill:\s*\(ctx, args\)\s*=>\s*new CodeSkillTask/.test(brain),
        'code_skill is missing from TASK_BUILDERS (mc_plan/mc_step would reject it)'
      );
    });
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
