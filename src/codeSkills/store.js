'use strict';

/**
 * Candidate / promoted code-skill lifecycle (P1 M4, A18/A20).
 *
 * The directory split in the plan has a state-machine counterpart:
 *
 *     generated -> candidate -> trialled -> promoted
 *                        \-> quarantined (failed trial; never promoted)
 *     promoted -> rolled back to the previous version, or retired
 *
 * Rules enforced here:
 *   - only a *trialled* candidate with a passing report may be promoted;
 *   - a quarantined candidate can never be promoted under the same version;
 *   - promotion remembers the previous version, so `rollback()` is exact;
 *   - `retire()` removes a version from distribution and prevents re-promotion;
 *   - `getPromoted()` is the only lookup a runner may use, so un-promoted candidates are
 *     never visible to normal dispatch.
 *
 * This store only tracks metadata; it never imports the entry file.
 */

const { validateManifest } = require('./manifest');

class CodeSkillStore {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    /** key name@version -> { manifest, status, tests, source, createdAt, at } */
    this.candidates = new Map();
    /** name -> { version, previous, at } */
    this.promoted = new Map();
    this.history = [];
  }

  static key(name, version) {
    return `${name}@${version}`;
  }

  addCandidate(manifest, options = {}) {
    const validation = validateManifest(manifest);
    if (!validation.ok) return { ok: false, reason: 'invalid-manifest', errors: validation.errors };
    const key = CodeSkillStore.key(manifest.name, manifest.version);
    if (this.candidates.has(key)) return { ok: false, reason: 'duplicate-version', key };
    const record = {
      manifest: { ...manifest, permissions: [...(manifest.permissions || [])] },
      status: 'candidate',
      source: options.source || 'generated',
      tests: options.tests || null,
      createdAt: new Date(this.now()).toISOString()
    };
    this.candidates.set(key, record);
    this.history.push({ at: record.createdAt, action: 'candidate', key });
    return { ok: true, key, record: this.view(record) };
  }

  /** Record the result of a trial run. A failure quarantines the candidate. */
  recordTrial(name, version, report = {}) {
    const record = this.candidates.get(CodeSkillStore.key(name, version));
    if (!record) return { ok: false, reason: 'unknown-candidate' };
    record.tests = { ok: report.ok === true, report: report.report || null, at: new Date(this.now()).toISOString() };
    record.status = report.ok === true ? 'trialled' : 'quarantined';
    this.history.push({ at: record.tests.at, action: record.status, key: `${name}@${version}` });
    return { ok: true, status: record.status };
  }

  /**
   * Promote a trialled candidate. Returns the previous promoted version (or null).
   */
  promote(name, version) {
    const key = CodeSkillStore.key(name, version);
    const record = this.candidates.get(key);
    if (!record) return { ok: false, reason: 'unknown-candidate' };
    if (record.status === 'retired') return { ok: false, reason: 'retired' };
    if (record.status === 'quarantined') return { ok: false, reason: 'quarantined' };
    if (record.status !== 'trialled' || !record.tests || record.tests.ok !== true) {
      return { ok: false, reason: 'not-trialled' };
    }
    const current = this.promoted.get(name);
    this.promoted.set(name, {
      version,
      previous: current ? current.version : null,
      at: new Date(this.now()).toISOString()
    });
    record.status = 'promoted';
    this.history.push({ at: new Date(this.now()).toISOString(), action: 'promoted', key });
    return { ok: true, key, previous: current ? current.version : null };
  }

  /** Return to the previous promoted version; with no previous, stop distributing it. */
  rollback(name) {
    const current = this.promoted.get(name);
    if (!current) return { ok: false, reason: 'not-promoted' };
    if (!current.previous) {
      this.promoted.delete(name);
      this.history.push({ at: new Date(this.now()).toISOString(), action: 'unpromoted', key: `${name}@${current.version}` });
      return { ok: true, version: null, rolledBackFrom: current.version };
    }
    const previous = current.previous;
    this.promoted.set(name, { version: previous, previous: null, at: new Date(this.now()).toISOString() });
    this.history.push({ at: new Date(this.now()).toISOString(), action: 'rollback', key: `${name}@${previous}` });
    return { ok: true, version: previous, rolledBackFrom: current.version };
  }

  /** Retire a version: it is no longer distributable and cannot be promoted again. */
  retire(name, version) {
    const key = CodeSkillStore.key(name, version);
    const record = this.candidates.get(key);
    if (!record) return { ok: false, reason: 'unknown-candidate' };
    record.status = 'retired';
    const current = this.promoted.get(name);
    if (current && current.version === version) this.promoted.delete(name);
    this.history.push({ at: new Date(this.now()).toISOString(), action: 'retired', key });
    return { ok: true };
  }

  getPromoted(name) {
    return this.promoted.get(name) || null;
  }

  getCandidate(name, version) {
    return this.candidates.get(CodeSkillStore.key(name, version)) || null;
  }

  list() {
    return [...this.candidates.entries()].map(([key, record]) => ({ key, ...this.view(record) }));
  }

  view(record) {
    return {
      manifest: { ...record.manifest, permissions: [...record.manifest.permissions] },
      status: record.status,
      tests: record.tests,
      source: record.source,
      createdAt: record.createdAt
    };
  }

  /**
   * Persist metadata for the live service. The entry code lives in CodeSkillDirectory;
   * this file only carries lifecycle state (status/trial reports/promoted pointers).
   */
  toJSON() {
    return {
      candidates: [...this.candidates.entries()].map(([key, record]) => [key, {
        manifest: record.manifest,
        status: record.status,
        source: record.source,
        tests: record.tests,
        createdAt: record.createdAt
      }]),
      promoted: [...this.promoted.entries()],
      history: this.history.slice(-200)
    };
  }

  restore(data) {
    if (!data || typeof data !== 'object') return false;
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const promoted = Array.isArray(data.promoted) ? data.promoted : [];
    this.candidates.clear();
    this.promoted.clear();
    for (const entry of candidates) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, record] = entry;
      if (!record || !record.manifest || !validateManifest(record.manifest).ok) continue;
      this.candidates.set(key, {
        manifest: { ...record.manifest, permissions: [...(record.manifest.permissions || [])] },
        status: record.status || 'candidate',
        source: record.source || 'restored',
        tests: record.tests || null,
        createdAt: record.createdAt || new Date(this.now()).toISOString()
      });
    }
    for (const entry of promoted) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [name, pointer] = entry;
      if (!pointer || typeof pointer.version !== 'string') continue;
      this.promoted.set(name, { ...pointer });
    }
    this.history = Array.isArray(data.history) ? data.history.slice(-200) : [];
    return true;
  }
}

module.exports = { CodeSkillStore };
