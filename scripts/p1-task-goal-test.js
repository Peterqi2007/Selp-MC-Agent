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
    selfDefense: options.selfDefense,
    onNewGoal: options.onNewGoal,
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
    // Failure ladder (2026-10-31): the old "second failure" prose is now class-based.
    assert.match(request.goal, /失败按类别/);
    assert.match(request.goal, /同一签名第三次盲试/);
    assert.match(request.goal, /lookup_mod_content/);
    assert.match(request.goal, /mc_ask_player/);
    assert.match(request.goal, /key forward down\/up/);
    assert.match(request.goal, /hold attack 600/);
    assert.match(request.goal, /tap inventory/);
  });

  await check('a fresh goal clears the previous failure-escalation ledger', async () => {
    let resets = 0;
    const h = makeHarness({ onNewGoal: () => { resets += 1; } });
    const res = await h.injected.maybeCreate({ command: '!mine dirt 1', source: 'chat' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(resets, 1, 'new goal is the ledger boundary when DSH has no goal-end callback');
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

  await check('the goal tells the action brain when the self-defense reflex may preempt it', async () => {
    const on = makeHarness({
      selfDefense: () => ({ enabled: true, engageRadiusXZ: 15, engageRadiusY: 4, engageHealthThreshold: 16 })
    });
    await on.injected.maybeCreate({ command: '!mine dirt 2', taskName: 'MineBlockTask', source: 'chat' });
    assert.match(on.calls[0].goal, /自卫反射已开启/);
    assert.match(on.calls[0].goal, /不是你的指令/);
    assert.match(on.calls[0].goal, /XZ 15/);

    const off = makeHarness({ selfDefense: () => ({ enabled: false }) });
    await off.injected.maybeCreate({ command: '!mine dirt 2', taskName: 'MineBlockTask', source: 'chat' });
    assert.doesNotMatch(off.calls[0].goal, /自卫反射已开启/);
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

  // -------------------------------------------------- @ dialogue goals (2026-10-29)
  await check('an @ request gets a goal that keeps the original text and tells the brain to act', async () => {
    const h = makeHarness();
    const original = '去砍两棵树然后回来';
    const res = await h.injected.maybeCreateDialogue({ text: original, speaker: 'Alice', source: 'dialogue' });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(h.calls.length, 1);
    const request = h.calls[0];
    assert.strictEqual(request.purpose, 'execute');
    assert.match(request.goal, /@ 自然语言/);
    assert(request.goal.includes(JSON.stringify(original)), 'the original text is not carried verbatim');
    assert.match(request.goal, /Alice/);
    assert.match(request.goal, /跨轮/);
    assert.match(request.goal, /同一签名第三次盲试/);
    assert.match(request.goal, /update_goal complete/);
  });

  await check('an @ request does not stack onto an active goal', async () => {
    const h = makeHarness({ activeGoal: 'goal-running' });
    const res = await h.injected.maybeCreateDialogue({ text: '去砍树' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'goal-active');
    assert.strictEqual(h.calls.length, 0);
  });

  await check('the dialogue router wires @ requests to the goal injection', () => {
    const router = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'dialogueRouter.js'), 'utf8');
    assert.match(router, /maybeCreateDialogue\(/);
    assert.match(router, /this\._maybeGoal\(original, meta\)/);
    const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    assert.match(index, /new TaskGoalInjection\(/);
    // Unified language-brain / addressed channels call forwardToActionBrain, not the router.
    assert.match(index, /ctx\.forwardToActionBrain = async/);
    assert.match(index, /ctx\.taskGoals\.maybeCreateDialogue\(/);
    // Live 2026-10-30: the language brain used to inline its own bridge call and bypass the
    // goal injection. It must consume the shared wrapper.
    assert.match(index, /forwardToActionBrain: ctx\.forwardToActionBrain/);
    assert.doesNotMatch(index, /forwardToActionBrain: harnessBridge\s*\?/);
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
