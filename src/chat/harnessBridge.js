'use strict';

/**
 * HarnessBridge - delivery of an approved player text to the behavior brain.
 *
 * The language brain's approval gate decides persona compliance; this bridge only forwards
 * the **original** text to the bound DeepSeek harness. It never rewrites, never adds an
 * action, and never retries a rejected approval.
 */
class HarnessBridge {
  /**
   * @param {object} options { url, fetchImpl, timeoutMs, log }
   */
  constructor(options = {}) {
    this.url = String(options.url || 'http://127.0.0.1:8770').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.timeoutMs = options.timeoutMs || 5000;
    this.log = options.log || { info() {}, warn() {}, debug() {} };
  }

  /**
   * @param {string} text original player text
   * @param {object} [meta] { from }
   * @returns {Promise<{ok:boolean, forwarded?:boolean, reason?:string, error?:string}>}
   */
  async forward(text, meta = {}) {
    const original = String(text || '');
    if (!original.trim()) return { ok: false, reason: 'empty-text' };
    if (!this.fetchImpl) return { ok: false, reason: 'fetch-unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: original, from: meta.from || null }),
        signal: controller.signal
      });
      let payload = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      if (!res.ok || payload.ok !== true) {
        return {
          ok: false,
          reason: payload.error || payload.reason || `HTTP ${res.status}`,
          status: res.status
        };
      }
      return { ok: true, forwarded: true, agentId: payload.agentId || null };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
      return { ok: false, reason: aborted ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Bind the bridge to a live DSH conversation.
   *
   * A DSH restart can leave the plugin unbound while the session id is still valid, so the
   * router retries once after this call when `/message` answers `no-live-agent`.
   *
   * @param {string} agentId live DSH session/agent id
   * @returns {Promise<{ok:boolean, agentId?:string, reason?:string, status?:number}>}
   */
  async bind(agentId) {
    const id = String(agentId || '').trim();
    if (!id) return { ok: false, reason: 'agent-id-required' };
    if (!this.fetchImpl) return { ok: false, reason: 'fetch-unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}/bind`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: id }),
        signal: controller.signal
      });
      let payload = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      if (!res.ok || payload.ok !== true) {
        return {
          ok: false,
          reason: payload.error || payload.reason || `HTTP ${res.status}`,
          status: res.status
        };
      }
      return { ok: true, agentId: payload.agentId || id };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
      return { ok: false, reason: aborted ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { HarnessBridge };
