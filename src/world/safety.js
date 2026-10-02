'use strict';

/**
 * Safety policy: stay away from anything a player built.
 *
 * The agent runs on a public server (other players join it), so the difference between "a
 * tree" and "a log in someone's wall" matters, and so does the difference between "a hill"
 * and "a staircase". This module is the single source of truth for that judgement, shared by
 * three consumers that must agree:
 *
 *   - the **pathfinder**, so routes do not cross built floors, farms or doorways
 *   - the **harvest tasks**, so a chop targets a tree and never a building
 *   - the **operator scripts**, so a test walk refuses a man-made destination
 *
 * Duplicating these lists is how a "safe" script ends up next to an unsafe agent, so there
 * is exactly one copy and it lives here.
 *
 * DESIGN BIAS: when in doubt, refuse. A skipped tree costs a few seconds; trampling a farm or
 * eating someone's base costs a ban, and there is no undo.
 */

/**
 * Block families the agent must never break or stand on, with the reason.
 *
 * Ordered: the first match wins, and the reasons are surfaced to the operator so a refusal
 * explains itself instead of looking like a bug.
 */
const MAN_MADE = [
  { why: 'container/storage', match: /chest|barrel|shulker|hopper|dispenser|dropper|crate|backpack|drawer|cabinet|sack|lectern|bookshelf|jukebox|beehive|bee_nest|decorated_pot|vault|trial_spawner/i },
  { why: 'workstation', match: /crafting_table|furnace|smoker|blast_furnace|anvil|smithing|grindstone|loom|cartography|stonecutter|brewing|cauldron|enchanting|composter|fletching|crafter|workbench|sawmill|basin|press|mixer|spout|depot|millstone|mortar|cutting_board|cooking_pot|skillet|oven|kiln|farmland/i },
  { why: 'farmland/crop', match: /crop|wheat|carrot|potato|beetroot|melon_stem|pumpkin_stem|rice|tomato|onion|cabbage|_seeds|soil$/i },
  { why: 'light source', match: /torch|lantern|lamp|campfire|candle|glowstone|shroomlight|sea_lantern/i },
  { why: 'built block (planks/bricks/stonework)', match: /_planks$|_slab$|_stairs$|_wall$|_fence|_door$|_trapdoor$|_bricks?$|_tiles?$|chiseled_|cut_|polished_|smooth_|glass|_terracotta$|_concrete|_wool$|carpet|_bed$|_banner$|_sign$|ladder|scaffolding|chain$|iron_bars|_pane$|flower_pot|_button$|_pressure_plate$|_rail$|rail$|_piston|observer|redstone_|repeater|comparator|target$|note_block|daylight_detector|tripwire|lever|_head$|skull|armor_stand|item_frame|painting|_cake$|_pumpkin$|hay_block|dried_kelp_block|_path$|path_block|mud_bricks|nether_brick|quartz_block|prismarine|purpur|end_stone_brick|blackstone_brick|deepslate_brick|deepslate_tile|cobbled_deepslate|mossy_|cracked_|_bars$/i },
  { why: 'storage/utility mod', match: /sophisticated|ae2|appliedenergistics|waystone|ftb|create:|immersiveengineering|mekanism|thermal|botania|ars_nouveau|touhou_little_maid|alexsmobs:.*(cage|dictionary)/i }
];

/** Has this block been placed by a player, as far as we can tell? */
function manMadeReason(blockName) {
  if (!blockName) return null;
  for (const rule of MAN_MADE) {
    if (rule.match.test(blockName)) return rule.why;
  }
  return null;
}

/** Ground that unambiguously generated with the world. */
const NATURAL_GROUND = /^(minecraft:)?(grass_block|dirt|coarse_dirt|rooted_dirt|podzol|mycelium|moss_block|sand|red_sand|gravel|stone|andesite|granite|diorite|deepslate|tuff|calcite|snow|snow_block|mud|clay|terracotta|netherrack|soul_sand|soul_soil|basalt|blackstone|end_stone|water|magma_block|sculk|moss_carpet)$/;

/** Vegetation that occupies a block but is neither an obstacle nor man-made. */
const WALKABLE_VEGETATION = /^(minecraft:)?(grass|tall_grass|short_grass|fern|large_fern|dead_bush|dandelion|poppy|blue_orchid|allium|azure_bluet|red_tulip|orange_tulip|white_tulip|pink_tulip|oxeye_daisy|cornflower|lily_of_the_valley|sunflower|lilac|rose_bush|peony|sugar_cane|kelp|seagrass|vine|snow|bush|flowering_azalea|azalea)$/;

/** Blocks that occupy a cell and can be walked through without touching anything built. */
const CLEAR = /^(minecraft:)?(air|cave_air|void_air)$/;

function bare(name) {
  if (!name) return '';
  const idx = String(name).indexOf(':');
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

/**
 * An absolute-coordinate block reader for any world-ish object.
 *
 * This indirection is not decoration. `BodyWorldView.blockAt()` is **offset-based** - it adds
 * the argument to the player's position, inherited from the mineflayer idiom
 * `bot.blockAt(pos.offset(...))` - while a Body's own `blockAt()` is absolute. Passing the
 * wrong one silently answers about the wrong coordinates, which is how "the tree is not
 * there" bugs happen: the lookup returned `null` for every neighbour and the tree check
 * reported "the column base is outside the scan".
 *
 * @param {object} world a BodyWorldView, a ClientWorldAdapter or a Body
 * @returns {((position:{x:number,y:number,z:number}) => ({name:string}|null))|null}
 */
function blockReader(world) {
  if (!world) return null;
  if (typeof world.blockAtAbsolute === 'function') return (position) => world.blockAtAbsolute(position);
  if (typeof world.blockAt === 'function') return (position) => world.blockAt(position);
  return null;
}

function isNaturalGround(name) {
  return NATURAL_GROUND.test(String(name || ''));
}

function isWalkableVegetation(name) {
  return WALKABLE_VEGETATION.test(String(name || ''));
}

function isClear(name) {
  return CLEAR.test(String(name || ''));
}

/**
 * May the agent stand here at all?
 *
 * @param {string} surfaceName the block it would stand ON
 * @param {string} spaceName the block occupying the cell itself
 * @returns {{ok:boolean, why?:string}}
 */
function assessStandability(surfaceName, spaceName) {
  if (!surfaceName || !spaceName) return { ok: false, why: 'block data not loaded' };

  const surfaceVeto = manMadeReason(surfaceName);
  if (surfaceVeto) return { ok: false, why: `ground is a ${surfaceVeto} (${surfaceName})` };

  const spaceVeto = manMadeReason(spaceName);
  if (spaceVeto && !isWalkableVegetation(spaceName)) {
    return { ok: false, why: `standing space holds a ${spaceVeto} (${spaceName})` };
  }

  if (!isClear(spaceName) && !isWalkableVegetation(spaceName)) {
    return { ok: false, why: `not standable (${spaceName})` };
  }
  if (!isNaturalGround(surfaceName)) {
    return { ok: false, why: `ground is ${surfaceName}, not natural terrain` };
  }
  return { ok: true };
}

/**
 * Is this log part of a *tree*, rather than a wall, a floor or a decoration?
 *
 * The test is deliberately structural rather than name-based, because a log is a log
 * wherever it is. A tree has: natural ground under the column, at least two logs stacked,
 * and no built blocks touching it. A log cabin fails all three.
 *
 * @param {object} world something with `blockAt(position)` (a BodyWorldView or ClientModBody)
 * @param {{name:string, position:{x:number,y:number,z:number}}} block a log
 * @param {object} [options] { requireLeaves } - a trunk without a canopy is refused by default
 * @returns {{ok:boolean, why:string}}
 */
function looksLikeTree(world, block, options = {}) {
  if (!world || !block || !block.position) return { ok: false, why: 'no block to inspect' };
  const name = bare(block.name);
  if (!/(_log|_stem|_wood|_hyphae)$/.test(name)) return { ok: false, why: `${name} is not a log` };

  const read = blockReader(world);
  if (!read) return { ok: false, why: 'the world cannot be read' };

  const at = (dx, dy, dz) => {
    const found = read({ x: Math.floor(block.position.x) + dx, y: Math.floor(block.position.y) + dy, z: Math.floor(block.position.z) + dz });
    return found ? found.name : null;
  };

  // 1. Walk down the column to its base, and refuse if a built block is anywhere in it.
  let base = null;
  for (let depth = 0; depth < 24; depth += 1) {
    const below = at(0, -depth - 1, 0);
    if (below === null) return { ok: false, why: 'the column base is outside the scan' };
    const veto = manMadeReason(below);
    if (veto) return { ok: false, why: `the log column sits on a ${veto} (${below})` };
    if (!/(_log|_stem|_wood|_hyphae)$/.test(bare(below))) {
      base = below;
      break;
    }
  }
  if (base === null) return { ok: false, why: 'the log column is too tall to verify' };

  /**
   * 2. The base must be natural ground - with two deliberate exceptions.
   *
   * `air` and leaves are accepted because the agent's own chopping removes the block below:
   * the first log of a tree leaves a floating trunk above an air gap, and refusing that made
   * a partially harvested tree impossible to finish (the task reported "no logs available"
   * next to a tree it had just started on). Leaves are accepted because a trunk can continue
   * up through a canopy. Anything built is still refused, which is what the rule is for.
   */
  const baseBare = bare(base);
  const tolerated = /^(air|cave_air|void_air)$/.test(baseBare) || /_leaves$/.test(baseBare);
  if (!isNaturalGround(base) && !/dirt|grass|podzol|mycelium|mud|moss|sand|gravel/.test(baseBare) && !tolerated) {
    return { ok: false, why: `the tree would be rooted in ${base}, which is not natural ground` };
  }

  // 3. A tree is more than one block; a single floating log is a decoration.
  const above = at(0, 1, 0);
  const belowIsLog = /(_log|_stem|_wood|_hyphae)$/.test(bare(at(0, -1, 0) || ''));
  if (!belowIsLog) {
    const stacked = /(_log|_stem|_wood|_hyphae)$/.test(bare(above || ''));
    if (!stacked) return { ok: false, why: 'a single isolated log - not a tree' };
  }

  // 4. Nothing built may touch the trunk.
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
    const neighbour = at(dx, dy, dz);
    const veto = manMadeReason(neighbour);
    if (veto) return { ok: false, why: `a ${veto} (${neighbour}) is touching the trunk` };
  }

  /**
   * 5. A trunk alone is not a tree: there must be a canopy.
   *
   * This is what separates a forest from a lumber yard. Everything above is structural but
   * blind: a player's log pillar standing on grass, a decorative stripped-log column, a
   * fence-post-like stack - all of them pass rules 1-4 and would be eaten. Requiring leaves
   * is the one signal that is a property of *trees* rather than of logs, and it is cheap
   * because leaves are always adjacent to the top of the trunk.
   *
   * Nether "trees" have no leaves at all (crimson/warped fungi carry wart blocks), and bamboo
   * is not a log with a canopy either - both are accepted by `isCanopy`.
   */
  if (options.requireLeaves !== false) {
    const canopy = findCanopy(at, block);
    if (!canopy.ok) return canopy;
  }

  return { ok: true, why: `rooted in ${base}` };
}

/** Block names that count as a tree's canopy. */
const CANOPY = /(_leaves|_wart_block|_foliage)$/;

/**
 * Does the trunk under `block` carry a canopy?
 *
 * Walks up the column to its top first, then looks in a small box around it: vanilla leaves
 * sit within ~2 blocks horizontally and up to ~4 above the highest log, which is the shape of
 * every overworld species. A bare column returns false with a reason saying so, because
 * "this is not a tree" and "this tree is out of sight" need different answers.
 *
 * @param {(dx:number, dy:number, dz:number) => (string|null)} at relative block reader
 * @param {{position:{x:number,y:number,z:number}}} block any log of the column
 * @param {object} [limits] { radius, up, down }
 * @returns {{ok:boolean, why:string}}
 */
function findCanopy(at, block, limits = {}) {
  const radius = limits.radius === undefined ? 2 : limits.radius;
  const up = limits.up === undefined ? 4 : limits.up;
  const down = limits.down === undefined ? 1 : limits.down;

  // Climb to the top of the trunk so the search happens where leaves actually are.
  let top = 0;
  for (let step = 0; step < 40; step += 1) {
    const next = at(0, top + 1, 0);
    if (next === null) break; // above the scan: stop climbing, search what we can see
    if (!/(_log|_stem|_wood|_hyphae)$/.test(bare(next))) break;
    top += 1;
  }

  let sawAnything = false;
  for (let dy = -down; dy <= up; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const name = at(dx, top + dy, dz);
        if (name === null) continue;
        sawAnything = true;
        if (CANOPY.test(bare(name))) return { ok: true, why: 'has a canopy' };
      }
    }
  }

  return {
    ok: false,
    why: sawAnything
      ? 'the trunk has no leaves - it looks built rather than grown'
      : 'the area around the trunk top is outside the scan, so I cannot confirm it is a tree'
  };
}

/**
 * A guard object for the pathfinder: may this cell be occupied?
 *
 * Wraps a Body/view so the movement model can ask about a cell without knowing where the
 * data comes from. Returns a reason string when the cell is refused, or null when it is fine.
 */
class ManMadeGuard {
  /**
   * @param {object} world something with `blockAtAbsolute`/`blockAt` (a ClientWorldAdapter)
   * @param {object} [options] { enabled, log }
   */
  constructor(world, options = {}) {
    this.world = world;
    this.read = blockReader(world);
    this.enabled = options.enabled !== false && !!this.read;
    this.log = options.log || { debug() {} };
    /** Cells already judged, so a repeated neighbour query is free. */
    this.cache = new Map();
    this.stats = { checked: 0, refused: 0 };
  }

  /** @returns {string|null} a refusal reason, or null when the cell is acceptable */
  veto(position) {
    if (!this.enabled || !this.read) return null;
    const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
    if (this.cache.has(key)) return this.cache.get(key);
    this.stats.checked += 1;

    const space = this.read({ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) });
    const floor = this.read({ x: Math.floor(position.x), y: Math.floor(position.y) - 1, z: Math.floor(position.z) });
    // Unknown cells are the movement model's business (it refuses them itself); do not
    // double-report them as man-made.
    let reason = null;
    if (space && space.name) {
      const veto = manMadeReason(space.name);
      if (veto && !isWalkableVegetation(space.name)) reason = veto;
    }
    if (!reason && floor && floor.name) {
      const veto = manMadeReason(floor.name);
      if (veto) reason = `standing on a ${veto}`;
    }
    if (reason) this.stats.refused += 1;
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(key, reason);
    return reason;
  }

  /** Convenience: is the cell free of built blocks? */
  allows(position) {
    return this.veto(position) === null;
  }

  describe() {
    return { enabled: this.enabled, ...this.stats };
  }
}

module.exports = {
  MAN_MADE,
  NATURAL_GROUND,
  WALKABLE_VEGETATION,
  CANOPY,
  manMadeReason,
  isNaturalGround,
  isWalkableVegetation,
  isClear,
  assessStandability,
  looksLikeTree,
  findCanopy,
  blockReader,
  ManMadeGuard,
  bare
};
