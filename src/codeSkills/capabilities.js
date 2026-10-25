'use strict';

/**
 * M4 v2 capability surface (2026-10-25 direct-body requirement).
 *
 * One table shared by the three places that must agree on "what may be called":
 *   - sandboxWorker builds the vm context from the manifest permissions;
 *   - SandboxRunner checks every RPC against the manifest before calling the host;
 *   - CodeSkillService exposes the host handlers.
 *
 * A ctx method may be backed by a different permission: `block_at`/`find_blocks` are
 * read-only and therefore belong to `read_state`; `body_look_at` shares `body_look`.
 */
const PERMISSION_METHODS = {
  read_state: ['read_state', 'block_at', 'find_blocks'],
  submit_task: ['submit_task'],
  chat: ['chat'],
  wait: ['wait'],
  search: ['search'],
  generate: ['generate'],
  subprocess: ['subprocess'],
  body_move: ['body_move'],
  body_dig: ['body_dig'],
  body_place: ['body_place'],
  body_use: ['body_use'],
  body_click: ['body_click'],
  body_look: ['body_look', 'body_look_at'],
  body_attack: ['body_attack']
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
  METHOD_PERMISSION,
  permissionFor,
  methodsForPermissions
};
