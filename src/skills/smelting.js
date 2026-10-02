'use strict';

/**
 * The `smelt` skill: put ore/food into a furnace and take the product out.
 *
 * Furnace menus are the simplest of the three containers (0 input, 1 fuel, 2 output, then
 * the player inventory), so the whole flow is: open the furnace, shift-click the input and
 * the fuel in (vanilla puts each stack in the right slot), wait for the output, shift-click
 * it out. The server does the smelting; this file only moves items and polls.
 */

const { register } = require('./registry');
const { bare, isFuel } = require('../world/items');
const { sleep } = require('../core/movement');

/** input item -> what the furnace turns it into. The common survival cases. */
const SMELT_YIELDS = {
  raw_iron: 'iron_ingot',
  raw_gold: 'gold_ingot',
  raw_copper: 'copper_ingot',
  iron_ore: 'iron_ingot',
  deepslate_iron_ore: 'iron_ingot',
  gold_ore: 'gold_ingot',
  deepslate_gold_ore: 'gold_ingot',
  copper_ore: 'copper_ingot',
  deepslate_copper_ore: 'copper_ingot',
  sand: 'glass',
  red_sand: 'glass',
  cobblestone: 'stone',
  stone: 'smooth_stone',
  clay_ball: 'brick',
  clay: 'terracotta',
  porkchop: 'cooked_porkchop',
  beef: 'steak',
  chicken: 'cooked_chicken',
  mutton: 'cooked_mutton',
  cod: 'cooked_cod',
  salmon: 'cooked_salmon',
  potato: 'baked_potato',
  kelp: 'dried_kelp',
  netherrack: 'nether_brick'
};

function menuCapable(body) {
  return !!(body && typeof body.menu === 'function' && typeof body.clickSlot === 'function');
}

function slotByName(menu, itemName, minIndex = 3) {
  const wanted = bare(itemName);
  for (const slot of menu.slots || []) {
    if (slot.i < minIndex) continue;
    if (!slot.item || slot.item === 'null') continue;
    if (bare(slot.item) === wanted) return slot;
  }
  return null;
}

function slotCount(menu, itemName, minIndex = 0) {
  const wanted = bare(itemName);
  let total = 0;
  for (const slot of menu.slots || []) {
    if (slot.i < minIndex || !slot.item || slot.item === 'null') continue;
    if (bare(slot.item) === wanted) total += slot.count;
  }
  return total;
}

function findFuelSlot(menu) {
  for (const slot of menu.slots || []) {
    if (slot.i < 3 || !slot.item || slot.item === 'null') continue;
    if (isFuel(bare(slot.item))) return slot;
  }
  return null;
}

function nearbyFurnace(ctx) {
  const world = ctx.world;
  if (!world || typeof world.findBlocksMatching !== 'function') return null;
  const found = world.findBlocksMatching((name) => /(^|_)furnace$/.test(bare(name)), { maxDistance: 6, count: 1 });
  return found && found.length ? found[0] : null;
}

register({
  name: 'smelt',
  title: '熔炼',
  description: 'Smelt ore/food in a nearby furnace: load input and fuel, wait, take the product.',
  params: {
    item: { type: 'string', required: true },
    count: { type: 'number', default: 1, min: 1, max: 64 },
    timeoutMs: { type: 'number', default: 90000, min: 5000, max: 600000 }
  },
  available: (ctx) => (menuCapable(ctx.body)
    ? { ok: true }
    : { ok: false, reason: 'this body cannot move items through a menu (smelting needs one)' }),
  async run(ctx, params) {
    const body = ctx.body;
    if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
    const inputName = bare(params.item);
    const outputName = SMELT_YIELDS[inputName];
    if (!outputName) {
      return { ok: false, reason: `I do not know what ${inputName} smelts into` };
    }

    const furnace = nearbyFurnace(ctx);
    if (!furnace) {
      return { ok: false, reason: 'no furnace within 6 blocks' };
    }
    await body.useOn(furnace.position, { face: { x: 0, y: 1, z: 0 } });

    let menu = await body.menu();
    if (!menu || !/furnace/i.test(menu.menuClass || '')) {
      return { ok: false, reason: 'the furnace did not open a furnace menu' };
    }

    // Count only the player's slots (>=3): the furnace's own output slot must not be
    // reported as "smelted" until it has actually been taken out.
    const before = slotCount(menu, outputName, 3);
    const inputSlot = menu.slots.find((slot) => slot.i === 0);
    if (!inputSlot || (inputSlot.item && inputSlot.item !== 'null')) {
      return { ok: false, reason: 'the furnace input slot is not empty' };
    }
    const source = slotByName(menu, inputName);
    if (!source) return { ok: false, reason: `no ${inputName} in the inventory` };
    await body.clickSlot(source.i, { mode: 'quickmove' });

    // Fuel: only load when the furnace does not already have some.
    menu = await body.menu();
    const fuelSlot = menu.slots.find((slot) => slot.i === 1);
    if (fuelSlot && (!fuelSlot.item || fuelSlot.item === 'null')) {
      const fuel = findFuelSlot(menu);
      if (fuel) await body.clickSlot(fuel.i, { mode: 'quickmove' });
    }

    // Wait for the product. Vanilla takes ~10s per item; the timeout is the caller's.
    const deadline = Date.now() + params.timeoutMs;
    let produced = 0;
    while (Date.now() < deadline) {
      await sleep(1000);
      menu = await body.menu();
      if (!menu || !menu.open) break;
      const outputSlot = menu.slots.find((slot) => slot.i === 2);
      if (outputSlot && outputSlot.item && outputSlot.item !== 'null') {
        await body.clickSlot(2, { mode: 'quickmove' });
        menu = await body.menu();
        produced = slotCount(menu, outputName, 3) - before;
        if (produced >= params.count) break;
      }
    }

    const afterMenu = await body.menu();
    const total = slotCount(afterMenu, outputName, 3) - before;
    await body.closeMenu().catch(() => false);
    if (total <= 0) {
      return { ok: false, reason: `no ${outputName} came out of the furnace (out of fuel or input?)` };
    }
    return { ok: true, produced: total, detail: `smelted ${total}x ${outputName}` };
  }
});

module.exports = { SMELT_YIELDS };
