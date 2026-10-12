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
  /**
   * Live 2026-10-10: the drop sat one level below a sealed ceiling. Digging the ceiling was
   * not enough - the walker refused to enter a cell whose floor was the open pit. The step
   * must target the drop's own level; the cell above it (our current level) is what gets
   * dug so the bot can step/fall down there.
   */
  const dy = dropCell.y - feet.y;
  if (dy < -1 || dy > 1) {
    return { ok: false, reason: 'the drop is more than one level away', failure: 'no_path', spent: 0, dug: [] };
  }
  const stepY = dy === -1 ? feet.y - 1 : dy === 1 ? feet.y + 1 : feet.y;
  const useX = Math.abs(dx) >= Math.abs(dz);
  const step = {
    x: feet.x + (useX ? Math.sign(dx) : 0),
    y: stepY,
    z: feet.z + (useX ? 0 : Math.sign(dz))
  };
  const dug = [];
  const log = io.log || null;
  for (const cell of [step, { x: step.x, y: step.y + 1, z: step.z }]) {
    /** Never dig the drop's own cell - it is the prize, and it must stay walkable. */
    if (cell.x === dropCell.x && cell.y === dropCell.y && cell.z === dropCell.z) continue;
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
      /**
       * The press: when the step cell is the drop's own cell (nothing to dig before the
       * walk) and only the head cell is unaffordable, refuse the dig but not the step.
       *
       * Live 2026-10-12: the item sat in a sealed 1x1 pocket whose head cell was solid -
       * the body can never stand in there, but the walk toward the pocket still presses
       * it to the far edge of the neighbouring cell, which is inside the vanilla pickup
       * inflation (1.0 horizontal). Digging one more block is not required to reach it,
       * so a spent budget must not abort the approach. The caller's observe() remains
       * the referee: no edit, no pickup, no progress.
       */
      const stepIsDropCell = step.x === dropCell.x && step.y === dropCell.y && step.z === dropCell.z;
      if (stepIsDropCell && cell.y === step.y + 1) {
        if (log && typeof log.info === 'function') {
          log.info(
            `carve: head ${cell.x},${cell.y},${cell.z} left in place (edit budget spent); pressing toward the drop`
          );
        }
        continue;
      }
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
  /**
   * Walkers report "arrived" within their own tolerance; live 2026-10-10 a range-1.0
   * arrival left the feet cell unchanged and the carve loop span on one cell forever.
   * Verify the landing against the real position, not the walker's word.
   *
   * Dig-then-drop needs a bounded settle: live 2026-10-12 the dug floor sent the bot
   * falling exactly as intended, but the immediate re-read (mid-fall, still one level up)
   * looked like a failed step and the loop gave up one cell short of the drop.
   */
  const landedAt = (position) =>
    !!position && Math.hypot(position.x - (step.x + 0.5), position.y - step.y, position.z - (step.z + 0.5)) <= 0.6;
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) {
      const snapshotAfter = (await io.refresh()) || null;
      const positionAfter = snapshotAfter ? snapshotAfter.position : null;
      if (landedAt(positionAfter)) return { snapshot: snapshotAfter, position: positionAfter, ok: true };
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    const snapshotAfter = (await io.refresh()) || null;
    return { snapshot: snapshotAfter, position: snapshotAfter ? snapshotAfter.position : null, ok: false };
  };
  let moved = await io.moveTo(step, { within: 0.5 });
  let settled = await settle();
  if ((!moved || !moved.ok) || !settled.ok) {
    /**
     * Straight-line walker stuck on a corner: the diagonal enclosure leaves it pressed
     * against the corner. Let the caller's planner route an orthogonal path when the io
     * offers one - the same target, a walkable polyline instead of a slide.
     */
    const planned = await io.moveTo(step, { within: 0.5, plan: true });
    const plannedSettle = await settle();
    if (plannedSettle.ok) {
      moved = planned && planned.ok ? planned : moved;
      settled = plannedSettle;
    }
  }
  const after = settled.snapshot;
  const posAfter = settled.position;
  const landed = settled.ok;
  if (log && typeof log.info === 'function') {
    log.info(
      `carve: feet ${feet.x},${feet.y},${feet.z} -> ${step.x},${step.y},${step.z}; dug ${dug.length}; ` +
        `move=${moved && moved.ok ? 'ok' : 'failed'}; landed=${landed}` +
        (posAfter ? ` at ${posAfter.x.toFixed(2)},${posAfter.y.toFixed(2)},${posAfter.z.toFixed(2)}` : '')
    );
  }
  if (!moved || !moved.ok || !landed) {
    /**
     * Descent the walker refuses: it stops at the pit edge (its strict-cell arrival ignored
     * y, live 2026-10-10). A player's answer is to fill the pit and walk in on the level -
     * place a support block into the pit cell (the item on top pops up with the block) and
     * stand on it. Placement still goes through the caller's permission gate.
     */
    const sameAsDropCell = step.x === dropCell.x && step.y === dropCell.y && step.z === dropCell.z;
    if (sameAsDropCell && step.y < feet.y && typeof io.placeBlock === 'function' && typeof io.pickScaffold === 'function') {
      const scaffold = io.pickScaffold(after || snapshot);
      if (scaffold) {
        let placed = await io.placeBlock(scaffold, { x: step.x, y: step.y - 1, z: step.z }, { x: 0, y: 1, z: 0 });
        if (!placed || !placed.ok) {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const reference = { x: step.x + dx, y: step.y, z: step.z + dz };
            placed = await io.placeBlock(scaffold, reference, { x: -dx, y: 0, z: -dz });
            if (placed && placed.ok) break;
          }
        }
        if (placed && placed.ok) {
          const upper = { x: step.x, y: step.y + 1, z: step.z };
          const walked = await io.moveTo(upper, { within: 0.5 });
          const afterFill = (await io.refresh()) || null;
          const posFill = afterFill ? afterFill.position : null;
          const landedFill =
            !!posFill &&
            Math.hypot(posFill.x - (upper.x + 0.5), posFill.y - upper.y, posFill.z - (upper.z + 0.5)) <= 0.6;
          if (log && typeof log.info === 'function') {
            log.info(
              `carve-fill: placed ${scaffold} into ${step.x},${step.y},${step.z}; walk=${walked && walked.ok ? 'ok' : 'failed'}; landed=${landedFill}`
            );
          }
          if (walked && walked.ok && landedFill) {
            return { ok: true, spent: dug.length, dug, moved: upper, moveOk: true, filled: { ...step } };
          }
          return {
            ok: false,
            failure: (walked && walked.failure) || 'no_path',
            reason:
              (walked && walked.reason) ||
              `filled ${step.x},${step.y},${step.z} but could not stand on it`,
            spent: dug.length,
            dug,
            moved: upper,
            moveOk: !!(walked && walked.ok),
            filled: { ...step }
          };
        }
      }
    }
    /**
     * Rim-wedged descent: in a 1x1 pit the player can stand on the corner its AABB still
     * leans over (live 2026-10-12: feet one level up, hole directly below, no fall), and
     * the walker cannot step deeper. Clear the supporting rim cells at the pit's level -
     * the cells the current AABB overlaps - and let gravity finish the descent.
     */
    if (step.y < feet.y) {
      const raw =
        posAfter || (after && after.position ? after.position : null) || { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
      const rimCells = [];
      for (let x = Math.floor(raw.x - 0.31); x <= Math.floor(raw.x + 0.31); x += 1) {
        for (let z = Math.floor(raw.z - 0.31); z <= Math.floor(raw.z + 0.31); z += 1) {
          const cell = { x, y: step.y, z };
          if (cell.x === step.x && cell.z === step.z) continue;
          const name = io.read(after, cell);
          if (io.passable(name)) continue;
          if (typeof io.protectedName === 'function' && io.protectedName(name)) continue;
          if (typeof io.dangerAt === 'function' && io.dangerAt(after, cell)) continue;
          rimCells.push(cell);
        }
      }
      let clearedRim = 0;
      for (const cell of rimCells) {
        if (spentSoFar + dug.length >= limits.maxLocalEdits) break;
        const opened = await io.digCell(cell);
        if (opened && opened.ok) {
          dug.push({ ...cell, rim: true });
          clearedRim += 1;
        }
      }
      if (clearedRim > 0) {
        let retrySettle = await settle();
        if (!retrySettle.ok) {
          await io.moveTo(step, { within: 0.5 });
          retrySettle = await settle();
        }
        if (log && typeof log.info === 'function') {
          log.info(`carve-rim: cleared ${clearedRim} rim cell(s) at y=${step.y}; landed=${retrySettle.ok}`);
        }
        if (retrySettle.ok) {
          return { ok: true, spent: dug.length, dug, moved: step, moveOk: true };
        }
        return {
          ok: false,
          failure: 'no_path',
          reason: `cleared the rim but still could not stand at ${step.x},${step.y},${step.z}`,
          spent: dug.length,
          dug,
          moved: step,
          moveOk: false
        };
      }
    }
    return {
      ok: false,
      reason:
        (moved && moved.reason) ||
        (!landed
          ? `the walker did not enter the opened cell ${step.x},${step.y},${step.z}` +
            (posAfter ? ` (at ${posAfter.x.toFixed(2)},${posAfter.y.toFixed(2)},${posAfter.z.toFixed(2)})` : '')
          : 'could not walk into the opened cell'),
      failure: (moved && moved.failure) || 'no_path',
      spent: dug.length,
      dug,
      moved: step,
      moveOk: !!(moved && moved.ok)
    };
  }
  return { ok: true, spent: dug.length, dug, moved: step, moveOk: true };
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
    /**
     * `<=` so a zero-cost step still runs at an exactly-spent edit budget: the final
     * "press toward the drop" walk digs nothing and is the step that reaches an item the
     * body cannot stand next to (live 2026-10-12). A step that does need a dig fails
     * inside carveAccessStep on the same budget and stops the loop as before.
     */
    for (let i = 0; i < 12 && editsUsed <= limits.maxLocalEdits; i += 1) {
      if (cancelled()) return finish({ outcome: 'interrupted', failure: 'interrupted', reason: signal.reason || 'cancelled' });
      if (outOfTime()) break;
      const carve = await carveAccessStep(goal, io, limits, editsUsed);
      editsUsed += carve.spent || 0;
      if (carve.dug && carve.dug.length) {
        result.attemptedActions.push({ action: 'carve', cells: carve.dug, ok: true });
      }
      if (carve.moved) {
        result.attemptedActions.push({ action: 'carve-step', to: { ...carve.moved }, ok: carve.moveOk !== false });
      }
      if (carve.filled) {
        result.attemptedActions.push({ action: 'fill', cell: { ...carve.filled }, ok: carve.moveOk !== false });
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
    /**
     * Any carve failure keeps its structured reason: "tried 3 stands" hid whether the
     * access was refused, unreachable or out of budget (live 2026-10-10 debugging).
     */
    if (carveNote && carveNote.reason) {
      return finish({
        outcome: carveNote.hazard ? 'blocked' : 'needs_recovery',
        failure: carveNote.failure || 'pickup_not_confirmed',
        reason: carveNote.reason
      });
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
