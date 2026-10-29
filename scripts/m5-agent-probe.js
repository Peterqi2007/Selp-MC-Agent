'use strict';

/**
 * `node scripts/m5-agent-probe.js` - the same M5 input-layer checks, but through the AGENT.
 *
 * The live probe (scripts/m5-live-probe.js) talks to the mod directly, which proves the mod.
 * This one talks to the agent's control API (`POST /command`, the exact endpoint the DSH
 * action brain's `mc_step` uses), which proves the wiring:
 *
 *     DSH -> agent command table -> input ledger -> body -> mod -> game
 *
 * It also proves the F1'b stop path on a real client: pressing a key and then issuing the
 * ordinary `stop` command must empty the ledger, because every Holds reason releases it.
 *
 * Requires: client running with the mod, agent running (`node scripts/run-all.js --no-server`).
 */

const http = require('http');

const AGENT_PORT = 8766;
const MOD_PORT = 8899;
const results = [];

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
        timeout: 30_000
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`non-JSON from :${port}${urlPath}: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const agent = (command) => request(AGENT_PORT, 'POST', '/command', { command });
const modState = () => request(MOD_PORT, 'GET', '/state');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${JSON.stringify(detail)}` : ''}\n`);
}

function heldOf(state) {
  return (state && state.input && state.input.held) || [];
}

async function main() {
  process.stdout.write(`M5 agent probe (agent :${AGENT_PORT} -> mod :${MOD_PORT})\n\n`);

  const state0 = await modState();
  check('the client is in a world', Boolean(state0 && state0.ready), state0 && state0.dimension);

  const before = await agent('inputs');
  check('!inputs answers through the agent', before && before.ok === true, before && before.result && before.result.count);

  // ---- press through the agent, observe at the mod -------------------------
  const down = await agent('key forward down');
  check('agent accepts key forward down', down && down.ok === true, down && down.result && down.result.action);
  await sleep(500);
  const held = heldOf(await modState());
  check('the mod reports the key as held', held.some((entry) => entry.action === 'forward'), held);

  const up = await agent('key forward up');
  check('agent accepts key forward up', up && up.ok === true);
  await sleep(300);
  check('the mod reports no held key after release', heldOf(await modState()).length === 0);

  // ---- screenshot through the agent ---------------------------------------
  const shot = await agent('shot 640');
  const shotResult = shot && (shot.result || shot);
  check('agent captures a screenshot', Boolean(shotResult && shotResult.ok), shotResult && shotResult.path);
  check('the screenshot has sane dimensions', Boolean(shotResult && shotResult.width > 0 && shotResult.height > 0),
    shotResult && `${shotResult.width}x${shotResult.height}`);

  // ---- stop path: Holds -> ledger (F1'b on a real client) -----------------
  await agent('key attack down');
  await sleep(400);
  const beforeStop = heldOf(await modState());
  check('attack is held before stop', beforeStop.some((entry) => entry.action === 'attack'), beforeStop);

  await agent('stop');
  await sleep(800);
  const afterStop = heldOf(await modState());
  check('stop releases every key (Holds -> ledger -> mod)', afterStop.length === 0, afterStop);

  const status = await agent('inputs');
  const ledger = status && (status.result || status);
  check('the agent ledger is clear after stop', Boolean(ledger && ledger.count === 0), ledger && ledger.held);

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
