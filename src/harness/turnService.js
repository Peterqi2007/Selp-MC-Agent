'use strict';

/**
 * TurnService - the live half of the harness turn contract (P1 M3/A28/F2).
 *
 * `TurnLifecycle`, `HarnessAdapter` and `ResumeBridge` were delivered as offline contracts
 * (M1/M3). This service connects them to the running agent and to a transport:
 *
 *   - a harness starts a turn (`begin`), optionally parks it on one task (`waitTask`) or on
 *     a whole plan (`trackPlan`);
 *   - when the task or plan settles, the adapter makes the turn `resumable`, the bridge
 *     asks this service to deliver once, and the delivery is published on a `TaskEvents`
 *     channel (`turn:resumable`) that `/harness/events` streams as SSE. A late subscriber
 *     still gets the ring replay, so a reconnecting harness does not lose the wake-up;
 *   - `cancel`/`cancelAll` kill the turn and its plan/task; late events cannot revive it;
 *   - `finish` closes a resumed turn after the model has consumed the event.
 *
 * The transport is deliberately just data: this class never calls a model and never holds a
 * DSH session object. The DSH plugin consumes `/harness/events` and decides how to resume
 * its own conversation.
 */

const { TaskEvents } = require('../core/taskEvents');
const { ResumeBridge } = require('./resumeBridge');

/** Plan events that mean "the harness turn has something to do". */
const RESUMABLE_PLAN_EVENTS = new Set([
  'plan:waiting',
  'plan:completed',
  'plan:failed',
  'plan:rejected'
]);
const TERMINAL_PLAN_EVENTS = new Set(['plan:completed', 'plan:failed', 'plan:rejected', 'plan:cancelled']);

class TurnService {
  /**
   * @param {object} deps { turns, adapter, planService, log, now }
   */
  constructor(deps = {}) {
    this.turns = deps.turns;
    this.adapter = deps.adapter;
    this.planService = deps.planService || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.now = deps.now || (() => Date.now());
    if (!this.turns || !this.adapter) {
      throw new Error('TurnService needs turns and adapter');
    }
    this.turnEvents = new TaskEvents({ limit: 200 });
    /** turnId -> planId, and planId -> turnId (one plan wake per turn). */
    this.turnPlans = new Map();
    this.planTurns = new Map();
    this.seq = 0;
    this.unsubscribePlan =
      this.planService && typeof this.planService.onEvent === 'function'
        ? this.planService.onEvent((event) => this.onPlanEvent(event))
        : () => {};
    this.bridge = new ResumeBridge({
      adapter: this.adapter,
      turns: this.turns,
      deliver: (turn, event) => this.deliver(turn, event),
      log: this.log
    });
  }

  /** Start one harness turn. */
  begin(meta = {}) {
    const started = this.adapter.start({ requestId: meta.requestId, planId: meta.planId });
    if (started.ok) {
      this.publish('turn:started', {
        turnId: started.turn.id,
        requestId: started.turn.requestId,
        planId: started.turn.planId
      });
    }
    return started;
  }

  /** Park the turn on one long task (the classic `tool.call` case). */
  waitTask(turnId, taskId, tool = null) {
    return this.adapter.toolCall({ turnId, taskId, tool });
  }

  /**
   * Park the turn on a plan and remember the mapping.
   *
   * Called before `PlanService.start`, so the first terminal event cannot race the park.
   */
  trackPlan(turnId, planId, tool = 'mc_plan') {
    if (!planId) return { ok: false, reason: 'planId-required' };
    if (
      this.planService &&
      typeof this.planService.get === 'function' &&
      !this.planService.get(planId)
    ) {
      return { ok: false, reason: 'unknown-plan', planId };
    }
    if (this.turnPlans.has(turnId) && this.turnPlans.get(turnId) !== planId) {
      return { ok: false, reason: 'turn-already-tracks-plan', planId: this.turnPlans.get(turnId) };
    }
    const parked = this.adapter.planCall({ turnId, planId, tool });
    if (!parked.ok) return parked;
    this.turnPlans.set(turnId, planId);
    this.planTurns.set(planId, turnId);
    return { ok: true, turnId, planId };
  }

  /** The plan changed. Wake the owning turn once, or cancel it when the plan was stopped. */
  onPlanEvent(event = {}) {
    if (!event.planId) return { ok: false, reason: 'no-plan-id' };
    const turnId = this.planTurns.get(event.planId);
    if (!turnId) return { ok: false, reason: 'no-turn-for-plan' };
    if (event.type === 'plan:cancelled') {
      return this.cancel(turnId, event.reason || 'plan-cancelled', { skipPlan: true, already: event });
    }
    if (!RESUMABLE_PLAN_EVENTS.has(event.type)) return { ok: true, ignored: true };
    return this.adapter.planEvent(turnId, event);
  }

  /**
   * Deliver one resume event to the harness transport.
   *
   * Delivery succeeds when the event is in the hub: the SSE ring is the transport's own
   * replay buffer, so "no listener connected right now" is not a lost wake-up. A throw here
   * keeps the item queued in ResumeBridge.
   */
  deliver(turn, event) {
    const payload = {
      type: 'turn:resumable',
      turnId: turn.id,
      planId: turn.planId || (event && event.planId) || this.turnPlans.get(turn.id) || null,
      event: event || null,
      resumeId: ++this.seq,
      eventId: `turn:resumable|${turn.id}|${this.seq}`
    };
    this.publish(payload.type, payload);
    return true;
  }

  /** Mark a resumed turn finished. The plan (if any) keeps running independently. */
  finish(turnId) {
    const result = this.adapter.finish(turnId);
    if (result.ok) {
      this._forgetTurn(turnId);
      this.publish('turn:finished', { turnId, eventId: `turn:finished|${turnId}` });
    }
    return result;
  }

  /**
   * Cancel one turn. By default its plan is cancelled through PlanService too, so a stop of
   * the model turn cannot leave the body running a plan the harness no longer owns.
   */
  cancel(turnId, reason = 'cancelled', options = {}) {
    const planId = this.turnPlans.get(turnId) || null;
    const result = this.adapter.cancel(turnId, reason);
    if (!options.skipPlan && planId && this.planService) {
      try {
        this.planService.cancel(planId, reason);
      } catch (err) {
        this.log.warn(`turn ${turnId}: plan cancel failed: ${err.message}`);
      }
    }
    if (result.ok) {
      this._forgetTurn(turnId);
      this.publish('turn:cancelled', {
        turnId,
        planId,
        reason,
        eventId: `turn:cancelled|${turnId}|${reason}`
      });
    }
    return result;
  }

  /** Cancel every live turn (and its plan). Safe to call when nothing is active. */
  cancelAll(reason = 'cancelled') {
    const outcomes = [];
    for (const turn of this.turns.status().turns) {
      if (turn.state === 'done' || turn.state === 'cancelled') continue;
      outcomes.push(this.cancel(turn.id, reason));
    }
    return outcomes;
  }

  status() {
    return {
      activeId: this.turns.status().activeId,
      turns: this.turns.status().turns,
      planTurns: [...this.planTurns.entries()].map(([planId, turnId]) => ({ planId, turnId })),
      bridge: this.bridge.status(),
      events: this.turnEvents.status()
    };
  }

  close() {
    try {
      this.unsubscribePlan();
    } catch {
      /* already gone */
    }
  }

  publish(type, payload) {
    const event = { ...payload, type, at: new Date(this.now()).toISOString() };
    if (!event.eventId) {
      event.eventId = `${type}|${event.turnId || ''}|${event.resumeId || ''}|${Date.now()}`;
    }
    return this.turnEvents.publish(event);
  }

  _forgetTurn(turnId) {
    const planId = this.turnPlans.get(turnId);
    this.turnPlans.delete(turnId);
    if (planId && this.planTurns.get(planId) === turnId) this.planTurns.delete(planId);
  }
}

module.exports = { TurnService, RESUMABLE_PLAN_EVENTS, TERMINAL_PLAN_EVENTS };
