'use strict';

/**
 * End-to-end probe for the three 2026-10-30 memory wirings, through the real entry points:
 *   - /lookup_mod_content over HTTP   (semantic auto-write, idempotent)
 *   - PlanService.run                 (method learning + plan.methodId)
 * Not part of the gates; kept as an operator repro.
 */

const http = require('http');
const { startStatusServer } = require('../src/web/statusServer');
const { Brain } = require('../src/brain');
const { loadConfig } = require('../src/util/config');

let failures = 0;
function ok(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL  ${name} - ${err.message}`);
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function makeCtx() {
  const cfg = loadConfig({ profile: null });
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const ctx = {
    cfg,
    log: silent,
    body: null,
    bodyKind: 'probe',
    world: {
      snapshot: () => ({ inventory: {}, emptySlots: 36, health: 20, food: 20, ready: false, dimension: 'minecraft:overworld' }),
      isNight: () => false
    },
    nav: { stop() {}, interrupt() {} },
    eat: { tick: async () => true },
    loop: { running: false, task: null },
    skills: {},
    reply: async () => {},
    memory: null
  };
  return ctx;
}

async function startServer(ctx) {
  const result = startStatusServer(ctx, { port: 0, host: '127.0.0.1' });
  await new Promise((resolve, reject) => {
    if (result.server.listening) return resolve();
    result.server.once('listening', resolve);
    result.server.once('error', reject);
  });
  return { server: result.server, port: result.server.address().port };
}

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* leave as text */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

(async () => {
  const ctx = makeCtx();
  const brain = new Brain(ctx, { state: { enabled: false } });
  ctx.brain = brain;
  brain.running = true;

  // A fixture lookup: the same query answered twice with updated content.
  let answer = 'zinc spawns at Y -63..70, needs an iron pickaxe';
  ctx.lookupFixture = (query) => ({
    ok: true,
    results: [{ title: `${query} 参考`, snippet: answer }]
  });

  const { server, port } = await startServer(ctx);
  try {
    console.log('A. /lookup_mod_content writes semantic memory once, then refreshes');
    const first = await post(port, '/lookup_mod_content', { query: 'create:zinc_ore' });
    ok('lookup answered 200', () => expect(first.status === 200, `status=${first.status}`));
    const afterFirst = brain.memoryStore.status().counts.semantic;
    ok('one semantic entry written automatically', () => expect(afterFirst === 1, `semantic=${afterFirst}`));

    answer = 'zinc spawns at Y -63..70; smelt it into a zinc ingot';
    const second = await post(port, '/lookup_mod_content', { query: 'create:zinc_ore' });
    ok('second lookup also 200', () => expect(second.status === 200, `status=${second.status}`));
    const afterSecond = brain.memoryStore.status().counts.semantic;
    ok('no duplicate entry for the same query', () => expect(afterSecond === 1, `semantic=${afterSecond}`));
    ok('content refreshed to the newer answer', () => {
      const entry = [...brain.memoryStore.entries.values()].find((e) => e.category === 'semantic');
      expect(/smelt it into a zinc ingot/.test(entry.text), `text=${entry.text.slice(0, 80)}`);
      expect(entry.count === 2, `count=${entry.count}`);
    });

    const other = await post(port, '/lookup_mod_content', { query: 'touhou_little_maid:altar' });
    ok('a different query is a separate fact', () => {
      expect(other.status === 200, `status=${other.status}`);
      expect(brain.memoryStore.status().counts.semantic === 2, `semantic=${brain.memoryStore.status().counts.semantic}`);
    });

    ctx.lookupFixture = () => ({ ok: true, results: [] });
    const empty = await post(port, '/lookup_mod_content', { query: 'nothing:here' });
    ok('an empty result teaches nothing', () => {
      expect(empty.status === 200, `status=${empty.status}`);
      expect(brain.memoryStore.status().counts.semantic === 2, `semantic=${brain.memoryStore.status().counts.semantic}`);
    });

    console.log('\nB. a settled plan teaches a method');
    const plan = ctx.planService
      ? null
      : null;
    const service = brain.planService;
    ok('PlanService exists on the brain', () => expect(!!service, 'no planService'));

    const steps = [
      { id: 's1', type: 'goto', args: { target: '0 64 0' } },
      { id: 's2', type: 'mine', args: { block: 'stone', count: 1 } }
    ];
    // Replace the executor so no real body is needed; the settle path is what we assert.
    service.runner.createTask = () => ({ type: 'probe' });
    service.runner.runTask = async () => ({ ok: true, status: 'succeeded' });
    service.runner.verify = () => ({ ok: true });

    const submitted = service.submit({ goal: 'probe sleep cycle', steps });
    ok('plan submitted', () => expect(submitted && submitted.ok, `submit=${JSON.stringify(submitted).slice(0, 160)}`));
    const planId = submitted.planId || (submitted.plan && submitted.plan.planId);
    ok('plan id known', () => expect(!!planId, 'no planId'));

    const started = service.start(planId, {});
    ok('plan started', () => expect(started && started.ok !== false, `start=${JSON.stringify(started).slice(0, 160)}`));
    await service.waitFor(planId, 5000);

    const stored = service.plans.get(planId);
    ok('the plan carries the method id it learned', () => expect(!!(stored && stored.methodId), 'no methodId on the plan'));
    ok('exactly one method in the library', () => expect(brain.methods.status().methods === 1, `methods=${brain.methods.status().methods}`));
    ok('the method shape is the step sequence', () => {
      const found = brain.methods.find('probe sleep cycle', 'goto > mine');
      expect(found, 'method not found by (goal, shape)');
      expect(found.success === 1, `success=${found.success}`);
      expect(found.conditions.dimension === 'minecraft:overworld', 'dimension not captured');
    });
    ok('suggestMethod now returns the learned method', () => {
      const suggestion = brain.suggestMethod('probe sleep cycle', { dimension: 'minecraft:overworld' });
      expect(suggestion.method, 'suggestMethod returned no method');
      expect(suggestion.method.method === 'goto > mine', `got ${suggestion.method.method}`);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(failures === 0 ? '\nall end-to-end memory checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('probe crashed:', err);
  process.exit(1);
});
