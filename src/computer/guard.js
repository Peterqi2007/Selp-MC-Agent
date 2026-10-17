'use strict';

/**
 * ComputerUseGuard - the only path from policy to a GUI executor (P1 M5).
 *
 * `WindowPolicy` answers "may this action run?"; this wrapper makes sure a rejected action
 * never reaches the injected executor:
 *
 *   - `policy.check()` is called first, every time;
 *   - a refusal returns `{executed:false, reason}` and the executor is **not** invoked;
 *   - an allowed action is passed through unchanged and its result is returned;
 *   - a thrown executor is reported as `executor-error` with `executed:true` (the call was
 *     attempted, and the caller needs to know that);
 *   - with no executor wired (the default until F1), nothing can run.
 *
 * The guard is transport-free: the executor is whatever the future client window injects.
 */

class ComputerUseGuard {
  constructor(deps = {}) {
    this.policy = deps.policy || null;
    this.execute = deps.execute || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    if (!this.policy || typeof this.policy.check !== 'function') {
      throw new Error('ComputerUseGuard needs a WindowPolicy');
    }
  }

  /**
   * @param {object} action { kind, windowId, x?, y? }
   * @returns {Promise<{ok:boolean, executed:boolean, reason?:string, result?:any, error?:string}>}
   */
  async act(action = {}) {
    const verdict = this.policy.check(action);
    if (!verdict || verdict.ok !== true) {
      const reason = (verdict && verdict.reason) || 'denied';
      this.log.debug(`computer-use action refused (${reason})`);
      return { ok: false, executed: false, reason };
    }
    if (typeof this.execute !== 'function') {
      return { ok: false, executed: false, reason: 'no-executor' };
    }
    try {
      const result = await this.execute(action);
      return { ok: true, executed: true, result };
    } catch (err) {
      return { ok: false, executed: true, reason: 'executor-error', error: err.message };
    }
  }

  status() {
    return {
      policy: this.policy.status ? this.policy.status() : null,
      hasExecutor: typeof this.execute === 'function'
    };
  }
}

module.exports = { ComputerUseGuard };
