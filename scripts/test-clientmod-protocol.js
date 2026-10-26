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
  /** One TACZ gun in the pack (shoot tests) and one other player (PvP id tests). */
  guns: [{ item: 'tacz:ak47', gunId: 'tacz:ak47', type: 'rifle', magazine: 30, dummy: 0, bullets: true }],
  players: [{ id: 77, name: 'Partner', position: { x: 4, y: 64, z: 0 }, distance: 4, health: 20 }],
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
/**
 * Extra fields merged into the next completed `pillar` progress payload. Scenarios set
 * this to prove how `ClientModBody.pillar` treats receipts (missing steps, wrong action).
 */
let pillarFinal = null;
/** Last tunnel command the mock received, for the protect-list wire assertions. */
let lastTunnelCommand = null;
let chatLog = [];
/** Slot clicks the mock received, in order. */
const clicks = [];
/** How many `close` commands the mock received (auto-close accounting). */
let closeCommands = 0;
/** How many /state polls the mock has served (idle-refresh regression, 2026-10-13). */
let stateHits = 0;
/** Query strings seen on /state, so the follow light-poll path is asserted on the wire. */
const stateQueries = [];
/** Last shoot/retreat verbs the mock received, for the wire assertions. */
let lastShoot = null;
let lastRetreat = null;
/** Scripted shoot verdict; null = a successful maxShots burst. */
let shootOutcome = null;

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
      stateHits += 1;
      stateQueries.push(url.search);
      // Mirrors the mod's lightweight follow poll: self position + players only.
      if (url.searchParams.get('players') === '1') {
        return send({
          ready: true,
          position: { ...world.position },
          players: world.players.map((player) => ({ ...player, position: { ...player.position } }))
        });
      }
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
      if (verb === 'shoot') {
        const parts = args.split(/\s+/);
        lastShoot = { command, id: Number(parts[0]), ms: Number(parts[1] || 8000), maxShots: Number(parts[2] || 6) };
        const outcome = shootOutcome || {
          done: true,
          failed: false,
          shots: lastShoot.maxShots,
          gunType: 'rifle',
          magazine: 24,
          blocked: false
        };
        let ticks = 0;
        busy = { busy: true, action: 'shoot', shots: 0 };
        const timer = setInterval(() => {
          ticks += 1;
          if (ticks >= 2) {
            clearInterval(timer);
            busy = { busy: false, action: 'shoot', ...outcome };
          }
        }, 60);
        return send({ command, ok: true, note: 'continuous' });
      }
      if (verb === 'retreat') {
        const parts = args.split(/\s+/);
        lastRetreat = { command, id: Number(parts[0]), ms: Number(parts[1] || 3000), fire: Number(parts[2] || 0) };
        let ticks = 0;
        busy = { busy: true, action: 'retreat' };
        const timer = setInterval(() => {
          ticks += 1;
          if (ticks >= 2) {
            clearInterval(timer);
            busy = { busy: false, action: 'retreat', done: true, failed: false };
          }
        }, 60);
        return send({ command, ok: true, note: 'continuous' });
      }
      if (verb === 'pillar') {
        let ticks = 0;
        busy = { busy: true, action: 'pillar', done: false, failed: false };
        const timer = setInterval(() => {
          ticks += 1;
          if (ticks >= 2) {
            clearInterval(timer);
            /**
             * Default: one completed hop with the full new receipt. Scenarios override
             * `pillarFinal` to drop `steps` or to answer with a different action.
             */
            busy = { busy: false, action: 'pillar', done: true, failed: false, steps: 1, ...(pillarFinal || {}) };
          }
        }, 60);
        return send({ command, ok: true, note: 'continuous' });
      }
      if (verb === 'tunnel') {
        // Walk-and-dig as one continuous action: clear every solid cell on the waypoint
        // line, then report the cells that were actually dug (the mining ledger uses them).
        const tunnelTokens = tokensOf(args);
        const protectAt = tunnelTokens.findIndex((t) => t.toLowerCase() === 'protect');
        const cellTokens = protectAt === -1 ? tunnelTokens : tunnelTokens.slice(0, protectAt);
        const protect = protectAt === -1
          ? []
          : tunnelTokens.slice(protectAt + 1).join(',').split(',').map((n) => n.trim()).filter(Boolean);
        lastTunnelCommand = command;
        const nums = cellTokens.map(Number);
        if (nums.length < 3 || nums.length % 3 !== 0 || nums.some((n) => !Number.isFinite(n))) {
          return send({ command, ok: false, error: 'usage: tunnel x y z [x y z ...]' });
        }
        const points = [];
        for (let i = 0; i < nums.length; i += 3) points.push({ x: nums[i], y: nums[i + 1], z: nums[i + 2] });
        let ticks = 0;
        const dugCells = [];
        busy = { busy: true, action: 'tunnel', done: false, failed: false };
        const timer = setInterval(() => {
          ticks += 1;
          if (ticks < 2) return;
          clearInterval(timer);
          for (const point of points) {
            for (const cell of [point, { x: point.x, y: point.y + 1, z: point.z }]) {
              const k = `${cell.x},${cell.y},${cell.z}`;
              const name = world.blocks.cells[k];
              if (!name || /air$/.test(name)) continue;
              /**
               * Protection mirrors the mod: stop BEFORE destroying a named block and
               * report the structured reason plus the exact cell.
               */
              if (protect.length && protect.some((p) => name === p || name.endsWith(`:${p}`))) {
                busy = { busy: false, action: 'tunnel', done: false, failed: true, reason: 'target_requires_acquisition', cell: { ...cell }, block: name, dugCells };
                return;
              }
              delete world.blocks.cells[k];
              dugCells.push({ ...cell });
              world.inventory['minecraft:cobblestone'] = (world.inventory['minecraft:cobblestone'] || 0) + 1;
            }
          }
          const last = points[points.length - 1];
          world.position = { x: last.x, y: last.y, z: last.z };
          busy = { busy: false, action: 'tunnel', done: true, failed: false, reason: null, dugCells };
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
    /**
     * Live report (2026-10-13): "a zombie stood against the agent's face and nothing
     * happened - I had to kill it myself." Root cause: `refresh()` only ever ran inside
     * action code paths, so between actions the cached snapshot - hostiles included -
     * froze; the reflex loop and the LLM `observe` tool both read that stale cache and
     * truthfully reported "没看到怪物". The body now polls /state in the background;
     * this check proves an IDLE body sees the world change with no action call at all.
     */
    const zombieEntry = world.hostiles[0];
    const hitsBefore = stateHits;
    world.hostiles = [];
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const idleHostiles = body.hostiles(16);
    check(
      'an idle body keeps refreshing its own snapshot (no action needed)',
      stateHits - hitsBefore >= 2 && idleHostiles.length === 0,
      `/state hits=${stateHits - hitsBefore}, hostiles=${idleHostiles.length}`
    );
    world.hostiles = [zombieEntry];
    const drops = body.itemDrops(8);
    check('itemDrops() reports the dropped log', drops.length === 1 && drops[0].name === 'minecraft:oak_log');
    const guns = body.snapshot().guns;
    check(
      'snapshot() exposes the TACZ guns array',
      Array.isArray(guns) && guns.length === 1 && guns[0].type === 'rifle' && guns[0].bullets === true,
      JSON.stringify(guns)
    );
    const seenPlayers = body.snapshot().players;
    check(
      'players carry their entity id (PvP aiming needs it)',
      seenPlayers.length === 1 && seenPlayers[0].id === 77 && seenPlayers[0].name === 'Partner',
      JSON.stringify(seenPlayers)
    );

    const light = await body.refreshPlayers();
    check(
      'refreshPlayers() uses the lightweight /state?players=1 path',
      light.ok === true &&
        Array.isArray(light.state.players) &&
        light.state.blocks === undefined &&
        stateQueries.includes('?players=1'),
      JSON.stringify({ ok: light.ok, query: stateQueries.slice(-3), hasBlocks: light.state && light.state.blocks !== undefined })
    );

    // ---- TACZ gunfire verbs ---------------------------------------------
    const shot = await body.shoot({ id: 42 }, { ms: 8000, maxShots: 6 });
    check(
      'shoot() fires one burst and reports the shots',
      shot === true && body.lastAction && body.lastAction.shots === 6 && body.lastAction.gunType === 'rifle',
      JSON.stringify(body.lastAction)
    );
    check(
      'the shoot verb carried ms and maxShots',
      lastShoot && lastShoot.command === 'shoot 42 8000 6',
      JSON.stringify(lastShoot)
    );
    shootOutcome = { done: false, failed: true, reason: 'no_ammo', shots: 0 };
    const dry = await body.shoot({ id: 42 }, { ms: 8000, maxShots: 6 });
    check(
      'a no_ammo verdict returns false with the reason',
      dry === false && body.lastAction.reason === 'no_ammo',
      JSON.stringify(body.lastAction)
    );
    shootOutcome = null;
    const retreated = await body.retreatFrom({ id: 42 }, { ms: 3000, fire: true });
    check(
      'retreatFrom() sends the fire flag',
      retreated === true && lastRetreat && lastRetreat.command === 'retreat 42 3000 1',
      JSON.stringify(lastRetreat)
    );

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

    /**
     * Screen ownership: only a container may be closed by the agent.
     *
     * The rule the operator set is "the text box and the Escape menu are mine". The first
     * implementation was a denylist of known human screens, which gets the default backwards -
     * anything it did not recognise was closed. That is how a text-input screen loses what the
     * player was typing, and modded packs add those freely (anvil, sign, book, and whatever a
     * pack invents). So: an allowlist of containers, everything else waits.
     */
    check(
      'the allowlist accepts containers and refuses text/pause screens',
      ClientModBody.isContainerScreen('ContainerScreen') &&
        ClientModBody.isContainerScreen('ChestScreen') &&
        ClientModBody.isContainerScreen('CraftingScreen') &&
        ClientModBody.isContainerScreen('FurnaceScreen') &&
        !ClientModBody.isContainerScreen('ChatScreen') &&
        !ClientModBody.isContainerScreen('PauseScreen') &&
        !ClientModBody.isContainerScreen('OptionsScreen') &&
        // The ones a denylist would have missed, and the reason for the switch.
        !ClientModBody.isContainerScreen('EditBookScreen') &&
        !ClientModBody.isContainerScreen('SignEditScreen') &&
        !ClientModBody.isContainerScreen('SomeModScreen') &&
        !ClientModBody.isContainerScreen('null') &&
        !ClientModBody.isContainerScreen(''),
      'ContainerScreen yes; Chat/Pause/Options/EditBook/SignEdit/SomeMod no'
    );

    // The regression this switch exists for: a text-input screen must survive the walk attempt.
    for (const [screen, why] of [
      ['PauseScreen', 'the operator paused the game'],
      ['OptionsScreen', 'the operator is in the settings'],
      ['EditBookScreen', 'the operator is typing in a book'],
      ['SignEditScreen', 'the operator is typing on a sign'],
      ['AnvilScreen', 'the operator is naming an item'],
      ['SomeModScreen', 'an unrecognised screen might be anything']
    ]) {
      const closesBefore = closeCommands;
      body.chatWaitMs = 300;
      world.screenOpen = true;
      world.screen = screen;
      await body.refresh(true);
      const walked = await body.moveTo({ x: 30, y: 64, z: 0 }, { range: 1.5, timeoutMs: 1200 });
      check(
        `${screen} is left alone (${why})`,
        walked === false && closeCommands === closesBefore && body.lastMove.reason === 'screen-open',
        `walk=${walked} closes=${closeCommands - closesBefore}`
      );
    }

    // A real container is still closed, so the agent is not paralysed by its own menu.
    {
      const closesBefore = closeCommands;
      world.screenOpen = true;
      world.screen = 'ChestScreen';
      await body.refresh(true);
      const walked = await body.moveTo({ x: 4, y: 64, z: 0 }, { range: 2, timeoutMs: 6000 });
      check(
        'a container screen is still closed so the walk can continue',
        walked === true && closeCommands > closesBefore && world.screenOpen === false,
        `walk=${walked} closes=${closeCommands - closesBefore}`
      );
    }

    // `closeMenu()` is the skills' own path; it must not become a general dismiss either.
    {
      const closesBefore = closeCommands;
      const ok = await body.closeMenu();
      check('closeMenu() still issues the close verb for the container skills', ok === true && closeCommands > closesBefore, `ok=${ok}`);
    }
    world.screenOpen = false;
    world.screen = 'null';
    await body.refresh(true);

    const dug = await body.dig({ name: 'minecraft:stone', position: { x: 5, y: 64, z: 0 } }, { timeoutMs: 5000 });
    check('dig() polls until the block is gone', dug === true);
    await body.refresh(true);
    check('dig() result is visible in the next snapshot', body.blockAt({ x: 5, y: 64, z: 0 }) === null);
    check('dig() yield landed in the inventory', (body.snapshot().inventory['minecraft:stone'] || 0) >= 1);

    // ---- dig-while-walking: one tunnel action, actual dug cells reported ----
    // The planned-route test above replaced this part of the grid with air, so put a fresh
    // solid block on the tunnel line: the controller must dig it and report it.
    world.blocks.cells['7,64,0'] = 'minecraft:stone';
    const tunneled = await body.tunnel([
      { x: 6, y: 64, z: 0 },
      { x: 7, y: 64, z: 0 }
    ]);
    check(
      'tunnel() runs as one action and reports the cells it dug',
      tunneled.ok === true &&
        tunneled.dugCells.length >= 1 &&
        tunneled.dugCells.some((c) => c.x === 7 && c.y === 64),
      JSON.stringify(tunneled)
    );
    check(
      'tunnel() ends standing on the last waypoint',
      body.snapshot().position.x === 7 && body.snapshot().position.z === 0,
      JSON.stringify(body.snapshot().position)
    );

    // ---- corridor target protection (C21 / CP7) ---------------------------
    world.blocks.cells['8,64,0'] = 'minecraft:diamond_ore';
    const protectedRun = await body.tunnel([{ x: 8, y: 64, z: 0 }], { protect: { blocks: ['diamond_ore'] } });
    check(
      'tunnel(): a protected ore stops the run with the structured reason and cell',
      protectedRun.ok === false &&
        protectedRun.reason === 'target_requires_acquisition' &&
        protectedRun.cell &&
        protectedRun.cell.x === 8 &&
        /diamond_ore/.test(String(protectedRun.block)),
      JSON.stringify(protectedRun)
    );
    check(
      'tunnel(): the protect list travelled the wire in the documented form',
      /protect diamond_ore/.test(String(lastTunnelCommand)),
      String(lastTunnelCommand)
    );
    check('tunnel(): the protected block survived the stop', !!world.blocks.cells['8,64,0']);
    const unprotected = await body.tunnel([{ x: 8, y: 64, z: 0 }]);
    check(
      'tunnel(): without the protect list the same ore is dug (legacy behaviour)',
      unprotected.ok === true && !world.blocks.cells['8,64,0'],
      JSON.stringify(unprotected)
    );

    // ---- pillar receipts (P4 / plan §5.4.1; B8 protocol side) -------------
    /**
     * The old `pillar()` padded a missing `steps` field with the requested count, which is
     * how "only rose one block" reported success for three. These checks pin the receipt
     * discipline: explicit fields pass through, a missing `steps` is a failure with 0
     * performed, and a verdict for another action never counts.
     */
    pillarFinal = {
      steps: 1,
      start: { x: 7, y: 64, z: 0 },
      end: { x: 7, y: 65, z: 0 },
      placedCells: [{ x: 7, y: 64, z: 0 }]
    };
    const hop = await body.pillar(1, { timeoutMs: 3000 });
    check(
      'pillar() passes the per-hop receipt through (start/end/placedCells)',
      hop.ok === true && hop.steps === 1 && !!hop.start && !!hop.end && hop.placedCells.length === 1,
      JSON.stringify(hop)
    );

    pillarFinal = { steps: undefined };
    const noSteps = await body.pillar(1, { timeoutMs: 3000 });
    check(
      'pillar(): a missing steps field is not padded with the requested count',
      noSteps.ok === false && noSteps.steps === 0 && /no pillar steps/i.test(String(noSteps.reason)),
      JSON.stringify(noSteps)
    );

    pillarFinal = { action: 'dig', steps: 1 };
    const wrongAction = await body.pillar(1, { timeoutMs: 3000 });
    check(
      'pillar(): a verdict for a different action is rejected',
      wrongAction.ok === false && wrongAction.steps === 0,
      JSON.stringify(wrongAction)
    );
    pillarFinal = null;

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

    // ---- the plan path: CraftTask must use the menu skill, not fail on supportsCrafting ----
    // Live A13-4 (2026-10-18): `!craft` worked, but a plan step `type:"craft"` went through
    // CraftTask -> supportsCrafting=false and failed instead of using the same grid clicks.
    world.menu = null;
    world.craftOpen = false;
    world.grid = new Array(9).fill(null);
    world.carried = null;
    world.inventory = { 'minecraft:oak_log': 2 };
    await body.refresh(true);
    const { CraftTask } = require('../src/tasks/craft');
    const craftTask = new CraftTask(craftCtx, { item: 'oak_planks', count: 4 });
    const craftTaskResult = await craftTask.execute();
    await body.refresh(true);
    check(
      'CraftTask (plan path) delegates to the menu-capable craft skill',
      craftTaskResult.ok === true && (body.snapshot().inventory['minecraft:oak_planks'] || 0) >= 4,
      JSON.stringify({ result: craftTaskResult, inventory: body.snapshot().inventory }).slice(0, 260)
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
    // The password is never a literal in this repo: export MC_AUTHME_PASSWORD to run the
    // real login against a live server, otherwise the probe uses a throwaway sentinel.
    const probePassword = process.env.MC_AUTHME_PASSWORD || 'probe-password';
    const loggedIn = await body.login(probePassword);
    check('login() sends the AuthMe command', loggedIn === true, `chat log: ${JSON.stringify(chatLog)}`);

    const chatted = await body.chat('/say hello');
    check('chat() with a slash routes to cmd', chatted === true, `chat log: ${JSON.stringify(chatLog)}`);
    check('login went out as "login <pw>" (no double slash)', chatLog.includes(`login ${probePassword}`));

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
