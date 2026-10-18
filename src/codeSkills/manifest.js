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
 *   - `permissions` is a subset of what the host offers. The 2026-10-18 sandbox grant is
 *     `read_state/submit_task/chat/wait/search/generate/subprocess`; direct `fs/net/exec`
 *     are still not on the list - search/generate go through the Node broker and subprocess
 *     is a controlled child script, not a raw shell;
 *   - `apiVersion` is the host contract version (currently 1).
 *
 * This module does not read or run the entry file.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const ALLOWED_PERMISSIONS = new Set([
  'read_state',
  'submit_task',
  'chat',
  'wait',
  'search',
  'generate',
  'subprocess'
]);
const API_VERSION = 1;

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest-required'] };

  if (typeof manifest.name !== 'string' || !NAME_PATTERN.test(manifest.name)) {
    errors.push('name-must-be-namespace.skill');
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    errors.push('version-must-be-semver');
  }
  if (manifest.apiVersion !== API_VERSION) errors.push(`apiVersion-must-be-${API_VERSION}`);

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

module.exports = { validateManifest, compareVersions, ALLOWED_PERMISSIONS, API_VERSION, NAME_PATTERN, VERSION_PATTERN };
