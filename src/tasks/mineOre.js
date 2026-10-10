'use strict';

/**
 * MineOreTask: the Brain's adapter around the `mine_ore` skill.
 *
 * The autonomous planner ("has a pickaxe, no iron yet -> go mine iron") must use the
 * same ore executor the explicit entry points submit - but it already owns a TaskHub/
 * Brain slot. Submitting another TaskHub job from inside its own run would replace the
 * very task that is running (the plan's §5.6.3 warning: "不从该任务内部再提交 TaskHub，
 * 否则会抢占自己"). So the adapter calls the skill boundary directly and keeps the
 * planner's ownership, cancellation and result reporting unchanged.
 */

const { Task } = require('./task');
const { normalizeMiningRequest, resolverFromCtx } = require('../core/miningRequest');

class MineOreTask extends Task {
  /**
   * @param {object} ctx
   * @param {object} options
   *   - block/ore: string or string[] target names (aliases allowed)
   *   - count: max ore blocks (strictly validated at run time)
   *   - plus any `mine_ore` skill parameter (maxXZ, maxY, maxMs, ...)
   */
  constructor(ctx, options = {}) {
    const targets = options.block || options.ore || 'iron_ore';
    const label = Array.isArray(targets) ? targets.join('/') : String(targets);
    super(ctx, {
      name: 'mine_ore',
      description: options.description || `mine ${label}${options.count ? ` x${options.count}` : ''}`,
      priority: options.priority === undefined ? 56 : options.priority,
      timeoutMs: options.timeoutMs || 600000
    });
    this.targets = targets;
    this.count = options.count;
    /** Everything else the skill understands is passed through untouched. */
    this.skillParams = {};
    for (const key of ['maxXZ', 'maxY', 'maxMs', 'maxApproachDigs', 'maxExtraDigs', 'eatAt', 'food', 'torch', 'lightThreshold']) {
      if (options[key] !== undefined) this.skillParams[key] = options[key];
    }
  }

  async run() {
    const normalized = normalizeMiningRequest(
      { blocks: this.targets, count: this.count },
      { resolver: resolverFromCtx(this.ctx) }
    );
    if (!normalized.ok) {
      return { ok: false, reason: normalized.reason, failure: 'bad_argument' };
    }
    if (normalized.kind !== 'ore') {
      return { ok: false, reason: 'MineOreTask only takes ores; use MineBlockTask for materials', failure: 'bad_argument' };
    }
    const params = { block: normalized.blocks.join(','), ...this.skillParams };
    if (normalized.count !== undefined) params.count = normalized.count;
    const skills = require('../skills');
    const result = await skills.run('mine_ore', this.ctx, params);
    /**
     * Keep the skill's full result (mined/ledger/minedAt/progress): the plan asks the
     * adapter to preserve `progress` and `mined/ledger/failure`, not just ok/reason.
     */
    return { ...result, ok: result.ok !== false };
  }

  progress() {
    if (!this.result) return null;
    return {
      mined: this.result.mined,
      minedAt: this.result.minedAt,
      blocked: this.result.skipped
    };
  }
}

module.exports = { MineOreTask };
