'use strict';

/**
 * Task: store loot in a chest.
 *
 * Two modes:
 *   - with an existing chest in range: deposit everything except the keep-list
 *   - without one: craft a chest from planks and place it, then deposit
 *
 * Keeps the agent's inventory free, which matters a lot because a full inventory
 * silently breaks mining (drops are never picked up).
 */

const { Task } = require('./task');
const { countItem, isLog } = require('../world/items');
const { sleep, placeBlockAgainst } = require('../core/movement');

const DEFAULT_KEEP = [
  'crafting_table', 'furnace', 'torch', 'coal', 'charcoal', 'stick',
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'apple',
  'water_bucket', 'bucket', 'shield'
];

class DepositTask extends Task {
  constructor(ctx, options = {}) {
    super(ctx, {
      name: 'deposit',
      description: options.description || 'store items in a chest',
      timeoutMs: options.timeoutMs || 90000
    });
    this.keep = new Set([...(options.keep || []), ...DEFAULT_KEEP]);
    this.deposited = 0;
  }

  progress() {
    return this.deposited;
  }

  async run() {
    const { bot, world, nav, log } = this.ctx;
    let chest = world.nearestContainer(32);

    if (!chest) {
      log.info('no chest nearby, crafting one');
      const made = await this.craftChest();
      if (!made) return this.fail('no chest and could not craft one');
      chest = await this.placeChest();
      if (!chest) return this.fail('could not place chest');
    }

    const reached = await nav.gotoTouchable(chest, { timeoutMs: 20000 });
    if (!reached) return this.fail('chest unreachable');

    let container;
    try {
      container = await bot.openContainer(chest);
    } catch (err) {
      return this.fail(`could not open chest: ${err.message}`);
    }

    try {
      for (const item of bot.inventory.items()) {
        if (this.keep.has(item.name)) continue;
        if (isTool(item.name)) continue;
        try {
          await container.deposit(item.type, null, item.count);
          this.deposited += item.count;
        } catch (err) {
          log.debug(`deposit ${item.name} failed: ${err.message}`);
        }
        if (this.cancelled) break;
      }
    } finally {
      try {
        container.close();
      } catch {
        /* ignore */
      }
    }
    this.checkpoint();
    if (this.deposited === 0) return this.fail('nothing to deposit');
    return this.succeed(`deposited ${this.deposited} items`);
  }

  async craftChest() {
    if (countItem(this.ctx.bot, 'chest') > 0) return true;
    const planks = countItem(this.ctx.bot, 'chest_planks') || countPlanks(this.ctx.bot);
    if (planks >= 8) {
      const ok = await this.ctx.craft({ item: 'chest', count: 1, requireTable: true }).catch(() => false);
      if (ok && countItem(this.ctx.bot, 'chest') > 0) return true;
    }
    // Convert logs to planks first if needed.
    const logItem = this.ctx.bot.inventory.items().find((i) => isLog(i.name));
    if (logItem) {
      await this.ctx.craft({ item: logItem.name.replace(/_log$/, '_planks'), count: 4, requireTable: false }).catch(() => {});
      const ok = await this.ctx.craft({ item: 'chest', count: 1, requireTable: true }).catch(() => false);
      if (ok && countItem(this.ctx.bot, 'chest') > 0) return true;
    }
    return countItem(this.ctx.bot, 'chest') > 0;
  }

  async placeChest() {
    const { bot, log } = this.ctx;
    const item = bot.inventory.items().find((i) => i.name === 'chest');
    if (!item) return null;
    const base = bot.entity.position.floored();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ground = bot.blockAt(base.offset(dx, -1, dz));
      const space = bot.blockAt(base.offset(dx, 0, dz));
      if (!ground || !space) continue;
      if (ground.name === 'air' || ground.name === 'water') continue;
      if (space.name !== 'air' && space.name !== 'grass') continue;
      const ok = await placeBlockAgainst(this.ctx.controller, 'chest', ground, { x: 0, y: 1, z: 0 });
      if (ok) {
        await sleep(300);
        const placed = bot.blockAt(base.offset(dx, 0, dz));
        if (placed && /chest|barrel/.test(placed.name)) {
          log.info('chest placed');
          return placed;
        }
      }
    }
    return null;
  }
}

function isTool(name) {
  return /_(pickaxe|axe|shovel|sword|hoe|helmet|chestplate|leggings|boots)$/.test(name);
}

function countPlanks(bot) {
  return bot.inventory.items().filter((i) => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
}

module.exports = { DepositTask, DEFAULT_KEEP };
