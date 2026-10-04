'use strict';

/**
 * Spatial grid: turn the block scan into a small ASCII map for the LLM.
 *
 * Follows numen's `spatial-perception.md` §3 - an agent-centric grid with semantic pooling
 * (each cell is a walkability symbol, not a block id), hazard inflation borrowed from ROS
 * costmaps, `?` for anything not loaded, and a Visualization-of-Thought cue in the header.
 * The evidence for the format is in that document: an egocentric semantic grid beat raw
 * images and flat coordinate lists by a wide margin in the cited studies.
 *
 * The renderer is pure - it takes a `read(x, y, z)` function and a position - so the same
 * code serves the real client-mod body, the mock body, and offline tests.
 */

const { bare } = require('./safety');

const SYMBOLS = Object.freeze({
  SELF: '@',
  WALK: '.',
  STEP_UP: '^',
  DROP: ',',
  CLIFF: 'v',
  BLOCKED: '#',
  TREE: 'T',
  WATER: '~',
  HAZARD: '!',
  HAZARD_BUFFER: 'x',
  UNKNOWN: '?'
});

const LEGEND =
  '@ you, . walkable, ^ step up, , drop 1-2, v drop 3+, # blocked, T tree, ' +
  '~ water, ! lava/fire/void, x hazard buffer, ? unknown';

const AIR = /^(air|cave_air|void_air)$/;
const WATER = /^(water|flowing_water)$/;
const HAZARD = /(lava|magma|campfire|fire)/;
const TREE = /(_log|_wood|_stem|leaves|wart_block)/;
/**
 * Anything the player can stand in / walk through. Deliberately generous for plants
 * (they do not stop movement) and strict for everything else: an unknown solid block is
 * `#`, which is the conservative answer for a walkability map.
 */
const NON_BLOCKING =
  /^(air|cave_air|void_air|water|flowing_water|lava|flowing_lava|short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|.*_flower|.*_sapling|torch|wall_torch|redstone_torch|soul_torch|.*_button|.*_pressure_plate|.*_carpet|.*_rail|.*_sign|.*_banner|wheat|.*_crop|carrots|potatoes|beetroots|kelp|seagrass|lily_pad|vine|snow|.*_plant)$/;

/**
 * @param {object} options
 * @param {(x:number,y:number,z:number) => string|null} options.read block name or null (unknown)
 * @param {{x:number,y:number,z:number}} options.position bot feet position (float)
 * @param {number} options.radius 4-16
 * @returns {{text:string, rows:string[], radius:number, position:{x:number,y:number,z:number}, legend:string}}
 */
function renderSpatialGrid({ read, position, radius }) {
  if (typeof read !== 'function') throw new Error('renderSpatialGrid needs a read function');
  if (!position) throw new Error('renderSpatialGrid needs a position');
  const r = Math.max(1, Math.min(16, Math.floor(Number(radius) || 8)));
  const cx = Math.floor(position.x);
  const cy = Math.floor(position.y);
  const cz = Math.floor(position.z);

  const at = (x, y, z) => {
    let name = null;
    try {
      name = read(x, y, z);
    } catch {
      name = null;
    }
    return typeof name === 'string' && name ? bare(name) : null;
  };

  const solid = (name) => name !== null && !AIR.test(name) && !NON_BLOCKING.test(name);
  const hazard = (name) => name !== null && HAZARD.test(name);

  /** First pass: classify each column. */
  const grid = [];
  for (let dz = -r; dz <= r; dz += 1) {
    const row = [];
    for (let dx = -r; dx <= r; dx += 1) {
      if (dx === 0 && dz === 0) {
        row.push(SYMBOLS.SELF);
        continue;
      }
      const x = cx + dx;
      const z = cz + dz;
      const feet = at(x, cy, z);
      const head = at(x, cy + 1, z);
      if (feet === null || head === null) {
        row.push(SYMBOLS.UNKNOWN);
        continue;
      }
      const floor = at(x, cy - 1, z);
      if (hazard(feet) || hazard(head) || hazard(floor)) {
        row.push(SYMBOLS.HAZARD);
        continue;
      }
      if (TREE.test(feet) || TREE.test(head)) {
        row.push(SYMBOLS.TREE);
        continue;
      }
      if (WATER.test(feet) || WATER.test(head)) {
        row.push(SYMBOLS.WATER);
        continue;
      }
      if (solid(feet) || solid(head)) {
        // A solid at the feet with a free head is a step a player can jump onto; a solid
        // head means there is no room even after stepping up.
        row.push(solid(head) ? SYMBOLS.BLOCKED : SYMBOLS.STEP_UP);
        continue;
      }
      if (floor === null) {
        row.push(SYMBOLS.UNKNOWN);
        continue;
      }
      if (WATER.test(floor)) {
        row.push(SYMBOLS.WATER);
        continue;
      }
      if (solid(floor)) {
        row.push(SYMBOLS.WALK);
        continue;
      }
      // Nothing solid right below: how far is the fall?
      let landed = false;
      for (let dy = 2; dy <= 3; dy += 1) {
        const below = at(x, cy - dy, z);
        if (below !== null && solid(below)) {
          landed = true;
          break;
        }
      }
      // Solid 1-2 blocks below is a step down; nothing within 3 (or unknown) is a cliff.
      row.push(landed ? SYMBOLS.DROP : SYMBOLS.CLIFF);
    }
    grid.push(row);
  }

  /** Second pass: hazard inflation (costmap-style) so the model keeps a berth. */
  for (let zi = 0; zi < grid.length; zi += 1) {
    for (let xi = 0; xi < grid[zi].length; xi += 1) {
      if (grid[zi][xi] === SYMBOLS.HAZARD || grid[zi][xi] === SYMBOLS.SELF) continue;
      let near = false;
      for (let zz = Math.max(0, zi - 1); zz <= Math.min(grid.length - 1, zi + 1) && !near; zz += 1) {
        for (let xx = Math.max(0, xi - 1); xx <= Math.min(grid[zi].length - 1, xi + 1); xx += 1) {
          if (grid[zz][xx] === SYMBOLS.HAZARD) {
            near = true;
            break;
          }
        }
      }
      if (near) grid[zi][xi] = SYMBOLS.HAZARD_BUFFER;
    }
  }

  const rows = grid.map((row, zi) => `z${(cz - r + zi >= 0 ? '+' : '')}${cz - r + zi} ${row.join('')}`);
  const header =
    `terrain ${2 * r + 1}x${2 * r + 1} around (${cx},${cy},${cz}); north (-z) up, east (+x) right; ` +
    `x from ${cx - r} to ${cx + r}`;
  const text = `${header}\n${LEGEND}\n${rows.join('\n')}`;

  return {
    text,
    rows,
    radius: r,
    position: { x: cx, y: cy, z: cz },
    legend: LEGEND
  };
}

module.exports = { renderSpatialGrid, SYMBOLS, LEGEND };
