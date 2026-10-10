'use strict';

/**
 * Survival domain knowledge: which items count as food / fuel / tools, how to read
 * the bot's inventory and equipment, and small helpers that several tasks need.
 *
 * Kept separate from the task layer so the knowledge table is easy to extend when
 * playing on a modded server (extra foods, extra tool tiers...).
 */

const FOOD_PRIORITY = [
  'golden_carrot',
  'cooked_beef',
  'cooked_porkchop',
  'cooked_mutton',
  'cooked_chicken',
  'cooked_rabbit',
  'cooked_salmon',
  'cooked_cod',
  'bread',
  'baked_potato',
  'carrot',
  'apple',
  'melon_slice',
  'beef',
  'porkchop',
  'mutton',
  'chicken',
  'rabbit',
  'salmon',
  'cod',
  'sweet_berries',
  'potato',
  'beetroot',
  'dried_kelp',
  'cookie'
];

/** Foods the agent is willing to eat raw (everything else should be cooked first). */
const RAW_FOODS = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'salmon', 'cod', 'potato']);

const FUELS = ['coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks', 'stick', 'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'lava_bucket', 'blaze_rod', 'dried_kelp_block', 'coal_block'];

const LOG_BLOCKS = ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'bamboo_block', 'crimson_stem', 'warped_stem'];

const TOOL_TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'];

const PICKAXE_REQUIRED = new Set([
  'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'coal_ore', 'deepslate_coal_ore',
  'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore', 'lapis_ore',
  'deepslate_lapis_ore', 'gold_ore', 'deepslate_gold_ore', 'redstone_ore', 'deepslate_redstone_ore',
  'diamond_ore', 'deepslate_diamond_ore', 'emerald_ore', 'deepslate_emerald_ore',
  'nether_gold_ore', 'nether_quartz_ore', 'ancient_debris', 'obsidian', 'iron_block', 'gold_block',
  'diamond_block', 'emerald_block', 'lapis_block', 'redstone_block', 'coal_block', 'furnace',
  'sandstone', 'terracotta', 'bricks', 'stone_bricks', 'andesite', 'diorite', 'granite',
  'tuff', 'calcite', 'dripstone_block', 'amethyst_block', 'basalt', 'blackstone', 'end_stone'
]);

/** Blocks that are effectively free to walk through from a pathfinding perspective. */
const PASSABLE = new Set([  'air', 'cave_air', 'void_air', 'water', 'lava', 'grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip',
  'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley',
  'sunflower', 'lilac', 'rose_bush', 'peony', 'torch', 'wall_torch', 'soul_torch', 'redstone_torch',
  'snow', 'vine', 'kelp', 'seagrass', 'sugar_cane', 'wheat', 'carrots', 'potatoes', 'beetroots',
  'sapling', 'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling', 'acacia_sapling',
  'dark_oak_sapling', 'brown_mushroom', 'red_mushroom', 'rail', 'powered_rail', 'detector_rail',
  'activator_rail', 'lever', 'stone_button', 'oak_button', 'tripwire', 'tripwire_hook', 'string',
  'fire', 'soul_fire', 'nether_portal', 'end_portal', 'light', 'structure_void', 'barrier'
]);

/** Strip a namespace: "minecraft:oak_log" -> "oak_log". */
function bare(name) {
  if (!name) return '';
  const idx = String(name).indexOf(':');
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

/**
 * Minimum pickaxe tier needed before a block is worth breaking.
 *
 * ONE EDITABLE TABLE, because this is a policy decision rather than a fact of the game, and
 * getting it wrong is expensive in both directions: too lenient and the bot destroys blocks
 * for nothing (a block broken below its tier drops NOTHING - it does not drop the item), too
 * strict and it refuses work it could have done.
 *
 * The table started as the operator's rule (diamond ore -> diamond pickaxe) and was then relaxed
 * by them twice: `diamond_ore` on 2026-10-01 and `deepslate_diamond_ore` on 2026-10-02 - both
 * now ask for **iron**, matching vanilla. `npm run selftest` and `npm run tasks:test` assert the
 * table entry by entry, so an edit here must be mirrored there - a tier table that disagrees
 * with its own tests is worse than either version.
 *
 * Absent from the table = no tool requirement (bare hand is fine): dirt, sand, gravel, wood,
 * wool, glass, plants, and every modded block we have no opinion about.
 */
const BLOCK_TIER_REQUIREMENT = new Map([
  // diamond and better only
  ['ancient_debris', 'diamond'],
  ['obsidian', 'diamond'],

  // iron and better
  ['diamond_ore', 'iron'],
  ['deepslate_diamond_ore', 'iron'],
  ['redstone_ore', 'iron'],
  ['deepslate_redstone_ore', 'iron'],
  ['lapis_ore', 'iron'],
  ['deepslate_lapis_ore', 'iron'],
  ['gold_ore', 'iron'],
  ['deepslate_gold_ore', 'iron'],
  ['emerald_ore', 'iron'],
  ['deepslate_emerald_ore', 'iron'],
  ['nether_gold_ore', 'iron'],

  // stone and better
  ['iron_ore', 'stone'],
  ['deepslate_iron_ore', 'stone'],
  ['copper_ore', 'stone'],
  ['deepslate_copper_ore', 'stone'],

  // wooden and better
  ['stone', 'wooden'],
  ['cobblestone', 'wooden'],
  ['deepslate', 'wooden'],
  ['cobbled_deepslate', 'wooden'],
  ['coal_ore', 'wooden'],
  ['deepslate_coal_ore', 'wooden'],
  ['nether_quartz_ore', 'wooden']
]);

/**
 * The minimum pickaxe tier for a block, as a tier name, or `null` when bare hands suffice.
 *
 * @param {string} blockName namespaced or bare
 * @returns {string|null} one of TOOL_TIERS, or null
 */
function requiredTierFor(blockName) {
  const name = bare(blockName);
  if (BLOCK_TIER_REQUIREMENT.has(name)) return BLOCK_TIER_REQUIREMENT.get(name);
  // Deepslate variants of anything listed keep the same requirement.
  if (name.startsWith('deepslate_') && BLOCK_TIER_REQUIREMENT.has(name.slice('deepslate_'.length))) {
    return BLOCK_TIER_REQUIREMENT.get(name.slice('deepslate_'.length));
  }
  return null;
}

/** Rank of a tier name (0 = wooden, 5 = netherite), or -1 when unknown. */
function tierRank(tierName) {
  return TOOL_TIERS.indexOf(String(tierName || ''));
}

/**
 * The pickaxe *harvest level* of a tier: which blocks it is allowed to break at all.
 *
 * Deliberately NOT `TOOL_TIERS.indexOf()`. `TOOL_TIERS` is an ordered list for progression
 * ("have we got past stone tools yet?"), and in that list golden sits above iron. For mining
 * that order is wrong: gold's harvest level is **0, the same as wood**, so a golden pickaxe
 * cannot break iron ore, gold ore, redstone or diamond at all - it is only much faster on the
 * blocks it can break. Using the tier index here would have let the agent take a golden
 * pickaxe to diamond ore and stand there swinging.
 *
 * Netherite shares diamond's level, also as in the game.
 */
const HARVEST_LEVEL = {
  wooden: 0,
  golden: 0,
  stone: 1,
  iron: 2,
  diamond: 3,
  netherite: 3
};

/**
 * Harvest level of a tier name; -1 when the name is unknown (treated as "cannot mine").
 * @param {string} tierName
 * @returns {number}
 */
function harvestLevel(tierName) {
  const name = String(tierName || '');
  return Object.prototype.hasOwnProperty.call(HARVEST_LEVEL, name) ? HARVEST_LEVEL[name] : -1;
}

/**
 * The item a block yields when broken.
 *
 * This table exists because "I broke the block" and "I got the item" are different
 * events, and conflating them is the single most misleading bug in a harvesting agent:
 * stone mined bare-handed disappears and drops **nothing**, and even with the right tool
 * the drop is rarely the block (`stone` -> `cobblestone`, `iron_ore` -> `raw_iron`).
 * Counting broken blocks therefore reports success with an empty inventory.
 *
 * Two rules that are easy to get wrong and are handled explicitly here:
 *   - `deepslate_X_ore` must be recognised BEFORE the generic `_ore` rule, or
 *     `deepslate_gold_ore` becomes `raw_deepslate_gold`.
 *   - only iron/copper/gold drop `raw_*`. Coal, diamond, emerald, lapis and redstone
 *     drop the plain item, and nether_gold_ore drops nuggets.
 *
 * Unknown and modded blocks fall back to themselves, which is the safe default (most
 * modded blocks do drop themselves, and a wrong guess only affects progress counting).
 *
 * @param {string} blockName namespaced or bare
 * @returns {string} bare item name
 */
function blockDrop(blockName) {
  const name = bare(blockName);
  if (!name) return '';

  // 1. Explicit table first: it holds every case the rules below would get wrong.
  const exact = BLOCK_DROPS[name];
  if (exact) return exact;

  // 2. raw_* rule, deepslate-prefixed ores included.
  const raw = name.startsWith('deepslate_') ? name.slice('deepslate_'.length) : name;
  if (RAW_DROP_ORES.has(raw)) return `raw_${raw.slice(0, -'_ore'.length)}`;

  // 3. Anything else drops itself.
  return name;
}

/** How many items a block yields (clay drops 4 balls, ore blocks drop 1). */
function blockDropCount(blockName) {
  return bare(blockName) === 'clay' ? 4 : 1;
}

/** Blocks whose drop is not themselves and cannot be derived by rule. */
const BLOCK_DROPS = {
  stone: 'cobblestone',
  deepslate: 'cobbled_deepslate',
  grass_block: 'dirt',
  mycelium: 'dirt',
  podzol: 'dirt',
  dirt_path: 'dirt',
  farm: 'dirt',
  farmland: 'dirt',
  coal_ore: 'coal',
  deepslate_coal_ore: 'coal',
  diamond_ore: 'diamond',
  deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald',
  deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli',
  deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone',
  deepslate_redstone_ore: 'redstone',
  nether_quartz_ore: 'quartz',
  nether_gold_ore: 'gold_nugget',
  clay: 'clay_ball',
  gravel: 'gravel',
  snow_block: 'snowball',
  bookshelf: 'book',
  gilded_blackstone: 'gilded_blackstone',
  // Leaves drop saplings/apples at random; listing them keeps the fallback honest.
  oak_leaves: 'oak_sapling',
  spruce_leaves: 'spruce_sapling',
  birch_leaves: 'birch_sapling',
  jungle_leaves: 'jungle_sapling',
  acacia_leaves: 'acacia_sapling',
  dark_oak_leaves: 'dark_oak_sapling'
};

/** Ores that follow the `X_ore -> raw_X` rule (see blockDrop). */
const RAW_DROP_ORES = new Set([
  'iron_ore', 'copper_ore', 'gold_ore', 'deepslate_iron_ore', 'deepslate_copper_ore', 'deepslate_gold_ore'
]);

function isLog(name) {  return LOG_BLOCKS.includes(name) || /_log$/.test(name) || /_stem$/.test(name);
}

function planksFor(logName, registry) {
  const base = String(logName)
    .replace(/_log$/, '')
    .replace(/_stem$/, '')
    .replace(/^stripped_/, '');
  const candidate = `${base}_planks`;
  return registry && registry.itemsByName[candidate] ? candidate : 'oak_planks';
}

function isFood(name, registry) {
  if (FOOD_PRIORITY.includes(name)) return true;
  const item = registry && registry.itemsByName[name];
  if (item && item.foodPoints) return true;
  return false;
}

function foodScore(name) {
  const idx = FOOD_PRIORITY.indexOf(name);
  return idx === -1 ? -1 : FOOD_PRIORITY.length - idx;
}

function isFuel(name) {
  return FUELS.includes(name) || /_planks$/.test(name) || /_log$/.test(name) || /_coal$/.test(name);
}

function countItem(bot, name) {
  return bot.inventory.items().filter((i) => i.name === name).reduce((sum, i) => sum + i.count, 0);
}

function countMatching(bot, predicate) {
  return bot.inventory.items().filter((i) => predicate(i.name)).reduce((sum, i) => sum + i.count, 0);
}

function inventorySummary(bot) {
  const items = {};
  for (const item of bot.inventory.items()) {
    items[item.name] = (items[item.name] || 0) + item.count;
  }
  return items;
}

function emptySlots(bot) {
  return bot.inventory.emptySlotCount();
}

/**
 * Best tool tier currently owned for a given kind.
 *
 * Accepts anything with `.inventory.items()` returning `[{name, count}]`: a mineflayer
 * bot, or the body-agnostic `SnapshotInventory` facade. The result carries both `tier`
 * (name) and `rank` (index into TOOL_TIERS) so callers can use either form.
 *
 * @returns {{name:string, tier:string, rank:number}|null}
 */
function bestTool(bot, kind) {
  if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return null;
  let best = null;
  for (const item of bot.inventory.items()) {
    for (const tier of TOOL_TIERS) {
      if (item.name === `${tier}_${kind}`) {
        const rank = TOOL_TIERS.indexOf(tier);
        if (!best || rank > best.rank) best = { name: item.name, tier, rank };
      }
    }
  }
  return best;
}

function hasPickaxe(bot) {
  return !!bestTool(bot, 'pickaxe');
}

function needsPickaxe(blockName) {
  return PICKAXE_REQUIRED.has(blockName);
}

function isPassable(name) {
  return PASSABLE.has(name);
}

/**
 * Blocks a player actually pillars with, in preference order.
 *
 * One list for the mining skill, the pillar executor and the mock body: the offline
 * tests must choose the same support block the live run would, or "no scaffold" passes
 * offline and fails in game.
 */
const SCAFFOLD_BLOCKS = [
  'cobblestone', 'cobbled_deepslate', 'dirt', 'oak_planks', 'spruce_planks', 'birch_planks',
  'oak_log', 'spruce_log', 'birch_log', 'stone', 'deepslate', 'granite', 'diorite',
  'andesite', 'tuff', 'netherrack'
];

/**
 * Pick the best scaffold stack from a `{name: count}` inventory.
 *
 * @param {object} inventory
 * @returns {string|null} the inventory key (namespace preserved) or null
 */
function findScaffold(inventory) {
  const inv = inventory || {};
  for (const want of SCAFFOLD_BLOCKS) {
    const found = Object.keys(inv).find((name) => bare(name) === want && inv[name] > 0);
    if (found) return found;
  }
  return null;
}

module.exports = {
  FOOD_PRIORITY,
  RAW_FOODS,
  FUELS,
  LOG_BLOCKS,
  TOOL_TIERS,
  TOOL_KINDS,
  PICKAXE_REQUIRED,
  PASSABLE,
  BLOCK_DROPS,
  RAW_DROP_ORES,
  BLOCK_TIER_REQUIREMENT,
  HARVEST_LEVEL,
  blockDrop,
  blockDropCount,
  bare,
  requiredTierFor,
  tierRank,
  harvestLevel,
  isLog,
  isFood,
  foodScore,
  isFuel,
  planksFor,
  countItem,
  countMatching,
  inventorySummary,
  emptySlots,
  bestTool,
  hasPickaxe,
  needsPickaxe,
  isPassable,
  SCAFFOLD_BLOCKS,
  findScaffold
};
