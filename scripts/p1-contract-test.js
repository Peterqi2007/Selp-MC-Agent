'use strict';

// Offline suites must not read or write the live session-state file (config enables it).
process.env.P1_STATE = 'off';

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
    assert.strictEqual(done[0].attemptId, 'task-1#0');
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
      evidence: { windowId: 'mc', screenshot: { ok: true, width: 800, height: 600 }, boundsSource: 'win32' }
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
      assert.deepStrictEqual(language, [
        'observe',
        'find_blocks',
        'lookup_item',
        'scan_around',
        'say',
        'silence',
        'search'
      ]);
      assert.deepStrictEqual(action.slice().sort(), ['do_skill', 'do_task', 'go_to', 'stop'].sort());
      assert(!language.some((name) => action.includes(name)), 'a tool may not be on both surfaces');
    });
    check('the language surface never contains an execution tool', () => {
      assert(!language.some((name) => EXECUTION_TOOLS.includes(name)));
      assert(language.every((name) => SURFACES.language.includes(name)));
      assert(action.every((name) => SURFACES.action.includes(name)));
    });
    const sayCalls = [];
    const sayContext = { reply: async (text, options) => sayCalls.push({ text, options }) };
    const spoken = await toolRegistry.call(sayContext, 'say', { text: 'hello there' });
    const silent = await toolRegistry.call(sayContext, 'silence', {});
    check('say is language-only and can actually speak', () => {
      assert(spoken.ok);
      assert.strictEqual(sayCalls.length, 1);
      assert.strictEqual(sayCalls[0].text, 'hello there');
      assert.strictEqual(sayCalls[0].options.conversation, true);
      assert(silent.ok && silent.result.silent);
      assert(!toolRegistry.toolNames().includes('say'), 'say must stay out of the P0 tool list');
    });

    const searchCalls = [];
    const searchContext = {
      search: async (query, options) => {
        searchCalls.push({ query, options });
        return {
          ok: true,
          cached: searchCalls.length > 1,
          results: [
            { title: 'Crafting – Minecraft Wiki', url: 'https://minecraft.wiki/w/Crafting', summary: 'Crafting table recipe', untrusted: true }
          ]
        };
      }
    };
    const searched = await toolRegistry.call(searchContext, 'search', { query: 'crafting table recipe', count: 2 });
    check('search is a language-only read tool with untrusted results', () => {
      assert(searched.ok);
      assert.strictEqual(searchCalls.length, 1);
      assert.strictEqual(searchCalls[0].query, 'crafting table recipe');
      assert.strictEqual(searchCalls[0].options.count, 2);
      assert.strictEqual(searched.result.untrusted, true);
      assert.strictEqual(searched.result.results[0].untrusted, true);
      assert.match(searched.result.results[0].url, /^https:\/\//);
      assert(SURFACES.language.includes('search'));
      assert(!SURFACES.action.includes('search'));
      assert(!toolRegistry.toolNames().includes('search'), 'search must stay out of the 8 action tools');
    });
  }

  // ------------------------------------------- addressed channel end-to-end
  process.stdout.write('\n21. addressed channel end-to-end\n');
  {
    const { ChatListener } = require('../src/chat/chatListener');
    const dispatched = [];
    const commands = [];
    let lines = ['<Steve> hello'];
    const listener = new ChatListener(
      { readChat: async () => ({ lines }) },
      { chat: { handle: async (command) => commands.push(command) } },
      { prefix: '!', addressedPrefix: '@', log: silent }
    );
    const handler = new AddressedHandler({
      gate: { decide: async (text) => ({ ok: true, dispatch: text }) },
      dispatch: async (text) => dispatched.push(text)
    });
    listener.onAddressed = (text) => handler.handle(text);
    await listener.poll(); // seed baseline
    lines = ['<Steve> hello', '<Steve> @帮我砍 8 根木头'];
    await listener.poll();
    check('the listener routes @ through the gate and dispatches the original', () => {
      assert.deepStrictEqual(dispatched, ['帮我砍 8 根木头']);
      assert.strictEqual(listener.stats.addressed, 1);
    });
    lines = ['<Steve> hello', '<Steve> @帮我砍 8 根木头', '<Steve> !help'];
    await listener.poll();
    check('the addressed channel and the ! channel coexist', () => {
      assert.deepStrictEqual(commands, ['help']);
    });
  }

  {
    const { ChatListener } = require('../src/chat/chatListener');
    const dispatched = [];
    let lines = ['<Steve> hello'];
    const listener = new ChatListener(
      { readChat: async () => ({ lines }) },
      { chat: { handle: async () => {} } },
      { prefix: '!', addressedPrefix: '@', log: silent }
    );
    listener.onAddressed = (text) =>
      new AddressedHandler({
        gate: { decide: async () => ({ ok: false, reason: 'denied' }) },
        dispatch: async (value) => dispatched.push(value)
      }).handle(text);
    await listener.poll();
    lines = ['<Steve> hello', '<Steve> @帮我砍树'];
    await listener.poll();
    check('a denied addressed line never reaches dispatch', () => {
      assert.deepStrictEqual(dispatched, []);
      assert.strictEqual(listener.stats.addressed, 1, 'the channel still saw the line');
    });
  }

  {
    const { ChatListener } = require('../src/chat/chatListener');
    const dispatched = [];
    let lines = ['<Steve> hello'];
    const listener = new ChatListener(
      { readChat: async () => ({ lines }) },
      { chat: { handle: async () => {} } },
      { prefix: '!', log: silent }
    );
    listener.onAddressed = (text) => dispatched.push(text);
    await listener.poll();
    lines = ['<Steve> hello', '<Steve> @帮我砍树'];
    await listener.poll();
    check('with the channel disabled, @ is not an addressed instruction', () => {
      assert.deepStrictEqual(dispatched, []);
      assert.strictEqual(listener.stats.addressed, 0);
    });
  }

  // ------------------------------------------- plan questions reuse proposals
  process.stdout.write('\n22. plan questions use the proposal desk\n');
  {
    const brain = makeBrain();
    const ran = [];
    brain.planRunner.createTask = (step, ids) => ({ name: step.id, ids, cancel() {} });
    brain.planRunner.runTask = async (task) => {
      ran.push(task.name);
      return { ok: true, status: 'succeeded' };
    };
    brain.plans.applyDraft({
      planId: 'pq',
      steps: [
        { id: 'a', type: 'mine' },
        { id: 'w', type: 'wait_for_player', args: { question: '继续执行吗？' } },
        { id: 'c', type: 'mine' }
      ]
    });
    const parked = await brain.runPlan('pq');
    check('a waiting plan becomes a plan_question proposal', () => {
      assert.strictEqual(parked.waiting.stepId, 'w');
      assert.strictEqual(parked.question.ok, true);
      const pending = brain.proposals.pending();
      assert.strictEqual(pending.candidate.type, 'plan_question');
      assert.strictEqual(pending.reason, '继续执行吗？');
      assert.deepStrictEqual(ran, ['a']);
    });
    const accepted = await brain.acceptProposal();
    check('accepting the question resumes the plan', () => {
      assert(accepted.ok);
      assert(accepted.resumed.ok);
      assert.deepStrictEqual(ran, ['a', 'c']);
      assert(brain.plans.get('pq').steps.every((step) => step.status === 'done'));
      assert.strictEqual(brain.proposals.pending(), null);
    });
  }

  {
    const brain = makeBrain();
    const ran = [];
    brain.planRunner.createTask = (step, ids) => ({ name: step.id, ids, cancel() {} });
    brain.planRunner.runTask = async (task) => {
      ran.push(task.name);
      return { ok: true, status: 'succeeded' };
    };
    brain.plans.applyDraft({
      planId: 'pr',
      steps: [
        { id: 'a', type: 'mine' },
        { id: 'w', type: 'wait_for_player', args: { question: '继续执行吗？' } },
        { id: 'c', type: 'mine' }
      ]
    });
    await brain.runPlan('pr');
    const rejected = await brain.rejectProposal();
    check('rejecting the question fails the step and stops the plan', () => {
      assert(rejected.ok);
      assert.deepStrictEqual(ran, ['a']);
      const plan = brain.plans.get('pr');
      assert.strictEqual(plan.steps.find((step) => step.id === 'w').status, 'failed');
      assert.strictEqual(plan.steps.find((step) => step.id === 'c').status, 'pending');
      assert.strictEqual(brain.proposals.pending(), null);
    });
  }

  // ------------------------------------------- code-skill generation pipeline
  process.stdout.write('\n23. code-skill generation pipeline\n');
  const { CodeSkillGenerator, scanCode } = require('../src/codeSkills/generator');
  const generationManifest = {
    name: 'agent.generated',
    version: '1.0.0',
    apiVersion: 1,
    entry: 'index.js',
    permissions: ['read_state']
  };
  const safeCode = 'module.exports = { async run(ctx, params) { return { ok: true }; } };\n';

  check('safe generated code passes the static scan', () => {
    const result = scanCode(safeCode);
    assert(result.ok);
    assert.strictEqual(result.bytes, Buffer.byteLength(safeCode));
  });

  check('dangerous APIs and unbounded loops are rejected', () => {
    for (const bad of [
      "require('fs')",
      "eval('1')",
      "new Function('return 1')",
      "fetch('http://example.com')",
      'while (true) {}'
    ]) {
      const result = scanCode(`module.exports = { async run() { ${bad} } };`);
      assert.strictEqual(result.ok, false, `should reject: ${bad}`);
      assert(result.errors.length > 0);
    }
  });

  check('oversized and exportless code is rejected', () => {
    assert.strictEqual(scanCode('module.exports = { run() {} };', { maxBytes: 5 }).ok, false);
    assert.strictEqual(scanCode('const x = 1;').ok, false);
  });

  {
    const generator = new CodeSkillGenerator({
      generate: async () => ({ code: safeCode, manifest: generationManifest })
    });
    const proposal = await generator.propose('build a staircase');
    check('the generator validates the manifest and code', () => {
      assert(proposal.ok);
      assert.strictEqual(proposal.bytes, Buffer.byteLength(safeCode));
    });
    const store = new CodeSkillStore();
    const registered = generator.register(store, proposal);
    check('a proposal enters the store as a candidate, never promoted', () => {
      assert(registered.ok);
      assert.strictEqual(store.getPromoted(generationManifest.name), null);
      assert.strictEqual(store.getCandidate(generationManifest.name, '1.0.0').status, 'candidate');
    });
  }

  {
    const generator = new CodeSkillGenerator({
      generate: async () => ({ code: "require('child_process').execSync('whoami')", manifest: generationManifest })
    });
    const proposal = await generator.propose('do something unsafe');
    check('unsafe generation is refused with a reason', () => {
      assert.strictEqual(proposal.ok, false);
      assert.strictEqual(proposal.reason, 'unsafe-code');
      assert(proposal.errors.some((entry) => entry.reason === 'require-not-allowed'));
    });
  }

  // ------------------------------------------------------- language agent
  process.stdout.write('\n24. language agent\n');
  const { LanguageAgent } = require('../src/llm/languageAgent');
  {
    const spoken = [];
    const ctx = { reply: async (text, options) => spoken.push({ text, options }) };
    const agent = new LanguageAgent({
      ctx,
      complete: async () => '{"tool":"say","args":{"text":"我在林子里"}}'
    });
    const result = await agent.respond({ text: '你在哪？' });
    check('the language agent speaks through the single reply path', () => {
      assert(result.ok);
      assert.strictEqual(result.spoke, true);
      assert.strictEqual(spoken.length, 1);
      assert.strictEqual(spoken[0].text, '我在林子里');
      assert.strictEqual(spoken[0].options.conversation, true);
    });
  }

  {
    const spoken = [];
    const silentAgent = new LanguageAgent({
      ctx: { reply: async (text) => spoken.push(text) },
      complete: async () => '{"tool":"silence"}'
    });
    const silent = await silentAgent.respond({ text: '随便聊聊' });
    check('silence stays silent', () => {
      assert(silent.ok);
      assert.strictEqual(silent.spoke, false);
      assert.strictEqual(spoken.length, 0);
    });
  }

  {
    const spoken = [];
    const agent = new LanguageAgent({
      ctx: { reply: async (text) => spoken.push(text) },
      complete: async () => '{"tool":"do_task","args":{"task":"mine"}}'
    });
    const refused = await agent.respond({ text: '帮我挖矿' });
    check('the language agent refuses every execution tool', () => {
      assert.strictEqual(refused.ok, false);
      assert.strictEqual(refused.reason, 'not-language-tool');
      assert.strictEqual(refused.tool, 'do_task');
      assert.strictEqual(spoken.length, 0);
    });
  }

  {
    const spoken = [];
    const agent = new LanguageAgent({
      ctx: { reply: async (text) => spoken.push(text) },
      complete: async () => 'I think I should say hello'
    });
    const malformed = await agent.respond({ text: 'hi' });
    check('malformed model output becomes silence, never a guessed action', () => {
      assert(malformed.ok);
      assert.strictEqual(malformed.spoke, false);
      assert.strictEqual(malformed.reason, 'malformed');
      assert.strictEqual(spoken.length, 0);
    });
  }

  {
    const agent = new LanguageAgent({
      complete: async () => {
        throw new Error('model offline');
      }
    });
    const failed = await agent.respond({ text: 'hi' });
    check('a model failure is reported, not turned into speech', () => {
      assert.strictEqual(failed.ok, false);
      assert.strictEqual(failed.reason, 'model-error');
    });
  }

  // ------------------------------------------- language dialogue + fallback
  process.stdout.write('\n25. language dialogue fallback rules\n');
  const { LanguageDialogue } = require('../src/chat/languageDialogue');
  {
    let fallbackCalls = 0;
    const dialogue = new LanguageDialogue({
      agent: { respond: async () => ({ ok: true, spoke: true, tool: 'say', text: 'hi' }) },
      fallback: async () => {
        fallbackCalls += 1;
      }
    });
    const result = await dialogue.handle('hello');
    check('a spoken language reply does not fall back', () => {
      assert(result.ok && result.spoke);
      assert.strictEqual(fallbackCalls, 0);
    });
  }

  {
    let fallbackCalls = 0;
    const dialogue = new LanguageDialogue({
      agent: { respond: async () => ({ ok: true, spoke: false, reason: 'malformed' }) },
      fallback: async () => {
        fallbackCalls += 1;
      }
    });
    const result = await dialogue.handle('hello');
    check('silence and malformed output are outcomes, not fallbacks', () => {
      assert(result.ok);
      assert.strictEqual(result.spoke, false);
      assert.strictEqual(fallbackCalls, 0);
    });
  }

  {
    let fallbackCalls = 0;
    const dialogue = new LanguageDialogue({
      agent: { respond: async () => ({ ok: false, spoke: false, reason: 'not-language-tool', tool: 'do_task' }) },
      fallback: async () => {
        fallbackCalls += 1;
      }
    });
    const result = await dialogue.handle('帮我挖矿');
    check('a refused execution request never falls back to the action brain', () => {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'not-language-tool');
      assert.strictEqual(fallbackCalls, 0);
    });
  }

  {
    let fallbackCalls = 0;
    const dialogue = new LanguageDialogue({
      agent: { respond: async () => ({ ok: false, spoke: false, reason: 'model-error' }) },
      fallback: async () => {
        fallbackCalls += 1;
        return { ok: true };
      }
    });
    const result = await dialogue.handle('hello');
    check('a model outage falls back to the existing dialogue path', () => {
      assert(result.ok);
      assert.strictEqual(result.fellBack, true);
      assert.strictEqual(fallbackCalls, 1);
    });
  }

  {
    const dialogue = new LanguageDialogue({
      agent: { respond: async () => ({ ok: false, spoke: false, reason: 'model-error' }) },
      fallback: async () => {
        throw new Error('action brain down');
      }
    });
    const result = await dialogue.handle('hello');
    check('a failing fallback is reported, not swallowed', () => {
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, 'fallback-error');
    });
  }

  // ------------------------------------------- unanswered plan questions expire
  process.stdout.write('\n26. unanswered plan questions expire\n');
  {
    const brain = makeBrain();
    let clock = 1000;
    brain.proposals.now = () => clock;
    const ran = [];
    brain.planRunner.createTask = (step, ids) => ({ name: step.id, ids, cancel() {} });
    brain.planRunner.runTask = async (task) => {
      ran.push(task.name);
      return { ok: true, status: 'succeeded' };
    };
    brain.plans.applyDraft({
      planId: 'pe',
      steps: [
        { id: 'a', type: 'mine' },
        { id: 'w', type: 'wait_for_player', args: { question: '继续执行吗？' } },
        { id: 'c', type: 'mine' }
      ]
    });
    await brain.runPlan('pe');
    assert.strictEqual(brain.proposals.pending().candidate.type, 'plan_question');
    clock += brain.proposals.ttlMs + 1;
    const expired = brain.proposals.sweep();
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('an unanswered plan question fails the step and stops the plan', () => {
      assert(expired && expired.status === 'expired');
      assert.deepStrictEqual(ran, ['a']);
      const plan = brain.plans.get('pe');
      assert.strictEqual(plan.steps.find((step) => step.id === 'w').status, 'failed');
      assert.strictEqual(plan.steps.find((step) => step.id === 'c').status, 'pending');
      assert.strictEqual(brain.proposals.pending(), null);
    });
  }

  // ----------------------------------------------------- !state operator surface
  process.stdout.write('\n27. persistence operator surface\n');
  {
    const { ChatController } = require('../src/chat/commands');
    const brain = makeBrain();
    const replies = [];
    brain.ctx.reply = async (text) => replies.push(text);
    const chat = new ChatController(brain.ctx);

    const disabled = await chat.handlers.state(['status']);
    check('!state reports persistence disabled by default', () => {
      assert.strictEqual(disabled.enabled, false);
      assert.match(replies[replies.length - 1], /未启用/);
    });
    const denied = await chat.handlers.state(['save']);
    check('!state save cannot enable persistence by itself', () => {
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.enabled, false);
      assert.strictEqual(denied.reason, 'state-disabled');
    });

    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'p1-state-cmd-'));
    const file = nodePath.join(dir, 'state.json');
    brain.stateStore = new StateStore({ file });
    brain.plans.applyDraft({ planId: 'ps', steps: [{ id: 's1' }] });
    const saved = await chat.handlers.state(['save']);
    check('!state save writes one atomic snapshot', () => {
      assert(saved.ok);
      assert(fs.existsSync(file));
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(data.version, 1);
      assert.strictEqual(data.plans.plans.length, 1);
    });
    const status = await chat.handlers.state(['status']);
    check('!state status reports the file and current counts', () => {
      assert.strictEqual(status.enabled, true);
      assert.strictEqual(status.plans, 1);
      assert.match(replies[replies.length - 1], /持久化开启/);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --------------------------------------------- step postconditions in plans
  process.stdout.write('\n28. plan step postconditions\n');
  {
    const plans = new PlanStore();
    plans.applyDraft({
      planId: 'pv',
      steps: [
        { id: 'a', type: 'mine' },
        { id: 'b', type: 'mine', postconditions: { inventoryAtLeast: { 'minecraft:iron_ore': 1 } } },
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
      },
      verify: (step) => ({ ok: step.id !== 'b' }),
      observe: () => ({})
    });
    const outcome = await runner.run('pv');
    check('a failed postcondition stops the plan even when the task said ok', () => {
      assert.deepStrictEqual(ran, ['a', 'b']);
      assert.strictEqual(outcome.ok, false);
      const plan = plans.get('pv');
      assert.strictEqual(plan.steps.find((step) => step.id === 'b').status, 'failed');
      assert.match(outcome.results.find((entry) => entry.stepId === 'b').reason, /postcondition/);
      assert.strictEqual(plan.steps.find((step) => step.id === 'c').status, 'pending');
    });
  }

  {
    const plans = new PlanStore();
    plans.applyDraft({
      planId: 'pw2',
      steps: [
        { id: 'only', type: 'mine', postconditions: { inventoryAtLeast: { 'minecraft:iron_ore': 1 } } }
      ]
    });
    const runner = new PlanRunner({
      plans,
      createTask: (step) => ({ name: step.id, cancel() {} }),
      runTask: async () => ({ ok: true, status: 'succeeded' }),
      verify: (step, observation) => verifyStep(step, observation),
      observe: () => ({ inventory: {} })
    });
    const outcome = await runner.run('pw2');
    check('the real verifier reads the observation and fails the empty inventory', () => {
      assert.strictEqual(outcome.ok, false);
      assert.match(outcome.results[0].reason, /postcondition/);
    });
  }

  // --------------------------------------------- snapshot field timestamps
  process.stdout.write('\n29. snapshot field timestamps\n');
  {
    const { ClientModBody } = require('../src/body/clientModBody');
    const body = new ClientModBody(loadConfig({ profile: null }), { log: silent });
    body._snapshot = {
      ready: true,
      position: { x: 0, y: 64, z: 0 },
      health: 20,
      food: 20,
      inventory: {},
      hostiles: [],
      blocks: null,
      time: { isDay: true }
    };
    body._snapshotAt = 5000;
    const snap = body.snapshot();
    check('the client body stamps fields with the refresh time, not the read time', () => {
      assert.strictEqual(snap.observedAt.position, 5000);
      assert.strictEqual(fieldAge(snap, 'hostiles', 5500), 500);
      assert.strictEqual(fieldAge(snap, 'blocks', 5500), 500);
    });

    body._snapshotVersion = 1;
    body.connected = true;
    const freshness = body.freshness(7000);
    check('the client body exposes per-field freshness and a version', () => {
      assert.strictEqual(freshness.version, 1);
      assert.strictEqual(freshness.connected, true);
      assert(freshness.stale, 'a 2s-old snapshot must be stale at the default budgets');
      assert(freshness.staleFields.some((entry) => entry.field === 'position'));
      assert.match(body.staleActionReason(7000), /stale state: position/);
    });

    body._lastRefreshErrorAt = 6500;
    check('a failed refresh is reported as degraded without pretending the data is fresh', () => {
      const degraded = body.freshness(7000);
      assert.strictEqual(degraded.degraded, true);
      assert.strictEqual(degraded.lastError, null, 'this fixture has no error message');
      assert(degraded.stale);
    });
  }

  // --------------------------------------------- request identity propagation
  process.stdout.write('\n30. request identity propagation\n');
  {
    const brain = makeBrain();
    brain.running = true;
    let seen = null;
    brain.runTask = async (task) => {
      seen = task;
    };
    brain.proposals.propose({
      name: 'mine',
      type: 'mine',
      args: { block: 'stone', count: 1 },
      reason: 'test'
    });
    const accepted = await brain.acceptProposal();
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('an accepted proposal carries its id as the task requestId', () => {
      assert(accepted.ok);
      assert(seen);
      assert.strictEqual(seen.requestId, accepted.proposal.id);
    });
  }

  {
    const brain = makeBrain();
    const task = { name: 'explicit', describe: () => 'explicit', state: 'pending' };
    brain.enqueue(task, { level: 'directive', source: 'test', requestId: 'req-7' });
    check('enqueue accepts an explicit requestId', () => {
      assert.strictEqual(task.requestId, 'req-7');
    });
  }

  {
    const brain = makeBrain();
    const receipt = await brain.ctx.hub.submit({
      name: 'hub-provenance',
      description: 'hub provenance',
      source: 'test',
      requestId: 'req-9',
      run: async () => ({ ok: true, reason: 'ok' })
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    check('a hub job carries its requestId into task events', () => {
      const done = brain.events
        .since(0)
        .filter((event) => event.type === 'task:done' && event.taskId === receipt.taskId);
      assert.strictEqual(done.length, 1);
      assert.strictEqual(done[0].requestId, 'req-9');
    });
  }

  // ------------------------------------------- code-skill directory layout
  process.stdout.write('\n31. code-skill directory layout\n');
  {
    const { CodeSkillDirectory } = require('../src/codeSkills/directory');
    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'p1-skills-'));
    const layout = new CodeSkillDirectory({ root: dir, now: () => 1000 });
    const manifest = {
      name: 'agent.tower',
      version: '1.0.0',
      apiVersion: 1,
      entry: 'index.js',
      permissions: ['read_state']
    };
    const code = 'module.exports = { async run() { return { ok: true }; } };\n';
    const written = layout.writeCandidate(manifest, code);
    check('the candidate directory holds the manifest and entry', () => {
      assert(written.ok);
      assert(fs.existsSync(nodePath.join(written.dir, 'manifest.json')));
      assert.strictEqual(fs.readFileSync(nodePath.join(written.dir, 'index.js'), 'utf8'), code);
    });
    const escaped = layout.writeCandidate({ ...manifest, entry: '../evil.js' }, code);
    check('a candidate entry cannot escape its directory', () => {
      assert.strictEqual(escaped.ok, false);
      assert.strictEqual(escaped.reason, 'invalid-manifest');
    });

    const promoted = layout.promote('agent.tower', '1.0.0');
    check('promotion copies the files and writes the current pointer', () => {
      assert(promoted.ok);
      assert.strictEqual(layout.current('agent.tower').version, '1.0.0');
      assert(fs.existsSync(nodePath.join(layout.promotedDir('agent.tower', '1.0.0'), 'index.js')));
    });

    layout.writeCandidate({ ...manifest, version: '1.0.1' }, code);
    layout.promote('agent.tower', '1.0.1');
    const rolled = layout.rollback('agent.tower');
    check('rollback points current back to the previous version', () => {
      assert(rolled.ok);
      assert.strictEqual(rolled.version, '1.0.0');
      assert.strictEqual(layout.current('agent.tower').version, '1.0.0');
    });

    layout.retire('agent.tower', '1.0.0');
    check('retiring the current version removes it and the pointer', () => {
      assert.strictEqual(layout.current('agent.tower'), null);
      assert.strictEqual(fs.existsSync(layout.promotedDir('agent.tower', '1.0.0')), false);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --------------------------------------------- language persona + refresh plan
  process.stdout.write('\n32. persona + refresh plan\n');
  {
    let captured = null;
    const agent = new LanguageAgent({
      persona: '大肥鱼，说话简短，不主动执行',
      complete: async ({ system }) => {
        captured = system;
        return '{"tool":"silence"}';
      }
    });
    await agent.respond({ text: 'hi' });
    check('the language agent carries the persona into its prompt', () => {
      assert.match(captured, /大肥鱼/);
      assert.match(captured, /must not plan or execute/i);
    });
  }

  {
    const { planRefresh } = require('../src/world/refreshPlan');
    const snapshot = stampSnapshot(
      { position: { x: 0, y: 64, z: 0 }, inventory: {} },
      { now: 9000, fields: ['position', 'inventory'] }
    );
    snapshot.observedAt.position = 9400; // 600ms old at now=10000, over the 500ms budget
    const plan = planRefresh(snapshot, {
      now: 10000,
      maxFields: 2,
      budgets: { position: 500, inventory: 2000, hostiles: 750 }
    });
    check('the refresh plan picks stale fields and flags critical ones', () => {
      assert(plan.needsRefresh);
      assert(plan.refresh.includes('hostiles'), 'a never-observed field is stale');
      assert(plan.refresh.includes('position'));
      assert(plan.criticalStale.some((entry) => entry.field === 'hostiles'));
      assert(!plan.refresh.includes('inventory'), 'inventory is still fresh at 1000ms < 2000ms');
    });
  }

  // ------------------------------------------- method outcome from plan steps
  process.stdout.write('\n33. method outcome feedback\n');
  {
    const brain = makeBrain();
    const method = brain.methods.add({ goal: 'get iron', method: 'dig', conditions: {} });
    brain.planRunner.createTask = (step, ids) => ({ name: step.id, ids, cancel() {} });
    brain.planRunner.runTask = async () => ({ ok: true, status: 'succeeded' });
    brain.plans.applyDraft({
      planId: 'pm',
      steps: [
        { id: 'a', type: 'mine', methodId: method.id },
        { id: 'b', type: 'mine', methodId: method.id }
      ]
    });
    await brain.runPlan('pm');
    check('successful plan steps update the method outcome', () => {
      const stored = brain.methods.toJSON().methods.find((entry) => entry.id === method.id);
      assert.strictEqual(stored.success, 2);
      assert.strictEqual(stored.failure, 0);
    });
  }

  {
    const brain = makeBrain();
    const method = brain.methods.add({ goal: 'get iron', method: 'dig', conditions: {} });
    brain.planRunner.createTask = (step) => ({ name: step.id, cancel() {} });
    brain.planRunner.runTask = async () => ({ ok: true, status: 'succeeded' });
    brain.planRunner.verify = () => ({ ok: false, stage: 'postcondition', failures: [] });
    brain.plans.applyDraft({
      planId: 'pf',
      steps: [{ id: 'a', type: 'mine', methodId: method.id }]
    });
    const outcome = await brain.runPlan('pf');
    check('a failed postcondition records a method failure', () => {
      assert.strictEqual(outcome.ok, false);
      const stored = brain.methods.toJSON().methods.find((entry) => entry.id === method.id);
      assert.strictEqual(stored.failure, 1);
      assert.strictEqual(stored.success, 0);
    });
  }

  // --------------------------------------------- local knowledge retrieval
  process.stdout.write('\n34. local knowledge retrieval\n');
  {
    const brain = makeBrain();
    const best = brain.methods.add({
      goal: 'get iron',
      method: 'dig at y=16',
      conditions: { biome: 'plains' }
    });
    brain.methods.add({ goal: 'get iron', method: 'find a cave', conditions: { biome: 'mountains' } });
    brain.methods.recordOutcome(best.id, true);
    brain.answers.remember({
      question: 'where is the iron?',
      answer: 'north cave',
      conditions: { dimension: 'overworld' }
    });
    const suggestion = brain.suggestMethod('get iron', {
      biome: 'plains',
      dimension: 'overworld'
    });
    check('suggestMethod returns the best method and remembered answer', () => {
      assert.strictEqual(suggestion.method.method, 'dig at y=16');
      assert.strictEqual(suggestion.method.success, 1);
      assert.strictEqual(suggestion.answer.answer, 'north cave');
    });

    const { ChatController } = require('../src/chat/commands');
    const replies = [];
    brain.ctx.reply = async (text) => replies.push(text);
    const chat = new ChatController(brain.ctx);
    await chat.handlers.method(['get', 'iron']);
    check('!method reports the method and the remembered answer', () => {
      assert.match(replies[replies.length - 1], /dig at y=16/);
      assert.match(replies[replies.length - 1], /north cave/);
    });
    const usage = await chat.handlers.method([]);
    check('!method without a goal explains its usage', () => {
      assert.strictEqual(usage.ok, false);
      assert.match(replies[replies.length - 1], /用法/);
    });
  }

  // ------------------------------------------------- threat observer contract
  process.stdout.write('\n35. threat observer\n');
  {
    const { ThreatObserver } = require('../src/world/threatObserver');
    const observed = [];
    const observer = new ThreatObserver({ radius: 8, now: () => 1000 });
    const off = observer.subscribe((event) => observed.push(event));
    const zombie = { id: 'z1', name: 'zombie', position: { x: 2, y: 64, z: 0 } };
    const farSkeleton = { id: 's1', name: 'skeleton', position: { x: 30, y: 64, z: 0 } };
    const snapshot = { ready: true, position: { x: 0, y: 64, z: 0 }, hostiles: [zombie, farSkeleton] };
    const first = observer.observe(snapshot);
    observer.observe(snapshot);
    check('a hostile entering the radius emits once, a far one none', () => {
      assert.strictEqual(first.length, 1);
      assert.strictEqual(first[0].type, 'threat:enter');
      assert.strictEqual(first[0].threat.name, 'zombie');
      assert.strictEqual(observed.length, 1, 'the second poll must not repeat the enter event');
      assert.strictEqual(observer.status().active.length, 1);
    });
    const left = observer.observe({ ...snapshot, hostiles: [farSkeleton] });
    check('leaving the radius emits a leave event', () => {
      assert.strictEqual(left.length, 1);
      assert.strictEqual(left[0].type, 'threat:leave');
      assert.strictEqual(left[0].threat.id, 'z1');
      assert.strictEqual(observer.status().active.length, 0);
    });
    const again = observer.observe(snapshot);
    check('re-entering emits a new event', () => {
      assert.strictEqual(again.length, 1);
      assert.strictEqual(again[0].type, 'threat:enter');
    });
    off();
    observer.observe({ ready: false });
    check('unsubscribe stops delivery and a non-ready snapshot clears threats', () => {
      assert.strictEqual(observer.status().active.length, 0);
      const before = observed.length;
      observer.observe(snapshot);
      assert.strictEqual(observed.length, before, 'no delivery after unsubscribe');
    });
  }

  // ------------------------------------------------- perception wake contract
  process.stdout.write('\n35b. perception wake\n');
  {
    const { PerceptionWake } = require('../src/world/perceptionWake');
    let clock = 1000;
    const wake = new PerceptionWake({ now: () => clock, radius: 8, chatCooldownMs: 5000 });
    const seen = [];
    wake.subscribe((event) => seen.push(event));
    const base = {
      ready: true,
      position: { x: 0, y: 64, z: 0 },
      weather: { raining: false },
      time: { isDay: true },
      hostiles: [{ id: 'z1', name: 'zombie', position: { x: 2, y: 64, z: 0 } }]
    };
    const first = wake.observe(base);
    const second = wake.observe(base);
    check('perception wake emits an edge once and not on repeated samples', () => {
      assert.strictEqual(first.length, 1);
      assert.strictEqual(first[0].type, 'threat:enter');
      assert.strictEqual(second.length, 0);
      assert.strictEqual(seen.length, 1);
    });
    const weather = wake.observe({ ...base, weather: { raining: true }, hostiles: [] });
    const phase = wake.observe({ ...base, weather: { raining: true }, time: { isDay: false }, hostiles: [] });
    check('weather and phase changes each emit once', () => {
      assert.deepStrictEqual(weather.map((e) => e.type), ['threat:leave', 'weather:change']);
      assert.deepStrictEqual(phase.map((e) => e.type), ['phase:change']);
    });
    const chat = wake.noteChat('今天天气怎么样');
    const repeat = wake.noteChat('今天天气怎么样');
    clock += 6000;
    const later = wake.noteChat('今天天气怎么样');
    check('chat wake is deduped inside the cooldown and becomes a new event after it', () => {
      assert.strictEqual(chat.type, 'chat:message');
      assert.strictEqual(repeat, null);
      assert.strictEqual(later.type, 'chat:message');
      assert.strictEqual(wake.status().counts['chat:message'], 2);
    });
  }

  // ------------------------------------------------------ classified memory
  process.stdout.write('\n36. classified memory\n');
  {
    const { MemoryStore } = require('../src/memory/store');
    const memory = new MemoryStore({ now: () => 1000 });
    memory.remember('episodic', {
      text: 'found iron at y=16',
      tags: ['iron', 'mining'],
      source: 'agent'
    });
    memory.remember('semantic', {
      text: 'iron ore drops raw iron',
      tags: ['iron', 'recipe'],
      source: 'wiki'
    });
    memory.remember('relational', {
      text: 'Steve prefers building',
      tags: ['steve'],
      source: 'chat'
    });
    check('classified memory keeps the three categories apart', () => {
      const counts = memory.status().counts;
      assert.strictEqual(counts.episodic, 1);
      assert.strictEqual(counts.semantic, 1);
      assert.strictEqual(counts.relational, 1);
    });
    const hits = memory.recall('iron', { category: 'episodic' });
    check('recall filters by category and scores tokens', () => {
      assert.strictEqual(hits.length, 1);
      assert.match(hits[0].entry.text, /found iron/);
    });
    const tagged = memory.recall('', { tags: ['iron'] });
    check('tag recall works without a query', () => {
      assert.strictEqual(tagged.length, 2);
    });
    check('an unknown category is refused', () => {
      assert.strictEqual(memory.remember('dream', { text: 'x' }).reason, 'unknown-category');
    });
  }

  {
    const brain = makeBrain();
    brain.memoryStore.remember('semantic', {
      text: 'diamonds need an iron pick',
      tags: ['diamond'],
      source: 'test'
    });
    const saved = brain.captureState();
    const restored = makeBrain();
    const outcome = restored.restoreState(saved);
    check('classified memory survives the session', () => {
      assert(outcome.restored.memoryStore);
      const hits = restored.memoryStore.recall('diamonds');
      assert.strictEqual(hits.length, 1);
      assert.match(hits[0].entry.text, /iron pick/);
    });
  }

  // --------------------------------------- memory consumed read-only
  process.stdout.write('\n37. classified memory in read paths\n');
  {
    const brain = makeBrain();
    brain.memoryStore.remember('semantic', {
      text: 'iron is common at y=16',
      tags: ['iron'],
      source: 'test'
    });
    brain.methods.add({ goal: 'get iron', method: 'dig', conditions: {} });
    const suggestion = brain.suggestMethod('get iron', {});
    check('suggestMethod includes relevant classified memory', () => {
      assert(suggestion.memories.length >= 1);
      assert.strictEqual(suggestion.memories[0].category, 'semantic');
      assert.match(suggestion.memories[0].text, /y=16/);
    });

    const replies = [];
    brain.ctx.reply = async (text) => replies.push(text);
    const { ChatController } = require('../src/chat/commands');
    const chat = new ChatController(brain.ctx);
    await chat.handlers.method(['get', 'iron']);
    check('!method surfaces the memory line', () => {
      assert.match(replies[replies.length - 1], /记忆：/);
    });
  }

  {
    let captured = null;
    const agent = new LanguageAgent({
      memoryFor: () => [{ category: 'semantic', text: 'iron is common at y=16' }],
      complete: async ({ system }) => {
        captured = system;
        return '{"tool":"silence"}';
      }
    });
    await agent.respond({ text: 'where is iron?' });
    check('the language prompt carries relevant memory', () => {
      assert.match(captured, /Relevant memory/);
      assert.match(captured, /iron is common at y=16/);
      assert.match(captured, /\[semantic\]/);
    });
  }

  // ---------------------------------------------------- CU guarded executor
  process.stdout.write('\n38. CU guarded executor\n');
  {
    const { ComputerUseGuard } = require('../src/computer/guard');
    const { WindowPolicy } = require('../src/computer/windowPolicy');
    const policy = new WindowPolicy();
    const calls = [];
    const guard = new ComputerUseGuard({
      policy,
      execute: async (action) => {
        calls.push(action);
        return { ok: true };
      }
    });
    const denied = await guard.act({ kind: 'click', windowId: 'mc', x: 10, y: 10 });
    check('an unverified policy keeps the executor untouched', () => {
      assert.strictEqual(denied.ok, false);
      assert.strictEqual(denied.executed, false);
      assert.strictEqual(calls.length, 0);
    });

    policy.verify({
      gameWindowId: 'mc',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      evidence: { windowId: 'mc', screenshot: { ok: true, width: 800, height: 600 }, boundsSource: 'win32' }
    });
    const allowed = await guard.act({ kind: 'click', windowId: 'mc', x: 100, y: 100 });
    check('a verified in-window action reaches the executor once', () => {
      assert(allowed.ok);
      assert.strictEqual(allowed.executed, true);
      assert.strictEqual(calls.length, 1);
    });

    const outside = await guard.act({ kind: 'click', windowId: 'mc', x: 900, y: 100 });
    const wrongWindow = await guard.act({ kind: 'click', windowId: 'other', x: 10, y: 10 });
    check('out-of-bounds and out-of-window actions are refused before execution', () => {
      assert.strictEqual(outside.reason, 'outside-bounds');
      assert.strictEqual(wrongWindow.reason, 'outside-window');
      assert.strictEqual(calls.length, 1);
    });

    const noExecutor = new ComputerUseGuard({ policy });
    const unwired = await noExecutor.act({ kind: 'screenshot', windowId: 'mc' });
    check('without an executor nothing runs', () => {
      assert.strictEqual(unwired.executed, false);
      assert.strictEqual(unwired.reason, 'no-executor');
    });

    const broken = new ComputerUseGuard({
      policy,
      execute: async () => {
        throw new Error('gui crashed');
      }
    });
    const failed = await broken.act({ kind: 'click', windowId: 'mc', x: 10, y: 10 });
    check('an executor failure is reported as attempted, not successful', () => {
      assert.strictEqual(failed.ok, false);
      assert.strictEqual(failed.executed, true);
      assert.strictEqual(failed.reason, 'executor-error');
    });
  }

  // ------------------------------------------------------------ day/night
  process.stdout.write('\n39. day/night\n');
  {
    const { isDaytime } = require('../src/world/daytime');
    check('timeOfDay is authoritative over a conflicting isDay flag', () => {
      assert.strictEqual(isDaytime({ isDay: true, timeOfDay: 13233 }), false);
      assert.strictEqual(isDaytime({ isDay: true, timeOfDay: 14175 }), false);
      assert.strictEqual(isDaytime({ isDay: false, timeOfDay: 6000 }), true);
    });
    check('isDay is only the fallback when timeOfDay is absent', () => {
      assert.strictEqual(isDaytime({ isDay: true }), true);
      assert.strictEqual(isDaytime({ isDay: false }), false);
      assert.strictEqual(isDaytime({ timeOfDay: 18000 }), false);
      assert.strictEqual(isDaytime(null), null);
    });
  }

  // ------------------------------------------------------------ bed scan box
  process.stdout.write('\n40. bed scan box\n');
  {
    const { findBedNear } = require('../src/world/beds');
    const beds = [
      { name: 'minecraft:white_bed', position: { x: 4, y: 64, z: 0 } },
      { name: 'minecraft:red_bed', position: { x: 1, y: 64, z: 1 } },
      { name: 'minecraft:blue_bed', position: { x: 0, y: 75, z: 0 } },
      { name: 'minecraft:green_bed', position: { x: 45, y: 64, z: 0 } }
    ];
    const world = { findBlocksMatching: () => beds };
    const found = findBedNear(world, { x: 0, y: 64, z: 0 });
    check('the bed search is limited to 60x10x60 and picks the nearest', () => {
      assert.strictEqual(found.name, 'minecraft:red_bed');
    });
    check('a bed outside the box is treated as absent', () => {
      const onlyOutside = { findBlocksMatching: () => [beds[2], beds[3]] };
      assert.strictEqual(findBedNear(onlyOutside, { x: 0, y: 64, z: 0 }), null);
      assert.strictEqual(findBedNear(null, { x: 0, y: 64, z: 0 }), null);
    });
  }

  // ------------------------------------------------------- task identity
  process.stdout.write('\n41. task identity\n');
  {
    const { TaskSlot } = require('../src/core/taskSlot');
    const published = [];
    const slot = new TaskSlot({}, { log: silent });
    slot.brain = {
      log: silent,
      running: true,
      paused: false,
      stopped: false,
      events: { publish: (event) => published.push(event) },
      completedGoals: [],
      queue: [],
      ctx: { memory: { bump() {}, rememberLandmark() {} } },
      drainQueue() {}
    };
    const makeTask = (reason) => ({
      name: 'go-to',
      description: 'walk',
      source: 'chat',
      state: 'pending',
      retries: 0,
      maxRetries: 0,
      result: null,
      async execute() {
        this.result = { ok: false, reason };
      },
      snapshot() {
        return {};
      }
    });
    await slot.runTask(makeTask('noPath A'));
    await slot.runTask(makeTask('noPath B'));
    check('two same-name tasks get distinct taskId and attemptId', () => {
      const failed = published.filter((event) => event.type === 'task:failed');
      assert.strictEqual(failed.length, 2);
      assert.notStrictEqual(failed[0].taskId, failed[1].taskId);
      assert.notStrictEqual(failed[0].attemptId, failed[1].attemptId);
      assert.match(failed[0].attemptId, /^task-\d+#0$/);
    });

    // A04: a retry is not a terminal broadcast; only the final attempt is.
    const retrySlot = new TaskSlot({}, { log: silent });
    const retryEvents = [];
    retrySlot.brain = {
      log: silent,
      running: true,
      paused: false,
      stopped: false,
      events: { publish: (event) => retryEvents.push(event) },
      completedGoals: [],
      queue: [],
      ctx: { memory: { bump() {}, rememberLandmark() {} } },
      drainQueue() {},
      runTask: (task) => retrySlot.runTask(task)
    };
    const flaky = {
      name: 'flaky-go-to',
      description: 'walk',
      source: 'chat',
      state: 'pending',
      retries: 0,
      maxRetries: 1,
      result: null,
      async execute() {
        this.result = { ok: false, reason: 'noPath retry' };
      },
      snapshot() {
        return {};
      }
    };
    await retrySlot.runTask(flaky);
    check('a retried failure is marked non-terminal but still observable', () => {
      const failed = retryEvents.filter((event) => event.type === 'task:failed');
      assert.strictEqual(failed.length, 1);
      assert.strictEqual(failed[0].retrying, true);
      assert.strictEqual(failed[0].terminal, false);
      assert.strictEqual(flaky.retries, 1);
    });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    check('only the final failed attempt is terminal', () => {
      const failed = retryEvents.filter((event) => event.type === 'task:failed');
      assert.strictEqual(failed.length, 2);
      assert.strictEqual(failed.filter((event) => event.terminal === true).length, 1);
      assert.strictEqual(failed[1].attemptId, `${flaky.taskId}#1`);
      assert.strictEqual(failed[1].terminal, true);
    });
  }

  // ------------------------------------------------ CU preflight gate (M5/F1)
  process.stdout.write('\n42. CU preflight gate (M5/F1)\n');
  {
    const { WindowPolicy } = require('../src/computer/windowPolicy');
    const { CuPreflight } = require('../src/computer/preflight');
    const {
      normalizeRect,
      resolveRect,
      win32RectProvider,
      buildWin32Script
    } = require('../src/computer/windowRect');

    const candidate = 'mc-330636';
    const makeGate = (options = {}) => {
      const calls = [];
      const policy = new WindowPolicy({ candidates: options.candidates || [] });
      const preflight = new CuPreflight({
        policy,
        execute: async (action) => {
          calls.push(action);
          return { ok: true, kind: action.kind };
        },
        rectProviders: options.rectProviders || []
      });
      return { policy, preflight, calls };
    };

    // -- pre-F1: acts denied, observation limited to the unique candidate
    const gate = makeGate({ candidates: [candidate] });
    const deniedAct = await gate.preflight.act({ kind: 'click', windowId: candidate, x: 10, y: 10 });
    check('pre-F1 act is refused before the executor is reached', () => {
      assert.strictEqual(deniedAct.ok, false);
      assert.strictEqual(deniedAct.executed, false);
      assert.strictEqual(deniedAct.reason, 'cu-unproven');
      assert.strictEqual(gate.calls.length, 0);
    });

    const readOnly = await gate.preflight.observe({ kind: 'screenshot', windowId: candidate });
    check('pre-F1 read-only observation of the unique candidate is allowed', () => {
      assert(readOnly.ok);
      assert.strictEqual(readOnly.executed, true);
      assert.strictEqual(gate.calls.length, 1);
      assert.strictEqual(gate.calls[0].kind, 'screenshot');
    });

    const noId = await gate.preflight.observe({ kind: 'screenshot' });
    check('observation without an explicit windowId is refused', () => {
      assert.strictEqual(noId.ok, false);
      assert.strictEqual(noId.reason, 'observe-window-required');
      assert.strictEqual(gate.calls.length, 1);
    });

    const otherWindow = await gate.preflight.observe({ kind: 'screenshot', windowId: 'notepad-1' });
    check('observation of any other window is refused', () => {
      assert.strictEqual(otherWindow.ok, false);
      assert.strictEqual(otherWindow.reason, 'not-candidate-window');
      assert.strictEqual(gate.calls.length, 1);
    });

    const carriesInput = await gate.preflight.observe({ kind: 'screenshot', windowId: candidate, x: 5, y: 5 });
    check('observation carrying input fields is refused', () => {
      assert.strictEqual(carriesInput.ok, false);
      assert.strictEqual(carriesInput.reason, 'interaction-not-allowed');
      assert.strictEqual(gate.calls.length, 1);
    });

    const twoCandidates = makeGate({ candidates: ['mc-a', 'mc-b'] });
    const ambiguous = await twoCandidates.preflight.observe({ kind: 'screenshot', windowId: 'mc-a' });
    check('observation needs exactly one candidate window', () => {
      assert.strictEqual(ambiguous.ok, false);
      assert.strictEqual(ambiguous.reason, 'candidate-not-unique');
      assert.strictEqual(twoCandidates.calls.length, 0);
    });

    // -- verify() only accepts real F1 evidence
    const noEvidence = new WindowPolicy({ candidates: [candidate] }).verify({
      gameWindowId: candidate,
      bounds: { x: 0, y: 0, width: 1280, height: 720 }
    });
    check('verify() refuses to pass without a screenshot', () => {
      assert.strictEqual(noEvidence.ok, false);
      assert.strictEqual(noEvidence.reason, 'screenshot-required');
    });

    const verifying = new WindowPolicy({ candidates: [candidate] });
    const pixelBounds = verifying.verify({
      gameWindowId: candidate,
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      evidence: {
        windowId: candidate,
        screenshot: { ok: true, width: 696, height: 417 },
        boundsSource: 'screenshot-size'
      }
    });
    check('verify() refuses bounds inferred from screenshot pixels', () => {
      assert.strictEqual(pixelBounds.ok, false);
      assert.strictEqual(pixelBounds.reason, 'bounds-source-invalid');
      assert.strictEqual(verifying.verified, false);
    });

    const foreignWindow = verifying.verify({
      gameWindowId: 'notepad-1',
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      evidence: { screenshot: { ok: true, width: 800, height: 600 }, boundsSource: 'win32' }
    });
    check('verify() refuses a window that is not the candidate', () => {
      assert.strictEqual(foreignWindow.ok, false);
      assert.strictEqual(foreignWindow.reason, 'window-mismatch');
      assert.strictEqual(verifying.verified, false);
    });

    const verified = verifying.verify({
      gameWindowId: candidate,
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      evidence: { windowId: candidate, screenshot: { ok: true, width: 1280, height: 720 }, boundsSource: 'dwm' }
    });
    check('verify() passes on screenshot plus a real geometry source', () => {
      assert(verified.ok);
      assert.strictEqual(verifying.verified, true);
      assert.strictEqual(verifying.bounds.source, 'dwm');
    });

    const postVerify = makeGate({ candidates: [candidate] });
    postVerify.policy.verify({
      gameWindowId: candidate,
      bounds: { x: 0, y: 0, width: 1280, height: 720 },
      evidence: { windowId: candidate, screenshot: { ok: true, width: 1280, height: 720 }, boundsSource: 'win32' }
    });
    const elsewhere = await postVerify.preflight.observe({ kind: 'screenshot', windowId: 'notepad-1' });
    const insideAct = await postVerify.preflight.act({ kind: 'click', windowId: candidate, x: 40, y: 40 });
    check('after verify the target window admits acts and other windows stay closed', () => {
      assert.strictEqual(elsewhere.ok, false);
      assert.strictEqual(elsewhere.reason, 'outside-window');
      assert(insideAct.ok);
      assert.strictEqual(postVerify.calls.length, 1);
    });

    // -- rect sources: helper first, then read-only Win32/DWM
    const helperWins = await resolveRect({
      windowId: candidate,
      providers: [
        { name: 'helper', get: async () => ({ x: 100, y: 200, width: 800, height: 600, source: 'helper' }) },
        {
          name: 'win32',
          get: async () => {
            throw new Error('must not be asked');
          }
        }
      ]
    });
    check('the helper rect is used when it returns one', () => {
      assert(helperWins.ok);
      assert.strictEqual(helperWins.rect.source, 'helper');
      assert.strictEqual(helperWins.rect.x, 100);
      assert.strictEqual(helperWins.attempts.length, 1);
    });

    const win32Fallback = await resolveRect({
      windowId: candidate,
      providers: [
        {
          name: 'helper',
          get: async () => {
            throw new Error('helper has no rect');
          }
        },
        { name: 'win32', get: async () => ({ x: 56, y: 24, width: 1280, height: 720, source: 'dwm' }) }
      ]
    });
    check('Win32/DWM is the fallback when the helper cannot return a rect', () => {
      assert(win32Fallback.ok);
      assert.strictEqual(win32Fallback.rect.source, 'dwm');
      assert.strictEqual(win32Fallback.attempts[0].reason, 'provider-error');
      assert.strictEqual(win32Fallback.attempts[1].ok, true);
    });

    const unavailable = await resolveRect({
      windowId: candidate,
      providers: [
        {
          name: 'helper',
          get: async () => {
            throw new Error('no helper rect');
          }
        },
        {
          name: 'win32',
          get: async () => {
            throw new Error('no powershell runner');
          }
        }
      ]
    });
    check('no rect source means rect-unavailable, with no invented coordinates', () => {
      assert.strictEqual(unavailable.ok, false);
      assert.strictEqual(unavailable.reason, 'rect-unavailable');
      assert.strictEqual(unavailable.rect, undefined);
    });

    const pixelRect = normalizeRect({ x: 0, y: 0, width: 696, height: 417, source: 'screenshot-size' });
    check('a rect labelled screenshot-size is refused at the source', () => {
      assert.strictEqual(pixelRect.ok, false);
      assert.strictEqual(pixelRect.reason, 'rect-source-invalid');
    });

    const degenerateRect = normalizeRect({ x: 0, y: 0, width: 0, height: 720, source: 'win32' });
    check('a degenerate rect is refused', () => {
      assert.strictEqual(degenerateRect.ok, false);
      assert.strictEqual(degenerateRect.reason, 'rect-invalid');
    });

    const win32Provider = win32RectProvider({
      runner: async () =>
        JSON.stringify({
          ok: true,
          pid: 1234,
          rect: { x: 10, y: 20, width: 1280, height: 720, source: 'dwm', hwnd: 99 }
        })
    });
    const parsedRect = await win32Provider.get(candidate);
    check('the win32 provider parses a read-only probe result', () => {
      assert.strictEqual(parsedRect.x, 10);
      assert.strictEqual(parsedRect.width, 1280);
      assert.strictEqual(parsedRect.source, 'dwm');
      assert.strictEqual(parsedRect.windowId, candidate);
    });

    const missingWindow = win32RectProvider({
      runner: async () => JSON.stringify({ ok: false, reason: 'window-not-found' })
    });
    let probeError = null;
    try {
      await missingWindow.get(candidate);
    } catch (err) {
      probeError = err.message;
    }
    check('the win32 provider surfaces a probe refusal as an error', () => {
      assert.match(String(probeError), /window-not-found/);
    });

    const script = buildWin32Script({ processName: 'java', titlePattern: '*Minecraft*' });
    check('the win32 probe is read-only: geometry only, no capture or input APIs', () => {
      assert.match(script, /GetWindowRect/);
      assert.match(script, /DwmGetWindowAttribute/);
      assert.doesNotMatch(script, /PrintWindow|BitBlt|SendInput|keybd_event|mouse_event|CopyFromScreen/);
      assert.match(script, /"java"/);
    });

    // -- the gate itself must never probe a non-candidate window's geometry
    let probed = false;
    const geometryGate = makeGate({
      candidates: [candidate],
      rectProviders: [
        {
          name: 'spy',
          get: async () => {
            probed = true;
            return { x: 0, y: 0, width: 10, height: 10, source: 'win32' };
          }
        }
      ]
    });
    const stolen = await geometryGate.preflight.resolveRect('notepad-1');
    check('geometry is never queried for a non-candidate window', () => {
      assert.strictEqual(stolen.ok, false);
      assert.strictEqual(stolen.reason, 'not-candidate-window');
      assert.strictEqual(probed, false);
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
