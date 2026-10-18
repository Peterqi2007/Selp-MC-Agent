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
const { ctxWithSignal } = require('../core/taskHub');

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
    /**
     * Bridge the base Task's cancel() into the skill's token so a planner pre-emption
     * stops the mining loop at its next action boundary instead of after the next ore.
     */
    this._signal = { cancelled: false, reason: null };
    const result = await skills.run('mine_ore', ctxWithSignal(this.ctx, this._signal), params);
    /**
     * Keep the skill's full result (mined/ledger/minedAt/progress): the plan asks the
     * adapter to preserve `progress` and `mined/ledger/failure`, not just ok/reason.
     *
     * `reason` is the skill's human detail. Without it a zero/partial result reached the
     * event stream as the useless word "completed" (A13-c1 live, 2026-10-18).
     */
    return { ...result, ok: result.ok !== false, reason: result.reason || result.detail || null };
  }

  cancel() {
    if (this._signal) {
      this._signal.cancelled = true;
      this._signal.reason = 'task cancelled';
    }
    super.cancel();
  }

  /**
   * A comparable progress value (P3). `brain._noteProgress` compares with `===`, so this
   * used to return a fresh object and the zero-progress park never fired for ore runs.
   * String form keeps both halves of the story - blocks actually mined and blocks the
   * planner had to skip - and stays monotonic as long as either changes.
   */
  progress() {
    if (!this.result) return null;
    const skipped = Array.isArray(this.result.skipped) ? this.result.skipped.length : Number(this.result.blocked || 0);
    return `${this.result.mined || 0}/${skipped}`;
  }
}

module.exports = { MineOreTask };
