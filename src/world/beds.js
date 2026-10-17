'use strict';

/**
 * Bed search for night safety (P1 client tests).
 *
 * The operator allowed a wider scan: **60 x 10 x 60** around the player (horizontal +-30,
 * vertical +-5). The block map is already loaded by the client, so this is a local filter,
 * not a new scan request:
 *
 *   - only `*_bed` blocks;
 *   - inside the box;
 *   - nearest first.
 *
 * A bed outside the box is ignored even if the client scan can see it. If nothing is found,
 * callers must stop for the night rather than wander.
 */

const { bare } = require('./items');

const DEFAULT_BOX = { halfX: 30, halfY: 5, halfZ: 30, maxDistance: 64, count: 32 };

function horizontalDistance(position, center) {
  return Math.hypot(position.x - center.x, position.z - center.z);
}

/**
 * @param {{findBlocksMatching:Function}} searcher body or world view
 * @param {{x:number,y:number,z:number}|null} center player position
 * @param {object} [options] { halfX, halfY, halfZ, maxDistance, count }
 * @returns {object|null} nearest bed inside the box
 */
function findBedNear(searcher, center, options = {}) {
  if (!searcher || typeof searcher.findBlocksMatching !== 'function') return null;
  const box = { ...DEFAULT_BOX, ...options };
  let beds = [];
  try {
    beds = searcher.findBlocksMatching((name) => /_bed$/.test(bare(name)), {
      maxDistance: box.maxDistance,
      count: box.count
    });
  } catch {
    return null;
  }
  if (!Array.isArray(beds) || !beds.length) return null;
  const inside = beds.filter((bed) => {
    if (!bed || !bed.position) return false;
    if (!center) return true;
    return (
      Math.abs(bed.position.x - center.x) <= box.halfX &&
      Math.abs(bed.position.y - center.y) <= box.halfY &&
      Math.abs(bed.position.z - center.z) <= box.halfZ
    );
  });
  if (!inside.length) return null;
  inside.sort((a, b) => {
    if (!center) return 0;
    return horizontalDistance(a.position, center) - horizontalDistance(b.position, center);
  });
  return inside[0];
}

module.exports = { findBedNear, DEFAULT_BOX };
