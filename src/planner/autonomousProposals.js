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
    this.stats = { prepStarted: 0, proposals: 0, accepted: 0, rejected: 0, expired: 0, errors: 0, expressed: 0 };
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
      if (at - this.lastBusyAt < this.idleMs) {
        return { ok: true, reason: 'idle-wait', remainingMs: this.idleMs - (at - this.lastBusyAt) };
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
      this.resetTimer('prep-timeout');
      return { ok: true, reason: 'prep-timeout' };
    }
    const agentId = await this._agentId();
    const goal = agentId ? await this.bridge.goalOf(agentId) : null;
    if (!goal || goal.phase !== 'active') {
      /**
       * The action brain completed/blocked the prep goal without proposing. No consent, no
       * execution: end the round and restart the 5-minute idle timer.
       */
      await this.completePrep('goal-ended-without-proposal');
      this.resetTimer('goal-ended-without-proposal');
      return { ok: true, reason: 'prep-ended-without-proposal' };
    }
    return { ok: true, reason: 'awaiting-proposal' };
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
    const goalText =
      'Autonomous task proposal request: read the full client state and propose one useful next task. ' +
      'Do not execute anything; the player must approve first.';
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

  /** Explicit accept from !proposal / chat / panel. Injects the execution goal first. */
  async accept(proposal) {
    const pending = proposal || (this.brain.proposals && this.brain.proposals.pending());
    if (!pending || !pending.candidate || pending.candidate.autonomous !== true) {
      return { ok: false, reason: 'not-autonomous-proposal' };
    }
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
    const created = await this.bridge.createGoal({
      agentId,
      goal:
        `Execute the approved autonomous task: ${candidate.name || candidate.type}. ` +
        'The player accepted the proposal; carry it out and report the real result.',
      purpose: 'execute',
      proposal: {
        type: candidate.type,
        name: candidate.name,
        args: candidate.args || {},
        reason: candidate.reason || ''
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
    const accepted = this.brain.proposals.accept(pending.id, { by: 'player' });
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
      proposalId: pending.id
    };
    this.stats.accepted += 1;
    this._clearPrep();
    this.lastBusyAt = at;
    this.lastProposal = pending;
    this.log.info(`autonomous proposal ${pending.id} accepted; execution goal ${this.executionGoal.id}`);
    return {
      ...accepted,
      goalInjected: true,
      goalId: this.executionGoal.id,
      agentId: this.executionGoal.agentId,
      proposalId: pending.id
    };
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
        if (result && result.ok) {
          this.stats.expressed += 1;
          return result;
        }
        this.log.warn(`proposal expression failed: ${(result && result.reason) || 'unknown'}`);
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
