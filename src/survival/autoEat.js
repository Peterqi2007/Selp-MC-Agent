'use strict';

/**
 * Auto-eat: keeps the bot fed so it can sprint, regenerate and survive.
 *
 * Rules (all tunable from config/agent.json):
 *  - eat when food <= eatFoodThreshold
 *  - prefer cooked/high-value food, avoid eating raw meat unless starving
 *  - never block the caller for more than a few seconds
 */

const { isFood, foodScore, RAW_FOODS } = require('../world/items');
const { Logger } = require('../util/logger');

class AutoEat {
  constructor(controller) {
    this.controller = controller;
    this.cfg = controller.cfg.agent.behaviour;
    this.log = new Logger('eat');
    this.eating = false;
    this.lastEatAt = 0;
  }

  get bot() {
    return this.controller.bot;
  }

  /** Pick the best food item in the inventory. */
  chooseFood() {
    const bot = this.bot;
    if (!bot || !bot.inventory) return null;
    const candidates = bot.inventory
      .items()
      .filter((item) => isFood(item.name, bot.registry))
      .map((item) => ({ item, score: foodScore(item.name), raw: RAW_FOODS.has(item.name) }));
    if (!candidates.length) return null;

    const starving = bot.food <= 6;
    const pool = starving ? candidates : candidates.filter((c) => !c.raw);
    const usable = pool.length ? pool : candidates;
    usable.sort((a, b) => b.score - a.score || b.item.count - a.item.count);
    return usable[0].item;
  }

  needsFood() {
    const bot = this.bot;
    if (!bot || bot.food === undefined) return false;
    return bot.food <= this.cfg.eatFoodThreshold;
  }

  /**
   * Eat if needed (or forced).
   * @returns {Promise<boolean>} whether something was eaten
   */
  async tick(force = false) {
    const bot = this.bot;
    if (!bot || !bot.entity || this.eating) return false;
    if (!this.cfg.autoEat && !force) return false;
    if (!force && !this.needsFood()) return false;
    if (bot.food >= 20 && !force) return false;

    const food = this.chooseFood();
    if (!food) {
      // Rate-limited: the fast loop runs every 600ms and would otherwise flood the log.
      const now = Date.now();
      if (this.needsFood() && now - (this.lastNoFoodWarn || 0) > 20000) {
        this.lastNoFoodWarn = now;
        this.log.warn(`hungry (${bot.food}) but no food in inventory`);
      }
      return false;
    }

    this.eating = true;
    try {
      await bot.equip(food, 'hand');
      await bot.consume();
      this.lastEatAt = Date.now();
      this.log.info(`ate ${food.name} (food now ${bot.food})`);
      return true;
    } catch (err) {
      this.log.debug(`eat failed: ${err.message}`);
      return false;
    } finally {
      this.eating = false;
    }
  }
}

module.exports = { AutoEat };
