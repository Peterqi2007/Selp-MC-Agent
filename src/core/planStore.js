'use strict';

/**
 * PlanStore - the authoritative plan record with a single writer (P1 §1.4.4, A31).
 *
 * The harness may *draft* a plan; only Node bumps `version`. A draft that was built against
 * an older version is rejected as `stale` instead of silently overwriting a plan that has
 * already advanced - that is the "two processes writing the same plan" failure the plan
 * calls out.
 *
 * Steps already `done` are preserved from the stored plan when a replan comes in, so a
 * replan only changes the unfinished part. Step identity is `id` (falling back to `stepId`).
 *
 * In memory for M1; persistence and restart recovery belong to A17/A29.
 */

class PlanStore {
  constructor() {
    this.plans = new Map();
    this.seq = 0;
  }

  /**
   * Apply a draft.
   *
   * @param {object} draft { planId, requestId?, goal?, constraints?, baseVersion?, steps:[...] }
   * @returns {{ok:boolean, plan?:object, reason?:string, current?:object}}
   */
  applyDraft(draft) {
    if (!draft || !draft.planId) return { ok: false, reason: 'planId-required' };
    if (!Array.isArray(draft.steps)) return { ok: false, reason: 'steps-required' };

    const current = this.plans.get(draft.planId) || null;
    const baseVersion = draft.baseVersion === undefined ? (current ? current.version : 0) : Number(draft.baseVersion);
    if (current && baseVersion !== current.version) {
      return { ok: false, reason: 'stale', current: this.view(current), expectedVersion: current.version };
    }
    if (!current && baseVersion !== 0) {
      return { ok: false, reason: 'stale', current: null, expectedVersion: 0 };
    }

    const done = new Map();
    if (current) {
      for (const step of current.steps) {
        if (step.status === 'done') done.set(this.stepKey(step), step);
      }
    }
    const steps = draft.steps.map((step, index) => {
      const key = this.stepKey(step, index);
      const finished = done.get(key);
      if (finished) return { ...finished };
      return {
        ...step,
        id: step.id || step.stepId || `s${index + 1}`,
        status: step.status || 'pending'
      };
    });

    const version = current ? current.version + 1 : 1;
    const plan = {
      planId: draft.planId,
      requestId: draft.requestId || (current && current.requestId) || null,
      goal: draft.goal || (current && current.goal) || null,
      constraints: draft.constraints || (current && current.constraints) || null,
      version,
      steps,
      updatedAt: new Date().toISOString()
    };
    this.plans.set(plan.planId, plan);
    return { ok: true, plan: this.view(plan) };
  }

  get(planId) {
    const plan = this.plans.get(planId);
    return plan ? this.view(plan) : null;
  }

  list() {
    return [...this.plans.values()].map((plan) => this.view(plan));
  }

  status() {
    return { plans: this.plans.size, last: this.list().slice(-1)[0] || null };
  }

  stepKey(step, index) {
    return step && (step.id || step.stepId) ? step.id || step.stepId : `s${(index || 0) + 1}`;
  }

  view(plan) {
    return JSON.parse(JSON.stringify(plan));
  }
}

module.exports = { PlanStore };
