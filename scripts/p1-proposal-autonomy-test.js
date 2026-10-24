'use strict';

/**
 * `npm run p1:proposal-autonomy:test` - offline contracts for the action-brain
 * autonomous task proposal chain.
 *
 * No client, no DSH, no model calls: the harness bridge and language brain are fakes.
 * Covers the 5min idle clock, prep goal injection, 30s proposal window, approval ->
 * execution goal, rejection/expiry -> complete prep + 5min reset, and the prep guard
 * expectations that the plugin test verifies against the real plugin.
 */

const assert = require('assert');
process.env.P1_STATE = 'off';
const { EventEmitter } = require('events');
const { ProposalDesk } = require('../src/planner/proposals');
const { AutonomousProposalCoordinator } = require('../src/planner/autonomousProposals');
const { LanguageBrain } = require('../src/llm/languageBrain');
const { HarnessBridge } = require('../src/chat/harnessBridge');

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
  brain.holds = { list: () => [] };
  brain.planService = { status: () => ({ active: null, plans: [] }) };
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
  const bridge = {
    agentId: 'agent-1',
    goal: null,
    calls: [],
    completed: [],
    failCreate: null,
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
      if (this.failCreate) return { ok: false, reason: this.failCreate };
      const goal = {
        id: `goal-${this.calls.length}`,
        revision: 1,
        phase: 'active',
        objective: `${options.purpose}:${options.goal}`
      };
      this.goal = goal;
      return { ok: true, agentId: this.agentId, goal };
    },
    async completeGoal(options) {
      this.completed.push({ ...options });
      this.goal = this.goal ? { ...this.goal, phase: 'complete' } : null;
      return { ok: true, completed: true };
    }
  };
  return bridge;
}

function makeHarness(now) {
  const brain = fakeBrain(now);
  const bridge = fakeBridge();
  const expressions = [];
  const languageBrain = {
    async expressProposal(proposal) {
      expressions.push(proposal);
      return { ok: true, via: 'template', said: `proposal ${proposal.id}` };
    }
  };
  const ctx = { reply: async () => true };
  const coordinator = new AutonomousProposalCoordinator({
    brain,
    bridge,
    languageBrain,
    ctx,
    cfg: { enabled: true, idleMs: 300000, responseMs: 30000, prepTimeoutMs: 90000, maxGoalRounds: 3 },
    log: silent,
    now: () => now.value
  });
  coordinator.start();
  return { brain, bridge, languageBrain, coordinator, expressions, now, ctx };
}

function propose(brain, autonomous = true, overrides = {}) {
  return brain.proposals.propose({
    rule: autonomous ? 'action-brain-autonomous' : 'deepseek-harness',
    name: overrides.name || 'mine_dirt',
    type: overrides.type || 'mine',
    args: overrides.args || { block: 'dirt', count: 2 },
    reason: overrides.reason || '背包缺泥土',
    autonomous,
    ttlMs: autonomous ? 30000 : undefined,
    allowStandingAuth: autonomous ? false : undefined
  });
}

(async () => {
  await check('idle 5min injects exactly one proposal-prep goal (no execution)', async () => {
    const now = { value: 1_000_000 };
    const h = makeHarness(now);
    now.value += 300000;
    const result = await h.coordinator.tick();
    assert.strictEqual(result.reason, 'prep-started');
    assert.strictEqual(h.bridge.calls.length, 1);
    assert.strictEqual(h.bridge.calls[0].purpose, 'proposal');
    assert.strictEqual(h.bridge.calls[0].maxGoalRounds, 3);
    assert.strictEqual(h.coordinator.prepInFlight, true);
    assert.strictEqual(h.coordinator.awaitingProposal, true);
    assert.strictEqual(h.expressions.length, 0);
    return `prep goal ${h.bridge.calls[0].goal.slice(0, 40)}...`;
  });

  await check('a blocked brain never injects a prep goal', async () => {
    const now = { value: 1_000_000 };
    const h = makeHarness(now);
    h.brain.activeTask = { name: 'mine' };
    now.value += 400000;
    const result = await h.coordinator.tick();
    assert.strictEqual(result.reason, 'active-task');
    assert.strictEqual(h.bridge.calls.length, 0);
    h.brain.activeTask = null;
    now.value += 299999;
    assert.strictEqual((await h.coordinator.tick()).reason, 'idle-wait');
    now.value += 1;
    assert.strictEqual((await h.coordinator.tick()).reason, 'prep-started');
    return 'blocked -> 5min after unblock only';
  });

  await check('a stale pending plan does not block the 5min clock', async () => {
    const now = { value: 1_500_000 };
    const h = makeHarness(now);
    h.brain.planService.status = () => ({
      active: null,
      plans: [{ planId: 'a29-old', state: 'pending' }]
    });
    now.value += 300000;
    const result = await h.coordinator.tick();
    assert.strictEqual(result.reason, 'prep-started');
    assert.strictEqual(h.bridge.calls.length, 1);
    return 'pending (not running/waiting) is ignored';
  });

  await check('autonomous proposal is expressed once with a 30s TTL', async () => {
    const now = { value: 2_000_000 };
    const h = makeHarness(now);
    now.value += 300000;
    await h.coordinator.tick();
    const outcome = propose(h.brain, true);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.proposal.expiresAt - outcome.proposal.createdAt, 30000);
    await flush();
    assert.strictEqual(h.expressions.length, 1);
    assert.strictEqual(h.brain.proposals.pending().id, outcome.proposal.id);
    assert.strictEqual(h.brain.proposals.pending().candidate.autonomous, true);
    return 'language brain asked once; TTL 30000ms';
  });

  await check('accept injects an execution goal and never builds/enqueues a local task', async () => {
    const now = { value: 3_000_000 };
    const h = makeHarness(now);
    now.value += 300000;
    await h.coordinator.tick();
    const outcome = propose(h.brain, true);
    await flush();
    const accepted = await h.coordinator.accept(h.brain.proposals.pending());
    assert.strictEqual(accepted.ok, true);
    assert.strictEqual(accepted.goalInjected, true);
    assert.strictEqual(h.bridge.calls.length, 2);
    assert.strictEqual(h.bridge.calls[1].purpose, 'execute');
    assert.strictEqual(h.bridge.calls[1].replace, true);
    assert.strictEqual(h.bridge.calls[1].proposal.type, outcome.proposal.candidate.type);
    assert.strictEqual(h.bridge.calls[1].proposal.name, outcome.proposal.candidate.name);
    assert.deepStrictEqual(h.bridge.calls[1].proposal.args, outcome.proposal.candidate.args);
    assert.strictEqual(h.brain.proposals.pending(), null);
    return `execution goal ${h.bridge.calls[1].goal.slice(0, 30)}...`;
  });

  await check('reject completes prep and resets the 5min clock', async () => {
    const now = { value: 4_000_000 };
    const h = makeHarness(now);
    now.value += 300000;
    await h.coordinator.tick();
    propose(h.brain, true);
    await flush();
    const rejected = h.brain.proposals.reject();
    assert.strictEqual(rejected.ok, true);
    await flush();
    assert.ok(h.bridge.completed.length >= 1);
    assert.strictEqual(h.coordinator.lastResetReason, 'rejected');
    now.value += 299999;
    assert.strictEqual((await h.coordinator.tick()).reason, 'idle-wait');
    now.value += 1;
    assert.strictEqual((await h.coordinator.tick()).reason, 'prep-started');
    return 'rejected -> complete prep -> 5min';
  });

  await check('30s no answer expires, completes prep and resets', async () => {
    const now = { value: 5_000_000 };
    const h = makeHarness(now);
    now.value += 300000;
    await h.coordinator.tick();
    propose(h.brain, true);
    await flush();
    const before = h.bridge.completed.length;
    now.value += 30001;
    h.brain.proposals.sweep(now.value);
    await flush();
    assert.ok(h.bridge.completed.length > before);
    assert.strictEqual(h.coordinator.lastResetReason, 'expired');
    assert.strictEqual(h.brain.proposals.pending(), null);
    now.value += 299999;
    assert.strictEqual((await h.coordinator.tick()).reason, 'idle-wait');
    return 'expired at 30s -> 5min';
  });

  await check('accept after the 30s window is refused and injects no goal', async () => {
    const now = { value: 6_000_000 };
    const h = makeHarness(now);
    h.brain.proposals.propose({
      name: 'mine_dirt',
      type: 'mine',
      args: { block: 'dirt' },
      autonomous: true,
      ttlMs: 30000,
      allowStandingAuth: false
    });
    now.value += 30001;
    const result = await h.coordinator.accept(h.brain.proposals.pending());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'expired');
    assert.strictEqual(h.bridge.calls.length, 0);
    return 'late consent rejected';
  });

  await check('prep timeout completes the goal without a proposal', async () => {
    const now = { value: 7_000_000 };
    const h = makeHarness(now);
    now.value += 300000;
    await h.coordinator.tick();
    now.value += 90001;
    const result = await h.coordinator.tick();
    assert.strictEqual(result.reason, 'prep-timeout');
    assert.ok(h.bridge.completed.length >= 1);
    assert.strictEqual(h.coordinator.prepInFlight, false);
    assert.strictEqual(h.coordinator.lastResetReason, 'prep-timeout');
    return 'prep timeout -> complete + reset';
  });

  await check('no live action brain means no prep goal and no fake local work', async () => {
    const now = { value: 8_000_000 };
    const h = makeHarness(now);
    h.bridge.agentId = '';
    h.bridge.boundAgentId = async () => null;
    now.value += 300000;
    const result = await h.coordinator.tick();
    assert.strictEqual(result.reason, 'no-live-action-brain');
    assert.strictEqual(h.bridge.calls.length, 0);
    return 'no agent -> no-op';
  });

  await check('standing authorization cannot auto-accept an autonomous proposal', () => {
    const now = { value: 9_000_000 };
    const h = makeHarness(now);
    h.brain.proposals.authorized.add('mine_dirt');
    const outcome = propose(h.brain, true);
    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(outcome.autoAccepted, false);
    assert.ok(h.brain.proposals.pending());
    return 'explicit approval still required';
  });

  await check('HarnessBridge posts goal purpose/proposal and cleanup', async () => {
    const calls = [];
    const bridge = new HarnessBridge({
      url: 'http://harness.test',
      agentId: 'agent-x',
      fetchImpl: async (url, options) => {
        calls.push({ url, method: options.method, body: JSON.parse(options.body) });
        return {
          ok: true,
          status: url.endsWith('/goal/complete') ? 200 : 202,
          json: async () => ({
            ok: true,
            agentId: 'agent-x',
            goal: url.endsWith('/goal/complete') ? { id: 'g1', phase: 'complete' } : { id: 'g1', revision: 1 }
          })
        };
      },
      log: silent
    });
    const created = await bridge.createGoal({
      goal: 'propose a task',
      purpose: 'proposal',
      proposal: { type: 'mine', name: 'mine_dirt', args: { block: 'dirt' } },
      maxGoalRounds: 1
    });
    assert.strictEqual(created.ok, true);
    assert.strictEqual(calls[0].url, 'http://harness.test/goal');
    assert.strictEqual(calls[0].body.purpose, 'proposal');
    assert.strictEqual(calls[0].body.maxGoalRounds, 1);
    assert.strictEqual(calls[0].body.proposal.type, 'mine');
    const closed = await bridge.completeGoal({ goalId: 'g1', revision: 1 });
    assert.strictEqual(closed.ok, true);
    assert.strictEqual(calls[1].url, 'http://harness.test/goal/complete');
    return 'create purpose=proposal + cleanup endpoint';
  });

  await check('LanguageBrain.expressProposal has a deterministic fallback', async () => {
    const replies = [];
    const brain = new LanguageBrain({
      mode: 'unified',
      reply: async (text) => {
        replies.push(text);
        return true;
      },
      log: silent
    });
    const result = await brain.expressProposal({
      reason: '附近有铁矿',
      candidate: { type: 'mine_ore', name: 'mine_iron', args: { block: 'iron_ore' } }
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.via, 'template');
    assert.ok(replies[0].includes('!proposal accept'));
    assert.ok(replies[0].includes('30 秒'));
    return 'fallback names both accept/reject commands';
  });

  await check('LanguageBrain.expressProposal uses the model line when available', async () => {
    const replies = [];
    const brain = new LanguageBrain({
      mode: 'unified',
      complete: async () => '{"tool":"say","args":{"text":"附近有矿，要我去挖吗？回复 !proposal accept"}}',
      reply: async (text) => {
        replies.push(text);
        return true;
      },
      log: silent
    });
    const result = await brain.expressProposal({
      reason: '附近有矿',
      candidate: { type: 'mine', name: 'mine_iron', args: { block: 'iron_ore' } }
    });
    assert.strictEqual(result.via, 'llm');
    assert.deepStrictEqual(replies, ['附近有矿，要我去挖吗？回复 !proposal accept']);
    return 'model JSON parsed, only speech';
  });

  await check('Brain accepts a command-table proposal with no TASK_BUILDER (farm)', async () => {
    const { Brain } = require('../src/brain');
    const { loadConfig } = require('../src/util/config');
    const cfg = loadConfig({ profile: null });
    const ctx = {
      cfg,
      log: silent,
      body: null,
      bodyKind: 'test',
      world: { snapshot: () => ({ ready: true, inventory: {}, emptySlots: 36, health: 20, food: 20, hostiles: [] }) },
      nav: { stop() {}, interrupt() {} },
      eat: { tick: async () => true },
      combat: { defend: async () => true },
      tools: { equipArmor: async () => true },
      controller: { bot: null, isAlive: true, snapshot: () => ({ ready: true }), loadedPlugins: [] },
      memory: { bump() {}, recordTask() {}, save() {}, landmark: () => null, summary: () => ({ deaths: 0 }) },
      reply: () => true,
      chat: { handlers: { farm: () => {}, mine: () => {} } }
    };
    const brain = new Brain(ctx);
    ctx.brain = brain;
    ctx.proposalCoordinator = { awaitingProposal: true, responseMs: 30000 };
    const result = await brain.proposeFromHarness({
      type: 'farm',
      name: 'farm',
      args: { radius: 6 },
      reason: 'ripe carrot',
      autonomous: true
    });
    assert.strictEqual(result.ok, true);
    const pending = brain.proposals.pending();
    assert(pending && pending.candidate.commandType === true, 'farm must be marked commandType');
    const unknown = await brain.proposeFromHarness({
      type: 'not-a-command',
      name: 'x',
      args: {},
      autonomous: true
    });
    assert.strictEqual(unknown.ok, false);
    assert.strictEqual(unknown.reason, 'unknown-task-type');
    return 'farm accepted; unknown rejected';
  });

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`P1 proposal autonomy: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const failure of failed) process.stdout.write(`  FAILED: ${failure.name} - ${failure.detail}\n`);
    process.exitCode = 1;
  }
})().catch((err) => {
  process.stderr.write(`p1-proposal-autonomy-test crashed: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
