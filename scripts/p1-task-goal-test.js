'use strict';

/**
 * Player task -> DSH goal contract (operator review, 2026-10-29).
 *
 *   node scripts/p1-task-goal-test.js
 *
 * Proves that a player-issued task (in-game command or a language-brain dispatch, both of
 * which travel through `chat.handle` -> `enqueue`) injects ONE bounded goal into the action
 * brain, and that every refusal path is honest (no goal, no crash, task unaffected).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { TaskGoalInjection } = require('../src/core/taskGoal');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    process.stdout.write(`  FAIL  ${name}\n    ${err && err.message}\n`);
  }
}

function makeHarness(options = {}) {
  const calls = [];
  let now = 1_000_000;
  const bridge = {
    async boundAgentId() {
      return options.agentId === undefined ? 'agent-1' : options.agentId;
    },
    async goalOf() {
      if (options.activeGoal) return { id: options.activeGoal, phase: 'active' };
      if (options.completedGoal) return { id: options.completedGoal, phase: 'complete' };
      return null;
    },
    async createGoal(request) {
      calls.push(request);
      if (options.failCreate) return { ok: false, reason: 'busy' };
      return { ok: true, goal: { id: `goal-${calls.length}`, revision: 1 }, agentId: 'agent-1' };
    }
  };
  if (options.noBridge) delete bridge.createGoal;
  const injected = new TaskGoalInjection({
    bridge: options.noBridge ? { boundAgentId: bridge.boundAgentId, goalOf: bridge.goalOf } : bridge,
    cfg: options.cfg || {},
    now: () => now,
    log: { info() {}, warn() {}, debug() {} }
  });
  return { injected, calls, advance: (ms) => { now += ms; } };
}

async function main() {
  process.stdout.write('Player task -> DSH goal (offline)\n\n');

  await check('one accepted player task creates one bounded execution goal', async () => {
    const h = makeHarness();
    const res = await h.injected.maybeCreate({ command: '!mine dirt 2', taskName: 'MineBlockTask', source: 'chat' });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(h.calls.length, 1);
    const request = h.calls[0];
    assert.strictEqual(request.purpose, 'execute');
    assert.strictEqual(request.maxGoalRounds, 3);
    assert.match(request.goal, /玩家下发任务：!mine dirt 2/);
    assert.match(request.goal, /不要重复/);
    assert.match(request.goal, /不要把 Node 的失败回执当成成功/);
  });

  await check('the goal text tells the brain to supervise, not to redo the skill', async () => {
    const h = makeHarness();
    await h.injected.maybeCreate({ command: '!chop 2', taskName: 'ChopWoodTask', source: 'llm' });
    const text = h.calls[0].goal;
    assert.match(text, /监督/);
    assert.match(text, /mc_state\/mc_observe/);
    assert.match(text, /来源：llm/);
    assert.match(text, /ChopWoodTask/);
  });

  await check('an already active goal is joined, not duplicated', async () => {
    const h = makeHarness({ activeGoal: 'goal-running' });
    const res = await h.injected.maybeCreate({ command: '!mine dirt 1' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'goal-active');
    assert.strictEqual(h.calls.length, 0);
  });

  await check('a completed goal does not block a new task goal', async () => {
    const h = makeHarness({ completedGoal: 'goal-old' });
    const res = await h.injected.maybeCreate({ command: '!mine dirt 1' });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(h.calls.length, 1);
  });

  await check('the same command twice inside the dedupe window creates one goal', async () => {
    const h = makeHarness();
    await h.injected.maybeCreate({ command: '!mine dirt 1' });
    h.advance(1_000);
    const second = await h.injected.maybeCreate({ command: '!mine dirt 1' });
    assert.strictEqual(second.reason, 'duplicate-within-window');
    assert.strictEqual(h.calls.length, 1);
    h.advance(20_000);
    await h.injected.maybeCreate({ command: '!mine dirt 1' });
    assert.strictEqual(h.calls.length, 2, 'after the window a new goal is allowed');
  });

  await check('no bridge / disabled / empty command are honest skips', async () => {
    const noBridge = makeHarness({ noBridge: true });
    assert.strictEqual((await noBridge.injected.maybeCreate({ command: '!mine dirt 1' })).reason, 'no-bridge');
    const disabled = makeHarness({ cfg: { enabled: false } });
    assert.strictEqual((await disabled.injected.maybeCreate({ command: '!mine dirt 1' })).reason, 'disabled');
    const empty = makeHarness();
    assert.strictEqual((await empty.injected.maybeCreate({ command: '   ' })).reason, 'no-command');
    assert.strictEqual(noBridge.calls.length + disabled.calls.length + empty.calls.length, 0);
  });

  await check('a rejected goal creation is reported and does not throw', async () => {
    const h = makeHarness({ failCreate: true });
    const res = await h.injected.maybeCreate({ command: '!mine dirt 1' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'busy');
    assert.strictEqual(h.injected.status().created, 0);
    assert.strictEqual(h.injected.status().lastSkip.reason, 'busy');
  });

  await check('status exposes created/skipped for the panel', async () => {
    const h = makeHarness({ activeGoal: 'g' });
    await h.injected.maybeCreate({ command: '!mine dirt 1' });
    const status = h.injected.status();
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.skipped, 1);
    assert.strictEqual(status.lastSkip.reason, 'goal-active');
  });

  // ---------------------------------------------------------------- wiring
  await check('enqueue injects the goal and the command line is carried through', () => {
    const commands = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'commands.js'), 'utf8');
    assert.match(commands, /this\.ctx\.taskGoals\.maybeCreate\(/);
    assert.match(commands, /command: this\.dispatchLine/);
    assert.match(commands, /this\.dispatchLine = String\(line\)\.trim\(\)/);
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    assert.match(index, /new TaskGoalInjection\(/);
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'agent.json'), 'utf8'));
    assert.strictEqual(config.taskGoal.enabled, true);
    assert.strictEqual(config.taskGoal.maxGoalRounds, 3);
  });

  const failed = results.filter((entry) => !entry.ok);
  if (failed.length) {
    process.stdout.write(`\n${failed.length} failed of ${results.length}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\n${results.length}/${results.length} passed\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
