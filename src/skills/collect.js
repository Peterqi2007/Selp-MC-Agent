'use strict';

/**
 * Collect nearby dropped items - the body-agnostic replacement for the old `!collect`
 * alias that only chopped one log (the operator found it 2026-10-21).
 *
 * Contract (operator's words):
 *   1. **No cached state.** Every scan and every pickup check forces a fresh body read
 *      (`refreshStrict(true)` when the body has it). `ctx.world` / `body.itemDrops()` are
 *      caches and are deliberately not used here.
 *   2. **15x15x15 around the player.** A drop is a candidate only when each axis is within
 *      +/-7 blocks of the player's position (15 cells per axis). Candidates are visited
 *      nearest-first.
 *   3. **A* to each one.** `moveTo(..., { pathfind: true })` tells the client-mod body to
 *      skip its straight-line walker and plan the route; other bodies use their own
 *      pathfinder.
 *   4. **Blocked means failure.** After each walk the skill compares how far the body
 *      actually moved and how much closer it got. When both are below the epsilon the drop
 *      is behind a wall/in a hole/pinned, and the skill returns `ok:false` with the
 *      navigator's reason instead of claiming a pickup it did not make.
 *
 * A drop that disappears before the body arrives was taken by someone else/despawned: it
 * is skipped, not counted as ours. Success requires at least one verified pickup.
 */

const { register } = require('./registry');
const { bare } = require('../world/items');
const { classifyMove, FAILURE } = require('../core/failure');

/** 15 cells per axis, centred on the player: offsets -7..+7. */
const BOX_HALF = 7;
/** The scan volume, for messages: 15x15x15. */
const BOX_SIZE = BOX_HALF * 2 + 1;
/** Stand this close; vanilla picks items up inside roughly one block. */
const PICK_RANGE = 1.0;
/** Per-target walk budget. */
const MOVE_TIMEOUT_MS = 8000;
/** Give the server a tick or two to register the pickup before re-reading. */
const PICK_WAIT_MS = 250;
/** Two attempts per drop: the first walk, and one retry while it is still there. */
const MAX_ATTEMPTS = 2;
/** Below this, neither the position nor the distance changed: blocked. */
const PROGRESS_EPS = 0.35;

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

function dropName(drop) {
  return bare((drop && (drop.item || drop.name)) || '');
}

function fmt(position) {
  if (!position) return '(unknown)';
  return `${Number(position.x).toFixed(1)},${Number(position.y).toFixed(1)},${Number(position.z).toFixed(1)}`;
}

/**
 * Force a fresh body read. Returns null when the body cannot answer right now.
 *
 * `ClientModBody.refreshStrict(true)` returns `{ok,state}` and keeps the OLD state in
 * `state` on failure - using it there is exactly the cache this skill must not trust, so
 * an `ok:false` answer becomes null instead of a fallback snapshot.
 */
async function freshSnapshot(ctx) {
  const body = ctx.body;
  if (!body) return null;
  if (typeof body.refreshStrict === 'function') {
    const outcome = await body.refreshStrict(true).catch(() => null);
    if (!outcome || outcome.ok !== true) return null;
  } else if (typeof body.refresh === 'function') {
    await body.refresh(true).catch(() => null);
  }
  return typeof body.snapshot === 'function' ? body.snapshot() : null;
}

/** Drops inside the 15x15x15 box, nearest-first. */
function dropsInBox(snapshot) {
  const center = snapshot && snapshot.position;
  if (!center) return [];
  const items = Array.isArray(snapshot.nearbyItems) ? snapshot.nearbyItems : [];
  return items
    .filter((drop) => drop && drop.position)
    .filter(
      (drop) =>
        Math.abs(Number(drop.position.x) - Number(center.x)) <= BOX_HALF &&
        Math.abs(Number(drop.position.y) - Number(center.y)) <= BOX_HALF &&
        Math.abs(Number(drop.position.z) - Number(center.z)) <= BOX_HALF
    )
    .map((drop) => ({ ...drop, distance: distance(center, drop.position) }))
    .sort((a, b) => a.distance - b.distance);
}

/** Same drop across two snapshots: same spot, and (same id or same item) there. */
function sameDrop(a, b) {
  if (!a || !b) return false;
  /**
   * Proximity is mandatory. Ids cannot be trusted on their own: the mock rebuilds its drop
   * list every snapshot, so `drop-0` is a different item after the first one is removed -
   * an id-only match made the skill walk to the *next* drop and count the first as
   * "still there". Entity ids are stable on the real bodies, but position + name is the
   * identity that holds everywhere.
   */
  if (distance(a.position, b.position) > 0.75) return false;
  if (a.id !== undefined && b.id !== undefined && String(a.id) === String(b.id)) return true;
  return dropName(a) === dropName(b);
}

register({
  name: 'collect',
  title: '捡起附近掉落物',
  description:
    `Pick up dropped items within ${BOX_SIZE}x${BOX_SIZE}x${BOX_SIZE} blocks: fresh scan, A* walk, ` +
    'fail honestly when the route makes no progress.',
  params: {
    count: { type: 'number', default: 16, min: 1, max: 64 }
  },
  available: (ctx) =>
    ctx.body && typeof ctx.body.moveTo === 'function' && typeof ctx.body.snapshot === 'function'
      ? { ok: true }
      : { ok: false, reason: 'this body cannot walk to dropped items' },
  async run(ctx, params) {
    const body = ctx.body;
    const limit = params.count === undefined ? 16 : params.count;

    const first = await freshSnapshot(ctx);
    if (!first) {
      return {
        ok: false,
        failure: FAILURE.INTERRUPTED,
        reason: 'could not read a fresh body state - the client/body is not answering'
      };
    }
    if (!first.position) {
      return { ok: false, failure: FAILURE.INTERRUPTED, reason: 'the body did not report a position' };
    }

    const targets = dropsInBox(first).slice(0, limit);
    if (!targets.length) {
      return {
        ok: false,
        failure: FAILURE.TARGET_LOST,
        reason: `no dropped items within ${BOX_SIZE}x${BOX_SIZE}x${BOX_SIZE} blocks of ${fmt(first.position)}`
      };
    }

    let picked = 0;
    for (const target of targets) {
      // Was it taken while we walked to the previous one? Re-read, never assume.
      let state = await freshSnapshot(ctx);
      if (!state) {
        return {
          ok: false,
          failure: FAILURE.INTERRUPTED,
          reason: 'lost the body state while collecting',
          picked
        };
      }
      let current = dropsInBox(state).find((drop) => sameDrop(drop, target));
      if (!current) continue; // gone before we started: not our pickup

      let lastPosition = state.position;
      let collected = false;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !collected; attempt += 1) {
        await body
          .moveTo(current.position, {
            range: PICK_RANGE,
            timeoutMs: MOVE_TIMEOUT_MS,
            /**
             * `pathfind` is honoured by the client-mod body: it skips the client's
             * straight-line WalkTo so the route is actually planned (A*). Other bodies
             * ignore the flag and use their own pathfinder.
             */
            pathfind: true
          })
          .catch(() => false);

        await sleep(PICK_WAIT_MS);
        const after = await freshSnapshot(ctx);
        if (!after) {
          return {
            ok: false,
            failure: FAILURE.INTERRUPTED,
            reason: 'lost the body state after walking to a drop',
            picked
          };
        }
        if (!after.position) {
          return { ok: false, failure: FAILURE.INTERRUPTED, reason: 'the body lost its position', picked };
        }

        const still = dropsInBox(after).find((drop) => sameDrop(drop, current));
        if (!still) {
          picked += 1;
          collected = true;
          break;
        }

        const moved = distance(lastPosition, after.position);
        const closer = distance(lastPosition, current.position) - distance(after.position, current.position);
        if (moved < PROGRESS_EPS && closer < PROGRESS_EPS) {
          /**
           * Standing on the drop and it is still listed is not "blocked": the pickup may
           * simply not have registered yet (or the drop is inside a block). Leave the loop
           * and report that honestly; only a drop we cannot get closer to is blocked.
           */
          if (distance(after.position, current.position) <= PICK_RANGE + 0.5) {
            if (attempt + 1 >= MAX_ATTEMPTS) break;
            // One more read after a short wait: the pickup may just be a tick late.
            await sleep(300);
            lastPosition = after.position;
            current = still;
            continue;
          }
          const why = body.lastMove && body.lastMove.reason ? String(body.lastMove.reason) : '';
          const failure = why ? classifyMove(why) : FAILURE.NO_PATH;
          return {
            ok: false,
            failure,
            reason:
              `blocked: zero progress toward ${dropName(current) || 'the drop'} at ${fmt(current.position)}` +
              (why ? ` (${why})` : ''),
            picked
          };
        }

        lastPosition = after.position;
        current = still;
      }

      if (!collected) {
        return {
          ok: false,
          failure: FAILURE.NO_PATH,
          reason:
            `reached ${dropName(current) || 'the drop'} at ${fmt(current.position)} but the pickup never ` +
            'registered (drop inside a block, or the body reported it late)',
          picked
        };
      }
    }

    if (picked === 0) {
      return {
        ok: false,
        failure: FAILURE.TARGET_LOST,
        reason: 'every drop in range disappeared before I could reach it'
      };
    }
    return {
      ok: true,
      picked,
      scanned: targets.length,
      detail: `picked up ${picked} of ${targets.length} drop(s) within ${BOX_SIZE}x${BOX_SIZE}x${BOX_SIZE}`
    };
  }
});
