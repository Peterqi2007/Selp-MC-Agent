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
    /** Unique task ids: two tasks with the same name must not share an attemptId. */
    this.seq = 0;
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
  /**
   * A04: will this failure be retried? Intermediate retries are not terminal and must not
   * broadcast another `task:failed`; only the last attempt does.
   */
  willRetry(task) {
    const reason = task.result ? task.result.reason : null;
    if (reason && /cancel/i.test(reason)) return false;
    return (task.retries || 0) < (task.maxRetries || 0);
  }

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
    /**
     * Identity is assigned once per task, not derived from the task name. Live M1
     * 2026-10-17: two `go-to` tasks shared `taskId="go-to"` and `attemptId="go-to#0"`,
     * so their events were indistinguishable and looked like duplicate terminals.
     */
    if (!task.taskId) task.taskId = `task-${++this.seq}`;
    /**
     * A task that belongs to a parent plan is settled by the PlanRunner/PlanService, which
     * owns replanning and its budget. TaskSlot's B2 retry loop must NOT run underneath it:
     * live A13 2026-10-18 the plan step failed, the plan published `plan:failed`, and then
     * TaskSlot retried the same body task 1.5s later (`mine` attempt 2/3) - a late action
     * and a late `task:failed` after the plan had already terminated.
     */
    const planOwned = !!(task.planId || task.stepId);
    const held = this.brainTask;
    if (this.busy && held !== task) {
      this.queue.push(task);
      const behind = held ? held.name : this.current ? this.current.kind : 'another owner';
      brain.log.debug(`${task.name} queued behind ${behind}`);
      return { ok: false, status: 'blocked', reason: 'queued behind another owner' };
    }
    const acquired = this.acquire({ kind: 'brain', task, id: task.name, note: `task ${task.name}` });
    if (!acquired.ok) {
      this.queue.push(task);
      brain.log.debug(`${task.name} queued: the body slot is held by ${this.current && this.current.kind}`);
      return { ok: false, status: 'blocked', reason: 'body-busy' };
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
        /**
         * A04: a retry is not a terminal event, but P0 consumers still expect a failure
         * event on the first attempt. Keep the event for compatibility and mark whether it
         * is retrying; exactly one attempt per task carries `terminal:true`.
         */
        const retrying = planOwned ? false : this.willRetry(task);
        this.publish('task:failed', {
          name: task.name,
          reason: res.reason,
          description: task.description,
          source: task.source || 'autonomous',
          level: task.level || null,
          retrying,
          terminal: !retrying
        });
        if (planOwned) {
          brain.log.debug(`${task.name} failed inside plan ${task.planId}; PlanRunner owns retry/replan`);
        } else {
          this.maybeRetry(task);
        }
      }
      /** M1c: the parent plan runner reads the normalized result to classify the step. */
      return res;
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
   *
   * M1 (§1.4.4): the same call also appends to the `TaskEvents` hub with identity fields.
   * SSE, the panel and the ledger read that hub; the listener map stays for the existing
   * LLM/proactive consumers until they migrate.
   */
  publish(event, payload) {
    const brain = this.brain || (this.ctx && this.ctx.brain);
    if (!brain) return;
    /**
     * Failure escalation (mc_step channel): the settle is the one place every task outcome
     * passes, so the ledger records it here and failed events carry the envelope. The gate
     * itself lives at the /command surface; recording every source keeps the signature
     * honest no matter who issued the attempt.
     */
    const escalation = brain.failureEscalation || (brain.ctx && brain.ctx.failureEscalation) || null;
    let enriched = payload;
    if (escalation && typeof escalation.recordTaskSettle === 'function' && (event === 'task:failed' || event === 'task:done')) {
      try {
        const settled = escalation.recordTaskSettle({
          name: payload && payload.name,
          ok: event === 'task:done',
          reason: payload && payload.reason,
          description: payload && payload.description,
          result: payload && payload.result
        });
        if (settled && event === 'task:failed') {
          enriched = {
            ...payload,
            failure: settled.failure,
            class: settled.class,
            retryable: settled.retryable,
            requires: settled.requires,
            next: settled.next,
            hint: settled.hint,
            lookupQuery: settled.lookupQuery || null,
            attempt: settled.attempt || null
          };
        }
      } catch (err) {
        brain.log && brain.log.debug && brain.log.debug(`escalation settle failed: ${err.message}`);
      }
    }
    if (brain.events && typeof brain.events.publish === 'function') {
      const task = this.brainTask;
      brain.events.publish({
        ...enriched,
        type: event,
        taskId: (payload && payload.taskId) || (task ? task.taskId || task.name : null),
        requestId: (payload && payload.requestId) || (task ? task.requestId || null : null),
        planId: (payload && payload.planId) || (task ? task.planId || null : null),
        stepId: (payload && payload.stepId) || (task ? task.stepId || null : null),
        attemptId:
          (payload && payload.attemptId) ||
          (task ? `${task.taskId || task.name}#${task.retries || 0}` : null)
      });
    }
    if (typeof brain.emit === 'function') brain.emit(event, payload);
  }

  /**
   * Persist the failure ledger (A17/R3): strike counts, quarantine windows, the last
   * blocked goal, and the bounded progress/stall counters that feed the zero-progress park.
   *
   * The body owner, queue and in-flight task are deliberately absent: a restart must not
   * resurrect an executor.
   */
  toJSON() {
    return {
      /**
       * Identity counter must survive a restart. Live A13 2026-10-18: after a restart the
       * counter reset and the new task reused `task-1`; its `task:failed` eventId collided
       * with the restored one and TaskEvents silently dropped it. The plan:step still
       * appeared, so the loss looked like "no task event" rather than a duplicate id.
       */
      seq: this.seq,
      failCounts: [...this.failCounts.entries()],
      quarantine: [...this.quarantine.entries()],
      blockedGoal: this.blockedGoal ? { ...this.blockedGoal } : null,
      progressSeen: [...this._progressSeen.entries()],
      stalls: [...this._stalls.entries()]
    };
  }

  restore(data) {
    if (!data || typeof data !== 'object') return false;
    const pairs = (value, predicate) =>
      Array.isArray(value) ? value.filter((entry) => Array.isArray(entry) && entry.length === 2 && predicate(entry[1])) : [];
    const seq = Number(data.seq);
    if (Number.isFinite(seq) && seq >= 0) this.seq = Math.floor(seq);
    this.failCounts = new Map(pairs(data.failCounts, (value) => Number.isFinite(Number(value)) && Number(value) >= 0));
    this.quarantine = new Map(pairs(data.quarantine, (value) => Number.isFinite(Number(value))));
    this.blockedGoal = data.blockedGoal && typeof data.blockedGoal === 'object' ? { ...data.blockedGoal } : null;
    this._progressSeen = new Map(pairs(data.progressSeen, (value) => value !== undefined));
    this._stalls = new Map(pairs(data.stalls, (value) => Number.isFinite(Number(value)) && Number(value) >= 0));
    return true;
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
