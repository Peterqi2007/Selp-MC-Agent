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
 * One bounded access step toward the first pending drop (plan §5.2 tier 3: "有限清障阶梯").
 *
 * Live 2026-10-10: the macro mined an ore through a corner and the drop landed in a sealed
 * pocket - no stand candidate existed anywhere, so the collector gave up without ever
 * touching the rock between the bot and the item. This step opens exactly the two cells a
 * player would (the foot and head of one walk cell toward the drop), re-checks hazards and
 * the protected-ore boundary, then walks in. It is macro-only; recovery mode never hides
 * digging inside `collect_target`.
 *
 * @returns {{ok:boolean, spent:number, dug:Array, reached?:boolean, hazard?:boolean,
 *            failure?:string, reason?:string}}
 */
async function carveAccessStep(goal, io, limits, spentSoFar) {
  const snapshot = await io.refresh();
  if (!snapshot) return { ok: false, reason: 'no valid world state while carving', failure: 'internal', spent: 0, dug: [] };
  const feet = io.feetOf(snapshot);
  if (!feet) return { ok: false, reason: 'no player position while carving', failure: 'internal', spent: 0, dug: [] };
  const drop = goal.pendingDrops[0];
  if (!drop) return { ok: false, reached: true, reason: 'no pending drop left', spent: 0, dug: [] };
  const dropCell = {
    x: Math.floor(drop.position.x),
    y: Math.floor(drop.position.y),
    z: Math.floor(drop.position.z)
  };
  const dx = dropCell.x - feet.x;
  const dz = dropCell.z - feet.z;
  if (dx === 0 && dz === 0) {
    if (dropCell.y === feet.y) return { ok: false, reached: true, reason: 'standing in the drop cell', spent: 0, dug: [] };
    return { ok: false, reason: 'the drop is straight up/down; the climb tier owns that case', failure: 'no_path', spent: 0, dug: [] };
  }
  const useX = Math.abs(dx) >= Math.abs(dz);
  const step = {
    x: feet.x + (useX ? Math.sign(dx) : 0),
    y: feet.y,
    z: feet.z + (useX ? 0 : Math.sign(dz))
  };
  const dug = [];
  for (const cell of [step, { x: step.x, y: step.y + 1, z: step.z }]) {
    const name = io.read(snapshot, cell);
    if (io.passable(name)) continue;
    if (typeof io.protectedName === 'function' && io.protectedName(name)) {
      return {
        ok: false,
        reason: `${name} at ${cell.x},${cell.y},${cell.z} blocks the access and is protected`,
        failure: 'protected_ore',
        spent: dug.length,
        dug
      };
    }
    if (spentSoFar + dug.length >= limits.maxLocalEdits) {
      return {
        ok: false,
        reason: 'local edit budget exhausted while carving access',
        failure: 'pickup_budget_exhausted',
        spent: dug.length,
        dug
      };
    }
    if (typeof io.dangerAt === 'function') {
      const danger = io.dangerAt(snapshot, cell);
      if (danger) {
        return { ok: false, reason: danger.reason, failure: 'hazard', hazard: true, spent: dug.length, dug };
      }
    }
    const opened = await io.digCell(cell);
    if (!opened || !opened.ok) {
      return {
        ok: false,
        reason: (opened && opened.reason) || `could not open ${cell.x},${cell.y},${cell.z}`,
        failure: (opened && opened.failure) || 'refused',
        spent: dug.length,
        dug
      };
    }
    dug.push({ ...cell });
  }
  const moved = await io.moveTo(step, { within: 1 });
  if (!moved || !moved.ok) {
    return {
      ok: false,
      reason: (moved && moved.reason) || 'could not walk into the opened cell',
      failure: (moved && moved.failure) || 'no_path',
      spent: dug.length,
      dug
    };
  }
  return { ok: true, spent: dug.length, dug };
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
          /**
           * The mined ore's own cell is allowed (live 2026-10-10): after the dig it is air,
           * and standing exactly there is the most reliable pickup spot in a tight shaft.
           * While the ore is still there the cell reads solid, so the passability checks
           * below reject it naturally - no special case needed.
           */
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

  // ---- 3. bounded access carving toward the drop (macro only) --------------
  if (mode === 'macro' && options.allowTerrainEdits && !outOfTime()) {
    let carveNote = null;
    for (let i = 0; i < 12 && editsUsed < limits.maxLocalEdits; i += 1) {
      if (cancelled()) return finish({ outcome: 'interrupted', failure: 'interrupted', reason: signal.reason || 'cancelled' });
      if (outOfTime()) break;
      const carve = await carveAccessStep(goal, io, limits, editsUsed);
      editsUsed += carve.spent || 0;
      if (carve.dug && carve.dug.length) {
        result.attemptedActions.push({ action: 'carve', cells: carve.dug, ok: true });
      }
      const seen = await observe();
      if (seen && seen.verdict.verified) return finish({ outcome: 'verified', reason: 'picked up after carving access' });
      if (!carve.ok) {
        carveNote = carve;
        break;
      }
      if (carve.reached) break;
    }
    if (carveNote && carveNote.hazard) {
      return finish({ outcome: 'blocked', failure: carveNote.failure || 'hazard', reason: carveNote.reason });
    }
    if (editsUsed > 0) result.lastDropPositions = goal.pendingDrops.map((d) => ({ ...d.position }));
    /**
     * Carving may have opened a fresh stand cell; one more stand pass with the updated
     * world, still inside the same budgets.
     */
    if (!outOfTime()) {
      const fresh = (await io.refresh()) || null;
      if (fresh) {
        for (const candidate of selectPickupStands(fresh, goal, io, limits)) {
          if (tried.length >= limits.maxLocalStands) break;
          if (goal.triedStands.some((s) => sameCell(s, candidate.position))) continue;
          const moved = await io.moveTo(candidate.position, { within: 1 });
          tried.push(candidate.position);
          goal.triedStands.push({ ...candidate.position });
          result.attemptedActions.push({ action: 'move', to: { ...candidate.position }, ok: !!(moved && moved.ok) });
          if (cancelled()) return finish({ outcome: 'interrupted', failure: 'interrupted', reason: signal.reason || 'cancelled' });
          const seen = await observe();
          if (seen && seen.verdict.verified) return finish({ outcome: 'verified', stand: { ...candidate.position } });
        }
      }
    }
    const reason = carveNote && carveNote.reason ? carveNote.reason : `tried ${tried.length} stand(s) without verified pickup`;
    const failure = carveNote && carveNote.failure ? carveNote.failure : 'pickup_not_confirmed';
    if (carveNote && (carveNote.failure === 'protected_ore' || carveNote.failure === 'pickup_budget_exhausted')) {
      return finish({ outcome: 'needs_recovery', failure, reason });
    }
  }

  return finish({
    outcome: 'needs_recovery',
    failure: 'pickup_not_confirmed',
    reason: `tried ${tried.length} stand(s) without verified pickup`,
    nextCandidateStands: stands.slice(0, limits.maxLocalStands).map((c) => ({ ...c.position }))
  });
}

module.exports = { DEFAULTS, selectPickupStands, attemptCollection };
