'use strict';

/**
 * `npm run mining:entry:test` - the A-series acceptance for the unified mining entry
 * (docs/MINING-LLM-PLAN.md §6.1).
 *
 * What this proves offline:
 *   - A1: `!mine`, the panel/HTTP form (same command table), `do_task mine`, `do_skill
 *     mine_ore`, the fallback-router Chinese form and the direct skill boundary all reach
 *     the same executor with the same normalized targets and count, exactly once;
 *   - A2: `!goal`, the CLI `--goal` path and the autonomous adapter pick the ore executor,
 *     a generic 挖 does not steal a specific mineral, and the adapter runs without
 *     submitting a second TaskHub job;
 *   - A3/A4: deepslate variants resolve correctly both ways, multi-target arrays keep
 *     order and de-duplicate, nether names get no invented twin;
 *   - A5: mixed ore/material, invalid counts and unknown targets are refused with zero
 *     world actions and zero task replacements;
 *   - A6: stone/dirt/sand keep the old material task;
 *   - A7 (partial): the ore count is mined-blocks, not drops and not count+2;
 *   - A8/A9 (partial): acceptance is async, replacement is single-owner, an invalid
 *     replacement leaves the legal task alone, and stop leaves no further actions.
 */

const assert = require('assert');
const { loadConfig } = require('../src/util/config');
const { MockBody } = require('../src/body/mockBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const { Brain } = require('../src/brain');
const { TaskHub } = require('../src/core/taskHub');
const { ChatController } = require('../src/chat/commands');
const skills = require('../src/skills');
const fallbackRouter = require('../src/llm/fallbackRouter');
const { runMiningInline } = require('../src/core/miningDispatch');
const { routeGoal, applyGoal } = require('../src/core/goalRouter');

const silent = { debug() {}, info() {}, warn() {}, error() {} };

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

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A solid stone slab with a carved corridor and extra ore blocks. */
function mineWorld({ minX = -8, maxX = 8, corridor = [], extras = [] } = {}) {
  const blocks = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = 63; y <= 66; y += 1) {
      for (let z = -3; z <= 3; z += 1) blocks.push({ name: 'stone', position: { x, y, z } });
    }
  }
  for (const cell of corridor) blocks.push({ name: 'air', position: cell });
  for (const block of extras) blocks.push(block);
  return blocks;
}

const DIAMOND_CORRIDOR = [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }];
function diamondWorld() {
  return mineWorld({
    corridor: DIAMOND_CORRIDOR,
    extras: [
      { name: 'diamond_ore', position: { x: 1, y: 64, z: 0 } },
      { name: 'deepslate_diamond_ore', position: { x: 2, y: 64, z: 0 } },
      { name: 'deepslate_diamond_ore', position: { x: 3, y: 64, z: 0 } }
    ]
  });
}

/** Assemble the control stack around a mock body, mirroring src/index.js wiring. */
async function buildAgent({ world, inventory, slowDigMs = 0 } = {}) {
  const cfg = loadConfig({ profile: null });
  const body = new MockBody(cfg, {
    blocks: world || mineWorld({ corridor: DIAMOND_CORRIDOR }),
    inventory: inventory || { 'minecraft:iron_pickaxe': 1, 'minecraft:cobblestone': 16 }
  });
  await body.connect();
  if (slowDigMs) {
    const realDig = body.dig.bind(body);
    body.dig = async (block, options) => {
      await new Promise((resolve) => setTimeout(resolve, slowDigMs));
      return realDig(block, options);
    };
  }
  const said = [];
  const traces = [];
  const runs = [];
  const ctx = {
    cfg,
    log: silent,
    body,
    bodyKind: 'mock',
    world: new BodyWorldView(body, cfg, { log: silent }),
    nav: { stop() {}, interrupt() {}, goto: async () => true },
    eat: { tick: async () => true },
    combat: { defend: async () => true },
    tools: { equipArmor: async () => true },
    controller: { bot: null, isAlive: true, snapshot: () => ({ ready: true }), loadedPlugins: [] },
    memory: { data: { runtime: {} }, bump() {}, recordTask() {}, save() {}, landmark: () => null, summary: () => ({ deaths: 0 }) },
    reply: (text) => {
      said.push(String(text));
      return true;
    }
  };
  const brain = new Brain(ctx);
  ctx.brain = brain;
  ctx.hub = new TaskHub(ctx, { log: silent, trace: (entry) => traces.push(entry) });
  ctx.chat = new ChatController(ctx, { prefix: '!' });

  const realRun = skills.run;
  skills.run = async (name, runCtx, params) => {
    const record = { name, params: params ? { ...params } : {}, done: null };
    runs.push(record);
    const result = await realRun(name, runCtx, params);
    record.done = result;
    return result;
  };
  return { cfg, body, ctx, brain, hub: ctx.hub, chat: ctx.chat, said, traces, runs, restore: () => { skills.run = realRun; } };
}

async function settleHub(hub) {
  const handle = hub.current;
  if (handle) await handle.settle;
}

async function main() {
  process.stdout.write('minecraft-survival-agent - mining entry test (offline, A-series)\n\n');

  // ---------------------------------------------------------------- A3/A4/A5 (pure)
  process.stdout.write('1. request normalization (A3 deepslate variants, A4 arrays, A5 refusals)\n');
  const mr = require('../src/core/miningRequest');
  await check('A3: plain ore name expands to the real pair, explicit deepslate stays exact', () => {
    const plain = mr.normalizeMiningRequest({ blocks: 'diamond_ore' });
    assert.deepStrictEqual(plain.blocks, ['diamond_ore', 'deepslate_diamond_ore']);
    const deep = mr.normalizeMiningRequest({ blocks: 'deepslate_diamond_ore' });
    assert.deepStrictEqual(deep.blocks, ['deepslate_diamond_ore']);
    return 'diamond_ore -> pair; deepslate -> exact';
  });
  await check('A4: nether and modded names never get an invented deepslate twin', () => {
    assert.deepStrictEqual(mr.normalizeMiningRequest({ blocks: 'nether_quartz_ore' }).blocks, ['nether_quartz_ore']);
    const resolved = mr.normalizeMiningRequest(
      { blocks: 'create:zinc_ore' },
      { resolver: () => ({ category: 'ore', mineable: true }) }
    );
    assert.deepStrictEqual(resolved.blocks, ['create:zinc_ore']);
    return 'no deepslate_nether_quartz_ore, modded namespace preserved';
  });
  await check('A4: arrays keep order and de-duplicate', () => {
    const r = mr.normalizeMiningRequest({ blocks: ['coal_ore', 'iron_ore', 'coal_ore'] });
    assert.deepStrictEqual(r.blocks, ['coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore']);
    return r.blocks.join(',');
  });
  await check('A5: ore+material mix, bad counts and unknown ores are refused', () => {
    assert.strictEqual(mr.normalizeMiningRequest({ blocks: 'stone,iron_ore' }).ok, false);
    assert.strictEqual(mr.normalizeMiningRequest({ blocks: 'iron', count: 0 }).ok, false);
    assert.strictEqual(mr.normalizeMiningRequest({ blocks: 'iron', count: 1.5 }).ok, false);
    assert.strictEqual(mr.normalizeMiningRequest({ blocks: 'iron', count: 'NaN' }).ok, false);
    assert.strictEqual(mr.normalizeMiningRequest({ blocks: 'iron', count: 512 }).ok, false);
    assert.strictEqual(mr.normalizeMiningRequest({ blocks: 'foo:bar_ore' }).ok, false);
    return '6 refusals, no guessing';
  });
  await check('A5: a direct mine_ore boundary refuses plain materials', () => {
    assert.strictEqual(mr.normalizeOreParams({ block: 'stone' }).ok, false);
    assert.strictEqual(mr.normalizeOreParams({ ore: 'deepslate_diamond_ore', block: 'diamond_ore' }).ok, false);
    assert.strictEqual(mr.normalizeOreParams({ ore: 'diamond', block: 'diamond_ore' }).ok, true);
    return 'material refused; agreeing spellings accepted';
  });

  // ------------------------------------------------------------------------- A1
  process.stdout.write('\n2. entry matrix (A1): one executor, one acceptance, same targets\n');
  {
    const entries = [
      {
        name: 'A1 !mine diamond 2 (chat)',
        run: async (agent) => (await agent.chat.handle('mine diamond 2', 'player', { source: 'chat' })).result
      },
      {
        name: 'A1 mine diamond 2 (panel/HTTP source)',
        run: async (agent) => (await agent.chat.handle('mine diamond 2', 'panel', { source: 'panel' })).result
      },
      {
        name: 'A1 do_task mine (native tool)',
        run: async (agent) =>
          require('../src/llm/tools/actuators').doTask(agent.ctx, { task: 'mine', args: { block: ['diamond_ore'], count: 2 } }, { source: 'llm' })
      },
      {
        name: 'A1 do_skill mine_ore (JSON skill)',
        run: async (agent) =>
          require('../src/llm/tools/actuators').doSkill(agent.ctx, { name: 'mine_ore', params: { block: 'diamond_ore', count: 2 } }, { source: 'llm' })
      },
      {
        name: 'A1 fallback router 挖2个钻石 -> skill dispatch',
        run: async (agent) => {
          const routed = fallbackRouter.route('挖2个钻石', {});
          assert(routed.ok && routed.intent.action && routed.intent.action.type === 'skill', 'fallback did not pick the ore skill');
          return require('../src/llm/tools/actuators').doSkill(
            agent.ctx,
            { name: 'mine_ore', params: routed.intent.action.args },
            { source: 'llm' }
          );
        }
      }
    ];

    for (const entry of entries) {
      const agent = await buildAgent({ world: diamondWorld(), inventory: { 'minecraft:iron_pickaxe': 1 } });
      let receipt;
      try {
        receipt = await entry.run(agent);
        await settleHub(agent.hub);
        const accepted = agent.traces.filter((t) => t.kind === 'task-accepted' && t.name === 'mine_ore');
        const mineRuns = agent.runs.filter((r) => r.name === 'mine_ore');
        await check(entry.name, () => {
          assert(receipt && receipt.ok !== false, `not accepted: ${JSON.stringify(receipt)}`);
          assert.strictEqual(accepted.length, 1, `expected exactly one mine_ore acceptance, got ${accepted.length}`);
          assert(
            receipt.kind === 'ore' || receipt.skill === 'mine_ore',
            `receipt does not identify the ore executor: ${JSON.stringify(receipt)}`
          );
          const run = mineRuns[0];
          assert(run, 'mine_ore never executed');
          /**
           * Entries that go through the dispatcher pass the already-expanded list; a
           * direct `do_skill mine_ore` passes the raw name and the skill boundary expands
           * it. Both must normalize to the same concrete target set.
           */
          const normalized = mr.normalizeOreParams({ block: run.params.block });
          assert(normalized.ok, `skill params did not normalize: ${JSON.stringify(run.params)}`);
          assert.deepStrictEqual(normalized.blocks, ['diamond_ore', 'deepslate_diamond_ore']);
          assert.strictEqual(run.params.count, 2);
          assert.strictEqual(agent.brain.queue.length, 0, 'a legacy MineBlockTask appeared on the brain queue');
          return `hub=${accepted[0].id}, block=${run.params.block}, count=${run.params.count}`;
        });
      } finally {
        agent.restore();
      }
    }
  }

  // ------------------------------------------------------------------------- A2
  process.stdout.write('\n3. goal router + autonomous adapter (A2)\n');
  {
    const agent = await buildAgent({});
    try {
      await check('A2: !goal 挖2块铁 queues the ore executor, not the stone task', async () => {
        const routed = routeGoal(agent.ctx, '挖2块铁');
        assert(routed && routed.task && routed.task.name === 'mine_ore', `routeGoal picked ${routed && routed.task && routed.task.name}`);
        assert.strictEqual(routed.task.count, 2);
        assert(/iron_ore/.test(String(routed.task.targets)), 'iron_ore target missing');
        await agent.chat.handle('goal 挖2块铁', 'player');
        const queued = agent.brain.queue.map((t) => t.name);
        assert(queued.includes('mine_ore'), `brain queue has ${queued.join(',')}`);
        assert(!queued.some((n) => n.includes('mine-block')), 'a mine-block task was queued');
        return `queued ${queued.join(',')}`;
      });
      await check('A2: CLI --goal path (applyGoal) uses the same ore executor', async () => {
        await applyGoal(agent.ctx, '挖3块钻石');
        const queued = agent.brain.queue.map((t) => t.name);
        assert(queued.includes('mine_ore'), `brain queue has ${queued.join(',')}`);
        return `queued ${queued.join(',')}`;
      });
    } finally {
      agent.restore();
    }
  }
  await check('A2: generic 挖 does not steal a specific mineral', () => {
    const fakeCtx = {};
    const iron = routeGoal(fakeCtx, '挖铁');
    const diamond = routeGoal(fakeCtx, '帮我挖点钻石');
    const stone = routeGoal(fakeCtx, '挖点石头');
    assert.strictEqual(iron.task.name, 'mine_ore');
    assert.strictEqual(diamond.task.name, 'mine_ore');
    assert.strictEqual(stone.task.name, 'mine');
    assert.strictEqual(stone.task.constructor.name, 'MineBlockTask');
    return 'iron/diamond -> mine_ore, stone -> MineBlockTask';
  });
  {
    const agent = await buildAgent({
      world: mineWorld({
        corridor: DIAMOND_CORRIDOR,
        extras: [{ name: 'iron_ore', position: { x: 1, y: 64, z: 0 } }]
      }),
      inventory: { 'minecraft:stone_pickaxe': 1 }
    });
    try {
      await check('A2: ctx.mine / runMiningInline runs the skill without submitting another hub job', async () => {
        const before = agent.traces.filter((t) => t.kind === 'task-accepted').length;
        const result = await runMiningInline(agent.ctx, { blocks: 'iron_ore', count: 1 });
        const after = agent.traces.filter((t) => t.kind === 'task-accepted').length;
        assert.strictEqual(after, before, 'the inline path submitted a TaskHub job');
        assert(result && result.mined === 1, `inline run mined ${result && result.mined}`);
        return `mined ${result.mined} without hub submission`;
      });
    } finally {
      agent.restore();
    }
  }

  // ------------------------------------------------------------------------- A6
  process.stdout.write('\n4. material path (A6)\n');
  {
    const agent = await buildAgent({ inventory: { 'minecraft:iron_pickaxe': 1 } });
    try {
      await check('A6: !mine stone/dirt/sand keep the material task and never touch the hub', async () => {
        for (const cmd of ['mine stone 4', 'mine dirt 4', 'mine sand 4']) {
          // eslint-disable-next-line no-await-in-loop
          await agent.chat.handle(cmd, 'player');
        }
        const queued = agent.brain.queue;
        const materials = queued.filter((t) => t.constructor.name === 'MineBlockTask');
        assert.strictEqual(materials.length, 3, `queued: ${queued.map((t) => t.constructor.name).join(',')}`);
        assert.strictEqual(agent.hub.current, null, 'the hub was used for a material request');
        assert.strictEqual(agent.runs.filter((r) => r.name === 'mine_ore').length, 0, 'mine_ore ran for a material');
        return '3 material tasks, hub untouched';
      });
    } finally {
      agent.restore();
    }
  }

  // ------------------------------------------------------------------------- A5/A8
  process.stdout.write('\n5. refusal safety and lifecycle (A5, A8, A9-lite)\n');
  {
    const agent = await buildAgent({
      world: diamondWorld(),
      inventory: { 'minecraft:iron_pickaxe': 1 },
      slowDigMs: 120
    });
    try {
      const first = await agent.chat.handle('mine diamond 2', 'player');
      const acceptedTrace = agent.traces.find((t) => t.kind === 'task-accepted' && t.name === 'mine_ore');
      const firstTask = acceptedTrace && acceptedTrace.id;
      await check('A8: acceptance is async and carries one task id', () => {
        const receipt = first.result;
        assert(receipt && receipt.async === true && typeof receipt.taskId === 'string');
        assert.strictEqual(receipt.taskId, firstTask, 'the hub owner and the receipt disagree');
        return `taskId=${receipt.taskId}`;
      });
      await check('A5/A8: invalid requests are refused and do not replace the legal task', async () => {
        const refused = await agent.chat.handle('mine stone,iron_ore', 'player');
        assert(refused.result && refused.result.ok === false, 'mixed request was not refused');
        assert.strictEqual(agent.hub.current && agent.hub.current.id, firstTask, 'the legal task was replaced by an invalid one');
        const badCount = await agent.chat.handle('mine diamond 0', 'player');
        assert(badCount.result && badCount.result.ok === false, 'count 0 was not refused');
        return 'mixed + count 0 refused, owner kept';
      });
      await check('A8: a legal second request replaces the first, single owner', async () => {
        await agent.chat.handle('mine deepslate_diamond_ore 1', 'player');
        const replaced = agent.traces.find((t) => t.kind === 'task-accepted' && t.replaced === firstTask);
        assert(replaced, 'replacement trace missing');
        const hist = agent.hub.history.find((h) => h.id === firstTask);
        assert(hist && hist.interrupted === 'replaced', `first task history: ${JSON.stringify(hist)}`);
        assert(agent.hub.current && agent.hub.current.id !== firstTask, 'two owners at once');
        return 'one owner, old task interrupted=replaced';
      });
      await check('A9: stop cancels and no further world actions follow', async () => {
        await agent.chat.handle('stop', 'player');
        await settleHub(agent.hub);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const len = agent.body.history.length;
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.strictEqual(agent.body.history.length, len, 'actions continued after stop');
        assert.strictEqual(agent.hub.current, null, 'hub still owns a task after stop');
        return `history frozen at ${len} entries`;
      });
    } finally {
      agent.restore();
    }
  }

  // ------------------------------------------------------------------------- A7
  process.stdout.write('\n6. count semantics and real mining (A7)\n');
  {
    const agent = await buildAgent({
      world: diamondWorld(),
      inventory: { 'minecraft:iron_pickaxe': 1 }
    });
    try {
      await check('A7: count=2 mines exactly two ore blocks (not count+2, not drops)', async () => {
        const receipt = await agent.chat.handle('mine diamond 2', 'player');
        assert(receipt.result && receipt.result.accepted, 'not accepted');
        const run = await waitFor(() => agent.runs.find((r) => r.name === 'mine_ore' && r.done), 8000);
        assert(run, 'mine_ore run never finished');
        const result = run.done;
        assert.strictEqual(result.mined, 2, `mined ${result.mined}`);
        const dugOres = agent.body.history.filter((h) => h.action === 'dig' && /diamond_ore$/.test(h.name));
        assert.strictEqual(dugOres.length, 2, `dug ${dugOres.length} ore blocks`);
        return `mined=${result.mined}, dug blocks=${dugOres.length}`;
      });
    } finally {
      agent.restore();
    }
  }

  process.stdout.write(`\n${failures ? 'FAIL' : 'OK'} - mining entry test: ${checks - failures}/${checks} checks\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('mining entry test crashed:', err.stack || err.message);
  process.exit(1);
});
