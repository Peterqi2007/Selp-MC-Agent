'use strict';

/**
 * WorldView: a cheap, synchronous read-only model of the bot's surroundings.
 *
 * Behaviour code should never scrape mineflayer directly - it asks the view
 * questions such as "is it night?", "is anything hostile within 12 blocks?" or
 * "where is the nearest log?". That keeps the decision layer testable and makes it
 * easy to swap in a richer perception source later (e.g. a server-side mod bridge).
 */

const { isLog, needsPickaxe, bestTool, TOOL_TIERS } = require('./items');

class WorldView {
  constructor(controller, options = {}) {
    this.controller = controller;
    this.cfg = controller.cfg;
    /** Optional ModKnowledge instance; enables modded-server awareness. */
    this.mods = options.mods || controller.mods || null;
  }

  get bot() {
    return this.controller.bot;
  }

  get ready() {
    return !!(this.bot && this.bot.entity);
  }

  // ------------------------------------------------------------------- time

  isNight() {
    const t = this.bot && this.bot.time;
    if (!t) return false;
    return !t.isDay;
  }

  timeOfDay() {
    return this.bot && this.bot.time ? this.bot.time.timeOfDay : 0;
  }

  day() {
    return this.bot && this.bot.time ? this.bot.time.day : 0;
  }

  isRaining() {
    return !!(this.bot && this.bot.isRaining);
  }

  // --------------------------------------------------------------- position

  position() {
    return this.bot && this.bot.entity ? this.bot.entity.position.clone() : null;
  }

  dimension() {
    return (this.bot && this.bot.game && this.bot.game.dimension) || 'minecraft:overworld';
  }

  /**
   * Block at a RELATIVE offset from the bot.
   *
   * NOTE: offset-based, for historical reasons. Tasks want absolute coordinates - use
   * `blockAtAbsolute` for those. Mixing the two silently returns the wrong block.
   */
  blockAt(x, y, z) {
    if (!this.bot || !this.bot.entity) return null;
    if (typeof x === 'object' && x !== null) {
      return this.bot.blockAt(this.bot.entity.position.offset(x.x || 0, x.y || 0, x.z || 0));
    }
    return this.bot.blockAt(this.bot.entity.position.offset(x || 0, y || 0, z || 0));
  }

  /** Block at ABSOLUTE world coordinates (what tasks use). */
  blockAtAbsolute(position) {
    if (!this.bot || !position) return null;
    const Vec3 = require('vec3');
    return this.bot.blockAt(new Vec3(position.x, position.y, position.z));
  }

  /** Highest non-air block in the column under the bot (good enough for shelter building). */
  groundLevel() {
    const pos = this.position();
    if (!pos) return null;
    for (let dy = 2; dy >= -4; dy -= 1) {
      const block = this.bot.blockAt(pos.offset(0, dy, 0));
      if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'water') {
        return Math.floor(block.position.y) + 1;
      }
    }
    return null;
  }

  // ----------------------------------------------------------------- blocks

  findBlock(matching, options = {}) {
    if (!this.ready) return null;
    const maxDistance = options.maxDistance || 32;
    const count = options.count || 1;
    return this.bot.findBlock({ matching, maxDistance, count });
  }

  findBlocks(matching, options = {}) {
    if (!this.ready) return [];
    return this.bot.findBlocks({
      matching,
      maxDistance: options.maxDistance || 32,
      count: options.count || 64
    });
  }

  /** Nearest wood log of any species. */
  findNearestLog(maxDistance = 48) {
    return this.findBlock((b) => isLog(b.name), { maxDistance });
  }

  findNearestBlockName(names, maxDistance = 32) {
    const set = new Set(names);
    return this.findBlock((b) => set.has(b.name), { maxDistance });
  }

  findNearbyBlockNames(names, maxDistance = 32, count = 64) {
    const set = new Set(names);
    return this.findBlocks((b) => set.has(b.name), { maxDistance, count });
  }

  /** Can the bot break this block with what it currently carries? */
  canMine(block) {
    if (!block) return false;
    // On a modded server most blocks are content mineflayer has never seen, so ask
    // the knowledge layer first: it refuses unbreakable/technical blocks and known
    // harvest-level gates, and otherwise lets the attempt happen.
    if (this.mods && this.mods.registry && !this.mods.registry.blocksByName[block.name]) {
      if (!this.mods.isMineable(block.name)) return false;
      return true;
    }
    if (!needsPickaxe(block.name)) return true;
    const pick = bestTool(this.bot, 'pickaxe');
    if (!pick) return false;
    // Obsidian / ancient debris need diamond or better.
    if (['obsidian', 'ancient_debris', 'crying_obsidian', 'respawn_anchor'].includes(block.name)) {
      return TOOL_TIERS.indexOf(pick.tier) >= TOOL_TIERS.indexOf('diamond');
    }
    return true;
  }

  /** True when this block came from a mod rather than vanilla. */
  isModded(blockOrName) {
    const name = typeof blockOrName === 'string' ? blockOrName : blockOrName && blockOrName.name;
    if (!name) return false;
    if (!this.mods) return name.includes(':') && !name.startsWith('minecraft:');
    return !!this.mods.namespaceOf(name);
  }

  /** Namespace of a modded block, for logging ("which mod is this from?"). */
  modSource(blockOrName) {
    const name = typeof blockOrName === 'string' ? blockOrName : blockOrName && blockOrName.name;
    if (!name || !this.mods) return null;
    const ns = this.mods.namespaceOf(name);
    return ns ? this.mods.modName(ns) : null;
  }

  // --------------------------------------------------------------- entities

  /** Entities that can hurt the bot, sorted by distance. */
  hostiles(maxDistance = 16) {
    if (!this.ready) return [];
    const pos = this.bot.entity.position;
    const out = [];
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || !entity.position || entity === this.bot.entity) continue;
      const kind = entity.kind || (entity.type === 'mob' ? 'Hostile mobs' : entity.type);
      if (kind !== 'Hostile mobs') continue;
      const distance = entity.position.distanceTo(pos);
      if (distance <= maxDistance) out.push({ entity, distance });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  nearestHostile(maxDistance = 16) {
    const list = this.hostiles(maxDistance);
    return list.length ? list[0] : null;
  }

  /** Drops (item entities) nearby - used to pick up what the bot just mined. */
  nearbyItemEntities(maxDistance = 8) {
    if (!this.ready) return [];
    const pos = this.bot.entity.position;
    return Object.values(this.bot.entities)
      .filter((e) => e && e.name === 'item' && e.position && e.position.distanceTo(pos) <= maxDistance)
      .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos));
  }

  /** The nearest stationary container block (chest, barrel, ...). */
  nearestContainer(maxDistance = 16) {
    return this.findNearestBlockName(
      ['chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest'],
      maxDistance
    );
  }

  // ------------------------------------------------------------------ light

  /** Light level at the bot's feet; night + dark means torches are worth placing. */
  lightLevel() {
    if (!this.ready) return 15;
    const pos = this.bot.entity.position.floored();
    const block = this.bot.blockAt(pos);
    if (!block) return 15;
    try {
      return block.light;
    } catch {
      return 15;
    }
  }

  isInDanger() {
    const bot = this.bot;
    if (!bot || !bot.entity) return false;
    if (bot.health !== undefined && bot.health <= this.cfg.agent.behaviour.fleeHealthThreshold) return true;
    const lava = bot.blockAt(bot.entity.position);
    if (lava && (lava.name === 'lava' || lava.name === 'fire')) return true;
    return false;
  }

  summary() {
    if (!this.ready) return { ready: false };
    const bot = this.bot;
    const pos = bot.entity.position;
    return {
      ready: true,
      position: { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) },
      dimension: this.dimension(),
      isDay: !this.isNight(),
      day: this.day(),
      health: bot.health,
      food: bot.food,
      light: this.lightLevel(),
      hostiles: this.hostiles(12).map((h) => ({ name: h.entity.name, distance: +h.distance.toFixed(1) })),
      raining: this.isRaining(),
      server: this.mods ? this.mods.summary() : undefined
    };
  }
}

module.exports = { WorldView };
