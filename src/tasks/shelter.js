'use strict';

/**
 * Task: build a night shelter.
 *
 * A 3x3x3 box with a door hole and a torch is enough to survive the first night.
 * The builder is intentionally defensive: it validates there is room, skips
 * placement when a block already exists, and gives up cleanly instead of leaving
 * the bot sealed inside a wall.
 */

const { Task } = require('./task');
const { placeBlockAgainst, sleep, digBlock } = require('../core/movement');
const { countItem, countMatching } = require('../world/items');

const BUILD_MATERIALS = ['cobblestone', 'stone', 'dirt', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'cobbled_deepslate', 'sandstone', 'deepslate', 'blackstone', 'terracotta', 'netherrack'];

class ShelterTask extends Task {
  constructor(ctx, options = {}) {
    super(ctx, {
      name: 'shelter',
      description: 'build a 3x3 night shelter',
      timeoutMs: options.timeoutMs || 120000
    });
    this.placed = 0;
  }

  progress() {
    return this.placed;
  }

  material() {
    const bot = this.ctx.bot;
    const items = bot.inventory.items();
    let best = null;
    for (const name of BUILD_MATERIALS) {
      const item = items.find((i) => i.name === name);
      if (item && (!best || item.count > best.count)) best = { name, count: item.count };
    }
    return best;
  }

  async run() {
    const { bot, log, tools } = this.ctx;
    const material = this.material();
    if (!material || material.count < 12) return this.fail('not enough building blocks (need ~12)');

    // Flatten the 3x3 area we will build in.
    const base = bot.entity.position.floored();
    log.info(`building shelter at ${base} using ${material.name} x${material.count}`);
    await tools.equipByName(material.name);

    // Ensure the ground under the footprint is solid enough.
    for (const [dx, dz] of footprint()) {
      const ground = bot.blockAt(base.offset(dx, -1, dz));
      const space = bot.blockAt(base.offset(dx, 0, dz));
      if (space && space.name !== 'air' && space.name !== 'grass' && space.name !== 'tall_grass') {
        await digBlock(this.ctx.controller, space, { log, timeoutMs: 6000 });
      }
      if (ground && ground.name === 'air') {
        await this.placeAt(bot.blockAt(base.offset(dx, -2, dz)), material.name);
      }
    }

    // Walls (two layers) around the 3x3 footprint, with a door gap on the south side.
    const doorSide = { x: 0, z: 1 };
    for (const layer of [0, 1]) {
      for (const [dx, dz] of ring()) {
        if (layer === 0 && dx === doorSide.x && dz === doorSide.z) continue; // leave the door
        const reference = bot.blockAt(base.offset(dx, layer - 1, dz));
        const existing = bot.blockAt(base.offset(dx, layer, dz));
        if (existing && existing.name !== 'air') continue;
        await this.placeAt(reference, material.name);
        await sleep(60);
      }
    }

    // Roof.
    for (const [dx, dz] of footprint()) {
      const reference = bot.blockAt(base.offset(dx, 1, dz));
      const existing = bot.blockAt(base.offset(dx, 2, dz));
      if (existing && existing.name !== 'air') continue;
      await this.placeAt(reference, material.name);
      await sleep(60);
    }

    // Torch inside so mobs cannot spawn in the shelter.
    if (countItem(bot, 'torch') > 0) {
      const torch = bot.inventory.items().find((i) => i.name === 'torch');
      const wallBlock = bot.blockAt(base.offset(0, 1, -1));
      try {
        await bot.equip(torch, 'hand');
        await bot.placeBlock(wallBlock, { x: 0, y: -1, z: 0 });
      } catch {
        /* not fatal */
      }
    }

    this.placed = this.countPlaced(material.name, base);
    this.checkpoint();
    if (this.placed < 8) return this.fail(`shelter incomplete (${this.placed} blocks placed)`);
    return this.succeed(`shelter built (${this.placed} blocks)`);
  }

  async placeAt(referenceBlock, itemName) {
    if (!referenceBlock) return false;
    const ok = await placeBlockAgainst(this.ctx.controller, itemName, referenceBlock, { x: 0, y: 1, z: 0 });
    if (ok) this.placed += 1;
    return ok;
  }

  countPlaced(itemName, base) {
    let count = 0;
    const bot = this.ctx.bot;
    for (const [dx, dz] of [...footprint(), ...ring()]) {
      for (const dy of [0, 1, 2]) {
        const b = bot.blockAt(base.offset(dx, dy, dz));
        if (b && BUILD_MATERIALS.includes(b.name)) count += 1;
      }
    }
    return count;
  }
}

function footprint() {
  return [
    [0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1]
  ];
}

function ring() {
  return footprint().filter(([dx, dz]) => dx !== 0 || dz !== 0);
}

module.exports = { ShelterTask, BUILD_MATERIALS };
