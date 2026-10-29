'use strict';

/**
 * Skill retrieval: description-as-key plus cosine similarity (Voyager, voyager.py:245-249).
 *
 * Voyager stores `{key: embedding(description), value: program}` and retrieves with
 * `query = context + summarize_chatlog(events)`. The important properties we keep:
 *
 *   - the **key is a vector of the description text**, not a name or a tag list;
 *   - ranking is **cosine similarity**, so "打开背包看看" can retrieve a skill described as
 *     "用 tap 键打开玩家背包并读取菜单"; word-level overlap alone is not the signal;
 *   - the query is **context + what the last round was missing**: the recent failure reason
 *     (which literally contains "missing glass x5"), recent chatlog lines and the current
 *     task. That is what makes the search follow the conversation instead of the action name.
 *
 * Two embedders are provided because this repository has no embedding endpoint configured:
 *
 *   - `LocalEmbedder` (default): tokenizer = ASCII words + CJK bigrams, hashed to a fixed
 *     dimension, IDF-weighted, L2-normalised. Deterministic, offline, unit-testable. It is a
 *     lexical vector space - similarity, not Jaccard/string equality.
 *   - `HttpEmbedder`: OpenAI-compatible `POST {url}/embeddings`; drop-in semantic upgrade once
 *     an endpoint/model/key exists. The index stores the embedder id so a provider change
 *     invalidates cached vectors instead of mixing spaces.
 */

const crypto = require('crypto');

const DEFAULT_DIM = 512;
const DEFAULT_K = 3;
const DEFAULT_MIN_SCORE = 0.18;

function tokenize(text) {
  const source = String(text || '').toLowerCase();
  const tokens = [];
  for (const match of source.matchAll(/[a-z0-9_:-]{2,}/g)) tokens.push(match[0]);
  const cjkOnly = source.replace(/[^\u4e00-\u9fff]+/g, ' ');
  for (const run of cjkOnly.split(/\s+/)) {
    if (!run) continue;
    const chars = [...run];
    if (chars.length === 1) {
      tokens.push(chars[0]);
      continue;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

function hashIndex(term, dim) {
  const digest = crypto.createHash('sha1').update(term).digest();
  return digest.readUInt32BE(0) % dim;
}

function l2normalise(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  }
  return vector;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

class LocalEmbedder {
  constructor(options = {}) {
    this.dim = Number(options.dim) || DEFAULT_DIM;
    this.id = `local-hash-tfidf-v1-${this.dim}`;
    this.idf = new Map();
  }

  /** Fit IDF weights over the corpus (document = the text that will be embedded). */
  fit(documents) {
    const df = new Map();
    for (const document of documents) {
      for (const term of new Set(tokenize(document))) {
        df.set(term, (df.get(term) || 0) + 1);
      }
    }
    const total = Math.max(1, documents.length);
    this.idf = new Map();
    for (const [term, count] of df) {
      this.idf.set(term, Math.log((1 + total) / (1 + count)) + 1);
    }
    return this;
  }

  embed(texts) {
    return this.embedSync(texts);
  }

  /** Same computation, explicit name for callers that must stay synchronous. */
  embedSync(texts) {
    return (Array.isArray(texts) ? texts : [texts]).map((text) => this._embedOne(text));
  }

  _embedOne(text) {
    const vector = new Float64Array(this.dim);
    const terms = tokenize(text);
    if (!terms.length) return vector;
    const counts = new Map();
    for (const term of terms) counts.set(term, (counts.get(term) || 0) + 1);
    for (const [term, count] of counts) {
      const weight = (1 + Math.log(count)) * (this.idf.get(term) || 1);
      vector[hashIndex(term, this.dim)] += weight;
    }
    return l2normalise(vector);
  }
}

/**
 * OpenAI-compatible embeddings (POST {url}/embeddings).
 *
 * `fetchImpl` is injectable for tests; the service never calls this by default because the
 * agent has no embeddings endpoint configured.
 */
class HttpEmbedder {
  constructor(options = {}) {
    if (!options.url) throw new Error('HttpEmbedder needs a url');
    this.url = String(options.url).replace(/\/$/, '');
    this.model = String(options.model || 'text-embedding-3-small');
    this.apiKey = options.apiKey || null;
    this.timeoutMs = Number(options.timeoutMs) || 10000;
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.id = `http-${this.model}`;
    this.dim = null;
  }

  fit() {
    return this;
  }

  async embed(texts) {
    if (!this.fetchImpl) throw new Error('fetch-unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
      const payload = await res.json();
      const rows = Array.isArray(payload.data) ? payload.data : [];
      const vectors = rows.map((row) => l2normalise(Float64Array.from(row.embedding || [])));
      this.dim = vectors[0] ? vectors[0].length : this.dim;
      return vectors;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build the retrieval text for one entry: description first, then the falsifiable bits. */
function documentText(entry) {
  const manifest = (entry && entry.manifest) || {};
  const conditionText = (map) => (map && typeof map === 'object' ? Object.keys(map).join(' ') : '');
  const parts = [
    manifest.name || entry.name || '',
    manifest.description || entry.description || '',
    manifest.title || '',
    conditionText(manifest.preconditions),
    conditionText(manifest.verification),
    Array.isArray(manifest.permissions) ? manifest.permissions.join(' ') : ''
  ];
  return parts.filter(Boolean).join(' \n ');
}

class SkillIndex {
  constructor(options = {}) {
    this.embedder = options.embedder || new LocalEmbedder(options.embedding || {});
    this.k = Number(options.k) || DEFAULT_K;
    this.minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : DEFAULT_MIN_SCORE;
    this.log = options.log || { info() {}, warn() {}, debug() {} };
    this.entries = [];
    this.vectors = [];
    this.builtAt = null;
    this.stale = true;
    this._building = null;
    this._builds = 0;
  }

  get embedderId() {
    return this.embedder && this.embedder.id ? this.embedder.id : 'unknown';
  }

  /** Rebuild the index from promoted entries (metadata only; never imports code). */
  async build(entries) {
    const list = Array.isArray(entries) ? entries : [];
    this.entries = list.map((entry) => ({ ...entry, doc: documentText(entry) }));
    const documents = this.entries.map((entry) => entry.doc);
    if (typeof this.embedder.fit === 'function') this.embedder.fit(documents);
    try {
      const vectors = documents.length ? await this.embedder.embed(documents) : [];
      this.vectors = vectors;
    } catch (err) {
      this.log.warn(`skill index embed failed (${this.embedderId}): ${err.message}`);
      this.vectors = this.entries.map(() => null);
    }
    this.builtAt = new Date().toISOString();
    this.stale = false;
    this._builds += 1;
    return this.status();
  }

  /**
   * Synchronous rebuild for the capability table. Only local embedders can do this; an async
   * embedder leaves the previous vectors in place and marks the index stale (the async
   * `search()` path still works for HTTP providers).
   */
  buildNow(entries) {
    const list = Array.isArray(entries) ? entries : [];
    this.entries = list.map((entry) => ({ ...entry, doc: documentText(entry) }));
    const documents = this.entries.map((entry) => entry.doc);
    if (typeof this.embedder.fit === 'function') this.embedder.fit(documents);
    if (typeof this.embedder.embedSync !== 'function') {
      this.stale = true;
      return { ok: false, reason: 'embedder-async', ...this.status() };
    }
    this.vectors = documents.length ? this.embedder.embedSync(documents) : [];
    this.builtAt = new Date().toISOString();
    this.stale = false;
    this._builds += 1;
    return { ok: true, ...this.status() };
  }

  /** Synchronous cosine search over the current vectors (no provider call). */
  searchSync(query, options = {}) {
    const text = String(query || '').trim();
    const k = Number(options.k) || this.k;
    const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : this.minScore;
    if (!text || !this.entries.length) return { ok: true, query: text, hits: [], embedder: this.embedderId, stale: this.stale };
    if (typeof this.embedder.embedSync !== 'function') {
      return { ok: false, reason: 'embedder-async', query: text, hits: [], embedder: this.embedderId };
    }
    const queryVector = this.embedder.embedSync([text])[0];
    const hits = this.entries
      .map((entry, index) => {
        const vector = this.vectors[index];
        const score = vector ? cosine(queryVector, vector) : 0;
        return {
          name: entry.name,
          version: entry.version,
          score: Math.round(score * 1000) / 1000,
          description: (entry.manifest && entry.manifest.description) || '',
          status: entry.status || 'promoted'
        };
      })
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return { ok: true, query: text, hits, embedder: this.embedderId, stale: this.stale, k, minScore };
  }

  /** Single-flight rebuild: concurrent searches share one build. */
  async rebuild(entries) {
    if (this._building) return this._building;
    this._building = this.build(entries).finally(() => {
      this._building = null;
    });
    return this._building;
  }

  async search(query, options = {}) {
    const text = String(query || '').trim();
    const k = Number(options.k) || this.k;
    const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : this.minScore;
    if (!text || !this.entries.length) return { ok: true, query: text, hits: [], embedder: this.embedderId, stale: this.stale };
    let queryVector;
    try {
      const vectors = await this.embedder.embed([text]);
      queryVector = vectors && vectors[0];
    } catch (err) {
      return { ok: false, reason: `embed-failed: ${err.message}`, query: text, hits: [], embedder: this.embedderId };
    }
    const scored = this.entries
      .map((entry, index) => {
        const vector = this.vectors[index];
        const score = vector ? cosine(queryVector, vector) : 0;
        return {
          name: entry.name,
          version: entry.version,
          score: Math.round(score * 1000) / 1000,
          description: (entry.manifest && entry.manifest.description) || '',
          status: entry.status || 'promoted'
        };
      })
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    return { ok: true, query: text, hits: scored, embedder: this.embedderId, stale: this.stale, k, minScore };
  }

  status() {
    return {
      embedder: this.embedderId,
      entries: this.entries.length,
      builtAt: this.builtAt,
      builds: this._builds,
      stale: this.stale,
      k: this.k,
      minScore: this.minScore,
      names: this.entries.map((entry) => `${entry.name}@${entry.version}`)
    };
  }
}

/**
 * Build the retrieval query: context + what the last round was missing.
 *
 * Mirrors Voyager's `query = context + "\n\n" + summarize_chatlog(events)`:
 *   - context: the action name and the task the brain is working on;
 *   - "missing": the newest failure/partial reason (these strings literally name what was
 *     missing, e.g. "missing glass x5" / "no not_a_real_block available nearby");
 *   - chatlog: the recent player/agent lines so a follow-up like "再来一次" still finds the
 *     skill that the previous line introduced.
 */
function buildSkillQuery(ctx, action, options = {}) {
  const maxChars = Number(options.maxChars) || 1200;
  const parts = [];
  const name = String(action || '').trim();
  if (name) parts.push(name);

  const brain = ctx && ctx.brain;
  const current = brain && brain.currentTask;
  if (current) {
    parts.push(`当前任务: ${current.name || current.type || ''} ${current.description || ''}`.trim());
  }

  const events = ctx && ctx.events && typeof ctx.events.since === 'function' ? ctx.events.since(0) : [];
  const failureTypes = new Set(['task:failed', 'plan:partial', 'plan:failed', 'plan:step']);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event || !failureTypes.has(event.type)) continue;
    if (!event.reason) continue;
    parts.push(`上一轮失败/未完成: ${String(event.reason).slice(0, 300)}`);
    break;
  }

  const history = ctx && ctx.languageBrain && Array.isArray(ctx.languageBrain.history)
    ? ctx.languageBrain.history.slice(-8)
    : [];
  for (const line of history) {
    if (!line || !line.text) continue;
    parts.push(`${line.self ? '我' : line.from || '玩家'}: ${String(line.text).slice(0, 160)}`);
  }

  const commands = ctx && ctx.chat && Array.isArray(ctx.chat.history) ? ctx.chat.history.slice(-5) : [];
  for (const entry of commands) {
    if (!entry || !entry.command) continue;
    parts.push(`命令: ${entry.command} ${(entry.args || []).join(' ')}`.trim());
  }

  return parts.join('\n').slice(0, maxChars);
}

module.exports = {
  LocalEmbedder,
  HttpEmbedder,
  SkillIndex,
  buildSkillQuery,
  documentText,
  tokenize,
  cosine,
  DEFAULT_DIM,
  DEFAULT_K,
  DEFAULT_MIN_SCORE
};
