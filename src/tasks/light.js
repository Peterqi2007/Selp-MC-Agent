'use strict';

/**
 * Task: light up the area.
 *
 * Placing torches keeps hostile mobs from spawning where the agent works, which is
 * cheaper than fighting them. Also crafts torches from coal/charcoal + sticks when
 * the inventory runs dry.
 */

const { Task } = require('./task');
const { countItem, countMatching, isLog, planksFor } = require('../world/items');
const { sleep } = require('../core/movement');

class LightTask extends Task {
  constructor(ctx, options = {}) {
    super(ctx, {
      name: 'light',
      description: options.description || `place ${options.count || 4} torches`,
      timeoutMs: options.timeoutMs || 90000
    });
    this.wanted = options.count || 4;
    this.placed = 0;
  }

  progress() {
    return this.placed;
  }

  async run() {
    const { bot, log } = this.ctx;
    await this.ensureTorches();
    if (countItem(bot, 'torch') === 0) return this.fail('no torches and no coal/charcoal to craft them');

    for (let i = 0; i < this.wanted; i += 1) {
      if (this.cancelled) break;
      const torch = bot.inventory.items().find((it) => it.name === 'torch');
      if (!torch) break;
      if (this.ctx.world.lightLevel() > this.ctx.cfg.agent.survival.torchLightLevel) break;

      const ok = await this.placeOnGround(torch);
      if (ok) this.placed += 1;
      else {
        // Try one step in a random direction, torches fail often against slabs/plants.
        const p = bot.entity.position;
        await this.ctx.nav.goto(p.offset((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6), { timeoutMs: 6000, range: 2 });
      }
      await sleep(150);
    }
    this.checkpoint();
    if (this.placed === 0) return this.fail('could not place any torch');
    return this.succeed(`placed ${this.placed} torches`);
  }

  async placeOnGround(torchItem) {
    const { bot, log } = this.ctx;
    const base = bot.entity.position.floored();
    const candidates = [
      [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]
    ];
    for (const [dx, dz] of candidates) {
      const ground = bot.blockAt(base.offset(dx, -1, dz));
      const space = bot.blockAt(base.offset(dx, 0, dz));
      if (!ground || !space) continue;
      if (ground.name === 'air' || ground.name === 'water' || ground.name === 'lava') continue;
      if (space.name !== 'air' && space.name !== 'grass' && space.name !== 'tall_grass') continue;
      try {
        await bot.equip(torchItem, 'hand');
        await bot.placeBlock(ground, { x: 0, y: 1, z: 0 });
        log.info(`torch placed at ${base.offset(dx, 0, dz)}`);
        return true;
      } catch (err) {
        log.debug(`torch placement failed: ${err.message}`);
      }
    }
    return false;
  }

  /** Craft torches from coal/charcoal + sticks (crafting sticks from planks if needed). */
  async ensureTorches() {
    const { bot, craft, log } = this.ctx;
    if (countItem(bot, 'torch') > 0) return;

    const coal = countItem(bot, 'coal') + countItem(bot, 'charcoal');
    if (coal === 0) return;

    if (countItem(bot, 'stick') < 1) {
      const plank = bot.inventory.items().find((i) => /_planks$/.test(i.name));
      const logItem = bot.inventory.items().find((i) => isLog(i.name));
      if (plank) {
        await craft({ item: 'stick', count: 4, requireTable: false }).catch(() => {});
      } else if (logItem) {
        await craft({ item: planksFor(logItem.name, bot.registry), count: 1, requireTable: false }).catch(() => {});
        await craft({ item: 'stick', count: 4, requireTable: false }).catch(() => {});
      }
    }

    const want = Math.min(4 * coal, 16);
    const ok = await craft({ item: 'torch', count: want, requireTable: false }).catch(() => false);
    if (ok) log.info(`crafted torches (${countItem(bot, 'torch')})`);
  }
}

module.exports = { LightTask };
