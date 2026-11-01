'use strict';

/** Scaffold contracts only: these helpers are not an OS or process sandbox. */
class ContractError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ContractError';
    this.code = code;
  }
}

function cleanText(value) {
  return String(value).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]');
}

/** Bounded JSON projection. Never expose credentials, live objects or raw Error stacks. */
function jsonSafe(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return cleanText(value).slice(0, 16000);
  if (typeof value === 'bigint') return value.toString();
  if (depth > 8 || seen.has(value)) return '[omitted]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 128).map((item) => jsonSafe(item, depth + 1, seen));
  const out = {};
  for (const key of Object.keys(value).slice(0, 128)) {
    if (/^(?:api[_-]?key|authorization|password|secret|credentials|headers|access[_-]?token|refresh[_-]?token)$/i.test(key)) {
      out[key] = '[redacted]';
    } else if (!['__proto__', 'constructor', 'prototype', 'stack'].includes(key)) {
      out[key] = jsonSafe(value[key], depth + 1, seen);
    }
  }
  return out;
}

function errorInfo(error, fallback = 'operation-failed') {
  return { code: cleanText(error && error.code || fallback), message: cleanText(error && error.message || fallback) };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function abortError() { return new ContractError('aborted', 'Operation cancelled'); }

/** Accept actual JSON values only; JSON.stringify silently discards unsupported values. */
function isJsonValue(value, depth = 0, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value)) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).some((key) => !('value' in descriptors[key]) ||
      (!descriptors[key].enumerable && !(Array.isArray(value) && key === 'length')))) return false;
  const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value))
    .every((entry) => isJsonValue(entry, depth + 1, seen));
  seen.delete(value);
  return valid && !Object.keys(value).some((key) => ['__proto__', 'constructor', 'prototype'].includes(key));
}

function mergedSignal(signals = []) {
  const controller = new AbortController();
  const active = signals.filter(Boolean);
  const abort = (reason) => { if (!controller.signal.aborted) controller.abort(typeof reason === 'string' ? reason : 'upstream-cancelled'); };
  for (const signal of active) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return { signal: controller.signal, abort, cleanup: () => active.forEach((signal) => signal.removeEventListener('abort', abort)) };
}

/** Abort the wait, not an uncooperative external side effect. The lease fences its result. */
function withAbort(promise, signals = []) {
  const active = signals.filter(Boolean);
  if (active.some((signal) => signal.aborted)) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => active.forEach((signal) => signal.removeEventListener('abort', onAbort));
    const onAbort = () => { cleanup(); reject(abortError()); };
    active.forEach((signal) => signal.addEventListener('abort', onAbort, { once: true }));
    Promise.resolve(promise).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

async function boundedOperation(name, operation, timeoutMs) {
  let timer;
  try {
    const result = await Promise.race([
      operation,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new ContractError('stop-timeout', name)), timeoutMs); })
    ]);
    if (result && result.ok === false) return { name, ok: false, error: errorInfo(result.error || result, 'stop-refused') };
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: errorInfo(error) };
  } finally { clearTimeout(timer); }
}

/** Same bound as boundedOperation, but keeps the resolved value (driver/session factories). */
async function boundedValue(name, operation, timeoutMs) {
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => operation()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ContractError('operation-timeout', name)), timeoutMs);
      })
    ]);
    return { name, ok: true, value };
  } catch (error) {
    /** `cause` keeps factory-attached recovery handles (e.g. a half-initialized session). */
    return { name, ok: false, error: errorInfo(error), cause: error };
  } finally { clearTimeout(timer); }
}

module.exports = { ContractError, jsonSafe, errorInfo, deferred, withAbort, boundedOperation, boundedValue, isJsonValue, mergedSignal };
