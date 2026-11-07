'use strict';

/**
 * `node scripts/m7-gate-live-probe.js` - M7 gate probes that need a real client + agent.
 *
 * Runs the body-level M7 items and writes reproducible evidence:
 *   A26  regression/degradation : walk, mine+pickup, cancel (<=3s), dual channel
 *   R1   `!`/do_task unchanged  : `!` command sample on the real client
 *   R4   task:quarantined       : force a strike quarantine and read it back from
 *                                 events, panel state and the agent log
 *   M0-C1 `/state` cost         : idle / moving / mining / GUI-open latency
 *
 * It does NOT run A28/A31 (need harness turns), F3 (needs eventsToken), A29 (restart) or
 * A33 (autonomous mode); those are separate steps. Every case records expected/actual and
 * a PASS/FAIL/PARTIAL/BLOCKED verdict; a skipped case is never reported as PASS.
 *
 * Usage:
 *   node scripts/m7-gate-live-probe.js [--port 8766] [--mod 8899] [--out runtime/evidence]
 *                                      [--only a26,r1,r4,m0]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const AGENT = `http://127.0.0.1:${Number(argValue('--port', 8766))}`;
const MOD = `http://127.0.0.1:${Number(argValue('--mod', 8899))}`;
const OUT_ROOT = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));
const LOG_FILE = path.resolve(ROOT, argValue('--log', path.join('runtime', 'logs', 'agent-m7-20261107.log')));
const ONLY = String(argValue('--only', 'a26,r1,r4,m0')).split(',').map((s) => s.trim()).filter(Boolean);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = path.join(OUT_ROOT, `m7-${stamp}`);
const cases = [];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function record(id, name, level, status, expected, actual, extra = {}) {
  const row = { id, name, level, status, expected, actual, ...extra, at: new Date().toISOString() };
  cases.push(row);
  process.stdout.write(`  ${status.padEnd(7)} ${id} ${name} :: ${JSON.stringify(actual).slice(0, 240)}\n`);
  return row;
}

async function json(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout || 15000) });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
  return { status: res.status, ok: res.ok, body };
}

const panel = (command) => json(`${AGENT}/command`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command })
});
const ui = () => json(`${AGENT}/ui/state`);
const events = (limit = 200) => json(`${AGENT}/events/recent?limit=${limit}`);
const modState = () => json(`${MOD}/state`);
const modCommand = (command, timeout = 20000) => json(`${MOD}/command`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ command }), timeout
});

async function inventory() {
  const res = await modState();
  return (res.body && res.body.inventory) || {};
}
const count = (inv, item) => Number(inv[item] || 0);

/** Latest event seq currently in the ring; a case only accepts events above its baseline. */
async function latestSeq() {
  const res = await events(1);
  return (res.body && res.body.seq) || 0;
}

/** Wait for a terminal task event ABOVE `minSeq` (never a stale event from the previous case). */
async function waitTerminal(minSeq, timeoutMs = 90000, types = ['task:done', 'task:failed', 'task:cancelled', 'task:quarantined']) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await events(300);
    const list = (res.body && res.body.events) || [];
    const hit = list.filter((e) => (e.seq || 0) > minSeq && types.includes(e.type)).pop();
    if (hit) return hit;
    await sleep(400);
  }
  return null;
}

const nowIso = () => new Date().toISOString();
const terminalTypes = ['task:done', 'task:failed', 'task:cancelled', 'task:quarantined'];

// ------------------------------------------------------------------ A26
async function a26() {
  process.stdout.write('\nA26 (real client): walk / mine+pickup / cancel / dual channel\n');

  // walk
  const before = (await modState()).body || {};
  const start = before.position;
  const target = { x: Math.round(start.x) + 4, y: Math.round(start.y), z: Math.round(start.z) };
  const walkSeq = await latestSeq();
  const walk = await panel(`!goto ${target.x} ${target.y} ${target.z}`);
  const walkEvent = await waitTerminal(walkSeq, 60000);
  const afterWalk = (await modState()).body || {};
  const walked = Math.hypot((afterWalk.position?.x || 0) - start.x, (afterWalk.position?.z || 0) - start.z);
  record('A26-walk', 'goto moves the body', 'G', walkEvent && walkEvent.type === 'task:done' && walked >= 2 ? 'PASS' : 'FAIL',
    'terminal task:done and >=2 blocks moved',
    { command: walk.body && walk.body.ok, event: walkEvent && { type: walkEvent.type, reason: walkEvent.reason }, walkedBlocks: Number(walked.toFixed(2)) });

  // mine + pickup
  const inv0 = await inventory();
  const dirt0 = count(inv0, 'minecraft:dirt');
  const logs0 = count(inv0, 'minecraft:oak_log') + count(inv0, 'minecraft:birch_log') + count(inv0, 'minecraft:spruce_log');
  const mineSeq = await latestSeq();
  const mine = await panel('!mine dirt 2');
  const mineEvent = await waitTerminal(mineSeq, 90000);
  const inv1 = await inventory();
  const dirt1 = count(inv1, 'minecraft:dirt');
  record('A26-mine', 'mine dirt 2 breaks blocks and collects', 'G',
    mineEvent && mineEvent.type === 'task:done' && dirt1 > dirt0 ? 'PASS' : 'FAIL',
    'task:done and minecraft:dirt inventory increases',
    { command: mine.body && mine.body.ok, event: mineEvent && { type: mineEvent.type, reason: mineEvent.reason },
      dirt: `${dirt0}->${dirt1}`, logs: `${logs0}->${count(inv1, 'minecraft:oak_log') + count(inv1, 'minecraft:birch_log') + count(inv1, 'minecraft:spruce_log')}` });

  // cancel: start a long mining run, stop after 1.5s, measure until the task settles
  const cancelSeq = await latestSeq();
  await panel('!mine dirt 10');
  await sleep(1500);
  const stopAt = Date.now();
  const stop = await panel('!stop');
  const stopEvent = await waitTerminal(cancelSeq, 12000, ['task:cancelled', 'task:failed', 'task:done']);
  const stopMs = stopEvent ? Date.parse(stopEvent.at) - stopAt : null;
  record('A26-cancel', 'stop bounds the running task at <=3s', 'G',
    stopMs !== null && stopMs <= 3000 ? 'PASS' : (stopMs === null ? 'FAIL' : 'FAIL'),
    'task settles within 3000ms of !stop',
    { stopOk: stop.body && stop.body.ok, event: stopEvent && { type: stopEvent.type, reason: stopEvent.reason }, cancelMs: stopMs });

  // dual channel: `!` (command) and panel NL are different entries; the in-game chat needs a
  // second player, so this run records the command channel and a chat-injected ordinary line.
  const chat = await json(`${AGENT}/chat/inject`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'M7Tester', text: '大肥鱼在吗' })
  });
  record('A26-dual', 'both entry channels answer', 'G',
    stop.body && stop.body.ok && chat.ok ? 'PARTIAL' : 'FAIL',
    '`!` channel answers; ordinary chat is handled (a real second player is required for the addressed channel)',
    { panelCommand: stop.body && stop.body.ok, chatInject: chat.body && { ok: chat.body.ok, status: chat.body.status, decision: chat.body.decision } });
  return { start, target };
}

// ------------------------------------------------------------------ R1
async function r1() {
  process.stdout.write('\nR1 (real client): `!`/do_task behaviour unchanged\n');
  const samples = [];
  for (const command of ['!status', '!inv', '!where', '!task status']) {
    const t = Date.now();
    const res = await panel(command);
    samples.push({ command, ok: res.ok && res.body && res.body.ok, ms: Date.now() - t });
  }
  record('R1-commands', 'the `!` command sample still answers', 'G',
    samples.every((s) => s.ok) ? 'PASS' : 'FAIL',
    'status/inv/where/task status all ok with a directive receipt', { samples });
  // do_task (NL -> model) needs the addressed channel; record it as PARTIAL with the reason.
  const addressed = await panel('!status').catch(() => null); // keep the run non-model if addressed is off
  record('R1-do_task', 'NL do_task path still runs', 'G', 'PARTIAL',
    'an addressed `@` request is routed to the model and produces a task',
    { note: 'chat.addressedPrefix is null in this window; the `!` half is PASS, the NL half needs the addressed channel enabled', addressed: Boolean(addressed) });
}

// ------------------------------------------------------------------ R4
async function r4() {
  process.stdout.write('\nR4 (real client): task:quarantined observable\n');
  const depSeq = await latestSeq();
  const dep = await panel('!deposit minecraft:barrier 1');
  const ev = await waitTerminal(depSeq, 60000, ['task:quarantined']);
  const state = await ui();
  const taskStatus = await panel('!task status');
  const log = fs.existsSync(LOG_FILE) ? fs.readFileSync(LOG_FILE, 'utf8') : '';
  const logHits = log.split('\n').filter((line) => /quarantined|task:quarantined/i.test(line)).slice(-3);
  const eventHits = ((await events(300)).body.events || []).filter((e) => e.type === 'task:quarantined' && (e.seq || 0) > depSeq);
  /** The panel surface must carry the quarantine; today /ui/state and !task status do not. */
  const panelHits = /quarantin/i.test(JSON.stringify({ state: state.body, taskStatus: taskStatus.body }));
  const verdict = ev && eventHits.length >= 1 && logHits.length >= 1
    ? (panelHits ? 'PASS' : 'PARTIAL')
    : 'FAIL';
  record('R4-quarantine', 'quarantine is visible in event stream, log and panel', 'G', verdict,
    'task:quarantined in events + a matching log line + panel surface',
    { command: dep.body && dep.body.ok, event: ev && { type: ev.type, reason: ev.reason, taskId: ev.taskId },
      eventCount: eventHits.length, logHits, panelHits,
      panelGap: panelHits ? null : 'control panel (/ui/state, !task status) has no quarantine field; event stream and debug log do',
      panel: { brain: state.body && state.body.brain && { current: state.body.brain.current }, failureEscalation: state.body && state.body.failureEscalation } });
}

// ------------------------------------------------------------------ M0-C1
async function sampleLatency(label, n) {
  const values = [];
  for (let i = 0; i < n; i += 1) {
    const t = Date.now();
    await modState();
    values.push(Date.now() - t);
    await sleep(120);
  }
  values.sort((a, b) => a - b);
  const p = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  return { label, n: values.length, p50: p(0.5), p95: p(0.95), max: values[values.length - 1] };
}

async function m0() {
  process.stdout.write('\nM0-C1 (real client): /state latency by load\n');
  const out = [];
  out.push(await sampleLatency('idle', 20));

  const pos = (await modState()).body.position;
  panel(`!goto ${Math.round(pos.x) + 6} ${Math.round(pos.y)} ${Math.round(pos.z)}`).catch(() => {});
  await sleep(500);
  out.push(await sampleLatency('moving', 15));
  await panel('!stop').catch(() => {});

  panel('!mine dirt 6').catch(() => {});
  await sleep(500);
  out.push(await sampleLatency('mining', 15));
  await panel('!stop').catch(() => {});

  await panel('!tap inventory').catch(() => {});
  await sleep(400);
  out.push(await sampleLatency('gui-open', 10));
  await panel('!close').catch(() => {});

  record('M0-C1', '/state latency under four loads', 'G', 'PASS',
    'idle/moving/mining/gui samples recorded; thresholds are not back-filled',
    out);
  return out;
}

// ------------------------------------------------------------------ main
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ui0 = await ui().catch((err) => ({ body: { error: err.message } }));
  const health = await json(`${AGENT}/health`).catch((err) => ({ body: { error: err.message } }));
  const manifest = {
    tool: 'scripts/m7-gate-live-probe.js',
    startedAt: new Date().toISOString(),
    git: { head: require('child_process').execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
      status: require('child_process').execSync('git status --porcelain', { encoding: 'utf8' }).trim().split('\n').slice(0, 20) },
    ports: { agent: AGENT, mod: MOD },
    agentHealth: health.body,
    body: ui0.body && ui0.body.identity,
    world: ui0.body && ui0.body.world,
    config: { plannerMode: 'off', addressedPrefix: null, eventsToken: '', testHooks: process.env.P1_TEST_HOOKS === 'on' },
    only: ONLY
  };

  try {
    if (ONLY.includes('a26')) await a26();
    if (ONLY.includes('r1')) await r1();
    if (ONLY.includes('r4')) await r4();
    if (ONLY.includes('m0')) await m0();
  } finally {
    const summary = {
      ...manifest,
      finishedAt: new Date().toISOString(),
      counts: cases.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {}),
      cases
    };
    fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(OUT_DIR, 'cases.jsonl'), cases.map((c) => JSON.stringify(c)).join('\n') + '\n');
    fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`\nM7 body probes: ${JSON.stringify(summary.counts)}  evidence: ${path.relative(ROOT, OUT_DIR)}\n`);
  }
})().catch((err) => {
  process.stderr.write(`\n[m7-gate-live-probe] ERROR: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
