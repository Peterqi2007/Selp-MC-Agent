'use strict';

/**
 * Finite budgets for planning work (P1 §1.4, A15).
 *
 * P1 is explicit that searches, replans and retries are finite, and that the numbers are a
 * starting point, not a measurement. This class owns the counting only:
 *
 *   - `spend(kind)` refuses once the limit is reached;
 *   - `reset()` starts a new round after new information, while `total` keeps the cumulative
 *     consumption so a later report can say what the whole goal cost;
 *   - time is not modelled here - duration must be measured, not guessed.
 *
 * Default limits are the plan's initial suggestions (3 searches, 2 replans, 2 retries).
 */

const DEFAULT_LIMITS = { searches: 3, replans: 2, retries: 2 };

class Budget {
  constructor(options = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) };
    this.spent = {};
    this.total = {};
  }

  /** @returns {{ok:boolean, kind:string, remaining:number, reason?:string}} */
  spend(kind, amount = 1) {
    if (!(kind in this.limits)) throw new Error(`unknown budget kind: ${kind}`);
    const used = this.spent[kind] || 0;
    if (used + amount > this.limits[kind]) {
      return { ok: false, kind, remaining: 0, reason: 'budget-exhausted' };
    }
    this.spent[kind] = used + amount;
    this.total[kind] = (this.total[kind] || 0) + amount;
    return { ok: true, kind, remaining: this.limits[kind] - this.spent[kind] };
  }

  remaining(kind) {
    if (!(kind in this.limits)) throw new Error(`unknown budget kind: ${kind}`);
    return this.limits[kind] - (this.spent[kind] || 0);
  }

  exhausted(kind) {
    return this.remaining(kind) <= 0;
  }

  /** New information arrived: a fresh round, cumulative totals preserved. */
  reset() {
    this.spent = {};
    return this.status();
  }

  status() {
    const remaining = {};
    for (const kind of Object.keys(this.limits)) remaining[kind] = this.remaining(kind);
    return { limits: { ...this.limits }, spent: { ...this.spent }, total: { ...this.total }, remaining };
  }

  /** Persist counters and limits (A29: a restart reports the same cumulative cost). */
  toJSON() {
    return { limits: { ...this.limits }, spent: { ...this.spent }, total: { ...this.total } };
  }

  /** Restore a persisted snapshot; unknown counters are dropped rather than trusted. */
  restore(data) {
    if (!data || typeof data !== 'object') return false;
    if (data.limits && typeof data.limits === 'object') {
      const limits = {};
      for (const [kind, value] of Object.entries(data.limits)) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) limits[kind] = number;
      }
      this.limits = { ...DEFAULT_LIMITS, ...limits };
    }
    this.spent = {};
    this.total = {};
    for (const field of ['spent', 'total']) {
      const source = data[field];
      if (!source || typeof source !== 'object') continue;
      for (const [kind, value] of Object.entries(source)) {
        const number = Number(value);
        if (Number.isFinite(number) && number >= 0) this[field][kind] = number;
      }
    }
    return true;
  }
}

module.exports = { Budget, DEFAULT_LIMITS };
