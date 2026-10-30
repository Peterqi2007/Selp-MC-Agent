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
    /** Persistent chat log: save/grep/context/compact (state file). The only chat store. */
    this.chatMemory = deps.chatMemory || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
  }

  /**
   * Persist the turn into ChatMemory - now the only chat store.
   *
   * This used to *also* write the same turn into `MemoryStore` as `relational`. That category
   * was removed on 2026-10-30 (see src/memory/store.js): under `language.brain=unified` this
   * module is never constructed, so the write never ran; and where it did run it duplicated
   * what ChatMemory already held, in a worse shape - ChatMemory keeps speaker and request
   * identity and supports grep/compact/context, the flat memory entry kept none of that.
   */
  _remember(text, result) {
    const reply = result && result.text ? String(result.text).slice(0, 500) : null;
    const sources = result && Array.isArray(result.sources) ? result.sources.slice(0, 5) : [];
    const payload = {
      text,
      reply,
      sources,
      tool: (result && result.tool) || null
    };
    if (!this.chatMemory) return false;
    try {
      /**
       * The global chat recorder already stored this player line as a user entry; only
       * the assistant half is missing. `attachReply` appends it without duplicating the
       * player line (and falls back to saveTurn when the recorder did not run).
       */
      if (typeof this.chatMemory.attachReply === 'function') this.chatMemory.attachReply(payload);
      else if (typeof this.chatMemory.saveTurn === 'function') this.chatMemory.saveTurn(payload);
      return true;
    } catch (err) {
      this.log.warn(`chat log write failed: ${err.message}`);
      return false;
    }
  }

  async handle(text, line, meta = {}) {
    if (!this.agent || typeof this.agent.respond !== 'function') {
      return { ok: false, reason: 'no-agent' };
    }
    const injected =
      this.chatMemory && typeof this.chatMemory.context === 'function'
        ? this.chatMemory.context({ query: text, budgetChars: 4000 })
        : [];
    const history = [...injected, ...(Array.isArray(meta.history) ? meta.history : [])];
    let result;
    try {
      result = await this.agent.respond({ text, history });
    } catch (err) {
      result = { ok: false, reason: 'agent-error', error: err.message };
    }
    if (result && result.ok) {
      const remembered = this._remember(text, result);
      return { ok: true, spoke: !!result.spoke, result, remembered };
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
