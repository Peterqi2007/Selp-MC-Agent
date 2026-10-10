'use strict';

/**
 * PathNavigator: "get me to that coordinate", built from the planner and the walker.
 *
 * This is the layer that copes with the mod's 24-block perception limit. A target 200
 * blocks away cannot be planned in one A* call, because A* would be reasoning about
 * terrain nobody has seen. The navigator therefore plans short, walks, **replans from the
 * new position**, and repeats - so every plan is made from a fresh, fully-observed
 * neighbourhood.
 *
 * It is also where the failure classification finally becomes a decision:
 *
 *   success            -> done
 *   partial            -> walk it anyway; it is progress, and we are about to replan
 *   noPath/blocked     -> stop; the caller picks another target
 *   out-of-grid        -> step toward the target, then replan
 *   timeout            -> retry once, then stop
 *
 * That decision table is the whole point of building this instead of letting the client's
 * straight-line walker flail (which is what `WalkTo` in the mod does, and why the plan
 * lists it as the thing to replace).
 */

const { PathPlanner, STATUS, withinGoalRange } = require('./planner');
const { WaypointWalker, WALK_REASON } = require('./walker');
const { distanceBetween, v3 } = require('./vec3util');

const NAV_REASON = {
  ARRIVED: 'arrived',
  NO_PATH: 'noPath',
  BLOCKED: 'blocked',
  TIMEOUT: 'timeout',
  OUT_OF_GRID: 'out-of-grid',
  MAX_ITERATIONS: 'max-iterations',
  BODY_LOST: 'body-lost',
  /** No block scan at all: the caller may degrade rather than give up. */
  UNKNOWN_BLOCK: 'unknown-block',
  /** Repeated jumps got nowhere: reported when changing direction did not help either. */
  JUMP_BLOCKED: 'jump-blocked',
  /** Plan/walk cycles stopped making ground: stop early instead of burning the iteration cap. */
  STALLED: 'stalled'
};

class PathNavigator {
  /**
   * @param {object} body Body instance
   * @param {object} [options] { replanEvery, maxIterations, log, ...planner/walker options }
   */
  constructor(body, options = {}) {
    this.body = body;
    this.log = options.log || { debug() {}, warn() {}, info() {} };
    this.planner = new PathPlanner(body, options);
    this.walker = new WaypointWalker(body, options);
    /** Path trace sink (P0-PLAN §8); forwarded to the planner through `options`. */
    this.trace = options.trace || (() => {});
    /**
     * How far along the planned path to walk before replanning. Kept well under the
     * 24-block perception radius so each new plan starts from a well-observed area.
     */
    this.replanEvery = options.replanEvery || 20;
    /** Ceiling on plan/walk cycles; a safety net against oscillation, not a real limit. */
    this.maxIterations = options.maxIterations || 40;
    /** Below this distance, skip planning entirely and just walk (cheaper, and avoids A* on a 1-block hop). */
    this.directRange = options.directRange === undefined ? 3 : options.directRange;
    /**
     * How many times a blocked route may be answered with "go a different way" before we
     * accept that the target is unreachable. Small on purpose: this is a deadlock breaker,
     * not a search strategy - two attempts cover "the snapshot was stale" and "the obstacle
     * is wider than one block", and everything beyond that is wandering.
     */
    this.maxSidesteps = options.maxSidesteps === undefined ? 2 : options.maxSidesteps;
    /** How far the sideways leg reaches. Inside the scan radius, far enough to matter. */
    this.sidestepDistance = options.sidestepDistance || 3;
    this.stats = { calls: 0, arrived: 0, failed: 0, iterations: 0, sidesteps: 0 };
  }

  get ready() {
    return !!(this.body && this.body.isReady);
  }

  /**
   * Walk to a position, replanning as needed.
   *
   * @param {{x:number,y:number,z:number}} target
   * @param {object} [options] { range, timeoutMs }
   * @returns {Promise<{ok:boolean, reason:string, iterations:number, distance:number}>}
   */
  async goTo(target, options = {}) {
    this.stats.calls += 1;
    this._lastTarget = { x: target.x, y: target.y, z: target.z };
    const range = options.range === undefined ? 1 : options.range;
    const deadline = Date.now() + (options.timeoutMs || 120000);
    let iterations = 0;
    let lastReason = NAV_REASON.NO_PATH;
    let retriedTimeout = false;
    /** Cells already used as a sidestep, so the same detour is not taken twice. */
    const sidestepTried = new Set();
    let sidestepsLeft = this.maxSidesteps;
    let avoidRelaxed = false;
    /**
     * Cycles that ended with the walker reporting success but the body not moving.
     *
     * That combination is the signature of the arrival deadlock (live 2026-10-10): the walker
     * accepts a leg the bot is already standing at, the goal check still fails, and every
     * replan derives the identical answer. Three of those in a row is not progress; report a
     * distinct reason instead of spinning until `maxIterations` (40).
     */
    let stalledCycles = 0;
    this.walker.resetJumpStreak();
    this.planner.movements.clearAvoid();

    if (!this.ready) {
      return this.done(false, NAV_REASON.BODY_LOST, 0);
    }

    while (iterations < this.maxIterations) {
      iterations += 1;
      this.stats.iterations += 1;

      if (Date.now() > deadline) {
        return this.done(false, NAV_REASON.TIMEOUT, iterations);
      }

      const snap = this.body.snapshot();
      if (!snap || !snap.ready) {
        return this.done(false, NAV_REASON.BODY_LOST, iterations);
      }

      const distance = distanceBetween(snap.position, target);
      /**
       * Arrival = the planner's own goal test (shared helper), with the historical float
       * check kept as an extra accept. Using two different rules here is what deadlocked
       * the trip just outside the radius; see `withinGoalRange`.
       */
      if (
        withinGoalRange(snap.position.x, snap.position.y, snap.position.z, target.x, target.y, target.z, range) ||
        distance <= range
      ) {
        this.stats.arrived += 1;
        return this.done(true, NAV_REASON.ARRIVED, iterations);
      }

      // ---- close enough that planning is overhead, not help -----------------
      if (distance <= this.directRange) {
        const ok = await this.walker.walk([v3(target.x, target.y, target.z)], { range, timeoutMs: 8000 });
        if (ok.ok) {
          this.stats.arrived += 1;
          return this.done(true, NAV_REASON.ARRIVED, iterations);
        }
        lastReason = ok.reason === WALK_REASON.BLOCKED ? NAV_REASON.BLOCKED : NAV_REASON.NO_PATH;
        // One direct attempt is enough; fall through to planning on the next loop.
        if (iterations > 2) return this.done(false, lastReason, iterations);
        continue;
      }

      // ---- plan -------------------------------------------------------------
      const plan = await this.planner.plan(target, { range });

      if (plan.status === STATUS.OUT_OF_GRID) {
        // Expected for distant targets: take a step in the right direction and look again.
        lastReason = NAV_REASON.OUT_OF_GRID;
        const step = this.planner.toward(target, Math.max(8, this.replanEvery));
        if (!step) return this.done(false, NAV_REASON.OUT_OF_GRID, iterations);
        const walked = await this.walker.walk([v3(step.x, step.y, step.z)], { range: 2, timeoutMs: 15000 });
        if (!walked.ok) return this.done(false, walked.reason === WALK_REASON.BLOCKED ? NAV_REASON.BLOCKED : NAV_REASON.OUT_OF_GRID, iterations);
        continue;
      }

      if (plan.status === STATUS.NO_PATH) {
        /**
         * A route we ruled out may have been the only one.
         *
         * Once a failed cell is remembered, A* can genuinely run out of options - the bot may
         * have been standing in the only corridor out. Rather than reporting noPath while
         * holding a self-imposed exclusion, drop the exclusions and ask once more.
         */
        if (!avoidRelaxed && this.planner.movements.avoid && this.planner.movements.avoid.size) {
          avoidRelaxed = true;
          this.log.debug('no route with the failed cells excluded - forgetting them and asking again');
          this.planner.movements.clearAvoid();
          continue;
        }
        this.stats.failed += 1;
        return this.done(false, NAV_REASON.NO_PATH, iterations);
      }

      /**
       * `unknown-block` is not a pathfinding result - it means there is no perception to
       * plan over. It is passed through verbatim so the *caller* can decide: `moveTo`
       * degrades to the client's own walker, while a task may prefer to report it. Folding
       * it into `noPath` here would hide "the scan is not loaded yet" behind "there is no
       * route", and those two need completely different responses.
       */
      if (plan.status === STATUS.UNKNOWN_BLOCK) {
        this.stats.failed += 1;
        return this.done(false, NAV_REASON.UNKNOWN_BLOCK, iterations);
      }

      if (plan.status === STATUS.TIMEOUT) {
        if (retriedTimeout) {
          this.stats.failed += 1;
          return this.done(false, NAV_REASON.TIMEOUT, iterations);
        }
        retriedTimeout = true;
        lastReason = NAV_REASON.TIMEOUT;
        continue;
      }

      if (!plan.path.length) {
        // partial/timeout with nothing usable: treat as no path so callers can move on.
        this.stats.failed += 1;
        return this.done(false, NAV_REASON.NO_PATH, iterations);
      }

      // ---- walk a slice of it, then replan ----------------------------------
      const slice = plan.path.slice(0, Math.min(this.replanEvery, plan.path.length));
      const walked = await this.walker.walk(slice, { range, timeoutMs: Math.min(60000, deadline - Date.now()) });

      if (walked.ok) {
        const nowPos = this.body.snapshot() && this.body.snapshot().position;
        const moved = nowPos ? distanceBetween(nowPos, snap.position) : 0;
        if (moved < 0.1) {
          stalledCycles += 1;
          if (stalledCycles >= 3) {
            this.stats.failed += 1;
            return this.done(false, NAV_REASON.STALLED, iterations);
          }
        } else {
          stalledCycles = 0;
        }
        continue; // replan from the new position
      }

      /**
       * Blocked, or jumping got us nowhere: try going a different way.
       *
       * This is the answer to "the bot keeps jumping at the same wall". Replanning from the
       * same cell produces the same route (the snapshot has not changed) and the same jump,
       * so more replanning is not a strategy. One short leg at an angle changes the vantage
       * point, and the next plan is a genuinely different question.
       */
      if (walked.reason === WALK_REASON.BLOCKED || walked.reason === WALK_REASON.JUMP_BLOCKED) {
        const jumpBlocked = walked.reason === WALK_REASON.JUMP_BLOCKED;
        this.avoidFailedLegs(walked);
        if (sidestepsLeft > 0 && Date.now() < deadline - 2000) {
          const side = this.sidestep(target, sidestepTried, jumpBlocked ? 'jump-blocked' : 'blocked');
          if (side) {
            sidestepsLeft -= 1;
            this.stats.sidesteps += 1;
            const stepped = await this.walker.walk([side], {
              range: 1.5,
              timeoutMs: Math.min(10000, Math.max(2000, deadline - Date.now()))
            });
            if (stepped.ok) {
              // New vantage point: the old route's verdict no longer applies.
              this.walker.resetJumpStreak();
              continue;
            }
            this.log.debug(`sidestep to (${side.x},${side.y},${side.z}) did not work either (${stepped.reason})`);
          }
        }
        this.stats.failed += 1;
        return this.done(false, jumpBlocked ? NAV_REASON.JUMP_BLOCKED : NAV_REASON.BLOCKED, iterations);
      }
      if (walked.reason === WALK_REASON.BODY_LOST) {
        return this.done(false, NAV_REASON.BODY_LOST, iterations);
      }
      if (walked.reason === WALK_REASON.NO_PROGRESS) {
        /**
         * Walked the slice but ended up short.
         *
         * This is where a *stale snapshot* usually lands first: one leg could not be walked,
         * and the walker ran out of legs before its stall or jump streak tripped. The failed
         * cells still have to be learned from, or the retry re-derives the same route and the
         * loop burns iterations until the guard stops it - the "it keeps trying the same
         * thing" behaviour, just slower.
         */
        this.avoidFailedLegs(walked);
        lastReason = NAV_REASON.NO_PATH;
        if (iterations > 3) {
          this.stats.failed += 1;
          return this.done(false, NAV_REASON.NO_PATH, iterations);
        }
        continue;
      }
      lastReason = NAV_REASON.TIMEOUT;
      if (iterations > 3) return this.done(false, lastReason, iterations);
    }

    this.stats.failed += 1;
    return this.done(false, NAV_REASON.MAX_ITERATIONS, iterations);
  }

  /**
   * A short leg at an angle to the direction we were trying to travel.
   *
   * WHY THIS IS NEEDED AT ALL
   * -------------------------
   * The client executes a leg by holding "forward" and pressing jump whenever it collides
   * (ClientActions.WalkTo). Faced with anything it cannot climb - a 2-block wall, a fence, a
   * step under a low ceiling - that becomes an endless pogo: the bot jumps on the spot,
   * reports nothing, and the walker eventually gives up. Replanning does not help, because
   * the snapshot is unchanged and A* returns the same route with the same jump in it.
   *
   * A player in that position does not jump harder; they walk around. That is all this does:
   * pick a standable cell at an angle to the blocked heading, walk the few blocks to it, and
   * let the caller replan from there. The candidate order puts the two perpendicular
   * directions first (those get around a wall), then the diagonals, then the direction we
   * were already failing at and the retreat.
   *
   * Every candidate is validated against the *movement model's own* rules - in the scan
   * grid, no built blocks, standable, with a floor - so a sidestep can never walk the bot
   * somewhere the planner would have refused, into lava, or into someone's base.
   *
   * @param {{x:number,y:number,z:number}} target where we are ultimately going
   * @param {Set<string>} tried hashes already used, so the same detour is not repeated
   * @param {string} why 'blocked' | 'jump-blocked', for the log line
   * @returns {{x:number,y:number,z:number}|null}
   */
  sidestep(target, tried = new Set(), why = 'blocked') {
    const snap = this.body.snapshot();
    if (!snap || !snap.position) return null;
    const from = v3(snap.position.x, snap.position.y, snap.position.z);
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const length = Math.hypot(dx, dz);
    // Perpendicular to the direction of travel. Standing on the target (length ~0) makes
    // "perpendicular" meaningless, so use +x - any direction is as good as any other.
    const px = length < 0.001 ? 1 : -dz / length;
    const pz = length < 0.001 ? 0 : dx / length;

    for (const degrees of [0, 180, 45, -45, 135, -135, 90, -90]) {
      const angle = (degrees * Math.PI) / 180;
      const cx = Math.cos(angle) * px - Math.sin(angle) * pz;
      const cz = Math.sin(angle) * px + Math.cos(angle) * pz;
      // Longest first, then closer in: terrain is uneven, so a cell 3 blocks out may be
      // unusable while the one 2 blocks out is fine.
      for (let step = this.sidestepDistance; step >= 1; step -= 1) {
        const x = Math.round(from.x + cx * step);
        const z = Math.round(from.z + cz * step);
        if (x === from.x && z === from.z) continue;
        for (const dy of [0, 1, -1]) {
          const candidate = v3(x, from.y + dy, z);
          if (tried.has(candidate.hash)) continue;
          if (!this.planner.world.inGrid(candidate)) continue;
          if (this.planner.guard && this.planner.guard.veto(candidate)) continue;
          if (!this.planner.movements.canStandAt(candidate)) continue;
          if (!this.planner.movements.hasFloorAt(candidate)) continue;
          tried.add(candidate.hash);
          this.log.info(
            `route is ${why} - trying a different direction: (${candidate.x},${candidate.y},${candidate.z})`
          );
          this.trace({ kind: 'sidestep', why, target: { ...this._lastTarget }, to: { ...candidate }, from: { ...from } });
          return candidate;
        }
      }
    }

    this.log.debug('no usable direction to sidestep into - the target looks unreachable');
    return null;
  }

  /**
   * Rule out the cells a failed walk could not reach, for the rest of this trip.
   *
   * WHY THIS IS THE CORE OF "TRY ANOTHER DIRECTION"
   * -----------------------------------------------
   * The block scan is a snapshot, and it can be wrong about what the *client* can execute: a
   * step under a low ceiling, a 1-block gap the bot walks into instead of jumping. When that
   * happens A* has no reason to prefer a different answer, so replanning re-derives the
   * identical route with the identical move - the bot jumps at the same wall until something
   * times out. Removing the offending cell from the graph is what makes the next plan a
   * genuinely different plan. `PathNavigator.goTo` clears the set per trip (and drops it once
   * if it ever leaves no route at all), so this is a per-attempt memory, not a grudge.
   *
   * @param {{legs?: Array<{x:number,y:number,z:number,move?:string}>, leg?: object, reason: string}} walked
   */
  avoidFailedLegs(walked) {
    const legs = (walked && walked.legs && walked.legs.length ? walked.legs : walked && walked.leg ? [walked.leg] : []);
    for (const failed of legs) {
      const key = this.planner.movements.avoidCell(failed);
      this.log.info(
        `cannot get to (${failed.x},${failed.y},${failed.z})${failed.move ? ` (needs a ${failed.move})` : ''} - ` +
          `treating it as blocked for the rest of this trip [${key}]`
      );
      this.trace({ kind: 'avoid', cell: { ...failed }, reason: walked.reason, target: { ...this._lastTarget } });
    }
    return legs.length;
  }

  /** Cut the current movement short (panel emergency stop, preemption). */
  stop() {
    this.walker.interruptBody('navigator stop');
  }

  /**
   * Plan without walking: a query, not a task (numen's `route plan`).
   *
   * The caller gets the same status the planner already reports plus a small summary the
   * operator can read. Nothing here touches the body, so `!route plan` cannot move the bot;
   * `!route go` re-runs this from the current position and only walks when the plan still
   * holds. Our movement model never digs or bridges, so there is no edit budget to commit -
   * "walk-only" is guaranteed by construction and stated in the summary.
   *
   * @param {{x:number,y:number,z:number}} target
   * @param {object} [options] { range, timeoutMs }
   */
  async plan(target, options = {}) {
    if (!this.ready) {
      return { ok: false, status: 'body-lost', reason: 'body is not attached to a client', waypoints: 0, distance: 0, nodes: 0, path: [] };
    }
    const range = options.range === undefined ? 2 : options.range;
    const res = await this.planner.plan(target, {
      range,
      timeoutMs: options.timeoutMs || 5000
    });
    const path = (res.path || []).map((p) => ({ x: p.x, y: p.y, z: p.z }));
    const snap = this.body.snapshot();
    const start = snap && snap.position;
    let distance = 0;
    if (start && path.length) {
      distance += Math.hypot(path[0].x - start.x, path[0].y - start.y, path[0].z - start.z);
    }
    for (let i = 1; i < path.length; i += 1) {
      distance += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y, path[i].z - path[i - 1].z);
    }
    return {
      ok: res.status === 'success',
      status: res.status,
      reason: res.reason,
      waypoints: path.length,
      distance: +distance.toFixed(1),
      nodes: res.nodes || 0,
      edits: 0,
      path
    };
  }

  done(ok, reason, iterations) {
    this.trace({
      kind: 'goTo',
      target: this._lastTarget || null,
      ok,
      reason,
      iterations,
      position: this.body && this.body.snapshot() ? this.body.snapshot().position : null
    });
    return { ok, reason, iterations };
  }

  describe() {
    return { ...this.stats, planner: this.planner.describe(), walker: this.walker.describe() };
  }
}

module.exports = { PathNavigator, NAV_REASON };
