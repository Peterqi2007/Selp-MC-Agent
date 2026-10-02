'use strict';

/**
 * `npm run body:info` - which bodies are available, and what each one can do.
 *
 * Prints a capability matrix so the trade-off is visible without reading the source.
 */

const { loadConfig } = require('../src/util/config');
const { describeBodies, createBody } = require('../src/body/factory');

const cfg = loadConfig();
const report = describeBodies(cfg);

const out = (s = '') => process.stdout.write(`${s}\n`);
out('minecraft-survival-agent - body (躯体) report');
out('');
out(`selected body : ${report.selected}    (config/agent.json -> body.kind, --body, MC_BODY)`);
out('');

const CAPABILITIES = [
  ['headless (no GPU)', { mineflayer: 'yes', mock: 'yes', clientmod: 'no' }],
  ['startup time', { mineflayer: '~1s', mock: 'instant', clientmod: '30-60s' }],
  ['instances per machine', { mineflayer: 'many', mock: 'many', clientmod: '1-2' }],
  ['vanilla / Paper / Spigot', { mineflayer: 'yes', mock: 'n/a', clientmod: 'yes' }],
  ['Fabric (server-side mods)', { mineflayer: 'yes', mock: 'n/a', clientmod: 'yes' }],
  ['Forge / NeoForge servers', { mineflayer: 'NO', mock: 'n/a', clientmod: 'yes' }],
  ['mod block properties', { mineflayer: 'guess', mock: 'n/a', clientmod: 'exact' }],
  ['mod recipes', { mineflayer: 'partial', mock: 'n/a', clientmod: 'exact' }],
  ['AuthMe /login', { mineflayer: 'yes', mock: 'yes', clientmod: 'yes' }],
  ['uses your game account', { mineflayer: 'no', mock: 'no', clientmod: 'YES' }]
];

out('capability matrix');
out('-'.repeat(72));
out(`  ${'capability'.padEnd(26)} ${'mineflayer'.padEnd(12)} ${'mock'.padEnd(10)} clientmod`);
for (const [capability, values] of CAPABILITIES) {
  out(`  ${capability.padEnd(26)} ${values.mineflayer.padEnd(12)} ${values.mock.padEnd(10)} ${values.clientmod}`);
}
out('');

out('available');
out('-'.repeat(72));
for (const entry of report.available) {
  out(`  ${entry.available ? '[x]' : '[ ]'} ${entry.kind.padEnd(11)} ${entry.note}`);
}
out('');

// Prove the factory can actually build the selected body (catches config typos).
try {
  const selection = createBody(cfg, {
    controller: { bot: null, isAlive: false, loadedPlugins: [] },
    log: { info() {}, warn() {}, error() {}, debug() {} }
  });
  out('factory check');
  out('-'.repeat(72));
  out(`  kind    ${selection.kind}`);
  out(`  usable  ${selection.usable}`);
  if (selection.reason) out(`  note    ${selection.reason}`);
} catch (err) {
  out(`factory check FAILED: ${err.message}`);
  process.exitCode = 1;
}

if (report.selected === 'clientmod' && !report.available.find((b) => b.kind === 'clientmod').available) {
  out('');
  out('NOTE: body.kind is "clientmod" but that body is not implemented yet.');
  out('      The Forge control mod is step 2 - see docs/CLIENT-MOD-RECON.md.');
  process.exitCode = 1;
}
