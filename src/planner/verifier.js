'use strict';

/**
 * Step verification against an observation (P1 §1.4, A15/A31).
 *
 * A step declares what must be true before it runs and what must be true after it claims
 * success. Verification is deliberately small and declarative:
 *
 *   preconditions / postconditions:
 *     { inventoryAtLeast: { 'minecraft:iron_ore': 3 },
 *       positionNear: { position: {x,y,z}, range: 2 },
 *       blockAt: { position: {x,y,z}, block: 'minecraft:stone' } }
 *
 * `verifyStep(step, observation)` fails at the first stage that does not hold; a task that
 * returned ok but did not change the inventory is therefore *not* silently accepted - the
 * postcondition fails and the caller can replan.
 *
 * The observation is plain data (`inventory` counts, `position`, `blocks` keyed by
 * "x,y,z"); nothing here reads the world or starts a scan.
 */

function inventoryCount(inventory, item) {
  if (!inventory) return 0;
  if (Array.isArray(inventory)) {
    return inventory.filter((entry) => entry && entry.name === item).reduce((sum, entry) => sum + (entry.count || 0), 0);
  }
  return Number(inventory[item] || 0);
}

function samePosition(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
}

function blockAt(observation, position) {
  if (!observation || !observation.blocks || !position) return undefined;
  const key = `${position.x},${position.y},${position.z}`;
  if (typeof observation.blocks.get === 'function') return observation.blocks.get(key);
  return observation.blocks[key];
}

function checkCondition(condition, observation) {
  const failures = [];
  for (const [item, count] of Object.entries(condition.inventoryAtLeast || {})) {
    const have = inventoryCount(observation && observation.inventory, item);
    if (have < count) failures.push({ kind: 'inventoryAtLeast', item, need: count, have });
  }
  if (condition.positionNear) {
    const { position, range = 1 } = condition.positionNear;
    const at = observation && observation.position;
    const distance = at ? Math.abs(at.x - position.x) + Math.abs(at.y - position.y) + Math.abs(at.z - position.z) : Infinity;
    if (distance > range) failures.push({ kind: 'positionNear', need: range, distance });
  }
  if (condition.blockAt) {
    const { position, block } = condition.blockAt;
    const found = blockAt(observation, position);
    if (found !== block) failures.push({ kind: 'blockAt', need: block, found: found === undefined ? null : found });
  }
  return failures;
}

/**
 * @param {object} step { id, preconditions?, postconditions? }
 * @param {object} observation
 * @returns {{ok:boolean, stage:string|null, failures:Array}}
 */
function verifyStep(step, observation) {
  const before = checkCondition(step.preconditions || {}, observation);
  if (before.length) return { ok: false, stage: 'precondition', failures: before };
  const after = checkCondition(step.postconditions || {}, observation);
  if (after.length) return { ok: false, stage: 'postcondition', failures: after };
  return { ok: true, stage: null, failures: [] };
}

/** Verify all steps the plan still has to run. */
function verifyPlan(plan, observation) {
  const results = [];
  for (const step of (plan && plan.steps) || []) {
    if (step.status === 'done') continue;
    results.push({ stepId: step.id, ...verifyStep(step, observation) });
  }
  return { ok: results.every((result) => result.ok), results };
}

module.exports = { verifyStep, verifyPlan, checkCondition, inventoryCount };
