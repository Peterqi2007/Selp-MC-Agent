'use strict';

/**
 * AutonomousProposalCoordinator - action-brain autonomous task requests.
 *
 * The local rule planner is off (`planner.mode=off`). This coordinator is the *timing and
 * safety* layer around the DeepSeek harness:
 *
 *   idle 5min -> inject a proposal-prep goal -> action brain reads the full client state
 *   and replies with mc_propose(autonomous) -> language brain asks the player
 *   -> accept: inject an execution goal; reject/30s timeout: complete prep, wait 5min again.
 *
 * It never builds or enqueues a task. The action brain executes only through the execution
 * goal, after an explicit player acceptance.
 */

const { reasonText } = require('./curriculum');

const DEFAULT_IDLE_MS = 300000;
const DEFAULT_RESPONSE_MS = 30000;
const DEFAULT_PREP_TIMEOUT_MS = 90000;
const DEFAULT_MAX_GOAL_ROUNDS = 3;
const DEFAULT_EXECUTION_ROUNDS = 6;

class AutonomousProposalCoordinator {
  /**
   * @param {object} deps
   *   brain, bridge, languageBrain, ctx, log
   *   cfg: { enabled, idleMs, responseMs, prepTimeoutMs, maxGoalRounds, executionGoalRounds }
   *   now: () => number
   */
  constructor(deps = {}) {
    this.brain = deps.brain;
    this.bridge = deps.bridge || null;
    this.languageBrain = deps.languageBrain || (deps.ctx && deps.ctx.languageBrain) || null;
    this.curriculum = deps.curriculum || (deps.ctx && deps.ctx.curriculum) || null;
    this.ctx = deps.ctx || (deps.brain && deps.brain.ctx) || {};
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.cfg = deps.cfg || {};
    this.now = deps.now || (() => Date.now());

    this.enabled = this.cfg.enabled !== false;
    this.idleMs = positive(this.cfg.idleMs, DEFAULT_IDLE_MS);
    this.responseMs = positive(this.cfg.responseMs, DEFAULT_RESPONSE_MS);
    this.prepTimeoutMs = positive(this.cfg.prepTimeoutMs, DEFAULT_PREP_TIMEOUT_MS);
    this.maxGoalRounds = positive(this.cfg.maxGoalRounds, DEFAULT_MAX_GOAL_ROUNDS);
    this.executionGoalRounds = positive(this.cfg.executionGoalRounds, DEFAULT_EXECUTION_ROUNDS);

    this.started = false;
    this.unsubscribe = [];
    this._ticking = false;
    this.lastBusyAt = this.now();
    this.lastBlockedReason = 'startup';
    this.lastError = null;
    this.lastResetReason = null;

    /** @type {null|{id:string, revision:number, agentId:string}} */
    this.prepGoal = null;
    this.prepInFlight = false;
    this.awaitingProposal = false;
    this.prepStartedAt = 0;
    /** @type {null|{id:string, revision:number, agentId:string, proposalId:string}} */
    this.executionGoal = null;
    this.lastProposal = null;
    this.announcedProposalId = null;
    this.stats = { prepStarted: 0, proposals: 0, accepted: 0, rejected: 0, expired: 0, errors: 0, expressed: 0, autoAccepted: 0 };
    /**
     * Fully autonomous mode (src/core/autonomousMode.js). Assigned after construction because
     * the mode owns the coordinator's goals, not the other way round. When absent the
     * coordinator behaves exactly as before (5-minute clock, player approval).
     *
     * @type {null|{isActive():boolean, shouldAutoAccept():boolean, effectiveIdleMs(n:number):number,
     *   prepPreamble():string, executionPreamble():string, notePreparation(o:object):void,
     *   noteExecution(o:object):void, noteRound(c:object):void}}
     */
    this.mode = deps.mode || null;
    /** Re-entrancy guard: one auto-accept at a time. */
    this._autoAccepting = false;
  }

  /** The mode, when one is attached (it can be attached after construction). */
  _mode() {
    return this.mode || (this.ctx && this.ctx.autonomous) || null;
  }

  /** 5 minutes when a human approves, a short cooldown when nobody does. */
  effectiveIdleMs() {
    const mode = this._mode();
    if (mode && typeof mode.effectiveIdleMs === 'function') {
      return Math.max(0, Number(mode.effectiveIdleMs(this.idleMs)) || 0);
    }
    return this.idleMs;
  }

  /** True while the fully autonomous mode is driving this coordinator. */
  autonomousActive() {
    const mode = this._mode();
    return !!(mode && typeof mode.isActive === 'function' && mode.isActive());
  }

  start() {
    if (this.started || !this.brain || typeof this.brain.on !== 'function') return;
    this.started = true;
    const on = (event, handler) => {
      const off = this.brain.on(event, (payload) => {
        Promise.resolve(handler(payload)).catch((err) => {
          this.stats.errors += 1;
          this.log.warn(`autonomous proposal ${event} handler failed: ${err.message}`);
        });
      });
      if (typeof off === 'function') this.unsubscribe.push(off);
    };
    on('proposal:new', (proposal) => this._onProposalNew(proposal));
    on('proposal:accepted', () => this._onProposalSettled('accepted'));
    on('proposal:rejected', () => this._onProposalSettled('rejected'));
    on('proposal:expired', () => this._onProposalSettled('expired'));
    on('proposal:superseded', () => this._onProposalSettled('superseded'));
  }

  stop() {
    for (const off of this.unsubscribe.splice(0)) {
      try {
        off();
      } catch {
        /* already detached */
      }
    }
    this.started = false;
  }

  /** Called by Brain.slowLoop every ~2.5s. Async, single-flight. */
  async tick() {
    if (!this.enabled || !this.bridge || !this.brain) return { ok: false, reason: 'disabled' };
    if (this._ticking) return { ok: false, reason: 'busy' };
    this._ticking = true;
    const at = this.now();
    try {
      /** Close the loop on an accepted proposal: the execution goal's end feeds the curriculum. */
      if (this.executionGoal) await this._tickExecution();
      if (this.prepInFlight) {
        return await this._tickPrep(at);
      }
      const pending = this.brain.proposals && typeof this.brain.proposals.pending === 'function'
        ? this.brain.proposals.pending()
        : null;
      if (pending) {
        this.lastBusyAt = at;
        this.lastBlockedReason = `proposal:${pending.id}`;
        return { ok: true, reason: 'proposal-pending', proposalId: pending.id };
      }
      const blocked = await this.blockedReason();
      if (blocked) {
        this.lastBusyAt = at;
        this.lastBlockedReason = blocked;
        return { ok: true, reason: blocked };
      }
      if (at - this.lastBusyAt < this.effectiveIdleMs()) {
        return { ok: true, reason: 'idle-wait', remainingMs: this.effectiveIdleMs() - (at - this.lastBusyAt) };
      }
      return await this.startPrep();
    } catch (err) {
      this.stats.errors += 1;
      this.lastError = err.message;
      this.lastBusyAt = at;
      this.log.warn(`autonomous proposal tick failed: ${err.message}`);
      return { ok: false, reason: 'error', error: err.message };
    } finally {
      this._ticking = false;
    }
  }

  async _tickPrep(at) {
    const pending = this.brain.proposals && typeof this.brain.proposals.pending === 'function'
      ? this.brain.proposals.pending()
      : null;
    if (pending) {
      this.lastBusyAt = at;
      this.lastBlockedReason = `proposal:${pending.id}`;
      return { ok: true, reason: 'proposal-pending', proposalId: pending.id };
    }
    if (!this.awaitingProposal) {
      /* A settled proposal should have cleaned this up; recover instead of wedging. */
      this._clearPrep();
      this.lastBusyAt = at;
      return { ok: true, reason: 'prep-recovered' };
    }
    if (at - this.prepStartedAt >= this.prepTimeoutMs) {
      await this.completePrep('prep-timeout');
      this._notePreparation(false);
      this.resetTimer('prep-timeout');
      return { ok: true, reason: 'prep-timeout' };
    }
    const agentId = await this._agentId();
    const goal = agentId ? await this.bridge.goalOf(agentId) : null;
    /**
     * The harness may pause a goal on its own (a host-side brake, e.g. an interrupted round).
     * Treating that as "the action brain finished" ended the round and left the mode sitting
     * on `goal:paused` forever. Resume it a couple of times per prep before giving up; a
     * deliberate operator pause arrives as `!stop`, which completes the goal instead.
     */
    if (goal && goal.phase === 'paused' && (this.prepResumes || 0) < 2) {
      this.prepResumes = (this.prepResumes || 0) + 1;
      try {
        await this.bridge.resumeGoal({ agentId, goalId: goal.id, revision: goal.revision });
        this.log.info(`resumed paused prep goal ${goal.id} (${this.prepResumes}/2)`);
        return { ok: true, reason: 'prep-resumed' };
      } catch (err) {
        this.log.debug(`resuming paused prep goal failed: ${err.message}`);
      }
    }
    if (goal && goal.phase === 'paused') {
      /**
       * The harness keeps pausing the round (it pauses a goal when the queued goal-round
       * message is discarded before the agent goes idle). Resuming twice did not stick, so
       * end this round and try a fresh goal on the next tick - and if that keeps happening,
       * pause the mode with an honest reason instead of spinning.
       */
      await this.completePrep('goal-paused');
      this.prepPauses = (this.prepPauses || 0) + 1;
      this.resetTimer('goal-paused');
      if (this.prepPauses >= 3 && this.mode && typeof this.mode.pause === 'function') {
        this.log.warn(`autonomous prep goals keep being paused by the harness (${this.prepPauses}x); pausing the mode`);
        this.mode.pause('prep-goals-paused');
        return { ok: true, reason: 'prep-paused' };
      }
      this._notePreparation(false);
      return { ok: true, reason: 'prep-paused' };
    }
    if (!goal || goal.phase !== 'active') {
      /**
       * The action brain completed/blocked the prep goal without proposing. No consent, no
       * execution: end the round and restart the 5-minute idle timer.
       */
      await this.completePrep('goal-ended-without-proposal');
      this._notePreparation(false);
      this.resetTimer('goal-ended-without-proposal');
      return { ok: true, reason: 'prep-ended-without-proposal' };
    }
    return { ok: true, reason: 'awaiting-proposal' };
  }

  /**
   * Poll the execution goal created for an accepted proposal and write its outcome into the
   * curriculum. This is the only place the autonomous path learns whether the task worked:
   * the action brain executes via mc_step (no Node TaskHub event), so the durable goal's
   * phase is the evidence.
   */
  async _tickExecution() {
    const tracked = this.executionGoal;
    if (!tracked || !tracked.agentId) return null;
    let goal = null;
    try {
      goal = await this.bridge.goalOf(tracked.agentId);
    } catch (err) {
      this.log.debug(`execution goal poll failed: ${err.message}`);
      return null;
    }
    if (!goal) {
      /** Goal was cleared by a restart/operator: stop tracking, no invented outcome. */
      this.executionGoal = null;
      return { ok: true, reason: 'goal-gone' };
    }
    const phase = String(goal.phase || '').toLowerCase();
    if (phase !== 'complete' && phase !== 'blocked') return { ok: true, reason: `phase:${phase}` };
    const candidate = tracked.candidate || {};
    if (this.curriculum) {
      if (phase === 'complete') {
        this.curriculum.recordCompleted({
          name: candidate.name || candidate.type,
          type: candidate.type,
          difficulty: candidate.difficulty,
          source: 'autonomous'
        });
        this.stats.completed = (this.stats.completed || 0) + 1;
      } else {
        this.curriculum.recordFailed({
          name: candidate.name || candidate.type,
          type: candidate.type,
          difficulty: candidate.difficulty,
          /**
           * The host's `blockedReason` is an object on a real DSH goal; the ledger column is
           * text and `describe()` feeds it back to the model, so it must be flattened here
           * too (the ledger normalizes as well - both sides share one rule).
           */
          reason: reasonText(goal.blockedReason) || 'blocked',
          source: 'autonomous'
        });
      }
    }
    /** Log the enforced band too - a settle that eased it is exactly what you grep for later. */
    let band = '';
    if (this.curriculum) {
      const penalty = this.curriculum.bandPenalty();
      band = penalty > 0
        ? ` (curriculum band ${this.curriculum.requiredDifficulty}, earned ${this.curriculum.level()},`
          + ` eased after ${this.curriculum.consecutiveFailures} failures)`
        : ` (curriculum level ${this.curriculum.level()})`;
    }
    this.log.info(`autonomous execution ${tracked.id} ${phase}: ${candidate.name || candidate.type}${band}`);
    this.executionGoal = null;
    /** The mode counts completions/blocks and pauses itself on a failure streak. */
    const mode = this._mode();
    if (mode && typeof mode.noteExecution === 'function') mode.noteExecution({ phase, candidate });
    return { ok: true, reason: `execution-${phase}` };
  }

  /** Tell the mode a prep round ended without a proposal (its failure guard). */
  _notePreparation(hadProposal) {
    const mode = this._mode();
    if (mode && typeof mode.notePreparation === 'function') mode.notePreparation({ hadProposal });
  }

  /**
   * Why a new autonomous proposal must not start now.
   * @returns {Promise<string|null>} reason or null when idle
   */
  async blockedReason() {
    const brain = this.brain;
    if (!brain.attached) return 'body-not-attached';
    if (brain.paused) return 'paused';
    if (brain.stopped) return 'stopped';
    if (brain.autoPlanDisabled) return 'auto-plan-disabled';
    if (brain.safeMode) return 'safe-mode';
    if (brain.activeTask || brain.currentTask) return 'active-task';
    if (brain.queue && brain.queue.length) return 'queued-task';
    if (brain.slot && brain.slot.busy) return 'task-slot-busy';
    if (brain.holds && typeof brain.holds.list === 'function' && brain.holds.list().length) return 'holds';
    const plans = brain.planService && typeof brain.planService.status === 'function'
      ? brain.planService.status()
      : null;
    if (plans) {
      if (plans.active) return 'plan-running';
      /**
       * Only a plan that is actually running or parked on a player question blocks the
       * body. A stale `pending` plan (restored from an older session, or submitted with
       * start:false) never owns the body; counting it reset the 5-minute idle clock forever
       * on this machine's old A29 fixture.
       */
      if (
        Array.isArray(plans.plans) &&
        plans.plans.some((plan) => plan.state === 'running' || plan.state === 'waiting')
      ) {
        return 'plan-active';
      }
    }
    const pending = brain.proposals && typeof brain.proposals.pending === 'function' ? brain.proposals.pending() : null;
    if (pending) return `proposal:${pending.id}`;
    if (this.prepInFlight) return 'prep-in-flight';

    const agentId = await this._agentId();
    if (!agentId) return 'no-live-action-brain';
    const health = typeof this.bridge.health === 'function' ? await this.bridge.health() : null;
    if (health) {
      if (!health.ok) return 'harness-down';
      if (health.busy) return 'harness-busy';
      if (Array.isArray(health.turns) && health.turns.length) return 'harness-turn-active';
    }
    const goal = await this.bridge.goalOf(agentId);
    /**
     * A leftover paused goal blocks every future prep (`goal:paused`). Ask the plugin to close
     * it (it clears a paused goal when `complete` refuses). If it survives three attempts the
     * harness itself is stuck; pause the mode with a reason instead of looking busy forever.
     */
    if (goal && goal.phase === 'paused') {
      this.goalPauseClears = (this.goalPauseClears || 0) + 1;
      try {
        await this.bridge.completeGoal({ agentId, goalId: goal.id, revision: goal.revision });
      } catch (err) {
        this.log.debug(`clearing paused goal failed: ${err.message}`);
      }
      let after = null;
      try {
        after = await this.bridge.goalOf(agentId);
      } catch (err) {
        after = null;
      }
      if (!after || after.phase !== 'paused') {
        this.goalPauseClears = 0;
        this.lastBlockedReason = 'goal-paused-cleared';
        this.lastBusyAt = this.now();
        return 'goal-paused-cleared';
      }
      if (this.goalPauseClears >= 3 && this.mode && typeof this.mode.pause === 'function') {
        this.log.warn('the harness goal stays paused; pausing the autonomous mode (goal-stuck)');
        this.mode.pause('goal-stuck');
      }
      return `goal:${goal.phase}`;
    }
    if (goal && goal.phase !== 'complete') return `goal:${goal.phase || 'active'}`;
    return null;
  }

  async startPrep() {
    const at = this.now();
    const agentId = await this._agentId();
    if (!agentId) {
      this.lastError = 'no-live-action-brain';
      this.lastBusyAt = at;
      return { ok: false, reason: 'no-live-action-brain' };
    }
    if (typeof this.bridge.createGoal !== 'function') {
      this.lastError = 'goal-client-unavailable';
      this.lastBusyAt = at;
      return { ok: false, reason: 'goal-client-unavailable' };
    }
    this.prepInFlight = true;
    this.awaitingProposal = true;
    this.prepStartedAt = at;
    this.prepGoal = null;
    this.stats.prepStarted += 1;
    /**
     * Do NOT reset the "harness keeps pausing preps" streak here: a fresh goal is exactly
     * what gets paused, so resetting on start made the counter unable to ever reach 3. It is
     * reset when a proposal is actually accepted (see accept()).
     */
    if (this.curriculum && typeof this.curriculum.resetRejections === 'function') {
      this.curriculum.resetRejections();
    }
    const baseGoal =
      'Autonomous task proposal request: read the full client state and propose one useful next task. ' +
      'Do not execute anything; the player must approve first.';
    const curriculumContext =
      this.curriculum && typeof this.curriculum.describe === 'function' ? this.curriculum.describe() : '';
    /**
     * Fully autonomous mode replaces "the player must approve first" with "you will be
     * approved automatically". The preamble comes from the mode so the promise (and the ban
     * on asking the player) has exactly one owner.
     */
    const mode = this._mode();
    const preamble = mode && typeof mode.prepPreamble === 'function' ? mode.prepPreamble() : '';
    const sections = [preamble, preamble ? null : baseGoal, curriculumContext].filter(Boolean);
    const goalText = sections.join('\n\n');
    const res = await this.bridge.createGoal({
      agentId,
      goal: goalText,
      purpose: 'proposal',
      maxGoalRounds: this.maxGoalRounds,
      replace: false
    });
    if (!res || res.ok !== true || !res.goal || !res.goal.id) {
      this.stats.errors += 1;
      this.lastError = (res && (res.reason || res.error || res.message)) || 'goal-create-failed';
      this._clearPrep();
      this.lastBusyAt = at;
      this.log.warn(`autonomous proposal prep not started: ${this.lastError}`);
      return { ok: false, reason: this.lastError };
    }
    this.prepGoal = {
      id: res.goal.id,
      revision: Number.isFinite(Number(res.goal.revision)) ? Number(res.goal.revision) : 1,
      agentId: res.agentId || agentId
    };
    this.lastBusyAt = at;
    this.lastError = null;
    this.log.info(`autonomous proposal prep goal injected: ${this.prepGoal.id}`);
    return { ok: true, reason: 'prep-started', goalId: this.prepGoal.id };
  }

  /**
   * Accept an autonomous proposal and inject its execution goal.
   *
   * @param {object|null} proposal pending proposal (defaults to the desk's current one)
   * @param {{by?:'player'|'autonomous'}} [options] who approved it (recorded on the desk)
   */
  async accept(proposal, options = {}) {
    const pending = proposal || (this.brain.proposals && this.brain.proposals.pending());
    if (!pending || !pending.candidate || pending.candidate.autonomous !== true) {
      return { ok: false, reason: 'not-autonomous-proposal' };
    }
    const by = options.by === 'autonomous' ? 'autonomous' : 'player';
    const at = this.now();
    if (Number.isFinite(Number(pending.expiresAt)) && at >= pending.expiresAt) {
      try {
        this.brain.proposals.sweep(at);
      } catch {
        /* already settled */
      }
      await this.completePrep('expired');
      this.resetTimer('expired');
      return { ok: false, reason: 'expired', proposalId: pending.id };
    }
    const agentId = await this._agentId();
    if (!agentId) return { ok: false, reason: 'no-live-action-brain', proposalId: pending.id };
    const candidate = pending.candidate;
    const mode = this._mode();
    const preamble = mode && typeof mode.executionPreamble === 'function' ? mode.executionPreamble() : '';
    const body =
      `Execute the approved autonomous task: ${candidate.name || candidate.type}. ` +
      (by === 'autonomous'
        ? 'It was auto-approved by fully autonomous mode; carry it out and report the real result.'
        : 'The player accepted the proposal; carry it out and report the real result.') +
      (candidate.commandType
        ? ' This is a local command-table action; translate type+args into one mc_step command if needed.'
        : '');
    const created = await this.bridge.createGoal({
      agentId,
      goal: preamble ? `${preamble}\n\n${body}` : body,
      purpose: 'execute',
      proposal: {
        type: candidate.type,
        name: candidate.name,
        args: candidate.args || {},
        reason: candidate.reason || '',
        commandType: candidate.commandType === true
      },
      maxGoalRounds: this.executionGoalRounds,
      replace: true
    });
    if (!created || created.ok !== true || !created.goal || !created.goal.id) {
      this.stats.errors += 1;
      this.lastError = (created && (created.reason || created.error || created.message)) || 'execution-goal-failed';
      return {
        ok: false,
        reason: 'action-brain-unavailable',
        detail: this.lastError,
        proposalId: pending.id
      };
    }
    const accepted = this.brain.proposals.accept(pending.id, { by });
    if (!accepted.ok) {
      /* The window closed between the expiry check and the desk accept: undo the goal. */
      await this.bridge
        .completeGoal({ agentId, goalId: created.goal.id, revision: created.goal.revision })
        .catch(() => null);
      return { ...accepted, proposalId: pending.id };
    }
    this.executionGoal = {
      id: created.goal.id,
      revision: Number.isFinite(Number(created.goal.revision)) ? Number(created.goal.revision) : 1,
      agentId: created.agentId || agentId,
      proposalId: pending.id,
      /** The curriculum needs the same candidate when the goal settles. */
      candidate: {
        type: candidate.type,
        name: candidate.name || candidate.type,
        args: candidate.args || {},
        difficulty:
          Number.isFinite(Number(candidate.difficulty))
            ? Number(candidate.difficulty)
            : this.curriculum
              ? this.curriculum.difficultyOf(candidate)
              : null
      }
    };
    this.stats.accepted += 1;
    if (by === 'autonomous') this.stats.autoAccepted = (this.stats.autoAccepted || 0) + 1;
    /** A round produced a proposal: the harness is admitting rounds again. */
    this.prepPauses = 0;
    this._clearPrep();
    this.lastBusyAt = at;
    this.lastProposal = pending;
    if (by === 'autonomous' && mode && typeof mode.noteRound === 'function') {
      mode.noteRound(this.executionGoal.candidate);
    }
    this.log.info(`autonomous proposal ${pending.id} accepted (${by}); execution goal ${this.executionGoal.id}`);
    return {
      ...accepted,
      goalInjected: true,
      goalId: this.executionGoal.id,
      agentId: this.executionGoal.agentId,
      proposalId: pending.id
    };
  }

  /**
   * Close the prep and execution goals and forget them.
   *
   * `!stop`, a death and `!autonomous off` all need this: a durable goal left "active" on the
   * action brain keeps the model working (and calling `mc_step`) even though Node said stop.
   * Best effort by design - a dead harness must not make the stop itself fail.
   */
  async abortGoals(reason = 'aborted') {
    const goals = [];
    if (this.prepGoal) goals.push(this.prepGoal);
    if (this.executionGoal) goals.push(this.executionGoal);
    this._clearPrep();
    const execution = this.executionGoal;
    this.executionGoal = null;
    const agentId = (execution && execution.agentId) || (await this._agentId());
    const closed = [];
    for (const goal of goals) {
      if (!goal || !goal.id || !agentId) continue;
      try {
        await this.bridge.completeGoal({ agentId, goalId: goal.id, revision: goal.revision });
        closed.push(goal.id);
      } catch (err) {
        this.log.debug(`abort goal ${goal.id} failed (${reason}): ${err.message}`);
      }
    }
    if (closed.length) this.log.info(`autonomous goals closed (${reason}): ${closed.join(', ')}`);
    this.lastBusyAt = this.now();
    this.lastBlockedReason = `aborted:${reason}`;
    return { ok: true, reason, closed };
  }

  /** End the prep goal (timeout/reject/expiry/accept). Never touches the body. */
  async completePrep(reason = 'prep-ended') {
    const goal = this.prepGoal;
    const agentId = (goal && goal.agentId) || (await this._agentId());
    this._clearPrep();
    if (!goal || !agentId) return { ok: true, reason: 'no-prep-goal' };
    try {
      const result = await this.bridge.completeGoal({
        agentId,
        goalId: goal.id,
        revision: goal.revision
      });
      this.log.info(`proposal prep goal ${goal.id} closed (${reason})`);
      return result;
    } catch (err) {
      this.log.debug(`proposal prep goal close failed (${reason}): ${err.message}`);
      return { ok: false, reason: err.message };
    }
  }

  resetTimer(reason = 'reset') {
    this.lastBusyAt = this.now();
    this.lastResetReason = reason;
    this.lastBlockedReason = reason;
  }

  async status() {
    const pending = this.brain && this.brain.proposals && typeof this.brain.proposals.pending === 'function'
      ? this.brain.proposals.pending()
      : null;
    return {
      enabled: this.enabled,
      idleMs: this.idleMs,
      effectiveIdleMs: this.effectiveIdleMs(),
      autoAccept: this.autonomousActive(),
      responseMs: this.responseMs,
      prepTimeoutMs: this.prepTimeoutMs,
      lastBusyAt: this.lastBusyAt,
      idleForMs: Math.max(0, this.now() - this.lastBusyAt),
      lastBlockedReason: this.lastBlockedReason,
      lastResetReason: this.lastResetReason,
      lastError: this.lastError,
      prepInFlight: this.prepInFlight,
      awaitingProposal: this.awaitingProposal,
      prepGoal: this.prepGoal,
      executionGoal: this.executionGoal,
      pendingProposal: pending
        ? {
            id: pending.id,
            autonomous: !!(pending.candidate && pending.candidate.autonomous),
            target: pending.target,
            expiresAt: pending.expiresAt
          }
        : null,
      stats: { ...this.stats }
    };
  }

  /** Synchronous subset for the panel; never calls the harness. */
  snapshot() {
    const pending = this.brain && this.brain.proposals && typeof this.brain.proposals.pending === 'function'
      ? this.brain.proposals.pending()
      : null;
    return {
      enabled: this.enabled,
      idleMs: this.idleMs,
      effectiveIdleMs: this.effectiveIdleMs(),
      autoAccept: this.autonomousActive(),
      responseMs: this.responseMs,
      idleForMs: Math.max(0, this.now() - this.lastBusyAt),
      lastBlockedReason: this.lastBlockedReason,
      lastResetReason: this.lastResetReason,
      lastError: this.lastError,
      prepInFlight: this.prepInFlight,
      awaitingProposal: this.awaitingProposal,
      prepGoalId: this.prepGoal ? this.prepGoal.id : null,
      executionGoalId: this.executionGoal ? this.executionGoal.id : null,
      pendingProposalId: pending ? pending.id : null,
      pendingAutonomous: !!(pending && pending.candidate && pending.candidate.autonomous === true),
      stats: { ...this.stats }
    };
  }

  // ------------------------------------------------------------------ events

  async _onProposalNew(proposal) {
    const pending = this.brain.proposals && typeof this.brain.proposals.pending === 'function'
      ? this.brain.proposals.pending()
      : null;
    if (!pending || !pending.candidate || pending.candidate.autonomous !== true) return;
    this.awaitingProposal = false;
    this.lastBusyAt = this.now();
    this.lastBlockedReason = `proposal:${pending.id}`;
    this.lastProposal = pending;
    this.stats.proposals += 1;
    this._notePreparation(true);

    /**
     * Fully autonomous mode: nobody is asked, so the proposal is accepted as soon as it
     * exists. Any failure to inject the execution goal is settled by rejecting the proposal
     * immediately - leaving it pending for 30 seconds would look like a stalled round.
     */
    const mode = this._mode();
    if (mode && typeof mode.shouldAutoAccept === 'function' && mode.shouldAutoAccept()) {
      if (this._autoAccepting) return;
      this._autoAccepting = true;
      try {
        const result = await this.accept(pending, { by: 'autonomous' });
        if (!result.ok) {
          this.log.warn(`autonomous auto-accept failed (${result.reason}); rejecting the proposal`);
          try {
            this.brain.proposals.reject(pending.id, { by: 'autonomous' });
          } catch {
            /* already settled */
          }
        }
      } finally {
        this._autoAccepting = false;
      }
      return;
    }

    if (this.announcedProposalId === pending.id) return;
    this.announcedProposalId = pending.id;
    await this._express(pending);
  }

  async _express(proposal) {
    const fallback = () =>
      `我有个提议：${String(proposal.reason || (proposal.candidate && (proposal.candidate.name || proposal.candidate.type)) || '任务')}。` +
      '要我去做吗？回复 !proposal accept 或 !proposal reject，30 秒内有效。';
    try {
      if (this.languageBrain && typeof this.languageBrain.expressProposal === 'function') {
        const result = await this.languageBrain.expressProposal(proposal);
        if (result && result.ok && result.said) {
          this.stats.expressed += 1;
          return result;
        }
        this.log.warn(`proposal expression failed or silent: ${(result && result.reason) || 'no said line'}`);
      }
    } catch (err) {
      this.log.warn(`proposal expression threw: ${err.message}`);
    }
    if (typeof this.ctx.reply === 'function') {
      try {
        const said = fallback();
        await this.ctx.reply(said, { why: 'autonomous-proposal', force: true });
        this.stats.expressed += 1;
        return { ok: true, via: 'template', said };
      } catch (err) {
        this.log.warn(`proposal template reply failed: ${err.message}`);
      }
    }
    return { ok: false, via: 'none', reason: 'no-speech-path' };
  }

  async _onProposalSettled(kind) {
    const at = this.now();
    this.lastBusyAt = at;
    this.lastBlockedReason = `proposal-${kind}`;
    this.awaitingProposal = false;
    if (kind === 'accepted') {
      this._clearPrep();
      return;
    }
    if (kind === 'rejected') this.stats.rejected += 1;
    if (kind === 'expired') this.stats.expired += 1;
    await this.completePrep(kind);
    this.resetTimer(kind);
    this.log.info(`autonomous proposal ${kind}; next prep no earlier than ${this.idleMs}ms`);
  }

  _clearPrep() {
    this.prepInFlight = false;
    this.awaitingProposal = false;
    this.prepGoal = null;
    this.prepStartedAt = 0;
    /** Give up resuming a harness-paused prep goal after two tries (see _tickPrep). */
    this.prepResumes = 0;
  }

  async _agentId() {
    if (!this.bridge) return null;
    try {
      if (typeof this.bridge.boundAgentId === 'function') return await this.bridge.boundAgentId();
      return this.bridge.agentId || null;
    } catch {
      return null;
    }
  }
}

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

module.exports = { AutonomousProposalCoordinator };
