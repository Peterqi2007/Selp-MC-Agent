'use strict';

const { ContractError, jsonSafe, errorInfo, deferred, withAbort, boundedOperation, boundedValue } = require('./contracts');
const { LeaseGate } = require('./leaseGate');
const { ToolBroker } = require('./toolBroker');
const { PluginRegistry, capabilityList } = require('./pluginRegistry');
const { SubagentScheduler } = require('./subagentScheduler');
const { createGameControlPort, installGameTools } = require('./gameControlPort');

/** Application-owned scaffold. It never starts production DSH/Pi/body/state services. */
class ActionBrainRuntime {
  constructor(options = {}) {
    this.driverFactory = options.driverFactory;
    this.gate = new LeaseGate(); this.listeners = new Set();
    this.seq = 0; this.runSeq = 0; this.phase = 'idle'; this.runId = null; this.goal = null;
    this.current = null; this.driver = null; this.unsafeDrivers = new Set();
    this.stopTimeoutMs = options.stopTimeoutMs || 1000;
    /** A factory that never resolves used to leave a run that could neither start nor stop. */
    this.initTimeoutMs = options.initTimeoutMs || 5000;
    this.defaultTaskMode = options.taskMode === 'async' ? 'async' : 'sync';
    this.taskMode = this.defaultTaskMode;
    this.worldSessionId = options.worldSessionId || null;
    this.paused = null; this.forceStopped = false;
    this.usage = { turns: 0, toolCalls: 0, wallMs: 0 };
    this.inboxSeq = 0; this.inboxSeen = new Set();
    this.stopErrors = []; this.lastError = null; this.stopPromise = null;
    this.plugins = new PluginRegistry(); this.gamePort = createGameControlPort(options.gamePort);
    /**
     * P2 task-event seam: the host owns the task ledger and pushes events here. The runtime
     * keeps no second ledger - it only stamps identity and forwards, so "task finished" has
     * exactly one source of truth (the game/task side).
     */
    if (typeof this.gamePort.onTaskEvent === 'function') {
      this.gamePort.onTaskEvent((event) => {
        const safe = jsonSafe(event);
        if (!safe || typeof safe !== 'object') return;
        if (safe.worldSessionId && this.worldSessionId && safe.worldSessionId !== this.worldSessionId) return;
        this._emit({ ...safe, from: 'game', worldSessionId: safe.worldSessionId || this.worldSessionId });
      });
    }
    this.broker = new ToolBroker({ gate: this.gate, plugins: this.plugins, emit: (event) => this._emit(event) });
    installGameTools(this.broker, this.gamePort);
    this.children = new SubagentScheduler({ gate: this.gate, broker: this.broker,
      workerFactory: options.workerFactory, maxConcurrent: options.maxConcurrent === undefined ? 2 : options.maxConcurrent,
      maxQueued: options.maxQueued === undefined ? 8 : options.maxQueued, stopTimeoutMs: this.stopTimeoutMs,
      emit: (event) => this._emit(event) });
  }

  /** Resolves after confirmed settled/cancelled/failed. UI can keep its returned promise. */
  async start(goal, options = {}) {
    /**
     * P2 stop levels: `stop({force:true})` records an unconfirmed stop so a slow/uncooperative
     * child cannot wedge the loop forever. The main driver must still be confirmed cleaned
     * (`unsafeDrivers` stays a hard block); unconfirmed children stay tracked and are retried
     * by the next stop, not silently forgotten.
     */
    if (this.stopErrors.length || this.unsafeDrivers.size || this.children.status().unconfirmed) {
      const forced = this.forceStopped && !this.unsafeDrivers.size;
      if (!forced) throw new ContractError('stop-recovery-required', 'Retry stop successfully before starting another run');
    }
    if (this.current || this.stopPromise || this.gate.active) throw new ContractError('run-active');
    /**
     * P2 pause: freeze new dispatches without destroying the run/session. The in-flight turn
     * keeps going; pause takes effect at the next start. resume() clears it.
     */
    if (this.paused) throw new ContractError('paused', 'Runtime is paused; call resume() first');
    const taskMode = options.taskMode === 'async'
      || (options.taskMode === undefined && this.defaultTaskMode === 'async') ? 'async' : 'sync';
    if (taskMode === 'async' && (typeof this.gamePort.tasks !== 'function' || typeof this.gamePort.onTaskEvent !== 'function')) {
      throw new ContractError('async-port-required', 'taskMode=async requires gamePort.tasks + gamePort.onTaskEvent');
    }
    if (typeof goal !== 'string' || !goal.trim()) throw new ContractError('goal-required');
    if (typeof this.driverFactory !== 'function') throw new ContractError('driver-unconfigured');
    const grants = capabilityList(options.capabilities || []);
    const lease = this.gate.begin(`run-${++this.runSeq}`);
    const budget = options.budget || (options.deadlineMs ? { deadlineMs: options.deadlineMs } : null);
    const record = { lease, driver: null, finished: deferred(), stopRequested: false, abortOutcome: null,
      brakesDone: null, cleanupErrors: [], phase: 'initializing', budget, startedAt: Date.now(), deadlineTimer: null };
    this.current = record; this.runId = lease.runId; this.goal = jsonSafe(goal);
    this.taskMode = taskMode;
    if (options.worldSessionId) this.worldSessionId = options.worldSessionId;
    this.usage.turns += 1;
    if (this.forceStopped) { this.forceStopped = false; this.stopErrors = []; }
    /**
     * P2 thinking budget: without a deadline a model can think forever and only an operator
     * stop can break it. The timer is the automatic exit; it reuses the normal stop path so
     * the body/inputs/children are released exactly like a manual stop.
     */
    if (budget && Number.isFinite(budget.deadlineMs) && budget.deadlineMs > 0) {
      record.deadlineTimer = setTimeout(() => {
        this._emit({ type: 'run:deadline', runId: lease.runId, epoch: lease.epoch, deadlineMs: budget.deadlineMs });
        this.stop('think-timeout');
      }, budget.deadlineMs);
      /** Deliberately NOT unref'd: a deadline that does not keep the process alive is no deadline. */
    }
    this.phase = 'running'; this.lastError = null;
    this._emit({ type: 'run:start', runId: lease.runId, epoch: lease.epoch, taskMode, worldSessionId: this.worldSessionId });
    return this._run(record, goal, grants);
  }

  async _run(record, goal, grants) {
    const lease = record.lease; let result;
    try {
      // A factory must honor lease.signal. If it does not, stop retains this record and
      // times out; another run is refused until the late driver is aborted and disposed.
      // The factory call itself is bounded: a hung session creation used to hold `current`
      // forever (start refused, stop could not reach a driver that did not exist yet).
      const factory = await boundedValue('driver.factory', () => this.driverFactory({
        lease, tools: this.broker.bind({ lease, capabilities: grants }),
        budget: record.budget, taskMode: this.taskMode, worldSessionId: this.worldSessionId,
        emit: (event) => { if (this.gate.isCurrent(lease)) this._emit({ ...jsonSafe(event), runId: lease.runId, epoch: lease.epoch }); }
      }), this.initTimeoutMs);
      if (!factory.ok) {
        /** Preserve a factory-attached recovery handle so the stop/retry gate still applies. */
        if (factory.cause && factory.cause.cleanupDriver) throw factory.cause;
        throw new ContractError(factory.error.code || 'driver-factory-failed', factory.error.message);
      }
      const driver = factory.value;
      record.driver = driver;
      if (!driver || ['start', 'steer', 'abort', 'dispose'].some((name) => typeof driver[name] !== 'function')) {
        throw new ContractError('invalid-driver', 'Driver start/steer/abort/dispose are mandatory');
      }
      if (!this.gate.isCurrent(lease)) {
        record.abortOutcome = this._operation('late-driver.abort', () => driver.abort('stale-start'));
        const outcome = await record.abortOutcome;
        if (!outcome.ok) record.cleanupErrors.push(outcome);
        result = { ok: false, error: { code: 'stale-result' } };
      } else {
        this.driver = driver; record.phase = 'running';
        const outcome = await withAbort(Promise.resolve().then(() => {
          if (!this.gate.isCurrent(lease)) throw new ContractError('stale-lease');
          return driver.start(goal);
        }), [lease.signal]);
        if (!this.gate.isCurrent(lease)) throw new ContractError('stale-result');
        if (!outcome || outcome.settled !== true) throw new ContractError('driver-not-settled');
        if (outcome.ok === false || ['failed', 'error', 'aborted', 'cancelled'].includes(outcome.outcome)) {
          const failure = errorInfo(outcome.error, outcome.outcome || 'driver-failed');
          throw new ContractError(failure.code, failure.message);
        }
        this.phase = 'settling';
        /**
         * P2 hard-conflict fix: the turn gate and the task gate are two different facts.
         *   sync  (legacy/default) - the turn is only successful once the game reports idle;
         *   async (P2)             - the turn is successful when the MODEL settled; tasks that
         *                            are still running are the normal case and must NOT fail
         *                            the turn (previously `game-not-idle` triggered a stop and
         *                            killed the very task async acceptance had just started).
         */
        if (this.taskMode === 'async') {
          record.phase = 'confirming-turn';
          const openTasks = await this._openTasks(lease);
          const revoked = this.gate.invalidate();
          const children = await this.children.cancelAll('turn-settled'); this.gate.abort(revoked, 'turn-settled');
          if (!children.ok) record.cleanupErrors.push({ name: 'children.cancelAll', ok: false, error: children.error });
          result = { ok: record.cleanupErrors.length === 0, outcome: jsonSafe(outcome), settledScope: 'turn', tasksOpen: openTasks.length };
          this._emit({ type: 'turn:settled', runId: lease.runId, epoch: lease.epoch, tasksOpen: openTasks.length });
        } else {
          record.phase = 'confirming-game-idle';
          // Model idle is not task completion: an accepted asynchronous game plan may remain.
          const idle = await withAbort(Promise.resolve().then(() => this.gamePort.waitForIdle({
            runId: lease.runId, epoch: lease.epoch, worldSessionId: this.worldSessionId, lease, signal: lease.signal
          })), [lease.signal]);
          if (!this.gate.isCurrent(lease)) throw new ContractError('stale-result');
          if (!idle || idle.ok !== true || idle.idle !== true) throw new ContractError('game-not-idle', 'Game adapter did not confirm terminal task/plan evidence');
          const revoked = this.gate.invalidate();
          const children = await this.children.cancelAll('parent-settled'); this.gate.abort(revoked, 'parent-settled');
          if (!children.ok) record.cleanupErrors.push({ name: 'children.cancelAll', ok: false, error: children.error });
          result = { ok: record.cleanupErrors.length === 0, outcome: jsonSafe(outcome), settledScope: 'task' };
        }
      }
    } catch (error) {
      // A factory may expose an internal recovery handle when partial initialization
      // could not confirm cleanup. Keep it under the same stop/retry gate.
      if (error && error.cleanupDriver) {
        record.driver = error.cleanupDriver; this.unsafeDrivers.add(error.cleanupDriver);
      }
      if (!this.gate.isCurrent(lease)) {
        result = { ok: false, error: { code: 'stale-result' } };
      } else {
        this.lastError = errorInfo(error, 'driver-failed');
        this.stop('run-failed'); // Brakes execute synchronously; do not await our own finished promise.
        if (record.brakesDone) await record.brakesDone;
        result = { ok: false, error: this.lastError };
      }
    } finally {
      record.phase = 'disposing';
      if (record.abortOutcome) {
        const aborted = await record.abortOutcome;
        if (!aborted.ok && !record.cleanupErrors.includes(aborted)) record.cleanupErrors.push(aborted);
      }
      const driver = record.driver;
      if (driver && typeof driver.dispose === 'function') {
        const disposed = await this._operation('driver.dispose', () => driver.dispose());
        if (!disposed.ok) record.cleanupErrors.push(disposed);
      } else if (driver) {
        record.cleanupErrors.push({ name: 'driver.dispose', ok: false, error: { code: 'invalid-driver-cleanup', message: 'Invalid driver cannot confirm disposal' } });
      }
      if (record.cleanupErrors.length && driver) this.unsafeDrivers.add(driver);
      for (const failure of record.cleanupErrors) this._emit({ type: 'run:cleanup-failed', operation: failure.name, error: failure.error });
      if (record.cleanupErrors.length) this.stopErrors.push(...record.cleanupErrors);
      if (this.driver === driver) this.driver = null;
      if (this.current === record) this.current = null;
      record.finished.resolve({ ok: record.cleanupErrors.length === 0,
        ...(record.cleanupErrors.length ? { error: { code: 'driver-cleanup-unconfirmed', message: 'Driver cleanup needs a successful retry' } } : {}) });
      if (this.stopErrors.length || this.unsafeDrivers.size || this.children.status().unconfirmed) this.phase = 'stop-failed';
      else if (record.stopRequested) this.phase = result && result.error && result.error.code !== 'stale-result' ? 'failed' : 'stopped';
      else this.phase = result && result.ok ? 'completed' : 'failed';
      /** Wall-clock accounting: needed to prove "the turn took N ms" without log archaeology. */
      this.usage.wallMs += Math.max(0, Date.now() - (record.startedAt || Date.now()));
      if (record.deadlineTimer) { clearTimeout(record.deadlineTimer); record.deadlineTimer = null; }
    }
    if (record.cleanupErrors.length) result = { ok: false, error: { code: 'driver-cleanup-unconfirmed' } };
    this._emit({ type: result && result.ok ? 'run:settled' : 'run:ended', runId: lease.runId, result });
    return jsonSafe(result);
  }

  async steer(message) {
    const lease = this.gate.active; const driver = this.driver; const record = this.current;
    if (!this.gate.isCurrent(lease) || !driver) return { ok: false, error: { code: 'run-not-ready' } };
    if (typeof message !== 'string' || !message.trim()) return { ok: false, error: { code: 'message-required' } };
    try {
      const result = await withAbort(Promise.resolve().then(() => {
        if (!this.gate.isCurrent(lease) || this.current !== record || this.driver !== driver) throw new ContractError('stale-lease');
        return driver.steer(message);
      }), [lease.signal]);
      return this.gate.isCurrent(lease) ? { ok: true, result: jsonSafe(result) } : { ok: false, error: { code: 'stale-result' } };
    } catch (error) { return { ok: false, error: errorInfo(error, 'steer-failed') }; }
  }

  stop(reason = 'operator-stop', options = {}) {
    if (this.stopPromise) return this.stopPromise;
    const force = !!(options && options.force);
    // External brake callbacks/subscribers may synchronously call stop again.
    // Publish the shared confirmation before invoking any of them.
    const confirmation = deferred();
    const shared = confirmation.promise.finally(() => { if (this.stopPromise === shared) this.stopPromise = null; });
    this.stopPromise = shared;
    const old = this.gate.invalidate(); // FIRST: no old call can pass the fence after this line.
    const record = this.current; if (record) record.stopRequested = true;
    this.phase = 'stopping';
    const context = { runId: old ? old.runId : this.runId, reason: String(reason),
      epoch: old ? old.epoch : this.gate.epoch, worldSessionId: this.worldSessionId };
    // Invoke immediately in this order, even when an earlier callback throws or hangs.
    const brakes = [
      this._operation('game.cancel', () => this.gamePort.cancel(context)),
      this._operation('game.releaseInputs', () => this.gamePort.releaseInputs(context)),
      this._operation('children.cancelAll', () => this.children.cancelAll(reason))
    ];
    this.gate.abort(old, reason);
    // SDK aborts LAST, after game brakes and child cancellation have been dispatched.
    if (record && record.driver && typeof record.driver.abort === 'function') {
      record.abortOutcome = this._operation('driver.abort', () => record.driver.abort(reason));
      brakes.push(record.abortOutcome);
    }
    for (const driver of this.unsafeDrivers) {
      if (record && driver === record.driver) continue;
      brakes.push(this._operation('orphan.cleanup', async () => {
        if (typeof driver.abort !== 'function' || typeof driver.dispose !== 'function') throw new ContractError('invalid-driver-cleanup');
        let abortError; let disposeError;
        try {
          const result = await driver.abort(reason);
          if (result && result.ok === false) throw new ContractError('driver-abort-refused', errorInfo(result.error).message);
        } catch (error) { abortError = error; }
        try {
          const result = await driver.dispose();
          if (result && result.ok === false) throw new ContractError('driver-dispose-refused', errorInfo(result.error).message);
        } catch (error) { disposeError = error; }
        if (abortError || disposeError) throw (abortError || disposeError);
        this.unsafeDrivers.delete(driver);
        return { ok: true };
      }));
    }
    const brakesDone = Promise.all(brakes); if (record) record.brakesDone = brakesDone;
    const confirmations = record ? [this._operation('driver.finish', () => record.finished.promise)] : [];
    this._emit({ type: 'run:stopping', runId: context.runId, epoch: this.gate.epoch });
    Promise.all([brakesDone, ...confirmations]).then((groups) => {
      const outcomes = groups.flat();
      this.stopErrors = outcomes.filter((entry) => !entry.ok);
      if (this.unsafeDrivers.size || this.children.status().unconfirmed || this.current) {
        this.stopErrors.push({ name: 'runtime.confirmation', ok: false, error: { code: 'stop-unconfirmed', message: 'Old initialization, worker or session is not confirmed stopped' } });
      }
      /**
       * P2 stop levels: a slow cancel used to leave the runtime permanently refusing to start.
       * `force` records the unconfirmed stop as `force-stopped` so the operator can start a
       * fresh generation, while the errors stay visible (never reported as "stopped clean").
       */
      if (this.stopErrors.length && force) { this.forceStopped = true; this.phase = 'force-stopped'; }
      else this.phase = this.stopErrors.length ? 'stop-failed' : 'stopped';
      this._emit({ type: 'run:stopped', runId: context.runId, ok: !this.stopErrors.length,
        forced: force && this.stopErrors.length > 0, errors: this.stopErrors });
      return jsonSafe({ ok: !this.stopErrors.length, outcomes, errors: this.stopErrors });
    }).then(confirmation.resolve, (error) => {
      this.stopErrors = [{ name: 'runtime.stop', ok: false, error: errorInfo(error) }]; this.phase = 'stop-failed';
      confirmation.resolve(jsonSafe({ ok: false, errors: this.stopErrors }));
    });
    return shared;
  }

  _operation(name, fn) {
    let promise; try { promise = Promise.resolve(fn()); } catch (error) { promise = Promise.reject(error); }
    return boundedOperation(name, promise, this.stopTimeoutMs);
  }

  status() {
    return jsonSafe({ phase: this.phase, runId: this.runId, epoch: this.gate.epoch, goal: this.goal,
      operation: this.current ? this.current.phase : null, unsafeDrivers: this.unsafeDrivers.size,
      children: this.children.status(), lastError: this.lastError, stopErrors: this.stopErrors,
      taskMode: this.taskMode, worldSessionId: this.worldSessionId, paused: this.paused,
      forceStopped: this.forceStopped, usage: this.usage });
  }

  /**
   * P2 pause: freeze new dispatches without tearing down the run/session. The in-flight turn
   * is not interrupted (that is `stop`); it finishes and the next `start` is refused until
   * `resume()`. This is deliberately NOT "stop": stopping destroys context, and operators
   * need a reversible hold ("let me type for a second").
   */
  pause(reason = 'operator-pause') {
    if (this.stopPromise) return { ok: false, error: { code: 'stopping' } };
    if (this.paused) return { ok: true, already: true, paused: this.paused };
    this.paused = { reason: String(reason), at: Date.now() };
    this._emit({ type: 'runtime:paused', reason: this.paused.reason });
    return { ok: true, paused: this.paused };
  }

  resume() {
    if (!this.paused) return { ok: false, error: { code: 'not-paused' } };
    const previous = this.paused; this.paused = null;
    this._emit({ type: 'runtime:resumed', reason: previous.reason });
    return { ok: true, reason: previous.reason };
  }

  /**
   * Boundary seam for the mailbox/wake scheduler: the host calls this after a tool batch
   * returns, which is the ONLY moment buffered events may be handed to the model.
   */
  boundary(detail = {}) {
    this._emit({ type: 'turn:boundary', runId: this.runId, epoch: this.gate.epoch, detail: jsonSafe(detail) });
    return { ok: true };
  }

  /**
   * Inbound event seam (no routing here). Dedupe by `eventId`, stamp `eventId`-less events
   * with a sequence, and drop events from another world session.
   */
  ingest(event) {
    const safe = jsonSafe(event);
    if (!safe || typeof safe !== 'object' || typeof safe.type !== 'string') {
      return { ok: false, error: { code: 'invalid-event' } };
    }
    if (safe.worldSessionId && this.worldSessionId && safe.worldSessionId !== this.worldSessionId) {
      return { ok: false, error: { code: 'stale-world' } };
    }
    const id = typeof safe.eventId === 'string' ? safe.eventId : null;
    if (id) {
      if (this.inboxSeen.has(id)) return { ok: true, duplicate: true };
      this.inboxSeen.add(id);
      if (this.inboxSeen.size > 256) this.inboxSeen.delete(this.inboxSeen.values().next().value);
    }
    this._emit({ ...safe, inboxSeq: ++this.inboxSeq, worldSessionId: safe.worldSessionId || this.worldSessionId });
    return { ok: true, duplicate: false };
  }

  /** Open body tasks reported by the host port (async acceptance evidence). */
  async tasks() {
    const lease = this.gate.active || { runId: this.runId, epoch: this.gate.epoch };
    return jsonSafe(await this._openTasks(lease));
  }

  /** Usage counters for budgets/panels: turns, tool calls and wall clock. */
  usageReport() { return jsonSafe({ ...this.usage, taskMode: this.taskMode }); }

  /**
   * Ask the player and park. Only available when the host injected `gamePort.ask`; the
   * runtime does not invent answers and does not treat "no answer" as consent.
   */
  async ask(question, options = {}) {
    if (typeof this.gamePort.ask !== 'function') throw new ContractError('ask-unavailable', 'Host did not inject gamePort.ask');
    if (typeof question !== 'string' || !question.trim()) throw new ContractError('question-required');
    const lease = this.gate.active;
    if (!this.gate.isCurrent(lease)) throw new ContractError('run-not-ready');
    this.phase = 'waiting-user';
    this._emit({ type: 'run:waiting_player', runId: lease.runId, epoch: lease.epoch, question: jsonSafe(question) });
    const answered = await boundedValue('game.ask', () => this.gamePort.ask({
      question, runId: lease.runId, epoch: lease.epoch, worldSessionId: this.worldSessionId,
      timeoutMs: options.timeoutMs
    }), options.timeoutMs || this.initTimeoutMs);
    this._emit({ type: 'run:answer', runId: lease.runId, ok: answered.ok });
    if (this.gate.isCurrent(lease)) this.phase = 'running';
    if (!answered.ok) throw new ContractError(answered.error.code || 'ask-failed', answered.error.message);
    return { ok: true, answer: jsonSafe(answered.value) };
  }

  /** What a host needs to continue after `restore()`: goal + open tasks + re-observe note. */
  async resumeRequest() {
    const tasks = typeof this.gamePort.tasks === 'function' ? await this.tasks() : [];
    return {
      goal: this.goal, epoch: this.gate.epoch, worldSessionId: this.worldSessionId,
      openTasks: tasks,
      note: this.goal || tasks.length
        ? 're-observe the world and reconcile open tasks before continuing; old tools are not replayed'
        : null
    };
  }

  checkpoint() { return { version: 1, ...this.status() }; }

  restore(checkpoint) {
    if (this.current || this.stopPromise || this.unsafeDrivers.size) throw new ContractError('run-active');
    if (!checkpoint || checkpoint.version !== 1) throw new ContractError('unsupported-checkpoint');
    this.gate.invalidate(); this.phase = 'interrupted';
    this.runId = jsonSafe(checkpoint.runId || null); this.goal = jsonSafe(checkpoint.goal || null);
    this._emit({ type: 'run:interrupted', runId: this.runId, reason: 'restored-no-replay' });
    return this.status();
  }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new ContractError('listener-required');
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }

  async _openTasks(lease) {
    if (typeof this.gamePort.tasks !== 'function') return [];
    const tasks = await this.gamePort.tasks({
      runId: lease && lease.runId, epoch: lease && lease.epoch, worldSessionId: this.worldSessionId
    });
    return Array.isArray(tasks) ? tasks : [];
  }

  _emit(event) {
    if (event && event.type === 'tool:end') this.usage.toolCalls += 1;
    const safe = jsonSafe({ ...event, seq: ++this.seq });
    for (const listener of this.listeners) {
      try { listener(jsonSafe(safe)); } catch (error) { this.lastError = errorInfo(error, 'subscriber-failed'); }
    }
  }
}

module.exports = { ActionBrainRuntime };
