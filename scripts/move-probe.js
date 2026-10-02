#!/usr/bin/env node
'use strict';

/**
 * Walk to a coordinate and print the track.
 *
 * `run-skill.js` covers the skill catalogue; this is the movement-only probe for tests
 * that are about the walker itself (crossing a river, climbing a hill, going around a
 * wall). Every second it samples /state, so the report shows where the bot actually went
 * instead of only "arrived / did not arrive".
 *
 *   node scripts/move-probe.js <x> <y> <z> [range] [timeoutSeconds] [--raw]
 */

const { loadConfig } = require('../src/util/config');
const { ClientModBody } = require('../src/body/clientModBody');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const raw = args.includes('--raw');
  const [x, y, z, range, timeoutSeconds] = args.filter((a) => !a.startsWith('--')).map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    console.error('usage: node scripts/move-probe.js <x> <y> <z> [range] [timeoutSeconds] [--raw]');
    process.exitCode = 2;
    return;
  }
  const cfg = loadConfig();
  const body = new ClientModBody(cfg, { log: console });
  if (!(await body.connect({ waitMs: 15000 }))) {
    console.error('the control mod is not answering on 127.0.0.1:8899');
    process.exitCode = 1;
    return;
  }
  await body.refresh(true);
  const start = body.snapshot();
  const target = { x, y, z };
  console.log(
    'start  :',
    JSON.stringify({ pos: start.position, air: start.air, dimension: start.dimension }),
    '-> target',
    JSON.stringify(target),
    raw ? '(raw walk)' : '(planned walk)'
  );

  const track = [];
  let moving = true;
  const sampler = (async () => {
    while (moving) {
      await sleep(1000);
      const state = await body.refresh(true).catch(() => null);
      if (!state) continue;
      const p = state.position;
      track.push({
        t: track.length + 1,
        x: +p.x.toFixed(1),
        y: +p.y.toFixed(1),
        z: +p.z.toFixed(1),
        air: state.air,
        inWater: state.inWater
      });
      process.stdout.write(
        `  t+${track.length}s  ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}` +
          `  air=${state.air}${state.inWater ? '  (in water)' : ''}\n`
      );
    }
  })();

  const started = Date.now();
  const ok = await body
    .moveTo(target, { range: Number.isFinite(range) ? range : 1.5, raw, timeoutMs: (timeoutSeconds || 120) * 1000 })
    .catch((err) => {
      console.log('moveTo threw:', err.message);
      return false;
    });
  moving = false;
  await sampler;

  const end = body.snapshot();
  console.log('result :', ok ? 'ARRIVED' : 'FAILED', JSON.stringify(body.lastMove || null));
  console.log('end    :', JSON.stringify({ pos: end.position, air: end.air, inWater: end.inWater }));
  console.log('ms     :', Date.now() - started, ' samples:', track.length);
  process.exitCode = ok ? 0 : 1;
}

main().catch((err) => {
  console.error('move probe failed:', err.stack || err.message);
  process.exitCode = 1;
});
