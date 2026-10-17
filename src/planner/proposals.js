'use strict';

/**
 * ProposalDesk - the autonomous-proposal lifecycle (RETIREMENT S3).
 *
 * In `planner.mode = 'proposals'` the rule table still decides *what* would help next, but
 * it no longer executes it: the candidate becomes a **proposal** that waits for a player
 * answer. This is the offline-testable half of P1 §2.4 (the language brain will phrase the
 * question and parse the answer in M3/M6; until then `!proposal` is the deterministic
 * surface).
 *
 * Lifecycle (A25):
 *
 *     propose -> awaiting -> accepted   (player said yes; the caller enqueues the task)
 *                         -> rejected   (player said no; 3 min cooldown for that target)
 *                         -> expired    (no answer is NOT consent; cooldown after expiry)
 *                         -> superseded (an explicit task/stop replaced the question)
 *
 * Standing authorization: accepting with `always: true` adds the target to a persistent
 * set; the next proposal for that target is born accepted (`autoAccepted`). This is the
 * "常驻授权清单" - the player approved that goal class once.
 *
 * `now` is injectable so cooldowns and expiry are tested without waiting.
 */

const silent = { info() {}, warn() {}, debug() {} };

class ProposalDesk {
  /**
   * @param {object} ctx agent context
   * @param {object} [options] { brain, log, cooldownMs, ttlMs, now }
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.brain = options.brain || null;
    this.log = options.log || silent;
    this.cooldownMs = options.cooldownMs || 180000;
    this.ttlMs = options.ttlMs || 300000;
    this.now = options.now || (() => Date.now());
    this.maxLog = options.maxLog || 20;
    this.seq = 0;
    /** @type {null|object} the proposal currently waiting for an answer */
    this.current = null;
    this.history = [];
    /** @type {Map<string, number>} target -> do-not-propose-before timestamp */
    this.cooldownUntil = new Map();
    /** Targets the player approved once with "always". */
    this.authorized = new Set();
  }

  /**
   * Offer a candidate. Never executes anything.
   *
   * @param {{name:string, rule:string, type:string, args:object, reason?:string}} candidate
   * @returns {{ok:boolean, proposal?:object, autoAccepted?:boolean, reason?:string, retryAt?:number}}
   */
  propose(candidate) {
    const at = this.now();
    this.sweep(at);
    if (this.current) return { ok: false, reason: 'pending', proposal: this.current };
    const target = candidate.name;
    const retryAt = this.cooldownUntil.get(target) || 0;
    if (at < retryAt) return { ok: false, reason: 'cooldown', target, retryAt };
    const proposal = {
      id: `p${++this.seq}`,
      target,
      candidate,
      reason: candidate.reason || '',
      status: 'awaiting',
      createdAt: at,
      expiresAt: at + this.ttlMs,
      answeredAt: null,
      by: null,
      note: null
    };
    this.current = proposal;
    this._remember(proposal);
    this._emit('proposal:new', proposal);
    if (this.authorized.has(target)) {
      proposal.status = 'accepted';
      proposal.answeredAt = at;
      proposal.by = 'standing-authorization';
      this.current = null;
      this._emit('proposal:accepted', proposal);
      this.log.info(`proposal ${proposal.id} auto-accepted by standing authorization (${target})`);
      return { ok: true, proposal, autoAccepted: true };
    }
    this.log.info(`proposal ${proposal.id}: ${target} (${proposal.reason})`);
    return { ok: true, proposal, autoAccepted: false };
  }

  pending() {
    return this.current;
  }

  /** Player said yes. `always` adds the target to the standing authorization list. */
  accept(id = null, options = {}) {
    const proposal = this._match(id);
    if (!proposal) return { ok: false, reason: 'no-such-proposal' };
    const at = this.now();
    proposal.status = 'accepted';
    proposal.answeredAt = at;
    proposal.by = options.by || 'player';
    this.current = null;
    if (options.always) this.authorized.add(proposal.target);
    this._emit('proposal:accepted', proposal);
    return { ok: true, proposal };
  }

  /** Player said no. The same target is not proposed again for `cooldownMs`. */
  reject(id = null, options = {}) {
    const proposal = this._match(id);
    if (!proposal) return { ok: false, reason: 'no-such-proposal' };
    const at = this.now();
    proposal.status = 'rejected';
    proposal.answeredAt = at;
    proposal.by = options.by || 'player';
    proposal.note = options.reason || 'rejected';
    this.cooldownUntil.set(proposal.target, at + this.cooldownMs);
    this.current = null;
    this._emit('proposal:rejected', proposal);
    return { ok: true, proposal, retryAt: at + this.cooldownMs };
  }

  /** No answer is not consent: expire it and cool the target down. */
  sweep(at = this.now()) {
    const proposal = this.current;
    if (!proposal || at < proposal.expiresAt) return null;
    proposal.status = 'expired';
    proposal.answeredAt = at;
    this.cooldownUntil.set(proposal.target, at + this.cooldownMs);
    this.current = null;
    this._emit('proposal:expired', proposal);
    this.log.info(`proposal ${proposal.id} expired unanswered (${proposal.target})`);
    return proposal;
  }

  /** An explicit task, stop or death replaced the question. */
  supersede(reason = 'explicit task') {
    const proposal = this.current;
    if (!proposal) return null;
    proposal.status = 'superseded';
    proposal.answeredAt = this.now();
    proposal.note = reason;
    this.current = null;
    this._emit('proposal:superseded', proposal);
    return proposal;
  }

  /** Drop the standing authorization for one target (or all). */
  revoke(target = null) {
    if (target) this.authorized.delete(target);
    else this.authorized.clear();
    return [...this.authorized];
  }

  status() {
    return {
      pending: this.current ? this._view(this.current) : null,
      recent: this.history.slice(-5).map((proposal) => this._view(proposal)),
      authorized: [...this.authorized],
      cooldown: [...this.cooldownUntil.entries()].map(([target, until]) => ({ target, until }))
    };
  }

  _match(id) {
    const proposal = this.current;
    if (!proposal) return null;
    if (id && proposal.id !== id) return null;
    return proposal;
  }

  _remember(proposal) {
    this.history.push(proposal);
    if (this.history.length > this.maxLog) this.history.shift();
  }

  _view(proposal) {
    return {
      id: proposal.id,
      target: proposal.target,
      status: proposal.status,
      reason: proposal.reason,
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      answeredAt: proposal.answeredAt,
      by: proposal.by,
      note: proposal.note
    };
  }

  _emit(event, proposal) {
    const brain = this.brain || (this.ctx && this.ctx.brain);
    if (brain && typeof brain.emit === 'function') brain.emit(event, this._view(proposal));
  }
}

module.exports = { ProposalDesk };
