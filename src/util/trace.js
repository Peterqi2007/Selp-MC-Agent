'use strict';

/**
 * Append-only JSONL traces.
 *
 * The plan asks for two of these (P0-PLAN §8): `runtime/path-trace.jsonl` for every moveTo
 * and `runtime/llm-trace.jsonl` for every brain turn. They exist because both of those
 * subsystems are *stochastic in production and invisible from the outside*: when the bot
 * walks into a wall you cannot tell whether A* returned noPath, the walker stalled, or the
 * client simply refused, and when the LLM picks a silly action you cannot see what it was
 * actually asked.
 *
 * Deliberately a fire-and-forget append rather than a log framework:
 *   - writing must never break the agent, so every failure is swallowed
 *   - one JSON object per line keeps `Select-String` / `jq` usable without a parser
 *   - the file is capped by trimming on startup, not on write (a rotate mid-run would
 *     lose the very trace you are debugging)
 */

const fs = require('fs');
const path = require('path');

/** Above this size a trace is truncated to its last half at open time. */
const MAX_BYTES = 2 * 1024 * 1024;

const opened = new Set();

/** Create the parent directory once, and trim an oversized file. */
function prepare(file) {
  if (opened.has(file)) return;
  opened.add(file);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && stat.size > MAX_BYTES) {
      const text = fs.readFileSync(file, 'utf8');
      const half = text.slice(Math.floor(text.length / 2));
      // Cut at a line boundary so the file never starts mid-record.
      const nl = half.indexOf('\n');
      fs.writeFileSync(file, nl === -1 ? '' : half.slice(nl + 1), 'utf8');
    }
  } catch {
    /* tracing is best-effort */
  }
}

/**
 * Append one record.
 *
 * @param {string} file absolute or relative path to the .jsonl file
 * @param {object} record JSON-serialisable object; `at` is added when missing
 */
function appendTrace(file, record) {
  if (!file) return;
  try {
    prepare(file);
    const entry = record && record.at ? record : { at: new Date().toISOString(), ...record };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    /* never let observability break the agent */
  }
}

/**
 * Build a tracer bound to one file.
 *
 * Returns a no-op when `file` is falsy, so callers can pass `cfg.trace` straight through
 * and tracing stays optional without a single branch at the call site.
 *
 * @param {string} file
 * @param {object} [base] fields merged into every record
 * @returns {(record:object)=>void}
 */
function tracer(file, base = {}) {
  if (!file) return () => {};
  return (record) => appendTrace(file, { ...base, ...record });
}

/** Read the last `n` records, newest last. Used by the status server. */
function readTrace(file, n = 10) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n').filter((line) => line.trim());
    return lines.slice(-n).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });
  } catch {
    return [];
  }
}

/**
 * Line counts, cached per file.
 *
 * The panel shows "path-trace N lines", and doing that with `readTrace(file, 1e6).length`
 * would re-read a multi-megabyte file once a second. Since traces are strictly
 * append-only, the count only ever needs the bytes added since the last look.
 *
 * @type {Map<string, {size:number, lines:number, partial:boolean}>}
 */
const counters = new Map();

/**
 * Count records in a trace file, reading only what has been appended since last time.
 *
 * @param {string} file
 * @returns {number}
 */
function countTrace(file) {
  if (!file) return 0;
  try {
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (!stat) return 0;
    const cached = counters.get(file);

    // Truncated or rotated: start over.
    if (!cached || stat.size < cached.size) {
      const text = fs.readFileSync(file, 'utf8');
      const complete = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
      const lines = complete ? complete.split('\n').length - 1 : 0;
      counters.set(file, { size: Buffer.byteLength(text), lines, partial: !text.endsWith('\n') });
      return lines;
    }
    if (stat.size === cached.size) return cached.lines;

    const fd = fs.openSync(file, 'r');
    try {
      const length = stat.size - cached.size;
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, cached.size);
      const text = buffer.toString('utf8');
      // Only count terminators, so a half-written final line is not counted twice.
      const added = (text.match(/\n/g) || []).length;
      const state = { size: stat.size, lines: cached.lines + added, partial: !text.endsWith('\n') };
      counters.set(file, state);
      return state.lines;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return 0;
  }
}

module.exports = { appendTrace, tracer, readTrace, countTrace, MAX_BYTES };
