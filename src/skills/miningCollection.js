'use strict';

/**
 * Mining collection: bounded stand selection and pickup confirmation for one AcquisitionGoal.
 *
 * This is the "shared collector" both paths call (docs/MINING-COLLECTION-PLAN.md §5/§6):
 * the deterministic macro uses `mode=macro` with terrain edits and a small pillar budget;
 * the LLM recovery path uses `mode=recovery` for one local move plus a bounded confirmation.
 * Neither mode hides a ten-step dig or another model call inside a collect command.
 *
 * Ground rules from the plan:
 *   - movement never verifies a pickup; only inventory evidence does (§5.1);
 *   - every await re-checks cancellation and the deadline before the next side effect;
 *   - a stand must have solid floor, two free body cells and a safe neighbourhood, and it
 *     must not be built out of the target ore or the drop's own support;
 *   - when the drop hangs above the feet, climbing reuses the P4 pillar executor through
 *     the caller's `climbTo` callback - one shared physical implementation.
 */

const { bare } = require('../world/items');
const { observeAcquisition, verifyAcquisition } = require('./miningAcquisition');

const DEFAULTS = {
  /** Candidate stand search: horizontal radius and vertical span around the drop. */
  standRadiusXZ: 2,
  standRangeY: 3,
  /** Local budget per attemptCollection call. */
  maxLocalStands: 3,
  maxLocalEdits: 6,
  maxLocalPillarSteps: 2,
  /** Bounded confirms; never "arrived so it must be picked". */
  pickupConfirmMs: 2500,
  dropSpawnWaitMs: 2000,
  maxGoalCollectionMs: 45000
};

function cellKey(cell) {
  return `${cell.x},${cell.y},${cell.z}`;
}

function sameCell(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
}

/**
 * Deterministic candidate stands for the visible pending drops (plan §5.2).
 *
 * @param {object} snapshot
 * @param {object} goal AcquisitionGoal
 * @param {object} io { read(snap, cell), passable(name), solid(name), feetOf(snap) }
 * @param {object} [limits]
 * @returns {Array<{position:object, drop:object, score:number}>}
 */
function selectPickupStands(snapshot, goal, io, limits = {}) {
  const cfg = { ...DEFAULTS, ...limits };
  const feet = io.feetOf(snapshot);
  if (!feet) return [];
  const drops = goal.pendingDrops.length
    ? goal.pendingDrops
    : [{ position: goal.target.position, count: 1, name: goal.acceptedProducts[0] || 'unknown' }];
  const candidates = [];
  const seen = new Set();
  for (const drop of drops) {
    const dropCell = {
      x: Math.floor(drop.position.x),
      y: Math.floor(drop.position.y),
      z: Math.floor(drop.position.z)
    };
    for (let dx = -cfg.standRadiusXZ; dx <= cfg.standRadiusXZ; dx += 1) {
      for (let dz = -cfg.standRadiusXZ; dz <= cfg.standRadiusXZ; dz += 1) {
        for (let dy = -cfg.standRangeY; dy <= cfg.standRangeY; dy += 1) {
          const stand = { x: dropCell.x + dx, y: dropCell.y + dy, z: dropCell.z + dz };
          const key = cellKey(stand);
          if (seen.has(key)) continue;
          seen.add(key);
          if (sameCell(stand, goal.target.position)) continue; // never stand in the ore's own cell
          const floor = { x: stand.x, y: stand.y - 1, z: stand.z };
          if (!io.solid(io.read(snapshot, floor))) continue;
          const body = io.read(snapshot, stand);
          const head = io.read(snapshot, { x: stand.x, y: stand.y + 1, z: stand.z });
          if (!io.passable(body) || !io.passable(head)) continue;
          if (sameCell(stand, feet)) continue; // already there; handled before stands
          if (typeof io.dangerAt === 'function' && io.dangerAt(snapshot, stand)) continue; // lava/monster/drop below
          const dx2 = stand.x + 0.5 - drop.position.x;
          const dy2 = stand.y - drop.position.y;
          const dz2 = stand.z + 0.5 - drop.position.z;
          const distance = Math.hypot(dx2, dy2, dz2);
          const score =
            distance + Math.hypot(stand.x - feet.x, stand.z - feet.z) * 0.25 + Math.abs(stand.y - feet.y) * 0.35;
          candidates.push({ position: stand, drop: { ...drop }, score, possibleContact: Math.abs(dy2) <= 1.6 });
        }
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates.slice(0, cfg.maxLocalStands * 2);
}

/**
 * Try to collect one goal, with a bounded local strategy.
 *
 * @param {object} options
 *   - goal, mode ('macro'|'recovery'), deadline, signal
 *   - allowTerrainEdits (macro only), limits
 *   - io:
 *       refresh() -> snapshot|null
 *       feetOf(snapshot)
 *       read(snapshot, cell) -> bare block name
 *       passable(name), solid(name)
 *       dangerAt(snapshot, cell) -> {reason, hostile}|null
 *       moveTo(position, {within}) -> Promise<{ok, reason?}>
 *       digCell(cell) -> Promise<{ok, reason?, failure?}>   (macro edits; counts ledger)
 *       climbTo(stand, {maxSteps, deadline, signal}) -> Promise<{ok, risen, reason?}>
 *       log
 * @returns {Promise<object>} CollectionResult (plan §6.1):
 *   {goalId, outcome, collectedDelta, collectedTotal, pendingDrops, evidenceLevel,
 *    reason, failure, stand, lastDropPositions, attemptedActions, nextCandidateStands}
 */
async function attemptCollection(options) {
  const { goal, io, mode = 'macro' } = options;
  const limits = { ...DEFAULTS, ...(options.limits || {}) };
  const deadline = Math.min(
    options.deadline || Date.now() + limits.maxGoalCollectionMs,
    Date.now() + limits.maxGoalCollectionMs
  );
  const signal = options.signal || null;
  const log = io.log || { info() {}, warn() {}, debug() {} };

  const result = {
    goalId: goal.goalId,
    outcome: 'pending',
    collectedDelta: 0,
    collectedTotal: goal.collectedItems,
    pendingDrops: [],
    evidenceLevel: null,
    reason: null,
    failure: null,
    stand: null,
    lastDropPositions: [],
    attemptedActions: [],
    nextCandidateStands: []
  };
  const cancelled = () => !!(signal && signal.cancelled);
  const outOfTime = () => Date.now() >= deadline;
  const finish = (patch) => {
    Object.assign(result, patch);
    result.collectedTotal = goal.collectedItems;
    result.pendingDrops = goal.pendingDrops.map((d) => ({ ...d }));
    return result;
  };

  const observe = async () => {
    const snapshot = await io.refresh();
    if (!snapshot) return null;
    const sighting = observeAcquisition(goal, snapshot);
    const verdict = verifyAcquisition(goal, sighting);
    result.evidenceLevel = verdict.evidenceLevel || result.evidenceLevel;
    result.collectedDelta += verdict.delta;
    return { snapshot, verdict, sighting };
  };

  // ---- 1. bounded wait for the drop / auto-pickup --------------------------
  const spawnDeadline = Math.min(deadline, Date.now() + limits.dropSpawnWaitMs);
  for (;;) {
    if (cancelled()) return finish({ outcome: 'interrupted', failure: 'interrupted', reason: signal.reason || 'cancelled' });
    const seen = await observe();
    if (!seen) return finish({ outcome: 'unknown', failure: 'internal', reason: 'no valid world state during collection' });
    if (seen.verdict.verified) {
      return finish({ outcome: 'verified', reason: goal.pendingDrops.length ? 'milestone reached; surplus remains' : null });
    }
    // A visible pending drop is already the strongest observation available; no need to
    // sit out the full spawn wait.
    if (goal.pendingDrops.length) break;
    if (Date.now() >= spawnDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!goal.pendingDrops.length) {
    /**
     * Nothing visible and no inventory evidence. The block was confirmed mined, so this is
     * a pickup problem (server lag, another collector, out-of-scan), never "complete".
     */
    return finish({
      outcome: 'pending',
      failure: 'pickup_not_confirmed',
      reason: 'the dig is confirmed but no product was observed'
    });
  }
  result.lastDropPositions = goal.pendingDrops.map((d) => ({ ...d.position }));

  // ---- 2. stand attempts ---------------------------------------------------
  const snapshot = (await io.refresh()) || null;
  if (!snapshot) return finish({ outcome: 'unknown', failure: 'internal', reason: 'world state lost before standing' });
  let stands = selectPickupStands(snapshot, goal, io, limits);
  let editsUsed = 0;
  let pillarsUsed = 0;
  const tried = [];

  for (const candidate of stands) {
    if (cancelled()) return finish({ outcome: 'interrupted', failure: 'interrupted', reason: signal.reason || 'cancelled' });
    if (outOfTime()) return finish({ outcome: 'pending', failure: 'pickup_budget_exhausted', reason: 'collection budget spent' });
    if (tried.length >= limits.maxLocalStands) break;

    const feet = io.feetOf(await io.refresh()) || null;
    const drop = goal.pendingDrops[0];
    const needsClimb = !!(feet && drop && drop.position.y > feet.y + 2);

    if (!needsClimb) {
      const moved = await io.moveTo(candidate.position, { within: 1 });
      result.attemptedActions.push({ action: 'move', to: { ...candidate.position }, ok: !!(moved && moved.ok) });
      tried.push(candidate.position);
      goal.triedStands.push({ ...candidate.position });
      if (cancelled()) return finish({ outcome: 'interrupted', failure: 'interrupted', reason: signal.reason || 'cancelled' });
      const seen = await observe();
      if (seen && seen.verdict.verified) return finish({ outcome: 'verified', stand: { ...candidate.position } });
      // Bounded confirm at the stand; a fresh stand is chosen afterwards if it stays dry.
      const confirmUntil = Math.min(deadline, Date.now() + limits.pickupConfirmMs);
      while (Date.now() < confirmUntil) {
        if (cancelled()) return finish({ outcome: 'interrupted', failure: 'interrupted', reason: signal.reason || 'cancelled' });
        const polled = await observe();
        if (polled && polled.verdict.verified) return finish({ outcome: 'verified', stand: { ...candidate.position } });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      continue;
    }

    /**
     * The product hangs above: reuse the single-cell pillar executor through `climbTo`.
     * The macro budget is bounded per call; the drop is re-checked after every climb.
     */
    if (pillarsUsed >= limits.maxLocalPillarSteps || typeof io.climbTo !== 'function') continue;
    const climb = await io.climbTo(candidate.position, {
      maxSteps: Math.max(1, limits.maxLocalPillarSteps - pillarsUsed),
      deadline,
      signal
    });
    result.attemptedActions.push({
      action: 'climb',
      toward: { ...candidate.position },
      ok: !!(climb && climb.ok),
      risen: (climb && climb.risen) || 0
    });
    pillarsUsed += (climb && climb.risen) || 0;
    if (cancelled()) return finish({ outcome: 'interrupted', failure: 'interrupted', reason: signal.reason || 'cancelled' });
    const seen = await observe();
    if (seen && seen.verdict.verified) return finish({ outcome: 'verified', stand: { ...candidate.position } });
    tried.push(candidate.position);
    goal.triedStands.push({ ...candidate.position });
  }

  // ---- 3. optional short clearing pass (macro only) ------------------------
  if (mode === 'macro' && options.allowTerrainEdits && editsUsed < limits.maxLocalEdits && !outOfTime()) {
    /**
     * A stand may be reachable only after one or two blocking cells go; still bounded, and
     * never the target ore (the caller's digCell enforces that through the ledger).
     */
    const fresh = (await io.refresh()) || null;
    if (fresh) stands = selectPickupStands(fresh, goal, io, { ...limits, standRadiusXZ: limits.standRadiusXZ + 1 });
    for (const candidate of stands.slice(0, limits.maxLocalStands)) {
      if (editsUsed >= limits.maxLocalEdits || outOfTime()) break;
      const feet = io.feetOf(await io.refresh());
      if (!feet) break;
      const step = {
        x: Math.sign(candidate.position.x - feet.x),
        y: candidate.position.y - feet.y,
        z: Math.sign(candidate.position.z - feet.z)
      };
      if (step.x === 0 && step.z === 0 && step.y === 0) continue;
      const target = {
        x: feet.x + step.x,
        y: feet.y + Math.min(1, Math.max(0, step.y)),
        z: feet.z + step.z
      };
      const name = io.read(fresh, target);
      if (io.passable(name)) continue;
      if (bare(name) === goal.target.blockId) continue; // never the target as clearing debris
      const dug = await io.digCell(target);
      result.attemptedActions.push({ action: 'dig', cell: target, ok: !!(dug && dug.ok) });
      if (dug && dug.ok) editsUsed += 1;
      if (cancelled()) return finish({ outcome: 'interrupted', failure: 'interrupted', reason: signal.reason || 'cancelled' });
    }
    const seen = await observe();
    if (seen && seen.verdict.verified) return finish({ outcome: 'verified' });
  }

  return finish({
    outcome: 'needs_recovery',
    failure: 'pickup_not_confirmed',
    reason: `tried ${tried.length} stand(s) without verified pickup`,
    nextCandidateStands: stands.slice(0, limits.maxLocalStands).map((c) => ({ ...c.position }))
  });
}

module.exports = { DEFAULTS, selectPickupStands, attemptCollection };
