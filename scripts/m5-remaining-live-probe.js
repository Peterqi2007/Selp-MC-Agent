'use strict';

/**
 * `node scripts/m5-remaining-live-probe.js` - the M5 items that can be driven without the operator.
 *
 * Covers:
 *   1. A21 挖掘长按   - aim at a block, hold attack until it breaks, ledger clean, no stray changes
 *   2. A21 库存变化   - the inventory changes underneath an open GUI; the agent must re-read and
 *                       must not act on the stale slot index
 *   3. F1'b 取消      - a running task is cancelled while a key is held (operator press)
 *   4. F1'b 任务结束  - a task ends normally while a key is held
 *   5. A07 单执行者   - while a task owns the body, the action-brain input channel is refused
 *                       while the operator channel still works (the ownership guard)
 *   6. A22 复用       - the same promoted GUI skill runs twice with zero model calls
 *
 * Everything is observed through the agent's own surfaces: `POST /command {via:"mc_step"}`
 * for the action channel, the operator channel for human actions, `/ui/state` for the body
 * owner and `!inputs` (read-only) for the ledger. The mod is only used out-of-band where the
 * test *needs* an external actor (moving a stack inside an open GUI).
 *
 * Usage: node scripts/m5-remaining-live-probe.js [--agent 8766] [--mod 8899]
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const AGENT_PORT = Number(argValue('--agent', 8766));
const MOD_PORT = Number(argValue('--mod', 8899));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));

const results = [];
const evidence = { startedAt: new Date().toISOString(), cases: {} };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function request(port, method, urlPath, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      timeout
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (err) { reject(new Error(`not JSON: ${text.slice(0, 160)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const step = (command) => request(AGENT_PORT, 'POST', '/command', { command, via: 'mc_step' });
const operator = (command) => request(AGENT_PORT, 'POST', '/command', { command });
const modCommand = (command) => request(MOD_PORT, 'POST', '/command', { command });
const modState = () => request(MOD_PORT, 'GET', '/state', undefined, 6000);
const uiState = () => request(AGENT_PORT, 'GET', '/ui/state', undefined, 8000);

function check(name, ok, detail) {
  results.push({ name, ok: ok === true, detail });
  process.stdout.write(`  ${ok === true ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 240)}`}\n`);
  return ok === true;
}

async function waitFor(fn, timeoutMs = 8000, interval = 150) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

async function ledger() {
  const receipt = await operator('inputs');
  return (receipt && receipt.result) || { count: null, held: [] };
}

const cellsOf = (state) => (state && state.blocks && state.blocks.cells) || (state && state.blocks) || {};
const slotView = (menu) => {
  const map = new Map();
  for (const slot of (menu && menu.slots) || []) {
    const index = Number(slot && (slot.slot !== undefined ? slot.slot : slot.i));
    if (!Number.isInteger(index)) continue;
    map.set(index, { item: slot.item || null, count: Number(slot.count) || 0 });
  }
  return map;
};

// ---------------------------------------------------------------- 1. dig long press
async function digLongPress() {
  process.stdout.write('\n1. A21 挖掘长按（对着方块按住 attack 直到破坏）\n');
  const state = await modState();
  const position = state.position;
  const cells = cellsOf(state);
  const breakable = new Set(['minecraft:grass_block', 'minecraft:dirt', 'minecraft:coarse_dirt', 'minecraft:podzol', 'minecraft:sand']);
  let target = null;
  for (const [key, block] of Object.entries(cells)) {
    if (!breakable.has(String(block))) continue;
    const [x, y, z] = key.split(',').map(Number);
    if (![x, y, z].every(Number.isFinite)) continue;
    const distance = Math.hypot(x + 0.5 - position.x, y + 0.5 - position.y, z + 0.5 - position.z);
    if (distance < 1.8 || distance > 4.2) continue;
    if (String(cells[`${x},${y + 1},${z}`]) !== 'minecraft:air') continue;
    if (!target || distance < target.distance) target = { x, y, z, distance, block: String(block) };
  }
  if (!check('1: a breakable block is within reach', Boolean(target), target)) return;

  /**
   * Aim, then TRUST THE CROSSHAIR: only the block the game actually reports under the
   * crosshair can be hit by a long press (occlusion and rounding make a coordinate-based
   * guess wrong often enough to matter). Try a few candidates until the game agrees.
   */
  const candidates = Object.entries(cells)
    .filter(([, block]) => breakable.has(String(block)))
    .map(([key]) => {
      const [x, y, z] = key.split(',').map(Number);
      return { x, y, z, distance: Math.hypot(x + 0.5 - position.x, y + 0.5 - position.y, z + 0.5 - position.z) };
    })
    .filter((entry) => entry.distance >= 1.8 && entry.distance <= 4.2
      && String(cells[`${entry.x},${entry.y + 1},${entry.z}`]) === 'minecraft:air')
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4);

  let aimedAt = null;
  let chosen = null;
  for (const candidate of candidates.length ? candidates : [target]) {
    await step(`lookat ${candidate.x + 0.5} ${candidate.y + 0.5} ${candidate.z + 0.5}`);
    await sleep(250);
    const receipt = await step('target');
    const seen = receipt && receipt.result;
    if (seen && seen.position
      && seen.position.x === candidate.x && seen.position.y === candidate.y && seen.position.z === candidate.z
      && breakable.has(String(seen.name))) {
      aimedAt = seen;
      chosen = candidate;
      break;
    }
  }
  if (!check('1: the crosshair is on a breakable block', Boolean(chosen), aimedAt)) return;
  target = { ...chosen, block: String(aimedAt.name) };

  const hold = await step('hold attack 1500');
  check('1: "hold attack 1500" accepted (mining long press)', hold && hold.ok === true, hold && (hold.reason || hold.result));
  const during = await ledger();
  evidence.cases.dig = { target, heldDuring: during.held };

  const broke = await waitFor(async () => {
    const after = await modState();
    const block = cellsOf(after)[`${target.x},${target.y},${target.z}`];
    return String(block) !== target.block ? String(block) : null;
  }, 6000);
  check('1: the block was actually broken by the long press', Boolean(broke), { now: broke, was: target.block });

  // The hold is bounded: the mod releases it on its own deadline, and the Node record carries
  // the same deadline (this run asked for 1500ms), so wait for that instead of guessing a sleep.
  const cleared = await waitFor(async () => {
    const state = await ledger();
    return state.count === 0 ? state : null;
  }, 5000, 100);
  check('1: the ledger is empty after the long press (bounded hold expires on its own)',
    Boolean(cleared), cleared && cleared.held);

  const world = await modState();
  const afterCells = cellsOf(world);
  let stray = 0;
  for (const [key, block] of Object.entries(afterCells)) {
    if (cells[key] !== block) stray += 1;
  }
  check('1: only that one cell changed', stray <= 1, { changedCells: stray });
  evidence.cases.dig.result = { now: broke, changedCells: stray, ledger: cleared && cleared.held };
}

// ---------------------------------------------------------------- 2. inventory change
async function inventoryChange() {
  process.stdout.write('\n2. A21 库存变化（界面开着时外部改动槽位）\n');
  const tap = await step('tap inventory');
  check('2: the inventory opened through the agent', tap && tap.ok === true, tap && (tap.reason || tap.ok));
  const menu = await waitFor(async () => {
    const receipt = await step('menu');
    return receipt && receipt.result && receipt.result.open ? receipt.result : null;
  }, 6000);
  if (!check('2: menu is readable', Boolean(menu), menu && menu.screen)) {
    await step('close');
    return;
  }
  const slots = slotView(menu);
  const source = [...slots.keys()].sort((a, b) => a - b)
    .find((i) => i >= 9 && i <= 44 && slots.get(i).item && slots.get(i).count > 0);
  const destination = [...Array(36)].map((_, k) => 9 + k).find((i) => !slots.has(i));
  if (!check('2: a source stack and an empty slot exist', source !== undefined && destination !== undefined, { source, destination })) {
    await step('close');
    return;
  }
  const original = slots.get(source);

  // Out-of-band change: the mod (not the agent) moves the stack while the GUI is open.
  const move1 = await modCommand(`click ${source} 0 pickup`);
  const move2 = await modCommand(`click ${destination} 0 pickup`);
  check('2: the stack was moved out-of-band (mod, not the agent)',
    Boolean(move1 && move1.ok) && Boolean(move2 && move2.ok), { move1: move1 && move1.ok, move2: move2 && move2.ok });
  await sleep(400);

  const refreshed = await step('menu');
  const freshSlots = slotView(refreshed && refreshed.result);
  check('2: a fresh read sees the change (source empty, destination holds the stack)',
    !(freshSlots.get(source) || {}).item && (freshSlots.get(destination) || {}).item === original.item,
    { source: freshSlots.get(source) || null, destination: freshSlots.get(destination) || null });

  // The stale-index click must not act on the old content: the receipt's own `before` shows
  // the refreshed state and nothing moves.
  const staleClick = await step(`click ${source} 0 pickup`);
  const receipt = staleClick && staleClick.result;
  const beforeAtSource = receipt && receipt.before && (receipt.before.slots || [])
    .find((slot) => slot.slot === source);
  check('2: clicking the stale index re-reads first and reports the new state',
    Boolean(staleClick && staleClick.ok === true) && !beforeAtSource,
    { beforeAtSource: beforeAtSource || null, changed: receipt && receipt.changed });
  check('2: the stale click moved nothing', Boolean(receipt) && receipt.changed === 0, receipt && receipt.changed);

  // Restore out-of-band so the world is left as found.
  await modCommand(`click ${destination} 0 pickup`);
  await modCommand(`click ${source} 0 pickup`);
  await sleep(400);
  const restored = await step('menu');
  const restoredSlots = slotView(restored && restored.result);
  check('2: the inventory was restored',
    (restoredSlots.get(source) || {}).item === original.item && !(restoredSlots.get(destination) || {}).item,
    { source: restoredSlots.get(source) || null, destination: restoredSlots.get(destination) || null });

  const close = await step('close');
  check('2: the screen closed', close && close.ok === true, close && (close.reason || close.ok));
  evidence.cases.inventoryChange = { source, destination, item: original.item, changed: receipt && receipt.changed };
}

// ---------------------------------------------------------------- shared: task helpers
async function bodyOwner() {
  const state = await uiState();
  return (state && state.hub && state.hub.slot) || null;
}

async function startSlowTask() {
  const receipt = await operator('code-skill agent.slow_wait');
  return receipt && receipt.result;
}

// ---------------------------------------------------------------- 3. cancel
async function cancelWhileHolding() {
  process.stdout.write('\n3. F1\'b 取消（任务被取消时按住键）\n');
  const started = await startSlowTask();
  check('3: the long task was accepted', Boolean(started && started.accepted !== false), started);

  const owned = await waitFor(async () => {
    const slot = await bodyOwner();
    return slot && slot.owned ? slot : null;
  }, 8000);
  check('3: a task owns the body (A07 observability)', Boolean(owned) && owned.kind === 'brain', owned);

  // A07: the action brain must be refused while the task owns the body...
  const brainPress = await step('key sprint down');
  check('3/A07: the action-brain input channel is refused while a task owns the body',
    Boolean(brainPress && brainPress.ok === false) && /body-busy/.test(String(brainPress.reason || brainPress.error)),
    brainPress && (brainPress.reason || brainPress.error));

  // ...while the operator keeps control and presses a key.
  const operatorPress = await operator('key sprint down');
  check('3: the operator can still press a key', operatorPress && operatorPress.ok !== false, operatorPress && (operatorPress.reason || operatorPress.ok));
  const held = await waitFor(async () => {
    const state = await ledger();
    return state.count >= 1 ? state : null;
  }, 4000);
  check('3: the ledger shows the held key', Boolean(held), held && held.held);

  const stopAt = Date.now();
  const stop = await operator('stop');
  const cleared = await waitFor(async () => {
    const state = await ledger();
    return state.count === 0 ? state : null;
  }, 5000, 80);
  const elapsed = Date.now() - stopAt;
  check('3: cancelling cleared the ledger', Boolean(cleared), { elapsedMs: elapsed });
  const release = cleared && (cleared.lastReleases || [])[cleared.lastReleases.length - 1];
  check('3: the release came from the stop/cancel path',
    Boolean(release) && ['owner-stop', 'task-end'].includes(release.reason),
    release);
  await operator('resume');
  evidence.cases.cancel = { elapsedMs: elapsed, release };
}

// ---------------------------------------------------------------- 4. task end
async function taskEndWhileHolding() {
  process.stdout.write('\n4. F1\'b 任务结束（任务正常结束时按住键）\n');
  const started = await startSlowTask();
  check('4: the long task was accepted', Boolean(started && started.accepted !== false), started);
  const owned = await waitFor(async () => {
    const slot = await bodyOwner();
    return slot && slot.owned ? slot : null;
  }, 8000);
  if (!check('4: a task owns the body', Boolean(owned), owned)) return;

  const press = await operator('key sprint down');
  check('4: the operator pressed a key during the task', press && press.ok !== false, press && (press.reason || press.ok));
  await waitFor(async () => ((await ledger()).count >= 1 ? true : null), 3000);

  const settled = await waitFor(async () => {
    const slot = await bodyOwner();
    return slot && !slot.owned ? true : null;
  }, 40000, 300);
  check('4: the task settled on its own', Boolean(settled));

  const cleared = await waitFor(async () => {
    const state = await ledger();
    return state.count === 0 ? state : null;
  }, 5000, 80);
  check('4: the ledger is empty after the task ended', Boolean(cleared), cleared && cleared.held);
  const release = cleared && (cleared.lastReleases || []).slice().reverse().find((entry) => entry.reason === 'task-end');
  check('4: a task-end release record exists', Boolean(release), release || (cleared && cleared.lastReleases));
  evidence.cases.taskEnd = { release };
  await operator('key sprint up').catch(() => null);
}

// ---------------------------------------------------------------- 5. A22 reuse
async function reuseCost() {
  process.stdout.write('\n5. A22 复用（同一晋升技能跑两次，模型调用差值）\n');
  const usagePath = path.join(ROOT, 'runtime', 'llm-usage.jsonl');
  const readLines = () => {
    try { return fs.readFileSync(usagePath, 'utf8').split('\n').filter(Boolean); } catch { return []; }
  };
  const before = readLines();
  const runs = [];
  for (const round of [1, 2]) {
    const receipt = await operator('code-skill agent.inventory_cycle_live3');
    const accepted = Boolean(receipt && receipt.result && receipt.result.accepted !== false);
    check(`5: run ${round} of the promoted GUI skill was accepted`, accepted, receipt && receipt.result);
    const settled = await waitFor(async () => {
      const slot = await bodyOwner();
      return slot && !slot.owned ? true : null;
    }, 30000, 250);
    check(`5: run ${round} settled`, Boolean(settled));
    runs.push({ round, accepted, settled: Boolean(settled) });
  }
  const after = readLines();
  const added = after.slice(before.length);
  const kinds = added.map((line) => {
    try { return JSON.parse(line).kind || 'unknown'; } catch { return 'unparsed'; }
  });
  const generated = kinds.filter((kind) => String(kind).startsWith('code-generation'));
  /**
   * A22 asks for a computable delta, not for zero: the announcement of a finished task goes
   * through the language layer (roleplay) and legitimately costs a call. What must not happen
   * is a *generation* call - reuse means the skill already exists.
   */
  check('5: reuse generated no new code (no code-generation call)',
    generated.length === 0, { kinds, added: added.length });
  check('5: the delta is small and attributable to the language layer',
    added.length <= 2 && kinds.every((kind) => String(kind).startsWith('language:')),
    { added: added.length, kinds });
  evidence.cases.reuse = { usageLinesBefore: before.length, usageLinesAfter: after.length, added, kinds, runs };
}

async function main() {
  process.stdout.write(`M5 remaining live items (agent ${AGENT_PORT}, mod ${MOD_PORT})\n`);
  const pre = await modState().catch((err) => ({ error: err.message }));
  if (!check('the client is in a world', Boolean(pre && pre.ready === true), pre && (pre.error || pre.screen))) return;
  if (!check('the player is alive', pre.dead !== true, { dead: pre.dead, health: pre.health })) return;
  const preLedger = await ledger();
  if (!check('the ledger starts empty', preLedger.count === 0, preLedger.held)) return;

  await digLongPress();
  await inventoryChange();
  await cancelWhileHolding();
  await taskEndWhileHolding();
  await reuseCost();

  const failed = results.filter((entry) => !entry.ok);
  evidence.finishedAt = new Date().toISOString();
  evidence.checks = results.length;
  evidence.passed = results.length - failed.length;
  evidence.failed = failed.length;
  evidence.failures = failed.map((entry) => ({ name: entry.name, detail: entry.detail }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `m5-remaining-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`\n${evidence.passed}/${evidence.checks} checks passed\n`);
  process.stdout.write(`evidence: ${path.relative(ROOT, file)}\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
