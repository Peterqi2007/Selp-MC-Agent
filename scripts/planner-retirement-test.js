'use strict';

// Offline suites must not read or write the live session-state file (config enables it).
process.env.P1_STATE = 'off';

/**
 * `npm run planner:test` - RETIREMENT S0/S1/S2 hooks.
 *
 * S0 installed the regression hooks (progress domain, decide() fixture, quarantined event).
 * S1 adds the evaluator section: the rule table must return declarative candidates, skip
 * rules the body cannot run (with a reason), and report a throwing precondition instead of
 * hiding it at debug level. S2 adds the slot: one owner, hub-only hold, and the executor
 * (runTask) releasing the body and publishing exactly one completion event.
 * Still no client, no network, no model calls.
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
  check(`${key}: progress() is null | number | string`, () => {
    const task = make();
    const value = task.progress();
    const domain =
      value === null || value === undefined || typeof value === 'number' || typeof value === 'string';
    assert(domain, `${key}.progress() returned ${typeof value} (${JSON.stringify(value)}) - a non-comparable value disables the stall check`);
  });
}

check('mine_ore: progress() is a stable comparable value (P3 fixed)', () => {
  const task = new (require('../src/tasks/mineOre').MineOreTask)(baseCtx(), { block: 'iron_ore', count: 1 });
  assert.strictEqual(task.progress(), null, 'a task that has not run should report null');
  task.result = { mined: 1, minedAt: 123, skipped: [] };
  const a = task.progress();
  const b = task.progress();
  assert.strictEqual(typeof a, 'string', 'ore progress must be a comparable value, not an object');
  assert.strictEqual(a, '1/0');
  assert.strictEqual(a, b, 'two reads of the same result must compare equal');
  task.result = { mined: 2, minedAt: 124, skipped: [{ reason: 'blocked' }] };
  assert.strictEqual(task.progress(), '2/1', 'both mined and skipped are represented');
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

// ---------------------------------------------------------------- 4. evaluator
process.stdout.write('\n4. evaluator (S1)\n');

const { evaluate } = require('../src/planner/evaluator');

check('evaluate() returns declarative candidates (no task instances)', () => {
  const brain = makeBrain({ 'minecraft:wooden_pickaxe': 1 });
  const candidates = evaluate(brain.ctx, { cfg: brain.cfg });
  assert(candidates.length > 0, 'expected at least one candidate');
  for (const candidate of candidates) {
    assert.strictEqual(typeof candidate.run, 'undefined', 'a candidate is data, not a task');
    assert(candidate.args && typeof candidate.args === 'object', 'a candidate carries constructor args');
    assert.strictEqual(typeof candidate.name, 'string', 'a candidate carries the eventual task name');
    assert.strictEqual(typeof candidate.rule, 'string', 'a candidate keeps the rule name for diagnostics');
  }
});

check('the first applicable candidate is the stone-tool rule and carries the task name', () => {
  const brain = makeBrain({ 'minecraft:wooden_pickaxe': 1 });
  const [first] = evaluate(brain.ctx, { cfg: brain.cfg });
  assert.strictEqual(first.rule, 'mine');
  assert.strictEqual(first.name, 'mine');
  assert.strictEqual(first.type, 'mine');
});

check('a body without mineflayer skips shelter/light with a reason (P1/P2)', () => {
  const brain = makeBrain({ 'minecraft:oak_planks': 20, 'minecraft:coal': 4 }, { isNight: true });
  const skips = [];
  evaluate(brain.ctx, { cfg: brain.cfg, onRuleSkip: (skip) => skips.push(skip) });
  const rules = skips.map((skip) => skip.rule);
  assert(rules.includes('shelter'), 'shelter must be skipped explicitly, not silently dead (P1)');
  assert(rules.includes('light'), 'light must be skipped explicitly on a body that cannot place torches (P2)');
  assert(skips.every((skip) => /mineflayer/.test(skip.reason)), 'the skip reason names the missing capability');
});

check('a throwing rule is reported and does not stop later rules', () => {
  const brain = makeBrain({});
  const errors = [];
  const throwing = { rule: 'boom', type: 'x', name: 'never', when: () => { throw new Error('nope'); } };
  const later = { rule: 'later', type: 'x', name: 'later-task', when: () => true, args: () => ({ priority: 1 }) };
  const candidates = evaluate(brain.ctx, {
    cfg: brain.cfg,
    rules: [throwing, later],
    onRuleError: (failure) => errors.push(failure)
  });
  assert.strictEqual(candidates.length, 1);
  assert.strictEqual(candidates[0].name, 'later-task');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].rule, 'boom');
});

// ---------------------------------------------------------------- 5. TaskSlot
process.stdout.write('\n5. TaskSlot (S2a)\n');

const { TaskSlot } = require('../src/core/taskSlot');

check('TaskSlot: one owner at a time; a second acquire fails', () => {
  const brain = makeBrain({});
  const slot = brain.slot;
  assert(slot instanceof TaskSlot);
  assert.strictEqual(slot.busy, false);
  const first = slot.acquire({ kind: 'brain', task: { name: 'a' }, id: 'a' });
  assert(first.ok);
  assert.strictEqual(brain.activeTask.name, 'a', 'activeTask is a view of the slot');
  const second = slot.acquire({ kind: 'brain', task: { name: 'b' }, id: 'b' });
  assert.strictEqual(second.ok, false, 'the body already has an owner');
  assert.strictEqual(brain.activeTask.name, 'a');
  assert.strictEqual(slot.release(first.owner), true);
  assert.strictEqual(brain.activeTask, null);
});

check('TaskSlot: a hub owner holds the brain, a brain owner does not', () => {
  const brain = makeBrain({});
  const slot = brain.slot;
  const brainOwner = slot.acquire({ kind: 'brain', task: { name: 'b' }, id: 'b' });
  assert.strictEqual(brain.holds.has('task'), false, 'a planner task must not block directives');
  slot.release(brainOwner.owner);
  const hubOwner = slot.acquire({ kind: 'hub', handle: { name: 'h' }, id: 'h1', holdsBody: true });
  assert.strictEqual(brain.holds.has('task'), true, 'a hub job holds the brain');
  assert.strictEqual(slot.hubHandle, hubOwner.owner.handle);
  slot.release(hubOwner.owner);
  assert.strictEqual(brain.holds.has('task'), false, 'releasing the hub job frees the brain');
});

check('TaskSlot: only the owner can release the slot', () => {
  const brain = makeBrain({});
  const slot = brain.slot;
  const owner = slot.acquire({ kind: 'brain', task: { name: 'x' }, id: 'x' });
  assert.strictEqual(slot.release({ kind: 'brain' }), false, 'a foreign owner must not release');
  assert(slot.busy, 'the slot stays owned');
  assert.strictEqual(slot.release(owner.owner), true);
});

// ------------------------------------------------------- 6. S2b execution
process.stdout.write('\n6. TaskSlot execution (S2b)\n');

(async () => {
  const brain = makeBrain({});
  const events = [];
  brain.on('task:done', (event) => events.push(event));
  const task = {
    name: 'probe-run',
    description: 'walk to 1,2,3',
    source: 'test',
    state: 'pending',
    result: null,
    async execute() {
      this.state = 'done';
      this.result = { ok: true, reason: 'arrived' };
    }
  };
  await brain.runTask(task);
  check('TaskSlot.runTask executes, releases the body and publishes one event', () => {
    assert.strictEqual(brain.slot.busy, false, 'the slot must be free after execution');
    assert.strictEqual(brain.activeTask, null);
    assert.strictEqual(events.length, 1, `expected one completion event, got ${events.length}`);
    assert.strictEqual(events[0].name, 'probe-run');
    assert.strictEqual(events[0].source, 'test');
  });

  // ------------------------------------------------------------ 7. proposals
  process.stdout.write('\n7. proposals (S3)\n');
  {
    const brain = makeBrain({ 'minecraft:wooden_pickaxe': 1 });
    brain.plannerMode = 'proposals';
    brain.running = true; // the drain only runs while the brain is online
    let clock = 1000;
    brain.proposals.now = () => clock;
    brain.ctx.controller.bot = {};
    brain.ctx.world.snapshot = () => ({
      inventory: { 'minecraft:wooden_pickaxe': 1 },
      emptySlots: 36,
      health: 20,
      food: 20,
      ready: true
    });
    const runs = [];
    brain.runTask = async (task) => {
      runs.push(task);
      task.state = 'done';
    };

    await brain.slowLoop();
    const pending = brain.proposals.pending();
    check('proposals mode offers a goal but does not execute it', () => {
      assert(pending, 'a proposal should be waiting');
      assert.strictEqual(pending.target, 'mine');
      assert.strictEqual(runs.length, 0, 'nothing may run before the player answers');
      assert.strictEqual(brain.lastDecision.decision, 'propose:mine');
    });

    await brain.acceptProposal(pending.id, { by: 'player' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('accepting a proposal executes exactly one directive task', () => {
      assert.strictEqual(runs.length, 1);
      assert.strictEqual(runs[0].name, 'mine');
      assert.strictEqual(brain.proposals.pending(), null);
    });

    const second = brain.proposeNext();
    assert(second && second.ok, 'a new proposal after the first was answered');
    brain.rejectProposal(second.proposal.id);
    check('a rejection starts a 3 minute cooldown for that target (A25)', () => {
      const cooled = brain.proposeNext();
      assert(cooled && cooled.ok === false && cooled.reason === 'cooldown');
      assert(cooled.retryAt >= clock + 180000 - 1);
      clock += 180001;
      const again = brain.proposeNext();
      assert(again && again.ok, 'after the cooldown the target may be proposed again');
    });

    check('an unanswered proposal expires and is never treated as consent (A25)', () => {
      clock += brain.proposals.ttlMs + 1;
      const expired = brain.proposals.sweep();
      assert(expired && expired.status === 'expired');
      assert.strictEqual(brain.proposals.pending(), null);
      assert.strictEqual(
        brain.proposals.history.filter((proposal) => proposal.status === 'accepted').length,
        1,
        'an expiry must not add an accepted proposal'
      );
      clock += brain.proposals.cooldownMs + 1;
    });

    const third = brain.proposeNext();
    assert(third && third.ok);
    brain.enqueue(
      { name: 'explicit-test', describe: () => 'explicit test task', state: 'pending', execute: async () => {} },
      { level: 'directive', source: 'test' }
    );
    check('an explicit task supersedes the pending question (A25)', () => {
      assert.strictEqual(brain.proposals.pending(), null);
      assert(brain.proposals.history.some((proposal) => proposal.status === 'superseded'));
    });
  }

  {
    const brain = makeBrain({ 'minecraft:wooden_pickaxe': 1 });
    brain.plannerMode = 'proposals';
    brain.running = true; // the drain only runs while the brain is online
    brain.ctx.controller.bot = {};
    brain.ctx.world.snapshot = () => ({
      inventory: { 'minecraft:wooden_pickaxe': 1 },
      emptySlots: 36,
      health: 20,
      food: 20,
      ready: true
    });
    const runs = [];
    brain.runTask = async (task) => {
      runs.push(task);
    };
    const first = brain.proposeNext();
    await brain.acceptProposal(first.proposal.id, { by: 'player', always: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    runs.length = 0;
    await brain.slowLoop();
    check('standing authorization auto-accepts the next same target', () => {
      assert.deepStrictEqual(brain.proposals.status().authorized, ['mine']);
      assert.strictEqual(runs.length, 1, 'the authorized target runs without asking');
      assert.strictEqual(runs[0].name, 'mine');
    });
  }

  // ----------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\nplanner retirement test: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write('FAILED\n');
    process.exit(1);
  }
  process.stdout.write('S0-S4 retirement is in place: evaluator + slot + proposals (offline only)\n');})();
