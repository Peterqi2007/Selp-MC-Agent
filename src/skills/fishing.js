'use strict';

/**
 * Fishing (钓鱼): walk to the nearest water, cast, wait for the bite, reel in, collect.
 *
 * Phase machine borrowed from the reference Java bot (mc_aiplayer's FishTask):
 *   FIND_WATER -> MOVE_TO_WATER -> CAST -> WAIT_BITE -> REEL -> COLLECT -> repeat.
 *
 * Operator's rules for this task:
 *   - find the nearest water and walk there (a water block with a standable bank cell);
 *   - when night falls, find a bed and sleep (the `sleep` skill, wider search radius);
 *   - stop when the fishing rod's durability runs out (or the rod breaks).
 *
 * The bite is what makes fishing work at all: reeling at a random moment loses the fish, so
 * the mod reports the bobber's `biting` flag (read reflectively - it is private in 1.20.1).
 */

const { bare } = require('../world/items');

const registry = require('./registry');
const { register } = registry;

const WATER = /^(water|flowing_water)$/;
const NOT_FLOOR = /^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava|short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|.*_flower|.*_sapling|torch|wall_torch|redstone_torch|soul_torch|.*_rail|.*_button|.*_pressure_plate|.*_carpet|.*_sign|.*_banner|wheat|.*_crop|carrots|potatoes|beetroots)$/;
const PASSABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|.*_flower|.*_sapling|torch|wall_torch|redstone_torch|soul_torch)$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function feetOf(snapshot) {
  if (!snapshot || !snapshot.position) return null;
  return {
    x: Math.floor(snapshot.position.x),
    y: Math.floor(snapshot.position.y),
    z: Math.floor(snapshot.position.z)
  };
}

async function refresh(ctx) {
  const body = ctx.body;
  if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
  return typeof body.snapshot === 'function' ? body.snapshot() : null;
}

/** Name of the block in `position`, or null when the scan has no opinion. */
function blockNameAt(ctx, position) {
  const world = ctx.world;
  if (!world) return null;
  const block =
    typeof world.blockAtAbsolute === 'function'
      ? world.blockAtAbsolute(position)
      : typeof world.blockAt === 'function'
        ? world.blockAt(position)
        : null;
  return block && block.name ? bare(block.name) : null;
}

/** Night by the world clock (the mod's isDay flag is wrong on this modpack). */
function isNight(time) {
  if (!time || !Number.isFinite(time.timeOfDay)) return false;
  const t = ((time.timeOfDay % 24000) + 24000) % 24000;
  return t >= 12542 && t <= 23458;
}

register({
  name: 'fish',
  title: '钓鱼',
  description:
    'Walk to the nearest water, cast a fishing rod, reel in on the bite and collect the catch; sleeps in a bed at night and stops when the rod is used up.',
  params: {
    rod: { type: 'string', default: 'fishing_rod' },
    searchRadius: { type: 'number', default: 24, min: 4, max: 48 },
    maxCatches: { type: 'number', default: 32, min: 1, max: 256 },
    maxMs: { type: 'number', default: 900000, min: 10000, max: 3600000 },
    biteTimeoutMs: { type: 'number', default: 45000, min: 5000, max: 180000 },
    eatAt: { type: 'number', default: 18, min: 1, max: 20 },
    food: { type: 'string', default: 'bread' },
    sleep: { type: 'boolean', default: true },
    bedRadius: { type: 'number', default: 32, min: 8, max: 64 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.useItem === 'function' && typeof ctx.body.moveTo === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot fish (needs useItem/moveTo)' }),
  async run(ctx, params) {
    const body = ctx.body;
    const deadline = Date.now() + params.maxMs;
    const stats = { catches: 0, sleeps: 0, casts: 0, ate: 0, collected: 0 };
    const blockedWater = new Set();
    const waterKey = (position) => `${position.x},${position.y},${position.z}`;

    const rodInBag = (snap) =>
      Object.keys((snap && snap.inventory) || {}).find(
        (name) => bare(name) === bare(params.rod) && snap.inventory[name] > 0
      ) || null;

    const eatIfHungry = async () => {
      const snap = await refresh(ctx);
      if (!snap || !snap.food || snap.food > params.eatAt) return;
      const chosen = Object.keys(snap.inventory || {}).find(
        (name) => bare(name) === bare(params.food) && snap.inventory[name] > 0
      );
      if (!chosen) return;
      const eater = typeof body.consume === 'function' ? body.consume : body.eat;
      if (typeof eater !== 'function') return;
      await body.equip(chosen).catch(() => false);
      if (await eater.call(body, chosen).catch(() => false)) stats.ate += 1;
    };

    const hostileNear = async (radius = 3) => {
      const snap = await refresh(ctx);
      const here = feetOf(snap);
      if (!here) return null;
      for (const hostile of (snap.hostiles || [])) {
        const p = hostile.position;
        if (!p) continue;
        if (
          Math.abs(p.x - here.x) <= radius &&
          Math.abs(p.y - here.y) <= radius &&
          Math.abs(p.z - here.z) <= radius
        ) {
          return hostile;
        }
      }
      return null;
    };

    /** Nearest water block that has a standable bank cell next to it. */
    const findWater = async () => {
      const snap = await refresh(ctx);
      const here = feetOf(snap);
      if (!here) return null;
      const found =
        ctx.world && typeof ctx.world.findBlocksMatching === 'function'
          ? ctx.world.findBlocksMatching((name) => WATER.test(bare(name)), {
              maxDistance: params.searchRadius,
              count: 192
            })
          : [];
      const candidates = [];
      for (const block of found) {
        if (blockedWater.has(waterKey(block.position))) continue;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (const dy of [0, 1, -1]) {
            const stand = {
              x: block.position.x + dx,
              y: block.position.y + dy,
              z: block.position.z + dz
            };
            const feet = blockNameAt(ctx, stand);
            const head = blockNameAt(ctx, { x: stand.x, y: stand.y + 1, z: stand.z });
            const floor = blockNameAt(ctx, { x: stand.x, y: stand.y - 1, z: stand.z });
            if (feet === null || head === null || floor === null) continue;
            if (!PASSABLE.test(feet) || !PASSABLE.test(head)) continue;
            if (NOT_FLOOR.test(floor)) continue;
            // Lava right beside the spot is not a fishing spot.
            let lava = false;
            for (let lx = -2; lx <= 2 && !lava; lx += 1) {
              for (let lz = -2; lz <= 2 && !lava; lz += 1) {
                for (let ly = -1; ly <= 1 && !lava; ly += 1) {
                  const name = blockNameAt(ctx, { x: stand.x + lx, y: stand.y + ly, z: stand.z + lz });
                  if (name && /lava/.test(name)) lava = true;
                }
              }
            }
            if (lava) continue;
            const distance = Math.hypot(block.position.x - here.x, block.position.z - here.z);
            candidates.push({ water: block.position, stand, distance });
          }
        }
      }
      candidates.sort((a, b) => a.distance - b.distance);
      return candidates[0] || null;
    };

    /** Walk over nearby drops and wait for the game to hand them over. */
    const collectDrops = async (radius = 6) => {
      let picked = 0;
      for (let pass = 0; pass < 3; pass += 1) {
        const snap = await refresh(ctx);
        const drops = (snap.nearbyItems || []).filter(
          (drop) => drop && drop.position && (drop.distance === undefined || drop.distance <= radius)
        );
        if (!drops.length) break;
        let pickedThisPass = 0;
        for (const drop of drops) {
          if (Date.now() > deadline) return picked;
          const id = drop.id;
          const gone = async () => !((await refresh(ctx)).nearbyItems || []).some((item) => item.id === id);
          if (await gone()) {
            picked += 1;
            pickedThisPass += 1;
            continue;
          }
          await body
            .moveTo(drop.position, {
              range: 1.0,
              timeoutMs: 12000,
              raw: (drop.distance === undefined ? 99 : drop.distance) <= 4
            })
            .catch(() => false);
          const waitUntil = Date.now() + 2500;
          while (Date.now() < waitUntil) {
            await sleep(200);
            if (await gone()) {
              picked += 1;
              pickedThisPass += 1;
              break;
            }
          }
        }
        if (!pickedThisPass) break;
      }
      stats.collected += picked;
      return picked;
    };

    // ---- main loop ---------------------------------------------------------
    for (;;) {
      if (Date.now() > deadline) {
        return {
          ok: true,
          catches: stats.catches,
          sleeps: stats.sleeps,
          casts: stats.casts,
          collected: stats.collected,
          detail: `time budget reached after ${stats.catches} catch(es)`
        };
      }

      await eatIfHungry();

      const hostile = await hostileNear(3);
      if (hostile) {
        return {
          ok: true,
          stopped: 'hostile',
          catches: stats.catches,
          detail: `stopped: ${bare(hostile.name)} within 3 blocks`
        };
      }

      const snapNow = await refresh(ctx);
      if (!rodInBag(snapNow)) {
        return {
          ok: stats.catches > 0,
          stopped: 'rod-broken',
          catches: stats.catches,
          sleeps: stats.sleeps,
          casts: stats.casts,
          detail:
            stats.casts > 0
              ? `fishing rod ran out of durability after ${stats.casts} cast(s) / ${stats.catches} catch(es)`
              : 'no fishing rod in the inventory'
        };
      }
      if (snapNow.heldDurability && snapNow.heldDurability.remaining <= 1 && /fishing_rod/.test(bare(snapNow.heldItem || ''))) {
        return {
          ok: true,
          stopped: 'rod-worn',
          catches: stats.catches,
          sleeps: stats.sleeps,
          casts: stats.casts,
          detail: `fishing rod is down to its last use (${snapNow.heldDurability.remaining}/${snapNow.heldDurability.max}) - stopping before it breaks`
        };
      }

      // Night: sleep in a bed, as the operator asked.
      if (params.sleep !== false && isNight(snapNow.time)) {
        const bed = await registry.run('sleep', ctx, { timeoutMs: 90000, radius: params.bedRadius });
        if (bed && bed.ok && bed.slept) {
          stats.sleeps += 1;
          continue;
        }
        if (bed && bed.ok && bed.slept === false) continue; // it turned out to be daytime
        return {
          ok: stats.catches > 0,
          stopped: 'no-bed',
          catches: stats.catches,
          sleeps: stats.sleeps,
          detail: `night and could not sleep: ${(bed && bed.reason) || 'unknown'}`
        };
      }

      const spot = await findWater();
      if (!spot) {
        return {
          ok: stats.catches > 0,
          stopped: 'no-water',
          catches: stats.catches,
          sleeps: stats.sleeps,
          detail: `no water with a fishable bank within ${params.searchRadius} blocks`
        };
      }

      const reached = await body
        .moveTo(spot.stand, { range: 1.6, timeoutMs: 40000 })
        .catch(() => false);
      if (!reached) {
        blockedWater.add(waterKey(spot.water));
        continue;
      }

      const rodName = rodInBag(await refresh(ctx));
      if (!rodName) continue; // the loop's rod check reports it
      if (!(await body.equip(rodName).catch(() => false))) {
        await sleep(300);
      }
      await body
        .lookAt({ x: spot.water.x + 0.5, y: spot.water.y + 0.9, z: spot.water.z + 0.5 })
        .catch(() => false);

      let current = await refresh(ctx);
      if (!current.fishing) {
        await body.useItem().catch(() => false);
        stats.casts += 1;
        const castUntil = Date.now() + 2500;
        while (Date.now() < castUntil) {
          await sleep(250);
          current = await refresh(ctx);
          if (current.fishing) break;
        }
        if (!current.fishing) {
          // Cast failed (no water in front, or the rod vanished): try again from the loop.
          if (!rodInBag(current)) continue;
          continue;
        }
      }

      // Wait for the bite.
      const biteUntil = Date.now() + params.biteTimeoutMs;
      let bit = false;
      while (Date.now() < biteUntil) {
        await sleep(250);
        const state = await refresh(ctx);
        if (!rodInBag(state)) break;
        if (!state.fishing) break; // hook gone: recast
        if (state.fishing.biting) {
          bit = true;
          break;
        }
      }

      // Reel in (also on a timeout, so a stale hook never blocks the next cast).
      // The bag is counted BEFORE the reel: the fish lands the moment the rod is pulled,
      // so comparing after would always show "no change" and every catch would be lost.
      const beforeReel = Object.values((await refresh(ctx)).inventory || {}).reduce(
        (sum, count) => sum + count,
        0
      );
      await body.useItem().catch(() => false);
      const reelUntil = Date.now() + 3000;
      let after = await refresh(ctx);
      while (after.fishing && Date.now() < reelUntil) {
        await sleep(250);
        after = await refresh(ctx);
      }
      if (bit) {
        const picked = await collectDrops(6);
        const now = await refresh(ctx);
        const total = Object.values(now.inventory || {}).reduce((sum, count) => sum + count, 0);
        if (total > beforeReel || picked > 0) stats.catches += 1;
        if (stats.catches >= params.maxCatches) {
          return {
            ok: true,
            catches: stats.catches,
            sleeps: stats.sleeps,
            casts: stats.casts,
            collected: stats.collected,
            detail: `caught ${stats.catches} fish (target reached)`
          };
        }
      }
    }
  }
});
