'use strict';

const { ContractError, deferred, jsonSafe, errorInfo, boundedOperation } = require('./contracts');
const { capabilityList } = require('./pluginRegistry');

const DEFAULT_READ_CAPABILITIES = Object.freeze(['files:read', 'game:observe']);

/**
 * Bounded independent-session scaffold. A host worker is {run(task,{signal,tools}),
 * abort(reason), dispose?()}. This is NOT process/OS isolation. A worker factory/run
 * which ignores cancellation retains its slot and causes stop to fail closed.
 */
class SubagentScheduler {
  constructor({ gate, broker, workerFactory, maxConcurrent = 2, maxQueued = 8, stopTimeoutMs = 1000, emit = () => {} } = {}) {
    if (!gate || !broker) throw new ContractError('subagent-dependencies-required');
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16 ||
        !Number.isInteger(maxQueued) || maxQueued < 0 || maxQueued > 64) throw new ContractError('invalid-subagent-bounds');
    this.gate = gate; this.broker = broker; this.workerFactory = workerFactory;
    this.maxConcurrent = maxConcurrent; this.maxQueued = maxQueued; this.stopTimeoutMs = stopTimeoutMs;
    this.emit = emit; this.seq = 0; this.jobs = new Map(); this.queue = []; this.active = 0;
    this.workers = new WeakSet();
  }

  spawn({ parentLease, task, capabilities = DEFAULT_READ_CAPABILITIES } = {}) {
    if (!this.gate.isCurrent(parentLease)) throw new ContractError('stale-lease');
    if (typeof this.workerFactory !== 'function') throw new ContractError('subagent-worker-unconfigured');
    const grants = capabilityList(capabilities);
    if (grants.includes('game:control')) throw new ContractError('subagent-game-control-denied');
    if (this.active >= this.maxConcurrent && this.queue.length >= this.maxQueued) throw new ContractError('subagent-queue-full');
    const controller = new AbortController();
    const job = { id: `child-${++this.seq}`, parentLease, task: jsonSafe(task), grants, controller,
      lease: this.gate.child(parentLease, controller.signal), done: deferred(), finished: deferred(),
      state: 'queued', worker: null, resultSettled: false, reserved: false, cancelPromise: null, cleanupErrors: [] };
    job.onParentAbort = () => { this.cancel(job.id, 'parent-cancelled'); };
    parentLease.signal.addEventListener('abort', job.onParentAbort, { once: true });
    this.jobs.set(job.id, job); this.queue.push(job); this._pump();
    return Object.freeze({ id: job.id, done: job.done.promise, cancel: (reason) => this.cancel(job.id, reason) });
  }

  _pump() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift();
      if (!this.gate.isCurrent(job.lease)) {
        this._settleResult(job, { ok: false, error: { code: 'stale-result' } }); this._finish(job); continue;
      }
      ++this.active; job.reserved = true; job.state = 'starting';
      this._run(job).catch((error) => {
        job.cleanupErrors.push(errorInfo(error));
        this._settleResult(job, { ok: false, error: errorInfo(error) }); this._finish(job);
      });
    }
  }

  async _run(job) {
    try {
      const tools = this.broker.bind({ lease: job.lease, capabilities: job.grants, actor: 'subagent' });
      const worker = await this.workerFactory({ id: job.id, signal: job.controller.signal, tools });
      if (!worker || !['object', 'function'].includes(typeof worker) || this.workers.has(worker)) {
        throw new ContractError('independent-worker-required');
      }
      // Own a NEW partial worker before validating it. Never adopt/abort a reused
      // worker, because another job may still own that independent session.
      this.workers.add(worker); job.worker = worker;
      if (typeof worker.run !== 'function' || typeof worker.abort !== 'function') {
        job.initializationFailed = true;
        try { await this._abortWorker(job, 'worker-initialization-failed'); }
        catch (error) { job.cleanupErrors.push(errorInfo(error, 'child-abort-failed')); }
        throw new ContractError('independent-worker-required');
      }
      if (job.controller.signal.aborted || !this.gate.isCurrent(job.lease)) {
        try { await this._abortWorker(job, 'stale-parent'); }
        catch (error) { job.cleanupErrors.push(errorInfo(error, 'child-abort-failed')); }
        return;
      }
      job.state = 'running';
      this.emit(jsonSafe({ type: 'child:start', id: job.id, runId: job.lease.runId }));
      // Keep a slot until the actual worker settles, even when it ignores cancellation.
      const value = await worker.run(job.task, { signal: job.controller.signal, tools });
      this._settleResult(job, this.gate.isCurrent(job.lease)
        ? { ok: true, result: jsonSafe(value) } : { ok: false, error: { code: 'stale-result' } });
    } catch (error) {
      this._settleResult(job, { ok: false, error: this.gate.isCurrent(job.lease) ? errorInfo(error, 'child-failed') : { code: 'stale-result' } });
    } finally {
      if (job.worker && typeof job.worker.dispose === 'function') {
        try { await this._disposeWorker(job); }
        catch (error) { job.cleanupErrors.push(errorInfo(error, 'child-dispose-failed')); }
      }
      if (!job.resultSettled) this._settleResult(job, { ok: false, error: { code: 'stale-result' } });
      this._finish(job);
    }
  }

  _settleResult(job, result) {
    if (job.resultSettled) return;
    job.resultSettled = true;
    const safe = jsonSafe(result); job.done.resolve(safe);
    this.emit(jsonSafe({ type: 'child:end', id: job.id, runId: job.lease.runId, outcome: safe }));
  }

  _abortWorker(job, reason) {
    if (!job.worker) return undefined; // A pending factory remains tracked by finished.
    if (typeof job.worker.abort === 'function') return Promise.resolve(job.worker.abort(reason)).then((result) => {
      if (result && result.ok === false) throw new ContractError('child-abort-refused', errorInfo(result.error).message);
      return result;
    });
    // Invalid workers have not had run called; authoritative disposal may recover
    // them. Without either cleanup method, the job retains its capacity/gate.
    if (job.initializationFailed && typeof job.worker.dispose === 'function') return undefined;
    throw new ContractError('invalid-worker-cleanup');
  }

  _disposeWorker(job) {
    return Promise.resolve(job.worker.dispose()).then((result) => {
      if (result && result.ok === false) throw new ContractError('child-dispose-refused', errorInfo(result.error).message);
      return result;
    });
  }

  _finish(job) {
    if (job.cleanupErrors.length) {
      job.state = 'cleanup-failed';
      job.finished.resolve({ ok: false, error: { code: 'child-cleanup-failed', message: 'Worker cleanup did not confirm a safe stop' } });
      this.emit(jsonSafe({ type: 'child:cleanup-failed', id: job.id, errors: job.cleanupErrors }));
      return;
    }
    job.state = 'done'; this.jobs.delete(job.id);
    job.parentLease.signal.removeEventListener('abort', job.onParentAbort);
    this.queue = this.queue.filter((entry) => entry !== job);
    if (job.reserved) { job.reserved = false; --this.active; }
    job.finished.resolve({ ok: true }); this._pump();
  }

  cancel(id, reason = 'cancelled') {
    const job = this.jobs.get(id);
    if (!job) return Promise.resolve({ ok: true, already: true });
    if (job.cancelPromise) return job.cancelPromise;
    const previousState = job.state;
    job.controller.abort(reason);
    this._settleResult(job, { ok: false, error: { code: 'cancelled', message: String(reason) } });
    if (previousState === 'queued') { this._finish(job); return Promise.resolve({ ok: true }); }
    job.state = 'stopping';
    let abort;
    try { abort = Promise.resolve(this._abortWorker(job, reason)); }
    catch (error) { abort = Promise.reject(error); }
    const confirm = previousState === 'cleanup-failed'
      ? abort.then(async () => {
        if (job.worker && typeof job.worker.dispose === 'function') await this._disposeWorker(job);
        job.cleanupErrors = []; this._finish(job); return { ok: true };
      })
      : Promise.all([abort, job.finished.promise]).then(([, outcome]) => outcome);
    job.cancelPromise = boundedOperation('child.cancel', confirm, this.stopTimeoutMs).then((outcome) => {
      if (!outcome.ok) {
        if (previousState === 'cleanup-failed' && this.jobs.has(job.id)) job.state = 'cleanup-failed';
        this.emit(jsonSafe({ type: 'child:cancel-failed', id: job.id, error: outcome.error }));
      }
      return outcome;
    }).finally(() => { job.cancelPromise = null; });
    return job.cancelPromise;
  }

  async cancelAll(reason = 'parent-stopped') {
    const outcomes = await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id, reason)));
    return { ok: outcomes.every((entry) => entry.ok), outcomes,
      ...(outcomes.some((entry) => !entry.ok) ? { error: { code: 'child-cancel-failed', message: 'A child did not confirm cancellation/cleanup' } } : {}) };
  }

  status() {
    return { active: this.active, queued: this.queue.length,
      unconfirmed: [...this.jobs.values()].filter((job) => job.controller.signal.aborted || job.state === 'cleanup-failed').length,
      maxConcurrent: this.maxConcurrent, maxQueued: this.maxQueued };
  }
}

module.exports = { SubagentScheduler, DEFAULT_READ_CAPABILITIES };
