#!/usr/bin/env node
'use strict';

/**
 * Phase 2/3 functional acceptance: the REAL client, on the PERSONAL server only.
 *
 * The operator's rule for these features is explicit: test on the client together with the
 * personal server, never on the public modded server. This script makes that one command:
 *
 *   1. refuses outright when the attached client looks like it is on the public modded
 *      server (any non-vanilla block namespace in the scan),
 *   2. starts the bundled vanilla 1.20.1 server (unless --skip-server),
 *   3. checks - through the server's own console - that the bot is a player on *this*
 *      server, and hands out the test materials with /give,
 *   4. builds a small test pad next to the bot (crafting table, furnace, dirt patch, bed),
 *   5. drives the Phase 2/3 skills against the live client and asserts what really ended up
 *      in the inventory / in the world.
 *
 * Usage (client must already be connected to 127.0.0.1:25565):
 *   node scripts/personal-test.js                 # start server, run, stop server
 *   node scripts/personal-test.js --skip-server   # use a server that is already running
 *   node scripts/personal-test.js --keep-server   # leave the server up afterwards
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('../src/util/config');
const { detectEnvironment } = require('../src/pcl/detect');
const { startServer } = require('../src/server/serverManager');
const { ClientModBody } = require('../src/body/clientModBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const skills = require('../src/skills');
const { bare } = require('../src/world/items');
const { sleep } = require('../src/core/movement');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(valueOf('--port', 25565));
const KEEP_SERVER = flag('--keep-server');
const SKIP_SERVER = flag('--skip-server');
const START_CLIENT = flag('--start-client');
/**
 * Manual mode: the operator prepares the items (and the world) by hand.
 *
 * Used for the single-player workflow: no server console, no /give, no test pad - the run
 * just drives the skills against whatever the human set up.
 */
const NO_PREPARE = flag('--no-prepare');
/**
 * Single-player worlds legitimately contain mod blocks (the client runs the full modpack),
 * so the "is this the public server?" namespace check can be explicitly waived. The public
 * server is never a single-player world; the flag exists so the operator can state that.
 */
const ALLOW_MODDED = flag('--allow-modded');
const log = { debug() {}, info() {}, warn() {}, error() {} };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`);
}

/** Namespaces in the client's block scan: vanilla means a personal/lab world. */
function scanNamespaces(body) {
  const snap = body.snapshot();
  const cells = snap && snap.blocks && snap.blocks.cells ? snap.blocks.cells : null;
  if (!cells) return null;
  const set = new Set();
  for (const name of Object.values(cells)) {
    const idx = String(name).indexOf(':');
    if (idx > 0) set.add(String(name).slice(0, idx));
  }
  return set;
}

async function main() {
  const cfg = loadConfig();
  process.stdout.write('Phase 2/3 functional test - client + PERSONAL server only\n\n');

  // ---- 0. the client (optionally launched by us) ---------------------------
  const body = new ClientModBody(cfg, { log });
  let server = null;
  const ensureServer = async () => {
    if (server) return server;
    const env = detectEnvironment(cfg);
    server = startServer(cfg, { java: env.serverJava, log });
    await server.ready;
    return server;
  };

  let attached = await body.connect({ waitMs: START_CLIENT ? 2500 : 8000 });
  if (!attached && START_CLIENT) {
    process.stdout.write('  ..    no client yet - starting the personal server and the Forge client\n');
    await ensureServer();
    const child = spawn(
      process.execPath,
      [
        path.join(cfg.root, 'scripts', 'launch-forge-client.js'),
        '--offline',
        '--username',
        cfg.agent.bot.username,
        '--server',
        `127.0.0.1:${PORT}`
      ],
      { cwd: cfg.root, detached: true, stdio: 'ignore' }
    );
    child.unref();
    for (let i = 0; i < 72 && !attached; i += 1) {
      await sleep(2500);
      attached = await body.connect({ waitMs: 2000 });
    }
  }
  if (!attached) {
    process.stdout.write('  FAIL  the control mod is not answering on 127.0.0.1:8899\n');
    process.stdout.write('        start the client first:\n');
    process.stdout.write(`          npm run client:launch -- --server 127.0.0.1:${PORT}\n`);
    process.stdout.write(`        or run everything at once:  npm run personal:test -- --start-client\n`);
    process.exitCode = 1;
    if (server && !KEEP_SERVER) await server.stop();
    return;
  }
  await body.refresh(true);
  const namespaces = scanNamespaces(body);
  const modded = namespaces ? [...namespaces].filter((ns) => ns !== 'minecraft') : [];
  if (modded.length && !ALLOW_MODDED) {
    process.stdout.write(`  STOP  this client is on a MODDED server (namespaces: ${modded.slice(0, 6).join(', ')}...)\n`);
    process.stdout.write('        that is the public server - functional tests are not allowed there.\n');
    process.stdout.write(`        point the client at the personal server (127.0.0.1:${PORT}) and run again.\n`);
    process.exitCode = 2;
    return;
  }
  const snap = body.snapshot();
  const pos = { x: Math.floor(snap.position.x), y: Math.floor(snap.position.y), z: Math.floor(snap.position.z) };
  record('client attached to a vanilla (personal) world', true, `pos ${pos.x},${pos.y},${pos.z}`);

  // ---- 1. the server -------------------------------------------------------
  if (!SKIP_SERVER) {
    await ensureServer();
    record('personal server is up', true, `127.0.0.1:${PORT} (log: ${server.logFile})`);
  } else {
    record('personal server assumed running (--skip-server)', true, `127.0.0.1:${PORT}`);
  }

  const consoleCommand = (cmd) => {
    if (server) server.command(cmd);
  };
  const waitForServerLine = async (fn, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (server && fs.existsSync(server.logFile)) {
        const text = fs.readFileSync(server.logFile, 'utf8');
        const hit = fn(text);
        if (hit) return hit;
      }
      await sleep(500);
    }
    return null;
  };

  // ---- 2. is the bot really on THIS server? --------------------------------
  if (server) {
    const username = cfg.agent.bot.username;
    consoleCommand('list');
    const listLine = await waitForServerLine((text) => {
      const lines = text.split(/\r?\n/).filter((l) => l.includes('players online'));
      return lines.length ? lines[lines.length - 1] : null;
    });
    const online = listLine && listLine.includes(username);
    record('the bot is a player on the personal server', !!online, listLine ? listLine.trim().slice(0, 80) : 'no "players online" line');
    if (!online) {
      process.stdout.write(`\n  Start the client against the personal server first:\n`);
      process.stdout.write(`    npm run client:launch -- --server 127.0.0.1:${PORT}\n`);
      process.exitCode = 1;
      if (server && !KEEP_SERVER) await server.stop();
      return;
    }
  }

  const ctx = { cfg, body, world: new BodyWorldView(body, cfg, { log }), log };
  const inventory = () => (body.snapshot() && body.snapshot().inventory) || {};
  const has = (name) => (inventory()[`minecraft:${bare(name)}`] || 0) > 0;

  // ---- 3. test materials + pad --------------------------------------------
  const username = cfg.agent.bot.username;
  const gives = [
    'minecraft:oak_log 8',
    'minecraft:cobblestone 24',
    'minecraft:coal 16',
    'minecraft:raw_iron 3',
    'minecraft:iron_hoe 1',
    'minecraft:wheat_seeds 8',
    'minecraft:red_bed 1',
    'minecraft:furnace 1',
    'minecraft:crafting_table 1'
  ];
  if (NO_PREPARE) {
    record('material preparation skipped (operator prepares by hand)', true, 'no /give, no test pad');
  } else {
    for (const give of gives) consoleCommand(`give ${username} ${give}`);
    consoleCommand('gamerule doDaylightCycle false');
    // No mobs: the sleep check must not fail because a zombie wandered next to the bed.
    consoleCommand('gamerule doMobSpawning false');
    consoleCommand('time set day');
  }
  // A small, flat pad: ground blocks replaced under the feet level, air above.
  const pad = [
    `setblock ${pos.x + 2} ${pos.y - 1} ${pos.z} minecraft:crafting_table`,
    `setblock ${pos.x - 2} ${pos.y - 1} ${pos.z} minecraft:furnace`,
    `setblock ${pos.x + 1} ${pos.y - 1} ${pos.z} minecraft:dirt`,
    `setblock ${pos.x + 1} ${pos.y - 1} ${pos.z + 1} minecraft:dirt`,
    // Air above the pad and the future bed, so nothing is obstructed.
    `setblock ${pos.x + 1} ${pos.y} ${pos.z} minecraft:air`,
    `setblock ${pos.x + 2} ${pos.y} ${pos.z} minecraft:air`,
    `setblock ${pos.x + 1} ${pos.y} ${pos.z + 1} minecraft:air`,
    `setblock ${pos.x + 2} ${pos.y} ${pos.z + 2} minecraft:air`,
    `setblock ${pos.x + 3} ${pos.y} ${pos.z + 2} minecraft:air`
  ];
  if (!NO_PREPARE) {
    for (const cmd of pad) consoleCommand(cmd);
    await sleep(2500);
    await body.refresh(true);
    record('test materials handed out', has('oak_log') || has('crafting_table'), JSON.stringify(Object.keys(inventory()).slice(0, 8)));
  }

  // ---- 4. craft ------------------------------------------------------------
  const tableCraft = await skills.run('craft', ctx, { item: 'crafting_table', count: 1 });
  await body.refresh(true);
  record('craft: crafting table from planks (2x2 grid)', tableCraft.ok === true && has('crafting_table'), JSON.stringify(tableCraft).slice(0, 160));

  const pickCraft = await skills.run('craft', ctx, { item: 'wooden_pickaxe', count: 1 });
  await body.refresh(true);
  record('craft: wooden pickaxe via the placed table (sub-crafts)', pickCraft.ok === true && has('wooden_pickaxe'), JSON.stringify(pickCraft).slice(0, 200));

  // ---- 5. smelt ------------------------------------------------------------
  const smelt = await skills.run('smelt', ctx, { item: 'raw_iron', count: 1, timeoutMs: 90000 });
  await body.refresh(true);
  record('smelt: raw iron becomes an iron ingot', smelt.ok === true && has('iron_ingot'), JSON.stringify(smelt).slice(0, 200));

  // ---- 6. farm -------------------------------------------------------------
  const farm = await skills.run('farm', ctx, { radius: 6 });
  record(
    'farm: tills soil and plants seeds',
    farm.ok === true && (farm.tilled > 0 || farm.planted > 0),
    JSON.stringify(farm).slice(0, 200)
  );

  // ---- 7. sleep ------------------------------------------------------------
  /**
   * Day/night comes from the clock, not the client's `isDay` flag: on this modpack the
   * flag still said "day" at timeOfDay 20310 (about 02:00), which would skip a perfectly
   * good night-time sleep check.
   */
  const clock = snap.time && Number.isFinite(snap.time.timeOfDay) ? snap.time.timeOfDay % 24000 : null;
  const isDayNow = clock === null ? !!(snap.time && snap.time.isDay) : !(clock >= 12542 && clock <= 23458);
  if (NO_PREPARE && !server && isDayNow) {
    record('sleep: skipped (daytime, no console to set night)', true, 'run this check after nightfall if wanted');
  } else {
    consoleCommand('time set night');
    consoleCommand(`setblock ${pos.x + 2} ${pos.y - 1} ${pos.z + 2} minecraft:red_bed[part=foot,facing=east]`);
    consoleCommand(`setblock ${pos.x + 3} ${pos.y - 1} ${pos.z + 2} minecraft:red_bed[part=head,facing=east]`);
    await sleep(2500);
    await body.refresh(true);
    const sleepResult = await skills.run('sleep', ctx, { timeoutMs: 60000 });
    record('sleep: sleeps through the night', sleepResult.ok === true && sleepResult.slept === true, JSON.stringify(sleepResult).slice(0, 200));
  }

  // ---- 8. Phase 3: the Chinese channel and the model-facing surfaces -------
  const { route } = require('../src/llm/fallbackRouter');
  const routing = [
    ['饿了', 'eat'],
    ['睡觉', 'sleep'],
    ['种地', 'farm'],
    ['合成一个石镐', 'craft'],
    ['熔炼铁矿', 'smelt'],
    ['有怪物', 'defend'],
    ['把东西存起来', 'deposit'],
    ['探索一下', 'explore']
  ];
  const wrongRoute = [];
  for (const [text, skill] of routing) {
    const routed = route(text, { speakerPosition: pos });
    const action = routed.ok ? routed.intent.action : null;
    if (!action || action.type !== 'skill' || action.skill !== skill) {
      wrongRoute.push(`${text}->${action ? action.skill || action.type : 'none'}`);
    }
  }
  record('Phase 3: Chinese utterances route to the right skills', wrongRoute.length === 0, wrongRoute.join('; ') || `${routing.length}/${routing.length}`);

  const { capabilities } = require('../src/llm/blackboard');
  const caps = Object.fromEntries(capabilities(ctx).map((c) => [c.name, c]));
  const requiredSkills = ['craft', 'smelt', 'farm', 'sleep', 'eat', 'deposit', 'withdraw', 'attack', 'defend'];
  const missingCaps = requiredSkills.filter((name) => !(caps[name] && caps[name].available));
  record(
    'Phase 3: capability table lists the Phase 2/3 skills as available',
    missingCaps.length === 0,
    missingCaps.length ? `missing: ${missingCaps.join(', ')}` : requiredSkills.join(', ')
  );

  const toolRegistry = require('../src/llm/tools/registry');
  const doSkillTool = toolRegistry.toOpenAiTools(ctx).find((t) => t.function && t.function.name === 'do_skill');
  const enumNames = doSkillTool && doSkillTool.function.parameters.properties.name.enum;
  record(
    'Phase 3: do_skill carries the live skill enum (registry-generated)',
    Array.isArray(enumNames) && enumNames.includes('craft') && enumNames.includes('sleep'),
    Array.isArray(enumNames) ? `${enumNames.length} skills` : 'no enum'
  );

  // ---- summary -------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(60)}\n`);
  process.stdout.write(`personal functional test: ${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail}\n`);
    process.exitCode = 1;
  }

  await body.disconnect().catch(() => {});
  if (server && !KEEP_SERVER) {
    process.stdout.write('stopping the personal server...\n');
    await server.stop();
  }
}

main().catch(async (err) => {
  process.stderr.write(`personal test crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
