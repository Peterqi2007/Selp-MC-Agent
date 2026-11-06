'use strict';

/**
 * `node scripts/m5-f1b-pause-probe.js` - F1'b: opening the pause screen must release the keys.
 *
 * F1'b's list is explicit: "游戏内暂停（PauseScreen）、死亡、断连、急停、取消、任务结束、进程退出
 * 时全部强制释放". Death / disconnect / exit / stop / cancel / task-end are covered; this is
 * the pause screen, which needs a human pressing Esc (Esc is not a KeyMapping, so the agent
 * cannot synthesise it).
 *
 * The probe holds one harmless key (sprint), waits for `/state.screen` to become PauseScreen,
 * then stops touching anything and watches the ledger from outside. "Empty" alone proves
 * nothing (the 10s hold expiry empties it), so the verdict also requires a release record
 * written after the pause was observed.
 *
 * Usage:
 *   node scripts/m5-f1b-pause-probe.js [--wait-ms 600000] [--key sprint] [--say "..."]
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
const WAIT_MS = Number(argValue('--wait-ms', 600000));
const KEY = argValue('--key', 'sprint');
const SAY = argValue('--say', null);
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
const modCommand = (command) => request(MOD_PORT, 'POST', '/command', { command });

async function ledger() {
  const receipt = await operator('inputs').catch((err) => ({ error: err.message }));
  const result = receipt && (receipt.result || receipt);
  if (!result || typeof result.count !== 'number') return { count: null, error: receipt && (receipt.reason || receipt.error) };
  return { count: result.count, held: result.held, lastReleases: result.lastReleases, at: Date.now() };
}

async function main() {
  const evidence = { case: 'F1b-pause', key: KEY, startedAt: new Date().toISOString() };

  const pre = await ledger();
  evidence.ledgerBefore = pre;
  if (pre.count !== 0) throw new Error(`precondition: the ledger is not empty (${JSON.stringify(pre)})`);
  const before = await modState();
  evidence.stateBefore = { screen: before.screen, dead: before.dead, ready: before.ready };
  if (!before || before.ready !== true) throw new Error(`precondition: no world loaded (${JSON.stringify(before)})`);
  if (before.dead === true) throw new Error('precondition: the player is dead - respawn first');

  const press = await step(`key ${KEY} down`);
  evidence.firstPress = press && (press.ok === true ? { ok: true } : { ok: false, reason: press.reason || press.error });
  evidence.firstPressAt = Date.now();
  if (SAY) await modCommand(`chat ${SAY}`).catch(() => null);

  // ---- wait for the pause screen, keeping the key down (10s record expiry)
  const presses = [];
  let lastPressAt = evidence.firstPressAt;
  let pausedAt = null;
  let pauseState = null;
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(200);
    const state = await modState().catch(() => null);
    if (state && state.dead === true) {
      evidence.verdict = 'INCONCLUSIVE';
      evidence.note = 'the player died instead of pausing';
      break;
    }
    if (state && /Pause/i.test(String(state.screen || ''))) {
      pausedAt = Date.now();
      pauseState = { screen: state.screen, screenOpen: state.screenOpen, mouseGrabbed: state.mouseGrabbed };
      break;
    }
    const current = await ledger().catch(() => null);
    if (current && current.count === 0) {
      const again = await step(`key ${KEY} down`).catch(() => null);
      lastPressAt = Date.now();
      presses.push({ at: lastPressAt, ok: Boolean(again && again.ok) });
    }
  }

  evidence.represses = presses.length;
  evidence.lastPressAt = lastPressAt;
  evidence.pausedAt = pausedAt;
  evidence.pauseState = pauseState;

  if (pausedAt !== null) {
    evidence.msSinceLastPressAtPause = pausedAt - lastPressAt;
    let clearedAt = null;
    let last = null;
    for (let i = 0; i < 50; i += 1) {
      await sleep(100);
      last = await ledger();
      if (last.count === 0) { clearedAt = Date.now(); break; }
    }
    evidence.ledgerAfter = last;
    evidence.clearedAfterPauseMs = clearedAt === null ? null : clearedAt - pausedAt;
    evidence.clearAfterLastPressMs = clearedAt === null ? null : clearedAt - lastPressAt;
    const releases = ((last && last.lastReleases) || [])
      .filter((entry) => entry && entry.at >= pausedAt - 1000);
    evidence.releaseRecords = releases;
    const observed = clearedAt !== null
      && (clearedAt - pausedAt) <= 5000
      && (clearedAt - lastPressAt) < 9000
      && releases.length > 0;
    evidence.verdict = observed ? 'PASS' : 'FAIL';
    if (!observed) {
      evidence.note = clearedAt === null
        ? 'the ledger still holds the key after the pause screen opened'
        : releases.length === 0
          ? 'the ledger emptied without a release record (expiry, not a pause release)'
          : 'the release came too late to be the pause path';
    }
  } else if (!evidence.verdict) {
    evidence.verdict = 'INCONCLUSIVE';
    evidence.note = `no pause screen within ${WAIT_MS}ms`;
  }

  // Leave nothing held.
  await step(`key ${KEY} up`).catch(() => null);

  evidence.finishedAt = new Date().toISOString();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `m5-f1b-pause-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`verdict: ${evidence.verdict}\nevidence: ${path.relative(ROOT, file)}\n`);
  if (evidence.verdict === 'FAIL') process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
