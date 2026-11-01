'use strict';

/**
 * Fully autonomous mode - one explicit state machine that lets the agent run the Voyager-style
 * curriculum with **no player approval at all**, and recover from its own deaths.
 *
 * Why a mode object instead of a few booleans on the Brain: every existing "stop" flag answers
 * a different question (`paused`, `owner-stop`, `dead`, `autoPlanDisabled`), and fully
 * autonomous behaviour needs answers to questions none of them answer:
 *
 *   - may the coordinator start a prep goal without the 5-minute idle wait?  -> phase
 *   - is an action-brain proposal approved without asking anyone?           -> isActive()
 *   - may a player command run right now, and what do we say when it may not? -> gateCommand()
 *   - who clears the post-death stop?                                      -> onRespawned() only
 *
 * The mode never executes tasks itself. It owns three things the other modules must not own:
 *
 *   1. **The lifecycle** (`!autonomous on/off`, `!stop` pauses) and its persistence.
 *   2. **The player gate** - a busy line with the current activity and state, used by the
 *      command table, the language-brain approval path and the permission gate.
 *   3. **Death recovery** - respawn + walk back to the corpse + loot it, while the brain is
 *      still stopped, then release the death hold and hand control back to the curriculum.
 *
 * Default off. Only a `!` command can start it (see `docs/FULLY-AUTONOMOUS.md`).
 */

const { recoverCorpse } = require('./corpseRecovery');

const DEFAULTS = Object.freeze({
  enabled: true,
  defaultObjective:
    '生存与发展（Voyager 风格）：从基础资源开始，逐步完成更难的采集、合成、建造与探索任务，避免重复已完成的工作。',
  commandAllowlist: ['autonomous', 'stop', 'status', 'help', 'inv', 'where'],
  roundCooldownMs: 5000,
  maxRoundsPerHour: 60,
  maxPrepFailures: 3,
  maxConsecutiveBlocked: 5,
  tickMs: 2500,
  announce: { start: true, stop: true, death: true, recovery: true },
  death: {
    respawn: true,
    respawnTimeoutMs: 30000,
    corpseRecovery: true,
    corpseEntityTypes: ['corpse:corpse'],
    corpseRadius: 16,
    maxCorpseDistance: 512,
    allowOtherDimension: false,
    deathLoopWindowMs: 600000,
    deathLoopMax: 3
  }
});

const DIMENSION_NAMES = {
  'minecraft:overworld': '主世界',
  'minecraft:the_nether': '下界',
  'minecraft:the_end': '末地',
  overworld: '主世界',
  the_nether: '下界',
  the_end: '末地'
};

const ACTIVE_PHASES = new Set(['running', 'dead', 'respawning', 'recovering']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function dimensionName(dimension) {
  const key = String(dimension || '');
  return DIMENSION_NAMES[key] || key || '未知维度';
}

function shortPosition(position) {
  if (!position) return '位置未知';
  return `${Math.floor(Number(position.x))},${Math.floor(Number(position.y))},${Math.floor(Number(position.z))}`;
}

/** Merge the operator's config over the defaults, one level deep, without dropping comments. */
function mergeCfg(base, override) {
  if (!override || typeof override !== 'object') return { ...base };
  const out = { ...base, ...override };
  out.death = { ...base.death, ...(override.death || {}) };
  out.announce = { ...base.announce, ...(override.announce || {}) };
  if (!Array.isArray(out.commandAllowlist) || !out.commandAllowlist.length) {
    out.commandAllowlist = [...base.commandAllowlist];
  }
  return out;
}

class AutonomousMode {
  /**
   * @param {object} deps
   *   ctx      agent context (body, brain, reply, curriculum, proposalCoordinator, harnessBridge, ...)
   *   cfg      planner.fullyAutonomous config block
   *   log      logger
   *   now      () => number
   */
  constructor(deps = {}) {
    this.ctx = deps.ctx || {};
    this.cfg = mergeCfg(DEFAULTS, deps.cfg);
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.now = deps.now || (() => Date.now());

    /** off | running | dead | respawning | recovering | paused */
    this.phase = 'off';
    this.pausedReason = null;
    this.objective = this.cfg.defaultObjective;
    this.startedAt = null;
    this.round = 0;
    this.death = null;
    this.recovering = null;
    this.lastRecovery = null;
    this.lastActivity = null;
    this.stats = {
      rounds: 0,
      completed: 0,
      blocked: 0,
      prepStarted: 0,
      prepFailed: 0,
      deaths: 0,
      respawns: 0,
      recoveries: 0,
      recoveryFailures: 0,
      busyReplies: 0,
      blockedCommands: 0
    };
    this.guards = { prepFailures: 0, consecutiveBlocked: 0, rounds: [], deaths: [] };
    /** Rolling inventory copy: the last seen contents before a death (for honest reporting). */
    this.lastInventory = {};
    this.timer = null;
    this._deathTask = null;
    this._abortRecovery = false;
    this._tickBusy = false;
  }

  // ------------------------------------------------------------------ lifecycle

  /** Is the mode allowed to act (start proposals, accept them, run recovery)? */
  isActive() {
    return ACTIVE_PHASES.has(this.phase);
  }

  /** Only a `!` command calls this. */
  async start(options = {}) {
    if (!this.cfg.enabled) return { ok: false, reason: 'disabled' };
    if (this.phase === 'running' || this.phase === 'recovering') {
      return { ok: true, reason: 'already-running', phase: this.phase };
    }
    const body = this.ctx.body;
    const snap = body && typeof body.snapshot === 'function' ? body.snapshot() : null;
    if (!snap || snap.ready !== true) return { ok: false, reason: 'body-not-attached' };
    const coordinator = this.ctx.proposalCoordinator;
    if (!coordinator) return { ok: false, reason: 'no-action-brain' };
    if (!this.ctx.harnessBridge) return { ok: false, reason: 'no-harness-bridge' };

    /** Take over: an explicit start cancels whatever the agent was doing. */
    try {
      this.ctx.brain.preempt();
    } catch {
      /* a stub brain in tests may not implement it */
    }
    if (this.ctx.planService && typeof this.ctx.planService.cancelAll === 'function') {
      this.ctx.planService.cancelAll('autonomous-takeover').catch(() => {});
    }
    if (this.ctx.turnService && typeof this.ctx.turnService.cancelAll === 'function') {
      this.ctx.turnService.cancelAll('autonomous-takeover');
    }
    if (this.ctx.hub && typeof this.ctx.hub.cancel === 'function') {
      this.ctx.hub.cancel('autonomous-takeover').catch(() => {});
    }
    /**
     * Clear the operator holds (`!stop` / `!pause`). The `dead` hold is deliberately left
     * alone: if the agent is dead, the death sequence below is what clears it.
     */
    if (typeof this.ctx.brain.resume === 'function') {
      try {
        this.ctx.brain.resume();
      } catch {
        /* stub */
      }
    }
    /**
     * A stop leaves a *paused* DSH goal behind; the plugin refuses new goal rounds for it and
     * the coordinator would sit on `goal:paused` forever. Starting the mode is an explicit
     * takeover, so an **active** goal left by a failed task is closed too: otherwise the
     * coordinator sits on `goal:active` and never starts a round (live retest 2026-11-01).
     */
    if (typeof this.ctx.clearActionBrainGoal === 'function') {
      try {
        const cleared = await this.ctx.clearActionBrainGoal({ includeActive: true });
        if (cleared && cleared.cleared) this.log.info(`cleared leftover action-brain goal ${cleared.goalId} (${cleared.phase || 'paused'})`);
      } catch (err) {
        this.log.debug(`clearing the leftover action-brain goal failed: ${err.message}`);
      }
    }

    this.phase = 'running';
    this.pausedReason = null;
    this.objective = String(options.objective || this.objective || this.cfg.defaultObjective).trim();
    this.startedAt = new Date(this.now()).toISOString();
    this.guards.prepFailures = 0;
    this.guards.consecutiveBlocked = 0;
    this._ensureTimer();
    this._announce('start', `完全自主模式已启动：${this.objective}`);
    this.log.info(`fully autonomous mode ON (objective: ${this.objective})`);
    Promise.resolve(coordinator.tick()).catch((err) => this.log.debug(`autonomous kick failed: ${err.message}`));
    return { ok: true, reason: 'started', phase: this.phase, objective: this.objective };
  }

  /** `!stop`, the panel's emergency stop and the safety guards all land here. */
  pause(reason = 'paused') {
    if (this.phase === 'off' || this.phase === 'paused') return { ok: true, reason: 'not-active', phase: this.phase };
    this.phase = 'paused';
    this.pausedReason = String(reason || 'paused');
    this._abortRecovery = true;
    /**
     * Stop the action brain itself. Closing the goal only stops future rounds; the turn that
     * is running right now keeps calling tools (live 2026-11-01: it kept issuing mc_step).
     */
    this._lockActionBrain(`autonomous:${this.pausedReason}`);
    const coordinator = this.ctx.proposalCoordinator;
    if (coordinator && typeof coordinator.abortGoals === 'function') {
      Promise.resolve(coordinator.abortGoals(`autonomous-${reason}`)).catch(() => null);
    }
    this._announce('stop', `完全自主模式已暂停（${this.pausedReason}），发 !autonomous on 继续`);
    this.log.warn(`fully autonomous mode PAUSED (${this.pausedReason})`);
    return { ok: true, reason: 'paused', phase: this.phase, pausedReason: this.pausedReason };
  }

  /** `!autonomous off`: leave the mode entirely (not the same thing as a pause). */
  off(reason = 'off') {
    if (this.phase === 'off') return { ok: true, reason: 'already-off' };
    this._lockActionBrain(`autonomous:${reason}`);
    const coordinator = this.ctx.proposalCoordinator;
    if (coordinator && typeof coordinator.abortGoals === 'function') {
      Promise.resolve(coordinator.abortGoals(`autonomous-${reason}`)).catch(() => null);
    }
    this._abortRecovery = true;
    this.phase = 'off';
    this.pausedReason = null;
    this.startedAt = null;
    this.recovering = null;
    this._stopTimer();
    this._announce('stop', '完全自主模式已关闭');
    this.log.info('fully autonomous mode OFF');
    return { ok: true, reason: 'off', phase: this.phase };
  }

  /**
   * Whose turn is it for the post-death stop?
   *
   * `DeathWatch` documents "no auto-resume" and that stays true: this only returns a resume
   * when the death happened **inside** the mode, i.e. the operator already opted into
   * "respawn and come back".
   */
  ownsDeathRecovery() {
    return this.isActive();
  }

  // ------------------------------------------------------------------ gates

  /** May this `!` command run while the mode is active? */
  gateCommand(cmd) {
    if (!this.isActive()) return { blocked: false };
    const name = String(cmd || '').toLowerCase();
    if (this.cfg.commandAllowlist.includes(name)) return { blocked: false };
    this.stats.blockedCommands += 1;
    return { blocked: true, reason: `autonomous-busy:${name}`, line: this.busyLine() };
  }

  /** Should a natural-language action request be turned into a busy reply? */
  gateApproval() {
    if (!this.isActive()) return null;
    return { blocked: true, line: this.busyLine() };
  }

  /** Saying it is the caller's job; this only counts and returns the line. */
  noteBusyReply() {
    this.stats.busyReplies += 1;
  }

  // ------------------------------------------------------------------ curriculum glue

  /** Auto-accept is the whole point of the mode; the coordinator asks this per proposal. */
  shouldAutoAccept() {
    return this.isActive();
  }

  /**
   * Effective idle time for the coordinator: the 5-minute human clock does not apply here.
   *
   * When the action brain is not bound yet (DSH still starting, or no live conversation), a
   * 5-second retry only fills the log with warnings - back off to 30 seconds until it binds.
   */
  effectiveIdleMs(fallback) {
    if (!this.isActive()) return fallback;
    const cooldown = clampNum(num(this.cfg.roundCooldownMs, 5000), 0, 600000);
    const coordinator = this.ctx.proposalCoordinator;
    const lastError = coordinator && coordinator.lastError ? String(coordinator.lastError) : '';
    if (/no-live-action-brain|goal-client-unavailable/.test(lastError)) return Math.max(cooldown, 30000);
    return cooldown;
  }

  /** Preamble prepended to the proposal-prep goal so the action brain knows nobody approves. */
  prepPreamble() {
    if (!this.isActive()) return '';
    return [
      'FULLY AUTONOMOUS MODE: no player is available to approve anything.',
      `OBJECTIVE: ${this.objective}`,
      'Propose exactly one next task that fits the curriculum band below. Your proposal will be accepted automatically and you will immediately receive an execution goal.',
      'Do NOT call mc_ask_player and do not ask the player: there is nobody to answer. If a task cannot be done, mark the goal blocked with a concrete reason and propose a different task next round.',
      'Prefer tasks that make measurable progress on the objective. Do not repeat the tasks in the completed list.'
    ].join('\n');
  }

  /** Preamble for the execution goal. */
  executionPreamble() {
    if (!this.isActive()) return '';
    return [
      'FULLY AUTONOMOUS MODE: this task was approved automatically on your own proposal.',
      'Carry it out now with mc_step/mc_plan, verify real effects with mc_state/mc_observe, and finish the goal with complete or blocked.',
      'There is nobody to ask: a tool answering `autonomous-no-approval` means "decide something else", not "wait for the player".'
    ].join('\n');
  }

  /** The coordinator reports preparation outcomes here (guards live in the mode). */
  notePreparation(outcome = {}) {
    if (!this.isActive()) return;
    if (outcome.hadProposal) {
      this.guards.prepFailures = 0;
      return;
    }
    this.guards.prepFailures += 1;
    this.stats.prepFailed += 1;
    if (this.guards.prepFailures >= clampNum(num(this.cfg.maxPrepFailures, 3), 1, 100)) {
      this.pause('prep-failures');
    }
  }

  /** The coordinator reports execution settlements here. */
  noteExecution(outcome = {}) {
    if (!this.isActive()) return;
    const phase = String(outcome.phase || '').toLowerCase();
    if (phase === 'complete') {
      this.stats.completed += 1;
      this.guards.consecutiveBlocked = 0;
      return;
    }
    if (phase === 'blocked') {
      this.stats.blocked += 1;
      this.guards.consecutiveBlocked += 1;
      if (this.guards.consecutiveBlocked >= clampNum(num(this.cfg.maxConsecutiveBlocked, 5), 1, 100)) {
        this.pause('repeated-failures');
      }
    }
  }

  /** Called when a proposal has been auto-accepted (one curriculum round). */
  noteRound(candidate = {}) {
    this.round += 1;
    this.stats.rounds += 1;
    this.lastActivity = {
      name: candidate.name || candidate.type || null,
      type: candidate.type || null,
      args: candidate.args || {},
      at: new Date(this.now()).toISOString()
    };
    this.guards.rounds.push(this.now());
    const windowStart = this.now() - 3600000;
    this.guards.rounds = this.guards.rounds.filter((at) => at >= windowStart);
    if (this.guards.rounds.length > clampNum(num(this.cfg.maxRoundsPerHour, 60), 1, 10000)) {
      this.pause('budget');
    }
  }

  // ------------------------------------------------------------------ death

  /** DeathWatch hook: the agent died while the mode was active. */
  onDeath(death) {
    this.death = death
      ? { ...death, at: death.at || new Date(this.now()).toISOString() }
      : { at: new Date(this.now()).toISOString(), position: null, dimension: null };
    this.stats.deaths += 1;
    this.guards.deaths.push(this.now());
    const windowMs = clampNum(num(this.cfg.death.deathLoopWindowMs, 600000), 1000, 86400000);
    this.guards.deaths = this.guards.deaths.filter((at) => at >= this.now() - windowMs);
    if (!this.isActive()) return { ok: true, reason: 'not-active' };
    if (this.guards.deaths.length >= clampNum(num(this.cfg.death.deathLoopMax, 3), 2, 100)) {
      this.pause('death-loop');
      return { ok: true, reason: 'death-loop-guard' };
    }
    this._announce('death', `死在了 ${shortPosition(this.death.position)}，正在自动重生并回收物品`);
    this._startDeathSequence();
    return { ok: true, reason: 'death-sequence-started' };
  }

  /** DeathWatch hook: the client is alive again (respawn already happened). */
  onRespawned() {
    this.stats.respawns += 1;
    if (this.phase === 'dead' || this.phase === 'respawning') {
      /** The death sequence polls the same fact; this only records the event for the panel. */
      this.log.info('fully autonomous: respawn observed');
    }
    return { ok: true };
  }

  /** Wait until the body reports a live player again. */
  async _waitAlive(timeoutMs) {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (this.phase === 'paused' || this.phase === 'off') return false;
      const snap = this.ctx.body && typeof this.ctx.body.snapshot === 'function' ? this.ctx.body.snapshot() : null;
      if (snap && snap.ready === true && snap.dead !== true) return true;
      await sleep(1000);
    }
    return false;
  }

  _startDeathSequence() {
    if (this._deathTask) return this._deathTask;
    this._deathTask = this._deathSequence()
      .catch((err) => {
        this.log.warn(`autonomous death sequence failed: ${err.message}`);
        this.pause('death-sequence-failed');
      })
      .finally(() => {
        this._deathTask = null;
        /**
         * A second death during respawn/recovery must restart the sequence, not fall through
         * to "resume the curriculum" - the body is dead again. The death-loop guard still
         * caps how many times this can happen.
         */
        if (this.pendingDeathRestart) {
          this.pendingDeathRestart = false;
          if (this.isActive()) this._startDeathSequence();
        }
      });
    return this._deathTask;
  }

  /**
   * Respawn, recover the corpse, then hand control back to the curriculum.
   *
   * The brain is still stopped by the `dead` hold while this runs, which is exactly what we
   * want: nothing else may drive the body during recovery.
   */
  async _deathSequence() {
    const cfg = this.cfg.death;
    const coordinator = this.ctx.proposalCoordinator;
    this.phase = 'dead';
    this.recovering = null;
    this._abortRecovery = false;
    if (coordinator && typeof coordinator.abortGoals === 'function') {
      await coordinator.abortGoals('death').catch(() => null);
    }

    const deadline = this.now() + clampNum(num(cfg.respawnTimeoutMs, 30000), 1000, 600000);
    let alive = false;
    while (this.now() < deadline) {
      if (this.phase === 'paused' || this.phase === 'off') return;
      const snap = this.ctx.body && typeof this.ctx.body.snapshot === 'function' ? this.ctx.body.snapshot() : null;
      if (snap && snap.ready === true && snap.dead !== true) {
        alive = true;
        break;
      }
      if (cfg.respawn !== false && this.ctx.body && typeof this.ctx.body.respawn === 'function') {
        const res = await this.ctx.body.respawn().catch(() => null);
        if (res && res.ok) this.log.info('fully autonomous: respawn requested');
      }
      await sleep(1000);
    }
    if (!alive) {
      this.pause('respawn-failed');
      return;
    }
    this.phase = 'respawning';
    const back = await this._waitAlive(clampNum(num(cfg.respawnTimeoutMs, 30000), 1000, 600000));
    if (!back) {
      this.pause('respawn-failed');
      return;
    }
    /** AuthMe login is fired by DeathWatch.onRespawn; give it a beat before walking away. */
    await sleep(1500);

    const snap = this.ctx.body && typeof this.ctx.body.snapshot === 'function' ? this.ctx.body.snapshot() : null;
    const inventoryBefore = { ...((snap && snap.inventory) || {}) };
    const expected = this.lastInventory || {};

    if (cfg.corpseRecovery !== false && this.death && this.death.position) {
      this.phase = 'recovering';
      this.recovering = { step: 'walking', corpse: null, startedAt: new Date(this.now()).toISOString() };
      const result = await recoverCorpse(this.ctx, {
        death: this.death,
        cfg,
        inventoryBefore,
        cancelled: () => this._abortRecovery || this.phase === 'paused' || this.phase === 'off',
        onStep: (step, detail) => {
          this.recovering = { ...(this.recovering || {}), step, ...(detail || {}) };
        }
      }).catch((err) => ({ ok: false, reason: `error:${err.message}` }));
      this.lastRecovery = { ...result, expectedItems: Object.keys(expected).length, at: new Date(this.now()).toISOString() };
      this.recovering = null;
      if (result.ok) {
        this.stats.recoveries += 1;
        this._announce('recovery', `物品已从遗体取回（${result.slotsMoved} 格）`);
      } else {
        this.stats.recoveryFailures += 1;
        this.log.warn(`fully autonomous: corpse recovery failed (${result.reason})`);
      }
    }

    if (this.phase === 'paused' || this.phase === 'off') return;
    /**
     * Dying again while walking to (or looting) the corpse is the one case that must not
     * resume the curriculum: the body in front of us is dead. Restart the sequence.
     */
    const finalSnap = this._snapshot();
    if (finalSnap && finalSnap.dead === true) {
      this.log.warn('fully autonomous: died again during recovery; restarting the death sequence');
      this.pendingDeathRestart = true;
      return;
    }
    /** This is the one place allowed to clear the post-death stop: the operator opted in. */
    if (this.ctx.brain && typeof this.ctx.brain.resumeFromDeath === 'function') {
      this.ctx.brain.resumeFromDeath();
    } else if (this.ctx.brain && typeof this.ctx.brain.release === 'function') {
      this.ctx.brain.release('dead');
    }
    this.phase = 'running';
    this.log.info('fully autonomous: death handled, curriculum resumes');
    if (coordinator && typeof coordinator.tick === 'function') {
      Promise.resolve(coordinator.tick()).catch(() => null);
    }
  }

  // ------------------------------------------------------------------ observation

  _snapshot() {
    const body = this.ctx.body;
    return body && typeof body.snapshot === 'function' ? body.snapshot() : null;
  }

  /** Everything the busy line, the panel and `/ui/state` need, in one plain object. */
  describeActivity() {
    const snap = this._snapshot();
    const coordinator = this.ctx.proposalCoordinator;
    const execution = coordinator && coordinator.executionGoal ? coordinator.executionGoal : null;
    const candidate = (execution && execution.candidate) || this.lastActivity || null;
    const curriculum = this.ctx.curriculum;
    let curriculumStatus = null;
    try {
      curriculumStatus = curriculum && typeof curriculum.status === 'function' ? curriculum.status() : null;
    } catch {
      curriculumStatus = null;
    }
    return {
      phase: this.phase,
      pausedReason: this.pausedReason,
      round: this.round,
      objective: this.objective,
      candidate: candidate
        ? { name: candidate.name || candidate.type || null, type: candidate.type || null, args: candidate.args || {} }
        : null,
      goal: execution ? { id: execution.id, agentId: execution.agentId || null } : null,
      recovering: this.recovering,
      body: {
        position: snap && snap.position ? { ...snap.position } : null,
        dimension: snap && snap.dimension ? String(snap.dimension) : null,
        health: snap && Number.isFinite(Number(snap.health)) ? Number(snap.health) : null,
        food: snap && Number.isFinite(Number(snap.food)) ? Number(snap.food) : null,
        dead: !!(snap && snap.dead === true)
      },
      curriculum: curriculumStatus
        ? {
            level: curriculumStatus.level,
            band: curriculumStatus.requiredDifficulty,
            completed: Array.isArray(curriculumStatus.completed) ? curriculumStatus.completed.length : curriculumStatus.completed,
            failed: Array.isArray(curriculumStatus.failed) ? curriculumStatus.failed.length : curriculumStatus.failed
          }
        : null,
      deaths: this.stats.deaths,
      lastRecovery: this.lastRecovery
    };
  }

  /**
   * The one line every player-facing gate says.
   *
   * It must answer three questions in one breath - "I am busy with what", "where am I and how
   * am I doing", "can you do my task" - because the mode's whole promise to the operator is
   * that they are not ignored, only declined.
   */
  busyLine() {
    const activity = this.describeActivity();
    const body = activity.body || {};
    let doing;
    if (activity.phase === 'dead') doing = '刚死了，正在重生';
    else if (activity.phase === 'respawning') doing = '正在重生';
    else if (activity.phase === 'recovering') {
      const step = (activity.recovering && activity.recovering.step) || '走过去';
      doing = `刚重生，正在回收遗体（${step}）`;
    } else if (activity.candidate) {
      doing = `正在做「${activity.candidate.name || activity.candidate.type}」（第 ${activity.round || this.round} 轮）`;
    } else if (activity.round > 0) doing = '正在挑下一个任务';
    else doing = '正在开始自主探索';
    const where = `${dimensionName(body.dimension)} ${shortPosition(body.position)}`;
    const hp = body.health === null || body.health === undefined ? '?' : Math.round(body.health);
    const food = body.food === null || body.food === undefined ? '?' : Math.round(body.food);
    const band = activity.curriculum ? `难度 ${activity.curriculum.band}` : '';
    const parts = [doing, band].filter(Boolean).join('，');
    return (
      `正在忙：${parts}；我在${where}，血 ${hp}/20 饥饿 ${food}/20。` +
      '完全自主模式中，新任务暂时做不了。'
    );
  }

  /** Snapshot for `/ui/state` (cheap, no I/O). */
  snapshot() {
    const activity = this.describeActivity();
    const coordinator = this.ctx.proposalCoordinator;
    return {
      enabled: this.cfg.enabled,
      active: this.isActive(),
      phase: this.phase,
      pausedReason: this.pausedReason,
      objective: this.objective,
      startedAt: this.startedAt,
      round: this.round,
      cooldownMs: this.cfg.roundCooldownMs,
      allowlist: [...this.cfg.commandAllowlist],
      activity,
      /** Why a round is not starting (e.g. `no-live-action-brain`, `prep-in-flight`). */
      coordinator: coordinator
        ? {
            prepInFlight: coordinator.prepInFlight === true,
            prepGoalId: coordinator.prepGoal ? coordinator.prepGoal.id : null,
            executionGoalId: coordinator.executionGoal ? coordinator.executionGoal.id : null,
            lastError: coordinator.lastError || null,
            lastBlockedReason: coordinator.lastBlockedReason || null,
            autoAccept: typeof coordinator.autonomousActive === 'function' ? coordinator.autonomousActive() : false
          }
        : null,
      guards: {
        prepFailures: this.guards.prepFailures,
        consecutiveBlocked: this.guards.consecutiveBlocked,
        roundsLastHour: this.guards.rounds.length,
        deathsInWindow: this.guards.deaths.length
      },
      lastRecovery: this.lastRecovery,
      stats: { ...this.stats }
    };
  }

  status() {
    return this.snapshot();
  }

  // ------------------------------------------------------------------ tick

  _ensureTimer() {
    if (this.timer) return;
    const interval = clampNum(num(this.cfg.tickMs, 2500), 250, 60000);
    this.timer = setInterval(() => {
      this.tick().catch(() => null);
    }, interval);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  _stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Heartbeat: keep the rolling inventory copy, notice a death the DeathWatch hook missed,
   * and keep a dead-but-active mode moving.
   */
  async tick() {
    if (this._tickBusy) return;
    if (!this.isActive()) {
      /** Still remember the inventory while paused? No: a pause is the operator's business. */
      return;
    }
    this._tickBusy = true;
    try {
      const snap = this._snapshot();
      if (snap && snap.inventory) this.lastInventory = { ...snap.inventory };
      if (snap && snap.dead === true) {
        /**
         * Backstop for a DeathWatch that is disabled or lagging. A death sequence already in
         * flight is not restarted (and must not be counted twice); a death **during recovery**
         * aborts the loot run and lets the pending restart handle it - the body cannot walk
         * while dead.
         */
        if (this._deathTask || this.phase === 'dead' || this.phase === 'respawning') {
          if (this.phase === 'recovering') this._abortRecovery = true;
          return;
        }
        this.onDeath({ position: snap.position ? { ...snap.position } : null, dimension: snap.dimension || null });
        return;
      }
      if (snap && snap.ready === true && snap.dead !== true && this.phase === 'dead' && !this._deathTask) {
        this._startDeathSequence();
      }
    } finally {
      this._tickBusy = false;
    }
  }

  // ------------------------------------------------------------------ persistence

  toJSON() {
    return {
      version: 1,
      phase: this.phase,
      pausedReason: this.pausedReason,
      objective: this.objective,
      startedAt: this.startedAt,
      round: this.round,
      stats: { ...this.stats },
      death: this.death,
      lastRecovery: this.lastRecovery,
      lastInventory: { ...this.lastInventory }
    };
  }

  /**
   * Restore from a session file.
   *
   * A restart is **not** a reason to start working again: the operator's rule is that only a
   * `!` command starts the mode. A previously running mode therefore comes back as `paused`
   * with `restart` as the reason, and the panel shows how to continue.
   */
  restore(data) {
    if (!data || data.version !== 1) return { ok: false, reason: 'unsupported-version' };
    this.objective = String(data.objective || this.cfg.defaultObjective);
    this.round = Number.isFinite(Number(data.round)) ? Number(data.round) : 0;
    this.death = data.death || null;
    this.lastRecovery = data.lastRecovery || null;
    this.lastInventory = data.lastInventory && typeof data.lastInventory === 'object' ? { ...data.lastInventory } : {};
    if (data.stats && typeof data.stats === 'object') this.stats = { ...this.stats, ...data.stats };
    const previous = String(data.phase || 'off');
    if (previous === 'off') {
      this.phase = 'off';
      return { ok: true, phase: this.phase };
    }
    this.phase = 'paused';
    this.pausedReason = 'restart';
    this.startedAt = data.startedAt || null;
    this.log.info(`fully autonomous mode restored from a restart (was ${previous}); send !autonomous on to continue`);
    return { ok: true, phase: this.phase, restoredFrom: previous };
  }

  // ------------------------------------------------------------------ internals

  /**
   * Put the action brain behind the operator's stop lock.
   *
   * Two layers, because they fail differently: `brain.hold('owner-stop')` is synchronous and
   * gates every later `mc_step` (even from a turn that is already running), while
   * `stopActionBrain` asks the plugin to actually cancel that turn and close its goal. Without
   * the first, a racing tool call still moves the body; without the second, the model keeps
   * producing turns against a closed goal.
   */
  _lockActionBrain(reason) {
    try {
      if (this.ctx.brain && typeof this.ctx.brain.hold === 'function') {
        this.ctx.brain.hold('owner-stop', reason);
      }
    } catch (err) {
      this.log.debug(`brain hold failed: ${err.message}`);
    }
    if (typeof this.ctx.stopActionBrain === 'function') {
      Promise.resolve(this.ctx.stopActionBrain(reason)).catch((err) =>
        this.log.debug(`action brain stop failed: ${err.message}`)
      );
    }
  }

  _announce(kind, text) {
    const wanted = this.cfg.announce && this.cfg.announce[kind] !== false;
    if (!wanted) return;
    if (typeof this.ctx.reply !== 'function') return;
    Promise.resolve(this.ctx.reply(text, { why: `autonomous-${kind}` })).catch(() => false);
  }
}

module.exports = { AutonomousMode, DEFAULTS, ACTIVE_PHASES, dimensionName };
