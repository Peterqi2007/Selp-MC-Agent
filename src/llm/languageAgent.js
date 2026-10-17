'use strict';

/**
 * LanguageAgent - the offline half of the language brain (P1 M2, A03).
 *
 * It is deliberately small and powerless:
 *   - the model is injected (`complete`), so no transport or key is involved here;
 *   - the only tools it can call are the language surface (`observe`, `find_blocks`,
 *     `lookup_item`, `scan_around`, `say`, `silence`);
 *   - an execution tool (`do_task`, `do_skill`, `go_to`, `stop`) is refused **before** any
 *     call, even if the model asks for it;
 *   - malformed output means silence, not a guessed action;
 *   - `say` goes through the single reply path (with the conversation guard opt-in).
 *
 * The action brain and the executor are not imported here. This class can talk and read;
 * it cannot act.
 */

const registry = require('./tools/registry');
const { SURFACES } = require('./toolSurface');

function languagePrompt(persona) {
  return [
    'You are the language half of a Minecraft agent.',
    'You may read state, retrieve/search, say one short line, or stay silent.',
    'You must not plan or execute actions: tasks, skills, movement and stopping belong to the action brain.',
    'Answer with exactly one JSON object and nothing else:',
    '  {"tool":"say","args":{"text":"..."}} or {"tool":"silence"} or {"tool":"observe"}',
    persona ? `Persona: ${persona}` : null
  ]
    .filter(Boolean)
    .join('\n');
}

function parseToolCall(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    const data = JSON.parse(candidate);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

class LanguageAgent {
  /**
   * @param {object} deps { complete, ctx, persona, maxTokens, log }
   *   complete({system, messages, maxTokens}) -> string | {ok,text}
   */
  constructor(deps = {}) {
    this.complete = deps.complete || null;
    this.ctx = deps.ctx || {};
    this.persona = deps.persona || null;
    this.maxTokens = deps.maxTokens || 400;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
  }

  /**
   * @param {object} request { text, speaker, history }
   * @returns {Promise<{ok:boolean, spoke:boolean, tool?:string, text?:string, reason?:string, result?:object}>}
   */
  async respond(request = {}) {
    const text = String(request.text || '').trim();
    if (!text) return { ok: false, spoke: false, reason: 'empty-text' };
    if (typeof this.complete !== 'function') return { ok: false, spoke: false, reason: 'no-model' };

    const messages = [
      ...(Array.isArray(request.history) ? request.history : []),
      { role: 'user', content: text }
    ];
    let raw;
    try {
      raw = await this.complete({
        system: languagePrompt(this.persona),
        messages,
        maxTokens: this.maxTokens
      });
    } catch (err) {
      return { ok: false, spoke: false, reason: 'model-error', error: err.message };
    }
    if (raw && typeof raw === 'object' && raw.ok === false) {
      return { ok: false, spoke: false, reason: raw.reason || 'model-error' };
    }
    if (raw && typeof raw === 'object' && typeof raw.text === 'string') raw = raw.text;

    const call = parseToolCall(raw);
    if (!call) {
      this.log.debug('language agent: malformed model output, staying silent');
      return { ok: true, spoke: false, reason: 'malformed' };
    }
    const name = call.tool || call.name;
    if (!SURFACES.language.includes(name)) {
      return { ok: false, spoke: false, reason: 'not-language-tool', tool: name || null };
    }
    const args = call.args || call.arguments || {};
    const result = await registry.call(this.ctx, name, args);
    return {
      ok: result.ok === true,
      spoke: name === 'say' && result.ok === true,
      tool: name,
      text: name === 'say' && result.result && result.result.said ? result.result.said : null,
      result
    };
  }
}

module.exports = { LanguageAgent, parseToolCall, languagePrompt };
