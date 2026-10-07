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
const { RecoveryLadder } = require('../core/recoveryLadder');
const { quoteApproach, stepVector, stepCells, DigLedger } = require('./miningPlan');

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
    'Quote every ore within range (x/z maxXZ, vertical maxY) by its approach cost - cells to dig, ' +
    'steps to take, vein blocks the arrival stand can reach - and take the cheapest; dig the sloped ' +
    'tunnel the quote describes, mine it and collect the drops. Refuses targets whose tunnel would ' +
    'drop sand on the bot or open into water, lights the tunnel with torches, and pauses when it runs ' +
    'out of torches in the dark.',
  params: {
    ore: { type: 'string', default: 'iron_ore' },
    maxXZ: { type: 'number', default: 30, min: 4, max: 48 },
    maxY: { type: 'number', default: 5, min: 1, max: 16 },
    maxMs: { type: 'number', default: 600000, min: 10000, max: 3600000 },
    eatAt: { type: 'number', default: 18, min: 1, max: 20 },
    food: { type: 'string', default: 'bread' },
    torch: { type: 'string', default: 'torch' },
    lightThreshold: { type: 'number', default: 2, min: 0, max: 15 },
    /**
     * numen's dig budget: refuse a target whose approach would need more than this many
     * terrain edits, and stop the task when execution digs this many cells the plan never
     * named (the plan is a commitment; the ledger is the actual account).
     */
    maxApproachDigs: { type: 'number', default: 96, min: 4, max: 512 },
    maxExtraDigs: { type: 'number', default: 12, min: 1, max: 200 }
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
      refusedCells: 0,
      rejectedTargets: 0,
      planExceeded: false,
      tunnelRuns: 0,
      tunnelCells: 0,
      plan: null,
      ledger: { planned: 0, dug: 0, extra: 0, extraCells: [] },
      minedAt: [],
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

    /** The plan the current ore is committed to; re-quoted for every new target. */
    let ledger = null;

    /**
     * Physical risks of digging one cell that "the cell itself is water/lava" cannot see.
     *
     * numen's dig admission prices both of these (DigQuote: 挖不动、贴着流体、顶着落沙):
     *   - falling sand/gravel directly above: digging this cell drops that column on the bot;
     *   - water in a horizontal neighbour: digging this cell opens the tunnel to a flood.
     * Both mark the target ore as not worth it (it is skipped), never the whole task.
     */
    const digRisk = (snap, position) => {
      const above = bare(cellAt(snap, { x: position.x, y: position.y + 1, z: position.z }));
      if (/(^|_)(sand|gravel)$/.test(above)) return `falling ${above} directly above`;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const neighbour = bare(cellAt(snap, { x: position.x + dx, y: position.y, z: position.z + dz }));
        if (/^(water|flowing_water)$/.test(neighbour)) return `water beside the block (${dx},${dz})`;
      }
      return null;
    };

    /**
     * Post one successfully dug cell to the actual account.
     *
     * Shared by the Node-side digger and the client's tunnel controller: whichever hand did
     * the digging, the ledger compares it against the quote and stops the task when the
     * world needed more edits than the plan named (numen's edit ledger).
     */
    const noteDug = (position) => {
      stats.blocks += 1;
      stats.ledger.dug += 1;
      if (!ledger) return;
      const unplanned = ledger.note(position);
      if (!unplanned) return;
      stats.ledger.extra = ledger.extra;
      stats.ledger.extraCells = ledger.extraCells;
      if (ledger.exceeded(params.maxExtraDigs)) {
        stats.planExceeded = true;
        if (ctx.log && ctx.log.warn) {
          ctx.log.warn(
            `plan exceeded: ${ledger.extra} cell(s) dug outside the quoted approach ` +
              `(budget ${params.maxExtraDigs}) - stopping`
          );
        }
      }
    };

    const digAt = async (position) => {
      const now = await refresh(ctx);
      const name = cellAt(now, position);
      if (AIR.test(bare(name))) return true;
      if (HAZARD.test(bare(name))) return false;
      const risk = digRisk(now, position);
      if (risk) {
        stats.refusedCells += 1;
        if (ctx.log && ctx.log.warn) {
          ctx.log.warn(`refusing to dig ${bare(name)} at ${posKey(position)}: ${risk}`);
        }
        return false;
      }
      const plan = minePlan(now, name);
      if (!plan.ok) {
        stats.refusedCells += 1;
        return false;
      }
      if (plan.tool) await body.equip(plan.tool.name).catch(() => false);
      const ok = await body.dig({ name, position }).catch(() => false);
      if (ok) noteDug(position);
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
        // Adjacent counts: the live run answered "arrived" while the feet were one block
        // past the target, and the strict equality threw that success away ("could not walk
        // into the dug step (arrived; ...)") and blacklisted a perfectly good vein.
        return (
          !!after &&
          Math.abs(after.x - position.x) <= 1 &&
          Math.abs(after.z - position.z) <= 1 &&
          Math.abs(after.y - position.y) <= 1
        );
      };
      /**
       * Always the client's own walker for a single tunnel step.
       *
       * The A* layer cannot execute a step that needs a jump: the live log shows
       * "leg (-84,-11,75) needed a step-up and failed" followed by a 45 s timeout even
       * though the ceiling was already cleared. A one-block hop is exactly what the
       * client's hold-forward-and-jump does best.
       */
      await body.moveTo(position, { raw: true, range: 0.45, timeoutMs: 20000 }).catch(() => false);
      if (await arrived()) return true;
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
          const dropId = drop.id;
          const gone = async () =>
            !((await refresh(ctx)).nearbyItems || []).some((item) => item.id === dropId);
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
          if (reached && (await gone())) {
            picked += 1;
            pickedThisPass += 1;
            continue;
          }
          /**
           * Walking failed - the drop is on a ledge the planner cannot route to (the live
           * run left iron on a shelf three blocks above the tunnel). Climb to it with the
           * same sloped stair the mining uses, ceiling included, then wait for the pickup.
           */
          if (!reached) {
            for (let step = 0; step < 10; step += 1) {
              const climb = await stepToward({ position: dropCell });
              if (climb.reached) break;
              if (!climb.ok) break;
            }
          }
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

    /** The quote for the ore the loop is currently working on (set by findOre). */
    let lastQuote = null;

    /**
     * Cheapest usable ore, numen-style (DigQuote/Goals.dig): every candidate gets a dig
     * quote - cells to dig, steps to take, and how many same-type ore blocks the arrival
     * stand can reach - and the cheapest wins. Distance only breaks ties, so a far ore
     * behind open air beats a near one behind six blocks of stone, and a vein stand beats
     * a single-block stand at equal cost.
     */
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
      if (!usable.length) {
        lastQuote = null;
        return null;
      }
      /**
       * Quote only the nearest candidates: the quote simulates the stair on the snapshot,
       * and running it for every one of 96 ores would walk the whole scan repeatedly.
       * 32 is far more than a real vein field has within 30 blocks.
       */
      usable.sort(
        (a, b) =>
          Math.hypot(a.position.x - here.x, a.position.z - here.z) -
          Math.hypot(b.position.x - here.x, b.position.z - here.z)
      );
      const shortlist = usable.slice(0, 32);
      const countReachable = (arrival) =>
        found.filter(
          (block) =>
            Math.hypot(
              block.position.x - arrival.x,
              block.position.y - arrival.y,
              block.position.z - arrival.z
            ) <= 4
        ).length;

      const quoted = [];
      for (const block of shortlist) {
        const quote = quoteApproach({
          from: here,
          ore: block.position,
          read: (cell) => bare(cellAt(snap, cell)),
          passable: (name) => AIR.test(name),
          mineable: (name) => minePlan(snap, name).ok,
          hazard: (name) => HAZARD.test(name),
          chooseSide: (cell) => chooseSide(snap, cell),
          reachableCount: countReachable,
          /**
           * numen's admission check before a job is accepted: a cell whose dig would drop
           * sand on the bot or open the tunnel to water is not a target at all.
           */
          risky: (cell) => digRisk(snap, cell),
          maxDigs: params.maxApproachDigs
        });
        if (quote.ok) quoted.push({ block, quote });
        else stats.rejectedTargets += 1;
      }
      quoted.sort((a, b) => a.quote.cost - b.quote.cost || a.quote.travel - b.quote.travel);
      const best = quoted[0] || null;
      lastQuote = best;
      if (best && ctx.log && ctx.log.info) {
        ctx.log.info(
          `plan: ${bare(best.block.name)} @${posKey(best.block.position)} - cost ${best.quote.cost} ` +
            `(dig ${best.quote.digs}, steps ${best.quote.steps}, vein ${best.quote.vein}, ` +
            `travel ${best.quote.travel.toFixed(1)})`
        );
      }
      return best ? best.block : null;
    };

    /**
     * A lateral side for a target directly above/below.
     *
     * An ore directly above/below has no horizontal offset, and a vertical shaft is a trap:
     * the bot digs it and then cannot climb out, so the vein got abandoned after two ores.
     * Pick a side and take a diagonal stair step instead. Shared with the quote, so the plan
     * and the execution choose the same side.
     */
    const chooseSide = (snap, here) => {
      const sides = [
        { sx: 1, sz: 0 },
        { sx: -1, sz: 0 },
        { sx: 0, sz: 1 },
        { sx: 0, sz: -1 }
      ];
      const clear = sides.find((side) => {
        const cell = { x: here.x + side.sx, y: here.y, z: here.z + side.sz };
        const name = bare(cellAt(snap, cell));
        return !HAZARD.test(name) && minePlan(snap, name).ok;
      });
      return clear || sides[0];
    };

    /** One tunnel step toward `target`; digs the sloped opening and walks in. */
    const stepToward = async (target) => {
      const snap = await refresh(ctx);
      const here = feetOf(snap);
      if (!here) return { ok: false, reason: 'no position' };
      /**
       * The geometry comes from src/skills/miningPlan.js - the same module the quote uses -
       * so "planned cells" and "cells actually dug" compare without a second implementation
       * drifting away from the executor.
       */
      const vector = stepVector(here, target.position);
      if (!vector) return { ok: true, reached: true };
      if (vector.vertical) {
        const side = chooseSide(snap, here);
        vector.sx = side.sx;
        vector.sz = side.sz;
      }
      const { next, cells } = stepCells(here, vector);
      const { stepY } = vector;

      const danger = dangerAt(snap, { x: next.x, y: next.y, z: next.z });
      if (danger) {
        return { ok: false, reason: `dangerous step: ${danger.reason}`, danger: true, hostile: danger.hostile };
      }

      if (stepY === 1) {
        /**
         * Sloped climb, three cells: the ceiling over the bot's own head, the new foot
         * level and the new head level.
         *
         * The live bug: climbing onto the step needs a JUMP, and a jump puts the head into
         * the block *above the bot's current head*. That ceiling was never dug, so the bot
         * pogoed in place under it and could never go up. The block at the old foot level
         * stays - it is the step the bot jumps onto.
         */
        const [ceiling, newFoot, newHead] = cells;
        if (ctx.log && ctx.log.info) {
          ctx.log.info(
            `climb: feet ${here.x},${here.y},${here.z} -> ${next.x},${next.y},${next.z}; ` +
              `ceiling ${bare(cellAt(snap, ceiling))}, foot ${bare(cellAt(snap, newFoot))}, ` +
              `head ${bare(cellAt(snap, newHead))}`
          );
        }
        if (!(await digAt(ceiling))) {
          return { ok: false, reason: `blocked overhead by ${bare(cellAt(await refresh(ctx), ceiling))} - cannot jump up` };
        }
        if (!(await digAt(newFoot))) {
          return { ok: false, reason: `blocked on the climb by ${bare(cellAt(await refresh(ctx), newFoot))}` };
        }
        if (!(await digAt(newHead))) {
          return { ok: false, reason: `blocked on the climb (headroom) by ${bare(cellAt(await refresh(ctx), newHead))}` };
        }
        if (ctx.log && ctx.log.info) {
          ctx.log.info(
            `climb cleared; after: ceiling ${bare(cellAt(await refresh(ctx), ceiling))}, ` +
              `foot ${bare(cellAt(await refresh(ctx), newFoot))}, head ${bare(cellAt(await refresh(ctx), newHead))}`
          );
        }
      } else if (stepY === -1) {
        // Sloped descent: three cells - the new foot level, the old foot and the old head.
        const [below, newFoot, newHead] = cells;
        if (!(await digAt(below))) {
          return { ok: false, reason: 'blocked on the descent' };
        }
        if (!(await digAt(newFoot))) {
          return { ok: false, reason: 'blocked on the descent (foot)' };
        }
        if (!(await digAt(newHead))) {
          return { ok: false, reason: 'blocked on the descent (head)' };
        }
      } else {
        const [foot, head] = cells;
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
          refusedCells: stats.refusedCells,
          minedAt: stats.minedAt,
          plan: stats.plan,
          ledger: { ...stats.ledger },
          detail: `stopped: ${bare(hostileNow.name)} within 3 blocks`
        };
      }

      const ore = await findOre();
      if (!ore) break;

      /**
       * The plan is a commitment (numen: 计划即承诺). The chosen ore brings the quoted
       * approach with it; every cell dug from here on is accounted against that quote, and
       * a later target re-quotes from the live world instead of carrying stale bookkeeping.
       */
      if (lastQuote && lastQuote.block === ore) {
        ledger = new DigLedger([...lastQuote.quote.edits, ore.position]);
        stats.ledger.planned += ledger.planned.size;
        stats.plan = {
          name: bare(ore.name),
          target: { ...ore.position },
          digs: lastQuote.quote.digs,
          steps: lastQuote.quote.steps,
          vein: lastQuote.quote.vein,
          cost: lastQuote.quote.cost
        };
      }

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
            refusedCells: stats.refusedCells,
            minedAt: stats.minedAt,
            plan: stats.plan,
            ledger: { ...stats.ledger },
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
      /**
       * Per-ore recovery ladder (src/core/recoveryLadder.js), numen-style:
       *   rung 1 `tunnel`      - hand the quoted step list to the client's dig-while-walking
       *                          controller: one continuous action that holds forward, clears
       *                          what blocks the way and jumps only real one-block steps;
       *   rung 2 `clear-retry` - the controller reports the exact cell that stopped it; dig
       *                          that cell (again) and re-run the same tunnel. This is the
       *                          answer to a stale scan / a dig the server did not confirm,
       *                          which is exactly when the old code jumped at a wall;
       *   rung 3 `direct`      - bodies without the tunnel primitive use the Node-side stair;
       *   rung 4 `flank`       - walled off from this side: approach from the far side.
       * Hazard/cavern stops are not recoverable: no rung handles them, so the ore is skipped
       * (danger) or the task ends (cavern) exactly as before.
       */
      const takeOre = async () => {
        const snapNow = await refresh(ctx);
        const here = feetOf(snapNow);
        const dist = here
          ? Math.hypot(ore.position.x - here.x, ore.position.y - here.y, ore.position.z - here.z)
          : 99;
        if (dist > 4.0) return { ok: false, reason: 'the ore is out of reach', failure: 'out_of_reach' };
        /**
         * A stale scan can list an ore another actor already took. `digAt` answers true for
         * air (nothing to dig), which is right for a tunnel cell but must never count as a
         * mined ore - numen kicks this back as TARGET_LOST. This was a real offline loop:
         * without it the skill "mined" one ore a million times.
         */
        if (AIR.test(bare(cellAt(snapNow, ore.position)))) {
          return { ok: false, reason: 'the ore is already gone (stale scan)', failure: 'target_lost' };
        }
        /**
         * The ore itself goes through the same dig admission as every tunnel cell, so the
         * ledger sees it, the falling-sand/water checks apply, and the tool is chosen in one
         * place instead of three.
         */
        if (await digAt(ore.position)) {
          const after = await refresh(ctx);
          if (!AIR.test(bare(cellAt(after, ore.position)))) {
            return { ok: false, reason: 'the dig reported success but the ore is still there', failure: 'internal' };
          }
          stats.ores += 1;
          stats.minedAt.push({ name: bare(ore.name), position: { ...ore.position } });
          if (ctx.log && ctx.log.info) {
            ctx.log.info(`mined ${bare(ore.name)} at ${posKey(ore.position)}`);
          }
          // Do not walk away from the vein before taking its drops with us - the first live
          // run left iron on the floor and moved on to the next ore.
          await collectDrops();
          return { ok: true, dug: true };
        }
        return { ok: false, reason: 'the ore dig was refused', failure: 'refused' };
      };

      const attempt = async (waypoint) => {
        const direct = waypoint.x === ore.position.x && waypoint.y === ore.position.y && waypoint.z === ore.position.z;
        if (direct) {
          const already = await takeOre();
          if (already.ok) return already;
        }
        let outcome = { ok: false, reason: 'gave up' };
        for (let step = 0; step < MAX_STEPS_PER_ORE; step += 1) {
          if (Date.now() > deadline) {
            stats.outOfTime = true;
            return { ok: false, reason: 'out of time', failure: 'timeout', outOfTime: true };
          }
          outcome = await stepToward({ position: waypoint });
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
            return { ok: false, reason: 'large cavern ahead', failure: 'hazard', cavern: true };
          }
        }
        if (outcome.danger) {
          return { ok: false, reason: outcome.reason, failure: 'hazard', danger: true, hostile: outcome.hostile };
        }
        if (!outcome.reached) {
          return { ok: false, reason: outcome.reason || 'did not reach the waypoint', failure: 'no_path' };
        }
        return takeOre();
      };

      const flankWaypoint = async () => {
        const here = feetOf(await refresh(ctx));
        if (!here) return null;
        const dx = Math.sign(ore.position.x - Math.floor(here.x)) || 1;
        const dz = Math.sign(ore.position.z - Math.floor(here.z)) || 0;
        const candidates = [
          { x: ore.position.x + dx, y: ore.position.y, z: ore.position.z + dz },
          { x: ore.position.x + dx, y: ore.position.y, z: ore.position.z },
          { x: ore.position.x, y: ore.position.y, z: ore.position.z + dz }
        ];
        return candidates.find((c) => !(c.x === ore.position.x && c.z === ore.position.z)) || null;
      };

      /**
       * Map the client controller's vocabulary onto the failure types the ladder routes on.
       * `jump-blocked`/`headroom`/`blocked` are all "something solid is still in the way" -
       * the clear-retry rung's business; `stuck`/`timeout` are route problems; falling sand,
       * liquid and a `ledge` (a step whose floor is more than two blocks down) are hazards
       * nobody should retry.
       */
      const classifyTunnelFailure = (reason) => {
        const text = String(reason || '');
        if (/jump-blocked|headroom|occluded|blocked|unbreakable/i.test(text)) return 'occluded';
        if (/stuck|no-progress|timeout|budget/i.test(text)) return 'no_path';
        if (/falling|hazard|water|lava|ledge/i.test(text)) return 'hazard';
        return 'unknown';
      };

      /**
       * One tunnel execution: hand the quoted steps to the client and post the cells it
       * actually dug to the ledger. `lastTunnelCell` keeps the controller's structured
       * stopping point for the clear-retry rung.
       *
       * The client walks the whole list itself, so the path guards a per-step executor would
       * apply have to run around the hand-off: before it every waypoint goes through the same
       * `dangerAt` admission the direct stair uses (deep drop below, lava nearby, hostiles),
       * and after it the space around the feet is re-read so a run that broke into a cavern
       * stops the task exactly like the direct path does. The controller's own tick-level
       * ledge probe covers whatever changes after the scan.
       */
      const tunnelSteps =
        lastQuote && lastQuote.block === ore && Array.isArray(lastQuote.quote.plan) ? lastQuote.quote.plan : [];
      let lastTunnelCell = null;
      let lastTunnelBlock = null;
      const runTunnel = async (steps) => {
        if (!steps.length) return { ok: false, reason: 'no quoted steps for this ore', failure: 'no_path' };
        const pre = await refresh(ctx);
        if (pre) {
          for (const step of steps) {
            const danger = dangerAt(pre, step.waypoint);
            if (!danger) continue;
            const where = posKey(step.waypoint);
            if (ctx.log && ctx.log.warn) {
              ctx.log.warn(`unsafe tunnel waypoint ${where}: ${danger.reason} - stopping`);
            }
            return {
              ok: false,
              reason: `unsafe tunnel waypoint ${where}: ${danger.reason}`,
              failure: 'hazard',
              danger: true,
              hostile: danger.hostile
            };
          }
        }
        stats.tunnelRuns += 1;
        const result = await body
          .tunnel(
            steps.map((s) => s.waypoint),
            { timeoutMs: Math.min(240000, 20000 * steps.length) }
          )
          .catch((err) => ({ ok: false, reason: `tunnel threw: ${err.message}`, cell: null, block: null, dugCells: [] }));
        if (!result.ok) {
          lastTunnelCell = result.cell ? { ...result.cell } : null;
          lastTunnelBlock = result.block || null;
          return {
            ok: false,
            reason: result.reason || 'the tunnel walk failed',
            failure: classifyTunnelFailure(result.reason),
            cell: lastTunnelCell,
            block: lastTunnelBlock
          };
        }
        lastTunnelCell = null;
        lastTunnelBlock = null;
        for (const cell of result.dugCells || []) {
          stats.tunnelCells += 1;
          noteDug(cell);
        }
        if (stats.planExceeded) {
          return { ok: false, reason: 'the tunnel dug outside the quoted plan', failure: 'no_path' };
        }
        /**
         * Cavern guard for the continuous action: the tunnel may have opened into air the
         * scan did not show. Re-read before the ore is taken - the same rule the direct stair
         * applies between its steps.
         */
        const after = await refresh(ctx);
        const afterFeet = feetOf(after);
        if (afterFeet && openness(after, afterFeet) >= 0.45) {
          stats.cavern = true;
          if (ctx.log && ctx.log.warn) {
            ctx.log.warn(`large cavern ahead at ${afterFeet.x},${afterFeet.y},${afterFeet.z} - stopping`);
          }
          return { ok: false, reason: 'large cavern ahead', failure: 'hazard', cavern: true };
        }
        return takeOre();
      };

      const rungs = [];
      if (typeof body.tunnel === 'function' && tunnelSteps.length) {
        rungs.push({
          name: 'tunnel',
          handles: ['no_path', 'occluded', 'out_of_reach', 'unknown', 'target_lost'],
          maxAttempts: 1,
          run: () => runTunnel(tunnelSteps)
        });
        rungs.push({
          name: 'clear-retry',
          handles: ['occluded', 'no_path'],
          maxAttempts: 1,
          run: async () => {
            if (!lastTunnelCell) {
              return { ok: false, reason: 'the tunnel gave up without naming a cell', failure: 'unknown' };
            }
            if (ctx.log && ctx.log.warn) {
              ctx.log.warn(
                `tunnel stopped at ${posKey(lastTunnelCell)}${lastTunnelBlock ? ` (${lastTunnelBlock})` : ''} - ` +
                  'clearing that cell and retrying'
              );
            }
            const cleared = await digAt(lastTunnelCell);
            if (!cleared) {
              return {
                ok: false,
                reason: `could not clear the cell the tunnel stopped at (${posKey(lastTunnelCell)})`,
                failure: 'refused',
                cell: lastTunnelCell
              };
            }
            return runTunnel(tunnelSteps);
          }
        });
      }
      rungs.push(
        {
          name: 'direct',
          handles: ['no_path', 'out_of_reach', 'occluded', 'unknown', 'target_lost', 'refused'],
          maxAttempts: 1,
          run: () => attempt(ore.position)
        },
        {
          name: 'flank',
          handles: ['no_path', 'out_of_reach', 'occluded'],
          maxAttempts: 1,
          run: async () => {
            const waypoint = await flankWaypoint();
            if (!waypoint) return { ok: false, reason: 'no flank waypoint', failure: 'no_path' };
            return attempt(waypoint);
          }
        }
      );
      const ladder = new RecoveryLadder('mine_ore', rungs);
      const outcome = await ladder.run();

      if (stats.outOfTime || outcome.outOfTime) break;
      if (stats.planExceeded) break;
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
          refusedCells: stats.refusedCells,
          minedAt: stats.minedAt,
          plan: stats.plan,
          ledger: { ...stats.ledger },
          detail: `stopped before a dangerous step (${outcome.reason}); mined ${stats.ores} so far`
        };
      }
      if (stats.cavern || outcome.cavern) {
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
          refusedCells: stats.refusedCells,
          minedAt: stats.minedAt,
          plan: stats.plan,
          ledger: { ...stats.ledger },
          detail: `stopped: the tunnel opened into a large cavern (mined ${stats.ores} so far)`
        };
      }
      if (!(outcome.ok && outcome.dug)) {
        // Unreachable, drowned or walled in - even the flank route did not work.
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
    const ledgerSummary = {
      planned: stats.ledger.planned,
      dug: stats.ledger.dug,
      extra: stats.ledger.extra,
      extraCells: stats.ledger.extraCells
    };
    return {
      ok: !stats.planExceeded,
      stopped: stats.planExceeded ? 'plan-exceeded' : null,
      mined: stats.ores,
      blocks: stats.blocks,
      torches: stats.torches,
      ate: stats.ate,
      collected: stats.collected,
      skipped: stats.skipped,
      refusedCells: stats.refusedCells,
      rejectedTargets: stats.rejectedTargets,
      tunnel: { runs: stats.tunnelRuns, cells: stats.tunnelCells },
      outOfTime: stats.outOfTime,
      minedAt: stats.minedAt,
      plan: stats.plan,
      ledger: ledgerSummary,
      position: end ? end.position : null,
      detail:
        `mined ${stats.ores} ${bare(params.ore)} (dug ${stats.blocks} blocks, ` +
        `${stats.torches} torch(es), collected ${stats.collected} drop(s), ate ${stats.ate}, ` +
        `skipped ${stats.skipped})` +
        `; ledger planned ${ledgerSummary.planned} / dug ${ledgerSummary.dug} / extra ${ledgerSummary.extra}` +
        (stats.planExceeded ? ' - plan exceeded, stopped' : stats.outOfTime ? ' - time budget reached' : '')
    };
  }
});
