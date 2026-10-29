'use strict';

/**
 * Step verification against an observation (P1 §1.4, A15/A31).
 *
 * A step declares what must be true before it runs and what must be true after it claims
 * success. Verification is deliberately small and declarative:
 *
 *   preconditions / postconditions:
 *     { inventoryAtLeast: { 'minecraft:iron_ore': 3 },
 *       positionNear: { position: {x,y,z}, range: 2, verticalRange? },
 *       blockAt: { position: {x,y,z}, block: 'minecraft:stone' } }
 *
 * `verifyStep(step, observation)` checks the supplied condition maps. PlanRunner supplies
 * only preconditions BEFORE execution and only postconditions AFTER execution, so consumed
 * inputs are never mistaken for a failed result. Empty maps provide no completion evidence.
 *
 * `positionNear` uses the same measure as the walk primitive it verifies (A13 live
 * 2026-10-20): **horizontal** Euclidean distance against `range`, plus a vertical
 * tolerance (`verticalRange`, default `max(1, range)`). `body.moveTo()`/`GoToTask` decide
 * arrival horizontally - the pathfinder owns the standing height, so a target y that is a
 * solid block ("stand on top of it") is normal and must not make the checkpoint fail by
 * one. Mixing a y-aware Manhattan here with a horizontal Euclidean in goto made a walk
 * that had actually arrived fail its postcondition.
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

/** Horizontal distance - the measure `GoToTask`/`body.moveTo()` use for "arrived". */
function horizontalDistance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Is `actual` close enough to `target`? Horizontal `range` plus a vertical tolerance.
 *
 * Shared by the verifier and `GoToTask` so a step's postcondition and the walk's own
 * arrival can never disagree about what "arrived" means.
 */
function positionReached(actual, target, range = 1, verticalRange) {
  if (!actual || !target) return false;
  if (!['x', 'y', 'z'].every((axis) => Number.isFinite(actual[axis]) && Number.isFinite(target[axis]))) return false;
  const limit = Number(range);
  if (!Number.isFinite(limit) || limit < 0) return false;
  if (horizontalDistance(actual, target) > limit) return false;
  const vertical = verticalRange === undefined ? Math.max(1, limit) : Math.abs(Number(verticalRange));
  if (!Number.isFinite(vertical)) return false;
  return Math.abs(actual.y - target.y) <= vertical;
}

function blockAt(observation, position) {
  if (!observation || !observation.blocks || !position) return undefined;
  const key = `${position.x},${position.y},${position.z}`;
  if (typeof observation.blocks.get === 'function') return observation.blocks.get(key);
  return observation.blocks[key];
}

function checkCondition(condition, observation) {
  const failures = [];
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
    return [{ kind: 'invalid-condition' }];
  }
  for (const key of Object.keys(condition)) {
    if (!['inventoryAtLeast', 'positionNear', 'blockAt', 'targetIs'].includes(key)) {
      failures.push({ kind: 'unsupported-condition', field: key });
    }
  }
  if (condition.inventoryAtLeast !== undefined &&
      (!condition.inventoryAtLeast || typeof condition.inventoryAtLeast !== 'object' || Array.isArray(condition.inventoryAtLeast))) {
    return [...failures, { kind: 'invalid-condition', field: 'inventoryAtLeast' }];
  }
  for (const [item, count] of Object.entries(condition.inventoryAtLeast || {})) {
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
      failures.push({ kind: 'invalid-condition', field: 'inventoryAtLeast', item });
      continue;
    }
    if (!observation || !observation.inventory) {
      failures.push({ kind: 'missing-observation', field: 'inventory', item });
      continue;
    }
    const have = inventoryCount(observation && observation.inventory, item);
    if (!Number.isFinite(have)) failures.push({ kind: 'missing-observation', field: 'inventory', item });
    else if (have < count) failures.push({ kind: 'inventoryAtLeast', item, need: count, have });
  }
  if (condition.positionNear !== undefined) {
    if (!condition.positionNear || typeof condition.positionNear !== 'object' || Array.isArray(condition.positionNear)) {
      return [...failures, { kind: 'invalid-condition', field: 'positionNear' }];
    }
    const { position, range = 1, verticalRange } = condition.positionNear;
    if (!position || !['x', 'y', 'z'].every((axis) => Number.isFinite(position[axis])) ||
        !Number.isFinite(range) || range < 0 ||
        (verticalRange !== undefined && (!Number.isFinite(verticalRange) || verticalRange < 0))) {
      failures.push({ kind: 'invalid-condition', field: 'positionNear' });
      return failures;
    }
    const at = observation && observation.position;
    if (!positionReached(at, position, range, verticalRange)) {
      const horizontal = horizontalDistance(at, position);
      failures.push({
        kind: 'positionNear',
        need: range,
        verticalRange: verticalRange === undefined ? Math.max(1, Number(range) || 0) : verticalRange,
        horizontal: Number.isFinite(horizontal) ? +horizontal.toFixed(2) : null,
        vertical: at && position ? +Math.abs(at.y - position.y).toFixed(2) : null
      });
    }
  }
  if (condition.blockAt !== undefined) {
    if (!condition.blockAt || typeof condition.blockAt !== 'object' || Array.isArray(condition.blockAt)) {
      return [...failures, { kind: 'invalid-condition', field: 'blockAt' }];
    }
    const { position, block } = condition.blockAt;
    if (!position || !['x', 'y', 'z'].every((axis) => Number.isFinite(position[axis])) ||
        typeof block !== 'string' || !block) {
      failures.push({ kind: 'invalid-condition', field: 'blockAt' });
      return failures;
    }
    const found = blockAt(observation, position);
    if (found !== block) failures.push({ kind: 'blockAt', need: block, found: found === undefined ? null : found });
  }
  if (condition.targetIs !== undefined) {
    failures.push(...checkTargetIs(condition.targetIs, observation));
  }
  return failures;
}

/**
 * `targetIs`: the crosshair points at the expected block or entity.
 *
 * Before this existed, `lookat` had no postcondition at all - a step could claim "looked at
 * the crafting table" while the view was elsewhere. The observation carries the mod's
 * `target` ({type,name,position,...}) from the same raycast the game uses for the outline.
 *
 * Spec: { name?: string, position?: {x,y,z}, type?: 'block'|'entity' } - all optional, and at
 * least one must be present; `position` matches within 0.5 of the block/entity centre.
 */
function checkTargetIs(spec, observation) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return [{ kind: 'invalid-condition', field: 'targetIs' }];
  }
  const hasName = typeof spec.name === 'string' && spec.name.length > 0;
  const hasPosition = spec.position && ['x', 'y', 'z'].every((axis) => Number.isFinite(spec.position[axis]));
  const hasType = spec.type === 'block' || spec.type === 'entity';
  if (!hasName && !hasPosition && !hasType) {
    return [{ kind: 'invalid-condition', field: 'targetIs' }];
  }
  const seen = observation && observation.target;
  if (!seen || typeof seen !== 'object') {
    return [{ kind: 'targetIs', reason: 'no-target', need: spec, found: null }];
  }
  const failures = [];
  if (hasType && seen.type !== spec.type) {
    failures.push({ kind: 'targetIs', field: 'type', need: spec.type, found: seen.type === undefined ? null : seen.type });
  }
  if (hasName && String(seen.name || '') !== spec.name) {
    failures.push({ kind: 'targetIs', field: 'name', need: spec.name, found: seen.name === undefined ? null : seen.name });
  }
  if (hasPosition) {
    const at = seen.position || {};
    const close = ['x', 'y', 'z'].every((axis) => Number.isFinite(at[axis]) && Math.abs(at[axis] - spec.position[axis]) <= 0.5);
    if (!close) {
      failures.push({
        kind: 'targetIs',
        field: 'position',
        need: spec.position,
        found: ['x', 'y', 'z'].every((axis) => Number.isFinite(at[axis]))
          ? { x: at.x, y: at.y, z: at.z }
          : null
      });
    }
  }
  return failures;
}

/** Empty/unknown condition maps are not evidence for completing a partial task. */
function hasConditions(condition) {
  return !!condition && (
    Object.keys(condition.inventoryAtLeast || {}).length > 0 ||
    !!condition.positionNear || !!condition.blockAt || !!condition.targetIs
  );
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

module.exports = {
  hasConditions,
  verifyStep,
  verifyPlan,
  checkCondition,
  inventoryCount,
  horizontalDistance,
  positionReached
};
