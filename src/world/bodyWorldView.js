'use strict';

/**
 * BodyWorldView: the same read-only world API the decision layer already uses
 * (`WorldView`), but backed by a Body instead of a mineflayer instance.
 *
 * Why this exists
 * ---------------
 * `WorldView` asks mineflayer directly. That is fine for the mineflayer body, but it
 * means the planner cannot run against a scripted world (MockBody) or a real Forge
 * client (ClientModBody) — both of which expose state through the Body contract, not
 * through mineflayer.
 *
 * Rather than rewrite `brain.js` to speak to a new interface, this adapter keeps the
 * exact `WorldView` surface and answers from `body.snapshot()` / `body.findBlocks*()`.
 * The result: the planner is body-agnostic without moving a single line of decision
 * logic, which is what the abstraction was for.
 *
 * Only the capabilities a Body can actually express are implemented. Anything else
 * returns a sensible "unknown" rather than throwing, so a degraded body degrades the
 * plan instead of crashing the agent.
 */

const { isLog } = require('./items');

class BodyWorldView {
  /**
   * @param {object} body a Body implementation
   * @param {object} cfg loaded agent config
   * @param {object} [options] { log }
   */
  constructor(body, cfg, options = {}) {
    this.body = body;
    this.cfg = cfg;
    this.log = options.log || { debug() {}, warn() {}, info() {} };
    /** Cache of the last snapshot, used by block lookups between updates. */
    this._last = null;
  }

  get ready() {
    return !!(this.body && this.body.isReady);
  }

  /** Latest state; refreshed lazily so repeated reads in one tick are cheap. */
  snapshot(force = false) {
    if (force || !this._last) this._last = this.body ? this.body.snapshot() : null;
    return this._last;
  }

  invalidate() {
    this._last = null;
  }

  // ------------------------------------------------------------------- time

  isNight() {
    const snap = this.snapshot();
    return snap && snap.time ? !snap.time.isDay : false;
  }

  timeOfDay() {
    const snap = this.snapshot();
    return snap && snap.time ? snap.time.timeOfDay : 0;
  }

  day() {
    const snap = this.snapshot();
    return snap && snap.time ? snap.time.day : 0;
  }

  isRaining() {
    const snap = this.snapshot();
    return !!(snap && snap.weather && snap.weather.raining);
  }

  // --------------------------------------------------------------- position

  position() {
    const snap = this.snapshot();
    return snap ? { ...snap.position } : null;
  }

  dimension() {
    const snap = this.snapshot();
    return (snap && snap.dimension) || 'minecraft:overworld';
  }

  /**
   * Block at a RELATIVE offset from the body (kept for WorldView API compatibility).
   * For absolute coordinates use `blockAtAbsolute`.
   */
  blockAt(x, y, z) {
    const snap = this.snapshot();
    if (!snap) return null;
    const position =
      typeof x === 'object' && x !== null
        ? { x: snap.position.x + (x.x || 0), y: snap.position.y + (x.y || 0), z: snap.position.z + (z === undefined ? x.z || 0 : 0) }
        : { x: snap.position.x + (x || 0), y: snap.position.y + (y || 0), z: snap.position.z + (z || 0) };
    return this.body.blockAt(position);
  }

  /**
   * Block at ABSOLUTE world coordinates.
   *
   * This distinction matters and was a real bug source: `blockAt` is offset-based
   * (inherited from the mineflayer WorldView, where `bot.blockAt(pos.offset(...))` was
   * the idiom), while tasks think in absolute positions. Mixing them silently returns
   * the wrong block - which looks exactly like "the tree is not there".
   */
  blockAtAbsolute(position) {
    if (!position) return null;
    return this.body.blockAt(position);
  }

  groundLevel() {
    const snap = this.snapshot();
    if (!snap) return null;
    for (let dy = 2; dy >= -4; dy -= 1) {
      const block = this.body.blockAt({ x: snap.position.x, y: snap.position.y + dy, z: snap.position.z });
      if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'water') {
        return Math.floor(block.position.y) + 1;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- blocks

  /** Body contract only guarantees findBlocksMatching, so everything routes through it. */
  findBlock(matching, options = {}) {
    const found = this.body.findBlocksMatching(matching, {
      maxDistance: options.maxDistance || 32,
      count: 1
    });
    return found.length ? toBlockRef(found[0]) : null;
  }

  findBlocks(matching, options = {}) {
    return this.body
      .findBlocksMatching(matching, { maxDistance: options.maxDistance || 32, count: options.count || 64 })
      .map(toBlockRef);
  }

  findNearestLog(maxDistance = 48) {
    return this.findBlock((name) => isLog(name), { maxDistance, count: 1 });
  }

  findNearestBlockName(names, maxDistance = 32) {
    return this.findBlock(matchNames(names), { maxDistance, count: 1 });
  }

  findNearbyBlockNames(names, maxDistance = 32, count = 64) {
    return this.findBlocksMatching(matchNames(names), { maxDistance, count });
  }

  /** Body-agnostic predicate search (this is how "any log" is expressed). */
  findBlocksMatching(predicate, options = {}) {
    return this.body
      .findBlocksMatching(predicate, { maxDistance: options.maxDistance || 32, count: options.count || 64 })
      .map(toBlockRef);
  }

  /**
   * Can the bot break this block?
   *
   * A Body that knows real block properties (a client mod) should answer this itself;
   * for others we fall back to "assume yes unless it looks unbreakable", because
   * refusing everything would paralyse the planner.
   */
  canMine(block) {
    if (!block) return false;
    if (typeof this.body.canMine === 'function') return this.body.canMine(block);
    return !['bedrock', 'barrier', 'end_portal_frame', 'command_block', 'structure_block'].includes(block.name);
  }

  // --------------------------------------------------------------- entities

  hostiles(maxDistance = 16) {
    return this.body.hostiles(maxDistance).map((e) => ({ entity: e, distance: e.distance }));
  }

  nearestHostile(maxDistance = 16) {
    const list = this.hostiles(maxDistance);
    return list.length ? list[0] : null;
  }

  nearbyItemEntities(maxDistance = 8) {
    return this.body.itemDrops(maxDistance);
  }

  nearestContainer(maxDistance = 16) {
    return this.findNearestBlockName(['chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest'], maxDistance);
  }

  // ------------------------------------------------------------------ light

  lightLevel() {
    const snap = this.snapshot();
    return snap && snap.lightLevel !== undefined ? snap.lightLevel : 15;
  }

  isInDanger() {
    const snap = this.snapshot();
    if (!snap) return false;
    if (snap.health !== undefined && snap.health <= this.cfg.agent.behaviour.fleeHealthThreshold) return true;
    const at = this.body.blockAt({ x: snap.position.x, y: snap.position.y, z: snap.position.z });
    if (at && (at.name === 'lava' || at.name === 'fire')) return true;
    return false;
  }

  /** Same shape as WorldView.summary() so logging and the HTTP API are unaffected. */
  summary() {
    const snap = this.snapshot(true);
    if (!snap || !snap.ready) return { ready: false };
    return {
      ready: true,
      position: { x: +snap.position.x.toFixed(1), y: +snap.position.y.toFixed(1), z: +snap.position.z.toFixed(1) },
      dimension: snap.dimension,
      isDay: snap.time ? snap.time.isDay : true,
      day: snap.time ? snap.time.day : 0,
      health: snap.health,
      food: snap.food,
      light: snap.lightLevel,
      hostiles: (snap.hostiles || []).map((h) => ({ name: h.name, distance: h.distance })),
      raining: !!(snap.weather && snap.weather.raining),
      body: snap.body
    };
  }
}

/** Body block refs are already {name, position}; keep the shape stable. */
function toBlockRef(entry) {
  if (!entry) return null;
  return { name: entry.name, position: entry.position, distance: entry.distance };
}

/** Strip a namespace: "minecraft:stone" -> "stone". */
function bare(name) {
  if (!name) return '';
  const idx = String(name).indexOf(':');
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

/**
 * Build a name predicate that ignores namespaces on BOTH sides.
 *
 * Callers pass bare names ("stone", "oak_log") because that is what the survival
 * knowledge tables and task options use, but bodies report namespaced names
 * ("minecraft:stone"). Comparing them directly silently finds nothing, which looks
 * exactly like "there is no stone here".
 */
function matchNames(names) {
  const wanted = new Set(names.map(bare));
  return (name) => wanted.has(bare(name));
}

module.exports = { BodyWorldView, matchNames, bare };
