'use strict';

/**
 * Live verification of mod awareness against a REAL Forge server.
 *
 * Starts the bundled Forge 1.20.1 dedicated server on an isolated port/level, then
 * connects the agent so ModKnowledge can scan a genuine modded registry and the
 * loader detection can be observed. Cleans up after itself.
 *
 *   node scripts/verify-modded.js [--port 25570] [--keep]
 */

const path = require('path');
const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { prepareForgeServer, startForgeServer } = require('../src/server/forgeServer');
const { BotController } = require('../src/core/bot');
const { ModKnowledge } = require('../src/mods/knowledge');
const { WorldView } = require('../src/world/worldView');
const { describeTarget } = require('../src/core/network');

const args = process.argv.slice(2);
function valueOf(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const next = args[i + 1];
  return !next || next.startsWith('--') ? null : next;
}

const port = Number(valueOf('--port')) || 25570;
const cfg = loadConfig();
cfg.server.port = port;
cfg.server.levelName = 'verify-forge-world';
cfg.agent.bot.host = '127.0.0.1';
cfg.agent.bot.port = port;
cfg.agent.bot.auth = 'offline';
cfg.agent.bot.username = 'ModProbe';

const log = new Logger('verify-modded');
const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`);
}

(async () => {
  process.stdout.write('minecraft-survival-agent - live mod awareness verification\n\n');

  const java = require('../src/pcl/detect').detectEnvironment(cfg).serverJava;
  if (!java) throw new Error('no java runtime found');

  process.stdout.write(`1. starting Forge server on port ${port}\n`);
  const prepared = await prepareForgeServer(cfg, { java }, log);
  const server = startForgeServer(cfg, { java, log, forgeVersion: prepared.forgeVersion });
  await Promise.race([
    server.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('forge server did not become ready in 300s')), 300000))
  ]);
  process.stdout.write(`   forge server ready (log: ${server.logFile})\n\n`);

  process.stdout.write('2. connecting the agent and scanning the live registry\n');
  const controller = new BotController(cfg, new Logger('bot', { level: 'warn' }));
  const mods = new ModKnowledge(cfg, { log });
  controller.mods = mods;
  const world = new WorldView(controller, { mods });

  const spawned = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 60000);
    controller.on('spawn', () => {
      clearTimeout(timer);
      setTimeout(() => resolve(true), 5000);
    });
    controller.on('kicked', (reason) => {
      clearTimeout(timer);
      log.error(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
      resolve(false);
    });
    controller.connect();
  });

  check('agent joined the Forge server', spawned, spawned ? `at ${JSON.stringify(controller.snapshot().position)}` : 'not spawned');

  if (spawned) {
    const detected = mods.scan(controller.bot);
    const report = mods.report;

    process.stdout.write('\n   --- mod knowledge report ---\n');
    process.stdout.write(`   loader          ${detected.loader}\n`);
    process.stdout.write(`   server brand    ${controller.bot.game ? controller.bot.game.version : '?'}\n`);
    process.stdout.write(`   mod namespaces  ${detected.modNamespaces.length ? detected.modNamespaces.join(', ') : '(none)'}\n`);
    process.stdout.write(`   vanilla items   ${report.vanillaItems}\n`);
    process.stdout.write(`   vanilla blocks  ${report.vanillaBlocks}\n`);
    process.stdout.write(`   unnamed entries ${report.unknownContent.itemCount}\n`);
    for (const line of mods.guidance()) process.stdout.write(`   guidance: ${line}\n`);
    process.stdout.write('   ----------------------------\n\n');

    check('detected a modded loader (forge)', /forge/i.test(detected.loader), detected.loader);
    check('registry knowledge loaded', report.vanillaItems > 1000, `${report.vanillaItems} items / ${report.vanillaBlocks} blocks`);
    check('guidance produced for a modded server', mods.guidance().length > 0, `${mods.guidance().length} line(s)`);

    // Behaviour checks that only make sense once we are actually in a world.
    const target = describeTarget(cfg);
    check('target described as local', target.scope.startsWith('local'), target.address);

    const pos = controller.bot.entity.position;
    const groundName = controller.bot.blockAt(pos.offset(0, -1, 0));
    check('world is readable', !!groundName, groundName ? `standing on ${groundName.name}` : 'no block below');
  }

  controller.shutdown();

  if (!args.includes('--keep')) {
    process.stdout.write('\n3. stopping the Forge server\n');
    await server.stop();
    process.stdout.write('   stopped\n');
    // Remove the throwaway level so repeat runs start clean.
    const levelDir = path.join(cfg.paths.server, cfg.server.levelName);
    try {
      require('fs').rmSync(levelDir, { recursive: true, force: true });
      process.stdout.write(`   removed ${cfg.server.levelName}\n`);
    } catch {
      /* best effort */
    }
  } else {
    process.stdout.write(`\n3. --keep set - Forge server left running on ${port}\n`);
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(58)}\n`);
  process.stdout.write(`live mod verification: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail}\n`);
    process.exitCode = 1;
  }
  process.exit(0);
})().catch(async (err) => {
  process.stdout.write(`verify-modded crashed: ${err.stack}\n`);
  process.exitCode = 1;
  process.exit(1);
});
