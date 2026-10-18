'use strict';

/**
 * UsageLedger - one JSONL record per provider request (P1 M7/A30).
 *
 * The aggregate `tokensToday` is useful for the budget gate, but A30 needs more: every
 * model request must be attributable to a request/kind after the run, and a response with
 * no `usage` object must be recorded as **unknown**, never as zero.
 *
 * Records are append-only JSONL. A write failure is logged/ignored - accounting must not
 * break a turn - but the in-memory status still says how many records were attempted so a
 * missing file is visible.
 *
 * No provider response body or prompt text is stored here; only identity, model, timing,
 * status and normalized token counts.
 */

const fs = require('fs');
const path = require('path');

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Normalize provider usage; missing fields stay unknown (null), never 0. */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const promptTokens = finiteNumber(usage.prompt_tokens ?? usage.promptTokens);
  const completionTokens = finiteNumber(usage.completion_tokens ?? usage.completionTokens);
  const totalTokens = finiteNumber(usage.total_tokens ?? usage.totalTokens);
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
  return { promptTokens, completionTokens, totalTokens };
}

class UsageLedger {
  /**
   * @param {object} options { file, enabled, now, log }
   */
  constructor(options = {}) {
    this.file = options.file || path.join('runtime', 'llm-usage.jsonl');
    this.enabled = options.enabled !== false;
    this.now = options.now || (() => Date.now());
    this.log = options.log || { warn() {}, debug() {} };
    this.records = 0;
    this.failures = 0;
    this.lastRecord = null;
  }

  /**
   * @param {object} input { requestId, kind, model, provider, ok, usage, status, error, ms, meta }
   * @returns {object|null} the normalized record
   */
  record(input = {}) {
    if (!this.enabled) return null;
    const usage = normalizeUsage(input.usage);
    const ok = input.ok === true;
    const status = ok ? (usage ? 'ok' : 'missing-usage') : input.status || 'error';
    const entry = {
      at: new Date(input.at || this.now()).toISOString(),
      requestId: input.requestId || null,
      kind: input.kind || 'unknown',
      model: input.model || null,
      provider: input.provider || null,
      ok,
      status,
      usage,
      error: input.error || null,
      ms: Number.isFinite(Number(input.ms)) ? Number(input.ms) : null,
      meta: input.meta && typeof input.meta === 'object' ? input.meta : null
    };
    this.lastRecord = entry;
    this.records += 1;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      this.failures += 1;
      this.log.warn(`usage ledger write failed: ${err.message}`);
    }
    return entry;
  }

  status() {
    return {
      enabled: this.enabled,
      file: this.file,
      records: this.records,
      failures: this.failures,
      last: this.lastRecord
        ? {
            requestId: this.lastRecord.requestId,
            kind: this.lastRecord.kind,
            status: this.lastRecord.status,
            usage: this.lastRecord.usage
          }
        : null
    };
  }
}

module.exports = { UsageLedger, normalizeUsage };
