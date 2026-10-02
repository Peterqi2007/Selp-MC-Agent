'use strict';

/**
 * Diagnostics: connect, then report what the bot can actually perceive around it.
 * Useful when the agent "does nothing" - usually the spawn is in a biome without
 * trees, or the chunk data has not arrived yet.
 *
 *   node scripts/inspect-world.js [seconds]
 */

const path = require('path');
const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { BotController } = require('../src/core/bot');
const { WorldView } = require('../src/world/worldView');
const { isLog } = require('../src/world/items');

const cfg = loadConfig();
const log = new Logger('inspect');
const controller = new BotController(cfg, new Logger('bot', { level: 'warn' }));
const view = new WorldView(controller);
const seconds = Number(process.argv[2]) || 20;

controller.on('spawn', async () => {
  log.info('spawned, sampling surroundings...');
  await new Promise((r) => setTimeout(r, 4000));

  const bot = controller.bot;
  const pos = bot.entity.position.floored();
  log.info(`position ${pos} dimension ${view.dimension()}`);
  log.info(`onGround=${bot.entity.onGround} yaw=${bot.entity.yaw.toFixed(2)} velocity=${JSON.stringify(bot.entity.velocity)}`);

  // --- pathfinder introspection: why does navigation fail? ---
  if (bot.pathfinder) {
    const { Movements, goals } = require('mineflayer-pathfinder');
    const mv = new Movements(bot);
    mv.canDig = true;
    bot.pathfinder.setMovements(mv);
    const target = bot.blockAt(pos.offset(-2, 0, 0));
    log.info(`target block for goto test: ${target ? target.name : 'null'} @ ${target ? target.position : '-'}`);
    bot.pathfinder.thinkTimeout = 5000;
    try {
      const p = bot.pathfinder.getPathTo(mv, new goals.GoalNear(pos.x - 2, pos.y, pos.z, 1), 5000);
      log.info(`pathfinder status=${p.status} visitedNodes=${p.visitedNodes} cost=${p.cost} pathLen=${p.path ? p.path.length : 0}`);
      if (p.path && p.path.length) {
        log.info(`first 5 movements: ${p.path.slice(0, 5).map((m) => `${m.moveType || m.type || '?'}->${JSON.stringify(m.to || m.position)}`).join(' | ')}`);
      }
    } catch (err) {
      log.warn(`getPathTo threw: ${err.message}`);
    }
    bot.pathfinder.thinkTimeout = 5000;
  }

  try {
    const biome = bot.world.getBiome(pos) ?? bot.world.getBiome ? bot.world.getBiome(pos) : null;
    log.info(`biome id: ${biome} (${bot.registry.biomes[biome] ? bot.registry.biomes[biome].name : 'unknown'})`);
  } catch (err) {
    log.warn(`biome lookup failed: ${err.message}`);
  }

  // Column profile under the bot.
  for (let dy = 3; dy >= -6; dy -= 1) {
    const b = bot.blockAt(pos.offset(0, dy, 0));
    log.info(`  y${dy >= 0 ? '+' : ''}${dy}: ${b ? b.name : '(unloaded)'}`);
  }

  // Block census in a cube around the bot.
  const counts = new Map();
  let logs = 0;
  for (let dx = -32; dx <= 32; dx += 1) {
    for (let dz = -32; dz <= 32; dz += 1) {
      for (let dy = -8; dy <= 12; dy += 1) {
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (!b || b.name === 'air' || b.name === 'cave_air') continue;
        counts.set(b.name, (counts.get(b.name) || 0) + 1);
        if (isLog(b.name)) logs += 1;
      }
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  log.info(`block census (65x65x21 cube): ${top.map(([n, c]) => `${n}:${c}`).join(', ')}`);
  log.info(`logs found in census: ${logs}`);

  // Entities.
  const entityNames = new Map();
  for (const e of Object.values(bot.entities)) {
    if (!e || !e.name || e === bot.entity) continue;
    entityNames.set(e.name, (entityNames.get(e.name) || 0) + 1);
  }
  log.info(`entities (${entityNames.size} kinds): ${[...entityNames.entries()].map(([n, c]) => `${n}:${c}`).join(', ') || 'none'}`);

  // What mineflayer's own finders return.
  const nearestLog = bot.findBlock({ matching: (b) => isLog(b.name), maxDistance: 48 });
  log.info(`findBlock(log, 48) -> ${nearestLog ? `${nearestLog.name} @ ${nearestLog.position}` : 'null'}`);
  const nearestAny = bot.findBlock({ matching: () => true, maxDistance: 16 });
  log.info(`findBlock(any, 16) -> ${nearestAny ? `${nearestAny.name} @ ${nearestAny.position}` : 'null'}`);

  controller.shutdown();
  process.exit(0);
});

controller.connect();
setTimeout(() => {
  log.warn('timeout, exiting');
  controller.shutdown();
  process.exit(2);
}, seconds * 1000);
