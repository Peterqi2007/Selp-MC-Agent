'use strict';

/**
 * Farming: harvest what is ripe, till fresh soil, plant seeds.
 *
 * Ripe-vs-growing is the one thing the flat block scan cannot answer (`minecraft:wheat`
 * looks the same at every stage), which is why the control mod reports a small `crops`
 * list with block-state ages. Everything here is ordinary play otherwise: hoe the dirt,
 * right-click the farmland with seeds, break the ripe crops.
 */

const { register } = require('./registry');
const { bare } = require('../world/items');

const GROUND = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium)$/;
const SEEDS = /(_seeds$|^carrot$|^potato$|^beetroot_seeds$|^nether_wart$)/;

/**
 * Is it daytime? Prefer the clock over the client's `isDay` flag.
 *
 * The mod's flag comes from `Level.isDay()`, which on this modpack answered "day" at
 * timeOfDay 20310 (about 02:00) - the bed, however, follows the same clock the rest of
 * the world does. Beds work from 12542 to 23458, so derive from the clock and keep the
 * flag only as a fallback for bodies that do not report timeOfDay.
 */
function isDaytime(time) {
  if (!time) return null;
  if (typeof time.timeOfDay === 'number' && Number.isFinite(time.timeOfDay)) {
    const t = ((time.timeOfDay % 24000) + 24000) % 24000;
    return !(t >= 12542 && t <= 23458);
  }
  return typeof time.isDay === 'boolean' ? time.isDay : null;
}

function findItem(inventory, pattern) {
  return Object.keys(inventory || {}).find((name) => pattern.test(bare(name))) || null;
}

function blockAt(ctx, position) {
  const world = ctx.world;
  if (!world) return null;
  if (typeof world.blockAtAbsolute === 'function') return world.blockAtAbsolute(position);
  if (typeof world.blockAt === 'function') return world.blockAt(position);
  return null;
}

/** Ground blocks with air above, so there is somewhere to plant. */
function findTillable(ctx, radius) {
  const world = ctx.world;
  if (!world || typeof world.findBlocksMatching !== 'function') return [];
  const found = world.findBlocksMatching((name) => GROUND.test(bare(name)), { maxDistance: radius, count: 24 });
  return found.filter((block) => {
    const above = blockAt(ctx, { x: block.position.x, y: block.position.y + 1, z: block.position.z });
    if (above === null) return false; // unknown: do not gamble
    const name = bare(above.name);
    return name === 'air' || name === 'cave_air' || name === 'void_air';
  });
}

/** Farmland blocks with air above: ready for seeds. */
function findFarmland(ctx, radius) {
  const world = ctx.world;
  if (!world || typeof world.findBlocksMatching !== 'function') return [];
  const found = world.findBlocksMatching((name) => /farmland/.test(bare(name)), { maxDistance: radius, count: 24 });
  return found.filter((block) => {
    const above = blockAt(ctx, { x: block.position.x, y: block.position.y + 1, z: block.position.z });
    return above !== null && /^(air|cave_air|void_air)$/.test(bare(above.name));
  });
}

register({
  name: 'farm',
  title: '种田',
  description: 'Harvest ripe crops nearby, till soil with a hoe, and plant seeds.',
  params: {
    radius: { type: 'number', default: 6, min: 2, max: 16 },
    seed: { type: 'string' },
    plant: { type: 'boolean', default: true }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.useOn === 'function' && typeof ctx.body.moveTo === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot farm (needs moveTo/useOn)' }),
  async run(ctx, params) {
    const body = ctx.body;
    if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
    const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
    const inventory = (snap && snap.inventory) || {};
    const crops = (snap && snap.crops) || [];

    // ---- 1. harvest what is ripe ------------------------------------------
    const ripe = crops.filter((crop) => Number(crop.age) >= Number(crop.maxAge));
    let harvested = 0;
    for (const crop of ripe) {
      const reached = await body.moveTo(crop.position, { range: 2, timeoutMs: 15000 }).catch(() => false);
      if (!reached) continue;
      const ok = await body.dig({ name: crop.name, position: crop.position }).catch(() => false);
      if (ok) harvested += 1;
    }

    if (params.plant === false) {
      return { ok: true, harvested, tilled: 0, planted: 0, detail: `harvested ${harvested} crop(s)` };
    }

    // ---- 2. till fresh soil ------------------------------------------------
    const hoe = findItem(inventory, /_hoe$/);
    let tilled = 0;
    if (hoe) {
      await body.equip(hoe).catch(() => false);
      for (const ground of findTillable(ctx, params.radius)) {
        const reached = await body.moveTo(ground.position, { range: 3, timeoutMs: 15000 }).catch(() => false);
        if (!reached) continue;
        const ok = await body.useOn(ground.position, { face: { x: 0, y: 1, z: 0 } }).catch(() => false);
        if (ok) tilled += 1;
      }
    }

    // ---- 3. plant seeds on the farmland ----------------------------------
    const seedName = params.seed
      ? Object.keys(inventory).find((name) => bare(name) === bare(params.seed))
      : findItem(inventory, SEEDS);
    let planted = 0;
    if (seedName) {
      if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
      await body.equip(seedName).catch(() => false);
      for (const plot of findFarmland(ctx, params.radius)) {
        const reached = await body.moveTo(plot.position, { range: 3, timeoutMs: 15000 }).catch(() => false);
        if (!reached) continue;
        const ok = await body.useOn(plot.position, { face: { x: 0, y: 1, z: 0 } }).catch(() => false);
        if (ok) planted += 1;
      }
    }

    return {
      ok: true,
      harvested,
      tilled,
      planted,
      detail:
        `harvested ${harvested}, tilled ${tilled}` +
        (seedName ? `, planted ${planted}` : ' (no seeds carried)')
    };
  }
});

register({
  name: 'sleep',
  title: '睡觉过夜',
  description: 'Walk to a bed and sleep until morning.',
  params: { timeoutMs: { type: 'number', default: 120000, min: 10000, max: 600000 } },
  available: (ctx) => (ctx.body && typeof ctx.body.useOn === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot use a bed' }),
  async run(ctx, params) {
    const body = ctx.body;
    if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
    const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
    if (isDaytime(snap && snap.time) === true) {
      return { ok: true, slept: false, detail: 'it is already daytime' };
    }
    const world = ctx.world;
    const beds = world && typeof world.findBlocksMatching === 'function'
      ? world.findBlocksMatching((name) => /_bed$/.test(bare(name)), { maxDistance: 12, count: 1 })
      : [];
    if (!beds.length) return { ok: false, reason: 'no bed within 12 blocks' };
    const bed = beds[0];
    const reached = await body.moveTo(bed.position, { range: 3, timeoutMs: 20000 }).catch(() => false);
    if (!reached) return { ok: false, reason: 'could not reach the bed' };
    await body.useOn(bed.position, { face: { x: 0, y: 1, z: 0 } });

    const deadline = Date.now() + params.timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const state = typeof body.refresh === 'function' ? await body.refresh(true).catch(() => null) : null;
      if (isDaytime(state && state.time) === true) {
        return { ok: true, slept: true, detail: 'slept until morning' };
      }
    }
    // The game says *why* it refused to sleep in chat; pass that on instead of guessing.
    let chat = [];
    if (typeof body.readChat === 'function') {
      const log = await body.readChat(6).catch(() => null);
      chat = (log && log.lines) || [];
    }
    const tail = chat.filter(Boolean).slice(-2).join(' | ');
    return {
      ok: false,
      reason:
        'still not morning - the bed may be obstructed or the game refused the sleep' +
        (tail ? ` (chat: ${tail})` : '')
    };
  }
});
