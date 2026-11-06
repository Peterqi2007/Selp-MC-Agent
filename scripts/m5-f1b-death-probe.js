'use strict';

/**
 * `node scripts/m5-f1b-death-probe.js` - F1'b: dying must release the keys.
 *
 * Death is the third way the world can change under the agent besides exit and disconnect:
 * the client, the mod and the connection all stay alive, only `dead` flips. The release must
 * come from the death hold (`DeathWatch` -> `holds.hold('dead')` -> `releaseAll('dead')`).
 *
 * The probe holds one harmless key (sneak) and keeps re-pressing so the record cannot expire
 * on its own, waits for `dead:true`, then stops touching anything and watches the ledger from
 * outside. A release that only happens at the 10s expiry proves nothing and is reported FAIL
 * with the timing that shows it.
 *
 * Usage:
 *   node scripts/m5-f1b-death-probe.js [--wait-ms 1200000] [--key sneak]
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
const MOD_PORT = Number(argValue('--mod', 8899));
const WAIT_MS = Number(argValue('--wait-ms', 1200000));
const KEY = argValue('--key', 'sneak');
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function request(port, method, urlPath, body, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const step = (command) => request(AGENT_PORT, 'POST', '/command', { command, via: 'mc_step' });
const operator = (command) => request(AGENT_PORT, 'POST', '/command', { command });
const modState = () => request(MOD_PORT, 'GET', '/state', undefined, 4000);
const health = () => request(MOD_PORT, 'GET', '/health', undefined, 3000);

async function ledger() {
  const receipt = await operator('inputs').catch((err) => ({ error: err.message }));
  const result = receipt && (receipt.result || receipt);
  if (!result || typeof result.count !== 'number') return { count: null, error: receipt && (receipt.reason || receipt.error) };
  return { count: result.count, held: result.held, lastReleases: result.lastReleases, at: Date.now() };
}

async function main() {
  const evidence = { case: 'F1b-death', key: KEY, startedAt: new Date().toISOString() };

  const pre = await ledger();
  evidence.ledgerBefore = pre;
  if (pre.count !== 0) throw new Error(`precondition: the ledger is not empty (${JSON.stringify(pre)})`);

  const before = await modState().catch((err) => ({ error: err.message }));
  evidence.stateBefore = { dead: before && before.dead, health: before && before.health, ready: before && before.ready };
  if (!before || before.ready !== true) throw new Error(`precondition: no world loaded (${JSON.stringify(before)})`);
  if (before.dead === true) throw new Error('precondition: the player is already dead - respawn first, then re-run');

  const press = await step(`key ${KEY} down`);
  evidence.firstPress = press && (press.ok === true ? { ok: true } : { ok: false, reason: press.reason || press.error });
  evidence.firstPressAt = Date.now();

  const presses = [];
  let lastPressAt = evidence.firstPressAt;
  let deadAt = null;
  let deathsSeen = null;
  const deadline = Date.now() + WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(200);
    const state = await modState().catch(() => null);
    const alive = await health().catch(() => null);
    if (alive && alive.inWorld === false) {
      evidence.verdict = 'INCONCLUSIVE';
      evidence.note = 'the client left the world before dying';
      break;
    }
    if (state && state.dead === true) {
      deadAt = Date.now();
      deathsSeen = state;
      break;
    }
    // Keep the key down: a `key ... down` record expires after 10s on its own.
    const nowLedger = await ledger().catch(() => null);
    if (nowLedger && nowLedger.count === 0) {
      const again = await step(`key ${KEY} down`).catch(() => null);
      const at = Date.now();
      lastPressAt = at;
      presses.push({ at, ok: Boolean(again && again.ok), reason: again && (again.reason || null) });
    }
  }

  evidence.represses = presses.length;
  evidence.lastPressAt = lastPressAt;
  evidence.deadAt = deadAt;

  if (deadAt !== null) {
    evidence.healthAtDeath = deathsSeen && deathsSeen.health;
    evidence.positionAtDeath = deathsSeen && deathsSeen.position;
    evidence.msSinceLastPressAtDeath = deadAt - lastPressAt;

    let clearedAt = null;
    let last = null;
    for (let i = 0; i < 80; i += 1) {
      await sleep(100);
      last = await ledger();
      if (last.count === 0) { clearedAt = Date.now(); break; }
    }
    evidence.ledgerAfter = last;
    evidence.clearedAfterDeathMs = clearedAt === null ? null : clearedAt - deadAt;
    evidence.clearAfterLastPressMs = clearedAt === null ? null : clearedAt - lastPressAt;
    /**
     * "Empty" alone is not evidence: the 10s hold expiry and the state-poll reconciliation both
     * empty it too. The record must name the death path, and its `count` says whether a key was
     * still held when that path ran (count 0 means something else got there first).
     */
    const deathReleases = ((last && last.lastReleases) || [])
      .filter((entry) => entry && entry.reason === 'dead' && entry.at >= deadAt - 1000);
    evidence.deathRelease = deathReleases[0] || null;
    evidence.releaseReason = deathReleases.length ? 'dead' : null;
    const observed = clearedAt !== null
      && (clearedAt - deadAt) <= 5000
      && (clearedAt - lastPressAt) < 9000
      && deathReleases.length > 0;
    evidence.verdict = observed ? 'PASS' : 'FAIL';
    if (!observed) {
      evidence.note = clearedAt === null
        ? 'the ledger never emptied after death'
        : deathReleases.length === 0
          ? 'the ledger emptied without a death release record (expiry or poll reconciliation)'
          : 'the ledger only emptied at the 10s hold expiry';
    }
  } else if (!evidence.verdict) {
    evidence.verdict = 'INCONCLUSIVE';
    evidence.note = `nobody died within ${WAIT_MS}ms`;
  }

  // Leave the key up if the death screen swallowed the release.
  await step(`key ${KEY} up`).catch(() => null);

  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `m5-f1b-death-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`verdict: ${evidence.verdict}\nevidence: ${path.relative(ROOT, file)}\n`);
  if (evidence.verdict === 'FAIL') process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
