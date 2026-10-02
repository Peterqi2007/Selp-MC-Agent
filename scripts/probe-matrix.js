'use strict';

/**
 * Movement robustness matrix.
 *
 * Reproduces the "bot spawned on a treetop" situation and tries the different
 * Movements configurations to find one that yields a usable path.
 */

const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { BotController } = require('../src/core/bot');
const { sleep } = require('../src/core/movement');

const cfg = loadConfig();
const log = new Logger('matrix');
const controller = new BotController(cfg, new Logger('bot', { level: 'warn' }));

controller.on('spawn', async () => {
  const bot = controller.bot;
  const { goals, Movements } = require('mineflayer-pathfinder');
  try {
    await sleep(5000);
    const pos = bot.entity.position.floored();
    log.info(`spawned at ${pos}`);
    for (let dy = 0; dy >= -12; dy -= 1) {
      const b = bot.blockAt(pos.offset(0, dy, 0));
      log.info(`  y${dy}: ${b ? b.name : '(unloaded)'}`);
    }

    const variants = [
      { label: 'default (canDig=false)', canDig: false, radius: 64, think: 5000 },
      { label: 'canDig=true', canDig: true, radius: 64, think: 5000 },
      { label: 'canDig=true small searchRadius', canDig: true, radius: 16, think: 5000 },
      { label: 'canDig=false small searchRadius', canDig: false, radius: 16, think: 5000 },
      { label: 'canDig=false + allow1by1towers', canDig: false, radius: 32, think: 5000, towers: true }
    ];

    for (const v of variants) {
      const mv = new Movements(bot);
      mv.canDig = v.canDig;
      if (v.towers) mv.allow1by1towers = true;
      bot.pathfinder.setMovements(mv);
      bot.pathfinder.searchRadius = v.radius;
      bot.pathfinder.thinkTimeout = v.think;
      bot.pathfinder.tickTimeout = 50;

      const target = new goals.GoalNear(pos.x + 3, pos.y, pos.z, 1);
      let result = 'unknown';
      let nodes = 0;
      const onUpdate = (r) => {
        result = r.status;
        nodes = r.visitedNodes;
      };
      bot.on('path_update', onUpdate);
      const t0 = Date.now();
      try {
        await bot.pathfinder.goto(target);
        log.info(`${v.label}: reached in ${Date.now() - t0}ms (status=${result}, nodes=${nodes}) pos=${bot.entity.position.floored()}`);
      } catch (err) {
        log.info(`${v.label}: FAILED in ${Date.now() - t0}ms (status=${result}, nodes=${nodes}) - ${err.message.split('!')[0]}`);
      }
      bot.removeListener('path_update', onUpdate);
      await sleep(400);
    }

    // Can we descend by simply walking off the tree?
    log.info('walking forward for 4s to fall off the tree...');
    bot.setControlState('forward', true);
    for (let i = 0; i < 8; i += 1) {
      await sleep(500);
      log.info(`  t+${(i + 1) * 500}ms pos=${bot.entity.position.floored()} onGround=${bot.entity.onGround}`);
    }
    bot.setControlState('forward', false);
    log.info(`after fall: ${bot.entity.position.floored()}`);
  } catch (err) {
    log.error(`matrix crashed: ${err.stack}`);
  } finally {
    controller.shutdown();
    await sleep(400);
    process.exit(0);
  }
});

controller.connect();
setTimeout(() => {
  controller.shutdown();
  process.exit(2);
}, 120000);
