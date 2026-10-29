'use strict';

/**
 * PlanRunner - executes a plan's steps through the single body executor (P1 §1.4.2 #2).
 *
 * The rule the plan is explicit about: a parent plan keeps its own logical state, and its
 * steps go through an **internal** execution path. They must NOT be submitted to TaskHub
 * one by one, because that would replace the parent task (the hub owns one job at a time)
 * and lose everything the parent had already done.
 *
 * So:
 *   - plan state lives in `PlanStore`; every finished step is written back with the version
 *     it was built from (a concurrent replan therefore cannot be silently overwritten);
 *   - each step is one task through the injected executor (`brain.runTask` -> `TaskSlot`),
 *     which keeps the body ownership rule intact;
 *   - `cancel()` is honoured between steps and forwarded to the running step, so a stop
 *     does not wait for the whole plan;
 *   - already-`done` steps are skipped, which is what makes a resumed plan cheap;
 *   - a `wait_for_player` step parks the plan (`status: 'waiting'`) and returns the
 *     question; `resume(planId, answer)` continues it. A false answer fails that step and
 *     stops the plan - it is never treated as consent.
 *
 * This is the offline contract; wiring a real planner/harness to it is M3.
 */

const { verifyStep, hasConditions } = require('../planner/verifier');
const { normalizeResult } = require('../tasks/task');

class PlanRunner {
  /**
   * @param {object} deps { plans, createTask(step, ids), runTask(task), log }
   */
  constructor(deps = {}) {
    this.plans = deps.plans;
    this.createTask = deps.createTask;
    this.runTask = deps.runTask;
    this.verify = deps.verify || verifyStep;
    this.observe = deps.observe || null;
    this.sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    /**
     * A body can report the task done before its snapshot reflects the last inventory
     * change (live A13-6 2026-10-19: craft said 4 sticks, postcondition still saw 8, the
     * next `/state` already had 12). Give a failed *postcondition* a short bounded settle
     * window; a genuine failure still fails after the last observation.
     */
    this.postconditionRetryMs = Number.isFinite(deps.postconditionRetryMs) ? deps.postconditionRetryMs : 0;
    this.postconditionRetryAttempts = Number.isFinite(deps.postconditionRetryAttempts)
      ? Math.max(0, deps.postconditionRetryAttempts)
      : 1;
    this.recordMethod = deps.recordMethod || null;
    /** Called after every step settlement; PlanService turns it into a `plan:step` event. */
    this.onStep = deps.onStep || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    if (!this.plans || typeof this.plans.applyDraft !== 'function') {
      throw new Error('PlanRunner needs a PlanStore');
    }
    if (typeof this.createTask !== 'function' || typeof this.runTask !== 'function') {
      throw new Error('PlanRunner needs createTask() and runTask()');
    }
    this.active = null;
    this.currentTask = null;
  }

  get busy() {
    return !!this.active;
  }

  /**
   * Run the plan's unfinished steps in order.
   *
   * @param {string} planId
   * @param {object} [options] { requestId }
   * @returns {Promise<{ok:boolean, results:Array, cancelled?:boolean, reason?:string}>}
   */
  async run(planId, options = {}) {
    const stored = this.plans.get(planId);
    if (!stored) return { ok: false, reason: 'unknown-plan', results: [] };
    if (this.active) return { ok: false, reason: 'busy', results: [] };

    this.active = { planId, cancelled: false, reason: null };
    const results = [];
    try {
      for (const step of stored.steps) {
        if (this.active.cancelled) break;
        if (step.status === 'done') {
          results.push({ stepId: step.id, status: 'succeeded', skipped: true });
          continue;
        }
        /**
         * A question step does not create a task. Without an answer, the plan parks and the
         * caller gets the question; `resume()` re-enters `run()` with the answer.
         */
        if (step.type === 'wait_for_player' || step.wait === true) {
          const answer = options.answers ? options.answers[step.id] : undefined;
          if (answer === undefined) {
            this._writeStep(planId, step.id, 'waiting');
            this._noteStep(planId, step.id, 'waiting', 'waiting-for-player');
            return {
              ok: false,
              waiting: {
                planId,
                stepId: step.id,
                question: step.question || (step.args && step.args.question) || null
              },
              results
            };
          }
          const accepted = answer !== false && answer !== 'deny';
          results.push({ stepId: step.id, status: accepted ? 'succeeded' : 'cancelled', waiting: true });
          this._writeStep(planId, step.id, accepted ? 'done' : 'failed');
          this._noteStep(planId, step.id, accepted ? 'succeeded' : 'failed', accepted ? null : 'player-rejected');
          if (!accepted) break;
          continue;
        }
        // An unfinished partial attempt is not replayed with its original quantity.
        // The caller must replan the remaining work, or supply fresh goal evidence.
        if (step.status === 'partial') {
          const verification = await this._verify(step, 'postcondition');
          if (this.active.cancelled) break;
          if (verification.ok === true && hasConditions(step.postconditions)) {
            const settlement = {
              ...(step.result || {}), status: 'succeeded', reason: 'postcondition-satisfied',
              verification, remaining: null
            };
            results.push({ stepId: step.id, ...settlement });
            this._writeStep(planId, step.id, 'done', settlement);
            this._noteStep(planId, step.id, 'succeeded', settlement.reason, settlement);
            continue;
          }
          const settlement = {
            ...(step.result || {}), status: 'partial', reason: 'partial-needs-replan', verification,
            remaining: this._remaining((step.result && step.result.taskResult) || {}, verification)
              || (step.result && step.result.remaining) || null
          };
          results.push({ stepId: step.id, ...settlement });
          this._writeStep(planId, step.id, 'partial', settlement);
          this._noteStep(planId, step.id, 'partial', settlement.reason, settlement);
          break;
        }

        // Validate prerequisites against the BEFORE observation, before even creating
        // a task. They may be consumed by a successful action and must not be rechecked.
        if (step.preconditions && Object.keys(step.preconditions).length) {
          const verification = await this._verify(step, 'precondition');
          if (this.active.cancelled) break;
          if (verification.ok !== true) {
            const reason = this._verificationReason('precondition', verification);
            const settlement = { status: 'failed', reason, executed: false, verification };
            results.push({ stepId: step.id, ...settlement });
            this._writeStep(planId, step.id, 'failed', settlement);
            this._noteStep(planId, step.id, 'failed', reason, settlement);
            break;
          }
        }
        /**
         * `createTask` builds a task from a plan step. A bad step type must fail *that
         * step*, not throw out of the plan and leave the run half-reported (M3 live entry).
         */
        let task = null;
        try {
          task = this.createTask(step, {
            planId,
            requestId: options.requestId || stored.requestId || null,
            stepId: step.id
          });
        } catch (err) {
          this._writeStep(planId, step.id, 'failed');
          results.push({ stepId: step.id, status: 'failed', reason: `task build failed: ${err.message}` });
          this._noteStep(planId, step.id, 'failed', `task build failed: ${err.message}`);
          return { ok: false, reason: `task build failed for step ${step.id}: ${err.message}`, results };
        }
        if (!task) {
          this._writeStep(planId, step.id, 'failed');
          results.push({ stepId: step.id, status: 'failed', reason: 'no task for step' });
          this._noteStep(planId, step.id, 'failed', 'no task for step');
          return { ok: false, reason: `no task for step ${step.id}`, results };
        }
        /**
         * Identity chain (A04/A31): the executor's event must name the plan and step it
         * belongs to, not just the task. Set them explicitly so a builder that ignores the
         * id args still produces attributable events.
         */
        if (!task.planId) task.planId = planId;
        if (!task.stepId) task.stepId = step.id;
        if (!task.requestId) task.requestId = options.requestId || stored.requestId || null;
        this.currentTask = task;
        let result;
        try {
          result = await this.runTask(task);
        } finally {
          this.currentTask = null;
        }
        const taskResult = normalizeResult(result == null ? { ok: false, status: 'unknown', reason: 'missing-task-result' } : result);
        const status = taskResult.status;
        let finalStatus = status;
        let reason = taskResult.reason || null;
        let verification = null;
        /**
         * A task saying "ok" is not the same as the step's postcondition holding (A06).
         * An unmet postcondition stops the plan: a successful task becomes `failed`,
         * while a partial task stays `partial` with its unfinished quantity intact.
         */
        if ((status === 'succeeded' || status === 'partial') && !this.active.cancelled) {
          let verdict;
          const attempts = 1 + this.postconditionRetryAttempts;
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            verdict = await this._verify(step, 'postcondition');
            if (this.active.cancelled) break;
            if (verdict && verdict.ok === true) break;
            const retryable = verdict && verdict.stage === 'postcondition' && this.postconditionRetryMs >= 0;
            if (!retryable || attempt + 1 >= attempts) break;
            this.log.debug(
              `postcondition not settled for ${planId}/${step.id}; re-observe in ${this.postconditionRetryMs}ms`
            );
            await this.sleep(this.postconditionRetryMs);
          }
          verification = verdict;
          if (!verdict || verdict.ok !== true) {
            finalStatus = status === 'partial' ? 'partial' : 'failed';
            reason = this._verificationReason('postcondition', verdict);
          } else if (status === 'partial') {
            finalStatus = hasConditions(step.postconditions) ? 'succeeded' : 'partial';
            reason = finalStatus === 'succeeded' ? 'postcondition-satisfied' : (result && result.reason) || 'partial-needs-replan';
          }
        }
        if (this.active.cancelled) {
          finalStatus = 'cancelled';
          reason = this.active.reason || 'cancelled';
        }
        const settlement = {
          status: finalStatus, reason, taskResult, verification,
          remaining: finalStatus === 'succeeded' ? null : this._remaining(taskResult, verification)
        };
        results.push({ stepId: step.id, ...settlement });
        this._writeStep(
          planId,
          step.id,
          finalStatus === 'succeeded'
            ? 'done'
            : finalStatus === 'cancelled'
              ? 'cancelled'
              : finalStatus === 'partial' ? 'partial' : 'failed',
          settlement
        );
        this._noteStep(planId, step.id, finalStatus, reason, settlement);
        /**
         * Learning feedback: a step that names a method updates that method's outcome record.
         * The evidence is the step result (including a failed postcondition), not the model's
         * self-report.
         */
        if (step.methodId && typeof this.recordMethod === 'function') {
          try {
            this.recordMethod(step, finalStatus === 'succeeded');
          } catch (err) {
            this.log.warn(`method outcome not recorded for ${step.methodId}: ${err.message}`);
          }
        }
        if (finalStatus === 'cancelled') {
          this.active.cancelled = true;
          break;
        }
        if (finalStatus !== 'succeeded') break;
      }
      const completed = results.length === stored.steps.length &&
        results.every((result) => result.skipped || result.status === 'succeeded');
      return {
        ok: completed && !this.active.cancelled,
        partial: !this.active.cancelled && results.some((result) => result.status === 'partial'),
        cancelled: this.active.cancelled,
        results
      };
    } finally {
      this.active = null;
      this.currentTask = null;
    }
  }

  /** Stop between steps; forward to the running step so it can wind down. */
  cancel(reason = 'cancelled') {
    if (!this.active) return false;
    this.active.cancelled = true;
    this.active.reason = reason;
    if (this.currentTask && typeof this.currentTask.cancel === 'function') this.currentTask.cancel();
    return true;
  }

  /** Continue a plan parked on a `wait_for_player` step. */
  async resume(planId, answer = true) {
    const plan = this.plans.get(planId);
    if (!plan) return { ok: false, reason: 'unknown-plan', results: [] };
    const waiting = plan.steps.find((step) => step.status === 'waiting');
    if (!waiting) return { ok: false, reason: 'nothing-waiting', results: [] };
    if (this.active) return { ok: false, reason: 'busy', results: [] };
    return this.run(planId, { answers: { [waiting.id]: answer } });
  }

  /** One observation point per step for PlanService/events; never throws into the run. */
  _noteStep(planId, stepId, status, reason, result = null) {
    if (typeof this.onStep !== 'function') return;
    try {
      this.onStep({ planId, stepId, status, reason: reason || null, result });
    } catch (err) {
      this.log.debug(`step event listener failed: ${err.message}`);
    }
  }

  /** Use phase-specific views even with older injected two-argument verifiers. */
  async _verify(step, phase) {
    try {
      const observation = typeof this.observe === 'function' ? await this.observe() : null;
      const scoped = {
        ...step,
        preconditions: phase === 'precondition' ? step.preconditions : undefined,
        postconditions: phase === 'postcondition' ? step.postconditions : undefined
      };
      const verdict = await this.verify(scoped, observation);
      return verdict || { ok: false, stage: 'verify-error', failures: [{ reason: 'no-verdict' }] };
    } catch (err) {
      return { ok: false, stage: 'verify-error', failures: [{ reason: err.message }] };
    }
  }

  _verificationReason(phase, verdict) {
    return `${phase}: ${(verdict && verdict.stage) || 'unknown'} ${JSON.stringify((verdict && verdict.failures) || [])}`;
  }

  /** Preserve raw task counters; only derive quantities whose units are explicit. */
  _remaining(taskResult, verification) {
    const remaining = {};
    if (taskResult.remaining !== undefined) remaining.reported = taskResult.remaining;
    if (Number.isFinite(taskResult.requested) && Number.isFinite(taskResult.collected)) {
      remaining.quantity = {
        requested: taskResult.requested, collected: taskResult.collected,
        remaining: Math.max(0, taskResult.requested - taskResult.collected)
      };
    }
    for (const failure of (verification && verification.failures) || []) {
      if (failure.kind === 'inventoryAtLeast') {
        if (!remaining.inventoryAtLeast) remaining.inventoryAtLeast = {};
        remaining.inventoryAtLeast[failure.item] = Math.max(0, failure.need - failure.have);
      }
    }
    return Object.keys(remaining).length ? remaining : null;
  }

  _writeStep(planId, stepId, status, result = null) {
    const plan = this.plans.get(planId);
    if (!plan) return;
    const steps = plan.steps.map((step) => (step.id === stepId ? { ...step, status, result } : step));
    const written = this.plans.applyDraft({
      planId,
      requestId: plan.requestId,
      goal: plan.goal,
      constraints: plan.constraints,
      baseVersion: plan.version,
      steps
    });
    if (!written.ok) {
      this.log.warn(`plan ${planId} step ${stepId} write-back failed: ${written.reason}`);
    }
  }
}

module.exports = { PlanRunner };
