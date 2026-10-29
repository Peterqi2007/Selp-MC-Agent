'use strict';

/**
 * Holds: the single table of "why the brain is not working right now".
 *
 * Before this table the same idea was spread over three booleans (`paused`, `stopped`,
 * `autoPlanDisabled`) that were set and read from the brain, the chat command table, the
 * panel and the tests. Three flags meant three answers to "can it plan?", "can it still
 * take an explicit command?", and "what clears this?" - and the answers drifted: the
 * post-death stop once resumed itself after a respawn because nothing said who was
 * allowed to clear it.
 *
 * The table is the one place that answers those questions, per reason:
 *
 *   - `dead`       the body died; only an explicit resume clears it (a respawn must not
 *                  restart work on its own);
 *   - `paused`     the operator asked it to pause; `!resume` clears it;
 *   - `owner-stop` `!stop` / the panel's emergency stop: autonomous planning is silenced
 *                  but an explicit instruction may still run, which is why this is a
 *                  separate reason rather than a stronger pause.
 *
 * `Brain` keeps `paused` / `stopped` / `autoPlanDisabled` as accessors over this set, so
 * every existing reader (panel, doctor, CLI, tests) keeps working while the semantics live
 * here.
 */

/**
 * Ordered by severity: the first active entry is the headline reason shown to the operator.
 *
 * @type {ReadonlyArray<{reason:string,label:string,blocksReflexes:boolean,blocksPlanning:boolean,blocksExplicit:boolean,clears:string}>}
 */
const HOLD_TABLE = Object.freeze([
  {
    reason: 'dead',
    label: '已停止（死亡）',
    blocksReflexes: true,
    blocksPlanning: true,
    blocksExplicit: true,
    clears: 'explicit resume only (resumeFromDeath); a respawn must not resume work'
  },
  {
    reason: 'paused',
    label: '已暂停',
    blocksReflexes: true,
    blocksPlanning: true,
    blocksExplicit: true,
    clears: '!resume'
  },
  {
    reason: 'owner-stop',
    label: '操作员停止（自动规划已停）',
    blocksReflexes: false,
    blocksPlanning: true,
    blocksExplicit: false,
    clears: '!resume; an explicit command still runs while this hold is active'
  },
  {
    /**
     * A background task owns the body (src/core/taskHub.js). Planning stops and new explicit
     * work is refused until it settles - one body, one task. `!stop` cancels it.
     */
    reason: 'task',
    label: '后台任务占用中',
    blocksReflexes: false,
    blocksPlanning: true,
    blocksExplicit: true,
    clears: 'the background task finishing (done/failed/stopped), or !stop'
  }
]);

const BY_REASON = new Map(HOLD_TABLE.map((entry) => [entry.reason, entry]));

/** A reason that is not in the table is a programming error, not a silent no-op. */
function spec(reason) {
  const entry = BY_REASON.get(reason);
  if (!entry) {
    throw new Error(`unknown hold reason "${reason}" - known: ${[...BY_REASON.keys()].join(', ')}`);
  }
  return entry;
}

class Holds {
  /**
   * @param {object} [deps]
   * @param {(reason:string)=>void} [deps.onHold] called on every *new* hold.
   *   Used by M5's input ledger: anything that stops the brain touching the world must
   *   also let go of the keys (F1'b). A hold that is refreshed is not a new signal, so the
   *   callback fires only on the first `hold(reason)`, not on repeats.
   */
  constructor({ onHold } = {}) {
    /** @type {Map<string,{since:number,note:string|null}>} */
    this.active = new Map();
    this.onHold = typeof onHold === 'function' ? onHold : null;
  }

  /** Enter (or refresh the note of) a hold. Idempotent. */
  hold(reason, note = null) {
    const entry = spec(reason);
    const current = this.active.get(reason);
    const isNew = !current;
    this.active.set(reason, {
      since: current ? current.since : Date.now(),
      note: note === null || note === undefined ? (current ? current.note : null) : String(note)
    });
    if (isNew && this.onHold) {
      try {
        this.onHold(reason);
      } catch (err) {
        // A listener must never break the hold itself: stopping the brain matters more
        // than whatever the listener wanted to do.
        console.warn(`holds: onHold(${reason}) failed: ${err.message}`);
      }
    }
    return entry;
  }

  /** Clear one hold. Returns true when it was active. */
  release(reason) {
    spec(reason);
    return this.active.delete(reason);
  }

  has(reason) {
    return this.active.has(reason);
  }

  /** True when any active hold blocks the given activity ("reflexes" | "planning" | "explicit"). */
  blocking(activity) {
    const field = {
      reflexes: 'blocksReflexes',
      planning: 'blocksPlanning',
      explicit: 'blocksExplicit'
    }[activity];
    if (!field) throw new Error(`unknown activity "${activity}"`);
    for (const reason of this.active.keys()) {
      if (BY_REASON.get(reason)[field]) return true;
    }
    return false;
  }

  /** The most severe active entry, in table order, or null. */
  primary() {
    for (const entry of HOLD_TABLE) {
      if (this.active.has(entry.reason)) return entry;
    }
    return null;
  }

  /** Everything active, in table order, for `status()` and the panel. */
  list() {
    return HOLD_TABLE.filter((entry) => this.active.has(entry.reason)).map((entry) => ({
      reason: entry.reason,
      label: entry.label,
      clears: entry.clears,
      since: this.active.get(entry.reason).since,
      note: this.active.get(entry.reason).note
    }));
  }
}

module.exports = { Holds, HOLD_TABLE, BY_REASON };
