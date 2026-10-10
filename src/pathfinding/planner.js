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
 * planner reports `out-of-grid` and the *caller* (WaypointWalker) walks toward it and
 * replans. Encoding that as a distinct status, rather than silently returning noPath, is
 * the difference between "the bot is stuck" and "the bot needs two hops".
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
 * 3D distance while our costs are weighted (climbing costs 1.5, swimming 2.5). Weighting
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
   * A cheap "walk toward it" direction for targets we cannot plan to yet.
   * @returns {{x:number,y:number,z:number}|null}
   */
  toward(target, distance = 12) {
    const snap = this.body.snapshot();
    if (!snap || !snap.position) return null;
    const from = toPathVec(snap.position);
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const length = Math.hypot(dx, dz);
    if (length < 0.001) return null;
    const step = Math.min(distance, length);
    return {
      x: Math.round(from.x + (dx / length) * step),
      y: Math.round(target.y),
      z: Math.round(from.z + (dz / length) * step)
    };
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
