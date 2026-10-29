'use strict';

/**
 * Sandbox worker for M4 generated skills.
 *
 * This file is the *only* place generated code is evaluated. It runs in a separate Node
 * process started by SandboxRunner with:
 *   --permission
 *   --allow-fs-read=<sandbox dir>
 *   --allow-fs-read=<this worker>
 *   --max-old-space-size=128
 *
 * The generated module is evaluated in a vm context with no `require`, no `process`, no
 * `fetch`/network globals and no direct child_process. All effects go through a narrow
 * capability RPC to the trusted parent:
 *
 *     read_state / submit_task / chat / wait / search / generate / subprocess
 *
 * `wait` is local (bounded); the rest are mediated by SandboxRunner and re-checked against
 * the manifest permissions. The parent owns the hard timeout, call budget and process kill.
 */

const fs = require('fs');
const vm = require('vm');
const Module = require('module');
const { methodsForPermissions } = require('./capabilities');

const spec = JSON.parse(process.env.SANDBOX_SPEC || '{}');
delete process.env.SANDBOX_SPEC;
/** Capture the IPC sender, then remove the public handle so escaped code cannot spoof
 * `done`/RPC messages to the parent. */
const ipcSend = typeof process.send === 'function' ? process.send.bind(process) : null;
const exitProcess = process.exit.bind(process);
try {
  process.send = undefined;
} catch {
  /* not configurable */
}
const pending = new Map();
let seq = 0;
let doneSent = false;

function safeValue(value, depth = 0) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 4000);
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) out[String(key).slice(0, 80)] = safeValue(item, depth + 1);
    return out;
  }
  return String(value).slice(0, 1000);
}

function send(message, callback) {
  if (!process.connected || !ipcSend) return;
  try {
    ipcSend(message, callback);
  } catch {
    /* parent gone */
  }
}

function log(level, values) {
  send({ type: 'log', level, values: values.map((value) => safeValue(value)) });
}

function call(capability, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ type: 'rpc', id, capability, args: safeValue(args || {}) });
  });
}

function finish(message) {
  if (doneSent) return;
  doneSent = true;
  send(message, () => exitProcess(0));
  setTimeout(() => exitProcess(0), 50).unref();
}

process.on('message', (message) => {
  if (!message || message.type !== 'rpc-result') return;
  const item = pending.get(message.id);
  if (!item) return;
  pending.delete(message.id);
  if (message.ok) item.resolve(message.result);
  else item.reject(new Error(message.error || 'capability-failed'));
});

process.on('disconnect', () => exitProcess(0));

const capabilities = {
  read_state: (args) => call('read_state', args || {}),
  /** v3 alias: `await ctx.state()` (same read-only capability). */
  state: (args) => call('read_state', args || {}),
  block_at: (args) => call('block_at', args || {}),
  find_blocks: (args) => call('find_blocks', args || {}),
  submit_task: (args) => call('submit_task', args || {}),
  chat: (args) => call('chat', args || {}),
  search: (args) => call('search', args || {}),
  generate: (args) => call('generate', args || {}),
  subprocess: (args) => call('subprocess', args || {}),
  body_move: (args) => call('body_move', args || {}),
  body_dig: (args) => call('body_dig', args || {}),
  body_place: (args) => call('body_place', args || {}),
  body_use: (args) => call('body_use', args || {}),
  body_click: (args) => call('body_click', args || {}),
  body_look: (args) => call('body_look', args || {}),
  body_look_at: (args) => call('body_look_at', args || {}),
  body_attack: (args) => call('body_attack', args || {}),
  /**
   * v3 input layer. Positional signatures read like a script (`ctx.key('forward', true)`),
   * while the RPC payload stays a single object so the host can validate it in one place.
   */
  key: (action, down) => call('key', { action, down: down !== false }),
  hold: (action, ms) => call('hold', { action, ms }),
  tap: (action) => call('tap', { action }),
  look: (yaw, pitch) => call('look', { yaw, pitch }),
  look_at: (position) => call('look_at', position && typeof position === 'object' ? position : {}),
  menu: () => call('menu', {}),
  click: (args) => call('click', args || {}),
  close: () => call('close', {}),
  select: (item) => call('select', typeof item === 'string' ? { item } : item || {}),
  use_on: (args) => call('use_on', args || {}),
  target: () => call('target', {}),
  inputs: () => call('inputs', {}),
  wait: async (ms) => {
    const delay = Math.min(Math.max(Number(ms) || 0, 0), 30000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return { ok: true, waitedMs: delay };
  }
};

const context = {};
/** One ctx method may map to a broader permission (block_at/find_blocks -> read_state). */
const wantedMethods = methodsForPermissions(spec.permissions);
for (const method of Object.keys(wantedMethods)) {
  if (typeof capabilities[method] === 'function') context[method] = capabilities[method];
}
context.log = (...values) => log('info', values);
context.console = {
  log: (...values) => log('info', values),
  info: (...values) => log('info', values),
  warn: (...values) => log('warn', values),
  error: (...values) => log('error', values)
};

(async () => {
  try {
    const code = fs.readFileSync(String(spec.entryPath || ''), 'utf8');
    /**
     * vm is not a security boundary by itself. After the entry has been read, deny the
     * module loader and process escape hatches so a generated module cannot reach fs/net/
     * child_process even if it escapes the context. The Node permission model is the second
     * layer; the static scanner is the first.
     */
    /**
     * Deny EVERY module load after setup, not just a denylist.
     *
     * A19 live 2026-10-25: the vm is not a boundary and `console.log.constructor(...)`
     * reaches this worker's host global (process object). A denylist still left
     * node:repl/crypto/perf_hooks reachable; generated code has no legitimate module use,
     * so the second layer becomes "no modules at all". fs/child_process/net stay denied by
     * name above for the worker's own startup requires, which are already resolved.
     */
    const originalLoad = Module._load;
    Module._load = function guardedLoad(request) {
      const name = String(request || '').replace(/^node:/, '').split('/')[0];
      throw new Error(`sandbox-denied-module:${name}`);
    };
    const originalGetBuiltin = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule : null;
    if (originalGetBuiltin) {
      process.getBuiltinModule = function guardedGetBuiltin(name) {
        const clean = String(name || '').replace(/^node:/, '').split('/')[0];
        throw new Error(`sandbox-denied-module:${clean}`);
      };
    }
    for (const escape of ['binding', '_linkedBinding', 'dlopen', 'mainModule', 'kill', 'exit', 'abort']) {
      try {
        process[escape] = undefined;
      } catch {
        /* not configurable */
      }
    }
    for (const network of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
      try {
        delete globalThis[network];
      } catch {
        /* not configurable */
      }
    }

    const module = { exports: {} };
    const sandbox = {
      module,
      exports: module.exports,
      console: context.console,
      setTimeout,
      clearTimeout
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: String(spec.entryPath || 'entry.js'), timeout: 5000 });
    const exported = sandbox.module.exports || sandbox.exports;
    const run = exported && (exported.run || exported.default || exported);
    if (typeof run !== 'function') {
      finish({ type: 'done', ok: false, reason: 'no-run-export' });
      return;
    }
    const result = await run(context, spec.params && typeof spec.params === 'object' ? spec.params : {});
    finish({ type: 'done', ok: true, result: safeValue(result) });
  } catch (err) {
    finish({
      type: 'done',
      ok: false,
      reason: err && err.name ? `${err.name}: ${err.message}` : String(err),
      stack: err && err.stack ? String(err.stack).slice(0, 4000) : null
    });
  }
})();
