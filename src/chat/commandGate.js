'use strict';

/**
 * The binary gate for addressed instructions (P1 M2, A02).
 *
 * The model is allowed exactly one decision: allow or deny. Everything else about the
 * message must survive untouched. This function is the only place that interprets the
 * verdict, so the failure modes are testable without a model:
 *
 *   - deny / malformed / timeout / empty  -> nothing is dispatched;
 *   - allow                                -> the **original** text is dispatched;
 *   - a rewritten `text` field in the verdict is ignored (and reported), never dispatched.
 *
 * The caller owns the model call and the timeout; this function owns the interpretation.
 */

const VERDICTS = new Set(['allow', 'deny']);

/**
 * @param {object} input { verdict, original, timedOut }
 * @returns {{ok:boolean, dispatch:string|null, reason:string, rewritten?:string|null}}
 */
function gateVerdict(input = {}) {
  const original = input.original;
  if (original === undefined || original === null || !String(original).trim()) {
    return { ok: false, dispatch: null, reason: 'empty' };
  }
  if (input.timedOut) return { ok: false, dispatch: null, reason: 'timeout' };

  const raw = input.verdict;
  const decision = raw && typeof raw === 'object' ? raw.verdict : raw;
  if (!VERDICTS.has(decision)) return { ok: false, dispatch: null, reason: 'malformed' };
  if (decision === 'deny') return { ok: false, dispatch: null, reason: 'denied' };

  const rewritten = raw && typeof raw === 'object' && raw.text !== undefined && raw.text !== original ? raw.text : null;
  return { ok: true, dispatch: String(original), reason: 'allowed', rewritten };
}

/**
 * CommandGate - the async half of the binary gate (P1 M2).
 *
 * The judge is injected (an LLM adapter later, a stub in tests). This class owns the timeout
 * and the interpretation; it never sees the body and never dispatches anything itself.
 */
class CommandGate {
  constructor(options = {}) {
    this.judge = options.judge || null;
    this.timeoutMs = options.timeoutMs || 1500;
    this.now = options.now || (() => Date.now());
  }

  /** @returns {Promise<{ok:boolean, dispatch:string|null, reason:string}>} */
  async decide(text) {
    if (!text || !String(text).trim()) return { ok: false, dispatch: null, reason: 'empty' };
    if (typeof this.judge !== 'function') return { ok: false, dispatch: null, reason: 'no-judge' };

    let timer = null;
    let timedOut = false;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        resolve(undefined);
      }, this.timeoutMs);
    });

    let verdict;
    try {
      verdict = await Promise.race([Promise.resolve().then(() => this.judge(text)), timeout]);
    } catch (err) {
      if (timer) clearTimeout(timer);
      return { ok: false, dispatch: null, reason: 'judge-error', error: err.message };
    }
    if (timer) clearTimeout(timer);
    if (timedOut) return { ok: false, dispatch: null, reason: 'timeout' };
    return gateVerdict({ verdict, original: text });
  }
}

module.exports = { gateVerdict, VERDICTS, CommandGate };
