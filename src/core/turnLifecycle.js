'use strict';

/**
 * TurnLifecycle - the offline model of the harness turn contract (P1 §1.9.3, A04/A28).
 *
 * A turn runs, may park while a long task executes (`waiting`), and is resumed by exactly one
 * matching task event. The failure modes this makes explicit:
 *
 *   - a duplicate or stale task event must not resume the turn twice;
 *   - an event for another task must not resume it at all (identity, not "first open task");
 *   - after `cancel()` the turn is dead: a late model output or task event is ignored rather
 *     than reviving work the player stopped;
 *   - only one turn may be active per session (P1: at most one LLM turn at a time).
 *
 * `now` is injectable for tests. The DSH plugin adapter will map its own events onto this
 * class; nothing here talks to a socket or a model.
 */

const STATES = new Set(['running', 'waiting', 'resumable', 'done', 'cancelled']);

class TurnLifecycle {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.seq = 0;
    /** @type {Map<string, object>} */
    this.turns = new Map();
    this.activeId = null;
  }

  /** Start a turn. Refuses while another turn is active. */
  begin(meta = {}) {
    if (this.activeId) return { ok: false, reason: 'turn-active', activeId: this.activeId };
    const turn = {
      id: `turn-${++this.seq}`,
      state: 'running',
      requestId: meta.requestId || null,
      planId: meta.planId || null,
      waitingTaskId: null,
      event: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      cancelReason: null
    };
    this.turns.set(turn.id, turn);
    this.activeId = turn.id;
    return { ok: true, turn: this.view(turn) };
  }

  /** The model emitted a tool call that started a long task; park the turn. */
  wait(turnId, taskId) {
    const turn = this._get(turnId);
    if (!turn) return { ok: false, reason: 'unknown-turn' };
    if (turn.state !== 'running') return { ok: false, reason: `turn-${turn.state}` };
    if (!taskId) return { ok: false, reason: 'taskId-required' };
    turn.state = 'waiting';
    turn.waitingTaskId = taskId;
    turn.updatedAt = this.now();
    return { ok: true, turn: this.view(turn) };
  }

  /**
   * A task event arrived. Only the matching task, while waiting, makes the turn resumable;
   * duplicates are dropped.
   */
  ingest(turnId, event = {}) {
    const turn = this._get(turnId);
    if (!turn) return { ok: false, reason: 'unknown-turn' };
    if (turn.state === 'cancelled') return { ok: false, reason: 'turn-cancelled' };
    if (turn.state !== 'waiting') return { ok: false, reason: `turn-${turn.state}` };
    if (!event.taskId || event.taskId !== turn.waitingTaskId) {
      return { ok: false, reason: 'task-mismatch' };
    }
    if (turn.event) return { ok: false, reason: 'already-resumable' };
    turn.event = { type: event.type || 'task:done', taskId: event.taskId, reason: event.reason || null };
    turn.state = 'resumable';
    turn.updatedAt = this.now();
    return { ok: true, turn: this.view(turn) };
  }

  /** Consume the parked event exactly once and run the turn again. */
  resume(turnId) {
    const turn = this._get(turnId);
    if (!turn) return { ok: false, reason: 'unknown-turn' };
    if (turn.state === 'cancelled') return { ok: false, reason: 'turn-cancelled' };
    if (turn.state !== 'resumable') return { ok: false, reason: `turn-${turn.state}` };
    const event = turn.event;
    turn.event = null;
    turn.waitingTaskId = null;
    turn.state = 'running';
    turn.updatedAt = this.now();
    return { ok: true, turn: this.view(turn), event };
  }

  /** The turn finished normally. */
  finish(turnId) {
    const turn = this._get(turnId);
    if (!turn) return { ok: false, reason: 'unknown-turn' };
    if (turn.state === 'cancelled') return { ok: false, reason: 'turn-cancelled' };
    turn.state = 'done';
    turn.updatedAt = this.now();
    if (this.activeId === turn.id) this.activeId = null;
    return { ok: true, turn: this.view(turn) };
  }

  /** Cancel by player/reflex/death. Late events and resumes are refused from here on. */
  cancel(turnId, reason = 'cancelled') {
    const turn = this._get(turnId);
    if (!turn) return { ok: false, reason: 'unknown-turn' };
    if (turn.state === 'cancelled') return { ok: false, reason: 'turn-cancelled' };
    turn.state = 'cancelled';
    turn.cancelReason = reason;
    turn.event = null;
    turn.waitingTaskId = null;
    turn.updatedAt = this.now();
    if (this.activeId === turn.id) this.activeId = null;
    return { ok: true, turn: this.view(turn) };
  }

  get(turnId) {
    const turn = this._get(turnId);
    return turn ? this.view(turn) : null;
  }

  status() {
    return {
      activeId: this.activeId,
      turns: [...this.turns.values()].map((turn) => this.view(turn))
    };
  }

  _get(turnId) {
    return turnId ? this.turns.get(turnId) || null : null;
  }

  view(turn) {
    return {
      id: turn.id,
      state: turn.state,
      requestId: turn.requestId,
      planId: turn.planId,
      waitingTaskId: turn.waitingTaskId,
      event: turn.event,
      cancelReason: turn.cancelReason,
      createdAt: turn.createdAt,
      updatedAt: turn.updatedAt
    };
  }
}

module.exports = { TurnLifecycle, STATES };
