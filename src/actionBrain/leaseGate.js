'use strict';

const { ContractError } = require('./contracts');

/** Runtime authorization fence; deliberately does NOT acquire a second body lock. */
class LeaseGate {
  constructor() { this.epoch = 0; this.active = null; this.issued = new WeakMap(); }

  begin(runId) {
    if (this.active) throw new ContractError('run-active');
    const controller = new AbortController();
    const lease = Object.freeze({ runId, epoch: ++this.epoch, signal: controller.signal });
    this.issued.set(lease, { root: lease, controller });
    this.active = lease;
    return lease;
  }

  child(parent, signal) {
    if (!this.isCurrent(parent)) throw new ContractError('stale-lease');
    const lease = Object.freeze({ runId: parent.runId, epoch: parent.epoch, signal: signal || parent.signal });
    this.issued.set(lease, { root: this.issued.get(parent).root });
    return lease;
  }

  isCurrent(lease) {
    const record = lease && this.issued.get(lease);
    return !!(record && this.active === record.root && lease.epoch === this.epoch && !lease.signal.aborted && !record.root.signal.aborted);
  }

  /** Synchronous invalidation FIRST. Abort is separate to preserve emergency-stop order. */
  invalidate() {
    const old = this.active;
    this.active = null;
    ++this.epoch;
    return old;
  }

  abort(lease, reason = 'stopped') {
    const record = lease && this.issued.get(lease);
    if (record && record.controller && !record.controller.signal.aborted) record.controller.abort(reason);
  }
}

module.exports = { LeaseGate };
