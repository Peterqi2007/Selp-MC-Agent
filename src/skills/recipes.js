'use strict';

/**
 * Recipe planning: "what do I put in the grid to get N of item X?"
 *
 * Pure and offline-testable on purpose. It answers three questions the crafting skill needs
 * and nothing else:
 *
 *   1. which recipe variant fits what the player is actually carrying (the 1.20.1 data has
 *      one variant per wood type, so `stick` has 12 - we pick the one whose planks are in
 *      the bag),
 *   2. the exact grid layout (column, row, item) so the click sequence is mechanical,
 *   3. what is missing when no variant is feasible.
 *
 * Recipe source: `prismarine-recipe` over `minecraft-data` (1.20.1), which is the same data
 * mineflayer uses - the mindcraft reference does exactly this. A tiny built-in table covers
 * the essentials when no registry is available (tests, offline installs).
 */

const minecraftData = require('minecraft-data');
// prismarine-recipe is a factory: recipeLib(registry).Recipe.find(itemId)
const recipeLib = require('prismarine-recipe');

const registries = new Map();

function registryFor(version = '1.20.1') {
  if (!registries.has(version)) registries.set(version, minecraftData(version));
  return registries.get(version);
}

function bare(name) {
  const text = String(name || '');
  const idx = text.indexOf(':');
  return idx === -1 ? text : text.slice(idx + 1);
}

/**
 * Built-in fallback for the survival essentials.
 *
 * Shape rows are `[row0, row1, row2]`, each an array of item names or null. Kept tiny: it
 * exists so the planner still works without a registry, not to duplicate the real data.
 */
const FALLBACK_RECIPES = {
  oak_planks: { table: false, result: 4, shape: [['oak_log']] },
  stick: { table: false, result: 4, shape: [['oak_planks'], ['oak_planks']] },
  crafting_table: { table: false, result: 1, shape: [['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks']] },
  torch: { table: false, result: 4, shape: [['coal'], ['stick']] },
  furnace: { table: true, result: 1, shape: [['cobblestone', 'cobblestone', 'cobblestone'], ['cobblestone', null, 'cobblestone'], ['cobblestone', 'cobblestone', 'cobblestone']] },
  chest: { table: true, result: 1, shape: [['oak_planks', 'oak_planks', 'oak_planks'], ['oak_planks', null, 'oak_planks'], ['oak_planks', 'oak_planks', 'oak_planks']] }
};

/** Count what the inventory holds for one ingredient, ignoring namespaces. */
function heldCount(inventory, itemName) {
  const wanted = bare(itemName);
  let total = 0;
  for (const [name, count] of Object.entries(inventory || {})) {
    if (bare(name) === wanted) total += Number(count) || 0;
  }
  return total;
}

/** Build a plan from a normalized list of ingredients + shape. */
function buildPlan({ itemName, count, resultPerCraft, table, shape, inventory }) {
  const crafts = Math.max(1, Math.ceil(count / resultPerCraft));
  const cells = [];
  const needed = new Map();
  shape.forEach((row, y) => {
    row.forEach((name, x) => {
      if (!name) return;
      cells.push({ x, y, name });
      needed.set(bare(name), (needed.get(bare(name)) || 0) + 1);
    });
  });

  const missing = [];
  for (const [name, perCraft] of needed) {
    const need = perCraft * crafts;
    const have = heldCount(inventory, name);
    if (have < need) missing.push({ name, need, have });
  }
  if (missing.length) {
    return {
      ok: false,
      item: itemName,
      table,
      crafts,
      missing,
      reason: `missing ${missing.map((m) => `${m.name} x${m.need - m.have}`).join(', ')}`
    };
  }

  const width = Math.max(...shape.map((row) => row.length), 0);
  const height = shape.length;
  return {
    ok: true,
    item: itemName,
    table,
    crafts,
    resultPerCraft,
    expected: resultPerCraft * crafts,
    shape: { width, height },
    cells,
    reason: null
  };
}

/** Plan one craft against a fixed inventory (no sub-crafting). */
function planOnce({ item, count = 1, inventory = {}, version = '1.20.1' }) {
  const itemName = bare(item);
  const wanted = Math.max(1, Math.floor(Number(count) || 1));
  const data = registryFor(version);
  const entry = data && data.itemsByName ? data.itemsByName[itemName] : null;

  if (entry) {
    let recipes = [];
    try {
      recipes = recipeLib(data).Recipe.find(entry.id) || [];
    } catch {
      recipes = [];
    }
    const candidates = [];
    for (const recipe of recipes) {
      if (!recipe || !recipe.result) continue;
      const shape = recipe.inShape
        ? recipe.inShape.map((row) =>
            row.map((cell) => (cell && cell.id >= 0 ? data.items[cell.id] && data.items[cell.id].name : null))
          )
        : // Shapeless: lay the ingredients out as a single column; the grid does not care.
          (recipe.ingredients || []).map((cell) => [cell && cell.id >= 0 ? data.items[cell.id] && data.items[cell.id].name : null]);
      const table = recipe.requiresTable === true;
      const plan = buildPlan({
        itemName,
        count: wanted,
        resultPerCraft: Math.max(1, Number(recipe.result.count) || 1),
        table,
        shape,
        inventory
      });
      candidates.push({ plan, table, cells: plan.cells ? plan.cells.length : 99 });
    }
    candidates.sort((a, b) => {
      if (a.plan.ok !== b.plan.ok) return a.plan.ok ? -1 : 1;
      if (a.plan.ok) {
        if (a.table !== b.table) return a.table ? 1 : -1; // prefer the inventory grid
        return a.cells - b.cells;
      }
      return (a.plan.missing ? a.plan.missing.length : 9) - (b.plan.missing ? b.plan.missing.length : 9);
    });
    if (candidates.length) {
      return { ...candidates[0].plan, source: 'registry' };
    }
  }

  const fallback = FALLBACK_RECIPES[itemName];
  if (fallback) {
    const plan = buildPlan({
      itemName,
      count: wanted,
      resultPerCraft: fallback.result,
      table: fallback.table,
      shape: fallback.shape,
      inventory
    });
    return { ...plan, source: 'fallback' };
  }

  return {
    ok: false,
    item: itemName,
    table: false,
    crafts: 0,
    missing: [],
    source: 'none',
    reason: `no recipe known for ${itemName}`
  };
}

/** Inventory as bare-name -> count, so simulation math cannot miss a namespace. */
function bareInventory(inventory) {
  const out = {};
  for (const [name, count] of Object.entries(inventory || {})) {
    const key = bare(name);
    out[key] = (out[key] || 0) + (Number(count) || 0);
  }
  return out;
}

/** How many of each ingredient one craft round consumes. */
function perCraftCounts(plan) {
  const out = {};
  for (const cell of plan.cells || []) {
    const key = bare(cell.name);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** Apply a complete plan (top-level grid + output) to an inventory snapshot. */
function applyPlanToSimulation(plan, baseSim) {
  if (plan.inventory) return { ...plan.inventory };
  const sim = { ...baseSim };
  for (const [name, each] of Object.entries(perCraftCounts(plan))) {
    sim[name] = (sim[name] || 0) - each * plan.crafts;
    if (sim[name] <= 0) delete sim[name];
  }
  sim[bare(plan.item)] = (sim[bare(plan.item)] || 0) + plan.expected;
  return sim;
}

/**
 * Recursive planning: satisfy missing ingredients by crafting them, depth-first.
 *
 * This is what makes `!craft wooden_pickaxe` work from raw logs: pickaxe -> sticks ->
 * planks -> logs, the same resolution mc_aiplayer's craft tool advertises ("prefer crafting
 * the target directly instead of planks and sticks as separate steps").
 *
 * @param {object} options { item, count, inventory, version, depth, visiting }
 * @returns {object} a plan; `.subcrafts` lists plans that must run first, in order
 */
function planCraft({ item, count = 1, inventory = {}, version = '1.20.1', depth = 0, visiting = new Set() }) {
  const base = bareInventory(inventory);
  const first = planOnce({ item, count, inventory: base, version });
  if (first.ok) return { ...first, inventory: applyPlanToSimulation(first, base), subcrafts: [] };
  if (depth >= 3) return first;
  if (!first.missing || !first.missing.length) return first;
  if (visiting.has(bare(item))) return first;

  let sim = { ...base };
  const subcrafts = [];
  /**
   * Iterate, because one ingredient can feed several needs.
   *
   * `wooden_pickaxe` from 2 logs needs 3 planks for the head *and* 2 planks for the sticks:
   * the first pass plans 3 planks and 4 sticks (which eat 2 of those planks), and the second
   * pass notices the shortfall and plans one more log's worth of planks. A single pass would
   * report "missing oak_planks x1" on an inventory that is actually sufficient.
   */
  for (let round = 0; round < 4; round += 1) {
    const plan = planOnce({ item, count, inventory: sim, version });
    // `planOnce` only checks feasibility; the plan's own consumption still has to be
    // applied before handing the simulation to the caller.
    if (plan.ok) return { ...plan, inventory: applyPlanToSimulation(plan, sim), subcrafts };
    if (!plan.missing || !plan.missing.length) return plan;

    let progressed = false;
    for (const miss of plan.missing) {
      const need = miss.need - miss.have;
      if (need <= 0) continue;
      const sub = planCraft({
        item: miss.name,
        count: need,
        inventory: sim,
        version,
        depth: depth + 1,
        visiting: new Set([...visiting, bare(item)])
      });
      if (!sub.ok) continue;
      /**
       * Adopt the sub-plan's *final* inventory, not just its own grid.
       *
       * A sub-plan may itself have sub-crafts (sticks need planks need logs), and the items
       * it consumes are the leaves of that chain. Its returned inventory is the simulated
       * state after the whole chain, which is exactly the state the next round must reason
       * about. Applying only `perCraftCounts(sub)` (the top-level grid) made the outer pass
       * believe it lacked planks it was about to craft itself.
       */
      sim = applyPlanToSimulation(sub, sim);
      subcrafts.push(sub);
      progressed = true;
    }
    if (!progressed) return plan;
  }
  return planOnce({ item, count, inventory: sim, version });
}

module.exports = { planCraft, planOnce, FALLBACK_RECIPES, registryFor, bare };
