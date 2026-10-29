'use strict';

/**
 * CodeSkillGeneration - the real generation backend for M4 (v3: input-layer scripts).
 *
 * `CodeSkillGenerator` only validates/scans a proposal; it deliberately has no model. This
 * adapter supplies the missing `generate()` function using the same DeepSeek chat client as
 * the rest of the agent, and asks for a strict JSON envelope:
 *
 *     { "manifest": {name, version, apiVersion:3, entry, description,
 *                    preconditions, verification, permissions},
 *       "code": "module.exports = { async run(ctx, params) { ... } }" }
 *
 * What a v3 skill may do is keyboard/mouse work: press/hold/tap keys, look, open and read a
 * menu, click slots, close it, select/use an item, plus read-only observation. It may not call
 * `body_move/body_dig/...` (those belong to the deterministic skills) - the capability table
 * and the static scan both enforce that.
 *
 * `feedback` is the Voyager-style repair channel: the previous attempt's *verbatim* failure
 * (reason, stack, stderr tail, refused calls, verifier output) and its code are rendered into
 * the prompt so the model repairs instead of starting over.
 *
 * The generated code is untrusted. It is only written to `candidates/`, never imported by
 * the Node process, and only ever executed by the sandbox child (see sandboxRunner.js).
 * `CodeSkillGenerator` still re-validates the manifest and statically scans the code before
 * a candidate is registered.
 */

const { parseGeneratedEnvelope } = require('./generator');
const { ALLOWED_PERMISSIONS, INPUT_PERMISSIONS } = require('./manifest');

const PERMISSION_LIST = [...INPUT_PERMISSIONS, 'read_state', 'wait', 'chat'];
const CONDITION_LIST = ['inventoryAtLeast', 'positionNear', 'blockAt', 'targetIs'];

const INPUT_METHODS = [
  'state(args?)                          // {ok, position, health, food, dimension, screen, target, inventory, ...}',
  'block_at({x,y,z})                     // read-only single block',
  'find_blocks({name|names, radiusXZ?, radiusY?, limit?})',
  'key(action, down)                     // hold/release: forward/back/left/right/jump/sprint/sneak/use/attack',
  'hold(action, ms)                      // bounded press (server clamps to 10s)',
  'tap(action)                           // toggle keys: inventory/drop/chat/swapoffhand/pickitem',
  'look(yaw, pitch) / look_at({x,y,z})',
  'menu()                                // current screen + slots (read BEFORE clicking)',
  'click({slot, button?, mode?})         // container/inventory slot click',
  'close()                               // close the open screen',
  'select({item})                        // put an inventory item into the hand',
  'use_on({x,y,z,face?,item?})           // right-click a block face',
  'target()                              // crosshair raycast result',
  'inputs()                              // input ledger: what is still held',
  'pillar({count:1})                     // ONE tick-accurate jump+place hop (needs a block in hand);',
  '                                      // count>1 is refused by the permission gate - loop these single hops',
  'wait(ms)',
  'chat(text)                            // speak one short line'
];

function feedbackBlock(feedback) {
  if (!feedback || typeof feedback !== 'object') return null;
  const lines = [];
  lines.push('');
  lines.push(`PREVIOUS ATTEMPT FAILED (round ${feedback.round || '?'}/${feedback.maxRounds || '?'}`
    + `${feedback.version ? `, version ${feedback.version}` : ''}).`);
  if (feedback.reason) lines.push(`reason: ${feedback.reason}`);
  if (feedback.stack) {
    lines.push('stack (verbatim):');
    lines.push(String(feedback.stack).slice(0, 1800));
  }
  if (feedback.stderr) {
    lines.push('sandbox stderr (verbatim, tail):');
    lines.push(String(feedback.stderr).slice(-1800));
  }
  if (Array.isArray(feedback.failedCalls) && feedback.failedCalls.length) {
    lines.push('refused/failed calls (verbatim):');
    for (const call of feedback.failedCalls.slice(0, 8)) {
      lines.push(`- ${call.capability}(${call.argsBytes || 0}B) -> ${call.error}`);
    }
  }
  if (feedback.result && typeof feedback.result === 'object') {
    lines.push('the skill itself returned (verbatim, truncated):');
    lines.push(JSON.stringify(feedback.result).slice(0, 800));
  }
  if (feedback.verificationFailures && feedback.verificationFailures.length) {
    lines.push('verification failures (JSON):');
    lines.push(JSON.stringify(feedback.verificationFailures).slice(0, 1200));
  }
  if (feedback.manifestErrors && feedback.manifestErrors.length) {
    lines.push(`manifest errors: ${feedback.manifestErrors.join(', ')}`);
  }
  if (feedback.scanErrors && feedback.scanErrors.length) {
    lines.push(`static-scan errors: ${JSON.stringify(feedback.scanErrors).slice(0, 800)}`);
  }
  if (feedback.code) {
    lines.push('previous code (verbatim, may be truncated):');
    lines.push('```js');
    lines.push(String(feedback.code).slice(0, 6000));
    lines.push('```');
  }
  lines.push('Repair ONLY what caused the failure, keep what already works, and answer with one');
  lines.push('complete JSON object again. The server assigns the version; do not try to reuse it.');
  return lines.join('\n');
}

function generationPrompt(prompt, manifest, feedback = null) {
  return [
    'You write ONE small Minecraft agent skill as CommonJS JavaScript: a keyboard/mouse script.',
    'Answer with exactly one JSON object:',
    '{"manifest":{...},"code":"module.exports = { async run(ctx, params) { ... } }"}',
    '',
    'MANIFEST (apiVersion 3 = input-layer script):',
    '- name: namespace.skill (lowercase, dot required)',
    '- version: x.y.z (the server may bump it; keep semver syntax)',
    '- apiVersion: 3',
    '- entry: "index.js"',
    '- description: 10-500 characters. This is the RETRIEVAL KEY - say what the skill does and',
    '  when it should be used, in plain language (Chinese or English). A vague description makes',
    '  the skill unfindable.',
    '- preconditions: object using only these keys (may be {} when there is nothing to require):',
    `  ${CONDITION_LIST.join(', ')}`,
    '- verification: NON-EMPTY object with the same keys. A skill that cannot falsify itself is',
    '  rejected. Example: {"inventoryAtLeast":{"minecraft:dirt":1}} or',
    '  {"targetIs":{"name":"minecraft:crafting_table"}} or',
    '  {"blockAt":{"position":{"x":1,"y":64,"z":2},"block":"minecraft:air"}}',
    '- permissions: subset of',
    `  ${PERMISSION_LIST.join(', ')}`,
    '',
    'RUNTIME CONTRACT:',
    '- module.exports = { async run(ctx, params) { ... } }',
    '- ctx exposes only what you declared:',
    INPUT_METHODS.map((line) => `  ${line}`).join('\n'),
    '- EVERY action returns {ok:boolean, ...}; a refusal (e.g. {ok:false, reason:"blockedByScreen"})',
    '  is a real failure: stop and return it instead of pretending the action happened.',
    '- GUI work: `await ctx.state()` first; toggle with `ctx.tap("inventory")`, `await ctx.wait(250)`,',
    '  then `menu()`; RE-READ the menu before every click (never click a remembered slot), and',
    '  after `close()` verify `state().screen` is null.',
    '- Keyboard work: `ctx.key(action,true)` then `ctx.key(action,false)` (or `hold(action,ms)`),',
    '  and check it is not blocked by a screen.',
    '- run() must return a JSON-serializable object such as {ok, steps:[...], evidence:{...}}.',
    '- Do NOT declare success yourself: success is decided by the manifest `verification`.',
    '- No require/import, no fs, no network, no process/globalThis, no eval/Function, no infinite loops.',
    '- No `body_*` / `submit_task` / `search` / `generate` / `subprocess` calls - v3 skills are',
    '  input scripts, not high-level task submitters.',
    '- Keep it under 120 lines; sleeps must stay under 2000 ms; explain failures honestly in the result.',
    manifest ? `Use this manifest as a starting point (server may override name/version): ${JSON.stringify(manifest)}` : null,
    feedbackBlock(feedback),
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
    this.maxTokens = deps.maxTokens || 3200;
    this.timeoutMs = deps.timeoutMs || 45000;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
  }

  async generate({ prompt, manifest = null, requestId = null, feedback = null } = {}) {
    if (typeof this.complete !== 'function') return { ok: false, reason: 'no-generator' };
    const clean = String(prompt || '').trim();
    if (!clean) return { ok: false, reason: 'empty-prompt' };
    let raw;
    try {
      raw = await this.complete({
        system: generationPrompt(clean, manifest, feedback),
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
    if (!envelope) return { ok: false, reason: 'malformed-envelope', raw: String(raw).slice(0, 1200) };
    return { ok: true, manifest: envelope.manifest, code: envelope.code, raw: String(raw).slice(0, 2000) };
  }
}

module.exports = {
  CodeSkillGeneration,
  generationPrompt,
  normalizeEnvelope,
  feedbackBlock,
  ALLOWED_PERMISSIONS,
  PERMISSION_LIST
};
