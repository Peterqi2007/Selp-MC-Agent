'use strict';

/**
 * SandboxRunner - real, restricted execution for M4 code skills.
 *
 * The trusted parent writes the candidate entry into a throwaway directory and starts one
 * Node child with the built-in permission system:
 *
 *   --permission --allow-fs-read=<sandbox> --allow-fs-read=<worker> --max-old-space-size=128
 *
 * No write permission, no child-process permission, no worker/addon/inspector permission.
 * The generated module is evaluated by sandboxWorker.js in a vm context with no require/
 * process/network globals; every effect is an RPC to the host allowlist:
 *
 *   read_state | submit_task | chat | wait | search | generate | subprocess
 *
 * This runner owns the hard wall clock, call budget, result/log caps, cancellation and
 * cleanup. It never returns code to the Node process for require().
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ALLOWED_PERMISSIONS } = require('./manifest');
const { permissionFor } = require('./capabilities');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 60000;
const MAX_CALLS = 100;
const MAX_STREAM_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;

function capString(value, bytes = MAX_STREAM_BYTES) {
  const text = String(value || '');
  return text.length > bytes ? `${text.slice(0, bytes)}\n...[truncated]` : text;
}

function jsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value === undefined ? null : value));
  } catch {
    return Infinity;
  }
}

function safeJson(value, bytes = MAX_RESULT_BYTES) {
  try {
    const text = JSON.stringify(value === undefined ? null : value);
    if (Buffer.byteLength(text) <= bytes) return JSON.parse(text);
    return { truncated: true, preview: text.slice(0, bytes) };
  } catch {
    return { error: 'result-not-serializable' };
  }
}

class SandboxRunner {
  /**
   * @param {object} options
   *   workerPath, sandboxRoot, timeoutMs, maxTimeoutMs, maxCalls, keepDirs, log
   */
  constructor(options = {}) {
    this.workerPath = options.workerPath || path.join(__dirname, 'sandboxWorker.js');
    this.sandboxRoot = options.sandboxRoot || path.join('runtime', 'code-skill-sandbox');
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs || MAX_TIMEOUT_MS;
    this.maxCalls = options.maxCalls || MAX_CALLS;
    this.keepDirs = options.keepDirs === true;
    this.log = options.log || { info() {}, warn() {}, debug() {} };
  }

  /**
   * @param {object} request
   *   name, version, entry, code, manifest, params, timeoutMs, signal, host
   * @returns {Promise<object>} execution evidence
   */
  async run(request = {}) {
    const startedAt = Date.now();
    const runId = `run-${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
    const permissions = Array.isArray(request.manifest && request.manifest.permissions)
      ? request.manifest.permissions
      : [];
    const unknown = permissions.filter((permission) => !ALLOWED_PERMISSIONS.has(permission));
    if (unknown.length) {
      return { ok: false, executed: false, runId, reason: `permission-not-allowed:${unknown.join(',')}` };
    }
    if (request.manifest && request.manifest.entry && request.entry !== request.manifest.entry) {
      return { ok: false, executed: false, runId, reason: 'entry-mismatch' };
    }
    if (typeof request.code !== 'string' || !request.code.trim()) {
      return { ok: false, executed: false, runId, reason: 'code-required' };
    }
    if (!request.host || typeof request.host !== 'object') {
      return { ok: false, executed: false, runId, reason: 'host-required' };
    }

    const timeoutMs = Math.min(Math.max(Number(request.timeoutMs) || this.timeoutMs, 100), this.maxTimeoutMs);
    fs.mkdirSync(this.sandboxRoot, { recursive: true });
    const sandboxDir = fs.mkdtempSync(path.join(this.sandboxRoot, 'run-'));
    const entry = String((request.manifest && request.manifest.entry) || request.entry || 'index.js');
    const entryPath = path.resolve(sandboxDir, entry);
    if (!entryPath.startsWith(`${path.resolve(sandboxDir)}${path.sep}`)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
      return { ok: false, executed: false, runId, reason: 'entry-escapes-sandbox' };
    }
    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, request.code);

    const logs = [];
    let logBytes = 0;
    let calls = 0;
    const callLog = [];
    let child = null;
    let timer = null;
    let settled = false;
    let doneResult = null;
    let spawnError = null;
    let exitInfo = null;
    /**
     * Internal cancellation for host-side capabilities. A runner timeout must also stop a
     * nested subprocess; the service AbortController alone does not fire on runner timeout.
     */
    const runController = new AbortController();

    let cleanupStarted = false;
    const cleanup = (done) => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (timer) clearTimeout(timer);
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        if (!this.keepDirs) {
          try {
            fs.rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          } catch {
            /* best-effort; the run id is still in the evidence */
          }
        }
        if (done) done();
      };
      if (child && child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        child.once('exit', remove);
        const fallback = setTimeout(remove, 1000);
        if (fallback.unref) fallback.unref();
      } else if (child && child.exitCode === null) {
        child.once('exit', remove);
      } else {
        remove();
      }
    };

    const result = await new Promise((resolve) => {
      const finish = (value) => {
        if (settled) return;
        settled = true;
        runController.abort();
        cleanup(() => resolve(value));
      };

      const args = [
        '--permission',
        `--allow-fs-read=${path.resolve(sandboxDir)}`,
        `--allow-fs-read=${path.resolve(this.workerPath)}`,
        `--allow-fs-read=${path.resolve(__dirname, 'capabilities.js')}`,
        '--max-old-space-size=128',
        '--no-warnings',
        this.workerPath
      ];
      const spec = {
        entryPath,
        permissions,
        params: request.params && typeof request.params === 'object' ? request.params : {},
        timeoutMs,
        maxCalls: this.maxCalls
      };
      try {
        child = spawn(process.execPath, args, {
          cwd: sandboxDir,
          env: {
            SANDBOX_SPEC: JSON.stringify(spec),
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP
          },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          windowsHide: true
        });
      } catch (err) {
        spawnError = err.message;
        finish({ ok: false, executed: true, runId, reason: `spawn-failed: ${err.message}` });
        return;
      }

      child.stdout.on('data', (chunk) => {
        if (logBytes >= MAX_STREAM_BYTES) return;
        const text = capString(chunk.toString(), MAX_STREAM_BYTES - logBytes);
        logBytes += text.length;
        logs.push({ stream: 'stdout', text });
      });
      child.stderr.on('data', (chunk) => {
        if (logBytes >= MAX_STREAM_BYTES) return;
        const text = capString(chunk.toString(), MAX_STREAM_BYTES - logBytes);
        logBytes += text.length;
        logs.push({ stream: 'stderr', text });
      });

      child.on('message', (message) => {
        if (!message || typeof message !== 'object') return;
        if (message.type === 'log') {
          if (logBytes >= MAX_STREAM_BYTES) return;
          const text = capString(JSON.stringify(message.values || []), MAX_STREAM_BYTES - logBytes);
          logBytes += text.length;
          logs.push({ stream: 'console', level: message.level || 'info', text });
          return;
        }
        if (message.type === 'done') {
          doneResult = message;
          return;
        }
        if (message.type !== 'rpc') return;
        const id = message.id;
        const capability = String(message.capability || '');
        const reply = (ok, payload) => {
          if (!child || !child.connected) return;
          try {
            child.send({ type: 'rpc-result', id, ok, ...(ok ? { result: payload } : { error: payload }) });
          } catch {
            /* child died */
          }
        };
        if (calls >= this.maxCalls) {
          callLog.push({ capability, denied: 'call-budget' });
          reply(false, 'call-budget-exhausted');
          return;
        }
        const required = permissionFor(capability);
        if (!required || !permissions.includes(required)) {
          callLog.push({ capability, denied: 'permission', required });
          reply(false, `permission-denied:${capability}`);
          return;
        }
        const handler = request.host[capability];
        if (typeof handler !== 'function') {
          callLog.push({ capability, denied: 'no-host-handler' });
          reply(false, `capability-unavailable:${capability}`);
          return;
        }
        calls += 1;
        const entryLog = { capability, argsBytes: jsonSize(message.args) };
        callLog.push(entryLog);
        Promise.resolve()
          .then(() => handler(message.args || {}, { runId, sandboxDir, permissions, signal: runController.signal }))
          .then(
            (value) => {
              entryLog.ok = true;
              reply(true, safeJson(value));
            },
            (err) => {
              entryLog.ok = false;
              entryLog.error = err && err.message ? String(err.message).slice(0, 300) : String(err);
              reply(false, entryLog.error);
            }
          );
      });

      child.on('error', (err) => {
        spawnError = err.message;
        finish({ ok: false, executed: true, runId, reason: `spawn-error: ${err.message}` });
      });
      child.on('exit', (code, signal) => {
        exitInfo = { code, signal };
        if (settled) return;
        if (doneResult) {
          finish({
            ok: doneResult.ok === true,
            executed: true,
            runId,
            reason: doneResult.ok === true ? 'completed' : doneResult.reason || 'skill-failed',
            result: doneResult.result === undefined ? null : doneResult.result,
            stack: doneResult.stack || null
          });
          return;
        }
        finish({
          ok: false,
          executed: true,
          runId,
          reason: `sandbox-exit: code=${code} signal=${signal}`,
          exitCode: code,
          signal
        });
      });

      timer = setTimeout(() => {
        finish({ ok: false, executed: true, runId, reason: 'timeout', timeout: true });
      }, timeoutMs);
      if (timer.unref) timer.unref();

      if (request.signal) {
        if (request.signal.aborted) finish({ ok: false, executed: false, runId, reason: 'cancelled' });
        else if (typeof request.signal.addEventListener === 'function') {
          request.signal.addEventListener(
            'abort',
            () => finish({ ok: false, executed: true, runId, reason: 'cancelled', cancelled: true }),
            { once: true }
          );
        }
      }
    });

    const evidence = {
      ...result,
      runId,
      name: request.name || null,
      version: request.version || null,
      permissions,
      timeoutMs,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      calls: callLog,
      callCount: calls,
      logs,
      exit: exitInfo,
      spawnError,
      sandboxDir: this.keepDirs ? sandboxDir : null,
      limits: { timeoutMs, maxCalls: this.maxCalls, maxStreamBytes: MAX_STREAM_BYTES, maxResultBytes: MAX_RESULT_BYTES }
    };
    return evidence;
  }
}

module.exports = { SandboxRunner, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
