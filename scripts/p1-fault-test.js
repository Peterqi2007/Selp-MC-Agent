'use strict';

// Offline suites must not read or write the live session-state file (config enables it).
process.env.P1_STATE = 'off';

/**
 * `npm run p1:fault:test` - offline fault drills (P1 M7).
 *
 * These are not happy-path contracts. Each drill makes one thing go wrong and checks that the
 * agent recovers without leaving a second owner, a stuck queue or a replayed action:
 *
 *   1. a hanging task times out and releases the body slot;
 *   2. a cancelled task settles quickly and releases the slot;
 *   3. a task that throws leaves the slot free;
 *   4. `preempt()` cancels the current task and clears the queue;
 *   5. a hub takeover never runs at the same time as the brain task;
 *   6. restored state does not replay an action after a restart.
 *
 * No client, no network, no model calls.
 */

const assert = require('assert');
const { loadConfig } = require('../src/util/config');
const { Brain } = require('../src/brain');
const { TaskHub } = require('../src/core/taskHub');
const { Task } = require('../src/tasks/task');

const silent = { info() {}, warn() {}, debug() {} };
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

function makeBrain() {
  const cfg = loadConfig({ profile: null });
  const ctx = {
    cfg,
    log: silent,
    body: null,
    bodyKind: 'test',
    world: {
      snapshot: () => ({ inventory: {}, emptySlots: 36, health: 20, food: 20, ready: false }),
      isNight: () => false
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
  ctx.hub = new TaskHub(ctx, { log: silent });
  return brain;
}

class HangingTask extends Task {
  constructor(ctx) {
    super(ctx, { name: 'hang', description: 'never finishes', timeoutMs: 40 });
  }
  run() {
    return new Promise(() => {});
  }
}

class CancellableTask extends Task {
  constructor(ctx) {
    super(ctx, { name: 'cancellable', description: 'waits until cancelled', timeoutMs: 5000 });
  }
  run() {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (this.cancelled) {
          clearInterval(timer);
          resolve({ ok: false, reason: 'task cancelled' });
        }
      }, 5);
      if (timer.unref) timer.unref();
    });
  }
}

class ThrowingTask extends Task {
  constructor(ctx) {
    super(ctx, { name: 'thrower', description: 'throws', timeoutMs: 1000 });
  }
  run() {
    throw new Error('boom');
  }
}

class QuickTask extends Task {
  constructor(ctx) {
    super(ctx, { name: 'quick', description: 'finishes', timeoutMs: 1000 });
  }
  run() {
    return { ok: true, status: 'succeeded', reason: 'ok' };
  }
}

class FailingPlanTask extends Task {
  constructor(ctx) {
    super(ctx, { name: 'failing-plan-step', description: 'plan step fails', timeoutMs: 1000 });
    this.runs = 0;
  }
  run() {
    this.runs += 1;
    return { ok: false, status: 'blocked', reason: 'no target' };
  }
}

(async () => {
  process.stdout.write('P1 fault drills (offline)\n\n');

  {
    const brain = makeBrain();
    const result = await brain.runTask(new HangingTask(brain.ctx));
    check('a hanging task times out and releases the body slot', () => {
      assert.strictEqual(result.status, 'failed');
      assert.match(result.reason, /timeout/);
      assert.strictEqual(brain.activeTask, null);
      assert.strictEqual(brain.queue.length, 0);
    });
    const next = await brain.runTask(new QuickTask(brain.ctx));
    check('the next task can run after a timeout', () => {
      assert.strictEqual(next.status, 'succeeded');
      assert.strictEqual(brain.activeTask, null);
    });
  }

  {
    const brain = makeBrain();
    const task = new CancellableTask(brain.ctx);
    const running = brain.runTask(task);
    setTimeout(() => task.cancel(), 15);
    const result = await running;
    check('a cancelled task settles and frees the slot', () => {
      assert.strictEqual(result.status, 'cancelled');
      assert.strictEqual(brain.activeTask, null);
    });
  }

  {
    const brain = makeBrain();
    const result = await brain.runTask(new ThrowingTask(brain.ctx));
    check('a throwing task leaves the slot free', () => {
      assert.strictEqual(result.status, 'failed');
      assert.match(result.reason, /throw: boom/);
      assert.strictEqual(brain.activeTask, null);
    });
  }

  {
    const brain = makeBrain();
    const task = new CancellableTask(brain.ctx);
    brain.running = true;
    const running = brain.runTask(task);
    setTimeout(() => brain.preempt(), 10);
    await running;
    check('preempt cancels the current task and clears the queue', () => {
      assert.strictEqual(brain.queue.length, 0);
      assert.strictEqual(brain.activeTask, null);
    });
  }

  {
    const brain = makeBrain();
    let overlapped = false;
    const task = new CancellableTask(brain.ctx);
    const running = brain.runTask(task);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const job = await brain.ctx.hub.submit({
      name: 'takeover',
      description: 'hub takeover',
      source: 'test',
      run: async () => {
        overlapped = overlapped || !!brain.activeTask;
        return { ok: true, reason: 'ok' };
      }
    });
    await running;
    await new Promise((resolve) => setTimeout(resolve, 20));
    check('a hub takeover never runs beside the brain task', () => {
      assert(job.accepted);
      assert.strictEqual(overlapped, false, 'two owners were active at once');
    });
  }

  {
    const brain = makeBrain();
    brain.plans.applyDraft({ planId: 'p-fault', steps: [{ id: 's1' }] });
    const saved = brain.captureState();
    const restored = makeBrain();
    const runs = [];
    restored.runTask = async (task) => runs.push(task);
    restored.restoreState(saved);
    check('a restart restores state but replays nothing', () => {
      assert.strictEqual(runs.length, 0);
      assert.strictEqual(restored.plans.get('p-fault').version, 1);
      assert.strictEqual(restored.activeTask, null);
    });
  }

  {
    const brain = makeBrain();
    brain.running = true;
    const task = new FailingPlanTask(brain.ctx);
    task.planId = 'plan-fault-retry';
    task.stepId = 's1';
    const result = await brain.runTask(task);
    check('a plan-owned failure does not schedule a TaskSlot retry', () => {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(task.runs, 1, 'the plan step ran again without the PlanRunner');
      assert.strictEqual(task.retries, 0, 'TaskSlot must not retry a plan-owned task');
      assert.strictEqual(brain.activeTask, null);
    });
  }

  {
    const brain = makeBrain();
    brain.running = true;
    const first = new FailingPlanTask(brain.ctx);
    first.planId = 'plan-identity-1';
    first.stepId = 's1';
    await brain.runTask(first);
    const firstId = first.taskId;
    const firstEvents = brain.events.since(0).filter((event) => event.type === 'task:failed' && event.taskId === firstId).length;
    const saved = brain.captureState();

    const restored = makeBrain();
    restored.running = true;
    const info = restored.restoreState(saved);
    const second = new FailingPlanTask(restored.ctx);
    second.planId = 'plan-identity-2';
    second.stepId = 's1';
    await restored.runTask(second);
    check('a restart advances task ids so the next failure event is not deduped', () => {
      assert(info.ok);
      assert.notStrictEqual(second.taskId, firstId, 'the new task reused a restored taskId');
      assert.strictEqual(firstEvents, 1);
      const secondEvents = restored.events
        .since(0)
        .filter((event) => event.type === 'task:failed' && event.taskId === second.taskId).length;
      assert.strictEqual(secondEvents, 1, 'the new task:failed was deduped by an id collision');
    });
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\nP1 fault drills: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write('FAILED\n');
    process.exit(1);
  }
  process.stdout.write('slot and restart recovery stay clean under failure; no action replay\n');
})();
