'use strict';

/**
 * A28 event injection - a test hook, not a transport.
 *
 * A28 ("event wake-up / single planner") has to be shown against a live turn without
 * waiting for a real 11-second task or a real plan failure: duplicate, out-of-order and
 * post-cancel completions are the interesting cases. This module manufactures those
 * events by calling the **same** entry points a real plan/task completion uses
 * (`TurnService.onPlanEvent`, the turn event ring), so "at most one wake-up per turn" is
 * exercised end to end - including the SSE ring a real harness reads - without a second
 * event source in the agent.
 *
 * Guarantees and boundaries:
 *   - it never calls a model and never touches the body;
 *   - it is wired into the HTTP surface only when `web.testHooks` is true (or
 *     `P1_TEST_HOOKS=on`), so a production agent exposes no injection endpoint;
 *   - it cannot invent a turn/plan mapping: `plan()` routes through TurnService, which
 *     drops events for plans it does not own (out-of-order/cancel cases return a reason).
 */

class HarnessInjector {
  /**
   * @param {object} deps { turnService, events?, log? }
   */
  constructor(deps = {}) {
    this.turnService = deps.turnService || null;
    this.events =
      deps.events || (this.turnService && this.turnService.turnEvents) || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    /** Injected events need their own eventIds: TaskEvents dedupes by id. */
    this.seq = 0;
  }

  /**
   * Feed a synthetic plan event into the owning turn (duplicate, out-of-order, late).
   *
   * @param {{planId:string, type:string, [key:string]:any}} event
   * @returns {{ok:boolean, kind:string, injected?:string, planId?:string, outcome?:any, reason?:string}}
   */
  plan(event = {}) {
    if (!this.turnService || typeof this.turnService.onPlanEvent !== 'function') {
      return { ok: false, kind: 'plan', reason: 'no-turn-service' };
    }
    const planId = String(event.planId || '').trim();
    const type = String(event.type || '').trim();
    if (!planId || !type) return { ok: false, kind: 'plan', reason: 'planId-and-type-required' };
    const outcome = this.turnService.onPlanEvent({ ...event, planId, type });
    return { ok: true, kind: 'plan', planId, injected: type, outcome: outcome || null };
  }

  /**
   * Publish a synthetic turn event on the SSE ring (default `turn:resumable`).
   *
   * The plugin is expected to ignore a second resume for a turn it already resumed; the
   * Node side is expected not to create a second delivery from a duplicate.
   *
   * @param {{turnId?:string, type?:string, planId?:string, event?:object, resumeId?:number}} payload
   */
  turn(payload = {}) {
    if (!this.events || typeof this.events.publish !== 'function') {
      return { ok: false, kind: 'turn', reason: 'no-turn-events' };
    }
    const type = String(payload.type || 'turn:resumable');
    const turnId = payload.turnId ? String(payload.turnId) : '';
    if (type.startsWith('turn:') && !turnId) {
      return { ok: false, kind: 'turn', reason: 'turnId-required' };
    }
    const published = this.events.publish({
      eventId: payload.eventId
        ? String(payload.eventId)
        : `injected|${type}|${turnId || '-'}|${++this.seq}`,
      type,
      turnId: turnId || null,
      planId: payload.planId ? String(payload.planId) : null,
      event: payload.event || null,
      resumeId: payload.resumeId === undefined ? null : payload.resumeId,
      injected: true
    });
    return {
      ok: true,
      kind: 'turn',
      injected: type,
      turnId: turnId || null,
      eventId: published && published.eventId ? published.eventId : null
    };
  }

  /** One-shot status for the HTTP surface: what this injector is attached to. */
  status() {
    return {
      ok: true,
      turnService: !!this.turnService,
      events: !!this.events
    };
  }
}

module.exports = { HarnessInjector };
