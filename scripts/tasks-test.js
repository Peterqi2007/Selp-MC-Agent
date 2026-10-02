'use strict';

/**
 * `npm run tasks:test` - offline acceptance for deliverable B (P0-PLAN §6.6).
 *
 * Runs the real `ChopWoodTask` / `MineBlockTask` / `GoToTask` against `MockBody`, which is
 * the whole reason the Body abstraction exists: every behaviour below is one the plan asks
 * to verify "on the real server", and all of them except the digging itself can be proven
 * here in milliseconds - including the ones that are hard to stage in a live game
 * (a full inventory, an unreachable tree, drops in a ravine).
 *
 * The scenarios map one-to-one onto §6.6:
 *
 *   walk    -> arrives, and reports *why* when it cannot
 *   break   -> needs a pickaxe for stone, says so, and does not pretend
 *   collect -> the dug block's item really lands in the inventory (not just the block
 *              disappearing - the distinction that matters most here)
 *   chain   -> a 3-log tree: walk -> break x3 -> collect x3 -> +3 logs
 *   full    -> fails early, with a reason, instead of digging into the void
 *   cliff   -> a drop 5 blocks down is skipped, never chased
 *   noPath  -> reports the reason and moves to the next target instead of hanging
 */

const { MockBody } = require('../src/body/mockBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const { ChopWoodTask } = require('../src/tasks/chopWood');
const { MineBlockTask, dropOf } = require('../src/tasks/mineBlock');
const { GoToTask } = require('../src/tasks/goto');
const { loadConfig } = require('../src/util/config');

const log = { debug() {}, info() {}, warn() {}, error() {} };

// --------------------------------------------------------------------------- harness

const results = [];

async function scenario(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    process.stdout.write(`  PASS  ${name}${detail ? ` - ${detail}` : ''}  (${Date.now() - started}ms)\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}  (${Date.now() - started}ms)\n`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/** Build the same ctx shape index.js builds, minus mineflayer-only services. */
function makeCtx(body, cfg, extra = {}) {
  const ctx = {
    cfg,
    log,
    body,
    memory: extra.memory || { recordTask() {}, landmark: extra.landmark ? () => extra.landmark : () => null },
    mods: extra.mods || null
  };
  ctx.world = new BodyWorldView(body, cfg, { log });
  return ctx;
}

/**
 * A tree: `height` logs stacked at (x, 64.., z) on a grass block, topped by a leaf disc.
 *
 * The canopy is not decoration. `looksLikeTree()` refuses a bare trunk, so a fixture without
 * leaves would be testing the refusal path and every chop scenario would fail for the wrong
 * reason. `canopy=false` builds the bare pillar on purpose, which is how the "a player's log
 * column is not a tree" case is expressed.
 */
function treeBlocks(x, z, height, species = 'oak', options = {}) {
  const blocks = [{ name: 'grass_block', position: { x, y: 63, z } }];
  for (let i = 0; i < height; i += 1) {
    blocks.push({ name: `${species}_log`, position: { x, y: 64 + i, z } });
  }
  if (options.canopy === false) return blocks;
  const top = 64 + height;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue; // the trunk continues through the canopy
      blocks.push({ name: `${species}_leaves`, position: { x: x + dx, y: top, z: z + dz } });
    }
  }
  return blocks;
}

(async () => {
  const cfg = loadConfig({ profile: null });
  process.stdout.write('minecraft-survival-agent - offline task test (MockBody)\n');
  process.stdout.write('(P0-PLAN §6.6: walk / break / collect + the awkward cases)\n\n');

  // ---------------------------------------------------------------- primitive 1
  process.stdout.write('1. primitive 1 - walk\n');

  await scenario('GoToTask walks to a coordinate and reports the distance', async () => {
    const body = new MockBody(cfg, { start: { x: 0, y: 64, z: 0 } });
    await body.connect();
    const task = new GoToTask(makeCtx(body, cfg), { position: { x: 20, y: 64, z: 0 }, range: 1 });
    const res = await task.execute();
    expect(res.ok, `expected arrival, got ${res.reason}`);
    expect(body.position.x === 20, `expected x=20, body is at ${body.position.x}`);
    expect(/moved 20 blocks/.test(res.reason), `reason should mention the distance, got "${res.reason}"`);
    return res.reason;
  });

  await scenario('GoToTask reports the pathfinding reason instead of a bare failure', async () => {
    const body = new MockBody(cfg, { start: { x: 0, y: 64, z: 0 } });
    await body.connect();
    body.lastMove = { ok: false, reason: 'noPath' };
    body.moveTo = async () => false;
    const task = new GoToTask(makeCtx(body, cfg), { position: { x: 999, y: 64, z: 999 } });
    const res = await task.execute();
    expect(!res.ok, 'an unreachable target must not report success');
    expect(/noPath/.test(res.reason), `reason should carry noPath, got "${res.reason}"`);
    return res.reason;
  });

  await scenario('GoToTask resolves a landmark from memory', async () => {
    const body = new MockBody(cfg, { start: { x: 0, y: 64, z: 0 } });
    await body.connect();
    const ctx = makeCtx(body, cfg, { landmark: { x: -8, y: 64, z: 4 } });
    const task = new GoToTask(ctx, { landmark: 'shelter', range: 1 });
    const res = await task.execute();
    expect(res.ok, `expected arrival at the landmark, got ${res.reason}`);
    expect(body.position.x === -8 && body.position.z === 4, `landed at ${JSON.stringify(body.position)}`);
    return res.reason;
  });

  await scenario('GoToTask fails clearly for an unknown landmark', async () => {
    const body = new MockBody(cfg, {});
    await body.connect();
    const task = new GoToTask(makeCtx(body, cfg), { landmark: 'nowhere' });
    const res = await task.execute();
    expect(!res.ok, 'unknown landmark must fail');
    expect(/no landmark named/.test(res.reason), `got "${res.reason}"`);
    return res.reason;
  });

  // ---------------------------------------------------------------- primitive 2
  process.stdout.write('\n2. primitive 2 - break\n');

  await scenario('MineBlockTask refuses stone without a pickaxe and says why', async () => {
    const body = new MockBody(cfg, { blocks: [{ name: 'stone', position: { x: 2, y: 64, z: 0 } }] });
    await body.connect();
    const task = new MineBlockTask(makeCtx(body, cfg), { block: ['stone', 'cobblestone'], count: 4 });
    const res = await task.execute();
    expect(!res.ok, 'mining stone bare-handed must fail');
    expect(/need a pickaxe/.test(res.reason), `reason should name the missing tool, got "${res.reason}"`);
    expect(body.stats.dug === 0, `nothing should have been dug, dug=${body.stats.dug}`);
    return res.reason;
  });

  await scenario('MineBlockTask mines with a pickaxe and counts the DROP (stone -> cobblestone)', async () => {
    const blocks = [];
    for (let i = 0; i < 4; i += 1) blocks.push({ name: 'stone', position: { x: 2 + i, y: 64, z: 0 } });
    const body = new MockBody(cfg, { blocks, inventory: { stone_pickaxe: 1 } });
    await body.connect();
    const task = new MineBlockTask(makeCtx(body, cfg), { block: ['stone'], count: 3, probeShaft: false });
    const res = await task.execute();
    expect(res.ok, `expected success, got ${res.reason}`);
    const cobble = body.inventory['minecraft:cobblestone'] || 0;
    expect(cobble >= 3, `expected >=3 cobblestone in the inventory, have ${cobble}`);
    return `${cobble} cobblestone, reason="${res.reason}"`;
  });

  await scenario('probe shaft digs down when nothing is exposed', async () => {
    // Stone only below the surface: nothing visible at y=64, so a shaft is the only way.
    const blocks = [];
    for (let d = 1; d <= 3; d += 1) blocks.push({ name: 'stone', position: { x: 0, y: 64 - d, z: 0 } });
    const body = new MockBody(cfg, { blocks, inventory: { stone_pickaxe: 1 } });
    await body.connect();
    const task = new MineBlockTask(makeCtx(body, cfg), { block: ['stone'], count: 1, shaftDepth: 4 });
    const res = await task.execute();
    expect(body.stats.dug > 0, 'the shaft should have dug at least one block');
    expect(res.ok || /only collected/.test(res.reason), `unexpected reason "${res.reason}"`);
    return `dug ${body.stats.dug}, reason="${res.reason}"`;
  });

  await scenario('dropOf maps ore blocks to their real drops', () => {
    expect(dropOf('stone') === 'cobblestone', 'stone -> cobblestone');
    expect(dropOf('minecraft:iron_ore') === 'raw_iron', 'iron_ore -> raw_iron');
    expect(dropOf('deepslate_gold_ore') === 'raw_gold', 'deepslate_gold_ore -> raw_gold');
    expect(dropOf('oak_log') === 'oak_log', 'oak_log -> itself');
    return 'stone/iron/deepslate gold/log all correct';
  });

  // ---------------------------------------------------------------- tool policy
  process.stdout.write('\n2b. tool policy - hardness vs. what is in the hand\n');

  await scenario("the hardness table is the operator's rule, block for block", () => {
    const { requiredTierFor } = require('../src/world/items');
    const expected = [
      // Relaxed by the operator: both diamond ore variants follow vanilla (iron). Surface on
      // 2026-10-01, deepslate on 2026-10-02 - see docs/P0-STATUS.md §四之四 ③.
      ['diamond_ore', 'iron'], ['deepslate_diamond_ore', 'iron'],
      ['ancient_debris', 'diamond'], ['obsidian', 'diamond'],
      ['redstone_ore', 'iron'], ['deepslate_redstone_ore', 'iron'],
      ['lapis_ore', 'iron'], ['deepslate_lapis_ore', 'iron'],
      ['gold_ore', 'iron'], ['deepslate_gold_ore', 'iron'],
      ['emerald_ore', 'iron'], ['deepslate_emerald_ore', 'iron'],
      ['iron_ore', 'stone'], ['deepslate_iron_ore', 'stone'],
      ['copper_ore', 'stone'], ['deepslate_copper_ore', 'stone'],
      ['stone', 'wooden'], ['cobblestone', 'wooden'], ['deepslate', 'wooden'], ['coal_ore', 'wooden'],
      // Everything else is bare-handed: the rule only names ores and stone.
      ['dirt', null], ['grass_block', null], ['sand', null], ['gravel', null], ['oak_log', null],
      ['clay', null], ['netherrack', null], ['create:andesite_alloy_block', null]
    ];
    const wrong = expected.filter(([block, tier]) => requiredTierFor(block) !== tier)
      .map(([block, tier]) => `${block}: want ${tier}, got ${requiredTierFor(block)}`);
    expect(!wrong.length, wrong.join('; '));
    // The namespace must not matter: both forms are the same block.
    expect(requiredTierFor('minecraft:iron_ore') === 'stone', 'a namespaced name must resolve too');
    return `${expected.length} blocks`;
  });

  await scenario('a golden pickaxe is a wood-level tool (the harvest-level trap)', () => {
    /**
     * The regression this guards. `TOOL_TIERS` is a *progression* order and in it golden sits
     * above iron; reading a harvest level out of that list made a golden pickaxe look able to
     * mine diamond ore. In the game gold's harvest level is 0 - the same as wood - so the bot
     * would have walked to the ore and swung at it forever for no drop.
     */
    const { harvestLevel, TOOL_TIERS } = require('../src/world/items');
    expect(TOOL_TIERS.indexOf('golden') > TOOL_TIERS.indexOf('iron'), 'the progression order itself is unchanged');
    expect(harvestLevel('golden') === harvestLevel('wooden'), 'gold must be wood level');
    expect(harvestLevel('golden') < harvestLevel('iron'), 'gold must be below iron');
    expect(harvestLevel('stone') < harvestLevel('iron'), 'stone must be below iron');
    expect(harvestLevel('netherite') === harvestLevel('diamond'), 'netherite shares diamond level');
    expect(harvestLevel('unobtainium') === -1, 'an unknown tier must be unusable, not level 0');
    return `wooden/golden=${harvestLevel('golden')} stone=${harvestLevel('stone')} iron=${harvestLevel('iron')} diamond=${harvestLevel('diamond')}`;
  });

  await scenario('the whole matrix: every block against every pickaxe tier', async () => {
    const TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
    const LEVEL = { wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 3 };
    const cases = [
      ['dirt', null], ['sand', null], ['oak_log', null],
      ['stone', 'wooden'], ['deepslate', 'wooden'], ['coal_ore', 'wooden'],
      ['iron_ore', 'stone'], ['deepslate_iron_ore', 'stone'], ['copper_ore', 'stone'],
      ['gold_ore', 'iron'], ['redstone_ore', 'iron'], ['lapis_ore', 'iron'], ['emerald_ore', 'iron'],
      // Both diamond ore variants are iron per the operator's relaxation (surface 10-01,
      // deepslate 10-02); ancient debris and obsidian stay diamond.
      ['diamond_ore', 'iron'], ['deepslate_diamond_ore', 'iron'], ['ancient_debris', 'diamond']
    ];
    const problems = [];
    for (const [block, need] of cases) {
      for (const tier of TIERS) {
        const body = new MockBody(cfg, { inventory: { [`${tier}_pickaxe`]: 1 } });
        await body.connect();
        const task = new MineBlockTask(makeCtx(body, cfg), { block: [block], count: 1, probeShaft: false, warmupMs: 0 });
        const got = task.canHarvest({ name: `minecraft:${block}`, position: { x: 2, y: 64, z: 0 } });
        const want = need === null ? true : LEVEL[tier] >= LEVEL[need];
        if (got !== want) problems.push(`${block}+${tier}: got ${got}, want ${want}`);
      }
    }
    expect(!problems.length, `${problems.length} wrong: ${problems.slice(0, 8).join('; ')}`);
    return `${cases.length} blocks x ${TIERS.length} tiers agreed`;
  });

  await scenario('a pickaxe that cannot break the block fails BEFORE walking to it', async () => {
    // A block broken below its tier drops nothing, so the honest answer is a refusal - and it
    // has to come before the walk, or the bot spends the trip to learn nothing.
    const body = new MockBody(cfg, {
      blocks: [{ name: 'iron_ore', position: { x: 2, y: 64, z: 0 } }],
      inventory: { wooden_pickaxe: 1 }
    });
    await body.connect();
    const task = new MineBlockTask(makeCtx(body, cfg), { block: ['iron_ore'], count: 1, probeShaft: false, warmupMs: 0 });
    const res = await task.execute();
    expect(!res.ok, `a wooden pickaxe must not "mine" iron ore, got ok=${res.ok}`);
    expect(/pickaxe too weak/.test(res.reason), `reason should name the tool problem, got "${res.reason}"`);
    expect(/need stone/.test(res.reason), `reason should name the required tier, got "${res.reason}"`);
    expect(body.stats.dug === 0, `nothing may be broken, dug=${body.stats.dug}`);
    expect(body.stats.moved === 0, `the walk must not happen, moved=${body.stats.moved}`);
    return res.reason;
  });

  await scenario('a golden pickaxe cannot mine iron ore either', async () => {
    // Same trap end to end, and the one the matrix alone cannot show: gold is *fast* on stone.
    const body = new MockBody(cfg, {
      blocks: [{ name: 'iron_ore', position: { x: 2, y: 64, z: 0 } }],
      inventory: { golden_pickaxe: 1 }
    });
    await body.connect();
    const task = new MineBlockTask(makeCtx(body, cfg), { block: ['iron_ore'], count: 1, probeShaft: false, warmupMs: 0 });
    const res = await task.execute();
    expect(!res.ok && /pickaxe too weak/.test(res.reason), `got ok=${res.ok} "${res.reason}"`);
    expect(body.stats.dug === 0, 'iron ore must not be broken for nothing');
    return res.reason;
  });

  await scenario('the highest-tier pickaxe in the bag is the one held', async () => {
    const body = new MockBody(cfg, {
      blocks: [{ name: 'stone', position: { x: 2, y: 64, z: 0 } }],
      inventory: { wooden_pickaxe: 1, stone_pickaxe: 1, iron_pickaxe: 1 }
    });
    await body.connect();
    const task = new MineBlockTask(makeCtx(body, cfg), { block: ['stone'], count: 1, probeShaft: false, warmupMs: 0 });
    const res = await task.execute();
    expect(res.ok, `expected the stone to be mined, got ${res.reason}`);
    expect(body.held === 'minecraft:iron_pickaxe', `expected the iron pickaxe, held "${body.held}"`);
    return `held ${body.held}`;
  });

  await scenario('among equal tiers the faster pickaxe wins (gold over wood)', async () => {
    // Both are harvest level 0, so the tie-break is speed - and gold is the fastest tool there is.
    const body = new MockBody(cfg, {
      blocks: [{ name: 'stone', position: { x: 2, y: 64, z: 0 } }],
      inventory: { wooden_pickaxe: 1, golden_pickaxe: 1 }
    });
    await body.connect();
    const task = new MineBlockTask(makeCtx(body, cfg), { block: ['stone'], count: 1, probeShaft: false, warmupMs: 0 });
    await task.execute();
    expect(body.held === 'minecraft:golden_pickaxe', `expected the golden pickaxe, held "${body.held}"`);
    return `held ${body.held}`;
  });

  await scenario('a block with no tool requirement is dug bare-handed', async () => {
    // The rule says "everything else with an empty hand", so equipping a pickaxe for dirt would
    // be a second, quieter bug: it would wear out a tool for nothing.
    const body = new MockBody(cfg, {
      blocks: [{ name: 'dirt', position: { x: 2, y: 64, z: 0 } }],
      inventory: { iron_pickaxe: 1 }
    });
    await body.connect();
    const task = new MineBlockTask(makeCtx(body, cfg), { block: ['dirt'], count: 1, probeShaft: false, warmupMs: 0 });
    const res = await task.execute();
    expect(res.ok, `dirt must be diggable, got ${res.reason}`);
    expect(body.stats.dug >= 1, `the dirt should have been broken, dug=${body.stats.dug}`);
    expect(!body.held, `nothing should be equipped for dirt, held "${body.held}"`);
    return 'dirt dug, hand empty';
  });

  await scenario('wrong-tool targets are skipped while the reachable ones are still mined', async () => {
    // "stone + diamond ore" with a stone pickaxe: mining the stone is right, refusing everything
    // is not, and quietly claiming success on both would be the worst of the three. The task
    // takes what it can, records the skip, and stays honest about the shortfall.
    const body = new MockBody(cfg, {
      blocks: [
        { name: 'stone', position: { x: 2, y: 64, z: 0 } },
        { name: 'diamond_ore', position: { x: 3, y: 64, z: 0 } }
      ],
      inventory: { stone_pickaxe: 1 }
    });
    await body.connect();
    const task = new MineBlockTask(makeCtx(body, cfg), {
      block: ['stone', 'diamond_ore'], count: 2, probeShaft: false, warmupMs: 0, roamSteps: 0
    });
    const res = await task.execute();
    const dugDiamond = body.history.some((h) => h.action === 'dig' && h.name === 'diamond_ore');
    expect(!dugDiamond, 'the diamond ore must not be broken with a stone pickaxe');
    expect(body.stats.dug >= 1, 'the stone should still have been mined');
    expect(Array.isArray(task.skippedForTool) && task.skippedForTool.includes('diamond_ore'), 'the skip should be recorded');
    // 1 of 2 is a failure by design (progress was possible), and the reason must say so.
    expect(!res.ok && /only collected 1\/2/.test(res.reason), `got ok=${res.ok} "${res.reason}"`);
    return `stone mined, ${task.skippedForTool.join('/')} skipped, "${res.reason}"`;
  });

  // ---------------------------------------------------------------- primitive 3
  process.stdout.write('\n3. primitive 3 - collect (and the three chained)\n');

  await scenario('chop a 3-log tree: walk -> break x3 -> collect x3 -> inventory +3', async () => {
    const body = new MockBody(cfg, { blocks: treeBlocks(6, 0, 3) });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 3, timeoutMs: 30000 });
    const res = await task.execute();
    const logs = body.inventory['minecraft:oak_log'] || 0;

    expect(logs === 3, `expected exactly 3 logs in the inventory, have ${logs} (reason: ${res.reason})`);
    expect(res.ok, `expected success, got ${res.reason}`);
    const dugLogs = body.history.filter((h) => h.action === 'dig' && /log$/.test(h.name)).length;
    expect(dugLogs === 3, `expected 3 log blocks broken, got ${dugLogs}`);
    const pickups = body.history.filter((h) => h.action === 'pickup').length;
    expect(pickups >= 3, `expected >=3 pickups, got ${pickups}`);
    expect(/3\/3 logs/.test(res.reason), `reason should show progress, got "${res.reason}"`);
    return res.reason;
  });

  await scenario('two trees: keeps going after the first is exhausted', async () => {
    const blocks = [...treeBlocks(4, 0, 2), ...treeBlocks(12, 0, 2, 'birch')];
    const body = new MockBody(cfg, { blocks });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 4, timeoutMs: 30000 });
    const res = await task.execute();
    const total = (body.inventory['minecraft:oak_log'] || 0) + (body.inventory['minecraft:birch_log'] || 0);
    expect(total === 4, `expected 4 logs total, have ${total} (reason: ${res.reason})`);
    expect(res.ok, `expected success, got ${res.reason}`);
    return `${total} logs from 2 species`;
  });

  await scenario('unreachable target is skipped, then reported as noPath - no hang', async () => {
    const body = new MockBody(cfg, { blocks: treeBlocks(8, 0, 2) });
    await body.connect();
    // Every walk fails, exactly like a tree across a ravine.
    body.lastMove = { ok: false, reason: 'noPath', target: null };
    body.moveTo = async () => false;
    const ctx = makeCtx(body, cfg);
    ctx.world.invalidate = () => {};
    const task = new ChopWoodTask(ctx, { count: 2, timeoutMs: 15000, warmupMs: 0 });
    const started = Date.now();
    const res = await task.execute();
    const elapsed = Date.now() - started;

    expect(elapsed < 12000, `must not hang, took ${elapsed}ms`);
    expect(body.stats.dug === 0, 'nothing should have been dug');
    expect(task.failedTargets.length > 0, 'the unreachable block should be remembered');
    // Zero harvest is a SUCCESS by design, so the planner stops re-queueing it.
    expect(res.ok, `zero-harvest must report success to stop replanning loops, got ${res.reason}`);
    expect(/no logs available nearby/.test(res.reason), `got "${res.reason}"`);
    return `${task.failedTargets.length} target(s) blacklisted, "${res.reason}"`;
  });

  await scenario('full inventory fails early with a reason (no digging into the void)', async () => {
    // 36 distinct items == no empty slots in the mock's inventory model.
    const inventory = {};
    for (let i = 0; i < 36; i += 1) inventory[`filler_${i}`] = 1;
    const body = new MockBody(cfg, { blocks: treeBlocks(5, 0, 4), inventory });
    await body.connect();
    const snap = body.snapshot();
    expect(snap.emptySlots === 0, `the mock should report a full inventory, emptySlots=${snap.emptySlots}`);

    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 4, timeoutMs: 20000, warmupMs: 0 });
    const res = await task.execute();
    expect(!res.ok, 'a full inventory must fail, not silently succeed');
    expect(/inventory is full/.test(res.reason), `reason should say the inventory is full, got "${res.reason}"`);
    expect(body.stats.dug === 0, `nothing should be dug while full, dug=${body.stats.dug}`);
    return res.reason;
  });

  await scenario('a drop in a ravine is skipped, never chased', async () => {
    // Height 2, not 1: a one-block trunk is refused as "a single isolated log", and the
    // scenario would then pass without ever entering the harvest loop it is meant to test.
    const body = new MockBody(cfg, { blocks: treeBlocks(3, 0, 2), inventory: {} });
    await body.connect();
    // A log floating in a drop 5 blocks below the bot.
    body.drops.push({ name: 'oak_log', count: 1, position: { x: 3, y: 59, z: 0 } });
    const moved = [];
    const realMove = body.moveTo.bind(body);
    body.moveTo = async (position, options) => {
      moved.push(position);
      return realMove(position, options);
    };

    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 1, timeoutMs: 20000, warmupMs: 0 });
    await task.execute();

    const chasedLowDrop = moved.some((p) => p.y < 62);
    expect(!chasedLowDrop, `the bot must not walk down to y<62, went to ${JSON.stringify(moved)}`);
    return 'cliff drop ignored';
  });

  await scenario('an unreachable drop does not block the main loop', async () => {
    const body = new MockBody(cfg, { blocks: treeBlocks(3, 0, 2) });
    await body.connect();
    body.drops.push({ name: 'oak_log', count: 1, position: { x: 5, y: 64, z: 0 } });
    // Only drops fail to be reached; normal targets work.
    body.moveTo = async (position, options) => {
      if (Math.abs(position.x - 5) < 0.01) return false;
      body.position = { ...position };
      body._pickUpDrops();
      return true;
    };

    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 2, timeoutMs: 20000, warmupMs: 0 });
    const res = await task.execute();
    expect(res.ok, `the task should still finish, got ${res.reason}`);
    const logs = body.inventory['minecraft:oak_log'] || 0;
    expect(logs >= 2, `expected >=2 logs, have ${logs}`);
    return `collected ${logs} despite an unreachable drop`;
  });

  await scenario('no trees at all: succeeds quickly with a clear message', async () => {
    const body = new MockBody(cfg, { blocks: [] });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 8, timeoutMs: 20000, warmupMs: 0 });
    const started = Date.now();
    const res = await task.execute();
    const elapsed = Date.now() - started;
    expect(res.ok, `zero-harvest must be a success, got ${res.reason}`);
    expect(elapsed < 5000, `should not spin, took ${elapsed}ms`);
    expect(/no logs available nearby/.test(res.reason), `got "${res.reason}"`);
    return res.reason;
  });

  await scenario('partially reaching the target is a FAILURE (progress was possible)', async () => {
    const body = new MockBody(cfg, { blocks: treeBlocks(4, 0, 2) });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 8, timeoutMs: 20000, warmupMs: 0 });
    const res = await task.execute();
    expect(!res.ok, '2 of 8 logs must fail so the planner can retry elsewhere');
    expect(/only collected 2\/8/.test(res.reason), `got "${res.reason}"`);
    return res.reason;
  });

  await scenario('the mod-knowledge safety gate blocks unknown machines', async () => {
    const body = new MockBody(cfg, {
      blocks: [
        { name: 'create:cogwheel', position: { x: 2, y: 64, z: 0 } },
        { name: 'minecraft:iron_ore', position: { x: 3, y: 64, z: 0 } }
      ],
      inventory: { stone_pickaxe: 1 }
    });
    await body.connect();
    const mods = { isMineable: (name) => !String(name).startsWith('create:') };
    const task = new MineBlockTask(makeCtx(body, cfg, { mods }), {
      block: ['cogwheel', 'iron_ore'],
      count: 1,
      probeShaft: false
    });
    const res = await task.execute();
    const dugCog = body.history.some((h) => h.action === 'dig' && h.name === 'create:cogwheel');
    expect(!dugCog, 'a modded machine must never be dug');
    expect(res.ok, `the iron ore should still be mined, got ${res.reason}`);
    return 'cogwheel refused, iron_ore mined';
  });

  await scenario('a log wall is NOT a tree: the agent refuses to dismantle a build', async () => {
    /**
     * The scenario that matters most on a public server. `isLog()` cannot tell a forest from
     * a log cabin, so without the structural check the agent would happily eat someone's
     * wall - and "it looked like a tree" is not a defence anyone accepts.
     */
    const blocks = [
      { name: 'oak_planks', position: { x: 4, y: 63, z: 0 } },
      { name: 'oak_log', position: { x: 4, y: 64, z: 0 } },
      { name: 'oak_log', position: { x: 4, y: 65, z: 0 } },
      { name: 'oak_log', position: { x: 4, y: 66, z: 0 } },
      { name: 'oak_log', position: { x: 5, y: 64, z: 0 } },
      { name: 'oak_log', position: { x: 5, y: 65, z: 0 } },
      { name: 'oak_log', position: { x: 5, y: 66, z: 0 } }
    ];
    const body = new MockBody(cfg, { blocks });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 4, timeoutMs: 20000, warmupMs: 0 });
    const res = await task.execute();
    const wallDug = body.history.filter((h) => h.action === 'dig' && /oak_log/.test(h.name)).length;
    expect(wallDug === 0, `the wall was dismantled: ${wallDug} log blocks broken`);
    expect(res.ok, `refusing a build should end quietly, got ${res.reason}`);
    expect(task.refusedTargets.length > 0, 'the refusals should be recorded for the log');
    return `refused ${task.refusedTargets.length} built log(s), nothing broken`;
  });

  await scenario('a real tree next to a build is still chopped (no over-blocking)', async () => {
    // The safety rule must not make the agent useless: a genuine tree must still work even
    // when a building is a few blocks away.
    const blocks = [
      ...treeBlocks(8, 0, 3),
      { name: 'oak_planks', position: { x: 12, y: 64, z: 0 } },
      { name: 'oak_planks', position: { x: 12, y: 64, z: 1 } },
      { name: 'glass', position: { x: 12, y: 65, z: 0 } }
    ];
    const body = new MockBody(cfg, { blocks });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 3, timeoutMs: 25000, warmupMs: 0 });
    const res = await task.execute();
    const logs = body.inventory['minecraft:oak_log'] || 0;
    expect(logs === 3, `expected 3 logs from the tree, have ${logs} (${res.reason})`);
    return 'tree chopped, build untouched';
  });

  await scenario('a single floating log (a decoration) is refused', async () => {
    const body = new MockBody(cfg, { blocks: [{ name: 'oak_log', position: { x: 2, y: 64, z: 0 } }] });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 1, timeoutMs: 15000, warmupMs: 0 });
    await task.execute();
    const dug = body.history.filter((h) => h.action === 'dig').length;
    expect(dug === 0, `an isolated log must not be broken (dug ${dug})`);
    expect(task.refusedTargets.length > 0, 'the refusal should be recorded');
    return task.refusedTargets[0].why;
  });

  await scenario("a player's log pillar on grass is refused: no leaves, so not a tree", async () => {
    /**
     * The hole the canopy rule closes. This column is rooted in grass, is four blocks tall and
     * has nothing built touching it - every structural test a log can pass, it passes. Without
     * the leaf check the agent eats it, and "it was a log on grass" is not a defence when the
     * logs were someone's beacon base.
     */
    const body = new MockBody(cfg, { blocks: treeBlocks(4, 0, 4, 'oak', { canopy: false }) });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 4, timeoutMs: 15000, warmupMs: 0, roamSteps: 0 });
    const res = await task.execute();
    const dug = body.history.filter((h) => h.action === 'dig').length;
    expect(dug === 0, `a bare log pillar must not be broken, dug ${dug}`);
    expect(task.refusedTargets.length >= 1, 'the refusal should be recorded');
    expect(/no leaves/.test(task.refusedTargets[0].why), `reason should name the missing canopy, got "${task.refusedTargets[0].why}"`);
    expect(res.ok, `refusing a build ends quietly, got ${res.reason}`);
    return task.refusedTargets[0].why;
  });

  await scenario('the identical column WITH a canopy is chopped (the rule is not a blanket refusal)', async () => {
    // The control for the scenario above: same ground, same trunk, same height - only the
    // leaves differ. If this one is refused too, the check has stopped being a signal.
    const body = new MockBody(cfg, { blocks: treeBlocks(4, 0, 4) });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 4, timeoutMs: 20000, warmupMs: 0 });
    const res = await task.execute();
    const logs = body.inventory['minecraft:oak_log'] || 0;
    expect(logs === 4, `expected 4 logs from the tree, have ${logs} (${res.reason})`);
    return `chopped ${logs} logs from the same shape plus leaves`;
  });

  await scenario('safety.requireLeaves=false restores the old behaviour (the rule is opt-out)', async () => {
    const body = new MockBody(cfg, { blocks: treeBlocks(4, 0, 3, 'oak', { canopy: false }) });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), {
      count: 3, timeoutMs: 20000, warmupMs: 0, requireLeaves: false
    });
    const res = await task.execute();
    const logs = body.inventory['minecraft:oak_log'] || 0;
    expect(logs === 3, `with the rule off the pillar is a target, have ${logs} (${res.reason})`);
    return 'canopy requirement is a switch, not a hard-coded opinion';
  });

  await scenario('a nether fungus still counts as a tree (wart blocks are its canopy)', async () => {
    // Crimson/warped "trees" have no leaves at all, so a canopy rule that only knows about
    // leaves would silently make the nether unchoppable.
    const blocks = [{ name: 'netherrack', position: { x: 4, y: 63, z: 0 } }];
    for (let i = 0; i < 3; i += 1) blocks.push({ name: 'crimson_stem', position: { x: 4, y: 64 + i, z: 0 } });
    blocks.push({ name: 'nether_wart_block', position: { x: 4, y: 67, z: 0 } });
    const body = new MockBody(cfg, { blocks });
    await body.connect();
    const task = new ChopWoodTask(makeCtx(body, cfg), { count: 3, timeoutMs: 20000, warmupMs: 0 });
    const res = await task.execute();
    const stems = body.inventory['minecraft:crimson_stem'] || 0;
    expect(stems === 3, `expected 3 stems, have ${stems} (${res.reason})`);
    return `chopped ${stems} stems`;
  });

  await scenario('mining refuses a wall built from natural stone', async () => {
    /**
     * `stone` is the most common building material there is, so the *name* cannot decide -
     * only the structure can. This map is built the way a real wall exists in a real world:
     * air on both faces, natural ground underneath, and repeating stone along its length.
     */
    const blocks = [];
    // Natural ground everywhere.
    for (let x = -4; x <= 5; x += 1) {
      for (let z = -4; z <= 4; z += 1) blocks.push({ name: 'grass_block', position: { x, y: 63, z } });
    }
    // A 4-long, 3-high stone wall at z=0, with air on both sides.
    for (let x = 0; x <= 3; x += 1) {
      for (let y = 64; y <= 66; y += 1) blocks.push({ name: 'stone', position: { x, y, z: 0 } });
    }
    // ...and air explicitly recorded in front/behind it, like a real scan would report.
    for (let x = 0; x <= 3; x += 1) {
      for (let y = 64; y <= 66; y += 1) {
        blocks.push({ name: 'air', position: { x, y, z: -1 } });
        blocks.push({ name: 'air', position: { x, y, z: 1 } });
        blocks.push({ name: 'air', position: { x, y: 67, z: 0 } });
      }
    }
    // A real vein far from the wall, so the task has something legitimate to do.
    for (let x = -4; x <= -3; x += 1) {
      for (let y = 64; y <= 65; y += 1) {
        blocks.push({ name: 'stone', position: { x, y, z: 3 } });
        blocks.push({ name: 'dirt', position: { x, y, z: 4 } });
        blocks.push({ name: 'andesite', position: { x, y, z: 2 } });
      }
    }
    const body = new MockBody(cfg, { blocks, inventory: { stone_pickaxe: 1 } });
    await body.connect();
    // `strictMining` is the opt-in anti-masonry mode; see MineBlockTask.extraSafetyCheck.
    const task = new MineBlockTask(makeCtx(body, cfg), { block: ['stone'], count: 2, probeShaft: false, warmupMs: 0, strictMining: true });
    const res = await task.execute();

    const wallDug = body.history.filter(
      (h) => h.action === 'dig' && h.position && h.position.z === 0 && h.position.x >= 0 && h.position.x <= 3
    ).length;
    expect(wallDug === 0, `the wall was mined: ${wallDug} block(s)`);
    expect(task.refusedTargets.length > 0, 'the refusals should be recorded');
    return `${task.refusedTargets.length} refused, reason: ${task.refusedTargets[0].why}`;
  });

  await scenario('the plan never routes across a player-built floor', async () => {
    /**
     * A path that *ends* on natural ground still crosses whatever is between, so the guard
     * has to be enforced in the movement model, not only at the destination. Here the only
     * direct route is over a plank bridge; the planner must refuse it.
     */
    const { PathPlanner, STATUS } = require('../src/pathfinding/planner');
    const { v3 } = require('../src/pathfinding/vec3util');
    const cells = {};
    const put = (x, y, z, name) => {
      cells[`${x},${y},${z}`] = name;
    };
    for (let x = -6; x <= 12; x += 1) {
      for (let z = -3; z <= 3; z += 1) {
        put(x, 62, z, 'minecraft:stone');
        put(x, 63, z, 'minecraft:air');
        for (let y = 64; y <= 68; y += 1) put(x, y, z, 'minecraft:air');
      }
    }
    // A plank bridge across a gap at x=2..4, the only way over.
    for (let x = 0; x <= 6; x += 1) {
      for (let z = -3; z <= 3; z += 1) put(x, 63, z, 'minecraft:air');
    }
    for (let x = 0; x <= 6; x += 1) put(x, 63, 0, 'minecraft:oak_planks');
    // Sea under the gap.
    for (let x = 0; x <= 6; x += 1) for (let z = -3; z <= 3; z += 1) put(x, 62, z, 'minecraft:water');

    const position = { x: -4, y: 64, z: 0 };
    const body = {
      isReady: true,
      snapshot: () => ({ ready: true, body: 'mock', position: { ...position }, blocks: { cells }, health: 20, food: 20 }),
      async moveTo(target) {
        position.x = target.x;
        position.y = target.y;
        position.z = target.z;
        return true;
      },
      async interrupt() {}
    };
    const planner = new PathPlanner(body, { log });
    const res = await planner.plan({ x: 10, y: 64, z: 0 });
    expect(res.status !== STATUS.SUCCESS, `a route over the bridge must not be planned (got ${res.status})`);
    const crossesBridge = res.path.some((n) => n.x >= 0 && n.x <= 6 && n.z === 0);
    expect(!crossesBridge, 'the path walks the plank bridge');
    return `${res.status} - bridge refused`;
  });

  await scenario('a man-made destination is refused with a clear reason', async () => {
    const { PathPlanner, STATUS } = require('../src/pathfinding/planner');
    const cells = {};
    for (let x = -4; x <= 6; x += 1) {
      for (let z = -4; z <= 4; z += 1) {
        cells[`${x},63,${z}`] = 'minecraft:grass_block';
        for (let y = 64; y <= 68; y += 1) cells[`${x},${y},${z}`] = 'minecraft:air';
      }
    }
    // Someone's floor, a few blocks away.
    cells['4,63,0'] = 'minecraft:oak_planks';
    const position = { x: 0, y: 64, z: 0 };
    const body = {
      isReady: true,
      snapshot: () => ({ ready: true, body: 'mock', position: { ...position }, blocks: { cells }, health: 20, food: 20 }),
      async moveTo() {
        return true;
      },
      async interrupt() {}
    };
    const planner = new PathPlanner(body, { log });
    const res = await planner.plan({ x: 4, y: 64, z: 0 });
    expect(res.status === STATUS.UNSAFE_TARGET, `expected unsafe-target, got ${res.status} (${res.reason})`);
    expect(/built block/.test(res.reason), `reason should name the problem: ${res.reason}`);
    return res.reason;
  });

  await scenario('with safety off the same map is walkable (the guard is opt-out)', async () => {
    // A private test server should not be hobbled by public-server rules, so the policy must
    // be a switch rather than a hard-coded opinion.
    const { PathPlanner, STATUS } = require('../src/pathfinding/planner');
    const cells = {};
    for (let x = -4; x <= 6; x += 1) {
      for (let z = -4; z <= 4; z += 1) {
        cells[`${x},63,${z}`] = 'minecraft:grass_block';
        for (let y = 64; y <= 68; y += 1) cells[`${x},${y},${z}`] = 'minecraft:air';
      }
    }
    cells['4,63,0'] = 'minecraft:oak_planks';
    const position = { x: 0, y: 64, z: 0 };
    const body = {
      isReady: true,
      snapshot: () => ({ ready: true, body: 'mock', position: { ...position }, blocks: { cells }, health: 20, food: 20 }),
      async moveTo() {
        return true;
      },
      async interrupt() {}
    };
    const planner = new PathPlanner(body, { log, avoidManMade: false });
    const res = await planner.plan({ x: 4, y: 64, z: 0 });
    expect(res.status === STATUS.SUCCESS, `with the guard off this should succeed, got ${res.status} (${res.reason})`);
    return 'guard disabled -> route allowed';
  });

  // ---------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`task test: ${results.length - failed.length}/${results.length} scenarios passed\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('deliverable B checkpoint reached: walk + break + collect verified offline\n');
  }
})().catch((err) => {
  process.stdout.write(`task test crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
