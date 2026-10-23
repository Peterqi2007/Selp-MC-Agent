'use strict';

/**
 * ChatMemory - persistent language-brain conversation memory (M1/M3, A16/A17).
 *
 * The language brain needs four operations that MemoryStore alone does not provide:
 *   save     append a player/assistant turn with sources and tool metadata;
 *   grep     lexical recall (CJK unigram/bigram aware) over saved turns;
 *   context  bounded context injection: summary + relevant matches + recent turns;
 *   compact  fold old turns into one summary so the stored history stays bounded.
 *
 * Entries live in the agent's session state (`runtime/p1-state.json`) through
 * `sessionState.captureState`; this class is deliberately serialisable and has no model or
 * network dependency. Sources are kept for audit and are NOT spoken back in game chat.
 */

const { tokenize } = require('./store');

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_KEEP_RECENT = 40;
const DEFAULT_CONTEXT_CHARS = 4000;

function cleanText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

class ChatMemory {
  /**
   * @param {object} options { maxEntries, keepRecent, contextChars, onChange, now, log }
   */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES;
    this.keepRecent = options.keepRecent || DEFAULT_KEEP_RECENT;
    this.contextChars = options.contextChars || DEFAULT_CONTEXT_CHARS;
    this.onChange = typeof options.onChange === 'function' ? options.onChange : null;
    this.now = options.now || (() => Date.now());
    this.log = options.log || { warn() {}, debug() {} };
    this.entries = [];
    this.seq = 0;
  }

  /**
   * Save one complete turn. A failed/empty assistant reply still saves the player line.
   * @param {object} input { text, reply, speaker, sources, tool, requestId }
   * @returns {object|null} the assistant entry (or user entry when no reply)
   */
  saveTurn(input = {}) {
    const text = cleanText(input.text);
    if (!text) return null;
    const at = new Date(this.now()).toISOString();
    const user = {
      id: `chat-${++this.seq}`,
      seq: this.seq,
      at,
      role: 'user',
      text,
      speaker: input.speaker || null,
      sources: [],
      tool: null,
      requestId: input.requestId || null
    };
    this.entries.push(user);
    const reply = cleanText(input.reply);
    let assistant = null;
    if (reply) {
      assistant = {
        id: `chat-${++this.seq}`,
        seq: this.seq,
        at,
        role: 'assistant',
        text: reply,
        speaker: null,
        sources: Array.isArray(input.sources) ? input.sources.slice(0, 10) : [],
        tool: input.tool || null,
        requestId: input.requestId || null
      };
      this.entries.push(assistant);
    }
    this._compactIfNeeded();
    this._changed();
    return assistant || user;
  }

  /**
   * Attach the assistant reply to the player line the recorder already stored.
   *
   * The global chat recorder writes every non-command player message as a user entry; when
   * the language dialogue answers it, this method appends the assistant half **without**
   * duplicating the user line. If the player line is missing (e.g. a direct LanguageDialogue
   * call in tests), it falls back to a full `saveTurn`.
   *
   * @param {object} input { text, reply, sources, tool, requestId }
   * @returns {object|null} the assistant entry (or null when the reply is empty)
   */
  attachReply(input = {}) {
    const text = cleanText(input.text);
    const reply = cleanText(input.reply);
    if (!text) return null;
    const last = this.entries[this.entries.length - 1];
    if (!reply) {
      if (last && last.role === 'user' && last.text === text) return null;
      return this.saveTurn({ text, speaker: input.speaker, requestId: input.requestId });
    }
    if (last && last.role === 'user' && last.text === text) {
      const assistant = {
        id: `chat-${++this.seq}`,
        seq: this.seq,
        at: new Date(this.now()).toISOString(),
        role: 'assistant',
        text: reply,
        speaker: null,
        sources: Array.isArray(input.sources) ? input.sources.slice(0, 10) : [],
        tool: input.tool || null,
        requestId: input.requestId || null
      };
      this.entries.push(assistant);
      this._compactIfNeeded();
      this._changed();
      return assistant;
    }
    return this.saveTurn({
      text,
      reply,
      speaker: input.speaker,
      sources: input.sources,
      tool: input.tool,
      requestId: input.requestId
    });
  }

  /** Lexical grep with CJK expansion; returns entries with a match score. */
  grep(query, options = {}) {
    const wanted = new Set(tokenize(query));
    if (!wanted.size) return [];
    const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 50);
    const scored = [];
    for (const entry of this.entries) {
      const have = new Set(tokenize(entry.text));
      let score = 0;
      for (const token of wanted) if (have.has(token)) score += 1;
      if (score > 0) scored.push({ entry, score });
    }
    return scored.sort((a, b) => b.score - a.score || b.entry.seq - a.entry.seq).slice(0, limit);
  }

  /**
   * Build bounded chat context for the language prompt: summary first, then relevant grep
   * hits and recent turns, de-duplicated and capped by characters.
   * @returns {Array<{role:string, content:string}>}
   */
  context(options = {}) {
    const budget = Math.min(Math.max(Number(options.budgetChars) || this.contextChars, 200), 12000);
    const query = cleanText(options.query);
    const relevant = query ? this.grep(query, { limit: 6 }).map(({ entry }) => entry) : [];
    const recent = this.entries.slice(-20);
    const selected = new Map();
    for (const entry of this.entries.filter((entry) => entry.role === 'summary')) selected.set(entry.id, entry);
    for (const entry of [...relevant, ...recent]) selected.set(entry.id, entry);
    const ordered = [...selected.values()].sort((a, b) => {
      if (a.role === 'summary' && b.role !== 'summary') return -1;
      if (b.role === 'summary' && a.role !== 'summary') return 1;
      return a.seq - b.seq;
    });
    const messages = [];
    let used = 0;
    for (const entry of ordered) {
      if (entry.role === 'summary') {
        const content = entry.text.slice(0, Math.min(1200, budget));
        messages.push({ role: 'system', content });
        used += content.length;
        continue;
      }
      const body = entry.role === 'user' && entry.speaker ? `${entry.speaker}: ${entry.text}` : entry.text;
      const content = body.slice(0, 1000);
      if (used + content.length > budget) continue;
      messages.push({ role: entry.role === 'assistant' ? 'assistant' : 'user', content });
      used += content.length;
    }
    return messages;
  }

  /**
   * Deterministic compaction: older turns become one summary entry, recent turns stay raw.
   * The summary keeps enough text for recall without a model call. Returns the summary.
   */
  compact(options = {}) {
    const keepRecent = Math.max(1, Number(options.keepRecent) || this.keepRecent);
    if (this.entries.length <= keepRecent) return null;
    const older = this.entries.slice(0, this.entries.length - keepRecent);
    const recent = this.entries.slice(-keepRecent);
    const body = older
      .map((entry) => `${entry.role === 'assistant' ? '大肥鱼' : '玩家'}：${entry.text}`)
      .join('；')
      .slice(0, 2000);
    const previousSummary = older.find((entry) => entry.role === 'summary');
    const summary = {
      id: `chat-${++this.seq}`,
      seq: this.seq,
      at: new Date(this.now()).toISOString(),
      role: 'summary',
      text: `早期对话摘要：${previousSummary ? `${previousSummary.text.replace(/^早期对话摘要：/, '')}；` : ''}${body}`.slice(0, 2400),
      speaker: null,
      sources: [],
      tool: null,
      requestId: null
    };
    this.entries = [summary, ...recent];
    this._changed();
    return summary;
  }

  status() {
    return {
      entries: this.entries.length,
      seq: this.seq,
      summaries: this.entries.filter((entry) => entry.role === 'summary').length,
      last: this.entries[this.entries.length - 1] || null
    };
  }

  toJSON() {
    return { seq: this.seq, entries: this.entries };
  }

  restore(data) {
    if (!data || !Array.isArray(data.entries)) return false;
    this.entries = data.entries.filter(
      (entry) => entry && entry.id && entry.text && ['user', 'assistant', 'summary'].includes(entry.role)
    );
    this.seq = Math.max(Number(data.seq) || 0, ...this.entries.map((entry) => Number(entry.seq) || 0));
    return true;
  }

  _compactIfNeeded() {
    if (this.entries.length > this.maxEntries) this.compact();
  }

  _changed() {
    if (!this.onChange) return;
    try {
      this.onChange();
    } catch (err) {
      this.log.warn(`chat memory change hook failed: ${err.message}`);
    }
  }
}

module.exports = { ChatMemory, DEFAULT_MAX_ENTRIES, DEFAULT_KEEP_RECENT, DEFAULT_CONTEXT_CHARS };
