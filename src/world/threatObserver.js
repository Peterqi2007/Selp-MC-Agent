'use strict';

/**
 * ThreatObserver - edge-triggered threat events from snapshots (P1 §1.5.3).
 *
 * The fast loop already reacts to threats every tick; this class is the *event* side the
 * plan asks for: a model wake-up should happen when a hostile **enters or leaves** the
 * configured radius, not on every poll. It therefore:
 *
 *   - keeps the set of threats currently inside the radius;
 *   - emits `enter` once per entity, and again only after it has left and re-entered;
 *   - emits `leave` when the entity is gone or the snapshot stops being ready;
 *   - never calls a model, never starts a task, never touches the body.
 *
 * Entity identity prefers `id`; a nameless/id-less hostile falls back to a position key, so
 * a snapshot without ids still produces sensible edges.
 */

function distanceTo(snapshot, threat) {
  if (!threat || !threat.position) return Infinity;
  if (Number.isFinite(threat.distance)) return threat.distance;
  const origin = snapshot && snapshot.position;
  if (!origin) return Infinity;
  const dx = threat.position.x - origin.x;
  const dy = threat.position.y - origin.y;
  const dz = threat.position.z - origin.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function keyOf(threat) {
  if (threat && threat.id !== undefined && threat.id !== null) return `id:${threat.id}`;
  if (threat && threat.position) {
    return `pos:${threat.position.x},${threat.position.y},${threat.position.z}`;
  }
  return `name:${(threat && threat.name) || 'unknown'}`;
}

class ThreatObserver {
  constructor(options = {}) {
    this.radius = options.radius === undefined ? 8 : options.radius;
    this.now = options.now || (() => Date.now());
    this.log = options.log || { info() {}, warn() {}, debug() {} };
    /** @type {Map<string, {name:string, position:object, distance:number}>} */
    this.active = new Map();
    /** @type {Set<(event:object)=>void>} */
    this.subscribers = new Set();
  }

  /**
   * @param {object|null} snapshot body snapshot
   * @returns {Array<{type:'threat:enter'|'threat:leave', threat:object, at:string}>} emitted events
   */
  observe(snapshot) {
    const events = [];
    const seen = new Set();
    const ready = !!(snapshot && snapshot.ready);

    if (ready) {
      for (const hostile of snapshot.hostiles || []) {
        const distance = distanceTo(snapshot, hostile);
        if (!(distance <= this.radius)) continue;
        const key = keyOf(hostile);
        seen.add(key);
        if (this.active.has(key)) continue;
        const threat = {
          key,
          id: hostile.id === undefined ? null : hostile.id,
          name: hostile.name || null,
          position: hostile.position ? { ...hostile.position } : null,
          distance: Number.isFinite(distance) ? distance : null
        };
        this.active.set(key, threat);
        events.push({ type: 'threat:enter', threat: { ...threat }, at: new Date(this.now()).toISOString() });
      }
    }

    if (!ready) {
      // A non-ready snapshot is not evidence that the threats are still there.
      this.active.clear();
    } else {
      for (const [key, threat] of this.active) {
        if (seen.has(key)) continue;
        this.active.delete(key);
        events.push({ type: 'threat:leave', threat: { ...threat }, at: new Date(this.now()).toISOString() });
      }
    }

    for (const event of events) this._emit(event);
    return events;
  }

  /** @returns {() => void} unsubscribe */
  subscribe(handler) {
    if (typeof handler !== 'function') throw new Error('subscribe needs a function');
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  status() {
    return { radius: this.radius, active: [...this.active.values()].map((threat) => ({ ...threat })) };
  }

  _emit(event) {
    for (const handler of this.subscribers) {
      try {
        handler(event);
      } catch (err) {
        this.log.warn(`threat observer subscriber failed: ${err.message}`);
      }
    }
  }
}

module.exports = { ThreatObserver, keyOf, distanceTo };
