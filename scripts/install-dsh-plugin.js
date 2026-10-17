#!/usr/bin/env node
/**
 * Install the dsh-mc-harness plugin into the current DSH desktop profile.
 *
 * It copies the plugin package and appends one insert entry to cordis.patch.yml.
 * It does NOT restart DSH. A restart is required before the plugin can load.
 *
 * Usage:
 *   node scripts/install-dsh-plugin.js            # print what would change
 *   node scripts/install-dsh-plugin.js --apply    # copy + patch (backup made)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'dsh-plugin-mc-harness');
const PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
const TARGET = path.join(PROFILE, 'node_modules', 'dsh-mc-harness');
const PATCH = path.join(PROFILE, 'cordis.patch.yml');
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

console.log(`source : ${SOURCE}`);
console.log(`target : ${TARGET}`);
console.log(`patch  : ${PATCH}`);
console.log(`entry  : ${already ? 'already present' : 'will be appended'}`);
if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to copy the plugin and patch the profile.');
  console.log('A DSH restart is required afterwards.');
  process.exit(0);
}

fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(path.dirname(TARGET), { recursive: true });
fs.cpSync(SOURCE, TARGET, { recursive: true });
console.log(`copied -> ${TARGET}`);

if (!already) {
  const backup = `${PATCH}.bak-mc-harness-${Date.now()}`;
  if (fs.existsSync(PATCH)) fs.copyFileSync(PATCH, backup);
  fs.appendFileSync(PATCH, `\n${entry}`);
  console.log(`patched -> ${PATCH}`);
  if (fs.existsSync(backup)) console.log(`backup  -> ${backup}`);
}
console.log('\nRestart DeepSeek Harness. Then check: GET http://127.0.0.1:8770/health');
console.log('Minecraft agent must be running on http://127.0.0.1:8766 for /goal to execute steps.');
