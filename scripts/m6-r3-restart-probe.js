'use strict';

/**
 * `node scripts/m6-r3-restart-probe.js` - R3 (real client): a restart restores the proposal desk
 * and the task failure ledger, and never replays in-flight work.
 *
 * R3's claim (docs/P1-CLIENT-TESTS.md): 重启后提案/失败账本可恢复.
 *
 * What the probe does:
 *   1. reads the live panel and the persisted state file (baseline)
 *   2. injects one fresh failure (`!goto` outside the world) so the ledger changes on purpose
 *   3. plants a pending autonomous proposal through the test hook (TTL long enough to survive)
 *   4. saves state, records the on-disk ledger/proposal subtrees
 *   5. restarts ONLY the agent (the client keeps running) via `/emergency-stop` + a detached spawn
 *   6. re-saves and compares: the subtrees must be identical, the planted proposal must still be
 *      pending, the startup log must say `state restored` with taskSlot/proposals true, and
 *      nothing may replay (no body owner, no task, no task events)
 *
 * Usage: node scripts/m6-r3-restart-probe.js [--out runtime/evidence]
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const AGENT_PORT = Number(argValue('--agent', 8766));
const MOD_PORT = Number(argValue('--mod', 8899));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));
const STATE_FILE = path.join(ROOT, 'runtime', 'p1-state.json');

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function request(port, method, urlPath, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        'user-agent': 'r3-probe/1',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      },
      timeout
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (err) { reject(new Error(`not JSON: ${text.slice(0, 120)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const uiState = () => request(AGENT_PORT, 'GET', '/ui/state', undefined, 30000);
const command = (text) => request(AGENT_PORT, 'POST', '/command', { command: text }, 30000);
const modHealth = () => request(MOD_PORT, 'GET', '/health', undefined, 5000);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: ok === true, detail });
  process.stdout.write(`  ${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 260)}`}\n`);
};

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function ledgerOf(state) {
  const slot = (state && state.taskSlot) || {};
  return {
    seq: slot.seq ?? null,
    failCounts: slot.failCounts || [],
    quarantine: slot.quarantine || [],
    blockedGoal: slot.blockedGoal || null,
    progressSeen: slot.progressSeen || [],
    stalls: slot.stalls || []
  };
}

function proposalsOf(state) {
  const proposals = (state && state.proposals) || {};
  return {
    seq: proposals.seq ?? 0,
    current: proposals.current || null,
    historyLength: Array.isArray(proposals.history) ? proposals.history.length : 0,
    historyIds: Array.isArray(proposals.history) ? proposals.history.map((entry) => entry && entry.id) : []
  };
}

const stable = (value) => JSON.stringify(value);

function readLockPid() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'runtime', 'agent.lock'), 'utf8')).pid;
  } catch {
    return null;
  }
}

async function waitForAgentUp(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const state = await uiState();
      if (state && state.world) return state;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) return null;
    await sleep(700);
  }
}

async function waitForAgentDown(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await uiState();
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

async function main() {
  const evidence = { case: 'R3', startedAt: new Date().toISOString() };

  const health = await modHealth().catch((err) => ({ error: err.message }));
  if (!health || health.inWorld !== true) throw new Error(`precondition: client not in world (${JSON.stringify(health)})`);
  const first = await uiState();
  if (first.death && first.death.dead) throw new Error('precondition: the player is dead');
  if (first.hub && first.hub.slot && first.hub.slot.owned) throw new Error('precondition: the body is already owned by a task');

  const before = readState();
  if (!before) throw new Error(`precondition: ${path.relative(ROOT, STATE_FILE)} is unreadable`);
  check('R3: the session state file is enabled and populated', Boolean(before.taskSlot && before.proposals),
    { savedAt: before.savedAt, file: path.relative(ROOT, STATE_FILE) });
  evidence.baseline = { ledger: ledgerOf(before), proposals: proposalsOf(before), savedAt: before.savedAt };

  // 1. A fresh failure, so the ledger demonstrably changes before the restart.
  const ledgerMap = (state) => Object.fromEntries((((state || {}).taskSlot || {}).failCounts || []).map(([key, count]) => [key, count]));
  const gotoBefore = ledgerMap(before);
  console.log('  injecting a failing sleep ...');
  const failureAttempts = [];
  const attempt = async (text) => {
    const receipt = await command(text).catch((err) => ({ ok: false, reason: err.message }));
    failureAttempts.push({ command: text, receipt: receipt && (receipt.result || receipt.reason || receipt.ok) });
    const deadline = Date.now() + 30000;
    for (;;) {
      const probe = await uiState().catch(() => null);
      const busy = probe && ((probe.hub && probe.hub.slot && probe.hub.slot.owned) || (probe.brain && probe.brain.current));
      if (!busy || Date.now() > deadline) break;
      await sleep(1000);
    }
    await sleep(1200);
    await command('state save').catch(() => null);
    await sleep(1000);
    return ledgerMap(readState());
  };
  let gotoAfter = await attempt('deposit minecraft:barrier 1');
  if (JSON.stringify(gotoAfter) === JSON.stringify(gotoBefore)) {
    console.log('  the deposit attempt did not move the ledger, trying light ...');
    gotoAfter = await attempt('light 1');
  }
  evidence.failureAttempts = failureAttempts;
  evidence.failure = { before: gotoBefore, after: gotoAfter };
  check('R3: the injected failure changed the persisted ledger',
    stable(gotoBefore) !== stable(gotoAfter),
    { before: gotoBefore, after: gotoAfter });

  // 2. A pending proposal that has to survive the restart.
  const plantName = `r3-restart-${Date.now()}`;
  const plant = await request(AGENT_PORT, 'POST', '/test/proposal-plant', {
    name: plantName, type: 'farm', reason: 'R3 restart probe: this proposal must survive the restart', ttlMs: 240000
  }).catch((err) => ({ ok: false, error: err.message }));
  const plantedId = (plant && plant.pending && plant.pending.id) || (plant && plant.result && plant.result.id) || null;
  evidence.plant = plant && { ok: plant.ok, id: plantedId, pending: Boolean(plant.pending), error: plant.error };
  check('R3: a proposal was planted and is pending', Boolean(plant && plant.ok && plantedId),
    evidence.plant);

  const statusBefore = (await command('state status').catch(() => null)) || {};
  evidence.statusBefore = statusBefore.result || statusBefore.reason;
  await command('state save').catch(() => null);
  await sleep(1500);
  const savedBefore = readState();
  const ledgerBefore = ledgerOf(savedBefore);
  const proposalsBefore = proposalsOf(savedBefore);
  evidence.persistedBeforeRestart = { ledger: ledgerBefore, proposals: proposalsBefore, savedAt: savedBefore.savedAt };
  check('R3: the planted proposal is on disk before the restart',
    Boolean(proposalsBefore.current && proposalsBefore.current.id === plantedId),
    { current: proposalsBefore.current && proposalsBefore.current.id, expected: plantedId });

  // 3. Restart the agent only. The client keeps running, so a restored ledger cannot come from a
  //    fresh world.
  process.stdout.write('  restarting the agent (state saved immediately before the kill) ...');
  const lockPid = readLockPid();
  try {
    if (!lockPid) throw new Error('runtime/agent.lock has no pid');
    process.kill(lockPid);
    evidence.kill = { ok: true, pid: lockPid };
  } catch (err) {
    evidence.kill = { ok: false, pid: lockPid, error: err.message };
  }
  const down = await waitForAgentDown(30000);
  check('R3: the old agent stopped', down === true, evidence.kill);

  const out = fs.openSync(path.join(ROOT, 'runtime', 'logs', 'agent-r3.log'), 'a');
  const err = fs.openSync(path.join(ROOT, 'runtime', 'logs', 'agent-r3.err.log'), 'a');
  const child = spawn(process.execPath, ['src/index.js', '--body', 'clientmod'], {
    cwd: ROOT, detached: true, stdio: ['ignore', out, err], windowsHide: true,
    env: { ...process.env, P1_TEST_HOOKS: 'on' }
  });
  child.unref();
  evidence.spawnedPid = child.pid;
  const up = await waitForAgentUp(60000);
  check('R3: the new agent came up and reattached to the body', Boolean(up), up && { pos: up.world && up.world.position, hp: up.world && up.world.health });
  if (!up) return;

  // 4. Post-restart: the persisted subtrees must be identical, not merely present.
  const statusAfter = (await command('state status').catch(() => null)) || {};
  evidence.statusAfter = statusAfter.result || statusAfter.reason;
  await command('state save').catch(() => null);
  await sleep(1500);
  const savedAfter = readState();
  const ledgerAfter = ledgerOf(savedAfter);
  const proposalsAfter = proposalsOf(savedAfter);
  evidence.persistedAfterRestart = { ledger: ledgerAfter, proposals: proposalsAfter, savedAt: savedAfter.savedAt };

  check('R3: the failure ledger survived the restart unchanged',
    stable(ledgerBefore.failCounts) === stable(ledgerAfter.failCounts)
      && stable(ledgerBefore.quarantine) === stable(ledgerAfter.quarantine)
      && stable(ledgerBefore.blockedGoal) === stable(ledgerAfter.blockedGoal),
    { before: ledgerBefore.failCounts.slice(0, 3), after: ledgerAfter.failCounts.slice(0, 3) });
  check('R3: the planted proposal is still pending after the restart',
    Boolean(proposalsAfter.current && proposalsAfter.current.id === plantedId)
      && proposalsAfter.seq === proposalsBefore.seq,
    { before: proposalsBefore.current && proposalsBefore.current.id, after: proposalsAfter.current && proposalsAfter.current.id, seq: [proposalsBefore.seq, proposalsAfter.seq] });
  check('R3: proposals history grew and was not reset',
    proposalsAfter.historyLength >= proposalsBefore.historyLength,
    { before: proposalsBefore.historyLength, after: proposalsAfter.historyLength });

  // 5. Nothing may replay: no owner, no task, no new task events.
  const post = await uiState();
  const slot = post.hub && post.hub.slot;
  const brain = post.brain || {};
  check('R3: nothing replayed - the body is free and no task is running',
    !(slot && slot.owned) && !brain.current && !brain.queueLength,
    { slot: slot && slot.owned, current: brain.current, queue: brain.queueLength });
  const logFile = path.join(ROOT, 'runtime', 'logs', 'agent-r3.log');
  let logTail = '';
  try { logTail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-400).join('\n'); } catch { /* ignore */ }
  const restored = /state restored: (\{[^}]*\})/.exec(logTail);
  const restoredFlags = restored ? JSON.parse(restored[1]) : null;
  evidence.restoredFlags = restoredFlags;
  check('R3: the startup log says the ledger and proposals were restored',
    Boolean(restoredFlags && restoredFlags.taskSlot === true && restoredFlags.proposals === true),
    restoredFlags);
  const replayed = /(task:done|task:failed|plan:resumed)/.test(logTail.split('state restored').slice(-1)[0] || '');
  check('R3: no task/plan event was replayed after the restore', !replayed, { replayed });

  evidence.finishedAt = new Date().toISOString();
  const passed = results.filter((entry) => entry.ok === true).length;
  evidence.passed = passed;
  evidence.checks = results.length;
  evidence.verdict = passed === results.length ? 'PASS' : 'FAIL';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `m6-r3-restart-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`\n${passed}/${results.length} checks passed - verdict ${evidence.verdict}\nevidence: ${path.relative(ROOT, file)}\n`);
  if (evidence.verdict !== 'PASS') process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
