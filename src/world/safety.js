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
 * Log-family block names - vanilla and modded.
 *
 * Names, not block entities: every tree mod we have met (Biomes We've Gone, Create, ...) keeps
 * the `*_log` / `*_wood` / `*_stem` / `*_hyphae` suffix, and the structural checks below do the
 * rest. Bamboo is deliberately NOT in this family: it is a plant, not a trunk with a canopy.
 */
const LOG_FAMILY = /(_log|_stem|_wood|_hyphae)$/;

/** Block names that count as a tree's canopy (leaves, nether wart blocks, modded foliage). */
const CANOPY = /(_leaves|_wart_block|_foliage)$/;

/** How many canopy blocks have to be visible before a trunk counts as a tree. */
const CANOPY_MIN = 3;

function isLogName(name) {
  return LOG_FAMILY.test(bare(name));
}

function isCanopyName(name) {
  return CANOPY.test(bare(name));
}

/**
 * Is this log part of a *tree*, rather than a wall, a floor or a decoration?
 *
 * Rewritten 2026-10-02 after live testing showed the old single-column walk refused real
 * trees. The old version climbed one vertical (x, z) column and demanded leaves within 2
 * blocks of that column's top. That shape does not exist for:
 *
 *   - acacia (the trunk grows diagonally, so the "column" turns into a staircase),
 *   - 2x2 dark oak / jungle / spruce (four columns, often with stumps),
 *   - big trees whose canopy starts more than 4 blocks above the top log,
 *   - any tree the agent already chopped a few blocks out of.
 *
 * The rewrite walks the **connected log cluster** (26-connected, bounded to 64 logs), which
 * covers all of the shapes above, then applies the same three safety rules as before:
 *
 *   1. every visible base block under the cluster must be natural ground (not a built block),
 *   2. nothing man-made may touch any log in the cluster,
 *   3. a canopy must exist around the cluster (>= CANOPY_MIN visible canopy blocks), because
 *      a trunk alone is indistinguishable from a player's log pillar.
 *
 * "Unknown" (outside the scan) keeps its own answer: "I cannot see" and "it is not a tree"
 * are different sentences, and the operator gets to read which one happened.
 *
 * @param {object} world something with `blockAt(position)` (a BodyWorldView or ClientModBody)
 * @param {{name:string, position:{x:number,y:number,z:number}}} block a log
 * @param {object} [options] { requireLeaves, canopy:{radius,up,down} }
 * @returns {{ok:boolean, why:string}}
 */
function looksLikeTree(world, block, options = {}) {
  if (!world || !block || !block.position) return { ok: false, why: 'no block to inspect' };
  const startName = bare(block.name);
  if (!isLogName(startName)) return { ok: false, why: `${startName} is not a log` };

  const read = blockReader(world);
  if (!read) return { ok: false, why: 'the world cannot be read' };

  const ox = Math.floor(block.position.x);
  const oy = Math.floor(block.position.y);
  const oz = Math.floor(block.position.z);
  const at = (x, y, z) => {
    const found = read({ x, y, z });
    return found ? found.name : null;
  };

  // 1. Walk the whole connected log cluster, not just one column. Bounded, so a huge
  //    modded tree cannot turn this into an unbounded scan.
  const MAX_LOGS = 64;
  const cluster = [];
  const seen = new Set();
  const queue = [[ox, oy, oz]];
  while (queue.length && cluster.length < MAX_LOGS) {
    const [x, y, z] = queue.shift();
    const key = `${x},${y},${z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = at(x, y, z);
    if (name === null || !isLogName(name)) continue;
    cluster.push({ x, y, z, name });
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          const neighbourKey = `${x + dx},${y + dy},${z + dz}`;
          if (!seen.has(neighbourKey)) queue.push([x + dx, y + dy, z + dz]);
        }
      }
    }
  }
  if (!cluster.length) return { ok: false, why: 'the log is outside the scan' };

  // 2. Base check: every column that reaches the ground must stand on natural terrain.
  const lowest = Math.min(...cluster.map((log) => log.y));
  const baseLogs = cluster.filter((log) => log.y === lowest);
  let baseName = null;
  let unknownBases = 0;
  for (const log of baseLogs) {
    // The cluster walk is capped at 64 logs, so the "lowest" log may still have trunk
    // below it on a very large tree. Keep probing down through logs until real ground.
    let y = log.y - 1;
    let probe = at(log.x, y, log.z);
    let steps = 0;
    while (probe !== null && isLogName(probe) && steps < 40) {
      y -= 1;
      steps += 1;
      probe = at(log.x, y, log.z);
    }
    if (probe === null) {
      unknownBases += 1;
      continue;
    }
    const veto = manMadeReason(probe);
    if (veto) return { ok: false, why: `the log column sits on a ${veto} (${probe})` };
    if (isLogName(probe)) return { ok: false, why: 'the trunk is too tall to verify its base' };
    if (baseName === null) baseName = probe;
  }
  if (baseName === null) {
    return { ok: false, why: 'the column base is outside the scan' };
  }
  if (unknownBases > 0) {
    return {
      ok: false,
      why: `part of the trunk base is outside the scan (${unknownBases} column(s) unverifiable)`
    };
  }

  /**
   * The base must be natural ground - with two deliberate exceptions.
   *
   * `air` and leaves are accepted because the agent's own chopping removes the block below:
   * the first log of a tree leaves a floating trunk above an air gap, and refusing that made
   * a partially harvested tree impossible to finish. Modded ground families pass through the
   * looser name test so a Biomes We've Gone `lush_grass_block` is not read as a build.
   */
  const baseBare = bare(baseName);
  const tolerated = /^(air|cave_air|void_air)$/.test(baseBare) || isCanopyName(baseBare);
  const naturalish = /(grass|dirt|moss|sand|gravel|podzol|mycelium|mud|stone|deepslate|tuff|calcite|terracotta|snow|netherrack|soul_|basalt|blackstone|clay|sculk|end_stone)/i;
  if (!isNaturalGround(baseName) && !naturalish.test(baseBare) && !tolerated) {
    return { ok: false, why: `the tree would be rooted in ${baseName}, which is not natural ground` };
  }

  // 3. Nothing built may touch any log in the cluster.
  const TOUCHING = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
  for (const log of cluster) {
    for (const [dx, dy, dz] of TOUCHING) {
      const neighbour = at(log.x + dx, log.y + dy, log.z + dz);
      const veto = manMadeReason(neighbour);
      if (veto) return { ok: false, why: `a ${veto} (${neighbour}) is touching the trunk` };
    }
  }

  /**
   * 4. A trunk alone is not a tree: there must be a canopy.
   *
   * This is what separates a forest from a lumber yard. Everything above is structural but
   * blind: a player's log pillar standing on grass, a decorative stripped-log column - both
   * pass rules 1-3 and would be eaten. Requiring leaves is the one signal that is a property
   * of *trees* rather than of logs. Nether "trees" carry wart blocks instead of leaves.
   */
  const canopy = options.requireLeaves === false
    ? { found: 0, visible: 0, unknown: 0, near: 0 }
    : canopyAround(at, cluster, options.canopy || {});

  /**
   * Two different failures, two different sentences:
   *  - nothing at all is visible around the trunk -> the scan does not cover this tree;
   *  - the trunk and its surroundings are visible, but carry no canopy -> not a tree.
   *
   * The acceptance threshold is shape-aware. `CANOPY_MIN` (3) is the strong signal, but a
   * single canopy block sitting on the trunk - a 1-wide nether fungus, or the last leaves of
   * a half-chopped sapling - is also enough when it is *near* the trunk. A stray leaf three
   * blocks away does not count, which keeps "a leaf someone placed next to a log pillar" from
   * turning the pillar into lumber.
   */
  const canopyStrong = canopy.found >= CANOPY_MIN;
  const canopyNear = canopy.found >= 1 && canopy.near >= 1;
  if (options.requireLeaves !== false && !canopyStrong && !canopyNear) {
    return {
      ok: false,
      why: canopy.visible === 0
        ? 'the area around the trunk is outside the scan, so I cannot confirm it is a tree'
        : 'the trunk has no leaves - it looks built rather than grown'
    };
  }

  // 5. One lone log is a decoration or a stump - only a stump with its canopy still standing
  //    is worth finishing. (A fully chopped tree leaves exactly this shape.)
  if (cluster.length < 2 && !canopyNear) {
    return { ok: false, why: 'a single isolated log - not a tree' };
  }

  return { ok: true, why: `rooted in ${baseName}` };
}

/**
 * Count canopy blocks around a log cluster.
 *
 * The box spans the cluster's bounding box plus a margin (3 blocks horizontally, 6 above the
 * highest log, 2 below the lowest), which covers every overworld tree shape we know: oak,
 * birch, spruce (including the 2x2 mega variant), jungle, acacia, dark oak, mangrove, cherry,
 * and the modded species that copy them.
 *
 * `near` counts canopy blocks within 2 columns of an actual log, so a pile of leaves dumped
 * on the ground next to a pillar does not by itself make it a tree.
 *
 * @param {(x:number,y:number,z:number) => (string|null)} at absolute block reader
 * @param {Array<{x:number,y:number,z:number}>} cluster
 * @param {object} [limits] { radius, up, down }
 * @returns {{found:number, visible:number, unknown:number, near:number}}
 */
function canopyAround(at, cluster, limits = {}) {
  const radius = limits.radius === undefined ? 3 : limits.radius;
  const up = limits.up === undefined ? 6 : limits.up;
  const down = limits.down === undefined ? 2 : limits.down;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const columns = new Map();
  for (const log of cluster) {
    minX = Math.min(minX, log.x);
    maxX = Math.max(maxX, log.x);
    minY = Math.min(minY, log.y);
    maxY = Math.max(maxY, log.y);
    minZ = Math.min(minZ, log.z);
    maxZ = Math.max(maxZ, log.z);
    const column = columns.get(`${log.x},${log.z}`) || { minY: log.y, maxY: log.y };
    column.minY = Math.min(column.minY, log.y);
    column.maxY = Math.max(column.maxY, log.y);
    columns.set(`${log.x},${log.z}`, column);
  }

  let found = 0;
  let visible = 0;
  let unknown = 0;
  let near = 0;
  for (let x = minX - radius; x <= maxX + radius; x += 1) {
    for (let z = minZ - radius; z <= maxZ + radius; z += 1) {
      for (let y = minY - down; y <= maxY + up; y += 1) {
        const name = at(x, y, z);
        if (name === null) {
          unknown += 1;
          continue;
        }
        visible += 1;
        if (!isCanopyName(name)) continue;
        found += 1;
        let isNear = false;
        for (let dx = -2; dx <= 2 && !isNear; dx += 1) {
          for (let dz = -2; dz <= 2; dz += 1) {
            const column = columns.get(`${x + dx},${z + dz}`);
            if (column && y >= column.minY - 1 && y <= column.maxY + up) {
              isNear = true;
              break;
            }
          }
        }
        if (isNear) near += 1;
      }
    }
  }
  return { found, visible, unknown, near };
}

/**
 * Relative-reader version kept for compatibility (the chop task and older callers).
 *
 * @param {(dx:number, dy:number, dz:number) => (string|null)} at relative block reader
 * @param {{position:{x:number,y:number,z:number}}} block any log of the column
 * @param {object} [limits] { radius, up, down }
 * @returns {{ok:boolean, why:string}}
 */
function findCanopy(at, block, limits = {}) {
  const bx = Math.floor(block.position.x);
  const by = Math.floor(block.position.y);
  const bz = Math.floor(block.position.z);
  const absAt = (x, y, z) => at(x - bx, y - by, z - bz);
  const cluster = [{ x: bx, y: by, z: bz }];
  for (let dy = 1; dy < 40; dy += 1) {
    const name = absAt(bx, by + dy, bz);
    if (name === null || !isLogName(name)) break;
    cluster.push({ x: bx, y: by + dy, z: bz });
  }
  for (let dy = 1; dy < 40; dy += 1) {
    const name = absAt(bx, by - dy, bz);
    if (name === null || !isLogName(name)) break;
    cluster.unshift({ x: bx, y: by - dy, z: bz });
  }
  const result = canopyAround(absAt, cluster, limits);
  if (result.found >= CANOPY_MIN || (result.found >= 1 && result.near >= 1)) {
    return { ok: true, why: 'has a canopy' };
  }
  return {
    ok: false,
    why: result.visible === 0
      ? 'the area around the trunk top is outside the scan, so I cannot confirm it is a tree'
      : 'the trunk has no leaves - it looks built rather than grown'
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
  CANOPY_MIN,
  LOG_FAMILY,
  manMadeReason,
  isNaturalGround,
  isWalkableVegetation,
  isClear,
  isLogName,
  isCanopyName,
  assessStandability,
  looksLikeTree,
  findCanopy,
  canopyAround,
  blockReader,
  ManMadeGuard,
  bare
};
