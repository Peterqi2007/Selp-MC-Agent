'use strict';

/**
 * HarnessAdapter - the boundary between a coding harness (DSH / Codex) and the local
 * turn/task contracts (P1 §1.9.3, M1d).
 *
 * The adapter is deliberately transport-agnostic: it takes plain events, never opens a
 * socket, never calls a model, and never leaks a harness session object into a task or body.
 * The future DSH plugin feeds it:
 *
 *     turn.started   { requestId?, planId? }          -> TurnLifecycle.begin
 *     tool.call      { turnId, taskId, tool }         -> wait; remembers task -> turn
 *     task.event     { event:{ taskId, type, ... } }  -> ingest the matching task event
 *     turn.resume    { turnId }                       -> consume the parked event once
 *     turn.cancel    { turnId, reason? }              -> cancelled; late events die
 *     turn.finished  { turnId }                       -> done
 *
 * `events` (TaskEvents) is subscribed directly, so the executor's own `task:done/failed`
 * facts reach the adapter without a second emitter. A task event that does not belong to a
 * parked turn is ignored silently - the planner runs tasks all the time and that is not an
 * error.
 *
 * `replay()` exists for the offline fixture: feed a recorded stream, get a transcript of what
 * the adapter did. That transcript is what an A04 test asserts on.
 */

class HarnessAdapter {
  /**
   * @param {object} deps { turns, events, now }
   */
  constructor(deps = {}) {
    this.turns = deps.turns || null;
    this.events = deps.events || null;
    this.now = deps.now || (() => Date.now());
    /** taskId -> turnId, for events that arrive without a turn id */
    this.taskToTurn = new Map();
    this.actions = [];
    this.unsubscribe = null;
    if (this.turns && this.events && typeof this.events.subscribe === 'function') {
      this.unsubscribe = this.events.subscribe((event) => this.onTaskEvent(event));
    }
  }

  /** Start a harness turn. */
  start(meta = {}) {
    if (!this.turns) return { ok: false, reason: 'no-turn-lifecycle' };
    const result = this.turns.begin(meta);
    if (result.ok) this._record('started', { turnId: result.turn.id, requestId: result.turn.requestId });
    return result;
  }

  /** The model chose a long-running tool; park the turn until that task settles. */
  toolCall({ turnId, taskId, tool } = {}) {
    if (!this.turns) return { ok: false, reason: 'no-turn-lifecycle' };
    const result = this.turns.wait(turnId, taskId);
    if (result.ok) {
      this.taskToTurn.set(taskId, turnId);
      this._record('waiting', { turnId, taskId, tool: tool || null });
    }
    return result;
  }

  /** A task event from the event hub, or directly from a recorded fixture. */
  onTaskEvent(event = {}) {
    if (!event.taskId) return { ok: false, reason: 'no-task-id' };
    const turnId = this.taskToTurn.get(event.taskId);
    if (!turnId) return { ok: false, reason: 'no-parked-turn' }; // normal planner traffic
    if (!this.turns) return { ok: false, reason: 'no-turn-lifecycle' };
    const result = this.turns.ingest(turnId, event);
    if (result.ok) {
      this._record('resumable', { turnId, taskId: event.taskId, event: event.type || null });
    } else if (result.reason === 'already-resumable') {
      this._record('ignored-duplicate', { turnId, taskId: event.taskId });
    } else {
      this._record('ignored', { turnId, taskId: event.taskId, reason: result.reason });
    }
    return result;
  }

  /** Consume the parked event exactly once. */
  resume(turnId) {
    if (!this.turns) return { ok: false, reason: 'no-turn-lifecycle' };
    const result = this.turns.resume(turnId);
    if (result.ok) this._record('resumed', { turnId, taskId: result.event.taskId });
    return result;
  }

  cancel(turnId, reason = 'cancelled') {
    if (!this.turns) return { ok: false, reason: 'no-turn-lifecycle' };
    const result = this.turns.cancel(turnId, reason);
    if (result.ok) this._record('cancelled', { turnId, reason });
    return result;
  }

  finish(turnId) {
    if (!this.turns) return { ok: false, reason: 'no-turn-lifecycle' };
    const result = this.turns.finish(turnId);
    if (result.ok) this._record('finished', { turnId });
    return result;
  }

  /** Map one harness event onto the adapter methods. */
  ingest(event = {}) {
    switch (event.type) {
      case 'turn.started':
        return this.start({ requestId: event.requestId, planId: event.planId });
      case 'tool.call':
        return this.toolCall({ turnId: event.turnId, taskId: event.taskId, tool: event.tool });
      case 'task.event':
        return this.onTaskEvent(event.event || {});
      case 'turn.resume':
        return this.resume(event.turnId);
      case 'turn.cancel':
        return this.cancel(event.turnId, event.reason);
      case 'turn.finished':
        return this.finish(event.turnId);
      default:
        this._record('ignored-unknown', { type: event.type || null });
        return { ok: false, reason: 'unknown-event' };
    }
  }

  /** Offline fixture: replay a recorded stream and return the transcript. */
  replay(events = []) {
    this.actions = [];
    for (const event of events) this.ingest(event);
    return this.actions.slice();
  }

  status() {
    return {
      tasks: this.taskToTurn.size,
      actions: this.actions.length,
      last: this.actions[this.actions.length - 1] || null
    };
  }

  _record(kind, data) {
    this.actions.push({ kind, at: new Date(this.now()).toISOString(), ...data });
    if (this.actions.length > 200) this.actions.shift();
  }
}

module.exports = { HarnessAdapter };
