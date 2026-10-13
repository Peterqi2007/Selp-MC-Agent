'use strict';

/**
 * Cross-run combat memory (docs/COMBAT-PLAN.md §②/§③).
 *
 * Two facts must survive individual skill calls:
 *
 *  - **Ignored targets.** A fight that makes no contact for 30s is abandoned and the
 *    target is skipped by target selection for a while. That live bug: a zombie at 3.4
 *    blocks survived three full 15s attack runs while nobody landed or took a hit (it was
 *    behind terrain) - the reflex re-engaged it forever. Getting into melee reach (≤3)
 *    clears the ignore: at that distance it can be hit.
 *
 *  - **The contactless clock.** It accumulates across attack runs, and any health loss on
 *    our side resets it - being hit means contact happened, whatever the cause.
 *
 *  - **The combat lease.** While attack/defend/shoot is executing - whatever the caller:
 *    a `!` command, the LLM actuator or the reflex's own chain - the fast loop must not
 *    start a second fight. Live 2026-10-13: the explicit `!shoot` (run straight through
 *    the skill registry, bypassing the task hub) and a reflex `shoot` replaced each
 *    other's bursts until a melee fallback swapped the gun out of the hand and both
 *    flows died with not_a_gun - the "hub task in progress" guard never saw the command.
 *
 * Deliberately process-local: the operator restarts the agent to clear it.
 */

const IGNORE_TTL_MS = 180000;
const STALL_MS = 30000;
const STALL_RANGE = 5;
const OVERRIDE_RANGE = 3;

/** The stall threshold is a constant in production; tests shrink it via setStallMs. */
let stallMs = STALL_MS;

/** target id -> ignore expiry timestamp. */
const ignored = new Map();
/** target id -> { since, distance }: the current contactless streak. */
const engaged = new Map();

function ignore(id, ttlMs = IGNORE_TTL_MS) {
  if (id === undefined || id === null) return;
  ignored.set(id, Date.now() + ttlMs);
}

function isIgnored(id) {
  const until = ignored.get(id);
  if (!until) return false;
  if (Date.now() > until) {
    ignored.delete(id);
    engaged.delete(id);
    return false;
  }
  return true;
}

/**
 * Should target selection skip this id?
 *
 * Ignored, unless it has closed into melee reach - at ≤3 blocks it is hittable, and the
 * ignore exists because it was NOT hittable.
 */
function shouldSkip(id, distance) {
  if (!isIgnored(id)) return false;
  if (Number.isFinite(distance) && distance <= OVERRIDE_RANGE) return false;
  return true;
}

/** Record that we are (still) fighting this target; the streak clock starts once. */
function rememberEngagement(id, distance) {
  if (id === undefined || id === null) return;
  const prev = engaged.get(id);
  engaged.set(id, {
    since: prev ? prev.since : Date.now(),
    distance: Number.isFinite(distance) ? distance : prev ? prev.distance : null
  });
}

/** Any health loss means contact happened: restart every contactless clock. */
function noteHealthDrop() {
  engaged.clear();
}

/**
 * Live combat-skill lease (see the header note).
 *
 * A depth counter rather than a boolean: a reflex shoot can hand over to its melee
 * fallback before the first call's `finally` runs, and those are two lease lifetimes.
 */
let combatDepth = 0;
let combatSkillName = null;

function beginCombatSkill(name) {
  combatDepth += 1;
  combatSkillName = String(name || 'combat');
}

function endCombatSkill() {
  combatDepth = Math.max(0, combatDepth - 1);
  if (combatDepth === 0) combatSkillName = null;
}

/** True while a combat skill is executing; the reflex must not double-engage. */
function combatSkillActive() {
  return combatDepth > 0;
}

/** Name of the running combat skill (null when idle) - for logs and tests. */
function activeCombatSkillName() {
  return combatSkillName;
}

/** True when the target sits ≤5 blocks and nothing has touched us for 30s. */
function isStalled(id) {
  const record = engaged.get(id);
  if (!record) return false;
  const inRange = record.distance !== null && record.distance <= STALL_RANGE;
  return inRange && Date.now() - record.since >= stallMs;
}

/** Test hooks; production state is intentionally process-local and never reset. */
function setStallMs(ms) {
  stallMs = Number.isFinite(ms) && ms > 0 ? ms : STALL_MS;
}

function reset() {
  ignored.clear();
  engaged.clear();
  stallMs = STALL_MS;
  combatDepth = 0;
  combatSkillName = null;
}

module.exports = {
  ignore,
  isIgnored,
  shouldSkip,
  rememberEngagement,
  noteHealthDrop,
  beginCombatSkill,
  endCombatSkill,
  combatSkillActive,
  activeCombatSkillName,
  isStalled,
  setStallMs,
  reset,
  IGNORE_TTL_MS,
  STALL_MS,
  STALL_RANGE
};
