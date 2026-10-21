'use strict';

// The live state file is enabled in config; this suite may create Brain fixtures.
process.env.P1_STATE = 'off';

/**
 * `npm run p1:m3:test` - offline proof that the M3 live entry is ready to be tested.
 *
 * It covers the pieces that had no executable surface before M3:
 *   - PlanService: draft validation, replan guard/budget, run/cancel/wait-for-player,
 *     plan events and identity;
 *   - TurnService: turn -> plan/task parking, one resume delivery, cancel, late-event safety;
 *   - persistence: plan + pending question + budget survive a restart, and restore never
 *     re-runs a task;
 *   - HTTP: `POST /plan`, `GET /plan/:id`, cancel, `/harness/turn/*`, `/harness/events`.
 *
 * No client, no model, no real Minecraft. The mock-body smoke test is a separate step.
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../src/util/config');
const { Brain } = require('../src/brain');
const { PlanStore } = require('../src/core/planStore');
const { PlanRunner } = require('../src/core/planRunner');
const { PlanService } = require('../src/core/planService');
const { TaskEvents } = require('../src/core/taskEvents');
const { TurnLifecycle } = require('../src/core/turnLifecycle');
const { HarnessAdapter } = require('../src/harness/adapter');
const { MemoryStore } = require('../src/memory/store');
const { TurnService } = require('../src/harness/turnService');
const { startStatusServer } = require('../src/web/statusServer');

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(events, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = events.since(0).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error('timed out waiting for event');
    await sleep(20);
  }
}

function makePlanService(options = {}) {
  const plans = new PlanStore();
  const events = new TaskEvents();
  const questions = {
    asked: [],
    ask(planId) {
      this.asked.push(planId);
      return { ok: true, planId, question: 'continue?' };
    }
  };
  const proposals = {
    pending: () => options.pending || null,
    supersedeCalls: [],
    supersede(reason) {
      this.supersedeCalls.push(reason);
    }
  };
  const runner = new PlanRunner({
    plans,
    createTask: options.createTask || ((step) => ({ name: step.id, cancel() {} })),
    runTask: options.runTask || (async () => ({ ok: true, status: 'succeeded' })),
    verify: options.verify || null,
    observe: options.observe || (() => ({})),
    sleep: options.sleep,
    postconditionRetryMs: options.postconditionRetryMs,
    postconditionRetryAttempts: options.postconditionRetryAttempts,
    log: silent
  });
  const service = new PlanService({
    plans,
    runner,
    questions,
    events,
    proposals,
    log: silent,
    knownStepTypes: ['mine', 'goto', 'wait_for_player'],
    waitIdleMs: 1000,
    canRun: options.canRun || (() => true),
    sleep: (ms) => sleep(Math.min(ms, 50)),
    onChange: options.onChange || (() => {})
  });
  return { plans, events, questions, proposals, runner, service };
}

function makeTurnService(options = {}) {
  const turns = new TurnLifecycle();
  const events = new TaskEvents();
  const adapter = new HarnessAdapter({ turns, events });
  const { service: planService } = options.planService
    ? { service: options.planService }
    : makePlanService();
  const turnService = new TurnService({ turns, adapter, planService, log: silent });
  return { turns, events, adapter, planService, turnService };
}

function makeBrain(stateOptions = null) {
  const cfg = loadConfig({ profile: null });
  const ctx = {
    cfg,
    log: silent,
    body: null,
    bodyKind: 'test',
    world: {
      snapshot: () => ({ inventory: {}, emptySlots: 36, health: 20, food: 20, ready: false, position: { x: 0, y: 64, z: 0 } }),
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
  const brain = new Brain(ctx, stateOptions ? { state: stateOptions } : {});
  ctx.brain = brain;
  /** The live agent sets this in start(); the fixture needs the same gate for plans. */
  brain.running = true;
  return brain;
}

async function startServer(ctx, options = {}) {
  const result = startStatusServer(ctx, { port: 0, host: '127.0.0.1', ...options });
  await new Promise((resolve, reject) => {
    if (result.server.listening) return resolve();
    result.server.once('listening', resolve);
    result.server.once('error', reject);
  });
  return { ...result, port: result.server.address().port };
}

function request(port, method, requestPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            /* SSE or plain text */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  process.stdout.write('P1 M3 live-entry contract test\n\n');

  // ----------------------------------------------------------------- submit
  process.stdout.write('1. PlanService submit / replan\n');
  {
    const { service, plans, events } = makePlanService();
    const accepted = service.submit(
      { planId: 'draft', goal: 'gather dirt', steps: [{ id: 'a', type: 'mine', args: { block: 'dirt' } }] },
      { source: 'test' }
    );
    await check('a valid draft is accepted at version 1 and published', () => {
      assert(accepted.ok);
      assert.strictEqual(accepted.version, 1);
      assert.strictEqual(plans.get('draft').steps.length, 1);
      assert(events.since(0).some((event) => event.type === 'plan:accepted' && event.planId === 'draft'));
    });

    await check('duplicate step ids and unknown types are refused before writing', () => {
      const duplicate = service.submit(
        { planId: 'bad1', steps: [{ id: 'x', type: 'mine' }, { id: 'x', type: 'mine' }] },
        { source: 'test' }
      );
      assert.strictEqual(duplicate.reason, 'duplicate-step-id');
      const unknown = service.submit(
        { planId: 'bad2', steps: [{ id: 'x', type: 'teleport' }] },
        { source: 'test' }
      );
      assert.strictEqual(unknown.reason, 'unknown-step-type');
      assert.strictEqual(plans.get('bad1'), null);
      assert.strictEqual(plans.get('bad2'), null);
    });

    await check('a replan must carry baseVersion and may not reopen a done step', () => {
      const noVersion = service.submit(
        { planId: 'draft', steps: [{ id: 'a', type: 'mine', args: { block: 'dirt' } }] },
        { source: 'test' }
      );
      assert.strictEqual(noVersion.reason, 'base-version-required');
      plans.applyDraft({
        planId: 'draft',
        baseVersion: 1,
        steps: [{ id: 'a', type: 'mine', args: { block: 'dirt' }, status: 'done' }]
      });
      const reopen = service.submit(
        {
          planId: 'draft',
          baseVersion: 2,
          steps: [{ id: 'a', type: 'mine', args: { block: 'dirt' }, status: 'pending' }]
        },
        { source: 'test' }
      );
      assert.strictEqual(reopen.reason, 'reopens-done-step');
      const replanned = service.submit(
        {
          planId: 'draft',
          baseVersion: 2,
          steps: [
            { id: 'a', type: 'mine', args: { block: 'dirt' }, status: 'done' },
            { id: 'b', type: 'mine', args: { block: 'dirt' } }
          ]
        },
        { source: 'test' }
      );
      assert(replanned.ok);
      assert.strictEqual(replanned.version, 3);
      assert.strictEqual(replanned.replanned, true);
    });

    await check('a non-zero baseVersion for an unknown plan is stale, not a new plan', () => {
      const stale = service.submit(
        { planId: 'fresh', baseVersion: 3, steps: [{ id: 'x', type: 'mine' }] },
        { source: 'test' }
      );
      assert.strictEqual(stale.reason, 'stale');
      assert.strictEqual(plans.get('fresh'), null);
    });

    await check('a draft cannot claim an unfinished step is done', () => {
      const claimed = service.submit(
        { planId: 'claimed', steps: [{ id: 'x', type: 'mine', status: 'done' }] },
        { source: 'test' }
      );
      assert(claimed.ok);
      assert.strictEqual(claimed.plan.steps[0].status, 'pending');
    });

    await check('a goto step accepts the command form (x/y/z) and normalizes position', () => {
      const gotoPlan = service.submit(
        { planId: 'goto', steps: [{ id: 'g', type: 'goto', args: { x: 1, y: 64, z: 2 } }] },
        { source: 'test' }
      );
      assert(gotoPlan.ok);
      assert.deepStrictEqual(gotoPlan.plan.steps[0].args.position, { x: 1, y: 64, z: 2 });
    });

    await check('the replan budget is finite and cumulative', () => {
      const budgeted = makePlanService();
      budgeted.service.submit({ planId: 'b', steps: [{ id: 's', type: 'mine' }] }, { source: 'test' });
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const current = budgeted.plans.get('b');
        const result = budgeted.service.submit(
          { planId: 'b', baseVersion: current.version, steps: [{ id: 's', type: 'mine', args: { attempt } }] },
          { source: 'test' }
        );
        assert(result.ok, `replan ${attempt} should fit the budget`);
      }
      const current = budgeted.plans.get('b');
      const exhausted = budgeted.service.submit(
        { planId: 'b', baseVersion: current.version, steps: [{ id: 's', type: 'mine', args: { attempt: 3 } }] },
        { source: 'test' }
      );
      assert.strictEqual(exhausted.reason, 'budget-exhausted');
      assert.strictEqual(budgeted.service.toJSON().budgets.length, 1);
    });
  }

  // --------------------------------------------------------------------- run
  process.stdout.write('\n2. PlanService run / steps / postcondition\n');
  {
    const executed = [];
    const fixture = makePlanService({
      runTask: async (task) => {
        executed.push({ planId: task.planId, stepId: task.stepId, requestId: task.requestId });
        return { ok: true, status: 'succeeded' };
      }
    });
    const { service, events, plans } = fixture;
    service.submit(
      {
        planId: 'run',
        requestId: 'req-run',
        steps: [
          { id: 'a', type: 'mine', args: { block: 'dirt' } },
          { id: 'b', type: 'mine', args: { block: 'dirt' } }
        ]
      },
      { source: 'test' }
    );
    const started = service.start('run');
    await check('a plan runs its steps through the one executor and completes', async () => {
      assert(started.ok);
      const view = await service.waitFor('run', 2000);
      assert.strictEqual(view.state, 'completed');
      assert.deepStrictEqual(executed.map((entry) => entry.stepId), ['a', 'b']);
      assert(executed.every((entry) => entry.planId === 'run' && entry.requestId === 'req-run'));
      assert(plans.get('run').steps.every((step) => step.status === 'done'));
      await waitForEvent(events, (event) => event.type === 'plan:completed' && event.planId === 'run');
      const stepEvents = events.since(0).filter((event) => event.type === 'plan:step');
      assert(stepEvents.length >= 2);
      assert(stepEvents.every((event) => event.planId === 'run' && event.stepId));
    });

    await check('a failed postcondition fails the step and stops the plan', async () => {
      const verifyFixture = makePlanService({
        verify: () => ({ ok: false, stage: 'postcondition', failures: [{ kind: 'inventoryAtLeast' }] })
      });
      verifyFixture.service.submit(
        { planId: 'verify', steps: [{ id: 'v', type: 'mine' }] },
        { source: 'test' }
      );
      verifyFixture.service.start('verify');
      const view = await verifyFixture.service.waitFor('verify', 2000);
      assert.strictEqual(view.state, 'failed');
      assert.strictEqual(view.steps[0].status, 'failed');
      await waitForEvent(verifyFixture.events, (event) => event.type === 'plan:failed');
    });

    await check('a postcondition re-observes a settling inventory before failing', async () => {
      /**
       * Live A13-6 2026-10-19: the craft task reported 4 sticks, the immediate observation
       * still showed 8, and the next `/state` showed 12. The step was wrongly failed.
       */
      let observations = 0;
      const settleFixture = makePlanService({
        postconditionRetryMs: 1,
        postconditionRetryAttempts: 1,
        sleep: async () => {},
        observe: () => ({ inventory: { 'minecraft:stick': ++observations >= 2 ? 12 : 8 } }),
        verify: (_step, observation) =>
          observation.inventory['minecraft:stick'] >= 12
            ? { ok: true, stage: null, failures: [] }
            : { ok: false, stage: 'postcondition', failures: [{ kind: 'inventoryAtLeast' }] },
        runTask: async () => ({ ok: true, status: 'succeeded' })
      });
      settleFixture.service.submit(
        {
          planId: 'settle',
          steps: [{ id: 's', type: 'mine', postconditions: { inventoryAtLeast: { 'minecraft:stick': 12 } } }]
        },
        { source: 'test' }
      );
      settleFixture.service.start('settle');
      const view = await settleFixture.service.waitFor('settle', 2000);
      assert.strictEqual(view.state, 'completed');
      assert(observations >= 2, `expected a re-observation, got ${observations}`);
    });
  }

  // -------------------------------------------------------------- questions
  process.stdout.write('\n3. wait_for_player + cancel\n');
  {
    const fixture = makePlanService();
    const { service, questions, events, plans } = fixture;
    service.submit(
      {
        planId: 'wait',
        steps: [
          { id: 'a', type: 'mine' },
          { id: 'w', type: 'wait_for_player', args: { question: 'continue?' } },
          { id: 'c', type: 'mine' }
        ]
      },
      { source: 'test' }
    );
    service.start('wait');
    const parked = await service.waitFor('wait', 2000);
    await check('a waiting plan parks, asks one question and runs nothing after it', () => {
      assert.strictEqual(parked.state, 'waiting');
      assert.strictEqual(parked.waitingStepId, 'w');
      assert.deepStrictEqual(questions.asked, ['wait']);
      assert.strictEqual(plans.get('wait').steps.find((step) => step.id === 'c').status, 'pending');
      assert(events.since(0).some((event) => event.type === 'plan:waiting'));
    });

    await check('answering yes resumes the plan and finishes it', async () => {
      const resumed = service.resume('wait', true);
      assert(resumed.ok);
      const view = await service.waitFor('wait', 2000);
      assert.strictEqual(view.state, 'completed');
      assert(plans.get('wait').steps.every((step) => step.status === 'done'));
      await waitForEvent(events, (event) => event.type === 'plan:completed' && event.planId === 'wait');
    });

    const rejectFixture = makePlanService();
    rejectFixture.service.submit(
      { planId: 'reject', steps: [{ id: 'a', type: 'mine' }, { id: 'w', type: 'wait_for_player' }, { id: 'c', type: 'mine' }] },
      { source: 'test' }
    );
    rejectFixture.service.start('reject');
    await rejectFixture.service.waitFor('reject', 2000);
    await check('answering no fails the waiting step and stops the plan', async () => {
      const resumed = rejectFixture.service.resume('reject', false);
      assert(resumed.ok);
      const view = await rejectFixture.service.waitFor('reject', 2000);
      const waitingStep = view.steps.find((step) => step.id === 'w');
      assert.strictEqual(waitingStep.status, 'failed');
      assert.strictEqual(view.steps.find((step) => step.id === 'c').status, 'pending');
      await waitForEvent(rejectFixture.events, (event) => event.type === 'plan:rejected');
    });

    const pausedFixture = makePlanService();
    pausedFixture.service.submit(
      { planId: 'paused', steps: [{ id: 'w', type: 'wait_for_player' }] },
      { source: 'test' }
    );
    pausedFixture.service.start('paused');
    await pausedFixture.service.waitFor('paused', 2000);
    pausedFixture.service.canRun = () => false;
    await check('a paused brain refuses to continue but can still fail the waiting step', async () => {
      const blocked = pausedFixture.service.resume('paused', true);
      assert.strictEqual(blocked.reason, 'brain-not-running');
      assert.strictEqual(pausedFixture.plans.get('paused').steps[0].status, 'waiting');
      const denied = pausedFixture.service.resume('paused', false);
      assert(denied.ok);
      await pausedFixture.service.waitFor('paused', 2000);
      assert.strictEqual(pausedFixture.plans.get('paused').steps[0].status, 'failed');
    });

    const cancelFixture = makePlanService({
      createTask: () => {
        const task = {
          name: 'long',
          cancel() {
            if (this._resolve) this._resolve({ ok: false, status: 'cancelled', reason: 'cancelled' });
          }
        };
        task._done = new Promise((resolve) => {
          task._resolve = resolve;
        });
        return task;
      },
      runTask: (task) => task._done
    });
    cancelFixture.service.submit({ planId: 'cancel', steps: [{ id: 'l', type: 'mine' }] }, { source: 'test' });
    cancelFixture.service.start('cancel');
    await sleep(20);
    const cancelled = cancelFixture.service.cancel('cancel', 'test-stop');
    await check('cancel stops the running step and publishes one cancelled event', async () => {
      assert(cancelled.ok);
      const view = await cancelFixture.service.waitFor('cancel', 2000);
      assert.strictEqual(view.state, 'cancelled');
      await waitForEvent(cancelFixture.events, (event) => event.type === 'plan:cancelled' && event.planId === 'cancel');
      const events = cancelFixture.events.since(0).filter((event) => event.type === 'plan:cancelled');
      assert.strictEqual(events.length, 1, 'cancel must not publish twice');
    });
  }

  // ------------------------------------------------ A14 answer channel
  process.stdout.write('\n3b. A14 plan-question answer channel\n');
  {
    const { PlanQuestionBridge } = require('../src/planner/planQuestions');
    const { AnswerMemory } = require('../src/learning/answerMemory');

    const notices = [];
    const bridge = new PlanQuestionBridge({
      plans: {
        get: () => ({ planId: 'q', steps: [{ id: 'w', status: 'waiting', question: '工作台在哪？' }] })
      },
      proposals: {
        propose: () => ({
          ok: true,
          proposal: { id: 'p1', candidate: { type: 'plan_question', args: { planId: 'q', stepId: 'w' } } }
        })
      },
      notify: (text) => notices.push(text)
    });
    const asked = bridge.ask('q');
    await check('a parked plan announces its question with the !answer hint', () => {
      assert.strictEqual(asked.ok, true);
      assert.strictEqual(notices.length, 1, `expected one announcement, got ${notices.length}`);
      assert(/工作台在哪/.test(notices[0]), 'announcement must carry the question');
      assert(/!answer/.test(notices[0]), 'announcement must teach !answer');
    });

    const forwarded = [];
    const accepted = [];
    const resumed = [];
    const brain = Object.create(Brain.prototype);
    brain.ctx = {
      body: { snapshot: () => ({ dimension: 'minecraft:overworld' }) },
      forwardToActionBrain: async (text) => {
        forwarded.push(text);
        return { ok: true };
      }
    };
    brain.proposals = {
      pending: () => ({
        id: 'p1',
        candidate: { type: 'plan_question', args: { planId: 'q', stepId: 'w' }, reason: '工作台在哪？' }
      }),
      accept: (id, options) => {
        accepted.push({ id, options });
        return { ok: true };
      }
    };
    brain.planService = {
      resume: (planId, answer, options) => {
        resumed.push({ planId, answer, options });
        return { ok: true };
      }
    };
    brain.answers = new AnswerMemory();
    brain.memoryStore = new MemoryStore();
    brain.planQuestions = { ask: () => ({ ok: false }) };
    const answered = await brain.answerPlanQuestion('在 (6,63,34)');
    await check('!answer remembers with conditions, forwards to the action brain and resumes', () => {
      assert.strictEqual(answered.ok, true);
      assert.strictEqual(answered.forwarded.ok, true);
      assert.strictEqual(forwarded.length, 1);
      assert(
        /工作台在哪/.test(forwarded[0]) && /6,63,34/.test(forwarded[0]),
        'forwarded text must carry question + answer'
      );
      assert.strictEqual(resumed.length, 1);
      assert.strictEqual(resumed[0].answer, true);
      assert.strictEqual(accepted.length, 1);
      const status = brain.answers.status();
      assert.strictEqual(status.facts, 1);
      assert.strictEqual(status.last.answer, '在 (6,63,34)');
      assert.strictEqual(status.last.conditions.dimension, 'minecraft:overworld');
      assert.strictEqual(brain.memoryStore.recall('6,63,34').length, 1);
    });
  }

  // ------------------------------------------------------------- turn layer
  process.stdout.write('\n4. TurnService resume/cancel\n');
  {
    const fixture = makeTurnService();
    const { turns, adapter, planService, turnService } = fixture;
    const begun = turnService.begin({ requestId: 'turn-req' });
    planService.submit({ planId: 'tp', requestId: 'turn-req', steps: [{ id: 's', type: 'mine' }] }, { source: 'test' });
    const tracked = turnService.trackPlan(begun.turn.id, 'tp');
    const started = planService.start('tp');
    await planService.waitFor('tp', 2000);
    await check('a plan completion wakes the parked turn exactly once', async () => {
      assert(begun.ok && tracked.ok && started.ok);
      await waitForEvent(turnService.turnEvents, (event) => event.type === 'turn:resumable');
      const resumes = turnService.turnEvents.since(0).filter((event) => event.type === 'turn:resumable');
      assert.strictEqual(resumes.length, 1);
      assert.strictEqual(resumes[0].planId, 'tp');
      assert.strictEqual(turns.get(begun.turn.id).state, 'running', 'the bridge consumes the parked event');
    });

    await check('finish closes the resumed turn without touching the plan', () => {
      const finished = turnService.finish(begun.turn.id);
      assert(finished.ok);
      assert.strictEqual(turns.get(begun.turn.id).state, 'done');
    });

    // Rebuild a long-running plan fixture for the cancel path.
    const longPlan = makePlanService({
      createTask: () => {
        const task = {
          name: 'long',
          cancel() {
            if (this._resolve) this._resolve({ ok: false, status: 'cancelled', reason: 'cancelled' });
          }
        };
        task._done = new Promise((resolve) => {
          task._resolve = resolve;
        });
        return task;
      },
      runTask: (task) => task._done
    });
    const turns2 = new TurnLifecycle();
    const events2 = new TaskEvents();
    const adapter2 = new HarnessAdapter({ turns: turns2, events: events2 });
    const turnService2 = new TurnService({ turns: turns2, adapter: adapter2, planService: longPlan.service, log: silent });
    const begun2 = turnService2.begin({ requestId: 'turn-cancel' });
    longPlan.service.submit({ planId: 'tp2', requestId: 'turn-cancel', steps: [{ id: 'l', type: 'mine' }] }, { source: 'test' });
    turnService2.trackPlan(begun2.turn.id, 'tp2');
    longPlan.service.start('tp2');
    await sleep(30);
    const cancelled = turnService2.cancel(begun2.turn.id, 'player-stop');
    await check('turn cancel kills the plan and a late plan event cannot revive it', async () => {
      assert(cancelled.ok);
      assert.strictEqual(turns2.get(begun2.turn.id).state, 'cancelled');
      await waitForEvent(turnService2.turnEvents, (event) => event.type === 'turn:cancelled');
      await sleep(30);
      const resumes = turnService2.turnEvents.since(0).filter((event) => event.type === 'turn:resumable');
      assert.strictEqual(resumes.length, 0);
    });

    const taskFixture = makeTurnService();
    const taskTurn = taskFixture.turnService.begin({ requestId: 'task-turn' });
    taskFixture.turnService.waitTask(taskTurn.turn.id, 'task-late');
    taskFixture.events.publish({ type: 'task:done', taskId: 'task-late', attemptId: 'task-late#0' });
    await check('a matching task event wakes a task-parked turn', async () => {
      await waitForEvent(taskFixture.turnService.turnEvents, (event) => event.type === 'turn:resumable');
      assert.strictEqual(taskFixture.turns.get(taskTurn.turn.id).state, 'running');
    });
  }

  // --------------------------------------------------------------- HTTP API
  // ------------------------------------------------- A28 event injection hook
  process.stdout.write('\n4b. A28 event injection (duplicate / out-of-order / late)\n');
  {
    const { HarnessInjector } = require('../src/harness/inject');
    const fixture = makeTurnService();
    const { turns, planService, turnService } = fixture;
    const injector = new HarnessInjector({ turnService, log: silent });

    const begun = turnService.begin({ requestId: 'inj-turn' });
    planService.submit({ planId: 'inj', requestId: 'inj-turn', steps: [{ id: 's', type: 'mine' }] }, { source: 'test' });
    turnService.trackPlan(begun.turn.id, 'inj');
    planService.start('inj');
    await planService.waitFor('inj', 2000);
    await waitForEvent(turnService.turnEvents, (event) => event.type === 'turn:resumable');
    const resumes = () => turnService.turnEvents.since(0).filter((event) => event.type === 'turn:resumable');
    const before = resumes().length;

    const duplicate = injector.plan({ planId: 'inj', type: 'plan:completed' });
    await sleep(20);
    await check('a duplicate completion cannot wake the same turn twice', () => {
      assert.strictEqual(before, 1);
      assert.strictEqual(resumes().length, 1);
      assert.strictEqual(duplicate.ok, true);
    });

    const outOfOrder = injector.plan({ planId: 'inj', type: 'plan:step' });
    await check('a non-resumable (out-of-order) plan event is ignored', () => {
      assert.strictEqual(outOfOrder.ok, true);
      assert.strictEqual(outOfOrder.outcome.ignored, true);
    });

    // A TurnService admits one live turn at a time: close the resumed one before the next case.
    assert.strictEqual(turnService.finish(begun.turn.id).ok, true);
    const published = injector.turn({ turnId: begun.turn.id, planId: 'inj' });
    await check('the injector can publish an extra resume on the SSE ring (plugin must dedupe)', () => {
      assert.strictEqual(published.ok, true);
      assert(published.eventId, 'injected events need their own eventId');
      const injected = turnService.turnEvents.since(0).filter((event) => event.injected === true);
      assert.strictEqual(injected.length, 1);
      assert.strictEqual(injected[0].injected, true);
    });

    const begun2 = turnService.begin({ requestId: 'inj-cancel' });
    planService.submit({ planId: 'inj2', requestId: 'inj-cancel', steps: [{ id: 'x', type: 'mine' }] }, { source: 'test' });
    turnService.trackPlan(begun2.turn.id, 'inj2');
    turnService.cancel(begun2.turn.id, 'player-stop');
    const late = injector.plan({ planId: 'inj2', type: 'plan:completed' });
    await sleep(20);
    await check('a completion after cancel cannot revive the turn', () => {
      assert.strictEqual(late.ok, true);
      assert.strictEqual(late.outcome.ok, false);
      assert.strictEqual(late.outcome.reason, 'no-turn-for-plan');
      assert.strictEqual(resumes().filter((event) => event.planId === 'inj2').length, 0);
      assert.strictEqual(turns.get(begun2.turn.id).state, 'cancelled');
    });
  }

  process.stdout.write('\n5. HTTP entry (/plan, /harness)\n');
  {
    const fixture = makePlanService();
    const turns = new TurnLifecycle();
    const adapter = new HarnessAdapter({ turns, events: fixture.events });
    const turnService = new TurnService({ turns, adapter, planService: fixture.service, log: silent });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-m3-http-'));
    const ctx = {
      cfg: { root: tempRoot, agent: { web: { bind: '127.0.0.1', eventsToken: '' } } },
      log: silent,
      body: { isReady: true, kind: 'test' },
      bodyKind: 'test',
      world: { summary: () => ({ ready: true }) },
      brain: {
        status: () => ({ running: false }),
        proposeFromHarness: async (candidate) => ({
          ok: true,
          autoAccepted: false,
          proposal: {
            id: 'p-harness',
            target: candidate.name || candidate.type,
            candidate,
            status: 'awaiting'
          }
        })
      },
      events: fixture.events,
      turnEvents: turnService.turnEvents,
      planService: fixture.service,
      turnService,
      turns,
      webSearch: {
        lookup: async (query, options) => ({
          ok: true,
          results: [
            {
              title: 'Mod block',
              url: 'https://example.invalid/mod',
              summary: 'behavior-brain lookup',
              untrusted: true
            }
          ],
          query,
          count: options.count
        })
      },
      perceptionWake: {
        seq: 2,
        events: ({ type, since, limit }) => [
          { seq: 1, type: 'threat:enter', detail: 'zombie' },
          { seq: 2, type: 'weather:change', detail: 'rain' }
        ].filter((event) => !type || type === 'all' || event.type === type || event.type.startsWith(`${type}:`)).slice(-limit)
      },
      memoryStore: new MemoryStore({ now: () => 1000 }),
      observation: {
        observe: async ({ fields, purpose }) => ({
          ok: true,
          revision: 1,
          purpose,
          fields: Object.fromEntries(
            (Array.isArray(fields) ? fields : [fields]).filter(Boolean).map((field) => [
              field,
              { value: field === 'position' ? { x: 0, y: 64, z: 0 } : 20, valid: true }
            ])
          )
        })
      }
    };
    const server = await startServer(ctx);
    try {
      const submitted = await request(server.port, 'POST', '/plan', {
        planId: 'http',
        requestId: 'http-req',
        wait: true,
        steps: [
          { id: 'a', type: 'mine', args: { block: 'dirt' } },
          { id: 'b', type: 'mine', args: { block: 'dirt' } }
        ]
      });
      await check('POST /plan accepts and wait:true returns the settled plan', () => {
        assert.strictEqual(submitted.status, 200);
        assert(submitted.body.ok);
        assert.strictEqual(submitted.body.planId, 'http');
        assert.strictEqual(submitted.body.plan.state, 'completed');
      });

      const lookup = await request(server.port, 'POST', '/lookup_mod_content', {
        query: 'mod block',
        count: 2
      });
      await check('POST /lookup_mod_content is the behavior-brain broker and marks results untrusted', () => {
        assert.strictEqual(lookup.status, 200);
        assert.strictEqual(lookup.body.ok, true);
        assert.strictEqual(lookup.body.source, 'deepseek-web-search');
        assert.strictEqual(lookup.body.untrusted, true);
        assert.strictEqual(lookup.body.results[0].untrusted, true);
        assert.match(lookup.body.results[0].url, /^https:\/\//);
      });

      const perception = await request(server.port, 'GET', '/perception?type=threat&limit=5');
      await check('GET /perception returns typed autonomous-perception edges', () => {
        assert.strictEqual(perception.status, 200);
        assert.strictEqual(perception.body.ok, true);
        assert(perception.body.events.some((event) => event.type === 'threat:enter'));
      });

      const state = await request(server.port, 'POST', '/observe', {
        fields: ['position', 'inventory'],
        purpose: 'task'
      });
      await check('POST /observe is the explicit pre-task state skill, not a push', () => {
        assert.strictEqual(state.status, 200);
        assert.strictEqual(state.body.ok, true);
        assert.strictEqual(state.body.fields.position.value.x, 0);
        assert.strictEqual(state.body.fields.inventory.value, 20);
      });

      const proposed = await request(server.port, 'POST', '/propose', {
        type: 'goto',
        args: { x: 1, y: 64, z: 1 },
        reason: 'harness seeks a better view'
      });
      await check('POST /propose accepts only a harness-generated proposal', () => {
        assert.strictEqual(proposed.status, 202);
        assert.strictEqual(proposed.body.ok, true);
        assert.strictEqual(proposed.body.proposal.candidate.type, 'goto');
        assert.strictEqual(proposed.body.proposal.target, 'goto');
      });

      const saved = await request(server.port, 'POST', '/memory', {
        text: '挖矿计划需要先合成木镐',
        tags: ['挖矿', '计划'],
        category: 'episodic',
        source: 'action-brain'
      });
      const recalled = await request(server.port, 'GET', `/memory?query=${encodeURIComponent('挖矿')}&sources=action-brain`);
      await check('POST/GET /memory expose shared task memory to the behavior brain', () => {
        assert.strictEqual(saved.status, 201);
        assert.strictEqual(saved.body.ok, true);
        assert.strictEqual(recalled.status, 200);
        assert(recalled.body.entries.some((entry) => /挖矿计划/.test(entry.text)));
      });
      await check('GET /plan and GET /plan/:id expose the live record', async () => {
        const list = await request(server.port, 'GET', '/plan');
        assert.strictEqual(list.status, 200);
        assert(list.body.plans.some((plan) => plan.planId === 'http'));
        const one = await request(server.port, 'GET', '/plan/http');
        assert.strictEqual(one.status, 200);
        assert.strictEqual(one.body.plan.state, 'completed');
        const missing = await request(server.port, 'GET', '/plan/nope');
        assert.strictEqual(missing.status, 404);
      });

      const waitingPlan = await request(server.port, 'POST', '/plan', {
        planId: 'http-wait',
        wait: true,
        waitMs: 2000,
        steps: [{ id: 'w', type: 'wait_for_player', args: { question: 'http question?' } }]
      });
      const cancelledHttp = await request(server.port, 'POST', '/plan/http-wait/cancel', { reason: 'http' });
      await check('a parked plan can be cancelled over HTTP', async () => {
        assert.strictEqual(waitingPlan.status, 200);
        assert.strictEqual(waitingPlan.body.plan.state, 'waiting');
        assert.strictEqual(cancelledHttp.status, 200);
        const after = await request(server.port, 'GET', '/plan/http-wait');
        assert.strictEqual(after.body.plan.state, 'cancelled');
      });

      const turned = await request(server.port, 'POST', '/harness/turn', { requestId: 'turn-http' });
      await check('POST /harness/turn creates a turn and GET lists it', async () => {
        assert.strictEqual(turned.status, 200);
        assert(turned.body.turn && turned.body.turn.id);
        const status = await request(server.port, 'GET', '/harness/turns');
        assert.strictEqual(status.status, 200);
        assert(status.body.turns.some((turn) => turn.id === turned.body.turn.id));
      });

      const hookServer = await startServer(ctx, { testHooks: true });
      try {
        const disabled = await request(server.port, 'POST', '/harness/inject', {
          kind: 'plan',
          planId: 'http-inject',
          type: 'plan:completed'
        });
        const enabled = await request(hookServer.port, 'POST', '/harness/inject', {
          kind: 'plan',
          planId: 'http-inject',
          type: 'plan:completed'
        });
        const injectedTurn = await request(hookServer.port, 'POST', '/harness/inject', {
          kind: 'turn',
          turnId: turned.body.turn.id
        });
        await check('A28 injection exists only when testHooks is on', () => {
          assert.strictEqual(disabled.status, 404, 'default agent must not expose injection');
          assert.strictEqual(enabled.status, 200);
          assert.strictEqual(enabled.body.ok, true);
          assert.strictEqual(enabled.body.outcome.ok, false, 'no turn owns that plan');
          assert.strictEqual(injectedTurn.status, 200);
          assert.match(injectedTurn.body.eventId, /^injected\|turn:resumable/);
        });
      } finally {
        hookServer.server.close();
      }

      const waited = await request(server.port, 'POST', `/harness/turn/${encodeURIComponent(turned.body.turn.id)}/wait`, {
        taskId: 'http-task'
      });
      assert.strictEqual(waited.status, 200);
      fixture.events.publish({ type: 'task:done', taskId: 'http-task', attemptId: 'http-task#0' });
      await waitForEvent(turnService.turnEvents, (event) => event.type === 'turn:resumable');
      await check('the harness event stream endpoint is a valid SSE source', async () => {
        const sse = await new Promise((resolve, reject) => {
          const req = http.get(
            { host: '127.0.0.1', port: server.port, path: '/harness/events?lastEventId=0' },
            (res) => {
              let data = '';
              res.on('data', (chunk) => {
                data += chunk;
                if (data.includes('event: turn:resumable')) {
                  req.destroy();
                  resolve({ status: res.statusCode, headers: res.headers, data });
                }
              });
              res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data }));
            }
          );
          req.on('error', (err) => {
            if (err.code === 'ECONNRESET') return;
            reject(err);
          });
          setTimeout(() => {
            req.destroy();
            reject(new Error('SSE timeout'));
          }, 1500).unref?.();
        });
        assert.strictEqual(sse.status, 200);
        assert(String(sse.headers['content-type']).includes('text/event-stream'));
        assert(sse.data.includes('event: turn:resumable'));
      });

      const finished = await request(
        server.port,
        'POST',
        `/harness/turn/${encodeURIComponent(turned.body.turn.id)}/finish`
      );
      assert.strictEqual(finished.status, 200);
    } finally {
      await server.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------- persistence
  process.stdout.write('\n6. persistence (A17/A29)\n');
  {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1-m3-state-'));
    const stateFile = path.join(tempRoot, 'state.json');
    const brain = makeBrain({ enabled: true, file: stateFile, debounceMs: 0 });
    brain.planService.submit(
      {
        planId: 'persist',
        goal: 'restart me',
        steps: [{ id: 'w', type: 'wait_for_player', args: { question: 'continue after restart?' } }]
      },
      { source: 'test' }
    );
    brain.planService.start('persist');
    await brain.planService.waitFor('persist', 2000);
    brain.chatMemory.saveTurn({ text: '重启前的聊天', reply: '记住了' });
    brain.saveStateNow();
    await check('a waiting plan, its question and budget are written atomically', () => {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      assert.strictEqual(saved.version, 1);
      assert(saved.plans.plans.some((plan) => plan.planId === 'persist'));
      assert(saved.proposals.current && saved.proposals.current.candidate.type === 'plan_question');
      assert(saved.planService.budgets.some(([planId]) => planId === 'persist'));
      assert(saved.budget && saved.budget.limits, 'the main planning budget must persist');
      assert(saved.chatMemory && saved.chatMemory.entries.some((entry) => /重启前的聊天/.test(entry.text)));
      const waiting = saved.plans.plans.find((plan) => plan.planId === 'persist').steps.find((step) => step.status === 'waiting');
      assert(waiting, 'the waiting step must be persisted');
    });

    const restored = makeBrain({ enabled: true, file: stateFile, debounceMs: 0 });
    await check('restart restores the plan/question/budget and never replays a task', () => {
      const plan = restored.plans.get('persist');
      assert(plan, 'plan not restored');
      assert.strictEqual(plan.steps.find((step) => step.id === 'w').status, 'waiting');
      const pending = restored.proposals.pending();
      assert(pending && pending.candidate.type === 'plan_question');
      assert.strictEqual(pending.candidate.args.planId, 'persist');
      assert.strictEqual(restored.planService.active, null, 'restore must not start a run');
      assert.strictEqual(restored.planService.budgets.has('persist'), true);
      assert.strictEqual(restored.chatMemory.grep('重启前').length >= 1, true, 'chat memory restored');
      const completed = restored.events.since(0).filter((event) => event.type === 'task:done');
      assert.strictEqual(completed.length, 0, 'restore must not replay a task');
      assert.strictEqual(restored.planRunner.busy, false);
    });

    restored.saveStateNow();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  process.stdout.write('\n7. memory write closure\n');
  {
    const brain = makeBrain();
    const first = brain.events.publish({
      type: 'task:done',
      taskId: 'task-mem',
      reason: 'collected 1 dirt'
    });
    const recalled = brain.memoryStore.recall('task-mem');
    await check('a terminal task event writes an episodic memory entry', () => {
      assert(first);
      assert.strictEqual(recalled.length, 1);
      assert.match(recalled[0].entry.text, /task-mem/);
      assert.match(recalled[0].entry.text, /collected 1 dirt/);
      assert.strictEqual(recalled[0].entry.source, 'task-event');
    });

    const duplicate = brain.events.publish({
      type: 'task:done',
      taskId: 'task-mem',
      reason: 'collected 1 dirt'
    });
    await check('the event-id dedupe prevents a duplicate memory write', () => {
      assert.strictEqual(duplicate, null);
      assert.strictEqual(brain.memoryStore.recall('task-mem').length, 1);
    });

    brain.plans.applyDraft({
      planId: 'mem-plan',
      goal: 'dig a memory hole',
      steps: [{ id: 's', type: 'mine' }]
    });
    brain.events.publish({ type: 'plan:completed', planId: 'mem-plan', reason: 'done' });
    await check('a terminal plan event writes a natural-language memory entry', () => {
      const entries = brain.memoryStore.recall('memory hole');
      assert(entries.length >= 1);
      assert.match(entries[0].entry.text, /计划「dig a memory hole」/);
      assert(entries[0].entry.tags.includes('plan'));
    });
  }

  process.stdout.write('\n8. harness proposal source\n');
  {
    const brain = makeBrain();
    const outcome = await brain.proposeFromHarness({
      type: 'goto',
      args: { x: 1, y: 64, z: 1 },
      reason: 'harness wants a better view'
    });
    await check('planner.mode=off keeps the local proposer off', () => {
      assert.strictEqual(brain.plannerMode, 'off');
      assert.strictEqual(brain.lastDecision, null);
    });
    await check('the harness proposal is stored only as a proposal, not executed', () => {
      assert(outcome.ok);
      assert.strictEqual(outcome.autoAccepted, false);
      assert(brain.proposals.pending());
      assert.strictEqual(brain.activeTask, null);
      assert.strictEqual(brain.queue.length, 0);
    });
    brain.rejectProposal();
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`P1 M3 live-entry contract: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const failure of failed) process.stdout.write(`  FAILED: ${failure.name} - ${failure.detail}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('M3 code is wired; client/model items remain unexecuted.\n');
  }
})().catch((err) => {
  process.stderr.write(`p1-m3-test crashed: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
