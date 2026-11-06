'use strict';

/**
 * `node scripts/m6-r2-idle-probe.js` - R2 (real client): idle behaviour follows the authorisation
 * mode, and the self-defence reflex still runs.
 *
 * R2's claim (docs/P1-CLIENT-TESTS.md): 空闲行为按授权口径（真机）- 未获准不执行；反射仍运行.
 *
 * The probe is passive: it only reads the agent's panel, the mod's `/state`, the panel access log
 * and the LLM usage ledger. Nothing is commanded during the window, so any action that appears is
 * by definition unauthorised.
 *
 * Two halves:
 *   R2a   idle window: no goal, no planning, no body owner, no action-brain command, no key held,
 *         player does not move, no new task event.
 *   R2b   reflex: a hostile inside the 24-block scan engages the self-defence reflex without any
 *         command. When no hostile shows up during the window the half is reported NOT_RUN (the
 *         world decides, not the probe).
 *
 * Usage: node scripts/m6-r2-idle-probe.js [--minutes 12] [--sample 10] [--out runtime/evidence]
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const AGENT_PORT = Number(argValue('--agent', 8766));
const MOD_PORT = Number(argValue('--mod', 8899));
const MINUTES = Number(argValue('--minutes', 12));
const FOCUS = String(argValue('--focus', 'both')).toLowerCase();
const SAMPLE_MS = Number(argValue('--sample', 10)) * 1000;
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function request(port, method, urlPath, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        'user-agent': 'r2-probe/1',
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

const uiState = () => request(AGENT_PORT, 'GET', '/ui/state', undefined, 20000);
const modState = () => request(MOD_PORT, 'GET', '/state', undefined, 15000);
const modHealth = () => request(MOD_PORT, 'GET', '/health', undefined, 5000);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: ok === true, detail });
  process.stdout.write(`  ${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 240)}`}\n`);
};

function countLines(file) {
    return fs.readFileSync(file, 'utf8').split(String.fromCharCode(10))
}

function countPanelPosts() {
  const file = path.join(ROOT, 'runtime', 'logs', 'panel-access.log');
  try {
    const posts = ['POST /command', 'POST /plan', 'POST /propose', 'POST /emergency-stop'];
    return fs.readFileSync(file, 'utf8').split(String.fromCharCode(10))
      .filter((line) => posts.some((prefix) => line.includes(prefix)))
      .filter((line) => !line.includes('ua="r2-probe')).length;
  } catch { return 0; }
}

async function main() {
  const evidence = { case: 'R2', startedAt: new Date().toISOString(), minutes: MINUTES, samples: [] };

  const health = await modHealth().catch((err) => ({ error: err.message }));
  if (!health || health.inWorld !== true) throw new Error(`precondition: client not in world (${JSON.stringify(health)})`);
  const first = await uiState();
  const world = first.world || {};
  if (first.death && first.death.dead) throw new Error('precondition: the player is dead');
  if (!first.selfDefense || first.selfDefense.enabled !== true) {
    throw new Error(`precondition: the reflex is disabled (${JSON.stringify(first.selfDefense)})`);
  }

  const usageFile = path.join(ROOT, 'runtime', 'llm-usage.jsonl');
  const baseline = {
    usageLines: countLines(usageFile),
    panelPosts: countPanelPosts(),
    position: { ...world.position },
    autonomous: { ...(first.autonomous || {}) },
    brain: { current: first.brain && first.brain.current, queueLength: first.brain && first.brain.queueLength },
    slot: first.hub && first.hub.slot,
    curriculumCompleted: first.curriculum && first.curriculum.completed
  };
  evidence.baseline = baseline;
  process.stdout.write(`baseline: autonomous.phase=${baseline.autonomous.phase} active=${baseline.autonomous.active} ` +
    `brain.current=${baseline.brain.current} queue=${baseline.brain.queueLength} slotOwned=${baseline.slot && baseline.slot.owned}\n`);

  check('R2: authorisation mode is off (nothing is allowed to self-start)',
    baseline.autonomous.active !== true && String(baseline.autonomous.phase || 'off') === 'off',
    { phase: baseline.autonomous.phase, active: baseline.autonomous.active });
  check('R2: no task and no body owner at the start of the window',
    !baseline.brain.current && baseline.brain.queueLength === 0 && !(baseline.slot && baseline.slot.owned),
    baseline.brain);

  const started = Date.now();
  const deadline = started + MINUTES * 60 * 1000;
  const violations = [];
  const reflex = { engagements: [], hostileSightings: [], lastHostiles: 0 };
  let ledger = null;
  let lastMod = null;
  let nextModAt = 0;
  let lastUi = null;

  while (Date.now() < deadline) {
    const now = Date.now();
    const ui = await uiState().catch((err) => ({ error: err.message }));
    lastUi = ui;
    if (ui && !ui.error) {
      const slot = ui.hub && ui.hub.slot;
      const brain = ui.brain || {};
      const auto = ui.autonomous || {};
      const sample = {
        at: new Date().toISOString(),
        autonomousPhase: auto.phase,
        autonomousActive: auto.active,
        brainCurrent: brain.current,
        queueLength: brain.queueLength,
        slotOwned: Boolean(slot && slot.owned),
        engaging: Boolean(ui.selfDefense && ui.selfDefense.engaging),
        health: ui.world && ui.world.health,
        pos: ui.world && ui.world.position
      };
      evidence.samples.push(sample);
      if (sample.slotOwned) violations.push({ at: sample.at, what: 'body owned', slot });
      if (sample.brainCurrent) violations.push({ at: sample.at, what: 'running task', current: sample.brainCurrent });
      if (sample.queueLength > 0) violations.push({ at: sample.at, what: 'queued task', queueLength: sample.queueLength });
      if (sample.autonomousActive || String(sample.autonomousPhase) !== 'off') {
        violations.push({ at: sample.at, what: 'autonomous active', phase: sample.autonomousPhase });
      }
      if (sample.engaging) reflex.engagements.push(sample.at);
    }

    // The mod scan is heavy; sample it less often.
    if (now >= nextModAt) {
      nextModAt = now + 30000;
      const mod = await modState().catch(() => null);
      if (mod) {
        lastMod = mod;
        const hostiles = Array.isArray(mod.hostiles) ? mod.hostiles.length : 0;
        reflex.lastHostiles = hostiles;
        reflex.hostileSightings.push({ at: new Date().toISOString(), count: hostiles, timeOfDay: mod.time && mod.time.timeOfDay });
        if (hostiles > 0) evidence.note = 'hostiles present during the window';
      }
    }

    // Ledger must stay empty: a key left down is a violation even if nothing else happened.
    if (ledger === null || now - (ledger.at || 0) > 30000) {
      const receipt = await request(AGENT_PORT, 'POST', '/command', { command: 'inputs' }, 8000).catch(() => null);
      const result = receipt && receipt.result;
      if (result && typeof result.count === 'number') {
        ledger = { count: result.count, held: result.held, at: now };
        if (result.count !== 0) violations.push({ at: new Date().toISOString(), what: 'ledger not empty', held: result.held });
      }
    }

    process.stdout.write(`.`);
    await sleep(SAMPLE_MS);
  }
  process.stdout.write('\n');

  const end = await uiState().catch(() => null);
  const endWorld = (end && end.world) || {};
  const drift = Math.hypot((endWorld.position && endWorld.position.x || 0) - baseline.position.x,
    (endWorld.position && endWorld.position.z || 0) - baseline.position.z);
  const usageDelta = countLines(usageFile) - baseline.usageLines;
  const panelDelta = countPanelPosts() - baseline.panelPosts;

  evidence.durationMs = Date.now() - started;
  evidence.violations = violations;
  evidence.ledger = ledger;
  evidence.reflex = {
    engagements: reflex.engagements.length,
    hostileSightings: reflex.hostileSightings.length,
    maxHostiles: reflex.hostileSightings.reduce((max, sighting) => Math.max(max, sighting.count || 0), 0),
    lastTimeOfDay: lastMod && lastMod.time && lastMod.time.timeOfDay
  };
  evidence.deltas = { usageLines: usageDelta, panelPosts: panelDelta, positionDrift: drift };

  check('R2a: no unauthorised body use (no task, no queue, no body owner)', violations.length === 0, violations.slice(0, 4));
  check('R2a: the action-brain sent no command/plan during the window', panelDelta === 0, { panelPosts: panelDelta });
  check('R2a: the player did not move on its own', drift < 1, { drift });
  check('R2a: no key stayed held', ledger === null || ledger.count === 0, ledger && ledger.held);
  check('R2a: autonomous mode stayed off', !(end && end.autonomous && (end.autonomous.active || String(end.autonomous.phase) !== 'off')),
    end && end.autonomous && { phase: end.autonomous.phase, active: end.autonomous.active });

  const r2aChecks = results.filter((entry) => entry.name.startsWith('R2a') || entry.name.startsWith('R2:'));
  const r2aPass = r2aChecks.length > 0 && r2aChecks.every((entry) => entry.ok === true);
  if (FOCUS === 'r2a') {
    results.push({ name: 'R2b: reflex exercised', ok: null, detail: 'NOT RUN - focus=r2a, the reflex half needs a hostile in range' });
    console.log('  SKIP R2b: reflex exercised :: focus=r2a (reflex half not judged)');
    evidence.verdict = r2aPass ? 'PASS' : 'FAIL';
    evidence.note = r2aPass
      ? 'R2a passed (idle behaviour follows the authorisation mode). R2b is NOT RUN and must not be inferred from this file.'
      : 'R2a failed - see the checks above';
  } else if (evidence.reflex.maxHostiles > 0) {
    check('R2b: a hostile engaged the self-defence reflex without a command',
      evidence.reflex.engagements > 0, evidence.reflex);
    evidence.verdict = r2aPass && evidence.reflex.engagements > 0 ? 'PASS' : 'FAIL';
    if (evidence.verdict === 'FAIL') evidence.note = r2aPass ? 'hostiles were scanned but the reflex never engaged' : 'R2a failed';
  } else {
    results.push({ name: 'R2b: reflex exercised', ok: null, detail: 'NOT RUN - no hostile inside the 24-block scan during the window' });
    console.log('  SKIP R2b: reflex exercised :: focus=r2a (reflex half not judged)');
    evidence.verdict = r2aPass ? 'PARTIAL' : 'FAIL';
    evidence.note = r2aPass ? 'R2a passed; R2b not run (no hostile in range).' : 'R2a failed';
  }
  evidence.usageLines = usageDelta;
  evidence.finishedAt = new Date().toISOString();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `m6-r2-idle-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  const passed = results.filter((entry) => entry.ok === true).length;
  const ran = results.filter((entry) => entry.ok !== null).length;
  process.stdout.write(`\n${passed}/${results.length} checks passed - verdict ${evidence.verdict}\nevidence: ${path.relative(ROOT, file)}\n`);
  if (evidence.verdict === 'FAIL') process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
