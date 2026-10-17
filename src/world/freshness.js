'use strict';

/**
 * Field freshness for perception (P1 M2, §1.5.3).
 *
 * The snapshot used to look uniformly fresh even when one field was seconds old. This module
 * attaches a per-field `observedAt` stamp and answers the two questions the scheduler needs:
 *
 *   - how old is this field? (missing stamp = Infinity, i.e. never observed);
 *   - which fields are older than their budget?
 *
 * It is deliberately pure and additive: callers stamp the fields they actually refreshed, and
 * nothing here starts a scan or a model turn. Wiring it into the client-mod poll is part of
 * the measured M2 work.
 */

const DEFAULT_FIELDS = ['position', 'inventory', 'entities', 'blocks', 'health', 'time'];

/**
 * Stamp the fields that are present in the snapshot with `now`.
 *
 * @param {object} snapshot
 * @param {object} [options] { now, fields }
 * @returns {object} a new snapshot with `observedAt`
 */
function stampSnapshot(snapshot, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const fields = options.fields || DEFAULT_FIELDS;
  const observedAt = { ...(snapshot && snapshot.observedAt) };
  for (const field of fields) {
    if (snapshot && snapshot[field] !== undefined) observedAt[field] = now;
  }
  return { ...(snapshot || {}), observedAt };
}

/** Age in ms; Infinity means the field was never observed. */
function fieldAge(snapshot, field, now = Date.now()) {
  const at = snapshot && snapshot.observedAt ? snapshot.observedAt[field] : undefined;
  return typeof at === 'number' ? Math.max(0, now - at) : Infinity;
}

/**
 * @param {object} snapshot
 * @param {Record<string, number>} budget field -> max age ms
 * @param {number} [now]
 * @returns {Array<{field:string, ageMs:number, budgetMs:number}>} stale fields, oldest first
 */
function staleFields(snapshot, budget = {}, now = Date.now()) {
  const stale = [];
  for (const [field, budgetMs] of Object.entries(budget)) {
    const ageMs = fieldAge(snapshot, field, now);
    if (ageMs > budgetMs) stale.push({ field, ageMs, budgetMs });
  }
  return stale.sort((a, b) => b.ageMs - a.ageMs);
}

module.exports = { stampSnapshot, fieldAge, staleFields, DEFAULT_FIELDS };
