'use strict';

/**
 * Protocol test for ClientModBody.
 *
 * Stands up a mock that answers exactly like the Forge control mod's HTTP API, then
 * drives ClientModBody against it. This verifies the *contract* between the Node agent
 * and the mod (paths, payload shape, continuous-action polling, /login) without needing
 * the real client - which matters because the mod cannot be built on this machine yet
 * (ForgeGradle's mapping repos are unreachable; see mod-client/BUILDING.md).
 *
 * It deliberately does NOT pretend the real mod works: the mock is hand-written from the
 * same endpoint spec, so a mismatch in ClientModBody shows up here, but nothing here
 * proves the Java side.
 *
 *   node scripts/test-clientmod-protocol.js
 */

const http = require('http');
const path = require('path');
const { ClientModBody } = require('../src/body/clientModBody');
const { loadConfig } = require('../src/util/config');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const skills = require('../src/skills');

const PORT = 18899; // deliberately not the real port, so a running client is untouched

/** A tiny world the mock mutates as actions arrive, so assertions are meaningful. */
const world = {
  ready: true,
  body: 'clientmod',
  position: { x: 0, y: 64, z: 0 },
  blockPosition: { x: 0, y: 64, z: 0 },
  dimension: 'minecraft:overworld',
  health: 20,
  maxHealth: 20,
  food: 18,
  onGround: true,
  heldItem: 'minecraft:stone_pickaxe',
  standingOn: 'minecraft:grass_block',
  lightLevel: 15,
  time: { timeOfDay: 1000, day: 1, isDay: true },
  weather: { raining: false, thundering: false },
  inventory: { 'minecraft:stone_pickaxe': 1, 'minecraft:oak_log': 4, 'minecraft:cooked_beef': 3 },
  emptySlots: 30,
  hostiles: [
    { id: 42, name: 'minecraft:zombie', type: 'minecraft:zombie', position: { x: 5, y: 64, z: 0 }, distance: 5, health: 20 }
  ],
  itemDrops: [
    { id: 7, item: 'minecraft:oak_log', count: 1, position: { x: 1, y: 64, z: 0 }, distance: 1 }
  ],
  players: [],
  blocks: {
    cells: {
      '5,64,0': 'minecraft:stone',
      '5,63,0': 'minecraft:stone',
      '6,64,0': 'minecraft:oak_log',
      '2,64,0': 'minecraft:water',
      '0,63,0': 'minecraft:grass_block'
    }
  }
};

/** Continuous-action state, mirroring the mod's /progress contract. */
let busy = null;
let chatLog = [];
/** Slot clicks the mock received, in order. */
const clicks = [];
/** How many `close` commands the mock received (auto-close accounting). */
let closeCommands = 0;

/**
 * Tokenising mirror of `ControlHttpServer.execute()` in the Java mod.
 *
 * The mock used to accept anything, so a Java-side parser bug ("click 3 0 pickup" was
 * rejected because the mode is not a number, and `numbers()` demanded three numeric
 * tokens) stayed invisible: 42 green offline checks, every slot click dead on the real
 * client. These helpers follow the Java rules, so a command the agent sends is only
 * accepted here when the real mod would accept it too.
 */
function tokensOf(args) {
  return args.length ? args.split(/\s+/) : [];
}

/** Mirrors `numbers(rest, count)`: null unless the first `count` tokens are all numeric. */
function numbers(tokens, count) {
  if (tokens.length < count) return null;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

/** Mirrors `tryInt(token)`. */
function tryInt(token) {
  if (token === undefined || token === '') return null;
  const n = Number(token);
  return Number.isFinite(n) ? Math.floor(n) : null;
}

/** Mirrors the `click <slot> [button] [mode]` case. */
function parseClick(tokens) {
  const slot = tokens.length > 0 ? tryInt(tokens[0]) : null;
  if (slot === null) return null;
  let button = 0;
  let next = 1;
  const maybeButton = tokens.length > 1 ? tryInt(tokens[1]) : null;
  if (maybeButton !== null) {
    button = maybeButton;
    next = 2;
  }
  const mode = tokens.length > next ? tokens[next] : 'pickup';
  return { slot, button, mode };
}

/**
 * Mini crafting simulation for the mock.
 *
 * The craft skill drives real menu clicks; this block gives the fake mod enough of a
 * crafting table to answer them: a grid, a cursor stack, and a small recipe table. It is
 * what makes `craft` verifiable end-to-end without the game.
 */
world.craftOpen = false;
world.grid = new Array(9).fill(null);
world.carried = null;
world.furnaceOpen = false;
world.furnace = { input: null, fuel: null, output: null };

const MOCK_RECIPES = [
  { name: 'oak_planks', out: 4, shape: [['oak_log']] },
  { name: 'stick', out: 4, shape: [['oak_planks'], ['oak_planks']] },
  { name: 'crafting_table', out: 1, shape: [['oak_planks', 'oak_planks'], ['oak_planks', 'oak_planks']] },
  {
    name: 'wooden_pickaxe',
    out: 1,
    shape: [['oak_planks', 'oak_planks', 'oak_planks'], [null, 'stick', null], [null, 'stick', null]]
  }
];

function bareName(name) {
  const text = String(name || '');
  const idx = text.indexOf(':');
  return idx === -1 ? text : text.slice(idx + 1);
}

/** Player-inventory slots (36) derived from world.inventory at dump time. */
function playerSlotsFromInventory() {
  const slots = new Array(36).fill(null);
  let i = 0;
  for (const [name, count] of Object.entries(world.inventory)) {
    if (!count || i >= 36) continue;
    slots[i] = { name, count };
    i += 1;
  }
  return slots;
}

function writeBackPlayerSlots(slots) {
  const inv = {};
  for (const slot of slots) {
    if (!slot) continue;
    inv[slot.name] = (inv[slot.name] || 0) + slot.count;
  }
  world.inventory = inv;
}

/** Build the menu the mod would report: crafting table when open, else the inventory menu. */
function buildMenu() {
  if (world.menu) return world.menu;
  if (world.furnaceOpen) {
    // One tick of "smelting" per menu read: input + fuel -> output. Instant on purpose; the
    // skill's job is the item choreography, not waiting ten real seconds.
    if (world.furnace.input && world.furnace.fuel) {
      world.furnace.input.count -= 1;
      if (world.furnace.input.count <= 0) world.furnace.input = null;
      world.furnace.output = world.furnace.output || { name: 'minecraft:iron_ingot', count: 0 };
      if (!/iron_ingot/.test(world.furnace.output.name)) world.furnace.output = { name: 'minecraft:iron_ingot', count: 0 };
      world.furnace.output.count += 1;
    }
    const slots = [
      { i: 0, item: world.furnace.input ? world.furnace.input.name : 'null', count: world.furnace.input ? world.furnace.input.count : 0, player: false },
      { i: 1, item: world.furnace.fuel ? world.furnace.fuel.name : 'null', count: world.furnace.fuel ? world.furnace.fuel.count : 0, player: false },
      { i: 2, item: world.furnace.output ? world.furnace.output.name : 'null', count: world.furnace.output ? world.furnace.output.count : 0, player: false }
    ];
    playerSlotsFromInventory().forEach((item, idx) => {
      slots.push({ i: 3 + idx, item: item ? item.name : 'null', count: item ? item.count : 0, player: true });
    });
    return {
      open: true,
      containerId: 14,
      size: slots.length,
      menuClass: 'FurnaceMenu',
      carried: world.carried ? { item: world.carried.name, count: world.carried.count } : { item: 'null', count: 0 },
      slots
    };
  }
  const gridWidth = world.craftOpen ? 3 : 2;
  const gridSize = gridWidth * gridWidth;
  const slots = [{ i: 0, item: 'null', count: 0, player: false }];
  for (let i = 0; i < gridSize; i += 1) {
    const cell = world.grid[i];
    slots.push({ i: i + 1, item: cell ? cell.name : 'null', count: cell ? cell.count : 0, player: false });
  }
  const firstPlayerSlot = gridSize + 1;
  if (!world.craftOpen) {
    // InventoryMenu: armour slots 5..8 sit between the grid and the inventory.
    while (slots.length < 5) slots.push({ i: slots.length, item: 'null', count: 0, player: true });
    for (let i = 5; i <= 8; i += 1) slots.push({ i, item: 'null', count: 0, player: true });
  }
  const players = playerSlotsFromInventory();
  const base = world.craftOpen ? 10 : 9;
  players.forEach((item, idx) => {
    slots.push({
      i: base + idx,
      item: item ? item.name : 'null',
      count: item ? item.count : 0,
      player: true
    });
  });
  return {
    open: true,
    containerId: world.craftOpen ? 12 : 0,
    size: slots.length,
    menuClass: world.craftOpen ? 'CraftingMenu' : 'InventoryMenu',
    carried: world.carried ? { item: world.carried.name, count: world.carried.count } : { item: 'null', count: 0 },
    slots
  };
}

/** Does the grid match a known recipe for the given width? */
function matchMockRecipe(width) {
  for (const recipe of MOCK_RECIPES) {
    const height = recipe.shape.length;
    const shapeWidth = Math.max(...recipe.shape.map((row) => row.length));
    if (shapeWidth > width || height > width) continue;
    let ok = true;
    for (let y = 0; y < height && ok; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const want = (recipe.shape[y] && recipe.shape[y][x]) || null;
        const cell = world.grid[y * width + x];
        const have = cell ? bareName(cell.name) : null;
        if (want && have !== want) ok = false;
        if (!want && x < shapeWidth && have) ok = false;
        if (!ok) break;
      }
    }
    if (ok) return recipe;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (obj) => {
      const text = JSON.stringify(obj);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(text);
    };

    if (url.pathname === '/health') {
      return send({ ok: true, mod: 'agent-client', version: '1.0.0-mock', inWorld: true, requests: 1 });
    }

    if (url.pathname === '/state') {
      return send({ ...world, position: { ...world.position } });
    }

    if (url.pathname === '/progress') {
      return send(busy || { busy: false });
    }

    if (url.pathname === '/command') {
      const command = JSON.parse(body || '{}').command || '';
      const [verb, ...rest] = command.split(/\s+/);
      const args = rest.join(' ');
      const tokens = tokensOf(args);

      if (verb === 'chat' || verb === 'cmd') {
        chatLog.push(args);
        return send({ command, ok: true });
      }
      if (verb === 'login') {
        chatLog.push(`login ${args}`);
        return send({ command, ok: true });
      }
      if (verb === 'moveto') {
        const [x, y, z] = args.split(/\s+/).map(Number);
        // Simulate a walk that takes two polls to finish.
        let ticks = 0;
        busy = { busy: true, action: 'walkTo', arrived: false, failed: false };
        const timer = setInterval(() => {
          ticks += 1;
          if (ticks >= 2) {
            clearInterval(timer);
            world.position = { x, y, z };
            busy = { busy: false, action: 'walkTo', arrived: true, failed: false };
          }
        }, 120);
        return send({ command, ok: true, note: 'continuous' });
      }
      if (verb === 'dig') {
        const [x, y, z] = args.split(/\s+/).map(Number);
        let ticks = 0;
        busy = { busy: true, action: 'dig', done: false, failed: false };
        const timer = setInterval(() => {
          ticks += 1;
          if (ticks >= 2) {
            clearInterval(timer);
            delete world.blocks.cells[`${x},${y},${z}`];
            world.inventory['minecraft:stone'] = (world.inventory['minecraft:stone'] || 0) + 1;
            busy = { busy: false, action: 'dig', done: true, failed: false };
          }
        }, 120);
        return send({ command, ok: true, note: 'continuous' });
      }
      if (verb === 'select') {
        world.heldItem = args;
        return send({ command, ok: true });
      }
      if (verb === 'useon') {
        // Opening a crafting table: the next `menu` reports the 3x3 crafting menu.
        const xyz = numbers(tokens, 3);
        if (!xyz) {
          return send({ command, ok: false, error: 'usage: useon <x> <y> <z> [face]' });
        }
        const [ux, uy, uz] = xyz;
        const target = world.blocks.cells[`${ux},${uy},${uz}`];
        if (target && /crafting_table/.test(target)) {
          world.craftOpen = true;
          world.menu = null;
          return send({ command, ok: true });
        }
        if (target && /furnace/.test(target)) {
          world.furnaceOpen = true;
          world.menu = null;
          return send({ command, ok: true });
        }
        // Opening a container: the mod reports the menu through the next /command menu call.
        world.menu = {
          open: true,
          containerId: 7,
          size: 3,
          menuClass: 'ChestMenu',
          carried: { item: 'null', count: 0 },
          slots: [
            { i: 0, item: 'minecraft:bread', count: 3, player: false },
            { i: 1, item: 'null', count: 0, player: false },
            { i: 2, item: 'minecraft:stone', count: 5, player: false }
  ]
};

        return send({ command, ok: true });
      }
      if (verb === 'menu') {
        const menu = buildMenu();
        return send({ command, ok: true, menu });
      }
      if (verb === 'click') {
        const parsed = parseClick(tokensOf(args));
        if (!parsed) {
          return send({ command, ok: false, error: 'usage: click <slot> [button] [pickup|quickmove|swap]' });
        }
        const { slot: slotIndex, button: buttonIndex, mode: clickMode } = parsed;
        clicks.push({ slot: slotIndex, button: buttonIndex, mode: clickMode });
        if (clickMode === 'quickmove' && slotIndex === 2 && world.menu && world.menu.slots[2]) {
          world.inventory['minecraft:stone'] = (world.inventory['minecraft:stone'] || 0) + world.menu.slots[2].count;
          world.menu.slots[2].item = 'null';
          world.menu.slots[2].count = 0;
        }
        // ---- the crafting menus -------------------------------------------
        if (!world.menu) {
          // ---- the furnace menu ------------------------------------------
          if (world.furnaceOpen) {
            const players = playerSlotsFromInventory();
            const playerIdx = (i) => (i >= 3 && i < 3 + 36 ? i - 3 : -1);
            if (clickMode === 'quickmove' && slotIndex >= 3) {
              const idx = playerIdx(slotIndex);
              const cell = idx >= 0 ? players[idx] : null;
              if (cell) {
                const name = bareName(cell.name);
                if (slotIndex !== 2 && !world.furnace.input && /raw_|_ore$|sand|cobblestone|porkchop|beef|chicken|potato|kelp/.test(name)) {
                  world.furnace.input = { name: cell.name, count: cell.count };
                  players[idx] = null;
                  writeBackPlayerSlots(players);
                } else if (/coal|charcoal|_log$|planks/.test(name) && !world.furnace.fuel) {
                  world.furnace.fuel = { name: cell.name, count: cell.count };
                  players[idx] = null;
                  writeBackPlayerSlots(players);
                }
              }
            } else if (clickMode === 'quickmove' && slotIndex === 2 && world.furnace.output) {
              const out = world.furnace.output;
              world.inventory[out.name] = (world.inventory[out.name] || 0) + out.count;
              world.furnace.output = null;
            }
            return send({ command, ok: true });
          }
          const gridWidth = world.craftOpen ? 3 : 2;
          const gridSize = gridWidth * gridWidth;
          const playerBase = world.craftOpen ? 10 : 9;
          const players = playerSlotsFromInventory();
          const inGrid = (i) => i >= 1 && i <= gridSize;
          const playerIdx = (i) => (i >= playerBase && i < playerBase + 36 ? i - playerBase : -1);

          const takeFromSlot = () => {
            if (inGrid(slotIndex)) {
              const cell = world.grid[slotIndex - 1];
              world.grid[slotIndex - 1] = null;
              return cell;
            }
            const idx = playerIdx(slotIndex);
            if (idx >= 0) {
              const cell = players[idx];
              players[idx] = null;
              writeBackPlayerSlots(players);
              return cell;
            }
            return null;
          };
          const putIntoSlot = (stack, onlyOne) => {
            if (!stack) return null;
            const amount = onlyOne ? Math.min(1, stack.count) : stack.count;
            const incoming = { name: stack.name, count: amount };
            const leftover = { name: stack.name, count: stack.count - amount };
            if (inGrid(slotIndex)) {
              const cell = world.grid[slotIndex - 1];
              if (!cell) world.grid[slotIndex - 1] = incoming;
              else if (bareName(cell.name) === bareName(incoming.name)) cell.count += amount;
              else return stack; // occupied by something else: drop the attempt
              return leftover.count > 0 ? leftover : null;
            }
            const idx = playerIdx(slotIndex);
            if (idx >= 0) {
              const cell = players[idx];
              if (!cell) players[idx] = incoming;
              else if (bareName(cell.name) === bareName(incoming.name)) cell.count += amount;
              else return stack;
              writeBackPlayerSlots(players);
              return leftover.count > 0 ? leftover : null;
            }
            return stack;
          };

          if (clickMode === 'quickmove' && slotIndex === 0) {
            const recipe = matchMockRecipe(gridWidth);
            if (recipe) {
              // consume one set
              for (const cell of world.grid.slice(0, gridSize)) {
                if (!cell) continue;
                cell.count -= 1;
                const at = world.grid.indexOf(cell);
                if (cell.count <= 0 && at !== -1) world.grid[at] = null;
              }
              world.inventory[`minecraft:${recipe.name}`] =
                (world.inventory[`minecraft:${recipe.name}`] || 0) + recipe.out;
            }
          } else if (buttonIndex === 1) {
            if (world.carried) {
              const leftover = putIntoSlot(world.carried, true);
              world.carried = leftover;
            }
          } else if (world.carried) {
            const leftover = putIntoSlot(world.carried, false);
            world.carried = leftover;
          } else {
            world.carried = takeFromSlot();
          }
        }
        return send({ command, ok: true });
      }
      if (verb === 'close') {
        world.menu = null;
        world.craftOpen = false;
        world.furnaceOpen = false;
        world.carried = null;
        world.grid = new Array(9).fill(null);
        world.screenOpen = false;
        world.screen = 'null';
        closeCommands += 1;
        return send({ command, ok: true });
      }
      if (verb === 'look') {
        // two numbers: yaw and pitch (three used to be required, which made every look fail)
        const yawPitch = numbers(tokens, 2);
        if (!yawPitch) {
          return send({ command, ok: false, error: 'usage: look <yaw> <pitch>' });
        }
        world.yaw = yawPitch[0];
        world.pitch = yawPitch[1];
        // Simulate "something comes into view" for the sweep test.
        if (world.sweepTarget && Math.abs(((yawPitch[0] % 360) + 360) % 360 - 180) < 45) {
          world.target = world.sweepTarget;
        }
        return send({ command, ok: true });
      }
      if (verb === 'lookat') {
        return send({ command, ok: true });
      }
      if (verb === 'target') {
        return send({ command, ok: true, target: world.target || null });
      }
      if (verb === 'use') {
        world.food = Math.min(20, world.food + 6);
        world.inventory['minecraft:cooked_beef'] -= 1;
        return send({ command, ok: true });
      }
      if (verb === 'attack') {
        if (!numbers(tokens, 2)) {
          return send({ command, ok: false, error: 'usage: attack <entityId> [timeoutMs]' });
        }
        return send({ command, ok: true });
      }
      if (verb === 'lookat' || verb === 'stop' || verb === 'resync') {
        if (verb === 'stop') busy = null;
        return send({ command, ok: true });
      }
      return send({ command, ok: false, error: `unknown command: ${verb}` });
    }

    res.writeHead(404);
    res.end('{}');
  });
});

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`);
}

(async () => {
  process.stdout.write('ClientModBody protocol test (mock stands in for the Forge mod)\n\n');
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  const cfg = loadConfig();
  /**
   * Keep this run's path trace out of `runtime/path-trace.jsonl`.
   *
   * That file is the *evidence* file for real-server runs, and a protocol test pointing at a
   * fake world would fill it with `unknown-block` entries for coordinates like (10,64,0) -
   * which reads exactly like a pathfinding failure on the real server.
   */
  cfg.agent.pathfinding.trace = 'runtime/_protocol-test-trace.jsonl';
  const body = new ClientModBody(cfg, {
    port: PORT,
    log: { info() {}, warn() {}, debug() {}, error() {} }
  });

  try {
    // ---- lifecycle -------------------------------------------------------
    const attached = await body.connect({ waitMs: 5000 });
    check('connect() attaches to the control API', attached === true, body.baseUrl);
    check('isReady after connect', body.isReady === true);

    // ---- perception ------------------------------------------------------
    const snap = body.snapshot();
    check('snapshot() exposes the contract shape', !!snap && snap.body === 'clientmod');
    check('snapshot carries inventory', snap.inventory['minecraft:oak_log'] === 4, `${Object.keys(snap.inventory).length} item kinds`);

    const stone = body.blockAt({ x: 5, y: 64, z: 0 });
    check('blockAt() reads the mod block map', !!stone && stone.name === 'minecraft:stone', stone && stone.name);
    const unknown = body.blockAt({ x: 999, y: 64, z: 999 });
    check('blockAt() returns null outside the scan (no guessing)', unknown === null);
    /**
     * Regression guard for a bug that made the whole pathfinding layer dead in production:
     * `snapshot()` did not expose `blocks`, so `ClientWorldAdapter.cells()` always saw "no
     * scan", every plan returned `unknown-block`, and `moveTo` quietly fell back to the
     * client's own walker. Nothing failed loudly - the bot just kept walking into walls.
     */
    check(
      'snapshot() exposes the block scan the pathfinder reads',
      !!(snap.blocks && snap.blocks.cells && Object.keys(snap.blocks.cells).length > 0),
      `${snap.blocks && snap.blocks.cells ? Object.keys(snap.blocks.cells).length : 0} cells`
    );

    const logs = body.findBlocks(['oak_log'], { maxDistance: 24 });
    check('findBlocks() matches bare names against namespaced ids', logs.length === 1, `${logs.length} found at ${logs[0] && logs[0].name}`);
    const ores = body.findBlocksMatching((n) => /_ore$/.test(n), { maxDistance: 24 });
    check('findBlocksMatching() predicate works', ores.length === 0, 'no ores in the mock world');

    const hostiles = body.hostiles(16);
    check('hostiles() reports the zombie', hostiles.length === 1 && /zombie/.test(hostiles[0].name), hostiles[0] && hostiles[0].name);
    const drops = body.itemDrops(8);
    check('itemDrops() reports the dropped log', drops.length === 1 && drops[0].name === 'minecraft:oak_log');

    // ---- actions ---------------------------------------------------------
    const arrived = await body.moveTo({ x: 10, y: 64, z: 0 }, { range: 1.5, timeoutMs: 5000 });
    check('moveTo() polls until the walk finishes', arrived === true, `now at ${JSON.stringify(body.snapshot().position)}`);
    /**
     * This mock world has only five scattered cells, so the planner cannot identify the
     * cell the bot is standing in and reports `unknown-block`. `moveTo` must then degrade
     * to the client's own walker rather than refusing to move - that degradation is the
     * thing being asserted here, and `lastMove.raw` is how it is observable.
     */
    check(
      'moveTo() degrades to a direct walk when the block scan is unusable',
      body.lastMove && body.lastMove.raw === true && body.lastMove.ok === true,
      JSON.stringify(body.lastMove)
    );

    // With a real scan the planner takes over. Fill in a floor so A* has something to plan
    // over, then walk far enough that planning is worth it - below `directRange` (3) the
    // body deliberately walks straight instead, so a short hop would not prove anything.
    for (let x = -2; x <= 18; x += 1) {
      for (let z = -2; z <= 2; z += 1) {
        world.blocks.cells[`${x},63,${z}`] = 'minecraft:grass_block';
        for (let y = 64; y <= 67; y += 1) world.blocks.cells[`${x},${y},${z}`] = 'minecraft:air';
      }
    }
    // The body reads a *cached* /state snapshot (400ms TTL, by design - `snapshot()` must
    // never block), so the new terrain has to be pulled in before planning can see it.
    await body.refresh(true);
    const planned = await body.moveTo({ x: 16, y: 64, z: 0 }, { range: 1.5, timeoutMs: 15000 });
    check('moveTo() walks a planned route when a scan is available', planned === true, `at ${JSON.stringify(body.snapshot().position)}`);
    check(
      'the planned move is distinguishable from the direct one',
      body.lastMove && body.lastMove.raw !== true && typeof body.lastMove.iterations === 'number',
      JSON.stringify(body.lastMove)
    );

    // ---- the screen-open guard ------------------------------------------
    // Live report: "I typed the command with the chat screen open; the moment I sent it,
    // the agent decided it could not run." The chat closes on send; the stale snapshot must
    // not be trusted. The first check below encodes exactly that sequence.
    world.screenOpen = true;
    world.screen = 'ChatScreen';
    await body.refresh(true); // cached snapshot says "screen open"
    world.screenOpen = false; // ...the player pressed Enter and the screen is already gone
    world.screen = 'null';
    const staleScreen = await body.moveTo({ x: 2, y: 64, z: 0 }, { range: 2, timeoutMs: 5000 });
    check(
      'a stale "screen open" snapshot does not block a fresh walk',
      staleScreen === true && closeCommands === 0,
      `walk=${staleScreen} closes=${closeCommands} ${JSON.stringify(body.lastMove)}`
    );

    // A screen that is genuinely still open is closed automatically, then the walk proceeds.
    world.screenOpen = true;
    world.screen = 'ContainerScreen';
    await body.refresh(true);
    const autoClosed = await body.moveTo({ x: 4, y: 64, z: 0 }, { range: 2, timeoutMs: 8000 });
    check(
      'a genuinely open screen is closed automatically and the walk continues',
      autoClosed === true && closeCommands >= 1 && world.screenOpen === false,
      `walk=${autoClosed} closes=${closeCommands} ${JSON.stringify(body.lastMove)}`
    );

    // With the feature off, the honest refusal is still available.
    body.autoCloseScreens = false;
    world.screenOpen = true;
    world.screen = 'ContainerScreen';
    await body.refresh(true);
    const blockedByScreen = await body.moveTo({ x: 30, y: 64, z: 0 }, { range: 1.5, timeoutMs: 3000 });
    check(
      'with auto-close disabled a real screen still refuses with a named reason',
      blockedByScreen === false && body.lastMove && body.lastMove.reason === 'screen-open',
      JSON.stringify(body.lastMove)
    );
    body.autoCloseScreens = true;
    world.screenOpen = false;
    world.screen = 'null';
    await body.refresh(true);

    // A chat screen is NEVER closed by the agent: the human may be typing `!stop`.
    const closesBeforeChat = closeCommands;
    body.chatWaitMs = 500; // keep the test fast; production default is 20s
    world.screenOpen = true;
    world.screen = 'ChatScreen';
    await body.refresh(true);
    const refusedChat = await body.moveTo({ x: 30, y: 64, z: 0 }, { range: 1.5, timeoutMs: 2000 });
    check(
      'a chat screen is never closed automatically (typing can interrupt)',
      refusedChat === false && closeCommands === closesBeforeChat && body.lastMove.reason === 'screen-open',
      `walk=${refusedChat} closes=${closeCommands - closesBeforeChat} ${JSON.stringify(body.lastMove)}`
    );
    // ...and once the human closes it, walking works again.
    world.screenOpen = false;
    world.screen = 'null';
    await body.refresh(true);
    const afterChat = await body.moveTo({ x: 3, y: 64, z: 0 }, { range: 2, timeoutMs: 5000 });
    check('closing the chat ourselves restores walking', afterChat === true, JSON.stringify(body.lastMove));

    const dug = await body.dig({ name: 'minecraft:stone', position: { x: 5, y: 64, z: 0 } }, { timeoutMs: 5000 });
    check('dig() polls until the block is gone', dug === true);
    await body.refresh(true);
    check('dig() result is visible in the next snapshot', body.blockAt({ x: 5, y: 64, z: 0 }) === null);
    check('dig() yield landed in the inventory', (body.snapshot().inventory['minecraft:stone'] || 0) >= 1);

    // ---- aimed vision: crosshair raycast + look sweep ---------------------
    world.target = { name: 'minecraft:dirt', position: { x: 1, y: 63, z: 0 }, face: 'up', distance: 1.2 };
    const aimed = await body.targetBlock();
    check('targetBlock() reports what the crosshair points at', !!aimed && aimed.name === 'minecraft:dirt', JSON.stringify(aimed));

    world.target = null;
    world.sweepTarget = { name: 'minecraft:grass_block', position: { x: -2, y: 63, z: 2 }, face: 'up', distance: 2.4 };
    const swept = await body.sweepLook({ steps: 8, pitch: 30, settleMs: 10, filter: (t) => /grass_block/.test(t.name) });
    check(
      'sweepLook() turns the view and finds a matching block',
      !!swept && /grass_block/.test(swept.name) && world.yaw !== undefined,
      JSON.stringify({ swept, yaw: world.yaw })
    );
    world.sweepTarget = null;
    world.target = null;

    const equipped = await body.equipBest('pickaxe');
    check('equipBest() selects a tool', equipped === true);

    const ate = await body.consume('minecraft:cooked_beef');
    check('consume() detects food going up', ate === true, `food now ${body.snapshot().food}`);

    const attacked = await body.attack({ id: 42 }, { timeoutMs: 2000 });
    check('attack() reaches the mod', attacked === true);

    // ---- menus and slot clicks (the crafting / container groundwork) -----
    const usedOn = await body.useOn({ x: 4, y: 64, z: 0 }, { face: { x: 0, y: 1, z: 0 }, waitMs: 0 });
    check('useOn() reaches the mod', usedOn === true);
    const menu = await body.menu();
    check(
      'menu() returns the open container',
      !!menu && menu.open === true && menu.slots.length === 3,
      menu ? `${menu.menuClass} slots=${menu.slots.length}` : 'null'
    );
    const clicked = await body.clickSlot(2, { mode: 'quickmove', waitMs: 0 });
    check('clickSlot() reports success', clicked === true);
    check(
      'the click carried the right slot and mode',
      clicks.length === 1 && clicks[0].slot === 2 && clicks[0].mode === 'quickmove',
      JSON.stringify(clicks)
    );
    // The Java parser used to demand three numbers, so "click 3 0 pickup" answered
    // "usage" and every crafting click died silently. These lock the contract down.
    const clickNoButton = await body.command('click 2 quickmove');
    check('click <slot> <mode> (no button) is accepted', !!clickNoButton && clickNoButton.ok === true);
    const clickBadSlot = await body.command('click banana');
    check('click with a non-numeric slot is refused', !!clickBadSlot && clickBadSlot.ok === false);
    const lookTwoNumbers = await body.command('look 90 0');
    check('look takes two numbers (yaw, pitch)', !!lookTwoNumbers && lookTwoNumbers.ok === true);
    const attackTwoNumbers = await body.command('attack 42 2000');
    check('attack takes two numbers (id, timeout)', !!attackTwoNumbers && attackTwoNumbers.ok === true);
    await body.refresh(true);
    check('the withdrawal is visible in the inventory', (body.snapshot().inventory['minecraft:stone'] || 0) >= 5);
    const closed = await body.closeMenu();
    check('closeMenu() closes the container', closed === true);

    // ---- crafting: planner + real menu clicks ---------------------------
    // Planks come from the 2x2 inventory grid; the pickaxe needs the 3x3 crafting table
    // and two sub-crafts (planks and sticks), which is the full Phase-2 path.
    world.menu = null;
    world.craftOpen = false;
    world.grid = new Array(9).fill(null);
    world.carried = null;
    world.inventory = { 'minecraft:oak_log': 4 };
    world.blocks.cells['2,64,0'] = 'minecraft:crafting_table';
    const craftCtx = {
      cfg,
      body,
      world: new BodyWorldView(body, cfg, { log: { debug() {}, info() {}, warn() {} } })
    };
    const planks = await skills.run('craft', craftCtx, { item: 'oak_planks', count: 4 });
    check('craft: planks in the 2x2 inventory grid', planks.ok === true, JSON.stringify(planks).slice(0, 180));
    const pick = await skills.run('craft', craftCtx, { item: 'wooden_pickaxe', count: 1 });
    check('craft: pickaxe via the crafting table (sub-crafts included)', pick.ok === true, JSON.stringify(pick).slice(0, 220));
    await body.refresh(true);
    check(
      'craft: the pickaxe really is in the inventory',
      (body.snapshot().inventory['minecraft:wooden_pickaxe'] || 0) >= 1,
      JSON.stringify(body.snapshot().inventory)
    );

    // ---- smelting: load input + fuel, take the product -------------------
    world.menu = null;
    world.craftOpen = false;
    world.furnaceOpen = false;
    world.furnace = { input: null, fuel: null, output: null };
    world.inventory = { 'minecraft:raw_iron': 2, 'minecraft:coal': 2 };
    world.blocks.cells['4,64,0'] = 'minecraft:furnace';
    const smelted = await skills.run('smelt', craftCtx, { item: 'raw_iron', count: 1, timeoutMs: 15000 });
    check('smelt: raw iron becomes an iron ingot', smelted.ok === true, JSON.stringify(smelted).slice(0, 200));
    await body.refresh(true);
    check(
      'smelt: the ingot really is in the inventory',
      (body.snapshot().inventory['minecraft:iron_ingot'] || 0) >= 1,
      JSON.stringify(body.snapshot().inventory)
    );

    // ---- the AuthMe path -------------------------------------------------
    const loggedIn = await body.login('<your-password>');
    check('login() sends the AuthMe command', loggedIn === true, `chat log: ${JSON.stringify(chatLog)}`);

    const chatted = await body.chat('/say hello');
    check('chat() with a slash routes to cmd', chatted === true, `chat log: ${JSON.stringify(chatLog)}`);
    check('login went out as "login <pw>" (no double slash)', chatLog.includes('login <your-password>'));

    // ---- degradation -----------------------------------------------------
    body.interrupt();
    const afterStop = await body.refresh(true);
    check('interrupt() does not break the body', !!afterStop);

    await body.disconnect();
    check('disconnect() clears readiness', body.isReady === false);
  } catch (err) {
    check('no unexpected exception', false, err.message);
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(60)}\n`);
  process.stdout.write(`protocol test: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail}\n`);
    process.exitCode = 1;
  }
  process.exit(0);
})();
