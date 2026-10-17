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
 *   - already-`done` steps are skipped, which is what makes a resumed plan cheap.
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
        results.push({ stepId: step.id, status, reason: result ? result.reason || null : null });
        this._writeStep(planId, step.id, status === 'succeeded' || status === 'partial' ? 'done' : 'failed');
        if (status === 'cancelled') {
          this.active.cancelled = true;
          break;
        }
        if (status !== 'succeeded' && status !== 'partial') break;
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
