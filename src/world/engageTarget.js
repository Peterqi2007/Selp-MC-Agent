'use strict';

/**
 * Which hostile the self-defense reflex should engage.
 *
 * Why this exists as its own module (2026-11-01 live incident): a phantom (幻翼) attacked the
 * bot until it dropped below the flee threshold, and the reflex never fought back. The inline
 * filter accepted only hostiles inside XZ 15 and |dy| <= 4; phantoms dive from ~10 blocks
 * above, so the only hostile around was filtered out. The reflex then saw "danger" (low hp)
 * with "no retreat target within 7 blocks" and spam-looped instead of attacking.
 *
 * Two rules keep that from happening again:
 *
 *   1. flying hostiles get a wider vertical window (they attack from above);
 *   2. if we were hurt THIS tick, the nearest hostile in the 24-block scan is engaged even
 *      outside the window - something just hit us, so "it is too far up to care" is wrong.
 */

const FLYING_HOSTILES =
  /^(?:minecraft:)?(?:phantom|ghast|vex|blaze|wither|ender_dragon|shulker|bee|parrot|allay|bat)$/i;

function isFlyingHostile(name) {
  return FLYING_HOSTILES.test(String(name || '').trim());
}

/** world.hostiles() entries -> plain targets with horizontal/vertical distance split. */
function normalise(entry, origin) {
  const entity = (entry && entry.entity) || {};
  const position = entity.position || (entry && entry.position) || null;
  const name = String(entity.name || (entry && entry.name) || '');
  const id = entity.id !== undefined ? entity.id : entry && entry.id;
  const distance = Number.isFinite(Number(entry && entry.distance)) ? Number(entry.distance) : null;
  const xzDistance = origin && position ? Math.hypot(position.x - origin.x, position.z - origin.z) : distance || 0;
  const verticalDistance = origin && position ? Math.abs(position.y - origin.y) : null;
  return { id, name, position, distance: distance === null ? xzDistance : distance, xzDistance, verticalDistance };
}

function byWindow(a, b) {
  return (a.xzDistance || 0) - (b.xzDistance || 0) || (a.distance || 0) - (b.distance || 0);
}

/**
 * @returns {{target: object|null, reason: 'window'|'hurt-outside-window'|'none'}}
 */
function pickEngageTarget({
  hostiles = [],
  origin = null,
  engageRadiusXZ = 15,
  engageRadiusY = 4,
  engageRadiusYFlying = 12,
  hurtThisTick = false,
  shouldSkip = null
} = {}) {
  const all = (hostiles || [])
    .map((entry) => normalise(entry, origin))
    .filter((target) => (typeof shouldSkip === 'function' ? !shouldSkip(target.id, target.distance) : true));
  const inWindow = all
    .filter((target) => {
      if (!origin) return true;
      if (target.xzDistance > engageRadiusXZ) return false;
      if (target.verticalDistance === null) return true;
      const limit = isFlyingHostile(target.name) ? Math.max(engageRadiusYFlying, engageRadiusY) : engageRadiusY;
      return target.verticalDistance <= limit;
    })
    .sort(byWindow);
  if (inWindow.length) return { target: inWindow[0], reason: 'window' };
  if (hurtThisTick) {
    const nearest = all
      .filter((target) => !origin || target.xzDistance <= 24)
      .sort((a, b) => (a.distance || 0) - (b.distance || 0));
    if (nearest.length) return { target: nearest[0], reason: 'hurt-outside-window' };
  }
  return { target: null, reason: 'none' };
}

module.exports = { pickEngageTarget, isFlyingHostile };
