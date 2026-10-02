'use strict';

/**
 * Minimal raw-pathfinder probe: does `bot.pathfinder.goto()` work at all in this
 * installation? No Navigator wrapper, no brain - just the plugin.
 */

const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { BotController } = require('../src/core/bot');
const { sleep } = require('../src/core/movement');

const cfg = loadConfig();
const log = new Logger('raw');
const controller = new BotController(cfg, new Logger('bot', { level: 'info' }));

controller.on('spawn', async () => {
  const bot = controller.bot;
  try {
    log.info(`spawned at ${bot.entity.position}`);
    await sleep(5000);

    log.info(`pathfinder keys: ${Object.keys(bot.pathfinder).join(', ')}`);
    log.info(`isMoving=${bot.pathfinder.isMoving()} goal=${bot.pathfinder.goal}`);

    bot.on('path_update', (r) => log.info(`  [path_update] status=${r.status} nodes=${r.visitedNodes} len=${r.path ? r.path.length : 0}`));
    bot.on('goal_reached', () => log.info('  [goal_reached]'));
    bot.on('path_reset', (why) => log.info(`  [path_reset] ${why}`));

    const { goals, Movements } = require('mineflayer-pathfinder');
    const mv = new Movements(bot);
    log.info(`Movements created: canDig=${mv.canDig} scafolding=${mv.scafoldingBlocks.length} blocksToAvoid=${mv.blocksToAvoid.size}`);
    bot.pathfinder.setMovements(mv);

    const from = bot.entity.position.clone();
    const target = from.offset(3, 0, 0).floored();
    log.info(`RAW goto -> ${target} (from ${from.floored()})`);

    const goal = new goals.GoalNear(target.x, target.y, target.z, 1);
    log.info(`pathfinder.goal before=${bot.pathfinder.goal}`);

    const started = Date.now();
    try {
      await bot.pathfinder.goto(goal);
      log.info(`RAW goto resolved after ${Date.now() - started}ms, pos=${bot.entity.position.floored()}`);
    } catch (err) {
      log.warn(`RAW goto rejected after ${Date.now() - started}ms: ${err.message}`);
    }
    log.info(`moved distance: ${bot.entity.position.distanceTo(from).toFixed(2)} blocks`);
    log.info(`isMoving=${bot.pathfinder.isMoving()} pos=${bot.entity.position.floored()}`);

    // Try the same thing again, this time watching whether the bot physically moves.
    const before = bot.entity.position.clone();
    const goal2 = new goals.GoalNear(Math.floor(before.x) + 2, Math.floor(before.y), Math.floor(before.z), 1);
    const p = bot.pathfinder.goto(goal2).then(
      () => log.info('  second goto resolved'),
      (e) => log.warn(`  second goto rejected: ${e.message}`)
    );
    for (let i = 0; i < 8; i += 1) {
      await sleep(500);
      log.info(`  t+${(i + 1) * 500}ms pos=${bot.entity.position.floored()} moving=${bot.pathfinder.isMoving()}`);
    }
    await p;
  } catch (err) {
    log.error(`raw probe crashed: ${err.stack}`);
  } finally {
    controller.shutdown();
    await sleep(400);
    process.exit(0);
  }
});

controller.connect();
setTimeout(() => {
  log.warn('raw probe timeout');
  controller.shutdown();
  process.exit(2);
}, 90000);
