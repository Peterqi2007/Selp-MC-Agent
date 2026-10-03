'use strict';

/**
 * Ore seeking (寻矿挖掘): lock onto the nearest ore, dig a tunnel to it, mine it, repeat.
 *
 * The operator's spec:
 *   - search the nearest ore within 30 blocks on x/z and 5 blocks vertically, through walls;
 *   - dig while advancing (边挖边前进) until the vein is adjacent, then collect it;
 *   - vertical moves use a sloped tunnel: a down step digs three cells (the new foot level,
 *     the old foot level and the old head level); an up step digs the new foot and head and
 *     climbs the remaining block (digging that block away would remove the step to stand on);
 *   - when the block light at the feet drops to `lightThreshold` (default 2), plant a torch
 *     on the floor behind the bot; when the torches run out there, PAUSE the task.
 *
 * Everything is ordinary play: `dig` breaks blocks, `moveTo` walks, `equip`/`place` light
 * the tunnel, `consume` eats. No packets are forged.
 */

const { register } = require('./registry');
const { bare } = require('../world/items');
const { toolPlan } = require('../world/toolPolicy');

const AIR = /^(air|cave_air|void_air)$/;
const HAZARD = /water|lava/;
const MAX_STEPS_PER_ORE = 96;

function feetOf(snapshot) {
  if (!snapshot || !snapshot.position) return null;
  return {
    x: Math.floor(snapshot.position.x),
    y: Math.floor(snapshot.position.y),
    z: Math.floor(snapshot.position.z)
  };
}

function cellAt(snapshot, position) {
  const cells = snapshot && snapshot.blocks && snapshot.blocks.cells;
  return (cells && cells[`${position.x},${position.y},${position.z}`]) || 'minecraft:air';
}

function posKey(position) {
  return `${position.x},${position.y},${position.z}`;
}

function inventoryItems(snapshot) {
  return Object.keys((snapshot && snapshot.inventory) || {}).map((name) => ({
    name,
    count: snapshot.inventory[name]
  }));
}

function minePlan(snapshot, blockName) {
  return toolPlan(blockName, inventoryItems(snapshot));
}

function countItem(snapshot, itemName) {
  const wanted = bare(itemName);
  let total = 0;
  for (const [name, count] of Object.entries((snapshot && snapshot.inventory) || {})) {
    if (bare(name) === wanted) total += count;
  }
  return total;
}

async function refresh(ctx) {
  const body = ctx.body;
  if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
  return typeof body.snapshot === 'function' ? body.snapshot() : null;
}

register({
  name: 'mine_ore',
  title: '寻矿挖掘',
  description:
    'Find the nearest ore through walls (x/z within maxXZ, vertical within maxY), dig a tunnel or sloped stair to it and mine it; lights the tunnel with torches and pauses when it runs out in the dark.',
  params: {
    ore: { type: 'string', default: 'iron_ore' },
    maxXZ: { type: 'number', default: 30, min: 4, max: 48 },
    maxY: { type: 'number', default: 5, min: 1, max: 16 },
    maxMs: { type: 'number', default: 600000, min: 10000, max: 3600000 },
    eatAt: { type: 'number', default: 18, min: 1, max: 20 },
    food: { type: 'string', default: 'bread' },
    torch: { type: 'string', default: 'torch' },
    lightThreshold: { type: 'number', default: 2, min: 0, max: 15 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.dig === 'function' && typeof ctx.body.moveTo === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot mine (needs dig/moveTo)' }),
  async run(ctx, params) {
    const body = ctx.body;
    const deadline = Date.now() + params.maxMs;
    const stats = {
      ores: 0,
      blocks: 0,
      torches: 0,
      ate: 0,
      collected: 0,
      skipped: 0,
      outOfTime: false,
      paused: false,
      cavern: false
    };

    let snapshot = await refresh(ctx);
    if (!snapshot) return { ok: false, reason: 'no state from the client' };
    const pickaxe = (() => {
      const plan = minePlan(snapshot, params.ore);
      return plan && plan.tool ? plan.tool.name : null;
    })();
    if (!pickaxe) return { ok: false, reason: `no pickaxe that can mine ${bare(params.ore)}` };
    await body.equip(pickaxe).catch(() => false);
    if (ctx.log && ctx.log.info) {
      ctx.log.info(`mine_ore: ${bare(params.ore)} with ${bare(pickaxe)} at y=${feetOf(snapshot).y}`);
    }

    const orePattern = new RegExp(`${bare(params.ore).replace(/^iron_ore$/, '(deepslate_)?iron_ore')}$`);
    const blocked = new Set();

    // ---- helpers -----------------------------------------------------------

    const digAt = async (position) => {
      const now = await refresh(ctx);
      const name = cellAt(now, position);
      if (AIR.test(bare(name))) return true;
      if (HAZARD.test(bare(name))) return false;
      const plan = minePlan(now, name);
      if (!plan.ok) {
        stats.skipped += 1;
        return false;
      }
      if (plan.tool) await body.equip(plan.tool.name).catch(() => false);
      const ok = await body.dig({ name, position }).catch(() => false);
      if (ok) stats.blocks += 1;
      return ok;
    };

    /**
     * Any hostile inside the ±3 block box the operator wants kept clear?
     *
     * The avoidance rule is deliberately cubic (horizontal and vertical), so a skeleton on
     * a ledge just above the tunnel counts exactly like one standing next to the bot.
     */
    const hostileInBox = (snap, position, radius = 3) => {
      for (const hostile of (snap && snap.hostiles) || []) {
        const p = hostile.position;
        if (!p) continue;
        if (
          Math.abs(p.x - position.x) <= radius &&
          Math.abs(p.y - position.y) <= radius &&
          Math.abs(p.z - position.z) <= radius
        ) {
          return hostile;
        }
      }
      return null;
    };

    /**
     * Is stepping into `position` dangerous?
     *
     * Two things kill mining bots: a floor that is not there (the live run fell into a
     * ravine and was finished off by a Swarmer) and lava behind the wall. Both are visible
     * in the block scan before the step, so the task refuses the move and stops.
     */
    const dangerAt = (snap, position) => {
      const hostile = hostileInBox(snap, position);
      if (hostile) return { reason: `${bare(hostile.name)} within 3 blocks`, hostile: true };
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          for (let dy = -3; dy <= 2; dy += 1) {
            const name = bare(cellAt(snap, { x: position.x + dx, y: position.y + dy, z: position.z + dz }));
            if (name === 'lava' || name === 'flowing_lava') {
              return { reason: 'lava in or beside the tunnel', hostile: false };
            }
          }
        }
      }
      let drop = 0;
      for (let dy = 1; dy <= 8; dy += 1) {
        const name = bare(cellAt(snap, { x: position.x, y: position.y - dy, z: position.z }));
        if (AIR.test(name)) {
          drop += 1;
          continue;
        }
        break;
      }
      if (drop > 2) return { reason: `${drop}-block drop below`, hostile: false };
      return null;
    };

    /** Walk into `position` (strict: the feet must end up in that block). */
    const stepTo = async (position) => {
      const arrived = async () => {
        const after = feetOf(await refresh(ctx));
        return !!after && after.x === position.x && after.z === position.z && Math.abs(after.y - position.y) <= 1;
      };
      await body.moveTo(position, { range: 0.45, timeoutMs: 20000 }).catch(() => false);
      if (await arrived()) return true;
      /**
       * One nudge. The planner is occasionally handed the same one-block hop and answers
       * `noPath` (the live run lost 27 ores to "could not walk into the dug step" that way),
       * so the retry forces the client's own walker rather than asking the planner again.
       */
      await body
        .moveTo(position, { raw: true, range: 0.45, timeoutMs: 12000 })
        .catch(() => false);
      return arrived();
    };

    const lightAtFeet = (snap) =>
      snap && Number.isFinite(snap.blockLight) && snap.blockLight !== null
        ? snap.blockLight
        : snap && Number.isFinite(snap.lightLevel)
          ? snap.lightLevel
          : 15;

    /**
     * How open is the space around the bot?
     *
     * A 1x2 tunnel we dug ourselves shows up as roughly a tenth of the box being air; a
     * natural cavern is mostly air. The operator's rule: once the tunnel breaks into a big
     * cave, stop the task instead of wandering into it.
     */
    const openness = (snap, feet) => {
      let air = 0;
      let total = 0;
      for (let dx = -4; dx <= 4; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -4; dz <= 4; dz += 1) {
            total += 1;
            if (AIR.test(bare(cellAt(snap, { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz })))) air += 1;
          }
        }
      }
      return total ? air / total : 0;
    };

    /** Walk over the drops we just made and wait until the game hands them to us. */
    const collectDrops = async (maxDistance = 8) => {
      let picked = 0;
      for (let pass = 0; pass < 4; pass += 1) {
        const snap = await refresh(ctx);
        const drops = (snap.nearbyItems || []).filter(
          (drop) => drop && drop.position && (drop.distance === undefined || drop.distance <= maxDistance)
        );
        if (!drops.length) break;
        let pickedThisPass = 0;
        for (const drop of drops) {
          if (Date.now() > deadline) return picked;
          const dropCell = {
            x: Math.floor(drop.position.x),
            y: Math.floor(drop.position.y),
            z: Math.floor(drop.position.z)
          };
          // Never walk after a drop that hangs over a hole; the item is not worth the fall.
          const danger = dangerAt(await refresh(ctx), dropCell);
          if (danger) continue;
          const reached = await body
            .moveTo(drop.position, {
              range: 1.0,
              timeoutMs: 12000,
              // Nearby drops are inside the tunnel we just dug: walk straight at them. The
              // planner answers `noPath` for those same one-block hops and the live run left
              // iron on the floor because of it.
              raw: (drop.distance === undefined ? 99 : drop.distance) <= 4
            })
            .catch(() => false);
          if (!reached) continue;
          const before = ((await refresh(ctx)).nearbyItems || []).length;
          const waitUntil = Date.now() + 2500;
          while (Date.now() < waitUntil) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            const after = await refresh(ctx);
            if (((after.nearbyItems || []).length) < before) {
              picked += 1;
              pickedThisPass += 1;
              break;
            }
          }
        }
        if (!pickedThisPass) break;
      }
      stats.collected += picked;
      if (picked && ctx.log && ctx.log.info) ctx.log.info(`collected ${picked} dropped item(s)`);
      return picked;
    };

    /**
     * Keep the tunnel lit: at block light <= threshold plant a torch on the floor behind
     * the bot (the cell it just came from - the only guaranteed free floor in a 1-wide
     * tunnel). Returns {ok:false, paused:true} when the torches are gone.
     */
    const ensureLight = async (direction) => {
      const snap = await refresh(ctx);
      const light = lightAtFeet(snap);
      if (light > params.lightThreshold) return { ok: true };
      if (countItem(snap, params.torch) <= 0) {
        return {
          ok: false,
          paused: true,
          reason: `block light ${light} <= ${params.lightThreshold} and no ${bare(params.torch)} left`
        };
      }
      const feet = feetOf(snap);
      /**
       * Any free cell within 3 blocks whose floor is solid can take the torch.
       *
       * The first attempt only tried the cell behind/at/ahead of the bot at one fixed
       * height; on a slope those references are air, and the live run stood at light 0
       * holding a torch it could not place. Searching the neighbourhood fixes that.
       */
      const candidates = [];
      for (let dx = -3; dx <= 3; dx += 1) {
        for (let dz = -3; dz <= 3; dz += 1) {
          for (let dy = -2; dy <= 1; dy += 1) {
            const spot = { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz };
            if (!AIR.test(bare(cellAt(snap, spot)))) continue;
            if (spot.x === feet.x && spot.y === feet.y && spot.z === feet.z) continue; // the bot stands there
            const below = { x: spot.x, y: spot.y - 1, z: spot.z };
            const refName = bare(cellAt(snap, below));
            if (AIR.test(refName) || HAZARD.test(refName) || /torch|rail|sapling|flower/.test(refName)) continue;
            // Prefer the way we came from, then straight down, then everything else.
            const back = dx * -(direction.dx || 0) + dz * -(direction.dz || 0);
            const score = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2 - back;
            candidates.push({ spot, below, score });
          }
        }
      }
      candidates.sort((a, b) => a.score - b.score);
      for (const candidate of candidates.slice(0, 8)) {
        const reference = candidate.below;
        const torchName = Object.keys(snap.inventory || {}).find((name) => bare(name) === bare(params.torch));
        if (!torchName) break;
        await body.equip(torchName).catch(() => false);
        const placed = await body
          .place(torchName, reference, { x: 0, y: 1, z: 0 })
          .catch(() => false);
        if (!placed) continue;
        const after = await refresh(ctx);
        const spot = { x: reference.x, y: reference.y + 1, z: reference.z };
        if (/torch/.test(bare(cellAt(after, spot)))) {
          stats.torches += 1;
          if (ctx.log && ctx.log.info) ctx.log.info(`placed a torch at ${spot.x},${spot.y},${spot.z} (light was ${light})`);
          // Switch straight back to the pickaxe: the tunnel work must not continue with a
          // torch in hand (the operator sees exactly that, and dirt/stone would be slow).
          const pick = minePlan(after, params.ore).tool;
          if (pick) await body.equip(pick.name).catch(() => false);
          return { ok: true };
        }
      }
      return { ok: false, reason: 'could not place a torch (no floor to stick it to)' };
    };

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
      if (await eater.call(body, chosen).catch(() => false)) {
        stats.ate += 1;
        if (ctx.log && ctx.log.info) ctx.log.info(`ate ${bare(chosen)} (food was ${snap.food})`);
      }
    };

    /** Nearest ore in range, nearest first. */
    const findOre = async () => {
      const snap = await refresh(ctx);
      const here = feetOf(snap);
      if (!here) return null;
      const found = ctx.world && typeof ctx.world.findBlocksMatching === 'function'
        ? ctx.world.findBlocksMatching((name) => orePattern.test(bare(name)), {
            maxDistance: params.maxXZ + params.maxY,
            count: 96
          })
        : [];
      const usable = found.filter((block) => {
        if (blocked.has(posKey(block.position))) return false;
        const dx = block.position.x - here.x;
        const dz = block.position.z - here.z;
        const dy = block.position.y - here.y;
        if (Math.hypot(dx, dz) > params.maxXZ) return false;
        if (Math.abs(dy) > params.maxY) return false;
        return minePlan(snap, block.name).ok;
      });
      usable.sort(
        (a, b) =>
          Math.hypot(a.position.x - here.x, a.position.z - here.z) -
          Math.hypot(b.position.x - here.x, b.position.z - here.z)
      );
      return usable[0] || null;
    };

    /** One tunnel step toward `target`; digs the sloped opening and walks in. */
    const stepToward = async (target) => {
      const snap = await refresh(ctx);
      const here = feetOf(snap);
      if (!here) return { ok: false, reason: 'no position' };
      const dx = target.position.x - here.x;
      const dz = target.position.z - here.z;
      const dy = target.position.y - here.y;
      if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && Math.abs(dy) <= 1) return { ok: true, reached: true };

      let sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
      let sz = sx === 0 ? Math.sign(dz) : 0;
      /**
       * An ore directly above/below has no horizontal offset, and a vertical shaft is a
       * trap: the bot digs it and then cannot climb out, so the vein got abandoned after
       * two ores. Pick a side and take a diagonal stair step instead.
       */
      if (sx === 0 && sz === 0) {
        const sides = [
          { dx: 1, dz: 0 },
          { dx: -1, dz: 0 },
          { dx: 0, dz: 1 },
          { dx: 0, dz: -1 }
        ];
        const clear = sides.find((side) => {
          const cell = { x: here.x + side.dx, y: here.y, z: here.z + side.dz };
          const name = bare(cellAt(snap, cell));
          return !HAZARD.test(name) && minePlan(snap, name).ok;
        });
        const side = clear || sides[0];
        sx = side.dx;
        sz = side.dz;
      }
      const stepY = dy >= 2 ? 1 : dy <= -2 ? -1 : 0;
      const next = { x: here.x + sx, y: here.y + stepY, z: here.z + sz };

      const danger = dangerAt(snap, { x: next.x, y: next.y, z: next.z });
      if (danger) {
        return { ok: false, reason: `dangerous step: ${danger.reason}`, danger: true, hostile: danger.hostile };
      }

      if (stepY === 1) {
        // Sloped climb: clear the new foot and head levels, keep the block at the old foot
        // level as the step to jump onto (digging it would remove the floor to climb).
        if (!(await digAt({ x: next.x, y: here.y + 1, z: next.z }))) {
          return { ok: false, reason: 'blocked on the climb' };
        }
        if (!(await digAt({ x: next.x, y: here.y + 2, z: next.z }))) {
          return { ok: false, reason: 'blocked on the climb (headroom)' };
        }
      } else if (stepY === -1) {
        // Sloped descent: three cells - the new foot level, the old foot and the old head.
        if (!(await digAt({ x: next.x, y: here.y - 1, z: next.z }))) {
          return { ok: false, reason: 'blocked on the descent' };
        }
        if (!(await digAt({ x: next.x, y: here.y, z: next.z }))) {
          return { ok: false, reason: 'blocked on the descent (foot)' };
        }
        if (!(await digAt({ x: next.x, y: here.y + 1, z: next.z }))) {
          return { ok: false, reason: 'blocked on the descent (head)' };
        }
      } else {
        const foot = { x: next.x, y: here.y, z: next.z };
        const head = { x: next.x, y: here.y + 1, z: next.z };
        const footName = bare(cellAt(snap, foot));
        const headName = bare(cellAt(snap, head));
        if (HAZARD.test(footName) || HAZARD.test(headName)) return { ok: false, reason: 'water or lava ahead' };
        if (!(await digAt(foot))) return { ok: false, reason: 'blocked ahead' };
        if (!(await digAt(head))) return { ok: false, reason: 'blocked ahead (headroom)' };
      }

      await eatIfHungry();
      const moved = await stepTo(next);
      if (moved) return { ok: true };
      const stuckAt = feetOf(await refresh(ctx));
      const why = body.lastMove && body.lastMove.reason ? body.lastMove.reason : 'unknown';
      return {
        ok: false,
        reason:
          `could not walk into the dug step (${why}; wanted ${next.x},${next.y},${next.z}` +
          (stuckAt ? `, feet at ${stuckAt.x},${stuckAt.y},${stuckAt.z})` : ')')
      };
    };

    // ---- main loop: nearest ore -> tunnel -> collect -> next ore ------------
    let lastDirection = { dx: 0, dz: 0 };
    for (;;) {
      if (Date.now() > deadline) {
        stats.outOfTime = true;
        break;
      }
      await eatIfHungry();

      /**
       * Monster avoidance: with a hostile inside the ±3 box there is no safe way to keep
       * digging (the bot cannot see it coming through a wall), so the task stops and leaves
       * the fight to the operator. Drops are left alone on purpose - walking around with a
       * mob nearby is exactly the behaviour this rule exists to prevent.
       */
      const checkSnap = await refresh(ctx);
      const hostileNow = hostileInBox(checkSnap, feetOf(checkSnap) || { x: 0, y: 0, z: 0 });
      if (hostileNow) {
        const stop = await refresh(ctx);
        if (ctx.log && ctx.log.warn) {
          ctx.log.warn(`${bare(hostileNow.name)} is within 3 blocks - stopping the mining task`);
        }
        return {
          ok: true,
          stopped: 'hostile',
          mined: stats.ores,
          blocks: stats.blocks,
          torches: stats.torches,
          ate: stats.ate,
          collected: stats.collected,
          position: stop ? stop.position : null,
          detail: `stopped: ${bare(hostileNow.name)} within 3 blocks`
        };
      }

      const ore = await findOre();
      if (!ore) break;

      const snapNow = await refresh(ctx);
      const here = feetOf(snapNow);
      lastDirection = {
        dx: Math.sign(ore.position.x - here.x),
        dz: Math.sign(ore.position.z - here.z)
      };

      const light = await ensureLight(lastDirection);
      if (!light.ok) {
        if (light.paused) {
          stats.paused = true;
          return {
            ok: false,
            paused: true,
            mined: stats.ores,
            blocks: stats.blocks,
            torches: stats.torches,
            ate: stats.ate,
            position: here,
            reason: light.reason,
            detail: `paused after ${stats.ores} ore(s): ${light.reason}`
          };
        }
        if (ctx.log && ctx.log.warn) ctx.log.warn(light.reason);
      }

      /**
       * Anything within arm's reach is simply mined - no walking, no tunnel.
       *
       * This is also what finishes a vein: the neighbours of the ore just taken are usually
       * exposed and only a couple of blocks away, and the "nearest ore" loop can reach them
       * without a dig-forward step. If the server refuses (out of reach), the tunnel path
       * below handles it as before.
       */
      {
        const reachSnap = await refresh(ctx);
        const reachHere = feetOf(reachSnap);
        const reach = reachHere
          ? Math.hypot(
              ore.position.x - reachHere.x,
              ore.position.y - reachHere.y,
              ore.position.z - reachHere.z
            )
          : 99;
        if (reach <= 4.0) {
          const plan = minePlan(reachSnap, ore.name);
          if (plan.tool) await body.equip(plan.tool.name).catch(() => false);
          if (await body.dig({ name: ore.name, position: ore.position }).catch(() => false)) {
            stats.ores += 1;
            stats.blocks += 1;
            if (ctx.log && ctx.log.info) {
              ctx.log.info(`mined ${bare(ore.name)} at ${posKey(ore.position)} (within reach)`);
            }
            await collectDrops();
            continue;
          }
        }
      }

      let outcome = { ok: false, reason: 'gave up' };
      for (let step = 0; step < MAX_STEPS_PER_ORE; step += 1) {
        if (Date.now() > deadline) {
          stats.outOfTime = true;
          break;
        }
        outcome = await stepToward(ore);
        if (outcome.reached) break;
        if (!outcome.ok) break;
        // Sweep the stone drops the tunnel leaves behind every few steps, so the floor does
        // not silt up with items we then have to walk back for.
        if (step % 4 === 3) await collectDrops(3);
        const afterStep = await refresh(ctx);
        const feetAfter = feetOf(afterStep);
        if (feetAfter && openness(afterStep, feetAfter) >= 0.45) {
          stats.cavern = true;
          if (ctx.log && ctx.log.warn) {
            ctx.log.warn(`large cavern ahead at ${feetAfter.x},${feetAfter.y},${feetAfter.z} - stopping`);
          }
          break;
        }
      }
      if (stats.outOfTime) break;
      if (outcome.danger) {
        // Lava/fall: sweep the drops on the way out. A monster: leave them, walk nothing.
        if (!outcome.hostile) await collectDrops();
        const stop = await refresh(ctx);
        if (ctx.log && ctx.log.warn) ctx.log.warn(`stopping: ${outcome.reason}`);
        return {
          ok: true,
          stopped: 'danger',
          mined: stats.ores,
          blocks: stats.blocks,
          torches: stats.torches,
          ate: stats.ate,
          collected: stats.collected,
          position: stop ? stop.position : null,
          detail: `stopped before a dangerous step (${outcome.reason}); mined ${stats.ores} so far`
        };
      }
      if (stats.cavern) {
        await collectDrops();
        const stop = await refresh(ctx);
        return {
          ok: true,
          stopped: 'cavern',
          mined: stats.ores,
          blocks: stats.blocks,
          torches: stats.torches,
          ate: stats.ate,
          collected: stats.collected,
          position: stop ? stop.position : null,
          detail: `stopped: the tunnel opened into a large cavern (mined ${stats.ores} so far)`
        };
      }

      if (outcome.reached) {
        const finalSnap = await refresh(ctx);
        const plan = minePlan(finalSnap, ore.name);
        if (plan.tool) await body.equip(plan.tool.name).catch(() => false);
        if (await body.dig({ name: ore.name, position: ore.position }).catch(() => false)) {
          stats.ores += 1;
          stats.blocks += 1;
          if (ctx.log && ctx.log.info) {
            ctx.log.info(`mined ${bare(ore.name)} at ${ore.position.x},${ore.position.y},${ore.position.z}`);
          }
          // Do not walk away from the vein before taking its drops with us - the first live
          // run left iron on the floor and moved on to the next ore.
          await collectDrops();
        } else {
          blocked.add(posKey(ore.position));
        }
      } else {
        // Unreachable, drowned or walled in: never try this vein again.
        blocked.add(posKey(ore.position));
        stats.skipped += 1;
        if (ctx.log && ctx.log.warn) {
          ctx.log.warn(`cannot reach ${bare(ore.name)} at ${posKey(ore.position)}: ${outcome.reason}`);
        }
      }
    }

    // Final sweep before reporting: the last vein's drops are usually still on the floor.
    await collectDrops(12);
    const end = await refresh(ctx);
    return {
      ok: true,
      mined: stats.ores,
      blocks: stats.blocks,
      torches: stats.torches,
      ate: stats.ate,
      collected: stats.collected,
      skipped: stats.skipped,
      outOfTime: stats.outOfTime,
      position: end ? end.position : null,
      detail:
        `mined ${stats.ores} ${bare(params.ore)} (dug ${stats.blocks} blocks, ` +
        `${stats.torches} torch(es), collected ${stats.collected} drop(s), ate ${stats.ate}, ` +
        `skipped ${stats.skipped})` +
        (stats.outOfTime ? ' - time budget reached' : '')
    };
  }
});
