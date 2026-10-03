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
/** Blocks that do not break vanilla's open-water check. */
const OPEN = /^(air|cave_air|void_air|water|flowing_water)$/;
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
  // Unknown cells count as air: the client's scan ships air explicitly, and "no floor"
  // (air) is the conservative answer for standability either way.
  return block && block.name ? bare(block.name) : 'air';
}

/** Night by the world clock (the mod's isDay flag is wrong on this modpack). */
function isNight(time) {
  if (!time || !Number.isFinite(time.timeOfDay)) return false;
  const t = ((time.timeOfDay % 24000) + 24000) % 24000;
  return t >= 12542 && t <= 23458;
}

/**
 * Vanilla's open-water rule (FishingHook.calculateOpenWater).
 *
 * A 5x5 area, 4-5 blocks tall, around the bobber must contain nothing but water and air.
 * Only open water rolls the fish/treasure table - a bobber in a puddle or under a lily pad
 * only ever pulls junk. The operator asked the agent to satisfy this when casting, so it is
 * both a selection preference and a post-cast check.
 */
function isOpenWater(ctx, water) {
  for (let dx = -2; dx <= 2; dx += 1) {
    for (let dz = -2; dz <= 2; dz += 1) {
      for (let dy = -1; dy <= 3; dy += 1) {
        const name = blockNameAt(ctx, { x: water.x + dx, y: water.y + dy, z: water.z + dz });
        if (name === null || !OPEN.test(name)) return false;
      }
    }
  }
  return true;
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
    const stats = { catches: 0, sleeps: 0, casts: 0, openCasts: 0, closedCasts: 0, ate: 0, collected: 0 };
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
            /**
             * Stay on the shore: a stand whose neighbours are mostly water is an island or a
             * ledge the walk would have to swim to. The operator's rule is "never wade in".
             */
            let waterNeighbours = 0;
            for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              if (WATER.test(blockNameAt(ctx, { x: stand.x + nx, y: stand.y, z: stand.z + nz }))) {
                waterNeighbours += 1;
              }
            }
            if (waterNeighbours >= 3) continue;
            /**
             * Cast as FAR as the water allows instead of wading out.
             *
             * Vanilla's open-water check needs 5x5 of water/air around the bobber, and a
             * short cast from the bank is junk-only - but the operator's rule is to solve
             * that with distance, not with swimming: march up to 10 blocks into the water
             * away from the stand and aim at the last water block found.
             */
            let target = block.position;
            for (let step = 1; step <= 10; step += 1) {
              const probe = {
                x: block.position.x - dx * step,
                y: block.position.y,
                z: block.position.z - dz * step
              };
              const name = blockNameAt(ctx, probe);
              if (!WATER.test(name)) break;
              target = probe;
            }
            const distance = Math.hypot(block.position.x - here.x, block.position.z - here.z);
            candidates.push({
              water: target,
              stand,
              distance,
              open: isOpenWater(ctx, target)
            });
          }
        }
      }
      // Open water first (that is what rolls the fish table), then nearest.
      candidates.sort(
        (a, b) => Number(b.open) - Number(a.open) || a.distance - b.distance
      );
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
          const dropCell = {
            x: Math.floor(drop.position.x),
            y: Math.floor(drop.position.y),
            z: Math.floor(drop.position.z)
          };
          /**
           * Never wade in after a drop. A fish floats ON the surface, so its own cell is
           * air and the water is one below - checking only the item's cell missed exactly
           * that case and the bot swam out to it.
           */
          if (
            WATER.test(blockNameAt(ctx, dropCell)) ||
            WATER.test(blockNameAt(ctx, { x: dropCell.x, y: dropCell.y - 1, z: dropCell.z }))
          ) {
            continue;
          }
          await body
            .moveTo(drop.position, {
              range: 1.0,
              timeoutMs: 12000,
              /**
               * No `raw` shortcut here on purpose: the client's straight-line walker
               * happily strolls off the bank into the river, which is exactly how the bot
               * drowned during the night-sleep test. The dry planner refuses water cells.
               */
              allowSwim: false
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
    /** The chosen bank. Picked and walked to ONCE; only nightfall moves the bot again. */
    let spot = null;
    for (;;) {
      if (Date.now() > deadline) {
        return {
          ok: true,
          catches: stats.catches,
          sleeps: stats.sleeps,
          casts: stats.casts,
          openWaterCasts: stats.openCasts,
          closedWaterCasts: stats.closedCasts,
          collected: stats.collected,
          detail:
            `time budget reached after ${stats.catches} catch(es) ` +
            `(${stats.openCasts} open-water cast(s), ${stats.closedCasts} junk-only)`
        };
      }

      await eatIfHungry();

      /**
       * Death is its own outcome.
       *
       * The drowning during the sleep test emptied the whole inventory - including the rod -
       * and the old check reported "rod-broken", which reads like a normal end of life for
       * the rod instead of "the bot died and lost everything".
       */
      const aliveSnap = await refresh(ctx);
      if (aliveSnap && aliveSnap.dead) {
        return {
          ok: false,
          stopped: 'dead',
          catches: stats.catches,
          sleeps: stats.sleeps,
          casts: stats.casts,
          detail: 'the bot died (looks like a drowning) - respawn and restock before fishing again'
        };
      }

      /**
       * Recovery net: if it ends up in water anyway, swim out immediately with the normal
       * planner (the dry one cannot start from a water cell) and carry on.
       */
      if (aliveSnap && aliveSnap.inWater) {
        if (ctx.log && ctx.log.warn) ctx.log.warn('in the water - climbing back onto the bank');
        await body
          .moveTo(spot ? spot.stand : aliveSnap.position, { range: 1.6, timeoutMs: 20000 })
          .catch(() => false);
      }

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
        if (ctx.log && ctx.log.info) ctx.log.info('night - walking to a bed to sleep');
        /**
         * The bed walk lives here rather than in the generic `sleep` skill because it has
         * two requirements that skill cannot express: stay off liquids, and ALLOW walking
         * over the operator's own base (the default man-made guard made the bed at
         * 25,63,59 unreachable with a plain `noPath`).
         */
        const beds =
          ctx.world && typeof ctx.world.findBlocksMatching === 'function'
            ? ctx.world.findBlocksMatching((name) => /_bed$/.test(bare(name)), {
                maxDistance: params.bedRadius,
                count: 1
              })
            : [];
        if (!beds.length) {
          return {
            ok: stats.catches > 0,
            stopped: 'no-bed',
            catches: stats.catches,
            sleeps: stats.sleeps,
            detail: `night and no bed within ${params.bedRadius} blocks`
          };
        }
        const bed = beds[0];
        const reached = await body
          .moveTo(bed.position, {
            range: 2.5,
            timeoutMs: 90000,
            allowSwim: false,
            allowManMade: true
          })
          .catch(() => false);
        if (!reached) {
          return {
            ok: stats.catches > 0,
            stopped: 'no-bed',
            catches: stats.catches,
            sleeps: stats.sleeps,
            detail: `night and could not reach the bed at ${bed.position.x},${bed.position.y},${bed.position.z}`
          };
        }
        await body.useOn(bed.position, { face: { x: 0, y: 1, z: 0 } }).catch(() => false);
        const wakeDeadline = Date.now() + 60000;
        let woke = false;
        while (Date.now() < wakeDeadline) {
          await sleep(1000);
          const state = await refresh(ctx);
          if (state && state.dead) {
            return {
              ok: false,
              stopped: 'dead',
              catches: stats.catches,
              sleeps: stats.sleeps,
              detail: 'the bot died while trying to sleep'
            };
          }
          if (state && !isNight(state.time)) {
            woke = true;
            break;
          }
        }
        if (!woke) {
          return {
            ok: stats.catches > 0,
            stopped: 'no-bed',
            catches: stats.catches,
            sleeps: stats.sleeps,
            detail: 'night and the bed did not put the bot to sleep (obstructed?)'
          };
        }
        stats.sleeps += 1;
        if (ctx.log && ctx.log.info) ctx.log.info('slept until morning - back to the water');
        spot = null; // one fresh walk back to a bank in the morning
        continue;
      }

      /**
       * ONE walk per fishing spot.
       *
       * The operator's rule: pathfind once to a bank from which the cast reaches open
       * water, then stand there and only cast/reel (the only later walk is to the bed at
       * night). The previous version re-picked a spot every cast, which is what made the
       * bot wander - and occasionally wade in.
       */
      if (!spot) {
        spot = await findWater();
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
          /**
           * Dry route (never through the pond) that may also cross the operator's own base:
           * after sleeping the bot starts *inside* the base, and with the default man-made
           * guard every route out of it answered `noPath`.
           */
          .moveTo(spot.stand, {
            range: 1.6,
            timeoutMs: 40000,
            allowSwim: false,
            allowManMade: true
          })
          .catch(() => false);
        const afterWalk = await refresh(ctx);
        if (!reached || afterWalk.inWater) {
          if (ctx.log && ctx.log.warn) {
            ctx.log.warn(
              afterWalk.inWater
                ? 'the route to this fishing spot wades - skipping it'
                : 'could not reach this fishing spot - skipping it'
            );
          }
          blockedWater.add(waterKey(spot.water));
          spot = null;
          continue;
        }
        if (ctx.log && ctx.log.info) {
          ctx.log.info(
            `fishing spot: standing at ${spot.stand.x},${spot.stand.y},${spot.stand.z}, ` +
              `casting at ${spot.water.x},${spot.water.y},${spot.water.z} ` +
              `(open water: ${spot.open ? 'yes' : 'no'})`
          );
        }
      }

      const rodName = rodInBag(await refresh(ctx));
      if (!rodName) continue; // the loop's rod check reports it
      if (!(await body.equip(rodName).catch(() => false))) {
        await sleep(300);
      }
      /**
       * Aim ABOVE the water, not at it.
       *
       * Vanilla's cast is a fixed-speed projectile: aiming at a block on the surface makes
       * the bobber plop down 3-6 blocks away (the live log showed a target 11 blocks out,
       * a bobber 3 blocks out, and a junk-only landing). Raising the aim point a couple of
       * blocks gives the throw an upward angle, so it actually flies far - which is what
       * the operator asked for ("把竿尽可能往远抛").
       */
      await body
        .lookAt({ x: spot.water.x + 0.5, y: spot.water.y + 2.5, z: spot.water.z + 0.5 })
        .catch(() => false);

      let current = await refresh(ctx);
      if (!current.fishing) {
        if (ctx.log && ctx.log.info) ctx.log.info(`cast #${stats.casts + 1}`);
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
        /**
         * The bobber decides, not the chosen block: vanilla's 5x4x5 open-water check runs
         * where the hook actually lands. Log it so a junk-only session is visible instead
         * of mysterious.
         */
        const hookCell = {
          x: Math.floor(current.fishing.x),
          y: Math.floor(current.fishing.y),
          z: Math.floor(current.fishing.z)
        };
        const hookOpen = isOpenWater(ctx, hookCell);
        if (hookOpen) stats.openCasts += 1;
        else stats.closedCasts += 1;
        if (ctx.log && ctx.log.info) {
          ctx.log.info(
            `bobber at ${hookCell.x},${hookCell.y},${hookCell.z} - open water: ${hookOpen ? 'yes' : 'NO (junk only)'}`
          );
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
          if (ctx.log && ctx.log.info) ctx.log.info('bite!');
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
        // Only what landed within reach of the stand: no walking away from the spot.
        const picked = await collectDrops(3);
        const now = await refresh(ctx);
        const total = Object.values(now.inventory || {}).reduce((sum, count) => sum + count, 0);
        if (total > beforeReel || picked > 0) stats.catches += 1;
        if (ctx.log && ctx.log.info) {
          ctx.log.info(`caught #${stats.catches} (picked ${picked} drop(s))`);
        }
        if (stats.catches >= params.maxCatches) {
          return {
            ok: true,
            catches: stats.catches,
            sleeps: stats.sleeps,
            casts: stats.casts,
            openWaterCasts: stats.openCasts,
            closedWaterCasts: stats.closedCasts,
            collected: stats.collected,
            detail:
              `caught ${stats.catches} fish (target reached; ` +
              `${stats.openCasts} cast(s) in open water, ${stats.closedCasts} junk-only)`
          };
        }
      }
    }
  }
});
