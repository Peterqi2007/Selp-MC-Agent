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

/** Water blocks around the player; used to prefer plots that will stay hydrated. */
function findWater(ctx, radius) {
  const world = ctx.world;
  if (!world || typeof world.findBlocksMatching !== 'function') return [];
  return world.findBlocksMatching((name) => /water/.test(bare(name)), {
    maxDistance: radius,
    count: 256
  });
}

/**
 * Tillable ground, hydrated candidates first.
 *
 * "Till by the water" is not just phrasing: a plot stays hydrated only when water sits
 * within four blocks horizontally at the SAME level or one ABOVE (vanilla FarmBlock
 * scans y..y+1). Water one block *below* does not count - tilling the bank while the pond
 * sits under it produces dry farmland that decays back to dirt when nothing is planted,
 * which is exactly what happened on the first attempt. Dry plots still work, so they stay
 * in the list as a fallback.
 */
function rankTillableByWater(ctx, radius) {
  const candidates = findTillable(ctx, radius);
  if (!candidates.length) return candidates;
  const water = findWater(ctx, radius + 5);
  if (!water.length) return candidates;
  const hydrated = (position) =>
    water.some(
      (w) =>
        Math.abs(w.position.x - position.x) <= 4 &&
        Math.abs(w.position.z - position.z) <= 4 &&
        (w.position.y === position.y || w.position.y === position.y + 1)
    );
  return candidates
    .map((block) => ({ block, wet: hydrated(block.position) }))
    .sort((a, b) => Number(b.wet) - Number(a.wet) || a.block.distance - b.block.distance)
    .map((entry) => entry.block);
}

register({
  name: 'farm',
  title: '种田',
  description: 'Harvest ripe crops nearby, till soil with a hoe, and plant seeds.',
  params: {
    radius: { type: 'number', default: 6, min: 2, max: 16 },
    seed: { type: 'string' },
    plant: { type: 'boolean', default: true },
    plots: { type: 'number', min: 1, max: 64 },
    harvest: { type: 'boolean', default: true },
    till: { type: 'boolean', default: true }
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
    const ripe = params.harvest === false
      ? []
      : crops.filter((crop) => Number(crop.age) >= Number(crop.maxAge));
    let harvested = 0;
    for (const crop of ripe) {
      const reached = await body.moveTo(crop.position, { range: 2, timeoutMs: 15000 }).catch(() => false);
      if (!reached) continue;
      const ok = await body.dig({ name: crop.name, position: crop.position }).catch(() => false);
      if (ok) harvested += 1;
    }

    // ---- 2. till fresh soil ------------------------------------------------
    const hoe = findItem(inventory, /_hoe$/);
    let tilled = 0;
    const freshPlots = [];
    if (hoe && params.till !== false) {
      await body.equip(hoe).catch(() => false);
      const wanted = params.plots ? Math.max(1, Math.floor(params.plots)) : Infinity;
      for (const ground of rankTillableByWater(ctx, params.radius)) {
        if (tilled >= wanted) break;
        const reached = await body.moveTo(ground.position, { range: 3, timeoutMs: 15000 }).catch(() => false);
        if (!reached) continue;
        await body.useOn(ground.position, { face: { x: 0, y: 1, z: 0 } }).catch(() => false);
        /**
         * Trust the world, not the click. The mod answers `ok` whenever the interaction
         * command was accepted, even when the held item did nothing - which is how
         * "tilled 6" was printed while the ground stayed grass.
         */
        if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
        const now = blockAt(ctx, ground.position);
        if (now && /farmland/.test(bare(now.name))) {
          tilled += 1;
          freshPlots.push(ground.position);
        }
      }
    }

    // `plant: false` means "till only", not "do nothing": the caller may want to prepare
    // the plots first and plant with a different seed later.
    if (params.plant === false) {
      return {
        ok: true,
        harvested,
        tilled,
        planted: 0,
        detail: `harvested ${harvested}, tilled ${tilled}`
      };
    }

    // ---- 3. plant seeds on the farmland ----------------------------------
    const seedName = params.seed
      ? Object.keys(inventory).find((name) => bare(name) === bare(params.seed))
      : findItem(inventory, SEEDS);
    let planted = 0;
    if (seedName) {
      if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
      await body.equip(seedName).catch(() => false);
      let seedsLeft = Number(inventory[seedName] || 0);
      /**
       * Sow the plots we just made first.
       *
       * Seeding them immediately is what keeps them hydrated farmland instead of dirt -
       * and it stops a stray walk to somebody else's empty field.
       */
      const key = (position) => `${position.x},${position.y},${position.z}`;
      const fresh = new Set(freshPlots.map(key));
      const plots = findFarmland(ctx, params.radius).sort(
        (a, b) => Number(fresh.has(key(b.position))) - Number(fresh.has(key(a.position))) || a.distance - b.distance
      );
      for (const plot of plots) {
        if (seedsLeft <= 0) break;
        const reached = await body.moveTo(plot.position, { range: 3, timeoutMs: 15000 }).catch(() => false);
        if (!reached) continue;
        await body.useOn(plot.position, { face: { x: 0, y: 1, z: 0 } }).catch(() => false);
        // A seed only counts when it actually left the inventory.
        if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
        const snapNow = typeof body.snapshot === 'function' ? body.snapshot() : null;
        const left = snapNow && snapNow.inventory ? Number(snapNow.inventory[seedName] || 0) : seedsLeft;
        if (left < seedsLeft) {
          planted += 1;
          seedsLeft = left;
        }
      }
    }

    return {
      ok: true,
      harvested,
      tilled,
      planted,
      detail:
        `harvested ${harvested}, tilled ${tilled}` +
        (seedName
          ? `, planted ${planted}${params.plots ? ` (limit ${params.plots})` : ''}`
          : ' (no seeds carried)')
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
