'use strict';

/**
 * `npm run skills:test` - offline acceptance for the new skill layer (src/skills).
 *
 * The skills are the rewritten operation catalogue: equip/eat/drop/armour, place/use,
 * attack/defend, explore/come, chest withdraw/deposit. Everything here runs against
 * MockBody or a scripted stub body, so the catalogue is verified without a game - which is
 * the only way to keep a growing capability surface honest between live sessions.
 */

const { MockBody } = require('../src/body/mockBody');
const { Body } = require('../src/body/body');
const { loadConfig } = require('../src/util/config');
const skills = require('../src/skills');

const cfg = loadConfig({ profile: null });
const log = { debug() {}, info() {}, warn() {}, error() {} };

const results = [];

async function scenario(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    process.stdout.write(`  PASS  ${name}${detail ? ` - ${detail}` : ''}  (${Date.now() - started}ms)\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}  (${Date.now() - started}ms)\n`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function makeCtx(body, extra = {}) {
  return { cfg, log, body, mods: null, world: body, ...extra };
}

/**
 * A solid stone slab with an optional carved corridor.
 *
 * Mining fixtures cannot be sparse: the skill's cavern rule stops when the space around the
 * tunnel is more than 45% air, which every sparse mock world is. Real rock + a 1-wide
 * corridor keeps the geometry honest (and gives `dangerAt` a floor to find).
 */
function mineWorld({ minX = -12, maxX = 12, corridor = [], extras = [] } = {}) {
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

/** A hand-built body that only implements the menu protocol, for container/armour flows. */
class MenuBody extends Body {
  constructor(cfg, script) {
    super(cfg);
    this.kind = 'menu-stub';
    this.script = script;
    this.calls = [];
  }

  async connect() {}
  async disconnect() {}
  snapshot() {
    return { ready: true, inventory: {}, position: { x: 0, y: 64, z: 0 }, players: [] };
  }
  async moveTo() {
    return true;
  }
  async menu() {
    this.calls.push({ call: 'menu' });
    return this.script.menu();
  }
  async clickSlot(slot, options = {}) {
    this.calls.push({ call: 'click', slot, mode: options.mode || 'pickup' });
    if (this.script.click) this.script.click(slot, options);
    return true;
  }
  async useOn(position) {
    this.calls.push({ call: 'useOn', position });
    if (this.script.useOn) this.script.useOn(position);
    return true;
  }
  async closeMenu() {
    this.calls.push({ call: 'close' });
    return true;
  }
  async equipArmor() {
    return false;
  }
}

(async () => {
  process.stdout.write('minecraft-survival-agent - skill catalogue test (offline)\n\n');

  // ------------------------------------------------------------------ registry
  process.stdout.write('1. registry - names, schema, refusals\n');

  await scenario('the catalogue exposes the full operation set', () => {
    const names = skills.names();
    const required = [
      'equip', 'eat', 'drop', 'armor', 'place', 'use_on',
      'attack', 'defend', 'explore', 'come', 'withdraw', 'deposit', 'craft'
    ];
    const missing = required.filter((name) => !names.includes(name));
    expect(!missing.length, `missing skills: ${missing.join(', ')}`);
    return `${names.length} skills registered`;
  });

  await scenario('an unknown skill is refused with the list of real ones', async () => {
    const result = await skills.run('fly_to_moon', makeCtx(null), {});
    expect(!result.ok, 'an unknown skill must not run');
    expect(/unknown skill/.test(result.reason), `reason should say unknown skill, got "${result.reason}"`);
    return result.reason.slice(0, 60);
  });

  await scenario('a missing required parameter is refused before anything runs', async () => {
    const body = new MockBody(cfg, { inventory: { 'minecraft:iron_pickaxe': 1 } });
    await body.connect();
    const result = await skills.run('equip', makeCtx(body), {});
    expect(!result.ok && /missing parameter "item"/.test(result.reason), `got "${result.reason}"`);
    return result.reason;
  });

  await scenario('an unknown parameter is refused rather than ignored', async () => {
    const body = new MockBody(cfg, {});
    await body.connect();
    const result = await skills.run('eat', makeCtx(body), { flavour: 'spicy' });
    expect(!result.ok && /unknown parameter "flavour"/.test(result.reason), `got "${result.reason}"`);
    return result.reason;
  });

  // ------------------------------------------------------------------ inventory
  process.stdout.write('\n2. inventory - equip / eat / drop\n');

  await scenario('equip holds a carried item, and refuses one that is not there', async () => {
    const body = new MockBody(cfg, { inventory: { 'minecraft:iron_pickaxe': 1 } });
    await body.connect();
    const ok = await skills.run('equip', makeCtx(body), { item: 'iron_pickaxe' });
    expect(ok.ok, `expected equip to work, got ${ok.reason}`);
    expect(body.held === 'minecraft:iron_pickaxe', `held ${body.held}`);
    const missing = await skills.run('equip', makeCtx(body), { item: 'diamond_sword' });
    expect(!missing.ok && /not in the inventory/.test(missing.reason), `got "${missing.reason}"`);
    return `held ${body.held}`;
  });

  await scenario('eat picks the best carried food without being told which', async () => {
    const body = new MockBody(cfg, { inventory: { 'minecraft:rotten_flesh': 2, 'minecraft:cooked_beef': 1 } });
    await body.connect();
    const result = await skills.run('eat', makeCtx(body), {});
    expect(result.ok, `expected eating to work, got ${result.reason}`);
    expect(body.stats.ate === 1, `stats.ate=${body.stats.ate}`);
    expect(body.inventory['minecraft:rotten_flesh'] === 2, 'the worse food must be left alone');
    expect(!body.inventory['minecraft:cooked_beef'], 'the cooked beef should be gone');
    return result.detail;
  });

  await scenario('drop removes exactly the requested count', async () => {
    const body = new MockBody(cfg, { inventory: { 'minecraft:dirt': 5 } });
    await body.connect();
    const result = await skills.run('drop', makeCtx(body), { item: 'dirt', count: 2 });
    expect(result.ok, `expected drop to work, got ${result.reason}`);
    expect(body.inventory['minecraft:dirt'] === 3, `left ${body.inventory['minecraft:dirt']}`);
    return result.detail;
  });

  await scenario('armour quick-moves every piece and reads the slots back', async () => {
    let landed = false;
    const body = new MenuBody(cfg, {
      menu: () => ({
        open: true,
        containerId: 0,
        menuClass: 'InventoryMenu',
        slots: landed
          ? [
              { i: 5, item: 'minecraft:iron_helmet', count: 1, player: true },
              { i: 6, item: 'minecraft:iron_chestplate', count: 1, player: true },
              { i: 10, item: 'null', count: 0, player: true }
            ]
          : [
              { i: 5, item: 'null', count: 0, player: true },
              { i: 10, item: 'minecraft:iron_helmet', count: 1, player: true },
              { i: 11, item: 'minecraft:iron_chestplate', count: 1, player: true }
            ]
      }),
      click: () => {
        landed = true;
      }
    });
    await body.connect();
    const result = await skills.run('armor', makeCtx(body), {});
    expect(result.ok, `expected armour to work, got ${result.reason}`);
    const quickMoves = body.calls.filter((call) => call.call === 'click' && call.mode === 'quickmove');
    expect(quickMoves.length === 2, `expected 2 quick-moves, saw ${quickMoves.length}`);
    return result.detail;
  });

  // ------------------------------------------------------------------ blocks
  process.stdout.write('\n3. blocks - place / use_on\n');

  await scenario('place puts a carried block above the reference position', async () => {
    const body = new MockBody(cfg, {
      blocks: [{ name: 'grass_block', position: { x: 0, y: 63, z: 0 } }],
      inventory: { 'minecraft:cobblestone': 1 }
    });
    await body.connect();
    const result = await skills.run('place', makeCtx(body), { item: 'cobblestone', x: 0, y: 63, z: 0, face: 'up' });
    expect(result.ok, `expected place to work, got ${result.reason}`);
    const placed = body.blockAt({ x: 0, y: 64, z: 0 });
    expect(placed && /cobblestone/.test(placed.name), `block at 0,64,0 is ${placed && placed.name}`);
    return result.detail;
  });

  await scenario('use_on right-clicks the named block face', async () => {
    const body = new MockBody(cfg, { blocks: [{ name: 'dirt', position: { x: 2, y: 64, z: 0 } }] });
    await body.connect();
    const result = await skills.run('use_on', makeCtx(body), { x: 2, y: 64, z: 0, face: 'up' });
    expect(result.ok, `expected use_on to work, got ${result.reason}`);
    const used = body.history.filter((entry) => entry.action === 'use');
    expect(used.length === 1, `expected 1 use, saw ${used.length}`);
    return result.detail;
  });

  // ------------------------------------------------------------------ combat
  process.stdout.write('\n4. combat - attack / defend\n');

  await scenario('attack finds the nearest hostile and kills it', async () => {
    const body = new MockBody(cfg, {
      entities: [
        { id: 1, name: 'minecraft:zombie', kind: 'hostile', alive: true, position: { x: 6, y: 64, z: 0 } },
        { id: 2, name: 'minecraft:skeleton', kind: 'hostile', alive: true, position: { x: 2, y: 64, z: 0 } }
      ]
    });
    await body.connect();
    const result = await skills.run('attack', makeCtx(body), { maxDistance: 8 });
    expect(result.ok, `expected attack to work, got ${result.reason}`);
    expect(/skeleton/.test(result.detail), `should have picked the nearer skeleton, got "${result.detail}"`);
    return result.detail;
  });

  await scenario('attack reports "no hostile" instead of inventing a target', async () => {
    const body = new MockBody(cfg, { entities: [] });
    await body.connect();
    const result = await skills.run('attack', makeCtx(body), {});
    expect(!result.ok && /no hostile/.test(result.reason), `got "${result.reason}"`);
    return result.reason;
  });

  await scenario('attack escalates the search radius instead of refusing at 8 blocks', async () => {
    // The live report: zombies ~10 blocks away, `!attack` refused because the default
    // looked only 8 blocks. One escalation step now runs before giving up.
    const body = new MockBody(cfg, {
      entities: [{ id: 1, name: 'minecraft:zombie', kind: 'hostile', alive: true, position: { x: 12, y: 64, z: 0 } }]
    });
    await body.connect();
    const result = await skills.run('attack', makeCtx(body), { maxDistance: 8 });
    expect(result.ok, `expected the escalation to find the zombie, got ${result.reason}`);
    return result.detail;
  });

  await scenario('attack on a dead bot says so instead of "no hostile"', async () => {
    const body = new MockBody(cfg, {});
    await body.connect();
    const base = body.snapshot();
    body.snapshot = () => ({ ...base, dead: true });
    const result = await skills.run('attack', makeCtx(body), {});
    expect(!result.ok && /dead/.test(result.reason), `got "${result.reason}"`);
    return result.reason;
  });

  await scenario('defend clears everything in range and then stands down', async () => {
    const body = new MockBody(cfg, {
      entities: [
        { id: 1, name: 'minecraft:zombie', kind: 'hostile', alive: true, position: { x: 3, y: 64, z: 0 } },
        { id: 2, name: 'minecraft:zombie', kind: 'hostile', alive: true, position: { x: 4, y: 64, z: 0 } }
      ]
    });
    await body.connect();
    const result = await skills.run('defend', makeCtx(body), { range: 6 });
    expect(result.ok, `expected defend to work, got ${result.reason}`);
    expect(body.stats.attacked === 2, `attacked ${body.stats.attacked}`);
    return result.detail;
  });

  await scenario('mine_ore: a monster inside the ±3 box stops the task before digging', async () => {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 20, z: 0 },
      blocks: [{ name: 'iron_ore', position: { x: 6, y: 20, z: 0 } }],
      entities: [{ id: 9, name: 'minecraft:zombie', kind: 'hostile', position: { x: 2, y: 21, z: 1 } }],
      inventory: { 'minecraft:stone_pickaxe': 1 }
    });
    await body.connect();
    const result = await skills.run('mine_ore', makeCtx(body), { maxMs: 20000, eatAt: 1 });
    expect(result.stopped === 'hostile', `expected a hostile stop, got ${JSON.stringify(result)}`);
    expect(
      !body.history.some((h) => h.action === 'dig'),
      'nothing may be dug while a monster is inside the avoidance box'
    );
    return result.detail;
  });

  await scenario('mine_ore: quotes pick the cheaper ore (open beats encased-nearer)', async () => {
    /**
     * numen's look -> plan rule in a fixture: reaching the near ore at (3,64,0) means digging
     * four stone cells through a wall; the farther ore at (-7,64,0) sits in open air. The
     * quote must pick the open one first even though it is farther.
     */
    /** Rock with a carved corridor to the open ore; the near ore is left behind solid stone. */
    const corridor = [];
    for (let x = 0; x >= -6; x -= 1) corridor.push({ x, y: 64, z: 0 }, { x, y: 65, z: 0 });
    corridor.push({ x: -7, y: 65, z: 0 });
    const blocks = mineWorld({
      corridor,
      extras: [
        { name: 'iron_ore', position: { x: -7, y: 64, z: 0 } },
        { name: 'iron_ore', position: { x: 3, y: 64, z: 0 } }
      ]
    });
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks,
      inventory: { 'minecraft:stone_pickaxe': 1 }
    });
    await body.connect();
    const result = await skills.run('mine_ore', makeCtx(body), { maxMs: 30000, eatAt: 1 });
    expect(result.ok, `expected the skill to finish, got ${JSON.stringify(result)}`);
    expect(Array.isArray(result.minedAt) && result.minedAt.length === 2, `expected both ores, got ${JSON.stringify(result.minedAt)}`);
    expect(
      result.minedAt[0].position.x === -7,
      `expected the open ore (-7) first, got ${JSON.stringify(result.minedAt[0])} (plan=${JSON.stringify(result.plan)})`
    );
    expect(
      result.ledger && result.ledger.extra === 0,
      `a static world must not need digs outside the plan: ${JSON.stringify(result.ledger)}`
    );
    return `first ${result.minedAt[0].position.x}, plan digs ${result.plan && result.plan.digs}, ledger ${JSON.stringify(result.ledger)}`;
  });

  await scenario('mine_ore: refuses a tunnel that would drop sand and takes the open ore', async () => {
    /**
     * The near ore needs a head cell at (1,65) with sand directly above it - digging it would
     * drop the sand on the bot, so the quote refuses that target before any dig happens
     * (numen: 受理之前判"顶着落沙"), and the open ore is mined instead.
     */
    const corridor = [];
    for (let x = 0; x >= -4; x -= 1) corridor.push({ x, y: 64, z: 0 }, { x, y: 65, z: 0 });
    corridor.push({ x: -5, y: 65, z: 0 });
    const blocks = mineWorld({
      minX: -10,
      maxX: 10,
      corridor,
      extras: [
        { name: 'sand', position: { x: 1, y: 66, z: 0 } },
        { name: 'iron_ore', position: { x: -5, y: 64, z: 0 } },
        { name: 'iron_ore', position: { x: 3, y: 64, z: 0 } }
      ]
    });
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks,
      inventory: { 'minecraft:stone_pickaxe': 1 }
    });
    await body.connect();
    const result = await skills.run('mine_ore', makeCtx(body), { maxMs: 30000, eatAt: 1 });
    expect(result.ok, `expected a graceful finish, got ${JSON.stringify(result)}`);
    expect(result.mined === 1 && result.minedAt[0].position.x === -5, `expected only the open ore, got ${JSON.stringify(result.minedAt)}`);
    expect(result.rejectedTargets >= 1, `the sand target was not rejected up front: ${JSON.stringify(result)}`);
    expect(
      !body.history.some((h) => h.action === 'dig' && /sand/.test(h.name)),
      'the falling sand must never be dug'
    );
    return `mined x=-5, rejected ${result.rejectedTargets} target(s), sand untouched`;
  });

  await scenario('mine_ore: a tunnel that stops at a named cell clears it and retries', async () => {
    /**
     * The client controller reports the exact cell that stopped it (numen's structured
     * execution reason). The skill must dig that cell once and re-run the tunnel instead of
     * jumping at it again - the offline stand-in for "a dig the server did not confirm".
     */
    const blocks = mineWorld({
      minX: -4,
      maxX: 6,
      corridor: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }],
      extras: [{ name: 'iron_ore', position: { x: 3, y: 64, z: 0 } }]
    });
    const body = new MockBody(cfg, { start: { x: 0, y: 64, z: 0 }, blocks, inventory: { 'minecraft:stone_pickaxe': 1 } });
    await body.connect();
    const realTunnel = body.tunnel.bind(body);
    let failedOnce = false;
    body.tunnel = async (waypoints, options) => {
      if (!failedOnce) {
        failedOnce = true;
        return {
          ok: false,
          reason: 'jump-blocked',
          cell: { x: 1, y: 64, z: 0 },
          block: 'minecraft:stone',
          dugCells: []
        };
      }
      return realTunnel(waypoints, options);
    };
    const result = await skills.run('mine_ore', makeCtx(body), { maxMs: 30000, eatAt: 1 });
    expect(failedOnce, 'the tunnel was never made to fail');
    expect(result.ok && result.mined === 1, `expected the ore to be mined after the retry, got ${JSON.stringify(result)}`);
    expect(result.tunnel && result.tunnel.runs === 2, `expected exactly one retry, got ${JSON.stringify(result.tunnel)}`);
    expect(
      body.history.some((h) => h.action === 'dig' && h.position.x === 1 && h.position.y === 64 && /stone/.test(h.name)),
      'the cell the tunnel named was not cleared'
    );
    expect(result.ledger.extra === 0, `clearing a planned cell must not count as extra: ${JSON.stringify(result.ledger)}`);
    return `cleared (1,64,0), tunnel runs ${result.tunnel.runs}, ledger ${JSON.stringify(result.ledger)}`;
  });

  await scenario('mine_ore: refuses a tunnel waypoint that hangs over a deep drop', async () => {
    /**
     * The quoted stair descends toward an ore below, but this world has no floor under the
     * first waypoint (below y=63 is missing -> air). The pre-run `dangerAt` admission must
     * stop the task with `danger` before the continuous tunnel is handed to the client - the
     * Node half of the anti-fall pair.
     */
    const blocks = mineWorld({
      minX: -4,
      maxX: 6,
      corridor: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }],
      extras: [{ name: 'iron_ore', position: { x: 3, y: 62, z: 0 } }]
    });
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks,
      inventory: { 'minecraft:stone_pickaxe': 1 }
    });
    await body.connect();
    let tunnelCalled = false;
    body.tunnel = async () => {
      tunnelCalled = true;
      return { ok: true, reason: null, cell: null, block: null, dugCells: [] };
    };
    const result = await skills.run('mine_ore', makeCtx(body), { maxMs: 20000, eatAt: 1 });
    expect(!tunnelCalled, 'the tunnel must not run toward a waypoint hanging over a deep drop');
    expect(result.stopped === 'danger', `expected a danger stop, got ${JSON.stringify(result)}`);
    expect(/drop below/.test(result.detail || ''), `expected the drop to be named: ${result.detail}`);
    expect(!body.history.some((h) => h.action === 'dig'), 'nothing may be dug toward the drop');
    return result.detail;
  });

  await scenario('mine_ore: a tunnel that breaks into a cavern stops the task', async () => {
    /**
     * Floor-only world: every waypoint has solid ground below it (the pre-check passes), but
     * the space around the tunnel is open air. The post-run openness check must catch what a
     * one-shot pre-check cannot see and stop the task like the direct stair path does.
     */
    const blocks = [];
    for (let x = -8; x <= 8; x += 1) {
      for (let z = -4; z <= 4; z += 1) blocks.push({ name: 'stone', position: { x, y: 63, z } });
    }
    blocks.push({ name: 'iron_ore', position: { x: 3, y: 64, z: 0 } });
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks,
      inventory: { 'minecraft:stone_pickaxe': 1 }
    });
    await body.connect();
    const result = await skills.run('mine_ore', makeCtx(body), { maxMs: 20000, eatAt: 1 });
    expect(result.stopped === 'cavern', `expected a cavern stop, got ${JSON.stringify(result)}`);
    expect(result.mined === 0, `the ore behind the cavern must not be taken: mined ${result.mined}`);
    return result.detail;
  });

  await scenario('mine_ore: re-equips the pickaxe for the tunnel after eating', async () => {
    /**
     * Eating puts the food in the main hand (MockBody now models that), and the tunnel rung
     * digs client-side with whatever is held for the whole run. The skill must put the
     * pickaxe back before handing the plan over - the live run carved a stone stair holding
     * bread (2026-10-08).
     */
    const blocks = mineWorld({
      minX: -4,
      maxX: 6,
      corridor: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }],
      extras: [{ name: 'gold_ore', position: { x: 3, y: 64, z: 0 } }]
    });
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks,
      food: 10,
      inventory: { 'minecraft:iron_pickaxe': 1, 'minecraft:bread': 2 }
    });
    await body.connect();
    const heldAtTunnel = [];
    const realTunnel = body.tunnel.bind(body);
    body.tunnel = async (waypoints, options) => {
      heldAtTunnel.push(body.held);
      return realTunnel(waypoints, options);
    };
    await skills.run('mine_ore', makeCtx(body), {
      ore: 'gold_ore',
      maxMs: 30000,
      eatAt: 18,
      food: 'bread'
    });
    expect(body.stats.ate >= 1, 'the fixture never actually ate');
    expect(heldAtTunnel.length > 0, 'the tunnel rung never ran');
    expect(
      heldAtTunnel.every((held) => /pickaxe/.test(String(held))),
      `the tunnel ran holding ${JSON.stringify(heldAtTunnel)}`
    );
    return `ate ${body.stats.ate}, tunnel held ${heldAtTunnel.join(',')}`;
  });

  await scenario("mine_ore: accepts the LLM's block/count phrasing and honours the cap", async () => {
    /**
     * The model naturally says `{block: 'diamond_ore', count: 32}`; the skill used to reject
     * that with "unknown parameter" and the request fell through to the walk-only task, which
     * cannot reach embedded ores (live 2026-10-10 diamond run). `block` is now an alias for
     * `ore` (comma list allowed) and `count` caps how many ores are taken.
     */
    const blocks = mineWorld({
      minX: -8,
      maxX: 8,
      corridor: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }],
      extras: [
        { name: 'gold_ore', position: { x: 3, y: 64, z: 0 } },
        { name: 'deepslate_gold_ore', position: { x: -3, y: 64, z: 0 } }
      ]
    });
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks,
      inventory: { 'minecraft:iron_pickaxe': 1 }
    });
    await body.connect();
    const result = await skills.run('mine_ore', makeCtx(body), {
      block: 'gold_ore,deepslate_gold_ore',
      count: 1,
      maxMs: 30000,
      eatAt: 1
    });
    expect(result.ok, `the alias run failed: ${JSON.stringify(result)}`);
    expect(result.mined === 1, `the count cap must stop at one ore, got ${result.mined}`);
    expect(result.stopped === 'count', `expected stopped:"count", got ${JSON.stringify(result.stopped)}`);
    return `block/count alias accepted; mined ${result.mined}, stopped ${result.stopped}`;
  });

  /**
   * P4 (plan §5.4 / §6.2): the iterative single-cell pillar.
   *
   * `makeShaftRig` builds the live failure's geometry: a 1-wide column, feet at y=64,
   * stone caps all the way up and the ore floating above them. The stair cannot climb
   * (upward `moveTo` fails), the client tunnel reports `stuck`, and the ore is only
   * diggable when no solid cell sits between the feet and it - the mock has no raycast,
   * so the rig models occlusion explicitly.
   */
  const makeShaftRig = ({ oreY = 70, cobble = 8, refuseDigAt = null, hopFailAt = null, hopLieAt = null } = {}) => {
    /**
     * Real caps above the slab: the stone floor fixture stops at y=66, so every cell
     * between it and the ore is explicitly solid unless the test says otherwise.
     */
    const extras = [{ name: 'gold_ore', position: { x: 0, y: oreY, z: 0 } }];
    for (let y = 67; y < oreY; y += 1) extras.push({ name: 'stone', position: { x: 0, y, z: 0 } });
    const blocks = mineWorld({
      minX: -6,
      maxX: 6,
      corridor: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }],
      extras
    });
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks,
      inventory: { 'minecraft:iron_pickaxe': 1, 'minecraft:cobblestone': cobble }
    });
    const orePos = { x: 0, y: oreY, z: 0 };
    const digLog = [];
    const hopLog = [];
    const rig = { body, orePos: { ...orePos }, digLog, hopLog };
    rig.setup = async () => {
      await body.connect();
      body.tunnel = async () => ({ ok: false, reason: 'stuck', cell: null, block: null, dugCells: [] });
      const realMoveTo = body.moveTo.bind(body);
      body.moveTo = async (position, options) => {
        if (Math.floor(position.y) > Math.floor(body.position.y)) return false;
        return realMoveTo(position, options);
      };
      const realDig = body.dig.bind(body);
      body.dig = async (block, options) => {
        const p = block && block.position;
        const feet = { x: Math.floor(body.position.x), y: Math.floor(body.position.y), z: Math.floor(body.position.z) };
        digLog.push({ cell: p ? { ...p } : null, feet, held: body.held });
        if (!p) return false;
        if (p.x === orePos.x && p.y === orePos.y && p.z === orePos.z) {
          for (let y = feet.y + 1; y < orePos.y; y += 1) {
            const entry = body.world.get(`${orePos.x},${y},${orePos.z}`);
            if (entry && !/air$/.test(String(entry.name))) return false; // occluded
          }
        }
        if (refuseDigAt && p.x === refuseDigAt.x && p.y === refuseDigAt.y && p.z === refuseDigAt.z) return false;
        return realDig(block, options);
      };
      const realPillar = body.pillar.bind(body);
      let hops = 0;
      body.pillar = async (count, options) => {
        hops += 1;
        hopLog.push({ count, held: body.held, feetY: Math.floor(body.position.y) });
        if (hopFailAt && hops >= hopFailAt) return { ok: false, steps: 0, reason: 'place-failed' };
        if (hopLieAt && hops >= hopLieAt) return { ok: true, steps: 1, reason: null }; // claims success, does not move
        return realPillar(count, options);
      };
    };
    return rig;
  };

  await scenario('B1/B2: iterative pillar clears cap by cap, rises 3+, mines the ore', async () => {
    const rig = makeShaftRig({ oreY: 70, cobble: 8 });
    await rig.setup();
    const result = await skills.run('mine_ore', makeCtx(rig.body), { ore: 'gold_ore', maxY: 16, maxMs: 30000, eatAt: 1 });
    expect(result.ok && result.mined === 1, `expected the ore after pillaring, got ${JSON.stringify(result)}`);
    expect(result.pillar && result.pillar.rises >= 3, `expected >=3 rises, got ${JSON.stringify(result.pillar)}`);
    const pillars = rig.body.history.filter((h) => h.action === 'pillar');
    expect(pillars.length >= 3 && pillars.every((p) => p.steps === 1), `one-hop requests expected, got ${JSON.stringify(pillars)}`);
    expect(rig.hopLog.every((h) => h.count === 1), `pillar requests must be single-hop: ${JSON.stringify(rig.hopLog)}`);
    expect(rig.hopLog.every((h) => /cobblestone/.test(String(h.held))), 'the support block must be held for a hop');
    // B2: caps above the start reach are only dug after a real rise, and no dig ever
    // exceeds the Mod's own 4.5-block admission.
    const highCaps = rig.digLog.filter((d) => d.cell && d.cell.x === 0 && d.cell.z === 0 && d.cell.y >= 68);
    expect(highCaps.length >= 1, 'the rig should have cleared high caps');
    expect(highCaps.every((d) => d.feet.y >= 65), `caps dug too early: ${JSON.stringify(highCaps)}`);
    const reach = (d) => Math.hypot(d.feet.x - d.cell.x, d.feet.y - (d.cell.y + 0.5), d.feet.z - d.cell.z);
    expect(rig.digLog.filter((d) => d.cell).every((d) => reach(d) <= 4.5 + 1e-6), 'a dig beyond 4.5 blocks was sent');
    expect(result.minedAt && result.minedAt[0] && result.minedAt[0].position.y === 70, 'minedAt should name the ore');
    return `rises=${result.pillar.rises}, hops=${rig.hopLog.length}, digs=${rig.digLog.length}`;
  });

  await scenario('B3: hop 2 fails - the first rise is kept and the hop is not blindly re-sent', async () => {
    /**
     * The live bug this pins: a failed `pillar(n)` made the old rung retry with `n-1`
     * from scratch, throwing the completed hop away. Digging stone also replenishes the
     * scaffold stack with cobblestone, so "material runs out" is not a reliable failure
     * fixture - a failing second hop is.
     */
    const rig = makeShaftRig({ oreY: 70, cobble: 8, hopFailAt: 2 });
    await rig.setup();
    const result = await skills.run('mine_ore', makeCtx(rig.body), { ore: 'gold_ore', maxY: 16, maxMs: 30000, eatAt: 1 });
    expect(result.mined === 0, `no ore should be mined, got ${result.mined}`);
    expect(result.pillar && result.pillar.rises === 1, `the first rise must survive, got ${JSON.stringify(result.pillar)}`);
    const pillarCalls = rig.hopLog.length;
    expect(pillarCalls === 2, `one success + one failed hop, no re-send storm; got ${pillarCalls}`);
    expect(Math.floor(rig.body.position.y) === 65, `feet should have stayed at 65, got ${rig.body.position.y}`);
    const placed = rig.body.world.get('0,64,0');
    expect(placed && /cobblestone/.test(placed.name), 'the support block must be in the old feet cell');
    return `rises=1 kept, hop attempts=${pillarCalls} (second failed, not retried)`;
  });

  await skillsTestScenarioRefuseDig();

  async function skillsTestScenarioRefuseDig() {
    const rig = makeShaftRig({ oreY: 70, cobble: 8, refuseDigAt: { x: 0, y: 66, z: 0 } });
    await rig.setup();
    const warns = [];
    const captureLog = { debug() {}, info() {}, warn: (...args) => warns.push(args.join(' ')), error() {} };
    const result = await skills.run('mine_ore', makeCtx(rig.body, { log: captureLog }), { ore: 'gold_ore', maxY: 16, maxMs: 30000, eatAt: 1 });
    await scenario('B4: a refused headroom dig stops the climb with zero pillar hops', async () => {
      expect(result.mined === 0, `no ore expected, got ${result.mined}`);
      expect(rig.hopLog.length === 0, `no pillar hop may follow a refused dig, got ${rig.hopLog.length}`);
      expect((result.pillar && result.pillar.rises) === 0, 'no rise may be reported');
      expect(warns.some((w) => /could not clear the headroom cell 0,66,0|refusing to dig/.test(w)), `failure cell missing from logs: ${warns.join(' | ')}`);
      return 'refused dig kept as the failure location; zero pillars';
    });
  }

  await scenario('B5: the target ore in the next-hop headroom is reported blocked, never jumped through', async () => {
    const blocks = mineWorld({
      minX: -6,
      maxX: 6,
      corridor: [{ x: 0, y: 64, z: 0 }, { x: 0, y: 65, z: 0 }],
      extras: [{ name: 'gold_ore', position: { x: 0, y: 66, z: 0 } }]
    });
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks,
      inventory: { 'minecraft:iron_pickaxe': 1, 'minecraft:cobblestone': 8 }
    });
    await body.connect();
    body.tunnel = async () => ({ ok: false, reason: 'stuck', cell: null, block: null, dugCells: [] });
    const realMoveTo = body.moveTo.bind(body);
    body.moveTo = async (position, options) =>
      Math.floor(position.y) > Math.floor(body.position.y) ? false : realMoveTo(position, options);
    // Occlusion model: the ore at feet+2 cannot be taken from below in this fixture.
    const realDig = body.dig.bind(body);
    body.dig = async (block, options) => {
      const p = block && block.position;
      if (p && p.x === 0 && p.y === 66 && p.z === 0 && Math.floor(body.position.y) < 65) return false;
      return realDig(block, options);
    };
    const result = await skills.run('mine_ore', makeCtx(body), { ore: 'gold_ore', maxMs: 30000, eatAt: 1 });
    expect(result.mined === 0 && result.skipped >= 1, `expected a blocked skip, got ${JSON.stringify({ mined: result.mined, skipped: result.skipped })}`);
    const hops = body.history.filter((h) => h.action === 'pillar');
    expect(hops.length === 0, `the climb must not jump through the ore: ${JSON.stringify(hops)}`);
    return 'occluded target reported; no hop attempted';
  });

  await scenario('B7: cancellation after the first hop stops all further actions', async () => {
    const rig = makeShaftRig({ oreY: 70, cobble: 8 });
    await rig.setup();
    const signal = { cancelled: false, reason: null };
    let cancelledAt = null;
    const realPillar = rig.body.pillar.bind(rig.body);
    rig.body.pillar = async (count, options) => {
      const res = await realPillar(count, options);
      if (!signal.cancelled) {
        signal.cancelled = true;
        signal.reason = 'operator stop';
        cancelledAt = rig.body.history.length;
      }
      return res;
    };
    const result = await skills.run('mine_ore', makeCtx(rig.body, { taskSignal: signal }), { ore: 'gold_ore', maxY: 16, maxMs: 30000, eatAt: 1 });
    expect(result.interrupted === true, `expected an interrupted result, got ${JSON.stringify({ ok: result.ok, interrupted: result.interrupted })}`);
    expect(result.mined === 0, `nothing more may be mined, got ${result.mined}`);
    const after = rig.body.history.slice(cancelledAt);
    const sideEffects = after.filter((h) => ['dig', 'place', 'pillar', 'moveTo', 'tunnel'].includes(h.action));
    expect(sideEffects.length === 0, `actions continued after cancel: ${JSON.stringify(sideEffects)}`);
    return `stopped after 1 hop, ${after.length} bookkeeping entries, 0 side effects`;
  });

  await scenario('B8: a hop that claims success without moving is not counted as a rise', async () => {
    const rig = makeShaftRig({ oreY: 70, cobble: 8, hopLieAt: 1 });
    await rig.setup();
    const result = await skills.run('mine_ore', makeCtx(rig.body), { ore: 'gold_ore', maxY: 16, maxMs: 30000, eatAt: 1 });
    expect(rig.hopLog.length === 1, `the failed hop must not be re-sent, got ${rig.hopLog.length}`);
    expect((result.pillar && result.pillar.rises) === 0, `a phantom rise must not be reported: ${JSON.stringify(result.pillar)}`);
    expect(result.mined === 0, `no ore expected, got ${result.mined}`);
    return 'lying verdict rejected after bounded re-reads; one request only';
  });

  await scenario('B10-lite: a body without pillar capability degrades honestly', async () => {
    const rig = makeShaftRig({ oreY: 70, cobble: 8 });
    await rig.setup();
    rig.body.pillar = undefined; // the method lives on the prototype; an own-property shadow is the removal
    const result = await skills.run('mine_ore', makeCtx(rig.body), { ore: 'gold_ore', maxY: 16, maxMs: 30000, eatAt: 1 });
    expect(result.ok !== undefined && result.mined === 0, `expected an honest no-ore result, got ${JSON.stringify({ ok: result.ok, mined: result.mined })}`);
    return 'no pillar primitive: task reported honestly, no exception';
  });

  // ------------------------------------------------------------------ movement
  process.stdout.write('\n5. movement - explore / come\n');

  await scenario('explore walks a fresh direction and reports where it got to', async () => {
    const body = new MockBody(cfg, { start: { x: 0, y: 64, z: 0 } });
    await body.connect();
    const result = await skills.run('explore', makeCtx(body), { distance: 12, direction: 'east' });
    expect(result.ok, `expected explore to work, got ${result.reason}`);
    expect(body.position.x === 12, `expected x=12, got ${body.position.x}`);
    return result.detail;
  });

  await scenario('come walks to a visible player, and says so when they are not visible', async () => {
    const body = new MockBody(cfg, {});
    body.snapshot = () => ({
      ready: true,
      inventory: {},
      position: { x: 0, y: 64, z: 0 },
      players: [{ name: 'Alice', position: { x: 5, y: 64, z: 0 } }]
    });
    await body.connect();
    const ok = await skills.run('come', makeCtx(body), { player: 'Alice', range: 2 });
    expect(ok.ok, `expected come to work, got ${ok.reason}`);
    expect(body.position.x > 0, `expected to have walked, at x=${body.position.x}`);
    const missing = await skills.run('come', makeCtx(body), { player: 'Nobody' });
    expect(!missing.ok && /not visible/.test(missing.reason), `got "${missing.reason}"`);
    return ok.detail;
  });

  // ------------------------------------------------------------------ containers
  process.stdout.write('\n6. containers - withdraw / deposit (beta, menu path)\n');

  await scenario('withdraw opens a nearby chest, quick-moves the item, and closes it', async () => {
    let open = false;
    const body = new MenuBody(cfg, {
      menu: () =>
        open
          ? {
              open: true,
              containerId: 7,
              menuClass: 'ChestMenu',
              slots: [
                { i: 0, item: 'minecraft:iron_ingot', count: 5, player: false },
                { i: 27, item: 'null', count: 0, player: true }
              ]
            }
          : { open: true, containerId: 0, menuClass: 'InventoryMenu', slots: [] },
      useOn: () => {
        open = true;
      }
    });
    await body.connect();
    const ctx = makeCtx(body);
    ctx.world = { findBlocksMatching: () => [{ position: { x: 3, y: 64, z: 0 }, name: 'minecraft:chest' }] };
    const result = await skills.run('withdraw', ctx, { item: 'iron_ingot', count: 5 });
    expect(result.ok, `expected withdraw to work, got ${result.reason}`);
    expect(result.moved === 5, `moved ${result.moved}`);
    const quickMove = body.calls.find((call) => call.call === 'click');
    expect(quickMove && quickMove.slot === 0 && quickMove.mode === 'quickmove', `click was ${JSON.stringify(quickMove)}`);
    expect(body.calls.some((call) => call.call === 'close'), 'the chest should have been closed');
    return result.detail;
  });

  await scenario('deposit keeps tools by default and reports an empty bag honestly', async () => {
    let open = false;
    const clicked = [];
    const body = new MenuBody(cfg, {
      menu: () =>
        open
          ? {
              open: true,
              containerId: 7,
              menuClass: 'ChestMenu',
              slots: [
                { i: 27, item: 'minecraft:iron_pickaxe', count: 1, player: true },
                { i: 28, item: 'minecraft:cobblestone', count: 32, player: true },
                { i: 0, item: 'null', count: 0, player: false }
              ]
            }
          : { open: true, containerId: 0, menuClass: 'InventoryMenu', slots: [] },
      useOn: () => {
        open = true;
      },
      click: (slot) => clicked.push(slot)
    });
    await body.connect();
    const ctx = makeCtx(body);
    ctx.world = { findBlocksMatching: () => [{ position: { x: 3, y: 64, z: 0 }, name: 'minecraft:chest' }] };
    const result = await skills.run('deposit', ctx, {});
    expect(result.ok, `expected deposit to work, got ${result.reason}`);
    expect(clicked.length === 1 && clicked[0] === 28, `expected only the cobblestone to move, clicked ${JSON.stringify(clicked)}`);
    return result.detail;
  });

  // ------------------------------------------------------------------ farming + sleep
  process.stdout.write('\n7. farming and sleep (Phase 2)\n');

  await scenario('farm: harvests a ripe crop, tills dirt and plants seeds', async () => {
    const air = (x, y, z) => ({ name: 'air', position: { x, y, z } });
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: [
        { name: 'wheat', position: { x: 1, y: 64, z: 0 } },
        { name: 'dirt', position: { x: 2, y: 63, z: 0 } },
        air(2, 64, 0),
        { name: 'farmland', position: { x: 3, y: 63, z: 0 } },
        air(3, 64, 0)
      ],
      crops: [{ name: 'minecraft:wheat', position: { x: 1, y: 64, z: 0 }, age: 7, maxAge: 7 }],
      inventory: { 'minecraft:iron_hoe': 1, 'minecraft:wheat_seeds': 4 }
    });
    await body.connect();
    const result = await skills.run('farm', makeCtx(body), { radius: 6 });
    expect(result.ok, `expected farm to work, got ${result.reason}`);
    expect(result.harvested >= 1, `expected a harvest, got ${result.harvested}`);
    expect(result.tilled >= 1, `expected tilling, got ${result.tilled}`);
    expect(result.planted >= 1, `expected planting, got ${result.planted}`);
    const dugWheat = body.history.some((h) => h.action === 'dig' && /wheat/.test(h.name));
    expect(dugWheat, 'the ripe crop should have been dug');
    return result.detail;
  });

  await scenario('sleep: daytime is a no-op, and a night sleep ends at morning', async () => {
    const dayBody = new MockBody(cfg, {});
    await dayBody.connect();
    const daytime = await skills.run('sleep', makeCtx(dayBody), {});
    expect(daytime.ok && daytime.slept === false, `daytime should be a no-op, got ${JSON.stringify(daytime)}`);

    const nightBody = new MockBody(cfg, {
      night: true,
      start: { x: 0, y: 64, z: 0 },
      blocks: [{ name: 'red_bed', position: { x: 2, y: 64, z: 0 } }]
    });
    await nightBody.connect();
    let calls = 0;
    nightBody.refresh = async () => {
      calls += 1;
      if (calls >= 2) {
        nightBody.state.night = false;
        nightBody.state.timeOfDay = 1000;
      }
      return nightBody.snapshot();
    };
    const slept = await skills.run('sleep', makeCtx(nightBody), { timeoutMs: 10000 });
    expect(slept.ok && slept.slept === true, `expected a sleep, got ${JSON.stringify(slept)}`);
    expect(nightBody.history.some((h) => h.action === 'use'), 'the bed should have been used');
    return `${daytime.detail}; ${slept.detail}`;
  });

  // ------------------------------------------------------------------ fishing
  process.stdout.write('\n8. fishing (Phase 3)\n');

  /**
   * A wide pond with a standable bank. The pond is deliberately big enough that water far
   * from the shore passes vanilla's 5x4x5 open-water check (that is what rolls the fish
   * table), and the bank is a stone lip at y=63 the bot can stand on.
   */
  const fishingBlocks = () => {
    const blocks = [];
    const cx = 7;
    const radius = 4;
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        blocks.push({ name: 'water', position: { x, y: 62, z } });
        blocks.push({ name: 'water', position: { x, y: 63, z } });
        for (let y = 64; y <= 68; y += 1) {
          blocks.push({ name: 'air', position: { x, y, z } });
        }
      }
    }
    // Bank: solid lip at the water surface level minus nothing - the bot stands one above
    // the lip, exactly where a player fishes from.
    for (let x = 0; x <= 2; x += 1) {
      for (let z = -4; z <= 4; z += 1) {
        blocks.push({ name: 'stone', position: { x, y: 63, z } });
        blocks.push({ name: 'air', position: { x, y: 64, z } });
        blocks.push({ name: 'air', position: { x, y: 65, z } });
      }
    }
    return blocks;
  };

  await scenario('fish: walks to water, waits for the bite and lands a catch', async () => {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: fishingBlocks(),
      inventory: { 'minecraft:fishing_rod': 1, 'minecraft:bread': 3 },
      bitesAfter: 2,
      rodUses: 8
    });
    await body.connect();
    const result = await skills.run('fish', makeCtx(body), { maxCatches: 3, maxMs: 30000, eatAt: 1 });
    expect(result.ok && result.catches >= 3, `expected catches, got ${JSON.stringify(result)}`);
    expect((body.inventory['minecraft:cod'] || 0) >= 3, 'the cod should be in the bag');
    expect(body.history.some((h) => h.action === 'useItem'), 'the rod should have been used');
    // One walk per spot: the operator's rule is pathfind once, then only cast and reel.
    expect(
      body.stats.moved === 1,
      `expected exactly one walk to the bank, saw ${body.stats.moved}`
    );
    return result.detail;
  });

  await scenario('fish: stops when the rod runs out of durability', async () => {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: fishingBlocks(),
      inventory: { 'minecraft:fishing_rod': 1 },
      bitesAfter: 1,
      rodUses: 2
    });
    await body.connect();
    const result = await skills.run('fish', makeCtx(body), { maxCatches: 10, maxMs: 30000, eatAt: 1 });
    expect(
      result.stopped === 'rod-broken' || result.stopped === 'rod-worn',
      `expected a rod stop, got ${JSON.stringify(result)}`
    );
    expect(
      !Object.keys(body.inventory).some((name) => /fishing_rod/.test(name)) || result.stopped === 'rod-worn',
      'either the rod broke or the task stopped on its last use'
    );
    return result.detail;
  });

  await scenario('fish: sleeps at night and keeps fishing in the morning', async () => {
    const body = new MockBody(cfg, {
      start: { x: 0, y: 64, z: 0 },
      blocks: [...fishingBlocks(), { name: 'red_bed', position: { x: 1, y: 64, z: 2 } }],
      inventory: { 'minecraft:fishing_rod': 1 },
      night: true,
      bitesAfter: 1,
      rodUses: 8
    });
    await body.connect();
    /**
     * Sleeping is what advances the clock - flip to morning when the bed is actually used,
     * not after an arbitrary number of polls (the skill polls a lot before it reaches the
     * night check, which made an earlier version of this test never sleep at all).
     */
    const useOnBed = body.useOn.bind(body);
    body.useOn = async (...args) => {
      const result = await useOnBed(...args);
      body.state.night = false;
      body.state.timeOfDay = 1000;
      return result;
    };
    const result = await skills.run('fish', makeCtx(body), {
      maxCatches: 1,
      maxMs: 40000,
      eatAt: 1,
      bedRadius: 16
    });
    expect(result.sleeps >= 1, `expected a sleep, got ${JSON.stringify(result)}`);
    expect(result.catches >= 1, `expected fishing to resume in the morning, got ${JSON.stringify(result)}`);
    return result.detail;
  });

  // ------------------------------------------------------------------ failure types
  await scenario('failure: every reason family maps to one vocabulary', async () => {
    const { classify, classifyMove, fromResult, FAILURE } = require('../src/core/failure');
    const cases = [
      [classifyMove('noPath'), FAILURE.NO_PATH, 'noPath'],
      [classifyMove('timeout'), FAILURE.TIMEOUT, 'timeout'],
      [classifyMove('screen-open'), FAILURE.OCCLUDED, 'screen-open'],
      [classifyMove('jump-blocked'), FAILURE.OCCLUDED, 'jump-blocked'],
      [classify('need a pickaxe to mine stone'), FAILURE.WRONG_TOOL, 'pickaxe'],
      [classify('no torches and no coal to craft them'), FAILURE.NO_MATERIAL, 'no torches'],
      [classify('hostile zombie at 3 blocks'), FAILURE.HAZARD, 'hostile'],
      [classify('unknown parameter "flavour" for eat'), FAILURE.BAD_ARGUMENT, 'unknown parameter'],
      [classify('no water with a fishable bank within 24 blocks'), FAILURE.TARGET_LOST, 'no water'],
      [classify('no hostile within 24 blocks (on this level)'), FAILURE.TARGET_LOST, 'no hostile'],
      [classify('no chest nearby'), FAILURE.TARGET_LOST, 'no chest'],
      [classify('the task was cancelled'), FAILURE.INTERRUPTED, 'cancelled']
    ];
    const wrong = cases.filter(([got, want]) => got !== want);
    expect(wrong.length === 0, `misclassified: ${JSON.stringify(wrong)}`);
    const folded = fromResult({ stopped: 'rod-worn', reason: 'the fishing rod is down to its last use' });
    expect(folded.failure === FAILURE.NO_MATERIAL && !!folded.hint, `rod-worn folded wrong: ${JSON.stringify(folded)}`);
    return `${cases.length} reasons + 1 stopped-code mapped`;
  });

  await scenario('failure: a failed skill result carries failure + hint', async () => {
    skills.register({
      name: 'test_failure_receipt',
      title: 'test-only failing skill',
      description: 'always fails, so the receipt shape is checked without a game',
      run: async () => ({ ok: false, reason: 'noPath while walking to the target' })
    });
    const body = new MockBody(cfg, {});
    await body.connect();
    const result = await skills.run('test_failure_receipt', makeCtx(body), {});
    expect(result.ok === false, `expected a failure, got ${JSON.stringify(result)}`);
    expect(result.failure === 'no_path', `expected no_path, got ${JSON.stringify(result)}`);
    expect(typeof result.hint === 'string' && result.hint.length > 0, 'the receipt has no hint');
    // An unavailable skill is a different kind: the body cannot do it, not the world.
    const gated = await skills.run('sleep', { cfg, log, body: null }, {});
    expect(gated.ok === false && gated.failure === 'unsupported', `expected unsupported, got ${JSON.stringify(gated)}`);
    return `${result.failure} + ${gated.failure} receipts`;
  });

  // ------------------------------------------------------------------ summary
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(60)}\n`);
  process.stdout.write(`skills test: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail}\n`);
    process.exitCode = 1;
  }
})().catch((err) => {
  process.stderr.write(`skills test crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
