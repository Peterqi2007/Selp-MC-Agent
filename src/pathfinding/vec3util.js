'use strict';

/**
 * Position type for the pathfinder, and the `hash` shim it requires.
 *
 * WHY THIS EXISTS (two separate traps, both verified on this machine)
 * ------------------------------------------------------------------
 * 1. **A\* keys its sets on `data.hash`.**
 *    `mineflayer-pathfinder`'s solver does `openDataMap.set(node.data.hash, ...)` and
 *    `openDataMap.get(neighborData.hash)` directly (astar.js:48, 81, 91). The `vec3`
 *    package provides **no** `hash` at all - `v(1,2,3).hash === undefined` - so feeding it
 *    bare vectors makes A* treat every node as the same key. It does not throw; it just
 *    returns `noPath` after visiting one node, which is a maddening thing to debug.
 *
 * 2. **`require('vec3')` is a factory function, not the class.**
 *    `module.exports = v` where `v()` returns `new Vec3(...)`, and the class is exposed
 *    separately as `v.Vec3`. Worse, every `Vec3` method (`floored()`, `offset()`,
 *    `translate()`, `scaled()`...) constructs a **plain `Vec3`** internally, so subclassing
 *    silently loses your extra members the first time the pathfinder floors a vector.
 *    An earlier version of this file subclassed `Vec3` and got `hash === undefined` for
 *    exactly that reason.
 *
 * CONCLUSION: do not subclass. Use a small plain object that carries what the solver and
 * the movement model actually touch - `x`, `y`, `z`, `hash`, `cost` - and convert at the
 * boundaries. This is the "vec3 垫片 (shim)" the plan called for, minus the inheritance
 * mistake.
 */

/**
 * @typedef {object} PathVec
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {string} hash   stable key for block-floor coordinates
 * @property {number} [cost] traversal cost, set on neighbours by the movement model
 */

/**
 * Create a path-capable position.
 * @returns {PathVec}
 */
function v3(x, y, z) {
  const fx = x | 0;
  const fy = y | 0;
  const fz = z | 0;
  return {
    x: fx,
    y: fy,
    z: fz,
    // Block-granular: two floats inside the same block must collide, which is what makes
    // the closed/open sets work on integer block coordinates.
    hash: `${fx},${fy},${fz}`,
    cost: undefined
  };
}

/**
 * Normalise anything position-shaped into a PathVec.
 *
 * Accepts a PathVec, a `vec3` instance, or a plain `{x,y,z}` literal - the last being
 * what arrives from the mod's JSON, which is the common case here.
 *
 * @param {{x:number,y:number,z:number}|null|undefined} position
 * @returns {PathVec|null}
 */
function toPathVec(position) {
  if (!position) return null;
  if (typeof position.x !== 'number' || typeof position.y !== 'number' || typeof position.z !== 'number') return null;
  return v3(position.x, position.y, position.z);
}

/** Stable key for block coordinates, usable without constructing a vector. */
function blockKey(x, y, z) {
  return `${x | 0},${y | 0},${z | 0}`;
}

/** Euclidean distance between two positions. */
function distanceBetween(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

module.exports = { v3, toPathVec, blockKey, distanceBetween };
