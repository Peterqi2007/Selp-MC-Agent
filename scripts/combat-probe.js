#!/usr/bin/env node
'use strict';

/**
 * Combat probe: wait for a hostile, then run the real `attack` skill with a health track.
 *
 * The skill layer is pure "pick the nearest hostile and swing"; what cannot be seen from
 * the code is what the live server does with those swings (reach, cooldown, knockback).
 * This probe watches the fight and prints what actually happened.
 *
 *   node scripts/combat-probe.js [waitSeconds] [maxDistance] [timeoutSeconds] [type]
 */

const { loadConfig } = require('../src/util/config');
const { ClientModBody } = require('../src/body/clientModBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const skills = require('../src/skills');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const [waitSeconds, maxDistance, timeoutSeconds, type] = process.argv.slice(2);
  const waitMs = Number(waitSeconds || 60) * 1000;
  const cfg = loadConfig();
  const body = new ClientModBody(cfg, { log: console });
  if (!(await body.connect({ waitMs: 15000 }))) {
    console.error('the control mod is not answering on 127.0.0.1:8899');
    process.exitCode = 1;
    return;
  }

  // ---- 1. wait for something to fight ---------------------------------------
  const deadline = Date.now() + waitMs;
  let found = null;
  while (Date.now() < deadline) {
    const state = await body.refresh(true).catch(() => null);
    const hostiles = state ? state.hostiles || [] : [];
    if (hostiles.length) {
      found = hostiles;
      break;
    }
    await sleep(1000);
  }
  if (!found) {
    console.log(`no hostile appeared within ${Math.round(waitMs / 1000)}s - nothing to fight here`);
    return;
  }
  console.log('hostiles:', JSON.stringify(found));
  const before = body.snapshot();
  console.log(
    'before :',
    JSON.stringify({ pos: before.position, health: before.health, held: before.heldItem, hostiles: found.length })
  );

  // ---- 2. fight, sampling health --------------------------------------------
  const ctx = { cfg, body, world: new BodyWorldView(body, cfg, { log: console }), log: console };
  const targetId = found[0].id;
  let lastHealth = found[0].health;
  let minHealth = found[0].health;
  let fighting = true;
  const sampler = (async () => {
    let t = 0;
    while (fighting) {
      await sleep(1000);
      t += 1;
      const state = await body.refresh(true).catch(() => null);
      if (!state) continue;
      const target = (state.hostiles || []).find((h) => h.id === targetId);
      if (target && Number.isFinite(target.health)) {
        lastHealth = target.health;
        minHealth = Math.min(minHealth, target.health);
      }
      process.stdout.write(
        `  t+${t}s hp=${state.health} food=${state.food} pos=${state.position.x.toFixed(1)},` +
          `${state.position.y.toFixed(1)},${state.position.z.toFixed(1)}` +
          `  target=${
            target
              ? `${target.name}@${Math.round(target.distance)}m hp=${target.health}`
              : `gone (min hp seen ${minHealth})/hostiles=` + (state.hostiles || []).length
          }\n`
      );
    }
  })();

  const params = {
    maxDistance: Number(maxDistance || 24),
    timeoutMs: Number(timeoutSeconds || 30) * 1000
  };
  if (type) params.type = type;
  const result = await skills.run('attack', ctx, params);
  fighting = false;
  await sampler;

  const after = body.snapshot();
  console.log('RESULT', JSON.stringify(result));
  console.log(
    'target :',
    JSON.stringify({ id: targetId, name: found[0].name, startHealth: found[0].health, minHealth, lastHealth })
  );
  console.log(
    'after  :',
    JSON.stringify({
      pos: after.position,
      health: after.health,
      food: after.food,
      held: after.heldItem,
      hostiles: (after.hostiles || []).length,
      inv: after.inventory
    })
  );
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err) => {
  console.error('combat probe failed:', err.stack || err.message);
  process.exitCode = 1;
});
