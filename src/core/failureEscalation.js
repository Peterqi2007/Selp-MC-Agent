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
const { isInputVerb, hasInputAlternative, INPUT_EXAMPLES } = require('./keyActions');

/** Commands that stay available while a player question is parked (read-only / stop). */
const PARKED_WHITELIST = new Set(['stop', 'inputs', 'state', 'status', 'task', 'keybinds', 'capabilities']);

/**
 * The input-layer rung (2026-11-01 operator report).
 *
 * The verb list itself lives in `keyActions.js` so the channel table, this ladder and the
 * receipts cannot drift: before the unification the ladder's gate named `key`, the channel
 * table listed five verbs, and a Node task failure (the live `deposit` case) named neither.
 */
const INPUT_VERBS = { has: (name) => isInputVerb(name) };
const INPUT_ALTERNATIVE = { has: (name) => hasInputAlternative(name) };

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
      const wantsLookup =
        className === CLASSES.KNOWLEDGE || (className === CLASSES.UNVERIFIED && !entry.inputTried);
      if (wantsLookup) {
        return this._refuse('lookup-required', verb, target, entry, {
          className,
          reason: `${signature} failed ${entry.failures}x with class=${className}: lookup_mod_content before any retry`,
          lookupQuery: this._lookupQuery(itemKey)
        });
      }
      /**
       * No lookup applies (or it has been done and the retry failed): the command channel is
       * not doing the job. Demand the input layer once before escalating to the player.
       */
      if (this._shouldDemandInput(verb, entry)) {
        return this._refuse('input-required', verb, target, entry, {
          className,
          reason:
            `${signature} failed ${entry.failures}x with class=${className}: the command channel is not producing an effect - ` +
            'switch to the input layer (look then key/hold/tap) instead of retrying the same command',
          requires: ['input-layer'],
          next: 'input-layer-then-retry-once',
          inputExamples: INPUT_EXAMPLES
        });
      }
      if (entry.inputTried) {
        /**
         * The input-layer attempt is the last "different approach" before the player. Allow
         * exactly one retry of the original command after it; a failure then escalates.
         */
        if (!entry.postInputFailures) {
          return { ok: true, signature, verb, target, itemKey, inputRetry: true, inputExamples: INPUT_EXAMPLES };
        }
        return this._refuse('ask-required', verb, target, entry, {
          className,
          reason: `${signature} still fails after the input-layer attempt: ask the player (mc_ask_player) or change task`,
          askQuestion: this._askQuestion(verb, itemKey || target, entry)
        });
      }
      return this._refuse('escalation-required', verb, target, entry, {
        className,
        reason: `${signature} failed ${entry.failures}x with class=${className}: change the approach, not the retry count`
      });
    }

    if (informed && entry.informedFailures >= this.cfg.informedAttempts && !entry.answered) {
      if (entry.inputTried && !entry.postInputFailures) {
        return { ok: true, signature, verb, target, itemKey, inputRetry: true, inputExamples: INPUT_EXAMPLES };
      }
      if (this._shouldDemandInput(verb, entry)) {
        return this._refuse('input-required', verb, target, entry, {
          className,
          reason:
            `${signature} still fails after the informed retry: the command channel is not working - ` +
            'switch to the input layer (look then key/hold/tap) for one attempt',
          requires: ['input-layer'],
          next: 'input-layer-then-retry-once',
          inputExamples: INPUT_EXAMPLES
        });
      }
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
    /**
     * The command table wraps a handler as `{ok:true, command:'place', result:{ok:false,...}}`.
     * Judging only the outer ack was a live bug: every failed place looked like a success to
     * the ledger, so the third-attempt gate never fired. The effective outcome is the nested
     * `result` when it carries an `ok` boolean; the outer envelope still carries `command`.
     */
    const nested = result.result && typeof result.result === 'object' ? result.result : null;
    const effective = nested && typeof nested.ok === 'boolean' ? nested : result;
    const { verb, target, itemKey } = this.parseCommand(command);
    const signature = this.signatureOf(verb, target, itemKey);
    if (result.accepted === true && effective.ok !== false) return result; // background ack
    /**
     * A successful input-layer action is the "switch channel" the ladder asked for; it opens
     * exactly one retry of the command that was gated (2026-11-01).
     */
    if (INPUT_VERBS.has(verb) && effective.ok !== false) this._noteInputUsed(verb);
    if (effective.ok === false) {
      const info = fromResult(effective);
      this.recordFailure({ verb, target, itemKey, className: classOf(info.failure), failure: info.failure });
      const entry = this.entries.get(signature);
      const folded = envelope(effective, {
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
      return { ...result, ...folded, ok: false, result: nested || result };
    }
    if (effective.ok !== false) this.recordSuccess({ verb, target, itemKey });
    return result;
  }

  /** Task settle (task:done / task:failed at the TaskSlot exit). */
  recordTaskSettle({ name, ok, reason, description, result }) {
    const verb = String(name || '').toLowerCase();
    if (!verb) return null;
    const target = String(description || '').trim();
    /**
     * The item key prefers **what actually failed** (the reason / result), not the task's
     * nominal target: a `deposit minecraft:dirt` that died placing its chest is a
     * `minecraft:chest` failure, and keying it on dirt made a chest lookup look "not
     * informed" forever (live 2026-11-01). It also lets the task path share the ledger entry
     * with the equivalent `place <item>` command.
     */
    const keyText = [
      result && typeof result === 'object' ? result.item || result.block || '' : '',
      reason || '',
      description || ''
    ].filter(Boolean).join(' ');
    const itemKey = (keyText.match(/[a-z0-9_]+:[a-z0-9_./-]+/i) || [null])[0];
    if (ok === true) {
      /** An input-layer step that ran through mc_plan is the channel switch too. */
      if (isInputVerb(verb)) this._noteInputUsed(verb);
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
    /**
     * Node-task failures (deposit/mine/goto/...) never pass the mc_step gate: their only
     * receipt is this settle. The live 2026-11-01 incident was exactly that - a failed
     * `deposit` whose receipt said `lookup_mod_content` and never mentioned the input layer.
     * Apply the same rung here so the task path cannot lag behind the command path.
     */
    const stage = this._taskEscalation(entry, verb, itemKey, settled.class);
    if (stage) Object.assign(settled, stage);
    this.lastSettled = {
      name: verb, ok: false, reason: settled.reason || null, at: new Date(this.now()).toISOString(),
      failure: settled.failure, class: settled.class, requires: settled.requires, next: settled.next,
      lookupQuery: settled.lookupQuery || null, attempt: settled.attempt || null,
      inputRequired: settled.inputRequired === true
    };
    return settled;
  }

  /**
   * The input-layer rung for a task settle, mirroring `gate()`.
   *
   * @returns {object|null} fields to merge into the envelope (never a new failure)
   */
  _taskEscalation(entry, verb, itemKey, className) {
    if (!entry) return null;
    if (className === CLASSES.PERMISSION) return null;
    if (!hasInputAlternative(verb) || isInputVerb(verb)) return null;
    const informed = this._informed(entry, itemKey);
    const budget = this._budgetFor(className);
    const lookupFirst =
      (className === CLASSES.KNOWLEDGE || className === CLASSES.UNVERIFIED) &&
      !informed &&
      !entry.inputTried;
    if (lookupFirst) {
      /** Lookup is still the first step; name the fallback so it is not a surprise later. */
      return {
        next: 'lookup-then-input-then-ask',
        inputHint: 'after the lookup (and one informed retry) the next step is the input layer, not another command',
        inputExamples: [...INPUT_EXAMPLES]
      };
    }
    if (entry.inputTried && entry.postInputFailures > 0) {
      return {
        requires: ['mc_ask_player'],
        next: 'input-failed-then-ask',
        reason: `${entry.failures}x failed for ${verb} (class=${className}); the input-layer attempt did not help either - ask the player or change task`,
        askQuestion: this._askQuestion(verb, itemKey || verb, entry)
      };
    }
    if (entry.inputTried) {
      return { next: 'input-retry-once', inputExamples: [...INPUT_EXAMPLES] };
    }
    if (informed || entry.failures >= budget) {
      entry.inputDemanded = true;
      return {
        requires: ['input-layer'],
        next: 'input-layer-then-retry-once',
        inputRequired: true,
        inputExamples: [...INPUT_EXAMPLES],
        reason: `${verb} failed ${entry.failures}x (class=${className}): switch to the input layer (look then key/hold/tap) for one attempt`
      };
    }
    return { inputHint: 'if the command keeps failing, switch to the input layer (look/key/hold/tap)' };
  }

  recordFailure({ verb, target, itemKey, className, failure }) {
    const signature = this.signatureOf(verb, target, itemKey);
    let entry = this.entries.get(signature);
    if (!entry) {
      entry = {
        failures: 0,
        lastClass: null,
        lastFailureAt: 0,
        informedFailures: 0,
        answeredFailures: 0,
        answered: false,
        inputDemanded: false,
        inputTried: false,
        postInputFailures: 0
      };
      this.entries.set(signature, entry);
    }
    entry.failures += 1;
    entry.lastClass = className || CLASSES.UNKNOWN;
    entry.lastFailure = failure || null;
    entry.lastFailureAt = this.now();
    if (entry.answered) entry.answeredFailures += 1;
    if (this._informed(entry, itemKey)) entry.informedFailures += 1;
    /** A failure after the input-layer attempt means that channel did not help either. */
    if (entry.inputTried) entry.postInputFailures = (entry.postInputFailures || 0) + 1;
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

  _shouldDemandInput(verb, entry) {
    if (!INPUT_ALTERNATIVE.has(verb)) return false;
    if (INPUT_VERBS.has(verb)) return false;
    if (entry && entry.inputTried) return false;
    return true;
  }

  /**
   * Mark every signature that was refused with `input-required` as having had its input-layer
   * attempt. One retry of the original command is then allowed; a failure after it escalates.
   */
  _noteInputUsed(verb) {
    let marked = 0;
    for (const entry of this.entries.values()) {
      if (!entry.inputDemanded || entry.inputTried) continue;
      entry.inputTried = true;
      entry.inputTriedAt = this.now();
      entry.postInputFailures = 0;
      marked += 1;
    }
    if (marked) this.log.info(`input layer used (${verb}): ${marked} gated signature(s) re-armed once`);
    return marked;
  }

  _refuse(error, verb, target, entry, extra = {}) {
    const className = extra.className || (entry && entry.lastClass) || null;
    if (error === 'input-required' && entry && !entry.inputTried) entry.inputDemanded = true;
    return {
      ok: false,
      error,
      verb,
      target: target || null,
      class: className,
      retryable: false,
      attempt: entry ? { count: entry.failures, budget: this._budgetFor(className) } : null,
      requires:
        extra.requires ||
        (extra.lookupQuery ? ['lookup_mod_content'] : error === 'ask-required' ? ['mc_ask_player'] : []),
      next: extra.next || error,
      inputExamples: extra.inputExamples || null,
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
        answered: entry.answered,
        inputDemanded: entry.inputDemanded === true,
        inputTried: entry.inputTried === true,
        postInputFailures: entry.postInputFailures || 0
      })).slice(-10)
    };
  }
}

module.exports = { FailureEscalation, DEFAULTS, PARKED_WHITELIST };
