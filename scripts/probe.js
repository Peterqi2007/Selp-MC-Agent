'use strict';

/**
 * Interactive behaviour probe.
 *
 * Connects like the agent, then exercises one primitive at a time with full
 * pathfinder instrumentation so failures are attributable:
 *   move -> dig -> pickup -> craft.
 *
 *   node scripts/probe.js
 */

const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { BotController } = require('../src/core/bot');
const { WorldView } = require('../src/world/worldView');
const { Navigator, digBlock, sleep, equipBest } = require('../src/core/movement');
const { isLog, countMatching } = require('../src/world/items');

const cfg = loadConfig();
const log = new Logger('probe');
const controller = new BotController(cfg, new Logger('bot', { level: 'info' }));
const view = new WorldView(controller);
const nav = new Navigator(controller);

function inv(bot) {
  const items = bot.inventory.items();
  return items.length ? items.map((i) => `${i.name}x${i.count}`).join(', ') : '(empty)';
}

controller.on('spawn', async () => {
  const bot = controller.bot;
  try {
    log.info(`spawned at ${bot.entity.position} - waiting 5s for chunks`);
    await sleep(5000);

    bot.pathfinder.thinkTimeout = 10000;
    bot.pathfinder.tickTimeout = 40;
    const debugPath = (r) => {
      log.info(`  [path_update] status=${r.status} nodes=${r.visitedNodes} len=${r.path ? r.path.length : 0}`);
    };
    bot.on('path_update', debugPath);
    bot.on('goal_reached', () => log.info('  [goal_reached]'));
    bot.on('path_reset', (why) => log.info(`  [path_reset] ${why}`));
    bot.on('noPath', () => log.info('  [noPath]'));

    // ---- 0. sanity: how many logs can we see, and is the world loaded? -----
    log.info(`logs in range 48: ${countMatching(bot, isLog)} in inventory; nearby blocks loaded=${!!bot.blockAt(bot.entity.position.offset(0, -1, 0))}`);

    // ---- 1. simple movement in a straight line ----------------------------
    const flatTarget = bot.entity.position.offset(3, 0, 0);
    log.info('TEST 1: walk 3 blocks east');
    const t1 = await nav.goto(flatTarget, { range: 1, timeoutMs: 15000 });
    log.info(`TEST 1 result: ${t1} - now at ${bot.entity.position.floored()} (moved ${bot.entity.position.distanceTo(flatTarget).toFixed(2)} from target)`);

    // ---- 2. walk to the nearest log --------------------------------------
    log.info('TEST 2: walk to the nearest log');
    const nearest = view.findNearestLog(48);
    if (nearest) {
      log.info(`  target ${nearest.name} @ ${nearest.position}`);
      const t2 = await nav.gotoBlock(nearest, { range: 1, timeoutMs: 20000 });
      log.info(`TEST 2 result: ${t2} - distance now ${bot.entity.position.distanceTo(nearest.position).toFixed(2)}`);
    } else {
      log.warn('TEST 2 skipped: no log found');
    }

    // ---- 3. dig + pickup -------------------------------------------------
    log.info('TEST 3: dig nearest log and pick up the drop');
    const target = view.findNearestLog(48);
    if (target) {
      const fresh = bot.blockAt(target.position);
      const dug = await digBlock(controller, fresh, { log });
      log.info(`  digBlock -> ${dug}`);
      await sleep(2000);
      const drops = view.nearbyItemEntities(10);
      log.info(`  item entities within 10: ${drops.length} ${drops.slice(0, 3).map((d) => `${d.name}@${d.position.floored()}`).join(' ')}`);
      if (drops.length) {
        const drop = drops[0];
        log.info(`  navigating to drop at ${drop.position.floored()}`);
        const t3 = await nav.goto(drop.position, { range: 1, timeoutMs: 15000 });
        log.info(`  goto drop -> ${t3}`);
        await sleep(1500);
      }
      log.info(`  inventory: ${inv(bot)}`);
    } else {
      log.warn('TEST 3 skipped: no log found');
    }

    // ---- 4. craft planks + sticks + a wooden pickaxe ----------------------
    log.info('TEST 4: craft planks -> sticks -> wooden_pickaxe');
    const logItem = bot.inventory.items().find((i) => isLog(i.name));
    if (logItem) {
      const mcData = bot.registry;
      const base = logItem.name.replace(/_log$/, '');
      const plank = `${base}_planks`;
      for (const [item, count, table] of [[plank, 4, null], ['stick', 4, null], ['wooden_pickaxe', 1, null], ['crafting_table', 1, null]]) {
        const it = mcData.itemsByName[item];
        if (!it) {
          log.warn(`  ${item}: unknown item`);
          continue;
        }
        const recipes = bot.recipesFor(it.id, null, 1, null) || [];
        log.info(`  ${item}: ${recipes.length} inventory recipe(s)`);
        if (recipes.length) {
          try {
            await bot.craft(recipes[0], 1, undefined);
            log.info(`  crafted ${item} -> ${inv(bot)}`);
          } catch (err) {
            log.warn(`  craft ${item} failed: ${err.message}`);
          }
        }
      }
    } else {
      log.warn('TEST 4 skipped: no logs in inventory');
    }

    log.info(`FINAL inventory: ${inv(bot)}`);
    log.info(`FINAL position: ${bot.entity.position.floored()}`);
  } catch (err) {
    log.error(`probe crashed: ${err.stack}`);
  } finally {
    controller.shutdown();
    await sleep(500);
    process.exit(0);
  }
});

controller.connect();
setTimeout(() => {
  log.warn('probe timeout');
  controller.shutdown();
  process.exit(2);
}, 180000);
