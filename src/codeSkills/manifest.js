'use strict';

/**
 * Code-skill manifest validation (P1 M4, A18/A20; v3 input-script refactor 2026-10-29).
 *
 * A generated code skill is first of all metadata. From apiVersion 3 the manifest is a
 * **four-tuple**: code (the entry file) + description (the retrieval key) + preconditions +
 * verification. v3 scripts drive the *input layer* (key/hold/tap/look/menu/click/...), never
 * the high-level body primitives; v1/v2 remain readable so already-promoted skills keep
 * running (config `codeSkills.allowLegacyBody` can disable them).
 *
 *   - `name` is `namespace.skill` (lowercase, no spaces) - the namespace keeps generated
 *     skills from overwriting built-ins;
 *   - `version` is plain semver (`1.2.3`), so promotion/rollback can be exact;
 *   - `entry` is a relative `.js` path with no `..` and no absolute path - the runner must
 *     not be able to point outside the skill directory;
 *   - `description` (v3) is the text whose vector is the retrieval key: 10-500 characters;
 *   - `preconditions` / `verification` (v3) are declarative conditions in the same dialect
 *     `src/planner/verifier.js` already checks (`inventoryAtLeast/positionNear/blockAt/
 *     targetIs`); preconditions may be `{}` but the key must exist, verification must be
 *     non-empty - a skill that cannot falsify itself is not admissible;
 *   - `permissions` is a subset of what the host offers for that apiVersion:
 *       v1: read_state/submit_task/chat/wait/search/generate/subprocess
 *       v2: + body_move/body_dig/body_place/body_use/body_click/body_look/body_attack
 *       v3: read_state/wait/chat + input_key/input_hold/input_tap/input_look/input_menu/
 *           input_click/input_close/input_select/input_use_on/input_target/input_ledger
 *     Direct `fs/net/exec` remain unavailable on every version.
 *
 * This module does not read or run the entry file.
 */

const { checkCondition } = require('../planner/verifier');

const NAME_PATTERN = /^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const API_VERSION = 3;
const API_VERSIONS = new Set([1, 2, 3]);
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
/** v3: keyboard/mouse scripts only. These are the only actions a new skill may perform. */
const INPUT_PERMISSIONS = [
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
];
/** Observation and reporting that do not act on the world. */
const PASSIVE_PERMISSIONS = ['read_state', 'wait', 'chat'];
const V3_PERMISSIONS = new Set([...PASSIVE_PERMISSIONS, ...INPUT_PERMISSIONS]);
const ALLOWED_PERMISSIONS = new Set([...LEGACY_PERMISSIONS, ...BODY_PERMISSIONS, ...INPUT_PERMISSIONS]);
const CONDITIONS = new Set(['inventoryAtLeast', 'positionNear', 'blockAt', 'targetIs']);
const DESCRIPTION_MIN = 10;
const DESCRIPTION_MAX = 500;

function permissionsForApiVersion(apiVersion) {
  if (apiVersion === 1) return new Set(LEGACY_PERMISSIONS);
  if (apiVersion === 2) return new Set([...LEGACY_PERMISSIONS, ...BODY_PERMISSIONS]);
  return new Set(V3_PERMISSIONS);
}

/**
 * Validate a declarative condition map.
 *
 * Shape errors come from the verifier itself (`invalid-condition`/`unsupported-condition`);
 * a well-formed condition that simply does not hold right now is NOT a schema error.
 */
function validateConditions(map, label, errors, options = {}) {
  if (map === undefined || map === null) {
    if (options.required !== false) errors.push(`${label}-required`);
    return;
  }
  if (typeof map !== 'object' || Array.isArray(map)) {
    errors.push(`${label}-must-be-an-object`);
    return;
  }
  const keys = Object.keys(map);
  if (options.nonEmpty === true && keys.length === 0) errors.push(`${label}-must-not-be-empty`);
  for (const key of keys) {
    if (!CONDITIONS.has(key)) errors.push(`${label}-unsupported-condition:${key}`);
  }
  if (!keys.length) return;
  const probe = { inventory: {}, position: { x: 0, y: 0, z: 0 }, blocks: {}, target: {} };
  for (const failure of checkCondition(map, probe)) {
    if (failure && (failure.kind === 'invalid-condition' || failure.kind === 'unsupported-condition')) {
      errors.push(`${label}-invalid:${failure.field || ''}`);
    }
  }
}

function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest-required'] };

  if (typeof manifest.name !== 'string' || !NAME_PATTERN.test(manifest.name)) {
    errors.push('name-must-be-namespace.skill');
  }
  if (typeof manifest.version !== 'string' || !VERSION_PATTERN.test(manifest.version)) {
    errors.push('version-must-be-semver');
  }
  if (!API_VERSIONS.has(manifest.apiVersion)) errors.push('apiVersion-must-be-1-2-or-3');

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
    const allowed = permissionsForApiVersion(manifest.apiVersion);
    for (const permission of manifest.permissions) {
      if (!ALLOWED_PERMISSIONS.has(permission)) {
        errors.push(`permission-not-allowed:${permission}`);
      } else if (!allowed.has(permission)) {
        errors.push(`permission-requires-api:${permission}`);
      }
    }
  }

  if (manifest.apiVersion === 3) {
    if (typeof manifest.description !== 'string' || !manifest.description.trim()) {
      errors.push('description-required');
    } else {
      const length = [...manifest.description.trim()].length;
      if (length < DESCRIPTION_MIN) errors.push(`description-too-short:min-${DESCRIPTION_MIN}`);
      if (length > DESCRIPTION_MAX) errors.push(`description-too-long:max-${DESCRIPTION_MAX}`);
    }
    validateConditions(manifest.preconditions, 'preconditions', errors);
    validateConditions(manifest.verification, 'verification', errors, { nonEmpty: true });
  } else if (manifest.description !== undefined && typeof manifest.description !== 'string') {
    errors.push('description-must-be-a-string');
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
  validateConditions,
  compareVersions,
  ALLOWED_PERMISSIONS,
  BODY_PERMISSIONS,
  INPUT_PERMISSIONS,
  PASSIVE_PERMISSIONS,
  V3_PERMISSIONS,
  permissionsForApiVersion,
  API_VERSION,
  API_VERSIONS,
  CONDITIONS,
  DESCRIPTION_MIN,
  DESCRIPTION_MAX,
  NAME_PATTERN,
  VERSION_PATTERN
};
