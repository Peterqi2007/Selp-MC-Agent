'use strict';

/**
 * ProposalChat - the chat-side answer surface for the existing ProposalDesk (P1 M6/A25).
 *
 * The proposal lifecycle itself already exists (`ProposalDesk`): a target is offered, the
 * player can accept/reject/it expires, rejection has a cooldown, and an explicit task
 * supersedes the question. What was missing was a live **chat** answer path; only the
 * deterministic `!proposal` command could answer.
 *
 * This parser is deliberately strict and small:
 *   - it only acts while a proposal is actually pending;
 *   - only an explicit yes/no (standalone word, optionally with punctuation) is accepted;
 *   - anything ambiguous stays unanswered - silence is not consent;
 *   - it never creates a proposal or executes a task itself; it calls the same
 *     `brain.acceptProposal` / `brain.rejectProposal` the command table uses.
 */

const ACCEPT =
  /^(?:是|好|好的|可以|行|同意|接受|准|去吧|没问题|ok|okay|yes|y|accept)\s*[!！。.,，]?$/i;
const REJECT =
  /^(?:不|不是|不要|不行|拒绝|算了|别|no|n|reject)\s*[!！。.,，]?$/i;

function classifyAnswer(text) {
  const clean = String(text || '').trim();
  if (!clean) return { answer: null, reason: 'empty' };
  if (ACCEPT.test(clean)) return { answer: 'accept', reason: 'explicit-yes' };
  if (REJECT.test(clean)) return { answer: 'reject', reason: 'explicit-no' };
  return { answer: null, reason: 'unclear' };
}

class ProposalChat {
  /**
   * @param {object} deps { brain, log, now }
   */
  constructor(deps = {}) {
    this.brain = deps.brain || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.now = deps.now || (() => Date.now());
    this.stats = { seen: 0, accepted: 0, rejected: 0, unclear: 0, errors: 0 };
  }

  /**
   * Classify and, on an explicit answer, settle the pending proposal.
   *
   * Returns synchronously with `handled` so the chat listener can decide whether ordinary
   * chat participation should also see the line; the accept/reject call itself is async.
   */
  handle({ from = null, text = '', line = null } = {}) {
    if (!this.brain || !this.brain.proposals) return { handled: false, reason: 'no-proposals' };
    const pending = typeof this.brain.proposals.pending === 'function' ? this.brain.proposals.pending() : null;
    if (!pending) return { handled: false, reason: 'no-pending' };
    const clean = String(text || '').trim();
    if (!clean) return { handled: false, reason: 'empty' };
    const verdict = classifyAnswer(clean);
    this.stats.seen += 1;
    if (!verdict.answer) {
      this.stats.unclear += 1;
      return { handled: false, reason: verdict.reason, proposalId: pending.id };
    }
    this.stats[verdict.answer === 'accept' ? 'accepted' : 'rejected'] += 1;
    let promise;
    try {
      promise =
        verdict.answer === 'accept'
          ? this.brain.acceptProposal()
          : this.brain.rejectProposal();
    } catch (err) {
      this.stats.errors += 1;
      this.log.warn(`proposal chat ${verdict.answer} threw: ${err.message}`);
      return { handled: false, reason: 'settle-failed', proposalId: pending.id, error: err.message };
    }
    Promise.resolve(promise).catch((err) => {
      this.stats.errors += 1;
      this.log.warn(`proposal chat ${verdict.answer} failed: ${err.message}`);
    });
    this.log.info(`proposal ${pending.id} ${verdict.answer === 'accept' ? 'accepted' : 'rejected'} by chat${from ? ` (${from})` : ''}`);
    return { handled: true, answer: verdict.answer, proposalId: pending.id, line };
  }

  status() {
    return { ...this.stats };
  }
}

module.exports = { ProposalChat, classifyAnswer };
