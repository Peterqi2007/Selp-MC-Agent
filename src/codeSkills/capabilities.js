'use strict';

/**
 * Code-skill capability surface (M4 v2 direct body + M4 v3 input scripts, 2026-10-29).
 *
 * One table shared by the three places that must agree on "what may be called":
 *   - sandboxWorker builds the vm context from the manifest permissions;
 *   - SandboxRunner checks every RPC against the manifest before calling the host;
 *   - CodeSkillService exposes the host handlers.
 *
 * v3 is the input-script generation surface: a generated skill may press keys, tap toggle
 * keys, look, open/close menus, click slots and use items, and may observe the world - but it
 * may not call the high-level body primitives (`body_move/body_dig/...`), which belong to the
 * deterministic skills. v1/v2 mappings are kept unchanged so already-promoted skills keep
 * working (config `codeSkills.allowLegacyBody`).
 *
 * A ctx method may be backed by a different permission: `block_at`/`find_blocks` are read-only
 * and belong to `read_state`; `look_at` shares `input_look`; `body_look_at` shares `body_look`.
 */
const PERMISSION_METHODS = {
  // ---- v1 orchestration ------------------------------------------------
  read_state: ['read_state', 'state', 'block_at', 'find_blocks'],
  submit_task: ['submit_task'],
  chat: ['chat'],
  wait: ['wait'],
  search: ['search'],
  generate: ['generate'],
  subprocess: ['subprocess'],
  // ---- v2 direct body (legacy: still runnable, never generated) --------
  body_move: ['body_move'],
  body_dig: ['body_dig'],
  body_place: ['body_place'],
  body_use: ['body_use'],
  body_click: ['body_click'],
  body_look: ['body_look', 'body_look_at'],
  body_attack: ['body_attack'],
  // ---- v3 input layer (the only actions a NEW skill may perform) -------
  input_key: ['key'],
  input_hold: ['hold'],
  input_tap: ['tap'],
  input_look: ['look', 'look_at'],
  input_menu: ['menu'],
  input_click: ['click'],
  input_close: ['close'],
  input_select: ['select'],
  input_use_on: ['use_on'],
  input_target: ['target'],
  input_ledger: ['inputs']
};

const BODY_PERMISSIONS = new Set([
  'body_move',
  'body_dig',
  'body_place',
  'body_use',
  'body_click',
  'body_look',
  'body_attack'
]);

const INPUT_PERMISSIONS = new Set([
  'input_key',
  'input_hold',
  'input_tap',
  'input_look',
  'input_menu',
  'input_click',
  'input_close',
  'input_select',
  'input_use_on',
  'input_target',
  'input_ledger'
]);

/**
 * `state()` is the v3 alias of `read_state()`: scripts read best as `await ctx.state()`.
 * It maps to the same read-only permission, so the capability table does not grow.
 */
const INPUT_METHODS = new Set([
  'state',
  'key',
  'hold',
  'tap',
  'look',
  'look_at',
  'menu',
  'click',
  'close',
  'select',
  'use_on',
  'target',
  'inputs'
]);

const METHOD_PERMISSION = {};
for (const [permission, methods] of Object.entries(PERMISSION_METHODS)) {
  for (const method of methods) METHOD_PERMISSION[method] = permission;
}

/** Permission required by a ctx method, or null for an unknown method. */
function permissionFor(method) {
  return METHOD_PERMISSION[method] || null;
}

/** ctx method -> permission map for the worker's context builder. */
function methodsForPermissions(permissions) {
  const wanted = new Set(Array.isArray(permissions) ? permissions : []);
  const out = {};
  for (const [permission, methods] of Object.entries(PERMISSION_METHODS)) {
    if (!wanted.has(permission)) continue;
    for (const method of methods) out[method] = permission;
  }
  return out;
}

module.exports = {
  PERMISSION_METHODS,
  BODY_PERMISSIONS,
  INPUT_PERMISSIONS,
  INPUT_METHODS,
  METHOD_PERMISSION,
  permissionFor,
  methodsForPermissions
};
