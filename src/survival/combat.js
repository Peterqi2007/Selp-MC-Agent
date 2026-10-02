'use strict';

/**
 * Combat: decide whether to fight or flee, then do it.
 *
 * The strategy intentionally mirrors what simple open-source mineflayer fighters do
 * (equip best sword, close distance, hold attack, jump-crit) while adding the two
 * things survival agents usually get wrong:
 *   1. a retreat rule when health is low or the target is out of our league
 *   2. giving up after a timeout so the agent cannot get stuck in an endless duel
 */

const { bestTool, TOOL_TIERS } = require('../world/items');
const { Logger } = require('../util/logger');
const { sleep } = require('../core/movement');

/** Mobs worth fleeing from unless properly geared. */
const DANGEROUS = new Set(['creeper', 'witch', 'ravager', 'warden', 'ender_dragon', 'wither', 'hoglin', 'zoglin', 'piglin_brute', 'elder_guardian', 'guardian', 'blaze', 'ghast', 'vindicator', 'evoker', 'pillager', 'shulker', 'magma_cube', 'phantom']);
const NEVER_FIGHT = new Set(['creeper', 'warden', 'wither', 'ender_dragon', 'elder_guardian']);

class Combat {
  constructor(controller, navigator) {
    this.controller = controller;
    this.cfg = controller.cfg.agent.behaviour;
    this.navigator = navigator;
    this.log = new Logger('fight');
    this.engaged = null;
    this.fleeing = false;
  }

  get bot() {
    return this.controller.bot;
  }

  /** Combat strength heuristic: 0 (defenceless) .. 1 (fully kitted). */
  strength() {
    const bot = this.bot;
    if (!bot || !bot.inventory) return 0;
    const sword = bestTool(bot, 'sword');
    const axe = bestTool(bot, 'axe');
    const weapon = sword || axe;
    const weaponRank = weapon ? TOOL_TIERS.indexOf(weapon.tier) + 1 : 0; // 0..6
    let armorPieces = 0;
    for (const slot of ['head', 'torso', 'legs', 'feet']) {
      const item = bot.inventory.slots[({ head: 5, torso: 6, legs: 7, feet: 8 })[slot]];
      if (item) armorPieces += 1;
    }
    const score = (weaponRank / 6) * 0.7 + (armorPieces / 4) * 0.3;
    return Math.max(0, Math.min(1, score));
  }

  shouldFlee(target) {
    const bot = this.bot;
    if (!bot || bot.health === undefined) return false;
    const name = target && target.entity ? target.entity.name : null;
    if (name && NEVER_FIGHT.has(name)) return true;
    if (bot.health <= this.cfg.fleeHealthThreshold) return true;
    if (name && DANGEROUS.has(name) && this.strength() < 0.5) return true;
    const multiple = this.controller.world ? this.controller.world.hostiles(10).length : 1;
    if (multiple >= 3 && this.strength() < 0.4) return true;
    return false;
  }

  /** Equip the best weapon in the inventory. */
  async equipWeapon() {
    const bot = this.bot;
    const sword = bestTool(bot, 'sword');
    const axe = bestTool(bot, 'axe');
    const pick = bestTool(bot, 'pickaxe');
    const choice = sword || axe || pick;
    if (!choice) return false;
    const item = bot.inventory.items().find((i) => i.name === choice.name);
    if (!item) return false;
    try {
      await bot.equip(item, 'hand');
      return true;
    } catch {
      return false;
    }
  }

  /** Attack the closest hostile until it dies, we flee, or we time out. */
  async attack(entity, options = {}) {
    const bot = this.bot;
    if (!bot || !entity) return false;
    const timeoutMs = options.timeoutMs || 20000;
    const deadline = Date.now() + timeoutMs;

    await this.equipWeapon();
    this.engaged = entity;

    try {
      while (Date.now() < deadline) {
        if (!entity.isValid) return true;
        if (!bot.entity || !bot.entity.position) return false;

        if (this.shouldFlee({ entity })) {
          this.log.warn(`fleeing from ${entity.name} (health ${bot.health})`);
          await this.flee(entity);
          return false;
        }

        const distance = entity.position.distanceTo(bot.entity.position);
        if (distance > 4) {
          const ok = await this.navigator.goto(entity.position, { range: 2, timeoutMs: 6000 });
          if (!ok) {
            // Path unreachable: try to break line of sight by simply retreating.
            if (Date.now() > deadline - timeoutMs / 2) return false;
          }
          continue;
        }

        await bot.lookAt(entity.position.offset(0, entity.height ? entity.height * 0.8 : 1.2, 0), true).catch(() => {});
        bot.attack(entity);
        // Small hop for crits, then wait out the attack cooldown.
        if (bot.entity.onGround && Math.random() < 0.35) bot.setControlState('jump', true);
        await sleep(120);
        bot.setControlState('jump', false);
        await sleep(280);
      }
      return !entity.isValid;
    } catch (err) {
      this.log.debug(`attack error: ${err.message}`);
      return false;
    } finally {
      bot.setControlState('jump', false);
      this.engaged = null;
    }
  }

  /** Run away from a threat for a few seconds. */
  async flee(threat) {
    const bot = this.bot;
    if (!bot || !bot.entity) return false;
    this.fleeing = true;
    try {
      // Pick a point roughly 12 blocks away, biased towards the bot's current facing.
      let best = null;
      let bestScore = -Infinity;
      for (let i = 0; i < 12; i += 1) {
        const angle = (Math.PI * 2 * i) / 12;
        const candidate = bot.entity.position.offset(Math.cos(angle) * 12, 0, Math.sin(angle) * 12);
        const awayFromThreat = threat && threat.position ? candidate.distanceTo(threat.position) : 12;
        const score = awayFromThreat;
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      if (!best) return false;
      this.navigator.interrupt('fleeing');
      return await this.navigator.goto(best, { timeoutMs: 7000, range: 2 });
    } finally {
      this.fleeing = false;
    }
  }

  /** Cheap retreat used when nothing specific is chasing us (low health, lava, etc). */
  async retreat(distance = 10) {
    const bot = this.bot;
    if (!bot || !bot.entity) return false;
    const pos = bot.entity.position;
    const target = pos.offset((Math.random() - 0.5) * distance, 0, (Math.random() - 0.5) * distance);
    return this.navigator.goto(target, { timeoutMs: 6000, range: 3 });
  }

  /** Defensive item use: eat, then fight whatever is closest. */
  async defend() {
    const hostiles = this.controller.world ? this.controller.world.hostiles(12) : [];
    if (!hostiles.length) return false;
    if (this.shouldFlee(hostiles[0])) {
      return this.flee(hostiles[0].entity);
    }
    return this.attack(hostiles[0].entity, { timeoutMs: 25000 });
  }
}

module.exports = { Combat, DANGEROUS, NEVER_FIGHT };
