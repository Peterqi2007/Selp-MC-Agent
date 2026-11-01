'use strict';

/**
 * `npm run p1:autonomous:test` - offline contracts for the fully autonomous mode.
 *
 * No client, no DSH, no model calls: the body, the bridge, the brain and the clock are fakes,
 * the mode and the proposal coordinator are the real implementations.
 *
 * What this suite is allowed to claim: the state machine, the player gates, the auto-accept
 * loop, the curriculum write-back, the guards and the death/recovery sequence behave as
 * documented. What it is NOT allowed to claim: that a real corpse can be looted on the server -
 * that is A33 in docs/P1-CLIENT-TESTS.md and needs a real client.
 */

const assert = require('assert');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

process.env.P1_STATE = 'off';

const { ProposalDesk } = require('../src/planner/proposals');
const { AutonomousProposalCoordinator } = require('../src/planner/autonomousProposals');
const { AutonomousMode, DEFAULTS } = require('../src/core/autonomousMode');
const { recoverCorpse, inventoryDelta, hazardAt } = require('../src/core/corpseRecovery');
const { findCorpseEntities } = require('../src/skills/corpse');
const { Curriculum } = require('../src/planner/curriculum');
const { LanguageBrain } = require('../src/llm/languageBrain');
const { ChatController } = require('../src/chat/commands');
const { installPermissionGate } = require('../src/core/permissionGate');

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const results = [];

function check(name, fn) {
  try {
    const outcome = fn();
    if (outcome && typeof outcome.then === 'function') {
      return outcome.then(
        () => {
          results.push({ name, ok: true });
          process.stdout.write(`  PASS  ${name}\n`);
        },
        (err) => {
          results.push({ name, ok: false, detail: err.message });
          process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
        }
      );
    }
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
  }
  return Promise.resolve();
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a predicate on the microtask queue (no timers: the fake clock drives the logic). */
async function until(predicate, label = 'condition', attempts = 200) {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true;
    await flush();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function tmpCurriculum() {
  const file = path.join(os.tmpdir(), `mc-curr-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  return new Curriculum({ cfg: { enabled: true, file, bandStep: 2, maxLevel: 4, maxRejections: 2, historyLimit: 12 }, log: silent });
}

// --------------------------------------------------------------------- fakes

function fakeBrain(now) {
  const brain = new EventEmitter();
  brain.paused = false;
  brain.stopped = false;
  brain.attached = true;
  brain.autoPlanDisabled = false;
  brain.safeMode = false;
  brain.activeTask = null;
  brain.currentTask = null;
  brain.queue = [];
  brain.slot = { busy: false };
  /** A real hold set: the operator-stop lock is read through `holds.has('owner-stop')`. */
  const holdSet = new Set();
  brain.holds = {
    list: () => [...holdSet],
    has: (name) => holdSet.has(name),
    hold: (name) => holdSet.add(name),
    release: (name) => holdSet.delete(name),
    clear: () => holdSet.clear()
  };
  brain.hold = (reason) => {
    holdSet.add(reason);
    return {};
  };
  brain.planService = { status: () => ({ active: null, plans: [] }), cancelAll: () => Promise.resolve() };
  brain.turnService = { cancelAll: () => {} };
  brain.calls = { resume: 0, resumeFromDeath: 0, preempt: 0, enqueue: 0 };
  brain.preempt = () => {
    brain.calls.preempt += 1;
  };
  brain.resume = () => {
    brain.calls.resume += 1;
    brain.paused = false;
    brain.stopped = false;
    holdSet.delete('owner-stop');
    holdSet.delete('paused');
    return { paused: false };
  };
  brain.resumeFromDeath = () => {
    brain.calls.resumeFromDeath += 1;
    brain.stopped = false;
    return { stopped: false };
  };
  brain.enqueue = () => {
    brain.calls.enqueue += 1;
    return { accepted: true };
  };
  brain.proposals = new ProposalDesk({}, {
    brain,
    cooldownMs: 180000,
    ttlMs: 300000,
    now: () => (now ? now.value : Date.now())
  });
  brain.on = (event, handler) => {
    EventEmitter.prototype.on.call(brain, event, handler);
    return () => EventEmitter.prototype.off.call(brain, event, handler);
  };
  return brain;
}

function fakeBridge() {
  return {
    agentId: 'agent-1',
    goal: null,
    calls: [],
    completed: [],
    async boundAgentId() {
      return this.agentId;
    },
    async health() {
      return { ok: true, busy: false, turns: [], boundAgentId: this.agentId };
    },
    async goalOf() {
      return this.goal;
    },
    async createGoal(options) {
      this.calls.push({ ...options });
      const goal = { id: `goal-${this.calls.length}`, revision: 1, phase: 'active', objective: `${options.purpose}:${options.goal}` };
      this.goal = goal;
      return { ok: true, agentId: this.agentId, goal };
    },
    async completeGoal(options) {
      this.completed.push({ ...options });
      this.goal = this.goal ? { ...this.goal, phase: 'complete' } : null;
      return { ok: true, completed: true };
    }
  };
}

/** A body that can be told what to report and records every call. */
function fakeBody(options = {}) {
  const state = {
    ready: true,
    dead: options.dead === true,
    position: options.position || { x: 10, y: 64, z: 10 },
    dimension: options.dimension || 'minecraft:overworld',
    health: 18,
    food: 15,
    inventory: options.inventory || { 'minecraft:dirt': 3 },
    entities: options.entities || [],
    screenOpen: false,
    screen: null
  };
  let menuOpen = null;
  const calls = { respawn: 0, moveTo: [], useEntity: [], clickSlot: [], closeMenu: 0 };
  const body = {
    state,
    calls,
    snapshot: () => ({ ...state, entities: state.entities.map((e) => ({ ...e })) }),
    refreshStrict: async () => ({ ok: true }).then(() => true),
    blockAt: () => ({ name: 'minecraft:grass_block' }),
    async moveTo(position, opts = {}) {
      calls.moveTo.push({ position: { ...position }, opts });
      state.position = { ...position };
      return true;
    },
    async respawn() {
      calls.respawn += 1;
      if (options.respawnFails === true) return { ok: false, reason: 'not-dead' };
      state.dead = false;
      return { ok: true, reason: null };
    },
    async useEntity(id) {
      calls.useEntity.push(id);
      if (options.useFails === true) return { ok: false, reason: 'no-entity-or-out-of-reach' };
      menuOpen = options.menu || {
        open: true,
        menuClass: 'CorpseInventoryScreen',
        slots: [
          { i: 0, item: 'minecraft:iron_pickaxe', count: 1, player: false },
          { i: 1, item: 'minecraft:diamond', count: 5, player: false },
          { i: 2, item: 'minecraft:oak_log', count: 12, player: false },
          { i: 3, item: 'null', count: 0, player: true }
        ]
      };
      state.screenOpen = true;
      state.screen = menuOpen.menuClass;
      return { ok: true, reason: null };
    },
    async menu() {
      return menuOpen;
    },
    async clickSlot(slot, opts = {}) {
      calls.clickSlot.push({ slot, opts });
      if (!menuOpen) return false;
      const target = menuOpen.slots.find((entry) => entry.i === slot);
      if (!target) return false;
      if (options.clickFails === true) return false;
      target.item = 'null';
      target.count = 0;
      return true;
    },
    async closeMenu() {
      calls.closeMenu += 1;
      menuOpen = null;
      state.screenOpen = false;
      state.screen = null;
      return true;
    },
    async interrupt() {
      return true;
    }
  };
  return body;
}

function makeHarness(options = {}) {
  const now = { value: options.at || 1_000_000 };
  const brain = fakeBrain(now);
  const bridge = fakeBridge();
  const body = options.body || fakeBody(options.bodyOptions || {});
  const curriculum = tmpCurriculum();
  const replies = [];
  const ctx = {
    brain,
    body,
    bridge,
    harnessBridge: bridge,
    cfg: { agent: { planner: {} } },
    curriculum,
    conversation: null,
    reply: async (text, meta) => {
      replies.push({ text, meta });
      return true;
    },
    log: silent
  };
  const stopped = [];
  const clears = [];
  if (options.spyStop) {
    ctx.stopActionBrain = async (reason) => {
      stopped.push(reason);
      return { ok: true };
    };
  }
  if (options.spyStop) {
    /**
     * Starting the mode is a takeover: it must clear a leftover goal, including an ACTIVE one
     * left by a task that failed before its round began (live retest 2026-11-01).
     */
    ctx.clearActionBrainGoal = async (opts) => {
      clears.push(opts || {});
      return { ok: true, cleared: true, goalId: 'goal-leftover' };
    };
  }
  const coordinator = new AutonomousProposalCoordinator({
    brain,
    bridge,
    curriculum,
    ctx,
    cfg: { enabled: true, idleMs: 300000, responseMs: 30000, prepTimeoutMs: 90000, maxGoalRounds: 3, executionGoalRounds: 6 },
    log: silent,
    now: () => now.value
  });
  coordinator.start();
  const mode = new AutonomousMode({
    ctx,
    cfg: { ...(options.cfg || {}), tickMs: 1e9 },
    log: silent,
    now: () => now.value
  });
  ctx.autonomous = mode;
  ctx.proposalCoordinator = coordinator;
  coordinator.mode = mode;
  return { now, brain, bridge, body, curriculum, coordinator, mode, ctx, replies, stopped, clears };
}

function propose(brain, overrides = {}) {
  return brain.proposals.propose({
    rule: 'action-brain-autonomous',
    name: overrides.name || 'mine_dirt',
    type: overrides.type || 'mine',
    args: overrides.args || { block: 'dirt', count: 2 },
    reason: overrides.reason || '背包缺泥土',
    autonomous: true,
    ttlMs: 30000,
    allowStandingAuth: false
  });
}

// --------------------------------------------------------------------- checks

(async () => {
  process.stdout.write('\nFully autonomous mode (offline)\n\n');

  await check('config defaults are complete and an empty allowlist falls back', () => {
    assert.strictEqual(DEFAULTS.enabled, true);
    assert.ok(DEFAULTS.commandAllowlist.includes('autonomous'));
    const mode = new AutonomousMode({ ctx: {}, cfg: { commandAllowlist: [] }, log: silent });
    assert.deepStrictEqual(mode.cfg.commandAllowlist, DEFAULTS.commandAllowlist);
    assert.ok(mode.cfg.death.corpseEntityTypes.includes('corpse:corpse'));
  });

  await check('start refuses without a live body or without the coordinator', async () => {
    const noBody = new AutonomousMode({ ctx: { body: null }, log: silent });
    assert.strictEqual((await noBody.start({})).reason, 'body-not-attached');
    const body = fakeBody();
    const noCoordinator = new AutonomousMode({ ctx: { body }, log: silent });
    assert.strictEqual((await noCoordinator.start({})).reason, 'no-action-brain');
  });

  await check('start clears operator holds, runs, and records the objective', async () => {
    const h = makeHarness();
    h.brain.paused = true;
    const result = await h.mode.start({ objective: '拿到钻石' });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(h.mode.phase, 'running');
    assert.strictEqual(h.mode.objective, '拿到钻石');
    assert.strictEqual(h.brain.calls.resume, 1);
    assert.strictEqual(h.mode.isActive(), true);
  });

  await check('!stop pauses the mode and !resume does not restart it', async () => {
    const h = makeHarness();
    await h.mode.start({});
    h.mode.pause('!stop');
    assert.strictEqual(h.mode.phase, 'paused');
    assert.strictEqual(h.mode.isActive(), false);
    /** The ChatController's resume handler must not resurrect an autonomous mode. */
    const controller = new ChatController({ ...h.ctx, autonomous: h.mode }, {});
    const replied = [];
    controller.ctx.reply = async (text) => replied.push(text);
    await controller.handle('resume', 'tester');
    assert.strictEqual(h.mode.phase, 'paused');
    assert.ok(replied.some((line) => /autonomous on/.test(line)));
  });

  await check('the command gate keeps the allowlist and refuses tasks with the busy line', async () => {
    const h = makeHarness();
    await h.mode.start({});
    for (const name of ['autonomous', 'stop', 'status', 'help', 'inv', 'where']) {
      assert.strictEqual(h.mode.gateCommand(name).blocked, false, name);
    }
    const gate = h.mode.gateCommand('mine');
    assert.strictEqual(gate.blocked, true);
    assert.match(gate.line, /正在忙/);
    assert.match(gate.line, /做不了/);
  });

  await check('the busy line reports the current task, the position and health/food', async () => {
    const h = makeHarness({ bodyOptions: { position: { x: 12, y: 64, z: -8 } } });
    await h.mode.start({});
    h.mode.round = 3;
    h.mode.lastActivity = { name: '挖 8 个铁矿', type: 'mine', args: { block: 'iron_ore' } };
    const line = h.mode.busyLine();
    assert.match(line, /挖 8 个铁矿/);
    assert.match(line, /12,64,-8/);
    assert.match(line, /血 18\/20/);
    assert.match(line, /饥饿 15\/20/);
    assert.match(line, /主世界/);
  });

  await check('no busy line and no approval gate while the mode is off', () => {
    const h = makeHarness();
    assert.strictEqual(h.mode.gateApproval('mine dirt'), null);
    assert.strictEqual(h.mode.gateCommand('mine').blocked, false);
  });

  await check('the command table refuses a player task without enqueueing anything', async () => {
    const h = makeHarness();
    await h.mode.start({});
    const said = [];
    const controller = new ChatController(
      { ...h.ctx, autonomous: h.mode, reply: async (text) => said.push(text) },
      {}
    );
    const outcome = await controller.handle('mine dirt 1', 'tester');
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.reason, 'autonomous-busy:mine');
    assert.strictEqual(h.brain.calls.enqueue, 0);
    assert.ok(said.some((line) => /正在忙/.test(line)));
    /**
     * The mode's own `mc_step` calls carry `source:'action-brain'`; gating them would refuse
     * the work the mode is doing (live 2026-11-01: `mine copper_ore 2` was busy-refused).
     */
    const ownStep = await controller.handle('mine dirt 1', 'mc_step', { source: 'action-brain' });
    assert.notStrictEqual(ownStep.reason, 'autonomous-busy:mine');
    /** The read-only control commands still work. */
    const statusOutcome = await controller.handle('autonomous status', 'tester');
    assert.strictEqual(statusOutcome.ok, true);
  });

  await check('an operator stop locks the action brain until resume', async () => {
    const h = makeHarness();
    await h.mode.start({});
    const controller = new ChatController({ ...h.ctx, autonomous: h.mode }, {});
    /**
     * 2026-11-01 operator report: `!stop` / `!autonomous off` did not stop the action brain.
     * The owner-stop hold must refuse its body calls even though the mode's own steps are
     * normally exempt from the busy gate.
     */
    h.brain.hold('owner-stop', '!stop');
    const blocked = await controller.handle('mine dirt 1', 'mc_step', { source: 'action-brain' });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.reason, 'operator-stop');
    assert.deepStrictEqual(blocked.requires, ['operator-resume']);
    assert.match(blocked.hint, /blocked/);
    /** Read-only commands stay usable for a final status check. */
    const state = await controller.handle('state', 'mc_step', { source: 'action-brain' });
    assert.notStrictEqual(state.reason, 'operator-stop');
    /** `!resume` clears the hold: the next action-brain step is allowed again. */
    h.brain.resume();
    const resumed = await controller.handle('mine dirt 1', 'mc_step', { source: 'action-brain' });
    assert.notStrictEqual(resumed.reason, 'operator-stop');
  });

  await check('!stop and !autonomous off tell the action brain to stop (goal pause+complete)', async () => {
    const h = makeHarness({ spyStop: true });
    await h.mode.start({});
    assert.strictEqual(h.brain.holds.has('owner-stop'), false);
    const controller = new ChatController({ ...h.ctx, autonomous: h.mode }, {});
    const stopped = await controller.handle('stop', 'tester');
    assert.strictEqual(stopped.ok, true);
    assert.strictEqual(h.brain.holds.has('owner-stop'), true, '!stop must lock the body');
    await flush();
    assert.ok(
      h.stopped.some((reason) => /!stop/.test(reason)),
      '!stop must ask the plugin to pause/complete the goal'
    );
    assert.strictEqual(h.mode.phase, 'paused');

    await h.mode.start({});
    assert.strictEqual(h.brain.holds.has('owner-stop'), false, 'start clears the operator lock');
    const off = await controller.handle('autonomous off', 'tester');
    assert.strictEqual(off.ok, true);
    await flush();
    assert.ok(
      h.stopped.some((reason) => /!autonomous off/.test(reason)),
      'off must stop the action brain'
    );
    assert.strictEqual(h.brain.holds.has('owner-stop'), true, 'off leaves the body locked');
    assert.strictEqual(h.mode.phase, 'off');
  });

  await check('the language-brain approval path answers busy and never forwards', async () => {
    const h = makeHarness();
    await h.mode.start({});
    const forwarded = [];
    const said = [];
    const brain = new LanguageBrain({
      mode: 'unified',
      ctx: { ...h.ctx, autonomous: h.mode },
      reply: async (text) => said.push(text),
      approvalGate: async () => ({ ok: true }),
      forwardToActionBrain: async (text) => {
        forwarded.push(text);
        return { ok: true };
      },
      log: silent
    });
    const record = await brain.handle({ text: '帮我挖点铁', source: 'dialogue', profile: 'approval', speaker: '玩家' });
    assert.strictEqual(record.decision, 'busy');
    assert.strictEqual(record.autonomous, true);
    assert.strictEqual(forwarded.length, 0);
    assert.ok(said.some((line) => /正在忙/.test(line)));
  });

  await check('a permission "ask" becomes a denial in the mode (no consent prompt)', async () => {
    const h = makeHarness();
    await h.mode.start({});
    const body = { dig: async () => true, lastRefusal: null };
    let asked = 0;
    installPermissionGate(body, {
      permissions: { check: () => ({ verdict: 'ask', reason: 'ask *' }) },
      consent: { ask: async () => { asked += 1; return 'allow'; } },
      log: silent,
      autonomous: () => h.mode
    });
    const result = await body.dig({ name: 'minecraft:stone', position: { x: 0, y: 64, z: 0 } });
    assert.strictEqual(result, false);
    assert.strictEqual(asked, 0);
    assert.match(String(body.lastRefusal.reason), /autonomous-no-approval/);
  });

  await check('the prep goal carries the autonomous preamble, the objective and the curriculum', async () => {
    const h = makeHarness();
    await h.mode.start({ objective: '拿到钻石' });
    /** `start()` kicks one tick; let it settle before driving the clock by hand. */
    await until(() => !h.coordinator._ticking, 'the startup tick');
    h.now.value += 6000;
    const tick = await h.coordinator.tick();
    assert.strictEqual(tick.reason, 'prep-started');
    const goal = h.bridge.calls[0].goal;
    assert.match(goal, /FULLY AUTONOMOUS MODE/);
    assert.match(goal, /OBJECTIVE: 拿到钻石/);
    assert.match(goal, /AUTOMATIC CURRICULUM/);
    assert.match(goal, /mc_ask_player/);
  });

  await check('a proposal is auto-accepted with no player and no announcement', async () => {
    const h = makeHarness();
    await h.mode.start({});
    h.now.value += 6000;
    await h.coordinator.tick();
    const proposed = propose(h.brain);
    assert.strictEqual(proposed.ok, true);
    await flush();
    const acceptedCall = h.bridge.calls.find((call) => call.purpose === 'execute');
    assert.ok(acceptedCall, 'no execution goal was created');
    assert.match(acceptedCall.goal, /FULLY AUTONOMOUS MODE/);
    assert.strictEqual(h.brain.proposals.pending(), null);
    assert.strictEqual(h.coordinator.stats.autoAccepted, 1);
    assert.strictEqual(h.mode.round, 1);
    assert.ok(h.replies.every((entry) => !/要我去做吗/.test(entry.text)));
  });

  await check('the execution goal settle feeds the curriculum and the mode counters', async () => {
    const h = makeHarness();
    await h.mode.start({});
    await until(() => !h.coordinator._ticking, 'the startup tick');
    h.now.value += 6000;
    await h.coordinator.tick();
    propose(h.brain);
    await until(() => h.coordinator.executionGoal, 'the auto-accepted execution goal');
    h.bridge.goal = { ...h.bridge.goal, phase: 'complete' };
    h.now.value += 1000;
    /** The tick that settles the execution goal continues into the idle check; assert effects. */
    await h.coordinator.tick();
    assert.strictEqual(h.coordinator.executionGoal, null);
    assert.strictEqual(h.mode.stats.completed, 1);
    assert.strictEqual(h.curriculum.status().completed, 1);
  });

  await check('the 5-minute idle clock is replaced by the short cooldown in the mode', () => {
    const h = makeHarness({ cfg: { roundCooldownMs: 5000 } });
    assert.strictEqual(h.coordinator.effectiveIdleMs(), 300000);
    h.mode.phase = 'running';
    assert.strictEqual(h.coordinator.effectiveIdleMs(), 5000);
  });

  await check('three empty prep rounds pause the mode instead of spinning', async () => {
    const h = makeHarness({ cfg: { maxPrepFailures: 3 } });
    await h.mode.start({});
    h.mode.notePreparation({ hadProposal: false });
    h.mode.notePreparation({ hadProposal: false });
    assert.strictEqual(h.mode.phase, 'running');
    h.mode.notePreparation({ hadProposal: false });
    assert.strictEqual(h.mode.phase, 'paused');
    assert.strictEqual(h.mode.pausedReason, 'prep-failures');
  });

  await check('a streak of blocked executions pauses the mode', async () => {
    const h = makeHarness({ cfg: { maxConsecutiveBlocked: 5 } });
    await h.mode.start({});
    for (let i = 0; i < 4; i += 1) h.mode.noteExecution({ phase: 'blocked' });
    assert.strictEqual(h.mode.phase, 'running');
    h.mode.noteExecution({ phase: 'blocked' });
    assert.strictEqual(h.mode.pausedReason, 'repeated-failures');
  });

  await check('the hourly round budget pauses a runaway loop', async () => {
    const h = makeHarness({ cfg: { maxRoundsPerHour: 2 } });
    await h.mode.start({});
    h.mode.noteRound({ name: 'a', type: 'mine' });
    h.mode.noteRound({ name: 'b', type: 'mine' });
    h.mode.noteRound({ name: 'c', type: 'mine' });
    assert.strictEqual(h.mode.pausedReason, 'budget');
  });

  await check('death: respawn, walk to the corpse, loot it, then resume the brain', async () => {
    const corpse = { id: 77, type: 'corpse:corpse', x: 20, y: 64, z: 20 };
    const h = makeHarness({ bodyOptions: { dead: true, entities: [corpse] } });
    await h.mode.start({});
    h.mode.onDeath({ position: { x: 20, y: 64, z: 20 }, dimension: 'minecraft:overworld' });
    await h.mode._deathTask;
    assert.strictEqual(h.mode.phase, 'running');
    assert.ok(h.body.calls.respawn >= 1);
    assert.strictEqual(h.brain.calls.resumeFromDeath, 1);
    assert.strictEqual(h.mode.stats.recoveries, 1);
    assert.strictEqual(h.mode.stats.recoveryFailures, 0);
    assert.ok(h.body.calls.useEntity.includes(77));
    assert.ok(h.body.calls.clickSlot.length >= 3);
    assert.ok(h.mode.lastRecovery && h.mode.lastRecovery.ok === true);
  });

  await check('death with no corpse is honest, bounded and does not block the curriculum', async () => {
    const h = makeHarness({ bodyOptions: { dead: true, entities: [] } });
    await h.mode.start({});
    const death = h.mode.onDeath({ position: { x: 5, y: 64, z: 5 }, dimension: 'minecraft:overworld' });
    assert.strictEqual(death.reason, 'death-sequence-started');
    await h.mode._deathTask;
    assert.strictEqual(h.mode.phase, 'running');
    assert.strictEqual(h.mode.stats.recoveryFailures, 1);
    assert.match(String(h.mode.lastRecovery.reason), /no-corpse|path-failed/);
    assert.strictEqual(h.brain.calls.resumeFromDeath, 1);
  });

  await check('recovery refuses another dimension, a hazard and a too-far corpse', async () => {
    const h = makeHarness();
    const other = await recoverCorpse(h.ctx, {
      death: { position: { x: 1, y: 64, z: 1 }, dimension: 'minecraft:the_nether' },
      cfg: { corpseRecovery: true },
      cancelled: () => false
    });
    assert.strictEqual(other.reason, 'other-dimension');
    const farBody = fakeBody({ position: { x: 5000, y: 64, z: 5000 } });
    const far = await recoverCorpse({ ...h.ctx, body: farBody }, {
      death: { position: { x: 0, y: 64, z: 0 }, dimension: 'minecraft:overworld' },
      cfg: { corpseRecovery: true, maxCorpseDistance: 100 },
      cancelled: () => false
    });
    assert.strictEqual(far.reason, 'too-far');
    const hazardBody = fakeBody();
    hazardBody.blockAt = () => ({ name: 'minecraft:lava' });
    assert.strictEqual(hazardAt(hazardBody, { x: 0, y: 64, z: 0 }), 'lava');
    const hz = await recoverCorpse({ ...h.ctx, body: hazardBody }, {
      death: { position: { x: 0, y: 64, z: 0 }, dimension: 'minecraft:overworld' },
      cfg: { corpseRecovery: true },
      cancelled: () => false
    });
    assert.strictEqual(hz.reason, 'hazard');
  });

  await check('a paused mode cancels a running recovery between steps', async () => {
    const h = makeHarness({ bodyOptions: { entities: [{ id: 5, type: 'corpse:corpse', x: 1, y: 64, z: 1 }] } });
    let cancelledFlag = false;
    const pending = recoverCorpse(h.ctx, {
      death: { position: { x: 1, y: 64, z: 1 }, dimension: 'minecraft:overworld' },
      cfg: { corpseRecovery: true },
      cancelled: () => cancelledFlag
    });
    cancelledFlag = true;
    const result = await pending;
    assert.strictEqual(result.ok, false);
  });

  await check('a corpse-like entity is found by type substring, nearest first', () => {
    const snapshot = {
      position: { x: 0, y: 64, z: 0 },
      entities: [
        { id: 1, type: 'minecraft:zombie', x: 1, y: 64, z: 1 },
        { id: 2, type: 'corpse:corpse', x: 8, y: 64, z: 0 },
        { id: 3, type: 'corpse:corpse_skeleton', x: 2, y: 64, z: 0 }
      ]
    };
    const found = findCorpseEntities(snapshot, { types: ['corpse:corpse'], radius: 16 });
    assert.strictEqual(found.length, 2);
    assert.strictEqual(found[0].id, 3);
    assert.strictEqual(found[1].id, 2);
    assert.strictEqual(findCorpseEntities(snapshot, { types: ['corpse'], radius: 4 }).length, 1);
  });

  await check('inventoryDelta reports what recovery actually brought back', () => {
    const delta = inventoryDelta({ 'minecraft:dirt': 3 }, { 'minecraft:dirt': 1, 'minecraft:iron_ingot': 4 });
    assert.strictEqual(delta.added, 4);
    assert.strictEqual(delta.removed, 2);
    assert.strictEqual(delta.net, 2);
  });

  await check('toJSON/restore round-trips and restores as paused(restart)', () => {
    const h = makeHarness();
    h.mode.phase = 'running';
    h.mode.round = 4;
    h.mode.objective = '目标';
    const saved = h.mode.toJSON();
    const other = new AutonomousMode({ ctx: {}, log: silent });
    const restored = other.restore(saved);
    assert.strictEqual(restored.ok, true);
    assert.strictEqual(other.phase, 'paused');
    assert.strictEqual(other.pausedReason, 'restart');
    assert.strictEqual(other.round, 4);
    assert.strictEqual(other.objective, '目标');
  });

  await check('without the mode a proposal still waits for the player', async () => {
    const h = makeHarness();
    h.now.value += 400000;
    await h.coordinator.tick();
    const proposed = propose(h.brain);
    assert.strictEqual(proposed.ok, true);
    await flush();
    assert.ok(h.brain.proposals.pending(), 'the proposal should still be pending');
    assert.strictEqual(h.bridge.calls.filter((call) => call.purpose === 'execute').length, 0);
  });

  await check('!autonomous off closes the goals and leaves the mode off', async () => {
    const h = makeHarness();
    await h.mode.start({});
    h.now.value += 6000;
    await h.coordinator.tick();
    propose(h.brain);
    await flush();
    const before = h.bridge.completed.length;
    h.mode.off('!autonomous off');
    await flush();
    assert.strictEqual(h.mode.phase, 'off');
    assert.ok(h.bridge.completed.length > before, 'the execution goal was not closed');
    assert.strictEqual(h.mode.isActive(), false);
  });

  await check('starting the mode takes over a leftover ACTIVE goal too', async () => {
    /**
     * Live retest 2026-11-01: a `goto` that failed before its round began left an active task
     * goal behind; `!autonomous on` then sat on `goal:active` and never started prep. Starting
     * is an explicit takeover, so the leftover must be closed - active or paused.
     */
    const h = makeHarness({ spyStop: true });
    await h.mode.start({});
    assert.ok(h.clears.length > 0, 'start must try to clear a leftover goal');
    assert.strictEqual(h.clears[0].includeActive, true, 'the takeover clears active goals, not only paused ones');
  });

  await check('three deaths inside the window pause the mode (no suicide loop)', async () => {
    const h = makeHarness({ cfg: { death: { deathLoopMax: 3, deathLoopWindowMs: 600000 } } });
    await h.mode.start({});
    h.mode.phase = 'running';
    for (let i = 0; i < 3; i += 1) h.mode.onDeath({ position: { x: i, y: 64, z: 0 }, dimension: 'minecraft:overworld' });
    assert.strictEqual(h.mode.phase, 'paused');
    assert.strictEqual(h.mode.pausedReason, 'death-loop');
  });

  await check('the tick backstop does not count one death twice', async () => {
    const h = makeHarness({ bodyOptions: { dead: true, entities: [] } });
    await h.mode.start({});
    /** The body is dead and the death sequence is already in flight: more ticks must not add deaths. */
    await h.mode.tick();
    await h.mode.tick();
    assert.strictEqual(h.mode.stats.deaths, 1);
    assert.strictEqual(h.mode.phase, 'dead');
    await h.mode._deathTask;
    assert.strictEqual(h.mode.stats.deaths, 1);
  });

  await check('a stop during a death sequence is not overwritten by the recovery', async () => {
    const h = makeHarness({ bodyOptions: { dead: true, entities: [] } });
    await h.mode.start({});
    h.mode.onDeath({ position: { x: 1, y: 64, z: 1 }, dimension: 'minecraft:overworld' });
    h.mode.pause('!stop');
    await h.mode._deathTask;
    assert.strictEqual(h.mode.phase, 'paused');
    assert.strictEqual(h.brain.calls.resumeFromDeath, 0);
  });

  // ------------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`fully autonomous mode: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('the mode is opt-in, approval-free, and its death recovery is bounded\n');
  }
})();
