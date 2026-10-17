'use strict';

/**
 * `npm run p1:contract:test` - P1 M1 offline contracts (P1 §1.4.1/§1.4.4, A04/A31).
 *
 * Covers the pieces that do not need a client:
 *   - TaskEvents: monotonic seq, idempotent publish, bounded replay, subscribers;
 *   - PlanStore: one writer, version increment, stale drafts refused, done steps preserved;
 *   - executor wiring: a planner task and a hub job both land in the event hub with the
 *     identity fields the SSE consumers will read;
 *   - the SSE helper: replay from `Last-Event-ID`, correct headers, token refusal.
 *
 * No client, no network, no model calls.
 */

const assert = require('assert');
const { loadConfig } = require('../src/util/config');
const { Brain } = require('../src/brain');
const { TaskHub } = require('../src/core/taskHub');
const { TaskEvents } = require('../src/core/taskEvents');
const { PlanStore } = require('../src/core/planStore');
const { streamEvents } = require('../src/web/eventStream');

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

process.stdout.write('P1 contract test (M1 offline)\n\n');

// ---------------------------------------------------------------- TaskEvents
process.stdout.write('1. TaskEvents\n');
check('publish assigns monotonic seq and drops duplicates', () => {
  const events = new TaskEvents();
  const first = events.publish({ type: 'task:done', taskId: 't1', attemptId: 't1', reason: 'ok' });
  const again = events.publish({ type: 'task:done', taskId: 't1', attemptId: 't1', reason: 'ok' });
  const second = events.publish({ type: 'task:failed', taskId: 't2', attemptId: 't2', reason: 'boom' });
  assert.strictEqual(first.seq, 1);
  assert.strictEqual(again, null, 'a duplicate eventId must be dropped');
  assert.strictEqual(second.seq, 2);
  assert.strictEqual(events.status().size, 2);
});

check('since() replays only newer events, and the ring stays bounded', () => {
  const events = new TaskEvents({ limit: 2 });
  events.publish({ type: 'a' });
  events.publish({ type: 'b' });
  events.publish({ type: 'c' });
  assert.deepStrictEqual(events.since(0).map((e) => e.type), ['b', 'c'], 'the ring drops the oldest');
  assert.deepStrictEqual(events.since(2).map((e) => e.type), ['c']);
  assert.deepStrictEqual(events.since(9), []);
});

check('subscribers receive new events and stop after unsubscribe', () => {
  const events = new TaskEvents();
  const seen = [];
  const off = events.subscribe((event) => seen.push(event.type));
  events.publish({ type: 'x' });
  off();
  events.publish({ type: 'y' });
  assert.deepStrictEqual(seen, ['x']);
});

// ----------------------------------------------------------------- PlanStore
process.stdout.write('\n2. PlanStore\n');
check('new plan starts at version 1 and keeps its steps', () => {
  const plans = new PlanStore();
  const result = plans.applyDraft({ planId: 'p1', goal: 'iron pickaxe', steps: [{ id: 's1' }, { id: 's2' }] });
  assert(result.ok);
  assert.strictEqual(result.plan.version, 1);
  assert.deepStrictEqual(result.plan.steps.map((s) => s.id), ['s1', 's2']);
  assert.strictEqual(plans.status().plans, 1);
});

check('a stale draft is refused and does not overwrite the plan', () => {
  const plans = new PlanStore();
  plans.applyDraft({ planId: 'p2', steps: [{ id: 's1' }] });
  const updated = plans.applyDraft({ planId: 'p2', baseVersion: 1, steps: [{ id: 's1' }, { id: 's2' }] });
  assert(updated.ok);
  assert.strictEqual(updated.plan.version, 2);
  const stale = plans.applyDraft({ planId: 'p2', baseVersion: 1, steps: [{ id: 's1' }] });
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.reason, 'stale');
  assert.strictEqual(plans.get('p2').version, 2, 'the stored plan must not move backwards');
});

check('a replan preserves done steps and only changes the unfinished part', () => {
  const plans = new PlanStore();
  plans.applyDraft({ planId: 'p3', steps: [{ id: 's1' }, { id: 's2' }] });
  plans.applyDraft({
    planId: 'p3',
    baseVersion: 1,
    steps: [{ id: 's1', status: 'done' }, { id: 's2' }]
  });
  const replanned = plans.applyDraft({
    planId: 'p3',
    baseVersion: 2,
    steps: [{ id: 's1', status: 'pending' }, { id: 's2', status: 'running' }]
  });
  assert(replanned.ok);
  const step1 = replanned.plan.steps.find((step) => step.id === 's1');
  assert.strictEqual(step1.status, 'done', 'a finished step must not be reopened by a replan');
});

// ------------------------------------------------------- capabilities + result
process.stdout.write('\n3. capabilities + result status\n');

check('capabilities distinguish body support from host requirements', () => {
  const { capabilities } = require('../src/core/capabilities');
  const table = capabilities({
    body: { supportsCrafting: true, supportsDeposit: false, supportsHunting: true },
    controller: { bot: null }
  });
  assert.strictEqual(table.crafting.supported, true);
  assert.strictEqual(table.deposit.supported, false);
  assert.match(table.deposit.reason, /container/);
  assert.strictEqual(table.light.supported, false, 'a body without mineflayer cannot place torches');
  assert.match(table.light.reason, /mineflayer/);
  const withBot = capabilities({ body: {}, controller: { bot: {} } });
  assert.strictEqual(withBot.shelter.supported, true);
});

check('normalizeResult assigns the P1 status vocabulary', () => {
  const { normalizeResult } = require('../src/tasks/task');
  assert.strictEqual(normalizeResult({ ok: true }).status, 'succeeded');
  assert.strictEqual(normalizeResult({ ok: true, partial: true }).status, 'partial');
  assert.strictEqual(normalizeResult({ ok: false, reason: 'cancelled by player' }).status, 'cancelled');
  assert.strictEqual(normalizeResult({ ok: false, reason: 'no path to target' }).status, 'blocked');
  assert.strictEqual(normalizeResult({ ok: false, reason: 'timeout after 5ms' }).status, 'failed');
  assert.strictEqual(normalizeResult({ ok: false, reason: 'unknown effect' }).status, 'unknown');
  assert.strictEqual(normalizeResult({ ok: true, status: 'blocked' }).status, 'blocked', 'explicit status wins');
});

check('the evaluator reads capabilities from the one table', () => {
  const { evaluate } = require('../src/planner/evaluator');
  const ctx = {
    cfg: loadConfig({ profile: null }),
    body: { supportsCrafting: false, supportsDeposit: false, supportsHunting: false },
    world: {
      snapshot: () => ({ inventory: {}, emptySlots: 36, health: 20, food: 20 }),
      isNight: () => false
    },
    controller: { bot: null },
    memory: { landmark: () => null },
    nav: {},
    log: silent
  };
  const candidates = evaluate(ctx, {});
  assert(!candidates.some((candidate) => candidate.rule === 'craft'), 'a body without crafting must not get craft rules');
  assert(!candidates.some((candidate) => candidate.rule === 'hunt'), 'a body without hunting must not get the hunt rule');
});

// ------------------------------------------------------------- brain wiring
process.stdout.write('\n4. executor wiring\n');

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

(async () => {
  const brain = makeBrain();
  const task = {
    name: 'probe-task',
    taskId: 'task-1',
    requestId: 'req-1',
    planId: 'plan-1',
    stepId: 'step-1',
    description: 'probe',
    source: 'test',
    retries: 0,
    state: 'pending',
    result: null,
    async execute() {
      this.result = { ok: true, reason: 'done' };
    }
  };
  await brain.runTask(task);
  check('a planner task publishes one event with the identity chain', () => {
    const done = brain.events.since(0).filter((event) => event.type === 'task:done');
    assert.strictEqual(done.length, 1, `expected one task:done, got ${done.length}`);
    assert.strictEqual(done[0].taskId, 'task-1');
    assert.strictEqual(done[0].requestId, 'req-1');
    assert.strictEqual(done[0].planId, 'plan-1');
    assert.strictEqual(done[0].stepId, 'step-1');
    assert.strictEqual(done[0].attemptId, 'probe-task#0');
  });

  const hub = brain.ctx.hub;
  const receipt = await hub.submit({
    name: 'hub-probe',
    description: 'hub probe',
    source: 'test',
    run: async () => ({ ok: true, reason: 'ok' })
  });
  assert(receipt.accepted, 'the hub should accept the job');
  await new Promise((resolve) => setTimeout(resolve, 30));
  check('a hub job publishes through the same hub with its task id', () => {
    const done = brain.events.since(0).filter((event) => event.type === 'task:done' && event.taskId === receipt.taskId);
    assert.strictEqual(done.length, 1, `expected the hub completion in the event hub, got ${done.length}`);
    assert.strictEqual(done[0].attemptId, receipt.taskId);
  });

  // ------------------------------------------------------------------- SSE
  process.stdout.write('\n5. SSE helper\n');

  function fakeRequest({ url = '/events', headers = {} } = {}) {
    const handlers = {};
    return {
      url,
      headers,
      on(event, handler) {
        handlers[event] = handler;
      },
      close() {
        if (handlers.close) handlers.close();
      }
    };
  }
  function fakeResponse() {
    const chunks = [];
    const handlers = {};
    return {
      statusCode: null,
      headers: null,
      chunks,
      writeHead(code, headers) {
        this.statusCode = code;
        this.headers = headers;
      },
      write(chunk) {
        chunks.push(String(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(String(chunk));
      },
      on(event, handler) {
        handlers[event] = handler;
      }
    };
  }

  check('a reconnect replays only the events after Last-Event-ID', () => {
    const events = new TaskEvents();
    events.publish({ type: 'a', taskId: 't1' });
    events.publish({ type: 'b', taskId: 't2' });
    events.publish({ type: 'c', taskId: 't3' });
    const req = fakeRequest({ headers: { 'last-event-id': '1' } });
    const res = fakeResponse();
    const started = streamEvents(req, res, { events, token: '', heartbeatMs: 100000 });
    assert.strictEqual(started, true);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    const body = res.chunks.join('');
    assert.match(body, /id: 2/);
    assert.match(body, /id: 3/);
    assert.doesNotMatch(body, /id: 1/);
    req.close();
  });

  check('a configured token rejects an unauthenticated stream', () => {
    const events = new TaskEvents();
    const req = fakeRequest();
    const res = fakeResponse();
    const started = streamEvents(req, res, { events, token: 'secret' });
    assert.strictEqual(started, false);
    assert.strictEqual(res.statusCode, 401);
    assert.match(res.chunks.join(''), /unauthorized/);
  });

  // ------------------------------------------------- PlanRunner + TurnLifecycle
  process.stdout.write('\n6. parent plan + turn lifecycle\n');
  const { PlanRunner } = require('../src/core/planRunner');
  const { TurnLifecycle } = require('../src/core/turnLifecycle');

  {
    const plans = new PlanStore();
    plans.applyDraft({
      planId: 'pl1',
      goal: 'g',
      steps: [
        { id: 's1', type: 'a', args: {} },
        { id: 's2', type: 'b', args: {} },
        { id: 's3', type: 'c', args: {} }
      ]
    });
    const ran = [];
    const runner = new PlanRunner({
      plans,
      createTask: (step, ids) => ({ name: step.id, ids, cancel() {} }),
      runTask: async (task) => {
        ran.push(task.name);
        return { ok: true, status: 'succeeded', reason: 'ok' };
      }
    });
    const outcome = await runner.run('pl1');
    check('PlanRunner runs steps in order and writes each one back', () => {
      assert.deepStrictEqual(ran, ['s1', 's2', 's3']);
      assert.strictEqual(outcome.ok, true);
      const plan = plans.get('pl1');
      assert.strictEqual(plan.version, 4, 'three step write-backs bump the version');
      assert(plan.steps.every((step) => step.status === 'done'));
    });
    ran.length = 0;
    await runner.run('pl1');
    check('PlanRunner skips steps already done (resume)', () => {
      assert.deepStrictEqual(ran, []);
    });
  }

  {
    const plans = new PlanStore();
    plans.applyDraft({ planId: 'pl2', steps: [{ id: 's1', type: 'a' }, { id: 's2', type: 'b' }] });
    const ran = [];
    const runner = new PlanRunner({
      plans,
      createTask: (step) => ({ name: step.id, cancel() {} }),
      runTask: async (task) => {
        ran.push(task.name);
        return { ok: false, status: 'blocked', reason: 'no path' };
      }
    });
    const outcome = await runner.run('pl2');
    check('PlanRunner stops at the first failed step', () => {
      assert.deepStrictEqual(ran, ['s1']);
      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(plans.get('pl2').steps[0].status, 'failed');
    });
  }

  {
    const plans = new PlanStore();
    plans.applyDraft({ planId: 'pl3', steps: [{ id: 's1', type: 'a' }, { id: 's2', type: 'b' }] });
    const ran = [];
    let runner = null;
    runner = new PlanRunner({
      plans,
      createTask: (step) => ({ name: step.id, cancel() {} }),
      runTask: async (task) => {
        ran.push(task.name);
        if (task.name === 's1') runner.cancel('player stop');
        return { ok: true, status: 'succeeded' };
      }
    });
    const outcome = await runner.run('pl3');
    check('PlanRunner cancel stops between steps', () => {
      assert.deepStrictEqual(ran, ['s1']);
      assert.strictEqual(outcome.cancelled, true);
      assert.strictEqual(outcome.ok, false);
    });
  }

  {
    const turns = new TurnLifecycle({ now: () => 1000 });
    const begun = turns.begin({ requestId: 'r1' });
    assert(begun.ok);
    const turnId = begun.turn.id;
    assert.strictEqual(turns.begin({}).ok, false, 'one turn at a time');
    assert(turns.wait(turnId, 't1').ok);
    assert.strictEqual(turns.ingest(turnId, { taskId: 't2', type: 'task:done' }).ok, false);
    assert(turns.ingest(turnId, { taskId: 't1', type: 'task:done' }).ok);
    assert.strictEqual(turns.ingest(turnId, { taskId: 't1', type: 'task:done' }).ok, false);
    const resumed = turns.resume(turnId);
    check('a parked turn resumes exactly once from the matching task', () => {
      assert(resumed.ok);
      assert.strictEqual(resumed.event.taskId, 't1');
      assert.strictEqual(turns.resume(turnId).ok, false, 'the same event cannot resume twice');
    });
    turns.finish(turnId);
    check('finishing the turn frees the session for the next one', () => {
      assert.strictEqual(turns.get(turnId).state, 'done');
      assert(turns.begin({}).ok);
    });
  }

  {
    const turns = new TurnLifecycle();
    const turnId = turns.begin({}).turn.id;
    turns.wait(turnId, 't1');
    turns.cancel(turnId, 'player said stop');
    check('a cancelled turn ignores late task events', () => {
      assert.strictEqual(turns.ingest(turnId, { taskId: 't1' }).ok, false);
      assert.strictEqual(turns.resume(turnId).ok, false);
    });
  }

  // --------------------------------------------------------- harness adapter
  process.stdout.write('\n7. harness adapter\n');
  const { HarnessAdapter } = require('../src/harness/adapter');

  {
    const turns = new TurnLifecycle();
    const adapter = new HarnessAdapter({ turns });
    const transcript = adapter.replay([
      { type: 'turn.started', requestId: 'r1' },
      { type: 'tool.call', turnId: 'turn-1', taskId: 't1', tool: 'mine' },
      { type: 'task.event', event: { type: 'task:done', taskId: 't1' } },
      { type: 'turn.resume', turnId: 'turn-1' },
      { type: 'tool.call', turnId: 'turn-1', taskId: 't2' },
      { type: 'task.event', event: { type: 'task:done', taskId: 't1' } },
      { type: 'turn.cancel', turnId: 'turn-1', reason: 'stop' },
      { type: 'task.event', event: { type: 'task:done', taskId: 't2' } }
    ]);
    check('the adapter maps a recorded harness stream to lifecycle actions', () => {
      assert.deepStrictEqual(
        transcript.map((action) => action.kind),
        ['started', 'waiting', 'resumable', 'resumed', 'waiting', 'ignored', 'cancelled', 'ignored']
      );
      assert.strictEqual(transcript[5].reason, 'task-mismatch');
      assert.strictEqual(transcript[7].reason, 'turn-cancelled');
    });
  }

  {
    const events = new TaskEvents();
    const turns = new TurnLifecycle();
    const adapter = new HarnessAdapter({ events, turns });
    const started = adapter.start({ requestId: 'r2' });
    adapter.toolCall({ turnId: started.turn.id, taskId: 't9', tool: 'mine' });
    events.publish({ type: 'task:done', taskId: 't9', attemptId: 't9', reason: 'ok' });
    events.publish({ type: 'task:done', taskId: 't9', attemptId: 't9', reason: 'ok' });
    const resumed = adapter.resume(started.turn.id);
    check('a real TaskEvents completion parks and resumes the turn once', () => {
      assert(resumed.ok);
      assert.strictEqual(resumed.event.taskId, 't9');
      assert.deepStrictEqual(
        adapter.actions.map((action) => action.kind),
        ['started', 'waiting', 'resumable', 'resumed']
      );
    });
  }

  // summary
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\nP1 contract test: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write('FAILED\n');
    process.exit(1);
  }
  process.stdout.write('M1 offline contracts hold (events hub + plan store + SSE + plan/turn/adapter)\n');
})();
