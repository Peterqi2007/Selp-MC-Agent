'use strict';

/**
 * WaypointWalker: turns a planned path into movement the client can actually perform.
 *
 * The client mod exposes movement as a continuous action (`moveto x y z range`, then poll
 * `/progress`), not as "walk this polyline". So the walker's job is threefold:
 *
 *   1. **Merge collinear waypoints.** A 40-block straight corridor is one `moveto`, not 40
 *      HTTP round-trips. This matters because each request has real latency and the bot
 *      visibly stutters between them.
 *   2. **Detect stalls.** The client's WalkTo holds "forward" and jumps when it collides;
 *      it can wedge against a fence or in a corner and then report neither `arrived` nor
 *      `failed` until its own 60s timeout. Waiting that long is unacceptable, so the walker
 *      watches the position itself and gives up on a stall.
 *   3. **Classify failure.** "Blocked" and "timed out" need different responses: blocked
 *      means replan (the world differs from the snapshot), timeout means the target is
 *      probably unreachable.
 *
 * Failure reasons are part of the contract, because the harvest task uses them to decide
 * whether to try the next target or give up on the area.
 */

const { distanceBetween } = require('./vec3util');
const { JUMPY_MOVES } = require('./movementsAdapter');

/** Why a walk ended. Consumed by tasks (see P0-PLAN §3.5). */
const WALK_REASON = {
  ARRIVED: 'arrived',
  TIMEOUT: 'timeout',
  BLOCKED: 'blocked',
  NO_PROGRESS: 'no-progress',
  BODY_LOST: 'body-lost',
  EMPTY_PATH: 'empty-path',
  /**
   * Repeated jump/step-up legs failed. Distinct from `blocked` because the answer is
   * different: a blocked route needs another route, a jump that will not happen needs
   * another *direction* (see PathNavigator.sidestep).
   */
  JUMP_BLOCKED: 'jump-blocked'
};

class WaypointWalker {
  /**
   * @param {object} body Body instance (ClientModBody)
   * @param {object} [options] { log, waypointRange, stallThreshold, stallDistance, perWaypointTimeoutMs }
   */
  constructor(body, options = {}) {
    this.body = body;
    this.log = options.log || { debug() {}, warn() {}, info() {} };
    /**
     * 1.0 rather than 1.5: the client's arrival test ignores Y and treats "within range" as
     * arrived, so a loose range makes the bot stop short of the block it wants to mine.
     */
    this.waypointRange = options.waypointRange === undefined ? 1.0 : options.waypointRange;
    /** Consecutive waypoints with no meaningful movement before we call it stuck. */
    this.stallThreshold = options.stallThreshold || 2;
    /** Below this many blocks of movement between waypoints counts as "no progress". */
    this.stallDistance = options.stallDistance || 0.5;
    this.perWaypointTimeoutMs = options.perWaypointTimeoutMs || 20000;
    /** How long to wait for a single merged leg before giving up on it. */
    this.legTimeoutMs = options.legTimeoutMs || 45000;
    /**
     * Failed jump/step-up legs in a row before we stop jumping and say so.
     *
     * The client walks a leg by holding "forward" and pressing jump whenever it collides
     * (ClientActions.WalkTo), which against anything it cannot climb becomes an endless
     * pogo - the bot visibly jumps at a wall until the 60s timeout. A jump that has failed
     * twice is not going to work on the third try; the route needs another direction, and
     * that decision belongs to the navigator (see `PathNavigator.sidestep`).
     */
    this.jumpStreakLimit = options.jumpStreakLimit === undefined ? 2 : options.jumpStreakLimit;
    /**
     * Deliberately an *instance* counter, not a local one.
     *
     * A blocked step is usually a one-leg path, and the navigator walks path slices: a local
     * counter would reset on every replan and the bot would jump at the same wall forever -
     * exactly the behaviour this exists to stop. It resets when a jumpy leg succeeds (so
     * jumping demonstrably works here) and when the navigator changes direction.
     */
    this.jumpStreak = 0;
    this.stats = { walks: 0, arrived: 0, blocked: 0, timeouts: 0, legs: 0, merged: 0, jumpFailures: 0, jumpBlocked: 0 };
  }

  /** Forget the jump streak: the situation changed (a sidestep succeeded, a new trip began). */
  resetJumpStreak() {
    this.jumpStreak = 0;
  }

  /**
   * Walk along a path.
   *
   * @param {Array<{x:number,y:number,z:number}>} path
   * @param {object} [options] { range, timeoutMs }
   * @returns {Promise<{ok:boolean, reason:string, arrived:number, travelled:number}>}
   */
  async walk(path, options = {}) {
    this.stats.walks += 1;
    const range = options.range === undefined ? this.waypointRange : options.range;
    const deadline = Date.now() + (options.timeoutMs || 120000);

    if (!path || !path.length) {
      return this.done(false, WALK_REASON.EMPTY_PATH, 0, 0);
    }

    const legs = mergeWaypoints(path, range);
    this.stats.legs += legs.length;
    this.stats.merged += Math.max(0, path.length - legs.length);

    const startPos = this.position();
    const travelledDistance = () => distanceBetween(startPos, this.position());
    let noProgressStreak = 0;
    let arrived = 0;
    /** Did the client report success on the final leg? See the arrival test below. */
    let lastLegOk = false;
    /**
     * Legs the client could not complete, with how they were meant to be performed.
     *
     * The navigator uses this to rule those cells out for the rest of the trip: a plan that
     * routes through a cell we just failed to reach is the same plan again, and it will end
     * the same way. Reporting only the *first* failure would leave the rest of the route
     * untouched and produce exactly that loop.
     */
    const failedLegs = [];
    const failure = (reason, arrivedCount) =>
      this.done(false, reason, arrivedCount, travelledDistance(), {
        legs: failedLegs.slice(),
        leg: failedLegs.length ? failedLegs[failedLegs.length - 1] : null
      });

    for (const leg of legs) {
      if (Date.now() > deadline) {
        this.stats.timeouts += 1;
        return failure(WALK_REASON.TIMEOUT, arrived);
      }
      if (!this.body.isReady) {
        return failure(WALK_REASON.BODY_LOST, arrived);
      }

      const legStart = this.position();
      const ok = await this.walkLeg(leg);
      const moved = distanceBetween(legStart, this.position());
      const jumpy = isJumpLeg(leg);
      lastLegOk = ok;

      if (ok) {
        noProgressStreak = 0;
        // A jump that worked proves jumping works here, so the streak starts over.
        if (jumpy) this.jumpStreak = 0;
        arrived += 1;
        continue;
      }
      failedLegs.push({ x: leg.x, y: leg.y, z: leg.z, move: leg.move || null });

      /**
       * A failed jump is its own kind of failure.
       *
       * "Blocked" means the terrain disagrees with the snapshot and a replan may fix it.
       * A failed *jump* means this route needs the bot to get over something it cannot get
       * over, and replanning the same shape will produce the same jump. The two need
       * different answers, so they get different reasons.
       */
      if (jumpy) {
        this.jumpStreak += 1;
        this.stats.jumpFailures += 1;
        // The client may still be holding "forward" and jumping: stop it first.
        this.interruptBody('jump did not work');
        this.log.debug(
          `leg (${leg.x},${leg.y},${leg.z}) needed a ${leg.move} and failed, ` +
            `streak ${this.jumpStreak}/${this.jumpStreakLimit}`
        );
        if (this.jumpStreak >= this.jumpStreakLimit) {
          this.stats.jumpBlocked += 1;
          this.log.warn(
            `${this.jumpStreak} ${leg.move} legs in a row got nowhere - jumping is not the answer, trying a different direction`
          );
          return failure(WALK_REASON.JUMP_BLOCKED, arrived);
        }
        continue;
      }

      // The client did not report success. Did we at least get closer?
      if (moved < this.stallDistance) {
        noProgressStreak += 1;
        this.log.debug(
          `waypoint (${leg.x},${leg.y},${leg.z}) made no progress (${moved.toFixed(2)} blocks), ` +
            `streak ${noProgressStreak}/${this.stallThreshold}`
        );
        // Stop the client's continuous action so it stops pressing forward into a wall.
        this.interruptBody();
        if (noProgressStreak >= this.stallThreshold) {
          this.stats.blocked += 1;
          return failure(WALK_REASON.BLOCKED, arrived);
        }
      } else {
        noProgressStreak = 0;
      }
    }

    /**
     * Arrival, judged honestly.
     *
     * The loose tolerance (`+1`) exists because the client's own arrival radius is wider than
     * `waypointRange`: it reports "arrived" up to ~1.5 blocks out, and refusing that would
     * make every walk end in failure. But the loose tolerance must NOT be available to a leg
     * that FAILED - a 2-block jump that the bot never performed leaves it exactly 2 blocks
     * away, which is inside the tolerance, and calling that an arrival is how "the bot is
     * standing across the gap from where it thinks it is" becomes a mining bug. So: a failed
     * final leg only counts if we are genuinely within the strict range.
     */
    const remaining = distanceBetween(this.position(), path[path.length - 1]);
    const strict = Math.max(range, this.waypointRange);
    if (remaining <= strict || (lastLegOk && remaining <= strict + 1)) {
      this.stats.arrived += 1;
      return this.done(true, WALK_REASON.ARRIVED, arrived, travelledDistance());
    }

    // Walked every leg but did not end up close: report failure rather than success,
    // otherwise callers mine a block they are not actually standing next to.
    this.stats.blocked += 1;
    return failure(WALK_REASON.NO_PROGRESS, arrived);
  }

  /**
   * Ask the body to stop whatever continuous action it is running.
   *
   * `stopContinuous()` is preferred over `interrupt()` wherever the body offers it. The
   * difference is not cosmetic: `interrupt()` means "stop everything, *including the plan*",
   * so a walker calling it re-enters the navigator that called the walker - infinite mutual
   * recursion, and a stack overflow the first time a stall or a death interrupt fired.
   * `stopContinuous()` is terminal: it only tells the client to stop moving.
   */
  interruptBody(reason = 'walker stall') {
    try {
      const method = typeof this.body.stopContinuous === 'function' ? 'stopContinuous' : 'interrupt';
      const result = this.body[method](reason);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      /* interrupt is best-effort by contract */
    }
  }

  /**
   * Send one `moveto` and wait for the client to report the outcome.
   *
   * `raw: true` tells the body to do a straight-line move for this leg instead of planning
   * again - we already have a path, and re-planning per leg would be both slower and
   * circular.
   *
   * @returns {Promise<boolean>} true when the client says it arrived
   */
  async walkLeg(leg) {
    try {
      return await this.body.moveTo(leg, {
        range: this.waypointRange,
        timeoutMs: this.legTimeoutMs,
        raw: true
      });
    } catch (err) {
      this.log.debug(`leg (${leg.x},${leg.y},${leg.z}) threw: ${err.message}`);
      return false;
    }
  }

  /** Current position, or null. */
  position() {
    const snap = this.body.snapshot();
    return snap && snap.position ? snap.position : null;
  }

  done(ok, reason, arrived, travelledBlocks, extra = {}) {
    return { ok, reason, arrived, travelled: travelledBlocks, ...extra };
  }

  describe() {
    return { ...this.stats };
  }
}

/**
 * Collapse runs of collinear, same-height waypoints into single legs.
 *
 * Two waypoints merge when they share a Y, the direction from the previous point is
 * unchanged, **and the move kind is unchanged**. That is exactly the "long straight
 * corridor" case; anything with a turn, a step or a drop stays separate because those need
 * distinct movement, and a jump or a step-up never merges at all - see the loop below for
 * why losing that node would lose the fact that a jump was needed.
 *
 * @param {Array<{x:number,y:number,z:number,move?:string}>} path
 * @param {number} range stop this far from the final waypoint
 * @returns {Array<{x:number,y:number,z:number,move?:string}>}
 */
function mergeWaypoints(path, range) {
  if (path.length <= 2) return path.slice();

  const out = [];
  let anchor = path[0];
  let prevDir = null;
  let prevMove;

  for (let i = 1; i < path.length; i += 1) {
    const node = path[i];
    const isLast = i === path.length - 1;

    /**
     * A jump or a step-up is always a leg of its own.
     *
     * Not an optimisation detail: the *start* of a merged run is implicit (the bot is
     * standing there), so folding a jump into the run that follows it deletes the node that
     * carries the `jump` tag - and with it the only evidence that this stretch needs the bot
     * to get over something. Keeping it separate also means the client is told "cross the
     * gap" as one action instead of "walk 8 blocks" through a hole.
     */
    if (isJumpLeg(node)) {
      out.push(node);
      anchor = node;
      prevDir = null;
      prevMove = node.move;
      continue;
    }

    const dir = { x: Math.sign(node.x - anchor.x), y: Math.sign(node.y - anchor.y), z: Math.sign(node.z - anchor.z) };
    const moveChanged = i > 1 && node.move !== prevMove;

    const sameHeading =
      prevDir && dir.x === prevDir.x && dir.y === prevDir.y && dir.z === prevDir.z;

    if (!sameHeading || moveChanged) {
      // Heading (or move kind) changed: the previous stretch is complete.
      if (out.length || i > 1) out.push(path[i - 1]);
      anchor = path[i - 1];
    }
    prevDir = dir;
    prevMove = node.move;

    if (isLast) out.push(node);
  }

  // Always keep the final node, and never return duplicates of it.
  const deduped = [];
  for (const node of out) {
    const last = deduped[deduped.length - 1];
    if (!last || last.x !== node.x || last.y !== node.y || last.z !== node.z) deduped.push(node);
  }
  return deduped.length ? deduped : path.slice(-1);
}

/**
 * Does executing this leg require the client to jump?
 *
 * The tag comes from the movement model (`MovementsAdapter.getNeighbors`), travels through
 * A* inside the node objects, and is preserved by `normalisePath` and `mergeWaypoints`.
 * A leg with no tag at all (a hand-built waypoint) is treated as a plain walk, which keeps
 * the callers that pass raw coordinates behaving exactly as before.
 */
function isJumpLeg(leg) {
  return !!leg && JUMPY_MOVES.has(leg.move);
}

module.exports = { WaypointWalker, WALK_REASON, mergeWaypoints, isJumpLeg };
