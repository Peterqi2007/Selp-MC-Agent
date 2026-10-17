'use strict';

/**
 * Restricted runner contract for code skills (P1 M4, A19).
 *
 * This class prepares a run; it **never executes code**. There is no `child_process`, no
 * `vm`, no `import()` here. P1 requires a restricted runtime with timeouts, cancellation and
 * evidence, and that is a separate, client-window deliverable (A19). Until then the honest
 * contract is: validate, return the exact command and limits, and set `executed: false`.
 *
 * A caller cannot use this to run an un-promoted version: the lookup goes through
 * `store.getPromoted()`, permissions must be in the manifest *and* the host allowlist, a
 * failed trial blocks the run, and the timeout has a hard ceiling.
 */

class RestrictedRunner {
  constructor(options = {}) {
    this.maxTimeoutMs = options.maxTimeoutMs || 60000;
    this.allowedPermissions = options.allowedPermissions || null; // null = manifest-only check
  }

  /**
   * @param {object} request { store, name, version?, timeoutMs?, args? }
   * @returns {{ok:boolean, executed:boolean, reason?:string, command?:object, limits?:object}}
   */
  prepare(request = {}) {
    const { store, name, version, timeoutMs = 10000, args = [] } = request;
    if (!store || typeof store.getPromoted !== 'function') return { ok: false, executed: false, reason: 'store-required' };
    if (!name) return { ok: false, executed: false, reason: 'name-required' };

    const promoted = store.getPromoted(name);
    if (!promoted) return { ok: false, executed: false, reason: 'not-promoted' };
    if (version && version !== promoted.version) {
      return { ok: false, executed: false, reason: 'version-mismatch', promoted: promoted.version };
    }

    const candidate = store.getCandidate(name, promoted.version);
    if (!candidate) return { ok: false, executed: false, reason: 'candidate-missing' };
    if (candidate.status === 'quarantined') return { ok: false, executed: false, reason: 'quarantined' };
    if (candidate.status === 'retired') return { ok: false, executed: false, reason: 'retired' };
    if (!candidate.tests || candidate.tests.ok !== true) {
      return { ok: false, executed: false, reason: 'tests-not-passed' };
    }

    const manifest = candidate.manifest;
    if (this.allowedPermissions) {
      for (const permission of manifest.permissions) {
        if (!this.allowedPermissions.has(permission)) {
          return { ok: false, executed: false, reason: `permission-denied:${permission}` };
        }
      }
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > this.maxTimeoutMs) {
      return { ok: false, executed: false, reason: 'timeout-out-of-range', maxTimeoutMs: this.maxTimeoutMs };
    }

    return {
      ok: true,
      executed: false,
      reason: 'dry-run-only',
      command: { entry: manifest.entry, args: Array.isArray(args) ? [...args] : [], cwd: `${name}@${promoted.version}` },
      limits: { timeoutMs, maxTimeoutMs: this.maxTimeoutMs },
      evidence: { name, version: promoted.version, manifestValidated: true }
    };
  }
}

module.exports = { RestrictedRunner };
