'use strict';

/**
 * ResumeBridge - delivers "this turn can continue" exactly once (P1 M3, A28).
 *
 * The pieces already exist: a task completion reaches `HarnessAdapter`, which parks it in
 * `TurnLifecycle` as `resumable`. Something still has to *wake the harness*. That is this
 * bridge. It is transport-free: `deliver(turn, event)` is the injection point, and the real
 * DSH plugin will implement it by sending a resume event over the same-port SSE channel.
 *
 * Guarantees:
 *   - one delivery per parked turn (a duplicate completion cannot wake it twice);
 *   - a turn that is cancelled or no longer `resumable` is dropped, not delivered;
 *   - `adapter.resume()` runs only after `deliver()` succeeded, so a failed send keeps the
 *     event parked and retries on the next `flush()` instead of losing it;
 *   - delivery is serialized, so two tasks cannot resume the same harness session at once.
 */

class ResumeBridge {
  /**
   * @param {object} deps { adapter, turns, deliver, log }
   */
  constructor(deps = {}) {
    this.adapter = deps.adapter;
    this.turns = deps.turns;
    this.deliver = deps.deliver;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    if (!this.adapter || !this.turns || typeof this.deliver !== 'function') {
      throw new Error('ResumeBridge needs adapter, turns and deliver()');
    }
    this.queue = [];
    this.flushing = false;
    this.adapter.onResumable = (turn, event) => this.enqueue(turn, event);
  }

  /** Called by the adapter when a task event makes a turn resumable. */
  enqueue(turn, event) {
    if (!turn || !turn.id) return false;
    if (this.queue.some((item) => item.turnId === turn.id)) return false;
    this.queue.push({ turnId: turn.id, event: event ? { ...event } : null });
    this.flush();
    return true;
  }

  /** Deliver queued resumes in order. Safe to call repeatedly; one loop at a time. */
  async flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length) {
        const item = this.queue[0];
        const turn = this.turns.get(item.turnId);
        if (!turn || turn.state !== 'resumable') {
          this.queue.shift();
          continue;
        }
        try {
          await this.deliver(turn, item.event);
        } catch (err) {
          this.log.warn(`resume delivery failed for ${item.turnId}: ${err.message}`);
          return; // keep the item; retry on the next flush
        }
        this.queue.shift();
        const resumed = this.adapter.resume(item.turnId);
        if (!resumed.ok) this.log.warn(`resume refused for ${item.turnId}: ${resumed.reason}`);
      }
    } finally {
      this.flushing = false;
    }
  }

  status() {
    return { pending: this.queue.length, flushing: this.flushing };
  }
}

module.exports = { ResumeBridge };
