'use strict';

/**
 * ConversationState - the deterministic half of chat concurrency (P1 M6, A23/A24).
 *
 * The model decides *what* to say; this class decides whether a candidate reply may be sent
 * at all, and whether an incoming line has already been handled:
 *
 *   - duplicate incoming lines (same id, or sender+text) are dropped inside `dedupeMs`;
 *   - a reply to a superseded request is refused (`stale-request`) - two interleaved requests
 *     must not both speak;
 *   - our own line coming back is refused (`self-echo`), never answered;
 *   - replies are rate-limited (`too-soon`) and identical replies are deduped;
 *   - overlong text is truncated to `maxChars` (with `truncated: true`), not sent whole.
 *
 * There is deliberately **no name-keyword filter**: P1 says not to add one. The only identity
 * check is the trigger/prefix, which lives in the listener.
 *
 * Pure and injectable clock; persisted with the session (A17).
 */

class ConversationState {
  constructor(options = {}) {
    this.now = options.now || (() => Date.now());
    this.dedupeMs = options.dedupeMs || 30000;
    this.minGapMs = options.minGapMs || 1500;
    this.maxChars = options.maxChars || 100;
    /** incoming key -> first-seen timestamp */
    this.seen = new Map();
    /** reply text -> last-sent timestamp */
    this.recentReplies = new Map();
    this.lastSentAt = 0;
    this.activeRequest = null;
  }

  /** Mark the request whose answer is still wanted; older answers become stale. */
  beginRequest(requestId) {
    this.activeRequest = requestId || null;
    return this.activeRequest;
  }

  isCurrent(requestId) {
    if (!requestId) return true;
    return this.activeRequest === requestId;
  }

  /** @returns {{ok:boolean, reason?:string}} */
  rememberIncoming({ id, text, from, at } = {}) {
    if (!text) return { ok: false, reason: 'empty' };
    const now = at === undefined ? this.now() : at;
    this._prune(now);
    const key = id ? `id:${id}` : `from:${from || ''}:${String(text)}`;
    const seenAt = this.seen.get(key);
    if (seenAt !== undefined && now - seenAt < this.dedupeMs) return { ok: false, reason: 'duplicate' };
    this.seen.set(key, now);
    return { ok: true };
  }

  /**
   * Approve or refuse a candidate reply.
   *
   * @param {object} input { text, requestId, fromAgent, at }
   * @returns {{ok:boolean, reason?:string, text?:string, truncated?:boolean}}
   */
  approve({ text, requestId, fromAgent = false, at } = {}) {
    const now = at === undefined ? this.now() : at;
    this._prune(now);
    if (fromAgent) return { ok: false, reason: 'self-echo' };
    if (!this.isCurrent(requestId)) return { ok: false, reason: 'stale-request' };
    let body = String(text === undefined || text === null ? '' : text).trim();
    if (!body) return { ok: false, reason: 'empty' };
    if (this.lastSentAt && now - this.lastSentAt < this.minGapMs) return { ok: false, reason: 'too-soon' };
    const lastReply = this.recentReplies.get(body);
    if (lastReply !== undefined && now - lastReply < this.dedupeMs) return { ok: false, reason: 'duplicate-reply' };
    const truncated = body.length > this.maxChars;
    if (truncated) body = body.slice(0, this.maxChars);
    return { ok: true, text: body, truncated };
  }

  /** Record that a reply was actually sent (only after `approve`). */
  markSent(text, at) {
    const now = at === undefined ? this.now() : at;
    this.lastSentAt = now;
    this.recentReplies.set(String(text), now);
    return this.status();
  }

  status() {
    return {
      activeRequest: this.activeRequest,
      lastSentAt: this.lastSentAt,
      seen: this.seen.size,
      recentReplies: this.recentReplies.size
    };
  }

  toJSON() {
    return {
      activeRequest: this.activeRequest,
      lastSentAt: this.lastSentAt,
      seen: [...this.seen.entries()],
      recentReplies: [...this.recentReplies.entries()]
    };
  }

  restore(data) {
    if (!data) return false;
    this.activeRequest = data.activeRequest || null;
    this.lastSentAt = Number(data.lastSentAt) || 0;
    this.seen = new Map(Array.isArray(data.seen) ? data.seen : []);
    this.recentReplies = new Map(Array.isArray(data.recentReplies) ? data.recentReplies : []);
    return true;
  }

  _prune(now) {
    for (const [key, at] of this.seen) {
      if (now - at >= this.dedupeMs) this.seen.delete(key);
    }
    for (const [text, at] of this.recentReplies) {
      if (now - at >= this.dedupeMs) this.recentReplies.delete(text);
    }
  }
}

module.exports = { ConversationState };
