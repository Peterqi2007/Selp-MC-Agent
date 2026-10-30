'use strict';

/**
 * FailureEscalation - the code-side gate behind the failure ladder (mc_step / mc_plan).
 *
 * The goal text tells the action brain the rules; this service is what makes them real:
 *
 *   - a per-signature ledger (verb + normalized target, NEVER per task/goal), so
 *     escalating one action (tilling plot 1) never drags movement to plot 2 onto the
 *     input layer, and a coordinate hop against the same item stays the same signature;
 *   - hard gates: the third blind same-signature attempt is refused, an un-researched
 *     knowledge/unverified retry is refused, and while a player question is parked every
 *     body action via the harness channels is refused (whitelist: stop/inputs/read-only);
 *   - de-escalation: a success clears the signature; lookup/answer records inform exactly
 *     one retry; TTL expiry clears; `clearGoal()` wipes the slate when a goal ends.
 *
 * It is deliberately in-memory: the ledger's scope is a goal's lifetime, and a restarted
 * agent has no business refusing actions over a failure it cannot replay.
 */

const { FAILURE, CLASSES, CLASS_POLICY, classOf, envelope, fromResult } = require('./failure');

/** Commands that stay available while a player question is parked (read-only / stop). */
const PARKED_WHITELIST = new Set(['stop', 'inputs', 'state', 'status', 'task', 'keybinds', 'capabilities']);

const DEFAULTS = {
  /** Same-signature blind attempts tolerated before the gate refuses (policy may lower it). */
  maxBlindAttempts: 2,
  /** A lookup informs retries for this long; older searches no longer count as "informed". */
  lookupTtlMs: 10 * 60 * 1000,
  /** Informed retries (after a lookup or an answer) per signature before asking again. */
  informedAttempts: 1,
  /** Rolling-window failure budget across all signatures; a circuit breaker, not a leash. */
  goalFailureBudget: 30,
  goalFailureWindowMs: 10 * 60 * 1000
};

class FailureEscalation {
  constructor(deps = {}) {
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.now = deps.now || (() => Date.now());
    this.cfg = { ...DEFAULTS, ...(deps.config || {}) };
    /** signature -> { failures, lastClass, lastFailureAt, informedFailures, answered } */
    this.entries = new Map();
    /** [{at, query}] - every lookup_mod_content call, recorded at the Node broker. */
    this.lookups = [];
    /** [{at}] - rolling global failure feed for the goal-level circuit breaker. */
    this.failureFeed = [];
    this.ask = null; // { planId, question, at, answered }
  }

  // ------------------------------------------------------------ parsing

  /**
   * `place immersive_aircraft:biplane 15 65 71 up` -> { verb:'place', target, itemKey }.
   * The item key is what a knowledge-class signature is built from: retrying the same
   * item at different coordinates must stay the same signature (the live biplane loop
   * hopped positions to dodge exactly that count).
   */
  parseCommand(commandLine) {
    const tokens = String(commandLine || '').trim().split(/\s+/).filter(Boolean);
    const verb = (tokens[0] || '').toLowerCase();
    const rest = tokens.slice(1);
    const itemKey = rest.find((token) => token.includes(':')) || null;
    return { verb, target: rest.join(' '), itemKey };
  }

  /** Stable ledger key: item-bearing commands key on the item, others on the full target. */
  signatureOf(verb, target, itemKey) {
    const base = itemKey || String(target || '').trim() || '-';
    return `${verb}:${base}`;
  }

  // -------------------------------------------------------------- gate

  /**
   * Pre-dispatch check for one harness command (via=mc_step) or plan step.
   *
   * @returns {object} { ok:true, signature, verb } | { ok:false, error, ...envelope }
   */
  gate(input = {}) {
    const line = String(input.command || '').trim();
    const { verb, target, itemKey } = this.parseCommand(line);
    if (!verb) return { ok: false, error: 'empty-command' };

    if (this.ask && !this.ask.answered && !PARKED_WHITELIST.has(verb)) {
      return this._refuse('waiting-for-player-answer', verb, target, null, {
        reason: `a question is parked for the player: "${(this.ask.question || '').slice(0, 120)}"`,
        question: this.ask.question,
        answerHint: 'the player answers in game with !answer <text>; whitelisted while parked: stop/inputs/state/task'
      });
    }

    const signature = this.signatureOf(verb, target, itemKey);
    const entry = this.entries.get(signature);
    if (!entry) return { ok: true, signature, verb, target, itemKey };

    const className = entry.lastClass || CLASSES.UNKNOWN;
    const policy = CLASS_POLICY[className] || CLASS_POLICY[CLASSES.UNKNOWN];
    const blindBudget = Math.min(policy.blindBudget, this.cfg.maxBlindAttempts);

    if (className === CLASSES.PERMISSION && entry.failures >= 1) {
      return this._refuse('escalation-required', verb, target, entry, {
        className,
        reason: 'permission/refused failures are never auto-retried: stop, or ask the player'
      });
    }

    const informed = this._informed(entry, itemKey);
    if (entry.failures >= blindBudget && !informed) {
      const wantsLookup = className === CLASSES.KNOWLEDGE || className === CLASSES.UNVERIFIED;
      return this._refuse(wantsLookup ? 'lookup-required' : 'escalation-required', verb, target, entry, {
        className,
        reason: wantsLookup
          ? `${signature} failed ${entry.failures}x with class=${className}: lookup_mod_content before any retry`
          : `${signature} failed ${entry.failures}x with class=${className}: change the approach, not the retry count`,
        lookupQuery: wantsLookup ? this._lookupQuery(itemKey) : null
      });
    }

    if (informed && entry.informedFailures >= this.cfg.informedAttempts && !entry.answered) {
      return this._refuse('ask-required', verb, target, entry, {
        className,
        reason: `${signature} still fails after the informed retry: ask the player (mc_ask_player) or switch channel`,
        askQuestion: this._askQuestion(verb, itemKey || target, entry)
      });
    }

    /**
     * A player answer is new information, not an unlimited retry budget. Once the
     * post-answer attempt also fails, stop and ask/switch instead of looping forever.
     */
    if (entry.answered && entry.answeredFailures >= this.cfg.informedAttempts) {
      return this._refuse('escalation-required', verb, target, entry, {
        className,
        reason: `${signature} still fails after the player answer: stop, ask again with new evidence, or change channel`
      });
    }

    return { ok: true, signature, verb, target, itemKey };
  }

  /** mc_plan variant: steps carry {type, args}; same ledger, same rules. */
  gateStep(step = {}) {
    if (step.type === 'wait_for_player' || step.wait === true) return { ok: true };
    const command = this.commandOfStep(step);
    return this.gate({ command, via: 'mc_plan' });
  }

  /** Flatten a plan step to the command shape the signature parser expects. */
  commandOfStep(step = {}) {
    const type = String(step.type || '').toLowerCase();
    const args = step.args || {};
    const parts = [type];
    if (args.item) parts.push(args.item);
    if (args.block) parts.push(args.block);
    const pos = args.position || (Number.isFinite(args.x) ? args : null);
    if (pos) parts.push(`${pos.x} ${pos.y} ${pos.z}`);
    if (args.count) parts.push(String(args.count));
    return parts.join(' ');
  }

  // --------------------------------------------------------- recording

  /**
   * Fold a synchronous mc_step receipt into the envelope and record the outcome.
   * Background acks ({accepted:true}) carry no outcome yet - the settle path records them.
   */
  foldReceipt(command, result) {
    if (!result || typeof result !== 'object') return result;
    const { verb, target, itemKey } = this.parseCommand(command);
    const signature = this.signatureOf(verb, target, itemKey);
    if (result.ok === false) {
      const info = fromResult(result);
      this.recordFailure({ verb, target, itemKey, className: classOf(info.failure), failure: info.failure });
      const entry = this.entries.get(signature);
      const folded = envelope(result, {
        verb, target, signature,
        attempt: entry ? { count: entry.failures, budget: this._budgetFor(entry.lastClass) } : null,
        lookupQuery: this._needsLookup(info.failure) ? this._lookupQuery(itemKey) : null,
        askQuestion: null
      });
      this.lastSettled = {
        name: verb || null,
        ok: false,
        reason: folded.reason || folded.error || null,
        at: new Date(this.now()).toISOString(),
        failure: folded.failure,
        class: folded.class,
        requires: folded.requires,
        next: folded.next,
        lookupQuery: folded.lookupQuery || null,
        attempt: folded.attempt || null
      };
      return folded;
    }
    if (result.accepted === true) return result; // ack: the settle event records the outcome
    if (result.ok !== false) this.recordSuccess({ verb, target, itemKey });
    return result;
  }

  /** Task settle (task:done / task:failed at the TaskSlot exit). */
  recordTaskSettle({ name, ok, reason, description, result }) {
    const verb = String(name || '').toLowerCase();
    if (!verb) return null;
    const target = String(description || '').trim();
    const itemKey = (target.match(/[a-z0-9_]+:[a-z0-9_./-]+/i) || [null])[0];
    if (ok === true) {
      this.recordSuccess({ verb, target, itemKey });
      this.lastSettled = { name: verb, ok: true, reason: reason || null, at: new Date(this.now()).toISOString() };
      return null;
    }
    const folded = envelope({ ok: false, reason: reason || (result && result.reason) || 'failed', ...(result && typeof result === 'object' ? result : {}) }, {
      verb, target, signature: this.signatureOf(verb, target, itemKey)
    });
    this.recordFailure({ verb, target, itemKey, className: folded.class, failure: folded.failure });
    const entry = this.entries.get(this.signatureOf(verb, target, itemKey));
    const settled = envelope(folded, { attempt: entry ? { count: entry.failures, budget: this._budgetFor(entry.lastClass) } : null });
    this.lastSettled = {
      name: verb, ok: false, reason: settled.reason || null, at: new Date(this.now()).toISOString(),
      failure: settled.failure, class: settled.class, requires: settled.requires, next: settled.next,
      lookupQuery: settled.lookupQuery || null, attempt: settled.attempt || null
    };
    return settled;
  }

  recordFailure({ verb, target, itemKey, className, failure }) {
    const signature = this.signatureOf(verb, target, itemKey);
    let entry = this.entries.get(signature);
    if (!entry) {
      entry = { failures: 0, lastClass: null, lastFailureAt: 0, informedFailures: 0, answeredFailures: 0, answered: false };
      this.entries.set(signature, entry);
    }
    entry.failures += 1;
    entry.lastClass = className || CLASSES.UNKNOWN;
    entry.lastFailure = failure || null;
    entry.lastFailureAt = this.now();
    if (entry.answered) entry.answeredFailures += 1;
    if (this._informed(entry, itemKey)) entry.informedFailures += 1;
    this.failureFeed.push({ at: this.now() });
    const cutoff = this.now() - this.cfg.goalFailureWindowMs;
    this.failureFeed = this.failureFeed.filter((item) => item.at >= cutoff);
    if (this.failureFeed.length > this.cfg.goalFailureBudget) {
      this.log.warn(`failure circuit breaker: ${this.failureFeed.length} failures in ${this.cfg.goalFailureWindowMs}ms`);
    }
    return entry;
  }

  /** Success clears the signature: the next same-kind action starts capability-first. */
  recordSuccess({ verb, target, itemKey }) {
    const signature = this.signatureOf(verb, target, itemKey);
    this.lastSettled = {
      name: verb || null,
      ok: true,
      reason: null,
      at: new Date(this.now()).toISOString()
    };
    if (this.entries.delete(signature)) {
      this.log.debug(`escalation cleared for ${signature} (success)`);
      return true;
    }
    return false;
  }

  /** Every lookup_mod_content call is recorded here (the plugin proxies through Node). */
  recordLookup(query) {
    const text = String(query || '').trim();
    if (!text) return false;
    this.lookups.push({ at: this.now(), query: text.toLowerCase() });
    if (this.lookups.length > 50) this.lookups.shift();
    return true;
  }

  // ---------------------------------------------------------- ask player

  /** `/ask_player` parked a single-step wait_for_player plan; body actions gate shut. */
  markAskParked(planId, question) {
    this.ask = { planId: planId || null, question: question || null, at: this.now(), answered: false };
  }

  /**
   * The parked question settled (answered / expired / cancelled). An answer counts as new
   * information: informed retries are re-armed for every signature the question touched.
   */
  markAskResolved(answered) {
    if (!this.ask) return false;
    const wasAnswered = answered === true;
    if (wasAnswered) {
      for (const entry of this.entries.values()) {
        entry.informedFailures = 0;
        entry.answeredFailures = 0;
        entry.answered = true;
      }
    }
    this.ask = null;
    return true;
  }

  waitingForAnswer() {
    return !!(this.ask && !this.ask.answered);
  }

  /** Goal end: wipe the ledger so the next goal starts capability-first. */
  clearGoal() {
    this.entries.clear();
    this.lookups = [];
    this.failureFeed = [];
    this.lastSettled = null;
    this.ask = null;
  }

  // ------------------------------------------------------------- internals

  _budgetFor(className) {
    const policy = CLASS_POLICY[className] || CLASS_POLICY[CLASSES.UNKNOWN];
    return Math.min(policy.blindBudget, this.cfg.maxBlindAttempts);
  }

  _needsLookup(failureType) {
    const className = classOf(failureType);
    return className === CLASSES.KNOWLEDGE || className === CLASSES.UNVERIFIED;
  }

  /** An entry counts as informed when a lookup names the item (or its mod) inside the TTL. */
  _informed(entry, itemKey) {
    if (entry && entry.answered) return true;
    if (!itemKey) return false;
    const key = String(itemKey).toLowerCase();
    const cutoff = this.now() - this.cfg.lookupTtlMs;
    const modid = key.includes(':') ? key.split(':', 1)[0] : key;
    const path = key.includes(':') ? key.split(':')[1] : key;
    return this.lookups.some(
      (lookup) => lookup.at >= cutoff && (lookup.query.includes(path) || lookup.query.includes(modid))
    );
  }

  _lookupQuery(itemKey) {
    if (!itemKey) return null;
    const [modid, path] = itemKey.includes(':') ? itemKey.split(':', 2) : ['minecraft', itemKey];
    return modid === 'minecraft' ? `${path} 使用方法` : `${modid} ${path} 怎么放置 使用`;
  }

  _askQuestion(verb, item, entry) {
    return (
      `"${verb} ${item}" 已经失败 ${entry ? entry.failures : '?'} 次，联网资料也没有解决。` +
      `你那边看到实际效果了吗？这个物品/机制需要怎么操作（特殊按键、特定方块、前置条件）？`
    );
  }

  _refuse(error, verb, target, entry, extra = {}) {
    const className = extra.className || (entry && entry.lastClass) || null;
    return {
      ok: false,
      error,
      verb,
      target: target || null,
      class: className,
      retryable: false,
      attempt: entry ? { count: entry.failures, budget: this._budgetFor(className) } : null,
      requires: extra.lookupQuery ? ['lookup_mod_content'] : error === 'ask-required' ? ['mc_ask_player'] : [],
      next: error,
      lookupQuery: extra.lookupQuery || null,
      askQuestion: extra.askQuestion || null,
      question: extra.question || null,
      answerHint: extra.answerHint || null,
      reason: extra.reason || error
    };
  }

  status() {
    return {
      signatures: this.entries.size,
      waitingForAnswer: this.waitingForAnswer(),
      ask: this.ask ? { planId: this.ask.planId, at: this.ask.at } : null,
      recentFailures: this.failureFeed.length,
      lastSettled: this.lastSettled || null,
      entries: [...this.entries.entries()].map(([signature, entry]) => ({
        signature,
        failures: entry.failures,
        class: entry.lastClass,
        informedFailures: entry.informedFailures,
        answeredFailures: entry.answeredFailures || 0,
        answered: entry.answered
      })).slice(-10)
    };
  }
}

module.exports = { FailureEscalation, DEFAULTS, PARKED_WHITELIST };
