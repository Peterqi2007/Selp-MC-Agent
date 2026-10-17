'use strict';

/**
 * MethodLibrary - a small, offline method store for "how do I do X here" (P1 M3).
 *
 * A method is not a task: it is a remembered approach (goal + steps + conditions) with a
 * success/failure count. Retrieval ranks by:
 *
 *   1. goal match (exact > substring/token overlap);
 *   2. conditions that agree with the current context (soft: disagreeing conditions lose
 *      points, absent context is neutral - we do not pretend to know what we did not observe);
 *   3. a Laplace-smoothed success rate, so one lucky attempt cannot outrank a proven method;
 *
 * No search engine, no model: this is the local half of "方法检索". A learned method from a
 * future web/player source plugs into `add({source:'learned'|'player'})`.
 */

class MethodLibrary {
  constructor(options = {}) {
    this.limit = options.limit || 200;
    this.now = options.now || (() => Date.now());
    this.methods = new Map();
    this.seq = 0;
  }

  /**
   * @param {object} input { id?, goal, method, conditions?, source? }
   * @returns {object} the stored method
   */
  add(input = {}) {
    if (!input.goal || !input.method) throw new Error('MethodLibrary.add needs goal and method');
    const id = input.id || `m${++this.seq}`;
    const method = {
      id,
      goal: String(input.goal),
      method: String(input.method),
      conditions: { ...(input.conditions || {}) },
      source: input.source || 'local',
      success: Number(input.success) || 0,
      failure: Number(input.failure) || 0,
      createdAt: input.createdAt || new Date(this.now()).toISOString(),
      lastUsedAt: input.lastUsedAt || null
    };
    this.methods.set(id, method);
    while (this.methods.size > this.limit) {
      this.methods.delete(this.methods.keys().next().value);
    }
    return { ...method, conditions: { ...method.conditions } };
  }

  /**
   * @param {string} goal
   * @param {object} context observed conditions (biome, dimension, tool, ...)
   * @param {object} [options] { limit }
   * @returns {Array<{method:object, score:number}>} best first
   */
  search(goal, context = {}, options = {}) {
    const query = String(goal || '').trim().toLowerCase();
    if (!query) return [];
    const limit = options.limit || 3;
    return [...this.methods.values()]
      .map((method) => ({ method, score: this._score(method, query, context) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => ({ method: { ...entry.method, conditions: { ...entry.method.conditions } }, score: entry.score }));
  }

  /** Evidence that a method worked (or did not) in this world. */
  recordOutcome(id, ok) {
    const method = this.methods.get(id);
    if (!method) return false;
    if (ok) method.success += 1;
    else method.failure += 1;
    method.lastUsedAt = new Date(this.now()).toISOString();
    return true;
  }

  status() {
    return { methods: this.methods.size, last: [...this.methods.values()].slice(-1)[0] || null };
  }

  toJSON() {
    return { seq: this.seq, methods: [...this.methods.values()] };
  }

  restore(data) {
    if (!data || !Array.isArray(data.methods)) return false;
    this.methods.clear();
    this.seq = Number(data.seq) || 0;
    for (const method of data.methods) {
      if (!method || !method.id || !method.goal || !method.method) continue;
      this.methods.set(method.id, {
        ...method,
        conditions: { ...(method.conditions || {}) },
        success: Number(method.success) || 0,
        failure: Number(method.failure) || 0
      });
    }
    return true;
  }

  _score(method, query, context) {
    let score = 0;
    const goal = method.goal.toLowerCase();
    if (goal === query) score += 10;
    else if (goal.includes(query) || query.includes(goal)) score += 6;
    else {
      const wanted = new Set(query.split(/\s+/).filter(Boolean));
      const have = goal.split(/\s+/).filter(Boolean);
      const overlap = have.filter((token) => wanted.has(token)).length;
      if (!overlap) return 0;
      score += overlap * 2;
    }

    for (const [key, value] of Object.entries(method.conditions || {})) {
      if (context[key] === undefined || context[key] === null) continue; // unknown is neutral
      if (String(context[key]) === String(value)) score += 2;
      else score -= 2;
    }

    const total = method.success + method.failure;
    score += ((method.success + 1) / (total + 2)) * 3;
    return score;
  }
}

module.exports = { MethodLibrary };
