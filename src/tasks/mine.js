'use strict';

/**
 * Task: mine blocks (stone, ores, sand, ...).
 *
 * Body-agnostic: everything goes through the Body contract, so this runs against a
 * real bot, a scripted mock world, or a Forge client.
 *
 * Design notes kept from the mineflayer-only version:
 *  - refuses blocks the current tool tier cannot break, so the agent does not stand in
 *    front of diamond ore punching forever
 *  - digs a short probe shaft when nothing is visible (the standard "branch mining"
 *    entry move)
 */

const { Task } = require('./task');
const { sleep } = require('../core/movement');
const { bestTool, TOOL_TIERS, needsPickaxe } = require('../world/items');

class MineTask extends Task {
  constructor(ctx, options = {}) {
    super(ctx, {
      name: options.name || 'mine',
      description: options.description || `mine ${options.count || 8}x ${options.block}`,
      timeoutMs: options.timeoutMs || 180000
    });
    this.blockNames = Array.isArray(options.block) ? options.block : [options.block];
    /** Requested quantity. NOTE: `this.count` is a number, which is why the item
     *  counting helper on Task is called `countItem`. */
    this.wanted = options.count || 8;
    this.mined = 0;
    this.radius = options.radius || 32;
  }

  progress() {
    return this.mined;
  }

  async run() {
    const { world, log } = this.ctx;
    const body = this.body;
    if (!body) return this.fail('no body attached');

    const names = this.blockNames.map(bare);
    const sample = names[0];
    const inventory = this.inventory;

    if (needsPickaxe(sample) && !bestTool({ inventory }, 'pickaxe')) {
      return this.fail(`need a pickaxe to mine ${names.join('/')}`);
    }
    await body.equipBest('pickaxe').catch(() => false);
    if (!this.checkTier()) return this.fail(`pickaxe tier too low for ${names.join('/')}`);

    let guard = 0;
    while (this.mined < this.wanted && guard < this.wanted * 6 + 20) {
      guard += 1;
      if (this.cancelled) return this.fail('cancelled');
      if (!body.isReady) return this.fail('body is gone');

      const targets = world.findNearbyBlockNames(names, this.radius, 12);
      if (!targets.length) {
        log.info('no target blocks visible, digging a probe shaft');
        const advanced = await this.probeShaft(names);
        if (!advanced) {
          if (this.mined > 0) return this.succeed(`mined ${this.mined} (area exhausted)`);
          return this.fail(`no ${names.join('/')} found within ${this.radius} blocks`);
        }
        continue;
      }

      let broke = 0;
      for (const target of targets) {
        if (this.mined >= this.wanted || this.cancelled) break;
        if (!world.canMine(target)) continue;

        const reached = await body.moveTo(target.position, { range: 1, timeoutMs: 15000 }).catch(() => false);
        if (!reached) continue;

        const ok = await body.dig(target, { timeoutMs: 15000 }).catch(() => false);
        if (ok) {
          this.mined += 1;
          broke += 1;
        }
      }

      await this.collectDrops();
      this.checkpoint();

      if (broke === 0) {
        await sleep(300);
        // Move a few blocks so we do not re-scan the same spot forever.
        const here = this.position || { x: 0, y: 64, z: 0 };
        await body
          .moveTo({ x: here.x + (Math.random() - 0.5) * 16, y: here.y, z: here.z + (Math.random() - 0.5) * 16 }, { timeoutMs: 10000, range: 3 })
          .catch(() => false);
      }
    }

    return this.mined >= this.wanted ? this.succeed(`mined ${this.mined} blocks`) : this.fail(`mined ${this.mined}/${this.wanted}`);
  }

  checkTier() {
    const hard = this.blockNames.map(bare).filter((n) => ['obsidian', 'ancient_debris'].includes(n));
    if (!hard.length) return true;
    const pick = bestTool({ inventory: this.inventory }, 'pickaxe');
    return !!pick && pick.rank >= TOOL_TIERS.indexOf('diamond');
  }

  /** Walk over nearby drops so the body can pick them up. */
  async collectDrops(attempts = 3) {
    const body = this.body;
    const world = this.ctx.world;
    for (let i = 0; i < attempts; i += 1) {
      const drops = world.nearbyItemEntities ? world.nearbyItemEntities(5) : [];
      if (!drops.length) return;
      const drop = drops[0];
      const position = drop.position || (drop.entity && drop.entity.position);
      if (!position) return;
      await body.moveTo(position, { range: 1, timeoutMs: 7000 }).catch(() => false);
      await sleep(150);
    }
  }

  /** Dig a short vertical shaft to expose new blocks. */
  async probeShaft(names) {
    const body = this.body;
    const world = this.ctx.world;
    let advanced = false;

    for (let step = 0; step < 4; step += 1) {
      const here = this.position;
      if (!here) break;
      const feet = world.blockAtAbsolute ? world.blockAtAbsolute({ x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) }) : null;
      const head = world.blockAtAbsolute ? world.blockAtAbsolute({ x: Math.floor(here.x), y: Math.floor(here.y) + 1, z: Math.floor(here.z) }) : null;

      for (const block of [head, feet]) {
        if (!block) continue;
        if (['air', 'cave_air', 'bedrock', 'water', 'lava'].includes(bare(block.name))) continue;
        const ok = await body.dig(block, { timeoutMs: 8000 }).catch(() => false);
        if (ok) advanced = true;
      }
      await sleep(200);

      const found = world.findNearbyBlockNames(names, this.radius, 4);
      if (found.length) break;
    }
    return advanced;
  }
}

/** Strip a namespace: "minecraft:stone" -> "stone". */
function bare(name) {
  if (!name) return '';
  const idx = String(name).indexOf(':');
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

module.exports = { MineTask };
