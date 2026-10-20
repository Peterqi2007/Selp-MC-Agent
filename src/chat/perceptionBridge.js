'use strict';

/**
 * PerceptionBridge - pushes edge-triggered autonomous-perception events into the behavior
 * brain (DeepSeek harness).
 *
 * This is the "agent Input" side of the diagram. The action brain can also pull the typed
 * edge log through `mc_perception(type=...)`; pushing wakes the conversation on meaningful
 * changes. A perception event is data, not an instruction and not a permission grant.
 */
class PerceptionBridge {
  constructor(options = {}) {
    this.url = String(options.url || 'http://127.0.0.1:8770').replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.timeoutMs = options.timeoutMs || 3000;
    this.log = options.log || { info() {}, warn() {}, debug() {} };
  }

  /**
   * @param {object} event perception edge ({type, seq, detail, ...})
   * @returns {Promise<{ok:boolean, forwarded?:boolean, reason?:string}>}
   */
  async forward(event) {
    if (!event || !event.type) return { ok: false, reason: 'event-type-required' };
    if (!this.fetchImpl) return { ok: false, reason: 'fetch-unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.url}/perception`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event),
        signal: controller.signal
      });
      let payload = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }
      if (!res.ok || payload.ok !== true) {
        return { ok: false, reason: payload.error || `HTTP ${res.status}`, status: res.status };
      }
      return { ok: true, forwarded: true, type: event.type, agentId: payload.agentId || null };
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
      return { ok: false, reason: aborted ? 'timeout' : err.message };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { PerceptionBridge };
