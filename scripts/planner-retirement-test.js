'use strict';

/**
 * `npm run planner:test` - RETIREMENT S0 hooks.
 *
 * S0 is deliberately behaviour-free: it installs the regression hooks that the later
 * stages (S1 evaluator, S2 TaskSlot) will be judged against, without changing what the
 * planner does. Three hooks:
 *
 *   1. **progress() value domain.** A task's `progress()` must return a comparable
 *      value (`null | number | string`). `brain._noteProgress()` compares with `===`,
 *      so a fresh object silently disables the zero-progress park (PLANNER-REFACTOR
 *      P3). `MineOreTask` violates this today; it is listed as a KNOWN violation so
 *      the suite stays green while still failing the day it is fixed (the entry must
 *      then be deleted).
 *   2. **decide() injectable fixture.** A hand-built ctx/world drives rule selection
 *      deterministically, with no game client (P9: the rule table had almost no tests).
 *   3. **`task:quarantined` is emitted** for both park paths (P8: the docs advertised
 *      the event for over a year while the code never emitted it).
 *
 * No client, no network, no model calls.
 */

const assert = require('assert');
const { loadConfig } = require('../src/util/config');
const { Brain } = require('../src/brain');

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
  }
}

process.stdout.write('planner retirement test (S0 hooks, offline)\n\n');

// ---------------------------------------------------------------- 1. progress()
/**
 * Known violations of the progress() value-domain contract.
 *
 * Keep this list small and referenced: an entry here is a *documented* defect, not a
 * permission. Each one names the PLANNER-REFACTOR item that will remove it.
 */
const KNOWN_PROGRESS_VIOLATIONS = {
  'mine_ore':
    'P3: progress() returns a fresh object every call; brain compares by identity, so the zero-progress park never fires for ore runs'
};

function baseCtx() {
  return {
    cfg: { agent: { survival: { targetWood: 16 } } },
    body: null,
    world: {},
    nav: {},
    memory: { bump() {}, landmark: () => null },
    controller: { bot: null, isAlive: true },
    log: silent
  };
}

const taskMakers = [
  ['chop-wood', () => new (require('../src/tasks/chopWood').ChopWoodTask)(baseCtx(), { count: 1 })],
  ['craft', () => new (require('../src/tasks/craft').CraftTask)(baseCtx(), { item: 'stick', count: 1 })],
  ['deposit', () => new (require('../src/tasks/deposit').DepositTask)(baseCtx(), {})],
  ['gather-wood', () => new (require('../src/tasks/gatherWood').GatherWoodTask)(baseCtx(), { count: 1 })],
  ['go-to', () => new (require('../src/tasks/goto').GoToTask)(baseCtx(), { position: { x: 0, y: 64, z: 0 } })],
  ['harvest', () => new (require('../src/tasks/harvest').HarvestTask)(baseCtx(), { block: 'dirt', count: 1 })],
  ['hunt', () => new (require('../src/tasks/hunt').HuntTask)(baseCtx(), { count: 1 })],
  ['light', () => new (require('../src/tasks/light').LightTask)(baseCtx(), { count: 1 })],
  ['mine', () => new (require('../src/tasks/mine').MineTask)(baseCtx(), { block: 'stone', count: 1 })],
  ['mine_ore', () => new (require('../src/tasks/mineOre').MineOreTask)(baseCtx(), { block: 'iron_ore', count: 1 })],
  ['mine-block', () => new (require('../src/tasks/mineBlock').MineBlockTask)(baseCtx(), { block: ['stone'], count: 1 })],
  ['shelter', () => new (require('../src/tasks/shelter').ShelterTask)(baseCtx(), {})]
];

process.stdout.write('1. progress() value domain\n');
for (const [key, make] of taskMakers) {
  const known = KNOWN_PROGRESS_VIOLATIONS[key];
  if (known) continue; // handled below, with the object check
  check(`${key}: progress() is null | number | string`, () => {
    const task = make();
    const value = task.progress();
    const domain =
      value === null || value === undefined || typeof value === 'number' || typeof value === 'string';
    assert(domain, `${key}.progress() returned ${typeof value} (${JSON.stringify(value)}) - a non-comparable value disables the stall check`);
  });
}

check('mine_ore: KNOWN violation is still an object with equal values but a new identity (P3)', () => {
  const note = KNOWN_PROGRESS_VIOLATIONS['mine_ore'];
  assert(note, 'the mine_ore violation must stay documented until S2 fixes it');
  const task = new (require('../src/tasks/mineOre').MineOreTask)(baseCtx(), { block: 'iron_ore', count: 1 });
  assert.strictEqual(task.progress(), null, 'a task that has not run should report null');
  task.result = { mined: 1, minedAt: 123, skipped: 0 };
  const a = task.progress();
  const b = task.progress();
  assert.strictEqual(typeof a, 'object', 'the known violation is an object return');
  assert.deepStrictEqual(a, b, 'the two reads describe the same progress');
  assert.notStrictEqual(a, b, 'a fresh identity each call is exactly what breaks the identity compare');
});

// ---------------------------------------------------------------- 2. decide()
process.stdout.write('\n2. decide() injectable fixture\n');

const cfg = loadConfig({ profile: null });

function makeBrain(inventory, { isNight = false } = {}) {
  const ctx = {
    cfg,
    log: silent,
    body: null,
    bodyKind: 'test',
    world: {
      snapshot: () => ({ inventory, emptySlots: 36, health: 20, food: 20 }),
      isNight: () => isNight
    },
    nav: { stop() {}, interrupt() {} },
    eat: { tick: async () => true },
    combat: { defend: async () => true },
    tools: { equipArmor: async () => true },
    controller: { bot: null, isAlive: true, snapshot: () => ({ ready: true }), loadedPlugins: [] },
    memory: {
      bump() {},
      recordTask() {},
      save() {},
      landmark: () => null,
      summary: () => ({ deaths: 0 })
    },
    reply: () => true
  };
  const brain = new Brain(ctx);
  ctx.brain = brain;
  return brain;
}

check('empty inventory, daylight: decide() returns null (idle is a valid state)', () => {
  const brain = makeBrain({});
  assert.strictEqual(brain.decide(), null);
});

check('a wooden pickaxe with no cobblestone: decide() picks the stone-tool rule', () => {
  const brain = makeBrain({ 'minecraft:wooden_pickaxe': 1 });
  const decision = brain.decide();
  assert(decision, 'a rule should apply');
  assert.strictEqual(decision.name, 'mine', `expected the mine rule, got ${decision.name}`);
});

check('the fixture honours quarantine: a parked task is not picked again', () => {
  const brain = makeBrain({ 'minecraft:wooden_pickaxe': 1 });
  brain.quarantine.set('mine', Date.now() + 60000);
  const decision = brain.decide();
  assert(!decision || decision.name !== 'mine', 'a quarantined task name must not be selected');
});

// ---------------------------------------------------------------- 3. quarantined
process.stdout.write('\n3. task:quarantined event (P8)\n');

check('zero-progress park emits task:quarantined exactly once (reason=no-progress)', () => {
  const brain = makeBrain({});
  const events = [];
  brain.on('task:quarantined', (event) => events.push(event));
  const task = { name: 'probe-no-progress', progress: () => 7, source: 'test' };
  brain._noteProgress(task);
  brain._noteProgress(task);
  brain._noteProgress(task);
  assert.strictEqual(events.length, 1, `expected one event, got ${events.length}`);
  const [event] = events;
  assert.strictEqual(event.name, 'probe-no-progress');
  assert.strictEqual(event.reason, 'no-progress');
  assert.strictEqual(event.value, 7);
  assert(event.until > Date.now(), 'the event carries the park expiry');
  assert.strictEqual(event.source, 'test', 'the event keeps the task source');
});

check('strike-based park emits task:quarantined (reason=strikes)', () => {
  const brain = makeBrain({});
  const events = [];
  brain.on('task:quarantined', (event) => events.push(event));
  const task = {
    name: 'probe-strikes',
    retries: 3,
    maxRetries: 2,
    source: 'test',
    state: 'failed',
    result: { reason: 'boom' }
  };
  brain.maybeRetry(task);
  assert.strictEqual(events.length, 1, `expected one event, got ${events.length}`);
  assert.strictEqual(events[0].name, 'probe-strikes');
  assert.strictEqual(events[0].reason, 'strikes');
  assert(events[0].strikes >= 1);
});

// ------------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\nplanner retirement test: ${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  process.stdout.write('FAILED\n');
  process.exit(1);
}
process.stdout.write('S0 hooks are in place (no behaviour change beyond the new event)\n');
