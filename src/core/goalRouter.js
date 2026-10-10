'use strict';

/**
 * Free-text goal router: turns "挖2块铁" into a task, once, for every entry that speaks
 * natural-ish language - `!goal`, the CLI `--goal` flag and (through them) the panel.
 *
 * The plan's §5.6.1 finding: the two copies of this routing (commands.onGoal and
 * index.applyGoal) disagreed on ordering - "挖铁" matched the generic 挖/stone branch
 * before the iron branch in one of them and mined rock while the player asked for iron.
 * Specific ores now win over generic verbs, and ore targets go to the ore executor
 * (`MineOreTask` -> `mine_ore`) instead of the walk-only task.
 */

const { ChopWoodTask } = require('../tasks/chopWood');
const { MineBlockTask } = require('../tasks/mineBlock');
const { MineOreTask } = require('../tasks/mineOre');
const { HuntTask } = require('../tasks/hunt');
const { ShelterTask } = require('../tasks/shelter');
const { CraftTask } = require('../tasks/craft');
const { LightTask } = require('../tasks/light');
const { DepositTask } = require('../tasks/deposit');

/**
 * Route one free-text goal.
 *
 * @param {object} ctx
 * @param {string} goal
 * @returns {{task:object, note:string}|null} null when nothing recognises it
 */
function routeGoal(ctx, goal) {
  const text = String(goal || '').toLowerCase();
  const numMatch = text.match(/(\d+)/);
  const count = numMatch ? Number(numMatch[1]) : undefined;

  if (/wood|log|tree|木头|原木|砍树|砍点|砍些|砍/.test(text)) {
    const n = count || 16;
    return { task: new ChopWoodTask(ctx, { count: n }), note: `去砍 ${n} 根木头` };
  }
  /**
   * Craft before the ore words: "合成铁镐" contains 铁 but asks for a workbench job, and
   * the old ordering answered it with an ore hunt.
   */
  if (/craft|合成|做一个|做一把|做个/.test(text)) {
    const item = text.replace(/craft|合成|做一个|做一把|做个|\d+|个/g, '').trim().replace(/\s+/g, '_');
    return { task: new CraftTask(ctx, { item, count: count || 1 }), note: `去合成 ${item}` };
  }
  /**
   * Specific ores before the generic dig verbs (plan §5.6.1: 明确矿物优先于泛采集词).
   * Ores use the dig-while-walking executor; embedded veins are unreachable for the
   * walk-only harvest task.
   */
  const ore = (block, n, note) => ({ task: new MineOreTask(ctx, { block, count: n, timeoutMs: 240000 }), note });
  if (/iron|铁/.test(text)) return ore(['iron_ore'], count || 3, '去挖铁');
  if (/diamond|钻石/.test(text)) return ore(['diamond_ore'], count || 1, '去挖钻石');
  if (/coal|煤/.test(text)) return ore(['coal_ore'], count || 8, '去挖煤');
  if (/emerald|绿宝石/.test(text)) return ore(['emerald_ore'], count || 1, '去挖绿宝石');
  if (/redstone|红石/.test(text)) return ore(['redstone_ore'], count || 8, '去挖红石');
  if (/lapis|青金石/.test(text)) return ore(['lapis_ore'], count || 3, '去挖青金石');
  if (/quartz|石英/.test(text)) return ore(['nether_quartz_ore'], count || 8, '去挖石英');
  if (/ancient_debris|残骸|netherite|下界合金/.test(text)) return ore(['ancient_debris'], count || 1, '去挖远古残骸');
  if (/gold|金/.test(text)) return ore(['gold_ore'], count || 3, '去挖金');
  if (/copper|铜/.test(text)) return ore(['copper_ore'], count || 8, '去挖铜');
  // Dirt before stone: "挖泥土" also matches the stone branch below via 挖, and answering a
  // request for dirt with a stone task looks like the agent ignoring what was asked.
  if (/dirt|泥土|土块|挖土/.test(text)) {
    return {
      task: new MineBlockTask(ctx, { block: ['dirt', 'grass_block'], count: count || 16, probeShaft: false }),
      note: `去挖 ${count || 16} 个泥土`
    };
  }
  if (/stone|cobble|石头|圆石|挖/.test(text)) {
    return {
      task: new MineBlockTask(ctx, { block: ['stone', 'cobblestone', 'deepslate'], count: count || 16 }),
      note: `去挖 ${count || 16} 个石头`
    };
  }
  if (/food|hunt|meat|食物|打猎|吃肉/.test(text)) {
    return { task: new HuntTask(ctx, { count: count || 3 }), note: '去打猎' };
  }
  if (/shelter|house|base|庇护|房子|基地/.test(text)) return { task: new ShelterTask(ctx), note: '去造庇护所' };
  if (/light|torch|火把|照明/.test(text)) return { task: new LightTask(ctx, { count: count || 4 }), note: '去插火把' };
  if (/store|chest|存|箱子/.test(text)) return { task: new DepositTask(ctx), note: '去存东西' };
  return null;
}

/**
 * Route and push onto the brain queue (the CLI/`--goal` path).
 *
 * @returns {Promise<object|null>} the enqueue receipt, or null when not understood
 */
async function applyGoal(ctx, goal) {
  const routed = routeGoal(ctx, goal);
  if (!routed) {
    if (ctx.log && ctx.log.warn) ctx.log.warn(`goal not understood: "${goal}"`);
    return null;
  }
  return ctx.brain.push(routed.task);
}

module.exports = { routeGoal, applyGoal };
