'use strict';

/**
 * FishTask: the task-layer adapter around the `fish` skill.
 *
 * Why an adapter instead of calling the skill directly:
 *   - the DSH action brain submits plans through `mc_plan` and proposals through
 *     `mc_propose`; both resolve their step type through `TASK_BUILDERS`, so `fish` has to
 *     exist there or Node rejects the step with `unknown-step-type`;
 *   - `!fish` must not block the command endpoint for the skill's 15-minute default budget,
 *     so the command enqueues this task and answers immediately (same shape as `!hunt`);
 *   - the planner owns one body and one task slot; running the skill inside a task keeps
 *     cancellation, `!task status`, events and the plan runner's postconditions intact
 *     (mirrors `MineOreTask`, docs/MINING-LLM-PLAN §5.6.3).
 *
 * Cancellation is bridged into the skill's `ctx.taskSignal`; `fishing.js` checks it inside
 * the bite wait, so `!stop` does not sit out the next 45-second cast.
 */

const { Task } = require('./task');
const { ctxWithSignal } = require('../core/taskHub');

/** Skill parameters the task forwards untouched. */
const SKILL_PARAMS = [
  'rod',
  'searchRadius',
  'maxCatches',
  'maxMs',
  'biteTimeoutMs',
  'eatAt',
  'food',
  'sleep',
  'bedRadius'
];

class FishTask extends Task {
  /**
   * @param {object} ctx
   * @param {object} options
   *   - count: alias for `maxCatches` (what `!fish <n>` and the model mean)
   *   - plus any `fish` skill parameter (maxMs, eatAt, food, sleep, ...)
   */
  constructor(ctx, options = {}) {
    const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : 900000;
    const maxCatches = Number.isFinite(options.count)
      ? options.count
      : Number.isFinite(options.maxCatches)
        ? options.maxCatches
        : 32;
    super(ctx, {
      name: 'fish',
      description: options.description || `fish (up to ${maxCatches} catch(es))`,
      timeoutMs: options.timeoutMs || maxMs + 60000,
      priority: options.priority
    });
    this.maxCatches = maxCatches;
    this.skillParams = {};
    for (const key of SKILL_PARAMS) {
      if (options[key] !== undefined && options[key] !== null) this.skillParams[key] = options[key];
    }
    /** Catches verified by the skill; the planner's comparable progress value. */
    this.catches = 0;
    /** Cancellation token handed to the skill through the scoped context. */
    this._signal = null;
  }

  progress() {
    return this.catches;
  }

  async run() {
    const skills = require('../skills');
    this._signal = { cancelled: false, reason: null };
    const params = { ...this.skillParams, maxCatches: this.maxCatches };
    const result = await skills.run('fish', ctxWithSignal(this.ctx, this._signal), params);
    this.catches = Number.isFinite(result.catches) ? result.catches : 0;
    /**
     * Keep the skill's full result (catches/casts/sleeps/stopped/detail). `reason` falls
     * back to `detail` so the event stream never reports the useless word "completed" for
     * a rod-broken / hostile / cancelled stop.
     */
    return {
      ...result,
      ok: result.ok !== false,
      reason: result.reason || result.detail || (result.ok === false ? 'fishing failed' : `caught ${this.catches} fish`)
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

module.exports = { FishTask };
