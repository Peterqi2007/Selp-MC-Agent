'use strict';

/**
 * AddressedHandler - the `@` channel's dispatch path (P1 M2, A02).
 *
 * Flow: raw text -> gate (allow/deny only) -> **original text** -> command table.
 * A deny, a malformed verdict, a timeout or a gate error dispatches nothing. The handler does
 * not interpret the text and does not rewrite it; that is the whole point of A02.
 *
 * `dispatch(text, meta)` is injected so the same handler can drive the real command table in
 * production and a recorder in tests. This module has no model, socket or body access.
 */

class AddressedHandler {
  constructor(deps = {}) {
    this.gate = deps.gate;
    this.dispatch = deps.dispatch;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    if (!this.gate || typeof this.gate.decide !== 'function') throw new Error('AddressedHandler needs a gate');
    if (typeof this.dispatch !== 'function') throw new Error('AddressedHandler needs dispatch()');
  }

  /**
   * @param {string} text the utterance with the addressed prefix removed
   * @param {object} [meta] { line, from, source }
   * @returns {Promise<{ok:boolean, reason?:string, dispatch?:string, result?:any}>}
   */
  async handle(text, meta = {}) {
    if (!text || !String(text).trim()) return { ok: false, reason: 'empty' };
    let verdict;
    try {
      verdict = await this.gate.decide(text);
    } catch (err) {
      return { ok: false, reason: 'gate-error', error: err.message };
    }
    if (!verdict || !verdict.ok) {
      const reason = (verdict && verdict.reason) || 'denied';
      this.log.info(`addressed refused (${reason}): ${text}`);
      return { ok: false, reason };
    }
    /**
     * A02 evidence needs the gate's own verdict, not only the bot's reply. The addressed
     * channel is opt-in, so logging the allowed original text here is acceptable.
     */
    this.log.info(
      `addressed allowed: ${text}${verdict.rewritten ? ` (rewritten "${verdict.rewritten}" ignored)` : ''}`
    );
    try {
      const result = await this.dispatch(verdict.dispatch, meta);
      return { ok: true, dispatch: verdict.dispatch, result };
    } catch (err) {
      return { ok: false, reason: 'dispatch-error', error: err.message };
    }
  }
}

module.exports = { AddressedHandler };
