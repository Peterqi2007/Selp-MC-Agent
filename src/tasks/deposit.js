'use strict';

/**
 * DepositTask: the task-layer adapter around the `deposit` skill.
 *
 * `!deposit`, `!store`, the planner's `deposit` rule and `!goal ... 存东西` all go through
 * this one path (2026-10-21 unification). The old implementation drove mineflayer's container
 * API directly and was dead on the client-mod body. The skill behind this adapter uses the
 * menu primitives both bodies share (`useOn/menu/clickSlot`), walks with A*, and
 * crafts+places a chest when the scan finds none.
 *
 * Explicit callers pass `{ item, count }`. The autonomous entries (planner rule, goal router)
 * have nobody to ask, so this adapter picks the biggest non-tool stack in the bag and
 * deposits all of it - the skill itself still requires a concrete item+count.
 */

const { Task } = require('./task');
const { ctxWithSignal } = require('../core/taskHub');
const { bare, isFood } = require('../world/items');

/** Tools and armour are never the "loot" an autonomous deposit should stash. */
const TOOL_OR_ARMOR = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/;
/** Survival essentials the old keep-list protected; the explicit command can still store them. */
const KEEP_FOR_AUTONOMY = /^(crafting_table|furnace|torch|coal|charcoal|stick|bucket|water_bucket|shield)$/;

class DepositTask extends Task {
  /**
   * @param {object} ctx
   * @param {object} options
   *   - item:  item to store (optional for the planner/goal path)
   *   - count: how many (optional for the planner/goal path)
   *   - plus timeoutMs/priority/description
   */
  constructor(ctx, options = {}) {
    super(ctx, {
      name: 'deposit',
      description:
        options.description ||
        (options.item ? `deposit ${options.count || '?'} ${options.item}` : 'deposit the biggest loot stack'),
      timeoutMs: options.timeoutMs || 300000,
      priority: options.priority
    });
    this.item = options.item ? bare(options.item) : null;
    const count = Number(options.count);
    this.count = Number.isFinite(count) && count > 0 ? Math.floor(count) : null;
    /** Items the skill verified as moved; the planner's comparable progress value. */
    this.deposited = 0;
    /** Cancellation token handed to the skill through the scoped context. */
    this._signal = null;
  }

  progress() {
    return this.deposited;
  }

  /**
   * The autonomous path has no operator to ask what to store. Pick the biggest non-tool
   * item in the bag (the inventory snapshot aggregates by item name) and deposit all of it;
   * when the inventory is nearly full, repeated runs drain it one item type at a time.
   */
  async deriveTarget() {
    const body = this.body;
    if (!body) return null;
    if (typeof body.refreshStrict === 'function') {
      const outcome = await body.refreshStrict(true).catch(() => null);
      if (!outcome || outcome.ok !== true) return null;
    } else if (typeof body.refresh === 'function') {
      await body.refresh(true).catch(() => null);
    }
    const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
    const stacks = Object.entries((snap && snap.inventory) || {})
      .filter(([name, count]) => {
        const item = bare(name);
        return (
          Number(count) > 0 &&
          !TOOL_OR_ARMOR.test(item) &&
          !KEEP_FOR_AUTONOMY.test(item) &&
          !isFood(item)
        );
      })
      .map(([name, count]) => ({ item: bare(name), count: Number(count) }))
      .sort((a, b) => b.count - a.count);
    return stacks[0] || null;
  }

  async run() {
    let item = this.item;
    let count = this.count;
    if (!item || !count) {
      const target = await this.deriveTarget();
      if (!target) return this.fail('nothing to deposit: no non-tool item in the inventory');
      item = target.item;
      count = target.count;
    }

    const skills = require('../skills');
    this._signal = { cancelled: false, reason: null };
    const result = await skills.run('deposit', ctxWithSignal(this.ctx, this._signal), { item, count });
    this.deposited = Number.isFinite(result.deposited) ? result.deposited : 0;
    return {
      ...result,
      ok: result.ok !== false,
      reason:
        result.reason ||
        result.detail ||
        (result.ok === false ? 'deposit failed' : `deposited ${this.deposited} ${item}`)
    };
  }

  cancel() {
    if (this._signal) {
      this._signal.cancelled = true;
      this._signal.reason = 'task cancelled';
    }
    super.cancel();
  }
}

module.exports = { DepositTask };
