'use strict';

/**
 * TaskEvents - the single event hub for task lifecycle facts (P1 §1.4.4).
 *
 * Before M1 there were two emitters (`Brain`'s listener map and `TaskHub`) and no way for a
 * second process to see a completion without polling. This class is the one place that
 * assigns an order and an identity to every task event:
 *
 *     { seq, eventId, type, at, requestId, planId, stepId, taskId, attemptId, status, ... }
 *
 * Guarantees:
 *   - **monotonic `seq`** - consumers can persist "last seen seq" instead of guessing;
 *   - **idempotent publish** - a duplicate `eventId` is dropped, so a retried producer or a
 *     re-delivery cannot make the same completion count twice;
 *   - **bounded replay** - `since(seq)` serves the ring buffer, which is what SSE uses for
 *     `Last-Event-ID` reconnects; the ring size is deliberately small;
 *   - **no I/O** - publishing never awaits a socket. Subscribers are notified after the
 *     event is stored, and a throwing subscriber cannot break the producer.
 *
 * The ring is in memory: restart recovery (A17/A29) will read the persisted task ledger in a
 * later milestone, not this buffer.
 */

class TaskEvents {
  /**
   * @param {object} [options] { limit, now }
   */
  constructor(options = {}) {
    this.limit = options.limit || 500;
    this.now = options.now || (() => Date.now());
    this.seq = 0;
    /** @type {Array<object>} bounded, oldest first */
    this.log = [];
    /** eventId -> seq, used for dedupe */
    this.seen = new Map();
    /** @type {Set<(event:object)=>void>} */
    this.subscribers = new Set();
  }

  /**
   * Store one event and notify subscribers. Returns the stored event, or null for a
   * duplicate.
   *
   * @param {object} input must carry `type`; identity fields are optional but recommended
   */
  publish(input) {
    if (!input || typeof input.type !== 'string' || !input.type) {
      throw new Error('TaskEvents.publish needs an event with a type');
    }
    const eventId =
      input.eventId ||
      [input.type, input.taskId || '', input.attemptId || '', input.status || input.reason || ''].join('|');
    if (this.seen.has(eventId)) return null;

    const event = {
      ...input,
      eventId,
      seq: ++this.seq,
      at: input.at || new Date(this.now()).toISOString()
    };
    this.seen.set(eventId, event.seq);
    this.log.push(event);
    while (this.log.length > this.limit) {
      const dropped = this.log.shift();
      this.seen.delete(dropped.eventId);
    }

    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        /* a subscriber must never break the producer */
      }
    }
    return event;
  }

  /** Events with `seq > lastSeq`, oldest first (SSE replay, panel tail). */
  since(lastSeq = 0) {
    const from = Number(lastSeq) || 0;
    return this.log.filter((event) => event.seq > from);
  }

  /** Subscribe to new events. Returns an unsubscribe function. */
  subscribe(handler) {
    if (typeof handler !== 'function') throw new Error('TaskEvents.subscribe needs a function');
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** Small, JSON-safe summary for `/status` and tests. */
  status() {
    const last = this.log[this.log.length - 1] || null;
    return {
      seq: this.seq,
      size: this.log.length,
      limit: this.limit,
      subscribers: this.subscribers.size,
      last: last ? { seq: last.seq, type: last.type, taskId: last.taskId || null } : null
    };
  }
}

module.exports = { TaskEvents };
