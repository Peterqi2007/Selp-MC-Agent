'use strict';

/**
 * PathPlanner: A* over the mod's block map, with the failure classification that makes
 * the result *actionable*.
 *
 * Reuses `mineflayer-pathfinder`'s solver (heap, path reconstruction, node bookkeeping)
 * and supplies our own world and movement model - see movementsAdapter.js for why that
 * split is safe.
 *
 * The hard constraint this module exists to manage: the mod's perception grid is only
 * +/-24 blocks horizontally. A target further away cannot be planned in one shot, so the
 * planner reports `out-of-grid` and the *caller* (PathNavigator) picks a **subgoal** inside
 * the grid - the dry cell on the straight line to the target that is closest to it
 * (`pickSubgoal`) - and plans to that instead. Encoding that as a distinct status, rather
 * than silently returning noPath or walking blindly, is the difference between "the bot is
 * stuck", "the bot needs two hops" and "the bot walked into the river".
 */

const AStar = require('mineflayer-pathfinder/lib/astar');
const { v3, toPathVec } = require('./vec3util');
const { ClientWorldAdapter } = require('./clientWorldAdapter');
const { MovementsAdapter } = require('./movementsAdapter');
const { ManMadeGuard } = require('../world/safety');

/** Failure/termination reasons, mirroring the table in P0-PLAN §3.5. */
const STATUS = {
  SUCCESS: 'success',
  PARTIAL: 'partial',
  NO_PATH: 'noPath',
  TIMEOUT: 'timeout',
  OUT_OF_GRID: 'out-of-grid',
  UNKNOWN_BLOCK: 'unknown-block',
  BODY_LOST: 'body-lost',
  /** The target itself is something a player built: refuse rather than walk to it. */
  UNSAFE_TARGET: 'unsafe-target'
};

/**
 * The one arrival test: is `position` inside `range` blocks of `target`?
 *
 * Cell-based and horizontal, with the ±1 vertical tolerance the movement model uses. Both
 * the planner's goal (`WeightedGoalNear.isEnd`) and the navigator's final acceptance call
 * this, because they used to disagree: the planner measured integer cells horizontally while
 * the navigator measured the float position against the target's block corner. The bot could
 * end in a spot the plan called "already within range" but the navigator refused, producing
 * 40 identical replans deadlocked just outside the radius (live 2026-10-10: 3.06 vs range 3).
 *
 * @param {number} px @param {number} py @param {number} pz position (float or cell)
 * @param {number} tx @param {number} ty @param {number} tz target block coordinates
 * @param {number} range horizontal tolerance in blocks
 * @returns {boolean}
 */
function withinGoalRange(px, py, pz, tx, ty, tz, range) {
  const dx = Math.floor(px) - Math.floor(tx);
  const dy = Math.floor(py) - Math.floor(ty);
  const dz = Math.floor(pz) - Math.floor(tz);
  return Math.abs(dy) <= 1 && Math.sqrt(dx * dx + dz * dz) <= range;
}

/**
 * A goal expressed against our movement model.
 *
 * `GoalNear` from the plugin would work for `isEnd`, but its `heuristic` uses plain
 * 3D distance while our costs are weighted (climbing costs 1.5-2.0, swimming 2.0). Weighting
 * the heuristic by the cheapest possible move keeps it admissible - an over-estimating
 * heuristic makes A* return suboptimal paths, which here means silly routes.
 */
class WeightedGoalNear {
  constructor(x, y, z, range = 1, minCostPerBlock = 1) {
    this.x = Math.floor(x);
    this.y = Math.floor(y);
    this.z = Math.floor(z);
    this.range = range;
    this.minCostPerBlock = minCostPerBlock;
  }

  heuristic(node) {
    const dx = node.x - this.x;
    const dy = node.y - this.y;
    const dz = node.z - this.z;
    // Manhattan distance is admissible under our 1.0-per-block walk cost and never
    // overestimates, which is what keeps the search optimal.
    const manhattan = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    return Math.max(0, (manhattan - this.range) * this.minCostPerBlock);
  }

  isEnd(node) {
    // Shared with the navigator's final check - see `withinGoalRange`.
    return withinGoalRange(node.x, node.y, node.z, this.x, this.y, this.z, this.range);
  }
}

class PathPlanner {
  /**
   * @param {object} body Body instance (usually ClientModBody)
   * @param {object} [options] { maxPathLength, nodeTimeoutMs, tickTimeoutMs, allowSwim, allowDig, log }
   */
  constructor(body, options = {}) {
    this.body = body;
    this.log = options.log || { debug() {}, warn() {} };
    /**
     * An injected world lets one adapter be shared between the planner and anything else
     * that needs block lookups (the navigator builds both from the same view). Constructing
     * a second one would be harmless but would double the per-lookup overhead during A*.
     */
    this.world = options.world || new ClientWorldAdapter(body, options);
    this.movements = new MovementsAdapter(this.world, options);
    /** Path trace sink (P0-PLAN §8); a no-op unless configured. */
    this.trace = options.trace || (() => {});
    /**
     * Stay off anything a player built.
     *
     * On by default: the agent runs on a public server, and "walk to that spot" must not
     * mean "walk across someone's roof". See src/world/safety.js.
     */
    this.avoidManMade = options.avoidManMade !== false;
    /**
     * The guard reads through the *adapter*, not the body: the adapter answers in absolute
     * coordinates and describes the block, which is what the policy needs. A Body's own
     * `blockAt` would work for ClientModBody but not for every body.
     */
    this.guard = this.avoidManMade ? new ManMadeGuard(this.world, { log: this.log }) : null;
    if (this.guard && typeof this.world.setGuard === 'function') {
      this.world.setGuard((position) => this.guard.veto(position));
    }
    /** Give up on a single A* call after this long. Long enough for a real search, short enough to stay interactive. */
    this.nodeTimeoutMs = options.nodeTimeoutMs || 3000;
    /** A* yields `partial` after this per-tick budget; we do not resume, so keep it high. */
    this.tickTimeoutMs = options.tickTimeoutMs || 2500;
    /** Refuse absurd routes; a 200-node path in a 24-block window means something is wrong. */
    this.maxPathLength = options.maxPathLength || 200;
    /** A* limits its own exploration radius; our grid is smaller than this anyway. */
    this.searchRadius = options.searchRadius || 64;
    this.stats = { planned: 0, success: 0, noPath: 0, outOfGrid: 0, timeout: 0, unsafe: 0 };
  }

  get ready() {
    return !!(this.body && this.body.isReady);
  }

  /**
   * Plan a route to a position, and trace the outcome.
   *
   * The trace wrapper exists because the *interesting* question after a failed walk is
   * not "did it fail" but "which of the seven statuses did A* return, and over how much
   * terrain" - see P0-PLAN §3.5.
   *
   * @param {{x:number,y:number,z:number}} target
   * @param {object} [options] { range, timeoutMs }
   * @returns {Promise<{status:string, path:Array<{x:number,y:number,z:number}>, reason:string, nodes:number}>}
   */
  async plan(target, options = {}) {
    const res = await this._plan(target, options);
    this.trace({
      kind: 'plan',
      target: { x: target.x, y: target.y, z: target.z },
      status: res.status,
      nodes: res.nodes,
      pathLen: res.path.length,
      range: options.range === undefined ? 1 : options.range,
      reason: res.reason
    });
    return res;
  }

  /** The actual search. See plan() for the traced entry point. */
  async _plan(target, options = {}) {
    this.stats.planned += 1;
    const range = options.range === undefined ? 1 : options.range;

    if (!this.ready) {
      return this.result(STATUS.BODY_LOST, [], 'body is not attached to a client');
    }

    const snap = this.body.snapshot();
    if (!snap || !snap.ready || !snap.position) {
      return this.result(STATUS.BODY_LOST, [], 'no usable snapshot from the client');
    }

    // v3() already floors to integer block coordinates, so no .floored() call is needed
    // (and would not exist - see vec3util.js for why this is a plain object, not a Vec3).
    const start = toPathVec(snap.position);
    const goalPos = v3(target.x, target.y, target.z);

    // ---- already there? ---------------------------------------------------
    if (withinGoalRange(start.x, start.y, start.z, goalPos.x, goalPos.y, goalPos.z, range)) {
      return this.result(STATUS.SUCCESS, [{ x: start.x, y: start.y, z: start.z }], 'already within range');
    }

    // ---- perception limits, checked BEFORE searching ----------------------
    // A* cannot know about terrain it has never seen, so an out-of-grid target must be
    // reported as such instead of as an unreachable one.
    if (!this.world.inGrid(goalPos)) {
      this.stats.outOfGrid += 1;
      return this.result(
        STATUS.OUT_OF_GRID,
        [],
        `target (${goalPos.x},${goalPos.y},${goalPos.z}) is outside the ${this.world.scanRadius}-block scan grid`
      );
    }

    // The start cell must be known-and-standable, or every neighbour test fails and we
    // get a misleading noPath. Check it explicitly to produce a clear reason.
    const startBlock = this.world.blockAt(start);
    if (startBlock === null) {
      return this.result(
        STATUS.UNKNOWN_BLOCK,
        [],
        `current position (${start.x},${start.y},${start.z}) is not in the scan grid (world still loading?)`
      );
    }

    /**
     * Refuse a destination that is itself built.
     *
     * The guard already keeps the *route* off built blocks, but if the goal is a plank floor
     * or a machine, then either A* fails with a confusing `noPath` or - worse - it succeeds
     * and the bot walks up to someone's chest. A distinct status keeps the reason honest and
     * lets the caller answer "that is something you built" instead of "I cannot reach it".
     */
    if (this.guard) {
      const veto = this.guard.veto(goalPos);
      if (veto) {
        this.stats.unsafe += 1;
        return this.result(STATUS.UNSAFE_TARGET, [], `refusing to walk to a ${veto} at (${goalPos.x},${goalPos.y},${goalPos.z})`);
      }
    }

    // ---- run A* -----------------------------------------------------------
    const goal = new WeightedGoalNear(goalPos.x, goalPos.y, goalPos.z, range);
    let raw;
    try {
      const solver = new AStar(
        start,
        {
          // A* calls movements.getNeighbors(node) directly (astar.js:85).
          getNeighbors: (node) => this.movements.getNeighbors(node)
        },
        goal,
        this.nodeTimeoutMs,
        this.tickTimeoutMs,
        this.searchRadius
      );
      raw = solver.compute();
    } catch (err) {
      this.log.debug(`A* threw: ${err.message}`);
      return this.result(STATUS.NO_PATH, [], `search failed: ${err.message}`);
    }

    const status = raw && raw.status ? raw.status : 'noPath';
    const path = Array.isArray(raw && raw.path) ? raw.path : [];
    const nodes = (raw && raw.generatedNodes) || 0;

    if (status === 'success') {
      if (path.length > this.maxPathLength) {
        return this.result(STATUS.NO_PATH, [], `path too long (${path.length} > ${this.maxPathLength} nodes)`);
      }
      this.stats.success += 1;
      return this.result(STATUS.SUCCESS, normalisePath(path), `reached in ${path.length} nodes`, nodes);
    }

    if (status === 'timeout') {
      this.stats.timeout += 1;
      return this.result(STATUS.TIMEOUT, normalisePath(path), `search timed out after ${this.nodeTimeoutMs}ms`, nodes);
    }

    if (status === 'partial') {
      this.stats.timeout += 1;
      // A partial path is still useful: it moves the bot closer and the next replan may
      // succeed from the new vantage point. Reporting it distinctly beats discarding it.
      return this.result(
        STATUS.PARTIAL,
        normalisePath(path),
        `search incomplete after ${this.tickTimeoutMs}ms of compute (${nodes} nodes)`,
        nodes
      );
    }

    this.stats.noPath += 1;
    return this.result(STATUS.NO_PATH, [], 'no route found within the known terrain', nodes);
  }

  /** Convenience: does a route exist at all? Used by tasks to filter candidates. */
  async canReach(target, options = {}) {
    const res = await this.plan(target, options);
    return res.status === STATUS.SUCCESS || res.status === STATUS.PARTIAL;
  }

  /**
   * The point `maxDistance` along the straight line from the bot toward `target` - geometry
   * only, no terrain opinion. Clamped to the target when it is nearer than `maxDistance`.
   *
   * @param {{x:number,y:number,z:number}} target
   * @param {{maxDistance?:number}} [options]
   * @returns {{x:number,y:number,z:number}|null}
   */
  subgoalPoint(target, options = {}) {
    const snap = this.body.snapshot ? this.body.snapshot() : null;
    const from = snap && snap.position;
    if (!from || !target) return null;
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const distance = Math.hypot(dx, dz);
    if (!Number.isFinite(distance) || distance < 0.001) return null;
    const maxDistance = options.maxDistance === undefined
      ? Math.max(1, this.world.scanRadius - 1)
      : options.maxDistance;
    const step = Math.min(maxDistance, distance);
    return {
      x: Math.round(from.x + (dx / distance) * step),
      y: Math.round(target.y),
      z: Math.round(from.z + (dz / distance) * step)
    };
  }

  /**
   * The dry, standable cell on the straight line to `target` that is closest to the target
   * and no further than `maxDistance` from the bot. `null` when the whole line is unusable.
   *
   * WHY THIS EXISTS
   * ---------------
   * The scan grid is the entire world knowledge this planner has (about +/-24 blocks
   * horizontally, -8/+8 vertically), and a cell outside it is *unknown* rather than empty.
   * A target beyond the grid therefore cannot be planned to in one A* call - and the old
   * answer, walking blindly in its direction, is exactly how the bot ended up in a river
   * instead of on the bridge (live 2026-10-14): the blind step took its y from the target,
   * ignored the water, and never looked at the bridge that was inside the grid all along.
   *
   * So this picks a *real* intermediate goal - on the line the bot would walk anyway, as far
   * toward the target as the grid allows - and lets A* answer the terrain question (bridge
   * or swim) with its own cost model. The search slides back toward the bot until it finds a
   * cell that satisfies the movement model's own occupancy rules, so a subgoal can never be
   * somewhere the planner would refuse: a wall, a fence top, a lava pool, or the water
   * surface (`isUsableSubgoal`).
   *
   * @param {{x:number,y:number,z:number}} target
   * @param {{maxDistance?:number, preferY?:number}} [options]
   * @returns {{x:number,y:number,z:number}|null}
   */
  pickSubgoal(target, options = {}) {
    const snap = this.body.snapshot ? this.body.snapshot() : null;
    const from = snap && snap.position;
    if (!from || !target) return null;
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const distance = Math.hypot(dx, dz);
    if (!Number.isFinite(distance) || distance < 1) return null;
    const ux = dx / distance;
    const uz = dz / distance;
    const maxDistance = Math.min(
      options.maxDistance === undefined ? Math.max(1, this.world.scanRadius - 1) : options.maxDistance,
      distance
    );
    const fromFeetY = Math.floor(from.y);

    // Farthest first (closest to the target), then slide back one cell at a time.
    for (let step = Math.floor(maxDistance); step >= 1; step -= 1) {
      const x = Math.round(from.x + ux * step);
      const z = Math.round(from.z + uz * step);
      const lineY = Math.round(fromFeetY + (target.y - fromFeetY) * (step / distance));
      for (const y of this.subgoalHeights(x, z, lineY, fromFeetY)) {
        const cell = v3(x, y, z);
        if (this.isUsableSubgoal(cell)) return { x: cell.x, y: cell.y, z: cell.z };
      }
    }
    return null;
  }

  /**
   * Candidate heights for one column, nearest the line's own height first.
   *
   * WHY THE WHOLE COLUMN AND NOT JUST THE LINE
   * ------------------------------------------
   * A target 40 blocks away over a cliff is a normal case here, and the walkable surface under
   * the ray can sit several blocks above or below the straight line between the two y values.
   * Probing only the line's height (and the bot's, +/-1) made *every* column over such a height
   * change fail the occupancy test, so the search slid all the way back to the bot's own ledge
   * and handed the navigator a subgoal 2-6 blocks away: one-block hops, then the +/-5 fallback
   * picking lateral cells - which is exactly what "the bot wanders at random" looked like in
   * the 2026-10-15 live test. The scan already reports -8..+8 vertically, so the surface is
   * visible; it just has to be looked at.
   *
   * Ordering keeps the intent ("as close to the straight line as possible") while letting a
   * cliff, a valley or a hilltop win when the line itself runs through rock or air.
   *
   * @param {number} x @param {number} z column to probe
   * @param {number} lineY interpolated height of the bot->target line at that column
   * @param {number} fromFeetY the bot's own feet height
   * @returns {number[]}
   */
  subgoalHeights(x, z, lineY, fromFeetY) {
    const up = Number.isFinite(this.world.scanUp) ? this.world.scanUp : 8;
    const down = Number.isFinite(this.world.scanDown) ? this.world.scanDown : 8;
    const out = [];
    for (let y = fromFeetY - down; y <= fromFeetY + up; y += 1) out.push(y);
    out.sort(
      (a, b) => Math.abs(a - lineY) - Math.abs(b - lineY) || Math.abs(a - fromFeetY) - Math.abs(b - fromFeetY)
    );
    return out;
  }

  /**
   * May the bot be *sent to* this cell as an intermediate goal?
   *
   * Stricter than "a valid path node", because the body has to come to rest here: the cell
   * must be known, dry, not built (when a guard is installed), occupiable - feet and head
   * both clear, so sugar cane, tall grass, kelp and friends are fine because they are not
   * solid - and it must have a real floor under it. The dry requirement implements the
   * operator's rule that the agent never needs to reach a cell *inside water*: a route may
   * still cross liquid (A* pays for it), but a waypoint never is one.
   *
   * @param {import('./vec3util').PathVec} cell
   * @returns {boolean}
   */
  isUsableSubgoal(cell) {
    if (!cell || !this.world.inGrid(cell)) return false;
    const block = this.world.blockAt(cell);
    if (!block || block.liquid) return false;
    if (typeof this.world.veto === 'function' && this.world.veto(cell)) return false;
    if (!this.movements.canStandAt(cell)) return false;
    if (!this.movements.hasFloorAt(cell)) return false;
    return true;
  }

  /**
   * Alternative subgoals around `anchor`, for when the best cell cannot be planned to.
   *
   * A single subgoal is a single question; when A* answers "no route" the useful move is to
   * ask a nearby one (the operator's +/-5 blocks). Candidates are therefore ordered by
   * distance to the *anchor* first - locality, because the anchor was chosen for a reason
   * and its neighbours are the cells most likely to share its route - and by distance to the
   * target second. Ordering by target distance first looks better on paper but spends every
   * attempt on the far side of an obstacle (measured: a crosswise wall put every reachable
   * alternative at rank 9+), which is exactly the case this fallback exists for.
   *
   * @param {{x:number,y:number,z:number}} anchor the primary subgoal, or its geometric point
   * @param {{x:number,y:number,z:number}} target
   * @param {{radius?:number, max?:number}} [options]
   * @returns {Array<{x:number,y:number,z:number,distance:number}>}
   */
  subgoalCandidates(anchor, target, options = {}) {
    const snap = this.body.snapshot ? this.body.snapshot() : null;
    const from = snap && snap.position;
    if (!anchor || !target || !from) return [];
    const radius = options.radius === undefined ? 5 : options.radius;
    const max = options.max === undefined ? 8 : options.max;
    /**
     * A candidate closer than this to the bot would be reported as "already there" by the
     * planner (the goal carries a `range` tolerance), so it is not a hop - offering it just
     * turns the fallback into one-block jitter (live 2026-10-15).
     */
    const minDistance = options.minDistance === undefined ? 3 : options.minDistance;
    const fromDistance = Math.hypot(target.x - from.x, target.z - from.z);
    const baseY = Number.isFinite(anchor.y) ? Math.floor(anchor.y) : Math.floor(from.y);
    const out = [];
    const seen = new Set();

    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        if (dx === 0 && dz === 0) continue;
        const x = Math.round(anchor.x + dx);
        const z = Math.round(anchor.z + dz);
        if (Math.hypot(x - from.x, z - from.z) < minDistance) continue;
        for (const y of [baseY, baseY + 1, baseY - 1, baseY + 2, baseY - 2]) {
          const cell = v3(x, y, z);
          if (seen.has(cell.hash)) continue;
          seen.add(cell.hash);
          if (!this.isUsableSubgoal(cell)) continue;
          const targetDistance = Math.hypot(target.x - cell.x, target.z - cell.z);
          // Progress guard: never send the bot somewhere *farther* from the target than it
          // already is - that would be wandering dressed up as a detour.
          if (targetDistance >= fromDistance) break;
          out.push({ x: cell.x, y: cell.y, z: cell.z, distance: targetDistance });
          break; // one usable height per column is enough
        }
      }
    }

    const offset = (c) => Math.abs(c.x - anchor.x) + Math.abs(c.z - anchor.z);
    const botDistance = (c) => Math.hypot(c.x - from.x, c.z - from.z);
    /**
     * Locality first, then *nearer the bot*.
     *
     * The second key matters more than it looks: an obstacle that eats the primary subgoal
     * usually sits between the bot and that subgoal, so among equally local cells the one
     * closer to the bot is the one on the near side of it. Measured on a crosswise wall, the
     * opposite tie-break (prefer nearer the target) put every reachable alternative at rank
     * 9+ and spent the whole attempt budget on the far side.
     */
    out.sort((a, b) => offset(a) - offset(b) || botDistance(a) - botDistance(b));
    return out.slice(0, max);
  }

  result(status, path, reason, nodes = 0) {
    return { status, path, reason, nodes };
  }

  describe() {
    return { ...this.stats, gridRadius: this.world.scanRadius, cells: this.world.cellCount() };
  }
}

/**
 * A* returns PathVec3 instances; hand callers plain objects they can JSON-serialise.
 *
 * `move` is carried across deliberately: it is the tag the movement model put on the edge
 * used to reach this node ("walk", "step-up", "jump", ...), and it is the only surviving
 * evidence of *how* the route expects to get there. The walker needs it to tell a walk that
 * failed from a jump that physically cannot be made - see WaypointWalker's jump streak.
 * Dropping it here is what would make "the bot keeps jumping at a wall" impossible to fix.
 */
function normalisePath(path) {
  return path.map((node) => (node.move ? { x: node.x, y: node.y, z: node.z, move: node.move } : { x: node.x, y: node.y, z: node.z }));
}

module.exports = { PathPlanner, WeightedGoalNear, STATUS, withinGoalRange };
