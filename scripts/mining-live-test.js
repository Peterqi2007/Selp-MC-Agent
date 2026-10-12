#!/usr/bin/env node
'use strict';

/**
 * Real-client driver for the mining acceptance matrix (MINING-LLM-PLAN §6.3 /
 * MINING-COLLECTION-PLAN §9.3). One command per scenario, one evidence file per run.
 *
 *   node scripts/mining-live-test.js --precheck
 *   node scripts/mining-live-test.js --mine diamond --count 2 --label shaft-3
 *   node scripts/mining-live-test.js --pillar-probe --confirm-world-change
 *   node scripts/mining-live-test.js --mine gold --count 1 --body mock   (offline plumbing)
 *
 * Read-only by default: `--mine` is the only mode that changes the world, and
 * `--pillar-probe` refuses without the explicit `--confirm-world-change` flag. Evidence
 * goes to `runtime/mining-live/<timestamp>-<label>.json` together with the console log.
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/util/config');
const { ClientModBody } = require('../src/body/clientModBody');
const { MockBody } = require('../src/body/mockBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const skills = require('../src/skills');
const { resolveMiningProducts } = require('../src/skills/miningAcquisition');

function parseArgs(argv) {
  const out = { body: 'clientmod', count: null, maxMs: null, expectMined: null, label: null, confirm: false, find: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => argv[++i];
    switch (a) {
      case '--precheck': out.mode = 'precheck'; break;
      case '--mine': out.mode = 'mine'; out.ore = value(); break;
      case '--pillar-probe': out.mode = 'pillar'; break;
      case '--tunnel-probe': out.mode = 'tunnel'; break;
      case '--command': out.mode = 'command'; out.line = value(); break;
      case '--stop-after': out.stopAfter = Number(value()); break;
      case '--collect-drops': out.mode = 'collect'; break;
      case '--item': out.item = String(value()); break;
      case '--find': out.mode = 'find'; out.find.push(value()); break;
      case '--count': out.count = Number(value()); break;
      case '--max-ms': out.maxMs = Number(value()); break;
      case '--expect-mined': out.expectMined = Number(value()); break;
      case '--label': out.label = String(value()); break;
      case '--body': out.body = String(value()); break;
      case '--no-login': out.noLogin = true; break;
      case '--recovery': out.recovery = true; break;
      case '--confirm-world-change': out.confirm = true; break;
      default:
        if (a.startsWith('--find ')) out.find.push(a.split(/\s+/).slice(1).join(' '));
        else throw new Error(`unknown argument "${a}"`);
    }
  }
  return out;
}

/** Offline fixture so the driver itself can be exercised without the game. */
function mockWorld() {
  const blocks = [];
  for (let x = -4; x <= 4; x += 1) {
    for (let y = 63; y <= 66; y += 1) {
      for (let z = -3; z <= 3; z += 1) blocks.push({ name: 'stone', position: { x, y, z } });
    }
  }
  for (const cell of [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }, { x: 1, y: 64, z: 0 }, { x: 1, y: 65, z: 0 }]) {
    blocks.push({ name: 'air', position: cell });
  }
  blocks.push({ name: 'gold_ore', position: { x: 1, y: 64, z: 0 } });
  return blocks;
}

async function buildBody(cfg, kind) {
  if (kind === 'mock') {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: mockWorld(),
      inventory: { 'minecraft:iron_pickaxe': 1, 'minecraft:cobblestone': 8 }
    });
    await body.connect();
    return body;
  }
  const body = new ClientModBody(cfg, { log: console });
  const attached = await body.connect({ waitMs: 15000 });
  if (!attached) throw new Error('the control mod is not answering on 127.0.0.1:8899 - start the Forge client first');
  return body;
}

/**
 * Authenticate on AuthMe servers, reusing the agent's own module: it only logs in when
 * the chat shows a login prompt (silence is not evidence), never registers, and respects
 * the rate-limit cooldown.
 */
async function ensureLoggedIn(body, cfg, log, enabled) {
  if (!enabled || typeof body.request !== 'function') return { ok: true, action: 'skip', reason: 'not applicable' };
  const { AuthMeLogin } = require('../src/core/authme');
  const authme = new AuthMeLogin(body, { log }, { ...(cfg.agent.bot.authme || {}), log });
  const chat = await body.request('/chatlog').catch(() => null);
  for (const line of (chat && chat.lines) || []) authme.observe(line);
  const verdict = await authme.ensure('live-test');
  log.info(`authme: ${verdict.action} - ${verdict.reason}`);
  return verdict;
}

function summarizeSnapshot(snap) {
  if (!snap) return null;
  return {
    position: snap.position,
    heldItem: snap.heldItem || null,
    health: snap.health,
    food: snap.food,
    onGround: snap.onGround !== false,
    emptySlots: snap.emptySlots,
    inventory: snap.inventory,
    nearbyItems: (snap.nearbyItems || []).slice(0, 12)
  };
}

function inventoryDelta(before, after) {
  const delta = {};
  const names = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const name of names) {
    const d = (after && after[name] ? after[name] : 0) - (before && before[name] ? before[name] : 0);
    if (d !== 0) delta[name] = d;
  }
  return delta;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode) {
    console.log('usage: node scripts/mining-live-test.js --precheck | --mine <ore> [--count N] | --find <block> [--body mock]');
    process.exitCode = 2;
    return;
  }
  const cfg = loadConfig();
  const body = await buildBody(cfg, args.body);
  const log = [];
  const captureLog = {
    info: (...a) => { log.push(`INFO ${a.join(' ')}`); },
    warn: (...a) => { log.push(`WARN ${a.join(' ')}`); },
    error: (...a) => { log.push(`ERROR ${a.join(' ')}`); },
    debug: () => {}
  };
  await body.refresh(true);
  const before = body.snapshot() || {};
  const ctx = { cfg, body, world: new BodyWorldView(body, cfg, { log: captureLog }), log: captureLog, trace: () => {} };
  /**
   * L-series only: enable the recovery session for THIS run in memory (the repository
   * default stays enabled:false). The runner is wired exactly like src/index.js - same
   * session, same budgets, real LlmClient from config/llm.json.
   */
  if (args.recovery && args.body !== 'mock') {
    const { LlmClient } = require('../src/llm/client');
    const { runMiningRecovery, MiningRecoverySession } = require('../src/skills/miningRecovery');
    ctx.cfg = {
      ...cfg,
      agent: { ...cfg.agent, miningRecovery: { ...(cfg.agent.miningRecovery || {}), enabled: true } }
    };
    const llm = new LlmClient({ ...(cfg.llm || {}), log: captureLog });
    ctx.recoveryRunner = async ({ goal, io, monitor, trigger, triggerReason, signal, cfg: recoveryCfg }) => {
      const session = new MiningRecoverySession({
        ctx,
        io,
        goal,
        signal,
        cfg: { ...(recoveryCfg || {}), enabled: true },
        llm,
        monitor,
        trigger,
        triggerReason,
        trace: (entry) => log.push(`TRACE ${JSON.stringify(entry)}`)
      });
      const summary = await runMiningRecovery(session);
      evidence.recovery = evidence.recovery || [];
      evidence.recovery.push({
        outcome: summary.outcome,
        trigger: summary.trigger,
        triggerReason: summary.triggerReason,
        calls: summary.calls,
        tokens: summary.tokens,
        reason: summary.reason,
        failure: summary.failure,
        acquisition: summary.acquisition
      });
      console.log(
        'recovery:',
        JSON.stringify({
          outcome: summary.outcome,
          trigger: summary.trigger,
          calls: summary.calls,
          tokens: summary.tokens,
          reason: summary.reason
        })
      );
      return summary;
    };
  }
  const auth = await ensureLoggedIn(body, cfg, captureLog, !args.noLogin && args.body !== 'mock');
  const evidence = {
    at: new Date().toISOString(),
    mode: args.mode,
    bodyKind: args.body,
    auth,
    params: { ore: args.ore || null, count: args.count, maxMs: args.maxMs, label: args.label },
    before: summarizeSnapshot(before)
  };
  if (args.recovery && args.body !== 'mock') evidence.recoveryEnabled = true;
  let exitCode = 0;

  if (args.mode === 'precheck') {
    const health =
      typeof body.request === 'function'
        ? await body.request('/health').catch((err) => ({ ok: false, error: err.message }))
        : { ok: true, note: 'mock body has no HTTP health endpoint' };
    console.log('health :', JSON.stringify(health));
    console.log('pos    :', JSON.stringify(before.position));
    console.log('held   :', before.heldItem || '(nothing)');
    console.log('inv    :', JSON.stringify(before.inventory));
    if (before.position) {
      const plan = await body.plan({ x: Math.floor(before.position.x) + 5, y: Math.floor(before.position.y), z: Math.floor(before.position.z) });
      console.log('plan   :', JSON.stringify({ ok: plan.ok, status: plan.status, waypoints: plan.waypoints, reason: plan.reason }));
      evidence.plan = { ok: plan.ok, status: plan.status, waypoints: plan.waypoints, reason: plan.reason };
    }
    evidence.health = health;
    const pass = !!before.position && !!before.ready;
    console.log(pass ? 'PRECHECK PASS' : 'PRECHECK FAIL');
    if (!pass) exitCode = 1;
  }

  if (args.mode === 'find') {
    const found = body.findBlocks(args.find, { maxDistance: 48 });
    console.log('found  :', JSON.stringify(found.slice(0, 20)));
    evidence.found = found.slice(0, 20);
    if (!found.length) exitCode = 1;
  }

  if (args.mode === 'mine') {
    if (!args.ore) throw new Error('--mine needs an ore name');
    const params = { block: args.ore, count: args.count === null ? undefined : args.count, maxMs: args.maxMs || 300000 };
    const startedAt = Date.now();
    const result = await skills.run('mine_ore', ctx, params);
    await body.refresh(true);
    const after = body.snapshot() || {};
    const products = resolveMiningProducts(args.ore, {});
    evidence.params.block = args.ore;
    evidence.durationMs = Date.now() - startedAt;
    evidence.result = result;
    evidence.after = summarizeSnapshot(after);
    evidence.inventoryDelta = inventoryDelta(before.inventory, after.inventory);
    evidence.productHint = products.ok ? products.products : null;
    console.log('result :', JSON.stringify({
      ok: result.ok, mined: result.mined, collected: result.collected, partial: result.partial,
      stopped: result.stopped, acquisition: result.acquisition, pending: result.pending,
      pillar: result.pillar, ledger: result.ledger, recoveryRuns: result.recoveryRuns
    }));
    console.log('delta  :', JSON.stringify(evidence.inventoryDelta));
    if (args.expectMined !== null && result.mined !== args.expectMined) {
      console.log(`EXPECT-MINED FAIL: wanted ${args.expectMined}, got ${result.mined}`);
      exitCode = 1;
    }
    if (result.ok === false && result.interrupted !== true) exitCode = 1;
  }

  if (args.mode === 'command') {
    /**
     * Drive the REAL command table the panel and `!` channel use: `mine <block> <count>`
     * goes through the shared dispatcher into the TaskHub and the skill runs with the
     * task's cancellation token. This is the live A-entry/TaskHub path without starting
     * the autonomous brain.
     */
    if (!args.line) throw new Error('--command needs a command line, e.g. "mine iron_ore 1"');
    const { TaskHub } = require('../src/core/taskHub');
    const { ChatController } = require('../src/chat/commands');
    const said = [];
    ctx.reply = (text) => {
      said.push(String(text));
      captureLog.info(`say: ${text}`);
      return true;
    };
    ctx.hub = new TaskHub(ctx, { log: captureLog, trace: () => {} });
    ctx.chat = new ChatController(ctx, { prefix: '!' });
    /**
     * Optional mid-run stop: `--stop-after N` cancels the live task through the same
     * TaskHub the operator's `!stop` uses, so the interruption semantics (no further side
     * effects, partial result preserved) are exercised for real.
     */
    if (args.stopAfter) {
      setTimeout(() => {
        ctx.hub.cancel('live-test stop').catch(() => {});
      }, args.stopAfter);
    }
    const handle = ctx.chat.handle(args.line, 'live-test', { source: 'panel' });
    const receipt = await handle;
    evidence.receipt = receipt && receipt.result ? receipt.result : receipt;
    console.log('receipt:', JSON.stringify(evidence.receipt));
    const task = ctx.hub.current;
    if (task && typeof task.settle?.then === 'function') {
      const info = await task.settle;
      evidence.task = info;
      console.log('task   :', JSON.stringify({
        ok: info.ok,
        ms: info.ms,
        partial: info.partial,
        pending: info.pending,
        recoveryRuns: info.recoveryRuns,
        interrupted: info.interrupted,
        reason: info.reason
      }));
      if (args.stopAfter) {
        // A stop test passes when the task really stopped (not when it finished normally).
        if (!info.interrupted) {
          console.log('STOP TEST FAIL: the task was not interrupted');
          exitCode = 1;
        }
        const progress = await body.request('/progress').catch(() => null);
        evidence.progressAfterStop = progress;
        console.log('progress:', JSON.stringify(progress));
      } else if (info.ok === false && info.interrupted !== 'replaced') {
        exitCode = 1;
      }
    } else if (receipt && receipt.result && Array.isArray(receipt.result.pending)) {
      // Material path: the task went to the brain queue instead of the hub.
      console.log('note   : material request queued (no hub task to settle here)');
    }
  }

  if (args.mode === 'pillar') {
    if (!args.confirm) {
      console.log('pillar probe refused: pass --confirm-world-change (it jumps and places a block)');
      exitCode = 2;
    } else {
      /**
       * The Mod pillars with whatever is held; equip a support block first (the real
       * executor does the same through io.equip).
       */
      const scaffold = Object.keys(before.inventory || {}).find(
        (n) => /cobblestone|cobbled_deepslate|^minecraft:(dirt|stone)$|planks$|_log$/.test(n) && before.inventory[n] > 0
      );
      if (!scaffold) {
        console.log('no scaffold block in the inventory - cannot probe');
        exitCode = 2;
      } else {
        await body.equip(scaffold);
        await body.refresh(true);
        const heldNow = (body.snapshot() || {}).heldItem;
        console.log('equip  :', scaffold, '-> held', heldNow);
        evidence.equipped = heldNow;
      }
    }
    if (args.confirm && exitCode === 0) {
      const receipt = await body.pillar(1, { timeoutMs: 12000 });
      await body.refresh(true);
      const after = body.snapshot() || {};
      evidence.receipt = receipt;
      evidence.after = summarizeSnapshot(after);
      console.log('receipt:', JSON.stringify(receipt));
      console.log('feet   :', JSON.stringify({ before: before.position, after: after.position }));
      const rose = before.position && after.position && Math.floor(after.position.y) === Math.floor(before.position.y) + 1;
      console.log(rose ? 'PILLAR PASS' : 'PILLAR FAIL');
      if (!rose) exitCode = 1;
    }
  }

  if (args.mode === 'tunnel') {
    /**
     * C21/CP7 live probe: pick an adjacent solid block, protect its type, and walk the
     * corridor one cell into it. The Mod must stop BEFORE destroying the protected block
     * and report `target_requires_acquisition` with the exact cell.
     */
    if (!args.confirm) {
      console.log('tunnel probe refused: pass --confirm-world-change (it may clear the headroom cell)');
      exitCode = 2;
    } else if (!before.position) {
      console.log('no player position');
      exitCode = 1;
    } else {
      const bareName = (name) => String(name || '').replace(/^[a-z0-9_]+:/, '');
      const feet = {
        x: Math.floor(before.position.x),
        y: Math.floor(before.position.y),
        z: Math.floor(before.position.z)
      };
      const candidates = [
        { x: feet.x + 1, y: feet.y, z: feet.z },
        { x: feet.x - 1, y: feet.y, z: feet.z },
        { x: feet.x, y: feet.y, z: feet.z + 1 },
        { x: feet.x, y: feet.y, z: feet.z - 1 },
        { x: feet.x + 1, y: feet.y + 1, z: feet.z },
        { x: feet.x, y: feet.y, z: feet.z - 1 }
      ];
      let chosen = null;
      for (const cell of candidates) {
        const block = body.blockAt(cell);
        if (block && block.name && !/air$/.test(block.name)) {
          chosen = { cell, name: block.name };
          break;
        }
      }
      if (!chosen) {
        console.log('no adjacent solid block to protect - probe needs a wall');
        exitCode = 2;
      } else {
        const protectName = bareName(chosen.name);
        console.log('target :', JSON.stringify(chosen.cell), protectName);
        const receipt = await body.tunnel([chosen.cell], {
          protect: { blocks: [protectName] },
          timeoutMs: 10000
        });
        await body.refresh(true);
        const afterBlock = body.blockAt(chosen.cell);
        evidence.probe = { chosen, receipt, after: afterBlock ? afterBlock.name : 'air' };
        console.log('receipt:', JSON.stringify(receipt));
        console.log('after  :', afterBlock ? afterBlock.name : 'air');
        const stopped =
          receipt.ok === false &&
          receipt.reason === 'target_requires_acquisition' &&
          receipt.cell &&
          receipt.cell.x === chosen.cell.x &&
          receipt.cell.y === chosen.cell.y &&
          receipt.cell.z === chosen.cell.z;
        const survived = !!afterBlock && bareName(afterBlock.name) === protectName;
        console.log(stopped && survived ? 'TUNNEL PROTECT PASS' : 'TUNNEL PROTECT FAIL');
        if (!(stopped && survived)) exitCode = 1;
      }
    }
  }

  if (args.mode === 'collect') {
    /**
     * Operator-directed collection probe: point the shared collector at the nearest dropped
     * item and let it walk / carve access / climb to it. This is the tool for the live
     * complaint "the ore dropped behind rock and the collector gave up" - the carve tier
     * now opens the pocket instead of failing.
     */
    const { prepareAcquisition } = require('../src/skills/miningAcquisition');
    const { attemptCollection } = require('../src/skills/miningCollection');
    const { findScaffold } = require('../src/world/items');
    const bareName = (name) => String(name || '').replace(/^[a-z0-9_]+:/, '');
    const drops = (before.nearbyItems || [])
      .filter((d) => d && d.position && (!args.item || String(d.name || d.item || '').includes(args.item)))
      .sort((a, b) => (a.distance || 0) - (b.distance || 0));
    if (!drops.length) {
      console.log('no visible dropped items nearby');
      exitCode = 2;
    } else {
      const drop = drops[0];
      /**
       * The Mod's item entities use `item`; the body method maps it to `name` (plan CP1).
       * Accept both so the probe cannot silently miss a real drop.
       */
      const dropName = bareName(drop.name || drop.item || '');
      const goal = prepareAcquisition({
        taskId: 'probe',
        target: { blockId: dropName, position: drop.position },
        products: [dropName],
        snapshot: before
      });
      goal.mined = { confirmed: true, actionId: 'probe', at: Date.now(), before: null, after: null };
      goal.status = 'pending';
      goal.phase = 'collect';
      goal.pendingDrops = [{ id: drop.id, name: dropName, count: drop.count || 1, position: { ...drop.position } }];
      /**
       * The probe explicitly owns this pre-existing entity: clear the "old drops" baseline,
       * or the fresh-drop filter would treat the target as someone else's leftover.
       */
      goal.dropsBefore = [];
      const pickaxe = Object.keys(before.inventory || {}).find((n) => /_pickaxe$/.test(n));
      if (pickaxe) await body.equip(pickaxe).catch(() => false);
      const scaffold = findScaffold(before.inventory || {});
      const io = {
        log: captureLog,
        refresh: async () => {
          await body.refresh(true);
          const s = body.snapshot();
          return s && s.ready !== false ? s : null;
        },
        feetOf: (s) => (s && s.position ? { x: Math.floor(s.position.x), y: Math.floor(s.position.y), z: Math.floor(s.position.z) } : null),
        read: (s, cell) => {
          const block = body.blockAt(cell);
          return block && block.name ? bareName(block.name) : 'unknown';
        },
        passable: (name) => /air$/.test(name),
        solid: (name) => !/air$/.test(name) && name !== 'unknown',
        protectedName: () => false, // operator-directed: nothing is "the task ore" here
        dangerAt: (s, cell) => {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const block = body.blockAt({ x: cell.x + dx, y: cell.y, z: cell.z + dz });
            if (block && /lava/.test(block.name)) return { reason: 'lava beside the access', hostile: false };
          }
          return null;
        },
        digCell: async (cell) => {
          const name = io.read(null, cell);
          if (io.passable(name)) return { ok: true };
          const feet = io.feetOf(body.snapshot());
          const reach = feet ? Math.hypot(feet.x - cell.x, feet.y - (cell.y + 0.5), feet.z - cell.z) : 99;
          if (reach > 4.5) return { ok: false, failure: 'out_of_reach', reason: `${reach.toFixed(2)} blocks away` };
          const dug = await body.dig({ name, position: { ...cell } }, { timeoutMs: 20000 }).catch(() => false);
          if (!dug) return { ok: false, failure: 'refused', reason: 'the dig was refused' };
          await body.refresh(true);
          const after = io.read(null, cell);
          return io.passable(after) ? { ok: true } : { ok: false, failure: 'occluded', reason: `${after} is still there` };
        },
        moveTo: async (position, opts) => {
          const range = Math.min(1, Math.max(0.3, (opts && opts.within) || 1));
          const ok = await body.moveTo(position, { range, timeoutMs: 12000, raw: true }).catch(() => false);
          return { ok: !!ok };
        },
        climbTo: async (stand, opts = {}) => {
          let risen = 0;
          if (scaffold) await body.equip(scaffold).catch(() => false);
          for (let i = 0; i < (opts.maxSteps || 2); i += 1) {
            const feet = io.feetOf(body.snapshot());
            if (!feet || feet.y >= stand.y) break;
            const hop = await body.pillar(1, { timeoutMs: 8000 }).catch(() => ({ ok: false }));
            if (!hop || !hop.ok) break;
            risen += 1;
          }
          return { ok: risen > 0, risen };
        },
        /** Support block + permission-gated placement for the fill-the-pit fallback. */
        pickScaffold: () => {
          const snap = body.snapshot();
          return snap && snap.inventory ? findScaffold(snap.inventory) : null;
        },
        placeBlock: async (item, reference, face) => {
          const ok = await body.place(item, reference, face).catch(() => false);
          return { ok: !!ok };
        }
      };
      const collected = await attemptCollection({
        goal,
        io,
        mode: 'macro',
        allowTerrainEdits: true,
        deadline: Date.now() + 90000
      });
      await body.refresh(true);
      const after = body.snapshot() || {};
      evidence.collect = {
        targetItem: goal.target.blockId,
        targetPosition: goal.target.position,
        result: collected,
        inventoryDelta: inventoryDelta(before.inventory, after.inventory)
      };
      console.log('collect:', JSON.stringify({
        outcome: collected.outcome,
        collectedDelta: collected.collectedDelta,
        reason: collected.reason,
        actions: collected.attemptedActions
      }));
      if (collected.outcome !== 'verified') exitCode = 1;
    }
  }

  evidence.logs = log.slice(-120);
  const dir = path.join(cfg.paths.root, 'runtime', 'mining-live');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${args.label || args.mode}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  console.log(`evidence: ${path.relative(cfg.paths.root, file)}`);
  await body.disconnect().catch(() => {});
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error('mining live test failed:', err.stack || err.message);
  process.exitCode = 1;
});
