'use strict';

/**
 * GoalEvaluator - the planner's rule table, as a pure function.
 *
 * RETIREMENT S1: the rules used to be 22 inline thunks inside `Brain.decide()`, which made
 * them untestable without a brain, mixed "which goal" with "build which task", and let a
 * precondition that threw disappear into a debug log (PLANNER-REFACTOR P1: the `shelter`
 * rule referenced an undefined `bot` for months). This module keeps the same order and the
 * same conditions, but returns **declarative candidates**:
 *
 *     { rule, type, name, args, weight, reason }
 *
 * - `rule`  is the rule's own name (may differ from the task name, e.g. rule `mine` ->
 *           `MineOreTask`, whose name is `mine_ore`)
 * - `type`  selects a task constructor in the Brain's factory (still legacy execution in S1)
 * - `name`  is the eventual TASK name, which is what quarantine is keyed on
 * - `args`  is the constructor option object
 *
 * The evaluator never constructs a task and never touches the body: it reads one snapshot and
 * returns data. That is what makes the rules directly testable (see `npm run planner:test`
 * and A10 in `mining-inter-entry-test`).
 *
 * Two deliberate differences from the old inline table (both are fixes, not drift):
 *   1. A rule whose precondition throws is **reported** (`onRuleError`) instead of being
 *      silently skipped at debug level.
 *   2. Rules whose task can only be driven through a mineflayer instance (`shelter`,
 *      `light`) carry `requiresBody: 'mineflayer'`. On a body without one they are skipped
 *      with a recorded reason instead of being selected and failing forever (P1/P2).
 */

const { countItem, countMatching, isFood, isLog, bestTool, TOOL_TIERS } = require('../world/items');
const { SnapshotInventory } = require('../world/snapshotInventory');
const { capabilities } = require('../core/capabilities');

/**
 * Order matters: the first candidate whose task name is not quarantined wins.
 *
 * `weight` mirrors the priority handed to the task (it is informational here; the array
 * order is what decides).
 */
const RULES = [
  {
    rule: 'deposit',
    type: 'deposit',
    name: 'deposit',
    weight: 5,
    reason: 'inventory is nearly full',
    when: (v) => v.canDeposit && v.emptySlots <= 2,
    args: () => ({ priority: 5 })
  },
  {
    rule: 'hunt',
    type: 'hunt',
    name: 'hunt',
    weight: 10,
    reason: 'hurt and out of food',
    when: (v) => v.canHunt && v.foodCount === 0 && (v.food < 17 || v.health < 12),
    args: () => ({ count: 3, priority: 10 })
  },
  {
    rule: 'gather-wood',
    type: 'chop-wood',
    name: 'chop-wood',
    weight: 20,
    reason: 'less than four logs of wood',
    when: (v) => v.mayChop && v.wood < 4,
    args: () => ({ count: 8, priority: 20 })
  },
  {
    rule: 'craft',
    type: 'craft',
    name: 'craft',
    weight: 25,
    reason: 'no crafting table',
    when: (v) => v.canCraft && !v.has('crafting_table'),
    args: () => ({ item: 'crafting_table', count: 1, requireTable: false, priority: 25 })
  },
  {
    rule: 'craft',
    type: 'craft',
    name: 'craft',
    weight: 27,
    reason: 'no pickaxe yet and logs in hand',
    when: (v) => v.canCraft && v.pickRank < 0 && v.planks < 3 && v.logs > 0,
    args: (v) => ({ item: plankName(v), count: 4, requireTable: false, priority: 27 })
  },
  {
    rule: 'gather-wood',
    type: 'chop-wood',
    name: 'chop-wood',
    weight: 27,
    reason: 'no pickaxe and not enough planks',
    when: (v) => v.mayChop && v.pickRank < 0 && v.planks < 3,
    args: () => ({ count: 8, priority: 27 })
  },
  {
    rule: 'craft',
    type: 'craft',
    name: 'craft',
    weight: 28,
    reason: 'no pickaxe and no sticks',
    when: (v) => v.canCraft && v.pickRank < 0 && v.planks >= 3 && !v.has('stick', 2),
    args: () => ({ item: 'stick', count: 4, requireTable: false, priority: 28 })
  },
  {
    rule: 'craft',
    type: 'craft',
    name: 'craft',
    weight: 30,
    reason: 'no pickaxe',
    when: (v) => v.canCraft && v.pickRank < 0,
    args: () => ({ item: 'wooden_pickaxe', count: 1, priority: 30 })
  },
  {
    rule: 'shelter',
    type: 'shelter',
    name: 'shelter',
    weight: 35,
    reason: 'night is falling and there is building material',
    requiresBody: 'mineflayer',
    when: (v) =>
      v.cfg.survival &&
      v.cfg.survival.shelterAtNight &&
      v.isNight &&
      !(v.memory && typeof v.memory.landmark === 'function' && v.memory.landmark('shelter')) &&
      v.materials >= 16,
    args: () => ({ priority: 35 })
  },
  {
    rule: 'mine',
    type: 'mine',
    name: 'mine',
    weight: 40,
    reason: 'weak pickaxe or no sword, little cobblestone',
    when: (v) => v.hasPick && (v.pickRank < v.stoneRank || !v.hasSword) && v.cobble < 3,
    args: () => ({ block: ['stone', 'cobblestone', 'deepslate'], count: 8, priority: 40 })
  },
  {
    rule: 'craft',
    type: 'craft',
    name: 'craft',
    weight: 41,
    reason: 'weak pickaxe or no sword, no sticks',
    when: (v) => v.canCraft && (v.pickRank < v.stoneRank || !v.hasSword) && !v.has('stick', 2) && v.planks >= 2,
    args: () => ({ item: 'stick', count: 4, requireTable: false, priority: 41 })
  },
  {
    rule: 'craft',
    type: 'craft',
    name: 'craft',
    weight: 42,
    reason: 'pickaxe below stone tier',
    when: (v) => v.canCraft && v.pickRank < v.stoneRank,
    args: () => ({ item: 'stone_pickaxe', count: 1, priority: 42 })
  },
  {
    rule: 'craft',
    type: 'craft',
    name: 'craft',
    weight: 43,
    reason: 'no sword',
    when: (v) => v.canCraft && !v.hasSword,
    args: () => ({ item: 'stone_sword', count: 1, priority: 43 })
  },
  {
    rule: 'light',
    type: 'light',
    name: 'light',
    weight: 45,
    reason: 'coal in hand and no torches',
    requiresBody: 'mineflayer',
    when: (v) => !v.has('torch') && (v.has('coal') || v.has('charcoal')),
    args: () => ({ count: 4, priority: 45 })
  },
  {
    rule: 'mine',
    type: 'mine',
    name: 'mine',
    weight: 47,
    reason: 'no furnace and little cobblestone',
    when: (v) => v.hasPick && !v.has('furnace') && v.cobble < 8,
    args: () => ({ block: ['stone', 'cobblestone', 'deepslate'], count: 8, priority: 47 })
  },
  {
    rule: 'craft',
    type: 'craft',
    name: 'craft',
    weight: 48,
    reason: 'no furnace',
    when: (v) => v.canCraft && !v.has('furnace'),
    args: () => ({ item: 'furnace', count: 1, priority: 48 })
  },
  {
    rule: 'hunt',
    type: 'hunt',
    name: 'hunt',
    weight: 50,
    reason: 'low on food items',
    when: (v) => v.canHunt && v.foodCount < 3,
    args: () => ({ count: 3, priority: 50 })
  },
  {
    rule: 'craft',
    type: 'craft',
    name: 'craft',
    weight: 55,
    reason: 'enough raw iron for an iron pickaxe',
    when: (v) =>
      v.canCraft &&
      v.pickRank >= v.stoneRank &&
      !v.has('iron_ingot', 3) &&
      countItem(v, 'raw_iron') + countItem(v, 'iron_ore') >= 3,
    args: () => ({ item: 'iron_pickaxe', count: 1, priority: 55 })
  },
  {
    rule: 'mine',
    type: 'mine-ore',
    name: 'mine_ore',
    weight: 56,
    reason: 'stone tools and no iron yet',
    when: (v) => v.hasPick && v.pickRank >= v.stoneRank && !v.has('iron_ingot', 3),
    /**
     * The autonomous iron run goes through the ore executor via the MineOreTask adapter:
     * it runs inside the planner's own ownership (no second TaskHub submission) and shares
     * the alias/variant normalization with every explicit entry (P1 §5.6.1).
     */
    args: () => ({ block: ['iron_ore'], count: 3, priority: 56, timeoutMs: 240000 })
  },
  {
    rule: 'gather-wood',
    type: 'chop-wood',
    name: 'chop-wood',
    weight: 60,
    reason: 'stockpiling wood',
    when: (v) => v.mayChop && v.wood < 16,
    args: () => ({ count: 16, priority: 60 })
  },
  {
    rule: 'light',
    type: 'light',
    name: 'light',
    weight: 62,
    reason: 'coal in hand',
    requiresBody: 'mineflayer',
    when: (v) => v.has('coal') || v.has('charcoal'),
    args: () => ({ count: 6, priority: 62 })
  },
  {
    rule: 'mine',
    type: 'mine',
    name: 'mine',
    weight: 70,
    reason: 'nothing else to do, mine stone',
    when: (v) => v.hasPick,
    args: () => ({ block: ['stone', 'cobblestone', 'deepslate'], count: 16, priority: 70 })
  }
  /**
   * There is deliberately no always-true fallback rule. Idling is a supported state: the
   * slow loop records `lastDecision.decision = 'idle'` and warns periodically. `!mine dirt 8`
   * and "挖点土" still work because an instruction is an instruction.
   *
   * The old `dig-dirt` rule (`when: () => true`) was removed by the operator; see the
   * P0-PLAN audit ("no always-true fallback goal").
   */
];

/**
 * Read one snapshot and derive everything the rules ask about.
 *
 * Pure with respect to the game: it only calls `world.snapshot()` and `world.isNight()`.
 * `options.rules` is for tests (inject a throwing rule); production always uses RULES.
 */
function buildView(ctx, options = {}) {
  const cfg = options.cfg || (ctx.cfg && ctx.cfg.agent) || {};
  const world = ctx.world || null;
  const snap = world && typeof world.snapshot === 'function' ? world.snapshot(true) : null;
  const inventory = new SnapshotInventory((snap && snap.inventory) || {}, {
    emptySlots: snap ? snap.emptySlots : undefined
  });
  const registry =
    options.registry !== undefined
      ? options.registry
      : ctx.controller && ctx.controller.bot && ctx.controller.bot.registry
        ? ctx.controller.bot.registry
        : null;
  const view = {
    cfg,
    world,
    memory: ctx.memory,
    inventory,
    registry,
    health: snap ? snap.health : 20,
    food: snap ? snap.food : 20,
    isNight: !!(world && typeof world.isNight === 'function' && world.isNight()),
    hasMineflayerBody: !!(ctx.controller && ctx.controller.bot)
  };
  const has = (name, n = 1) => countItem(view, name) >= n;
  const planks = countMatching(view, (n) => /_planks$/.test(n));
  const logs = countMatching(view, isLog);
  const pick = bestTool(view, 'pickaxe');
  const caps = capabilities(ctx);
  Object.assign(view, {
    has,
    capabilities: caps,
    planks,
    logs,
    wood: logs + planks,
    pick,
    pickRank: pick ? pick.rank : -1,
    hasSword: !!bestTool(view, 'sword'),
    foodCount: countMatching(view, (n) => isFood(n, view.registry)),
    emptySlots: inventory.emptySlotCount(),
    cobble: countItem(view, 'cobblestone'),
    stoneRank: TOOL_TIERS.indexOf('stone'),
    materials: countMatching(
      view,
      (n) => /_planks$/.test(n) || ['cobblestone', 'stone', 'dirt', 'sand'].includes(n)
    ),
    mayChop: cfg.survival ? cfg.survival.allowWoodChopping !== false : false,
    /**
     * Capability support comes from the one table (A05); `canX` stays as the rule-facing
     * name so the rule conditions above read unchanged.
     */
    canCraft: caps.crafting.supported,
    hasPick: pick ? pick.rank >= 0 : false,
    canDeposit: caps.deposit.supported,
    canHunt: caps.hunting.supported
  });
  return view;
}

/**
 * Evaluate every rule against one snapshot.
 *
 * @param {object} ctx agent context (cfg/body/world/memory/controller)
 * @param {object} [options]
 *   - cfg / registry: overrides for tests
 *   - rules: inject a rule list (tests)
 *   - onRuleError({rule, error}): a precondition threw
 *   - onRuleSkip({rule, reason}): the rule applies but the body cannot run its task
 * @returns {Array<{rule,type,name,args,weight,reason}>}
 */
function evaluate(ctx, options = {}) {
  const rules = options.rules || RULES;
  const view = buildView(ctx, options);
  const candidates = [];
  for (const rule of rules) {
    let applicable = false;
    try {
      applicable = rule.when(view);
    } catch (err) {
      if (options.onRuleError) options.onRuleError({ rule: rule.rule, error: err.message });
      continue;
    }
    if (!applicable) continue;
    if (rule.requiresBody === 'mineflayer') {
      const host = view.capabilities && view.capabilities[rule.rule];
      const supported = host ? host.supported : view.hasMineflayerBody;
      if (!supported) {
        if (options.onRuleSkip) {
          options.onRuleSkip({ rule: rule.rule, reason: (host && host.reason) || 'this body has no mineflayer instance' });
        }
        continue;
      }
    }
    candidates.push({
      rule: rule.rule,
      type: rule.type,
      name: rule.name,
      args: rule.args ? rule.args(view) : {},
      weight: rule.weight,
      reason: rule.reason
    });
  }
  return candidates;
}

/** Which plank type should we craft? Derived from the logs in hand (Body snapshot). */
function plankName(view) {
  const logItem = view.inventory.find((name) => isLog(name));
  if (!logItem) return 'oak_planks';
  const base = logItem.name.replace(/_log$/, '').replace(/_stem$/, '').replace(/^stripped_/, '');
  const candidate = `${base}_planks`;
  const registry = view.registry;
  if (!registry || !registry.itemsByName) return candidate;
  return registry.itemsByName[candidate] ? candidate : 'oak_planks';
}

module.exports = { evaluate, buildView, RULES };
