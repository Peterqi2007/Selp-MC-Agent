'use strict';

/**
 * Replan-draft guard (P1 §1.4.4, A15/A31).
 *
 * The harness may only submit a *draft*. Node validates it before PlanStore turns it into the
 * authoritative plan:
 *
 *   - a stale `baseVersion` is refused (PlanStore would also refuse it, but the reason is
 *     clearer here);
 *   - a completed step may not be reopened, retyped or dropped - only unfinished steps may
 *     change ("只修订受影响未完成步骤");
 *   - every replan spends one unit of the replan budget; exhausted means "ask the player",
 *     not "try again quietly".
 *
 * This module never writes the plan. It returns the validated step list for PlanStore.
 */

function stepPayload(step) {
  return { type: step.type || null, args: step.args || null, material: step.material || null };
}

function validateReplanDraft({ current, draft, budget } = {}) {
  if (!current) return { ok: false, reason: 'unknown-plan' };
  if (!draft || !Array.isArray(draft.steps)) return { ok: false, reason: 'steps-required' };
  if (draft.baseVersion !== current.version) {
    return { ok: false, reason: 'stale', expectedVersion: current.version };
  }
  if (budget) {
    const spent = budget.spend('replans');
    if (!spent.ok) return { ok: false, reason: 'budget-exhausted', kind: 'replans' };
  }

  const byId = new Map(current.steps.map((step) => [step.id, step]));
  const seen = new Set();
  for (const step of draft.steps) {
    if (!step || !step.id) return { ok: false, reason: 'step-id-required' };
    seen.add(step.id);
    const existing = byId.get(step.id);
    if (!existing) continue; // a new unfinished step is allowed
    if (existing.status !== 'done') continue;
    if (step.status !== 'done') return { ok: false, reason: 'reopens-done-step', stepId: step.id };
    const before = JSON.stringify(stepPayload(existing));
    const after = JSON.stringify(stepPayload(step));
    if (before !== after) return { ok: false, reason: 'changes-done-step', stepId: step.id };
  }
  for (const existing of current.steps) {
    if (existing.status === 'done' && !seen.has(existing.id)) {
      return { ok: false, reason: 'drops-done-step', stepId: existing.id };
    }
  }

  const changed = draft.steps
    .filter((step) => {
      const existing = byId.get(step.id);
      if (!existing) return true;
      return existing.status !== 'done' && JSON.stringify(stepPayload(existing)) !== JSON.stringify(stepPayload(step));
    })
    .map((step) => step.id);

  return { ok: true, changed, steps: draft.steps };
}

module.exports = { validateReplanDraft };
