'use strict';

/**
 * `npm run client:install` - copy the built control mod into the Forge client's mods dir.
 *
 * The client is version-isolated, so its mods live under
 * `versions/<version>/mods`, NOT `<minecraftDir>/mods`. Getting this wrong is the single
 * most common reason a freshly built mod "does not load".
 *
 *   node scripts/install-client-mod.js [--remove]
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/util/config');
const { detectEnvironment } = require('../src/pcl/detect');

const args = process.argv.slice(2);
const remove = args.includes('--remove');
function valueOf(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const next = args[i + 1];
  return !next || next.startsWith('--') ? null : next;
}

const cfg = loadConfig();
const out = (s = '') => process.stdout.write(`${s}\n`);

const env = detectEnvironment(cfg);
const version = valueOf('--version') || env.clientVersion;
if (!env.minecraftDir) {
  out('cannot locate the Minecraft directory - set pcl.minecraftDir in config/pcl.json');
  process.exitCode = 1;
  return;
}
if (!version) {
  out('cannot determine the client version - set pcl.clientVersion in config/pcl.json');
  process.exitCode = 1;
  return;
}

// Version-isolated mods directory.
const modsDir = path.join(env.minecraftDir, 'versions', version, 'mods');
const built = path.join(cfg.root, 'mod-client', 'dist', 'agent-client-1.0.0.jar');

out('minecraft-survival-agent - install the client control mod');
out(`  minecraft : ${env.minecraftDir}`);
out(`  version   : ${version}`);
out(`  mods dir  : ${modsDir}`);
out(`  jar       : ${built}`);
out('');

if (!fs.existsSync(modsDir)) {
  out(`  mods directory does not exist - is "${version}" really installed?`);
  process.exitCode = 1;
  return;
}

if (remove) {
  let removed = 0;
  for (const file of fs.readdirSync(modsDir)) {
    if (/^agent-client.*\.jar$/.test(file)) {
      fs.unlinkSync(path.join(modsDir, file));
      out(`  removed ${file}`);
      removed += 1;
    }
  }
  out(removed ? `  done (${removed} file(s) removed)` : '  nothing to remove');
  return;
}

if (!fs.existsSync(built)) {
  out(`  the mod is not built yet. Run:  npm run client:build`);
  process.exitCode = 1;
  return;
}

// Replace any previous copy so a stale build can never be loaded.
for (const file of fs.readdirSync(modsDir)) {
  if (/^agent-client.*\.jar$/.test(file)) {
    fs.unlinkSync(path.join(modsDir, file));
    out(`  replaced previous ${file}`);
  }
}

const target = path.join(modsDir, path.basename(built));
fs.copyFileSync(built, target);
const size = fs.statSync(target).size;
const total = fs.readdirSync(modsDir).filter((f) => f.endsWith('.jar')).length;

out(`  installed ${path.basename(target)} (${size} bytes)`);
out(`  ${total} mods now in that profile`);
out('');
out('  next:');
out('    npm run client:launch     # start the client (60-90s to reach a world)');
out('    npm run client:check      # confirm the control API is up');
out('    npm run client:verify     # drive it through the agent body');
