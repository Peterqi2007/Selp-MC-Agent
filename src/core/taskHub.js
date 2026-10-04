'use strict';

/**
 * TaskHub: the single background-task slot for one body.
 *
 * numen's TaskDispatch/`TaskSlot` (docs/architecture-mind-model.md §六) in the shape this
 * agent needs: a long-running skill is *accepted* now and *finishes later*. The acceptance
 * receipt carries a task id; the completion is delivered as the same `task:done` /
 * `task:failed` brain event the rest of the agent already listens to, so the LLM's
 * follow-up turn and the proactive "it's done" line work unchanged.
 *
 * Rules that come straight from the reference design:
 *   - one body, one background task; a new one replaces the running one (a change of mind
 *     must not be ignored because the bot is busy);
 *   - the replaced task settles as stopped/replaced, never as success, and it always gets a
 *     result - nothing may vanish while a caller is waiting for it;
 *   - acceptance means "this can start now": an invalid or impossible job must have been
 *     refused before it reached the slot (validation lives in the skill registry);
 *   - while the slot is occupied the brain is held (`task` hold): no autonomous planning and
 *     no new explicit work, because both would fight for the same keyboard. `!stop` cancels.
 *
 * Interruption is cooperative on purpose: the running skill is not killed mid-await (JS has
 * no safe way to do that); instead the navigator and the client's continuous action are
 * interrupted, which makes the skill's next step fail and return. The hub waits for that
 * settle (bounded) before starting the replacement.
 */

const { fold } = require('./failure');

const SETTLE_TIMEOUT_MS = 15000;

class TaskHub {
  /**
   * @param {object} ctx agent context (needs brain/nav/body for holds and interruption)
   * @param {object} [options] { log, trace }
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.log = options.log || { info() {}, warn() {}, debug() {} };
    this.trace = options.trace || (() => {});
    this.seq = 0;
    /** @type {null|{id:string,name:string,description:string,source:string,startedAt:number}} */
    this.current = null;
    this.history = [];
  }

  get busy() {
    return !!this.current;
  }

  /**
   * Accept a background job.
   *
   * @param {object} job { name, description, source, run: () => Promise<object> }
   * @returns {Promise<object>} the acceptance receipt (ok, accepted, taskId, replaced, note)
   */
  async submit(job) {
    const name = String(job.name || 'task');
    const id = `t${++this.seq}`;

    let replaced = null;
    if (this.current) {
      replaced = this.current.id;
      this.current.replacedBy = id;
      await this._interruptCurrent('replaced');
    }

    const handle = {
      id,
      name,
      description: job.description || name,
      source: job.source || 'unknown',
      startedAt: Date.now(),
      interruptReason: null,
      replacedBy: null
    };
    handle.settle = new Promise((resolve) => {
      handle.resolveSettle = resolve;
    });

    /**
     * Take the body before work starts: cancel whatever autonomous task is running (its
     * request path already reports the cancellation) and hold the brain so the planner
     * cannot start something new behind the task's back.
     */
    try {
      if (this.ctx.brain && typeof this.ctx.brain.preempt === 'function' && this.ctx.brain.activeTask) {
        this.ctx.brain.preempt();
      }
    } catch {}
    this._hold(true, `${id} ${name}`);

    this.current = handle;
    this.log.info(`task ${id} accepted: ${name} (${handle.source})${replaced ? ` [replaced ${replaced}]` : ''}`);
    this.trace({ kind: 'task-accepted', id, name, source: handle.source, replaced });

    (async () => {
      let result;
      try {
        result = await job.run();
      } catch (err) {
        result = fold({ ok: false, reason: `${name} threw: ${err.message}`, failure: 'internal' });
      }
      this._settle(handle, result);
    })();

    return {
      ok: true,
      accepted: true,
      async: true,
      taskId: id,
      name,
      replaced,
      note:
        'running in the background; the result arrives as a task_finished event - ' +
        'do not poll, keep talking or send a new task to replace it'
    };
  }

  /** Stop the running task (used by `!stop`, `task stop` and the panel's emergency stop). */
  async cancel(reason = 'stopped') {
    if (!this.current) return { ok: true, cancelled: null };
    const id = this.current.id;
    this.log.warn(`task ${id} cancelled: ${reason}`);
    await this._interruptCurrent(reason);
    return { ok: true, cancelled: id, reason };
  }

  /** Snapshot for the panel, `!task status` and tests. */
  status() {
    const current = this.current
      ? {
          id: this.current.id,
          name: this.current.name,
          description: this.current.description,
          source: this.current.source,
          startedAt: this.current.startedAt,
          ms: Date.now() - this.current.startedAt
        }
      : null;
    return { busy: !!current, current, recent: this.history.slice(-5) };
  }

  async _interruptCurrent(reason) {
    const handle = this.current;
    if (!handle) return;
    handle.interruptReason = reason;
    try {
      if (this.ctx.nav && typeof this.ctx.nav.interrupt === 'function') {
        this.ctx.nav.interrupt(`task ${handle.id} ${reason}`);
      }
    } catch {}
    try {
      if (this.ctx.body && typeof this.ctx.body.interrupt === 'function') {
        this.ctx.body.interrupt(`task ${handle.id} ${reason}`);
      }
    } catch {}
    const settled = await Promise.race([
      handle.settle.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), SETTLE_TIMEOUT_MS))
    ]);
    if (!settled) {
      this.log.warn(`task ${handle.id} did not settle after ${reason}; continuing anyway`);
    }
  }

  _settle(handle, result) {
    const ms = Date.now() - handle.startedAt;
    const interrupted = handle.interruptReason;
    const ok = !!(result && result.ok !== false) && !interrupted;
    const info = {
      taskId: handle.id,
      name: handle.name,
      description: handle.description,
      source: handle.source,
      ok,
      reason: (result && (result.reason || result.detail)) || null,
      failure: (result && result.failure) || (interrupted ? 'interrupted' : null),
      hint: (result && result.hint) || null,
      ms,
      replacedBy: handle.replacedBy || null,
      interrupted,
      result: result || null
    };

    if (this.current === handle) this.current = null;
    this._hold(false, `${handle.id} settled`);
    this.history.push({
      id: handle.id,
      name: handle.name,
      ok,
      ms,
      at: Date.now(),
      reason: info.reason,
      interrupted
    });
    if (this.history.length > 20) this.history.shift();
    handle.resolveSettle(info);
    this.trace({ kind: 'task-finished', id: handle.id, name: handle.name, ok, ms, interrupted, reason: info.reason });
    this.log.info(
      `task ${handle.id} ${ok ? 'done' : interrupted ? `stopped (${interrupted})` : 'failed'} in ${ms}ms` +
        (info.reason ? `: ${String(info.reason).slice(0, 120)}` : '')
    );

    /** The same events the brain's own tasks emit; the LLM/proactive wiring consumes them. */
    try {
      if (this.ctx.brain && typeof this.ctx.brain.emit === 'function') {
        this.ctx.brain.emit(ok ? 'task:done' : 'task:failed', info);
      }
    } catch {}
  }

  _hold(on, note) {
    const brain = this.ctx.brain;
    if (!brain || typeof brain.hold !== 'function' || typeof brain.release !== 'function') return;
    try {
      if (on) brain.hold('task', note);
      else brain.release('task');
    } catch {}
  }
}

module.exports = { TaskHub };
