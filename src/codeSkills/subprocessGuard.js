'use strict';

/**
 * Preload guard for the `subprocess` capability (A19, 2026-10-25).
 *
 * Node's permission model (v24) covers filesystem, child-process, worker, addon and
 * inspector access, but **not network**. A generated skill could otherwise hand a child
 * script that calls `fetch`/`node:net` and reach the internet. The sandbox contract says
 * generated code has no direct network, so the child is started with:
 *
 *   --permission --allow-fs-read=<sandbox> --allow-fs-read=<this file> --require <this file>
 *
 * This guard closes the JS-level network and module surface (defense in depth, not an OS
 * firewall): every builtin require is denied, network globals are removed and the process
 * escape hatches are cleared. `fs`/`child_process` are additionally denied by the Node
 * permission flags even if a native escape got past this file.
 */

const Module = require('module');

const originalLoad = Module._load;
Module._load = function guardedLoad(request, parent, isMain) {
  /** The entry script itself is the thing we were asked to run; its requires are not. */
  if (isMain === true) return originalLoad.call(this, request, parent, isMain);
  const name = String(request || '').replace(/^node:/, '').split('/')[0];
  throw new Error(`sandbox-denied-module:${name}`);
};

for (const key of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']) {
  try {
    delete globalThis[key];
  } catch {
    /* not configurable */
  }
}
for (const key of ['binding', '_linkedBinding', 'dlopen', 'mainModule', 'kill', 'exit', 'abort']) {
  try {
    process[key] = undefined;
  } catch {
    /* not configurable */
  }
}
