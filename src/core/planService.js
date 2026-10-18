'use strict';

/**
 * PlanService - the live entry point for multi-step plans (P1 M3).
 *
 * M1 delivered the plan *record* (`PlanStore`) and the step *executor* (`PlanRunner`) as
 * offline contracts; nothing outside the test suite could submit or start a plan. This
 * service is that missing entry:
 *
 *   - `submit()` validates a draft (shape, duplicate ids, replan guard + budget) and writes
 *     it through `PlanStore`, which stays the single writer of `version`;
 *   - `start()` waits for the body to become free, then runs the unfinished steps through
 *     the existing `PlanRunner` - the body owner is still `TaskSlot`, never a second
 *     executor;
 *   - a `wait_for_player` step parks the plan, and the question is asked through the
 *     existing `ProposalDesk` (one question lifecycle, not a second state machine);
 *   - `resume()` answers a parked plan; `cancel()` stops the running step or fails the
 *     waiting step, so a player `!stop` never leaves a plan "silently running";
 *   - every transition is published on `TaskEvents` (`plan:started`, `plan:step`,
 *     `plan:waiting`, `plan:completed`, `plan:failed`, `plan:cancelled`), so SSE/panel and
 *     the harness turn layer can observe plans without polling private fields.
 *
 * It never calls a model and never touches the body directly. Running state is deliberately
 * not persisted: a restart restores the plan record and any pending question, but it must
 * not replay actions (A17/A29).
 */

const { Budget } = require('../planner/budget');
const { validateReplanDraft } = require('../planner/draftGuard');

const PLAN_ID_MAX = 64;
const DEFAULT_WAIT_IDLE_MS = 30000;
const IDLE_POLL_MS = 200;

class PlanService {
  /**
   * @param {object} deps
   *   plans       PlanStore
   *   runner      PlanRunner
   *   questions   PlanQuestionBridge
   *   events      TaskEvents
   *   proposals   ProposalDesk (optional; used to clear an obsolete question)
   *   log         logger
   *   onChange    called after any plan state change (persistence)
   *   isBodyBusy  () => boolean; wait until false before starting
   *   knownStepTypes optional Set/array of accepted step types
   *   now/sleep   injectable clock
   */
  constructor(deps = {}) {
    this.plans = deps.plans;
    this.runner = deps.runner;
    this.questions = deps.questions;
    this.events = deps.events || null;
    this.proposals = deps.proposals || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.onChange = deps.onChange || (() => {});
    this.isBodyBusy = deps.isBodyBusy || (() => false);
    /** A stopped/paused brain must not start or resume a plan (safety, A08). */
    this.canRun = deps.canRun || (() => true);
    this.knownStepTypes = deps.knownStepTypes ? new Set(deps.knownStepTypes) : null;
    this.now = deps.now || (() => Date.now());
    this.sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.waitIdleMs = deps.waitIdleMs || DEFAULT_WAIT_IDLE_MS;
    /** @type {null|{planId:string, runId:string, startedAt:number, cancelReason:null|string, promise:Promise, result:object|null, terminalPublished:boolean}} */
    this.active = null;
    this.planSeq = 0;
    this.runSeq = 0;
    /** planId -> Budget (replan/retry/search counters) */
    this.budgets = new Map();
    /** @type {Set<(event:object)=>void>} plan event listeners (turn layer) */
    this.listeners = new Set();
    if (!this.plans || typeof this.plans.applyDraft !== 'function') {
      throw new Error('PlanService needs a PlanStore');
    }
    if (!this.runner || typeof this.runner.run !== 'function') {
      throw new Error('PlanService needs a PlanRunner');
    }
    if (!this.questions || typeof this.questions.ask !== 'function') {
      throw new Error('PlanService needs a PlanQuestionBridge');
    }
    /**
     * Wire step observations unless the owner already installed one (Brain passes a
     * closure, because PlanService is constructed after PlanRunner there).
     */
    if (!this.runner.onStep && typeof this.runner === 'object') {
      this.runner.onStep = (event) => this.onStep(event);
    }
  }

  get busy() {
    return !!this.active;
  }

  // ------------------------------------------------------------------ submit

  /**
   * Validate and store a plan draft.
   *
   * A draft for an existing plan must carry the exact `baseVersion`; silently accepting an
   * absent version would let a harness overwrite work it never saw (A31).
   *
   * @returns {{ok:boolean, plan?:object, reason?:string, version?:number, replanned?:boolean}}
   */
  submit(draft, options = {}) {
    if (!draft || typeof draft !== 'object') return { ok: false, reason: 'draft-required' };
    const planId = this._planId(draft.planId);
    if (!planId) return { ok: false, reason: 'planId-required' };
    if (!Array.isArray(draft.steps) || !draft.steps.length) return { ok: false, reason: 'steps-required' };
    if (draft.steps.length > 100) return { ok: false, reason: 'too-many-steps' };

    const current = this.plans.get(planId);
    const replanned = !!current;
    const seen = new Set();
    const steps = [];
    for (let index = 0; index < draft.steps.length; index += 1) {
      const raw = draft.steps[index];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, reason: `step-${index + 1}-invalid` };
      }
      const id = String(raw.id || raw.stepId || `s${index + 1}`).trim();
      if (!id) return { ok: false, reason: `step-${index + 1}-id-required` };
      if (seen.has(id)) return { ok: false, reason: `duplicate-step-id`, stepId: id };
      seen.add(id);
      const waiting = raw.type === 'wait_for_player' || raw.wait === true;
      if (!waiting && !raw.type) return { ok: false, reason: `step-${id}-type-required` };
      if (!waiting && this.knownStepTypes && !this.knownStepTypes.has(raw.type)) {
        return { ok: false, reason: 'unknown-step-type', stepId: id, type: raw.type };
      }
      if (raw.args !== undefined && (raw.args === null || typeof raw.args !== 'object' || Array.isArray(raw.args))) {
        return { ok: false, reason: `step-${id}-args-invalid` };
      }
      let args = raw.args || null;
      /**
       * A harness naturally drafts a walk as `{type:"goto", args:{x,y,z}}` (the command
       * form); GoToTask consumes `position`. Normalize here so the two forms cannot mean
       * "walk to nowhere".
       */
      if (raw.type === 'goto' && args && !args.position) {
        const { x, y, z } = args;
        if ([x, y, z].every((value) => Number.isFinite(Number(value)))) {
          args = { ...args, position: { x: Number(x), y: Number(y), z: Number(z) } };
        }
      }
      const existing = current && current.steps.find((step) => step.id === id);
      /**
       * A draft cannot claim an unfinished step is done; only the executor writes that
       * status. A previously done step must be echoed back as done (draftGuard rejects a
       * reopen), which is the one status the draft is allowed to carry.
       */
      const status = existing && existing.status === 'done' ? raw.status : 'pending';
      steps.push({
        ...raw,
        id,
        status,
        ...(raw.type ? { type: String(raw.type) } : {}),
        ...(args ? { args } : {})
      });
    }

    if (current) {
      const baseVersion = Number(draft.baseVersion);
      if (!Number.isFinite(baseVersion)) {
        return { ok: false, reason: 'base-version-required', expectedVersion: current.version };
      }
      if (baseVersion !== current.version) {
        return { ok: false, reason: 'stale', expectedVersion: current.version };
      }
      const guard = validateReplanDraft({
        current,
        draft: { ...draft, planId, steps },
        budget: this._budget(planId)
      });
      if (!guard.ok) return guard;
    } else if (draft.baseVersion !== undefined && Number(draft.baseVersion) !== 0) {
      /** A draft built against a plan this process does not have is stale, not a new plan. */
      return { ok: false, reason: 'stale', expectedVersion: 0 };
    }

    const written = this.plans.applyDraft({
      planId,
      requestId: draft.requestId || null,
      goal: draft.goal || null,
      constraints: draft.constraints || null,
      baseVersion: current ? current.version : 0,
      steps
    });
    if (!written.ok) return written;
    /** A replan that changes/removes a parked step must not leave the old question live. */
    if (replanned && current.steps.some((step) => step.status === 'waiting')) this._clearQuestion(planId);

    const type = replanned ? 'plan:replanned' : 'plan:accepted';
    this._publish(type, {
      planId,
      version: written.plan.version,
      goal: written.plan.goal,
      requestId: written.plan.requestId,
      steps: written.plan.steps.map((step) => step.id),
      source: options.source || null,
      eventId: `${type}|${planId}|${written.plan.version}`
    });
    this.onChange();
    return {
      ok: true,
      plan: this.get(planId),
      version: written.plan.version,
      replanned,
      budget: this._budget(planId).status()
    };
  }

  // ------------------------------------------------------------------- run

  /**
   * Run the plan's unfinished steps in the background.
   *
   * Returns as soon as the run is accepted; callers observe `get()` / events / `waitFor()`.
   * Refuses while another plan run is active, while the plan is parked on a question, or
   * while the body slot is held by another executor (after a bounded wait).
   */
  start(planId, options = {}) {
    const gate = this._gate();
    if (!gate.ok) return gate;
    const plan = this.plans.get(planId);
    if (!plan) return { ok: false, reason: 'unknown-plan' };
    if (this.active) return { ok: false, reason: 'plan-busy', active: this.active.planId };
    if (this.runner.busy) return { ok: false, reason: 'runner-busy' };
    if (plan.steps.some((step) => step.status === 'waiting')) {
      return { ok: false, reason: 'waiting-for-player', plan: this.get(planId) };
    }

    const run = this._beginRun(planId);
    this._publish('plan:started', {
      planId,
      runId: run.runId,
      version: plan.version,
      requestId: options.requestId || plan.requestId || null,
      eventId: `plan:started|${planId}|${run.runId}`
    });
    run.promise = this._execute(run, () =>
      this.runner.run(planId, { requestId: options.requestId || plan.requestId || null })
    );
    return { ok: true, accepted: true, planId, runId: run.runId, plan: this.get(planId), promise: run.promise };
  }

  /** Answer a parked `wait_for_player` step and continue the plan. */
  resume(planId, answer = true, options = {}) {
    /**
     * A negative answer only fails the waiting step; it must still be possible while the
     * brain is paused/stopped (otherwise an expired question would park the plan forever).
     */
    const negative = answer === false || answer === 'deny';
    if (!negative) {
      const gate = this._gate();
      if (!gate.ok) return gate;
    }
    const plan = this.plans.get(planId);
    if (!plan) return { ok: false, reason: 'unknown-plan' };
    if (this.active) return { ok: false, reason: 'plan-busy', active: this.active.planId };
    if (this.runner.busy) return { ok: false, reason: 'runner-busy' };
    const waiting = plan.steps.find((step) => step.status === 'waiting');
    if (!waiting) return { ok: false, reason: 'nothing-waiting' };

    const run = this._beginRun(planId);
    this._publish('plan:resumed', {
      planId,
      runId: run.runId,
      stepId: waiting.id,
      answer: answer !== false && answer !== 'deny',
      reason: options.reason || null,
      eventId: `plan:resumed|${planId}|${run.runId}`
    });
    run.promise = this._execute(run, () => this.runner.resume(planId, answer));
    return { ok: true, accepted: true, planId, runId: run.runId, plan: this.get(planId), promise: run.promise };
  }

  /**
   * Cancel the active run, or close a parked plan by marking its waiting step cancelled.
   *
   * The running task is cancelled through PlanRunner.cancel (which forwards to the task),
   * so the body stops through the same cooperative path as `!stop`.
   */
  cancel(planId, reason = 'cancelled') {
    const plan = this.plans.get(planId);
    if (!plan) return { ok: false, reason: 'unknown-plan' };

    if (this.active && this.active.planId === planId) {
      if (this.active.cancelReason) return { ok: true, cancelling: true, already: true, planId };
      this.active.cancelReason = reason;
      const forwarded = this.runner.cancel(reason);
      this._clearQuestion(planId);
      this._publishTerminal(this.active, 'plan:cancelled', { reason, phase: 'cancelling' });
      return { ok: true, cancelling: true, forwarded, planId };
    }

    if (this.active) return { ok: false, reason: 'plan-busy', active: this.active.planId };
    const waiting = plan.steps.find((step) => step.status === 'waiting');
    if (waiting) {
      this._clearQuestion(planId);
      this._writeStepStatus(planId, waiting.id, 'cancelled');
      const run = { planId, runId: this._nextRunId(), terminalPublished: false };
      this._publishTerminal(run, 'plan:cancelled', { reason, phase: 'parked' });
      this.onChange();
      return { ok: true, cancelling: true, parked: true, planId };
    }

    return { ok: false, reason: 'not-running', planId };
  }

  /**
   * Cancel the active run and close parked plans (used by `!stop`/emergency stop).
   *
   * Parked plans are closed after the active run settles: starting a second PlanRunner run
   * while one is unwinding would replace the active record and lose the stop.
   */
  async cancelAll(reason = 'cancelled') {
    const outcomes = [];
    let activePromise = null;
    if (this.active) {
      activePromise = this.active.promise;
      outcomes.push(this.cancel(this.active.planId, reason));
    }
    if (activePromise) {
      await Promise.race([activePromise.catch(() => null), this.sleep(3000)]);
    }
    for (const plan of this.plans.list()) {
      if (this.active && this.active.planId === plan.planId) continue;
      if (plan.steps.some((step) => step.status === 'waiting')) {
        outcomes.push(this.cancel(plan.planId, reason));
      }
    }
    return outcomes;
  }

  /** Wait (bounded) until the plan leaves `running`, then return its view. */
  async waitFor(planId, timeoutMs = 10000) {
    const deadline = this.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      const view = this.get(planId);
      if (!view) return null;
      if (!this.active || this.active.planId !== planId) return view;
      if (this.now() >= deadline) return view;
      await this.sleep(50);
    }
  }

  // ------------------------------------------------------------------ read

  get(planId) {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    return this._view(plan);
  }

  list() {
    return this.plans.list().map((plan) => this._view(plan));
  }

  status() {
    const plans = this.list();
    return {
      count: plans.length,
      active: this.active ? { planId: this.active.planId, runId: this.active.runId, startedAt: this.active.startedAt } : null,
      plans: plans.slice(-10),
      budgets: [...this.budgets.entries()].map(([planId, budget]) => ({ planId, ...budget.status() }))
    };
  }

  /** Subscribe to plan lifecycle events. Returns an unsubscribe function. */
  onEvent(handler) {
    if (typeof handler !== 'function') throw new Error('PlanService.onEvent needs a function');
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Persistence: only the budgets are service-owned (plans live in PlanStore). */
  toJSON() {
    return {
      budgets: [...this.budgets.entries()].map(([planId, budget]) => [planId, budget.toJSON()])
    };
  }

  restore(data) {
    if (!data || !Array.isArray(data.budgets)) return false;
    this.budgets.clear();
    for (const entry of data.budgets) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
      const budget = new Budget();
      if (budget.restore(entry[1])) this.budgets.set(entry[0], budget);
    }
    return true;
  }

  /**
   * After a restart: re-ask a question for every plan parked at `waiting`.
   *
   * The plan record is restored by PlanStore and the pending proposal by ProposalDesk; this
   * only fills the gap where a save happened between "step waiting" and "proposal created".
   * It never starts a plan.
   */
  restoreQuestions() {
    const restored = [];
    for (const plan of this.plans.list()) {
      const waiting = plan.steps.find((step) => step.status === 'waiting');
      if (!waiting) continue;
      const asked = this.questions.ask(plan.planId);
      restored.push({ planId: plan.planId, stepId: waiting.id, asked: asked.ok !== false, reason: asked.reason || null });
    }
    return restored;
  }

  /** Called by PlanRunner after one step settles. */
  onStep(event = {}) {
    if (!event.planId || !event.stepId) return;
    const runId = this.active && this.active.planId === event.planId ? this.active.runId : 'restored';
    this._publish('plan:step', {
      planId: event.planId,
      stepId: event.stepId,
      status: event.status || null,
      reason: event.reason || null,
      runId,
      eventId: `plan:step|${event.planId}|${event.stepId}|${event.status}|${runId}`
    });
    this.onChange();
  }

  // --------------------------------------------------------------- internals

  /**
   * A run id only has to be unique across restarts as well: the event ring is persisted,
   * and reusing `run-1` after a restart would make the restored ring drop the new event.
   */
  _nextRunId() {
    return `run-${this.now()}-${++this.runSeq}`;
  }

  _beginRun(planId) {
    const run = {
      planId,
      runId: this._nextRunId(),
      startedAt: this.now(),
      cancelReason: null,
      result: null,
      terminalPublished: false,
      promise: null
    };
    this.active = run;
    return run;
  }

  async _execute(run, call) {
    let result = null;
    try {
      const idle = await this._waitForBody(run);
      if (!idle) {
        result = { ok: false, reason: run.cancelReason || 'body-busy', results: [] };
      } else if (run.cancelReason) {
        result = { ok: false, cancelled: true, reason: run.cancelReason, results: [] };
      } else {
        result = await call();
      }
      run.result = result || null;

      if (run.cancelReason) {
        this._publishTerminal(run, 'plan:cancelled', { reason: run.cancelReason, phase: 'settled' });
      } else if (result && result.waiting) {
        this._publish('plan:waiting', {
          planId: run.planId,
          runId: run.runId,
          stepId: result.waiting.stepId,
          question: result.waiting.question,
          eventId: `plan:waiting|${run.planId}|${run.runId}`
        });
        this._askQuestion(run.planId);
      } else if (result && result.cancelled) {
        this._publishTerminal(run, 'plan:cancelled', { reason: result.reason || 'cancelled', phase: 'settled' });
      } else if (result && result.ok) {
        this._publishTerminal(run, 'plan:completed', { results: result.results || [] });
      } else if (
        result &&
        Array.isArray(result.results) &&
        result.results.some((step) => step.waiting && step.status === 'cancelled')
      ) {
        this._publishTerminal(run, 'plan:rejected', {
          reason: 'player-rejected',
          results: result.results
        });
      } else {
        this._publishTerminal(run, 'plan:failed', {
          reason: (result && result.reason) || 'plan-failed',
          results: (result && result.results) || []
        });
      }
      return result;
    } catch (err) {
      result = { ok: false, reason: `plan-error: ${err.message}`, results: [] };
      run.result = result;
      this._publishTerminal(run, 'plan:failed', { reason: result.reason, error: err.message });
      this.log.warn(`plan ${run.planId} failed: ${err.message}`);
      return result;
    } finally {
      if (this.active === run) this.active = null;
      this.onChange();
    }
  }

  async _waitForBody(run) {
    const waitMs = Number(run.waitIdleMs || this.waitIdleMs);
    const deadline = this.now() + waitMs;
    let busy = false;
    try {
      busy = this.isBodyBusy();
    } catch {
      busy = false;
    }
    while (busy) {
      if (run.cancelReason) return false;
      if (this.now() >= deadline) {
        this.log.warn(`plan ${run.planId}: body still busy after ${waitMs}ms`);
        return false;
      }
      await this.sleep(IDLE_POLL_MS);
      try {
        busy = this.isBodyBusy();
      } catch {
        busy = false;
      }
    }
    return true;
  }

  _askQuestion(planId) {
    try {
      const asked = this.questions.ask(planId);
      if (asked && asked.ok === false && asked.reason !== 'pending') {
        this.log.warn(`plan ${planId} question not asked: ${asked.reason}`);
      }
      return asked;
    } catch (err) {
      this.log.warn(`plan ${planId} question failed: ${err.message}`);
      return null;
    }
  }

  _clearQuestion(planId) {
    const pending = this.proposals && typeof this.proposals.pending === 'function' ? this.proposals.pending() : null;
    const candidate = pending && pending.candidate;
    if (candidate && candidate.type === 'plan_question' && candidate.args && candidate.args.planId === planId) {
      this.proposals.supersede('plan cancelled');
    }
  }

  /** Mark one step without running the plan (parked-plan cancellation). */
  _writeStepStatus(planId, stepId, status) {
    const plan = this.plans.get(planId);
    if (!plan) return null;
    const steps = plan.steps.map((step) => (step.id === stepId ? { ...step, status } : step));
    const written = this.plans.applyDraft({
      planId,
      requestId: plan.requestId,
      goal: plan.goal,
      constraints: plan.constraints,
      baseVersion: plan.version,
      steps
    });
    if (!written.ok) this.log.warn(`plan ${planId} step ${stepId} -> ${status} failed: ${written.reason}`);
    return written;
  }

  _gate() {
    try {
      if (this.canRun() === false) return { ok: false, reason: 'brain-not-running' };
    } catch {
      /* a liveness probe must not block a plan */
    }
    return { ok: true };
  }

  _budget(planId) {
    let budget = this.budgets.get(planId);
    if (!budget) {
      budget = new Budget();
      this.budgets.set(planId, budget);
    }
    return budget;
  }

  _planId(value) {
    const text = String(value || '').trim();
    if (text) return text.length <= PLAN_ID_MAX ? text : null;
    return `plan-${this.now()}-${++this.planSeq}`;
  }

  _view(plan) {
    const active = this.active && this.active.planId === plan.planId ? this.active : null;
    const waiting = plan.steps.find((step) => step.status === 'waiting') || null;
    let state = 'pending';
    if (active) state = 'running';
    else if (waiting) state = 'waiting';
    else if (plan.steps.every((step) => step.status === 'done')) state = 'completed';
    else if (plan.steps.some((step) => step.status === 'cancelled')) state = 'cancelled';
    else if (plan.steps.some((step) => step.status === 'failed')) state = 'failed';
    const budget = this.budgets.get(plan.planId);
    return {
      ...plan,
      state,
      running: !!active,
      runId: active ? active.runId : null,
      waitingStepId: waiting ? waiting.id : null,
      question: waiting ? waiting.question || (waiting.args && waiting.args.question) || null : null,
      budget: budget ? budget.status() : null
    };
  }

  _publish(type, payload) {
    const event = {
      ...payload,
      type,
      at: new Date(this.now()).toISOString(),
      planId: payload.planId
    };
    let stored = event;
    if (this.events && typeof this.events.publish === 'function') {
      stored = this.events.publish(event) || event;
    }
    for (const listener of this.listeners) {
      try {
        listener(stored);
      } catch (err) {
        this.log.debug(`plan event listener failed: ${err.message}`);
      }
    }
    return stored;
  }

  _publishTerminal(run, type, payload) {
    if (run.terminalPublished) return null;
    run.terminalPublished = true;
    return this._publish(type, {
      ...payload,
      planId: run.planId,
      runId: run.runId,
      eventId: `${type}|${run.planId}|${run.runId}`
    });
  }
}

module.exports = { PlanService };
