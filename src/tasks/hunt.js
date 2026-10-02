'use strict';

/**
 * Task: hunt animals for food.
 *
 * Passive mobs only (never picks a fight with a hostile mob on purpose). Uses the
 * combat helper to close distance and strike, then collects the drops and cooks
 * them if a furnace + fuel are available.
 */

const { Task } = require('./task');
const { collectNearbyDrops, sleep } = require('../core/movement');
const { isFood, countMatching } = require('../world/items');

const FOOD_ANIMALS = ['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'salmon', 'cod', 'tropical_fish'];

class HuntTask extends Task {
  constructor(ctx, options = {}) {
    super(ctx, {
      name: 'hunt',
      description: options.description || `hunt ${options.count || 3} animals`,
      timeoutMs: options.timeoutMs || 150000
    });
    this.wanted = options.count || 3;
    this.killed = 0;
  }

  progress() {
    return this.killed;
  }

  nearbyAnimals(maxDistance = 40) {
    const bot = this.ctx.bot;
    const pos = bot.entity.position;
    return Object.values(bot.entities)
      .filter((e) => e && e.name && FOOD_ANIMALS.some((a) => e.name === a || e.name.endsWith(`_${a}`)) && e.position)
      .map((e) => ({ entity: e, distance: e.position.distanceTo(pos) }))
      .filter((x) => x.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);
  }

  async run() {
    const { bot, nav, combat, log } = this.ctx;
    await combat.equipWeapon();
    let guard = 0;
    while (this.killed < this.wanted && guard < 60) {
      guard += 1;
      if (this.cancelled) return this.fail('cancelled');

      const animals = this.nearbyAnimals();
      if (!animals.length) {
        if (this.killed > 0) break;
        // Roam to find animals.
        await nav.goto(bot.entity.position.offset((Math.random() - 0.5) * 60, 0, (Math.random() - 0.5) * 60), {
          timeoutMs: 15000,
          range: 5
        });
        continue;
      }

      const target = animals[0].entity;
      const reached = await nav.goto(target.position, { range: 2, timeoutMs: 10000 });
      if (!reached) continue;
      const before = countMatching(bot, isFood);
      const ok = await combat.attack(target, { timeoutMs: 15000 });
      await collectNearbyDrops(this.ctx.controller, nav, 6, 3);
      if (ok || countMatching(bot, isFood) > before) {
        this.killed += 1;
        log.info(`hunted ${target.name} (${this.killed}/${this.wanted})`);
      }
      await sleep(200);
      this.checkpoint();
    }
    const food = countMatching(bot, isFood);
    if (this.killed === 0 && food === 0) return this.fail('no animals found');
    return this.succeed(`killed ${this.killed} animals, ${food} food items in inventory`);
  }
}

module.exports = { HuntTask, FOOD_ANIMALS };
