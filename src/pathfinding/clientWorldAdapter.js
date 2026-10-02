'use strict';

/**
 * ClientWorldAdapter: presents the mod's flat `blocks.cells` map as the block-lookup
 * world that the movement model expects.
 *
 * The mod sends a flat map of "x,y,z" -> "namespace:block" covering a 49x49x17 box
 * (40817 cells) around the player. That is the entire world knowledge we have, and the
 * hard limit of 24 blocks of horizontal reach is a first-class constraint of this
 * planner, not an implementation detail - see `inGrid()`.
 *
 * The critical honesty rule: a coordinate OUTSIDE the grid returns `null` ("unknown"),
 * never "air". Treating unknown as air would make the planner cheerfully route the bot
 * into unloaded terrain, and the walker would then fail in a way that looks like a
 * pathfinding bug rather than a perception limit.
 */

const { PASSABLE } = require('../world/items');
const { blockKey } = require('./vec3util');

/** Half-width of the mod's horizontal scan. Kept in sync with ClientStateSnapshot.SCAN_RADIUS. */
const SCAN_RADIUS = 24;
const SCAN_UP = 8;
const SCAN_DOWN = 8;

/**
 * Solid blocks you cannot stand on top of.
 *
 * This list exists because of one specific, very visible failure. A fence, a cobblestone wall,
 * a glass pane, iron bars or a closed door occupies its cell and is therefore `solid`, and the
 * cell *above* it is air - so a movement model that only asks "is the block below solid?"
 * concludes "you can step up onto the fence". The client then walks into the fence, presses
 * jump on collision, and is still jumping at it a minute later. That is the exact shape of
 * the reported "it keeps jumping and never goes anywhere".
 *
 * The P0 bias applies: it is better to route *around* a fence (or report `noPath`) than to
 * plan a move the bot physically cannot perform. Judging a fence by shape rather than trying
 * to be clever about jumping from a neighbouring block costs a detour and nothing else.
 *
 * Slabs and stairs are deliberately absent: you really can stand on those, and the client's
 * automatic 0.6-block step handles them without a jump.
 */
const NOT_STANDABLE = /(^|_)(fence|fence_gate|wall|pane|bars|chain|door|trapdoor|carpet|button|pressure_plate|candle|sign|banner|bed|gate|rod|lantern|torch|flower_pot|skull|head|hopper|cauldron|composter|anvil|grindstone|stonecutter|lectern|bell|brewing_stand|enchanting_table|daylight_detector|repeater|comparator|tripwire_hook|lever|rail|bush|sapling|kelp|seagrass|coral|amethyst_cluster|bud|pointed_dripstone|sculk_sensor|sculk_shrieker|turtle_egg|sniffer_egg|dragon_egg|cocoa|sweet_berry)$/;

/**
 * Movement-relevant properties of a block, derived from its name.
 *
 * Deliberately a small, testable pure function rather than pulling in the whole
 * minecraft-data block table: P0 only needs to know whether a cell blocks movement,
 * whether it is a liquid, whether it is climbable, and whether it can be stood *on*.
 *
 * @param {string} name e.g. "minecraft:oak_log" or "create:cogwheel"
 * @returns {{name:string, bare:string, solid:boolean, liquid:boolean, lava:boolean, climbable:boolean, dangerous:boolean, standable:boolean}}
 */
function describeBlock(name) {
  const bare = String(name).replace(/^[a-z0-9_]+:/i, '');
  const liquid = /^(water|flowing_water|bubble_column)$/.test(bare);
  const lava = /^(lava|flowing_lava)$/.test(bare);
  const climbable = /^(ladder|vine|scaffolding|twisting_vines|weeping_vines|cave_vines)$/.test(bare);
  // Things that hurt to stand in; the movement model refuses to enter them.
  const dangerous = lava || /^(fire|soul_fire|magma_block|cactus|sweet_berry_bush|powder_snow|wither_rose)$/.test(bare);
  const solid = !PASSABLE.has(bare) && !liquid && !lava;
  return {
    name,
    bare,
    // PASSABLE is the curated set from src/world/items.js; anything not listed blocks.
    solid,
    liquid,
    lava,
    climbable,
    dangerous,
    /**
     * Can the bot stand on top of this block?
     *
     * `false` for anything with a partial or non-full collision shape that does not give you
     * a surface at the top of its own cell (see NOT_STANDABLE). Non-solid blocks are never a
     * floor either, whatever their shape.
     */
    standable: solid && !NOT_STANDABLE.test(bare)
  };
}

/** True when a block can be walked through. */
function isPassableBlock(description) {
  return !!description && !description.solid;
}

class ClientWorldAdapter {
  /**
   * @param {object} body a Body with snapshot() exposing blocks.cells
   * @param {object} [options] { log }
   */
  constructor(body, options = {}) {
    this.body = body;
    this.log = options.log || { debug() {}, warn() {} };
    /** Exposed so diagnostics can explain "out of grid" instead of guessing. */
    this.scanRadius = options.scanRadius || SCAN_RADIUS;
    this.scanUp = options.scanUp || SCAN_UP;
    this.scanDown = options.scanDown || SCAN_DOWN;
  }

  /** The raw cell map from the latest snapshot, or null. */
  cells() {
    const snap = this.body && this.body.snapshot();
    if (!snap || !snap.ready) return null;
    return (snap.blocks && snap.blocks.cells) || null;
  }

  /**
   * Optional "do not go here" policy, consulted for every candidate cell.
   *
   * Set by `PathPlanner` from the `avoidManMade` option so routes never cross a player's
   * build (see src/world/safety.js). Absent by default, which keeps the offline tests
   * unaffected and makes the policy a deliberate opt-in at the wiring layer.
   *
   * @param {(position:{x:number,y:number,z:number}) => (string|null)} guard
   */
  setGuard(guard) {
    this.guard = typeof guard === 'function' ? guard : null;
  }

  /** @returns {string|null} the guard's refusal reason for this cell, if any */
  veto(position) {
    if (!this.guard) return null;
    try {
      return this.guard(position) || null;
    } catch {
      // A guard that throws must not break pathfinding; refuse the cell instead, which is
      // the conservative direction.
      return 'guard error';
    }
  }

  /** Player position from the latest snapshot, or null. */
  origin() {
    const snap = this.body && this.body.snapshot();
    return snap ? snap.position : null;
  }

  /**
   * Is a coordinate inside the region the mod actually reported?
   *
   * The grid is centred on the player, so this moves as the bot moves. Callers use it to
   * distinguish "air" from "we do not know", which is what makes long-distance planning
   * degrade into iterative replanning instead of confidently walking into the void.
   */
  inGrid(position) {
    const origin = this.origin();
    if (!origin || !position) return false;
    const dx = Math.floor(position.x) - Math.floor(origin.x);
    const dy = Math.floor(position.y) - Math.floor(origin.y);
    const dz = Math.floor(position.z) - Math.floor(origin.z);
    return (
      Math.abs(dx) <= this.scanRadius &&
      Math.abs(dz) <= this.scanRadius &&
      dy <= this.scanUp &&
      dy >= -this.scanDown
    );
  }

  /**
   * Block at an absolute position.
   *
   * @returns {{name:string, bare:string, solid:boolean, liquid:boolean, climbable:boolean}|null}
   *   null means UNKNOWN (outside the grid), not air.
   */
  blockAt(position) {
    if (!position) return null;
    const cells = this.cells();
    if (!cells) return null;
    const key = blockKey(position.x, position.y, position.z);
    const name = cells[key];
    if (name === undefined) return null;
    return describeBlock(name);
  }

  /** Convenience: is this exact cell known and passable? Unknown counts as NOT passable. */
  passable(position) {
    const block = this.blockAt(position);
    return isPassableBlock(block);
  }

  /** Count of loaded cells, for diagnostics. */
  cellCount() {
    const cells = this.cells();
    return cells ? Object.keys(cells).length : 0;
  }

  /**
   * Which target blocks are reachable in principle? Used by the harvest task to skip
   * targets that are outside the perception grid entirely.
   */
  describe(position) {
    const block = this.blockAt(position);
    if (!block) return { known: false, reason: this.inGrid(position) ? 'cell missing from map' : 'outside scan grid' };
    return { known: true, block };
  }
}

module.exports = { ClientWorldAdapter, describeBlock, isPassableBlock, NOT_STANDABLE, SCAN_RADIUS, SCAN_UP, SCAN_DOWN };
