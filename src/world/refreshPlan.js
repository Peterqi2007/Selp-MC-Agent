'use strict';

/**
 * Refresh planning for perception fields (P1 §1.5.2).
 *
 * The client body currently fetches everything with one `/state` call, so this module is a
 * contract for the *next* step (per-purpose endpoints): given the snapshot's field ages and
 * a per-field budget, decide which fields are worth refreshing and which are critical.
 *
 * It is pure: it does not call the body, start a scan or trigger a model. That keeps the
 * policy testable while the collection boundary is still being measured (M0-C1).
 */

const { staleFields } = require('./freshness');

const DEFAULT_BUDGET = {
  position: 500,
  health: 500,
  hostiles: 750,
  inventory: 2000,
  players: 2000,
  nearbyItems: 1000,
  blocks: 5000,
  time: 5000,
  crops: 5000
};

const CRITICAL = ['hostiles', 'health', 'position'];

/**
 * @param {object} snapshot
 * @param {object} [options] { now, budgets, maxFields, critical }
 * @returns {{stale:Array, refresh:string[], criticalStale:Array, needsRefresh:boolean}}
 */
function planRefresh(snapshot, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const budgets = options.budgets || DEFAULT_BUDGET;
  const maxFields = options.maxFields === undefined ? 3 : options.maxFields;
  const critical = options.critical || CRITICAL;
  const stale = staleFields(snapshot, budgets, now);
  return {
    stale,
    refresh: stale.slice(0, Math.max(0, maxFields)).map((entry) => entry.field),
    criticalStale: stale.filter((entry) => critical.includes(entry.field)),
    needsRefresh: stale.length > 0
  };
}

module.exports = { planRefresh, DEFAULT_BUDGET, CRITICAL };
