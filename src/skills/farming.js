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
const { isDaytime } = require('../world/daytime');
const { findBedNear } = require('../world/beds');
const { RecoveryLadder } = require('../core/recoveryLadder');

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

/** Fresh snapshot: refresh the body, then read it. */
async function refresh(ctx) {
  const body = ctx.body;
  if (body && typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
  return body && typeof body.snapshot === 'function' ? body.snapshot() : null;
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
    till: { type: 'boolean', default: true },
    /** Re-till farmland that a jump/fall trampled back into dirt (inside the field). */
    repairTrampled: { type: 'boolean', default: true }
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

    /**
     * Walk over the drops a harvest leaves on the field and wait for the game to hand them
     * over. The operator's report: "好多掉落物都没捡，太浪费" - wheat and seeds were lying
     * everywhere while the bot walked off to the next crop.
     */
    const collectDrops = async (radius = 6) => {
      let picked = 0;
      for (let pass = 0; pass < 3; pass += 1) {
        const state = await refresh(ctx);
        const drops = (state && state.nearbyItems ? state.nearbyItems : []).filter(
          (drop) => drop && drop.position && (drop.distance === undefined || drop.distance <= radius)
        );
        if (!drops.length) break;
        let pickedThisPass = 0;
        for (const drop of drops) {
          const id = drop.id;
          const gone = async () =>
            !(((await refresh(ctx)).nearbyItems) || []).some((item) => item.id === id);
          if (await gone()) {
            picked += 1;
            pickedThisPass += 1;
            continue;
          }
          const cell = {
            x: Math.floor(drop.position.x),
            y: Math.floor(drop.position.y),
            z: Math.floor(drop.position.z)
          };
          const below = { x: cell.x, y: cell.y - 1, z: cell.z };
          const nameAt = (position) => {
            const world = ctx.world;
            const block = world && typeof world.blockAtAbsolute === 'function' ? world.blockAtAbsolute(position) : null;
            return block && block.name ? bare(block.name) : 'air';
          };
          // Never step into an irrigation channel after a drop.
          if (/water/.test(nameAt(cell)) || /water/.test(nameAt(below))) continue;
          await body
            .moveTo(drop.position, {
              range: 1.0,
              timeoutMs: 12000,
              allowSwim: false,
              allowManMade: true
            })
            .catch(() => false);
          const waitUntil = Date.now() + 2500;
          while (Date.now() < waitUntil) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            if (await gone()) {
              picked += 1;
              pickedThisPass += 1;
              break;
            }
          }
        }
        if (!pickedThisPass) break;
      }
      return picked;
    };

    // ---- 1. harvest what is ripe ------------------------------------------
    const ripe = params.harvest === false
      ? []
      : crops.filter((crop) => Number(crop.age) >= Number(crop.maxAge));
    let harvested = 0;

    /**
     * One harvest attempt, extracted so the ladder can offer a genuinely different second
     * execution: the direct walk, then a fresh scan with a wider arrival tolerance. A crop
     * left standing by the first rung is still ripe for the second - the recovery boundary
     * is "take this crop", nothing wider.
     */
    const harvestCrop = async (crop, options = {}) => {
      const reached = await body
        .moveTo(crop.position, {
          range: options.range || 2,
          timeoutMs: options.timeoutMs || 15000,
          allowManMade: true,
          // Dry route: the farm's irrigation channels must not be waded through.
          allowSwim: false
        })
        .catch(() => false);
      if (!reached) return { ok: false, reason: 'could not reach the crop', failure: 'no_path' };
      const ok = await body.dig({ name: crop.name, position: crop.position }).catch(() => false);
      return ok ? { ok: true } : { ok: false, reason: 'the crop dig was refused', failure: 'refused' };
    };

    for (const crop of ripe) {
      /**
       * `allowManMade` on every farm walk: a farm IS player-built ground (farmland, water
       * channels, fences), and the default guard that keeps the bot off other people's
       * builds made every harvest step answer `noPath` - 4 of 60 ripe wheat got collected.
       */
      const ladder = new RecoveryLadder('farm-harvest', [
        {
          name: 'direct',
          handles: ['no_path', 'out_of_reach', 'unknown', 'hazard'],
          maxAttempts: 1,
          run: () => harvestCrop(crop, {})
        },
        {
          name: 'fresh-scan-wide',
          handles: ['no_path', 'out_of_reach', 'unknown'],
          maxAttempts: 1,
          run: async () => {
            if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
            return harvestCrop(crop, { range: 2.5, timeoutMs: 25000 });
          }
        }
      ]);
      const result = await ladder.run();
      if (result.ok) harvested += 1;
      // Every few crops, sweep what has fallen on the field.
      if (harvested % 4 === 0) await collectDrops(5);
    }
    const collected = await collectDrops(6);

    // ---- 2. till fresh soil ------------------------------------------------
    const hoe = findItem(inventory, /_hoe$/);
    let tilled = 0;
    const freshPlots = [];
    if (hoe && params.till !== false) {
      await body.equip(hoe).catch(() => false);
      const wanted = params.plots ? Math.max(1, Math.floor(params.plots)) : Infinity;
      for (const ground of rankTillableByWater(ctx, params.radius)) {
        if (tilled >= wanted) break;
        /**
         * Stand ON TOP of the block, then hoe it. Targeting the ground cell itself sends
         * the planner to a solid block, which it can only refuse (`noPath`) whenever the
         * raw short-hop fallback does not apply.
         */
        const stand = { x: ground.position.x, y: ground.position.y + 1, z: ground.position.z };
        const reached = await body
          .moveTo(stand, {
            range: 2.5,
            timeoutMs: 15000,
            allowManMade: true,
            allowSwim: false
          })
          .catch(() => false);
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

    // ---- 3. plant seeds on the farmland ----------------------------------
    // `plant: false` means "harvest (and repair) only", not "return before the repair".
    const shouldPlant = params.plant !== false;
    const seedName = params.seed
      ? Object.keys(inventory).find((name) => bare(name) === bare(params.seed))
      : findItem(inventory, SEEDS);
    let planted = 0;
    if (shouldPlant && seedName) {
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
        const stand = { x: plot.position.x, y: plot.position.y + 1, z: plot.position.z };
        const reached = await body
          .moveTo(stand, {
            range: 2.5,
            timeoutMs: 15000,
            allowManMade: true,
            allowSwim: false
          })
          .catch(() => false);
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

    /**
     * Repair farmland that a jump or a fall turned back into dirt.
     *
     * The operator's report: "agent上来跳跃会踩坏农田". Walking is harmless; landing after a
     * jump is not, and the client's walker jumps whenever a step blocks it. Rather than try
     * to forbid every jump, till the damage back: a dirt block with two or more farmland
     * neighbours is a hole inside the field, not fresh ground to expand onto.
     */
    let repaired = 0;
    if (hoe && params.repairTrampled !== false) {
      const dirtCells =
        ctx.world && typeof ctx.world.findBlocksMatching === 'function'
          ? ctx.world.findBlocksMatching((name) => /^dirt$/.test(bare(name)), {
              maxDistance: params.radius,
              // 256, not 64: most dirt in range is the subsoil *under* the field, and the
              // nearest-64 cap left real surface holes unrepaired.
              count: 256
            })
          : [];
      const farmlandNeighbours = (position) => {
        let count = 0;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const block = blockAt(ctx, { x: position.x + dx, y: position.y, z: position.z + dz });
          if (block && /farmland/.test(bare(block.name))) count += 1;
        }
        return count;
      };
      if (dirtCells.length) await body.equip(hoe).catch(() => false);
      if (ctx.log && ctx.log.info && dirtCells.length) {
        ctx.log.info(`repair: ${dirtCells.length} dirt block(s) near the field`);
      }
      for (const cell of dirtCells) {
        const neighbours = farmlandNeighbours(cell.position);
        if (neighbours < 2) continue;
        const stand = { x: cell.position.x, y: cell.position.y + 1, z: cell.position.z };
        const reached = await body
          .moveTo(stand, {
            range: 2.5,
            timeoutMs: 15000,
            allowManMade: true,
            allowSwim: false
          })
          .catch(() => false);
        if (!reached) {
          if (ctx.log && ctx.log.warn) {
            ctx.log.warn(`repair: cannot reach ${cell.position.x},${cell.position.y},${cell.position.z}`);
          }
          continue;
        }
        /**
         * A crop still standing on the trampled block blocks the hoe: vanilla only tills
         * when the cell above is empty. Clear the plant first (its drops land on the field).
         */
        const abovePosition = { x: cell.position.x, y: cell.position.y + 1, z: cell.position.z };
        const above = blockAt(ctx, abovePosition);
        const aboveName = above && above.name ? bare(above.name) : 'air';
        /**
         * Only plants block the hoe; decorations (a torch, a sign) must be left alone -
         * the first live repair dug the torch standing on the trampled block.
         */
        const PLANT = /^(wheat|carrots|potatoes|beetroots|.*_seeds|.*_crop|.*_stem|melon_stem|pumpkin_stem|sugar_cane|bamboo|kelp|.*_kelp|seagrass|.*_sapling|.*_flower|dandelion|poppy|.*_grass|grass|fern|large_fern|vine|.*_vines|nether_wart|sweet_berry_bush)$/;
        if (PLANT.test(aboveName)) {
          await body.dig({ name: aboveName, position: abovePosition }).catch(() => false);
          await refresh(ctx);
        } else if (!/^(air|cave_air|void_air)$/.test(aboveName)) {
          // A torch or other decoration sits on the hole: leave the operator's build alone.
          if (ctx.log && ctx.log.info) {
            ctx.log.info(
              `repair: leaving ${cell.position.x},${cell.position.y},${cell.position.z} alone ` +
                `(${aboveName} on top)`
            );
          }
          continue;
        }
        await body.useOn(cell.position, { face: { x: 0, y: 1, z: 0 } }).catch(() => false);
        await refresh(ctx);
        const after = blockAt(ctx, cell.position);
        if (after && /farmland/.test(bare(after.name))) {
          repaired += 1;
        } else if (ctx.log && ctx.log.warn) {
          ctx.log.warn(
            `repair: hoed ${cell.position.x},${cell.position.y},${cell.position.z} but it is still ` +
              `${after ? bare(after.name) : 'unknown'}`
          );
        }
      }
    }

    return {
      ok: true,
      harvested,
      tilled,
      planted,
      collected,
      repaired,
      detail:
        `harvested ${harvested}, tilled ${tilled}, collected ${collected} drop(s)` +
        (repaired ? `, repaired ${repaired} trampled farmland` : '') +
        (seedName
          ? `, planted ${planted}${params.plots ? ` (limit ${params.plots})` : ''}`
          : shouldPlant
            ? ' (no seeds carried)'
            : '')
    };
  }
});

register({
  name: 'sleep',
  title: '睡觉过夜',
  description: 'Walk to a bed and sleep until morning.',
  params: {
    timeoutMs: { type: 'number', default: 120000, min: 10000, max: 600000 },
    /** How far to look for a bed: 60 x 10 x 60 around the player (operator's rule). */
    radius: { type: 'number', default: 60, min: 4, max: 64 }
  },
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
    const bedRadius = params.radius === undefined ? 60 : params.radius;
    const here = snap && snap.position ? snap.position : null;
    const bed = findBedNear(world, here, {
      halfX: Math.min(30, bedRadius),
      halfY: 5,
      halfZ: Math.min(30, bedRadius),
      maxDistance: bedRadius
    });
    if (!bed) return { ok: false, reason: 'no bed within 60x10x60' };
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
