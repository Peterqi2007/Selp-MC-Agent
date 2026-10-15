'use strict';

/**
 * `npm run path:test` - the offline acceptance test for deliverable A.
 *
 * This is the checkpoint the plan calls out after M1: **the pathfinding loop is proven
 * without touching Minecraft.** Each scenario builds a hand-written `blocks.cells` map,
 * feeds it to a fake body, and runs the real planner / walker / navigator.
 *
 * Scenario list comes from P0-PLAN §3.6. Pass condition: the five reachable scenarios all
 * succeed, the two unreachable ones fail *clearly* and do not hang.
 *
 * Why this matters more than it looks: pathfinding is the most intricate part of P0 and
 * the only part whose bugs are indistinguishable from "the world is weird". Being able to
 * reproduce a wall, a lake, a step and a dead end deterministically is what makes it
 * debuggable at all.
 */

const { PathPlanner, STATUS } = require('../src/pathfinding/planner');
const { WaypointWalker, WALK_REASON, mergeWaypoints } = require('../src/pathfinding/walker');
const { PathNavigator, NAV_REASON } = require('../src/pathfinding/navigator');
const { v3, distanceBetween } = require('../src/pathfinding/vec3util');
const { describeBlock } = require('../src/pathfinding/clientWorldAdapter');
const { COST } = require('../src/pathfinding/movementsAdapter');

// --------------------------------------------------------------------------- map building

const AIR = 'minecraft:air';
const GRASS = 'minecraft:grass_block';
const STONE = 'minecraft:stone';
const WATER = 'minecraft:water';
const LAVA = 'minecraft:lava';
const PLANKS = 'minecraft:oak_planks';

/**
 * Build a cell map.
 *
 * The subsurface matters more than it looks: a real scan reports the stone under the
 * grass, and `hasFloorAt()` uses it to decide whether a cell is standable. If the map has
 * air/unknown under the ground, water becomes impossible to *enter* (no floor under the
 * water cell) and every scenario involving liquid would be testing the wrong thing.
 *
 * @param {object} spec { radius, ground, groundY, depth, fill(put, x, y, z) }
 */
function buildMap(spec) {
  const radius = spec.radius === undefined ? 30 : spec.radius;
  const groundY = spec.groundY === undefined ? 63 : spec.groundY;
  const depth = spec.depth === undefined ? 4 : spec.depth;
  const cells = {};
  const put = (x, y, z, name) => {
    cells[`${x},${y},${z}`] = name;
  };

  for (let x = -radius; x <= radius; x += 1) {
    for (let z = -radius; z <= radius; z += 1) {
      for (let y = groundY - depth; y < groundY; y += 1) put(x, y, z, STONE);
      put(x, groundY, z, spec.ground || GRASS);
      for (let y = groundY + 1; y <= groundY + 8; y += 1) put(x, y, z, AIR);
    }
  }
  if (spec.fill) spec.fill(put);
  return { cells, groundY };
}

/**
 * A fake body that satisfies the Body contract's reading half, and moves instantly.
 *
 * `stepTowards` is deliberate: the walker is supposed to *observe* movement, so a body
 * that teleports on every moveto would make the stall detector untestable.
 *
 * `options.refuse(target, position, options)` models the thing the block scan cannot see:
 * the client's walker holds "forward" and jumps when it collides, so terrain that changed
 * since the snapshot - a hole someone dug, a fence, a step it cannot climb - makes the
 * *actual* move fail while the map still says the route is clear. Without it there is no
 * way to test the "stop jumping, go around" behaviour offline.
 */
function makeBody(cells, start, options = {}) {
  let position = { ...start };
  const snap = () => ({
    ready: true,
    body: 'mock',
    position: { ...position },
    dimension: 'minecraft:overworld',
    health: 20,
    food: 20,
    blocks: { cells }
  });
  return {
    isReady: true,
    snapshot: snap,
    setPosition(p) {
      position = { ...p };
    },
    get position() {
      return position;
    },
    /** Straight-line move: enough to exercise the walker without simulating physics. */
    async moveTo(target, opts = {}) {
      if (options.frozen) return false; // scenario 7: the bot cannot move
      if (options.refuse && options.refuse(target, position, opts)) return false;
      const dist = Math.hypot(target.x - position.x, target.z - position.z);
      if (dist < 0.01) return true;
      position = { x: target.x, y: target.y, z: target.z };
      return true;
    },
    async interrupt() {},
    async stopContinuous() {},
    async chat() {
      return true;
    },
    async dig() {
      return true;
    }
  };
}

// --------------------------------------------------------------------------- harness

const results = [];
function scenario(name, fn) {
  return (async () => {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail, ms: Date.now() - started });
      process.stdout.write(`  PASS  ${name}${detail ? ` - ${detail}` : ''}  (${Date.now() - started}ms)\n`);
    } catch (err) {
      results.push({ name, ok: false, detail: err.message, ms: Date.now() - started });
      process.stdout.write(`  FAIL  ${name} - ${err.message}  (${Date.now() - started}ms)\n`);
    }
  })();
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

// --------------------------------------------------------------------------- scenarios

(async () => {
  process.stdout.write('minecraft-survival-agent - offline pathfinding test\n');
  process.stdout.write('(P0-PLAN §3.6: reachable scenarios succeed, blocked ones fail clearly and never hang)\n\n');

  const log = { debug() {}, warn() {}, info() {} };

  // ---- 0. the shim itself -------------------------------------------------
  process.stdout.write('0. foundations\n');
  await scenario('vec3 shim provides the hash A* needs', () => {
    const a = v3(1.9, 2.1, 3.99);
    const b = v3(1.1, 2.9, 3.01);
    expect(typeof a.hash === 'string', `hash must be a string, got ${typeof a.hash}`);
    expect(a.hash === '1,2,3', `expected floor hash "1,2,3", got "${a.hash}"`);
    expect(a.hash === b.hash, 'positions inside the same block must share a hash');
    const c = v3(2, 2, 3);
    expect(a.hash !== c.hash, 'different blocks must hash differently');
    return `hash("${a.hash}") is block-granular`;
  });

  await scenario('block name -> movement properties', () => {
    const air = describeBlock('minecraft:air');
    const grass = describeBlock('minecraft:grass_block');
    const water = describeBlock('minecraft:water');
    const lava = describeBlock('minecraft:lava');
    expect(air.solid === false, 'air must not be solid');
    expect(grass.solid === true, 'grass_block must be solid');
    expect(water.liquid === true && water.solid === false, 'water must be liquid and not solid');
    expect(lava.dangerous === true, 'lava must be flagged dangerous');
    return 'air/grass/water/lava classified';
  });

  await scenario('modded block names are handled (namespace stripped)', () => {
    const cog = describeBlock('create:cogwheel');
    expect(cog.bare === 'cogwheel', `expected bare "cogwheel", got "${cog.bare}"`);
    expect(cog.solid === true, 'an unknown modded block should default to solid (conservative)');
    return 'create:cogwheel -> solid';
  });

  await scenario('solid is not the same as standable (fences are not floors)', () => {
    /**
     * The distinction that stops the bot jumping at a fence forever.
     *
     * A fence, a wall, a pane or a closed door is solid, and the cell above it is air - so a
     * model that only asks "is the block below solid?" happily plans "step up onto the fence".
     * The client then walks into it, presses jump on collision, and is still jumping a minute
     * later. Standability has to be its own property.
     */
    const fence = describeBlock('minecraft:oak_fence');
    const wall = describeBlock('minecraft:cobblestone_wall');
    const pane = describeBlock('minecraft:glass_pane');
    const bars = describeBlock('minecraft:iron_bars');
    const gate = describeBlock('minecraft:oak_fence_gate');
    const closedDoor = describeBlock('minecraft:oak_door');
    const stone = describeBlock('minecraft:stone');
    const slab = describeBlock('minecraft:stone_slab');
    const dirt = describeBlock('minecraft:dirt');

    for (const [label, block] of [['fence', fence], ['wall', wall], ['pane', pane], ['bars', bars], ['gate', gate], ['door', closedDoor]]) {
      expect(block.solid === true, `${label} must still count as an obstacle`);
      expect(block.standable === false, `${label} must NOT be a floor`);
    }
    expect(stone.standable === true, 'stone is a floor');
    expect(dirt.standable === true, 'dirt is a floor');
    // Slabs and stairs give you a real surface, so they must keep working as a floor.
    expect(slab.standable === true, 'a slab is still standable');
    expect(describeBlock('minecraft:oak_stairs').standable === true, 'stairs are still standable');
    const air = describeBlock('minecraft:air');
    expect(air.standable === false, 'air is not a floor');
    return 'fence/wall/pane/bars/gate/door -> solid but not standable; stone/slab/stairs -> standable';
  });

  // ---- 1. flat ground -----------------------------------------------------
  process.stdout.write('\n1. reachable scenarios\n');
  await scenario('1 flat ground: straight walk succeeds', async () => {
    const { cells } = buildMap({ radius: 30 });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const res = await planner.plan({ x: 10, y: 64, z: 0 });
    expect(res.status === STATUS.SUCCESS, `expected success, got ${res.status} (${res.reason})`);
    expect(res.path.length >= 9, `expected ~10 nodes, got ${res.path.length}`);
    expect(res.path.length <= 14, `path should be near-straight, got ${res.path.length} nodes`);
    return `${res.path.length} nodes, ${res.nodes} generated`;
  });

  // ---- 2. wall ------------------------------------------------------------
  await scenario('2 wall: routes around a 5-wide obstruction', async () => {
    // A wall spanning z=-2..2 at x=6, three blocks tall so it must be gone around.
    const { cells } = buildMap({
      radius: 30,
      fill: (put) => {
        for (let z = -2; z <= 2; z += 1) {
          for (let y = 64; y <= 66; y += 1) put(6, y, z, STONE);
        }
      }
    });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const res = await planner.plan({ x: 12, y: 64, z: 0 });
    expect(res.status === STATUS.SUCCESS, `expected success, got ${res.status} (${res.reason})`);
    // Going around must cost more than the straight-line 12.
    expect(res.path.length > 12, `detour should exceed the straight line, got ${res.path.length}`);
    const passesWallColumn = res.path.some((n) => n.x === 6 && Math.abs(n.z) <= 2);
    expect(!passesWallColumn, 'path must not go through the wall');
    return `${res.path.length} nodes, detoured around x=6`;
  });

  // ---- 3. water -----------------------------------------------------------
  await scenario('3 water: crossing needs swim, and reports noPath without it', async () => {
    // A lake spanning the *whole* map width in z, so "walk around it" is not an option and
    // the scenario really tests liquid traversal rather than detouring.
    const lake = (put) => {
      for (let x = 3; x <= 7; x += 1) {
        for (let z = -30; z <= 30; z += 1) {
          put(x, 63, z, WATER);
          put(x, 64, z, WATER);
        }
      }
    };

    const body = makeBody(buildMap({ radius: 30, fill: lake }).cells, { x: 0, y: 64, z: 0 });
    const swimPlanner = new PathPlanner(body, { log, allowSwim: true });
    const ok = await swimPlanner.plan({ x: 10, y: 64, z: 0 });
    expect(ok.status === STATUS.SUCCESS, `swim allowed should succeed, got ${ok.status} (${ok.reason})`);
    const crossedWater = ok.path.some((n) => n.x >= 3 && n.x <= 7);
    expect(crossedWater, 'the successful route should actually cross the lake');

    const dryPlanner = new PathPlanner(body, { log, allowSwim: false });
    const blocked = await dryPlanner.plan({ x: 10, y: 64, z: 0 });
    expect(
      blocked.status === STATUS.NO_PATH,
      `swim disabled across a full-width lake must be noPath, got ${blocked.status} (${blocked.reason})`
    );
    return `swim=${ok.status}(${ok.path.length}n, crosses lake) noswim=${blocked.status}`;
  });

  // ---- 4. steps -----------------------------------------------------------
  await scenario('4 steps: climbs a 4-level hill onto a plateau', async () => {
    // Rises one block per two columns, then levels off, so the goal sits on top of the hill
    // and the only way there is up.
    const hill = (put) => {
      for (let z = -6; z <= 6; z += 1) {
        for (let x = 4; x <= 12; x += 1) {
          const top = x <= 5 ? 64 : x <= 7 ? 65 : x <= 9 ? 66 : 67;
          for (let y = 64; y <= top; y += 1) put(x, y, z, STONE);
        }
      }
    };
    const body = makeBody(buildMap({ radius: 30, fill: hill }).cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const res = await planner.plan({ x: 11, y: 68, z: 0 });
    expect(res.status === STATUS.SUCCESS, `expected success climbing, got ${res.status} (${res.reason})`);
    const maxY = Math.max(...res.path.map((n) => n.y));
    expect(maxY >= 68, `path should climb to the plateau, max y was ${maxY}`);
    // Every rise must be exactly one block - a bigger jump would not be walkable.
    for (let i = 1; i < res.path.length; i += 1) {
      const rise = res.path[i].y - res.path[i - 1].y;
      expect(rise <= 1, `step of ${rise} blocks at node ${i} is not walkable`);
    }
    return `${res.path.length} nodes, climbed to y=${maxY}`;
  });

  // ---- 5. dead end --------------------------------------------------------
  await scenario('5 dead end: sealed chamber reports noPath (does not hang)', async () => {
    // A hollow stone block with the goal in the cavity. Shell is 2 blocks thick on every
    // side plus a roof, so there is genuinely no route and the planner must say so.
    const chamber = (put) => {
      for (let x = 8; x <= 14; x += 1) {
        for (let z = -6; z <= 6; z += 1) {
          for (let y = 64; y <= 70; y += 1) {
            const cavity = x >= 10 && x <= 12 && z >= -4 && z <= 4 && y <= 67;
            if (!cavity) put(x, y, z, STONE);
          }
        }
      }
    };
    const body = makeBody(buildMap({ radius: 30, fill: chamber }).cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log, nodeTimeoutMs: 2000 });
    const started = Date.now();
    const res = await planner.plan({ x: 11, y: 64, z: 0 });
    const elapsed = Date.now() - started;
    expect(res.status !== STATUS.SUCCESS, `a sealed chamber must not report success (got ${res.status})`);
    expect(elapsed < 12000, `must fail promptly, took ${elapsed}ms`);
    return `${res.status} in ${elapsed}ms (${res.reason})`;
  });

  // ---- 6. out of grid -----------------------------------------------------
  await scenario('6 out of grid: distant target reports out-of-grid, and offers a dry subgoal', async () => {
    const { cells } = buildMap({ radius: 30 });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const far = { x: 40, y: 64, z: 0 };
    const res = await planner.plan(far);
    expect(res.status === STATUS.OUT_OF_GRID, `expected out-of-grid, got ${res.status}`);
    /**
     * The replacement for the old blind `toward()` step: a *validated* cell inside the grid,
     * on the line to the target, as far toward it as the scan allows. It must be a cell the
     * movement model would accept - dry, occupiable, with a floor - because the navigator
     * plans to it rather than walking at it.
     */
    const subgoal = planner.pickSubgoal(far);
    expect(subgoal, 'a flat map must offer a subgoal toward a far target');
    expect(subgoal.x > 0 && subgoal.x <= 23, `subgoal should sit inside the grid toward the target, got x=${subgoal.x}`);
    expect(planner.isUsableSubgoal(subgoal), 'the chosen subgoal must satisfy the movement model');
    const hop = await planner.plan(subgoal);
    expect(hop.status === STATUS.SUCCESS, `the subgoal must be plannable, got ${hop.status} (${hop.reason})`);
    return `status=${res.status}, subgoal=(${subgoal.x},${subgoal.y},${subgoal.z}) -> ${hop.status} in ${hop.path.length} nodes`;
  });

  // ---- 7. stuck -----------------------------------------------------------
  await scenario('7 stuck: frozen body is detected as blocked, not waited on forever', async () => {
    const { cells } = buildMap({ radius: 30 });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 }, { frozen: true });
    const walker = new WaypointWalker(body, { log, stallThreshold: 2 });
    const path = [];
    for (let i = 1; i <= 8; i += 1) path.push(v3(i, 64, 0));
    const started = Date.now();
    const res = await walker.walk(path, { timeoutMs: 10000 });
    const elapsed = Date.now() - started;
    expect(res.ok === false, 'a frozen body must not report arrival');
    expect(
      res.reason === WALK_REASON.BLOCKED || res.reason === WALK_REASON.NO_PROGRESS,
      `expected blocked/no-progress, got ${res.reason}`
    );
    expect(elapsed < 3000, `stall detection should be fast, took ${elapsed}ms`);
    return `${res.reason} detected in ${elapsed}ms`;
  });

  // ---- extra: waypoint merging -------------------------------------------
  process.stdout.write('\n2. supporting behaviour\n');

  await scenario('a fence line is never something to climb: the plan says noPath instead', async () => {
    /**
     * The field failure this whole round started from, in its most common shape: a fence
     * between the bot and where it wants to go.
     *
     * Before standability existed, the movement model saw "solid block at feet level, air
     * above it" and produced a `step-up` onto the fence top. The plan looked perfectly
     * reasonable, the client could not execute it, and the result was a bot jumping at a
     * fence until the 60s timeout - repeatedly, because every replan said the same thing.
     * `noPath` is the honest answer: go around, or pick another target.
     */
    const { cells } = buildMap({ radius: 20 });
    const put = (x, y, z, name) => {
      cells[`${x},${y},${z}`] = name;
    };
    // A fence right across the map at x=4, with air above each fence block (which is exactly
    // how a real fence looks in the scan).
    for (let z = -20; z <= 20; z += 1) put(4, 64, z, 'minecraft:oak_fence');

    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const res = await planner.plan({ x: 10, y: 64, z: 0 });

    expect(res.status !== STATUS.SUCCESS, `a fence must not be planned over, got ${res.status}`);
    expect(res.status === STATUS.NO_PATH, `expected noPath, got ${res.status} (${res.reason})`);
    const climbed = res.path.some((n) => n.y > 64 && n.x === 4);
    expect(!climbed, `the path must never step up onto the fence: ${JSON.stringify(res.path)}`);
    const neighbours = planner.movements.getNeighbors(v3(3, 64, 0));
    expect(
      !neighbours.some((n) => n.x === 4 && n.y === 65),
      'stepping up onto a fence must not even be a candidate move'
    );
    return `${res.status} (${res.reason}) - fence is an obstacle, not a step`;
  });

  await scenario('waypoint merging collapses a straight corridor', () => {
    const path = [];
    for (let i = 1; i <= 30; i += 1) path.push(v3(i, 64, 0));
    const merged = mergeWaypoints(path, 1);
    expect(merged.length <= 3, `30 collinear nodes should merge to <=3 legs, got ${merged.length}`);
    const withTurn = [v3(1, 64, 0), v3(2, 64, 0), v3(3, 64, 0), v3(3, 64, 1), v3(3, 64, 2)];
    const mergedTurn = mergeWaypoints(withTurn, 1);
    expect(mergedTurn.length >= 2, `a turn must not be merged away, got ${mergedTurn.length}`);
    const withStep = [v3(1, 64, 0), v3(2, 64, 0), v3(2, 65, 0), v3(2, 66, 0)];
    const mergedStep = mergeWaypoints(withStep, 1);
    expect(mergedStep.length >= 2, `a step must not be merged away, got ${mergedStep.length}`);
    return `straight ${path.length}->${merged.length}, turn ${withTurn.length}->${mergedTurn.length}, step ${withStep.length}->${mergedStep.length}`;
  });

  // ---- 8. how a move is performed ----------------------------------------
  await scenario('8 move tags: the movement model says HOW each neighbour is reached', () => {
    /**
     * The tag is the only surviving evidence of the client's problem. A leg the bot walks
     * and a leg that needs a jump are the same command to the mod, so without this the
     * walker cannot tell "replan, the snapshot is stale" from "this jump does not work".
     */
    const { cells } = buildMap({ radius: 10 });
    const put = (x, y, z, name) => {
      cells[`${x},${y},${z}`] = name;
    };
    /**
     * One feature per cardinal direction from (0,64,0), because that is exactly how the
     * movement model probes: straight across, then one step up, then down, then a 2-block
     * jump. Two features in the same direction would hide each other.
     */
    // +x: a 1-block step (the cell itself is solid rock, so arriving means standing at y=65).
    put(1, 64, 0, STONE);
    // +z: water on the normal grass floor - walkable, but it is a swim, not a walk.
    put(0, 64, 1, WATER);
    // -z: a bottomless-looking hole (deeper than MAX_DROP = 3), so the only way over is a jump.
    for (let y = 59; y <= 64; y += 1) put(0, y, -1, AIR);
    // The drop is probed from a different origin, since all four directions are now taken.
    put(10, 63, 0, AIR);

    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const neighbours = planner.movements.getNeighbors(v3(0, 64, 0));
    const tagAt = (list, x, y, z) => {
      const found = list.find((n) => n.x === x && n.y === y && n.z === z);
      return found ? found.move : `(no neighbour at ${x},${y},${z})`;
    };

    expect(tagAt(neighbours, -1, 64, 0) === 'walk', `flat ground should be a walk, got ${tagAt(neighbours, -1, 64, 0)}`);
    expect(tagAt(neighbours, 1, 65, 0) === 'step-up', `a 1-block step up should be step-up, got ${tagAt(neighbours, 1, 65, 0)}`);
    expect(tagAt(neighbours, 0, 64, -2) === 'jump', `a 4-deep hole should need a jump, got ${tagAt(neighbours, 0, 64, -2)}`);
    expect(tagAt(neighbours, 0, 64, 1) === 'swim', `water should be swim, got ${tagAt(neighbours, 0, 64, 1)}`);
    expect(neighbours.every((n) => typeof n.move === 'string'), 'every neighbour must carry a tag');

    const dropNeighbours = planner.movements.getNeighbors(v3(9, 64, 0));
    expect(tagAt(dropNeighbours, 10, 63, 0) === 'drop', `a 1-deep step down should be drop, got ${tagAt(dropNeighbours, 10, 63, 0)}`);
    return `${neighbours.length} neighbours, tags: walk/step-up/jump/swim/drop`;
  });

  await scenario('a jump is never merged into the walk next to it', () => {
    // Same heading, same height: a 1-block gap jump looks exactly like a longer walk, so
    // without the move-kind break it would be merged - and then the client would try to
    // *walk* over the gap while the walker lost the evidence that a jump was needed.
    const path = [
      { ...v3(1, 64, 0), move: 'walk' },
      { ...v3(2, 64, 0), move: 'walk' },
      { ...v3(3, 64, 0), move: 'walk' },
      { ...v3(5, 64, 0), move: 'jump' },
      { ...v3(6, 64, 0), move: 'walk' },
      { ...v3(7, 64, 0), move: 'walk' }
    ];
    const merged = mergeWaypoints(path, 1);
    const jumpLeg = merged.find((n) => n.move === 'jump');
    expect(jumpLeg && jumpLeg.x === 5, `the jump must survive as its own leg, got ${JSON.stringify(merged)}`);
    const untagged = mergeWaypoints(path.map(({ move, ...rest }) => rest), 1);
    expect(
      merged.length > untagged.length,
      `the tag must change the outcome: tagged ${merged.length} legs vs untagged ${untagged.length}`
    );
    expect(!untagged.some((n) => n.move), 'without tags there is nothing to merge around');
    return `${path.length} nodes -> ${merged.length} legs (${untagged.length} untagged), jump kept at x=5`;
  });

  await scenario('9 repeated failed jumps stop being jumps: jump-blocked, not jump-forever', async () => {
    /**
     * The reported symptom. The client presses jump whenever it collides, so a step it
     * cannot climb becomes an endless pogo. The walker must stop asking for the same jump
     * and say *why*, because "blocked" and "this jump will never work" need different
     * answers from the navigator.
     */
    const { cells } = buildMap({ radius: 10 });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 }, { frozen: true });
    const walker = new WaypointWalker(body, { log, stallThreshold: 2, jumpStreakLimit: 2 });
    const jumpLeg = { ...v3(2, 64, 0), move: 'jump' };

    const first = await walker.walk([jumpLeg], { timeoutMs: 5000 });
    expect(first.ok === false, 'a jump that does not move us cannot be an arrival');
    expect(first.reason !== WALK_REASON.JUMP_BLOCKED, `one failure is not yet a verdict, got ${first.reason}`);

    const second = await walker.walk([jumpLeg], { timeoutMs: 5000 });
    expect(
      second.reason === WALK_REASON.JUMP_BLOCKED,
      `the second failed jump must report jump-blocked, got ${second.reason}`
    );

    // ...and a jump that works clears the verdict, so a later stall is judged on its own.
    const movingBody = makeBody(cells, { x: 0, y: 64, z: 0 });
    const movingWalker = new WaypointWalker(movingBody, { log, jumpStreakLimit: 2 });
    const good = await movingWalker.walk([{ ...v3(2, 64, 0), move: 'jump' }], { timeoutMs: 5000 });
    expect(good.ok === true, `a jump the body can do must arrive, got ${good.reason}`);
    expect(movingWalker.jumpStreak === 0, 'a successful jump must reset the streak');
    return `${first.reason} -> ${second.reason}, cleared by a jump that worked`;
  });

  await scenario('10a blocked route: the cell that cannot be reached is ruled out, and the next plan goes around it', async () => {
    /**
     * The end-to-end version of the reported bug, with the terrain lying to the planner.
     *
     * The map has a 1-wide, 4-deep hole at (4,64,0) - shallow enough for A* to jump it, which
     * the client cannot do (it walks straight in). Replanning from the same cell therefore
     * re-derives the identical route, forever: the snapshot never changes, so A* has no
     * reason to answer differently. Learning "I cannot get to (5,64,0)" is what turns the
     * retry into a *different* plan, and that is what gets the bot around the hole.
     */
    const { cells } = buildMap({ radius: 20 });
    for (let y = 59; y <= 64; y += 1) cells[`4,${y},0`] = AIR;

    /** The client's blind walker: it cannot cross the hole, whatever the map says. */
    const refuse = (target, position) => position.x < 4 && target.z === 0 && target.x > 4;

    const body = makeBody(cells, { x: 0, y: 64, z: 0 }, { refuse });
    const nav = new PathNavigator(body, { log, replanEvery: 12, maxSidesteps: 2 });
    const res = await nav.goTo({ x: 10, y: 64, z: 0 }, { range: 1.5, timeoutMs: 20000 });
    expect(res.ok === true, `the detour should get around the hole, got ${res.reason}`);
    expect(
      nav.planner.movements.avoid && nav.planner.movements.avoid.size >= 1,
      'the unreachable cell must have been remembered'
    );
    const final = distanceBetween(body.position, { x: 10, y: 64, z: 0 });
    expect(final <= 2, `should end within 2 blocks of the goal, was ${final.toFixed(2)}`);
    return `arrived from (${body.position.x},${body.position.z}) in ${res.iterations} iterations, ${nav.planner.movements.avoid.size} cell(s) ruled out`;
  });

  await scenario('10b sidestep: a blocked route is answered with a standable step at an angle', () => {
    /**
     * The other half of the recovery: when the bot has to *move* before a new plan is
     * possible, the step has to be sideways. Straight ahead is the blocked direction, so a
     * "sidestep" along the line of travel would be no change at all.
     *
     * Every candidate is validated against the movement model's own rules, which is the part
     * worth locking down: a detour must never be able to walk the bot into lava, off the
     * scan grid, or onto someone's build.
     */
    const { cells } = buildMap({ radius: 20 });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const nav = new PathNavigator(body, { log });
    const target = { x: 20, y: 64, z: 0 };

    const tried = new Set();
    const side = nav.sidestep(target, tried, 'jump-blocked');
    expect(side, 'open ground must offer a sidestep');
    expect(side.z !== 0, `travelling along +x, the sidestep must go sideways in z, got z=${side.z}`);
    expect(nav.planner.world.inGrid(side), 'the sidestep must stay inside the scan grid');
    expect(
      nav.planner.movements.canStandAt(side) && nav.planner.movements.hasFloorAt(side),
      `the sidestep must be somewhere the bot can stand: ${JSON.stringify(side)}`
    );
    expect(side.hash !== undefined, 'the sidestep must carry its hash, so it can be remembered');

    const again = nav.sidestep(target, tried, 'blocked');
    expect(again && again.hash !== side.hash, 'the same detour must not be chosen twice in a row');

    // With every perpendicular cell taken by a build, the sideways step must be refused
    // rather than walked onto someone's floor.
    for (const z of [-3, -2, -1, 1, 2, 3]) cells[`0,63,${z}`] = 'minecraft:oak_planks';
    const fresh = new PathNavigator(makeBody(cells, { x: 0, y: 64, z: 0 }), { log });
    const blockedSide = fresh.sidestep({ x: 0, y: 64, z: 20 }, new Set(), 'blocked');
    const floor = blockedSide
      ? fresh.planner.world.blockAt(v3(blockedSide.x, blockedSide.y - 1, blockedSide.z))
      : null;
    expect(!floor || !/planks/.test(floor.name), `a sidestep must not aim at a built floor, got ${JSON.stringify(blockedSide)}`);
    return `sidestep -> (${side.x},${side.z}), next -> (${again.x},${again.z}), planks guarded`;
  });

  await scenario('10c no detour exists: the navigator fails cleanly instead of looping', async () => {
    // The honest half of the same feature. When every direction is blocked there is nothing
    // left to try, and the answer must be a clear failure in bounded time - "it kept trying"
    // is the bug being fixed here, so it must not be replaced by "it kept trying, differently".
    const { cells } = buildMap({ radius: 20 });
    const refuse = (target, position) => position.x < 4 && target.x > 4;
    const body = makeBody(cells, { x: 0, y: 64, z: 0 }, { refuse });
    const nav = new PathNavigator(body, { log, replanEvery: 12, maxSidesteps: 2, maxIterations: 8 });
    const started = Date.now();
    const res = await nav.goTo({ x: 10, y: 64, z: 0 }, { range: 1.5, timeoutMs: 20000 });
    const elapsed = Date.now() - started;
    expect(res.ok === false, `a sealed route must not report arrival, got ${res.reason}`);
    expect(elapsed < 15000, `must give up promptly, took ${elapsed}ms`);
    expect(res.iterations <= 8, `must respect maxIterations, used ${res.iterations}`);
    expect(nav.stats.sidesteps <= 2, `sidesteps must stay bounded, used ${nav.stats.sidesteps}`);
    return `${res.reason} in ${res.iterations} iterations / ${elapsed}ms, ${nav.stats.sidesteps} sidestep(s)`;
  });

  await scenario('navigator walks a planned route to the goal', async () => {
    const { cells } = buildMap({ radius: 30 });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const nav = new PathNavigator(body, { log, replanEvery: 6 });
    const res = await nav.goTo({ x: 12, y: 64, z: 4 }, { range: 1.5, timeoutMs: 20000 });
    expect(res.ok === true, `navigator should arrive, got ${res.reason}`);
    const final = distanceBetween(body.position, { x: 12, y: 64, z: 4 });
    expect(final <= 2, `should end within 2 blocks, was ${final.toFixed(2)}`);
    return `arrived in ${res.iterations} iteration(s), ${final.toFixed(2)} blocks away`;
  });

  await scenario('navigator steps toward an out-of-grid target (iterative replanning)', async () => {
    const { cells } = buildMap({ radius: 40 });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const nav = new PathNavigator(body, { log, replanEvery: 10 });
    const res = await nav.goTo({ x: 35, y: 64, z: 0 }, { range: 2, timeoutMs: 25000 });
    expect(res.ok === true, `should close a 35-block gap across replans, got ${res.reason}`);
    expect(res.iterations >= 2, `expected multiple plan/walk cycles, got ${res.iterations}`);
    return `arrived in ${res.iterations} iterations`;
  });

  await scenario('lava is never entered even when it blocks the way', async () => {
    const lava = (put) => {
      for (let x = 3; x <= 7; x += 1) {
        for (let z = -30; z <= 30; z += 1) {
          put(x, 63, z, LAVA);
          put(x, 64, z, LAVA);
        }
      }
    };
    const body = makeBody(buildMap({ radius: 30, fill: lava }).cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const res = await planner.plan({ x: 12, y: 64, z: 0 });
    expect(res.status !== STATUS.SUCCESS, `must not route through lava, got ${res.status}`);
    const anyLavaNode = res.path.some((n) => n.x >= 3 && n.x <= 7);
    expect(!anyLavaNode, 'no path node may sit inside the lava span');
    return `${res.status} (lava refused)`;
  });

  // ---- 11. beyond the scan grid: subgoal hopping instead of blind walking ----------
  //
  // Live 2026-10-14: asked to cross a river, the bot walked into the water instead of over
  // the bridge that was six blocks away. The cause was not the cost model but the fallback:
  // a target beyond the 24-block scan grid made the navigator take a straight-line step with
  // the target's own y and no terrain check (`planner.toward()`), so A* was never asked the
  // question at all. These scenarios pin the replacement: a *validated* dry subgoal inside
  // the grid, planned to with A*, with a +/-5 neighbour search when that plan fails.

  /** Instrument a body so every leg it is asked to walk is recorded, with where it started. */
  function recordLegs(body) {
    const legs = [];
    const original = body.moveTo.bind(body);
    body.moveTo = async (target, opts = {}) => {
      const from = { ...body.snapshot().position };
      legs.push({ ...target, raw: opts.raw === true, from });
      return original(target, opts);
    };
    return legs;
  }

  /** Flat map with a north-south river at x in [riverX0, riverX1] and a plank bridge. */
  function riverMap(spec) {
    const { radius, riverX0, riverX1, bridgeZ } = spec;
    return buildMap({
      radius,
      fill: (put) => {
        for (let x = riverX0; x <= riverX1; x += 1) {
          for (let z = -radius; z <= radius; z += 1) put(x, 63, z, WATER);
        }
        if (bridgeZ !== undefined) {
          for (let x = riverX0 - 1; x <= riverX1 + 1; x += 1) {
            put(x, 63, bridgeZ, PLANKS);
            put(x, 64, bridgeZ, AIR);
          }
        }
      }
    });
  }

  await scenario('11a beyond the grid: hops through dry subgoals, and never steps past the scan', async () => {
    const { cells } = riverMap({ radius: 40, riverX0: 6, riverX1: 9, bridgeZ: 6 });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const legs = recordLegs(body);
    const plans = [];
    const nav = new PathNavigator(body, {
      log,
      // `avoidManMade` is the planner/walker key (the operator's world has it false);
      // `allowManMade` is the *body's* navigator picker and is not what the planner reads.
      avoidManMade: false,
      trace: (rec) => {
        if (rec.kind === 'plan') plans.push(rec);
        if (rec.kind === 'subgoal' || rec.kind === 'subgoal-try') plans.push(rec);
      }
    });
    const res = await nav.goTo({ x: 35, y: 64, z: 0 }, { range: 2, timeoutMs: 30000 });

    expect(res.ok === true, `a 35-block trip across flat ground must still arrive, got ${res.reason}`);
    const hops = plans.filter((p) => p.kind === 'subgoal');
    expect(hops.length >= 1, 'the trip must have been carried out as subgoal hops');
    /**
     * The property that was broken: no leg may ever be aimed at terrain outside the scan.
     * That is what "do not walk blindly" means operationally - the old code issued legs up
     * to 20 blocks toward a target nobody had observed, and the leg carried the target's y.
     */
    const scan = 24;
    const blind = legs.filter((leg) => Math.hypot(leg.x - leg.from.x, leg.z - leg.from.z) > scan);
    expect(blind.length === 0, `no leg may leave the scan grid, got ${JSON.stringify(blind.slice(0, 2))}`);
    for (const hop of hops) {
      const chosen = hop.chosen;
      const distance = Math.hypot(chosen.x - 0, chosen.z - 0);
      expect(distance <= scan, `subgoal (${chosen.x},${chosen.z}) would be outside the grid`);
    }
    return `arrived in ${hops.length} hop(s), ${legs.length} leg(s), none beyond ${scan} blocks`;
  });

  await scenario('11b the ray lands in water: the subgoal slides back to dry land', async () => {
    // Everything east of x=2 is water, so the farthest cell on the line is wet: the subgoal
    // has to walk back toward the bot until the movement model accepts a cell.
    const { cells } = buildMap({
      radius: 40,
      fill: (put) => {
        for (let x = 2; x <= 40; x += 1) {
          for (let z = -40; z <= 40; z += 1) put(x, 63, z, WATER);
        }
      }
    });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const subgoal = planner.pickSubgoal({ x: 40, y: 64, z: 0 });
    expect(subgoal, 'there is dry land behind the water, so a subgoal must exist');
    expect(subgoal.x <= 1, `the subgoal must slide back to the last dry cell, got x=${subgoal.x}`);
    expect(planner.isUsableSubgoal(subgoal), 'the slid-back subgoal must satisfy the movement model');
    const blocked = planner.pickSubgoal({ x: 40, y: 64, z: 0 }, { maxDistance: 1 });
    expect(blocked && blocked.x <= 1, 'even a one-cell reach must stay on dry land');
    return `water from x=2 -> subgoal (${subgoal.x},${subgoal.y},${subgoal.z})`;
  });

  await scenario('11c primary subgoal unreachable: the +/-5 neighbours are tried instead', async () => {
    /**
     * A full-width wall at x=22: the subgoal on the ray (x=23) is dry and standable but
     * cannot be reached, while cells just short of the wall can. This is the case the
     * operator asked for - "if pathfinding finds nothing, pick points within +/-5 blocks".
     */
    const { cells } = buildMap({
      radius: 40,
      fill: (put) => {
        for (let z = -40; z <= 40; z += 1) {
          put(22, 64, z, STONE);
          put(22, 65, z, STONE);
        }
      }
    });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const far = { x: 40, y: 64, z: 0 };
    const primary = planner.pickSubgoal(far);
    expect(primary && primary.x === 23, `expected the ray subgoal at x=23, got ${JSON.stringify(primary)}`);
    const blocked = await planner.plan(primary);
    expect(blocked.status !== STATUS.SUCCESS, `x=23 is sealed off, planning there must fail, got ${blocked.status}`);

    const candidates = planner.subgoalCandidates(primary, far, { radius: 5, max: 8 });
    expect(candidates.length > 0, 'the +/-5 neighbourhood must offer alternatives');
    for (const candidate of candidates) {
      expect(Math.abs(candidate.x - primary.x) <= 5 && Math.abs(candidate.z - primary.z) <= 5, 'candidate escaped the +/-5 box');
      expect(planner.isUsableSubgoal(candidate), `candidate (${candidate.x},${candidate.y},${candidate.z}) is not usable`);
      expect(candidate.distance < 40, 'candidates must be closer to the target than the bot');
    }
    const reachable = [];
    for (const candidate of candidates) {
      const res = await planner.plan(candidate);
      if (res.status === STATUS.SUCCESS) reachable.push(candidate);
    }
    expect(reachable.length > 0, 'at least one neighbour subgoal must be plannable (this side of the wall)');
    expect(reachable.every((c) => c.x < 22), `the wall is solid, so reachable subgoals must sit west of it, got ${JSON.stringify(reachable)}`);

    // And the navigator as a whole must make progress rather than reporting out-of-grid.
    // Range defaults to 1 here on purpose: with a wider goal tolerance A* legitimately
    // "reaches" the sealed subgoal from a cell on the near side of the wall, and the
    // neighbour search would never be exercised.
    const navBody = makeBody(cells, { x: 0, y: 64, z: 0 });
    const tried = [];
    const nav = new PathNavigator(navBody, {
      log,
      avoidManMade: false,
      trace: (rec) => {
        if (rec.kind === 'subgoal-try') tried.push(rec);
      },
      subgoalMaxAttempts: 8
    });
    await nav.goTo(far, { timeoutMs: 20000 });
    expect(navBody.position.x >= 15, `the bot should have closed on the wall, stopped at x=${navBody.position.x}`);
    expect(tried.length >= 1, 'the unreachable primary subgoal must be recorded as a failed try');
    return `primary x=23 unreachable -> ${reachable.length} neighbour(s) plannable, bot reached x=${navBody.position.x}`;
  });

  await scenario('11d no subgoal can be planned: honest out-of-grid, and the bot does not move', async () => {
    /**
     * A walled box: the subgoals on the ray are perfectly good *cells* (flat grass, dry,
     * standable) but nothing outside the box can be planned to. This is the case where the
     * old code walked blindly for 8-20 blocks; the contract now is to report `out-of-grid`
     * without issuing a single leg.
     */
    const { cells } = buildMap({
      radius: 40,
      fill: (put) => {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          put(dx, 64, dz, STONE);
          put(dx, 65, dz, STONE);
        }
        put(0, 66, 0, STONE); // and a lid, so not even a jump can help
      }
    });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const legs = recordLegs(body);
    const planner = new PathPlanner(body, { log, avoidManMade: false });
    const far = { x: 40, y: 64, z: 0 };
    expect(planner.pickSubgoal(far), 'the fixture must offer usable subgoals (the box is the obstacle)');
    expect(planner.subgoalCandidates(planner.pickSubgoal(far), far, { radius: 5, max: 8 }).length > 0, 'the box must have usable neighbours too');

    const nav = new PathNavigator(body, { log, avoidManMade: false });
    const res = await nav.goTo(far, { range: 2, timeoutMs: 10000 });
    expect(res.ok === false, 'an unreachable horizon must not be reported as arrival');
    expect(res.reason === NAV_REASON.OUT_OF_GRID, `expected out-of-grid, got ${res.reason}`);
    expect(body.position.x === 0 && body.position.z === 0, `the bot must not move, ended at ${JSON.stringify(body.position)}`);
    expect(legs.length === 0, `no leg may be issued when no subgoal is plannable, got ${JSON.stringify(legs)}`);
    return `${res.reason} in ${res.iterations} iteration(s), 0 legs issued`;
  });

  await scenario('11e plants are not obstacles: sugar cane and tall grass do not block a subgoal', async () => {
    const { cells } = buildMap({
      radius: 40,
      fill: (put) => {
        put(23, 64, 0, 'minecraft:sugar_cane'); // the cell the subgoal wants to occupy
        put(23, 65, 0, 'minecraft:tall_grass'); // and the head cell
        put(21, 64, 0, STONE); // a solid block instead: this one must be stepped around
      }
    });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    expect(planner.isUsableSubgoal(v3(23, 64, 0)), 'sugar cane is passable - it must not veto a subgoal');
    expect(!planner.isUsableSubgoal(v3(21, 64, 0)), 'a solid block at the feet must veto a subgoal');
    const subgoal = planner.pickSubgoal({ x: 40, y: 64, z: 0 });
    expect(subgoal && subgoal.x === 23, `the subgoal should still be the farthest cell, got ${JSON.stringify(subgoal)}`);
    return `sugar cane accepted at x=23, stone refused at x=21, subgoal=(23,${subgoal.y},0)`;
  });

  // ---- 11f/11g. the wandering regression (live 2026-10-15) -----------------
  //
  // On the live server the bot "walked at random": one-block hops that creased sideways. The
  // cause was the subgoal search's *vertical* window - it probed only the straight line's own
  // height (and the bot's, +/-1), so across a height change every column failed the occupancy
  // test and the search slid all the way back to the bot's own ledge. The navigator then got a
  // subgoal 2-6 blocks away, which the goal tolerance reported as "already there"; the +/-5
  // fallback answered that with lateral cells just outside the tolerance, and the bot wandered
  // a block at a time. The fix probes the whole visible column (-8..+8) and refuses to treat an
  // "already there" answer as a reason to look sideways.

  /** A plateau at y=65 with a one-block staircase down to low ground at y=61. */
  function cliffMap({ radius = 40 } = {}) {
    const cells = {};
    const put = (x, y, z, name) => {
      cells[`${x},${y},${z}`] = name;
    };
    for (let x = -radius; x <= radius; x += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        for (let y = 56; y <= 60; y += 1) put(x, y, z, STONE);
        put(x, 61, z, GRASS); // low ground: feet at 62
        for (let y = 62; y <= 71; y += 1) put(x, y, z, AIR);
      }
    }
    for (let x = -4; x <= 4; x += 1) {
      for (let z = -4; z <= 4; z += 1) {
        for (let y = 61; y <= 64; y += 1) put(x, y, z, STONE);
        put(x, 65, z, GRASS); // plateau: feet at 66
        for (let y = 66; y <= 71; y += 1) put(x, y, z, AIR);
      }
    }
    // Staircase along z=0: 64, 63, 62, 61 -> the drop is one block per step, so it is walkable.
    for (let i = 0; i < 4; i += 1) {
      const x = 5 + i;
      const top = 64 - i;
      for (let y = 61; y <= top; y += 1) put(x, y, 0, STONE);
      put(x, top, 0, GRASS);
      for (let y = top + 1; y <= 71; y += 1) put(x, y, 0, AIR);
    }
    return { cells };
  }

  await scenario('11f a cliff between bot and target: the subgoal is still far away, not the ledge underfoot', async () => {
    const { cells } = cliffMap();
    const body = makeBody(cells, { x: 0, y: 66, z: 0 });
    const planner = new PathPlanner(body, { log, avoidManMade: false });
    const far = { x: 40, y: 62, z: 0 };
    const subgoal = planner.pickSubgoal(far);
    expect(subgoal, 'a cliff is not a reason to give up on a subgoal');
    const reach = Math.hypot(subgoal.x, subgoal.z);
    expect(reach >= 20, `the subgoal must be a real hop, got ${reach.toFixed(1)} blocks at ${JSON.stringify(subgoal)}`);
    expect(subgoal.y === 62, `the subgoal must sit on the low ground (feet 62), got y=${subgoal.y}`);
    const hop = await planner.plan(subgoal);
    expect(hop.status === STATUS.SUCCESS, `the staircase makes it reachable, got ${hop.status} (${hop.reason})`);

    // And the trip must not degenerate into a long train of one-block legs.
    const navBody = makeBody(cells, { x: 0, y: 66, z: 0 });
    const legs = recordLegs(navBody);
    const nav = new PathNavigator(navBody, { log, avoidManMade: false });
    const res = await nav.goTo(far, { range: 2, timeoutMs: 30000 });
    expect(res.ok === true, `the trip must arrive, got ${res.reason}`);
    expect(legs.length <= 8, `40 blocks must not take ${legs.length} legs (that is the wandering signature)`);
    return `subgoal (${subgoal.x},${subgoal.y},${subgoal.z}) at ${reach.toFixed(0)} blocks, arrived in ${legs.length} leg(s)`;
  });

  await scenario('11g nowhere good to hop: creep forward, never crease sideways', async () => {
    /**
     * A small dry platform in a lava lake: every cell on the ray is unusable, so the best
     * subgoal available is one of the platform's own edge cells - inside the goal tolerance.
     * The contract is: take the forward step (it is real progress), then stop honestly. What
     * must never happen is answering that with lateral neighbours, which is the shuffle the
     * live 2026-10-15 report described.
     */
    const { cells } = buildMap({
      radius: 40,
      fill: (put) => {
        for (let x = -40; x <= 40; x += 1) {
          for (let z = -40; z <= 40; z += 1) put(x, 63, z, LAVA);
        }
        for (let x = -2; x <= 2; x += 1) {
          for (let z = -2; z <= 2; z += 1) put(x, 63, z, GRASS); // the platform
        }
      }
    });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const legs = recordLegs(body);
    const nav = new PathNavigator(body, { log, avoidManMade: false });
    const res = await nav.goTo({ x: 40, y: 64, z: 0 }, { range: 2, timeoutMs: 10000 });
    expect(res.ok === false, 'a lava horizon must not be reported as arrival');
    expect(
      res.reason === NAV_REASON.STALLED || res.reason === NAV_REASON.OUT_OF_GRID,
      `expected stalled/out-of-grid, got ${res.reason}`
    );
    expect(legs.length <= 3, `at most a step or two of real progress, got ${legs.length} legs`);
    const sideways = legs.filter((leg) => Math.abs(leg.z - leg.from.z) > 1 || leg.x < leg.from.x);
    expect(sideways.length === 0, `no leg may crease sideways or backwards: ${JSON.stringify(sideways)}`);
    const wander = Math.hypot(body.position.x, body.position.z);
    expect(wander <= 4, `the bot must stay near its platform, ended ${wander.toFixed(1)} blocks away`);
    return `${res.reason} after ${res.iterations} iteration(s), ${legs.length} forward leg(s), within ${wander.toFixed(1)} blocks`;
  });

  await scenario('11h a lake wider than the scan: swim waypoints carry the trip across', async () => {
    /**
     * The live shape (2026-10-15): bot on a bank, target 40 blocks away, and 27 blocks of deep
     * water in between - so no dry cell exists anywhere on the line. Refusing liquid waypoints
     * stranded the trip on the bank (it failed in 19 ms). Water is crossable, so a surface
     * waypoint is exactly the right answer here.
     */
    const lake = (put) => {
      for (let x = 4; x <= 30; x += 1) {
        for (let z = -40; z <= 40; z += 1) {
          for (let y = 57; y <= 63; y += 1) put(x, y, z, WATER); // deep: no floor within reach
        }
      }
    };
    const { cells } = buildMap({ radius: 40, fill: lake });
    const bank = makeBody(cells, { x: 3, y: 64, z: 0 });
    const planner = new PathPlanner(bank, { log, avoidManMade: false });
    const far = { x: 40, y: 64, z: 0 };
    const subgoal = planner.pickSubgoal(far);
    expect(subgoal, 'a lake is not a reason to give up on a subgoal');
    const reach = Math.hypot(subgoal.x - 3, subgoal.z);
    expect(reach >= 18, `the swim waypoint must be a real hop, got ${reach.toFixed(1)} blocks`);
    expect(planner.isSwimSubgoal(v3(subgoal.x, subgoal.y, subgoal.z)), `expected a water waypoint, got ${JSON.stringify(subgoal)}`);
    expect(!planner.isDrySubgoal(v3(subgoal.x, subgoal.y, subgoal.z)), 'the far bank is out of scan range, so this cell cannot be dry');
    const hop = await planner.plan(subgoal);
    expect(hop.status === STATUS.SUCCESS, `swimming to the waypoint must be plannable, got ${hop.status} (${hop.reason})`);

    // And the trip crosses: bank -> swim -> far shore.
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const legs = recordLegs(body);
    const nav = new PathNavigator(body, { log, avoidManMade: false });
    const res = await nav.goTo(far, { range: 2, timeoutMs: 40000 });
    expect(res.ok === true, `the trip must cross the lake, got ${res.reason}`);
    expect(body.position.x >= 32, `the bot must end on the far bank, ended x=${body.position.x}`);
    expect(
      legs.some((leg) => cells[`${leg.x},${leg.y},${leg.z}`] === WATER),
      'crossing a lake means at least one leg puts the body in the water'
    );
    return `swim waypoint (${subgoal.x},${subgoal.y},${subgoal.z}) at ${reach.toFixed(0)} blocks, crossed in ${legs.length} legs to x=${body.position.x}`;
  });

  // ---- 3b. water costs twice a walk (operator's rule) -----------------------
  await scenario('3b water: twice the cost of flat ground, and never free', async () => {
    expect(COST.SWIM === 2 * COST.WALK, `water must cost exactly 2x a walk, got ${COST.SWIM} vs ${COST.WALK}`);
    expect(COST.SWIM > COST.WALK, 'water must never be as cheap as walking');

    // (a) a narrow river far from its bridge: swimming is the route the model prefers.
    const narrow = riverMap({ radius: 30, riverX0: 10, riverX1: 11, bridgeZ: 14 });
    const swimBody = makeBody(narrow.cells, { x: 0, y: 64, z: 0 });
    const swimPlanner = new PathPlanner(swimBody, { log, avoidManMade: false, allowSwim: true });
    const swim = await swimPlanner.plan({ x: 20, y: 64, z: 0 });
    expect(swim.status === STATUS.SUCCESS, `a narrow river is crossable, got ${swim.status}`);
    /**
     * "Crosses the water" means the body's own cell is water. Testing the x coordinate alone
     * would also pass for a bridge at the same x - walking *over* a plank deck puts the feet
     * in an air cell - which is exactly the distinction these two halves pin down.
     */
    const feet = (map, n) => map[`${n.x},${n.y},${n.z}`];
    expect(swim.path.some((n) => feet(narrow.cells, n) === WATER), 'the allowed route should put the body in the water');

    // (b) the same river with swimming off: the bridge becomes the route, and no water is used.
    const dryBody = makeBody(narrow.cells, { x: 0, y: 64, z: 0 });
    const dryPlanner = new PathPlanner(dryBody, { log, avoidManMade: false, allowSwim: false });
    const dry = await dryPlanner.plan({ x: 20, y: 64, z: 0 });
    expect(dry.status === STATUS.SUCCESS, `the bridge must make it crossable without swimming, got ${dry.status} (${dry.reason})`);
    expect(!dry.path.some((n) => feet(narrow.cells, n) === WATER), 'the dry route must not put the body in the water');
    expect(dry.path.some((n) => narrow.cells[`${n.x},${n.y - 1},${n.z}`] === PLANKS), 'the dry route must use the bridge');

    // (c) a bridge on the line beats swimming across the same span: water is not free.
    // Two levels here, because they answer different questions. The path level shows the
    // *model's* preference (walk the deck, not the river); the navigator level shows the trip
    // staying dry end to end, which is what "it used the bridge" actually means.
    const wide = riverMap({ radius: 30, riverX0: 10, riverX1: 17, bridgeZ: 0 });
    const planBody = makeBody(wide.cells, { x: 0, y: 64, z: 0 });
    const planPlanner = new PathPlanner(planBody, { log, avoidManMade: false, allowSwim: true });
    const inbound = await planPlanner.plan({ x: 20, y: 64, z: 0 });
    expect(inbound.status === STATUS.SUCCESS, `a bridged river must be crossable, got ${inbound.status}`);
    const plankCells = inbound.path.filter((n) => wide.cells[`${n.x},${n.y - 1},${n.z}`] === PLANKS).length;
    expect(plankCells >= 4, `with the bridge on the line the route should walk it, plank cells=${plankCells}`);
    expect(!inbound.path.some((n) => wide.cells[`${n.x},${n.y},${n.z}`] === WATER), 'the bridged route must not enter the water');

    // Same map, target 25 blocks out: this trip also exercises the subgoal hop, and it must
    // still cross on foot (the walker merges the straight deck into one leg, so "no leg ever
    // puts the body in water" is the property to assert, not "a leg lands on a plank").
    const bridgeBody = makeBody(wide.cells, { x: 0, y: 64, z: 0 });
    const bridgeLegs = recordLegs(bridgeBody);
    const bridgeNav = new PathNavigator(bridgeBody, { log, avoidManMade: false, allowSwim: true });
    const bridge = await bridgeNav.goTo({ x: 25, y: 64, z: 0 }, { range: 2, timeoutMs: 30000 });
    expect(bridge.ok === true, `a bridged river must be crossed, got ${bridge.reason}`);
    expect(
      !bridgeLegs.some((leg) => wide.cells[`${leg.x},${leg.y},${leg.z}`] === WATER),
      'with a bridge on the line the crossing must stay dry (no leg may put the body in water)'
    );
    return `SWIM=${COST.SWIM} = 2x WALK=${COST.WALK}; narrow river swims, no-swim bridge, bridged span walks ${plankCells} plank cells and stays dry over ${bridgeLegs.length} legs`;
  });

  // ---- summary -----------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`pathfinding test: ${results.length - failed.length}/${results.length} scenarios passed\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('deliverable A checkpoint reached: planner + walker + navigator verified offline\n');
  }
})().catch((err) => {
  process.stdout.write(`pathfinding test crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
