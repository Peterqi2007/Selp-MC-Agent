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
const { bare, findScaffold } = require('../world/items');
const { toolPlan } = require('../world/toolPolicy');
const { RecoveryLadder } = require('../core/recoveryLadder');
const { quoteApproach, stepVector, stepCells, DigLedger } = require('./miningPlan');
const { normalizeOreParams, resolverFromCtx, targetMatches } = require('../core/miningRequest');
const { pillarUpRounds } = require('./pillarUp');
const {
  resolveMiningProducts,
  prepareAcquisition,
  sealBaseline,
  recordMineResult,
  reconcilePendingGoals,
  describeAcquisition
} = require('./miningAcquisition');
const { attemptCollection } = require('./miningCollection');
const { MiningProgressMonitor, fingerprintOf } = require('../core/miningProgress');

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
    /**
     * No schema default: `block` is an alias for the same field, and a default here would
     * always win over an explicitly passed `block` (validate fills defaults first). The
     * fallback to iron_ore lives in run() where the two spellings are resolved together.
     */
    ore: { type: 'string' },
    /**
     * The LLM's natural phrasing for the same thing, including a comma list
     * ("diamond_ore,deepslate_diamond_ore"). Kept as an alias rather than renamed, because
     * the live diamond run was rejected with `unknown parameter "block"` and fell back to
     * the walk-only mining task, which cannot reach embedded ores (2026-10-10).
     */
    block: { type: 'string' },
    /** Optional cap: stop after this many ores are mined (absent = until no targets/budget). */
    count: { type: 'number', min: 1, max: 256 },
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
    /**
     * The task's cancellation token (TaskHub). It belongs to *this* task, so it must be
     * checked at every action boundary - a global `owner-stop` flag would also stop work
     * after the operator has explicitly started a new task (plan §5.4.3).
     */
    const taskSignal = ctx.taskSignal || null;
    const cancelled = () => !!(taskSignal && taskSignal.cancelled);
    const stats = {
      ores: 0,
      blocks: 0,
      torches: 0,
      ate: 0,
      collected: 0,
      verifiedGoals: 0,
      partial: false,
      recoveryRuns: 0,
      recoveryTrigger: null,
      recovery: [],
      skipped: 0,
      refusedCells: 0,
      rejectedTargets: 0,
      planExceeded: false,
      tunnelRuns: 0,
      tunnelCells: 0,
      pillarRises: 0,
      pillarPlaced: 0,
      pillarCleared: 0,
      plan: null,
      ledger: { planned: 0, dug: 0, extra: 0, extraCells: [] },
      minedAt: [],
      outOfTime: false,
      countReached: false,
      paused: false,
      cavern: false
    };

    /**
     * Resolve the target block names from `ore` or its `block` alias. A comma list may carry
     * both the plain and the deepslate variant; the pattern matches any of them, so the same
     * job works above y=0 (diamond_ore) and below it (deepslate_diamond_ore).
     */
    /**
     * The skill boundary normalizes through the same pure module as every entry point
     * (plan §5.6.1: "在技能边界也调用同一个纯归一函数，防止直调绕过"). A direct
     * `do_skill("mine_ore")` therefore gets the same alias expansion and the same
     * deepslate pairs as `!mine`, and a plain material target is refused as
     * `bad_argument` instead of silently scanning for a block that is not an ore.
     */
    const normalizedTargets = normalizeOreParams(
      { ore: params.ore, block: params.block },
      { resolver: resolverFromCtx(ctx) }
    );
    if (!normalizedTargets.ok) {
      return { ok: false, reason: normalizedTargets.reason, failure: 'bad_argument' };
    }
    const oreNames = normalizedTargets.blocks;
    const oreLabel = oreNames.join('/');
    /**
     * Exact set membership, never an end-anchored regex: `diamond_ore$` would also match
     * a modded `foo:diamond_ore`, and a bare `gold_ore` would match `nether_gold_ore`
     * nowhere (good) but `deepslate_gold_ore` only by luck of the suffix (bad).
     */
    const oreSet = new Set(oreNames);
    const matchesOre = (name) => targetMatches(name, oreSet);

    let snapshot = await refresh(ctx);
    if (!snapshot) return { ok: false, reason: 'no state from the client' };
    const pickaxe = (() => {
      for (const name of oreNames) {
        const plan = minePlan(snapshot, name);
        if (plan && plan.ok && plan.tool) return plan.tool.name;
      }
      return null;
    })();
    if (!pickaxe) return { ok: false, reason: `no pickaxe that can mine ${oreLabel}` };
    await body.equip(pickaxe).catch(() => false);
    if (ctx.log && ctx.log.info) {
      ctx.log.info(`mine_ore: ${oreLabel} with ${bare(pickaxe)} at y=${feetOf(snapshot).y}`);
    }

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
      /**
       * The Mod refuses a dig whose block center is more than 4.5 blocks from the player
       * (ClientActions.dig, plan §3.1). Do not send the request at all: a "dig refused"
       * that never left Node keeps the logs honest and makes the offline tests measure the
       * same admission rule the live run applies.
       */
      const feetNow = feetOf(now);
      if (feetNow) {
        const reach = Math.hypot(
          feetNow.x - position.x,
          feetNow.y - (position.y + 0.5),
          feetNow.z - position.z
        );
        if (reach > 4.5) {
          stats.refusedCells += 1;
          if (ctx.log && ctx.log.warn) {
            ctx.log.warn(`refusing to dig ${bare(name)} at ${posKey(position)}: ${reach.toFixed(2)} blocks away (> 4.5)`);
          }
          return false;
        }
      }
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
          const pick = minePlan(after, oreNames[0]).tool;
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
        /**
         * Eating leaves the food in the main hand, and the tunnel rung digs client-side
         * with whatever is held for the whole run. Put the pickaxe back immediately - the
         * live run carved a stone stair holding bread (2026-10-08).
         */
        await body.equip(pickaxe).catch(() => false);
      }
    };

    /**
     * A block to pillar with, preferring common scaffold materials.
     *
     * The player answer to "walled in, need to go up" is "jump and place under yourself";
     * cobblestone/dirt/planks/logs are what survives the trip (live 2026-10-10).
     */
    const scaffoldBlock = (snap) => {
      // One preference list for the skill, the pillar executor and the mock body.
      return findScaffold((snap && snap.inventory) || {});
    };

    /**
     * The acquired-goal ledger (C1): one record per mined ore, from the sealed pre-dig
     * baseline to the verified pickup. The collector reads and writes the same records the
     * LLM recovery path will use, so there is one evidence chain, not two.
     */
    const goals = [];
    /**
     * The ore the main loop is currently working on. Outer-scope helpers (fingerprint,
     * provisional goal, recovery IO) run after the loop's block-scoped `ore` is out of
     * reach, so the current target is mirrored here (live 2026-10-10: referencing the
     * loop variable from such a helper threw "ore is not defined" mid-recovery).
     */
    let currentOre = null;

    /**
     * P3: the progress monitor and the P2 hand-over (plan §5.2/§5.3). The macro records
     * a semantic entry at every action boundary; when the monitor names a trigger, control
     * moves to the recovery session *inside this same task* and comes back if it recovers.
     */
    const recoveryCfg = (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.miningRecovery) || {};
    const progress = new MiningProgressMonitor({ config: { miningRecovery: recoveryCfg } });
    /** The most recent collection result, for the pickup_stalled trigger. */
    let lastCollection = null;

    const currentGoalId = () => {
      const pending = goals.find((g) => g.mined.confirmed && g.status === 'pending');
      const last = goals[goals.length - 1];
      return (pending || last || { goalId: 'locked' }).goalId;
    };

    /** Situation fingerprint for the monitor: feet + the cells this phase depends on. */
    const situationFingerprint = async (phase) => {
      const snap = await refresh(ctx);
      const feet = feetOf(snap);
      const cells = [];
      if (feet) {
        for (const dy of [1, 2, 3]) {
          cells.push({ x: feet.x, y: feet.y + dy, z: feet.z, name: bare(cellAt(snap, { x: feet.x, y: feet.y + dy, z: feet.z })) });
        }
      }
      const latest = goals[goals.length - 1];
      if (latest) cells.push({ ...latest.target.position, name: bare(cellAt(snap, latest.target.position)) });
      return fingerprintOf({
        goalId: currentGoalId(),
        phase,
        feet,
        cells,
        tool: pickaxe ? bare(pickaxe) : null,
        scaffold: scaffoldBlock(snap),
        target: {
          mined: !!(latest && latest.mined.confirmed),
          visible: !!(currentOre && !AIR.test(bare(cellAt(snap, currentOre.position)))),
          pending: latest ? latest.pendingDrops.length : 0
        }
      });
    };

    const recordProgress = async (entry) => {
      const fingerprint = await situationFingerprint(entry.phase).catch(() => null);
      return progress.record({ goalId: currentGoalId(), fingerprint, ...entry });
    };

    /** IO the shared collector drives; every world touch goes through the skill's admission. */
    const collectionIo = () => ({
      log: ctx.log,
      refresh: async () => {
        const s = await refresh(ctx);
        return s && s.ready !== false ? s : null;
      },
      feetOf,
      read: (s, cell) => bare(cellAt(s, cell)),
      passable: (name) => AIR.test(name),
      solid: (name) => !AIR.test(name) && !HAZARD.test(name) && !/torch|rail|sapling|flower/.test(name),
      /** Another ore of the task set must never be carved away as "access". */
      protectedName: (name) => matchesOre(name),
      dangerAt: (s, cell) => {
        const d = dangerAt(s, cell);
        return d ? { reason: d.reason, hostile: !!d.hostile } : null;
      },
      moveTo: async (position, opts) => {
        /** Respect the caller's tolerance: a carve step needs a real cell landing. */
        const within = (opts && opts.within) || 1;
        const range = Math.min(1, Math.max(0.3, within));
        /**
         * Strict entry (within <= 0.5) means "stand in that block". Aim the client walker
         * at the precise cell CENTRE instead of the floored corner: a corner aim converges
         * the steer line onto the corner and wedges the body against the neighbouring row
         * (live 2026-10-12, diagonal-sealed pocket - the bot stopped half a body width
         * short and both attempts "arrived" without entering). The centre aim keeps a
         * lateral component on the approach, so the collision slide carries it past the
         * corner. The range stays <= 0.5 so the client requires the feet cell itself, not
         * "close by" (a 0.8 range "arrives" from outside and turned the fallback into a
         * silent no-op).
         */
        const strict = within <= 0.5;
        const target = strict ? { x: position.x + 0.5, y: position.y, z: position.z + 0.5 } : position;
        if (opts && opts.plan) {
          // Planner route (A*): orthogonal legs around a corner the slide-walker cannot take.
          const ok = await body
            .moveTo(target, {
              range: strict ? 0.5 : Math.max(range, 0.8),
              timeoutMs: 18000,
              ...(strict ? { precise: true } : {})
            })
            .catch(() => false);
          return { ok: !!ok };
        }
        const ok = await body
          .moveTo(target, { range, timeoutMs: 12000, raw: true, ...(strict ? { precise: true } : {}) })
          .catch(() => false);
        return { ok: !!ok };
      },
      digCell: async (cell) => {
        const ok = await digAt(cell);
        return ok ? { ok: true } : { ok: false, reason: `could not clear ${posKey(cell)}`, failure: 'refused' };
      },
      climbTo: (stand, opts) => climbToStand(stand, opts),
      /** Support block for the "fill the pit" descent fallback (permission-gated place). */
      pickScaffold: (s) => scaffoldBlock(s),
      placeBlock: async (item, reference, face) => {
        const ok = await body.place(item, reference, face).catch(() => false);
        return { ok: !!ok };
      }
    });

    /**
     * Climb toward a pickup stand with the P4 executor: one shared physical implementation
     * for "jump and place under yourself", budgeted by the collection plan (§5.3).
     */
    const climbToStand = async (stand, opts = {}) => {
      const startSnap = await refresh(ctx);
      const feet = feetOf(startSnap);
      if (!feet || !stand || stand.y <= feet.y) return { ok: false, risen: 0, reason: 'no climb needed' };
      const maxSteps = Math.max(1, opts.maxSteps || 2);
      const res = await pillarUpRounds({
        deadline: Math.min(opts.deadline || deadline, deadline),
        signal: opts.signal || taskSignal,
        goalFeetY: Math.min(stand.y, feet.y + maxSteps),
        maxRise: maxSteps,
        log: ctx.log,
        io: {
          refresh: async () => {
            const s = await refresh(ctx);
            return s && s.ready !== false ? s : null;
          },
          feetOf,
          scanCell: (s, cell) => bare(cellAt(s, cell)),
          isAir: (name) => AIR.test(name),
          sameColumn: (s, start) => {
            const f = feetOf(s);
            return !!f && f.x === start.x && f.z === start.z;
          },
          dangerAt: (s, cell) => {
            const d = dangerAt(s, cell);
            return d ? { reason: d.reason, hostile: !!d.hostile } : null;
          },
          isTargetCell: () => false,
          /**
           * Every task ore is protected from clearing, not just the locked one: the
           * collector may not delete a different vein to make room for a pickup.
           */
          protectedCell: (name) => matchesOre(name),
          digCell: async (cell) => {
            const ok = await digAt(cell);
            return ok ? { ok: true } : { ok: false, reason: `could not clear ${posKey(cell)}`, failure: 'refused' };
          },
          takePossible: () => false,
          takeTarget: async () => ({ ok: false, reason: 'no target during a pickup climb' }),
          pickScaffold: (s) => scaffoldBlock(s),
          equip: async (item) => {
            await body.equip(item).catch(() => false);
          },
          pillarHop: async (timeoutMs) => {
            const hop = await body.pillar(1, { timeoutMs }).catch((err) => ({ ok: false, reason: err.message, steps: 0 }));
            return { ok: !!(hop && hop.ok), steps: Number(hop && hop.steps) || 0, reason: (hop && hop.reason) || null };
          }
        }
      });
      stats.pillarCleared += res.clearedCells ? res.clearedCells.length : 0;
      stats.pillarPlaced += res.placedCells ? res.placedCells.length : 0;
      stats.pillarRises += res.risen || 0;
      return { ok: !!(res.ok || res.risen > 0), risen: res.risen || 0, reason: res.reason || null };
    };

    /**
     * The goal a recovery session works on: the mined-but-unpaid record first, then the
     * last verified one, else a provisional record created *before* any dig (its baseline
     * must predate the target dig or evidence attribution breaks - plan §3.1).
     */
    let provisionalGoal = null;
    const activeRecoveryGoal = () => {
      const pending = goals.find((g) => g.mined.confirmed && g.status === 'pending');
      if (pending) return pending;
      const verified = [...goals].reverse().find((g) => g.status === 'verified');
      if (verified) return verified;
      return provisionalGoal;
    };
    const ensureProvisionalGoal = (snapshot) => {
      if (provisionalGoal) return provisionalGoal;
      if (!currentOre) return null;
      const resolved = resolveMiningProducts(currentOre.name, { item: pickaxe }, { modKnowledge: ctx.modKnowledge });
      if (!resolved.ok) return null;
      provisionalGoal = prepareAcquisition({
        taskId: ctx.taskId || null,
        target: { blockId: currentOre.name, position: currentOre.position },
        tool: { item: pickaxe },
        products: resolved.products,
        snapshot
      });
      sealBaseline(provisionalGoal, snapshot);
      goals.push(provisionalGoal);
      return provisionalGoal;
    };

    /** Raw scan only: a cell outside the scan is unknown, never "air". */
    const recoveryIoRead = (snapshot, cell) => {
      const cells = snapshot && snapshot.blocks && snapshot.blocks.cells;
      const name = cells && cells[`${cell.x},${cell.y},${cell.z}`];
      return name ? bare(name) : 'unknown';
    };

    /**
     * Hand over to the LLM recovery session when the monitor names a trigger.
     *
     * @returns {Promise<object|null>} the session summary, or a {outcome:'disabled'|
     *   'unavailable'} marker when the model must not be called.
     */
    const runRecoveryIfTriggered = async (trigger) => {
      if (!trigger) return null;
      stats.recoveryTrigger = trigger;
      if (!recoveryCfg.enabled) {
        if (ctx.log && ctx.log.warn) {
          ctx.log.warn(
            `recovery trigger ${trigger.trigger}: ${trigger.reason} - miningRecovery.enabled=false, not calling the model`
          );
        }
        return { outcome: 'disabled', reason: trigger.reason, trigger: trigger.trigger };
      }
      if (typeof ctx.recoveryRunner !== 'function') {
        if (ctx.log && ctx.log.warn) ctx.log.warn(`recovery trigger ${trigger.trigger} but no recovery runner is wired`);
        return { outcome: 'unavailable', reason: 'no recovery runner wired', trigger: trigger.trigger };
      }
      const snapshot = await refresh(ctx);
      const goal = activeRecoveryGoal() || ensureProvisionalGoal(snapshot);
      if (!goal) return { outcome: 'unavailable', reason: 'no goal record to recover', trigger: trigger.trigger };
      const summary = await ctx.recoveryRunner({
        goal,
        io: recoveryIo(),
        monitor: progress,
        trigger: trigger.trigger,
        triggerReason: trigger.reason,
        signal: taskSignal,
        cfg: recoveryCfg
      });
      stats.recoveryRuns += 1;
      stats.recovery.push({
        outcome: summary && summary.outcome,
        reason: summary && summary.reason,
        trigger: (summary && summary.trigger) || trigger.trigger,
        calls: summary && summary.calls,
        tokens: summary && summary.tokens
      });
      return summary || { outcome: 'failed', reason: 'the recovery runner returned nothing' };
    };

    /** Stop the task with the recovery session's partial result (plan §5.3.1). */
    const stopByRecovery = async (recovery, stoppedCode = 'recovery') => {
      const stop = await refresh(ctx);
      const leftover = goals.filter((g) => g.status !== 'verified' && g.status !== 'lost' && g.status !== 'blocked');
      return {
        ok: false,
        stopped: stoppedCode,
        failure: recovery.failure || 'recovery_failed',
        reason: recovery.reason || 'the recovery session did not finish',
        mined: stats.ores,
        blocks: stats.blocks,
        torches: stats.torches,
        ate: stats.ate,
        collected: stats.collected,
        minedAt: stats.minedAt,
        position: stop ? stop.position : null,
        recovery: stats.recovery,
        acquisition: goals.map(describeAcquisition),
        pending: leftover.map((g) => ({
          goalId: g.goalId,
          block: g.target.blockId,
          position: { ...g.target.position },
          collected: g.collectedItems,
          pendingDrops: g.pendingDrops.length,
          reason: g.reason || g.failure || null
        })),
        detail: `stopped by recovery (${recovery.outcome}): ${recovery.reason || ''}`
      };
    };

    /** IO the recovery session drives: the same primitives, the same admission. */
    const recoveryIo = () => ({
      refresh: async () => {
        const s = await refresh(ctx);
        return s && s.ready !== false ? s : null;
      },
      feetOf,
      read: (s, cell) => bare(cellAt(s, cell)),
      /** Raw scan only: a cell outside the scan is unknown, never "air". */
      rawRead: (s, cell) => {
        const cells = s && s.blocks && s.blocks.cells;
        const name = cells && cells[`${cell.x},${cell.y},${cell.z}`];
        return name ? bare(name) : 'unknown';
      },
      passable: (name) => AIR.test(name),
      protectedName: (name) => matchesOre(name),
      digCell: async (cell) => {
        const ok = await digAt(cell);
        return ok ? { ok: true } : { ok: false, reason: `could not clear ${posKey(cell)}`, failure: 'refused' };
      },
      takeTarget: async () => (currentOre ? takeOre(currentOre) : { ok: false, failure: 'internal', reason: 'no current ore' }),
      pillarOne: async (options) => {
        const hop = await body
          .pillar(1, { timeoutMs: (options && options.timeoutMs) || 8000 })
          .catch((err) => ({ ok: false, steps: 0, reason: err.message }));
        return {
          ok: !!(hop && hop.ok),
          steps: Number(hop && hop.steps) || 0,
          reason: hop && hop.reason ? `${hop.reason}${hop.detail ? ` (${hop.detail})` : ''}` : null
        };
      },
      moveLocal: async (stand, options) => {
        const ok = await body
          .moveTo(stand, { range: 1.0, timeoutMs: (options && options.timeoutMs) || 8000, raw: true })
          .catch(() => false);
        return { ok: !!ok };
      },
      placeBlock: async (item, reference, face) => {
        const ok = await body.place(item, reference, face).catch(() => false);
        return { ok: !!ok };
      },
      pickScaffold: (s) => scaffoldBlock(s),
      canAccept: (s) => (s && Number.isFinite(s.emptySlots) ? s.emptySlots > 0 : true),
      acquisitionState: () => {
        const g = activeRecoveryGoal();
        return {
          mined: !!(g && g.mined.confirmed),
          verified: !!(g && g.status === 'verified'),
          collectedItems: (g && g.collectedItems) || 0,
          pendingDrops: (g && g.pendingDrops.length) || 0,
          pendingDropsList: (g && g.pendingDrops) || []
        };
      },
      collectOnce: async () => {
        const g = activeRecoveryGoal();
        if (!g) return { outcome: 'unknown', failure: 'internal', reason: 'no goal record to collect for' };
        const r = await attemptCollection({
          goal: g,
          mode: 'recovery',
          deadline,
          signal: taskSignal,
          allowTerrainEdits: false,
          io: collectionIo(),
          limits: { maxLocalStands: 1, maxLocalPillarSteps: 0, dropSpawnWaitMs: 500, pickupConfirmMs: 1200 }
        });
        lastCollection = r;
        stats.collected += r.collectedDelta;
        if (r.outcome === 'verified') stats.verifiedGoals += 1;
        return r;
      },
      inspectSlice: async (slice) => {
        const snapshot = await refresh(ctx);
        if (!snapshot) return [];
        const out = [];
        const radius = Math.min(4, Math.max(1, Number(slice.radiusXZ) || 2));
        for (let x = slice.center.x - radius; x <= slice.center.x + radius; x += 1) {
          for (let z = slice.center.z - radius; z <= slice.center.z + radius; z += 1) {
            for (let y = slice.yMin; y <= slice.yMax; y += 1) {
              const cell = { x, y, z };
              out.push({ ...cell, name: recoveryIoRead(snapshot, cell) });
            }
          }
        }
        return out;
      },
      relevantCells: async ({ inspected }) => {
        const snapshot = await refresh(ctx);
        if (!snapshot) return [];
        const feet = feetOf(snapshot);
        const cells = [];
        const seen = new Set();
        const push = (cell) => {
          const key = posKey(cell);
          if (seen.has(key)) return;
          seen.add(key);
          cells.push({ ...cell, name: recoveryIoRead(snapshot, cell) });
        };
        if (currentOre) push(currentOre.position);
        if (feet) for (let dy = 1; dy <= 4; dy += 1) push({ x: feet.x, y: feet.y + dy, z: feet.z });
        const g = activeRecoveryGoal();
        if (g) for (const drop of g.pendingDrops) {
          push({ x: Math.floor(drop.position.x), y: Math.floor(drop.position.y), z: Math.floor(drop.position.z) });
        }
        if (inspected && feet) {
          for (const [key, name] of inspected) {
            const [x, y, z] = key.split(',').map(Number);
            if (Math.hypot(x - feet.x, z - feet.z) <= 8) {
              cells.push({ x, y, z, name: name || 'unknown' });
            }
          }
        }
        return cells.slice(0, 80);
      },
      stable: async () => {
        const s = await refresh(ctx);
        return !!(s && s.onGround !== false);
      },
      /** The ladder result is awaited before a hand-over, so the body is quiet. */
      quiesced: async () => true
    });

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
        ? ctx.world.findBlocksMatching((name) => matchesOre(name), {
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
      if (cancelled()) {
        const stop = await refresh(ctx);
        return {
          ok: false,
          interrupted: true,
          failure: 'interrupted',
          reason: taskSignal.reason || 'task cancelled',
          mined: stats.ores,
          blocks: stats.blocks,
          collected: stats.collected,
          minedAt: stats.minedAt,
          position: stop ? stop.position : null,
          detail: `cancelled after ${stats.ores} ore(s)`
        };
      }
      if (Date.now() > deadline) {
        stats.outOfTime = true;
        break;
      }
      // Optional cap from the `count` alias/parameter: the LLM's "挖 32 颗钻石" is a budget,
      // not a promise to burn the whole time budget once that many are in the bag.
      if (params.count && stats.ores >= params.count) {
        stats.countReached = true;
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
      currentOre = ore;

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
      /**
       * @param {object} [target] the block to take; defaults to the locked ore. The tunnel
       * controller can hand back a *different* protected ore it stopped in front of (C21) -
       * that block goes through exactly the same count/collect flow.
       */
      const takeOre = async (target = ore) => {
        const snapNow = await refresh(ctx);
        const here = feetOf(snapNow);
        const dist = here
          ? Math.hypot(target.position.x - here.x, target.position.y - here.y, target.position.z - here.z)
          : 99;
        if (dist > 4.0) return { ok: false, reason: 'the ore is out of reach', failure: 'out_of_reach' };
        /**
         * A stale scan can list an ore another actor already took. `digAt` answers true for
         * air (nothing to dig), which is right for a tunnel cell but must never count as a
         * mined ore - numen kicks this back as TARGET_LOST. This was a real offline loop:
         * without it the skill "mined" one ore a million times.
         */
        if (AIR.test(bare(cellAt(snapNow, target.position)))) {
          return { ok: false, reason: 'the ore is already gone (stale scan)', failure: 'target_lost' };
        }
        /**
         * C1: resolve the real product and create the acquisition record *before* the dig,
         * with the inventory/entity baseline sealed now. Without this step, a diamond that
         * auto-banks before any entity shows up can never be verified - the live complaint
         * behind "挖到了但不知道收没收到".
         */
        const toolName = (() => {
          const plan = minePlan(snapNow, target.name);
          return plan && plan.tool ? plan.tool.name : pickaxe;
        })();
        const resolved = resolveMiningProducts(target.name, { item: toolName }, { modKnowledge: ctx.modKnowledge });
        if (!resolved.ok) {
          return { ok: false, reason: `${resolved.reason} (refusing to mine without a verified product)`, failure: 'product_unknown' };
        }
        const goal = prepareAcquisition({
          taskId: ctx.taskId || null,
          target: { blockId: target.name, position: target.position },
          tool: { item: toolName },
          products: resolved.products,
          snapshot: snapNow
        });
        sealBaseline(goal, snapNow);
        /**
         * The ore itself goes through the same dig admission as every tunnel cell, so the
         * ledger sees it, the falling-sand/water checks apply, and the tool is chosen in one
         * place instead of three.
         */
        if (await digAt(target.position)) {
          const after = await refresh(ctx);
          if (!AIR.test(bare(cellAt(after, target.position)))) {
            recordMineResult(goal, {
              receipt: { ok: false, failure: 'internal', reason: 'the dig reported success but the ore is still there' },
              before: snapNow,
              after
            });
            return { ok: false, reason: 'the dig reported success but the ore is still there', failure: 'internal' };
          }
          stats.ores += 1;
          stats.minedAt.push({ name: bare(target.name), position: { ...target.position } });
          if (ctx.log && ctx.log.info) {
            ctx.log.info(`mined ${bare(target.name)} at ${posKey(target.position)}`);
          }
          recordMineResult(goal, { receipt: { ok: true, dug: true }, before: snapNow, after });
          goals.push(goal);
          await recordProgress({ phase: 'mine', action: 'dig', ok: true, progress: true, failure: null, reason: null });
          /**
           * Do not walk away from the vein before trying to take its products with us (the
           * first live run left iron on the floor). The shared collector is bounded here;
           * whatever stays pending is retried by the drain phase or reported as partial -
           * never silently treated as collected.
           */
          const collection = await attemptCollection({
            goal,
            mode: 'macro',
            deadline,
            signal: taskSignal,
            allowTerrainEdits: true,
            io: collectionIo()
          });
          stats.collected += collection.collectedDelta;
          await recordProgress({
            phase: 'collect',
            action: 'collect',
            ok: collection.outcome === 'verified',
            progress: collection.outcome === 'verified',
            failure: collection.failure || null,
            reason: collection.reason || null
          });
          if (collection.outcome === 'verified') {
            stats.verifiedGoals += 1;
            return { ok: true, dug: true, acquisition: describeAcquisition(goal), collection };
          }
          if (collection.outcome === 'interrupted') {
            return {
              ok: false,
              reason: collection.reason || 'task cancelled during collection',
              failure: 'interrupted',
              interrupted: true
            };
          }
          // Keep the uncollected reason on the record so the panel/pending list can say why.
          goal.reason = collection.reason || 'the product is not confirmed in the inventory yet';
          return {
            ok: true,
            dug: true,
            collected: false,
            acquisition: describeAcquisition(goal),
            collection,
            reason: collection.reason || 'the product is not confirmed in the inventory yet'
          };
        }
        recordMineResult(goal, { receipt: { ok: false, failure: 'refused', reason: 'the ore dig was refused' }, before: snapNow, after: snapNow });
        await recordProgress({ phase: 'mine', action: 'dig', ok: false, progress: false, failure: 'refused', reason: 'the ore dig was refused' });
        return { ok: false, reason: 'the ore dig was refused', failure: 'refused' };
      };

      const attempt = async (waypoint) => {
        const direct = waypoint.x === ore.position.x && waypoint.y === ore.position.y && waypoint.z === ore.position.z;
        if (direct) {
          const already = await takeOre();
          if (already.ok) return already;
        }
        let outcome = { ok: false, reason: 'gave up' };
      /**
       * Oscillation guard (live 2026-10-10): in the tight shaft the stair walked A -> B -> A
       * more than twenty times before the pillar rung got its turn. Within one attempt a cell
       * visited three times with no arrival is a cycle, not progress; bail out immediately so
       * the next rung (pillar-up) takes over.
       */
      const visits = new Map();
        for (let step = 0; step < MAX_STEPS_PER_ORE; step += 1) {
        if (cancelled()) {
          return { ok: false, reason: taskSignal.reason || 'task cancelled', failure: 'interrupted', interrupted: true };
        }
          if (Date.now() > deadline) {
            stats.outOfTime = true;
            return { ok: false, reason: 'out of time', failure: 'timeout', outOfTime: true };
          }
          outcome = await stepToward({ position: waypoint });
          if (outcome.reached) break;
          if (!outcome.ok) {
            await recordProgress({
              phase: 'approach',
              action: 'step',
              ok: false,
              progress: false,
              failure: outcome.failure || null,
              reason: outcome.reason || null,
              arrived: !!outcome.reached,
              moved: 0
            });
            break;
          }
          // Sweep the stone drops the tunnel leaves behind every few steps, so the floor does
          // not silt up with items we then have to walk back for.
          if (step % 4 === 3) await collectDrops(3);
          const afterStep = await refresh(ctx);
          const feetAfter = feetOf(afterStep);
          if (feetAfter) {
            const key = posKey(feetAfter);
            const seen = (visits.get(key) || 0) + 1;
            visits.set(key, seen);
            if (seen >= 3) {
              await recordProgress({
                phase: 'approach',
                action: 'step',
                ok: false,
                progress: false,
                failure: 'no_path',
                reason: `oscillating around ${key} without progress`,
                arrived: false,
                moved: 0
              });
              return { ok: false, reason: `oscillating around ${key} without progress`, failure: 'no_path', oscillating: true };
            }
          }
          if (feetAfter && openness(afterStep, feetAfter) >= 0.45) {
            stats.cavern = true;
            if (ctx.log && ctx.log.warn) {
              ctx.log.warn(`large cavern ahead at ${feetAfter.x},${feetAfter.y},${feetAfter.z} - stopping`);
            }
            return { ok: false, reason: 'large cavern ahead', failure: 'hazard', cavern: true };
          }
        }
        if (outcome.danger) {
          lastDanger = { reason: outcome.reason, hostile: !!outcome.hostile };
          return { ok: false, reason: outcome.reason, failure: 'hazard', danger: true, hostile: outcome.hostile };
        }
        if (!outcome.reached) {
          await recordProgress({
            phase: 'approach',
            action: 'step',
            ok: false,
            progress: false,
            failure: 'no_path',
            reason: outcome.reason || 'did not reach the waypoint',
            arrived: !!outcome.reached,
            moved: 0
          });
          return { ok: false, reason: outcome.reason || 'did not reach the waypoint', failure: 'no_path' };
        }
        await recordProgress({
          phase: 'approach',
          action: 'step',
          ok: true,
          progress: true,
          failure: null,
          reason: null,
          arrived: true,
          moved: 1
        });
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
      /**
       * The last danger refusal (drop below / lava / hostile) seen by the tunnel pre-check or
       * the direct stair. The pillar rung reads it: a drop below an ascending waypoint is the
       * shaft-climb case the pillar exists for, while lava and monsters still stop the task.
       */
      let lastDanger = null;
      const runTunnel = async (steps) => {
        if (!steps.length) return { ok: false, reason: 'no quoted steps for this ore', failure: 'no_path' };
        const pre = await refresh(ctx);
        if (pre) {
          const feetNow = feetOf(pre);
          for (const step of steps) {
            const danger = dangerAt(pre, step.waypoint);
            if (!danger) continue;
            /**
             * A drop *below* an ascending waypoint is not a fall risk: the route climbs up to
             * that cell, and the shaft case is the pillar rung's business. Refusing here used
             * to stop the whole task just above a hole (live 2026-10-10), while genuine
             * descents and lava keep the refusal below.
             */
            if (feetNow && /drop below/i.test(String(danger.reason)) && step.waypoint.y > feetNow.y) {
              continue;
            }
            const where = posKey(step.waypoint);
            if (ctx.log && ctx.log.warn) {
              ctx.log.warn(`unsafe tunnel waypoint ${where}: ${danger.reason} - stopping`);
            }
            lastDanger = { reason: danger.reason, hostile: !!danger.hostile };
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
        /**
         * The client digs with the held item for the entire continuous run; make sure that
         * is the tool this skill chose, not the last eaten food / torch.
         */
        await body.equip(pickaxe).catch(() => false);
        const result = await body
          .tunnel(
            steps.map((s) => s.waypoint),
            {
              timeoutMs: Math.min(240000, 20000 * steps.length),
              /**
               * C21: every task ore is protected from the corridor dig. The controller
               * stops before the block and names it; Node then runs the real take flow.
               */
              protect: { blocks: oreNames }
            }
          )
          .catch((err) => ({ ok: false, reason: `tunnel threw: ${err.message}`, cell: null, block: null, dugCells: [] }));
        if (!result.ok && /target_requires_acquisition/i.test(String(result.reason || '')) && result.cell && result.block) {
          if (matchesOre(result.block)) {
            if (ctx.log && ctx.log.info) {
              ctx.log.info(
                `tunnel stopped before a protected ore ${bare(result.block)} at ${posKey(result.cell)} - taking it properly`
              );
            }
            return takeOre({ name: bare(result.block), position: { ...result.cell } });
          }
          return {
            ok: false,
            reason: `the tunnel is blocked by protected ${result.block} at ${posKey(result.cell)}`,
            failure: 'target_requires_acquisition',
            cell: result.cell,
            block: result.block
          };
        }
        if (!result.ok) {
          lastTunnelCell = result.cell ? { ...result.cell } : null;
          lastTunnelBlock = result.block || null;
          await recordProgress({
            phase: 'approach',
            action: 'tunnel',
            ok: false,
            progress: false,
            failure: classifyTunnelFailure(result.reason),
            reason: result.reason || 'the tunnel walk failed'
          });
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
      rungs.push({
        name: 'direct',
        handles: ['no_path', 'out_of_reach', 'occluded', 'unknown', 'target_lost', 'refused'],
        maxAttempts: 1,
        run: () => attempt(ore.position)
      });
      /**
       * Climb out of a shaft the stair cannot.
       *
       * A 1-wide shaft has no horizontal room for the sloped stair, and the client walker
       * cannot jump onto a block it is already pressed against: the live run oscillated at
       * (5,-59,171) -> (6,-58,171) until the ore was abandoned (2026-10-10). Every player
       * answer is "jump and place a block under yourself", so when the ore sits above the
       * bot, pillar up to its level with a scaffold block and retry the approach.
       */
      if (typeof body.pillar === 'function') {
        const before = feetOf(await refresh(ctx));
        const sameColAtStart = before && before.x === ore.position.x && before.z === ore.position.z;
        const riseAtStart = before ? ore.position.y - before.y : 0;
        /**
         * Two blocks above is already a shaft problem unless we are straight under the ore
         * (then the take itself can reach it, and pillaring into the ore's own head cell
         * would suffocate - so that case keeps the stricter threshold).
         */
        if (before && (riseAtStart >= 3 || (riseAtStart >= 2 && !sameColAtStart))) {
          rungs.push({
            name: 'pillar-up',
            handles: ['no_path', 'out_of_reach', 'occluded', 'unknown', 'refused', 'hazard'],
            maxAttempts: 1,
            run: async () => {
              /**
               * Only a drop below an ascending waypoint is the pillar's business: that is
               * the walled-shaft case. Lava and monsters keep their stop-the-task semantics.
               */
              if (lastDanger && !/drop below/i.test(String(lastDanger.reason))) {
                return {
                  ok: false,
                  reason: lastDanger.reason,
                  failure: 'hazard',
                  danger: true,
                  hostile: !!lastDanger.hostile
                };
              }
              const firstSnap = await refresh(ctx);
              const here = feetOf(firstSnap);
              if (!here) {
                return { ok: false, reason: 'no position for the pillar climb', failure: 'internal' };
              }
              if (!scaffoldBlock(firstSnap)) {
                return { ok: false, reason: 'no scaffold block to pillar with', failure: 'no_material' };
              }
              /**
               * Fixed climb endpoint (plan §5.4.2 rule 1): straight under the ore stop two
               * short (its own cell would become the head cell), from a neighbouring column
               * one short - the ore stays visible. Recomputing this from the live feet each
               * round would turn a partial rise into a fresh oversized request.
               */
              const sameColumn = here.x === ore.position.x && here.z === ore.position.z;
              const goalFeetY = Math.max(here.y + 1, ore.position.y - (sameColumn ? 2 : 1));
              if (ctx.log && ctx.log.info) {
                ctx.log.info(`pillar-up: climbing from y=${here.y} toward y=${goalFeetY} (${posKey(ore.position)})`);
              }
              const result = await pillarUpRounds({
                deadline,
                signal: ctx.taskSignal,
                goalFeetY,
                log: ctx.log,
                io: {
                  refresh: async () => {
                    const s = await refresh(ctx);
                    return s && s.ready !== false ? s : null;
                  },
                  feetOf,
                  scanCell: (s, cell) => bare(cellAt(s, cell)),
                  isAir: (name) => AIR.test(name),
                  sameColumn: (s, start) => {
                    const f = feetOf(s);
                    return !!f && f.x === start.x && f.z === start.z;
                  },
                  dangerAt: (s, cell) => {
                    const d = dangerAt(s, cell);
                    return d ? { reason: d.reason, hostile: !!d.hostile } : null;
                  },
                  isTargetCell: (cell) =>
                    cell.x === ore.position.x && cell.y === ore.position.y && cell.z === ore.position.z,
                  protectedCell: (name) => matchesOre(name),
                  digCell: async (cell) => {
                    const ok = await digAt(cell);
                    return ok
                      ? { ok: true }
                      : { ok: false, reason: `could not clear the headroom cell ${posKey(cell)}`, failure: 'refused' };
                  },
                  takePossible: (_s, feet) =>
                    Math.hypot(ore.position.x - feet.x, ore.position.y - feet.y, ore.position.z - feet.z) <= 4.0,
                  takeTarget: async () => takeOre(),
                  pickScaffold: (s) => scaffoldBlock(s),
                  equip: async (item) => {
                    await body.equip(item).catch(() => false);
                  },
                  pillarHop: async (timeoutMs) => {
                    const res = await body
                      .pillar(1, { timeoutMs })
                      .catch((err) => ({ ok: false, reason: err.message, steps: 0 }));
                    return {
                      ok: !!(res && res.ok),
                      steps: Number(res && res.steps) || 0,
                      reason: res && res.reason
                        ? `${res.reason}${res.detail ? ` (${res.detail})` : ''}`
                        : null,
                      cell: (res && res.cell) || null
                    };
                  }
                }
              });
              stats.pillarCleared += result.clearedCells ? result.clearedCells.length : 0;
              stats.pillarPlaced += result.placedCells ? result.placedCells.length : 0;
              stats.pillarRises += result.risen || 0;
              await recordProgress({
                phase: 'raise',
                action: 'pillar',
                ok: !!result.ok,
                progress: (result.risen || 0) > 0,
                failure: result.failure || null,
                reason: result.reason || null
              });
              if (ctx.log && ctx.log.info) {
                ctx.log.info(
                  `pillar-up: risen ${result.risen}, cleared ${stats.pillarCleared}, placed ${stats.pillarPlaced}` +
                    (result.reason ? ` - ${result.reason}` : '')
                );
              }
              if (result.ok && result.minedTarget) return { ok: true, dug: true };
              if (result.ok) return attempt(ore.position);
              if (result.failure === 'target_lost') {
                return { ok: false, reason: result.reason, failure: 'target_lost', targetLost: true };
              }
              if (result.failure === 'interrupted') {
                return { ok: false, reason: result.reason, failure: 'interrupted', interrupted: true };
              }
              if (result.failure === 'hazard') {
                return { ok: false, reason: result.reason, failure: 'hazard', danger: true, hostile: !!result.hostile };
              }
              /**
               * A partial rise is kept, never thrown away: the ore may already be in reach,
               * so try the take once before reporting the climb's failure upward.
               */
              if (result.risen > 0) return attempt(ore.position);
              /**
               * Preserve the executor's own failure class. A refused dig / occluded
               * headroom must NOT be relabelled as `no_path`, or the ladder hands it to
               * the flank rung and a permission refusal gets "recovered" by more digging
               * (plan §5.4.3: 危险、拒绝、取消与预算耗尽不可被普通换路吞掉).
               */
              const failure = ['no_material', 'timeout', 'refused', 'occluded', 'no_path', 'internal'].includes(result.failure)
                ? result.failure
                : 'no_path';
              return {
                ok: false,
                reason: `pillar up failed: ${result.reason}`,
                failure,
                cell: result.cell || null,
                block: result.block || null
              };
            }
          });
        }
      }
      rungs.push({
        name: 'flank',
        handles: ['no_path', 'out_of_reach', 'occluded'],
        maxAttempts: 1,
        run: async () => {
          const waypoint = await flankWaypoint();
          if (!waypoint) return { ok: false, reason: 'no flank waypoint', failure: 'no_path' };
          return attempt(waypoint);
        }
      });
      const ladder = new RecoveryLadder('mine_ore', rungs);
      const outcome = await ladder.run();

      if (stats.outOfTime || outcome.outOfTime) break;
      if (stats.planExceeded) break;
      /**
       * A cancellation is not "this ore failed, try the next one": no further side effects
       * may follow, and the ladder must not fall through to flank/direct work (plan §5.4.3).
       */
      if (outcome.interrupted || outcome.failure === 'interrupted') {
        const stop = await refresh(ctx);
        return {
          ok: false,
          interrupted: true,
          failure: 'interrupted',
          reason: outcome.reason || (taskSignal && taskSignal.reason) || 'task cancelled',
          mined: stats.ores,
          blocks: stats.blocks,
          collected: stats.collected,
          minedAt: stats.minedAt,
          position: stop ? stop.position : null,
          pillar: { rises: stats.pillarRises, placed: stats.pillarPlaced, cleared: stats.pillarCleared },
          detail: `cancelled after ${stats.ores} ore(s)`
        };
      }
      /**
       * C15: a mined-but-unpaid goal blocks the next ore. The product may be lying on a
       * ledge; digging the second ore first is how the first diamond got lost. Resolve the
       * pickup inside this task's budget, or stop with an honest partial.
       */
      const unpaid = goals.find((g) => g.mined.confirmed && g.status === 'pending');
      if (unpaid && outcome.ok && outcome.dug) {
        if (Date.now() > deadline) {
          stats.outOfTime = true;
          stats.partial = true;
          break;
        }
        const retry = await attemptCollection({
          goal: unpaid,
          mode: 'macro',
          deadline,
          signal: taskSignal,
          allowTerrainEdits: true,
          io: collectionIo()
        });
        stats.collected += retry.collectedDelta;
        await recordProgress({
          phase: 'collect',
          action: 'collect',
          ok: retry.outcome === 'verified',
          progress: retry.outcome === 'verified',
          failure: retry.failure || null,
          reason: retry.reason || null
        });
        if (retry.outcome === 'verified') {
          stats.verifiedGoals += 1;
        } else {
          /**
           * L03/L11: exactly the situation the LLM recovery exists for - the product is
           * real but the local stands could not bank it. Hand over once; if the session
           * fails, stop with the unpaid record preserved.
           */
          const trigger =
            progress.evaluate({ pickupStalled: true }) ||
            { trigger: 'pickup_stalled', reason: retry.reason || 'pickup not confirmed' };
          const recovery = await runRecoveryIfTriggered(trigger);
          if (recovery && recovery.outcome === 'recovered') {
            // Back to the macro with the goal verified; the loop continues on its own.
          } else if (recovery && recovery.outcome === 'cancelled') {
            return { ok: false, interrupted: true, failure: 'interrupted', reason: recovery.reason || 'cancelled', mined: stats.ores, collected: stats.collected, minedAt: stats.minedAt };
          } else if (recovery && (recovery.outcome === 'failed' || recovery.outcome === 'blocked')) {
            return stopByRecovery(recovery, 'recovery');
          } else {
            unpaid.reason = retry.reason || unpaid.reason;
            stats.partial = true;
            if (ctx.log && ctx.log.warn) {
              ctx.log.warn(
                `stopping: ${unpaid.target.blockId} was mined at ${posKey(unpaid.target.position)} ` +
                  `but its product is not in the bag (${retry.reason || retry.outcome})`
              );
            }
            break;
          }
        }
      }
      /**
       * Ore-level anomaly: the ladder could not reach/mine this target. Only structural
       * failures go to the model - lava/monster results keep their stop-the-task meaning
       * (plan §5.2.3 / R08).
       */
      if (!(outcome.ok && outcome.dug) && !outcome.danger) {
        const trigger = progress.evaluate({ ladderExhausted: true });
        if (trigger) {
          const recovery = await runRecoveryIfTriggered(trigger);
          if (recovery && recovery.outcome === 'recovered') continue;
          if (recovery && recovery.outcome === 'cancelled') {
            return { ok: false, interrupted: true, failure: 'interrupted', reason: recovery.reason || 'cancelled', mined: stats.ores, collected: stats.collected, minedAt: stats.minedAt };
          }
          if (recovery && (recovery.outcome === 'failed' || recovery.outcome === 'blocked')) {
            return stopByRecovery(recovery, 'recovery');
          }
        }
      }
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

    /**
     * Drain phase (C2): the count bounds mined blocks, not collected items. Finish the
     * pickup queue for mined-but-unpaid goals inside the remaining budget, or report
     * partial - "数量达到、部分未收取" must never read as a full success.
     */
    const drainGoals = goals.filter((g) => g.status === 'pending' || (g.status === 'prepared' && g.mined.confirmed));
    for (const goal of drainGoals) {
      if (cancelled()) break;
      if (Date.now() > deadline) {
        stats.outOfTime = true;
        break;
      }
      const collection = await attemptCollection({
        goal,
        mode: 'macro',
        deadline,
        signal: taskSignal,
        allowTerrainEdits: true,
        io: collectionIo()
      });
      stats.collected += collection.collectedDelta;
      await recordProgress({
        phase: 'collect',
        action: 'collect',
        ok: collection.outcome === 'verified',
        progress: collection.outcome === 'verified',
        failure: collection.failure || null,
        reason: collection.reason || null
      });
      if (collection.outcome === 'verified') stats.verifiedGoals += 1;
      else if (collection.outcome === 'interrupted') break;
      else {
        goal.reason = collection.reason || goal.reason;
        stats.partial = true;
      }
    }
    /**
     * Incidental sweep before reporting: corridor stone. It may also pick up a product the
     * collector could not reach - and the entity-vanish counter alone must not decide the
     * goal (live 2026-10-10: the diamond was in the bag while the goal still said pending),
     * so every unverified goal is re-observed against its sealed baseline afterwards.
     */
    await collectDrops(12);
    const reconcileSnap = await refresh(ctx);
    for (const goal of reconcilePendingGoals(goals, reconcileSnap)) {
      stats.verifiedGoals += 1;
      if (ctx.log && ctx.log.info) {
        ctx.log.info(`acquisition reconciled after the sweep: ${describeAcquisition(goal)}`);
      }
    }
    const end = await refresh(ctx);
    const pendingAfter = goals.filter((g) => g.status !== 'verified' && g.status !== 'lost' && g.status !== 'blocked');
    const partial = stats.partial || pendingAfter.length > 0;
    const ledgerSummary = {
      planned: stats.ledger.planned,
      dug: stats.ledger.dug,
      extra: stats.ledger.extra,
      extraCells: stats.ledger.extraCells
    };
    return {
      /**
       * Zero ore OR an uncollected product is not success. Live M1 2026-10-17: `!mine
       * diamond_ore` with no target returned `task:done` ("mined 0 ..."), exactly the false
       * completion A06 forbids. Live A13-c1 2026-10-18: the ore was mined but its product
       * was not in the bag; `stats.ores > 0` alone still reported done. A goal is complete
       * only when nothing is pending and the run is not partial.
       */
      ok: !stats.planExceeded && stats.ores > 0 && !partial,
      stopped: stats.planExceeded ? 'plan-exceeded' : stats.countReached ? 'count' : null,
      mined: stats.ores,
      blocks: stats.blocks,
      torches: stats.torches,
      ate: stats.ate,
      collected: stats.collected,
      skipped: stats.skipped,
      partial,
      acquisition: goals.map(describeAcquisition),
      recoveryRuns: stats.recoveryRuns,
      recovery: stats.recovery,
      pending: pendingAfter.map((g) => ({
        goalId: g.goalId,
        block: g.target.blockId,
        position: { ...g.target.position },
        collected: g.collectedItems,
        pendingDrops: g.pendingDrops.length,
        reason: g.reason || g.failure || null
      })),
      refusedCells: stats.refusedCells,
      rejectedTargets: stats.rejectedTargets,
      tunnel: { runs: stats.tunnelRuns, cells: stats.tunnelCells },
      pillar: { rises: stats.pillarRises, placed: stats.pillarPlaced, cleared: stats.pillarCleared },
      outOfTime: stats.outOfTime,
      minedAt: stats.minedAt,
      plan: stats.plan,
      ledger: ledgerSummary,
      position: end ? end.position : null,
      detail:
        `mined ${stats.ores} ${oreLabel} (dug ${stats.blocks} blocks, ` +
        `${stats.torches} torch(es), collected ${stats.collected} drop(s), ate ${stats.ate}, ` +
        `skipped ${stats.skipped})` +
        `; ledger planned ${ledgerSummary.planned} / dug ${ledgerSummary.dug} / extra ${ledgerSummary.extra}` +
        `; acquisition ${stats.verifiedGoals}/${goals.length} verified` +
        (partial ? ` - partial: ${pendingAfter.length} goal(s) still pending pickup` : '') +
        (stats.planExceeded ? ' - plan exceeded, stopped' : stats.outOfTime ? ' - time budget reached' : '')
    };
  }
});
