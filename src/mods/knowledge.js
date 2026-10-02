'use strict';

/**
 * ModKnowledge: play on *modded* servers without being told what the mods are.
 *
 * The hard truth about running mineflayer against a modded server:
 *
 *   - Connecting works. Forge/NeoForge/Fabric servers accept vanilla clients, so
 *     mineflayer speaks the protocol fine. No mod-side plugin is required.
 *   - Understanding does NOT come for free. mineflayer's registry
 *     (`minecraft-data`) only knows vanilla content (1.20.1: 1255 items, 1003
 *     blocks). Every modded block/item arrives as content the bot has never seen,
 *     and there is no way to ask the server for its properties.
 *   - mineflayer's registry *does* expose runtime numeric ids, so we can still
 *     detect, name, count and reason about modded content - we just cannot know
 *     its hardness, tool, food value or drops.
 *
 * So this module does three things:
 *
 *   1. DETECT   what the server is running (Forge / NeoForge / Fabric / vanilla)
 *               from block namespaces, entity names and the server brand string.
 *   2. LEARN    a knowledge file (config/mod-knowledge.json) mapping item/block
 *               names to a category, harvested from the live registry plus a
 *               signature table. It persists, so the bot gets smarter across runs.
 *   3. CLASSIFY unknown content by name signature so existing survival logic can
 *               make a defensible decision instead of "unknown, ignore".
 *
 * Everything here degrades gracefully: on a vanilla server the detection reports
 * `vanilla` and the classification tables simply never fire.
 */

const fs = require('fs');
const path = require('path');
const { Logger } = require('../util/logger');

/** Namespaces that are vanilla / protocol plumbing rather than a content mod. */
const VANILLA_NAMESPACES = new Set(['minecraft', 'c', 'forge', 'neoforge', 'fabric', 'fabric-api', 'brigadier', 'realms']);

/**
 * Well-known loader markers found in block/entity namespaces.
 * Keyed by a lowercase substring that appears in the namespace.
 */
const KNOWN_NAMESPACES = {
  create: { name: 'Create', note: 'kinetic machinery; brass/andesite alloys' },
  ae2: { name: 'Applied Energistics 2', note: 'ME networks, certus quartz' },
  appliedenergistics2: { name: 'Applied Energistics 2' },
  farmersdelight: { name: "Farmer's Delight", note: 'cooking pot, cutting board, new crops' },
  tacz: { name: 'Timeless and Classics Zero', note: 'firearms - avoid gunfights' },
  iceandfire: { name: 'Ice and Fire', note: 'dragons; extremely dangerous' },
  twilightforest: { name: 'Twilight Forest' },
  botania: { name: 'Botania' },
  thermal: { name: 'Thermal Series' },
  immersiveengineering: { name: 'Immersive Engineering' },
  mekanism: { name: 'Mekanism' },
  alexscaves: { name: "Alex's Caves", note: 'hostile cave biomes' },
  alexsmobs: { name: "Alex's Mobs" },
  mowziesmobs: { name: "Mowzie's Mobs", note: 'boss mobs' },
  biomesoplenty: { name: 'Biomes O Plenty' },
  byg: { name: 'Oh The Biomes You\u2019ll Go' },
  supplementaries: { name: 'Supplementaries' },
  waystones: { name: 'Waystones', note: 'teleport network - useful for travel' },
  sophisticatedbackpacks: { name: 'Sophisticated Backpacks', note: 'portable storage' },
  sophisticatedstorage: { name: 'Sophisticated Storage' },
  xaerominimap: { name: 'Xaero\u2019s Minimap' },
  ftbchunks: { name: 'FTB Chunks', note: 'claim system - respect claimed land' },
  ftbquests: { name: 'FTB Quests' },
  journey: { name: 'JourneyMap' },
  kubejs: { name: 'KubeJS', note: 'server-side scripting; recipes may be customised' }
};

/**
 * Name-signature classification. Ordered: the first matching rule wins, so put the
 * more specific patterns first.
 */
const SIGNATURES = [
  // ---- items -------------------------------------------------------------
  { match: /_ingot$|^ingot_/, category: 'material', kind: 'ingot' },
  { match: /_nugget$/, category: 'material', kind: 'nugget' },
  { match: /_dust$|_powder$/, category: 'material', kind: 'dust' },
  { match: /_plate$|_sheet$/, category: 'material', kind: 'plate' },
  { match: /_(gear|cogwheel|gearwheel)$/, category: 'material', kind: 'gear' },
  { match: /_(gem|shard|crystal)$/, category: 'material', kind: 'gem' },
  { match: /_(raw_|crushed_|clump)/, category: 'material', kind: 'raw' },
  { match: /_(stick|rod|wire|coil)$/, category: 'material', kind: 'rod' },
  { match: /_(pickaxe|axe|shovel|hoe|sword|dagger|spear|hammer|scythe|paxel)$/, category: 'tool', kind: 'tool' },
  { match: /_(helmet|chestplate|leggings|boots|shield)$/, category: 'armor', kind: 'armor' },
  { match: /_(bucket|tank|canister|cell)$/, category: 'container', kind: 'fluid' },
  { match: /_(seed|seeds|sapling|cutting|spore)$/, category: 'seed', kind: 'seed' },
  { match: /_(berries|berry)$/, category: 'food', kind: 'berry' },
  {
    match: /_(soup|stew|pie|cake|sandwich|burger|pizza|noodles|rice_bowl|curry|jam|juice|tea|coffee|salad|roast|bacon|jerky|dumpling|pancake|waffle|smoothie|sorbet|ice_cream|porridge|skewer)$/,
    category: 'food',
    kind: 'cooked'
  },
  { match: /_(cooked|roasted|fried|baked|smoked|grilled|roast|charred)_/, category: 'food', kind: 'cooked' },
  { match: /^(cooked|roasted|fried|baked|smoked|grilled)_/, category: 'food', kind: 'cooked' },
  // Prefix-style prepared food names: roast_chicken, baked_potato, fried_rice...
  { match: /^(roast|baked|fried|grilled|smoked|steamed|stuffed|glazed|honeyed|spiced|seasoned|pickled|candied)_/, category: 'food', kind: 'cooked' },
  // Dish words that appear as a trailing token: chicken_soup, berry_pie, apple_juice.
  { match: /_(soup|stew|pie|cake|jam|juice|tea|coffee|salad|curry|porridge|smoothie|sorbet|cocktail|broth|sauce|syrup|nectar)$/, category: 'food', kind: 'cooked' },
  { match: /_(meat|fillet|chop|drumstick|thigh|wing|patty|sausage)$/, category: 'food', kind: 'meat' },
  { match: /_bottle$|_potion$|_elixir$|_flask$/, category: 'potion', kind: 'potion' },
  { match: /_upgrade$|_module$|_blueprint$|_schematic$/, category: 'tech', kind: 'upgrade' },
  { match: /_key$|_token$|_coin$|_currency$/, category: 'tech', kind: 'key' },
  { match: /_(alloy|compound|mixture|blend|amalgam|paste|slurry)$/, category: 'material', kind: 'alloy' },
  { match: /_(cogwheel|wheel|rotor|shaft|bearing|piston|pulley|clutch|gearbox|drill|saw|fan|press|mixer|spout|funnel|chute|depot|tank|pipe|pump|valve|nozzle)$/, category: 'machine_part', kind: 'component', needsPickaxe: true },
  { match: /_(workbench|table|station|crucible|kiln|oven|grill|pot|pan|board|cauldron|basin|millstone|mortar|juicer|skillet)$/, category: 'station', kind: 'utility', needsPickaxe: true },
  { match: /_(fiber|fibre|thread|cloth|fabric|leather|hide|pelt|sinew)$/, category: 'material', kind: 'fiber' },

  // ---- blocks ------------------------------------------------------------
  { match: /_ore$/, category: 'ore', needsPickaxe: true },
  { match: /_raw_block$/, category: 'ore_block', needsPickaxe: true },
  { match: /_(log|wood|stem|hyphae)$/, category: 'wood', tool: 'axe' },
  { match: /_planks$/, category: 'wood', tool: 'axe' },
  { match: /_leaves$/, category: 'foliage', tool: 'hoe' },
  { match: /_sapling$/, category: 'foliage' },
  /**
   * Natural terrain by family name.
   *
   * This rule exists because the live server runs a biome modpack: its grass is often
   * `biomeswevegone:lush_grass_block`, not `minecraft:grass_block`, and every one of those
   * names used to classify as `unknown` -> `isMineable()` false -> "no dirt available
   * nearby" while the player was standing on dirt.
   */
  { match: /(^|_)(dirt|grass_block|podzol|mycelium|soil|clay|sand|gravel|mud|moss_block|snow_block|terracotta|tuff|calcite)(_|$)/, category: 'terrain', kind: 'soil' },
  { match: /_crop$|_plant$|_vine$|_bush$/, category: 'plant' },
  { match: /_machine$|_generator$|_furnace$|_smelter$|_crusher$|_mixer$|_press$|_reactor$/, category: 'machine', needsPickaxe: true },
  { match: /_cable$|_pipe$|_conduit$|_wire$/, category: 'tech_block', needsPickaxe: true },
  { match: /_tank$|_barrel$|_crate$|_chest$/, category: 'storage' },
  { match: /_bricks?$|_tiles?$|_concrete$/, category: 'building', needsPickaxe: true },
  { match: /_door$|_trapdoor$|_fence$|_wall$|_gate$/, category: 'building', tool: 'axe' },
  { match: /_(lamp|lantern|light|torch)$/, category: 'light' }
];

/** Block categories we are willing to dig even though they came from a mod. */
const MODDED_MINEABLE_CATEGORIES = [
  'ore',
  'ore_block',
  'terrain',
  'wood',
  'foliage',
  'plant',
  'building',
  'light',
  'storage',
  'machine',
  'machine_part',
  'station',
  'tech_block'
];

class ModKnowledge {
  /**
   * @param {object} cfg loaded agent config
   * @param {object} [options] { registry, knowledgeFile, log }
   */
  constructor(cfg, options = {}) {
    this.cfg = cfg;
    this.log = options.log || new Logger('mods');
    this.registry = options.registry || null;
    this.file = options.knowledgeFile || path.join(cfg.root, 'config', 'mod-knowledge.json');
    this.detected = null;
    this.unknownItems = new Set();
    this.unknownBlocks = new Set();
    this.namespaces = new Map();
    this.learned = { items: {}, blocks: {}, servers: {} };
    this.report = null;
    this.load();
  }

  // ------------------------------------------------------------ persistence

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
        this.learned = { items: {}, blocks: {}, servers: {}, ...parsed };
      }
    } catch (err) {
      this.log.debug(`mod knowledge file unreadable, starting fresh: ${err.message}`);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.learned.updatedAt = new Date().toISOString();
      fs.writeFileSync(this.file, JSON.stringify(this.learned, null, 2), 'utf8');
    } catch (err) {
      this.log.debug(`could not persist mod knowledge: ${err.message}`);
    }
  }

  // --------------------------------------------------------------- detection

  /**
   * Scan the live registry for non-vanilla content and work out the loader.
   * Call this once after spawn (the registry is available as soon as the bot is
   * created, but namespaced block names only appear once chunks arrive).
   */
  scan(bot) {
    if (!bot || !bot.registry) return null;
    this.registry = bot.registry;
    const registry = this.registry;

    this.namespaces.clear();
    this.unknownItems.clear();
    this.unknownBlocks.clear();

    for (const item of Object.values(registry.itemsByName || {})) {
      if (!item || !item.name) continue;
      const ns = namespaceOf(item.name);
      if (ns) this.namespaces.set(ns, (this.namespaces.get(ns) || 0) + 1);
    }
    for (const block of Object.values(registry.blocksByName || {})) {
      if (!block || !block.name) continue;
      const ns = namespaceOf(block.name);
      if (ns) this.namespaces.set(ns, (this.namespaces.get(ns) || 0) + 1);
    }

    // mineflayer resolves unknown ids to names like "unknown" or leaves them
    // numeric; anything without a vanilla-style name is content we cannot model.
    for (const [name, item] of Object.entries(registry.items || {})) {
      if (!item || !item.name) {
        this.unknownItems.add(String(name));
      }
    }

    const modNamespaces = [...this.namespaces.keys()].filter((ns) => !VANILLA_NAMESPACES.has(ns));
    const loader = this.detectLoader(bot, modNamespaces);
    const controller = bot.agent && bot.agent.controller;
    this.detected = {
      loader,
      brand: (bot.game && bot.game.version) || null,
      serverBrand: controller ? controller.serverBrand : null,
      pluginChannels: controller ? [...(controller.pluginChannels || [])] : [],
      modNamespaces,
      mods: modNamespaces.map((ns) => this.describeNamespace(ns)),
      at: new Date().toISOString()
    };
    this.report = this.buildReport();
    this.rememberServer(this.detected);
    return this.detected;
  }

  detectLoader(bot, modNamespaces) {
    const joined = modNamespaces.join(' ');
    // Plugin channels are authoritative: Forge registers fml:*/forge:*, Fabric fabric:*.
    const channels = bot.agent && bot.agent.controller && bot.agent.controller.pluginChannels
      ? [...bot.agent.controller.pluginChannels]
      : [];
    const channelText = channels.join(' ');
    const brand = String(
      (bot.agent && bot.agent.controller && bot.agent.controller.serverBrand) ||
        (bot.game && bot.game.serverBrand) ||
        (bot.settings && bot.settings.brand) ||
        ''
    ).toLowerCase();
    const versionName = String((bot.game && bot.game.version) || '').toLowerCase();

    if (/neoforge/.test(channelText) || /neoforge/.test(brand)) return 'neoforge';
    if (/\bfml:|forge:handshake|forge:registry/.test(channelText) || /\bforge\b/.test(versionName) || /forge/.test(brand)) return 'forge';
    if (/fabric/.test(channelText) || /fabric/.test(brand)) return 'fabric';
    if (/\bforge\b/.test(joined)) return 'forge';
    if (modNamespaces.length) return 'modded (loader unknown)';
    return 'vanilla';
  }

  describeNamespace(ns) {
    const known = KNOWN_NAMESPACES[ns.toLowerCase()];
    return known ? { namespace: ns, name: known.name, note: known.note || null } : { namespace: ns, name: null, note: null };
  }

  rememberServer(detected) {
    if (!detected) return;
    const key = `${this.cfg.agent.bot.host}:${this.cfg.agent.bot.port}`;
    this.learned.servers[key] = {
      loader: detected.loader,
      mods: detected.mods.map((m) => m.namespace),
      lastSeen: detected.at
    };
    this.save();
  }

  // ------------------------------------------------------------ classification

  /**
   * Best-effort classification of a name we may never have seen.
   * @param {string} name e.g. "create:brass_ingot" or "some_mod:weird_ore"
   * @returns {{category:string, kind?:string, tool?:string, needsPickaxe?:boolean, confidence:string, namespace:string|null}}
   */
  classify(name) {
    const bare = bareName(name);
    const learned = this.learned.items[bare] || this.learned.blocks[bare];
    if (learned) return { ...learned, confidence: 'learned' };

    for (const rule of SIGNATURES) {
      if (rule.match.test(bare)) {
        const result = { category: rule.category, namespace: namespaceOf(name) };
        if (rule.kind) result.kind = rule.kind;
        if (rule.tool) result.tool = rule.tool;
        if (rule.needsPickaxe) result.needsPickaxe = true;
        result.confidence = 'signature';
        return result;
      }
    }
    return { category: 'unknown', namespace: namespaceOf(name), confidence: 'none' };
  }

  /** Teach the knowledge base something we verified in-world. */
  learn(name, facts) {
    const bare = bareName(name);
    const bucket = facts && facts.isBlock ? 'blocks' : 'items';
    this.learned[bucket][bare] = { ...(this.learned[bucket][bare] || {}), ...facts, at: new Date().toISOString() };
    this.save();
  }

  // ----------------------------------------------------------------- queries

  /** Is this item plausibly edible? Unknown modded food is treated as edible only with a signature match. */
  isProbablyFood(name) {
    if (!name) return false;
    const bare = bareName(name);
    if (this.registry && this.registry.foodsByName && this.registry.foodsByName[bare]) return true;
    const cls = this.classify(bare);
    return cls.category === 'food';
  }

  /** Should the agent avoid trying to mine this block? */
  isMineable(name) {
    if (!name) return false;
    const bare = bareName(name);
    const block = this.registry && this.registry.blocksByName ? this.registry.blocksByName[bare] : null;
    if (block) {
      // Vanilla knowledge: bedrock-like blocks are never diggable.
      if (block.diggable === false) return false;
      return true;
    }
    const cls = this.classify(bare);
    // Unknown modded block. Two ways to say yes:
    //  - the operator explicitly opted in (survival.mineUnknownModBlocks)
    //  - a name signature suggests an ordinary block
    // Unbreakable/technical blocks would otherwise trap the bot in a pointless dig
    // loop, which is why the default is conservative.
    if (this.cfg.agent.survival && this.cfg.agent.survival.mineUnknownModBlocks) return true;
    return MODDED_MINEABLE_CATEGORIES.includes(cls.category);
  }

  /** Namespace of a modded name, or null for vanilla. */
  namespaceOf(name) {
    const ns = namespaceOf(name);
    return ns && !VANILLA_NAMESPACES.has(ns) ? ns : null;
  }

  /** Mod display name for a namespace, if we recognise it. */
  modName(ns) {
    const known = KNOWN_NAMESPACES[String(ns).toLowerCase()];
    return known ? known.name : ns;
  }

  buildReport() {
    return {
      loader: this.detected ? this.detected.loader : 'unknown',
      vanillaItems: this.registry ? Object.keys(this.registry.itemsByName || {}).length : 0,
      vanillaBlocks: this.registry ? Object.keys(this.registry.blocksByName || {}).length : 0,
      modNamespaces: this.detected ? this.detected.modNamespaces : [],
      recognisedMods: (this.detected ? this.detected.mods : []).filter((m) => m.name),
      unknownContent: {
        items: [...this.unknownItems].slice(0, 50),
        itemCount: this.unknownItems.size,
        blockCount: this.unknownBlocks.size
      },
      guidance: this.guidance()
    };
  }

  /** Practical advice for the current server, surfaced in logs and via the status API. */
  guidance() {
    const loader = this.detected ? this.detected.loader : 'unknown';
    const mods = this.detected ? this.detected.modNamespaces : [];
    const out = [];
    if (loader === 'vanilla' && !mods.length) {
      out.push('Vanilla server: full item/block knowledge available.');
    } else {
      out.push(`${loader} server with ${mods.length} mod namespace(s): vanilla knowledge still covers common blocks.`);
      if (loader !== 'vanilla') {
        out.push(
          `${loader} detected via plugin channels: the server accepts vanilla-protocol clients, ` +
            'but any server-side mod content stays invisible to mineflayer.'
        );
      }
      out.push('Modded blocks/items are detected but their hardness, drops and recipes are unknown to mineflayer.');
      out.push('Unknown blocks are only mined when a name signature suggests a normal block (see src/mods/knowledge.js).');
    }
    if (mods.some((m) => /tacz|gun|iceandfire|mowzies/i.test(m))) {
      out.push('Combat-heavy mods detected: prefer fleeing over fighting.');
    }
    if (mods.some((m) => /ftbchunks|claim/i.test(m))) {
      out.push('Claim mod detected: do not break blocks inside claimed chunks.');
    }
    return out;
  }

  summary() {
    if (!this.report) return { loader: 'unknown', note: 'not scanned yet (no server connection)' };
    return {
      loader: this.report.loader,
      mods: this.report.modNamespaces.slice(0, 20),
      recognisedMods: this.report.recognisedMods.map((m) => m.name),
      unknownItemCount: this.report.unknownContent.itemCount,
      guidance: this.report.guidance
    };
  }
}

function namespaceOf(name) {
  if (!name || typeof name !== 'string') return null;
  const idx = name.indexOf(':');
  return idx === -1 ? null : name.slice(0, idx);
}

function bareName(name) {
  if (!name || typeof name !== 'string') return '';
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

/** Known loader namespace markers, exported for tests. */
module.exports = { ModKnowledge, namespaceOf, bareName, SIGNATURES, KNOWN_NAMESPACES, VANILLA_NAMESPACES, MODDED_MINEABLE_CATEGORIES };
