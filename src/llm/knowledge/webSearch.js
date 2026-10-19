'use strict';

/**
 * WebSearch - the Node-side network broker for the behavior brain's mod-content lookup
 * (M4 capability / A16; plan file name: webSearch.js, tool name: lookup_mod_content).
 *
 * Generated code never gets direct network access. The behavior brain (DeepSeek harness)
 * calls `lookup_mod_content`; the Node broker performs the HTTP request with the operator's
 * configured key. The language brain must NOT expose this as a tool.
 *
 * Safety rules carried over from docs/LLM-INTEGRATION-PLAN.md §5.1:
 *   - results are data, never instructions: each result is marked `untrusted:true` and is
 *     not concatenated into a model system prompt by this service;
 *   - queries are filtered for coordinates / hostnames / IPs (no server or player
 *     addresses leave the machine);
 *   - 8s timeout, bounded count and content bytes; failures do not retry in a loop;
 *   - results are cached to a human-readable JSON file for review, with a bounded ring.
 *
 * Endpoint: POST https://api.deepseek.com/v1/tools/search
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_QUERY = 128;
const MAX_CONTENT = 8 * 1024;
const CACHE_LIMIT = 50;

/**
 * Source priority for mod/vanilla knowledge. MC百科 (mcmod.cn) is the operator's first
 * choice for Chinese mod content; Minecraft Wiki is the authoritative vanilla fallback.
 * This is a preference, not a whitelist: other mod docs remain valid and are kept after
 * the preferred sources.
 */
const DEFAULT_PREFERRED_SOURCES = [
  { host: 'mcmod.cn', label: 'MC百科' },
  { host: 'minecraft.wiki', label: 'Minecraft Wiki' },
  { host: 'zh.minecraft.wiki', label: 'Minecraft Wiki 中文' }
];

function fingerprint(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 16);
}

function hostnameOf(url) {
  try {
    return new URL(String(url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function preferredRank(url, preferredSources = DEFAULT_PREFERRED_SOURCES) {
  const host = hostnameOf(url);
  if (!host) return preferredSources.length;
  for (let index = 0; index < preferredSources.length; index += 1) {
    const source = preferredSources[index];
    if (host === source.host || host.endsWith(`.${source.host}`)) return index;
  }
  return preferredSources.length;
}

/** Stable re-rank: preferred sources first, the backend's relative order otherwise. */
function rankPreferred(results, preferredSources = DEFAULT_PREFERRED_SOURCES) {
  return results
    .map((result, index) => {
      const rank = preferredRank(result.url, preferredSources);
      const source = preferredSources[rank] || null;
      return {
        ...result,
        preferred: !!source,
        preferredSource: source ? source.label : null,
        sourceRank: rank,
        _order: index
      };
    })
    .sort((a, b) => a.sourceRank - b.sourceRank || a._order - b._order)
    .map(({ _order, ...result }) => result);
}

/** Reject coordinates, IPs, server addresses and player-like entity selectors. */
function unsafeQuery(query) {
  const text = String(query || '');
  if (/\b-?\d{1,4}\s*[, ]\s*-?\d{1,4}\s*[, ]\s*-?\d{1,4}\b/.test(text)) return 'coordinates';
  if (/\b[xyz]\s*[:=]\s*-?\d{1,6}\b/i.test(text)) return 'coordinates';
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)) return 'ip-address';
  if (/@[a-z0-9_]{2,16}\b/i.test(text)) return 'player-name';
  return null;
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return null;
  const title = String(result.title || '').slice(0, 300);
  const url = String(result.url || '').slice(0, 1000);
  const summary = String(result.summary || result.snippet || '').slice(0, 2000);
  const content = String(result.content || '').slice(0, MAX_CONTENT);
  if (!title && !url && !summary) return null;
  return { title, url, summary, content, untrusted: true };
}

class WebSearch {
  /**
   * @param {object} options
   *   baseUrl/apiKey  DeepSeek credentials (reuse the LLM config)
   *   fetchImpl       injectable for tests
   *   cacheFile       human-reviewable cache path (default runtime/search-cache.json)
   *   enabled         false disables the capability entirely
   *   timeoutMs/countMax/maxContentBytes/log/now
   */
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
    this.apiKey = options.apiKey || '';
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.enabled = options.enabled !== false;
    this.cacheFile = options.cacheFile || path.join('runtime', 'search-cache.json');
    this.timeoutMs = options.timeoutMs || 8000;
    this.countMax = options.countMax || 10;
    this.maxContentBytes = options.maxContentBytes || MAX_CONTENT;
    this.log = options.log || { info() {}, warn() {}, debug() {} };
    this.now = options.now || (() => Date.now());
    this.preferredSources = Array.isArray(options.preferredSources)
      ? options.preferredSources
      : DEFAULT_PREFERRED_SOURCES;
    this.cache = this._loadCache();
    this.stats = { calls: 0, ok: 0, failures: 0, filtered: 0, cachedHits: 0 };
  }

  get configured() {
    return !!(this.enabled && this.apiKey && this.fetchImpl);
  }

  /**
   * @param {string} query
   * @param {object} [options] { count, needContent, oriQuestion }
   * @returns {Promise<{ok:boolean, reason?:string, results?:Array, cached?:boolean}>}
   */
  async search(query, options = {}) {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    if (!this.apiKey) return { ok: false, reason: 'no-api-key' };
    if (!this.fetchImpl) return { ok: false, reason: 'fetch-unavailable' };
    const clean = String(query || '').trim();
    if (!clean) return { ok: false, reason: 'query-required' };
    if (clean.length > MAX_QUERY) return { ok: false, reason: 'query-too-long' };
    const unsafe = unsafeQuery(clean);
    if (unsafe) {
      this.stats.filtered += 1;
      return { ok: false, reason: 'privacy-filtered', detail: unsafe };
    }
    const count = Math.min(Math.max(Number(options.count) || 5, 1), this.countMax);
    const key = fingerprint(`${clean}|${count}|${options.needContent ? 1 : 0}`);
    const cached = this.cache[key];
    if (cached && this.now() - cached.at < 1000 * 60 * 60 * 24) {
      this.stats.cachedHits += 1;
      return { ok: true, cached: true, results: rankPreferred(cached.results, this.preferredSources) };
    }

    this.stats.calls += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/tools/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          query: clean,
          count,
          need_content: options.needContent === true,
          ...(options.oriQuestion ? { ori_question: String(options.oriQuestion).slice(0, 128) } : {})
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        this.stats.failures += 1;
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
        return { ok: false, reason: `HTTP ${res.status}`, detail };
      }
      const payload = await res.json();
      const normalized = (payload.results || [])
        .map(normalizeResult)
        .filter(Boolean)
        .slice(0, count)
        .map((result) => ({ ...result, content: result.content.slice(0, this.maxContentBytes) }));
      const results = rankPreferred(normalized, this.preferredSources);
      this._writeCache(key, clean, results);
      this.stats.ok += 1;
      return { ok: true, cached: false, results };
    } catch (err) {
      this.stats.failures += 1;
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
      return { ok: false, reason: aborted ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  status() {
    return {
      enabled: this.enabled,
      configured: this.configured,
      endpoint: `${this.baseUrl}/v1/tools/search`,
      cacheFile: this.cacheFile,
      preferredSources: this.preferredSources.map((source) => ({ ...source })),
      stats: { ...this.stats }
    };
  }

  _loadCache() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
      return {};
    }
  }

  _writeCache(key, query, results) {
    this.cache[key] = { at: this.now(), query, results };
    const entries = Object.entries(this.cache).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    this.cache = Object.fromEntries(entries.slice(0, CACHE_LIMIT));
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, `${JSON.stringify(this.cache, null, 2)}\n`);
    } catch (err) {
      this.log.warn(`search cache write failed: ${err.message}`);
    }
  }
  /**
   * Behavior-brain name. Keep `search` as the low-level method for generated-code RPC.
   * @param {string} query
   * @param {object} [options]
   */
  async lookup(query, options = {}) {
    const result = await this.search(query, options);
    return { ...result, source: 'deepseek-web-search' };
  }
}

module.exports = {
  WebSearch,
  unsafeQuery,
  normalizeResult,
  preferredRank,
  rankPreferred,
  DEFAULT_PREFERRED_SOURCES
};
