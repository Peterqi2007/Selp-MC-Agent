'use strict';

/**
 * Task: craft something.
 *
 * Crafting is an OPTIONAL body capability: the body owns recipe knowledge and the
 * actual crafting act, because that knowledge differs per body:
 *
 *   mineflayer - prismarine-recipe (vanilla recipes only, with wood-variant quirks)
 *   mock       - a small built-in table
 *   clientmod  - the real client knows every recipe, including modded ones
 *
 * What stays here is the part that is genuinely the *decision* layer's job:
 * satisfying prerequisites. The single most common crafting failure is asking for a
 * crafting table (or a tool) while the planks and sticks are still logs, so this task
 * converts materials first and then retries.
 *
 * Menu-capable bodies (the real client) do NOT have a recipe database in the body; they
 * craft through the registered `craft` skill (recipe planner + real grid clicks), which is
 * the same path `!craft` already used. Before this delegation, a plan step `type:"craft"`
 * went through `body.supportsCrafting=false` and failed instantly, while `!craft` worked
 * (live A13-4, 2026-10-18).
 */

const { Task } = require('./task');
const { isLog } = require('../world/items');

/** Items that need planks as a direct ingredient. */
const NEEDS_PLANKS = ['crafting_table', 'chest', 'stick', 'fence', 'fence_gate', 'door', 'trapdoor', 'boat', 'bowl', 'barrel', 'bookshelf'];
/** Items that need sticks as a direct ingredient. */
const NEEDS_STICKS = /_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|torch$|bow$|arrow$|fishing_rod$|ladder$|_sign$/;

class CraftTask extends Task {
  constructor(ctx, options = {}) {
    super(ctx, {
      name: options.name || 'craft',
      description: options.description || `craft ${options.count || 1}x ${options.item}`,
      timeoutMs: options.timeoutMs || 60000
    });
    this.item = options.item;
    this.count = options.count || 1;
    this.crafted = 0;
    /** Recursion guard for prerequisite crafting. */
    this.depth = options.depth || 0;
  }

  progress() {
    return this.countItem(this.item);
  }

  async run() {
    if (!this.item) return this.fail('no item specified');
    const body = this.body;
    if (!body) return this.fail('no body attached');

    /**
     * Menu-capable bodies are the real client: they know every recipe but expose it through
     * the open menu, not a `body.craft()` recipe database. Route to the registered skill
     * (the same one `!craft` uses) instead of failing on `supportsCrafting === false`.
     */
    if (typeof body.menu === 'function' && typeof body.clickSlot === 'function') {
      return this.runMenuCraft();
    }

    if (body.supportsCrafting === false) {
      return this.fail(`${body.kind} body cannot craft (no recipe support)`);
    }

    const before = this.progress();
    let outcome = await this.tryCraft();
    if (outcome.ok) return this.report(before, outcome);

    // Prerequisites: turn logs into planks / planks into sticks, then retry.
    if (this.depth < 3) {
      const prepared = await this.prepareIngredients();
      if (prepared) {
        this.log.info(`retrying ${this.item} after preparing prerequisites`);
        outcome = await this.tryCraft();
        if (outcome.ok) return this.report(before, outcome);
      }
    }

    const produced = this.progress() - before;
    this.crafted = produced;
    this.checkpoint();
    if (produced > 0) return this.succeed(`crafted ${produced}x ${this.item}`);
    return this.fail(`could not craft ${this.item}: ${outcome.reason || 'unknown reason'} (held: ${this.inventoryDigest()})`);
  }

  /**
   * Craft through the registered `craft` skill: recipe planning + real menu clicks.
   *
   * The skill returns what actually appeared in the menu; we cross-check the inventory delta
   * too, because a stale snapshot must not turn "clicks ran but nothing appeared" into success.
   */
  async runMenuCraft() {
    const skills = require('../skills');
    const before = this.progress();
    const result = await skills
      .run('craft', this.ctx, { item: this.item, count: this.count })
      .catch((err) => ({ ok: false, reason: err.message }));
    const produced = Math.max(Number(result && result.produced) || 0, this.progress() - before);
    this.crafted = produced;
    this.checkpoint();
    if (result && result.ok === true && produced > 0) {
      return this.succeed(`crafted ${produced}x ${this.item}`);
    }
    const detail = (result && (result.reason || result.detail)) || 'unknown reason';
    return this.fail(`could not craft ${this.item}: ${detail} (held: ${this.inventoryDigest()})`);
  }

  /** One craft attempt, normalised to {ok, reason}. */
  async tryCraft() {
    try {
      const res = await this.body.craft(this.item, this.count);
      return res && typeof res === 'object' ? res : { ok: !!res };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  report(before, outcome) {
    const produced = Math.max(this.progress() - before, outcome.produced || 0);
    this.crafted = produced;
    this.checkpoint();
    return this.succeed(`crafted ${produced}x ${this.item}`);
  }

  /**
   * Produce whatever this item's recipe is most likely missing.
   *
   * Deliberately blunt: we do not try to be clever about which wood type or how many
   * units, because the body is the one that knows the real recipe. We just make sure
   * the two universal intermediates exist, then let the body try again.
   */
  async prepareIngredients() {
    const target = String(this.item);
    const wantsPlanks = NEEDS_PLANKS.includes(target) || /_planks$/.test(target) || NEEDS_STICKS.test(target);
    const wantsSticks = NEEDS_STICKS.test(target) || target === 'stick';
    let did = false;

    if (wantsPlanks && !this.hasAnyPlanks()) {
      did = (await this.craftIntermediates('planks')) || did;
    }
    if (wantsSticks && this.countItem('stick') < 2) {
      // Sticks come from planks, so planks first if we are short.
      if (!this.hasAnyPlanks()) did = (await this.craftIntermediates('planks')) || did;
      if (this.hasAnyPlanks()) {
        const res = await this.subCraft('stick', 4);
        did = did || res;
      }
    }
    return did;
  }

  hasAnyPlanks() {
    return this.inventory.items().some((i) => /_planks$/.test(i.name));
  }

  /**
   * Turn one log into planks. Which plank type depends on what wood we carry, and the
   * recipe needs the *same* type, so craft every species we hold.
   */
  async craftIntermediates(kind) {
    if (kind !== 'planks') return false;
    const logs = this.inventory.items().filter((i) => isLog(i.name));
    if (!logs.length) return false;

    let did = false;
    for (const logItem of logs) {
      const planks = plankNameFor(logItem.name);
      const res = await this.subCraft(planks, 4);
      did = did || res;
    }
    return did;
  }

  /** Run a nested CraftTask (guarded by depth). */
  async subCraft(item, count) {
    if (this.depth >= 3) return false;
    const sub = new CraftTask(this.ctx, { item, count, depth: this.depth + 1 });
    const res = await sub.execute();
    if (!res.ok) this.log.debug(`prerequisite ${item} failed: ${res.reason}`);
    return res.ok;
  }

  inventoryDigest() {
    const items = this.inventory.items();
    return items.length ? items.map((i) => `${i.name}x${i.count}`).join(',') : '(empty)';
  }
}

/** "spruce_log" -> "spruce_planks" */
function plankNameFor(logName) {
  const base = String(logName).replace(/_log$/, '').replace(/_stem$/, '').replace(/^stripped_/, '');
  return `${base}_planks`;
}

module.exports = { CraftTask, plankNameFor };
