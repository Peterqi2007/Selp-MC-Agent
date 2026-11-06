'use strict';

/**
 * `node scripts/m5-f1b-disconnect-probe.js` - F1'b: leaving the world must release the keys.
 *
 * The exit injection (`m5-f1b-injection-probe.js --exit`) kills the process, so the agent
 * notices a *body that stopped answering*. A disconnect is different: the client keeps
 * running and the mod keeps answering `/health` and `/state` - only the world is gone
 * (`inWorld:false` / `ready:false`). Nothing in the process dies, so the release has to come
 * from the disconnect being *observed*.
 *
 * The probe keeps one harmless key down (sneak) while it waits: a `key ... down` record expires
 * after 10s, so it re-presses whenever the ledger empties (the world may also clear keys while
 * a screen is open). When `inWorld` flips to false it stops pressing and watches the ledger
 * from outside. A release that only happens at the 10s expiry is NOT a disconnect release and
 * is reported as FAIL, with the timing that proves it.
 *
 * Usage:
 *   node scripts/m5-f1b-disconnect-probe.js [--wait-ms 90000] [--say "press Esc now"]
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
const WAIT_MS = Number(argValue('--wait-ms', 90000));
const SAY = argValue('--say', null);
const VIA_VERB = args.includes('--via-verb');
const KEY = argValue('--key', 'sneak');
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function request(port, method, urlPath, body, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const step = (command) => request(AGENT_PORT, 'POST', '/command', { command, via: 'mc_step' });
const operator = (command) => request(AGENT_PORT, 'POST', '/command', { command });
const modCommand = (command) => request(MOD_PORT, 'POST', '/command', { command });
const health = () => request(MOD_PORT, 'GET', '/health', undefined, 3000);

async function ledger() {
  const receipt = await operator('inputs').catch((err) => ({ error: err.message }));
  const result = receipt && (receipt.result || receipt);
  if (!result || typeof result.count !== 'number') return { count: null, error: receipt && (receipt.reason || receipt.error) };
  return { count: result.count, held: result.held, lastReleases: result.lastReleases, at: Date.now() };
}

async function main() {
  const evidence = { case: 'F1b-disconnect', key: KEY, startedAt: new Date().toISOString() };

  const pre = await ledger();
  evidence.ledgerBefore = pre;
  if (pre.count !== 0) throw new Error(`precondition: the ledger is not empty (${JSON.stringify(pre)})`);

  const before = await health();
  evidence.healthBefore = before;
  if (!before || before.inWorld !== true) throw new Error(`precondition: the client is not in a world (${JSON.stringify(before)})`);

  const announce = await step(`key ${KEY} down`);
  evidence.firstPress = announce && (announce.ok === true ? { ok: true } : { ok: false, reason: announce.reason || announce.error });
  evidence.firstPressAt = Date.now();
  if (SAY) {
    // Best effort: a normal chat line is the only signal the player sees inside the game.
    await modCommand(`chat ${SAY}`).catch(() => null);
  }

  /**
   * Two ways to disconnect: a human pressing Esc -> "Disconnect", or the mod's own
   * `disconnect` verb (added for this injection). The verb path is the repeatable one; the
   * operator path stays available because it is the real button.
   */
  if (VIA_VERB) {
    await sleep(800);
    const fired = await modCommand('disconnect').catch((err) => ({ error: err.message }));
    evidence.verb = { fired: Boolean(fired && fired.ok === true), detail: fired && (fired.error || fired.ok) };
    evidence.trigger = 'mod-verb';
  } else {
    evidence.trigger = 'operator';
  }

  // ---- wait for the disconnect, keeping one key down
  const presses = [];
  let disconnectedAt = null;
  let lastPressAt = evidence.firstPressAt;
  const deadline = Date.now() + WAIT_MS;
  let lastHealth = before;
  while (Date.now() < deadline) {
    await sleep(250);
    lastHealth = await health().catch(() => null);
    if (lastHealth && lastHealth.inWorld === false) {
      disconnectedAt = Date.now();
      break;
    }
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
  evidence.healthLast = lastHealth;
  evidence.disconnectedAt = disconnectedAt;

  if (disconnectedAt === null) {
    evidence.verdict = 'INCONCLUSIVE';
    evidence.note = `the world was still loaded after ${WAIT_MS}ms - nobody disconnected`;
  } else {
    evidence.msSinceLastPressAtDisconnect = disconnectedAt - lastPressAt;
    let clearedAt = null;
    let last = null;
    for (let i = 0; i < 100; i += 1) {
      await sleep(100);
      last = await ledger();
      if (last.count === 0) { clearedAt = Date.now(); break; }
    }
    evidence.ledgerAfter = last;
    evidence.clearedAfterDisconnectMs = clearedAt === null ? null : clearedAt - disconnectedAt;
    evidence.clearAfterLastPressMs = clearedAt === null ? null : clearedAt - lastPressAt;
    evidence.releaseReason = (last && last.lastReleases && last.lastReleases[0] && last.lastReleases[0].reason) || null;
    const observedRelease = clearedAt !== null
      && (clearedAt - disconnectedAt) <= 5000
      && (clearedAt - lastPressAt) < 9000;
    evidence.verdict = observedRelease ? 'PASS' : 'FAIL';
    if (!observedRelease) {
      evidence.note = clearedAt === null
        ? 'the ledger never emptied after the disconnect'
        : 'the ledger only emptied at the 10s hold expiry, not because the world went away';
    }
  }

  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `m5-f1b-disconnect-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`verdict: ${evidence.verdict}\nevidence: ${path.relative(ROOT, file)}\n`);
  if (evidence.verdict === 'FAIL') process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
