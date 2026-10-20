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
    planService:
      brain.planService && typeof brain.planService.toJSON === 'function' ? brain.planService.toJSON() : null,
    budget: brain.budget && typeof brain.budget.toJSON === 'function' ? brain.budget.toJSON() : null,
    taskSlot: brain.slot && typeof brain.slot.toJSON === 'function' ? brain.slot.toJSON() : null,
    proposals:
      brain.proposals && typeof brain.proposals.toJSON === 'function' ? brain.proposals.toJSON() : null,
    events: brain.events && typeof brain.events.toJSON === 'function' ? brain.events.toJSON() : null,
    methods: brain.methods && typeof brain.methods.toJSON === 'function' ? brain.methods.toJSON() : null,
    answers: brain.answers && typeof brain.answers.toJSON === 'function' ? brain.answers.toJSON() : null,
    conversation:
      brain.conversation && typeof brain.conversation.toJSON === 'function' ? brain.conversation.toJSON() : null,
    memoryStore:
      brain.memoryStore && typeof brain.memoryStore.toJSON === 'function' ? brain.memoryStore.toJSON() : null,
    chatMemory:
      brain.chatMemory && typeof brain.chatMemory.toJSON === 'function' ? brain.chatMemory.toJSON() : null
  };
}

function restoreState(brain, data) {
  if (!data || data.version !== VERSION) {
    return { ok: false, reason: 'unsupported-version' };
  }
  const restored = {
    plans: false,
    planService: false,
    budget: false,
    taskSlot: false,
    proposals: false,
    events: false,
    methods: false,
    answers: false,
    conversation: false,
    memoryStore: false,
    chatMemory: false
  };
  if (data.plans && brain.plans && typeof brain.plans.restore === 'function') {
    restored.plans = brain.plans.restore(data.plans);
  }
  if (data.planService && brain.planService && typeof brain.planService.restore === 'function') {
    restored.planService = brain.planService.restore(data.planService);
  }
  if (data.budget && brain.budget && typeof brain.budget.restore === 'function') {
    restored.budget = brain.budget.restore(data.budget);
  }
  if (data.taskSlot && brain.slot && typeof brain.slot.restore === 'function') {
    restored.taskSlot = brain.slot.restore(data.taskSlot);
  }
  if (data.proposals && brain.proposals && typeof brain.proposals.restore === 'function') {
    restored.proposals = brain.proposals.restore(data.proposals);
  }
  if (data.events && brain.events && typeof brain.events.restore === 'function') {
    restored.events = brain.events.restore(data.events);
  }
  /**
   * Old state files predate `taskSlot.seq`. Even when the counter was persisted, the event
   * ring is the authority on which ids were already used: a new `task-N` whose eventId was
   * restored would be silently deduped by TaskEvents (A13 live 2026-10-18). Advance the
   * slot past every restored id before the next task is built.
   */
  if (brain.slot && brain.events && typeof brain.events.since === 'function') {
    let maxTaskSeq = 0;
    for (const event of brain.events.since(0)) {
      const match = /^task-(\d+)$/.exec(String((event && event.taskId) || ''));
      if (match) maxTaskSeq = Math.max(maxTaskSeq, Number(match[1]));
    }
    if (maxTaskSeq > (Number(brain.slot.seq) || 0)) brain.slot.seq = maxTaskSeq;
  }
  if (data.methods && brain.methods && typeof brain.methods.restore === 'function') {
    restored.methods = brain.methods.restore(data.methods);
  }
  if (data.answers && brain.answers && typeof brain.answers.restore === 'function') {
    restored.answers = brain.answers.restore(data.answers);
  }
  if (data.conversation && brain.conversation && typeof brain.conversation.restore === 'function') {
    restored.conversation = brain.conversation.restore(data.conversation);
  }
  if (data.memoryStore && brain.memoryStore && typeof brain.memoryStore.restore === 'function') {
    restored.memoryStore = brain.memoryStore.restore(data.memoryStore);
  }
  if (data.chatMemory && brain.chatMemory && typeof brain.chatMemory.restore === 'function') {
    restored.chatMemory = brain.chatMemory.restore(data.chatMemory);
  }
  return { ok: true, restored, savedAt: data.savedAt || null };
}

module.exports = { captureState, restoreState, VERSION };
