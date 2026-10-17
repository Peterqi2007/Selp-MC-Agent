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
    /** B1/B2 state (moved from Brain in S2b). */
    this.blockedGoal = null;
    this.quarantine = new Map();
    this.failCounts = new Map();
    this._progressSeen = new Map();
    this._stalls = new Map();
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

  /** B1 state: per-goal last-seen progress and stall counters (moved here in S2b). */
  noteProgress(task) {
    const value = typeof task.progress === 'function' ? safeCall(() => task.progress()) : null;
    if (value === null || value === undefined) {
      this._progressSeen.delete(task.name);
      return;
    }
    const previous = this._progressSeen.get(task.name);
    if (previous !== undefined && previous === value) {
      const stalls = (this._stalls.get(task.name) || 0) + 1;
      this._stalls.set(task.name, stalls);
      if (stalls >= 2 && !this.isQuarantined(task.name)) {
        this.brain.log.warn(`${task.name} made no progress (${value}) for ${stalls} runs - parking it briefly`);
        this.quarantine.set(task.name, Date.now() + 30000);
        this._stalls.delete(task.name);
        /** P8: the zero-progress park is one of the two producers of this event. */
        this.publish('task:quarantined', {
          name: task.name,
          reason: 'no-progress',
          value,
          stalls,
          until: this.quarantine.get(task.name),
          source: task.source || 'autonomous'
        });
      }
    } else {
      this._stalls.delete(task.name);
    }
    this._progressSeen.set(task.name, value);
  }

  /** True while a goal is parked (keyed on the TASK name, never the rule's). */
  isQuarantined(name) {
    const until = this.quarantine.get(name);
    if (!until) return false;
    if (Date.now() > until) {
      this.quarantine.delete(name);
      return false;
    }
    return true;
  }

  /** B2 (strike backoff): retry a failed task or park the goal with a growing window. */
  maybeRetry(task) {
    const brain = this.brain;
    const reason = task.result ? task.result.reason : null;
    /**
     * Never resurrect deliberate cancellation. `preempt()`, `pause()` and the post-death
     * stop all cancel the running task; a retry would quietly undo exactly what the user
     * just asked for.
     */
    if (reason && /cancel/i.test(reason)) {
      brain.log.debug(`${task.name} was cancelled - not retrying`);
      brain.drainQueue();
      return;
    }
    if (task.retries >= task.maxRetries) {
      brain.log.warn(`${task.name} exhausted retries`);
      this.blockedGoal = { name: task.name, at: Date.now(), reason: task.result ? task.result.reason : null };
      this.failCounts.set(task.name, (this.failCounts.get(task.name) || 0) + 1);
      const strikes = this.failCounts.get(task.name);
      const windowMs = Math.min(120000, 20000 * strikes);
      this.quarantine.set(task.name, Date.now() + windowMs);
      brain.log.debug(`${task.name} quarantined for ${Math.round(windowMs / 1000)}s (strike ${strikes})`);
      this.publish('task:quarantined', {
        name: task.name,
        reason: 'strikes',
        strikes,
        until: this.quarantine.get(task.name),
        source: task.source || 'autonomous'
      });
      brain.drainQueue();
      return;
    }
    task.retries += 1;
    task.state = 'pending';
    brain.log.info(`retrying ${task.name} (attempt ${task.retries + 1})`);
    setTimeout(() => {
      if (brain.running && !brain.paused && !brain.stopped) {
        brain.runTask(task).catch((e) => brain.log.debug(`retry failed: ${e.message}`));
      }
    }, 1500);
  }

  /**
   * Run one planner task (RETIREMENT S2b): the slot owns execution, settlement, B1/B2 and
   * the task lifecycle events. `brain.runTask()` is now a delegate.
   */
  async runTask(task) {
    const brain = this.brain;
    if (!brain) throw new Error('TaskSlot.runTask needs a brain');
    const held = this.brainTask;
    if (this.busy && held !== task) {
      this.queue.push(task);
      const behind = held ? held.name : this.current ? this.current.kind : 'another owner';
      brain.log.debug(`${task.name} queued behind ${behind}`);
      return;
    }
    const acquired = this.acquire({ kind: 'brain', task, id: task.name, note: `task ${task.name}` });
    if (!acquired.ok) {
      this.queue.push(task);
      brain.log.debug(`${task.name} queued: the body slot is held by ${this.current && this.current.kind}`);
      return;
    }
    const owner = acquired.owner;
    try {
      await task.execute();
      const res = task.result || { ok: false, reason: 'no result' };
      if (res.ok) {
        brain.log.info(`done ${task.name}: ${res.reason}`);
        brain.completedGoals.push({ name: task.name, reason: res.reason, at: Date.now() });
        if (brain.completedGoals.length > 50) brain.completedGoals.shift();
        if (task.name === 'shelter') {
          const pos = brain.ctx.body.snapshot();
          if (pos && pos.position) brain.ctx.memory.rememberLandmark('shelter', { ...pos.position });
        }
        brain.ctx.memory.bump(`task:${task.name}:ok`);
        this.noteProgress(task);
        this.publish('task:done', {
          name: task.name,
          reason: res.reason,
          description: task.description,
          source: task.source || 'autonomous',
          level: task.level || null
        });
      } else {
        brain.log.warn(`failed ${task.name}: ${res.reason}`);
        brain.ctx.memory.bump(`task:${task.name}:fail`);
        this.publish('task:failed', {
          name: task.name,
          reason: res.reason,
          description: task.description,
          source: task.source || 'autonomous',
          level: task.level || null
        });
        this.maybeRetry(task);
      }
    } finally {
      this.release(owner);
      /**
       * Pick up anything queued while this task ran. Without it, a command issued during
       * a long task waits for the next planning tick.
       */
      if (this.queue.length && brain.running && !brain.paused && !brain.stopped) {
        setTimeout(() => {
          brain.drainQueue().catch((err) => brain.log.debug(`drain after task: ${err.message}`));
        }, 0);
      }
    }
  }

  /**
   * The single event exit (S2b): both planner tasks and hub jobs publish through here, so
   * "two places emit the same completion" cannot come back.
   */
  publish(event, payload) {
    const brain = this.brain || (this.ctx && this.ctx.brain);
    if (brain && typeof brain.emit === 'function') brain.emit(event, payload);
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

/** Call a function that might throw, returning null instead of propagating (B1 reads task state). */
function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
