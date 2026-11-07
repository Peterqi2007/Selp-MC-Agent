'use strict';

/**
 * Corpse recovery - walk back to where the agent died and take its items out of the corpse.
 *
 * This runs while the brain is still stopped (the `dead` hold is only cleared afterwards), so
 * it may not go through the planner, the task hub or a plan: it is a bounded, deterministic
 * sequence over body primitives that the fully-autonomous mode owns.
 *
 * Deliberate limits, all of them refusals rather than heroics:
 *   - a corpse in another dimension is **not** chased (there is no cross-dimension navigation);
 *   - a corpse further than `maxCorpseDistance` is not chased (the agent would walk into
 *     unloaded terrain with no way to verify progress);
 *   - a corpse sitting in lava/fire/cactus/void is not chased (the previous death is the
 *     evidence of what happens there);
 *   - only `corpse`-shaped containers are looted (see skills/corpse.js).
 *
 * Every failure comes back as `{ ok:false, reason }` with a machine-readable reason, because
 * the mode has to keep the curriculum running instead of parking on a lost corpse forever.
 */

const { findCorpseEntities, lootCorpse } = require('../skills/corpse');

const HAZARD_BLOCKS = /^(lava|fire|soul_fire|magma_block|cactus|powder_snow|campfire|sweet_berry_bush)$/;
const HAZARD_NEIGHBOURS = /^(lava|fire|soul_fire)$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function distance(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function fmt(position) {
  if (!position) return '(unknown)';
  return `${Math.floor(Number(position.x))},${Math.floor(Number(position.y))},${Math.floor(Number(position.z))}`;
}

function cancelled(signal) {
  return typeof signal === 'function' && signal() === true;
}

/** Total item stacks in an inventory map, useful for a before/after comparison. */
function inventoryTotal(inventory) {
  let total = 0;
  for (const count of Object.values(inventory || {})) total += Number(count) || 0;
  return total;
}

/** Sum of one inventory map minus another (what recovery actually brought back). */
function inventoryDelta(before, after) {
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  let added = 0;
  let removed = 0;
  for (const name of names) {
    const diff = (Number((after || {})[name]) || 0) - (Number((before || {})[name]) || 0);
    if (diff > 0) added += diff;
    if (diff < 0) removed += -diff;
  }
  return { added, removed, net: added - removed };
}

function blockNameAt(body, position) {
  if (!body || typeof body.blockAt !== 'function' || !position) return null;
  try {
    const block = body.blockAt(position);
    const name = block && (block.name || block.id);
    return name ? String(name).replace(/^minecraft:/, '').split('[')[0] : null;
  } catch {
    return null;
  }
}

/**
 * Is the corpse position somewhere the agent must not walk?
 *
 * Checked at the death cell and the six neighbours (a corpse floating on lava is reachable in
 * the mod, but standing next to it is not worth dying for a second time).
 *
 * @returns {string|null} hazard block name, or null when it looks walkable/unknown
 */
function hazardAt(body, position) {
  if (!position) return null;
  const own = blockNameAt(body, position);
  if (own && HAZARD_BLOCKS.test(own)) return own;
  const offsets = [
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 }
  ];
  for (const offset of offsets) {
    const name = blockNameAt(body, {
      x: Math.floor(position.x) + offset.x,
      y: Math.floor(position.y) + offset.y,
      z: Math.floor(position.z) + offset.z
    });
    if (name && HAZARD_NEIGHBOURS.test(name)) return name;
  }
  return null;
}

/**
 * Walk to the corpse in short waypoints instead of one 50-block `moveTo`.
 *
 * Live A33.6 2026-11-07: a single `moveTo(deathPosition, {range:2.5})` gave up with
 * "no usable subgoal within 5 blocks of (-11,69,28)" after ~17s, so the walk never reached
 * the corpse. Short segments recompute A* from the current cell, and a lateral detour around
 * a blocked waypoint is cheaper than declaring the whole corpse unreachable.
 */
async function walkTo(body, target, options = {}) {
  const log = options.log || { info() {}, warn() {}, debug() {} };
  const cancelled = typeof options.cancelled === 'function' ? options.cancelled : () => false;
  const budgetMs = Number.isFinite(Number(options.budgetMs)) ? Number(options.budgetMs) : 120000;
  const deadline = Date.now() + budgetMs;
  const snapshot = () => (typeof body.snapshot === 'function' ? body.snapshot() : null);
  let snap = snapshot();
  let from = snap && snap.position ? snap.position : null;
  const total = distance(from, target);
  if (!from || !Number.isFinite(total)) return { ok: false, reason: 'unknown-position' };
  if (total <= 3.5) return { ok: true };
  const dir = { x: (Number(target.x) - from.x) / total, z: (Number(target.z) - from.z) / total };
  const perp = { x: -dir.z, z: dir.x };
  const step = 8;
  const waypoints = [];
  for (let travelled = step; travelled < total - 2; travelled += step) {
    /** Interpolate Y too: aiming at the start height inside a hillside is not walkable. */
    const fraction = travelled / total;
    waypoints.push({
      x: from.x + dir.x * travelled,
      y: from.y + (Number(target.y) - from.y) * fraction,
      z: from.z + dir.z * travelled
    });
  }
  waypoints.push({ x: Number(target.x), y: Number(target.y), z: Number(target.z) });

  for (const waypoint of waypoints) {
    if (cancelled()) return { ok: false, reason: 'cancelled' };
    if (Date.now() > deadline) return { ok: false, reason: 'path-failed', detail: `budget at ${fmt(waypoint)}` };
    snap = snapshot();
    const here = snap && snap.position ? snap.position : null;
    if (here && distance(here, target) <= 3.5) return { ok: true };
    const y = Number.isFinite(Number(waypoint.y)) ? Number(waypoint.y) : (here ? here.y : Number(target.y));
    const aims = [
      { x: waypoint.x, y, z: waypoint.z },
      { x: waypoint.x + perp.x * 6, y, z: waypoint.z + perp.z * 6 },
      { x: waypoint.x - perp.x * 6, y, z: waypoint.z - perp.z * 6 }
    ];
    let reached = false;
    for (const aim of aims) {
      const timeoutMs = Math.min(25000, Math.max(3000, deadline - Date.now()));
      try {
        await body.moveTo(aim, { range: 1.8, timeoutMs, pathfind: true });
      } catch (err) {
        log.debug(`corpse walk: ${err.message}`);
      }
      snap = snapshot();
      const at = snap && snap.position ? snap.position : null;
      if (at && (distance(at, target) <= 3.5 || distance(at, waypoint) <= 4.5)) { reached = true; break; }
      if (Date.now() > deadline) break;
    }
    if (!reached) {
      return { ok: false, reason: 'path-failed', detail: `stopped ${fmt(snap && snap.position)} at ${fmt(waypoint)}` };
    }
  }
  snap = snapshot();
  const at = snap && snap.position ? snap.position : null;
  return at && distance(at, target) <= 4.5
    ? { ok: true }
    : { ok: false, reason: 'path-failed', detail: `stopped ${fmt(at)}` };
}

/**
 * Recover the agent's corpse after a respawn.
 *
 * @param {object} ctx agent context (body required; log optional)
 * @param {object} options
 *   death      { position, dimension, at } recorded by DeathWatch
 *   cfg        planner.fullyAutonomous.death config block
 *   cancelled  () => boolean (stop/off/second death)
 *   inventoryBefore  inventory map captured right after respawn (for the delta)
 *   onStep     (step:string, detail:object) => void, for /ui/state
 * @returns {Promise<{ok:boolean, reason?:string, corpse?:object, items?:object, slotsMoved?:number, seconds?:number}>}
 */
async function recoverCorpse(ctx, options = {}) {
  const started = Date.now();
  const body = ctx && ctx.body;
  const log = (ctx && ctx.log) || { info() {}, warn() {}, debug() {} };
  const cfg = options.cfg || {};
  const onStep = typeof options.onStep === 'function' ? options.onStep : () => {};
  const death = options.death || {};
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;

  if (!body) return { ok: false, reason: 'no-body' };
  if (cfg.corpseRecovery === false) return { ok: false, reason: 'disabled' };
  if (cancelled(options.cancelled)) return { ok: false, reason: 'cancelled' };

  const deathPosition = death.position ? { ...death.position } : null;
  if (!deathPosition) return { ok: false, reason: 'unknown-death-position' };
  const snapshot = typeof body.snapshot === 'function' ? body.snapshot() : null;
  const currentDimension = snapshot && snapshot.dimension ? String(snapshot.dimension) : null;
  if (death.dimension && currentDimension && String(death.dimension) !== currentDimension) {
    if (cfg.allowOtherDimension !== true) {
      return { ok: false, reason: 'other-dimension', detail: `${death.dimension} -> ${currentDimension}` };
    }
  }

  const maxDistance = Number.isFinite(Number(cfg.maxCorpseDistance)) ? Number(cfg.maxCorpseDistance) : 512;
  const from = snapshot && snapshot.position ? snapshot.position : null;
  const initialDistance = distance(from, deathPosition);
  if (Number.isFinite(initialDistance) && initialDistance > maxDistance) {
    return { ok: false, reason: 'too-far', detail: `${Math.round(initialDistance)}m > ${maxDistance}m` };
  }

  const hazard = hazardAt(body, deathPosition);
  if (hazard) return { ok: false, reason: 'hazard', detail: hazard };

  const radius = Number.isFinite(Number(cfg.corpseRadius)) ? Number(cfg.corpseRadius) : 16;
  const types = Array.isArray(cfg.corpseEntityTypes) ? cfg.corpseEntityTypes : ['corpse:corpse'];

  onStep('walking', { target: deathPosition });
  const walked = await walkTo(body, deathPosition, {
    log,
    cancelled: options.cancelled,
    budgetMs: Number.isFinite(Number(cfg.walkTimeoutMs)) ? Number(cfg.walkTimeoutMs) : 120000
  });
  if (!walked.ok) return { ok: false, reason: walked.reason || 'path-failed', detail: walked.detail };

  onStep('searching', { radius });
  let corpse = null;
  for (let attempt = 1; attempt <= 3 && !corpse; attempt += 1) {
    if (cancelled(options.cancelled)) return { ok: false, reason: 'cancelled' };
    const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
    const found = findCorpseEntities(snap, { types, radius, position: deathPosition });
    if (found.length) {
      corpse = found[0];
      break;
    }
    /** A corpse can sit a few blocks off the death cell (falling, sliding). Probe around it. */
    const probe = {
      x: Number(deathPosition.x) + (attempt === 1 ? 4 : -4),
      y: Number(deathPosition.y),
      z: Number(deathPosition.z) + (attempt === 2 ? 4 : 0)
    };
    try {
      await body.moveTo(probe, { range: 2, timeoutMs: 20000, pathfind: true });
    } catch {
      /* best effort */
    }
    await sleep(400);
  }
  if (!corpse) return { ok: false, reason: 'no-corpse', detail: `within ${radius} of ${fmt(deathPosition)}` };

  onStep('looting', { corpse: corpse.id, type: corpse.type });
  const looted = await lootCorpse(ctx, {
    entityId: corpse.id,
    cancelled: options.cancelled,
    menuClassPattern: /corpse/i,
    allowAnyMenu: cfg.allowAnyMenu === true
  });

  const after = typeof body.snapshot === 'function' ? body.snapshot() : null;
  const delta = inventoryDelta(options.inventoryBefore || {}, (after && after.inventory) || {});
  const result = {
    ok: looted.ok === true,
    reason: looted.ok === true ? null : looted.reason,
    corpse: { id: corpse.id, type: corpse.type, position: corpse.position },
    menuClass: looted.menuClass || null,
    slotsMoved: looted.slotsMoved || 0,
    items: looted.items || {},
    remaining: looted.remaining === undefined ? null : looted.remaining,
    inventoryBefore: inventoryTotal(options.inventoryBefore || {}),
    inventoryAfter: inventoryTotal((after && after.inventory) || {}),
    inventoryDelta: delta,
    seconds: seconds()
  };
  if (result.ok && result.slotsMoved === 0 && delta.net <= 0) {
    /**
     * "The menu was empty" is a legitimate outcome (a second death, another player took it),
     * but it is not a recovery. Report it as such instead of a silent success.
     */
    return { ...result, ok: false, reason: 'empty-corpse' };
  }
  return result;
}

module.exports = { recoverCorpse, hazardAt, inventoryDelta, inventoryTotal };
