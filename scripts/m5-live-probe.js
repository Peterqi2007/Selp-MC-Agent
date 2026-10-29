'use strict';

/**
 * `node scripts/m5-live-probe.js` - real-client check of the M5 input layer.
 *
 * Runs against a live Forge client with the agent-client mod loaded (default
 * 127.0.0.1:8899). It is the real-machine half of F1' and the first slice of A21:
 *
 *   F1'a  capture comes from the game's render target and moves nothing but the player;
 *   F1'b  a held key is bounded, visible in the ledger, and released (by deadline or by
 *         an explicit `up`);
 *   A21    the effects of the input are verified from structured state (position), not
 *         from "the key was sent".
 *
 * Evidence (JSON + PNG) is written under runtime/evidence/ so a failure leaves a trail.
 *
 * Usage: node scripts/m5-live-probe.js [--base http://127.0.0.1:8899] [--out <dir>]
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadConfig } = require('../src/util/config');

const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const cfg = loadConfig({ profile: null });
const cm = (cfg.agent && cfg.agent.clientMod) || {};
const base = argValue('--base') || `http://${cm.host || '127.0.0.1'}:${cm.port || 8899}`;
const token = cm.token || '';
const outDir = path.resolve(argValue('--out') || path.join('runtime', 'evidence'));
const ROOT = path.resolve(__dirname, '..');

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: {
          ...(token ? { 'x-agent-token': token } : {}),
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
        },
        timeout: 30_000
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) });
          } catch (err) {
            reject(new Error(`non-JSON response (${res.statusCode}): ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}\n`);
}

async function command(line) {
  const res = await request('POST', '/command', { command: line });
  return res.json;
}

async function state() {
  const res = await request('GET', '/state');
  return res.json;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evidence = { base, startedAt: new Date().toISOString(), checks: results, samples: {} };

  process.stdout.write(`M5 live probe against ${base}\n\n`);

  // ---------------------------------------------------------------- health
  process.stdout.write('1. client is up and in a world\n');
  let health = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      health = (await request('GET', '/health')).json;
      break;
    } catch (err) {
      await sleep(2000);
    }
  }
  check('the control API answers /health', Boolean(health), health && health.version);
  evidence.samples.health = health;

  let snap = null;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    snap = await state().catch(() => null);
    if (snap && snap.ready) break;
    await sleep(2000);
  }
  check('the client is in a world (state.ready)', Boolean(snap && snap.ready), snap && (snap.reason || snap.dimension));
  if (!snap || !snap.ready) {
    evidence.failedEarly = 'no world';
    fs.writeFileSync(path.join(outDir, `m5-live-${stamp}.json`), JSON.stringify(evidence, null, 2));
    return finish();
  }
  evidence.samples.stateAtStart = {
    position: snap.position,
    gameTime: snap.gameTime,
    screen: snap.screen,
    input: snap.input
  };

  // ------------------------------------------------------------ tick clock
  process.stdout.write('\n2. the tick clock and ledger come from /state (F1b)\n');
  check('state reports a monotonic gameTime', Number.isFinite(snap.gameTime), String(snap.gameTime));
  check('state reports the input ledger', Boolean(snap.input) && typeof snap.input === 'object', snap.input && snap.input.count);
  const startedTick = snap.gameTime;
  await sleep(1200);
  snap = await state();
  check('gameTime advances while idle', snap.gameTime > startedTick, `${startedTick} -> ${snap.gameTime}`);

  // ------------------------------------------------------------- screenshot
  process.stdout.write('\n3. screenshot is taken from the game frame (F1a)\n');
  const shot = await command('shot 768');
  const shotOk = shot && shot.ok && shot.pngBase64;
  check('shot returns a PNG', Boolean(shotOk), shotOk ? `${shot.width}x${shot.height} ${shot.bytes}B (source ${shot.sourceWidth}x${shot.sourceHeight})` : shot && shot.error);
  let shotPath = null;
  if (shotOk) {
    shotPath = path.join(outDir, `m5-shot-${stamp}.png`);
    fs.writeFileSync(shotPath, Buffer.from(shot.pngBase64, 'base64'));
    const header = fs.readFileSync(shotPath).subarray(0, 4);
    check('the saved file is a real PNG', header[0] === 0x89 && header[1] === 0x50, shotPath);
    check('the capture is downscaled to the requested edge', Math.max(shot.width, shot.height) <= 768, `${shot.width}x${shot.height}`);
    evidence.samples.screenshot = { path: path.relative(ROOT, shotPath), width: shot.width, height: shot.height, bytes: shot.bytes, sourceWidth: shot.sourceWidth, sourceHeight: shot.sourceHeight };
  }

  // ------------------------------------------------------------------ keys
  process.stdout.write('\n4. a key press moves the player and is visible in the ledger (F1b + A21)\n');
  const before = await state();
  const yaw0 = before.yaw;
  const pos0 = before.position;
  const down = await command('key forward down');
  check('key forward down is acknowledged', down && down.ok === true, down && { tick: down.tick, blockedByScreen: down.blockedByScreen });
  let during = await command('inputs');
  check('the ledger reports the held key', Boolean(during && during.count >= 1), during && during.held);
  await sleep(1500);
  const moved = await state();
  check('the player actually moved', dist(pos0, moved.position) > 0.2, `${fmt(pos0)} -> ${fmt(moved.position)}`);
  check('looking did not change (no hidden camera drift)', Math.abs(moved.yaw - yaw0) < 1, `${yaw0} -> ${moved.yaw}`);
  const up = await command('key forward up');
  check('key forward up is acknowledged', up && up.ok === true, up && up.tick);
  const after = await command('inputs');
  check('the ledger is empty after release', Boolean(after && after.count === 0), after && after.held);
  evidence.samples.keyForward = { before: pos0, after: moved.position, down, up };

  // ------------------------------------------------------------------ hold
  process.stdout.write('\n5. a bounded hold releases by itself (F1b cap)\n');
  const holdStart = await state();
  const held = await command('hold jump 600');
  check('hold is acknowledged with a deadline', Boolean(held && held.ok && held.untilTick), held && { untilTick: held.untilTick, clamped: held.clamped });
  const heldNow = await command('inputs');
  check('the ledger shows the hold while it runs', Boolean(heldNow && heldNow.count >= 1), heldNow && heldNow.held);
  await sleep(1600);
  const heldLater = await command('inputs');
  check('the hold is released without an explicit up', Boolean(heldLater && heldLater.count === 0), heldLater && heldLater.held);
  const holdEnd = await state();
  check('the tick clock advanced past the hold', holdEnd.gameTime > held.untilTick, `${held.untilTick} <= ${holdEnd.gameTime}`);
  evidence.samples.holdJump = { start: holdStart.position, end: holdEnd.position, held, after: heldLater.held };

  // ------------------------------------------------------- unknown key is refused
  process.stdout.write('\n6. the input layer refuses what it cannot do\n');
  const bad = await command('key fly up');
  check('an unknown key is refused with a reason', Boolean(bad && bad.ok === false && bad.error), bad && bad.error);
  const badVerb = await command('hold');
  check('hold without an action is refused', Boolean(badVerb && badVerb.ok === false), badVerb && badVerb.error);

  // ------------------------------------------------------------- clean state
  const final = await state();
  check('no key is left held at the end', Boolean(final.input && final.input.count === 0), final.input && final.input.held);
  evidence.final = { position: final.position, gameTime: final.gameTime, input: final.input };

  evidence.finishedAt = new Date().toISOString();
  const evidencePath = path.join(outDir, `m5-live-${stamp}.json`);
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  process.stdout.write(`\nevidence: ${path.relative(ROOT, evidencePath)}\n`);
  if (shotPath) process.stdout.write(`screenshot: ${path.relative(ROOT, shotPath)}\n`);
  return finish();
}

function dist(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a.x - b.x, (a.y || 0) - (b.y || 0), a.z - b.z);
}

function fmt(p) {
  return p ? `${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` : 'n/a';
}

function finish() {
  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
  return failed.length === 0;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
