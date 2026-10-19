'use strict';

/**
 * PlanQuestionBridge - turns a parked plan into a proposal (P1 M3, A14/A25).
 *
 * `PlanRunner` parks on a `wait_for_player` step and returns the question; this bridge asks
 * the **existing** ProposalDesk, so the question reuses the same lifecycle: 3-minute cooldown
 * after a rejection, no-answer expiry, standing authorization, supersede-on-explicit-task.
 * There is no second question state machine.
 *
 * The proposal carries `type: 'plan_question'` and the plan/step ids; accept/reject are
 * routed by `Brain` to `PlanRunner.resume(planId, true/false)`. This module only creates the
 * proposal - it never resumes anything and never touches the body.
 */

class PlanQuestionBridge {
  constructor(deps = {}) {
    this.plans = deps.plans;
    this.proposals = deps.proposals;
    if (!this.plans || !this.proposals) throw new Error('PlanQuestionBridge needs plans and proposals');
  }

  /**
   * @param {string} planId
   * @returns {{ok:boolean, reason?:string, proposal?:object, question?:string}}
   */
  ask(planId) {
    const plan = this.plans.get(planId);
    if (!plan) return { ok: false, reason: 'unknown-plan' };
    const step = plan.steps.find((candidate) => candidate.status === 'waiting');
    if (!step) return { ok: false, reason: 'nothing-waiting' };
    const question =
      step.question || (step.args && step.args.question) || `Continue plan ${planId}?`;
    const candidate = {
      name: `plan:${planId}:${step.id}`,
      reason: question,
      type: 'plan_question',
      args: { planId, stepId: step.id }
    };
    let result = this.proposals.propose(candidate);
    /**
     * A parked plan's question is a direct request to the player and must not disappear
     * behind an autonomous survival proposal. Live A14 2026-10-19: p2 `mine_ore` was
     * pending, `propose()` returned `pending`, and the question never appeared; the plan
     * was parked with no answer surface except the raw HTTP resume. Supersede only a
     * non-question proposal; if a question is already pending, leave it alone.
     */
    if (!result.ok && result.reason === 'pending' && typeof this.proposals.supersede === 'function') {
      const pending = result.proposal;
      if (!pending || (pending.candidate && pending.candidate.type !== 'plan_question')) {
        this.proposals.supersede(`plan-question ${planId}/${step.id}`);
        result = this.proposals.propose(candidate);
      }
    }
    return { ...result, planId, stepId: step.id, question };
  }
}

module.exports = { PlanQuestionBridge };
