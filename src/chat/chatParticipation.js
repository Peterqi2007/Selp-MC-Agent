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

function participationPrompt({ persona, memories = [], recent = [], from, maxChars }) {
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
    this.historyLimit = deps.historyLimit || 8;
    this.maxChars = deps.maxChars || 100;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.now = deps.now || (() => Date.now());
    this.seq = 0;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.history = [];
    this.stats = { seen: 0, deduped: 0, considered: 0, replied: 0, silent: 0, stale: 0, dropped: 0, errors: 0 };
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
    const entry = { from: from || null, text: clean, line: line || null, at: new Date(this.now()).toISOString() };
    this.history.push(entry);
    if (this.history.length > this.historyLimit) this.history.shift();
    const snapshot = this.history.slice();
    this.pending += 1;
    this.queue = this.queue
      .then(() => this._consider({ entry, snapshot, requestId }))
      .catch((err) => {
        this.stats.errors += 1;
        this.log.debug(`chat participation failed: ${err.message}`);
      })
      .finally(() => {
        this.pending = Math.max(0, this.pending - 1);
      });
    return { ok: true, queued: true, requestId };
  }

  async _consider({ entry, snapshot, requestId }) {
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
    const recent = snapshot.slice(0, -1).map((item) => `${item.from || '玩家'}: ${item.text}`);
    let raw;
    try {
      raw = await this.complete({
        system: participationPrompt({
          persona: this.persona,
          memories,
          recent,
          from: entry.from,
          maxChars: this.maxChars
        }),
        messages: [{ role: 'user', content: entry.text }],
        maxTokens: this.maxTokens,
        timeoutMs: this.timeoutMs
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
    if (spoke) this.stats.replied += 1;
    else this.stats.dropped += 1;
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
