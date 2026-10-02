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
        const menu = world.menu || {
          open: true,
          containerId: 0,
          size: 46,
          menuClass: 'InventoryMenu',
          carried: { item: 'null', count: 0 },
          slots: []
        };
        return send({ command, ok: true, menu });
      }
      if (verb === 'click') {
        const [slot, button, mode] = args.split(/\s+/);
        clicks.push({ slot: Number(slot), button: Number(button || 0), mode: mode || 'pickup' });
        if ((mode || 'pickup') === 'quickmove' && Number(slot) === 2 && world.menu && world.menu.slots[2]) {
          world.inventory['minecraft:stone'] = (world.inventory['minecraft:stone'] || 0) + world.menu.slots[2].count;
          world.menu.slots[2].item = 'null';
          world.menu.slots[2].count = 0;
        }
        return send({ command, ok: true });
      }
      if (verb === 'close') {
        world.menu = null;
        world.screenOpen = false;
        world.screen = 'null';
        closeCommands += 1;
        return send({ command, ok: true });
      }
      if (verb === 'look') {
        const [yaw, pitch] = args.split(/\s+/).map(Number);
        world.yaw = yaw;
        world.pitch = pitch;
        // Simulate "something comes into view" for the sweep test.
        if (world.sweepTarget && Math.abs(((yaw % 360) + 360) % 360 - 180) < 45) {
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
    await body.refresh(true);
    check('the withdrawal is visible in the inventory', (body.snapshot().inventory['minecraft:stone'] || 0) >= 5);
    const closed = await body.closeMenu();
    check('closeMenu() closes the container', closed === true);

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
