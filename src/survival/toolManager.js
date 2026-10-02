'use strict';

/**
 * Tool & armour maintenance: keep the best tool in hand for the job and armour on
 * the body. Both are small behaviours, but getting them wrong is the classic reason
 * bots break their hands on stone or die to a single zombie.
 */

const { bestTool, TOOL_TIERS } = require('../world/items');
const { Logger } = require('../util/logger');

const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet'];

class ToolManager {
  constructor(controller) {
    this.controller = controller;
    this.cfg = controller.cfg.agent.behaviour;
    this.log = new Logger('gear');
  }

  get bot() {
    return this.controller.bot;
  }

  /** Equip the tool that matches the block we are about to break. */
  async equipForBlock(block) {
    const bot = this.bot;
    if (!bot || !block) return false;
    if (this.cfg.autoTool && bot.tool && bot.tool.equipForBlock) {
      try {
        await bot.tool.equipForBlock(block);
        return true;
      } catch {
        /* fall through to manual selection */
      }
    }
    return this.equipBestFor(block.name);
  }

  /** Manual fallback: choose by block category. */
  async equipBestFor(blockName) {
    const kind = /_log$|_stem$|_planks$|_wood$/.test(blockName)
      ? 'axe'
      : /dirt|sand|gravel|clay|soul_soil|_concrete_powder/.test(blockName)
        ? 'shovel'
        : 'pickaxe';
    const tool = bestTool(this.bot, kind) || bestTool(this.bot, 'pickaxe') || bestTool(this.bot, 'axe');
    if (!tool) return false;
    return this.equipByName(tool.name);
  }

  async equipByName(name) {
    const bot = this.bot;
    if (!bot) return false;
    const item = bot.inventory.items().find((i) => i.name === name);
    if (!item) return false;
    try {
      await bot.equip(item, 'hand');
      return true;
    } catch (err) {
      this.log.debug(`equip ${name} failed: ${err.message}`);
      return false;
    }
  }

  /** Put on any armour pieces that are still in the inventory. */
  async equipArmor() {
    const bot = this.bot;
    if (!bot || !this.cfg.autoArmor) return false;
    if (bot.armorManager && typeof bot.armorManager.equipAll === 'function') {
      try {
        await bot.armorManager.equipAll();
        return true;
      } catch {
        /* fall through */
      }
    }
    return this.manualEquipArmor();
  }

  async manualEquipArmor() {
    const bot = this.bot;
    if (!bot) return false;
    const bySlot = { head: [], torso: [], legs: [], feet: [] };
    for (const item of bot.inventory.items()) {
      if (/_helmet$/.test(item.name)) bySlot.head.push(item);
      else if (/_chestplate$/.test(item.name)) bySlot.torso.push(item);
      else if (/_leggings$/.test(item.name)) bySlot.legs.push(item);
      else if (/_boots$/.test(item.name)) bySlot.feet.push(item);
    }
    let equipped = 0;
    for (const slot of ARMOR_SLOTS) {
      const candidates = bySlot[slot];
      if (!candidates.length) continue;
      candidates.sort((a, b) => armorRank(b.name) - armorRank(a.name));
      try {
        await bot.equip(candidates[0], slot);
        equipped += 1;
      } catch {
        /* ignore single-slot failure */
      }
    }
    return equipped > 0;
  }

  /** Drop junk when the inventory is nearly full (keeps the agent mobile). */
  async dropJunk(keepNames = []) {
    const bot = this.bot;
    if (!bot) return false;
    const keep = new Set(keepNames);
    const junk = bot.inventory.items().filter((i) => {
      if (keep.has(i.name)) return false;
      if (/_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|_helmet$|_chestplate$|_leggings$|_boots$/.test(i.name)) return false;
      if (/torch|crafting_table|furnace|food|bread|_planks$|_log$/.test(i.name)) return false;
      return ['gravel', 'flint', 'andesite', 'diorite', 'granite', 'tuff', 'dirt'].includes(i.name);
    });
    let dropped = 0;
    for (const item of junk.slice(0, 8)) {
      try {
        await bot.tossStack(item);
        dropped += 1;
      } catch {
        /* ignore */
      }
    }
    if (dropped) this.log.info(`dropped ${dropped} junk stacks`);
    return dropped > 0;
  }

  needsBetterPickaxe() {
    const pick = bestTool(this.bot, 'pickaxe');
    return !pick || TOOL_TIERS.indexOf(pick.tier) < TOOL_TIERS.indexOf('stone');
  }
}

function armorRank(name) {
  for (const tier of TOOL_TIERS) if (name.startsWith(`${tier}_`)) return TOOL_TIERS.indexOf(tier);
  if (name.startsWith('leather_')) return -1;
  if (name.startsWith('chainmail_')) return 0;
  return -2;
}

module.exports = { ToolManager };
