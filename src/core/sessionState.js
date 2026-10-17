'use strict';

/**
 * Session state capture/restore (A17/A29).
 *
 * What is persisted: plans (goal/version/steps), proposals (pending question, history,
 * standing authorization, cooldowns) and the event ring (sequence + recent facts).
 *
 * What is deliberately NOT persisted:
 *   - in-flight tasks or the body owner - a restart must not replay actions;
 *   - LLM turns - the harness session is gone; the pending *question* is restored instead.
 *
 * A restored proposal is awaiting an answer. Nothing executes on restore, and an expired
 * question is swept the next time the desk proposes.
 */

const VERSION = 1;

function captureState(brain) {
  return {
    version: VERSION,
    savedAt: new Date().toISOString(),
    plans: brain.plans && typeof brain.plans.toJSON === 'function' ? brain.plans.toJSON() : null,
    proposals:
      brain.proposals && typeof brain.proposals.toJSON === 'function' ? brain.proposals.toJSON() : null,
    events: brain.events && typeof brain.events.toJSON === 'function' ? brain.events.toJSON() : null,
    methods: brain.methods && typeof brain.methods.toJSON === 'function' ? brain.methods.toJSON() : null,
    answers: brain.answers && typeof brain.answers.toJSON === 'function' ? brain.answers.toJSON() : null
  };
}

function restoreState(brain, data) {
  if (!data || data.version !== VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  const restored = { plans: false, proposals: false, events: false, methods: false, answers: false };
  if (data.plans && brain.plans && typeof brain.plans.restore === 'function') {
    restored.plans = brain.plans.restore(data.plans);
  }
  if (data.proposals && brain.proposals && typeof brain.proposals.restore === 'function') {
    restored.proposals = brain.proposals.restore(data.proposals);
  }
  if (data.events && brain.events && typeof brain.events.restore === 'function') {
    restored.events = brain.events.restore(data.events);
  }
  if (data.methods && brain.methods && typeof brain.methods.restore === 'function') {
    restored.methods = brain.methods.restore(data.methods);
  }
  if (data.answers && brain.answers && typeof brain.answers.restore === 'function') {
    restored.answers = brain.answers.restore(data.answers);
  }
  return { ok: true, restored, savedAt: data.savedAt || null };
}

module.exports = { captureState, restoreState, VERSION };
