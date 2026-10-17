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

  // ------------------------------------------------------ M2 routing/perception
  process.stdout.write('\n8. M2 routing + perception contracts\n');
  const { gateVerdict } = require('../src/chat/commandGate');
  const { selectSurface, verifySeparation, toolName, SURFACES, EXECUTION_TOOLS } = require('../src/llm/toolSurface');
  const { stampSnapshot, fieldAge, staleFields } = require('../src/world/freshness');

  check('the addressed gate dispatches the original text and nothing else', () => {
    const allowed = gateVerdict({ verdict: { verdict: 'allow', text: 'cut 3 trees' }, original: '帮我砍 3 棵树' });
    assert(allowed.ok);
    assert.strictEqual(allowed.dispatch, '帮我砍 3 棵树');
    assert.strictEqual(allowed.rewritten, 'cut 3 trees', 'a rewritten field is reported but never dispatched');
    assert.strictEqual(gateVerdict({ verdict: 'deny', original: '帮我砍树' }).ok, false);
    assert.strictEqual(gateVerdict({ verdict: 'maybe', original: 'x' }).reason, 'malformed');
    assert.strictEqual(gateVerdict({ verdict: 'allow', original: 'x', timedOut: true }).reason, 'timeout');
    assert.strictEqual(gateVerdict({ verdict: 'allow', original: '   ' }).reason, 'empty');
  });

  check('the language tool surface cannot execute', () => {
    const tools = [
      { name: 'observe' },
      { name: 'find_blocks' },
      { name: 'say' },
      { name: 'do_task' },
      { name: 'do_skill' },
      { name: 'go_to' },
      { name: 'stop' }
    ];
    const language = selectSurface(tools, 'language').map(toolName);
    assert.deepStrictEqual(language, ['observe', 'find_blocks', 'say']);
    assert(!language.some((name) => EXECUTION_TOOLS.includes(name)));
    const action = selectSurface(tools, 'action').map(toolName);
    assert.deepStrictEqual(action, ['do_task', 'do_skill', 'go_to', 'stop']);
    assert(verifySeparation(tools).ok);
    assert(!SURFACES.language.some((name) => EXECUTION_TOOLS.includes(name)));
  });

  check('perception fields carry their own age and stale schedule', () => {
    const snapshot = stampSnapshot({ position: { x: 1 }, inventory: {} }, { now: 1000 });
    assert.strictEqual(snapshot.observedAt.position, 1000);
    assert.strictEqual(snapshot.observedAt.entities, undefined, 'only fields that were refreshed get a stamp');
    assert.strictEqual(fieldAge(snapshot, 'position', 1500), 500);
    assert.strictEqual(fieldAge(snapshot, 'entities', 1500), Infinity, 'never observed means Infinity');
    const stale = staleFields(snapshot, { position: 400, inventory: 1000, entities: 0 }, 1500);
    assert.deepStrictEqual(stale.map((entry) => entry.field), ['entities', 'position']);
  });

  // ------------------------------------------------------------ persistence
  process.stdout.write('\n9. persistence\n');
  const { StateStore } = require('../src/core/stateStore');
  const fs = require('fs');
  const os = require('os');
  const nodePath = require('path');

  {
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'p1-state-'));
    const file = nodePath.join(dir, 'state.json');
    const store = new StateStore({ file });
    assert.strictEqual(store.load(), null, 'no file means nothing to restore');
    store.save({ version: 1, ok: true });
    assert.deepStrictEqual(store.load(), { version: 1, ok: true });
    fs.writeFileSync(file, '{broken');
    check('StateStore is atomic and quarantines a corrupt file', () => {
      assert.strictEqual(store.load(), null);
      assert(
        fs.readdirSync(dir).some((name) => name.includes('.corrupt-')),
        'the corrupt file is moved aside instead of crashing the agent'
      );
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  {
    const brain = makeBrain();
    brain.plans.applyDraft({ planId: 'p9', goal: 'iron', steps: [{ id: 's1' }, { id: 's2' }] });
    brain.plans.applyDraft({
      planId: 'p9',
      baseVersion: 1,
      steps: [{ id: 's1', status: 'done' }, { id: 's2' }]
    });
    brain.proposals.propose({ name: 'mine', reason: 'test', type: 'mine', args: {} });
    brain.events.publish({ type: 'task:done', taskId: 'tx', attemptId: 'tx', reason: 'ok' });
    const saved = brain.captureState();

    const restored = makeBrain();
    const outcome = restored.restoreState(saved);
    check('plans, the pending question and the event sequence survive a restart', () => {
      assert(outcome.ok);
      assert.strictEqual(restored.plans.get('p9').version, 2);
      assert.strictEqual(restored.plans.get('p9').steps[0].status, 'done');
      assert.strictEqual(restored.proposals.pending().target, 'mine');
      assert.strictEqual(restored.proposals.pending().status, 'awaiting');
      assert.strictEqual(restored.events.status().seq, 1);
    });

    const runs = [];
    restored.runTask = async (task) => runs.push(task);
    check('restore never replays an action', () => {
      assert.strictEqual(runs.length, 0, 'nothing may execute just because state was restored');
    });

    check('a restored plan still refuses a stale draft', () => {
      const stale = restored.plans.applyDraft({ planId: 'p9', baseVersion: 1, steps: [{ id: 's1' }] });
      assert.strictEqual(stale.reason, 'stale');
    });

    check('a restored question can be answered but is not consent by itself', () => {
      assert.strictEqual(restored.proposals.pending().status, 'awaiting');
      const accepted = restored.proposals.accept(null, { by: 'player' });
      assert(accepted.ok);
      assert.strictEqual(restored.proposals.pending(), null);
    });

    check('the restored event ring still drops duplicates', () => {
      assert.strictEqual(
        restored.events.publish({ type: 'task:done', taskId: 'tx', attemptId: 'tx', reason: 'ok' }),
        null
      );
    });
  }

  // ------------------------------------------------------- waiting_for_player
  process.stdout.write('\n10. waiting_for_player\n');
  {
    const plans = new PlanStore();
    plans.applyDraft({
      planId: 'pw',
      steps: [
        { id: 'a', type: 'mine' },
        { id: 'w', type: 'wait_for_player', args: { question: '还要继续吗？' } },
        { id: 'c', type: 'mine' }
      ]
    });
    const ran = [];
    const runner = new PlanRunner({
      plans,
      createTask: (step) => ({ name: step.id, cancel() {} }),
      runTask: async (task) => {
        ran.push(task.name);
        return { ok: true, status: 'succeeded' };
      }
    });
    const first = await runner.run('pw');
    check('a question step parks the plan without creating a task', () => {
      assert.deepStrictEqual(ran, ['a']);
      assert.strictEqual(first.ok, false);
      assert.strictEqual(first.waiting.stepId, 'w');
      assert.strictEqual(first.waiting.question, '还要继续吗？');
      const plan = plans.get('pw');
      assert.strictEqual(plan.steps.find((step) => step.id === 'w').status, 'waiting');
      assert.strictEqual(plan.steps.find((step) => step.id === 'c').status, 'pending');
    });
    const resumed = await runner.resume('pw', true);
    check('resume after a yes continues the remaining steps', () => {
      assert(resumed.ok);
      assert.deepStrictEqual(ran, ['a', 'c']);
      assert(plans.get('pw').steps.every((step) => step.status === 'done'));
    });
  }

  {
    const plans = new PlanStore();
    plans.applyDraft({
      planId: 'pr',
      steps: [
        { id: 'a', type: 'mine' },
        { id: 'w', type: 'wait_for_player', args: { question: '还要继续吗？' } },
        { id: 'c', type: 'mine' }
      ]
    });
    const ran = [];
    const runner = new PlanRunner({
      plans,
      createTask: (step) => ({ name: step.id, cancel() {} }),
      runTask: async (task) => {
        ran.push(task.name);
        return { ok: true, status: 'succeeded' };
      }
    });
    await runner.run('pr');
    const rejected = await runner.resume('pr', false);
    check('a no fails the waiting step and stops the plan', () => {
      assert.strictEqual(rejected.ok, false);
      assert.deepStrictEqual(ran, ['a']);
      const plan = plans.get('pr');
      assert.strictEqual(plan.steps.find((step) => step.id === 'w').status, 'failed');
      assert.strictEqual(plan.steps.find((step) => step.id === 'c').status, 'pending');
    });
    const again = await runner.resume('pr');
    check('resuming a finished question plan says nothing is waiting', () => {
      assert.strictEqual(again.ok, false);
      assert.strictEqual(again.reason, 'nothing-waiting');
    });
  }

  // --------------------------------------------------------------- resume bridge
  process.stdout.write('\n11. resume bridge\n');
  const { ResumeBridge } = require('../src/harness/resumeBridge');

  {
    const events = new TaskEvents();
    const turns = new TurnLifecycle();
    const adapter = new HarnessAdapter({ events, turns });
    const delivered = [];
    const bridge = new ResumeBridge({
      adapter,
      turns,
      deliver: async (turn, event) => delivered.push({ turnId: turn.id, taskId: event.taskId })
    });
    const started = adapter.start({ requestId: 'r1' });
    adapter.toolCall({ turnId: started.turn.id, taskId: 't1' });
    events.publish({ type: 'task:done', taskId: 't1', attemptId: 't1', reason: 'ok' });
    events.publish({ type: 'task:done', taskId: 't1', attemptId: 't1', reason: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('a completion is delivered to the parked turn exactly once', () => {
      assert.strictEqual(delivered.length, 1);
      assert.strictEqual(delivered[0].taskId, 't1');
      assert.strictEqual(turns.get(started.turn.id).state, 'running', 'delivery is followed by resume');
      assert.strictEqual(bridge.status().pending, 0);
    });
  }

  {
    const events = new TaskEvents();
    const turns = new TurnLifecycle();
    const adapter = new HarnessAdapter({ events, turns });
    const delivered = [];
    const bridge = new ResumeBridge({
      adapter,
      turns,
      deliver: async (turn, event) => delivered.push({ turnId: turn.id, taskId: event.taskId })
    });
    const started = adapter.start({ requestId: 'r2' });
    adapter.toolCall({ turnId: started.turn.id, taskId: 't2' });
    adapter.cancel(started.turn.id, 'player stop');
    events.publish({ type: 'task:done', taskId: 't2', attemptId: 't2', reason: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('a cancelled turn is never woken by a late completion', () => {
      assert.strictEqual(delivered.length, 0);
      assert.strictEqual(bridge.status().pending, 0);
      assert.strictEqual(turns.get(started.turn.id).state, 'cancelled');
    });
  }

  {
    const events = new TaskEvents();
    const turns = new TurnLifecycle();
    const adapter = new HarnessAdapter({ events, turns });
    let attempts = 0;
    const bridge = new ResumeBridge({
      adapter,
      turns,
      deliver: async () => {
        attempts += 1;
        throw new Error('harness offline');
      }
    });
    const started = adapter.start({ requestId: 'r3' });
    adapter.toolCall({ turnId: started.turn.id, taskId: 't3' });
    events.publish({ type: 'task:done', taskId: 't3', attemptId: 't3', reason: 'ok' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('a failed delivery keeps the resume queued for a retry', () => {
      assert.strictEqual(attempts, 1);
      assert.strictEqual(bridge.status().pending, 1);
      assert.strictEqual(turns.get(started.turn.id).state, 'resumable');
    });
    bridge.deliver = async () => {};
    await bridge.flush();
    check('a retry delivers once and resumes the turn', () => {
      assert.strictEqual(bridge.status().pending, 0);
      assert.strictEqual(turns.get(started.turn.id).state, 'running');
    });
  }

  // -------------------------------------------------- methods + answer memory
  process.stdout.write('\n12. methods + answer memory\n');
  const { MethodLibrary } = require('../src/learning/methodLibrary');
  const { AnswerMemory } = require('../src/learning/answerMemory');

  {
    const library = new MethodLibrary({ now: () => 1000 });
    const plains = library.add({
      goal: 'get iron',
      method: 'dig at y=16',
      conditions: { biome: 'plains' }
    });
    library.add({ goal: 'get iron', method: 'find a cave', conditions: { biome: 'mountains' } });
    check('methods are ranked by matching conditions', () => {
      assert.strictEqual(library.search('get iron', { biome: 'plains' })[0].method.method, 'dig at y=16');
      assert.strictEqual(library.search('get iron', { biome: 'mountains' })[0].method.method, 'find a cave');
    });
    for (let i = 0; i < 5; i += 1) library.recordOutcome(plains.id, true);
    check('a proven method outranks an unproven one', () => {
      const ranked = library.search('get iron', {});
      assert.strictEqual(ranked[0].method.id, plains.id);
      assert(ranked[0].method.success === 5);
    });
  }

  {
    const memory = new AnswerMemory({ now: () => 1000 });
    memory.remember({
      question: 'where is the iron?',
      answer: 'north cave',
      conditions: { dimension: 'overworld', biome: 'plains' }
    });
    check('an answer is recalled only under compatible conditions', () => {
      assert.strictEqual(memory.recall('where is the iron?', { dimension: 'overworld' }).fact.answer, 'north cave');
      assert.strictEqual(memory.recall('where is the iron?', { dimension: 'nether' }), null);
      assert.strictEqual(memory.recall('what time is it?', { dimension: 'overworld' }), null);
    });
  }

  {
    const brain = makeBrain();
    brain.methods.add({ goal: 'get iron', method: 'dig', conditions: { biome: 'plains' } });
    brain.answers.remember({ question: 'where is iron?', answer: 'north', conditions: { biome: 'plains' } });
    const saved = brain.captureState();
    const restored = makeBrain();
    const result = restored.restoreState(saved);
    check('methods and answers are restored with the session', () => {
      assert(result.restored.methods && result.restored.answers);
      assert.strictEqual(restored.methods.search('get iron', { biome: 'plains' })[0].method.method, 'dig');
      assert.strictEqual(restored.answers.recall('where is iron?', { biome: 'plains' }).fact.answer, 'north');
    });
  }

  // ------------------------------------------------ budgets + verification
  process.stdout.write('\n13. budgets + verification + replan guard\n');
  const { Budget } = require('../src/planner/budget');
  const { verifyStep } = require('../src/planner/verifier');
  const { validateReplanDraft } = require('../src/planner/draftGuard');

  {
    const budget = new Budget();
    assert(budget.spend('searches').ok);
    assert(budget.spend('searches').ok);
    assert(budget.spend('searches').ok);
    const refused = budget.spend('searches');
    check('a search budget refuses the fourth search', () => {
      assert.strictEqual(refused.ok, false);
      assert.strictEqual(refused.reason, 'budget-exhausted');
      assert.strictEqual(budget.remaining('searches'), 0);
    });
    budget.reset();
    check('new information starts a fresh round but keeps the cumulative total', () => {
      assert.strictEqual(budget.remaining('searches'), 3);
      assert.strictEqual(budget.status().total.searches, 3);
    });
  }

  {
    const observation = {
      inventory: { 'minecraft:iron_ore': 2 },
      position: { x: 0, y: 64, z: 0 },
      blocks: { '1,64,0': 'minecraft:stone' }
    };
    check('a step fails its precondition before it runs', () => {
      const result = verifyStep(
        { preconditions: { inventoryAtLeast: { 'minecraft:iron_ore': 3 } } },
        observation
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.stage, 'precondition');
    });
    check('a step that claims success without the postcondition is rejected', () => {
      const result = verifyStep(
        { postconditions: { inventoryAtLeast: { 'minecraft:iron_ore': 3 } } },
        observation
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.stage, 'postcondition');
    });
    check('position and block conditions are checked against the observation', () => {
      assert(verifyStep({ preconditions: { blockAt: { position: { x: 1, y: 64, z: 0 }, block: 'minecraft:stone' } } }, observation).ok);
      const far = verifyStep(
        { postconditions: { positionNear: { position: { x: 9, y: 64, z: 0 }, range: 2 } } },
        observation
      );
      assert.strictEqual(far.ok, false);
    });
  }

  {
    const current = {
      planId: 'p',
      version: 2,
      steps: [
        { id: 's1', type: 'mine', status: 'done', args: { count: 1 } },
        { id: 's2', type: 'mine', status: 'pending', args: { count: 2 } }
      ]
    };
    const draft = {
      baseVersion: 2,
      steps: [
        { id: 's1', type: 'mine', status: 'done', args: { count: 1 } },
        { id: 's2', type: 'mine', status: 'pending', args: { count: 4 } }
      ]
    };
    check('a replan may change unfinished steps only', () => {
      const result = validateReplanDraft({ current, draft });
      assert(result.ok);
      assert.deepStrictEqual(result.changed, ['s2']);
    });
    check('a replan cannot reopen or drop a done step', () => {
      const reopen = validateReplanDraft({
        current,
        draft: {
          baseVersion: 2,
          steps: [
            { id: 's1', type: 'mine', status: 'pending', args: { count: 1 } },
            { id: 's2', type: 'mine', status: 'pending', args: { count: 2 } }
          ]
        }
      });
      assert.strictEqual(reopen.reason, 'reopens-done-step');
      const drop = validateReplanDraft({
        current,
        draft: { baseVersion: 2, steps: [{ id: 's2', type: 'mine', status: 'pending', args: { count: 2 } }] }
      });
      assert.strictEqual(drop.reason, 'drops-done-step');
    });
    check('an exhausted replan budget refuses the draft', () => {
      const budget = new Budget({ limits: { replans: 0 } });
      const result = validateReplanDraft({ current, draft, budget });
      assert.strictEqual(result.reason, 'budget-exhausted');
    });
  }

  // --------------------------------------------------- code-skill lifecycle
  process.stdout.write('\n14. code-skill manifest/lifecycle\n');
  const { validateManifest } = require('../src/codeSkills/manifest');
  const { CodeSkillStore } = require('../src/codeSkills/store');
  const { RestrictedRunner } = require('../src/codeSkills/runner');

  {
    const good = {
      name: 'agent.staircase',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.js',
      permissions: ['read_state', 'submit_task']
    };
    check('a valid code-skill manifest passes and unsafe shapes fail', () => {
      assert(validateManifest(good).ok);
      assert(!validateManifest({ ...good, name: 'staircase' }).ok, 'namespace is required');
      assert(!validateManifest({ ...good, version: '1.0' }).ok, 'version must be semver');
      assert(!validateManifest({ ...good, entry: '../evil.js' }).ok, 'entry must not escape the skill directory');
      assert(!validateManifest({ ...good, entry: '/etc/passwd.js' }).ok, 'entry must be relative');
      assert(!validateManifest({ ...good, permissions: ['exec'] }).ok, 'exec is not an allowed permission');
      assert(!validateManifest({ ...good, apiVersion: 2 }).ok);
    });
  }

  {
    const store = new CodeSkillStore({ now: () => 1000 });
    const v1 = {
      name: 'agent.staircase',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.js',
      permissions: ['read_state', 'submit_task']
    };
    const v2 = { ...v1, version: '1.0.1' };
    store.addCandidate(v1);
    store.addCandidate(v2);
    check('an untrialled candidate cannot be promoted', () => {
      assert.strictEqual(store.promote(v1.name, v1.version).reason, 'not-trialled');
    });
    store.recordTrial(v1.name, v1.version, { ok: true, report: 'offline: 3/3' });
    assert(store.promote(v1.name, v1.version).ok);
    store.recordTrial(v2.name, v2.version, { ok: true, report: 'offline: 4/4' });
    const promoted = store.promote(v2.name, v2.version);
    check('promotion remembers the previous version for rollback', () => {
      assert(promoted.ok);
      assert.strictEqual(promoted.previous, '1.0.0');
      assert.strictEqual(store.getPromoted(v1.name).version, '1.0.1');
    });
    const rolled = store.rollback(v1.name);
    check('rollback returns to the previous promoted version', () => {
      assert(rolled.ok);
      assert.strictEqual(rolled.version, '1.0.0');
      assert.strictEqual(store.getPromoted(v1.name).version, '1.0.0');
    });
    store.recordTrial(v1.name, '1.0.1', { ok: false, report: 'failed' });
    check('a failed trial quarantines the candidate for good', () => {
      assert.strictEqual(store.getCandidate(v1.name, '1.0.1').status, 'quarantined');
      assert.strictEqual(store.promote(v1.name, '1.0.1').reason, 'quarantined');
    });
    store.retire(v1.name, '1.0.0');
    check('retiring the promoted version removes it from distribution', () => {
      assert.strictEqual(store.getPromoted(v1.name), null);
      assert.strictEqual(store.getCandidate(v1.name, '1.0.0').status, 'retired');
    });
  }

  {
    const store = new CodeSkillStore({ now: () => 1000 });
    const manifest = {
      name: 'agent.tower',
      version: '2.0.0',
      apiVersion: 1,
      entry: 'index.js',
      permissions: ['read_state']
    };
    store.addCandidate(manifest);
    store.recordTrial(manifest.name, manifest.version, { ok: true, report: 'ok' });
    const runner = new RestrictedRunner({ maxTimeoutMs: 5000 });
    check('the runner refuses an un-promoted skill', () => {
      const result = runner.prepare({ store, name: manifest.name, timeoutMs: 1000 });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'not-promoted');
    });
    store.promote(manifest.name, manifest.version);
    check('a promoted skill only gets a dry-run command and hard limits', () => {
      const result = runner.prepare({ store, name: manifest.name, timeoutMs: 1000 });
      assert(result.ok);
      assert.strictEqual(result.executed, false);
      assert.strictEqual(result.reason, 'dry-run-only');
      assert.strictEqual(result.command.entry, 'index.js');
      assert.strictEqual(result.limits.timeoutMs, 1000);
    });
    check('the runner refuses a version mismatch or an over-long timeout', () => {
      assert.strictEqual(runner.prepare({ store, name: manifest.name, version: '1.0.0' }).reason, 'version-mismatch');
      assert.strictEqual(runner.prepare({ store, name: manifest.name, timeoutMs: 60000 }).reason, 'timeout-out-of-range');
    });
  }

  // ---------------------------------------------- promoted catalogue + CU policy
  process.stdout.write('\n15. promoted catalogue + CU window policy\n');
  const { listPromoted, findPromoted, toToolDescriptor } = require('../src/codeSkills/catalog');
  const { WindowPolicy } = require('../src/computer/windowPolicy');

  {
    const store = new CodeSkillStore();
    const base = {
      name: 'agent.staircase',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.js',
      permissions: ['read_state'],
      description: 'builds a staircase'
    };
    store.addCandidate(base);
    store.recordTrial(base.name, base.version, { ok: true, report: 'ok' });
    store.promote(base.name, base.version);
    store.addCandidate({ ...base, version: '1.0.1' });
    check('only promoted code skills are visible to retrieval', () => {
      const list = listPromoted(store);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].version, '1.0.0');
      assert.strictEqual(findPromoted(store, base.name, { version: '1.0.1' }), null);
      const tool = toToolDescriptor(list[0]);
      assert.match(tool.description, /code skill v1\.0\.0/);
    });
    store.retire(base.name, base.version);
    check('retiring removes a skill from retrieval', () => {
      assert.strictEqual(listPromoted(store).length, 0);
      assert.strictEqual(findPromoted(store, base.name), null);
    });
  }

  {
    const policy = new WindowPolicy();
    check('computer use is denied until the window limit is proven', () => {
      const result = policy.check({ kind: 'click', windowId: 'mc', x: 10, y: 10 });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'cu-unproven');
    });
    policy.verify({
      gameWindowId: 'mc',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      evidence: 'F1 pending'
    });
    check('an action inside the verified window is allowed, outside is not', () => {
      assert(policy.check({ kind: 'click', windowId: 'mc', x: 100, y: 100 }).ok);
      assert.strictEqual(policy.check({ kind: 'click', windowId: 'mc', x: 900, y: 100 }).reason, 'outside-bounds');
      assert.strictEqual(policy.check({ kind: 'click', windowId: 'other', x: 100, y: 100 }).reason, 'outside-window');
    });
    check('screenshots are limited to the configured window', () => {
      assert(policy.check({ kind: 'screenshot', windowId: 'mc' }).ok);
      assert.strictEqual(policy.check({ kind: 'screenshot', windowId: 'other' }).reason, 'outside-window');
    });
  }

  // --------------------------------------------------- chat conversation state
  process.stdout.write('\n16. chat conversation state\n');
  const { ConversationState } = require('../src/chat/conversation');

  {
    let clock = 1000;
    const conversation = new ConversationState({
      now: () => clock,
      dedupeMs: 30000,
      minGapMs: 1500,
      maxChars: 10
    });
    check('a duplicate incoming line is dropped inside the window', () => {
      assert(conversation.rememberIncoming({ id: 'm1', text: 'hi', from: 'p' }).ok);
      clock += 1000;
      assert.strictEqual(conversation.rememberIncoming({ id: 'm1', text: 'hi', from: 'p' }).reason, 'duplicate');
      clock += 30001;
      assert(conversation.rememberIncoming({ id: 'm1', text: 'hi', from: 'p' }).ok, 'after the window it is a new line');
    });
    check('a reply to a superseded request is refused', () => {
      conversation.beginRequest('r1');
      conversation.beginRequest('r2');
      assert.strictEqual(conversation.approve({ text: 'old', requestId: 'r1' }).reason, 'stale-request');
      assert(conversation.approve({ text: 'new', requestId: 'r2' }).ok);
    });
    check('self-echo and too-soon replies are refused', () => {
      assert.strictEqual(conversation.approve({ text: 'x', fromAgent: true }).reason, 'self-echo');
      conversation.markSent('hello');
      clock += 500;
      assert.strictEqual(conversation.approve({ text: 'again' }).reason, 'too-soon');
    });
    check('identical replies are deduped and long text is truncated', () => {
      clock += 2000;
      assert.strictEqual(conversation.approve({ text: 'hello' }).reason, 'duplicate-reply');
      const long = conversation.approve({ text: '123456789012345', requestId: 'r2' });
      assert(long.ok);
      assert.strictEqual(long.text, '1234567890');
      assert.strictEqual(long.truncated, true);
    });
  }

  {
    const brain = makeBrain();
    brain.conversation.beginRequest('r9');
    brain.conversation.markSent('hello', 1000);
    brain.conversation.rememberIncoming({ id: 'm9', text: 'hi', from: 'p', at: 1000 });
    const saved = brain.captureState();
    const restored = makeBrain();
    const result = restored.restoreState(saved);
    check('conversation dedupe state survives the session', () => {
      assert(result.restored.conversation);
      assert.strictEqual(restored.conversation.activeRequest, 'r9');
      assert.strictEqual(restored.conversation.lastSentAt, 1000);
      assert.strictEqual(
        restored.conversation.rememberIncoming({ id: 'm9', text: 'hi', at: 1001 }).reason,
        'duplicate'
      );
    });
  }

  // ------------------------------------------------ outbound conversation guard
  process.stdout.write('\n17. outbound conversation guard\n');
  {
    const { reply } = require('../src/chat/reply');
    const { ConversationState } = require('../src/chat/conversation');
    let clock = 1000;
    const sent = [];
    const ctx = {
      body: { chat: async (text) => sent.push(text) },
      cfg: { agent: { chat: { maxChars: 100, replyInGame: true, minReplyGapMs: 0 } } },
      log: { info() {}, warn() {}, debug() {} },
      chatListener: { noteOwnSpeech() {} },
      conversation: new ConversationState({ now: () => clock, minGapMs: 1500, dedupeMs: 30000 })
    };
    await reply(ctx, 'first answer', { conversation: true });
    clock += 500;
    const tooSoon = await reply(ctx, 'second answer', { conversation: true });
    check('a guarded reply too soon after the previous one is dropped', () => {
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(tooSoon, false);
    });
    clock += 2000;
    await reply(ctx, 'second answer', { conversation: true });
    const duplicate = await reply(ctx, 'second answer', { conversation: true });
    check('the guard allows a later reply but not an identical one', () => {
      assert.deepStrictEqual(sent, ['first answer', 'second answer']);
      assert.strictEqual(duplicate, false);
    });
    const unguarded = await reply(ctx, 'command ack', {});
    check('command replies that do not opt in keep their path', () => {
      assert.strictEqual(unguarded, true);
      assert.strictEqual(sent[sent.length - 1], 'command ack');
    });
  }

  // --------------------------------------------------- addressed gate channel
  process.stdout.write('\n18. addressed gate channel\n');
  const { CommandGate } = require('../src/chat/commandGate');
  const { AddressedHandler } = require('../src/chat/addressedHandler');

  {
    const gate = new CommandGate({
      judge: async () => ({ verdict: 'allow', text: 'rewrite this' }),
      timeoutMs: 100
    });
    const verdict = await gate.decide('帮我砍树');
    check('an allow verdict dispatches the original, not the rewrite', () => {
      assert(verdict.ok);
      assert.strictEqual(verdict.dispatch, '帮我砍树');
      assert.strictEqual(verdict.rewritten, 'rewrite this');
    });
    const denied = await new CommandGate({ judge: () => ({ verdict: 'deny' }) }).decide('x');
    const malformed = await new CommandGate({ judge: () => ({ verdict: 'maybe' }) }).decide('x');
    const noJudge = await new CommandGate({}).decide('x');
    const errored = await new CommandGate({
      judge: () => {
        throw new Error('boom');
      }
    }).decide('x');
    const timedOut = await new CommandGate({
      judge: () => new Promise(() => {}),
      timeoutMs: 20
    }).decide('x');
    check('deny, malformed, missing judge, error and timeout all dispatch nothing', () => {
      for (const result of [denied, malformed, noJudge, errored, timedOut]) {
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.dispatch, null);
      }
      assert.strictEqual(malformed.reason, 'malformed');
      assert.strictEqual(noJudge.reason, 'no-judge');
      assert.strictEqual(errored.reason, 'judge-error');
      assert.strictEqual(timedOut.reason, 'timeout');
    });
  }

  {
    const dispatched = [];
    const allowed = new AddressedHandler({
      gate: { decide: async () => ({ ok: true, dispatch: 'original instruction' }) },
      dispatch: async (text) => {
        dispatched.push(text);
        return { ok: true };
      }
    });
    const handled = await allowed.handle('whatever the gate said');
    const refused = new AddressedHandler({
      gate: { decide: async () => ({ ok: false, reason: 'denied' }) },
      dispatch: async (text) => dispatched.push(text)
    });
    const denied = await refused.handle('do not dispatch me');
    const broken = new AddressedHandler({
      gate: { decide: async () => ({ ok: true, dispatch: 'x' }) },
      dispatch: async () => {
        throw new Error('table down');
      }
    });
    const failed = await broken.handle('x');
    check('the addressed handler dispatches only the approved original', () => {
      assert(handled.ok);
      assert.deepStrictEqual(dispatched, ['original instruction']);
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.reason, 'denied');
      assert.strictEqual(failed.reason, 'dispatch-error');
    });
  }

  // ------------------------------------------------------ instruction judge
  process.stdout.write('\n19. instruction judge\n');
  const { InstructionJudge, parseVerdict } = require('../src/llm/judge');

  check('the judge accepts only allow/deny and drops rewrite fields', () => {
    assert.deepStrictEqual(parseVerdict('{"verdict":"allow"}'), { verdict: 'allow' });
    assert.deepStrictEqual(parseVerdict('deny'), { verdict: 'deny' });
    assert.deepStrictEqual(parseVerdict({ verdict: 'allow', text: 'cut 3 trees' }), { verdict: 'allow' });
    assert.throws(() => parseVerdict('allow because it is safe'), /malformed-verdict/);
    assert.throws(() => parseVerdict('{"verdict":"maybe"}'), /malformed-verdict/);
    assert.throws(() => parseVerdict(['allow']), /malformed-verdict/);
  });

  {
    const judge = new InstructionJudge({ complete: async () => '{"verdict":"allow"}' });
    const verdict = await judge.judge('帮我砍树');
    check('the judge uses the injected completion', () => {
      assert.deepStrictEqual(verdict, { verdict: 'allow' });
    });
  }

  {
    let timeoutError = null;
    try {
      await new InstructionJudge({ complete: () => new Promise(() => {}), timeoutMs: 20 }).judge('x');
    } catch (err) {
      timeoutError = err.message;
    }
    let missingError = null;
    try {
      await new InstructionJudge({}).judge('x');
    } catch (err) {
      missingError = err.message;
    }
    check('a hanging or missing completion refuses the instruction', () => {
      assert.strictEqual(timeoutError, 'judge-timeout');
      assert.strictEqual(missingError, 'no-complete');
    });
  }

  {
    const judge = new InstructionJudge({
      complete: async () => '{"verdict":"allow","text":"rewrite me"}'
    });
    const gate = new CommandGate({ judge: (text) => judge.judge(text) });
    const verdict = await gate.decide('原始指令');
    check('the gate still dispatches the original after a rewriting model', () => {
      assert(verdict.ok);
      assert.strictEqual(verdict.dispatch, '原始指令');
      assert.strictEqual(verdict.rewritten, null);
    });
  }

  // --------------------------------------------------- dual-brain tool lists
  process.stdout.write('\n20. dual-brain tool lists\n');
  const toolRegistry = require('../src/llm/tools/registry');

  {
    const all = toolRegistry.toOpenAiTools(null).map((tool) => tool.function.name);
    const language = toolRegistry.toOpenAiTools(null, 'language').map((tool) => tool.function.name);
    const action = toolRegistry.toOpenAiTools(null, 'action').map((tool) => tool.function.name);
    check('the registry splits the P0 tool list into two disjoint surfaces', () => {
      assert.strictEqual(all.length, 8, `expected the 8 P0 tools, got ${all.join(',')}`);
      assert.deepStrictEqual(language, ['observe', 'find_blocks', 'lookup_item', 'scan_around']);
      assert.deepStrictEqual(action.slice().sort(), ['do_skill', 'do_task', 'go_to', 'stop'].sort());
      assert(!language.some((name) => action.includes(name)), 'a tool may not be on both surfaces');
    });
    check('the language surface never contains an execution tool', () => {
      assert(!language.some((name) => EXECUTION_TOOLS.includes(name)));
      assert(language.every((name) => SURFACES.language.includes(name)));
      assert(action.every((name) => SURFACES.action.includes(name)));
    });
  }

  // summary
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\nP1 contract test: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write('FAILED\n');
    process.exit(1);
  }
  process.stdout.write('P1 offline contracts hold (M1-M6: events, plans, SSE, turn, routing, state, skills, CU, chat)\n');
})();
