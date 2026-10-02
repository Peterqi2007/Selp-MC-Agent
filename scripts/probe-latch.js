'use strict';

/**
 * Is the latch caused by my Navigator wrapper, or by the environment?
 * Runs the identical walk twice: once through Navigator, once through the raw
 * plugin, and reports the internal goal/stop state between attempts.
 */

const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { BotController } = require('../src/core/bot');
const { Navigator, sleep } = require('../src/core/movement');
const { WorldView } = require('../src/world/worldView');

const cfg = loadConfig();
const log = new Logger('latch');
const controller = new BotController(cfg, new Logger('bot', { level: 'warn' }));
const nav = new Navigator(controller);
const view = new WorldView(controller);

controller.on('spawn', async () => {
  const bot = controller.bot;
  const { goals } = require('mineflayer-pathfinder');
  try {
    await sleep(6000);
    const pos = bot.entity.position.floored();
    log.info(`spawned ${pos} feet=${bot.blockAt(bot.entity.position)?.name} below=${bot.blockAt(pos.offset(0, -1, 0))?.name}`);

    const state = (tag) => {
      const g = bot.pathfinder.goal;
      log.info(`  [${tag}] goal=${g ? g.constructor.name : 'null'} moving=${bot.pathfinder.isMoving()} isMining=${bot.pathfinder.isMining()} pos=${bot.entity.position.floored()}`);
    };

    state('initial');
    nav.refreshMovements({ canDig: true });
    state('after refreshMovements');

    // 1. Through my wrapper - a goal ONE block away (must be trivially reachable).
    const near = pos.offset(1, 0, 0);
    log.info(`TEST A: Navigator.goto one block away -> ${near}`);
    let okA = await nav.goto(near, { range: 1, timeoutMs: 8000 });
    log.info(`TEST A result=${okA} pos=${bot.entity.position.floored()}`);
    state('after A');

    // Clear the latch exactly the way the controller does, then retry.
    controller.rearmPathfinder();
    state('after rearm');

    log.info('TEST B: Navigator.goto the same one block away after rearm');
    const okB = await nav.goto(near, { range: 1, timeoutMs: 8000 });
    log.info(`TEST B result=${okB} pos=${bot.entity.position.floored()}`);
    state('after B');

    // 2. Raw plugin on a fresh target, no Navigator involved at all.
    controller.rearmPathfinder();
    const raw = bot.entity.position.offset(-2, 0, 0).floored();
    log.info(`TEST C: raw pathfinder.goto -> ${raw}`);
    let okC = 'resolved';
    try {
      await bot.pathfinder.goto(new goals.GoalNear(raw.x, raw.y, raw.z, 1));
    } catch (err) {
      okC = `rejected: ${err.message.split('!')[0]}`;
    }
    log.info(`TEST C ${okC} pos=${bot.entity.position.floored()}`);

    // 3. Does a real tree walk work now?
    const tree = view.findNearestLog(48);
    if (tree) {
      controller.rearmPathfinder();
      log.info(`TEST D: walk to nearest tree ${tree.name}@${tree.position}`);
      const okD = await nav.gotoBlock(tree, { range: 1, timeoutMs: 20000, canDig: true });
      log.info(`TEST D result=${okD} dist=${bot.entity.position.distanceTo(tree.position).toFixed(2)} pos=${bot.entity.position.floored()}`);
    } else {
      log.warn('TEST D skipped: no tree in range');
    }
  } catch (err) {
    log.error(`latch probe crashed: ${err.stack}`);
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
