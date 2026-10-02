'use strict';

/**
 * One place that answers: "what does this block need in hand?"
 *
 * The P0 code answered that question in three places that could disagree: the hardness table
 * in `items.js` (tiers), `ClientModBody.equipForBlock()` (a regex that picked a tool *kind*),
 * and the LLM capability blackboard (which told the model mining always needs a pickaxe).
 * Live testing found the consequence: the agent told a player it could not dig dirt without
 * a pickaxe, and the tool in hand was chosen by two different regexes depending on the path.
 *
 * This module is now the single rule:
 *
 *   - **hard requirement** - blocks in `BLOCK_TIER_REQUIREMENT` (stone, ores) drop nothing
 *     below their minimum pickaxe tier. `ok:false` when the tier is not met.
 *   - **soft preference** - dirt/sand/gravel prefer a shovel, logs/planks an axe, leaves and
 *     wool shears. None of them are required: bare hands still harvest the block. When the
 *     preferred tool is in the bag it is equipped (faster, and tools take durability instead
 *     of the block silently dropping nothing for some families).
 *   - everything else needs nothing.
 *
 * Callers pass the inventory as an array of `{name, count}` stacks (the shape every Body
 * snapshot already produces). Both the tasks and the bodies use this module, so the answer
 * cannot drift between "will it try" and "what will it hold".
 */

const { requiredTierFor, harvestLevel, bare } = require('./items');

/** Tool kinds this policy understands. */
const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'shears', 'hoe'];

/**
 * Blocks an axe speeds up. Preference only - logs, planks and wooden fittings all drop
 * fine bare-handed, which is how every player starts a world.
 */
const AXE_FAMILY = /(_log|_stem|_wood|_hyphae|_planks|_fence|_fence_gate|_door|_trapdoor|_sign|_hanging_sign|_boat|_chest_boat|_button|_pressure_plate|_slab|_stairs|_carpenter|_mosaic|_board|_beam|_seat|_post|_stripped|ladder|crafting_table|bookshelf|barrel|chest|lectern|composter|bamboo|note_block|jukebox|cartography_table|fletching_table|smithing_table|loom)$/;

/**
 * Blocks a shovel speeds up. Dirt-family blocks must never be gated on a tool: digging dirt
 * with a bare hand is the first thing a player does, and refusing it was a real live bug.
 */
const SHOVEL_FAMILY = /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|farmland|dirt_path|soul_sand|soul_soil|sand|red_sand|gravel|clay|mud|muddy_mangrove_roots|moss_block|snow|snow_block|sculk|sculk_vein|.*_dirt|.*_sand|.*_gravel|.*_soil|.*_clay)$/;

/** Blocks shears are the *right* tool for (leaves keep their drops, wool survives intact). */
const SHEARS_FAMILY = /(_leaves|_wool$|^wool|carpet$|^vine$|glow_lichen$|hanging_roots$|cobweb$|^dead_bush$|^fern$|^large_fern$|^tall_grass$|^grass$|^seagrass$|^kelp$|^kelp_plant$|_vines$)/;

/** What tool kind speeds this block up, if any. Independent of tiers. */
function preferredKind(blockName) {
  const name = bare(blockName);
  if (!name) return null;
  if (requiredTierFor(name)) return 'pickaxe';
  if (AXE_FAMILY.test(name)) return 'axe';
  if (SHOVEL_FAMILY.test(name)) return 'shovel';
  if (SHEARS_FAMILY.test(name)) return 'shears';
  return null;
}

/**
 * The best carried tool of a kind, or null.
 *
 * For tiered tools (pickaxe/axe/shovel/hoe) "best" is highest harvest level first; for equal
 * levels the fastest material wins (gold > netherite > diamond > iron > stone > wood), except
 * that gold is wood-level for harvesting, so it only wins ties it is actually allowed to win.
 */
const TIER_SPEED = ['golden', 'netherite', 'diamond', 'iron', 'stone', 'wooden'];

function bestKindTool(inventoryItems, kind) {
  const items = Array.isArray(inventoryItems) ? inventoryItems : [];
  let best = null;
  for (const stack of items) {
    if (!stack || !stack.name) continue;
    const name = bare(stack.name);
    if (kind === 'shears') {
      if (name === 'shears') return { name: stack.name, tier: null, level: null };
      continue;
    }
    const match = name.match(new RegExp(`^([a-z_]+)_${kind}$`));
    if (!match) continue;
    const tier = match[1];
    if (!TIER_SPEED.includes(tier)) continue;
    const level = harvestLevel(tier);
    const speed = TIER_SPEED.indexOf(tier);
    if (
      !best ||
      level > best.level ||
      (level === best.level && speed < best.speed)
    ) {
      best = { name: stack.name, tier, level, speed };
    }
  }
  return best;
}

/**
 * The full decision for one block against one inventory.
 *
 * @param {string} blockName bare or namespaced block name
 * @param {Array<{name:string,count?:number}>} inventoryItems
 * @returns {{
 *   ok:boolean,                  // can this block be harvested (with drop) right now?
 *   kind:(string|null),          // tool kind that matters, if any
 *   required:boolean,            // true when missing/too-weak tool means no drop
 *   minTier:(string|null),       // minimum pickaxe tier for required blocks
 *   tool:({name:string,tier:(string|null)}|null),  // what to equip, if anything
 *   reason:(string|null)         // human-readable refusal when !ok
 * }}
 */
function toolPlan(blockName, inventoryItems) {
  const name = bare(blockName);
  const minTier = requiredTierFor(name);

  if (minTier) {
    const pick = bestKindTool(inventoryItems, 'pickaxe');
    if (!pick) {
      return {
        ok: false,
        kind: 'pickaxe',
        required: true,
        minTier,
        tool: null,
        reason: `need a pickaxe to mine ${name} (needs ${minTier})`
      };
    }
    if (harvestLevel(pick.tier) < harvestLevel(minTier)) {
      return {
        ok: false,
        kind: 'pickaxe',
        required: true,
        minTier,
        tool: pick,
        reason: `pickaxe too weak for ${name} (have ${pick.tier} ${pick.name.replace(/^minecraft:/, '')}, need ${minTier})`
      };
    }
    return { ok: true, kind: 'pickaxe', required: true, minTier, tool: pick, reason: null };
  }

  const kind = preferredKind(name);
  const tool = kind ? bestKindTool(inventoryItems, kind) : null;
  return { ok: true, kind, required: false, minTier: null, tool, reason: null };
}

/** Just the tool name to hold, or null when nothing should be equipped. */
function chooseTool(blockName, inventoryItems) {
  const plan = toolPlan(blockName, inventoryItems);
  return plan.tool ? plan.tool.name : null;
}

/** One-line summary for logs and capability documents. */
function describePolicy(blockName) {
  const plan = toolPlan(blockName, []);
  if (plan.required) return `${bare(blockName)}: requires ${plan.minTier} pickaxe`;
  if (plan.kind) return `${bare(blockName)}: no tool required (${plan.kind} is faster)`;
  return `${bare(blockName)}: bare hands`;
}

module.exports = {
  TOOL_KINDS,
  AXE_FAMILY,
  SHOVEL_FAMILY,
  SHEARS_FAMILY,
  TIER_SPEED,
  preferredKind,
  bestKindTool,
  toolPlan,
  chooseTool,
  describePolicy
};
