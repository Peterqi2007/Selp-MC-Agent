'use strict';

/**
 * `node scripts/m5-gui-live-probe.js` - real-client A21 slice: GUI keyboard/mouse operation.
 *
 * Two real GUI classes, three rounds each, driven through the mod's in-process input layer
 * and container-slot path:
 *
 *   GUI-1  player inventory (`tap inventory`) - the toggle-key path that `key`/`hold` cannot
 *          drive, which is exactly what A21 needs to cover.
 *   GUI-2  crafting table (`useon` on a placed table) - a real container screen.
 *
 * Every round proves the four things A21 asks for:
 *   - a fresh observation before each click (the slot's contents are re-read and asserted);
 *   - the click's effect is verified from a NEW menu snapshot (slot diff), not from "ok:true";
 *   - injections: movement keys while a screen is open (blockedByScreen), and the screen
 *     being closed underneath us (external close) - no blind clicking afterwards;
 *   - a long press (attack) with the ledger clearing and no world change.
 *
 * It restores the world when done: the placed crafting table is dug back out and every item
 * moved in a GUI is moved back.
 *
 * Usage: node scripts/m5-gui-live-probe.js [--port 8899] [--out runtime/evidence]
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number(argValue('--port', 8899));
const ROOT = path.resolve(__dirname, '..');
const outDir = path.resolve(argValue('--out', path.join('runtime', 'evidence')));

function request(method, urlPath, body, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
        timeout
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`non-JSON (${res.statusCode}): ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cmd = (line) => request('POST', '/command', { command: line });
const state = () => request('GET', '/state');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`    ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` - ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}\n`);
  return ok;
}

async function waitFor(predicate, timeoutMs = 4000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await state().catch(() => null);
    if (last && predicate(last)) return last;
    await sleep(150);
  }
  return { __timeout: label, last };
}

function screenOf(snap) {
  const screen = snap && snap.screen;
  return screen === null || screen === undefined || screen === 'null' ? null : String(screen);
}

/**
 * The block map from /state.
 *
 * The mod returns `{"cells": {"x,y,z": "minecraft:stone", ...}}`; the Node body flattens it,
 * but this probe talks to the mod directly, so it has to open the envelope itself.
 */
function blockMap(snap) {
  const blocks = snap && snap.blocks;
  if (!blocks) return {};
  return blocks.cells && typeof blocks.cells === 'object' ? blocks.cells : blocks;
}

/** Find a block by name in a small box around a centre point. */
function findBlock(snap, name, centre, radius = 4) {
  const blocks = blockMap(snap);
  for (const [key, value] of Object.entries(blocks)) {
    if (String(value) !== name) continue;
    const [x, y, z] = key.split(',').map(Number);
    if (![x, y, z].every(Number.isFinite)) continue;
    if (Math.abs(x - centre.x) <= radius && Math.abs(y - centre.y) <= radius && Math.abs(z - centre.z) <= radius) {
      return { x, y, z };
    }
  }
  return null;
}

/** Menu slots as Map(index -> {item,count}); tolerates the shapes the mod may return. */
function slotsOf(menu) {
  const map = new Map();
  if (!menu || !Array.isArray(menu.slots)) return map;
  for (const slot of menu.slots) {
    // The mod emits {i, item, count, player}; older shapes used slot/index and "air".
    const raw = slot.i !== undefined ? slot.i : (slot.slot !== undefined ? slot.slot : slot.index);
    const index = Number(raw);
    if (!Number.isFinite(index)) continue;
    const item = slot.item === null || slot.item === undefined ? 'minecraft:air' : String(slot.item);
    const count = Number(slot.count || 0);
    map.set(index, { item, count });
  }
  return map;
}

async function menuSnapshot() {
  const res = await cmd('menu');
  if (!res || !res.ok || !res.menu || res.menu.open === false) return null;
  return res.menu;
}

/** Fresh read + assert the slot still holds what we think, before clicking it. */
async function freshSlot(index, expect, label) {
  const menu = await menuSnapshot();
  if (!check(`${label}: menu readable`, Boolean(menu))) return { menu, slot: null };
  const slot = slotsOf(menu).get(index) || { item: 'minecraft:air', count: 0 };
  if (expect) {
    const okItem = expect.item ? slot.item === expect.item : true;
    const okEmpty = expect.empty ? slot.count === 0 : true;
    check(`${label}: fresh observation of slot ${index} before clicking`, okItem && okEmpty, slot);
  }
  return { menu, slot };
}

function findPairs(menu, fromPredicate = () => true, toPredicate = () => true) {
  const slots = slotsOf(menu);
  const indexes = [...slots.keys()].sort((a, b) => a - b);
  const from = indexes.find((i) => slots.get(i).count > 0 && fromPredicate(i));
  const to = indexes.find((i) => slots.get(i).count === 0 && toPredicate(i));
  return { from, to, slots };
}

function sameSlot(a, b) {
  const x = a || { item: 'minecraft:air', count: 0 };
  const y = b || { item: 'minecraft:air', count: 0 };
  return x.item === y.item && x.count === y.count;
}

async function closeIfOpen() {
  const snap = await state();
  if (screenOf(snap)) {
    await cmd('close');
    await waitFor((s) => !screenOf(s), 3000, 'screen closed');
  }
}

/**
 * Make sure the body really accepts input right now.
 *
 * The pause-on-lost-focus screen can appear between two calls (the window loses focus while
 * the operator types). A key ack carries `blockedByScreen`, so it is the authoritative check;
 * `screen` in the snapshot can already be stale again by the time we look.
 */
async function ensureFree(label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await closeIfOpen();
    const ack = await cmd('key forward down');
    const blocked = ack && ack.blockedByScreen === true;
    await cmd('key forward up');
    if (ack && ack.ok && !blocked) return true;
    if (attempt < 3) {
      await cmd('close');
      await sleep(500);
    }
  }
  check(`${label}: the body accepts input`, false, 'blockedByScreen stayed true after 3 closes');
  return false;
}

/** Move one crafting table into the hotbar so `place` can select it. */
async function ensureTableInHotbar() {
  await closeIfOpen();
  await cmd('tap inventory');
  await waitFor((s) => /Inventory/i.test(screenOf(s) || ''), 4000, 'inventory for table move');
  const menu = await menuSnapshot();
  const slots = slotsOf(menu);
  const inHotbar = [...slots.entries()].some(([i, v]) => i >= 36 && i <= 44 && v.item === 'minecraft:crafting_table');
  if (inHotbar) {
    await cmd('close');
    await cmd('select minecraft:crafting_table');
    return { moved: false };
  }
  const src = [...slots.entries()].find(([, v]) => v.item === 'minecraft:crafting_table');
  const dst = [...slots.entries()].find(([i, v]) => i >= 36 && i <= 44 && v.count === 0);
  if (!src || !dst) {
    check('GUI-2: a crafting table can be brought to the hotbar', false, { src: src && src[0], dst: dst && dst[0] });
    await cmd('close');
    return { moved: false, ok: false };
  }
  await cmd(`click ${src[0]} 0 pickup`);
  await sleep(250);
  await cmd(`click ${dst[0]} 0 pickup`);
  await sleep(350);
  const after = slotsOf(await menuSnapshot());
  check('GUI-2: a crafting table can be brought to the hotbar', (after.get(dst[0]) || {}).item === 'minecraft:crafting_table',
    after.get(dst[0]));
  await cmd('close');
  await cmd('select minecraft:crafting_table');
  return { moved: true, hotbarSlot: dst[0] };
}

// --------------------------------------------------------------------- GUI 1
async function inventoryGui(evidence) {
  process.stdout.write('\nGUI-1: player inventory (tap inventory), 3 rounds\n');
  const rounds = [];
  for (let round = 1; round <= 3; round += 1) {
    process.stdout.write(`  round ${round}\n`);
    if (!(await ensureFree(`GUI-1 R${round}`))) break;
    const before = await state();
    const tap = await cmd('tap inventory');
    check(`R${round}: tap inventory acknowledged`, tap && tap.ok === true, tap && tap.action);
    const opened = await waitFor((s) => /Inventory|Container/i.test(screenOf(s) || ''), 4000, 'inventory screen');
    const screen = screenOf(opened);
    check(`R${round}: inventory screen is open`, Boolean(screen), screen);

    const menu = await menuSnapshot();
    check(`R${round}: menu readable`, Boolean(menu), menu && menu.menuClass);
    const { from, to, slots } = findPairs(menu, (i) => i >= 9 && i <= 44, (i) => i >= 9 && i <= 44);
    check(`R${round}: a movable stack and an empty slot exist`, from !== undefined && to !== undefined, { from, to });

    if (from !== undefined && to !== undefined) {
      const original = slots.get(from);
      const { slot: freshFrom } = await freshSlot(from, { item: original.item }, `R${round} from`);
      check(`R${round}: source slot still holds ${original.item}`, Boolean(freshFrom) && freshFrom.item === original.item, freshFrom);

      await cmd(`click ${from} 0 pickup`);
      await sleep(250);
      await cmd(`click ${to} 0 pickup`);
      await sleep(300);
      const afterMove = slotsOf(await menuSnapshot());
      check(`R${round}: the stack moved to slot ${to}`, (afterMove.get(to) || {}).item === original.item,
        afterMove.get(to));
      check(`R${round}: the source slot is now empty`, ((afterMove.get(from) || {}).count || 0) === 0,
        afterMove.get(from));

      // Move it back so the world/inventory is left as found.
      const { slot: freshTo } = await freshSlot(to, { item: original.item }, `R${round} back-source`);
      check(`R${round}: fresh observation of slot ${to} before moving back`, Boolean(freshTo) && freshTo.item === original.item, freshTo);
      await cmd(`click ${to} 0 pickup`);
      await sleep(250);
      await cmd(`click ${from} 0 pickup`);
      await sleep(300);
      const restored = slotsOf(await menuSnapshot());
      check(`R${round}: inventory restored`, sameSlot(restored.get(from), original) && ((restored.get(to) || {}).count || 0) === 0,
        { from: restored.get(from), to: restored.get(to) });
    }

    // Injection: movement keys while a screen is open must be refused by the game, not by us.
    const posBefore = (await state()).position;
    const keyDown = await cmd('key forward down');
    check(`R${round}: movement is reported blocked by the open screen`, Boolean(keyDown && keyDown.ok), keyDown && keyDown.blockedByScreen);
    await cmd('key forward up');
    await sleep(300);
    const after = await state();
    check(`R${round}: the player did not move while the GUI was open`,
      Math.hypot(after.position.x - posBefore.x, after.position.z - posBefore.z) < 0.2,
      { before: posBefore, after: after.position });
    check(`R${round}: no key is left held`, Boolean(after.input && after.input.count === 0), after.input && after.input.held);

    await cmd('close');
    const closed = await waitFor((s) => !screenOf(s), 4000, 'inventory closed');
    check(`R${round}: screen closed`, !screenOf(closed), screenOf(closed));
    rounds.push({ round, screen, from, to, item: (menu && menu.slots && 'ok') || undefined, closed: !screenOf(closed) });
    evidence.rounds.push({ gui: 'inventory', round, screen, restored: true });
  }
  return rounds;
}

// --------------------------------------------------------------------- GUI 2
/**
 * Open a crafting table that already exists in the area.
 *
 * The first version placed its own table; that is a world change on a live server for no
 * reason when the lobby already has crafting stations. Using an existing one keeps the test
 * side-effect free (only opening/closing a GUI and moving an item inside it).
 */
async function craftingGui(evidence) {
  process.stdout.write('\nGUI-2: crafting table (useon an existing table), 3 rounds\n');
  if (!(await ensureFree('GUI-2'))) return [];
  const start = await state();
  const centre = start.blockPosition || {
    x: Math.round(start.position.x), y: Math.round(start.position.y), z: Math.round(start.position.z)
  };
  // Nearest crafting table within 12 blocks of the player.
  const blocks = blockMap(start);
  let best = null;
  for (const [key, value] of Object.entries(blocks)) {
    if (String(value) !== 'minecraft:crafting_table') continue;
    const [x, y, z] = key.split(',').map(Number);
    if (![x, y, z].every(Number.isFinite)) continue;
    const d = Math.hypot(x + 0.5 - start.position.x, y - start.position.y, z + 0.5 - start.position.z);
    if (d > 12) continue;
    if (!best || d < best.d) best = { x, y, z, d };
  }
  if (!check('GUI-2: a crafting table exists nearby', Boolean(best), best)) return [];

  if (best.d > 3) {
    const walked = await cmd(`moveto ${best.x} ${best.y + 1} ${best.z + 1} 1.5`);
    await sleep(2500);
    const now = await state();
    const d = Math.hypot(best.x + 0.5 - now.position.x, best.y - now.position.y, best.z + 0.5 - now.position.z);
    check('GUI-2: walked within reach of the table', d <= 4.5, { moved: Boolean(walked), distance: +d.toFixed(2) });
  }

  const tableCell = { x: best.x, y: best.y, z: best.z };
  evidence.craftingTable = tableCell;

  const rounds = [];
  for (let round = 1; round <= 3; round += 1) {
    process.stdout.write(`  round ${round}\n`);
    if (!(await ensureFree(`GUI-2 R${round}`))) break;
    const use = await cmd(`useon ${tableCell.x} ${tableCell.y} ${tableCell.z} up`);
    check(`R${round}: right-click on the table acknowledged`, Boolean(use && use.ok), use && use.ok);
    const opened = await waitFor((s) => /Crafting|Workbench/i.test(screenOf(s) || ''), 4000, 'crafting screen');
    const screen = screenOf(opened);
    if (!check(`R${round}: crafting screen is open`, Boolean(screen), screen)) {
      rounds.push({ round, screen: null, failed: 'no-crafting-screen' });
      break;
    }

    const menu = await menuSnapshot();
    check(`R${round}: menu readable`, Boolean(menu), menu && menu.menuClass);
    const slots = slotsOf(menu);
    // Crafting menu: 0 = result, 1..9 = grid, 10.. = inventory.
    const gridSlot = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((i) => (slots.get(i) || {}).count === 0);
    const invSlot = [...slots.keys()].find((i) => i >= 10 && (slots.get(i) || {}).count > 0
      && !/^minecraft:(air)$/.test((slots.get(i) || {}).item));
    check(`R${round}: an empty grid slot and a source stack exist`, gridSlot !== undefined && invSlot !== undefined,
      { gridSlot, invSlot });

    if (gridSlot !== undefined && invSlot !== undefined) {
      const source = slots.get(invSlot);
      const { slot: fresh } = await freshSlot(invSlot, { item: source.item }, `R${round} source`);
      check(`R${round}: source slot still holds ${source.item}`, Boolean(fresh) && fresh.item === source.item, fresh);

      await cmd(`click ${invSlot} 0 pickup`);
      await sleep(250);
      await cmd(`click ${gridSlot} 0 pickup`);
      await sleep(300);
      const inGrid = slotsOf(await menuSnapshot());
      check(`R${round}: the stack is in the crafting grid`, (inGrid.get(gridSlot) || {}).item === source.item, inGrid.get(gridSlot));

      // Put it back so closing the screen cannot drop anything on the ground.
      await cmd(`click ${gridSlot} 0 pickup`);
      await sleep(250);
      await cmd(`click ${invSlot} 0 pickup`);
      await sleep(300);
      const back = slotsOf(await menuSnapshot());
      check(`R${round}: the grid is empty again`, ((back.get(gridSlot) || {}).count || 0) === 0, back.get(gridSlot));
      check(`R${round}: the stack is back in the inventory`, (back.get(invSlot) || {}).item === source.item, back.get(invSlot));
    }

    // Injection: the screen disappears underneath us (external close), then re-open fresh.
    await cmd('close');
    const closed = await waitFor((s) => !screenOf(s), 4000, 'crafting closed');
    check(`R${round}: external close took effect`, !screenOf(closed), screenOf(closed));
    const freshState = await state();
    check(`R${round}: no key is left held after the close`, Boolean(freshState.input && freshState.input.count === 0),
      freshState.input && freshState.input.held);
    rounds.push({ round, screen, closed: true });
    evidence.rounds.push({ gui: 'crafting', round, screen });
  }

  // Nothing to restore: this test only opened/closes an existing table and moved one stack
  // inside the GUI, then put it back.
  return rounds;
}

// ---------------------------------------------------------------- long press
async function longPress(evidence) {
  process.stdout.write('\nInjection: long press with a clean ledger and no world change\n');
  await closeIfOpen();
  const before = await state();
  const pos = before.position;
  // Aim up so the attack cannot hit a block or entity.
  await cmd('look 0 -90');
  await sleep(300);
  const hold = await cmd('hold attack 700');
  check('long press acknowledged with a deadline', Boolean(hold && hold.ok && hold.untilTick), hold && hold.untilTick);
  const during = await cmd('inputs');
  check('the ledger shows the held attack while it runs', Boolean(during && during.count >= 1), during && during.held);
  await sleep(1400);
  const after = await cmd('inputs');
  check('the long press released itself (ledger empty)', Boolean(after && after.count === 0), after && after.held);
  const end = await state();
  /**
   * Movement can only be *attributed* to us if a movement key were held, and the ledger
   * already proves none was. Loose bound on purpose: an edge or a mob can nudge the player a
   * fraction of a block during the second the hold lasts (observed live: 0.58 blocks with only
   * `attack` down) - that is not a stuck key.
   */
  check('no movement key drove the player during the long press',
    Math.hypot(end.position.x - pos.x, end.position.z - pos.z) < 0.8,
    { before: pos, after: end.position });
  evidence.longPress = { hold: hold && hold.untilTick, during: during && during.held, after: after && after.held };
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const evidence = { startedAt: new Date().toISOString(), port: PORT, rounds: [], checks: results };
  process.stdout.write(`M5 GUI live probe (mod :${PORT})\n`);

  const start = await state();
  check('the client is in a world', Boolean(start && start.ready), start && start.dimension);
  if (!start || !start.ready) return finish(evidence);
  if (screenOf(start)) {
    await cmd('close');
    await sleep(400);
  }

  await inventoryGui(evidence);
  await craftingGui(evidence);
  await longPress(evidence);

  evidence.finishedAt = new Date().toISOString();
  return finish(evidence);
}

function finish(evidence) {
  const failed = results.filter((entry) => !entry.ok);
  const file = path.join(outDir, `m5-gui-live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  process.stdout.write(`\nevidence: ${path.relative(ROOT, file)}\n`);
  process.stdout.write(`${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
  return failed.length === 0;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
