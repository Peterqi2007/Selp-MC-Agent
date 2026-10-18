'use strict';

/**
 * CuPreflight - the gate the real computer_use bridge is supposed to call (P1 M5 / F1).
 *
 * Why this file exists: the packed DSH plugin talks to the helper directly, and `WindowPolicy`
 * was never on that path - nothing imported it, so the offline contract proved nothing about
 * the live `computer_use_*` tools (see docs/P1-M5.md §5.4). This adapter is the single place to
 * wire it in:
 *
 *   act(request)      -> guard.act(request)      -> policy.check()      - refusals never execute
 *   observe(request)  -> guard.observe(request)  -> policy.checkObserve() - read-only, unique candidate
 *   resolveRect(id)   -> helper rect, then Win32/DWM - validated window first, never screenshot pixels
 *
 * Honest scope: until a host adapter actually calls this module, the live tools are still
 * gated only by the helper's own authorization. Implementing this file does not, by itself,
 * make F1 pass - it makes the gate *available* and testable offline.
 */

const { ComputerUseGuard } = require('./guard');
const { resolveRect } = require('./windowRect');

class CuPreflight {
  constructor({ policy, execute, rectProviders = [], log } = {}) {
    if (!policy) throw new Error('CuPreflight needs a WindowPolicy');
    this.log = log || { info() {}, warn() {}, debug() {} };
    this.policy = policy;
    this.rectProviders = rectProviders;
    this.guard = new ComputerUseGuard({ policy, execute, log: this.log });
  }

  /** Act path: policy.check() runs first; a refusal never reaches the executor. */
  async act(request = {}) {
    return this.guard.act(request);
  }

  /** Read-only path: unique candidate window only until F1 evidence verifies the target. */
  async observe(request = {}) {
    return this.guard.observe(request);
  }

  /**
   * Read-only geometry for `windowId`. The window itself is validated before any provider is
   * asked, so this can never be used to probe the geometry of an arbitrary window.
   */
  async resolveRect(windowId) {
    const verdict = this.policy.checkObserve({ kind: 'screenshot', windowId });
    if (!verdict.ok) return { ok: false, reason: verdict.reason, attempts: [] };
    return resolveRect({ providers: this.rectProviders, windowId, log: this.log });
  }

  status() {
    return {
      guard: this.guard.status(),
      candidate: this.policy.candidateStatus ? this.policy.candidateStatus() : null,
      rectProviders: (this.rectProviders || []).map((provider) => (provider && provider.name) || 'unknown')
    };
  }
}

module.exports = { CuPreflight };
