'use strict';

/**
 * `node scripts/m5-m53-gui-live-probe.js` - M5.3: A07 / A08 / A12-GUI re-run with a GUI open.
 *
 * M5.3 asks whether the invariants M1/M2 established still hold when a screen is up:
 *   A07  single body owner      - a background task and a raw input both claim the body?
 *   A08  stop is bounded        - `stop` while a GUI is open must clear the ledger and the
 *                                 body in <=3s;
 *   A12-GUI  threat response    - the self-defence reflex must still fire while a GUI is open.
 *
 * All actions go through the agent (`POST /command` with `via:"mc_step"`); observations come
 * from the agent's `/ui/state`. A12-GUI needs a hostile mob; when none is in range the row is
 * recorded as NOT_RUN with the reason instead of being counted as a pass.
 *
 * Usage: node scripts/m5-m53-gui-live-probe.js [--agent 8766] [--out runtime/evidence]
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const AGENT_PORT = Number(argValue('--agent', 8766));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));

const results = [];
const evidence = { startedAt: new Date().toISOString(), layer: 'agent', cases: {} };

function request(method, urlPath, body, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: AGENT_PORT,
      path: urlPath,
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      timeout
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (err) { reject(new Error(`not JSON: ${text.slice(0, 160)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout ${method} ${urlPath}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const step = (command) => request('POST', '/command', { command, via: 'mc_step' });
const operator = (command) => request('POST', '/command', { command });
const state = () => request('GET', '/ui/state');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function check(name, ok, detail) {
  results.push({ name, ok: ok === true, detail });
  process.stdout.write(`  ${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 220)}`}\n`);
  return ok === true;
}

function notRun(name, reason) {
  results.push({ name, ok: null, detail: { notRun: reason } });
  process.stdout.write(`  NOT_RUN ${name} :: ${reason}\n`);
}

async function waitFor(fn, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(150);
  }
}

const heldCount = (receipt) => {
  const result = receipt && (receipt.result || receipt);
  return result && typeof result.count === 'number' ? result.count : null;
};
const screenOf = async () => {
  const snapshot = await state();
  const world = (snapshot && snapshot.world) || {};
  return { screen: world.screen || null, open: Boolean(world.screenOpen), position: world.position || null };
};

// ------------------------------------------------------------------ A07
async function a07SingleOwner() {
  process.stdout.write('\nA07 (GUI): one body owner while the GUI is open\n');
  const start = await screenOf();
  const target = start.position
    ? { x: Math.round(start.position.x) + 8, y: Math.round(start.position.y), z: Math.round(start.position.z) + 8 }
    : null;
  const gotoReceipt = target ? await step(`goto ${target.x} ${target.y} ${target.z}`) : null;
  const running = await waitFor(async () => {
    const receipt = await step('task status');
    const text = JSON.stringify(receipt && (receipt.result || receipt));
    return /goto|walk|running|active/i.test(text) ? text : null;
  }, 8000);
  check('A07: a background task is running and owns the body', Boolean(running),
    { goto: gotoReceipt && (gotoReceipt.ok || gotoReceipt.reason), task: running && running.slice(0, 160) });

  // A raw input while a task owns the body must be refused, not executed in parallel.
  const input = await step('hold attack 300');
  check('A07: a raw input is refused while a task owns the body',
    Boolean(input && input.ok === false), input && (input.reason || input.failure || input.result));
  evidence.cases.a07 = { task: running && running.slice(0, 200), input: input && (input.reason || input.ok) };

  // Stop must release the body and the ledger.
  const stopAt = Date.now();
  const stop = await operator('stop');
  const cleared = await waitFor(async () => (heldCount(await step('inputs')) === 0 ? true : null), 3000);
  const elapsed = Date.now() - stopAt;
  check('A07/A08: stop acknowledged', Boolean(stop && stop.ok), stop && (stop.reason || stop.ok));
  check('A07/A08: the ledger is empty after stop', Boolean(cleared), { elapsedMs: elapsed });
  check('A07/A08: stop took <= 3000ms', elapsed <= 3000, { elapsedMs: elapsed });
  evidence.cases.a07.stop = { ok: stop && stop.ok, elapsedMs: elapsed };
}

// ------------------------------------------------------------------ A08
async function a08StopInGui() {
  process.stdout.write('\nA08 (GUI): stop with an open screen is bounded\n');
  const tap = await step('tap inventory');
  check('A08: the inventory opened through the agent', tap && tap.ok === true, tap && (tap.reason || tap.ok));
  const opened = await waitFor(async () => ((await screenOf()).open ? true : null), 5000);
  check('A08: a screen is open before the stop', Boolean(opened));

  const key = await step('key attack down');
  const ledgerBefore = heldCount(await step('inputs'));
  check('A08: the key press is recorded while the GUI is open', ledgerBefore !== null,
    { held: ledgerBefore, key: key && (key.reason || key.ok) });

  const stopAt = Date.now();
  const stop = await operator('stop');
  const cleared = await waitFor(async () => (heldCount(await step('inputs')) === 0 ? true : null), 3000);
  const elapsed = Date.now() - stopAt;
  check('A08: stop cleared the ledger even with the GUI open', Boolean(cleared), { elapsedMs: elapsed });
  check('A08: stop took <= 3000ms with the GUI open', elapsed <= 3000, { elapsedMs: elapsed });

  const close = await step('close');
  const closed = await waitFor(async () => (!(await screenOf()).open ? true : null), 5000);
  check('A08: the screen closed and the body is free',
    Boolean(closed) && Boolean(close && close.ok), { stop: stop && (stop.ok || stop.reason) });
  evidence.cases.a08 = { elapsedMs: elapsed, stop: stop && stop.ok, heldBefore: ledgerBefore };
}

// ------------------------------------------------------------------ A12-GUI
async function a12GuiThreatInGui() {
  process.stdout.write('\nA12-GUI (GUI): threat response with a screen open\n');
  const snapshot = await state();
  const threat = (snapshot && snapshot.selfDefense) || {};
  if (!threat.enabled) {
    notRun('A12-GUI: the self-defence reflex is enabled', 'behaviour.autoFight is off in this configuration');
    return;
  }
  const hostiles = await step('target');
  check('A12-GUI: the target probe answers through the agent', Boolean(hostiles && hostiles.ok), hostiles && (hostiles.reason || hostiles.ok));
  // The agent has no direct hostile list on /ui/state; ask for a fresh observation instead.
  const observation = await request('GET', '/ui/state').catch(() => null);
  const nearby = (observation && observation.brain && observation.brain.hostiles) || null;
  notRun('A12-GUI: a hostile engages the reflex while the GUI is open',
    `no reliable hostile source in /ui/state (hostiles=${JSON.stringify(nearby)}); needs a mob in range - re-run at night or next to a spawner`);
}

async function main() {
  process.stdout.write(`M5.3 with a GUI open (agent ${AGENT_PORT})\n`);
  const pre = await state().catch((err) => ({ error: err.message }));
  if (!check('agent state is reachable', Boolean(pre && !pre.error), pre && pre.error)) return;

  await a07SingleOwner();
  await a08StopInGui();
  await a12GuiThreatInGui();

  const failed = results.filter((entry) => entry.ok === false);
  const notRuns = results.filter((entry) => entry.ok === null);
  evidence.finishedAt = new Date().toISOString();
  evidence.checks = results.length;
  evidence.passed = results.filter((entry) => entry.ok === true).length;
  evidence.failed = failed.length;
  evidence.notRun = notRuns.length;
  evidence.failures = failed.map((entry) => ({ name: entry.name, detail: entry.detail }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(OUT_DIR, `m5-m53-gui-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`\n${evidence.passed}/${evidence.checks} passed, ${evidence.notRun} NOT_RUN, ${evidence.failed} failed\n`);
  process.stdout.write(`evidence: ${path.relative(ROOT, file)}\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
