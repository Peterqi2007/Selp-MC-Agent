'use strict';

/**
 * WithdrawTask: the task-layer adapter around the `withdraw` skill.
 *
 * `!withdraw`, the planner/DSH action brain (`mc_plan`/`mc_propose` step type `withdraw`)
 * and `do_task` all go through this one task. The skill owns the 15x15x9 pure-container
 * scan, the A* walk, reading each chest for the item and the exact-count transfer.
 *
 * `item` is required here (withdrawing "something" is too ambiguous); `count` defaults to 1.
 */

const { Task } = require('./task');
const { ctxWithSignal } = require('../core/taskHub');
const { bare } = require('../world/items');

class WithdrawTask extends Task {
  constructor(ctx, options = {}) {
    super(ctx, {
      name: 'withdraw',
      description:
        options.description ||
        (options.item ? `withdraw ${options.count || 1} ${options.item}` : 'withdraw an item from a container'),
      timeoutMs: options.timeoutMs || 300000,
      priority: options.priority
    });
    this.item = options.item ? bare(options.item) : null;
    const count = Number(options.count);
    this.count = Number.isFinite(count) && count > 0 ? Math.min(2304, Math.floor(count)) : 1;
    /** Items the skill verified as moved; the planner's comparable progress value. */
    this.withdrawn = 0;
    /** Cancellation token handed to the skill through the scoped context. */
    this._signal = null;
  }

  progress() {
    return this.withdrawn;
  }

  async run() {
    if (!this.item) return this.fail('withdraw needs an item (for example: withdraw dirt 8)');
    const skills = require('../skills');
    this._signal = { cancelled: false, reason: null };
    const result = await skills.run('withdraw', ctxWithSignal(this.ctx, this._signal), {
      item: this.item,
      count: this.count
    });
    this.withdrawn = Number.isFinite(result.withdrawn)
      ? result.withdrawn
      : Number.isFinite(result.moved)
        ? result.moved
        : 0;
    return {
      ...result,
      ok: result.ok !== false,
      reason:
        result.reason ||
        result.detail ||
        (result.ok === false ? 'withdraw failed' : `withdrew ${this.withdrawn} ${this.item}`)
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

module.exports = { WithdrawTask };
