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

// --------------------------------------------------------------------------- map building

const AIR = 'minecraft:air';
const GRASS = 'minecraft:grass_block';
const STONE = 'minecraft:stone';
const WATER = 'minecraft:water';
const LAVA = 'minecraft:lava';

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
  await scenario('6 out of grid: distant target reports out-of-grid, not noPath', async () => {
    const { cells } = buildMap({ radius: 30 });
    const body = makeBody(cells, { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log });
    const res = await planner.plan({ x: 40, y: 64, z: 0 });
    expect(res.status === STATUS.OUT_OF_GRID, `expected out-of-grid, got ${res.status}`);
    const toward = planner.toward({ x: 40, y: 64, z: 0 }, 12);
    expect(toward && toward.x > 0, 'toward() should point in the target direction');
    return `status=${res.status}, toward=(${toward.x},${toward.y},${toward.z})`;
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
