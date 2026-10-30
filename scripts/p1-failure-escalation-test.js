'use strict';

// Offline suites must not read or write the live session-state file (config enables it).
process.env.P1_STATE = 'off';

/**
 * `npm run p1:failure-escalation:test` - failure envelope + escalation gate contracts.
 *
 * Covers, without a client, network or model:
 *   - failure.js: UNVERIFIED/KNOWLEDGE types, class mapping, envelope shape;
 *   - the signature ledger: coordinate hops stay one signature, other verbs are untouched;
 *   - the hard gates: third blind retry refused, lookup-required -> informed retry ->
 *     ask-required, permission never retried, parked-question whitelist;
 *   - de-escalation: success / clearGoal resets the ladder;
 *   - place evidence judging (Node verdict over mod-shaped JSON);
 *   - PlanRunner: a gated step fails the plan honestly with the envelope;
 *   - prompt/capability text: the ladder, granularity and realtime-control rules are
 *     present where the action brain reads them.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { FAILURE, CLASSES, classOf, envelope, fold } = require('../src/core/failure');
const { FailureEscalation } = require('../src/core/failureEscalation');
const { judgeEffect } = require('../src/body/placeEvidence');
const { PlanRunner } = require('../src/core/planRunner');
const { PlanStore } = require('../src/core/planStore');

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const results = [];

/** Async-aware check queue (this suite mixes sync and async assertions). */
const queue = [];
function test(name, fn) {
  queue.push([name, fn]);
}

process.stdout.write('P1 failure-escalation test (offline)\n\n');

// ------------------------------------------------------------ 1. envelope
process.stdout.write('1. failure envelope\n');

test('new failure types map to their classes', () => {
  assert.strictEqual(classOf(FAILURE.UNVERIFIED), CLASSES.UNVERIFIED);
  assert.strictEqual(classOf(FAILURE.KNOWLEDGE), CLASSES.KNOWLEDGE);
  assert.strictEqual(classOf(FAILURE.REFUSED), CLASSES.PERMISSION);
  assert.strictEqual(classOf(FAILURE.TIMEOUT), CLASSES.TRANSIENT);
  assert.strictEqual(classOf(FAILURE.NO_MATERIAL), CLASSES.PRECONDITION);
  assert.strictEqual(classOf(FAILURE.UNSUPPORTED), CLASSES.CAPABILITY);
  assert.strictEqual(classOf('whatever'), CLASSES.UNKNOWN);
});

test('envelope carries class policy + context; unknown is never retryable', () => {
  const out = envelope(
    { ok: false, failure: 'unverified', reason: 'no world effect' },
    { verb: 'place', target: 'immersive_aircraft:biplane', signature: 'place:immersive_aircraft:biplane', attempt: { count: 2, budget: 2 } }
  );
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.class, 'unverified');
  assert.strictEqual(out.retryable, false);
  assert.deepStrictEqual(out.requires, ['lookup_mod_content']);
  assert.strictEqual(out.next, 'lookup-then-ask-then-input');
  assert.strictEqual(out.signature, 'place:immersive_aircraft:biplane');
  assert.strictEqual(out.attempt.count, 2);

  const unknown = envelope({ ok: false, reason: 'something odd happened' });
  assert.strictEqual(unknown.class, 'unknown');
  assert.strictEqual(unknown.retryable, false, 'unclassified failures must not be retryable');
});

test('legacy fold() keeps the two-field shape for existing callers', () => {
  const out = fold({ ok: false, reason: 'no path to target' });
  assert.strictEqual(out.failure, 'no_path');
  assert.ok(out.hint);
  assert.strictEqual(out.class, undefined, 'fold() must not grow fields its callers do not expect');
});

// ---------------------------------------------------------- 2. signatures
process.stdout.write('\n2. signature ledger\n');

test('coordinate hops against the same item stay one signature', () => {
  const esc = new FailureEscalation({ log: silent, now: () => 1000 });
  const a = esc.parseCommand('place immersive_aircraft:biplane 15 65 71 up');
  const b = esc.parseCommand('place immersive_aircraft:biplane 18 65 70 up');
  assert.strictEqual(esc.signatureOf(a.verb, a.target, a.itemKey), esc.signatureOf(b.verb, b.target, b.itemKey));
  const c = esc.parseCommand('goto 18 65 70');
  assert.notStrictEqual(
    esc.signatureOf(a.verb, a.target, a.itemKey),
    esc.signatureOf(c.verb, c.target, c.itemKey),
    'a different verb is a different signature (granularity)'
  );
});

test('escalation is per action: a tilling failure never gates goto', () => {
  const esc = new FailureEscalation({ log: silent });
  esc.recordFailure({ verb: 'use_on', target: 'minecraft:wooden_hoe', itemKey: 'minecraft:wooden_hoe', className: 'knowledge' });
  esc.recordFailure({ verb: 'use_on', target: 'minecraft:wooden_hoe', itemKey: 'minecraft:wooden_hoe', className: 'knowledge' });
  const gated = esc.gate({ command: 'use_on 15 65 71 up minecraft:wooden_hoe', via: 'mc_step' });
  assert.strictEqual(gated.ok, false, 'the failed action is refused after the blind budget');
  const walk = esc.gate({ command: 'goto 20 65 71', via: 'mc_step' });
  assert.strictEqual(walk.ok, true, 'movement to the next plot keeps the command channel');
});

// --------------------------------------------------------------- 3. gates
process.stdout.write('\n3. hard gates\n');

test('third blind same-signature attempt is refused (precondition class)', () => {
  const esc = new FailureEscalation({ log: silent });
  for (let i = 0; i < 2; i += 1) {
    esc.recordFailure({ verb: 'craft', target: 'minecraft:stick', itemKey: 'minecraft:stick', className: 'precondition' });
  }
  const gated = esc.gate({ command: 'craft minecraft:stick 4', via: 'mc_step' });
  assert.strictEqual(gated.ok, false);
  assert.strictEqual(gated.error, 'escalation-required');
});

test('knowledge ladder: blind cap -> lookup-required -> informed retry -> ask-required', () => {
  let now = 1000;
  const esc = new FailureEscalation({ log: silent, now: () => now });
  const fail = () =>
    esc.recordFailure({ verb: 'place', target: 'immersive_aircraft:biplane', itemKey: 'immersive_aircraft:biplane', className: 'unverified' });

  fail();
  assert.strictEqual(esc.gate({ command: 'place immersive_aircraft:biplane 15 65 71 up', via: 'mc_step' }).ok, true, 'one blind retry is tolerated');
  fail();
  const refused = esc.gate({ command: 'place immersive_aircraft:biplane 20 65 70 up', via: 'mc_step' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.error, 'lookup-required', 'un-searched retry must demand the lookup');
  assert.ok(refused.lookupQuery && refused.lookupQuery.includes('immersive_aircraft'));

  esc.recordLookup('immersive_aircraft biplane 怎么放置');
  const informed = esc.gate({ command: 'place immersive_aircraft:biplane 20 65 70 up', via: 'mc_step' });
  assert.strictEqual(informed.ok, true, 'a recorded lookup re-arms one informed retry');

  fail(); // the informed retry fails too
  const ask = esc.gate({ command: 'place immersive_aircraft:biplane 21 65 70 up', via: 'mc_step' });
  assert.strictEqual(ask.ok, false);
  assert.strictEqual(ask.error, 'ask-required');
  assert.ok(ask.askQuestion, 'the refusal carries a concrete question');

  now += 11 * 60 * 1000; // past the lookup TTL: the search no longer informs
  const stale = esc.gate({ command: 'place immersive_aircraft:biplane 22 65 70 up', via: 'mc_step' });
  assert.strictEqual(stale.ok, false, 'a lookup older than the TTL does not count');
});

test('permission class is never auto-retried', () => {
  const esc = new FailureEscalation({ log: silent });
  esc.recordFailure({ verb: 'attack', target: 'Partner', itemKey: null, className: 'permission' });
  const gated = esc.gate({ command: 'attack Partner', via: 'mc_step' });
  assert.strictEqual(gated.ok, false);
  assert.strictEqual(gated.error, 'escalation-required');
});

test('parked question refuses body actions but whitelists stop/inputs; answer re-arms', () => {
  const esc = new FailureEscalation({ log: silent });
  esc.recordFailure({ verb: 'place', target: 'immersive_aircraft:biplane', itemKey: 'immersive_aircraft:biplane', className: 'unverified' });
  esc.recordFailure({ verb: 'place', target: 'immersive_aircraft:biplane', itemKey: 'immersive_aircraft:biplane', className: 'unverified' });
  esc.markAskParked('ask-1', 'did the plane appear?');
  assert.strictEqual(esc.waitingForAnswer(), true);
  const blocked = esc.gate({ command: 'place immersive_aircraft:biplane 15 65 71 up', via: 'mc_step' });
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.error, 'waiting-for-player-answer');
  assert.strictEqual(esc.gate({ command: 'stop', via: 'mc_step' }).ok, true, 'stop stays available');
  assert.strictEqual(esc.gate({ command: 'inputs', via: 'mc_step' }).ok, true, 'inputs stays available');
  esc.markAskResolved(true);
  assert.strictEqual(esc.waitingForAnswer(), false);
  const after = esc.gate({ command: 'place immersive_aircraft:biplane 15 65 71 up', via: 'mc_step' });
  assert.strictEqual(after.ok, true, 'an answer counts as new information and re-arms the retry');
  esc.recordFailure({ verb: 'place', target: 'immersive_aircraft:biplane', itemKey: 'immersive_aircraft:biplane', className: 'unverified' });
  const exhausted = esc.gate({ command: 'place immersive_aircraft:biplane 15 65 71 up', via: 'mc_step' });
  assert.strictEqual(exhausted.ok, false, 'an answer is not an unlimited retry budget');
  assert.strictEqual(exhausted.error, 'escalation-required');
});

// --------------------------------------------------------- 4. de-escalation
process.stdout.write('\n4. de-escalation\n');

test('success clears the signature; clearGoal wipes the slate', () => {
  const esc = new FailureEscalation({ log: silent });
  esc.recordFailure({ verb: 'place', target: 'immersive_aircraft:biplane', itemKey: 'immersive_aircraft:biplane', className: 'unverified' });
  esc.recordFailure({ verb: 'place', target: 'immersive_aircraft:biplane', itemKey: 'immersive_aircraft:biplane', className: 'unverified' });
  assert.strictEqual(esc.gate({ command: 'place immersive_aircraft:biplane 15 65 71 up', via: 'mc_step' }).ok, false);
  esc.recordSuccess({ verb: 'place', target: 'whatever', itemKey: 'immersive_aircraft:biplane' });
  assert.strictEqual(esc.gate({ command: 'place immersive_aircraft:biplane 15 65 71 up', via: 'mc_step' }).ok, true, 'success returns the action to capability-first');

  esc.recordFailure({ verb: 'place', target: 'x:y', itemKey: 'x:y', className: 'knowledge' });
  esc.markAskParked('ask-9', 'q');
  esc.clearGoal();
  assert.strictEqual(esc.waitingForAnswer(), false);
  assert.strictEqual(esc.status().signatures, 0, 'goal end clears the ledger');
  assert.strictEqual(esc.status().lastSettled, null, 'goal end clears the stale settle snapshot');
});

test('a sync success replaces the last failure snapshot instead of leaving it stale', () => {
  const esc = new FailureEscalation({ log: silent });
  esc.recordFailure({ verb: 'place', target: 'x:y', itemKey: 'x:y', className: 'unverified' });
  esc.foldReceipt('place x:y 1 64 1 up', { ok: false, failure: 'unverified', reason: 'no effect' });
  assert.strictEqual(esc.status().lastSettled.ok, false);
  esc.foldReceipt('place x:y 1 64 1 up', { ok: true });
  assert.strictEqual(esc.status().lastSettled.ok, true, 'success must not leave a stale failure in lastSettled');
});

// --------------------------------------------------------- 5. foldReceipt
process.stdout.write('\n5. mc_step receipt folding\n');

test('sync failure receipts carry the envelope; acks stay untouched; success clears', () => {
  const esc = new FailureEscalation({ log: silent });
  const refused = esc.foldReceipt('place immersive_aircraft:biplane 15 65 71 up', {
    ok: false, failure: 'unverified', reason: 'no world effect', lookupQuery: 'immersive_aircraft biplane 怎么放置 使用'
  });
  assert.strictEqual(refused.class, 'unverified');
  assert.strictEqual(refused.signature, 'place:immersive_aircraft:biplane');
  assert.deepStrictEqual(refused.requires, ['lookup_mod_content']);
  assert.strictEqual(esc.status().signatures, 1, 'the failure is recorded');

  const ack = esc.foldReceipt('goto 70 64 32', { ok: true, accepted: true, taskId: 'task-1' });
  assert.strictEqual(ack.accepted, true);
  assert.strictEqual(ack.class, undefined, 'a background ack is not an outcome');

  esc.foldReceipt('place immersive_aircraft:biplane 15 65 71 up', { ok: true });
  assert.strictEqual(esc.status().signatures, 0, 'a sync success clears the signature');
});

test('recordTaskSettle enriches failures and feeds lastSettled', () => {
  const esc = new FailureEscalation({ log: silent });
  const settled = esc.recordTaskSettle({ name: 'goto', ok: false, reason: 'noPath', description: 'walk to 31,63,59' });
  assert.strictEqual(settled.class, 'precondition');
  assert.strictEqual(esc.lastSettled.class, 'precondition');
  assert.strictEqual(esc.lastSettled.ok, false);
  esc.recordTaskSettle({ name: 'goto', ok: true, description: 'walk to 31,63,59' });
  assert.strictEqual(esc.status().signatures, 0);
  assert.strictEqual(esc.lastSettled.ok, true);
});

// ------------------------------------------------------ 6. place evidence
process.stdout.write('\n6. place evidence judging\n');

const TARGET = { x: 15, y: 65, z: 71 };
function receipt(beforeBlocks, afterBlocks, beforeCount, afterCount, beforeEntities, afterEntities) {
  return {
    ok: true,
    dispatched: true,
    consumesAction: true,
    evidence: {
      item: 'immersive_aircraft:biplane',
      before: { blocks: beforeBlocks, itemCount: beforeCount, entities: beforeEntities },
      after2: null,
      after12: { blocks: afterBlocks, itemCount: afterCount, entities: afterEntities },
      incomplete: false
    }
  };
}
const AIR = { '15,65,71': 'minecraft:air', '15,66,71': 'minecraft:air' };

test('a spawned matching entity counts as placed', () => {
  const judged = judgeEffect(
    receipt(AIR, AIR, 1, 0, [], [{ id: 9, type: 'immersive_aircraft:biplane' }]),
    { item: 'immersive_aircraft:biplane', target: TARGET }
  );
  assert.strictEqual(judged.ok, true);
  assert.strictEqual(judged.effect, 'entity');
});

test('a spawn egg matches its entity type instead of failing as consumed-only', () => {
  const judged = judgeEffect(
    receipt(AIR, AIR, 1, 0, [], [{ id: 10, type: 'minecraft:chicken' }]),
    { item: 'minecraft:chicken_spawn_egg', target: TARGET }
  );
  assert.strictEqual(judged.ok, true);
  assert.strictEqual(judged.effect, 'entity');
});

test('a block change (incl. neighbour cells) counts as placed', () => {
  const judged = judgeEffect(
    receipt(AIR, { ...AIR, '15,66,71': 'minecraft:oak_planks' }, 9, 8, [], []),
    { item: 'minecraft:oak_planks', target: TARGET }
  );
  assert.strictEqual(judged.ok, true);
});

test('an unrelated new entity does not fake a placement', () => {
  const judged = judgeEffect(
    receipt(AIR, AIR, 1, 1, [], [{ id: 9, type: 'minecraft:pig' }]),
    { item: 'immersive_aircraft:biplane', target: TARGET }
  );
  assert.strictEqual(judged.ok, false);
  assert.strictEqual(judged.code, 'place-unverified');
  assert.strictEqual(judged.failure, 'unverified');
  assert.ok(judged.lookupQuery.includes('immersive_aircraft'));
});

test('no effect at all is place-unverified, never a silent success', () => {
  const judged = judgeEffect(receipt(AIR, AIR, 1, 1, [], []), { item: 'immersive_aircraft:biplane', target: TARGET });
  assert.strictEqual(judged.ok, false);
  assert.strictEqual(judged.retryable, true);
  assert.deepStrictEqual(judged.requiresLookup, true);
  assert.strictEqual(judgeEffect({ ok: true }, { item: 'x', target: TARGET }), null, 'legacy receipts fall through to the caller');
});

test('consuming the item without a visible effect is unverified, not success', () => {
  const judged = judgeEffect(receipt(AIR, AIR, 1, 0, [], []), { item: 'immersive_aircraft:biplane', target: TARGET });
  assert.strictEqual(judged.ok, false);
  assert.strictEqual(judged.code, 'consumed-without-visible-effect');
  assert.strictEqual(judged.effect, 'none');
  assert.ok(judged.evidence.itemCountBefore === 1 && judged.evidence.itemCountAfter === 0);
  assert.ok(judged.lookupQuery.includes('immersive_aircraft'));
});

// ------------------------------------------------ 7. PlanRunner integration
process.stdout.write('\n7. PlanRunner gate\n');

test('a gated step fails the plan honestly with the escalation envelope', async () => {
  const esc = new FailureEscalation({ log: silent });
  esc.recordFailure({ verb: 'goto', target: '1 64 1', itemKey: null, className: 'precondition' });
  esc.recordFailure({ verb: 'goto', target: '1 64 1', itemKey: null, className: 'precondition' });
  const plans = new PlanStore();
  plans.applyDraft({
    planId: 'plan-gated',
    goal: 'walk twice',
    baseVersion: 0,
    steps: [
      { id: 's1', type: 'goto', args: { position: { x: 1, y: 64, z: 1 } }, status: 'pending' },
      { id: 's2', type: 'goto', args: { position: { x: 2, y: 64, z: 2 } }, status: 'pending' }
    ]
  });
  let ran = 0;
  const runner = new PlanRunner({
    plans,
    createTask: () => ({ async run() { return { ok: true }; }, cancel() {} }),
    runTask: async (task) => {
      ran += 1;
      return task.run();
    },
    escalation: esc,
    log: silent
  });
  const result = await runner.run('plan-gated');
  assert.strictEqual(result.ok, false, 'the plan must not pretend success');
  assert.strictEqual(ran, 0, 'the gated step is never dispatched');
  const failed = result.results.find((step) => step.status === 'failed');
  assert.ok(failed && failed.gated === true, 'the step carries the gate verdict');
  assert.strictEqual(failed.escalation.error, 'escalation-required');
});

test('wait_for_player steps are never gated (ask plan must park)', async () => {
  const esc = new FailureEscalation({ log: silent });
  esc.markAskParked('ask-1', 'q');
  const plans = new PlanStore();
  plans.applyDraft({
    planId: 'plan-ask',
    goal: 'ask',
    baseVersion: 0,
    steps: [{ id: 'ask', type: 'wait_for_player', question: 'q?', status: 'pending' }]
  });
  const runner = new PlanRunner({
    plans,
    createTask: () => ({ async run() { return { ok: true }; }, cancel() {} }),
    runTask: async (task) => task.run(),
    escalation: esc,
    log: silent
  });
  const result = await runner.run('plan-ask');
  assert.ok(result.waiting, 'the question step parks instead of being gated');
});

// ------------------------------------------------------ 8. prompt contracts
process.stdout.write('\n8. prompt + capability text\n');

test('taskGoal texts carry the ladder, granularity and realtime rules', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'taskGoal.js'), 'utf8');
  for (const needle of [
    'knowledge/unverified',
    'lookup_mod_content',
    'mc_ask_player',
    '同一签名第三次盲试会被 Node 拒绝',
    '升级是按动作的，不是按任务的',
    '走去下一片田仍用 goto',
    'ms 级连续控制',
    'mounted=true',
    'ctx.state() + ctx.key/ctx.hold/ctx.tap'
  ]) {
    assert.ok(src.includes(needle), `taskGoal.js missing: ${needle}`);
  }
});

test('plugin carries mc_ask_player, the via marker and the new goal prompt', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'dsh-plugin-mc-harness', 'lib', 'index.js'), 'utf8');
  for (const needle of [
    "name: 'mc_ask_player'",
    "via: 'mc_step'",
    'askPlayer',
    'lookup-required',
    'never a task-level mode',
    'ms-level continuous control',
    'mc_ask_player /'
  ]) {
    assert.ok(src.includes(needle), `plugin missing: ${needle}`);
  }
});

test('mc_capabilities exposes the failure policy from the same source of truth', () => {
  const { describe } = require('../src/core/channelPolicy');
  const table = describe({ codeSkills: null, failureEscalation: null });
  assert.ok(table.failurePolicy, 'failurePolicy section present');
  assert.ok(table.failurePolicy.classes.includes('unverified'));
  assert.ok(table.failurePolicy.classes.includes('knowledge'));
  assert.ok(table.failurePolicy.realtimeControl.includes('ms-level'));
  assert.ok(table.failurePolicy.granularity.includes('per action signature'));
  assert.ok(table.escalation.rule.includes('lookup_mod_content'));
  assert.ok(table.escalation.rule.includes('mc_ask_player'));
});

test('the generation prompt teaches the realtime loop pattern', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'codeSkills', 'generation.js'), 'utf8');
  assert.ok(src.includes('Real-time control loops'), 'generation prompt mentions realtime loops');
  assert.ok(src.includes('ctx.wait(ms)'), 'generation prompt teaches ctx.wait pacing');
});

// ------------------------------------------------------------------- runner
(async () => {
  for (const [name, fn] of queue) {
    try {
      await fn();
      results.push({ name, ok: true });
      process.stdout.write(`  PASS  ${name}\n`);
    } catch (err) {
      results.push({ name, ok: false, detail: err.message });
      process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
    }
  }
  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exit(failed.length ? 1 : 0);
})();
