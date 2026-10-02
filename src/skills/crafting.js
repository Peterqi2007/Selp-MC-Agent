'use strict';

/**
 * The `craft` skill: recipes planned offline, executed through real menu clicks.
 *
 * The split mirrors the whole architecture: `recipes.js` decides *what* to put where (pure,
 * offline-tested), this file performs it like a player would - pick up a stack, right-click
 * the grid, shift-click the result. The Java mod never learns a recipe; it only moves items.
 *
 * Grid layout comes from the vanilla menus, which is why the slot math is written down:
 *
 *   player inventory (2x2): 0 result, 1..4 grid (x + y*2), 5..8 armour, 9..44 inventory
 *   crafting table (3x3):   0 result, 1..9 grid (x + y*3), 10..45 inventory
 */

const { register } = require('./registry');
const { planCraft } = require('./recipes');
const { bare } = require('../world/items');

function menuCapable(body) {
  return !!(body && typeof body.menu === 'function' && typeof body.clickSlot === 'function');
}

function gridSlot(x, y, width) {
  return 1 + x + y * width;
}

function carriedItem(menu) {
  return menu && menu.carried && menu.carried.item && menu.carried.item !== 'null' ? menu.carried.item : null;
}

/** A player-inventory slot holding the item (never a grid/result slot). */
function findSourceSlot(menu, itemName, gridSize) {
  const wanted = bare(itemName);
  let best = null;
  for (const slot of menu.slots || []) {
    if (slot.i === 0 || (slot.i >= 1 && slot.i <= gridSize)) continue;
    if (!slot.item || slot.item === 'null') continue;
    if (bare(slot.item) !== wanted) continue;
    if (!best || slot.count > best.count) best = slot;
  }
  return best;
}

function findEmptyPlayerSlot(menu, gridSize) {
  /**
   * Inventory starts after the armour slots: 9 in the player inventory menu, 10 in the
   * crafting table menu. Treating 5..8 as free looked harmless and silently ate the stack
   * on the cursor (armour slots accept no arbitrary item), which showed up as "out of
   * oak_log" on the very next craft.
   */
  const playerStart = gridSize === 9 ? 10 : 9;
  for (const slot of menu.slots || []) {
    if (slot.i < playerStart) continue;
    if (!slot.item || slot.item === 'null') return slot;
  }
  return null;
}

function inventoryCount(menu, itemName) {
  const wanted = bare(itemName);
  let total = 0;
  for (const slot of menu.slots || []) {
    if (!slot.item || slot.item === 'null') continue;
    if (bare(slot.item) === wanted) total += slot.count;
  }
  return total;
}

/** How close the table must be to click it; how far we are willing to walk to one. */
const TABLE_REACH = 6;
const TABLE_WALK_MAX = 24;

/** Find a crafting table block near the bot, or null. */
function nearbyTable(ctx, maxDistance = TABLE_REACH) {
  const world = ctx.world;
  if (!world || typeof world.findBlocksMatching !== 'function') return null;
  const found = world.findBlocksMatching((name) => bare(name) === 'crafting_table', {
    maxDistance,
    count: 1
  });
  return found && found.length ? found[0] : null;
}

/**
 * Run one plan: sub-crafts first, then `plan.crafts` rounds of (place a set, take the output).
 *
 * @param {object} ctx
 * @param {object} plan from `planCraft`
 * @param {object} state { openedTable:boolean, gridWidth:number, gridSize:number }
 */
async function runPlan(ctx, plan, state) {
  const body = ctx.body;
  for (const sub of plan.subcrafts || []) {
    const subResult = await runPlan(ctx, sub, state);
    if (!subResult.ok) return subResult;
  }

  // ---- make sure the right grid is open ---------------------------------
  if (plan.table) {
    if (!state.openedTable) {
      let table = nearbyTable(ctx);
      if (!table) {
        /**
         * No table in reach does not mean there is none: a player would walk to the one
         * nine blocks away. Search wider, walk into reach, then re-check.
         */
        const far = nearbyTable(ctx, TABLE_WALK_MAX);
        if (far && typeof body.moveTo === 'function') {
          const walked = await body.moveTo(far.position, { range: 3, timeoutMs: 25000 }).catch(() => false);
          if (walked) table = nearbyTable(ctx) || far;
        }
      }
      if (!table) {
        return {
          ok: false,
          reason: `crafting ${plan.item} needs a crafting table, and there is none within ${TABLE_WALK_MAX} blocks`
        };
      }
      await body.useOn(table.position, { face: { x: 0, y: 1, z: 0 } });
      const menu = await body.menu();
      if (!menu || !/craft/i.test(menu.menuClass || '')) {
        return { ok: false, reason: 'the crafting table did not open a crafting menu' };
      }
      state.openedTable = true;
      state.gridWidth = 3;
      state.gridSize = 9;
    }
    if (state.gridWidth !== 3) {
      await body.closeMenu();
      const table = nearbyTable(ctx);
      if (!table) return { ok: false, reason: 'lost the crafting table' };
      await body.useOn(table.position, { face: { x: 0, y: 1, z: 0 } });
      state.gridWidth = 3;
      state.gridSize = 9;
      state.openedTable = true;
    }
  } else if (state.gridWidth !== 2) {
    if (state.openedTable) {
      await body.closeMenu();
      state.openedTable = false;
    }
  }
  const gridWidth = plan.table ? 3 : 2;
  const gridSize = gridWidth * gridWidth;
  state.gridWidth = gridWidth;
  state.gridSize = gridSize;

  // ---- craft the planned rounds -----------------------------------------
  const beforeMenu = await body.menu();
  if (!beforeMenu || !beforeMenu.open) return { ok: false, reason: 'no menu available for crafting' };
  const beforeCount = inventoryCount(beforeMenu, plan.item);

  for (let round = 0; round < plan.crafts; round += 1) {
    for (const cell of plan.cells) {
      let menu = await body.menu();
      if (!menu || !menu.open) return { ok: false, reason: 'the crafting menu closed unexpectedly' };
      if (carriedItem(menu) !== cell.name) {
        // Put back whatever we are holding before grabbing the right stack.
        if (carriedItem(menu)) {
          const spare = findEmptyPlayerSlot(menu, gridSize);
          if (spare) await body.clickSlot(spare.i, { mode: 'pickup' });
          menu = await body.menu();
        }
        const source = findSourceSlot(menu, cell.name, gridSize);
        if (!source) {
          return { ok: false, reason: `out of ${bare(cell.name)} while crafting ${plan.item}` };
        }
        await body.clickSlot(source.i, { mode: 'pickup', button: 0 });
      }
      await body.clickSlot(gridSlot(cell.x, cell.y, gridWidth), { mode: 'pickup', button: 1 });
    }

    // Return leftovers so the result slot is reachable and the cursor is empty.
    let menu = await body.menu();
    if (carriedItem(menu)) {
      const spare = findEmptyPlayerSlot(menu, gridSize);
      if (spare) await body.clickSlot(spare.i, { mode: 'pickup' });
    }
    // Shift-click the result: crafts the set and moves the output to the inventory.
    await body.clickSlot(0, { mode: 'quickmove' });
  }

  const afterMenu = await body.menu();
  const afterCount = inventoryCount(afterMenu, plan.item);
  const gained = afterCount - beforeCount;
  if (gained <= 0) {
    return { ok: false, reason: `the crafting clicks ran but no ${plan.item} appeared (grid recipe may not match)` };
  }
  return { ok: true, produced: gained };
}

register({
  name: 'craft',
  title: '合成',
  description: 'Craft an item from the inventory, resolving planks/sticks recursively; uses a nearby crafting table when the recipe needs 3x3.',
  params: {
    item: { type: 'string', required: true },
    count: { type: 'number', default: 1, min: 1, max: 64 }
  },
  available: (ctx) => (menuCapable(ctx.body)
    ? { ok: true }
    : ctx.body && ctx.body.supportsCrafting
      ? { ok: true }
      : { ok: false, reason: 'this body cannot craft (needs a menu API or its own recipe database)' }),
  async run(ctx, params) {
    // Bodies with their own crafting implementation (mineflayer) take that path; the client
    // mod has no recipe knowledge, so it goes through the grid clicks below.
    if (!menuCapable(ctx.body) && ctx.body && typeof ctx.body.craft === 'function' && ctx.body.supportsCrafting) {
      const byBody = await ctx.body.craft(params.item, params.count).catch((err) => ({ ok: false, reason: err.message }));
      return byBody && byBody.ok
        ? { ok: true, produced: byBody.produced || params.count, detail: `crafted ${params.item} via the body` }
        : { ok: false, reason: (byBody && byBody.reason) || 'the body could not craft that' };
    }
    // Fresh snapshot: the plan must see what the bag actually holds right now, and the table
    // search must see the current block scan (a stale snapshot is how "no crafting table"
    // appeared next to a crafting table).
    if (ctx.body && typeof ctx.body.refresh === 'function') {
      await ctx.body.refresh(true).catch(() => null);
    }
    const snap = ctx.body && typeof ctx.body.snapshot === 'function' ? ctx.body.snapshot() : null;
    const inventory = (snap && snap.inventory) || {};
    const plan = planCraft({ item: params.item, count: params.count, inventory });
    if (!plan.ok) {
      return { ok: false, reason: plan.reason || `cannot craft ${params.item}` };
    }
    const state = { openedTable: false, gridWidth: 0, gridSize: 0 };
    const result = await runPlan(ctx, plan, state);
    if (state.openedTable) await ctx.body.closeMenu().catch(() => false);
    if (!result.ok) return result;
    const subCount = (plan.subcrafts || []).length;
    return {
      ok: true,
      produced: result.produced,
      detail:
        `crafted ${result.produced}x ${bare(plan.item)}` +
        (subCount ? ` (${subCount} intermediate craft(s))` : '')
    };
  }
});

module.exports = { gridSlot, findSourceSlot };
