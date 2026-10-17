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

class PlanRunner {
  /**
   * @param {object} deps { plans, createTask(step, ids), runTask(task), log }
   */
  constructor(deps = {}) {
    this.plans = deps.plans;
    this.createTask = deps.createTask;
    this.runTask = deps.runTask;
    this.verify = deps.verify || null;
    this.observe = deps.observe || null;
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
          if (!accepted) break;
          continue;
        }
        const task = this.createTask(step, {
          planId,
          requestId: options.requestId || stored.requestId || null,
          stepId: step.id
        });
        if (!task) {
          this._writeStep(planId, step.id, 'failed');
          results.push({ stepId: step.id, status: 'failed', reason: 'no task for step' });
          return { ok: false, reason: `no task for step ${step.id}`, results };
        }
        this.currentTask = task;
        let result;
        try {
          result = await this.runTask(task);
        } finally {
          this.currentTask = null;
        }
        const status = (result && result.status) || (result && result.ok ? 'succeeded' : 'failed');
        let finalStatus = status;
        let reason = result ? result.reason || null : null;
        /**
         * A task saying "ok" is not the same as the step's postcondition holding (A06).
         * When a verifier is injected, a failed postcondition turns the step into `failed`
         * and stops the plan - the caller can then replan instead of assuming progress.
         */
        if ((status === 'succeeded' || status === 'partial') && typeof this.verify === 'function') {
          let verdict;
          try {
            const observation = typeof this.observe === 'function' ? this.observe() : null;
            verdict = this.verify(step, observation);
          } catch (err) {
            verdict = { ok: false, stage: 'verify-error', failures: [{ reason: err.message }] };
          }
          if (!verdict || verdict.ok !== true) {
            finalStatus = 'failed';
            reason = `postcondition: ${(verdict && verdict.stage) || 'unknown'} ${JSON.stringify(
              (verdict && verdict.failures) || []
            )}`;
          }
        }
        results.push({ stepId: step.id, status: finalStatus, reason });
        this._writeStep(
          planId,
          step.id,
          finalStatus === 'succeeded' || finalStatus === 'partial' ? 'done' : 'failed'
        );
        if (finalStatus === 'cancelled') {
          this.active.cancelled = true;
          break;
        }
        if (finalStatus !== 'succeeded' && finalStatus !== 'partial') break;
      }
      const completed = results.every(
        (result) => result.skipped || result.status === 'succeeded' || result.status === 'partial'
      );
      return {
        ok: completed && !this.active.cancelled,
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

  _writeStep(planId, stepId, status) {
    const plan = this.plans.get(planId);
    if (!plan) return;
    const steps = plan.steps.map((step) => (step.id === stepId ? { ...step, status } : step));
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
