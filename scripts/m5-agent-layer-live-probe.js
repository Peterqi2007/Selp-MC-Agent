'use strict';

/**
 * `node scripts/m5-agent-layer-live-probe.js` - A21 re-run through the AGENT layer.
 *
 * Why this file exists: the 2026-10-29 A21 slice drove the mod's HTTP port directly, so the
 * milestone stayed "partial (probe only)". This probe performs every *action* through the
 * agent's own command table (`POST /command` with `via:"mc_step"`, i.e. the same path the DSH
 * action brain uses, escalation gate included) and every *observation* through the agent's
 * state projection.
 *
 * It covers the A21 proposition as written in docs/P1-M5.md §7.4:
 *   - two real GUI classes, three rounds each (player inventory, crafting table);
 *   - fresh observation before each click and the effect verified from a NEW snapshot
 *     (`!click` returns the slot diff), never from "it said ok";
 *   - injections: movement keys while a screen is open, the screen closed underneath us,
 *     and a long press with the ledger clearing and no world change.
 *
 * Usage: node scripts/m5-agent-layer-live-probe.js [--agent 8766] [--mod 8899] [--out runtime/evidence]
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
const evidence = { startedAt: new Date().toISOString(), layer: 'agent', rounds: [], injections: {} };

function request(port, method, urlPath, body, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
        : {},
      timeout
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (err) { reject(new Error(`${method} ${urlPath}: not JSON: ${text.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout ${method} ${urlPath}`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Every action goes through the agent's command table, exactly like the action brain. */
const step = (command) => request(AGENT_PORT, 'POST', '/command', { command, via: 'mc_step' });
/** The operator answering the consent desk (`!yes`) - not an action, so it is not `mc_step`. */
const operatorSay = (command) => request(AGENT_PORT, 'POST', '/command', { command });
const modCommand = (command) => request(MOD_PORT, 'POST', '/command', { command });

/**
 * One observation: the agent's own projection (`/ui/state`: identity + world) plus the block
 * map, which only the mod exposes (`/state`). Actions never go to the mod directly.
 */
async function liveState() {
  const [ui, mod] = await Promise.all([
    request(AGENT_PORT, 'GET', '/ui/state').catch(() => null),
    request(MOD_PORT, 'GET', '/state').catch(() => null)
  ]);
  const world = (ui && ui.world) || {};
  const rawBlocks = (mod && mod.blocks) || null;
  return {
    ui,
    mod,
    player: ui && ui.identity ? ui.identity.name : null,
    position: world.position || null,
    screen: world.screen || null,
    screenOpen: Boolean(world.screenOpen),
    health: world.health,
    blocks: (rawBlocks && rawBlocks.cells) || rawBlocks || {}
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail) {
  results.push({ name, ok: ok === true, detail });
  const mark = ok === true ? 'PASS' : 'FAIL';
  const extra = detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 240)}`;
  process.stdout.write(`  ${mark} ${name}${extra}\n`);
  return ok === true;
}

async function waitFor(fn, timeoutMs = 6000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

const screenOf = (state) => (state && state.screen) || null;

function blockMap(state) {
  return (state && state.blocks) || {};
}

/** The `menu` verb answers through the command receipt; normalise the useful part. */
function menuOf(receipt) {
  if (!receipt) return null;
  const result = receipt.result !== undefined ? receipt.result : receipt;
  if (!result) return null;
  if (result.open === false) return null;
  return result;
}

async function readMenu() {
  const receipt = await step('menu');
  return { receipt, menu: menuOf(receipt) };
}

async function inputState() {
  const receipt = await step('inputs');
  const result = receipt && (receipt.result || receipt);
  return result || null;
}

function slotsOf(menu) {
  const map = new Map();
  for (const slot of (menu && menu.slots) || []) {
    const index = Number(slot && (slot.slot !== undefined ? slot.slot : slot.i));
    if (!Number.isInteger(index)) continue;
    map.set(index, { item: slot.item || null, count: Number(slot.count) || 0 });
  }
  return map;
}

// ---------------------------------------------------------------- GUI 1
async function inventoryGui() {
  process.stdout.write('\nGUI-1 (agent layer): player inventory via "tap inventory", 3 rounds\n');
  let opened = 0;
  for (let round = 1; round <= 3; round += 1) {
    process.stdout.write(` round ${round}\n`);
    const tap = await step('tap inventory');
    if (!check(`R${round}: agent accepted "tap inventory"`, tap && tap.ok === true, tap && (tap.error || tap.result))) break;

    const seen = await waitFor(async () => {
      const { menu } = await readMenu();
      return menu && /Inventory/i.test(menu.menuClass || '') ? menu : null;
    }, 6000);
    if (!check(`R${round}: the inventory screen is open (fresh read)`, Boolean(seen), seen && seen.menuClass)) {
      await step('close');
      continue;
    }
    opened += 1;

    const slots = slotsOf(seen);
    const from = [...slots.keys()].sort((a, b) => a - b)
      .find((i) => i >= 9 && i <= 44 && slots.get(i).item && slots.get(i).count > 0);
    // Empty slots are absent from the snapshot, not present with item:null - that is why
    // this searches the slot number space instead of the map's keys.
    const to = [...Array(36)].map((_, k) => 9 + k).find((i) => !slots.has(i));
    if (!check(`R${round}: a movable stack and an empty slot exist`, from !== undefined && to !== undefined, { from, to })) {
      await step('close');
      continue;
    }
    const original = slots.get(from);

    const move = await step(`click ${from} 0 pickup`);
    check(`R${round}: click on slot ${from} reported a slot diff`,
      Boolean(move && move.ok === true && move.result && move.result.changed >= 1),
      move && move.result && { changed: move.result.changed, changes: move.result.changes });

    const place = await step(`click ${to} 0 pickup`);
    const placed = place && place.result && place.result.after
      ? slotsOf(place.result.after).get(to) || null
      : null;
    check(`R${round}: the stack landed in slot ${to} (verified from a NEW snapshot)`,
      Boolean(placed) && placed.item === original.item, { placed, expected: original.item });

    // Put it back: the world/inventory must be left exactly as found.
    await step(`click ${to} 0 pickup`);
    const back = await step(`click ${from} 0 pickup`);
    const restored = back && back.result && back.result.after ? slotsOf(back.result.after) : null;
    check(`R${round}: inventory restored (slot ${from} holds ${original.item}, slot ${to} empty)`,
      Boolean(restored) && (restored.get(from) || {}).item === original.item && !((restored.get(to) || {}).count),
      { from: restored && restored.get(from), to: restored && restored.get(to) });

    // Injection: a movement key while a screen is open must be blocked by the game.
    const before = await liveState();
    const keyDown = await step('key forward down');
    const blocked = keyDown && keyDown.result ? keyDown.result.blockedByScreen : undefined;
    check(`R${round}: movement while the GUI is open is reported blocked by the screen`,
      keyDown && keyDown.ok === true, { blockedByScreen: blocked });
    await step('key forward up');
    await sleep(351);
    const after = await liveState();
    const drift = Math.hypot((after.position.x || 0) - (before.position.x || 0), (after.position.z || 0) - (before.position.z || 0));
    check(`R${round}: the player did not move while the GUI was open`, drift < 0.2, { drift: +drift.toFixed(3) });

    const ledger = await inputState();
    check(`R${round}: no key is left held`, Boolean(ledger && ledger.count === 0), ledger && ledger.held);

    const close = await step('close');
    const closed = await waitFor(async () => {
      const { menu } = await readMenu();
      return menu === null ? true : null;
    }, 5000);
    check(`R${round}: screen closed`, Boolean(closed) && Boolean(close && close.ok), { close: close && close.ok });
    evidence.rounds.push({ gui: 'inventory', round, from, to, item: original.item, closed: Boolean(closed) });
  }
  return opened;
}

// ---------------------------------------------------------------- helpers
/** Pick a walkable cell next to a block (feet + head air, solid below). */
function adjacentStand(table, blocks) {
  const map = blocks || {};
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = table.x + dx;
    const z = table.z + dz;
    const below = map[`${x},${table.y - 1},${z}`];
    const feet = map[`${x},${table.y},${z}`];
    const head = map[`${x},${table.y + 1},${z}`];
    if (below && below !== 'minecraft:air' && feet === 'minecraft:air' && head === 'minecraft:air') {
      return { x, y: table.y, z };
    }
  }
  return { x: table.x + 1, y: table.y, z: table.z };
}

/** Walk to a cell through the command channel and wait until we are actually there. */
async function approach(target, range = 4.5, timeoutMs = 30000) {
  const before = await liveState();
  const receipt = await step(`goto ${target.x} ${target.y} ${target.z}`);
  const within = await waitFor(async () => {
    const state = await liveState();
    if (!state.position) return null;
    const distance = Math.hypot(state.position.x - target.x, state.position.y - target.y, state.position.z - target.z);
    return distance <= range ? distance : null;
  }, timeoutMs);
  return { accepted: Boolean(receipt && receipt.ok), target, within, from: before.position };
}

/**
 * Which hotbar slot is empty (an empty hand opens a table; a held sword does not).
 * Returns 1-based hotbar indices, because that is what `key hotbarN` presses.
 */
async function pickEmptyHotbar() {
  await step('tap inventory');
  const menu = await waitFor(async () => (await readMenu()).menu, 6000);
  if (!menu) return null;
  const slots = slotsOf(menu);
  const hotbar = [...Array(9)].map((_, i) => 36 + i);
  const emptySlot = hotbar.find((index) => !slots.has(index));
  const state = await liveState();
  const held = state.ui && state.ui.world ? state.ui.world.heldItem : null;
  const heldSlot = held ? hotbar.find((index) => (slots.get(index) || {}).item === held) : undefined;
  await step('close');
  return {
    empty: emptySlot === undefined ? null : emptySlot - 35,
    held: heldSlot === undefined ? null : heldSlot - 35,
    heldItem: held || null
  };
}

// ---------------------------------------------------------------- GUI 2
async function craftingGui() {
  process.stdout.write('\nGUI-2 (agent layer): crafting table via "use", 3 rounds\n');
  const start = await liveState();
  const blocks = blockMap(start);
  const position = (start && start.position) || { x: 0, y: 0, z: 0 };
  let best = null;
  for (const [key, value] of Object.entries(blocks)) {
    if (String(value) !== 'minecraft:crafting_table') continue;
    const [x, y, z] = key.split(',').map(Number);
    if (![x, y, z].every(Number.isFinite)) continue;
    const distance = Math.hypot(x + 0.5 - position.x, y - position.y, z + 0.5 - position.z);
    if (distance > 12) continue;
    if (!best || distance < best.distance) best = { x, y, z, distance };
  }
  if (!check('GUI-2: a crafting table exists within 12 blocks', Boolean(best), best)) return 0;
  evidence.craftingTable = { x: best.x, y: best.y, z: best.z, distance: +best.distance.toFixed(2) };

  // A right click only reaches ~4.5 blocks: walk to a neighbouring cell first.
  const spot = adjacentStand(best, blocks);
  const walked = await approach(spot, 4.5);
  check('GUI-2: reached the cell next to the table through the command channel',
    Boolean(walked.accepted) && walked.within !== null, { target: spot, within: walked.within, from: walked.from });

  const hands = await pickEmptyHotbar();
  // A full inventory can have no empty hotbar slot; what the round needs is an empty HAND,
  // and the reflex may already have left the hand empty. Only insist on the precondition the
  // round actually uses.
  check('GUI-2: the hand can be made empty for the empty-hand right click',
    Boolean(hands && (hands.empty || !hands.heldItem)),
    hands && { empty: hands.empty, held: hands.held, heldItem: hands.heldItem });

  let opened = 0;
  for (let round = 1; round <= 3; round += 1) {
    process.stdout.write(` round ${round}\n`);
    if (hands && hands.empty) await step(`key hotbar${hands.empty}`);
    const emptyHanded = await liveState();
    check(`R${round}: the hand is empty before the right click`,
      !emptyHanded.ui || !emptyHanded.ui.world || !emptyHanded.ui.world.heldItem,
      emptyHanded.ui && emptyHanded.ui.world && emptyHanded.ui.world.heldItem);

    // `use` is permission-gated (mode=ask): the operator answers the consent desk. When no
    // question is pending the answer is simply rejected, which is not a failure of the test.
    const pendingUse = step(`use ${best.x} ${best.y} ${best.z} up`);
    await sleep(700);
    await operatorSay('yes').catch(() => null);
    const use = await pendingUse;
    check(`R${round}: agent accepted "use" on the table`, use && use.ok === true,
      use && (use.error || use.reason || use.result));

    const seen = await waitFor(async () => {
      const { menu } = await readMenu();
      return menu && /Crafting|Workbench/i.test(`${menu.screen || ''} ${menu.menuClass || ''}`) ? menu : null;
    }, 6000);
    if (!check(`R${round}: the crafting screen is open (fresh read)`, Boolean(seen),
      seen && (seen.screen || seen.menuClass))) {
      await step('close');
      if (hands && hands.held) await step(`key hotbar${hands.held}`);
      continue;
    }
    opened += 1;

    /**
     * One verifiable GUI operation per round, with one retry.
     *
     * On a busy server the screen can vanish mid-round (round 2 of the 2026-11-02 run lost it
     * exactly like that). The A21 rule is what makes this safe: after the screen is gone the
     * next click must be refused, never replayed against an index from the old screen. So the
     * retry re-opens the table and re-reads the menu instead of clicking again.
     */
    let outcome = null;
    for (let attempt = 1; attempt <= 2 && outcome === null; attempt += 1) {
      const menu = attempt === 1 ? seen : await openCrafting(best);
      if (!menu) break;
      outcome = await moveStackOnce(menu);
      if (!outcome.ok && attempt < 2) {
        await step('close');
        await sleep(400);
      }
    }
    if (outcome) evidence.rounds.push({
      gui: 'crafting',
      round,
      grid: outcome.grid,
      source: outcome.source,
      item: outcome.item,
      restored: outcome.restored,
      detail: outcome.detail
    });
    check(`R${round}: a stack went into the grid and came back (verified from NEW snapshots each time)`,
      Boolean(outcome && outcome.ok), outcome && outcome.detail);

    const close = await step('close');
    const closed = await waitFor(async () => {
      const { menu } = await readMenu();
      return menu === null ? true : null;
    }, 5000);
    const ledger = await inputState();
    check(`R${round}: screen closed with an empty ledger`,
      Boolean(closed) && Boolean(close && close.ok) && Boolean(ledger && ledger.count === 0),
      { closed: Boolean(closed), held: ledger && ledger.held });
    if (hands && hands.held) await step(`key hotbar${hands.held}`);
  }
  return opened;
}

/** Open the table through the agent (consent desk included) and wait for a fresh menu. */
async function openCrafting(best) {
  const pendingUse = step(`use ${best.x} ${best.y} ${best.z} up`);
  await sleep(700);
  await operatorSay('yes').catch(() => null);
  const use = await pendingUse;
  if (!use || use.ok !== true) return null;
  return waitFor(async () => {
    const { menu } = await readMenu();
    return menu && /Crafting|Workbench/i.test(`${menu.screen || ''} ${menu.menuClass || ''}`) ? menu : null;
  }, 6000);
}

/** Pick a stack up, drop it in an empty grid slot, then put it back - verifying each step. */
async function moveStackOnce(menu) {
  const slots = slotsOf(menu);
  const grid = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((i) => !slots.has(i));
  const source = [...slots.keys()].sort((a, b) => a - b)
    .find((i) => i >= 10 && slots.get(i).item && slots.get(i).count > 0);
  if (grid === undefined || source === undefined) {
    return { ok: false, grid, source, detail: { grid, source, reason: 'no-grid-or-source' } };
  }
  const original = slots.get(source);

  const pick = await step(`click ${source} 0 pickup`);
  const place = await step(`click ${grid} 0 pickup`);
  const after = place && place.result && place.result.after ? slotsOf(place.result.after) : null;
  if (!after) {
    // The screen died between the two clicks; do NOT click again against this screen.
    return {
      ok: false,
      grid,
      source,
      item: original.item,
      detail: {
        grid,
        source,
        reason: 'screen-closed-mid-round',
        pick: pick && (pick.reason || pick.ok),
        place: place && (place.reason || place.ok)
      }
    };
  }
  const inGrid = after.get(grid) || null;

  const backPick = await step(`click ${grid} 0 pickup`);
  const backPlace = await step(`click ${source} 0 pickup`);
  const restored = backPlace && backPlace.result && backPlace.result.after
    ? slotsOf(backPlace.result.after)
    : null;
  const restoredOk = Boolean(restored)
    && !((restored.get(grid) || {}).count)
    && (restored.get(source) || {}).item === original.item;
  const ok = Boolean(inGrid) && inGrid.item === original.item && restoredOk;
  return {
    ok,
    grid,
    source,
    item: original.item,
    restored: restoredOk,
    detail: {
      grid,
      source,
      expected: original.item,
      inGrid,
      restoredOk,
      back: backPick && (backPick.reason || backPick.ok)
    }
  };
}

// ---------------------------------------------------------------- injections
async function externalCloseInjection() {
  process.stdout.write('\nInjection: the screen is closed underneath the agent\n');
  const tap = await step('tap inventory');
  check('injection: inventory opened through the agent', tap && tap.ok === true, tap && tap.error);
  const opened = await waitFor(async () => (await readMenu()).menu, 6000);
  if (!check('injection: menu is open before the external close', Boolean(opened), opened && opened.menuClass)) return;

  // The game (or the player pressing Escape) closes the screen: the agent is NOT told.
  const external = await modCommand('close');
  check('injection: the screen was closed out-of-band (mod side, not the agent)', Boolean(external && external.ok), external && (external.ok || external.error));
  await sleep(600);

  const { menu } = await readMenu();
  check('injection: the agent observes the screen is gone', menu === null, menu && menu.menuClass);

  const blind = await step('click 9 0 pickup');
  check('injection: a click after the external close is refused instead of blind-clicking',
    Boolean(blind && blind.ok === false), blind && (blind.error || blind.reason || blind.result));
  evidence.injections.externalClose = { refused: Boolean(blind && blind.ok === false), receipt: blind && (blind.error || blind.reason) };

  await step('close');
}

async function longPressInjection() {
  process.stdout.write('\nInjection: long press (attack 600ms), ledger and world both clean\n');
  const before = await liveState();
  const beforeBlocks = blockMap(before);
  const hold = await step('hold attack 600');
  check('injection: "hold attack 600" accepted by the agent', hold && hold.ok === true, hold && (hold.error || hold.result));
  await sleep(1400);

  const ledger = await inputState();
  check('injection: the ledger is empty after the bounded hold expires', Boolean(ledger && ledger.count === 0), ledger && ledger.held);

  const after = await liveState();
  const afterBlocks = blockMap(after);
  let changedCells = 0;
  const keys = new Set([...Object.keys(beforeBlocks || {}), ...Object.keys(afterBlocks || {})]);
  for (const key of keys) {
    if ((beforeBlocks || {})[key] !== (afterBlocks || {})[key]) changedCells += 1;
  }
  const drift = Math.hypot((after.position.x || 0) - (before.position.x || 0), (after.position.z || 0) - (before.position.z || 0));
  check('injection: the 600ms attack did not move the player or change the world',
    drift < 0.5 && changedCells === 0, { drift: +drift.toFixed(3), changedCells });
  evidence.injections.longPress = { drift: +drift.toFixed(3), changedCells, held: ledger && ledger.held };
}

// ---------------------------------------------------------------- main
async function main() {
  process.stdout.write(`M5 A21 through the agent layer (agent ${AGENT_PORT}, mod ${MOD_PORT})\n`);
  const health = await liveState().catch((err) => ({ error: err.message }));
  if (!check('agent state is reachable', Boolean(health && !health.error && health.position), health && (health.error || health.position))) {
    process.stdout.write('\nthe agent is not running - start it (npm run agent:client) with the client in world\n');
    return;
  }
  evidence.player = health.player || null;
  evidence.startPosition = health.position;

  let preMenu = await readMenu();
  if (preMenu.menu) {
    // A previous session can leave a screen open; the probe needs a known starting point
    // (and this also proves the agent can close what it did not open).
    await step('close');
    await sleep(800);
    preMenu = await readMenu();
    check('preflight: a stray screen was closed through the agent', preMenu.menu === null,
      preMenu.menu && preMenu.menu.menuClass);
  }
  check('preflight: no screen is open', preMenu.menu === null, preMenu.menu && preMenu.menu.menuClass);
  const preLedger = await inputState();
  check('preflight: the input ledger is empty', Boolean(preLedger && preLedger.count === 0), preLedger && preLedger.held);

  const inventoryRounds = await inventoryGui();
  const craftingRounds = await craftingGui();
  await externalCloseInjection();
  await longPressInjection();

  // Leave the world as found.
  await step('close').catch(() => {});

  const failed = results.filter((entry) => !entry.ok);
  evidence.finishedAt = new Date().toISOString();
  evidence.checks = results.length;
  evidence.failed = failed.length;
  evidence.passed = results.length - failed.length;
  evidence.inventoryRounds = inventoryRounds;
  evidence.craftingRounds = craftingRounds;
  evidence.failures = failed.map((entry) => ({ name: entry.name, detail: entry.detail }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(OUT_DIR, `m5-agent-layer-${stamp}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`\n${evidence.passed}/${evidence.checks} checks passed\n`);
  process.stdout.write(`evidence: ${path.relative(ROOT, outFile)}\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
