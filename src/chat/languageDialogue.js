'use strict';

/**
 * LanguageDialogue - the dialogue-channel wrapper around LanguageAgent (P1 M2).
 *
 * The rule that matters: **a refused execution request must not fall back to the action
 * brain.** Falling back on every non-ok result would turn "the language model tried to call
 * do_task" into "the action brain executes it", which is exactly the boundary the split was
 * built to enforce.
 *
 * Fallback is limited to availability failures (`model-error`, `no-model`): when the language
 * brain cannot answer at all, the existing dialogue path keeps the agent responsive.
 * Silence and malformed output are deliberate outcomes (`ok: true, spoke: false`) and do not
 * fall back either.
 */

class LanguageDialogue {
  constructor(deps = {}) {
    this.agent = deps.agent || null;
    this.fallback = deps.fallback || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
  }

  async handle(text, line, meta = {}) {
    if (!this.agent || typeof this.agent.respond !== 'function') {
      return { ok: false, reason: 'no-agent' };
    }
    let result;
    try {
      result = await this.agent.respond({ text, history: meta.history });
    } catch (err) {
      result = { ok: false, reason: 'agent-error', error: err.message };
    }
    if (result && result.ok) {
      return { ok: true, spoke: !!result.spoke, result };
    }

    const reason = (result && result.reason) || 'unknown';
    const availabilityFailure = reason === 'model-error' || reason === 'no-model' || reason === 'agent-error';
    if (!availabilityFailure || typeof this.fallback !== 'function') {
      return { ok: false, reason, result };
    }

    try {
      const fallbackResult = await this.fallback(text, line, meta);
      return { ok: true, fellBack: true, reason, result: fallbackResult };
    } catch (err) {
      return { ok: false, reason: 'fallback-error', error: err.message, result };
    }
  }
}

module.exports = { LanguageDialogue };
