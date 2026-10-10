'use strict';

/**
 * Iterative headroom-clearing pillar: one cell per round.
 *
 * The plan (docs/MINING-LLM-PLAN.md §5.4) replaces the old "clear `feet+2 .. feet+need+2`
 * once, then `pillar(need)`, then retry with `need-1`" with a loop that cannot outrun
 * reality:
 *
 *   refresh -> confirm next-hop headroom -> clear and re-verify -> place one block ->
 *   verify the landing -> add one to the real height
 *
 * The reasons this lives in Node and not in the mod controller: the 4.5-block dig reach
 * means a one-shot pre-clear of the whole column is impossible to execute truthfully
 * (the far cells are refused), a solid cap limits the jump apex to a ~0.2-block placement
 * window, and a partial rise must never be thrown away by a coarser retry.
 *
 * Everything that touches the world goes through callbacks (`io`), so the module is
 * deterministic and stays reusable by the LLM recovery path (P1) and the collection
 * climber (C-series): the same executor, different callers.
 *
 * The `pillar(1)` hop itself is the mod's job (jump, place under the feet, land). This
 * module never re-sends a hop that failed: per §5.4.3 a single `pillar(1)` already
 * contains the client's finite jump retries, and repeating it blindly is exactly the
 * "repeated ineffective action" the plan exists to stop.
 */

const DEFAULT_MAX_RISE = 16;
const DEFAULT_SINGLE_HOP_MS = 8000;

function cellKey(cell) {
  return `${cell.x},${cell.y},${cell.z}`;
}

/** Wait for a *new* snapshot to agree with an already-observed change (bounded). */
async function confirmState(io, predicate, attempts = 3, waitMs = 250) {
  for (let i = 0; i < attempts; i += 1) {
    const snap = await io.refresh();
    if (snap && predicate(snap)) return snap;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return null;
}

/**
 * Run the per-cell pillar loop.
 *
 * @param {object} options
 *   - `deadline` (epoch ms): the parent task's hard budget, shared with everything else
 *   - `signal` `{cancelled, reason}`: the task's cancellation token (checked after every
 *     await, before any further side effect)
 *   - `goalFeetY` (number): the fixed feet height this climb was planned for; recomputed
 *     by the caller from the *original* start each time it starts a climb, never treated
 *     as a fresh request after a partial rise
 *   - `io` callbacks:
 *       `refresh()` -> snapshot|null   a valid new read; cached/stale data must come back
 *                                      as null (the caller decides what stale means)
 *       `feetOf(snap)` -> {x,y,z}|null
 *       `scanCell(snap, cell)` -> bare block name
 *       `isAir(name)` -> boolean
 *       `sameColumn(snap, start)` -> boolean     still in the planned (x,z)
 *       `dangerAt(snap, cell)` -> {reason, hostile}|null
 *       `isTargetCell(cell)` -> boolean          the locked ore blocks the next hop
 *       `protectedCell(name, cell)` -> boolean   another target ore / unknown block
 *       `digCell(cell)` -> Promise<{ok, reason?, failure?}>  full admission + ledger
 *       `takePossible(snap, feet)` -> boolean    close enough to try the target
 *       `takeTarget()` -> Promise<{ok, dug?, failure?, reason?}>
 *       `pickScaffold(snap)` -> itemName|null
 *       `equip(item)` -> Promise<boolean>
 *       `pillarHop(timeoutMs)` -> Promise<{ok, steps?, reason?, cell?}>
 *   - `maxRise`, `singleHopMs`, `log`
 * @returns {Promise<object>} see §5.4.3:
 *   { ok, failure, reason, cell, block, requested, risen, remaining, start, end,
 *     clearedCells, placedCells, minedTarget, interrupted, elapsedMs }
 */
async function pillarUpRounds(options) {
  const io = options.io;
  const log = options.log || { info() {}, warn() {}, debug() {} };
  const deadline = options.deadline;
  const signal = options.signal || null;
  const maxRise = options.maxRise || DEFAULT_MAX_RISE;
  const singleHopMs = options.singleHopMs || DEFAULT_SINGLE_HOP_MS;
  const startedAt = Date.now();

  const state = {
    ok: false,
    failure: null,
    reason: null,
    cell: null,
    block: null,
    requested: null,
    risen: 0,
    remaining: null,
    start: null,
    end: null,
    clearedCells: [],
    placedCells: [],
    minedTarget: false,
    interrupted: false,
    elapsedMs: 0
  };
  const done = (patch) => {
    Object.assign(state, patch);
    state.elapsedMs = Date.now() - startedAt;
    if (state.start && state.end) {
      state.remaining = Math.max(0, options.goalFeetY - state.end.y);
    }
    return state;
  };
  const cancelled = () => !!(signal && signal.cancelled);
  const checkCancel = () => {
    if (!cancelled()) return null;
    return done({
      ok: false,
      interrupted: true,
      failure: 'interrupted',
      reason: (signal && signal.reason) || 'task cancelled',
      end: state.end
    });
  };

  for (;;) {
    const cancel = checkCancel();
    if (cancel) return cancel;
    if (Date.now() >= deadline) {
      return done({ ok: false, failure: 'timeout', reason: 'out of time while pillaring up', end: state.end });
    }

    /**
     * Step 2 of the plan: a valid new read, every round. The caller's `refresh` returns
     * null when the HTTP layer served stale data or the world session changed; unknown
     * cells are never treated as air.
     */
    const snap = await io.refresh();
    if (!snap || snap.ready === false) {
      return done({ ok: false, failure: 'internal', reason: 'no valid world state while pillaring', end: state.end });
    }
    const feet = io.feetOf(snap);
    if (!feet) {
      return done({ ok: false, failure: 'internal', reason: 'no player position while pillaring', end: state.end });
    }
    if (!state.start) {
      state.start = { ...feet };
      state.requested = Math.max(1, options.goalFeetY - feet.y);
    }
    state.end = { ...feet };
    if (!io.sameColumn(snap, state.start)) {
      return done({ ok: false, failure: 'no_path', reason: 'moved out of the pillar column', cell: { ...feet } });
    }
    if (snap.onGround === false) {
      /**
       * A hop in progress is not a place to start another one; the Mod controller is
       * expected to have landed. Wait one bounded beat, then give up honestly.
       */
      const landed = await confirmState(io, (s) => s.onGround !== false, 3, 200);
      if (!landed) {
        return done({ ok: false, failure: 'internal', reason: 'not standing on the ground', cell: { ...feet } });
      }
      continue;
    }
    const under = io.scanCell(snap, { x: feet.x, y: feet.y - 1, z: feet.z });
    if (io.isAir(under)) {
      return done({ ok: false, failure: 'no_path', reason: 'no solid support under the feet', cell: { ...feet } });
    }
    const danger = typeof io.dangerAt === 'function' ? io.dangerAt(snap, feet) : null;
    if (danger) {
      return done({
        ok: false,
        failure: 'hazard',
        reason: danger.reason,
        hostile: !!danger.hostile,
        cell: { ...feet }
      });
    }

    const remaining = options.goalFeetY - feet.y;
    state.remaining = Math.max(0, remaining);
    if (remaining <= 0) {
      return done({ ok: true });
    }
    if (state.risen >= maxRise) {
      return done({ ok: false, failure: 'no_path', reason: `rise budget of ${maxRise} blocks spent` });
    }

    /**
     * Step 1: try the target before anything else. "Already diggable" must not be
     * confused with "already collectible", but a successful take inside this loop is a
     * real completion of the climb's purpose and is reported as `minedTarget`.
     */
    if (io.takePossible && io.takePossible(snap, feet)) {
      const take = await io.takeTarget();
      const cancelAfterTake = checkCancel();
      if (cancelAfterTake) return cancelAfterTake;
      if (take && take.ok && take.dug) {
        return done({ ok: true, minedTarget: true, end: { ...feet } });
      }
      if (take && take.failure === 'target_lost') {
        return done({ ok: false, failure: 'target_lost', reason: take.reason || 'the target disappeared', end: { ...feet } });
      }
      // refused / out_of_reach: the dig refusal from below is the case this loop fixes.
    }

    /**
     * Step 3: clear only what the next hop needs - the feet cell's `y+2` and `y+3`,
     * bottom-up. `y+4` is left for after the rise. Each cell is re-read before and after
     * its dig; a dig that does not visibly pass removes the blocker is a failure, not a
     * reason to jump anyway.
     */
    let feetNow = feet;
    let clearedRound = false;
    for (const dy of [2, 3]) {
      const cancelBeforeClear = checkCancel();
      if (cancelBeforeClear) return cancelBeforeClear;
      const cell = { x: feetNow.x, y: feetNow.y + dy, z: feetNow.z };
      const fresh = await io.refresh();
      if (!fresh || fresh.ready === false) {
        return done({ ok: false, failure: 'internal', reason: 'no valid world state before clearing', cell });
      }
      const nowFeet = io.feetOf(fresh);
      if (!nowFeet || !io.sameColumn(fresh, state.start)) {
        return done({ ok: false, failure: 'no_path', reason: 'moved out of the pillar column during clearing', cell });
      }
      feetNow = nowFeet;
      state.end = { ...nowFeet };
      const name = io.scanCell(fresh, cell);
      if (io.isAir(name)) continue;

      if (io.isTargetCell && io.isTargetCell(cell)) {
        /**
         * Rule 5: the locked ore in the next-hop headroom goes through the real take
         * flow. If it cannot be taken from here, the climb stops with a readable
         * reason instead of jumping through it or deleting it as if it were stone.
         */
        const take = await io.takeTarget();
        const cancelAfterTake = checkCancel();
        if (cancelAfterTake) return cancelAfterTake;
        if (take && take.ok && take.dug) {
          return done({ ok: true, minedTarget: true, end: { ...feetNow } });
        }
        if (take && take.failure === 'target_lost') {
          return done({ ok: false, failure: 'target_lost', reason: take.reason || 'the target disappeared', cell });
        }
        return done({
          ok: false,
          failure: 'occluded',
          reason: `the target ore blocks the next hop at ${cellKey(cell)} and cannot be taken (${(take && take.reason) || 'unknown'})`,
          cell,
          block: name
        });
      }
      if (io.protectedCell && io.protectedCell(name, cell)) {
        return done({
          ok: false,
          failure: 'occluded',
          reason: `${name} at ${cellKey(cell)} is protected and blocks the next hop`,
          cell,
          block: name
        });
      }
      const dig = await io.digCell(cell);
      const cancelAfterDig = checkCancel();
      if (cancelAfterDig) return cancelAfterDig;
      if (!dig || !dig.ok) {
        return done({
          ok: false,
          failure: (dig && dig.failure) || 'occluded',
          reason: (dig && dig.reason) || `could not clear ${cellKey(cell)}`,
          cell,
          block: name
        });
      }
      const after = await io.refresh();
      const stillThere = after ? io.scanCell(after, cell) : name;
      if (!io.isAir(stillThere)) {
        return done({
          ok: false,
          failure: 'occluded',
          reason: `${stillThere} is still at ${cellKey(cell)} after digging it`,
          cell,
          block: stillThere
        });
      }
      state.clearedCells.push({ ...cell, block: name });
      clearedRound = true;
    }
    if (clearedRound) {
      log.info(`pillar-up: cleared ${state.clearedCells.length} cell(s) for the next hop`);
    }

    /** Re-check cancellation and hazards after the clearing work. */
    const cancelBeforePlace = checkCancel();
    if (cancelBeforePlace) return cancelBeforePlace;
    const prePlace = await io.refresh();
    if (!prePlace || prePlace.ready === false) {
      return done({ ok: false, failure: 'internal', reason: 'no valid world state before placing', cell: { ...feetNow } });
    }
    const feetPre = io.feetOf(prePlace);
    if (!feetPre || !io.sameColumn(prePlace, state.start)) {
      return done({ ok: false, failure: 'no_path', reason: 'moved out of the pillar column before placing', cell: { ...feetNow } });
    }
    const dangerNow = typeof io.dangerAt === 'function' ? io.dangerAt(prePlace, feetPre) : null;
    if (dangerNow) {
      return done({ ok: false, failure: 'hazard', reason: dangerNow.reason, hostile: !!dangerNow.hostile, cell: { ...feetPre } });
    }

    /** Step 6: choose the support block fresh each round; never jump empty-handed. */
    const scaffold = io.pickScaffold(prePlace);
    if (!scaffold) {
      return done({ ok: false, failure: 'no_material', reason: 'no scaffold block to pillar with', cell: { ...feetPre } });
    }
    await io.equip(scaffold);
    const cancelAfterEquip = checkCancel();
    if (cancelAfterEquip) return cancelAfterEquip;

    const hopTimeout = Math.max(1000, Math.min(singleHopMs, deadline - Date.now()));
    const hop = await io.pillarHop(hopTimeout);

    /**
     * Step 7: verify with a new snapshot. `ok:true` or `steps:1` alone is not enough -
     * the feet must be exactly one block higher, in the same column, and the old feet
     * cell must now be solid (the block we just placed). The client may report late, so a
     * bounded re-read is allowed; a *second placement* is not.
     */
    const expectedY = feetPre.y + 1;
    const verified = await confirmState(
      io,
      (s) => {
        const f = io.feetOf(s);
        return !!f && f.y === expectedY && io.sameColumn(s, state.start);
      },
      3,
      250
    );
    const hopFeet = verified ? io.feetOf(verified) : null;
    if (verified && hopFeet) {
      const oldCell = { x: feetPre.x, y: feetPre.y, z: feetPre.z };
      const placedName = io.scanCell(verified, oldCell);
      if (io.isAir(placedName)) {
        const cancelMid = checkCancel();
        if (cancelMid) return cancelMid;
        return done({
          ok: false,
          failure: 'internal',
          reason: 'the feet rose but the old feet cell is not solid (placement unconfirmed)',
          cell: oldCell
        });
      }
      state.risen += 1;
      state.end = { ...hopFeet };
      state.placedCells.push({ ...oldCell, block: placedName });
      log.info(`pillar-up: rose to y=${hopFeet.y} (${state.risen} this climb)`);
    }
    /**
     * Account a completed hop *before* reacting to a cancellation: the rise happened and
     * must survive in the partial result (plan §5.4.2 rule 8). The cancel still stops
     * every further side effect.
     */
    const cancelAfterHop = checkCancel();
    if (cancelAfterHop) return cancelAfterHop;
    if (!verified || !hopFeet) {
      const postFeet = io.feetOf(prePlace);
      const moved = postFeet && postFeet.y !== feetPre.y ? ` (feet moved to y=${postFeet.y})` : '';
      return done({
        ok: false,
        failure: (hop && hop.failure) || 'no_path',
        reason: `${(hop && hop.reason) || 'the pillar hop did not complete'}${moved}`,
        cell: { ...feetPre },
        block: scaffold,
        end: postFeet ? { ...postFeet } : { ...feetPre }
      });
    }

    /** One more round; the loop head re-validates everything. */
  }
}

module.exports = { pillarUpRounds };
