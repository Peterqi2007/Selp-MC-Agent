'use strict';

/**
 * Task: chop wood.
 *
 * The first thing any survival agent needs. Walks to the nearest log, digs out the
 * trunk, collects the drops, and repeats until the target count is reached or no tree
 * can be found.
 *
 * This is the reference implementation for the Body contract: it never touches
 * mineflayer, so it runs identically against a real bot, a scripted mock world, or a
 * Forge client driven by the control mod.
 */

const { Task } = require('./task');
const { sleep } = require('../core/movement');
const { isLog } = require('../world/items');

class GatherWoodTask extends Task {
  constructor(ctx, options = {}) {
    super(ctx, {
      name: 'gather-wood',
      description: `gather ${options.count || 16} logs`,
      timeoutMs: options.timeoutMs || 180000
    });
    this.target = options.count || ctx.cfg.agent.survival.targetWood || 16;
    this.searchRadius = options.searchRadius || 48;
    this.treesChopped = 0;
  }

  progress() {
    return this.countLogs();
  }

  async run() {
    const { world, log } = this.ctx;
    const body = this.body;
    if (!body) return this.fail('no body attached');
    /** Snapshot of progress at entry, used to detect "this grove is exhausted". */
    this.startedWith = this.progress();

    // Perception is frequently incomplete right after connecting: give the world a
    // moment to arrive before concluding "there are no trees here".
    if (!world.findNearestLog(this.searchRadius)) {
      log.info('no tree visible yet, waiting for world data');
      await sleep(3000);
    }

    let guard = 0;
    let failedWalks = 0;
    while (this.progress() < this.target && guard < 40) {
      guard += 1;
      if (this.cancelled) return this.fail('cancelled');
      if (!body.isReady) return this.fail('body is gone');

      const tree = world.findNearestLog(this.searchRadius);
      if (!tree) {
        if (this.progress() > 0) return this.succeed(`no more trees nearby, have ${this.progress()} logs`);
        // Nothing close: roam a little and look again.
        log.warn('no tree in range, wandering to search');
        const here = this.position || { x: 0, y: 64, z: 0 };
        await body
          .moveTo(
            { x: here.x + (Math.random() - 0.5) * 40, y: here.y, z: here.z + (Math.random() - 0.5) * 40 },
            { timeoutMs: 12000, range: 4 }
          )
          .catch(() => false);
        continue;
      }

      const reached = await body.moveTo(tree.position, { range: 1, timeoutMs: 20000 }).catch(() => false);
      if (!reached) {
        this.log.debug(`could not reach ${tree.name} at ${fmt(tree.position)}`);
        failedWalks += 1;
        if (failedWalks >= 3) {
          log.warn('cannot reach any nearby tree - giving up on this grove');
          break;
        }
        await sleep(300);
        continue;
      }
      failedWalks = 0;

      const chopped = await this.chopTree(tree);
      if (chopped > 0) this.treesChopped += 1;
      else this.log.debug(`found ${tree.name} at ${fmt(tree.position)} but could not dig it`);

      await this.collectDrops();
      this.checkpoint();
    }

    if (this.progress() >= this.target) {
      return this.succeed(`collected ${this.progress()} logs (${this.treesChopped} trees)`);
    }

    // Not enough, but no progress after searching the whole radius means the grove is
    // exhausted. Reporting that as a hard failure would make the planner re-queue the
    // same goal forever on a map with few trees; reporting success lets it move on.
    const gained = this.progress() - (this.startedWith || 0);
    if (gained === 0) {
      return this.succeed(`no trees available nearby (still have ${this.progress()}/${this.target} logs)`);
    }
    return this.fail(`only collected ${this.progress()}/${this.target} logs`);
  }

  /** Dig the target log plus the connected trunk above it. */
  async chopTree(startBlock) {
    const body = this.body;
    const { world } = this.ctx;
    let chopped = 0;
    let current = startBlock;

    for (let i = 0; i < 12 && current; i += 1) {
      if (this.cancelled) break;

      // Re-read through the world view so we notice if someone else took it.
      const fresh = world.blockAtAbsolute ? world.blockAtAbsolute(current.position) : null;
      const target = fresh && isLog(fresh.name) ? fresh : null;
      if (!target) break;

      const ok = await body.dig(target, { timeoutMs: 12000 }).catch(() => false);
      if (!ok) break;
      chopped += 1;

      // Next trunk segment: the block directly above, if it is also a log.
      const above = world.blockAtAbsolute
        ? world.blockAtAbsolute({ x: target.position.x, y: target.position.y + 1, z: target.position.z })
        : null;
      current = above && isLog(above.name) ? above : null;
    }

    if (chopped) this.log.info(`chopped ${chopped} logs`);
    return chopped;
  }

  /** Walk over nearby dropped items so the body can pick them up. */
  async collectDrops(attempts = 4) {
    const body = this.body;
    const world = this.ctx.world;
    for (let i = 0; i < attempts; i += 1) {
      const drops = world.nearbyItemEntities ? world.nearbyItemEntities(6) : [];
      if (!drops.length) return;
      const drop = drops[0];
      const position = drop.position || (drop.entity && drop.entity.position);
      if (!position) return;
      await body.moveTo(position, { range: 1, timeoutMs: 8000 }).catch(() => false);
      await sleep(200);
    }
  }

  /** Wood type the body has most of - used when the planner wants planks. */
  dominantWood() {
    const counts = new Map();
    for (const item of this.inventory.items()) {
      if (!isLog(item.name)) continue;
      counts.set(item.name, (counts.get(item.name) || 0) + item.count);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) return null;
    const base = best[0].replace(/_log$/, '').replace(/_stem$/, '');
    return { log: best[0], planks: `${base}_planks`, count: best[1] };
  }
}

function fmt(position) {
  if (!position) return '(unknown)';
  return `(${position.x}, ${position.y}, ${position.z})`;
}

module.exports = { GatherWoodTask };
