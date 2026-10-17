'use strict';

/**
 * Code-skill generation contract (P1 M4, A18).
 *
 * The coding backend is injected. This module owns the part that must not depend on which
 * model or harness generated the code:
 *
 *   1. the returned manifest must pass `validateManifest()`;
 *   2. the source must stay under a size limit;
 *   3. the source is scanned for the things a generated skill must never contain:
 *      `require`, `import`, `eval`, `new Function`, `process`, `globalThis`, network APIs,
 *      and obvious unbounded loops;
 *   4. the source must export a `run` entry point.
 *
 * It **never executes or compiles the code** - no `import()`, no `vm`, no `new Function`.
 * A passing result still goes through `CodeSkillStore.addCandidate()` and the normal trial
 * gate before it can be promoted.
 */

const { validateManifest } = require('./manifest');

const FORBIDDEN = [
  { pattern: /\brequire\s*\(/, reason: 'require-not-allowed' },
  { pattern: /\bimport\s+/, reason: 'import-not-allowed' },
  { pattern: /\beval\s*\(/, reason: 'eval-not-allowed' },
  { pattern: /\bnew\s+Function\s*\(/, reason: 'function-constructor-not-allowed' },
  { pattern: /\bprocess\b/, reason: 'process-not-allowed' },
  { pattern: /\bglobalThis\b/, reason: 'global-access-not-allowed' },
  { pattern: /\bfetch\s*\(/, reason: 'network-not-allowed' },
  { pattern: /\bXMLHttpRequest\b/, reason: 'network-not-allowed' },
  { pattern: /\bWebSocket\b/, reason: 'network-not-allowed' },
  { pattern: /\bwhile\s*\(\s*(?:true|1)\s*\)/, reason: 'unbounded-loop-suspected' },
  { pattern: /\bfor\s*\(\s*;\s*;\s*\)/, reason: 'unbounded-loop-suspected' }
];

/**
 * @param {string} code
 * @param {object} [options] { maxBytes }
 * @returns {{ok:boolean, bytes:number, errors:Array<{reason:string, line?:number}>}}
 */
function scanCode(code, options = {}) {
  const maxBytes = options.maxBytes || 64 * 1024;
  const source = String(code || '');
  const bytes = Buffer.byteLength(source);
  const errors = [];
  if (!source.trim()) return { ok: false, bytes, errors: [{ reason: 'empty-code' }] };
  if (bytes > maxBytes) return { ok: false, bytes, errors: [{ reason: 'too-large', maxBytes }] };
  for (const { pattern, reason } of FORBIDDEN) {
    const match = pattern.exec(source);
    if (match) {
      const line = source.slice(0, match.index).split('\n').length;
      errors.push({ reason, line });
    }
  }
  if (!/module\.exports/.test(source) || !/\brun\b/.test(source)) {
    errors.push({ reason: 'missing-run-export' });
  }
  return { ok: errors.length === 0, bytes, errors };
}

class CodeSkillGenerator {
  /**
   * @param {object} deps { generate, maxBytes }
   *   generate({prompt, manifest}) -> string | {code, manifest}
   */
  constructor(deps = {}) {
    this.generate = deps.generate || null;
    this.maxBytes = deps.maxBytes || 64 * 1024;
  }

  /**
   * @param {string} prompt
   * @param {object} [options] { manifest }
   * @returns {Promise<{ok:boolean, reason?:string, manifest?:object, code?:string, bytes?:number, errors?:Array}>}
   */
  async propose(prompt, options = {}) {
    if (typeof this.generate !== 'function') return { ok: false, reason: 'no-generator' };
    if (!prompt || !String(prompt).trim()) return { ok: false, reason: 'empty-prompt' };

    let raw;
    try {
      raw = await this.generate({ prompt, manifest: options.manifest || null });
    } catch (err) {
      return { ok: false, reason: 'generation-failed', error: err.message };
    }
    const code = typeof raw === 'string' ? raw : raw && raw.code;
    const manifest = (raw && typeof raw === 'object' && raw.manifest) || options.manifest || null;
    if (!code) return { ok: false, reason: 'empty-code' };

    const validation = validateManifest(manifest);
    if (!validation.ok) return { ok: false, reason: 'invalid-manifest', errors: validation.errors };
    const scan = scanCode(code, { maxBytes: this.maxBytes });
    if (!scan.ok) return { ok: false, reason: 'unsafe-code', errors: scan.errors };

    return { ok: true, manifest, code, bytes: scan.bytes };
  }

  /** Register a passing proposal as a candidate (never promotes it). */
  register(store, proposal, options = {}) {
    if (!proposal || !proposal.ok) return proposal || { ok: false, reason: 'proposal-required' };
    if (!store || typeof store.addCandidate !== 'function') return { ok: false, reason: 'store-required' };
    return store.addCandidate(proposal.manifest, {
      source: options.source || 'generated',
      tests: null
    });
  }
}

module.exports = { CodeSkillGenerator, scanCode, FORBIDDEN };
