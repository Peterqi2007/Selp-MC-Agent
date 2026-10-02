'use strict';

/**
 * Focused reproduction of the "pathfinder returns an empty partial path" symptom.
 * Tries a horizontal goal, then a goal straight down, then walks off manually.
 */

const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { BotController } = require('../src/core/bot');
const { sleep } = require('../src/core/movement');

const cfg = loadConfig();
const log = new Logger('repro');
const controller = new BotController(cfg, new Logger('bot', { level: 'warn' }));

controller.on('spawn', async () => {
  const bot = controller.bot;
  const { goals, Movements } = require('mineflayer-pathfinder');
  try {
    await sleep(5000);
    const start = bot.entity.position.floored();
    log.info(`start ${start} onGround=${bot.entity.onGround} feetBlock=${bot.blockAt(bot.entity.position)?.name}`);

    const mv = new Movements(bot);
    mv.canDig = false;
    mv.maxDropDown = 4;
    mv.allow1by1towers = true;
    bot.pathfinder.setMovements(mv);
    bot.pathfinder.thinkTimeout = 4000;
    bot.pathfinder.searchRadius = 48;

    const tryGoal = async (label, goal) => {
      let status = '?';
      let len = -1;
      const h = (r) => {
        status = r.status;
        len = r.path ? r.path.length : -1;
      };
      bot.on('path_update', h);
      const t0 = Date.now();
      let outcome;
      try {
        const p = await Promise.race([
          bot.pathfinder.goto(goal).then(() => 'resolved'),
          sleep(6000).then(() => 'race-timeout')
        ]);
        outcome = p;
      } catch (err) {
        outcome = `threw: ${err.message.split('!')[0]}`;
      }
      bot.removeListener('path_update', h);
      log.info(`${label}: outcome=${outcome} status=${status} pathLen=${len} dt=${Date.now() - t0}ms pos=${bot.entity.position.floored()}`);
      bot.pathfinder.stop();
      await sleep(300);
    };

    await tryGoal('east 3 (same y)', new goals.GoalNear(start.x + 3, start.y, start.z, 1));
    await tryGoal('down 6 (below tree)', new goals.GoalNear(start.x, start.y - 6, start.z, 1));
    await tryGoal('far east 10 at ground', new goals.GoalNear(start.x + 10, 66, start.z, 1));

    // Manual escape: sneak-walk off the canopy.
    log.info('manual fall test: holding forward until onGround at a lower y');
    bot.setControlState('forward', true);
    const y0 = bot.entity.position.y;
    for (let i = 0; i < 20; i += 1) {
      await sleep(500);
      const p = bot.entity.position;
      if (p.y < y0 - 8 && bot.entity.onGround) break;
    }
    bot.setControlState('forward', false);
    await sleep(500);
    log.info(`after manual walk: ${bot.entity.position.floored()} (started y=${y0.toFixed(1)})`);

    const ground = bot.entity.position.floored();
    await tryGoal('east 3 after descending', new goals.GoalNear(ground.x + 3, ground.y, ground.z, 1));
  } catch (err) {
    log.error(`repro crashed: ${err.stack}`);
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
}, 90000);
