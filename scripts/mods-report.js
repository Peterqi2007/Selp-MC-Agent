'use strict';

/**
 * `npm run mods:report` - what does the agent know about the server it is joining?
 *
 * Runs two layers:
 *   1. OFFLINE (always): the signature classifier and the known-mod namespace table,
 *      exercised against synthetic modded names, plus the persisted knowledge file.
 *   2. LIVE (best effort): if a Minecraft server is reachable it connects, scans the
 *      real registry and prints the detected loader / mod namespaces.
 *
 * Usage:
 *   node scripts/mods-report.js                 # offline only
 *   node scripts/mods-report.js --live          # also connect and scan
 *   node scripts/mods-report.js --live --host play.example.com --port 25565
 */

const path = require('path');
const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { ModKnowledge } = require('../src/mods/knowledge');
const { detectEnvironment } = require('../src/pcl/detect');

const cfg = loadConfig();
const log = new Logger('mods-report');
const args = process.argv.slice(2);
const live = args.includes('--live');

/** Read `--flag value`, ignoring the case where the flag is last or followed by another flag. */
function valueOf(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return null;
  return next;
}

const hostArg = valueOf('--host');
const portArg = valueOf('--port');
if (hostArg) cfg.agent.bot.host = hostArg;
if (portArg) cfg.agent.bot.port = Number(portArg);
if (args.includes('--profile')) {
  const profile = valueOf('--profile');
  if (profile) {
    const { loadConfig } = require('../src/util/config');
    Object.assign(cfg, loadConfig({ profile }));
  }
}

/** Names we would meet on real modded servers, used to prove the classifier. */
const SAMPLES = [
  'create:brass_ingot',
  'create:andesite_alloy',
  'create:crushing_wheel',
  'create:fluid_tank',
  'create:cogwheel',
  'ae2:certus_quartz_crystal',
  'ae2:charged_certus_quartz_crystal',
  'ae2:fluix_crystal',
  'farmersdelight:cooking_pot',
  'farmersdelight:tomato_seeds',
  'farmersdelight:roast_chicken',
  'tacz:modern_kinetic_gun',
  'iceandfire:dragon_skull',
  'thermal:tin_ingot',
  'thermal:tin_ore',
  'mekanism:osmium_ore',
  'mekanism:enriched_iron',
  'immersiveengineering:hemp_fiber',
  'twilightforest:steeleaf_pickaxe',
  'sophisticatedbackpacks:backpack',
  'supplementaries:globe',
  'someunknownmod:mysterious_artifact',
  'minecraft:oak_log',
  'minecraft:diamond_ore'
];

function section(title) {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

function offlineReport() {
  const mods = new ModKnowledge(cfg, { log, knowledgeFile: path.join(cfg.root, 'config', 'mod-knowledge.json') });

  section('1. Signature classification (offline, synthetic modded names)');
  for (const name of SAMPLES) {
    const cls = mods.classify(name);
    const ns = mods.namespaceOf(name);
    const mod = ns ? mods.modName(ns) : '(vanilla)';
    process.stdout.write(
      `  ${name.padEnd(42)} ${String(cls.category).padEnd(11)} ${String(cls.kind || cls.tool || '').padEnd(9)} ` +
        `${cls.confidence.padEnd(9)} ${mod}\n`
    );
  }

  section('2. Safety gates');
  const checks = [
    ['minecraft:oak_log', true, 'vanilla wood is always mineable'],
    ['minecraft:bedrock', false, 'bedrock is never mineable'],
    ['create:copper_ore', true, 'signature *_ore -> mineable'],
    ['ae2:fluix_crystal', false, 'unknown signature -> not mined (avoids dig loops)'],
    ['someunknownmod:mysterious_artifact', false, 'unknown signature -> not mined'],
    ['farmersdelight:roast_chicken', true, 'food signature recognised (isProbablyFood)']
  ];
  let failures = 0;
  for (const [name, expected, why] of checks) {
    const actual = name.includes('roast_chicken') ? mods.isProbablyFood(name) : mods.isMineable(name);
    const ok = actual === expected;
    if (!ok) failures += 1;
    process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(40)} -> ${String(actual).padEnd(5)} (${why})\n`);
  }

  section('3. Persisted knowledge');
  process.stdout.write(`  file            ${mods.file}\n`);
  process.stdout.write(`  learned items   ${Object.keys(mods.learned.items || {}).length}\n`);
  process.stdout.write(`  learned blocks  ${Object.keys(mods.learned.blocks || {}).length}\n`);
  for (const [server, info] of Object.entries(mods.learned.servers || {})) {
    process.stdout.write(`  seen server     ${server} -> ${info.loader} (${(info.mods || []).length} mods, last ${info.lastSeen})\n`);
  }

  section('4. Target');
  const { describeTarget } = require('../src/core/network');
  const t = describeTarget(cfg);
  process.stdout.write(`  address  ${t.address}  (${t.scope})\n`);
  process.stdout.write(`  auth     ${t.auth}  username=${t.username || '(msa profile)'}\n`);
  process.stdout.write(`  proxy    ${t.proxy || '(none)'}\n`);
  for (const note of t.notes) process.stdout.write(`  note     ${note}\n`);

  return failures;
}

async function liveReport() {
  section('5. Live server scan');
  const { BotController } = require('../src/core/bot');
  const controller = new BotController(cfg, new Logger('bot', { level: 'warn' }));
  const mods = new ModKnowledge(cfg, { log });
  controller.mods = mods;

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout (30s)' }), 30000);
    controller.on('spawn', () => {
      setTimeout(() => {
        clearTimeout(timer);
        const detected = mods.scan(controller.bot);
        resolve({ ok: true, detected });
      }, 4000);
    });
    controller.on('socketError', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message });
    });
    controller.on('kicked', (reason) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: `kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}` });
    });
    try {
      controller.connect();
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message });
    }
  });

  controller.shutdown();

  if (!result.ok) {
    process.stdout.write(`  could not connect to ${cfg.agent.bot.host}:${cfg.agent.bot.port} - ${result.reason}\n`);
    process.stdout.write('  (offline report above is still valid; start a server or pass --host/--port)\n');
    return 0;
  }

  const d = result.detected;
  process.stdout.write(`  loader            ${d.loader}\n`);
  process.stdout.write(`  mod namespaces    ${d.modNamespaces.length ? d.modNamespaces.join(', ') : '(none)'}\n`);
  const known = d.mods.filter((m) => m.name);
  if (known.length) {
    process.stdout.write('  recognised mods:\n');
    for (const m of known) process.stdout.write(`    - ${m.name} (${m.namespace})${m.note ? ` - ${m.note}` : ''}\n`);
  }
  process.stdout.write(`  vanilla items     ${mods.report.vanillaItems}\n`);
  process.stdout.write(`  vanilla blocks    ${mods.report.vanillaBlocks}\n`);
  process.stdout.write(`  unnamed entries   ${mods.report.unknownContent.itemCount}\n`);
  process.stdout.write('  guidance:\n');
  for (const line of mods.guidance()) process.stdout.write(`    - ${line}\n`);
  return 0;
}

(async () => {
  process.stdout.write('minecraft-survival-agent - mod knowledge report\n');
  const failures = offlineReport();
  if (live) await liveReport();

  const env = detectEnvironment(cfg);
  section('Environment');
  process.stdout.write(`  PCL2            ${env.pclExe || '(not found)'}\n`);
  process.stdout.write(`  client version  ${env.clientVersion || '-'}   (modpack the human plays)\n`);
  process.stdout.write(`  server java     ${env.serverJava || '-'}\n`);

  if (failures) {
    process.stdout.write(`\n${failures} classifier check(s) FAILED\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('\nclassifier checks passed\n');
  }
})().catch((err) => {
  process.stdout.write(`mods report crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
