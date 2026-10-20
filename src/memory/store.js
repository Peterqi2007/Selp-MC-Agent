'use strict';

/**
 * MemoryStore - classified memory for P1 §1.6.1.
 *
 * Three categories, deliberately small and inspectable:
 *
 *   - `episodic`   what happened (time, place, outcome);
 *   - `semantic`   stable facts about the world (recipes, mechanics, landmarks);
 *   - `relational` things about players/agents (preferences, trust, history).
 *
 * Retrieval is lexical + tag based and runs locally: no model, no embeddings. Each entry
 * keeps its `source` and `at` so a later answer can say where a fact came from. The store is
 * bounded per category and serialisable for A17/A29.
 *
 * This is additive: the existing `ctx.memory` (deaths/landmarks/counters) is untouched.
 */

const CATEGORIES = new Set(['episodic', 'semantic', 'relational']);
const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'at', 'and', 'or',
  'for', 'i', 'you', 'we', 'me', 'my', 'your', 'it', 'this', 'that', 'with', 'from'
]);

function cjkTokens(sequence) {
  const chars = [...sequence];
  const out = [];
  for (const char of chars) out.push(char);
  for (let index = 0; index < chars.length - 1; index += 1) {
    out.push(chars[index] + chars[index + 1]);
  }
  return out;
}

/**
 * Lexical tokens with deterministic CJK unigram + bigram expansion.
 *
 * Whitespace tokenization alone makes every Chinese sentence one token ("熔炉怎么做"), so a
 * query for "熔炉" could never match. The expansion keeps English behavior and gives Chinese
 * queries character/bigram overlap without a segmenter dependency.
 */
function tokenize(text) {
  const expanded = String(text || '')
    .toLowerCase()
    .replace(/([\p{Script=Han}]+)/gu, (_match, sequence) => ` ${cjkTokens(sequence).join(' ')} `);
  return [...new Set(
    expanded
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((token) => token && !STOP.has(token))
  )];
}

class MemoryStore {
  constructor(options = {}) {
    this.limitPerCategory = options.limitPerCategory || 200;
    this.now = options.now || (() => Date.now());
    this.entries = new Map();
    this.seq = 0;
  }

  /** @returns {{ok:boolean, entry?:object, reason?:string}} */
  remember(category, input = {}) {
    if (!CATEGORIES.has(category)) return { ok: false, reason: 'unknown-category' };
    const text = String(input.text || '').trim();
    if (!text) return { ok: false, reason: 'empty-text' };
    const entry = {
      id: input.id || `mem${++this.seq}`,
      category,
      text,
      tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
      source: input.source || 'unknown',
      at: input.at || new Date(this.now()).toISOString(),
      data: input.data || null
    };
    this.entries.set(entry.id, entry);
    this._prune(category);
    return { ok: true, entry: { ...entry, tags: [...entry.tags] } };
  }

  /**
   * @param {string} query
   * @param {object} [options] { category, tags, limit }
   * @returns {Array<{entry:object, score:number}>}
   */
  recall(query, options = {}) {
    const wanted = new Set(tokenize(query));
    const limit = options.limit || 5;
    const requiredTags = (options.tags || []).map(String);
    const scored = [];
    for (const entry of this.entries.values()) {
      if (options.category && entry.category !== options.category) continue;
      if (options.source && entry.source !== options.source) continue;
      if (Array.isArray(options.sources) && options.sources.length && !options.sources.includes(entry.source)) continue;
      if (requiredTags.length && !requiredTags.every((tag) => entry.tags.includes(tag))) continue;
      let score = 0;
      const have = new Set(tokenize(entry.text));
      for (const token of wanted) if (have.has(token)) score += 2;
      for (const tag of requiredTags) if (entry.tags.includes(tag)) score += 1;
      if (!wanted.size && !requiredTags.length) score = 1; // browse
      if (score <= 0) continue;
      scored.push({ entry: { ...entry, tags: [...entry.tags] }, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || String(b.entry.at).localeCompare(String(a.entry.at)))
      .slice(0, limit);
  }

  get(id) {
    const entry = this.entries.get(id);
    return entry ? { ...entry, tags: [...entry.tags] } : null;
  }

  remove(id) {
    return this.entries.delete(id);
  }

  status() {
    const counts = { episodic: 0, semantic: 0, relational: 0 };
    for (const entry of this.entries.values()) counts[entry.category] += 1;
    return { total: this.entries.size, counts };
  }

  toJSON() {
    return { seq: this.seq, entries: [...this.entries.values()] };
  }

  restore(data) {
    if (!data || !Array.isArray(data.entries)) return false;
    this.entries.clear();
    this.seq = Number(data.seq) || 0;
    for (const entry of data.entries) {
      if (!entry || !entry.id || !CATEGORIES.has(entry.category) || !entry.text) continue;
      this.entries.set(entry.id, {
        ...entry,
        tags: Array.isArray(entry.tags) ? entry.tags.map(String) : []
      });
    }
    return true;
  }

  _prune(category) {
    const same = [...this.entries.values()].filter((entry) => entry.category === category);
    const excess = same.length - this.limitPerCategory;
    if (excess <= 0) return;
    same.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const entry of same.slice(0, excess)) this.entries.delete(entry.id);
  }
}

module.exports = { MemoryStore, CATEGORIES, tokenize };
