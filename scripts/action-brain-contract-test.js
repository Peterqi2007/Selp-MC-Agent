'use strict';

/** Scaffold only. No production imports, runtime files, network, model, SDK or game. */
const assert = require('node:assert/strict');
const {
  ActionBrainRuntime, LeaseGate, ToolBroker, PluginRegistry, SubagentScheduler,
  createGameControlPort, createPiDriverFactory, projectPiEvent, supportedNode, jsonSafe, deferred,
  SCHEMA_VERSION, DEFAULT_WORLD_KEY, TASK_STATES, TERMINAL_STATES, EVENT_TYPES, DELIVERY_TIMING,
  SYNC_COMMANDS, ASYNC_COMMANDS, STOP_COMMANDS, RECEIPT_FIELDS, TERMINAL_EVENT_FIELDS, isTerminalState,
  classifyCommand, buildAcceptedReceipt, buildTerminalEvent, validateReceipt,
  CONSUME_MODES, OFFER_RESULTS, createEventMailbox,
  WAKE_REASONS, NON_WAKE_REASONS, createWakeScheduler
} = require('../src/actionBrain');

const tests = [];
const check = (name, fn) => tests.push({ name, fn });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function gamePort(overrides = {}) {
  return { ownership: 'existing-task-slot-plan-service', observe: async () => ({ health: 20 }),
    execute: async () => ({ accepted: true }), cancel: () => ({ ok: true }),
    waitForIdle: async () => ({ ok: true, idle: true }),
    releaseInputs: () => ({ ok: true }), ...overrides };
}

function controlledDriver(log = []) {
  const completed = deferred();
  return { completed, start: async () => completed.promise, steer: async () => 'queued',
    abort: () => { log.push('sdk.abort'); return { ok: true }; }, dispose: () => { log.push('sdk.dispose'); } };
}

class FakePiSession {
  constructor() { this.listeners = new Set(); this.prompts = []; this.steers = []; this.aborts = 0; this.disposed = 0; this.promptResult = deferred(); }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event) { for (const fn of this.listeners) fn(event); }
  prompt(text) { this.prompts.push(text); return this.promptResult.promise; }
  steer(text) { this.steers.push(text); return 'queued'; }
  abort() { ++this.aborts; this.emit({ type: 'agent_settled' }); return Promise.resolve(); }
  dispose() { ++this.disposed; }
}

check('CommonJS scaffold loads without installing or importing Pi', () => {
  assert.equal(typeof ActionBrainRuntime, 'function');
  assert.equal(supportedNode('18.20.0'), false);
  assert.equal(supportedNode('22.18.0'), false);
  assert.equal(supportedNode('22.19.0'), true);
  assert.equal(supportedNode('24.0.0'), true);
});

check('game control is fail-closed and requires the existing ownership adapter', () => {
  const port = createGameControlPort();
  assert.throws(() => port.execute({}), /Inject the existing/);
  assert.throws(() => createGameControlPort({ ...gamePort(), ownership: 'new-body-lock' }), /existing TaskSlot/);
});

check('lease revocation is synchronous, precedes abort, and rejects forged/old leases', () => {
  const gate = new LeaseGate(); const lease = gate.begin('one');
  assert.equal(gate.isCurrent(lease), true);
  assert.equal(gate.isCurrent({ ...lease }), false);
  assert.equal(gate.invalidate(), lease);
  assert.equal(gate.isCurrent(lease), false);
  assert.equal(lease.signal.aborted, false);
  gate.abort(lease);
  assert.equal(lease.signal.aborted, true);
  const next = gate.begin('two'); assert.equal(gate.isCurrent(next), true);
  assert.equal(gate.isCurrent(lease), false);
});

check('broker defaults to denial and validates capabilities and tool input', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('one'); const broker = new ToolBroker({ gate }); let calls = 0;
  assert.throws(() => broker.register({ name: 'bad', capability: 'anything', execute() {} }), /invalid-tool/);
  broker.register({ name: 'inspect', capability: 'files:read', validate: (input) => typeof input.path === 'string', execute: () => ++calls });
  assert.equal((await broker.bind({ lease }).invoke('inspect', { path: 'x' })).error.code, 'capability-denied');
  assert.equal(broker.bind({ lease }).descriptors().length, 0);
  const tools = broker.bind({ lease, capabilities: ['files:read'] });
  assert.equal((await tools.invoke('inspect', {})).error.code, 'invalid-tool-input');
  assert.equal((await tools.invoke('missing', {})).error.code, 'unknown-tool');
  assert.deepEqual(await tools.invoke('inspect', { path: 'x' }), { ok: true, result: 1 });
  assert.equal(calls, 1);
});

check('stale uncooperative tool results and errors never enter a newer turn', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('one'); const events = []; const result = deferred();
  const broker = new ToolBroker({ gate, emit: (event) => events.push(event) });
  broker.register({ name: 'slow', capability: 'compute', validate: () => true, execute: () => result.promise });
  const call = broker.bind({ lease, capabilities: ['compute'] }).invoke('slow', {});
  await tick(); gate.invalidate(); gate.begin('two'); result.resolve({ text: 'MUST NOT SURVIVE' });
  assert.equal((await call).error.code, 'stale-result');
  assert.equal(JSON.stringify(events).includes('MUST NOT SURVIVE'), false);
  assert.equal(events.filter((event) => event.type === 'tool:end').length, 0);
});

check('abort returns promptly even if an uncooperative tool is still pending', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('one'); const result = deferred();
  const broker = new ToolBroker({ gate });
  broker.register({ name: 'slow', capability: 'compute', validate: () => true, execute: () => result.promise });
  const call = broker.bind({ lease, capabilities: ['compute'] }).invoke('slow', {});
  await tick(); const revoked = gate.invalidate(); gate.abort(revoked);
  assert.equal((await call).error.code, 'stale-result');
  result.reject(new Error('late failure')); await tick(); // No unhandled rejection.
});

check('plugin manifest starts ungranted, enforces subset grants, and supports revocation', async () => {
  const plugins = new PluginRegistry();
  assert.throws(() => plugins.register({ id: 'bad', version: '1.0.0', apiVersion: 1, capabilities: ['shell:all'], tools: [] }), /unknown-capability/);
  plugins.register({ id: 'demo', version: '1.0.0', apiVersion: 1, capabilities: ['files:read'], tools: [{ name: 'demo.read', capability: 'files:read' }] });
  const gate = new LeaseGate(); const lease = gate.begin('one'); const broker = new ToolBroker({ gate, plugins });
  broker.register({ name: 'demo.read', capability: 'files:read', pluginId: 'demo', validate: () => true, execute: () => 'ok' });
  const tools = broker.bind({ lease, capabilities: ['files:read'] });
  assert.equal((await tools.invoke('demo.read', {})).error.code, 'plugin-not-authorized');
  assert.throws(() => plugins.authorize('demo', ['files:write']), /plugin-grant-refused/);
  plugins.authorize('demo', ['files:read']);
  assert.equal((await tools.invoke('demo.read', {})).ok, true);
  plugins.authorize('demo', []);
  assert.equal((await tools.invoke('demo.read', {})).error.code, 'plugin-not-authorized');
});

check('subagents default to read capabilities and can never directly control the game', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('one'); const broker = new ToolBroker({ gate });
  broker.register({ name: 'read', capability: 'files:read', validate: () => true, execute: () => 'read' });
  broker.register({ name: 'write', capability: 'files:write', validate: () => true, execute: () => 'write' });
  broker.register({ name: 'move', capability: 'game:control', validate: () => true, execute: () => 'move' });
  const scheduler = new SubagentScheduler({ gate, broker, workerFactory: async () => ({
    run: async (_task, { tools }) => ({ read: await tools.invoke('read', {}), write: await tools.invoke('write', {}), move: await tools.invoke('move', {}) }), abort() {}
  }) });
  assert.throws(() => scheduler.spawn({ parentLease: lease, task: 'x', capabilities: ['game:control'] }), /subagent-game-control-denied/);
  const result = await scheduler.spawn({ parentLease: lease, task: 'x' }).done;
  assert.equal(result.result.read.ok, true);
  assert.equal(result.result.write.error.code, 'capability-denied');
  assert.equal(result.result.move.error.code, 'capability-denied');
  const forced = broker.bind({ lease, capabilities: ['game:control'], actor: 'subagent' });
  assert.equal((await forced.invoke('move', {})).error.code, 'subagent-game-control-denied');
});

check('subagent concurrency and queue are bounded and workers are independent', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('one'); const broker = new ToolBroker({ gate }); const calls = []; const waits = [];
  const scheduler = new SubagentScheduler({ gate, broker, maxConcurrent: 1, maxQueued: 1, workerFactory: async ({ id }) => {
    calls.push(id); const wait = deferred(); waits.push(wait); return { run: () => wait.promise, abort() {} };
  } });
  const first = scheduler.spawn({ parentLease: lease, task: 'one' });
  const second = scheduler.spawn({ parentLease: lease, task: 'two' });
  assert.throws(() => scheduler.spawn({ parentLease: lease, task: 'three' }), /subagent-queue-full/);
  await tick(); assert.equal(calls.length, 1); assert.equal(scheduler.status().queued, 1);
  waits[0].resolve('one'); assert.equal((await first.done).ok, true); await tick(); assert.equal(calls.length, 2);
  waits[1].resolve('two'); assert.equal((await second.done).ok, true);
});

check('parent cancellation cancels running and queued children without admitting late results', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('one'); const broker = new ToolBroker({ gate }); const wait = deferred(); let aborts = 0; const events = [];
  const scheduler = new SubagentScheduler({ gate, broker, maxConcurrent: 1, maxQueued: 1, emit: (event) => events.push(event),
    workerFactory: async () => ({ run: () => wait.promise, abort: () => { ++aborts; } }) });
  const one = scheduler.spawn({ parentLease: lease, task: 'one' });
  const two = scheduler.spawn({ parentLease: lease, task: 'two' });
  await tick(); const revoked = gate.invalidate(); gate.abort(revoked);
  assert.equal((await one.done).ok, false); assert.equal((await two.done).ok, false);
  await tick(); assert.equal(aborts, 1);
  wait.resolve('LATE CHILD DATA'); await tick();
  assert.equal(JSON.stringify(events).includes('LATE CHILD DATA'), false);
});

check('worker created after parent stop is aborted and never run', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('one'); const broker = new ToolBroker({ gate }); const factory = deferred(); let runs = 0; let aborts = 0;
  const scheduler = new SubagentScheduler({ gate, broker, stopTimeoutMs: 20, workerFactory: () => factory.promise });
  const job = scheduler.spawn({ parentLease: lease, task: 'x' });
  const revoked = gate.invalidate(); assert.equal((await scheduler.cancelAll()).ok, false); gate.abort(revoked);
  assert.equal(scheduler.status().unconfirmed, 1); assert.equal(scheduler.status().active, 1);
  factory.resolve({ run() { ++runs; }, abort() { ++aborts; } });
  await tick(); await tick(); assert.equal((await job.done).ok, false); assert.equal(runs, 0); assert.equal(aborts, 1);
});

check('reusing the same child worker is refused instead of sharing a session', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('one'); const broker = new ToolBroker({ gate });
  const worker = { run: async () => 'ok', abort() {} };
  const scheduler = new SubagentScheduler({ gate, broker, workerFactory: async () => worker });
  assert.equal((await scheduler.spawn({ parentLease: lease, task: 'one' }).done).ok, true);
  const result = await scheduler.spawn({ parentLease: lease, task: 'two' }).done;
  assert.equal(result.error.code, 'independent-worker-required');
});

check('runtime stop revokes first, dispatches game brakes and children, then SDK abort', async () => {
  const log = []; const driver = controlledDriver(log); const childWait = deferred(); let lease; let tools;
  const runtime = new ActionBrainRuntime({
    gamePort: gamePort({ cancel() { assert.equal(runtime.gate.isCurrent(lease), false); log.push('game.cancel'); },
      releaseInputs() { log.push('game.release'); } }),
    driverFactory: async (context) => { lease = context.lease; tools = context.tools; return driver; },
    workerFactory: async () => ({ run: () => childWait.promise, abort() { log.push('child.abort'); childWait.resolve('cancelled'); } })
  });
  const run = runtime.start('test', { capabilities: ['game:control'] }); await tick();
  const child = runtime.children.spawn({ parentLease: lease, task: 'read' }); await tick();
  const stopped = runtime.stop();
  assert.equal(runtime.gate.isCurrent(lease), false);
  assert.deepEqual(log.slice(0, 4), ['game.cancel', 'game.release', 'child.abort', 'sdk.abort']);
  assert.equal((await stopped).ok, true); assert.equal((await run).error.code, 'stale-result');
  assert.equal((await child.done).ok, false);
  assert.equal((await tools.invoke('mc_step', {})).error.code, 'stale-lease');
  driver.completed.resolve({ settled: true }); childWait.resolve('late');
});

check('failed or hanging brakes are reported, input release still runs, and restart stays blocked', async () => {
  const log = []; const driver = controlledDriver(log); let failed = true;
  const runtime = new ActionBrainRuntime({ stopTimeoutMs: 20, driverFactory: async () => driver,
    gamePort: gamePort({ cancel: () => failed ? new Promise(() => {}) : { ok: true },
      releaseInputs: () => { log.push('release'); return failed ? { ok: false, error: { code: 'release-failed' } } : { ok: true }; } }) });
  const run = runtime.start('test'); await tick(); const result = await runtime.stop();
  assert.equal(result.ok, false); assert.equal(log.includes('release'), true); assert.equal(log.includes('sdk.abort'), true);
  assert.equal(runtime.status().phase, 'stop-failed'); assert.equal(runtime.status().stopErrors.length, 2);
  await assert.rejects(runtime.start('new'), /Retry stop/);
  await run; failed = false; assert.equal((await runtime.stop('retry-cleanup')).ok, true);
  driver.completed.resolve({ settled: true });
});

check('driver created after stop cannot start and is cleaned up', async () => {
  const factory = deferred(); let starts = 0; let aborts = 0; let disposals = 0;
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), stopTimeoutMs: 20, driverFactory: () => factory.promise });
  const run = runtime.start('test'); assert.equal((await runtime.stop()).ok, false);
  await assert.rejects(runtime.start('too-early'), /Retry stop/);
  factory.resolve({ start() { ++starts; }, steer() {}, abort() { ++aborts; }, dispose() { ++disposals; } });
  assert.equal((await run).error.code, 'stale-result'); assert.equal(starts, 0); assert.equal(aborts, 1); assert.equal(disposals, 1);
  assert.equal((await runtime.stop('retry-confirmation')).ok, true);
});

check('runtime restore marks interrupted and never replays tools, workers, or model calls', () => {
  let calls = 0; const runtime = new ActionBrainRuntime({ driverFactory: () => { ++calls; } });
  const restored = runtime.restore({ version: 1, phase: 'running', runId: 'old', goal: 'unfinished' });
  assert.equal(restored.phase, 'interrupted'); assert.equal(calls, 0); assert.equal(runtime.driver, null);
  assert.equal(runtime.gate.active, null); assert.equal(runtime.children.status().active, 0);
});

check('status, errors and event projections are JSON-safe and redact credential fields', () => {
  const circular = { apiKey: 'private', authorization: 'Bearer sensitive', value: Infinity, tokenCount: 12 }; circular.self = circular;
  const safe = jsonSafe(circular);
  assert.equal(safe.apiKey, '[redacted]'); assert.equal(safe.authorization, '[redacted]');
  assert.equal(safe.value, null); assert.equal(safe.tokenCount, 12); assert.equal(safe.self, '[omitted]');
  assert.doesNotThrow(() => JSON.stringify(new ActionBrainRuntime().status()));
  const projected = projectPiEvent({ type: 'agent_end', apiKey: 'private', messages: circular });
  assert.deepEqual(projected, { type: 'driver:run-ended', settled: false });
});

check('Pi fake session streams text and supports steer but agent_end does not finish a run', async () => {
  const session = new FakePiSession(); const events = []; let definitions;
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(),
    driverFactory: createPiDriverFactory({ sessionFactory: async ({ customTools }) => { definitions = customTools; return { session }; } }) });
  runtime.subscribe((event) => events.push(event));
  const run = runtime.start('test', { capabilities: ['game:observe'] }); let finished = false; run.then(() => { finished = true; });
  await tick(); assert.deepEqual(session.prompts, ['test']); assert.deepEqual(definitions.map((tool) => tool.name), ['mc_observe']);
  assert.equal((await runtime.steer('new observation')).ok, true); assert.deepEqual(session.steers, ['new observation']);
  session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hello' } });
  session.emit({ type: 'agent_end' }); session.promptResult.resolve(); await tick();
  assert.equal(finished, false); assert.equal(runtime.status().phase, 'running');
  session.emit({ type: 'agent_settled' }); assert.equal((await run).ok, true);
  assert.equal(runtime.status().phase, 'completed'); assert.equal(session.disposed, 1);
  assert.equal(events.some((event) => event.type === 'model:text' && event.text === 'hello'), true);
});

check('Pi abort and late SDK events cannot publish into the current runtime turn', async () => {
  const session = new FakePiSession(); const events = [];
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), driverFactory: createPiDriverFactory({ sessionFactory: async () => session }) });
  runtime.subscribe((event) => events.push(event)); const run = runtime.start('test'); await tick();
  assert.equal((await runtime.stop()).ok, true); assert.equal((await run).ok, false);
  session.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'LATE SDK DATA' } });
  assert.equal(session.aborts, 1); assert.equal(JSON.stringify(events).includes('LATE SDK DATA'), false);
});

check('actual SDK path fails closed before any import without explicit integration configuration', async () => {
  const factory = createPiDriverFactory();
  await assert.rejects(factory({ tools: { descriptors: () => [] }, emit() {} }), (error) =>
    error.code === 'pi-configuration-required' || error.code === 'pi-node-version');
});

check('tool registration requires validation and inputs cannot hide non-JSON values', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('json'); const broker = new ToolBroker({ gate }); let calls = 0;
  assert.throws(() => broker.register({ name: 'unvalidated', capability: 'compute', execute() {} }), /invalid-tool/);
  broker.register({ name: 'json', capability: 'compute', validate: () => true, execute: () => ++calls });
  const tools = broker.bind({ lease, capabilities: ['compute'] }); const circular = {}; circular.self = circular;
  const getter = {}; Object.defineProperty(getter, 'x', { enumerable: true, get() { throw new Error('must not execute getter'); } });
  const hidden = {}; Object.defineProperty(hidden, 'fn', { value() {} }); const symbol = { [Symbol('hidden')]: 'ignored' };
  for (const input of [{ x: undefined }, { x() {} }, { x: NaN }, { x: Infinity }, circular, getter, hidden, symbol, new Date(), [undefined]]) {
    assert.equal((await tools.invoke('json', input)).error.code, 'invalid-tool-input');
  }
  assert.equal(calls, 0);
});

check('both root and external cancellation reach the actual tool signal', async () => {
  for (const source of ['root', 'external']) {
    const gate = new LeaseGate(); const lease = gate.begin(source); const controller = new AbortController();
    const wait = deferred(); let signal; let cancelled = 0; const broker = new ToolBroker({ gate });
    broker.register({ name: 'linked', capability: 'compute', validate: () => true, execute: (_input, context) => {
      signal = context.signal; signal.addEventListener('abort', () => { ++cancelled; wait.resolve('cancelled'); }, { once: true });
      return wait.promise;
    } });
    const call = broker.bind({ lease, capabilities: ['compute'] }).invoke('linked', {}, { signal: controller.signal });
    await tick(); if (source === 'root') gate.abort(lease); else controller.abort();
    assert.equal(signal.aborted, true); assert.equal(cancelled, 1); assert.equal((await call).ok, false);
  }
});

function grantedPlugin() {
  const plugins = new PluginRegistry();
  plugins.register({ id: 'writer', version: '1.0.0', apiVersion: 1, capabilities: ['files:write'],
    tools: [{ name: 'writer.write', capability: 'files:write' }] });
  plugins.authorize('writer', ['files:write']); return plugins;
}

check('revocation before dispatch prevents plugin execution', async () => {
  const plugins = grantedPlugin(); const gate = new LeaseGate(); const lease = gate.begin('plugin'); let calls = 0;
  const broker = new ToolBroker({ gate, plugins });
  broker.register({ name: 'writer.write', capability: 'files:write', pluginId: 'writer', validate: () => true, execute: () => ++calls });
  const call = broker.bind({ lease, capabilities: ['files:write'] }).invoke('writer.write', {});
  plugins.authorize('writer', []);
  assert.equal((await call).error.code, 'plugin-authorization-changed'); assert.equal(calls, 0);
});

check('in-flight revocation synchronously cancels cooperative effects and regrant cannot revive the result', async () => {
  const plugins = grantedPlugin(); const gate = new LeaseGate(); const lease = gate.begin('plugin');
  const broker = new ToolBroker({ gate, plugins }); const wait = deferred(); let signal; let writes = 0;
  broker.register({ name: 'writer.write', capability: 'files:write', pluginId: 'writer', validate: () => true,
    execute: async (_input, context) => { signal = context.signal; await wait.promise; if (!signal.aborted) ++writes; return 'old-output'; } });
  const call = broker.bind({ lease, capabilities: ['files:write'] }).invoke('writer.write', {});
  await tick(); plugins.authorize('writer', []); assert.equal(signal.aborted, true);
  plugins.authorize('writer', ['files:write']); wait.resolve();
  assert.equal((await call).error.code, 'plugin-authorization-changed'); await tick(); assert.equal(writes, 0);
});

check('uncooperative child run retains capacity, fails stop and gates runtime restart', async () => {
  const driver = controlledDriver(); const childRun = deferred(); let lease;
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), stopTimeoutMs: 20,
    driverFactory: async (context) => { lease = context.lease; return driver; },
    workerFactory: async () => ({ run: () => childRun.promise, abort() {} }) });
  const run = runtime.start('test'); await tick(); const child = runtime.children.spawn({ parentLease: lease, task: 'slow' }); await tick();
  assert.equal((await runtime.stop()).ok, false); assert.equal((await child.done).ok, false); await run;
  assert.equal(runtime.children.status().active, 1); assert.equal(runtime.children.status().unconfirmed, 1);
  await assert.rejects(runtime.start('too-early'), /Retry stop/);
  childRun.resolve('late'); await tick(); assert.equal(runtime.children.status().active, 0);
  assert.equal((await runtime.stop('retry')).ok, true); driver.completed.resolve({ settled: true });
});

check('new partial child worker is aborted and disposed even when validation fails', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('partial'); const broker = new ToolBroker({ gate }); let aborts = 0; let disposals = 0;
  const scheduler = new SubagentScheduler({ gate, broker, workerFactory: async () => ({ abort() { ++aborts; }, dispose() { ++disposals; } }) });
  const result = await scheduler.spawn({ parentLease: lease, task: 'partial' }).done; await tick();
  assert.equal(result.error.code, 'independent-worker-required'); assert.equal(aborts, 1); assert.equal(disposals, 1);
  assert.equal(scheduler.status().active, 0); assert.equal(scheduler.status().unconfirmed, 0);
});

check('partial worker cleanup failure retains a retryable slot', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('partial-failed'); const broker = new ToolBroker({ gate }); let fail = true; let disposals = 0;
  const scheduler = new SubagentScheduler({ gate, broker, stopTimeoutMs: 20, workerFactory: async () => ({ abort() {},
    dispose() { ++disposals; if (fail && disposals === 1) throw new Error('dispose unavailable');
      return fail ? { ok: false, error: { code: 'dispose-refused' } } : undefined; } }) });
  await scheduler.spawn({ parentLease: lease, task: 'partial' }).done; await tick();
  assert.equal(scheduler.status().unconfirmed, 1); assert.equal((await scheduler.cancelAll()).ok, false);
  fail = false; assert.equal((await scheduler.cancelAll()).ok, true); assert.equal(scheduler.status().active, 0); assert.equal(disposals, 3);
});

check('rejecting a reused live worker never aborts another child session', async () => {
  const gate = new LeaseGate(); const lease = gate.begin('reuse'); const broker = new ToolBroker({ gate });
  const wait = deferred(); let aborts = 0; let disposals = 0;
  const worker = { run: () => wait.promise, abort() { ++aborts; }, dispose() { ++disposals; } };
  const scheduler = new SubagentScheduler({ gate, broker, workerFactory: async () => worker });
  const first = scheduler.spawn({ parentLease: lease, task: 'one' }); await tick();
  assert.equal((await scheduler.spawn({ parentLease: lease, task: 'two' }).done).error.code, 'independent-worker-required');
  assert.equal(aborts, 0); assert.equal(disposals, 0);
  wait.resolve('done'); assert.equal((await first.done).ok, true); await tick(); assert.equal(disposals, 1);
});

check('model settled and accepted game receipts do not complete an active asynchronous plan', async () => {
  const idle = deferred(); let accepted = 0; let finished = false;
  const runtime = new ActionBrainRuntime({ gamePort: gamePort({ execute: async () => { ++accepted; return { accepted: true, planId: 'pending' }; },
    waitForIdle: () => idle.promise }), driverFactory: async ({ tools }) => ({
    start: async () => { await tools.invoke('mc_step', {}); return { settled: true, outcome: 'completed' }; }, steer() {}, abort() {}, dispose() {}
  }) });
  const run = runtime.start('plan', { capabilities: ['game:control'] }); run.then(() => { finished = true; }); await tick();
  assert.equal(accepted, 1); assert.equal(finished, false); assert.equal(runtime.status().phase, 'settling');
  idle.resolve({ ok: true, idle: true, taskState: 'completed', planState: 'completed' });
  assert.equal((await run).ok, true);
});

check('missing terminal game evidence fails and invokes game brakes', async () => {
  const log = []; const driver = controlledDriver(log);
  const runtime = new ActionBrainRuntime({ gamePort: gamePort({ waitForIdle: async () => ({ accepted: true }),
    cancel: () => { log.push('cancel'); }, releaseInputs: () => { log.push('release'); } }), driverFactory: async () => driver });
  const run = runtime.start('plan'); await tick(); driver.completed.resolve({ settled: true });
  const result = await run; assert.equal(result.ok, false); assert.equal(result.error.code, 'game-not-idle');
  assert.equal(log.includes('cancel'), true); assert.equal(log.includes('release'), true);
});

check('failed main disposal cannot be cleared without retrying the original driver', async () => {
  let fail = true; let disposals = 0; const driver = controlledDriver();
  driver.dispose = () => { ++disposals; return fail ? { ok: false, error: { code: 'dispose-failed' } } : undefined; };
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), stopTimeoutMs: 20, driverFactory: async () => driver });
  const run = runtime.start('dispose'); await tick(); driver.completed.resolve({ settled: true });
  assert.equal((await run).ok, false); assert.equal(runtime.status().unsafeDrivers, 1);
  await assert.rejects(runtime.start('too-early'), /Retry stop/);
  assert.equal((await runtime.stop('retry-fails')).ok, false); assert.equal(runtime.status().unsafeDrivers, 1);
  fail = false; assert.equal((await runtime.stop('retry-recovers')).ok, true);
  assert.equal(runtime.status().unsafeDrivers, 0); assert.equal(disposals, 3);
});

check('pending main disposal remains gated after stop timeout until actual cleanup and retry', async () => {
  const disposal = deferred(); const driver = controlledDriver(); driver.dispose = () => disposal.promise;
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), stopTimeoutMs: 20, driverFactory: async () => driver });
  const run = runtime.start('dispose'); await tick(); driver.completed.resolve({ settled: true }); await tick();
  assert.equal(runtime.status().operation, 'disposing'); assert.equal((await runtime.stop()).ok, false);
  await assert.rejects(runtime.start('too-early'), /Retry stop/);
  disposal.resolve(); await run; assert.equal((await runtime.stop('retry')).ok, true);
});

check('queued steer is fenced before dispatch when stop lands first', async () => {
  const log = []; const driver = controlledDriver(log); driver.steer = () => { log.push('steer'); };
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), driverFactory: async () => driver });
  const run = runtime.start('steer'); await tick(); const steering = runtime.steer('late'); const stopping = runtime.stop();
  assert.equal((await stopping).ok, true); assert.equal((await steering).ok, false); await run;
  assert.equal(log.includes('steer'), false); assert.equal(log.filter((entry) => entry === 'sdk.abort').length, 1);
});

check('stop reentry from brakes and events shares one promise and dispatches once', async () => {
  let runtime; let nested; let eventStop; let cancels = 0; let releases = 0; const log = []; const driver = controlledDriver(log);
  runtime = new ActionBrainRuntime({ gamePort: gamePort({ cancel() { ++cancels; nested = runtime.stop('nested'); },
    releaseInputs() { ++releases; } }), driverFactory: async () => driver });
  runtime.subscribe((event) => { if (event.type === 'run:stopping') eventStop = runtime.stop('subscriber'); });
  const run = runtime.start('reentry'); await tick(); const outer = runtime.stop('outer');
  assert.equal(outer, nested); assert.equal(outer, eventStop); assert.equal((await outer).ok, true); await run;
  assert.equal(cancels, 1); assert.equal(releases, 1); assert.equal(log.filter((entry) => entry === 'sdk.abort').length, 1);
});

check('Pi subscription initialization failure aborts and disposes the partial session', async () => {
  const session = new FakePiSession(); session.subscribe = () => { throw new Error('subscribe failed'); };
  const factory = createPiDriverFactory({ sessionFactory: async () => session });
  await assert.rejects(factory({ tools: { descriptors: () => [] }, emit() {} }), (error) => error.code === 'pi-initialization-failed' && !error.cleanupDriver);
  assert.equal(session.aborts, 1); assert.equal(session.disposed, 1); assert.equal(session.prompts.length, 0);
});

check('Pi failed partial cleanup retains the runtime recovery handle until a successful retry', async () => {
  const session = new FakePiSession(); let fail = true;
  session.subscribe = () => { throw new Error('subscribe failed'); };
  session.dispose = () => { ++session.disposed; if (fail) throw new Error('dispose failed'); };
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), stopTimeoutMs: 20,
    driverFactory: createPiDriverFactory({ sessionFactory: async () => session, initializationCleanupTimeoutMs: 20 }) });
  assert.equal((await runtime.start('broken-init')).ok, false); await tick();
  assert.equal(runtime.status().unsafeDrivers, 1); await assert.rejects(runtime.start('too-early'), /Retry stop/);
  assert.equal((await runtime.stop('retry-fails')).ok, false); assert.equal(runtime.status().unsafeDrivers, 1);
  fail = false; assert.equal((await runtime.stop('retry-recovers')).ok, true); assert.equal(runtime.status().unsafeDrivers, 0);
  assert.equal(session.disposed, 4); assert.equal(session.prompts.length, 0);
});

check('Pi disposal still runs when unsubscribe fails and both cleanup steps are retryable', async () => {
  const session = new FakePiSession(); let fail = true; let unsubscribes = 0;
  session.subscribe = () => () => { ++unsubscribes; if (fail) throw new Error('unsubscribe failed'); };
  const factory = createPiDriverFactory({ sessionFactory: async () => session });
  const driver = await factory({ tools: { descriptors: () => [] }, emit() {} });
  await assert.rejects(driver.dispose(), /unsubscribe failed/); assert.equal(session.disposed, 1);
  fail = false; await driver.dispose(); assert.equal(unsubscribes, 2); assert.equal(session.disposed, 2);
});

check('Pi settled cancellation or final assistant failure never reports runtime success', async () => {
  for (const ending of [{ aborted: true }, { stopReason: 'aborted' }, { stopReason: 'error', errorMessage: 'provider failed' }]) {
    const session = new FakePiSession(); const events = [];
    const runtime = new ActionBrainRuntime({ gamePort: gamePort(), driverFactory: createPiDriverFactory({ sessionFactory: async () => session }) });
    runtime.subscribe((event) => events.push(event)); const run = runtime.start('failure'); await tick();
    if (ending.stopReason) session.emit({ type: 'message_end', message: { role: 'assistant', ...ending } });
    session.emit({ type: 'agent_settled', aborted: ending.aborted || false });
    const result = await run; assert.equal(result.ok, false); assert.equal(result.error.code, ending.stopReason === 'error' ? 'pi-model-error' : 'aborted');
    assert.equal(events.some((event) => event.type === 'run:settled'), false); assert.equal(session.aborts, 1);
  }
});

check('Pi successful final retry replaces an intermediate assistant failure', async () => {
  const session = new FakePiSession();
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), driverFactory: createPiDriverFactory({ sessionFactory: async () => session }) });
  const run = runtime.start('retry'); await tick();
  session.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'temporary' } });
  session.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } });
  session.emit({ type: 'agent_settled', aborted: false }); assert.equal((await run).ok, true);
});

check('explicit settled driver failure invokes brakes and returns failure', async () => {
  for (const outcome of ['failed', 'aborted']) {
    const log = []; const driver = controlledDriver(log);
    const runtime = new ActionBrainRuntime({ gamePort: gamePort({ cancel() { log.push('cancel'); } }), driverFactory: async () => driver });
    const run = runtime.start('failure'); await tick(); driver.completed.resolve({ settled: true, outcome });
    const result = await run; assert.equal(result.ok, false); assert.equal(result.error.code, outcome);
    assert.equal(log.includes('cancel'), true); assert.equal(log.includes('sdk.abort'), true);
  }
});

check('async contracts are data-only and frozen', () => {
  // v2 (2026-11-06): receipts/terminal events carry the worldKey partition key.
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(Object.isFrozen(TASK_STATES), true);
  assert.equal(Object.isFrozen(TERMINAL_STATES), true);
  assert.equal(TASK_STATES.includes('accepted'), true);
  for (const state of ['succeeded', 'failed', 'dropped', 'timeout', 'cancelled', 'interrupted']) {
    assert.equal(TERMINAL_STATES.includes(state), true, state);
    assert.equal(isTerminalState(state), true, state);
  }
  // accepted/running 永远不是终态：回执不能被当成完成。
  assert.equal(isTerminalState('accepted'), false);
  assert.equal(isTerminalState('running'), false);
  assert.equal(TERMINAL_STATES.includes('accepted'), false);
});

check('async command classification matches the frozen verb tables', () => {
  assert.equal(classifyCommand('mine iron_ore 20'), 'async');
  assert.equal(classifyCommand('plan'), 'async');
  assert.equal(classifyCommand('stop'), 'stop');
  assert.equal(classifyCommand('cancel plan-1'), 'stop');
  assert.equal(classifyCommand('state'), 'sync');
  assert.equal(classifyCommand('observe'), 'sync');
  assert.equal(classifyCommand('teleport'), 'unknown');
  assert.equal(Object.isFrozen(ASYNC_COMMANDS), true);
  assert.equal(ASYNC_COMMANDS.includes(SYNC_COMMANDS[0]), false);
});

check('every event type has a delivery timing', () => {
  const allowed = ['boundary', 'round', 'ride'];
  for (const type of EVENT_TYPES) {
    assert.equal(allowed.includes(DELIVERY_TIMING[type]), true, `${type} -> ${DELIVERY_TIMING[type]}`);
  }
  // 只有活人说话与显式 steer 允许开轮；世界事实恒不紧急。
  assert.equal(DELIVERY_TIMING['chat.incoming'], 'round');
  assert.equal(DELIVERY_TIMING['perception.edge'], 'ride');
  assert.equal(DELIVERY_TIMING['task.progress'], 'boundary');
});

check('async builders refuse to pretend a task succeeded', () => {
  for (const attempt of [
    () => buildAcceptedReceipt({ taskId: 't-1', verb: 'mine' }),
    () => buildTerminalEvent({ taskId: 't-1', state: 'succeeded' }),
    () => validateReceipt({ ok: true, async: true })
  ]) {
    assert.throws(attempt, (error) => error && error.code === 'not-implemented');
  }
  assert.equal(RECEIPT_FIELDS.includes('schemaVersion'), true);
  assert.equal(RECEIPT_FIELDS.includes('taskId'), true);
  assert.equal(TERMINAL_EVENT_FIELDS.includes('eventId'), true);
  assert.equal(TERMINAL_EVENT_FIELDS.includes('epoch'), true);
});

check('event mailbox is an unrouted stub with an idempotent contract', () => {
  const mailbox = createEventMailbox({ capacity: 8 });
  for (const method of ['offer', 'takeBatch', 'peek', 'pending', 'acknowledge', 'snapshot', 'restore']) {
    assert.equal(typeof mailbox[method], 'function', method);
    assert.throws(() => mailbox[method]({ eventId: 'e-1' }), (error) => error && error.code === 'not-implemented', method);
  }
  assert.equal(OFFER_RESULTS.includes('duplicate'), true);
  assert.deepEqual(CONSUME_MODES, ['mid-turn', 'background', 'idle']);
});

check('wake scheduler refuses to open a round before it is implemented', () => {
  const scheduler = createWakeScheduler({ mailbox: createEventMailbox(), runtime: {} });
  for (const method of ['onEvent', 'onBoundary', 'whyNotWake', 'status', 'restore', 'stop']) {
    assert.equal(typeof scheduler[method], 'function', method);
    assert.throws(() => scheduler[method]({ type: 'task.finished' }), (error) => error && error.code === 'not-implemented', method);
  }
  assert.equal(WAKE_REASONS.includes('principal-speech'), true);
  assert.equal(NON_WAKE_REASONS.includes('perception'), true);
  assert.equal(NON_WAKE_REASONS.includes('principal-speech'), false);
});

/** Host adapter with the P2 (async) seams: task list + task-event push. */
function asyncAdapter({ tasks = [], ask = null } = {}) {
  let push = () => {};
  const adapter = {
    ownership: 'existing-task-slot-plan-service',
    observe: async () => ({ health: 20 }),
    execute: async () => ({ accepted: true, taskId: 't-1' }),
    /** Deliberately NOT idle: async mode must never depend on this. */
    waitForIdle: async () => ({ ok: false, idle: false }),
    cancel: () => ({ ok: true }), releaseInputs: () => ({ ok: true }),
    tasks: () => tasks.slice(),
    onTaskEvent: (cb) => { push = cb; return () => { push = () => {}; }; }
  };
  if (ask) adapter.ask = ask;
  return { adapter, tasks, push: (event) => push(event) };
}

check('B2: async task mode settles the turn without requiring an idle body', async () => {
  const { adapter, tasks } = asyncAdapter();
  tasks.push({ taskId: 't-9', state: 'running' });
  const driver = controlledDriver();
  const runtime = new ActionBrainRuntime({ gamePort: adapter, driverFactory: async () => driver, taskMode: 'async' });
  const run = runtime.start('mine iron');
  await tick();
  driver.completed.resolve({ settled: true, outcome: 'completed' });
  const result = await run;
  assert.equal(result.ok, true);
  assert.equal(result.settledScope, 'turn');
  assert.equal(result.tasksOpen, 1);
  assert.equal(runtime.status().phase, 'completed');
});

check('B2: async mode fails closed when the task ports are missing', async () => {
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), driverFactory: async () => controlledDriver() });
  await assert.rejects(runtime.start('mine', { taskMode: 'async' }), /taskMode=async requires/);
});

check('B2: a hung driver factory times out instead of wedging start and stop', async () => {
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), initTimeoutMs: 20, stopTimeoutMs: 20,
    driverFactory: () => new Promise(() => {}) });
  const result = await runtime.start('hang');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'operation-timeout');
  await tick();
  assert.equal(runtime.current, null);
});

check('B2: force stop unlocks a new generation after unconfirmed children', async () => {
  let lease;
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), stopTimeoutMs: 10,
    driverFactory: async (context) => {
      lease = context.lease;
      return { start: () => new Promise(() => {}), steer: async () => 'q', abort: () => ({ ok: true }), dispose: () => {} };
    },
    workerFactory: async () => ({ run: () => new Promise(() => {}), abort() {} }) });
  const run = runtime.start('child-holder'); await tick();
  const child = runtime.children.spawn({ parentLease: lease, task: 'slow' }); await tick();
  assert.equal((await runtime.stop()).ok, false);
  await run;
  await assert.rejects(runtime.start('too-early'), /Retry stop/);
  const forced = await runtime.stop('force', { force: true });
  assert.equal(forced.ok, false);
  assert.equal(runtime.status().phase, 'force-stopped');
  const next = runtime.start('fresh'); await tick();
  assert.equal(runtime.status().runId !== null, true);
  await runtime.stop('cleanup'); await next;
  await child.done;
});

check('B2: pause refuses new turns and resume re-opens them', async () => {
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), driverFactory: async () => controlledDriver() });
  assert.equal(runtime.pause('operator typing').ok, true);
  await assert.rejects(runtime.start('x'), /paused/);
  assert.equal(runtime.status().paused.reason, 'operator typing');
  assert.equal(runtime.resume().ok, true);
  const run = runtime.start('x'); await tick();
  assert.equal(runtime.status().phase, 'running');
  await runtime.stop('cleanup'); await run;
});

check('B2: a deadline stops a thinking model instead of waiting forever', async () => {
  const events = [];
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), stopTimeoutMs: 20,
    driverFactory: async () => ({ start: () => new Promise(() => {}), steer: async () => 'q',
      abort: () => ({ ok: true }), dispose: () => {} }) });
  runtime.subscribe((event) => events.push(event.type));
  const result = await runtime.start('think', { deadlineMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(events.includes('run:deadline'), true);
  assert.equal(['stopped', 'failed'].includes(runtime.status().phase), true);
});

check('B2: boundary and ingest are the mailbox seams (dedupe + world fence)', () => {
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), worldSessionId: 'w-1', driverFactory: async () => controlledDriver() });
  const events = []; runtime.subscribe((event) => events.push(event));
  runtime.boundary({ batch: 1 });
  assert.equal(events.some((event) => event.type === 'turn:boundary'), true);
  assert.deepEqual(runtime.ingest({ type: 'task.finished', eventId: 'e-1' }), { ok: true, duplicate: false });
  assert.deepEqual(runtime.ingest({ type: 'task.finished', eventId: 'e-1' }), { ok: true, duplicate: true });
  assert.equal(runtime.ingest({ type: 'task.finished', worldSessionId: 'other' }).error.code, 'stale-world');
  assert.equal(runtime.ingest({}).error.code, 'invalid-event');
});

check('B2: host task events are forwarded with identity, never re-ledgered', () => {
  const { adapter, push } = asyncAdapter();
  const runtime = new ActionBrainRuntime({ gamePort: adapter, worldSessionId: 'w-1', driverFactory: async () => controlledDriver() });
  const events = []; runtime.subscribe((event) => events.push(event));
  push({ type: 'task.finished', taskId: 't-1', state: 'succeeded', worldSessionId: 'w-1' });
  push({ type: 'task.finished', taskId: 't-2', worldSessionId: 'other' });
  const seen = events.filter((event) => event.type === 'task.finished');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].from, 'game');
  assert.equal(seen[0].taskId, 't-1');
});

check('B2: ask parks on the host port and fails closed without it', async () => {
  const plain = new ActionBrainRuntime({ gamePort: gamePort(), driverFactory: async () => controlledDriver() });
  await assert.rejects(plain.ask('dig here?'), /gamePort\.ask/);
  const { adapter } = asyncAdapter({ ask: async () => 'ok' });
  const runtime = new ActionBrainRuntime({ gamePort: adapter, driverFactory: async () => controlledDriver() });
  const run = runtime.start('x'); await tick();
  assert.deepEqual(await runtime.ask('dig here?'), { ok: true, answer: 'ok' });
  await runtime.stop('cleanup'); await run;
});

check('B2: usage counts turns and completed tool calls', async () => {
  const runtime = new ActionBrainRuntime({ gamePort: gamePort(), driverFactory: async (context) => ({
    start: async () => { await context.tools.invoke('mc_observe', {}); return { settled: true, ok: true }; },
    steer: async () => 'q', abort: () => ({ ok: true }), dispose: () => {} }) });
  const result = await runtime.start('x', { capabilities: ['game:observe'] });
  assert.equal(result.ok, true);
  assert.equal(runtime.usageReport().turns, 1);
  assert.equal(runtime.usageReport().toolCalls, 1);
});

check('B2: resumeRequest exposes the re-observe note and open tasks', async () => {
  const { adapter, tasks } = asyncAdapter();
  tasks.push({ taskId: 't-1', state: 'running' });
  const runtime = new ActionBrainRuntime({ gamePort: adapter, driverFactory: async () => controlledDriver(), taskMode: 'async' });
  const request = await runtime.resumeRequest();
  assert.equal(request.openTasks.length, 1);
  assert.match(request.note, /re-observe/);
});

/** Host adapter with the P2 process seam: the game is USER-launched, the product only discovers/attaches. */
function processAdapter({ attachResult = { ok: true, worldKey: 'world-a', worldSessionId: 'w-9' } } = {}) {
  let lost = () => {};
  const discovered = [];
  const attached = [];
  const adapter = {
    ...gamePort(),
    discover: async (input) => { discovered.push(input); return { ok: true, candidates: [{ endpoint: 'http://127.0.0.1:8899', worldKey: 'world-a' }] }; },
    attach: async (candidate) => { attached.push(candidate); return attachResult; },
    onGameLost: (cb) => { lost = cb; return () => { lost = () => {}; }; }
  };
  return { adapter, discovered, attached, lose: (info) => lost(info) };
}

check('process seam is atomic: partial adapters fail closed at construction', () => {
  assert.throws(() => createGameControlPort({ ...gamePort(), discover: async () => ({}) }), /discover \+ attach \+ onGameLost/);
  assert.throws(() => createGameControlPort({ ...gamePort(), discover: async () => ({}), attach: async () => ({}) }), /discover \+ attach \+ onGameLost/);
  assert.throws(() => createGameControlPort({ ...gamePort(), onGameLost: () => () => {} }), /discover \+ attach \+ onGameLost/);
  const { adapter } = processAdapter();
  const port = createGameControlPort(adapter);
  assert.equal(typeof port.discover, 'function');
  assert.equal(typeof port.attach, 'function');
  assert.equal(typeof port.onGameLost, 'function');
  // 无进程接缝的同步夹具照常可用（接缝是可选组，不强制）。
  const plain = createGameControlPort(gamePort());
  assert.equal(plain.discover, undefined);
  assert.equal(plain.attach, undefined);
});

check('discover/attach fail closed without the process seam; attach is refused mid-run', async () => {
  const plain = new ActionBrainRuntime({ gamePort: gamePort(), driverFactory: async () => controlledDriver() });
  await assert.rejects(plain.discoverGames(), /process seam/);
  await assert.rejects(plain.attachGame({ endpoint: 'http://127.0.0.1:8899' }), /process seam/);
  const { adapter } = processAdapter();
  const runtime = new ActionBrainRuntime({ gamePort: adapter, stopTimeoutMs: 20,
    driverFactory: async () => ({ start: () => new Promise(() => {}), steer: async () => 'q',
      abort: () => ({ ok: true }), dispose: () => {} }) });
  const run = runtime.start('busy'); await tick();
  await assert.rejects(runtime.attachGame({ endpoint: 'http://127.0.0.1:8899' }), /run-active/);
  await runtime.stop('cleanup'); await run;
});

check('attach adopts the host-reported world identity and stamps runs, events and requests', async () => {
  const { adapter, attached } = processAdapter();
  let driverContext = null;
  const runtime = new ActionBrainRuntime({ gamePort: adapter,
    driverFactory: async (context) => { driverContext = context; return controlledDriver(); } });
  const events = []; runtime.subscribe((event) => events.push(event));
  const result = await runtime.attachGame({ endpoint: 'http://127.0.0.1:8899' });
  assert.deepEqual(result, { ok: true, worldKey: 'world-a', worldSessionId: 'w-9' });
  assert.equal(attached.length, 1);
  assert.equal(events.some((event) => event.type === 'game:attached' && event.worldKey === 'world-a'), true);
  const run = runtime.start('mine'); await tick();
  assert.equal(runtime.status().worldKey, 'world-a');
  assert.equal(driverContext.worldKey, 'world-a');
  assert.equal(events.some((event) => event.type === 'run:start' && event.worldKey === 'world-a'), true);
  driverFinishOf(runtime).resolve({ settled: true, outcome: 'completed' });
  assert.equal((await run).ok, true);
  assert.equal((await runtime.resumeRequest()).worldKey, 'world-a');
});

/** Reach the controlled driver's completion deferred through the runtime fixture. */
function driverFinishOf(runtime) {
  const record = runtime.current;
  if (!record || !record.driver || !record.driver.completed) throw new Error('no controlled driver in flight');
  return record.driver.completed;
}

check('game loss runs the normal stop fence: game brakes before SDK abort', async () => {
  const log = [];
  const { adapter, lose } = processAdapter();
  const runtime = new ActionBrainRuntime({
    gamePort: { ...adapter,
      cancel: () => { log.push('game.cancel'); return { ok: true }; },
      releaseInputs: () => { log.push('game.releaseInputs'); return { ok: true }; } },
    stopTimeoutMs: 50,
    driverFactory: async () => controlledDriver(log)
  });
  const events = []; runtime.subscribe((event) => events.push(event.type));
  const run = runtime.start('mine'); await tick();
  lose({ reason: 'endpoint-gone' });
  await run;
  assert.equal(events.includes('game:lost'), true);
  assert.equal(log[0], 'game.cancel');
  assert.equal(log.indexOf('sdk.abort') > log.indexOf('game.releaseInputs'), true);
  assert.equal(['stopped', 'failed'].includes(runtime.status().phase), true);
});

check('cross-world events are rejected at both inbound seams', () => {
  const { adapter, push } = asyncAdapter();
  const runtime = new ActionBrainRuntime({ gamePort: adapter, worldKey: 'world-a', worldSessionId: 'w-1',
    driverFactory: async () => controlledDriver() });
  const events = []; runtime.subscribe((event) => events.push(event));
  // 分区栅栏（cross-world）与会话栅栏（stale-world）是两种可判别的错误。
  assert.equal(runtime.ingest({ type: 'task.finished', eventId: 'e-1', worldKey: 'world-b' }).error.code, 'cross-world');
  assert.equal(runtime.ingest({ type: 'task.finished', eventId: 'e-2', worldKey: 'world-a' }).ok, true);
  assert.equal(runtime.ingest({ type: 'task.progress', worldSessionId: 'other' }).error.code, 'stale-world');
  push({ type: 'task.finished', taskId: 't-1', worldKey: 'world-b', worldSessionId: 'w-1' });
  push({ type: 'task.finished', taskId: 't-2', worldKey: 'world-a', worldSessionId: 'w-1' });
  // 只统计任务事件转发 seam 的产物（ingest 通道自己也会发事件，带 inboxSeq）。
  const seen = events.filter((event) => event.type === 'task.finished' && event.from === 'game');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].taskId, 't-2');
});

check('async receipts and terminal events freeze the worldKey partition field', () => {
  assert.equal(RECEIPT_FIELDS.includes('worldKey'), true);
  assert.equal(TERMINAL_EVENT_FIELDS.includes('worldKey'), true);
  assert.equal(Object.isFrozen(RECEIPT_FIELDS), true);
  assert.equal(Object.isFrozen(TERMINAL_EVENT_FIELDS), true);
  // 缺失 worldKey 的兜底分区是显式常量，不是隐式合并。
  assert.equal(DEFAULT_WORLD_KEY, 'default');
  assert.equal(RECEIPT_FIELDS.includes('worldSessionId'), false);
});

(async () => {
  let failed = 0;
  for (const test of tests) {
    try { await test.fn(); process.stdout.write(`  PASS  ${test.name}\n`); }
    catch (error) { ++failed; process.stdout.write(`  FAIL  ${test.name}: ${error.stack}\n`); }
  }
  process.stdout.write(`\nAction brain scaffold: ${tests.length - failed}/${tests.length} checks passed (fake/offline only)\n`);
  if (failed) process.exitCode = 1;
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
