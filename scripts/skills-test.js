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
