'use strict';

/**
 * MineflayerBody: the existing headless implementation of the Body contract.
 *
 * This adapter deliberately wraps the *current* code (`BotController`, `Navigator`,
 * `WorldView`, `Combat`, `AutoEat`, `ToolManager`) instead of replacing it, so the
 * behaviour that already works - pathfinder latch recovery, empty-path detection,
 * physical rescue, serialized task execution - is preserved untouched while the
 * decision layer gains a body-agnostic seam.
 */

const { Body, BodyUnavailableError } = require('./body');
const { isLog, bestTool } = require('../world/items');

class MineflayerBody extends Body {
  /**
   * @param {object} cfg
   * @param {object} deps { controller, world, nav, combat, eat, tools, log }
   */
  constructor(cfg, deps) {
    super(cfg);
    this.kind = 'mineflayer';
    this.controller = deps.controller;
    this.world = deps.world;
    this.nav = deps.nav;
    this.combat = deps.combat;
    /** The AutoEat system. Kept under a non-colliding name - see consume(). */
    this.eatSystem = deps.eat;
    this.tools = deps.tools;
    this.log = deps.log;
    /** Escape hatch for code that genuinely needs mineflayer (kept small on purpose). */
    this.raw = deps.controller;
  }

  get bot() {
    return this.controller.bot;
  }

  get isReady() {
    return this.controller.isAlive && !!this.bot;
  }

  async connect() {
    this.controller.connect();
  }

  async disconnect() {
    this.controller.shutdown();
  }

  // ------------------------------------------------------------ perception

  snapshot() {
    const bot = this.bot;
    if (!bot || !bot.entity) return null;
    const pos = bot.entity.position;
    const inv = {};
    for (const item of bot.inventory.items()) inv[item.name] = (inv[item.name] || 0) + item.count;

    return {
      ready: true,
      body: this.kind,
      position: { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2) },
      dimension: (bot.game && bot.game.dimension) || 'minecraft:overworld',
      health: bot.health,
      food: bot.food,
      onGround: !!bot.entity.onGround,
      time: {
        isDay: !this.world.isNight(),
        timeOfDay: this.world.timeOfDay(),
        day: this.world.day()
      },
      weather: { raining: !!bot.isRaining, thundering: !!bot.thunderState },
      inventory: inv,
      emptySlots: bot.inventory.emptySlotCount(),
      heldItem: bot.heldItem ? bot.heldItem.name : null,
      standingOn: this._blockRef(bot.blockAt(pos.offset(0, -1, 0))),
      lightLevel: this.world.lightLevel(),
      hostiles: this.hostiles(16),
      nearbyItems: this.itemDrops(8),
      players: Object.keys(bot.players || {})
    };
  }

  blockAt(position) {
    const bot = this.bot;
    if (!bot || !bot.entity) return null;
    return this._blockRef(bot.blockAt(vecLike(position)));
  }

  findBlocks(names, options = {}) {
    const set = new Set(names.map(normalizeName));
    return this.findBlocksMatching((name) => set.has(normalizeName(name)), options);
  }

  findBlocksMatching(predicate, options = {}) {
    const bot = this.bot;
    if (!bot || !bot.entity) return [];
    const maxDistance = options.maxDistance || 32;
    const count = options.count || 32;
    const found = bot.findBlocks({ matching: (b) => predicate(b.name), maxDistance, count }) || [];
    const here = bot.entity.position;
    return found
      .map((p) => ({ position: { x: p.x, y: p.y, z: p.z }, name: null, _vec: p }))
      .map((entry) => {
        const block = bot.blockAt(entry._vec);
        delete entry._vec;
        entry.name = block ? block.name : null;
        entry.distance = +here.distanceTo(vecLike(entry.position)).toFixed(2);
        return entry;
      })
      .filter((entry) => entry.name)
      .sort((a, b) => a.distance - b.distance);
  }

  /** Convenience used by the wood task: nearest log of any species. */
  findLogs(maxDistance = 48, count = 8) {
    return this.findBlocksMatching((name) => isLog(name), { maxDistance, count });
  }

  hostiles(maxDistance = 16) {
    const bot = this.bot;
    if (!bot || !bot.entity) return [];
    const here = bot.entity.position;
    const out = [];
    for (const entity of Object.values(bot.entities || {})) {
      if (!entity || !entity.position || entity === bot.entity) continue;
      const kind = entity.kind || (entity.type === 'mob' ? 'Hostile mobs' : entity.type);
      if (kind !== 'Hostile mobs') continue;
      const distance = entity.position.distanceTo(here);
      if (distance > maxDistance) continue;
      out.push({
        id: entity.id,
        name: entity.name,
        position: { x: +entity.position.x.toFixed(2), y: +entity.position.y.toFixed(2), z: +entity.position.z.toFixed(2) },
        distance: +distance.toFixed(2),
        kind: 'hostile',
        _entity: entity
      });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  itemDrops(maxDistance = 8) {
    const bot = this.bot;
    if (!bot || !bot.entity) return [];
    const here = bot.entity.position;
    return Object.values(bot.entities || {})
      .filter((e) => e && e.name === 'item' && e.position && e.position.distanceTo(here) <= maxDistance)
      .map((e) => ({
        id: e.id,
        name: 'item',
        position: { x: +e.position.x.toFixed(2), y: +e.position.y.toFixed(2), z: +e.position.z.toFixed(2) },
        distance: +e.position.distanceTo(here).toFixed(2),
        kind: 'item',
        _entity: e
      }))
      .sort((a, b) => a.distance - b.distance);
  }

  // ---------------------------------------------------------------- action

  async moveTo(position, options = {}) {
    if (!this.isReady) throw new BodyUnavailableError('bot is not spawned');
    return this.nav.goto(vecLike(position), { range: options.range, timeoutMs: options.timeoutMs });
  }

  async dig(block, options = {}) {
    if (!this.isReady) throw new BodyUnavailableError('bot is not spawned');
    const bot = this.bot;
    const target = bot.blockAt(vecLike(block.position));
    if (!target) return false;
    if (options.equip !== false) {
      await this.tools.equipForBlock(target).catch(() => {});
    }
    const { digBlock } = require('../core/movement');
    return digBlock(this.controller, target, { log: this.log, timeoutMs: options.timeoutMs });
  }

  async place(itemName, referenceBlock, faceVector) {
    if (!this.isReady) throw new BodyUnavailableError('bot is not spawned');
    const bot = this.bot;
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) return false;
    const reference = bot.blockAt(vecLike(referenceBlock.position || referenceBlock));
    if (!reference) return false;
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(reference, faceVector);
      return true;
    } catch (err) {
      this.log && this.log.debug && this.log.debug(`place ${itemName} failed: ${err.message}`);
      return false;
    }
  }

  async equip(itemName) {
    if (!this.isReady) return false;
    return this.tools.equipByName(itemName);
  }

  /** Equip the best tool for a block (mineflayer-tool aware). */
  async equipForBlock(block) {
    if (!this.isReady) return false;
    const bot = this.bot;
    const target = bot.blockAt(vecLike(block.position));
    if (!target) return false;
    return this.tools.equipForBlock(target);
  }

  async equipBest(kind) {
    const bot = this.bot;
    if (!bot) return false;
    const best = bestTool(bot, kind);
    return best ? this.equip(best.name) : false;
  }

  async equipArmor() {
    return this.tools.equipArmor();
  }

  /**
   * Eat something.
   *
   * NOTE the name: `consume`, not `eat`. The AutoEat *system* is stored on
   * `this.eat`, and an instance property shadows a prototype method — so a method
   * called `eat` here would be invisible on the instance. (Found the hard way.)
   */
  async consume(itemName) {
    if (!this.isReady) return false;
    if (itemName) return this._eatSpecific(itemName);
    return this.eatSystem.tick(true);
  }

  async _eatSpecific(itemName) {
    const bot = this.bot;
    const item = bot.inventory.items().find((i) => i.name === itemName);
    if (!item) return false;
    try {
      await bot.equip(item, 'hand');
      await bot.consume();
      return true;
    } catch {
      return false;
    }
  }

  async attack(entity, options = {}) {
    if (!this.isReady) throw new BodyUnavailableError('bot is not spawned');
    const target = entity && entity._entity ? entity._entity : entity;
    if (!target) return false;
    return this.combat.attack(target, options);
  }

  async chat(message) {
    if (!this.isReady) throw new BodyUnavailableError('bot is not spawned');
    this.bot.chat(message);
    return true;
  }

  async lookAt(position) {
    if (!this.isReady) return false;
    try {
      await this.bot.lookAt(vecLike(position), true);
      return true;
    } catch {
      return false;
    }
  }

  interrupt(reason) {
    if (this.nav && this.nav.interrupt) this.nav.interrupt(reason || 'body interrupt');
  }

  // -------------------------------------------------------- optional: crafting

  get supportsCrafting() {
    return true;
  }

  /**
   * mineflayer can open containers, so the stash goal is legitimate here.
   *
   * The client-mod body cannot (the mod exposes no container API yet), which is why this is
   * a capability rather than an assumption: the planner skips the deposit goal on bodies that
   * would only fail it, instead of retrying and quarantining on every tick.
   */
  get supportsDeposit() {
    return true;
  }

  /** mineflayer sees the whole entity list, so hunting is possible. */
  get supportsHunting() {
    return true;
  }

  /**
   * Craft via mineflayer, resolving the awkward parts that only make sense here:
   *
   *  - `Recipe.find()` lists *every* wood variant (oak first), while `recipesFor()`
   *    only matches planks we actually hold - so a bot with spruce logs looks like it
   *    "has no recipe" for a wooden pickaxe.
   *  - 3x3 recipes need a crafting table, and `craft()` silently produces nothing if
   *    the table is not actually reachable/openable.
   *
   * The decision layer only asks "craft N of X"; all of the above lives in the body.
   *
   * @returns {Promise<{ok:boolean, produced?:number, reason?:string}>}
   */
  async craft(itemName, count = 1) {
    if (!this.isReady) return { ok: false, reason: 'bot is not spawned' };
    const bot = this.bot;
    const { CraftTask } = require('../tasks/craft'); // body-agnostic; used for plumbing
    const items = require('../world/items');
    const before = items.countItem(bot, bareName(itemName));

    const item = bot.registry.itemsByName[bareName(itemName)];
    if (!item) return { ok: false, reason: `unknown item ${itemName}` };

    // Prefer an inventory-grid recipe, then a reachable table, then a table we carry.
    let recipe = pickRecipe(bot, item.id, null);
    let table = null;
    if (!recipe) {
      const nearbyTable = bot.findBlock({
        matching: (b) => b.name === 'crafting_table',
        maxDistance: 48
      });
      if (nearbyTable) {
        const ok = await this.moveTo(nearbyTable.position, { range: 2, timeoutMs: 20000 }).catch(() => false);
        const fresh = bot.blockAt(nearbyTable.position);
        if (ok && fresh && fresh.name === 'crafting_table' && bot.entity.position.distanceTo(fresh.position) <= 4) {
          table = fresh;
          recipe = pickRecipe(bot, item.id, table);
        }
      }
    }
    if (!recipe) {
      recipe = pickRecipe(bot, item.id, true);
      if (recipe && !table) {
        // Need a table: use one we already carry, or make one.
        if (items.countItem(bot, 'crafting_table') === 0) {
          const made = await this._craftSimple('crafting_table', 1);
          if (!made.ok) {
            return { ok: false, reason: `needs a crafting table and could not make one (${made.reason})` };
          }
        }
        table = await this._placeCraftingTable();
      }
    }
    if (!recipe) return { ok: false, reason: 'no recipe available (missing materials?)' };

    const perCraft = recipe.result ? recipe.result.count : 1;
    let ops = Math.max(1, Math.ceil((count - (items.countItem(bot, bareName(itemName)) - before)) / Math.max(1, perCraft)));

    try {
      await bot.craft(recipe, ops, table || undefined);
    } catch (err) {
      if (table) {
        await new Promise((r) => setTimeout(r, 400));
        await bot.craft(recipe, 1, table).catch(() => {});
      } else {
        return { ok: false, reason: err.message };
      }
    }

    let produced = items.countItem(bot, bareName(itemName)) - before;
    // A 3x3 recipe quietly produces nothing when no table window opened: place one and
    // retry once, which is the fix in practice.
    if (produced <= 0 && recipe.requiresTable) {
      const placed = table || (await this._placeCraftingTable());
      if (placed) {
        try {
          await bot.craft(recipe, Math.max(1, count - produced), placed);
        } catch (err) {
          this.log && this.log.debug && this.log.debug(`craft at table failed: ${err.message}`);
        }
        produced = items.countItem(bot, bareName(itemName)) - before;
      }
    }

    if (produced <= 0) {
      return {
        ok: false,
        reason: `craft produced nothing (held: ${items
          .inventorySummary(bot)
          ? Object.entries(items.inventorySummary(bot)).map(([n, c]) => `${n}x${c}`).join(',')
          : 'empty'}; requiresTable=${!!recipe.requiresTable})`
      };
    }
    this.log && this.log.info && this.log.info(`crafted ${produced}x ${bareName(itemName)}`);
    return { ok: true, produced };
  }

  /** Craft something that works in the 2x2 grid (used to bootstrap a table). */
  async _craftSimple(itemName, count) {
    const bot = this.bot;
    const item = bot.registry.itemsByName[bareName(itemName)];
    if (!item) return { ok: false, reason: `unknown item ${itemName}` };
    const recipe = pickRecipe(bot, item.id, null);
    if (!recipe) return { ok: false, reason: `no inventory recipe for ${itemName}` };
    try {
      await bot.craft(recipe, count, undefined);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  }

  /** Put a crafting table on the ground next to the bot. */
  async _placeCraftingTable() {
    const bot = this.bot;
    const item = bot.inventory.items().find((i) => i.name === 'crafting_table');
    if (!item) return null;
    const base = bot.entity.position.floored();
    const candidates = [
      base.offset(1, 0, 0),
      base.offset(-1, 0, 0),
      base.offset(0, 0, 1),
      base.offset(0, 0, -1)
    ];
    for (const target of candidates) {
      const ground = bot.blockAt(target.offset(0, -1, 0));
      const here = bot.blockAt(target);
      if (!ground || !here) continue;
      if (ground.name === 'air' || ground.name === 'water' || ground.name === 'lava') continue;
      if (here.name !== 'air' && here.name !== 'grass' && here.name !== 'tall_grass') continue;
      try {
        await bot.equip(item, 'hand');
        await bot.placeBlock(ground, { x: 0, y: 1, z: 0 });
        const placed = bot.blockAt(target);
        if (placed && placed.name === 'crafting_table') {
          this.log && this.log.info && this.log.info('placed a crafting table');
          return placed;
        }
      } catch (err) {
        this.log && this.log.debug && this.log.debug(`place table failed: ${err.message}`);
      }
    }
    return null;
  }

  describe() {
    return {
      kind: this.kind,
      ready: this.isReady,
      plugins: this.controller.loadedPlugins,
      position: this.bot && this.bot.entity ? this.bot.entity.position.floored() : null
    };
  }

  // ---------------------------------------------------------------- helpers

  _blockRef(block) {
    if (!block) return null;
    return {
      name: block.name,
      position: { x: block.position.x, y: block.position.y, z: block.position.z }
    };
  }
}

/** Accept {x,y,z} or a vec3-like object without importing vec3 here. */
function vecLike(position) {
  if (!position) return position;
  if (typeof position.offset === 'function') return position;
  const Vec3 = require('vec3');
  return new Vec3(position.x, position.y, position.z);
}

function normalizeName(name) {
  if (!name) return '';
  return name.includes(':') ? name : `minecraft:${name}`;
}

/** Strip a namespace: "minecraft:oak_log" -> "oak_log". */
function bareName(name) {
  if (!name) return '';
  const idx = String(name).indexOf(':');
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

/**
 * Find a usable recipe for an item.
 *
 * mineflayer's `recipesFor(itemId, metadata, minResultCount, craftingTable)` returns
 * every wood variant, so we probe in the order that actually works: inventory grid
 * first, then the given table, then "any table".
 */
function pickRecipe(bot, itemId, table) {
  try {
    const recipes = bot.recipesFor(itemId, null, 1, table) || [];
    return recipes.length ? recipes[0] : null;
  } catch {
    return null;
  }
}

module.exports = { MineflayerBody };
