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
const { foodScore, isFood, bare } = require('../world/items');

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
    /**
     * The client mod reports the real FoodProperties of every installed item; the
     * mineflayer registry is the equivalent source on that body. Without either, the
     * vanilla table + the Farmer's Delight fallback patterns are still consulted.
     */
    const foods = snap && snap.foods && typeof snap.foods === 'object' ? snap.foods : null;
    const registry = ctx.bot && ctx.bot.registry ? ctx.bot.registry : null;
    let chosen = null;
    if (food) {
      chosen = Object.keys(inventory).find((name) => bare(name) === bare(food)) || null;
      if (!chosen) return { ok: false, reason: `${bare(food)} is not in the inventory` };
      if (!isFood(chosen, registry, foods)) return { ok: false, reason: `${bare(food)} is not edible` };
    } else {
      let best = -1;
      for (const [name, count] of Object.entries(inventory)) {
        if (!count) continue;
        if (!isFood(name, registry, foods)) continue;
        const score = foodScore(name, foods);
        if (score > best) {
          best = score;
          chosen = name;
        }
      }
      if (!chosen || best <= 0) return { ok: false, reason: 'nothing edible in the inventory' };
    }
    /**
     * Remember what was in the hand and put it back after the meal.
     *
     * Eating equips the food and the old version left it there: live 2026-10-13 a
     * mid-fight auto-eat swapped the sword for bread, the mod's 15s swing loop kept
     * punching with the bread, a zombie survived three full attack timeouts, and the
     * user watched the bot "never switch to the sword" - they had to do it by hand.
     * A meal must not disarm a fight.
     */
    const heldBefore = snap && snap.heldItem ? snap.heldItem : null;
    const eater = typeof ctx.body.consume === 'function' ? ctx.body.consume : ctx.body.eat;
    const ok = await eater.call(ctx.body, chosen);
    if (ok && heldBefore && bare(heldBefore) !== bare(chosen) && typeof ctx.body.equip === 'function') {
      await ctx.body.equip(heldBefore).catch(() => false);
    }
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
     * Shift-clicking a CARRIED armour item makes vanilla move it into its armour slot.
     * The worn slots themselves (5..8) are also player-owned slots, so they must never
     * be quick-moved: live 2026-10-13 the reflex ran this skill every 30s against an
     * already-dressed bot, every run shifted the worn pieces back into the bag, and the
     * armour visibly toggled on and off. Only bag slots (>= 9) are candidates, and a
     * candidate must fill an empty slot or beat what is worn - shifting a worse piece
     * would swap the good one out.
     */
    if (typeof body.menu === 'function' && typeof body.clickSlot === 'function') {
      const ARMOR_SLOT = { helmet: 5, chestplate: 6, leggings: 7, boots: 8 };
      const ARMOR_RANK = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite'];
      const kindOf = (item) => bare(item).split('_').pop();
      const rankOf = (item) => ARMOR_RANK.indexOf(bare(item).replace(/_(helmet|chestplate|leggings|boots)$/, ''));
      let changedAny = false;
      /** A click that the server drops must not turn into a spray at the same slot. */
      const attempted = new Set();
      for (let guard = 0; guard < 8; guard += 1) {
        const menu = await body.menu();
        if (!menu || !Array.isArray(menu.slots)) {
          if (!changedAny && typeof body.equipArmor === 'function' && (await body.equipArmor())) {
            return { ok: true, detail: 'equipped armour through the body API' };
          }
          if (!changedAny) return { ok: false, reason: 'no inventory menu available' };
          break;
        }
        const carried = menu.slots.filter(
          (slot) => slot.player && slot.i >= 9 && /_(helmet|chestplate|leggings|boots)$/.test(slot.item || '')
        );
        const pick = carried.find((piece) => {
          if (attempted.has(piece.i)) return false;
          const worn = menu.slots.find((s) => s.i === ARMOR_SLOT[kindOf(piece.item)]);
          const wornName = worn && worn.item && worn.item !== 'null' ? worn.item : null;
          return !wornName || rankOf(piece.item) > rankOf(wornName);
        });
        if (!pick) break;
        attempted.add(pick.i);
        await body.clickSlot(pick.i, { mode: 'quickmove' });
        changedAny = true;
      }
      const after = await body.menu();
      const worn = (after && after.slots ? after.slots : []).filter(
        (slot) => slot.i >= 5 && slot.i <= 8 && slot.item && slot.item !== 'null'
      );
      if (worn.length) return { ok: true, detail: `wore ${worn.map((s) => bare(s.item)).join(', ')}` };
      return {
        ok: false,
        reason: changedAny ? 'the quick-move did not land in the armour slots' : 'no armour pieces in the inventory'
      };
    }
    const ok = await body.equipArmor();
    return ok ? { ok: true, detail: 'equipped armour' } : { ok: false, reason: 'equipping armour failed' };
  }
});
