'use strict';

/**
 * TaskSlot - the single body-ownership slot (RETIREMENT S2).
 *
 * Before S2 the agent had two owners for one body: `Brain.activeTask/queue` ran the
 * planner's tasks, and `TaskHub.current` ran long skills. They only coordinated through
 * two checks (`brain.holds.has('task')` in enqueue, `brain.preempt()` in hub.submit), which
 * is PLANNER-REFACTOR Q3: two bookkeepings that can disagree, and a window where the hub
 * starts while the brain's task is still unwinding.
 *
 * This class is the one place that answers "who owns the body right now":
 *
 *   current = { kind: 'brain'|'hub', task?|handle?, id, note, holdsBody, since }
 *
 * - `brain` owners do **not** hold the brain: an explicit directive may still queue behind
 *   them (unchanged P0 behaviour).
 * - `hub` owners set the `task` hold, so `brain.enqueue` refuses non-urgent work and
 *   `slowLoop` stays quiet (unchanged P0 behaviour, now performed by the slot).
 * - The eye/reflex layer is untouched: reflexes still preempt through `brain.preempt()`.
 *
 * S2a (this class) moves ownership and the queue; moving `runTask`'s B1/B2, timeout and
 * event exit into an executor is S2b. Keeping the move in two steps is what lets the
 * existing suites prove "!/do_task byte-equivalent" at each step.
 */
class TaskSlot {
  /**
   * @param {object} ctx agent context (brain is attached after construction)
   * @param {object} [options] { log }
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.log = options.log || { info() {}, warn() {}, debug() {} };
    this.brain = null;
    /** @type {null|{kind:string,id?:string,note?:string,holdsBody?:boolean,since:number}} */
    this.current = null;
    /** The planner's pending tasks. Brain keeps a reference to this same array. */
    this.queue = [];
  }

  get busy() {
    return !!this.current;
  }

  /** The running brain task, if the owner is a planner task. */
  get brainTask() {
    return this.current && this.current.kind === 'brain' ? this.current.task : null;
  }

  /** The running hub handle, if the owner is a background job. */
  get hubHandle() {
    return this.current && this.current.kind === 'hub' ? this.current.handle : null;
  }

  /**
   * Take the body. Fails (does not queue) when another owner already has it: the caller
   * decides whether to queue, refuse or replace.
   *
   * @returns {{ok:boolean, owner?:object, current?:object}}
   */
  acquire(owner) {
    if (!owner || !owner.kind) throw new Error('TaskSlot.acquire needs an owner with a kind');
    if (this.current) return { ok: false, current: this.current };
    const entry = { ...owner, since: Date.now() };
    this.current = entry;
    if (entry.holdsBody) this._hold(true, entry.note || `${entry.kind}:${entry.id || ''}`);
    this.log.debug(`slot acquired by ${entry.kind}:${entry.id || (entry.task && entry.task.name) || ''}`);
    return { ok: true, owner: entry };
  }

  /** Release the body. Only the current owner can release it (identity check). */
  release(owner) {
    if (!this.current) return false;
    if (owner && this.current !== owner) return false;
    const entry = this.current;
    this.current = null;
    if (entry.holdsBody) this._hold(false, 'slot released');
    this.log.debug(`slot released by ${entry.kind}:${entry.id || (entry.task && entry.task.name) || ''}`);
    return true;
  }

  /**
   * Wait (bounded) for the current owner of `kind` to release the body.
   *
   * Used when the hub takes over from a planner task: cancelling is cooperative, so the
   * task may still be unwinding. P1 §1.4.2 #4: never start a second executor before the
   * old one confirms it stopped.
   */
  waitForRelease(kind, timeoutMs = 15000) {
    if (!this.current || (kind && this.current.kind !== kind)) return Promise.resolve(true);
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const tick = () => {
        if (!this.current || (kind && this.current.kind !== kind)) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  /** Drop every queued planner task, returning how many were dropped. */
  clearQueue() {
    const dropped = this.queue.length;
    this.queue.length = 0;
    return dropped;
  }

  _hold(on, note) {
    const brain = this.brain || (this.ctx && this.ctx.brain);
    if (!brain || typeof brain.hold !== 'function' || typeof brain.release !== 'function') return;
    try {
      if (on) brain.hold('task', note);
      else brain.release('task');
    } catch {}
  }
}

module.exports = { TaskSlot };
