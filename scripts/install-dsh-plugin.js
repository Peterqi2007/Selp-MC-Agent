#!/usr/bin/env node
/**
 * Install the dsh-mc-harness plugin into the current DSH desktop profile.
 *
 * The profile keeps the plugin as a **declared link dependency**:
 *
 *   package.json  "dsh-mc-harness": "link:.staged/dsh-mc-harness"
 *   .staged/dsh-mc-harness/          <- the files this script copies
 *   node_modules/dsh-mc-harness      -> .staged/dsh-mc-harness   (junction)
 *
 * Why: a plain copy into node_modules is not in the dependency tree, so every
 * `dsh plugin` operation runs pnpm, which moves it to `node_modules/.ignored/`
 * ("not in the dependency tree and pnpm has no record of installing it") and the
 * plugin silently stops loading. Declaring the link dependency keeps pnpm from
 * pruning it, and the junction keeps Node resolution at the same specifier.
 *
 * It appends one insert entry to cordis.patch.yml.
 * It does NOT restart DSH. A restart is required before the plugin can load.
 *
 * Usage:
 *   node scripts/install-dsh-plugin.js            # print what would change
 *   node scripts/install-dsh-plugin.js --apply    # copy + link + patch
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'dsh-plugin-mc-harness');
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const STAGED = path.join(PROFILE, '.staged', 'dsh-mc-harness');
const LINK = path.join(PROFILE, 'node_modules', 'dsh-mc-harness');
const PACKAGE_JSON = path.join(PROFILE, 'package.json');
const PATCH = path.join(PROFILE, 'cordis.patch.yml');
const LINK_SPEC = 'link:.staged/dsh-mc-harness';
const APPLY = process.argv.includes('--apply');

if (!fs.existsSync(PROFILE)) {
  console.error(`DSH desktop profile not found: ${PROFILE}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(SOURCE, 'lib', 'index.js'))) {
  console.error(`plugin source missing: ${SOURCE}`);
  process.exit(1);
}

const entry = [
  '- insert:',
  '    - id: dsh-mc-harness',
  '      name: dsh-mc-harness',
  '      config:',
  '        port: 8770',
  '        controlUrl: http://127.0.0.1:8766',
  ''
].join('\n');

const current = fs.existsSync(PATCH) ? fs.readFileSync(PATCH, 'utf8') : '';
const already = current.includes('id: dsh-mc-harness');

/** True when `p` is a link/junction, false for a real directory, undefined when absent. */
function linkState(p) {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink() ? 'link' : 'real';
  } catch {
    return 'absent';
  }
}

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
} catch (err) {
  console.error(`cannot read ${PACKAGE_JSON}: ${err.message}`);
  process.exit(1);
}
const declared = (manifest.dependencies || {})['dsh-mc-harness'] || null;

const state = {
  staged: fs.existsSync(STAGED) ? 'present' : 'absent',
  link: linkState(LINK),
  declared: declared === LINK_SPEC ? 'declared' : declared ? `different (${declared})` : 'absent'
};

console.log(`source  : ${SOURCE}`);
console.log(`staged  : ${STAGED} (${state.staged})`);
console.log(`link    : ${LINK} (${state.link})`);
console.log(`dep     : dsh-mc-harness = "${declared || '(missing)'}" (${state.declared})`);
console.log(`patch   : ${PATCH}`);
console.log(`entry   : ${already ? 'already present' : 'will be appended'}`);

if (state.link === 'real') {
  console.error(
    `\nrefusing to continue: ${LINK} is a real directory, not a link.\n` +
    'The previous copy-style install can only be replaced by hand:\n' +
    `  1) move it to ${STAGED}\n` +
    `  2) re-run this script with --apply\n`
  );
  process.exit(1);
}
if (declared && declared !== LINK_SPEC) {
  console.error(`\nrefusing to continue: package.json declares "${declared}", expected "${LINK_SPEC}".`);
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to copy the plugin, link it and patch the profile.');
  console.log('A DSH restart is required afterwards.');
  process.exit(0);
}

// 1. copy the plugin into the staged directory (the pnpm link target)
fs.rmSync(STAGED, { recursive: true, force: true });
fs.mkdirSync(path.dirname(STAGED), { recursive: true });
fs.cpSync(SOURCE, STAGED, { recursive: true });
console.log(`copied  -> ${STAGED}`);

// 2. make sure node_modules/dsh-mc-harness is a junction to it
if (linkState(LINK) === 'absent') {
  fs.symlinkSync(STAGED, LINK, 'junction');
  console.log(`linked  -> ${LINK} => ${STAGED}`);
} else {
  console.log(`link    -> ${LINK} already points at the staged copy`);
}

// 3. declare the dependency so pnpm stops treating the plugin as extraneous
if (!declared) {
  manifest.dependencies = manifest.dependencies || {};
  manifest.dependencies['dsh-mc-harness'] = LINK_SPEC;
  const sorted = {};
  for (const key of Object.keys(manifest.dependencies).sort()) sorted[key] = manifest.dependencies[key];
  manifest.dependencies = sorted;
  fs.writeFileSync(PACKAGE_JSON, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`declared-> ${PACKAGE_JSON} dependencies["dsh-mc-harness"] = "${LINK_SPEC}"`);
  console.log('           run `pnpm install --lockfile-only` in the profile to refresh pnpm-lock.yaml');
}

// 4. profile patch row (idempotent)
if (!already) {
  const backup = `${PATCH}.bak-mc-harness-${Date.now()}`;
  if (fs.existsSync(PATCH)) fs.copyFileSync(PATCH, backup);
  fs.appendFileSync(PATCH, `\n${entry}`);
  console.log(`patched -> ${PATCH}`);
  if (fs.existsSync(backup)) console.log(`backup  -> ${backup}`);
}

console.log('\nRestart DeepSeek Harness. Then check: GET http://127.0.0.1:8770/health');
console.log('Minecraft agent must be running on http://127.0.0.1:8766 for /goal to execute steps.');
