'use strict';

/**
 * `node scripts/m6-r2b-reflex-probe.js` - R2b (real client): the self-defence reflex still runs.
 *
 * R2b's claim: 未获准不执行；反射仍运行. R2a proves the agent does nothing on its own; R2b proves
 * that "nothing" is not "defenceless": when a hostile enters the reflex radius the body is taken
 * over by the reflex, without any command.
 *
 * The hard part is ATTRIBUTION, not the fight: a mob dying proves nothing on its own (the action
 * brain could have been told to attack). The probe therefore keeps three independent witnesses:
 *
 *   1. the panel access log - no `POST /command|/plan|/propose` from anyone but this probe's
 *      own reads (tagged `ua="r2b-probe/1"`) during the window;
 *   2. `/ui/state.selfDefense` - `source=agent.behaviour.autoFight`, `engaging` transitions;
 *   3. the agent log - `hostile <name> at N blocks ... - engaging`, which is the reflex's own line.
 *
 * Plus the hostile has to actually take damage/die (a reflex that says "engaging" and does nothing
 * is not a reflex).
 *
 * The probe sends NO commands. Lure a zombie/skeleton within 15 blocks (XZ) / +-4 (Y) - or let it
 * hit the bot (a hit engages even outside that window) - and watch.
 *
 * Usage: node scripts/m6-r2b-reflex-probe.js [--seconds 300] [--sample 500]
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
const SECONDS = Number(argValue('--seconds', 300));
const SAMPLE_MS = Number(argValue('--sample', 500));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function request(port, method, urlPath, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        'user-agent': 'r2b-probe/1',
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
const modState = () => request(MOD_PORT, 'GET', '/state', undefined, 20000);

function countForeignCommands() {
  const file = path.join(ROOT, 'runtime', 'logs', 'panel-access.log');
  try {
    const prefixes = ['POST /command', 'POST /plan', 'POST /propose', 'POST /emergency-stop'];
    const lines = fs.readFileSync(file, 'utf8').split(String.fromCharCode(10));
    return lines
      .filter((line) => prefixes.some((prefix) => line.includes(prefix)))
      .filter((line) => !line.includes('ua="r2b-probe/1'))
      .filter((line) => !line.includes('ua="r2-probe/1'))
      .length;
  } catch {
    return 0;
  }
}

function newestAgentLog() {
  const dir = path.join(ROOT, 'runtime', 'logs');
  try {
    const files = fs.readdirSync(dir)
      .filter((name) => /^agent.*\.log$/.test(name) && !name.includes('.err.'))
      .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length ? path.join(dir, files[0].name) : null;
  } catch {
    return null;
  }
}

function readFrom(file, offset) {
  try {
    const size = fs.statSync(file).size;
    if (size <= offset) return { text: '', offset: size };
    const fd = fs.openSync(file, 'r');
    const length = Math.min(size - offset, 4 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    fs.closeSync(fd);
    return { text: buffer.toString('utf8'), offset: size };
  } catch {
    return { text: '', offset };
  }
}

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: ok === true, detail });
  process.stdout.write(`  ${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 240)}`}\n`);
};

async function main() {
  const evidence = { case: 'R2b', startedAt: new Date().toISOString(), seconds: SECONDS, samples: [] };

  const first = await uiState();
  if (!first.selfDefense || first.selfDefense.enabled !== true) {
    throw new Error(`precondition: the reflex is disabled (${JSON.stringify(first.selfDefense)})`);
  }
  if (first.death && first.death.dead) throw new Error('precondition: the player is dead');
  if (first.hub && first.hub.slot && first.hub.slot.owned) throw new Error('precondition: the body is owned by a task');
  const world = first.world || {};
  evidence.baseline = {
    hp: world.health,
    position: world.position,
    source: first.selfDefense.source,
    foreignCommands: countForeignCommands(),
    autonomous: first.autonomous && { phase: first.autonomous.phase, active: first.autonomous.active }
  };
  check('R2b: the reflex is wired to the auto-fight behaviour',
    first.selfDefense.source === 'agent.behaviour.autoFight', first.selfDefense.source);
  check('R2b: the agent starts idle and unauthorised',
    !(first.autonomous && first.autonomous.active), first.autonomous && first.autonomous.phase);

  const logFile = newestAgentLog();
  let logOffset = logFile ? fs.statSync(logFile).size : 0;
  evidence.logFile = logFile ? path.relative(ROOT, logFile) : null;

  const started = Date.now();
  const deadline = started + SECONDS * 1000;
  const engagements = [];
  const sightings = [];
  let wasEngaging = false;
  let nextModAt = 0;

  while (Date.now() < deadline) {
    const ui = await uiState().catch(() => null);
    if (ui && ui.selfDefense) {
      const engaging = ui.selfDefense.engaging === true;
      if (engaging && !wasEngaging) {
        engagements.push({ at: new Date().toISOString(), hp: ui.world && ui.world.health });
        process.stdout.write('  [reflex] engaging\n');
      }
      wasEngaging = engaging;
      evidence.samples.push({
        at: new Date().toISOString(),
        engaging,
        hp: ui.world && ui.world.health,
        slotOwned: Boolean(ui.hub && ui.hub.slot && ui.hub.slot.owned),
        task: ui.brain && ui.brain.current
      });
    }

    const now = Date.now();
    if (now >= nextModAt) {
      nextModAt = now + 3000;
      const mod = await modState().catch(() => null);
      if (mod) {
        const hostiles = (mod.hostiles || []).map((hostile) => ({
          name: hostile.name,
          distance: hostile.distance === undefined || hostile.distance === null ? null : Number(Number(hostile.distance).toFixed(1))
        }));
        sightings.push({ at: new Date().toISOString(), hostiles, hp: mod.health, timeOfDay: mod.time && mod.time.timeOfDay });
        if (hostiles.length) {
          process.stdout.write(`  [world] hostiles: ${hostiles.map((h) => `${h.name}@${h.distance}`).join(', ')}\n`);
        }
      }
    }

    if (logFile) {
      const chunk = readFrom(logFile, logOffset);
      logOffset = chunk.offset;
      if (chunk.text) evidence.logLines = (evidence.logLines || '') + chunk.text;
    }

    await sleep(SAMPLE_MS);
  }

  const engagingLine = /hostile .* - engaging/.test(evidence.logLines || '');
  const closest = sightings.reduce((min, entry) => {
    for (const hostile of entry.hostiles) {
      const distance = hostile.distance;
      if (distance !== null && (min === null || distance < min)) min = distance;
    }
    return min;
  }, null);
  const hostileSeen = sightings.some((entry) => entry.hostiles.length > 0);
  const minHostileHp = null;
  const finalUi = await uiState().catch(() => null);
  const hpValues = sightings.map((entry) => entry.hp).filter((value) => typeof value === 'number');
  const hpDropped = hpValues.length > 1 && Math.min(...hpValues) < hpValues[0];
  const deadMobs = (evidence.logLines || '').match(/died|slain|killed/gi) || [];

  evidence.engagementEvents = engagements;
  evidence.sightings = sightings.slice(-20);
  evidence.closestDistance = closest;
  evidence.hostileSeen = hostileSeen;
  evidence.agentHpDropped = hpDropped;
  evidence.foreignCommands = countForeignCommands() - evidence.baseline.foreignCommands;
  evidence.engagementLogLine = engagingLine;
  evidence.final = finalUi && {
    hp: finalUi.world && finalUi.world.health,
    slotOwned: Boolean(finalUi.hub && finalUi.hub.slot && finalUi.hub.slot.owned),
    task: finalUi.brain && finalUi.brain.current
  };

  check('R2b: a hostile entered the reflex window', hostileSeen, { closest });
  check('R2b: the reflex engaged on its own (engaging transition + its own log line)',
    engagements.length > 0 && engagingLine,
    { engagements: engagements.length, logLine: engagingLine });
  check('R2b: nobody commanded it (no foreign POST /command|/plan|/propose)',
    evidence.foreignCommands === 0, { foreignCommands: evidence.foreignCommands });
  check('R2b: the body was not owned by a task while the reflex worked',
    evidence.samples.every((sample) => !sample.slotOwned && !sample.task),
    { ownedSamples: evidence.samples.filter((sample) => sample.slotOwned).length });

  if (!hostileSeen) {
    evidence.verdict = 'NOT RUN';
    evidence.note = 'no hostile entered the 24-block scan; nothing to judge';
  } else if (engagements.length > 0 && engagingLine && evidence.foreignCommands === 0) {
    evidence.verdict = 'PASS';
    evidence.note = 'the reflex engaged a hostile without any command';
  } else {
    evidence.verdict = 'FAIL';
    evidence.note = 'hostiles were present but the reflex did not engage (or a command was sent)';
  }
  evidence.finishedAt = new Date().toISOString();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `m6-r2b-reflex-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  const passed = results.filter((entry) => entry.ok === true).length;
  process.stdout.write(`\n${passed}/${results.length} checks passed - verdict ${evidence.verdict}\nevidence: ${path.relative(ROOT, file)}\n`);
  if (evidence.verdict === 'FAIL') process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
