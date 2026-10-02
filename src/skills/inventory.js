'use strict';

/**
 * Inventory skills: equip, eat, drop, armour.
 *
 * These are the operations every player does constantly and the P0 agent did not have:
 * swap the tool in hand, eat when hurt, throw something away, put armour on. All of them
 * are body-agnostic - the body decides how a hotbar is selected (the client mod moves the
 * selected slot; mineflayer equips an item).
 */

const { register } = require('./registry');
const { foodScore, bare } = require('../world/items');

function snapshotOf(ctx) {
  if (ctx.body && typeof ctx.body.snapshot === 'function') return ctx.body.snapshot();
  if (ctx.world && typeof ctx.world.snapshot === 'function') return ctx.world.snapshot(true);
  return null;
}

register({
  name: 'equip',
  title: '手持/切换物品',
  description: 'Put an item from the inventory into the hand (tool, block, food, bucket).',
  params: { item: { type: 'string', required: true } },
  available: (ctx) => (ctx.body && typeof ctx.body.equip === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot select items' }),
  async run(ctx, { item }) {
    const snap = snapshotOf(ctx);
    const inventory = (snap && snap.inventory) || {};
    const found = Object.keys(inventory).find((name) => bare(name) === bare(item));
    if (!found) return { ok: false, reason: `${bare(item)} is not in the inventory` };
    const ok = await ctx.body.equip(found);
    return ok ? { ok: true, detail: `holding ${bare(found)}` } : { ok: false, reason: `could not select ${bare(item)}` };
  }
});

register({
  name: 'eat',
  title: '吃东西',
  description: 'Eat the best food carried, or a named food item.',
  params: { food: { type: 'string' } },
  available: (ctx) => {
    const body = ctx.body;
    if (!body) return { ok: false, reason: 'no body' };
    if (typeof body.consume === 'function' || typeof body.eat === 'function') return { ok: true };
    return { ok: false, reason: 'this body cannot eat' };
  },
  async run(ctx, { food }) {
    const snap = snapshotOf(ctx);
    const inventory = (snap && snap.inventory) || {};
    let chosen = null;
    if (food) {
      chosen = Object.keys(inventory).find((name) => bare(name) === bare(food)) || null;
      if (!chosen) return { ok: false, reason: `${bare(food)} is not in the inventory` };
    } else {
      let best = -1;
      for (const [name, count] of Object.entries(inventory)) {
        if (!count) continue;
        // foodScore() works on bare names; inventory keys are namespaced.
        const score = foodScore(bare(name));
        if (score > best) {
          best = score;
          chosen = name;
        }
      }
      if (!chosen || best <= 0) return { ok: false, reason: 'nothing edible in the inventory' };
    }
    const eater = typeof ctx.body.consume === 'function' ? ctx.body.consume : ctx.body.eat;
    const ok = await eater.call(ctx.body, chosen);
    return ok ? { ok: true, detail: `ate ${bare(chosen)}` } : { ok: false, reason: `could not eat ${bare(chosen)}` };
  }
});

register({
  name: 'drop',
  title: '丢弃物品',
  description: 'Drop items from the inventory (one, or the whole stack).',
  params: {
    item: { type: 'string', required: true },
    count: { type: 'number', default: 1, min: 1, max: 2304 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.dropItem === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot drop items' }),
  async run(ctx, { item, count }) {
    const ok = await ctx.body.dropItem(item, count);
    return ok ? { ok: true, detail: `dropped up to ${count}x ${bare(item)}` } : { ok: false, reason: `could not drop ${bare(item)}` };
  }
});

register({
  name: 'armor',
  title: '穿装备',
  description: 'Equip the best armour pieces carried (quick-move into the armour slots).',
  params: {},
  available: (ctx) => {
    const body = ctx.body || {};
    if (typeof body.menu === 'function' && typeof body.clickSlot === 'function') return { ok: true };
    if (typeof body.equipArmor === 'function') return { ok: true };
    return { ok: false, reason: 'this body cannot equip armour' };
  },
  async run(ctx) {
    const body = ctx.body;
    /**
     * Preferred path: the menu click route, which is how a player does it.
     *
     * Shift-clicking an armour item in the inventory makes vanilla move it into its armour
     * slot, so the skill is "find every piece, quick-move it, then read back slots 5-8".
     * Slots 5..8 in the player inventory menu are helmet/chest/legs/boots.
     */
    if (typeof body.menu === 'function' && typeof body.clickSlot === 'function') {
      const menu = await body.menu();
      if (!menu || !Array.isArray(menu.slots)) {
        if (typeof body.equipArmor === 'function' && (await body.equipArmor())) {
          return { ok: true, detail: 'equipped armour through the body API' };
        }
        return { ok: false, reason: 'no inventory menu available' };
      }
      const pieces = menu.slots.filter(
        (slot) => slot.player && /_(helmet|chestplate|leggings|boots)$/.test(slot.item || '')
      );
      if (!pieces.length) return { ok: false, reason: 'no armour pieces in the inventory' };
      for (const piece of pieces) {
        await body.clickSlot(piece.i, { mode: 'quickmove' });
      }
      const after = await body.menu();
      const worn = (after && after.slots ? after.slots : []).filter(
        (slot) => slot.i >= 5 && slot.i <= 8 && slot.item && slot.item !== 'null'
      );
      return worn.length
        ? { ok: true, detail: `wore ${worn.map((s) => bare(s.item)).join(', ')}` }
        : { ok: false, reason: 'the quick-move did not land in the armour slots' };
    }
    const ok = await body.equipArmor();
    return ok ? { ok: true, detail: 'equipped armour' } : { ok: false, reason: 'equipping armour failed' };
  }
});
