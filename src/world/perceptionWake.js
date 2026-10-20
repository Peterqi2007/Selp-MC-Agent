'use strict';

/**
 * PerceptionWake - edge-triggered "something changed" events for the perception layer.
 *
 * A09 forbids model calls on pure sampling. A11 requires the opposite only for *meaningful
 * changes*: a threat enters/leaves, weather flips, day becomes night, or a player sends a
 * chat message. This class is the seam between the 500ms snapshot poll and the model:
 *
 *   - it never starts a scan and never calls a model itself;
 *   - it emits one event per edge/key, with a cooldown for repeated chat lines;
 *   - `subscribe()` is where the model wake policy is attached, so the sampling loop and
 *     the model consumer stay separable and testable.
 *
 * The ThreatObserver already owns threat enter/leave edge semantics; this class composes it
 * with weather/phase/chat edges rather than duplicating that logic.
 */

const { ThreatObserver } = require('./threatObserver');

function fingerprint(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

class PerceptionWake {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.log = options.log || { info() {}, warn() {}, debug() {} };
    this.chatCooldownMs = options.chatCooldownMs === undefined ? 5000 : options.chatCooldownMs;
    this.threats = new ThreatObserver({
      radius: options.radius === undefined ? 8 : options.radius,
      now: this.now,
      log: this.log
    });
    this.subscribers = new Set();
    this.seq = 0;
    this.counts = {};
    this.last = null;
    /** Bounded edge history for the behavior-brain `mc_perception` tool. */
    this.historyLimit = options.historyLimit || 100;
    this.history = [];
    this._weather = undefined;
    this._isDay = undefined;
    this._chatAt = new Map();
  }

  /**
   * Feed one snapshot. Returns only the edges produced by this call.
   *
   * Called once per fast loop tick; an unchanging snapshot returns [] and never wakes a
   * consumer. The ThreatObserver's radius is the only "area" this layer tracks.
   */
  observe(snapshot) {
    const events = [];
    for (const event of this.threats.observe(snapshot)) {
      events.push({ ...event, reason: 'threat' });
    }

    if (snapshot && snapshot.ready) {
      const raining = !!(snapshot.weather && snapshot.weather.raining);
      if (this._weather !== undefined && raining !== this._weather) {
        events.push({
          type: 'weather:change',
          reason: 'weather',
          detail: raining ? '开始下雨' : '雨停了',
          at: new Date(this.now()).toISOString()
        });
      }
      this._weather = raining;

      const isDay = snapshot.time ? snapshot.time.isDay !== false : undefined;
      if (this._isDay !== undefined && isDay !== undefined && isDay !== this._isDay) {
        events.push({
          type: 'phase:change',
          reason: 'phase',
          detail: isDay ? '天亮了' : '天黑了',
          at: new Date(this.now()).toISOString()
        });
      }
      this._isDay = isDay;
    }

    for (const event of events) this._emit(event);
    return events;
  }

  /**
   * A player chat line. Repeated identical lines inside the cooldown are ignored, which is
   * what "repeated observation must not repeat a proposal" means at this layer.
   */
  noteChat(text, from = null) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const key = fingerprint(clean);
    const now = this.now();
    const last = this._chatAt.get(key);
    if (last !== undefined && now - last < this.chatCooldownMs) return null;
    this._chatAt.set(key, now);
    const event = {
      type: 'chat:message',
      reason: 'chat',
      detail: clean.slice(0, 160),
      from: from || null,
      at: new Date(now).toISOString()
    };
    this._emit(event);
    return event;
  }

  subscribe(handler) {
    if (typeof handler !== 'function') throw new Error('subscribe needs a function');
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /**
   * Read recent edges, optionally only one type family (`threat`, `weather`, `phase`,
   * `chat`). The behavior brain's `mc_perception` tool uses this instead of guessing from
   * the latest snapshot.
   *
   * @param {object} [options] { type, since, limit }
   * @returns {Array<object>}
   */
  events(options = {}) {
    const since = Number(options.since) || 0;
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 100);
    const type = options.type && options.type !== 'all' ? String(options.type) : null;
    return this.history
      .filter((event) => event.seq > since)
      .filter((event) => !type || event.type === type || event.type.startsWith(`${type}:`))
      .slice(-limit);
  }

  /** Latest edge of one type family, or the global latest. */
  latest(type = null) {
    if (!type || type === 'all') return this.last;
    for (let index = this.history.length - 1; index >= 0; index -= 1) {
      const event = this.history[index];
      if (event.type === type || event.type.startsWith(`${type}:`)) return event;
    }
    return null;
  }

  status() {
    return {
      seq: this.seq,
      counts: { ...this.counts },
      last: this.last,
      history: this.history.length,
      weather: this._weather,
      isDay: this._isDay,
      threats: this.threats.status()
    };
  }

  _emit(event) {
    this.seq += 1;
    this.counts[event.type] = (this.counts[event.type] || 0) + 1;
    this.last = { ...event, seq: this.seq };
    this.history.push(this.last);
    while (this.history.length > this.historyLimit) this.history.shift();
    for (const handler of this.subscribers) {
      try {
        handler(this.last);
      } catch (err) {
        this.log.warn(`perception wake subscriber failed: ${err.message}`);
      }
    }
  }
}

module.exports = { PerceptionWake, fingerprint };
