'use strict';

/**
 * FollowTask: the task-layer adapter around the `follow` skill.
 *
 * `!follow`, `do_skill follow`, a DSH `mc_plan`/`mc_propose` step of type `follow` and any
 * other task caller all go through this one adapter. The skill owns the high-frequency
 * target polling, the A* re-planning and the pathfinding-range guard.
 *
 * `player` is required. `durationMs` defaults to five minutes: follow is a long-running
 * directive, so it is ended by `!stop` (which cancels the current task) or by the target
 * disappearing; the timeout is slightly above the skill's own duration so the two do not
 * race.
 */

const { Task } = require('./task');
const { ctxWithSignal } = require('../core/taskHub');
const { bare } = require('../world/items');

class FollowTask extends Task {
  constructor(ctx, options = {}) {
    const requested = Number(options.durationMs);
    const durationMs =
      Number.isFinite(requested) && requested > 0 ? Math.min(3600000, Math.floor(requested)) : 300000;
    super(ctx, {
      name: 'follow',
      description: options.player ? `follow ${options.player}` : 'follow a player',
      timeoutMs: options.timeoutMs || durationMs + 30000,
      priority: options.priority
    });
    this.player = options.player ? String(options.player).trim() : null;
    this.range = options.range;
    this.maxRange = options.maxRange;
    this.pollMs = options.pollMs;
    this.durationMs = durationMs;
    /** Number of fresh target reads; comparable progress for the planner/task slot. */
    this.samples = 0;
    /** Cancellation token handed to the skill through the scoped context. */
    this._signal = null;
  }

  progress() {
    return this._signal ? Number(this._signal.samples) || 0 : this.samples;
  }

  async run() {
    if (!this.player) return this.fail('follow needs a player name');
    const skills = require('../skills');
    this._signal = { cancelled: false, reason: null, samples: 0 };
    const params = {
      player: bare(this.player),
      durationMs: this.durationMs
    };
    if (this.range !== undefined) params.range = this.range;
    if (this.maxRange !== undefined) params.maxRange = this.maxRange;
    if (this.pollMs !== undefined) params.pollMs = this.pollMs;
    const result = await skills.run('follow', ctxWithSignal(this.ctx, this._signal), params);
    this.samples = Number.isFinite(result.samples) ? result.samples : 0;
    return {
      ...result,
      ok: result.ok !== false,
      reason:
        result.reason ||
        result.detail ||
        (result.ok === false ? 'follow failed' : `followed ${this.player}`)
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

module.exports = { FollowTask };
