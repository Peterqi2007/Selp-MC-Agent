'use strict';

/**
 * A read-only inventory facade built from a Body snapshot.
 *
 * The decision layer already reasons about items in terms of
 * `{name, count}` plus `emptySlotCount()`. mineflayer's `bot.inventory` happens to
 * expose exactly that, which is why the original code used it directly - and why the
 * planner could not run against any other body.
 *
 * This class gives the same surface for *any* Body, so `countItem` / `countMatching` /
 * `bestTool` and the whole rule table keep working unchanged.
 *
 * Names are bare-normalised ("oak_log", not "minecraft:oak_log") because that is what
 * `src/world/items.js` knows about.
 */

class SnapshotInventory {
  /**
   * @param {Object<string,number>} items  item name -> count (namespaced or bare)
   * @param {object} [options] { emptySlots }
   */
  constructor(items = {}, options = {}) {
    this._items = [];
    for (const [rawName, rawCount] of Object.entries(items || {})) {
      const count = Number(rawCount) || 0;
      if (count <= 0) continue;
      this._items.push({ name: bare(rawName), fullName: rawName, count, type: rawName });
    }
    this._emptySlots = options.emptySlots === undefined ? null : options.emptySlots;
  }

  /** Same shape as mineflayer: [{ name, count, type }] */
  items() {
    return this._items;
  }

  emptySlotCount() {
    if (this._emptySlots !== null) return this._emptySlots;
    // Rough fallback: assume 36 slots and one slot per distinct item kind.
    return Math.max(0, 36 - this._items.length);
  }

  count(name) {
    const target = bare(name);
    return this._items.filter((i) => i.name === target).reduce((sum, i) => sum + i.count, 0);
  }

  find(predicate) {
    return this._items.find((i) => predicate(i.name, i)) || null;
  }

  filter(predicate) {
    return this._items.filter((i) => predicate(i.name, i));
  }

  has(name, count = 1) {
    return this.count(name) >= count;
  }

  toObject() {
    const out = {};
    for (const item of this._items) out[item.name] = (out[item.name] || 0) + item.count;
    return out;
  }

  get size() {
    return this._items.length;
  }
}

/**
 * Best tool of a kind from a snapshot inventory, using the same tier ranking as
 * `src/world/items.js` but without needing a minecraft-data registry.
 * @returns {{name:string, tier:string, rank:number}|null}
 */
function bestToolFromInventory(inventory, kind, tiers) {
  const order = tiers || ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
  let best = null;
  for (const item of inventory.items()) {
    for (const tier of order) {
      if (item.name === `${tier}_${kind}`) {
        const rank = order.indexOf(tier);
        if (!best || rank > best.rank) best = { name: item.name, tier, rank };
      }
    }
  }
  return best;
}

/** Strip a namespace: "minecraft:oak_log" -> "oak_log". */
function bare(name) {
  if (!name) return '';
  const idx = String(name).indexOf(':');
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

module.exports = { SnapshotInventory, bestToolFromInventory, bare };
