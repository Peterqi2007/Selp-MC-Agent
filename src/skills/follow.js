'use strict';

/**
 * Follow skill: keep a player within `range` blocks, re-reading their position at a high
 * frequency while walking.
 *
 * Why a loop instead of one `moveTo` call: a single A* plan is computed against the target
 * position at plan time. The operator explicitly wants the target re-read as often as the
 * pathfinder allows, so this skill:
 *   - polls a fresh body state every `pollMs` (default 150ms) while a move is running;
 *   - interrupts the current move and replans when the target has moved more than
 *     REPATH_DISTANCE from the waypoint the path was built for;
 *   - keeps the player inside the 30-block block-scan radius: `maxRange` defaults to 24,
 *     leaving margin for the A* planner; beyond that the target is reported as lost instead
 *     of walking blindly into unknown blocks;
 *   - stops when the target disappears (two consecutive misses) or the duration expires.
 *
 * The movement itself goes through `body.moveTo(..., { pathfind: true })`, i.e. the same A*
 * navigator as the rest of the skills.
 */

const { register } = require('./registry');
const { bare } = require('../world/items');
const { FAILURE } = require('../core/failure');

/** Replan when the target moved this far from the waypoint the current route targets. */
const REPATH_DISTANCE = 1.5;
/** One move slice; the poll loop can interrupt it much earlier. */
const MOVE_SEGMENT_MS = 6000;
/** Give up after this many consecutive non-interrupted move failures. */
const MAX_MOVE_FAILURES = 3;
/** Two misses at 150ms avoid stopping on one transient player-list frame. */
const MAX_MISSES = 2;
/** A body that cannot answer /state for ~3s is not a target problem, it is a body problem. */
const MAX_POLL_FAILURES = 20;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Find one player's position in a snapshot's players array. */
function playerPosition(players, playerName) {
  for (const entry of players || []) {
    if (!entry) continue;
    const name = typeof entry === 'string' ? entry : entry.name;
    if (bare(name || '') !== bare(playerName)) continue;
    if (!entry.position) return null;
    return { ...entry.position };
  }
  return null;
}

/**
 * Read one fresh body state. `refreshStrict(true)` is the expensive-but-fresh path (the
 * mod's /state carries the block scan and the players); the cache is only used when the
 * body has no refresh hook at all.
 */
async function readFollowState(ctx, playerName, { full = false } = {}) {
  const body = ctx.body;
  if (!body) return { ok: false, player: null, position: null, error: 'no body' };
  let snap = null;
  if (!full && typeof body.refreshPlayers === 'function') {
    const result = await body.refreshPlayers().catch(() => null);
    if (!result || result.ok !== true) {
      return { ok: false, player: null, position: null, error: (result && result.error) || 'state unavailable' };
    }
    const state = result.state;
    return {
      ok: true,
      player: playerPosition(state.players, playerName),
      position: state.position ? { ...state.position } : null
    };
  }
  if (typeof body.refreshStrict === 'function') {
    const result = await body.refreshStrict(true).catch(() => null);
    if (!result || result.ok !== true) {
      return { ok: false, player: null, position: null, error: (result && result.error) || 'state unavailable' };
    }
    snap = typeof body.snapshot === 'function' ? body.snapshot() : result.state;
  } else if (typeof body.refresh === 'function') {
    await body.refresh(true).catch(() => null);
    snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
  } else if (typeof body.snapshot === 'function') {
    snap = body.snapshot();
  }
  if (!snap) return { ok: false, player: null, position: null, error: 'no snapshot' };
  return {
    ok: true,
    player: playerPosition(snap.players, playerName),
    position: snap.position ? { ...snap.position } : null
  };
}

register({
  name: 'follow',
  title: '跟随玩家',
  description:
    'Follow a player, re-reading their position every poll and replanning with A* when they move ' +
    '(stays within pathfinding range; stops when they are lost or the duration expires).',
  beta: true,
  params: {
    player: { type: 'string', required: true },
    range: { type: 'number', default: 3, min: 1, max: 6 },
    maxRange: { type: 'number', default: 24, min: 4, max: 30 },
    durationMs: { type: 'number', default: 300000, min: 1000, max: 3600000 },
    pollMs: { type: 'number', default: 150, min: 50, max: 1000 }
  },
  available: (ctx) => {
    const body = ctx.body || {};
    return typeof body.moveTo === 'function' && typeof body.snapshot === 'function'
      ? { ok: true }
      : { ok: false, reason: 'this body cannot walk/follow (needs moveTo + snapshot)' };
  },
  async run(ctx, params) {
    const body = ctx.body;
    const playerName = String(params.player || '').trim();
    const range = params.range;
    const maxRange = params.maxRange;
    const durationMs = params.durationMs;
    const pollMs = params.pollMs;
    const signal = ctx.taskSignal || null;
    const cancelled = () => !!(signal && signal.cancelled);
    const stop = () => ({
      ok: false,
      failure: FAILURE.INTERRUPTED,
      reason: (signal && signal.reason) || 'cancelled'
    });

    if (!playerName) return { ok: false, failure: FAILURE.BAD_ARGUMENT, reason: 'follow needs a player name' };
    if (range >= maxRange) {
      return { ok: false, failure: FAILURE.BAD_ARGUMENT, reason: `range (${range}) must be smaller than maxRange (${maxRange})` };
    }

    const first = await readFollowState(ctx, playerName, { full: true });
    if (!first.ok) {
      return { ok: false, failure: FAILURE.UNKNOWN, reason: `could not read a fresh body state: ${first.error || 'unknown'}` };
    }
    if (!first.player) {
      return { ok: false, failure: FAILURE.TARGET_LOST, reason: `${playerName} is not visible right now` };
    }
    if (first.position && distance(first.position, first.player) > maxRange) {
      return {
        ok: false,
        failure: FAILURE.TARGET_LOST,
        reason: `${playerName} is ${distance(first.position, first.player).toFixed(1)} blocks away - beyond the pathfinding range (${maxRange})`
      };
    }

    let latest = { ...first.player };
    let here = first.position ? { ...first.position } : null;
    let lost = false;
    let tooFar = false;
    let misses = 0;
    let pollFailures = 0;
    let samples = 0;
    let repaths = 0;
    let goal = null;
    let interrupted = false;
    let polling = false;

    /**
     * High-frequency perception. The interval overlaps the move on purpose: A* is running
     * in `moveTo`, while this reads /state and interrupts the route the moment the target
     * has moved past REPATH_DISTANCE. `polling` prevents overlapping /state requests.
     */
    const poll = async () => {
      if (polling || cancelled()) return;
      polling = true;
      try {
        const read = await readFollowState(ctx, playerName);
        if (!read.ok) {
          pollFailures += 1;
          return;
        }
        pollFailures = 0;
        samples += 1;
        if (signal) signal.samples = samples; // live progress for the task adapter
        if (!read.player) {
          misses += 1;
          if (misses >= MAX_MISSES) {
            lost = true;
            if (goal) {
              goal = null;
              interrupted = true;
              if (typeof body.interrupt === 'function') body.interrupt('follow target lost');
            }
          }
          return;
        }
        misses = 0;
        latest = { ...read.player };
        if (read.position) here = { ...read.position };
        if (here && distance(here, latest) > maxRange) {
          tooFar = true;
          if (goal) {
            goal = null;
            interrupted = true;
            if (typeof body.interrupt === 'function') body.interrupt('follow target too far');
          }
          return;
        }
        if (goal && distance(latest, goal) > REPATH_DISTANCE) {
          goal = null;
          interrupted = true;
          if (typeof body.interrupt === 'function') body.interrupt('follow repath');
        }
      } finally {
        polling = false;
      }
    };

    const timer = setInterval(() => {
      poll().catch(() => {});
    }, pollMs);

    try {
      const deadline = Date.now() + durationMs;
      let moveFailures = 0;
      while (Date.now() < deadline) {
        if (cancelled()) return { ...stop(), samples };
        if (lost) return { ok: false, failure: FAILURE.TARGET_LOST, reason: `lost sight of ${playerName}`, samples };
        if (tooFar) {
          return {
            ok: false,
            failure: FAILURE.TARGET_LOST,
            reason: `${playerName} moved beyond the pathfinding range (${maxRange} blocks)`,
            samples
          };
        }
        if (pollFailures >= MAX_POLL_FAILURES) {
          return { ok: false, failure: FAILURE.UNKNOWN, reason: 'lost the body state while following', samples };
        }

        const targetDistance = here ? distance(here, latest) : Infinity;
        if (targetDistance <= range) {
          // Already close enough: keep polling; the loop re-checks after each short wait.
          await sleep(Math.min(pollMs, 100));
          continue;
        }

        // Full scan at pathfinding cadence, not at poll cadence: refresh the block map and
        // inventory just before committing to a route. The 150ms polls stay players-only.
        const preMove = await readFollowState(ctx, playerName, { full: true });
        if (preMove.ok) {
          if (preMove.player) latest = preMove.player;
          if (preMove.position) here = preMove.position;
        }

        goal = { ...latest };
        interrupted = false;
        const ok = await body
          .moveTo(goal, { range, timeoutMs: MOVE_SEGMENT_MS, pathfind: true })
          .catch(() => false);
        goal = null;

        if (cancelled()) return { ...stop(), samples };
        if (lost || tooFar) continue;
        if (interrupted) {
          repaths += 1;
          moveFailures = 0;
        } else if (!ok) {
          moveFailures += 1;
          if (moveFailures >= MAX_MOVE_FAILURES) {
            const why = (body.lastMove && body.lastMove.reason) || 'no progress';
            return {
              ok: false,
              failure: FAILURE.NO_PATH,
              reason: `could not follow ${playerName}: ${why}`,
              samples
            };
          }
        } else {
          moveFailures = 0;
        }

        if (typeof body.snapshot === 'function') {
          const snap = body.snapshot();
          if (snap && snap.position) here = { ...snap.position };
        }
      }

      /**
       * A duration that expires while the target is still visible is a successful follow;
       * a player who vanished near the deadline is still a failure.
       */
      if (cancelled()) return { ...stop(), samples };
      if (lost) return { ok: false, failure: FAILURE.TARGET_LOST, reason: `lost sight of ${playerName}`, samples };
      if (tooFar) {
        return {
          ok: false,
          failure: FAILURE.TARGET_LOST,
          reason: `${playerName} moved beyond the pathfinding range (${maxRange} blocks)`,
          samples
        };
      }
      return {
        ok: true,
        detail: `followed ${playerName} for ${Math.round(durationMs / 1000)}s`,
        samples,
        repaths
      };
    } finally {
      clearInterval(timer);
    }
  }
});
