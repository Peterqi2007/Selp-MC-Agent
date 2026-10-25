'use strict';

/**
 * Code-skill manifest validation (P1 M4, A18/A20).
 *
 * A generated code skill is first of all metadata: a namespaced name, a version, an entry
 * file inside its own directory, and a small permission set. Validation is strict on the
 * things that make a skill addressable and safe to *consider*:
 *
 *   - `name` is `namespace.skill` (lowercase, no spaces) - the namespace keeps generated
 *     skills from overwriting built-ins;
 *   - `version` is plain semver (`1.2.3`), so promotion/rollback can be exact;
 *   - `entry` is a relative `.js` path with no `..` and no absolute path - the runner must
 *     not be able to point outside the skill directory;
 *   - `permissions` is a subset of what the host offers. apiVersion 1 is the 2026-10-18
 *     orchestration surface (`read_state/submit_task/chat/wait/search/generate/subprocess`);
 *     apiVersion 2 (2026-10-25 direct-body requirement) adds `body_move/body_dig/
 *     body_place/body_use/body_click/body_look/body_attack`. Direct `fs/net/exec` remain
 *     unavailable; body primitives go through the single TaskSlot owner and permissionGate;
 *   - `apiVersion` is the host contract version (1 = orchestration, 2 = direct body).
 *
 * This module does not read or run the entry file.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const API_VERSION = 2;
const API_VERSIONS = new Set([1, 2]);
const LEGACY_PERMISSIONS = ['read_state', 'submit_task', 'chat', 'wait', 'search', 'generate', 'subprocess'];
const BODY_PERMISSIONS = [
  'body_move',
  'body_dig',
  'body_place',
  'body_use',
  'body_click',
  'body_look',
  'body_attack'
];
const ALLOWED_PERMISSIONS = new Set([...LEGACY_PERMISSIONS, ...BODY_PERMISSIONS]);

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest-required'] };

  if (typeof manifest.name !== 'string' || !NAME_PATTERN.test(manifest.name)) {
    errors.push('name-must-be-namespace.skill');
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    errors.push('version-must-be-semver');
  }
  if (!API_VERSIONS.has(manifest.apiVersion)) errors.push('apiVersion-must-be-1-or-2');

  if (typeof manifest.entry !== 'string' || !manifest.entry) {
    errors.push('entry-required');
  } else {
    const entry = manifest.entry.replace(/\\/g, '/');
    if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry)) errors.push('entry-must-be-relative');
    if (entry.split('/').includes('..')) errors.push('entry-must-not-escape-directory');
    if (!entry.endsWith('.js')) errors.push('entry-must-be-javascript');
  }

  if (!Array.isArray(manifest.permissions)) {
    errors.push('permissions-must-be-an-array');
  } else {
    for (const permission of manifest.permissions) {
      if (!ALLOWED_PERMISSIONS.has(permission)) errors.push(`permission-not-allowed:${permission}`);
      else if (manifest.apiVersion === 1 && BODY_PERMISSIONS.includes(permission)) {
        errors.push(`permission-requires-api-2:${permission}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

module.exports = {
  validateManifest,
  compareVersions,
  ALLOWED_PERMISSIONS,
  BODY_PERMISSIONS,
  API_VERSION,
  NAME_PATTERN,
  VERSION_PATTERN
};
