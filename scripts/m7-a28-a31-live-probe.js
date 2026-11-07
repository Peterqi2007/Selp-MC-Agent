'use strict';

/**
 * `node scripts/m7-a28-a31-live-probe.js` - A28/A31 against the live agent.
 *
 * A28: create a real TurnService turn, park it on a real plan whose step runs 15s
 * (`agent.slow_wait`), then manufacture the awkward events through the same entry point a
 * real completion uses (`/harness/inject` -> TurnService.onPlanEvent):
 *   - a non-resumable step event is ignored;
 *   - the real terminal event wakes the turn exactly once (counted on the turn SSE ring);
 *   - a duplicate terminal event is `already-resumable` (no second wake);
 *   - a late terminal after `finish` is `no-turn-for-plan`.
 * A second turn/plan is cancelled and then receives a late `plan:completed`.
 *
 * A31: two turn events with the same eventId must enter the ring once (double emitter).
 *
 * Requires `P1_TEST_HOOKS=on`; no model and no body action beyond the promoted code skill.
 * Evidence: runtime/evidence/m7-20261107-gate/a28-a31.json
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);
const BASE = 'http://127.0.0.1:8766';
const OUT = path.join(ROOT, 'runtime', 'evidence', 'm7-20261107-gate', 'a28-a31.json');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function json(pathname, options = {}) {
  const res = await fetch(BASE + pathname, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    signal: AbortSignal.timeout(options.timeout || 30000)
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, ok: res.ok, body };
}
const post = (pathname, body, timeout) => json(pathname, { method: 'POST', body: JSON.stringify(body || {}), timeout });
const get = (pathname) => json(pathname);

/** Collect SSE events (id/event/data) for `durationMs`; closes the stream afterwards. */
function collectSse(pathname, durationMs) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get(BASE + pathname, (res) => {
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const entry = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) entry.id = line.slice(4);
            else if (line.startsWith('event: ')) entry.event = line.slice(7);
            else if (line.startsWith('data: ')) {
              entry.data = line.slice(6);
              try { entry.json = JSON.parse(entry.data); } catch { /* keep raw */ }
            }
          }
          if (entry.event) events.push(entry);
        }
      });
    });
    req.on('error', () => {});
    setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } resolve(events); }, durationMs);
  });
}

async function waitPlan(planId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get('/plan');
    const plan = (res.body.plans || []).find((p) => p.planId === planId);
    if (plan && ['completed', 'failed', 'cancelled', 'partial'].includes(plan.state)) return plan;
    await sleep(500);
  }
  return null;
}

(async () => {
  const out = { at: new Date().toISOString(), a28: {}, a31: {}, checks: [] };
  const check = (id, ok, detail) => {
    out.checks.push({ id, ok: ok === true, detail });
    process.stdout.write(`  ${ok === true ? 'PASS' : 'FAIL'} ${id} :: ${JSON.stringify(detail).slice(0, 260)}\n`);
  };

  const hooks = await get('/harness/inject');
  if (!hooks.ok) {
    process.stderr.write('test hooks are off (start the agent with P1_TEST_HOOKS=on)\n');
    process.exitCode = 1;
    return;
  }

  // ------------------------------------------------------------ A28 main turn
  const planId = `m7-a28-${Date.now()}`;
  const turnRes = await post('/harness/turn', { planId });
  const turnId = turnRes.body && turnRes.body.turn && turnRes.body.turn.id;
  if (!turnId) {
    process.stderr.write(`could not begin a turn: ${JSON.stringify(turnRes.body)}\n`);
    process.exitCode = 1;
    return;
  }
  out.a28.turnId = turnId;
  out.a28.planId = planId;

  const sse = collectSse('/harness/events', 45000);
  const planRes = await post('/plan', {
    planId,
    goal: 'A28: long step then event injection',
    steps: [{ id: 's1', type: 'code_skill', args: { name: 'agent.slow_wait', params: {} } }]
  });
  const parked = await post(`/harness/turn/${turnId}/wait`, { planId });
  out.a28.planAccepted = planRes.status;
  out.a28.parked = parked.body;

  // A non-resumable plan event must not wake the turn.
  const stepEvent = await post('/harness/inject', { kind: 'plan', planId, type: 'plan:step:completed', stepId: 's1' });
  check('A28 non-resumable step event is ignored', stepEvent.body && stepEvent.body.outcome && stepEvent.body.outcome.ignored === true, stepEvent.body && stepEvent.body.outcome);

  const started = Date.now();
  const plan = await waitPlan(planId, 60000);
  out.a28.planDurationMs = Date.now() - started;
  out.a28.planState = plan && plan.state;
  check('A28 real long step settles', plan && ['completed', 'failed', 'partial'].includes(plan.state), { state: plan && plan.state, durationMs: out.a28.planDurationMs });

  // Duplicate terminal while the turn is still parked/resumable.
  const dup = await post('/harness/inject', { kind: 'plan', planId, type: 'plan:completed' });
  out.a28.duplicate = dup.body;
  const dupReason = dup.body && (dup.body.outcome ? dup.body.outcome.reason : dup.body.reason);
  /** `already-resumable` and `turn-running` both mean "this terminal did not wake again". */
  check('A28 duplicate terminal does not wake twice', dupReason === 'already-resumable' || dupReason === 'turn-running', dup.body);

  const finished = await post(`/harness/turn/${turnId}/finish`, {});
  out.a28.finished = finished.body;

  // Late terminal after the turn is finished.
  const late = await post('/harness/inject', { kind: 'plan', planId, type: 'plan:completed' });
  out.a28.late = late.body;
  check('A28 late terminal is dropped (no-turn-for-plan)', late.body && (late.body.reason === 'no-turn-for-plan' || (late.body.outcome && late.body.outcome.reason === 'no-turn-for-plan')), late.body);

  const events = await sse;
  const resumable = events.filter((e) => e.event === 'turn:resumable' && e.json && e.json.turnId === turnId);
  out.a28.turnResumableCount = resumable.length;
  out.a28.turnEventTypes = events.filter((e) => e.json && e.json.turnId === turnId).map((e) => e.event);
  check('A28 exactly one turn:resumable for the turn', resumable.length === 1, { count: resumable.length, types: out.a28.turnEventTypes });

  // ------------------------------------------------------------ A28 cancel path
  const planId2 = `m7-a28c-${Date.now()}`;
  const turn2 = await post('/harness/turn', { planId: planId2 });
  const turnId2 = turn2.body && turn2.body.turn && turn2.body.turn.id;
  await post('/plan', {
    planId: planId2,
    goal: 'A28 cancel path',
    steps: [{ id: 's1', type: 'code_skill', args: { name: 'agent.slow_wait', params: {} } }]
  });
  await post(`/harness/turn/${turnId2}/wait`, { planId: planId2 });
  await sleep(1200);
  const cancelRes = await post(`/plan/${encodeURIComponent(planId2)}/cancel`, { reason: 'a28-probe' });
  out.a28.cancel = cancelRes.body;
  await sleep(300);
  const lateCancel = await post('/harness/inject', { kind: 'plan', planId: planId2, type: 'plan:completed' });
  out.a28.lateAfterCancel = lateCancel.body;
  const turn2State = await get(`/harness/turn/${turnId2}`);
  out.a28.cancelTurnState = turn2State.body && turn2State.body.turn && turn2State.body.turn.state;
  check('A28 cancel wins and late completion is dropped',
    (lateCancel.body && (lateCancel.body.reason === 'no-turn-for-plan' || (lateCancel.body.outcome && lateCancel.body.outcome.reason === 'no-turn-for-plan'))) ||
      out.a28.cancelTurnState === 'cancelled',
    { late: lateCancel.body, turnState: out.a28.cancelTurnState });

  // ------------------------------------------------------------ A31 double emitter
  const before = await get('/harness/turns');
  const beforeSize = before.body.events && before.body.events.size;
  const eventId = `m7-dup-${Date.now()}`;
  const one = await post('/harness/inject', { kind: 'turn', turnId, type: 'task:done', eventId });
  const two = await post('/harness/inject', { kind: 'turn', turnId, type: 'task:done', eventId });
  const after = await get('/harness/turns');
  const afterSize = after.body.events && after.body.events.size;
  out.a31 = { beforeSize, afterSize, eventId, one: one.body, two: two.body };
  check('A31 duplicate eventId enters the ring once', afterSize === beforeSize + 1, { beforeSize, afterSize });

  fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
  const failed = out.checks.filter((c) => !c.ok);
  process.stdout.write(`\nA28/A31: ${out.checks.length - failed.length}/${out.checks.length} checks passed; evidence ${path.relative(ROOT, OUT)}\n`);
  if (failed.length) process.exitCode = 1;
})().catch((err) => {
  process.stderr.write(`A28/A31 probe crashed: ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
