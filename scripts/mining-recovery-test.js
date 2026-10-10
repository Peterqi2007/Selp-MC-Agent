'use strict';

/**
 * `npm run mining:recovery:test` - the R-series acceptance for the LLM mining recovery
 * (docs/MINING-LLM-PLAN.md §6.5). No paid model, no game: the real monitor, session and
 * executors run against a scripted transport and a constrained fake body.
 */

const assert = require('assert');
const { MiningProgressMonitor } = require('../src/core/miningProgress');
const { MiningRecoverySession, runMiningRecovery, DEFAULT_CFG } = require('../src/skills/miningRecovery');
const { validateBatch, createRecoveryTools } = require('../src/llm/miningRecoveryTools');
const registry = require('../src/llm/tools/registry');

let failures = 0;
let checks = 0;
async function check(name, fn) {
  checks += 1;
  try {
    const note = await fn();
    process.stdout.write(`  PASS  ${name}${note ? ` - ${note}` : ''}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
  }
}

/** A minimal, honest fake body the session can drive. */
function makeEnv({ model, cfg = {}, goal: goalPatch = {}, verified = false, mined = false } = {}) {
  const state = {
    feet: { x: 0, y: 64, z: 0 },
    cells: new Map([['1,64,0', 'minecraft:stone'], ['0,66,0', 'minecraft:stone']]),
    inventory: { 'minecraft:diamond': verified ? 1 : 0 },
    digs: [],
    moves: [],
    pillars: 0,
    collects: 0,
    places: 0,
    quiesced: true,
    calls: 0,
    maxActionsSeen: [],
    revision: 0
  };
  const goal = {
    goalId: 'g1',
    target: { blockId: 'diamond_ore', position: { x: 2, y: 64, z: 0 } },
    status: verified ? 'verified' : mined ? 'pending' : 'prepared',
    mined: { confirmed: !!mined || !!verified },
    pendingDrops: [],
    collectedItems: verified ? 1 : 0,
    acceptedProducts: ['diamond'],
    ...goalPatch
  };
  const snapshot = () => ({
    ready: true,
    onGround: true,
    position: { ...state.feet },
    heldItem: 'minecraft:cobblestone',
    emptySlots: 10,
    inventory: Object.fromEntries(Object.entries(state.inventory).filter(([, count]) => count > 0)),
    nearbyItems: goal.pendingDrops.map((d, i) => ({ id: `p${i}`, name: d.name, count: d.count, position: d.position, distance: 1 })),
    blocks: { cells: Object.fromEntries(state.cells) }
  });
  const io = {
    quiesced: async () => state.quiesced,
    stable: async () => true,
    refresh: async () => snapshot(),
    feetOf: (snap) => (snap && snap.position ? { ...state.feet } : null),
    read: (snap, cell) => (state.cells.get(`${cell.x},${cell.y},${cell.z}`) || 'minecraft:air').replace(/^[a-z0-9_]+:/, ''),
    passable: (name) => /air$/.test(name),
    protectedName: (name) => /_ore$/.test(name),
    digCell: async (cell) => {
      state.digs.push({ ...cell });
      state.cells.delete(`${cell.x},${cell.y},${cell.z}`);
      state.revision += 1;
      return { ok: true };
    },
    takeTarget: async () => {
      if (goal.mined.confirmed) return { ok: false, failure: 'repeat_rejected', reason: 'already mined' };
      goal.mined.confirmed = true;
      goal.status = 'pending';
      state.cells.delete('2,64,0');
      goal.pendingDrops = [{ name: 'diamond', count: 1, position: { x: 2, y: 64, z: 0 } }];
      state.revision += 1;
      return { ok: true, dug: true };
    },
    pillarOne: async () => {
      state.pillars += 1;
      state.revision += 1;
      return { ok: true, steps: 1 };
    },
    moveLocal: async (stand) => {
      state.moves.push({ ...stand });
      state.feet = { ...stand };
      state.revision += 1;
      return { ok: true, position: { ...stand } };
    },
    placeBlock: async () => {
      state.places += 1;
      state.revision += 1;
      return { ok: true };
    },
    pickScaffold: () => 'minecraft:cobblestone',
    canAccept: () => true,
    acquisitionState: () => ({
      mined: goal.mined.confirmed,
      verified: goal.status === 'verified',
      collectedItems: goal.collectedItems,
      pendingDrops: goal.pendingDrops.length,
      pendingDropsList: goal.pendingDrops
    }),
    collectOnce: async () => {
      state.collects += 1;
      if (!goal.mined.confirmed) return { outcome: 'unknown', failure: 'internal', reason: 'nothing mined' };
      goal.status = 'verified';
      goal.collectedItems += 1;
      state.inventory['minecraft:diamond'] = (state.inventory['minecraft:diamond'] || 0) + 1;
      goal.pendingDrops = [];
      state.revision += 1;
      return { outcome: 'verified', collectedDelta: 1, pendingDrops: [] };
    },
    inspectSlice: async (slice) => {
      state.inspectCalls = (state.inspectCalls || 0) + 1;
      const out = [];
      for (let x = slice.center.x - slice.radiusXZ; x <= slice.center.x + slice.radiusXZ; x += 1) {
        for (let y = slice.yMin; y <= slice.yMax; y += 1) {
          const cell = { x, y, z: slice.center.z };
          out.push({ ...cell, name: io.read(snapshot(), cell) });
        }
      }
      return out;
    },
    relevantCells: async () => [{ ...goal.target.position, name: io.read(snapshot(), goal.target.position) }],
    fingerprint: () => `${state.feet.x},${state.feet.y},${state.feet.z}|${state.revision}|${goal.mined.confirmed}|${goal.status}`
  };
  const monitor = new MiningProgressMonitor({});
  const signal = {
    cancelled: false,
    reason: null,
    _subs: [],
    subscribe(fn) {
      this._subs.push(fn);
      return () => {};
    },
    cancel(reason) {
      this.cancelled = true;
      this.reason = reason || 'cancelled';
      for (const fn of this._subs.splice(0)) fn(this.reason);
    }
  };
  const llm = model === null
    ? null
    : {
        complete: async (request) => {
          state.calls += 1;
          const user = request.messages[0].content;
          const recoveryId = (user.match(/recoveryId=(\S+)/) || [])[1];
          const goalId = (user.match(/goalId=(\S+)/) || [])[1];
          const revision = Number((user.match(/basedOnRevision=(\d+)/) || [])[1]) || 0;
          const maxActions = Number((user.match(/up to (\d+) base action/) || [])[1]) || 1;
          state.maxActionsSeen.push(maxActions);
          const next = typeof model === 'function'
            ? model({ recoveryId, goalId, revision, maxActions, user, call: state.calls })
            : model;
          return typeof next === 'string' ? { ok: true, text: next, usage: { total_tokens: 40 } } : next;
        }
      };
  const session = new MiningRecoverySession({
    ctx: { taskId: 't1' },
    io,
    goal,
    signal,
    cfg: { ...DEFAULT_CFG, enabled: true, ...cfg },
    llm,
    monitor,
    trigger: 'same_failure',
    triggerReason: 'fixture'
  });
  return { state, goal, io, monitor, signal, session };
}

function stop(recoveryId, goalId, revision, reason = 'nothing left') {
  return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"stop","reason":"${reason}"}`;
}

async function main() {
  process.stdout.write('minecraft-survival-agent - mining recovery test (offline, R-series)\n\n');

  process.stdout.write('1. progress monitor triggers (R02-R05)\n');
  await check('R02: two identical failures trigger same_failure; progress resets it', () => {
    const monitor = new MiningProgressMonitor({ now: () => 1000 });
    monitor.record({ goalId: 'g', phase: 'clear', action: 'dig', ok: false, cellKey: '1,65,0', fingerprint: 'fp', elapsedMs: 100 });
    monitor.record({ goalId: 'g', phase: 'clear', action: 'dig', ok: false, cellKey: '1,65,0', fingerprint: 'fp', elapsedMs: 100 });
    assert.strictEqual(monitor.evaluate().trigger, 'same_failure');
    monitor.record({ ok: true, progress: true, fingerprint: 'fp2', elapsedMs: 100 });
    assert.strictEqual(monitor.evaluate(), null);
    return 'trigger then reset';
  });
  await check('R03: an A/B/A/B stand cycle reports position_cycle, not a generic failure', () => {
    const monitor = new MiningProgressMonitor({ now: () => 1000 });
    for (const fp of ['a', 'b', 'a', 'b']) monitor.record({ ok: false, fingerprint: fp, elapsedMs: 10 });
    assert.strictEqual(monitor.evaluate().trigger, 'position_cycle');
    return 'cycle detected';
  });
  await check('R04: three false arrivals trigger false_arrival', () => {
    const monitor = new MiningProgressMonitor({ now: () => 1000 });
    for (let i = 0; i < 3; i += 1) {
      monitor.record({ ok: false, arrived: true, moved: 0.02, fingerprint: `f${i}`, elapsedMs: 50 });
    }
    assert.strictEqual(monitor.evaluate().trigger, 'false_arrival');
    return '3 zero-move arrivals';
  });
  await check('R05: no_progress needs 3 attempts AND the active window; waiting time does not count', () => {
    let t = 1000;
    const monitor = new MiningProgressMonitor({ now: () => t, config: { miningRecovery: { noProgressActiveMs: 30000 } } });
    monitor.record({ ok: false, fingerprint: 'x', elapsedMs: 1000 });
    monitor.record({ ok: false, fingerprint: 'y', elapsedMs: 1000 });
    monitor.record({ ok: false, fingerprint: 'z', elapsedMs: 1000 });
    t += 29000;
    const early = monitor.evaluate();
    assert(!early || early.trigger !== 'no_progress', '29s must not trip it');
    monitor.record({ waiting: true, elapsedMs: 60000, fingerprint: 'z2' });
    t += 2000;
    assert.strictEqual(monitor.evaluate().trigger, 'no_progress');
    return 'threshold exact, wait excluded';
  });

  process.stdout.write('\n2. session lifecycle (R01/R10/R13/R14)\n');
  await check('R01: an already-verified goal recovers with zero model calls', async () => {
    const env = makeEnv({ model: () => stop('x', 'x', 0), verified: true });
    const result = await runMiningRecovery(env.session);
    assert.strictEqual(result.outcome, 'recovered');
    assert.strictEqual(env.state.calls, 0);
    return 'no call needed';
  });
  await check('R10: multi-batch until the product is really in the bag', async () => {
    const script = ({ recoveryId, goalId, revision, call }) => {
      if (call === 1) {
        return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"s1","tool":"dig_cells","args":{"cells":[{"x":1,"y":64,"z":0}]},"purpose":"clear_next_jump","expected":{"type":"cells_passable"}}]}`;
      }
      if (call === 2) {
        return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"s2","tool":"mine_block","args":{"goalId":"${goalId}"},"purpose":"mine_target","expected":{"type":"target_mined"}}]}`;
      }
      return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"s3","tool":"collect_target","args":{"goalId":"${goalId}"},"purpose":"collect_target","expected":{"type":"acquisition_checked"}}]}`;
    };
    const env = makeEnv({ model: script });
    const result = await runMiningRecovery(env.session);
    assert.strictEqual(result.outcome, 'recovered', `outcome=${result.outcome} reason=${result.reason}`);
    assert(env.state.calls >= 3, `calls=${env.state.calls}`);
    assert.strictEqual(env.state.digs.length, 1);
    assert(env.goal.status === 'verified', 'success must come from acquisition evidence');
    return `calls=${env.state.calls}, verified via evidence`;
  });
  await check('R12-lite: a dig alone does not end the session (milestone needs the product)', async () => {
    let call = 0;
    const env = makeEnv({
      model: ({ recoveryId, goalId, revision }) => {
        call += 1;
        if (call === 1) {
          return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"s1","tool":"mine_block","args":{"goalId":"${goalId}"},"purpose":"mine_target"}]}`;
        }
        return stop(recoveryId, goalId, revision, 'stopping after the dig');
      }
    });
    const result = await runMiningRecovery(env.session);
    assert(env.goal.mined.confirmed === true, 'the dig happened');
    assert.notStrictEqual(result.outcome, 'recovered', 'a confirmed dig without pickup must not be recovered');
    assert.strictEqual(call, 2, 'the session continued after the dig');
    return `outcome=${result.outcome}`;
  });
  await check('R13: the batch-size budget escalates 1 -> 2 -> 3 only after clean batches', async () => {
    let call = 0;
    const env = makeEnv({
      model: ({ recoveryId, goalId, revision }) => {
        call += 1;
        if (call >= 4) return stop(recoveryId, goalId, revision, 'enough');
        return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"s${call}","tool":"dig_cells","args":{"cells":[{"x":1,"y":64,"z":0}]},"purpose":"clear_next_jump","expected":{"type":"cells_passable"}}]}`;
      }
    });
    await runMiningRecovery(env.session);
    assert.deepStrictEqual(env.state.maxActionsSeen.slice(0, 3), [1, 2, 3], `saw ${env.state.maxActionsSeen.join(',')}`);
    return 'maxActions 1,2,3';
  });
  await check('R14: a mid-batch failure truncates the rest and is reported to the next round', async () => {
    let call = 0;
    const env = makeEnv({
      model: ({ recoveryId, goalId, revision }) => {
        call += 1;
        if (call === 1) {
          return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"a","tool":"dig_cells","args":{"cells":[{"x":1,"y":64,"z":0}]},"purpose":"clear_next_jump"}]}`;
        }
        if (call === 2) {
          return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"b","tool":"dig_cells","args":{"cells":[{"x":6,"y":64,"z":0}]},"purpose":"clear_next_jump"},{"id":"c","tool":"dig_cells","args":{"cells":[{"x":5,"y":64,"z":0}]},"purpose":"clear_next_jump"}]}`;
        }
        return stop(recoveryId, goalId, revision, 'done');
      }
    });
    env.state.cells.set('6,64,0', 'minecraft:stone');
    env.state.cells.set('5,64,0', 'minecraft:stone');
    const originalDig = env.io.digCell;
    env.io.digCell = async (cell) => {
      if (cell.x === 5) return { ok: false, failure: 'occluded', reason: 'still solid' };
      return originalDig(cell);
    };
    await runMiningRecovery(env.session);
    assert.strictEqual(call, 3, 'the round after the failure must carry the receipt');
    assert(env.state.digs.some((c) => c.x === 6), 'the first step of the batch must have run');
    assert(!env.state.digs.some((c) => c.x === 5), 'the failing cell must not have been dug');
    assert(/occluded/.test(JSON.stringify(env.session.receipts)), 'the failure receipt must be kept');
    return 'truncated after the failing cell';
  });

  process.stdout.write('\n3. guards and degradation (R16-R28)\n');
  await check('R16: invalid JSON gets one repair, then the session fails honestly', async () => {
    const env = makeEnv({
      model: ({ call }) => (call === 1 ? 'this is not json' : 'still not json')
    });
    const result = await runMiningRecovery(env.session);
    assert.strictEqual(result.outcome, 'failed');
    assert(/invalid recovery response/.test(String(result.reason)), result.reason);
    assert.strictEqual(env.state.calls, 2, `calls=${env.state.calls} (one repair at most)`);
    return 'one repair, then failure';
  });
  await check('R17: an identical failing proposal is refused after its first execution', async () => {
    const env = makeEnv({
      cfg: { maxRepeatedProposals: 2 },
      model: ({ recoveryId, goalId, revision }) =>
        `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"same","tool":"dig_cells","args":{"cells":[{"x":5,"y":64,"z":0}]},"purpose":"clear_next_jump"}]}`
    });
    env.state.cells.set('5,64,0', 'minecraft:stone');
    const originalDig = env.io.digCell;
    env.io.digCell = async (cell) => (cell.x === 5 ? { ok: false, failure: 'occluded', reason: 'still solid' } : originalDig(cell));
    const result = await runMiningRecovery(env.session);
    assert.strictEqual(result.outcome, 'failed');
    assert.strictEqual(result.failure, 'no_valid_recovery');
    assert.strictEqual(env.state.calls, 3, `calls=${env.state.calls}`);
    assert(
      env.session.receipts.filter((r) => r.kind === 'batch-rejected').length >= 1,
      'the repeat must be recorded as rejected'
    );
    return 'executed once, refused twice, exited no_valid_recovery';
  });
  await check('R18: a replayed step id is refused and never re-dig', async () => {
    const env = makeEnv({
      model: ({ recoveryId, goalId, revision, call }) => {
        if (call >= 3) return stop(recoveryId, goalId, revision, 'done');
        const x = call === 1 ? 6 : 7;
        return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"fixed-id","tool":"dig_cells","args":{"cells":[{"x":${x},"y":64,"z":0}]},"purpose":"clear_next_jump"}]}`;
      }
    });
    env.state.cells.set('6,64,0', 'minecraft:stone');
    env.state.cells.set('7,64,0', 'minecraft:stone');
    await runMiningRecovery(env.session);
    assert(env.state.digs.some((c) => c.x === 6), 'the first use of the id runs');
    assert(!env.state.digs.some((c) => c.x === 7), 'the replay must not run');
    assert(/repeat_rejected/.test(JSON.stringify(env.session.receipts)), 'the replay is reported as repeat_rejected');
    return 'replay refused before any world touch';
  });
  await check('R20: a stop during the model wait cancels immediately and runs nothing', async () => {
    const env = makeEnv({ model: null });
    env.session.llm = {
      complete: (request) =>
        new Promise((resolve) => {
          request.signal.addEventListener('abort', () => resolve({ ok: false, reason: 'cancelled' }));
        })
    };
    const run = runMiningRecovery(env.session);
    setTimeout(() => env.signal.cancel('operator stop'), 10);
    const result = await run;
    assert.strictEqual(result.outcome, 'cancelled');
    assert.strictEqual(env.state.digs.length + env.state.moves.length, 0, 'no side effects after cancellation');
    return 'cancelled during the wait';
  });
  await check('R21: the primitive-action budget stops further steps without losing receipts', async () => {
    const env = makeEnv({
      cfg: { maxPrimitiveActions: 1 },
      model: ({ recoveryId, goalId, revision, call }) => {
        if (call >= 3) return stop(recoveryId, goalId, revision, 'done');
        const x = call === 1 ? 6 : 7;
        return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"s${call}","tool":"dig_cells","args":{"cells":[{"x":${x},"y":64,"z":0}]},"purpose":"clear_next_jump"}]}`;
      }
    });
    env.state.cells.set('6,64,0', 'minecraft:stone');
    env.state.cells.set('7,64,0', 'minecraft:stone');
    await runMiningRecovery(env.session);
    assert.strictEqual(env.state.digs.length, 1, `digs=${env.state.digs.length}`);
    assert(/budget/.test(JSON.stringify(env.session.receipts)), 'the budget refusal is recorded');
    return 'one action spent, the next refused';
  });
  await check('R22: no model client means recovery_unavailable, not a regex fallback', async () => {
    const env = makeEnv({ model: null });
    const result = await runMiningRecovery(env.session);
    assert.strictEqual(result.outcome, 'failed');
    assert(/recovery_unavailable/.test(String(result.reason)), result.reason);
    return result.reason;
  });
  await check('R23: inspect is read-only, bounded and repeatable without raising the revision', async () => {
    const env = makeEnv({
      model: ({ recoveryId, goalId, revision, call }) => {
        if (call >= 2) return stop(recoveryId, goalId, revision, 'seen enough');
        return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"inspect","inspect":{"center":{"x":1,"y":64,"z":0},"radiusXZ":2,"yMin":63,"yMax":66}}`;
      }
    });
    const result = await runMiningRecovery(env.session);
    assert.strictEqual(result.outcome, 'blocked');
    assert.strictEqual(env.state.inspectCalls, 1);
    assert.strictEqual(env.session.revision, 0, 'inspect must not count as a world change');
    return 'inspect used, revision untouched';
  });
  await check('R27: unknown tools and target-digging through dig_cells are refused before acting', async () => {
    const env = makeEnv({
      model: ({ recoveryId, goalId, revision, call }) => {
        if (call === 1) {
          return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"x","tool":"launch_missile","args":{}}]}`;
        }
        if (call === 2) {
          return `{"recoveryId":"${recoveryId}","goalId":"${goalId}","basedOnRevision":${revision},"decision":"execute","steps":[{"id":"y","tool":"dig_cells","args":{"cells":[{"x":2,"y":64,"z":0}]},"purpose":"clear_next_jump"}]}`;
        }
        return stop(recoveryId, goalId, revision, 'done');
      }
    });
    await runMiningRecovery(env.session);
    assert.strictEqual(env.state.digs.length, 0, 'nothing may be dug');
    assert(/mine_block/.test(JSON.stringify(env.session.receipts)), 'the locked-target refusal names mine_block');
    return 'unknown tool + locked target both refused';
  });
  await check('R28: the recovery tools are unreachable without a session; the public 8 tools are untouched', () => {
    const tools = createRecoveryTools(null);
    return tools.call('dig_cells', { cells: [{ x: 0, y: 64, z: 0 }] }).then((result) => {
      assert.strictEqual(result.ok, false);
      assert(/no active recovery context/.test(result.reason), result.reason);
      const publicNames = registry.toolNames();
      assert.strictEqual(publicNames.length, 8, `public tools=${publicNames.join(',')}`);
      for (const name of ['mine_block', 'dig_cells', 'pillar_up', 'collect_target']) {
        assert(!publicNames.includes(name), `${name} leaked into the public catalogue`);
      }
      return 'context required; public registry unchanged';
    });
  });

  process.stdout.write(`\n(checks so far: ${checks})\n`);
}

main()
  .then(() => {
    process.stdout.write(`\n${failures ? 'FAIL' : 'OK'} - mining recovery test: ${checks - failures}/${checks} checks\n`);
    process.exit(failures ? 1 : 0);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('mining recovery test crashed:', err.stack || err.message);
    process.exit(1);
  });

module.exports = { makeEnv, stop };
