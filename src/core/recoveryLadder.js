'use strict';

/**
 * RecoveryLadder: ordered alternative EXECUTIONS of one bounded goal.
 *
 * Borrowed from numen's `RecoveryLadder` (core/task/base/RecoveryLadder.java): a rung offers
 * a different way to reach the same goal ("walk straight to the ore" -> "approach from the
 * far side" -> "give up this instance"), declares which failure types it is willing to catch,
 * and caps its own retries. A cause no rung handles falls straight through to the caller -
 * the ladder never widens the goal or auto-acquires a prerequisite; that would be a decision
 * for the LLM or the operator, not a hidden retry.
 *
 * The ladder is deterministic and Minecraft-free: rungs are plain async functions, so it is
 * unit-testable with fakes and can wrap any skill's attempt loop.
 */

const { classify } = require('./failure');

class RecoveryLadder {
  /**
   * @param {string} name ladder name, for logs/traces (e.g. "mine_ore")
   * @param {Array<{name:string, handles:string[], maxAttempts?:number, run:(context:object)=>Promise<object>}>} rungs
   * @param {object} [options] { log, trace }
   */
  constructor(name, rungs, options = {}) {
    this.name = name;
    this.rungs = (rungs || []).slice();
    this.log = options.log || { debug() {}, info() {}, warn() {} };
    this.trace = options.trace || (() => {});
  }

  /**
   * Run the ladder to a conclusion.
   *
   * @param {object} [context] passed to each rung's run() as `{ ...context, attempt, rung }`
   * @returns {Promise<object>} the first successful result (with `ladder.attempts` attached)
   *          or a failure carrying `failure`, `reason` and the full attempt list.
   */
  async run(context = {}) {
    const attempts = [];
    let last = null;
    let lastFailure = null;

    for (const rung of this.rungs) {
      /**
       * Enter a rung only when it declares the last failure as its business. numen's rule:
       * a rung recovers the execution of the goal it was written for; a cause nobody
       * handles must fall straight through instead of being retried by an unrelated rung.
       * The first rung always runs (there is no failure yet).
       */
      if (lastFailure) {
        const handles = rung.handles || ['*'];
        if (!handles.includes('*') && !handles.includes(lastFailure)) continue;
      }
      const maxAttempts = Math.max(1, rung.maxAttempts || 1);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const started = Date.now();
        let result;
        try {
          result = await rung.run({ ...context, attempt, rung: rung.name });
        } catch (err) {
          result = { ok: false, reason: `${rung.name} threw: ${err.message}`, failure: 'internal' };
        }
        if (!result || typeof result !== 'object') {
          result = { ok: false, reason: `${rung.name} returned nothing`, failure: 'internal' };
        }

        const ok = result.ok !== false;
        const type = result.failure || classify(result.reason || result.detail);
        const record = {
          rung: rung.name,
          attempt,
          ok,
          failure: ok ? null : type,
          ms: Date.now() - started,
          reason: result.reason || result.detail || null
        };
        attempts.push(record);
        last = { ...result, failure: ok ? null : type };
        lastFailure = ok ? null : type;
        this.trace({ kind: 'ladder-attempt', ladder: this.name, ...record });
        this.log.debug(`${this.name}: rung ${rung.name} attempt ${attempt} -> ${ok ? 'ok' : type}`);

        if (ok) {
          return { ...result, ladder: { name: this.name, attempts } };
        }

        /**
         * A rung only catches the causes it declared. Anything else is someone else's
         * decision (missing material, wrong tool, permission) - stop retrying this rung and
         * let a later rung that explicitly handles it try, then fall out to the caller.
         */
        const handles = rung.handles || ['*'];
        const catches = handles.includes('*') || handles.includes(type);
        if (!catches) break;
      }
    }

    return {
      ...(last || {}),
      ok: false,
      failure: (last && last.failure) || 'unknown',
      reason: (last && last.reason) || `recovery ladder ${this.name} exhausted`,
      detail: (last && last.detail) || null,
      ladder: { name: this.name, attempts, exhausted: true }
    };
  }
}

module.exports = { RecoveryLadder };
