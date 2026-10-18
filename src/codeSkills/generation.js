'use strict';

/**
 * CodeSkillGeneration - the real generation backend for M4.
 *
 * `CodeSkillGenerator` only validates/scans a proposal; it deliberately has no model. This
 * adapter supplies the missing `generate()` function using the same DeepSeek chat client as
 * the rest of the agent, and asks for a strict JSON envelope:
 *
 *     { "manifest": {name, version, apiVersion, entry, description, permissions},
 *       "code": "module.exports = { async run(ctx, params) { ... } }" }
 *
 * The generated code is untrusted. It is only written to `candidates/`, never imported by
 * the Node process, and only ever executed by the sandbox child (see sandboxRunner.js).
 * `CodeSkillGenerator` still re-validates the manifest and statically scans the code before
 * a candidate is registered.
 */

const { parseGeneratedEnvelope } = require('./generator');

const ALLOWED_PERMISSIONS = ['read_state', 'submit_task', 'chat', 'wait', 'search', 'generate', 'subprocess'];

function generationPrompt(prompt, manifest) {
  return [
    'You write one small Minecraft agent code skill as CommonJS JavaScript.',
    'Answer with exactly one JSON object:',
    '{"manifest":{...},"code":"module.exports = { async run(ctx, params) { ... } }"}',
    'Manifest requirements:',
    '- name: namespace.skill (lowercase, dot required)',
    '- version: x.y.z',
    '- apiVersion: 1',
    '- entry: "index.js"',
    `- permissions: subset of ${ALLOWED_PERMISSIONS.join(', ')}`,
    'Runtime contract:',
    '- module.exports = { async run(ctx, params) { ... } }',
    '- ctx may expose only the declared permissions: read_state, submit_task, chat, wait, search, generate, subprocess.',
    '- run() must return a JSON-serializable object.',
    '- No require/import, no fs, no network, no process/globalThis, no eval/Function, no infinite loops.',
    '- Keep it under 300 lines and explain failures honestly in the returned object.',
    manifest ? `Use this manifest exactly (unless a field is missing): ${JSON.stringify(manifest)}` : null,
    '',
    `TASK: ${prompt}`
  ]
    .filter(Boolean)
    .join('\n');
}

function normalizeEnvelope(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const manifest = parsed.manifest && typeof parsed.manifest === 'object' ? parsed.manifest : null;
  const code = typeof parsed.code === 'string' ? parsed.code : null;
  return manifest && code ? { manifest, code } : null;
}

class CodeSkillGeneration {
  /**
   * @param {object} deps { complete, maxTokens, timeoutMs, log }
   *   complete({system,messages,maxTokens,timeoutMs,usageContext}) -> string|{ok,text}
   */
  constructor(deps = {}) {
    this.complete = deps.complete || null;
    this.maxTokens = deps.maxTokens || 2600;
    this.timeoutMs = deps.timeoutMs || 30000;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
  }

  async generate({ prompt, manifest = null, requestId = null } = {}) {
    if (typeof this.complete !== 'function') return { ok: false, reason: 'no-generator' };
    const clean = String(prompt || '').trim();
    if (!clean) return { ok: false, reason: 'empty-prompt' };
    let raw;
    try {
      raw = await this.complete({
        system: generationPrompt(clean, manifest),
        messages: [{ role: 'user', content: clean }],
        maxTokens: this.maxTokens,
        timeoutMs: this.timeoutMs,
        usageContext: {
          requestId: requestId || `code-generation-${Date.now()}`,
          kind: 'code-generation'
        }
      });
    } catch (err) {
      return { ok: false, reason: 'model-error', error: err.message };
    }
    if (raw && typeof raw === 'object' && raw.ok === false) {
      return { ok: false, reason: raw.reason || 'model-error' };
    }
    if (raw && typeof raw === 'object' && typeof raw.text === 'string') raw = raw.text;
    const parsed = parseGeneratedEnvelope(raw);
    const envelope = normalizeEnvelope(parsed);
    if (!envelope) return { ok: false, reason: 'malformed-envelope' };
    return { ok: true, manifest: envelope.manifest, code: envelope.code, raw: String(raw).slice(0, 2000) };
  }
}

module.exports = { CodeSkillGeneration, generationPrompt, normalizeEnvelope, ALLOWED_PERMISSIONS };
