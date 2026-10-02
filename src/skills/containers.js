'use strict';

/**
 * Container skills: withdraw from and deposit into a chest (or barrel/shulker).
 *
 * Built on the three menu primitives the control mod now exposes - `useon` to open,
 * `menu` to read the slots, `click` to move stacks - which is exactly how a player does it.
 * The flow is verified against the protocol mock offline; live behaviour on the Forge
 * server is what the next real-machine test has to confirm.
 *
 * Both skills are marked `beta`: they work through the mod's click path, but no one has
 * moved a stack on a live server yet.
 */

const { register } = require('./registry');
const { bare } = require('../world/items');

const CONTAINER_BLOCK = /(chest|barrel|crate|shulker|drawer|cabinet|sack)/;

function menuCapable(body) {
  return !!(body && typeof body.menu === 'function' && typeof body.clickSlot === 'function');
}

/** Find a nearby container block, when the caller did not name coordinates. */
function nearestContainer(ctx, maxDistance = 8) {
  const world = ctx.world;
  if (!world || typeof world.findBlocksMatching !== 'function') return null;
  const list = world.findBlocksMatching((name) => CONTAINER_BLOCK.test(bare(name)), { maxDistance, count: 1 });
  return list && list.length ? list[0] : null;
}

/** Open a container: use explicit coordinates, or whatever chest is nearby. */
async function openContainer(ctx, params) {
  const body = ctx.body;
  const existing = await body.menu();
  if (existing && existing.open && existing.menuClass && !/InventoryMenu/.test(existing.menuClass)) {
    return { ok: true, menu: existing, opened: false };
  }
  let position = null;
  if (params.x !== undefined && params.y !== undefined && params.z !== undefined) {
    position = { x: params.x, y: params.y, z: params.z };
  } else {
    position = nearestContainer(ctx, 8);
  }
  if (!position) return { ok: false, reason: 'no container in range (pass x/y/z to name one)' };
  if (typeof body.useOn !== 'function') return { ok: false, reason: 'this body cannot open containers' };
  await body.useOn(position, { face: { x: 0, y: 1, z: 0 } });
  const menu = await body.menu();
  if (!menu || !menu.open) return { ok: false, reason: `no menu opened at ${position.x},${position.y},${position.z}` };
  if (/InventoryMenu/.test(menu.menuClass || '')) return { ok: false, reason: 'the block did not open a container menu' };
  return { ok: true, menu, opened: true, position };
}

register({
  name: 'withdraw',
  title: '从箱子取物',
  description: 'Take an item out of a nearby (or named) chest into the inventory.',
  beta: true,
  params: {
    item: { type: 'string', required: true },
    count: { type: 'number', default: 1, min: 1, max: 2304 },
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' }
  },
  available: (ctx) => (menuCapable(ctx.body) ? { ok: true } : { ok: false, reason: 'this body cannot move items through a menu' }),
  async run(ctx, params) {
    const body = ctx.body;
    const opened = await openContainer(ctx, params);
    if (!opened.ok) return opened;
    const menu = opened.menu;
    const sources = menu.slots
      .filter((slot) => slot.player === false && bare(slot.item || '') === bare(params.item) && slot.count > 0)
      .sort((a, b) => b.count - a.count);
    if (!sources.length) {
      if (opened.opened) await body.closeMenu();
      return { ok: false, reason: `the container has no ${bare(params.item)}` };
    }
    let moved = 0;
    for (const slot of sources) {
      if (moved >= params.count) break;
      await body.clickSlot(slot.i, { mode: 'quickmove' });
      moved += slot.count;
    }
    if (opened.opened) await body.closeMenu();
    return { ok: true, detail: `withdrew ${moved} ${bare(params.item)} (asked ${params.count})`, moved };
  }
});

register({
  name: 'deposit',
  title: '存物品到箱子',
  description: 'Put an item (or everything except tools) into a nearby (or named) chest.',
  beta: true,
  params: {
    item: { type: 'string' },
    keepTools: { type: 'boolean', default: true },
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' }
  },
  available: (ctx) => (menuCapable(ctx.body) ? { ok: true } : { ok: false, reason: 'this body cannot move items through a menu' }),
  async run(ctx, params) {
    const body = ctx.body;
    const opened = await openContainer(ctx, params);
    if (!opened.ok) return opened;
    const menu = opened.menu;
    const keepTools = /_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/;
    const wanted = params.item ? (name) => bare(name) === bare(params.item) : () => true;
    const sources = menu.slots.filter((slot) => {
      if (!slot.player || !slot.count) return false;
      if (!wanted(slot.item)) return false;
      if (!params.item && params.keepTools !== false && keepTools.test(bare(slot.item))) return false;
      return true;
    });
    if (!sources.length) {
      if (opened.opened) await body.closeMenu();
      return { ok: false, reason: params.item ? `${bare(params.item)} is not in the inventory` : 'nothing to deposit' };
    }
    for (const slot of sources) {
      await body.clickSlot(slot.i, { mode: 'quickmove' });
    }
    if (opened.opened) await body.closeMenu();
    return { ok: true, detail: `deposited ${sources.length} stack(s)` };
  }
});
