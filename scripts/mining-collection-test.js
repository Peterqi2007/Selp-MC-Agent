'use strict';

/**
 * `npm run mining:collection:test` - the C-series acceptance for the shared pickup loop
 * (docs/MINING-COLLECTION-PLAN.md §9.1/§9.2).
 *
 * Coverage over the offline matrix:
 *   - product resolution incl. silk touch / fortune / unknown modded (C11);
 *   - baseline + evidence rules: delta required, vanish-is-not-pickup, ambiguous sources,
 *     partial stacks, claimable caps (C01/C06/C07/C08/C12/C20);
 *   - bounded stand strategy: false arrival is not verified (C02), cancel stops instantly
 *     (C13), dangerous stands are refused (C14);
 *   - end-to-end: auto-pickup verifies with no extra moves (C04), an unrelated drop never
 *     verifies (C10), and an unpaid goal blocks the next ore (C15);
 *   - corridor target protection: both the mock body and the skill's reaction to a
 *     `target_requires_acquisition` stop (C21/CP7).
 */

const assert = require('assert');
const { loadConfig } = require('../src/util/config');
const { MockBody } = require('../src/body/mockBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const skills = require('../src/skills');
const {
  resolveMiningProducts,
  prepareAcquisition,
  sealBaseline,
  recordMineResult,
  observeAcquisition,
  verifyAcquisition,
  reconcilePendingGoals
} = require('../src/skills/miningAcquisition');
const { attemptCollection, selectPickupStands } = require('../src/skills/miningCollection');

const cfg = loadConfig({ profile: null });
const silent = { debug() {}, info() {}, warn() {}, error() {} };

let failures = 0;
let checks = 0;
async function check(name, fn) {
  checks += 1;
  try {
    const note = await fn();
    process.stdout.write(`  PASS  ${name}${note ? ` - ${note}` : ''}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
  }
}

function mineWorld({ minX = -8, maxX = 8, corridor = [], extras = [] } = {}) {
  const blocks = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = 63; y <= 66; y += 1) {
      for (let z = -3; z <= 3; z += 1) blocks.push({ name: 'stone', position: { x, y, z } });
    }
  }
  for (const cell of corridor) blocks.push({ name: 'air', position: cell });
  for (const block of extras) blocks.push(block);
  return blocks;
}

function makeCtx(body) {
  return { cfg, log: silent, body, mods: null, world: body };
}

/** A fresh AcquisitionGoal whose baseline is sealed against the given snapshot. */
function goalFor(snapshot, overrides = {}) {
  const goal = prepareAcquisition({
    taskId: 'test',
    target: { blockId: 'diamond_ore', position: { x: 9, y: 64, z: 9 } },
    tool: { item: 'minecraft:iron_pickaxe' },
    products: ['diamond'],
    snapshot
  });
  sealBaseline(goal, snapshot);
  Object.assign(goal, overrides);
  return goal;
}

function snap({ feet = { x: 0, y: 64, z: 0 }, inventory = {}, drops = [], cells = {} } = {}) {
  return {
    ready: true,
    position: { ...feet },
    inventory: { ...inventory },
    nearbyItems: drops.map((d, i) => ({ id: d.id === undefined ? `d${i}` : d.id, name: d.name, count: d.count || 1, position: { ...d.position }, distance: d.distance })),
    blocks: { cells: { ...cells } }
  };
}

/** Scripted IO for attemptCollection unit cases. */
function fakeIo({ snaps, danger = null, moveOk = true } = {}) {
  const state = { snaps: snaps.slice(), moveCalls: [], digCalls: [] };
  const io = {
    log: silent,
    refresh: async () => (state.snaps.length > 1 ? state.snaps.shift() : state.snaps[0] || null),
    feetOf: (s) => (s && s.position ? { x: Math.floor(s.position.x), y: Math.floor(s.position.y), z: Math.floor(s.position.z) } : null),
    read: (s, cell) => (s.blocks && s.blocks.cells[`${cell.x},${cell.y},${cell.z}`]) || 'minecraft:air',
    passable: (n) => /air$/.test(n),
    solid: (n) => !/air$/.test(n),
    dangerAt: () => danger,
    moveTo: async (p) => {
      state.moveCalls.push({ ...p });
      return { ok: moveOk };
    },
    digCell: async (c) => {
      state.digCalls.push({ ...c });
      return { ok: true };
    },
    climbTo: async () => ({ ok: false, risen: 0, reason: 'disabled in fixture' })
  };
  return { io, state };
}

const FAST_LIMITS = { dropSpawnWaitMs: 40, pickupConfirmMs: 60, maxLocalStands: 2, maxLocalPillarSteps: 0 };

/**
 * A sealed rock pocket around the drop (live 2026-10-10): walking is only legal to an
 * adjacent open cell, so the collector must actually open the wall to reach the item.
 */
function pocketIo({ drop, feet = { x: 0, y: 64, z: 0 } }) {
  const key = (c) => `${c.x},${c.y},${c.z}`;
  const state = {
    feet: { ...feet },
    inv: {},
    picked: false,
    digs: [],
    cells: new Map([
      ['0,63,0', 'minecraft:stone'], ['1,63,0', 'minecraft:stone'],
      ['2,63,0', 'minecraft:stone'], ['3,63,0', 'minecraft:stone'],
      ['1,64,0', 'minecraft:stone'], ['1,65,0', 'minecraft:stone'],
      ['2,64,0', 'minecraft:stone'], ['2,65,0', 'minecraft:stone']
    ])
  };
  const snapshot = () => {
    const distance = Math.hypot(state.feet.x + 0.5 - drop.position.x, state.feet.y - drop.position.y, state.feet.z + 0.5 - drop.position.z);
    return {
      ready: true,
      position: { ...state.feet },
      onGround: true,
      inventory: { ...state.inv },
      nearbyItems: state.picked ? [] : [{ id: 'd1', name: drop.name, count: drop.count, position: { ...drop.position }, distance }],
      blocks: { cells: Object.fromEntries(state.cells) }
    };
  };
  const tryPickup = () => {
    if (state.picked) return;
    const distance = Math.hypot(state.feet.x + 0.5 - drop.position.x, state.feet.y - drop.position.y, state.feet.z + 0.5 - drop.position.z);
    if (distance <= 1.5) {
      state.picked = true;
      state.inv[drop.name] = (state.inv[drop.name] || 0) + (drop.count || 1);
    }
  };
  const io = {
    log: silent,
    refresh: async () => snapshot(),
    feetOf: () => ({ ...state.feet }),
    read: (s, cell) => state.cells.get(key(cell)) || 'minecraft:air',
    passable: (n) => /air$/.test(n),
    solid: (n) => !/air$/.test(n),
    protectedName: (n) => /_ore$/.test(n),
    dangerAt: () => null,
    digCell: async (cell) => {
      state.digs.push({ ...cell });
      state.cells.delete(key(cell));
      return { ok: true };
    },
    moveTo: async (pos) => {
      const cheb = Math.max(Math.abs(pos.x - state.feet.x), Math.abs(pos.y - state.feet.y), Math.abs(pos.z - state.feet.z));
      const name = state.cells.get(key(pos)) || 'minecraft:air';
      if (cheb > 1 || !/air$/.test(name)) return { ok: false, reason: 'a wall is in the way' };
      state.feet = { ...pos };
      tryPickup();
      return { ok: true };
    },
    climbTo: async () => ({ ok: false, risen: 0, reason: 'no climb in fixture' })
  };
  return { io, state };
}

async function main() {
  process.stdout.write('minecraft-survival-agent - mining collection test (offline, C-series)\n\n');

  process.stdout.write('1. product resolution (C11)\n');
  await check('C11: vanilla, silk touch and fortune produce different truths', () => {
    assert.deepStrictEqual(resolveMiningProducts('diamond_ore', {}).products, ['diamond']);
    assert.deepStrictEqual(resolveMiningProducts('deepslate_iron_ore', {}).products, ['raw_iron']);
    assert.deepStrictEqual(resolveMiningProducts('nether_quartz_ore', {}).products, ['quartz']);
    const silk = resolveMiningProducts('diamond_ore', { silkTouch: true });
    assert.deepStrictEqual(silk.products, ['diamond_ore']);
    const fortune = resolveMiningProducts('diamond_ore', { fortune: 3 });
    assert.strictEqual(fortune.expectedMax, 4);
    return 'diamond/silk/fortune mapped';
  });
  await check('C11: an unknown modded ore is product_unknown, never guessed', () => {
    const unknown = resolveMiningProducts('create:zinc_ore', {});
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(unknown.failure, 'product_unknown');
    const known = resolveMiningProducts('create:zinc_ore', {}, {
      modKnowledge: { classify: () => ({ category: 'ore', knownDrop: 'create:zinc_ingot' }) }
    });
    assert.deepStrictEqual(known.products, ['create:zinc_ingot']);
    return 'unknown refused, known mapping honoured';
  });

  process.stdout.write('\n2. goal lifecycle and evidence (C01/C06/C08/C12/C20)\n');
  await check('C01: an inventory delta verifies; the baseline is the sealed one', () => {
    const before = snap({ inventory: {} });
    const goal = goalFor(before);
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    const seen = observeAcquisition(goal, snap({ inventory: { 'minecraft:diamond': 1 } }));
    const verdict = verifyAcquisition(goal, seen);
    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(goal.collectedItems, 1);
    assert.strictEqual(goal.status, 'verified');
    return 'delta=1 -> verified';
  });
  await check('C06/C07: a vanished entity with no delta is never a pickup', () => {
    const goal = goalFor(snap({}));
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    observeAcquisition(goal, snap({ drops: [{ name: 'minecraft:diamond', position: { x: 1, y: 64, z: 0 } }] }));
    const seen = observeAcquisition(goal, snap({ drops: [] })); // entity gone, inventory unchanged
    const verdict = verifyAcquisition(goal, seen);
    assert.strictEqual(verdict.verified, false);
    assert.strictEqual(goal.collectedItems, 0);
    return 'gone != collected';
  });
  await check('C08: a partially picked stack keeps its remainder pending', () => {
    const goal = goalFor(snap({}));
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    const seen = observeAcquisition(
      goal,
      snap({ inventory: { 'minecraft:diamond': 1 }, drops: [{ name: 'minecraft:diamond', count: 2, position: { x: 1, y: 64, z: 0 } }] })
    );
    const verdict = verifyAcquisition(goal, seen);
    assert.strictEqual(verdict.verified, true);
    assert.strictEqual(goal.collectedItems, 1);
    assert.strictEqual(verdict.pendingDrops.length, 1);
    assert.strictEqual(verdict.pendingDrops[0].count, 2);
    return 'collected 1, pending 2';
  });
  await check('C12: same-product drops before the dig mark the evidence ambiguous', () => {
    const goal = goalFor(snap({ drops: [{ id: 'old1', name: 'minecraft:diamond', position: { x: 3, y: 64, z: 0 } }] }));
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    const seen = observeAcquisition(goal, snap({ inventory: { 'minecraft:diamond': 1 } }));
    assert.strictEqual(seen.evidenceLevel, 'ambiguous');
    verifyAcquisition(goal, seen);
    assert.strictEqual(goal.evidenceLevel, 'ambiguous');
    return 'old drop -> ambiguous, not correlated';
  });
  await check('live fix 10-10b: a delta from another source never verifies while the target drop is intact', () => {
    const goal = goalFor(snap({}));
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    goal.pendingDrops = [{ id: 'orig', name: 'diamond', count: 2, position: { x: 1, y: 64, z: 0 } }];
    const seen = observeAcquisition(
      goal,
      snap({
        inventory: { 'minecraft:diamond': 1 },
        drops: [{ id: 'orig', name: 'minecraft:diamond', count: 2, position: { x: 1, y: 64, z: 0 } }]
      })
    );
    const verdict = verifyAcquisition(goal, seen);
    assert.strictEqual(verdict.verified, false, 'an intact tracked drop must block attribution');
    assert.strictEqual(goal.collectedItems, 0);
    assert.strictEqual(goal.evidenceLevel, 'ambiguous');
    // Then the real stack is picked: the entity disappears and the same delta verifies.
    const later = observeAcquisition(goal, snap({ inventory: { 'minecraft:diamond': 1 }, drops: [] }));
    const verdict2 = verifyAcquisition(goal, later);
    assert.strictEqual(verdict2.verified, true);
    assert.strictEqual(goal.collectedItems, 1);
    return 'intact target blocks the attribution; disappearance unlocks it';
  });
  await check('C20: claimable caps one delta to one goal', () => {
    const goal = goalFor(snap({}));
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    const seen = observeAcquisition(goal, snap({ inventory: { 'minecraft:diamond': 3 } }));
    const verdict = verifyAcquisition(goal, seen, { claimable: 1 });
    assert.strictEqual(verdict.delta, 1);
    assert.strictEqual(goal.collectedItems, 1);
    return 'delta 3 capped to 1';
  });
  await check('live fix 10-10: a banked product reconciled after the sweep verifies the goal', () => {
    const goal = goalFor(snap({}));
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    // The collector failed (goal still pending), then the incidental sweep banked it.
    const reconciled = reconcilePendingGoals([goal], snap({ inventory: { 'minecraft:diamond': 1 } }));
    assert.strictEqual(reconciled.length, 1);
    assert.strictEqual(goal.status, 'verified');
    assert.strictEqual(goal.collectedItems, 1);
    return 'pending -> verified from inventory evidence, not from the sweep counter';
  });
  await check('live fix 10-10: the mined ore cell is a legal pickup stand once it is air', () => {
    const cells = {
      '0,63,0': 'minecraft:stone',
      '1,63,0': 'minecraft:stone',
      '0,64,0': 'minecraft:air', '0,65,0': 'minecraft:air',
      '1,64,0': 'minecraft:air', '1,65,0': 'minecraft:air',
      '2,64,0': 'minecraft:air', '2,65,0': 'minecraft:air'
    };
    const snapshot = snap({ cells });
    const goal = goalFor(snap({ cells }), { target: { blockId: 'diamond_ore', position: { x: 1, y: 64, z: 0 } } });
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    goal.pendingDrops = [{ name: 'diamond', count: 1, position: { x: 1, y: 64, z: 0 } }];
    const io = {
      feetOf: (s) => ({ x: Math.floor(s.position.x), y: Math.floor(s.position.y), z: Math.floor(s.position.z) }),
      read: (s, cell) => (s.blocks && s.blocks.cells[`${cell.x},${cell.y},${cell.z}`]) || 'minecraft:air',
      passable: (n) => /air$/.test(n),
      solid: (n) => !/air$/.test(n)
    };
    const stands = selectPickupStands(snapshot, goal, io);
    assert(
      stands.some((c) => c.position.x === 1 && c.position.y === 64 && c.position.z === 0),
      `the ore cell must be a stand: ${JSON.stringify(stands.map((c) => c.position))}`
    );
    return 'target cell included after the dig';
  });

  process.stdout.write('\n3. collection unit behaviour (C02/C13/C14)\n');
  await check('C02: move succeeded but the bag stayed empty -> needs_recovery, never verified', async () => {
    const cells = {
      '0,63,0': 'minecraft:stone', '1,63,0': 'minecraft:stone', '2,63,0': 'minecraft:stone',
      '0,64,0': 'minecraft:air', '0,65,0': 'minecraft:air',
      '1,64,0': 'minecraft:air', '1,65,0': 'minecraft:air',
      '2,64,0': 'minecraft:air', '2,65,0': 'minecraft:air'
    };
    const dropSnap = snap({
      drops: [{ name: 'minecraft:diamond', position: { x: 1, y: 64, z: 0 } }],
      cells
    });
    // The baseline is taken BEFORE the drop exists; the drop then appears (post-dig truth).
    const goal = goalFor(snap({ cells }));
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    const after = snap({ drops: [{ name: 'minecraft:diamond', position: { x: 1, y: 64, z: 0 } }], cells });
    const { io, state } = fakeIo({ snaps: [dropSnap, after] });
    const result = await attemptCollection({ goal, io, mode: 'macro', limits: FAST_LIMITS });
    assert.notStrictEqual(result.outcome, 'verified');
    assert.strictEqual(goal.collectedItems, 0);
    assert(state.moveCalls.length >= 1, 'the stand move should have been attempted');
    return `outcome=${result.outcome}`;
  });
  await check('C13: a cancelled signal stops before any move', async () => {
    const dropSnap = snap({ drops: [{ name: 'minecraft:diamond', position: { x: 1, y: 64, z: 0 } }] });
    const goal = goalFor(dropSnap);
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    const { io, state } = fakeIo({ snaps: [dropSnap] });
    const result = await attemptCollection({ goal, io, mode: 'macro', limits: FAST_LIMITS, signal: { cancelled: true, reason: 'stop' } });
    assert.strictEqual(result.outcome, 'interrupted');
    assert.strictEqual(state.moveCalls.length, 0);
    return 'interrupted with zero moves';
  });
  await check('C14: dangerous stands are refused (lava/monster never entered)', async () => {
    const cells = {
      '0,63,0': 'minecraft:stone', '1,63,0': 'minecraft:stone',
      '0,64,0': 'minecraft:air', '0,65,0': 'minecraft:air',
      '1,64,0': 'minecraft:air', '1,65,0': 'minecraft:air'
    };
    const dropSnap = snap({
      drops: [{ name: 'minecraft:diamond', position: { x: 1, y: 64, z: 0 } }],
      cells
    });
    const goal = goalFor(snap({ cells }));
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    const { io, state } = fakeIo({ snaps: [dropSnap], danger: { reason: 'lava in or beside the tunnel', hostile: false } });
    const result = await attemptCollection({ goal, io, mode: 'macro', limits: FAST_LIMITS });
    assert.notStrictEqual(result.outcome, 'verified');
    assert.strictEqual(state.moveCalls.length, 0);
    return `outcome=${result.outcome}, no dangerous move`;
  });
  await check('live fix 10-10: a sealed pocket is carved open until the drop is picked', async () => {
    const drop = { name: 'diamond', count: 1, position: { x: 3, y: 64, z: 0 } };
    const { io, state } = pocketIo({ drop });
    const goal = goalFor(snap({}), { target: { blockId: 'diamond_ore', position: { x: 8, y: 64, z: 8 } } });
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    goal.pendingDrops = [{ ...drop }];
    const result = await attemptCollection({ goal, io, mode: 'macro', allowTerrainEdits: true, limits: FAST_LIMITS });
    assert.strictEqual(result.outcome, 'verified', `outcome=${result.outcome} reason=${result.reason}`);
    assert(state.digs.length >= 4, `expected the wall opened, dug ${state.digs.length}`);
    assert(state.picked === true, 'the drop must end up in the bag');
    assert(
      result.attemptedActions.some((a) => a.action === 'carve' && a.cells.length >= 2),
      `carve actions missing: ${JSON.stringify(result.attemptedActions)}`
    );
    return `carved ${state.digs.length} cell(s), collected via proximity`;
  });
  await check('live fix 10-10: recovery mode never carves on its own', async () => {
    const drop = { name: 'diamond', count: 1, position: { x: 3, y: 64, z: 0 } };
    const { io, state } = pocketIo({ drop });
    const goal = goalFor(snap({}), { target: { blockId: 'diamond_ore', position: { x: 8, y: 64, z: 8 } } });
    recordMineResult(goal, { receipt: { ok: true, dug: true } });
    goal.pendingDrops = [{ ...drop }];
    const result = await attemptCollection({ goal, io, mode: 'recovery', allowTerrainEdits: false, limits: FAST_LIMITS });
    assert.notStrictEqual(result.outcome, 'verified');
    assert.strictEqual(state.digs.length, 0, 'collect_target must not dig');
    return `outcome=${result.outcome}, zero edits`;
  });

  process.stdout.write('\n4. end-to-end with the skill (C04/C10/C15)\n');
  /**
   * Shrink the collection waits for tests; production values stay if the config module
   * grows its own knobs later.
   */
  const collectionModule = require('../src/skills/miningCollection');
  collectionModule.DEFAULTS.dropSpawnWaitMs = 50;
  collectionModule.DEFAULTS.pickupConfirmMs = 80;
  collectionModule.DEFAULTS.maxLocalStands = 2;

  const DIAMOND_CORRIDOR = [
    { x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 },
    { x: 1, y: 64, z: 0 }, { x: 1, y: 65, z: 0 },
    { x: 2, y: 64, z: 0 }, { x: 2, y: 65, z: 0 }
  ];

  await check('C04: an auto-banked product verifies without extra movement', async () => {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: mineWorld({ corridor: DIAMOND_CORRIDOR, extras: [{ name: 'gold_ore', position: { x: 1, y: 64, z: 0 } }] }),
      inventory: { 'minecraft:iron_pickaxe': 1 }
    });
    await body.connect();
    const result = await skills.run('mine_ore', makeCtx(body), { ore: 'gold_ore', maxMs: 20000, eatAt: 1 });
    assert(result.ok && result.mined === 1, `mined ${result.mined}`);
    assert(result.partial !== true, `expected a complete collection, got partial: ${JSON.stringify(result.pending)}`);
    assert(
      (result.acquisition || []).some((line) => /\[verified\]/.test(line)),
      `no verified acquisition record: ${JSON.stringify(result.acquisition)}`
    );
    return (result.acquisition || [])[0];
  });

  await check('C10: digging a diamond but receiving cobblestone never verifies', async () => {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: mineWorld({ corridor: DIAMOND_CORRIDOR, extras: [{ name: 'diamond_ore', position: { x: 1, y: 64, z: 0 } }] }),
      inventory: { 'minecraft:iron_pickaxe': 1 }
    });
    await body.connect();
    const realDig = body.dig.bind(body);
    body.dig = async (block, options) => realDig(block, { ...options, drop: 'minecraft:cobblestone' });
    const result = await skills.run('mine_ore', makeCtx(body), { ore: 'diamond_ore', maxMs: 20000, eatAt: 1 });
    assert(result.mined === 1, `the block should be mined, got ${result.mined}`);
    assert(result.partial === true, 'an unrelated drop must not complete the goal');
    assert(
      !(result.acquisition || []).some((line) => /\[verified\]/.test(line)),
      `unexpected verified record: ${JSON.stringify(result.acquisition)}`
    );
    assert((result.pending || []).length === 1, `pending queue wrong: ${JSON.stringify(result.pending)}`);
    return 'incidental cobble kept out of the diamond goal';
  });

  await check('C15: an unpaid first ore blocks the second one', async () => {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: mineWorld({
        corridor: DIAMOND_CORRIDOR,
        extras: [
          { name: 'gold_ore', position: { x: 1, y: 64, z: 0 } },
          { name: 'gold_ore', position: { x: 2, y: 64, z: 0 } }
        ]
      }),
      inventory: { 'minecraft:iron_pickaxe': 1 }
    });
    await body.connect();
    body._pickUpDrops = () => {}; // the product can never be banked in this fixture
    const result = await skills.run('mine_ore', makeCtx(body), { ore: 'gold_ore', count: 2, maxMs: 20000, eatAt: 1 });
    assert(result.mined === 1, `only the first ore may be mined, got ${result.mined}`);
    assert(result.partial === true, 'the task must report partial, not success');
    assert((result.pending || []).length === 1, `pending queue wrong: ${JSON.stringify(result.pending)}`);
    assert(!!body.world.get('2,64,0'), 'the second ore must still be in the world');
    return `mined=${result.mined}, pending=${(result.pending || []).length}`;
  });

  process.stdout.write('\n5. corridor target protection (C21/CP7)\n');
  await check('C21: a protected ore stops the mock tunnel before it is destroyed', async () => {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: mineWorld({
        corridor: DIAMOND_CORRIDOR,
        extras: [{ name: 'gold_ore', position: { x: 2, y: 64, z: 0 } }]
      })
    });
    await body.connect();
    const result = await body.tunnel([{ x: 2, y: 64, z: 0 }], { protect: { blocks: ['gold_ore'] } });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'target_requires_acquisition');
    assert.strictEqual(result.cell.x, 2);
    assert(!!body.world.get('2,64,0'), 'the protected block must survive');
    return `stopped at ${result.cell.x},${result.cell.y},${result.cell.z} (${result.block})`;
  });
  await check('C21/CP7: the skill passes protection and takes a blocking ore properly', async () => {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: mineWorld({
        corridor: DIAMOND_CORRIDOR.concat([{ x: 3, y: 64, z: 0 }, { x: 3, y: 65, z: 0 }]),
        extras: [{ name: 'gold_ore', position: { x: 3, y: 64, z: 0 } }]
      }),
      inventory: { 'minecraft:iron_pickaxe': 1 }
    });
    await body.connect();
    let protectSeen = null;
    let tunnelCalls = 0;
    body.tunnel = async (waypoints, options) => {
      tunnelCalls += 1;
      protectSeen = options && options.protect;
      return { ok: false, reason: 'target_requires_acquisition', cell: { x: 3, y: 64, z: 0 }, block: 'minecraft:gold_ore', dugCells: [] };
    };
    const result = await skills.run('mine_ore', makeCtx(body), { ore: 'gold_ore', maxMs: 20000, eatAt: 1 });
    assert(tunnelCalls >= 1, 'the tunnel rung never ran');
    assert(protectSeen && protectSeen.blocks.includes('gold_ore'), `protect not passed: ${JSON.stringify(protectSeen)}`);
    assert(result.mined === 1, `the blocking ore should be taken properly, mined=${result.mined}`);
    assert(!body.world.get('3,64,0'), 'the blocking ore must be gone after the real take');
    return 'protection propagated; blocking ore mined through the take flow';
  });

  process.stdout.write(`\n(checks so far: ${checks})\n`);
}

main()
  .then(() => {
    process.stdout.write(`\n${failures ? 'FAIL' : 'OK'} - mining collection test: ${checks - failures}/${checks} checks\n`);
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('mining collection test crashed:', err.stack || err.message);
    process.exit(1);
  });
