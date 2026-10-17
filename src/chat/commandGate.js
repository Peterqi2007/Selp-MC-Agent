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

module.exports = { gateVerdict, VERDICTS };
