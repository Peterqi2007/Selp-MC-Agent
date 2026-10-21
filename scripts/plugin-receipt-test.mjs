/**
 * Offline verification for the mc_plan receipt passthrough fix (no DSH, no Minecraft).
 *
 * The plugin's `mc_plan` used to return only `{ok:false, hint}` for a rejected plan, so a
 * 409 `budget-exhausted` replan looked identical to "no live agent bound" (live A15
 * 2026-10-20). This harness applies the real plugin with a fake ctx and a stub control
 * server, then feeds the tool three receipts: budget-exhausted, turn-active and success.
 */
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const silent = { info() {}, warn() {}, debug() {}, error() {} };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function startStub(getReply) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      for await (const _ of req) { /* drain */ }
      const reply = getReply();
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function main() {
  let reply = { status: 409, body: { ok: false, error: 'budget-exhausted', detail: { reason: 'budget-exhausted', kind: 'replans' } } };
  const stub = await startStub(() => reply);
  const pluginPort = await freePort();

  const tools = [];
  const cleanups = [];
  const ctx = {
    logger: silent,
    get: () => null,
    inject: (names, callback) => callback({ tools: { register: (definition) => tools.push(definition) }, agents: null }),
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    }
  };

  const mod = await import(pathToFileURL(path.join(ROOT, 'dsh-plugin-mc-harness', 'lib', 'index.js')).href);
  await mod.apply(ctx, { port: pluginPort, controlUrl: `http://127.0.0.1:${stub.port}` });
  const planTool = tools.find((tool) => tool.name === 'mc_plan');
  assert(planTool, 'mc_plan was not registered');

  const args = {
    goal: 'replan probe',
    planId: 'plan-probe',
    baseVersion: 6,
    steps: [{ id: 's1', type: 'craft', args: { item: 'stick', count: 4 } }]
  };

  const rejected = JSON.parse(await planTool.execute(args));
  assert(rejected.ok === false, 'rejected plan must report ok:false');
  assert(rejected.httpStatus === 409, `expected httpStatus 409, got ${rejected.httpStatus}`);
  assert(rejected.error === 'budget-exhausted', `expected error budget-exhausted, got ${rejected.error}`);
  assert(rejected.detail && rejected.detail.reason === 'budget-exhausted', 'Node detail.reason must pass through');
  assert(/rejected/i.test(rejected.hint), 'hint must not claim "no bound agent" for a rejection');

  reply = { status: 409, body: { ok: false, error: 'turn-active', activeTurn: 'turn-9' } };
  const turnActive = JSON.parse(await planTool.execute(args));
  assert(turnActive.error === 'turn-active', 'turn-active must pass through');
  assert(turnActive.activeTurn === 'turn-9', 'activeTurn must pass through');

  reply = { status: 202, body: { ok: true, accepted: true, planId: 'plan-probe', turnId: 'turn-3', state: 'running' } };
  const accepted = JSON.parse(await planTool.execute(args));
  assert(accepted.ok === true && accepted.async === true, 'accepted plan must report ok/async');
  assert(accepted.error === null, 'accepted plan has no error');
  assert(/resumed/i.test(accepted.hint), 'accepted hint must describe turn resume');

  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch { /* closing anyway */ }
  }
  await new Promise((resolve) => stub.server.close(resolve));
  console.log('mc_plan receipt passthrough: PASS (error/detail/activeTurn/httpStatus + hints)');
}

main().catch((err) => {
  console.error('mc_plan receipt passthrough: FAIL -', err.message);
  process.exit(1);
});
