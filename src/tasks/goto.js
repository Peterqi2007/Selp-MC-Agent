'use strict';

/**
 * GoToTask: the "walk" primitive on its own (P0-PLAN §6.5).
 *
 * Trivial by itself - it is `body.moveTo()` - but it is the task the plan uses to
 * demonstrate the pathfinding failure classification, so its real job is **reporting why**
 * a walk failed in the vocabulary of §3.5 rather than a bare false:
 *
 *   noPath        -> "there is no route through the terrain I know about"
 *   blocked       -> "I got wedged" (the world does not match the snapshot, or a door)
 *   out-of-grid   -> "that is further than I can see; I can only get closer"
 *   timeout       -> "too slow" (usually the same as blocked, from further away)
 *   body-lost     -> "the client is gone"
 *
 * That distinction is what lets the caller decide between "pick another target" and
 * "give up on this area", so it is preserved all the way out to chat.
 */

const { Task } = require('./task');
const { positionReached, horizontalDistance } = require('../planner/verifier');

class GoToTask extends Task {
  /**
   * @param {object} ctx
   * @param {object} options { position?: {x,y,z}, landmark?: string, range?, timeoutMs? }
   */
  constructor(ctx, options = {}) {
    const label = options.landmark || (options.position ? fmt(options.position) : 'nowhere');
    super(ctx, {
      name: options.name || 'go-to',
      description: options.description || `walk to ${label}`,
      timeoutMs: options.timeoutMs || 180000
    });
    this.destination = options.position ? { ...options.position } : null;
    this.landmark = options.landmark || null;
    /**
     * 0.25 by default: the operator needs cell-precise positioning (2026-10-25); the old
     * 2-block arrival radius left the body up to two blocks off the requested point.
     * Callers that want a loose walk (shelter/landmark) can still pass an explicit range.
     */
    this.range = options.range === undefined ? 0.25 : options.range;
  }

  progress() {
    const snap = this.world_state;
    if (!snap || !snap.position) return null;
    const target = this.resolved();
    if (!target) return null;
    return +Math.hypot(target.x - snap.position.x, target.z - snap.position.z).toFixed(2);
  }

  /** Resolve the destination, reading a landmark from memory when one was named. */
  resolved() {
    if (this.destination) return this.destination;
    if (!this.landmark) return null;
    const memory = this.ctx.memory;
    if (!memory || typeof memory.landmark !== 'function') return null;
    const found = memory.landmark(this.landmark);
    if (!found) return null;
    const position = found.position || found;
    if (typeof position.x !== 'number') return null;
    return { x: position.x, y: position.y, z: position.z };
  }

  async run() {
    const body = this.body;
    if (!body) return this.fail('no body attached');

    const target = this.resolved();
    if (!target) {
      return this.fail(
        this.landmark ? `no landmark named "${this.landmark}" in memory` : 'no destination given'
      );
    }
    this.destination = target;

    const from = this.position;
    const started = Date.now();
    let reached = false;
    try {
      reached = await body.moveTo(target, {
        range: this.range,
        timeoutMs: this.timeoutMs - 2000,
        /**
         * The client walker floors a coordinate unless `precise` is set. With a 0.25
         * arrival radius a floored target is unreachable (the cell centre is 0.5 away),
         * so preserve the doubles the operator asked for.
         */
        precise: true
      });
    } catch (err) {
      return this.fail(`walk failed: ${err.message}`);
    }
    const ms = Date.now() - started;

    if (reached) {
      let now = this.position;
      /**
       * A planned walk stops at the goal *cell*, which can be up to ~0.7 blocks from the
       * requested point. With the 0.25 radius that is not arrival, so make one direct
       * precise hop at the exact coordinates before judging the task.
       */
      if (now && !positionReached(now, target, this.range)) {
        try {
          await body.moveTo(target, {
            range: this.range,
            timeoutMs: Math.min(8000, Math.max(2000, this.timeoutMs - ms - 1000)),
            raw: true,
            precise: true
          });
        } catch {
          /* the failure below reports the measured position */
        }
        now = this.position;
      }
      if (now && !positionReached(now, target, this.range)) {
        const off = now ? horizontalDistance(now, target).toFixed(2) : '?';
        return this.fail(`not-arrived: stopped at ${fmt(now)} (${off} blocks) outside ${this.range} of ${fmt(target)}`);
      }
      const travelled = from && now ? +Math.hypot(now.x - from.x, now.z - from.z).toFixed(2) : null;
      return this.succeed(`arrived at ${fmt(target)}${travelled === null ? '' : ` (moved ${travelled} blocks in ${ms}ms)`}`);
    }

    // Prefer the body's own classification over a generic failure.
    const reason = (body.lastMove && body.lastMove.reason) || 'unreachable';
    const now = this.position;
    const where = now ? ` from ${fmt(now)}` : '';
    return this.fail(`${reason}: cannot reach ${fmt(target)}${where}`);
  }

  snapshot() {
    return { ...super.snapshot(), destination: this.destination, landmark: this.landmark, range: this.range };
  }
}

function fmt(position) {
  if (!position) return '(unknown)';
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

module.exports = { GoToTask };
