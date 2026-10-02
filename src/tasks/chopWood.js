'use strict';

/**
 * ChopWoodTask: collect logs (P0-PLAN §6.2).
 *
 * Everything generic lives in HarvestTask; this only says what a target is and that a
 * tree should be taken as a whole column rather than one block at a time.
 *
 * Why the trunk matters: walking to each of a tree's 6-8 logs individually multiplies the
 * walking - and therefore the failure surface - by six. The base log is reached once, then
 * the column above is dug in place, which is also what a human does.
 */

const { HarvestTask } = require('./harvest');
const { isLog } = require('../world/items');
const { looksLikeTree } = require('../world/safety');

/** Trees taller than this are left alone: a 2x2 jungle giant is not a P0 concern. */
const MAX_TRUNK = 12;

/** Strip a namespace: "minecraft:oak_log" -> "oak_log". */
function bare(name) {
  if (!name) return '';
  const idx = String(name).indexOf(':');
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

class ChopWoodTask extends HarvestTask {
  constructor(ctx, options = {}) {
    super(ctx, {
      ...options,
      name: options.name || 'chop-wood',
      description: options.description || `chop ${options.count || 8} logs`,
      timeoutMs: options.timeoutMs || 180000
    });
    /** Logs kept in reserve for crafting; never chop ourselves below this. */
    this.reserve = options.reserve || 0;
    /**
     * `safety.requireNaturalTrees` from config/agent.json.
     *
     * It is the difference between "only fell things that look like a tree" and "chop
     * whatever matched the name predicate", so it is honoured rather than assumed. Leave it on
     * on any server you do not own - a log is a log whether it grows or holds up a roof.
     */
    const cfgSafety = (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.safety) || {};
    this.requireNaturalTrees =
      options.requireNaturalTrees === undefined ? cfgSafety.requireNaturalTrees !== false : options.requireNaturalTrees !== false;
    /**
     * `safety.requireLeaves` (default on): a trunk only counts as a tree if it carries a
     * canopy. Without it, a player's log pillar on grass passes every structural test and gets
     * eaten - see `findCanopy()` in src/world/safety.js.
     */
    this.requireLeaves = options.requireLeaves === undefined ? cfgSafety.requireLeaves !== false : options.requireLeaves !== false;
  }

  isTarget(name) {
    return isLog(bare(name));
  }

  /**
   * A log is only a target if it is part of a *tree*.
   *
   * This is the check that keeps the agent out of trouble on a public server: a log cabin,
   * a fence post, a decorative pillar and a chest room's ceiling are all made of logs, and
   * `isLog()` cannot tell them apart from a forest. `looksLikeTree()` requires the whole
   * shape - natural ground under the column, more than one block tall, nothing built touching
   * it, **and leaves on top** - and refuses anything that fails.
   */
  extraSafetyCheck(block) {
    if (!this.requireNaturalTrees) return null;
    const verdict = looksLikeTree(this.ctx.world, block, { requireLeaves: this.requireLeaves });
    return verdict.ok ? null : verdict.why;
  }

  countsAsHarvest(itemName) {
    return isLog(bare(itemName));
  }

  unitName() {
    return 'logs';
  }

  /**
   * Take the rest of the trunk above the block we just broke.
   *
   * Re-reads each block before digging so a log another player already removed ends the
   * column cleanly instead of producing a failed dig per level.
   */
  async afterBreak(block) {
    const world = this.ctx.world;
    if (!world || !world.blockAtAbsolute) return 0;

    let chopped = 0;
    let y = Math.floor(block.position.y) + 1;

    for (let level = 0; level < MAX_TRUNK; level += 1) {
      if (this.cancelled) break;
      const above = world.blockAtAbsolute({ x: Math.floor(block.position.x), y, z: Math.floor(block.position.z) });
      if (!above || !this.isTarget(above.name)) break;

      const ok = await this.breakBlock(above);
      if (!ok) break;
      chopped += 1;
      y += 1;
    }

    if (chopped) this.log.debug(`chopped ${chopped + 1} logs from the trunk at ${block.position.x},${block.position.z}`);
    return chopped;
  }

  /** True when chopping more would eat into the reserve kept for crafting. */
  canPickUpMore() {
    if (!this.reserve) return false;
    return this.countLogs() > this.reserve;
  }
}

module.exports = { ChopWoodTask, MAX_TRUNK };
