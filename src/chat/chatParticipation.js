'use strict';

/**
 * ChatParticipation - the live entry for A23/A24's "participate or stay silent" decision
 * (P1 M6).
 *
 * The offline half (`ConversationState`) already answers "may this reply be sent?"; what was
 * missing was a live caller that:
 *   - receives ordinary multiplayer chat (not `!`, not the dialogue trigger);
 *   - asks the model whether this line needs a reply, with a prompt that allows **silence**;
 *   - passes the decision through the same `ConversationState` request lifecycle and the
 *     single `reply()` path, so stale/duplicate/rate-limit/self-echo rules actually run.
 *
 * This module can only *talk*. It has no action tools, no brain/task/body handle, and the
 * model is told to return exactly one JSON object. A malformed answer is silence, not a
 * guessed action.
 *
 * It is opt-in (`chat.participate=false` by default): enabling it changes the agent from
 * "answers when addressed" to "may join ordinary chat", which is a real behaviour change
 * and belongs to the M6 client window.
 */

function parseParticipation(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : text;
  try {
    const data = JSON.parse(candidate);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function participationPrompt({ persona, memories = [], recent = [], from, maxChars, selfLabel = '我' }) {
  return [
    'You are the chat half of a Minecraft agent on a multiplayer server.',
    'Decide whether the latest player chat line needs a reply from you.',
    'You may only speak or stay silent. You cannot execute tasks, skills, movement, or stop.',
    'Answer with exactly one JSON object and nothing else:',
    '  {"respond":true,"text":"one short line"} or {"respond":false}',
    'Rules:',
    '- Stay silent for side conversations, commands, server notices, and lines not worth answering.',
    '- Do not repeat a line you already answered.',
    '- If the latest line supersedes an earlier one, answer only the latest.',
    `- Lines starting with "${selfLabel}:" are your own earlier replies; use them for continuity.`,
    `- Keep text under ${maxChars} characters; no action claims.`,
    persona ? `Persona: ${persona}` : null,
    memories.length
      ? `Relevant memory:\n${memories.map((memory) => `- [${memory.category || 'memory'}] ${memory.text}`).join('\n')}`
      : null,
    recent.length ? `Recent chat:\n${recent.join('\n')}` : null,
    from ? `Latest speaker: ${from}` : null
  ]
    .filter(Boolean)
    .join('\n');
}

class ChatParticipation {
  /**
   * @param {object} deps
   *   ctx          agent context (conversation, memory, body)
   *   enabled      boolean; false is a complete no-op
   *   complete     async ({system,messages,maxTokens,timeoutMs}) -> string|{ok,text}
   *   reply        ctx.reply (single output path)
   *   conversation ConversationState
   *   persona      persona text
   *   memoryFor    (text) => [{category,text}]
   *   maxTokens / timeoutMs / historyLimit / maxChars
   */
  constructor(deps = {}) {
    this.ctx = deps.ctx || {};
    this.enabled = deps.enabled === true;
    this.complete = deps.complete || null;
    this.reply = deps.reply || (this.ctx.reply ? this.ctx.reply.bind(this.ctx) : null);
    this.conversation = deps.conversation || this.ctx.conversation || null;
    this.persona = deps.persona || null;
    this.memoryFor = deps.memoryFor || null;
    this.maxTokens = deps.maxTokens || 120;
    this.timeoutMs = deps.timeoutMs || 4000;
    /** How many prior chat lines (players + our own replies) the prompt shows. */
    this.historyLimit = deps.historyLimit || 15;
    this.selfLabel = deps.selfLabel || '我';
    this.maxChars = deps.maxChars || 100;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.now = deps.now || (() => Date.now());
    this.seq = 0;
    /** Monotonic order for incoming lines; our own replies get order + 0.5. */
    this.entrySeq = 0;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.history = [];
    this.stats = {
      seen: 0,
      deduped: 0,
      considered: 0,
      replied: 0,
      silent: 0,
      stale: 0,
      dropped: 0,
      errors: 0,
      self: 0
    };
    /** A persisted window is a context cache, never a replay queue. */
    if (Array.isArray(deps.history)) this.restore({ history: deps.history });
  }

  /**
   * Queue one ordinary chat line. Returns immediately; ChatListener must not be blocked by a
   * model call. Duplicate lines are dropped by the shared ConversationState before the model
   * is touched.
   */
  handle({ from = null, text = '', line = null } = {}) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, reason: 'empty' };
    if (!this.complete || !this.reply || !this.conversation) return { ok: false, reason: 'not-wired' };
    if (typeof this.conversation.rememberIncoming !== 'function') return { ok: false, reason: 'no-conversation-state' };

    const incoming = this.conversation.rememberIncoming({ text: clean, from: from || null });
    if (!incoming.ok) {
      this.stats.deduped += 1;
      return { ok: false, reason: incoming.reason };
    }
    this.stats.seen += 1;
    const requestId = `chat-${++this.seq}`;
    this.conversation.beginRequest(requestId);
    const entry = {
      order: (this.entrySeq = Math.floor(this.entrySeq) + 1),
      from: from || null,
      text: clean,
      line: line || null,
      self: false,
      at: new Date(this.now()).toISOString()
    };
    this.history.push(entry);
    this._trimHistory();
    this.pending += 1;
    this.queue = this.queue
      .then(() => this._consider({ entry, requestId }))
      .catch((err) => {
        this.stats.errors += 1;
        this.log.debug(`chat participation failed: ${err.message}`);
      })
      .finally(() => {
        this.pending = Math.max(0, this.pending - 1);
      });
    return { ok: true, queued: true, requestId };
  }

  async _consider({ entry, requestId }) {
    /**
     * A newer message already superseded this one: do not spend a model call on an answer
     * that `ConversationState` would refuse anyway.
     */
    if (this.conversation.activeRequest !== requestId) {
      this.stats.stale += 1;
      return;
    }
    this.stats.considered += 1;
    const memories = typeof this.memoryFor === 'function' ? this.memoryFor(entry.text) || [] : [];
    /**
     * Context is ordered by `order`, not by arrival time:
     * - entries with `order < entry.order` happened before this line;
     * - our own replies use `order + 0.5`, so a reply to line N is visible to N+1
     *   but a line that arrived later (and is queued) never leaks into this prompt.
     * This is also why we never read the chat log back: operator lines typed on the
     * agent's own account must not be mistaken for the agent's speech.
     */
    const recentEntries = this.history.filter((item) => item.order < entry.order).slice(-this.historyLimit);
    const recent = recentEntries.map((item) => this._formatLine(item));
    let raw;
    try {
      raw = await this.complete({
        system: participationPrompt({
          persona: this.persona,
          memories,
          recent,
          from: entry.from,
          maxChars: this.maxChars,
          selfLabel: this.selfLabel
        }),
        messages: [{ role: 'user', content: entry.text }],
        maxTokens: this.maxTokens,
        timeoutMs: this.timeoutMs,
        usageContext: { requestId, kind: 'chat-participation' }
      });
    } catch (err) {
      this.stats.errors += 1;
      this.log.debug(`chat participation model error: ${err.message}`);
      return;
    }
    if (raw && typeof raw === 'object' && raw.ok === false) {
      this.stats.errors += 1;
      return;
    }
    if (raw && typeof raw === 'object' && typeof raw.text === 'string') raw = raw.text;

    const parsed = parseParticipation(raw);
    if (!parsed || parsed.respond !== true) {
      this.stats.silent += 1;
      return;
    }
    let text = String(parsed.text || '').trim();
    if (!text) {
      this.stats.silent += 1;
      return;
    }
    if (text.length > this.maxChars) text = text.slice(0, this.maxChars);
    if (this.conversation.activeRequest !== requestId) {
      this.stats.stale += 1;
      return;
    }
    const spoke = await this.reply(text, {
      conversation: true,
      requestId,
      why: 'chat-participation'
    });
    if (spoke) {
      this.stats.replied += 1;
      /**
       * Store the exact text we just sent, AFTER a successful send. Never read it back from
       * the chat log: the operator shares the agent's account, so an echo-based hook would
       * capture human lines as agent speech.
       */
      this._rememberSelf(text, entry);
    } else {
      this.stats.dropped += 1;
    }
  }

  _formatLine(item) {
    const speaker = item.self ? this.selfLabel : item.from || '玩家';
    return `${speaker}: ${item.text}`;
  }

  /** Our own reply sits between this line (N) and the next incoming line (N+1). */
  _rememberSelf(text, entry) {
    if (!text) return;
    this.history.push({
      order: entry.order + 0.5,
      from: this.selfLabel,
      text,
      self: true,
      at: new Date(this.now()).toISOString()
    });
    this.stats.self += 1;
    this._trimHistory();
  }

  /**
   * Keep a little more than the prompt window so self lines can interleave without
   * dropping lines a queued request still needs. The prompt itself slices to historyLimit.
   */
  _trimHistory() {
    const keep = this.historyLimit * 2 + 4;
    while (this.history.length > keep) this.history.shift();
  }

  /**
   * Persisted with the session (A17). Only the bounded window is stored; it is context for
   * the next decision, never replayed as incoming messages or model calls.
   */
  toJSON() {
    return {
      history: this.history.slice(-(this.historyLimit * 2 + 4)).map((item) => ({
        order: item.order,
        from: item.from || null,
        text: item.text,
        self: item.self === true,
        at: item.at || null
      }))
    };
  }

  /** Restore a saved window. Invalid/legacy entries are dropped, never guessed. */
  restore(data) {
    const raw = data && Array.isArray(data.history) ? data.history : [];
    let fallback = 0;
    const entries = raw
      .filter((item) => item && typeof item.text === 'string' && item.text.trim())
      .map((item) => {
        const order = Number(item.order);
        return {
          order: Number.isFinite(order) && order > 0 ? order : ++fallback,
          from: item.from || null,
          text: String(item.text),
          self: item.self === true,
          at: item.at || null
        };
      })
      .slice(-(this.historyLimit * 2 + 4));
    this.history = entries;
    this.entrySeq = entries.reduce((max, item) => Math.max(max, item.order), 0);
    return entries.length > 0;
  }

  status() {
    return {
      enabled: this.enabled,
      pending: this.pending,
      history: this.history.length,
      ...this.stats
    };
  }
}

module.exports = { ChatParticipation, parseParticipation, participationPrompt };
