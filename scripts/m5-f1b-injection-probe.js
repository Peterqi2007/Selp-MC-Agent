'use strict';

/**
 * `node scripts/m5-f1b-injection-probe.js --exit` - F1'b: the ledger must not survive the client.
 *
 * F1'b (docs/P1-M5.md §7.3) says the pressed-key set is always enumerable and is forcibly
 * released on pause / death / disconnect / stop / cancel / task end / **process exit**. The
 * contract half lives in `p1:m5:test`; this file is the real-client half for the injection
 * that can be performed without a death: press a key, kill the game, then watch the agent's
 * ledger from outside.
 *
 * The timing matters: a `key <action> down` record expires after 10s anyway, so the client
 * must die within a second or two and the observation window must stay well inside that
 * bound - otherwise "released" would just be the expiry timer, which proves nothing.
 *
 * Usage:
 *   node scripts/m5-f1b-injection-probe.js --exit            # press forward, kill java, watch
 *   node scripts/m5-f1b-injection-probe.js --exit --dry-run  # do not kill anything
 */

const { execSync } = require('child_process');
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
const DRY_RUN = args.includes('--dry-run');
const MODE = args.includes('--exit') ? 'exit' : null;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function request(method, urlPath, body, timeout = 10000) {
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Operator channel: read-only ledger reads must work even while a stop lock is armed. */
const operator = (command) => request('POST', '/command', { command });
const step = (command) => request('POST', '/command', { command, via: 'mc_step' });

async function ledger() {
  const receipt = await operator('inputs').catch((err) => ({ error: err.message }));
  const result = receipt && (receipt.result || receipt);
  if (!result || typeof result.count !== 'number') return { count: null, error: receipt && (receipt.reason || receipt.error) };
  return { count: result.count, held: result.held, lastReleases: result.lastReleases, mod: result.mod || null };
}

function clientAlive() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq java.exe" /NH', { encoding: 'utf8' });
    return /java\.exe/i.test(out);
  } catch {
    return false;
  }
}

async function exitInjection() {
  const evidence = { case: 'F1b-exit', startedAt: new Date().toISOString(), kill: DRY_RUN ? 'dry-run' : 'taskkill' };

  const pre = await ledger();
  evidence.ledgerBefore = pre;
  if (pre.count !== 0) throw new Error(`precondition: the ledger is not empty (${JSON.stringify(pre)})`);

  const press = await step('key forward down');
  evidence.press = press && (press.ok === true ? { ok: true } : { ok: false, reason: press.reason || press.error });
  await sleep(200);
  const held = await ledger();
  evidence.ledgerHeld = held;
  evidence.pressedAt = Date.now();

  if (!DRY_RUN) {
    try { execSync('taskkill /F /IM java.exe', { stdio: 'ignore' }); } catch { /* already gone */ }
    try { execSync('taskkill /F /IM javaw.exe', { stdio: 'ignore' }); } catch { /* already gone */ }
  }
  const killedAt = Date.now();
  evidence.killedAt = killedAt;

  let clearedAt = null;
  let last = null;
  // The record expires 10s after the press, so stop observing well before that: a release that
  // only happens at expiry would not be a release path at all.
  for (let i = 0; i < 60; i += 1) {
    await sleep(120);
    last = await ledger();
    if (last.count === 0) { clearedAt = Date.now(); break; }
  }
  evidence.ledgerAfter = last;
  evidence.clientGone = !clientAlive();
  evidence.clearedAfterMs = clearedAt === null ? null : clearedAt - killedAt;
  evidence.withinExpiry = clearedAt !== null && (clearedAt - evidence.pressedAt) < 10000;
  evidence.releaseReason = (last && last.lastReleases && last.lastReleases[0] && last.lastReleases[0].reason) || null;
  evidence.verdict = evidence.clearedAfterMs !== null && evidence.withinExpiry ? 'PASS' : 'FAIL';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `m5-f1b-${MODE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`evidence: ${path.relative(ROOT, file)}\n`);
  if (evidence.verdict !== 'PASS') process.exitCode = 1;
}

async function main() {
  if (MODE !== 'exit') {
    process.stdout.write('usage: node scripts/m5-f1b-injection-probe.js --exit [--dry-run]\n');
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`F1'b exit injection through the agent (${AGENT_PORT})${DRY_RUN ? ' [dry-run]' : ''}\n`);
  await exitInjection();
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
