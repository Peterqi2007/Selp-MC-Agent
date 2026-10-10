'use strict';

/**
 * Mining progress monitor: decides - from *observed* progress and repeated situations -
 * when the deterministic macro should hand control to the LLM recovery session.
 *
 * The plan (docs/MINING-LLM-PLAN.md §5.2) is explicit about the division of labour:
 * "阶段与有效进展由 Node 计算，不能采信模型的 progress:true". This module is that Node
 * judge. It is pure data + deterministic rules over records the callers submit when a
 * *semantic action* ends (not every tick), plus injectable time so the offline tests can
 * advance a virtual clock instead of sleeping 30 seconds.
 *
 * Trigger codes it produces (an explanation, not a decision to call the model by itself):
 *   same_failure      same goal/phase/situation/action failed twice with no progress after
 *   position_cycle    a 2..4-step stand/phase cycle repeated fully twice with no progress
 *   false_arrival     three "arrived/succeeded" reports with <0.1 movement and no phase goal
 *   no_progress       >=3 finished attempts and >=30s active execution without progress
 *   ladder_exhausted  the caller's local ladder is exhausted while the target still exists
 *   pickup_stalled    the shared collector tried different viable stands without success
 */

const HISTORY_SIZE = 12;
const FINGERPRINT_HISTORY = 48;

const DEFAULTS = {
  historySize: HISTORY_SIZE,
  fingerprintHistory: FINGERPRINT_HISTORY,
  sameFailureLimit: 2,
  falseArrivalLimit: 3,
  noProgressActiveMs: 30000,
  cycleLengths: [2, 3, 4]
};

/** FNV-1a over a stable string; short, deterministic, no crypto dependency. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Quantise a position to the cell (floats jitter within a cell must not change a fingerprint). */
function cellOf(position) {
  if (!position) return null;
  return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}

/**
 * Stable situation fingerprint (plan §5.2.2): goal + phase + landed feet cell + the state
 * of the cells the current action depends on + tool/support availability + target state.
 * Camera, timestamps, entity order and sub-cell jitter are deliberately excluded.
 */
function fingerprintOf(input = {}) {
  const feet = cellOf(input.feet);
  const cells = (input.cells || [])
    .map((c) => `${c.x},${c.y},${c.z}=${String(c.name || '?').replace(/^[a-z0-9_]+:/, '')}`)
    .sort();
  const target = input.target || {};
  const text = [
    `g:${input.goalId || '-'}`,
    `p:${input.phase || '-'}`,
    `f:${feet ? `${feet.x},${feet.y},${feet.z}` : '-'}`,
    `t:${input.tool || '-'}`,
    `s:${input.scaffold || '-'}`,
    `c:${cells.join('|')}`,
    `m:${target.mined ? 1 : 0}`,
    `v:${target.visible ? 1 : 0}`,
    `d:${target.pending === undefined ? '-' : target.pending}`
  ].join(';');
  return hash(text);
}

class MiningProgressMonitor {
  /**
   * @param {object} [options] { config, now() }
   */
  constructor(options = {}) {
    this.cfg = { ...DEFAULTS, ...((options.config && options.config.miningRecovery) || {}) };
    this.now = options.now || (() => Date.now());
    /** Full semantic records, newest last. */
    this.history = [];
    /** Compressed fingerprints for cycle detection, newest last. */
    this.fingerprints = [];
    /** Active execution time (excludes waits the caller declares as waiting). */
    this.activeMs = 0;
    this.attempts = 0;
    this.lastProgressAt = this.now();
    this.lastTrigger = null;
    /** Sequence bookkeeping: failures before the last progress must not count again. */
    this.recordSeq = 0;
    this.lastProgressSeq = 0;
  }

  /**
   * Record one finished semantic action.
   *
   * @param {object} entry
   *   - goalId, phase, action, args, fingerprint
   *   - ok, failure, reason, cellKey
   *   - progress: true when the Node compared before/after state and the phase goal moved
   *   - elapsedMs: the action's active time (already excluding declared waits)
   *   - waiting: true for human/model waits that must not count as active time
   */
  record(entry = {}) {
    const at = this.now();
    this.recordSeq += 1;
    const record = { at, seq: this.recordSeq, ...entry };
    record.seq = this.recordSeq;
    this.history.push(record);
    if (this.history.length > this.cfg.historySize) this.history.shift();
    if (entry.fingerprint) {
      this.fingerprints.push(entry.fingerprint);
      if (this.fingerprints.length > this.cfg.fingerprintHistory) this.fingerprints.shift();
    }
    if (entry.waiting) return record;
    this.activeMs += Math.max(0, Number(entry.elapsedMs) || 0);
    if (entry.ok || entry.progress) {
      this.attempts = 0;
      this.activeMs = 0;
      this.lastProgressAt = at;
      this.lastProgressSeq = record.seq;
    } else {
      this.attempts += 1;
    }
    return record;
  }

  /** Since when has no phase progress been observed? */
  silentMs() {
    return this.now() - this.lastProgressAt;
  }

  /**
   * Evaluate the trigger table (plan §5.2.2).
   *
   * @param {object} [state]
   *   - ladderExhausted:boolean  the caller's own recovery ladder ran out
   *   - pickupStalled:boolean    the shared collector reported needs_recovery
   * @returns {{trigger:string, reason:string}|null}
   */
  evaluate(state = {}) {
    const recent = this.history;

    // 1. pickup_stalled: the collector's own verdict is the strongest signal.
    if (state.pickupStalled) {
      return { trigger: 'pickup_stalled', reason: 'the shared collector tried its stands without a verified pickup' };
    }

    /**
     * 2. position_cycle before same_failure: a clean A/B/A/B cycle contains two identical
     * endpoint situations, and reporting it as "same failure twice" would hide the actual
     * pattern the operator saw (A/B oscillation). A true same-situation repeat (fewer than
     * four recorded steps, or a fingerprint that does not form a full 2x cycle) still falls
     * through to same_failure below.
     */
    for (const length of this.cfg.cycleLengths) {
      const seq = this.fingerprints;
      if (seq.length < length * 2) continue;
      const tail = seq.slice(-length);
      const before = seq.slice(-length * 2, -length);
      if (tail.every((value, i) => value === before[i])) {
        const progressed = recent.some((r) => r.progress && this.now() - r.at < length * 2 * 1000);
        if (!progressed) {
          return { trigger: 'position_cycle', reason: `the same ${length}-step situation cycle repeated twice` };
        }
      }
    }

    // 3. same_failure: identical goal/phase/action/situation failed twice with no progress.
    const failures = recent.filter((r) => !r.ok && !r.progress && r.seq > this.lastProgressSeq);
    if (failures.length >= this.cfg.sameFailureLimit) {
      const last = failures[failures.length - 1];
      const same = failures.filter(
        (r) =>
          r.goalId === last.goalId &&
          r.phase === last.phase &&
          r.action === last.action &&
          (r.cellKey || '') === (last.cellKey || '') &&
          r.fingerprint &&
          r.fingerprint === last.fingerprint
      );
      if (same.length >= this.cfg.sameFailureLimit) {
        return {
          trigger: 'same_failure',
          reason: `${same.length} identical ${last.action} failures at ${last.cellKey || 'the same situation'}`
        };
      }
    }

    // 4. false_arrival: three success/arrival claims with almost no movement.
    const arrivals = recent.filter((r) => r.arrived && !r.progress && !(r.moved > 0.1) && r.seq > this.lastProgressSeq);
    if (arrivals.length >= this.cfg.falseArrivalLimit) {
      return { trigger: 'false_arrival', reason: `${arrivals.length} "arrived" reports with no movement` };
    }

    // 5. no_progress: enough finished attempts and no phase progress for the active window.
    if (this.attempts >= 3 && this.silentMs() >= this.cfg.noProgressActiveMs) {
      return {
        trigger: 'no_progress',
        reason: `${Math.round(this.silentMs() / 1000)}s without phase progress over ${this.attempts} attempts`
      };
    }

    // 6. ladder_exhausted: the deterministic side admits it is done.
    if (state.ladderExhausted) {
      return { trigger: 'ladder_exhausted', reason: 'the local recovery ladder is exhausted' };
    }

    return null;
  }

  /** Compact view for prompts/reports. */
  snapshot() {
    return {
      attempts: this.attempts,
      activeMs: this.activeMs,
      silentMs: this.silentMs(),
      lastProgressAt: this.lastProgressAt,
      recent: this.history.slice(-6),
      lastTrigger: this.lastTrigger
    };
  }
}

module.exports = { MiningProgressMonitor, fingerprintOf, DEFAULTS, cellOf };
