'use strict';

/**
 * `npm run selftest` - offline verification that needs no Minecraft server.
 *
 * Checks, in order:
 *   1. every source module can be required (catches path/typo regressions)
 *   2. mineflayer + the optional plugins resolve against the installed versions
 *      and minecraft-data actually knows the configured protocol version
 *   3. the PCL2 / Minecraft / Java detection finds a usable environment
 *   4. the pure helpers (item knowledge, goal router) behave as expected
 *   5. the task classes can be built from config without a live connection
 *
 * Exits non-zero if any check fails, so it is safe to use in CI or a launcher.
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const results = [];

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    process.stdout.write(`  PASS  ${name}${detail ? ` - ${detail}` : ''}\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    process.stdout.write(`  PASS  ${name}${detail ? ` - ${detail}` : ''}\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
  }
}

function section(title) {
  process.stdout.write(`\n${title}\n${'-'.repeat(title.length)}\n`);
}

async function main() {
  process.stdout.write('minecraft-survival-agent selftest\n');

  // ---------------------------------------------------------------- 1. modules
  section('1. module graph');
  const modules = [
    'src/util/config',
    'src/util/logger',
    'src/pcl/detect',
    'src/pcl/launcher',
    'src/server/serverManager',
    'src/core/bot',
    'src/core/plugins',
    'src/core/movement',
    'src/core/memory',
    'src/world/items',
    'src/world/worldView',
    'src/survival/autoEat',
    'src/survival/combat',
    'src/survival/toolManager',
    'src/tasks/task',
    'src/tasks/gatherWood',
    'src/tasks/craft',
    'src/tasks/mine',
    'src/tasks/shelter',
    'src/tasks/hunt',
    'src/tasks/light',
    'src/tasks/deposit',
    'src/chat/commands',
    'src/web/statusServer',
    'src/mods/knowledge',
    'src/core/network',
    'src/core/preflight',
    'src/body/body',
    'src/body/mineflayerBody',
    'src/body/mockBody',
    'src/body/clientModBody',
    'src/body/botFacade',
    'src/pathfinding/vec3util',
    'src/pathfinding/clientWorldAdapter',
    'src/pathfinding/movementsAdapter',
    'src/pathfinding/planner',
    'src/pathfinding/walker',
    'src/pathfinding/navigator',
    'src/tasks/harvest',
    'src/tasks/chopWood',
    'src/tasks/mineBlock',
    'src/tasks/goto',
    'src/chat/chatListener',
    'src/chat/reply',
    'src/core/deathWatch',
    'src/llm',
    'src/llm/client',
    'src/llm/blackboard',
    'src/llm/intent',
    'src/llm/fallbackRouter',
    'src/util/trace',
    'src/web/panel',
    'src/brain'
  ];
  for (const mod of modules) {
    check(`require ${mod}`, () => {
      require(path.join(ROOT, mod));
      return null;
    });
  }

  // -------------------------------------------------------------- 2. packages
  section('2. mineflayer stack');
  const packages = [
    'mineflayer',
    'mineflayer-pathfinder',
    'mineflayer-collectblock',
    'mineflayer-tool',
    'mineflayer-armor-manager',
    'minecrafthawkeye',
    'minecraft-data',
    'prismarine-item',
    'prismarine-recipe',
    'vec3'
  ];
  for (const pkg of packages) {
    check(`resolve ${pkg}`, () => {
      const entry = require.resolve(pkg, { paths: [ROOT] });
      // Some packages (vec3) do not export ./package.json; fall back to the entry point.
      let version = '?';
      try {
        const pkgJson = path.join(path.dirname(require.resolve(`${pkg}/package.json`, { paths: [ROOT] })), 'package.json');
        version = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version;
      } catch {
        const dir = path.dirname(entry);
        const guess = path.join(dir, 'package.json');
        if (fs.existsSync(guess)) version = JSON.parse(fs.readFileSync(guess, 'utf8')).version;
      }
      return `v${version}`;
    });
  }

  const cfg = require(path.join(ROOT, 'src/util/config')).loadConfig();

  await checkAsync(`minecraft-data supports ${cfg.server.mcVersion}`, async () => {
    const mcData = require('minecraft-data');
    const data = mcData(cfg.server.mcVersion);
    if (!data) throw new Error(`minecraft-data has no version ${cfg.server.mcVersion}`);
    return `${Object.keys(data.itemsByName).length} items, ${Object.keys(data.blocksByName).length} blocks`;
  });

  // ------------------------------------------------------------------ 3. PCL2
  section('3. PCL2 / Java environment');
  const { detectEnvironment } = require(path.join(ROOT, 'src/pcl/detect'));
  const env = detectEnvironment(cfg);
  check('PCL2 executable found', () => {
    if (!env.pclExe) throw new Error('not found - set pcl.pclExe in config/pcl.json');
    return env.pclExe;
  });
  check('minecraft directory found', () => {
    if (!env.minecraftDir) throw new Error('no directory containing versions/');
    return `${env.minecraftDir} (${env.versions.length} versions)`;
  });
  check('java for the dedicated server', () => {
    if (!env.serverJava) throw new Error('no java binary detected');
    const j = env.java.find((x) => x.path === env.serverJava);
    return `${env.serverJava} (major ${j ? j.major : '?'})`;
  });
  check('server jar prepared', () => {
    const jar = path.join(cfg.paths.server, `server-${cfg.server.mcVersion}.jar`);
    if (!fs.existsSync(jar)) throw new Error('missing - run: npm run server:setup');
    return `${(fs.statSync(jar).size / 1048576).toFixed(1)} MiB`;
  });

  // --------------------------------------------------------- 4. pure helpers
  section('4. survival knowledge');
  const items = require(path.join(ROOT, 'src/world/items'));
  check('log detection', () => {
    const good = ['oak_log', 'spruce_log', 'crimson_stem', 'stripped_birch_log', 'cherry_log'].every((n) => items.isLog(n) || n.startsWith('stripped_'));
    if (!good) throw new Error('isLog missed a known log');
    return 'oak/spruce/crimson/ cherry recognised';
  });
  check('food ranking prefers cooked food', () => {
    if (!(items.foodScore('cooked_beef') > items.foodScore('beef'))) throw new Error('cooked beef should outrank raw');
    if (!(items.foodScore('golden_carrot') > items.foodScore('bread'))) throw new Error('golden carrot should outrank bread');
    return 'cooked_beef > beef, golden_carrot > bread';
  });
  check('plank substitution', () => {
    const mcData = require('minecraft-data')(cfg.server.mcVersion);
    const p = items.planksFor('spruce_log', mcData);
    if (p !== 'spruce_planks') throw new Error(`expected spruce_planks, got ${p}`);
    return 'spruce_log -> spruce_planks';
  });
  check('pickaxe requirement table', () => {
    if (!items.needsPickaxe('stone')) throw new Error('stone should need a pickaxe');
    if (items.needsPickaxe('dirt')) throw new Error('dirt should not need a pickaxe');
    return 'stone requires pickaxe, dirt does not';
  });
  check('fuel table', () => {
    if (!items.isFuel('coal') || !items.isFuel('oak_planks') || items.isFuel('diamond')) throw new Error('fuel classification wrong');
    return 'coal/planks are fuel, diamond is not';
  });

  // ---------------------------------------------------------- 5. task wiring
  section('5. task construction');
  const fakeBot = {
    username: 'SelftestBot',
    registry: require('minecraft-data')(cfg.server.mcVersion),
    inventory: { items: () => [], emptySlotCount: () => 36 },
    entity: { position: { x: 0, y: 64, z: 0 } },
    players: {},
    entities: {},
    health: 20,
    food: 20,
    time: { timeOfDay: 1000, day: 1, isDay: true }
  };
  const fakeCtx = {
    cfg,
    bot: fakeBot,
    log: require(path.join(ROOT, 'src/util/logger')).Logger ? new (require(path.join(ROOT, 'src/util/logger')).Logger)('selftest') : console,
    world: { hostiles: () => [], lightLevel: () => 15, findNearestLog: () => null, nearestContainer: () => null },
    nav: { stop: () => {}, goto: async () => false },
    memory: { recordTask: () => {}, landmark: () => null, summary: () => ({}) }
  };
  const taskModules = [
    ['src/tasks/gatherWood', 'GatherWoodTask', { count: 4 }],
    ['src/tasks/craft', 'CraftTask', { item: 'stick', count: 4 }],
    ['src/tasks/mine', 'MineTask', { block: ['stone'], count: 4 }],
    ['src/tasks/shelter', 'ShelterTask', {}],
    ['src/tasks/hunt', 'HuntTask', { count: 2 }],
    ['src/tasks/light', 'LightTask', { count: 2 }],
    ['src/tasks/deposit', 'DepositTask', {}]
  ];
  for (const [mod, klass, options] of taskModules) {
    check(`build ${klass}`, () => {
      const Cls = require(path.join(ROOT, mod))[klass];
      const task = new Cls(fakeCtx, options);
      if (!task.name || typeof task.execute !== 'function') throw new Error('task is not shaped correctly');
      return task.describe();
    });
  }

  await checkAsync('Task.execute returns a normalised failure on throw', async () => {
    const { Task } = require(path.join(ROOT, 'src/tasks/task'));
    const t = new Task(fakeCtx, { name: 'boom', timeoutMs: 500 });
    t.run = async () => {
      throw new Error('intentional');
    };
    const res = await t.execute();
    if (res.ok !== false) throw new Error('expected ok:false');
    return res.reason;
  });

  await checkAsync('Task.execute enforces its timeout', async () => {
    const { Task } = require(path.join(ROOT, 'src/tasks/task'));
    const t = new Task(fakeCtx, { name: 'hang', timeoutMs: 300 });
    t.run = () => new Promise(() => {});
    const res = await t.execute();
    if (res.ok !== false || !/timeout/.test(res.reason)) throw new Error(`expected timeout, got ${JSON.stringify(res)}`);
    return res.reason;
  });

  // ------------------------------------------------------- 6. goal routing
  section('6. goal router + config');
  const { expandBlockNames } = require(path.join(ROOT, 'src/chat/commands'));
  check('block alias expansion', () => {
    const iron = expandBlockNames('iron');
    if (!iron.includes('iron_ore')) throw new Error('iron alias should include iron_ore');
    return `iron -> ${iron.join(', ')}`;
  });
  check('config defaults and paths', () => {
    if (!cfg.agent.bot.username || !cfg.server.port) throw new Error('config incomplete');
    if (!fs.existsSync(cfg.paths.root)) throw new Error('paths.root does not exist');
    return `${cfg.agent.bot.username} -> ${cfg.agent.bot.host}:${cfg.agent.bot.port}, mc ${cfg.server.mcVersion}`;
  });

  // ----------------------------------------------------- 7. external servers
  section('7. external multiplayer support');
  const { applyAddress, loadConfig } = require(path.join(ROOT, 'src/util/config'));
  check('address parsing (host:port / bare host / IPv6)', () => {
    // A bare host keeps the configured port; the explicit default is only a fallback.
    const cases = [
      ['mc.example.com:25565', 'mc.example.com', 25565],
      ['[::1]:25570', '::1', 25570]
    ];
    for (const [input, host, port] of cases) {
      const c = loadConfig();
      applyAddress(c, input);
      if (c.agent.bot.host !== host || c.agent.bot.port !== port) {
        throw new Error(`${input} -> ${c.agent.bot.host}:${c.agent.bot.port}, expected ${host}:${port}`);
      }
    }
    const bare = loadConfig();
    bare.agent.bot.port = null;
    applyAddress(bare, 'example.org');
    if (bare.agent.bot.host !== 'example.org' || bare.agent.bot.port !== 25565) {
      throw new Error(`bare host -> ${bare.agent.bot.host}:${bare.agent.bot.port}`);
    }
    const keepsPort = loadConfig();
    applyAddress(keepsPort, 'example.org');
    if (keepsPort.agent.bot.port !== 25565) throw new Error('bare host wrongly reset the configured port');
    return 'host:port, IPv6 and bare host (keeps configured port)';
  });
  check('named server profiles resolve', () => {
    const c = loadConfig({ profile: 'simpfun' });
    if (c.agent.bot.host !== 'mc.example.com' || c.agent.bot.port !== 25565) {
      throw new Error(`profile simpfun resolved to ${c.agent.bot.host}:${c.agent.bot.port}`);
    }
    return `simpfun -> ${c.agent.bot.host}:${c.agent.bot.port}, publicServerMode=${c.agent.behaviour.publicServerMode}`;
  });
  check('unknown profile is rejected loudly', () => {
    try {
      loadConfig({ profile: 'definitely-not-a-profile' });
      throw new Error('expected a throw');
    } catch (err) {
      if (!/unknown server profile/.test(err.message)) throw err;
      return 'clear error message';
    }
  });
  const { parseProxy, buildAuthOptions } = require(path.join(ROOT, 'src/core/network'));
  check('proxy url parsing', () => {
    const socks = parseProxy('socks5://user:pw@127.0.0.1:1080');
    if (socks.protocol !== 'socks5' || socks.host !== '127.0.0.1' || socks.port !== 1080) throw new Error('socks5 parse failed');
    if (socks.userId !== 'user' || socks.password !== 'pw') throw new Error('credentials lost');
    const http = parseProxy('http://proxy.local:8080');
    if (http.protocol !== 'http' || http.port !== 8080) throw new Error('http parse failed');
    const bare = parseProxy('127.0.0.1:1081');
    if (bare.protocol !== 'socks5') throw new Error('bare host should default to socks5');
    return 'socks5/socks4/http + credentials + bare host';
  });
  check('bad proxy url is rejected', () => {
    try {
      parseProxy('ftp://nope:21');
      throw new Error('expected a throw');
    } catch (err) {
      if (!/unsupported proxy protocol/.test(err.message)) throw err;
      return 'unsupported protocols rejected';
    }
  });
  check('auth options: offline vs microsoft', () => {
    const offline = loadConfig();
    offline.agent.bot.auth = 'offline';
    const a = buildAuthOptions(offline, { warn() {}, info() {}, debug() {} });
    if (a.auth !== 'offline') throw new Error('offline auth not selected');
    const msa = loadConfig();
    msa.agent.bot.auth = 'microsoft';
    const b = buildAuthOptions(msa, { warn() {}, info() {}, debug() {} });
    if (b.auth !== 'microsoft' || !b.profilesFolder) throw new Error('microsoft auth not configured');
    return 'offline -> auth=offline, microsoft -> auth=microsoft with token cache';
  });
  const { ModKnowledge } = require(path.join(ROOT, 'src/mods/knowledge'));
  check('mod signature classification', () => {
    const mk = new ModKnowledge(cfg, { log: fakeCtx.log });
    const expectations = [
      ['thermal:tin_ore', 'ore'],
      ['create:brass_ingot', 'material'],
      ['farmersdelight:roast_chicken', 'food'],
      ['twilightforest:steeleaf_pickaxe', 'tool'],
      ['create:andesite_alloy', 'material'],
      ['someunknownmod:mysterious_artifact', 'unknown']
    ];
    for (const [name, category] of expectations) {
      const got = mk.classify(name).category;
      if (got !== category) throw new Error(`${name} classified as ${got}, expected ${category}`);
    }
    return `${expectations.length} modded names classified correctly`;
  });
  check('mod safety gates (unknown blocks are not mined)', () => {
    const mk = new ModKnowledge(cfg, { log: fakeCtx.log });
    const data = require('minecraft-data')(cfg.server.mcVersion);
    mk.registry = data;
    if (mk.isMineable('minecraft:bedrock')) throw new Error('bedrock must never be mineable');
    if (!mk.isMineable('minecraft:oak_log')) throw new Error('vanilla logs must be mineable');
    if (!mk.isMineable('create:copper_ore')) throw new Error('signature-matched mod ore should be mineable');
    if (mk.isMineable('someunknownmod:mysterious_artifact')) throw new Error('unknown content must not be mined by default');
    if (!mk.isProbablyFood('farmersdelight:roast_chicken')) throw new Error('food signature not recognised');
    return 'bedrock/unknown refused, vanilla+signature allowed';
  });
  check('mod knowledge persists to disk', () => {
    const file = path.join(ROOT, 'runtime', 'selftest-mod-knowledge.json');
    const mk = new ModKnowledge(cfg, { log: fakeCtx.log, knowledgeFile: file });
    mk.learn('testmod:test_ore', { category: 'ore', isBlock: true });
    const reread = new ModKnowledge(cfg, { log: fakeCtx.log, knowledgeFile: file });
    const cls = reread.classify('testmod:test_ore');
    fs.unlinkSync(file);
    if (cls.confidence !== 'learned') throw new Error('learned fact did not survive a reload');
    return 'learn() survives reload';
  });
  check('modded block detection in WorldView', () => {
    const { WorldView } = require(path.join(ROOT, 'src/world/worldView'));
    const mk = new ModKnowledge(cfg, { log: fakeCtx.log });
    const view = new WorldView({ cfg, bot: null }, { mods: mk });
    if (!view.isModded('create:cogwheel')) throw new Error('create:cogwheel should be modded');
    if (view.isModded('minecraft:oak_log')) throw new Error('vanilla must not be modded');
    if (view.modSource('ae2:fluix_crystal') !== 'Applied Energistics 2') throw new Error('namespace -> mod name failed');
    return 'modded blocks and their source mod are recognised';
  });

  // -------------------------------------------------- 8. body abstraction
  section('8. body abstraction (decision layer <-> body seam)');
  const { Body, BodyUnavailableError, isUnavailable } = require(path.join(ROOT, 'src/body/body'));
  const { MineflayerBody } = require(path.join(ROOT, 'src/body/mineflayerBody'));
  const { MockBody } = require(path.join(ROOT, 'src/body/mockBody'));

  await checkAsync('Body contract: unimplemented methods raise BodyUnavailableError', async () => {
    const bare = new Body(cfg);
    let caught = null;
    try {
      await bare.moveTo({ x: 0, y: 0, z: 0 });
    } catch (err) {
      caught = err;
    }
    if (!caught) throw new Error('moveTo should reject on the abstract Body');
    if (!isUnavailable(caught)) throw new Error('rejection should be recognised as "unavailable"');
    if (bare.snapshot() !== null) throw new Error('abstract Body should report no state');
    return 'graceful degradation path exists';
  });

  check('MineflayerBody satisfies the contract surface', () => {
    const required = ['connect', 'disconnect', 'snapshot', 'blockAt', 'findBlocks', 'findBlocksMatching', 'hostiles', 'itemDrops', 'moveTo', 'dig', 'place', 'equip', 'consume', 'attack', 'chat', 'lookAt', 'interrupt', 'describe'];
    const body = new MineflayerBody(cfg, { controller: { bot: null, isAlive: false, loadedPlugins: [] } });
    for (const method of required) {
      if (typeof body[method] !== 'function') throw new Error(`MineflayerBody.${method} missing`);
    }
    if (body.isReady) throw new Error('body must not claim readiness without a bot');
    if (body.snapshot() !== null) throw new Error('snapshot must be null when not spawned');
    return `${required.length} methods, reports unready correctly`;
  });

  check('MockBody satisfies the same contract surface', () => {
    const required = ['connect', 'disconnect', 'snapshot', 'blockAt', 'findBlocks', 'findBlocksMatching', 'hostiles', 'itemDrops', 'moveTo', 'dig', 'place', 'equip', 'consume', 'attack', 'chat', 'lookAt', 'interrupt', 'describe'];
    const body = new MockBody(cfg, {});
    for (const method of required) {
      if (typeof body[method] !== 'function') throw new Error(`MockBody.${method} missing`);
    }
    return `${required.length} methods`;
  });

  await checkAsync('MockBody: connect -> perceive -> dig -> pick up', async () => {
    const body = new MockBody(cfg, {
      blocks: [{ name: 'oak_log', position: { x: 2, y: 64, z: 0 } }],
      inventory: {}
    });
    await body.connect();
    const snap = body.snapshot();
    if (!snap || !snap.ready) throw new Error('snapshot not ready after connect');
    const logs = body.findBlocksMatching((n) => /_log$/.test(n), { maxDistance: 16 });
    if (logs.length !== 1) throw new Error(`expected 1 log, found ${logs.length}`);
    if (!(await body.moveTo(logs[0].position))) throw new Error('moveTo failed');
    if (!(await body.dig(logs[0]))) throw new Error('dig failed');
    const after = body.snapshot();
    if ((after.inventory['minecraft:oak_log'] || 0) < 1) throw new Error('drop was not picked up');
    return 'dug a tree and collected the drop';
  });

  await checkAsync('MockBody: night/hostiles are reported like a real world', async () => {
    const body = new MockBody(cfg, {
      night: true,
      entities: [{ name: 'zombie', position: { x: 3, y: 64, z: 0 } }]
    });
    await body.connect();
    const snap = body.snapshot();
    if (snap.time.isDay) throw new Error('night not reflected');
    if (snap.hostiles.length !== 1) throw new Error(`expected 1 hostile, got ${snap.hostiles.length}`);
    if (snap.hostiles[0].name !== 'zombie') throw new Error('wrong hostile reported');
    return 'isDay=false and the zombie is visible';
  });

  await checkAsync('MockBody: crafting consumes ingredients and fails loudly', async () => {
    const body = new MockBody(cfg, { inventory: { oak_log: 1 } });
    await body.connect();
    const planks = await body.craft('oak_planks', 1);
    if (!planks.ok) throw new Error(`planks should succeed: ${planks.reason}`);
    if ((body.snapshot().inventory['minecraft:oak_planks'] || 0) !== 4) throw new Error('planks count wrong');
    if (body.snapshot().inventory['minecraft:oak_log']) throw new Error('log should have been consumed');
    const pick = await body.craft('wooden_pickaxe', 1);
    if (pick.ok) throw new Error('pickaxe must fail without 3 planks + 2 sticks');
    if (!/missing/.test(pick.reason)) throw new Error(`unhelpful failure: ${pick.reason}`);
    return 'ingredients consumed; impossible craft reports what is missing';
  });

  await checkAsync('MockBody: eating restores food', async () => {
    const body = new MockBody(cfg, { food: 8, inventory: { cooked_beef: 2 } });
    await body.connect();
    if (!(await body.consume())) throw new Error('consume should succeed with cooked_beef');
    if (body.snapshot().food <= 8) throw new Error('food did not increase');
    if (body.snapshot().inventory['minecraft:cooked_beef'] !== 1) throw new Error('food item not consumed');
    return `food 8 -> ${body.snapshot().food}`;
  });

  await checkAsync('decision layer can be driven by a non-mineflayer body', async () => {
    // This is the whole point of the seam: a scripted body must be usable wherever a
    // real bot is, with no mineflayer present at all.
    const body = new MockBody(cfg, {
      blocks: [
        { name: 'oak_log', position: { x: 3, y: 64, z: 0 } },
        { name: 'oak_log', position: { x: 4, y: 65, z: 0 } }
      ],
      inventory: { wooden_pickaxe: 1 }
    });
    await body.connect();
    const snap = body.snapshot();
    if (snap.body !== 'mock') throw new Error('body kind not reported');
    for (const method of ['moveTo', 'dig', 'chat', 'interrupt']) {
      if (typeof body[method] !== 'function') throw new Error(`${method} unavailable`);
    }
    await body.chat('/login test-password');
    const logs = body.findBlocksMatching((n) => /_log$/.test(n), { maxDistance: 32 });
    if (logs.length !== 2) throw new Error(`expected 2 logs, got ${logs.length}`);
    if (!(await body.moveTo(logs[0].position))) throw new Error('moveTo failed');
    if (!(await body.dig(logs[0]))) throw new Error('dig failed');
    if (body.stats.dug !== 1) throw new Error('dig was not recorded');
    if (!body.stats.chats.some((c) => c.startsWith('/login'))) throw new Error('chat command not recorded');
    return 'tasks drive a mock body with no mineflayer';
  });

  // ------------------------------------------- 9. P0 control layer (plan §8)
  /**
   * The additions the plan asks for by name: intent schema, the tool whitelist, the
   * pathfinding scenarios, task construction, rate limiting and echo filtering. Each of
   * these is a place where a quiet regression costs a whole feature, so they belong in the
   * always-run suite rather than only in the per-milestone scripts.
   */
  section('9. P0 control layer (pathfinding / primitives / chat / llm)');

  /** A logger that swallows everything: these checks assert on state, not on output. */
  const silent = { debug() {}, info() {}, warn() {}, error() {} };

  const { PathPlanner, STATUS } = require(path.join(ROOT, 'src/pathfinding/planner'));
  const { WaypointWalker, WALK_REASON } = require(path.join(ROOT, 'src/pathfinding/walker'));
  const { PathNavigator } = require(path.join(ROOT, 'src/pathfinding/navigator'));
  const { v3 } = require(path.join(ROOT, 'src/pathfinding/vec3util'));
  const { describeBlock } = require(path.join(ROOT, 'src/pathfinding/clientWorldAdapter'));
  const { ChopWoodTask } = require(path.join(ROOT, 'src/tasks/chopWood'));
  const { MineBlockTask } = require(path.join(ROOT, 'src/tasks/mineBlock'));
  const { GoToTask } = require(path.join(ROOT, 'src/tasks/goto'));
  const { HarvestTask } = require(path.join(ROOT, 'src/tasks/harvest'));
  const { ChatListener } = require(path.join(ROOT, 'src/chat/chatListener'));
  const { reply: sendReply, sanitize, fingerprint } = require(path.join(ROOT, 'src/chat/reply'));
  const { createBotFacade } = require(path.join(ROOT, 'src/body/botFacade'));
  const { DeathWatch } = require(path.join(ROOT, 'src/core/deathWatch'));
  const { parseIntent, normalizeIntent, describeIntent } = require(path.join(ROOT, 'src/llm/intent'));
  const fallbackRouter = require(path.join(ROOT, 'src/llm/fallbackRouter'));
  const { blockDrop, blockDropCount } = require(path.join(ROOT, 'src/world/items'));
  const { countTrace, appendTrace } = require(path.join(ROOT, 'src/util/trace'));

  /** A flat world for the pathfinding checks. */
  const flatMap = (radius = 24, groundY = 63) => {
    const cells = {};
    for (let x = -radius; x <= radius; x += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        for (let y = groundY - 3; y < groundY; y += 1) cells[`${x},${y},${z}`] = 'minecraft:stone';
        cells[`${x},${groundY},${z}`] = 'minecraft:grass_block';
        for (let y = groundY + 1; y <= groundY + 8; y += 1) cells[`${x},${y},${z}`] = 'minecraft:air';
      }
    }
    return cells;
  };

  /** A body that satisfies the read half of the contract, with instant movement. */
  const mapBody = (cells, start) => {
    const position = { ...start };
    const frozen = { value: false };
    return {
      isReady: true,
      position,
      frozen,
      snapshot: () => ({ ready: true, body: 'mock', position: { ...position }, blocks: { cells }, health: 20, food: 20 }),
      async moveTo(target) {
        if (frozen.value) return false;
        position.x = target.x;
        position.y = target.y;
        position.z = target.z;
        return true;
      },
      async interrupt() {},
      async dig() {
        return true;
      },
      async chat() {
        return true;
      }
    };
  };

  await checkAsync('pathfinding: vec3 shim provides the block-granular hash A* needs', () => {
    const a = v3(1.9, 2.1, 3.99);
    if (typeof a.hash !== 'string') throw new Error(`hash must be a string, got ${typeof a.hash}`);
    if (a.hash !== '1,2,3') throw new Error(`expected floor hash, got "${a.hash}"`);
    if (a.hash !== v3(1.1, 2.9, 3.01).hash) throw new Error('same block must share a hash');
    return `hash("${a.hash}") is block-granular`;
  });

  await checkAsync('pathfinding: negative coordinates floor to the real block', () => {
    /**
     * Regression for the 2026-10-10 diamond run: `x | 0` truncates toward zero, so a bot at
     * x=-0.31 was read as cell 0 instead of block -1 and the planner never saw it inside the
     * goal radius.
     */
    const a = v3(-0.31, -59, 170.46);
    if (a.x !== -1 || a.z !== 170) throw new Error(`expected (-1,-59,170), got (${a.x},${a.y},${a.z})`);
    return `v3(-0.31,-59,170.46) -> (${a.x},${a.y},${a.z})`;
  });

  await check('pathfinding: planner and navigator share one goal test', () => {
    /**
     * The exact deadlock position: 3.06 blocks (float) from the target corner, but inside the
     * goal cell for the planner. Both layers must agree it counts as arrived; divergence here
     * produced 40 identical replans at range 3.
     */
    const { withinGoalRange } = require(path.join(ROOT, 'src/pathfinding/planner'));
    const inside = withinGoalRange(-0.31, -59, 170.46, -3, -59, 169, 3);
    if (!inside) throw new Error('a position inside the goal cell must count as arrived');
    const outside = withinGoalRange(0.4, -59, 171.6, -3, -59, 169, 3);
    if (outside) throw new Error('a position beyond the cell radius must not count as arrived');
    return 'cell-based arrival accepts the 3.06/3 deadlock spot and rejects the next cell out';
  });

  await check('pathfinding: block classification handles modded namespaces', () => {
    if (describeBlock('minecraft:air').solid) throw new Error('air must not be solid');
    if (!describeBlock('minecraft:grass_block').solid) throw new Error('grass must be solid');
    if (describeBlock('minecraft:lava').dangerous !== true) throw new Error('lava must be dangerous');
    const cog = describeBlock('create:cogwheel');
    if (cog.bare !== 'cogwheel') throw new Error(`namespace not stripped: ${cog.bare}`);
    if (!cog.solid) throw new Error('unknown modded blocks must default to solid');
    return 'air/grass/lava/create:cogwheel classified';
  });

  await checkAsync('pathfinding: flat ground plans a near-straight route', async () => {
    const body = mapBody(flatMap(24), { x: 0, y: 64, z: 0 });
    const res = await new PathPlanner(body, { log: silent }).plan({ x: 10, y: 64, z: 0 });
    if (res.status !== STATUS.SUCCESS) throw new Error(`expected success, got ${res.status} (${res.reason})`);
    if (res.path.length > 14) throw new Error(`path should be near-straight, got ${res.path.length} nodes`);
    return `${res.path.length} nodes, ${res.nodes} generated`;
  });

  await checkAsync('pathfinding: a wall is walked around, not through', async () => {
    const cells = flatMap(24);
    for (let z = -2; z <= 2; z += 1) for (let y = 64; y <= 66; y += 1) cells[`6,${y},${z}`] = 'minecraft:stone';
    const body = mapBody(cells, { x: 0, y: 64, z: 0 });
    const res = await new PathPlanner(body, { log: silent }).plan({ x: 12, y: 64, z: 0 });
    if (res.status !== STATUS.SUCCESS) throw new Error(`expected success, got ${res.status} (${res.reason})`);
    if (res.path.length <= 12) throw new Error(`expected a detour longer than the straight line, got ${res.path.length}`);
    if (res.path.some((n) => n.x === 6 && Math.abs(n.z) <= 2)) throw new Error('path went through the wall');
    return `${res.path.length} nodes, detoured`;
  });

  await checkAsync('pathfinding: a sealed chamber reports noPath and does not hang', async () => {
    const cells = flatMap(24);
    for (let x = 8; x <= 14; x += 1) {
      for (let z = -6; z <= 6; z += 1) {
        for (let y = 64; y <= 70; y += 1) {
          const cavity = x >= 10 && x <= 12 && z >= -4 && z <= 4 && y <= 67;
          if (!cavity) cells[`${x},${y},${z}`] = 'minecraft:stone';
        }
      }
    }
    const body = mapBody(cells, { x: 0, y: 64, z: 0 });
    const started = Date.now();
    const res = await new PathPlanner(body, { log: silent, nodeTimeoutMs: 2000 }).plan({ x: 11, y: 64, z: 0 });
    const ms = Date.now() - started;
    if (res.status === STATUS.SUCCESS) throw new Error('a sealed chamber must not be reachable');
    if (ms > 12000) throw new Error(`must fail promptly, took ${ms}ms`);
    return `${res.status} in ${ms}ms`;
  });

  await checkAsync('pathfinding: targets beyond the scan grid report out-of-grid', async () => {
    const body = mapBody(flatMap(24), { x: 0, y: 64, z: 0 });
    const planner = new PathPlanner(body, { log: silent });
    const res = await planner.plan({ x: 40, y: 64, z: 0 });
    if (res.status !== STATUS.OUT_OF_GRID) throw new Error(`expected out-of-grid, got ${res.status}`);
    const toward = planner.toward({ x: 40, y: 64, z: 0 }, 12);
    if (!toward || toward.x <= 0) throw new Error('toward() should point at the target');
    return `out-of-grid, then toward (${toward.x},${toward.y},${toward.z})`;
  });

  await checkAsync('pathfinding: lava is never entered, even as a shortcut', async () => {
    const cells = flatMap(24);
    for (let x = 3; x <= 7; x += 1) for (let z = -24; z <= 24; z += 1) {
      cells[`${x},63,${z}`] = 'minecraft:lava';
      cells[`${x},64,${z}`] = 'minecraft:lava';
    }
    const body = mapBody(cells, { x: 0, y: 64, z: 0 });
    const res = await new PathPlanner(body, { log: silent }).plan({ x: 12, y: 64, z: 0 });
    if (res.status === STATUS.SUCCESS) throw new Error('must not route through a full-width lava band');
    if (res.path.some((n) => n.x >= 3 && n.x <= 7)) throw new Error('a path node sits inside the lava');
    return `${res.status} (lava refused)`;
  });

  await checkAsync('pathfinding: a frozen body is detected as stuck, not waited on', async () => {
    const body = mapBody(flatMap(24), { x: 0, y: 64, z: 0 });
    body.frozen.value = true;
    const walker = new WaypointWalker(body, { log: silent, stallThreshold: 2 });
    const path = [];
    for (let i = 1; i <= 8; i += 1) path.push(v3(i, 64, 0));
    const started = Date.now();
    const res = await walker.walk(path, { timeoutMs: 10000 });
    const ms = Date.now() - started;
    if (res.ok) throw new Error('a frozen body must not report arrival');
    if (res.reason !== WALK_REASON.BLOCKED && res.reason !== WALK_REASON.NO_PROGRESS) {
      throw new Error(`expected blocked/no-progress, got ${res.reason}`);
    }
    if (ms > 3000) throw new Error(`stall detection took ${ms}ms`);
    return `${res.reason} in ${ms}ms`;
  });

  await checkAsync('pathfinding: the navigator closes a gap across replans', async () => {
    const body = mapBody(flatMap(40), { x: 0, y: 64, z: 0 });
    const nav = new PathNavigator(body, { log: silent, replanEvery: 10 });
    const res = await nav.goTo({ x: 35, y: 64, z: 0 }, { range: 2, timeoutMs: 25000 });
    if (!res.ok) throw new Error(`expected arrival, got ${res.reason}`);
    if (res.iterations < 2) throw new Error(`expected multiple plan/walk cycles, got ${res.iterations}`);
    return `arrived in ${res.iterations} iterations`;
  });

  await check('primitives: the harvest base class refuses to run without isTarget()', () => {
    const task = new HarvestTask({ cfg: {}, body: null }, {});
    let threw = false;
    try {
      task.isTarget('stone');
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('HarvestTask.isTarget must be abstract');
    return 'abstract method enforced';
  });

  await check('primitives: chop targets logs and nothing else', () => {
    const task = new ChopWoodTask({ cfg: {}, body: null }, { count: 1 });
    if (!task.isTarget('minecraft:oak_log')) throw new Error('oak_log should be a target');
    if (!task.isTarget('spruce_log')) throw new Error('spruce_log should be a target');
    if (task.isTarget('minecraft:stone')) throw new Error('stone is not a log');
    if (task.unitName() !== 'logs') throw new Error('unit should be logs');
    return 'logs in, stone out';
  });

  await check('primitives: mine maps block names ignores namespaces', () => {
    const task = new MineBlockTask({ cfg: {}, body: null }, { block: ['iron_ore'], count: 2 });
    if (!task.isTarget('minecraft:iron_ore')) throw new Error('namespaced name should match');
    if (!task.isTarget('iron_ore')) throw new Error('bare name should match');
    if (task.isTarget('gold_ore')) throw new Error('gold is not iron');
    return 'namespaced and bare both match';
  });

  await check('primitives: rarity gate demands a diamond pickaxe where it matters', () => {
    const task = new MineBlockTask({ cfg: {}, body: null }, { block: ['obsidian'], count: 1 });
    const { TOOL_TIERS, requiredTierFor } = require(path.join(ROOT, 'src/world/items'));
    if (task.requiredTier() !== TOOL_TIERS.indexOf('diamond')) throw new Error('obsidian needs diamond');
    /**
     * `stone` is the weakest gate there is, not "no gate". Breaking stone bare-handed
     * destroys the block and drops nothing, so the operator's table asks for a wooden
     * pickaxe - `requiredTier()` reports the *weakest* tier, which for stone is wooden.
     * Only blocks with no entry at all (dirt, sand, gravel, wood) are tool-free.
     */
    const stone = new MineBlockTask({ cfg: {}, body: null }, { block: ['stone'], count: 1 });
    if (stone.requiredTier() !== TOOL_TIERS.indexOf('wooden')) {
      throw new Error(`stone needs a wooden pickaxe, got index ${stone.requiredTier()}`);
    }
    const dirt = new MineBlockTask({ cfg: {}, body: null }, { block: ['dirt'], count: 1 });
    if (dirt.requiredTier() !== null) throw new Error('dirt needs no tool at all');
    /**
     * The two ends of the table, pinned so an edit has to be deliberate.
     *
     * Both diamond ore variants were relaxed to iron by the operator (vanilla behaviour; surface
     * on 2026-10-01, deepslate on 2026-10-02). Ancient debris and obsidian stay diamond; pinning
     * all of them keeps a future edit from "tidying" one away without anyone noticing.
     */
    if (requiredTierFor('diamond_ore') !== 'iron') throw new Error('diamond_ore should be iron (operator relaxation)');
    if (requiredTierFor('deepslate_diamond_ore') !== 'iron') throw new Error('deepslate_diamond_ore should also be iron (operator relaxation)');
    if (requiredTierFor('ancient_debris') !== 'diamond') throw new Error('ancient_debris needs diamond');
    return 'obsidian/ancient_debris -> diamond, both diamond ores -> iron, stone -> wooden, dirt -> bare hands';
  });

  await check('primitives: block drops follow the real game, not the block name', () => {
    const cases = [
      ['stone', 'cobblestone'],
      ['minecraft:iron_ore', 'raw_iron'],
      ['deepslate_gold_ore', 'raw_gold'],
      ['coal_ore', 'coal'],
      ['diamond_ore', 'diamond'],
      ['redstone_ore', 'redstone'],
      ['lapis_ore', 'lapis_lazuli'],
      ['grass_block', 'dirt'],
      ['oak_log', 'oak_log']
    ];
    for (const [block, want] of cases) {
      const got = blockDrop(block);
      if (got !== want) throw new Error(`${block} -> ${got}, expected ${want}`);
    }
    if (blockDropCount('clay') !== 4) throw new Error('clay drops 4 balls');
    return 'stone->cobblestone, ores->raw_*, deepslate handled';
  });

  await checkAsync('tasks: GoToTask needs a destination before it will run', async () => {
    const body = { isReady: true, snapshot: () => ({ ready: true, position: { x: 0, y: 64, z: 0 } }), async moveTo() { return true; } };
    const task = new GoToTask({ cfg: {}, body, log: silent, memory: { landmark: () => null } }, { landmark: 'nowhere' });
    const res = await task.execute();
    if (res.ok) throw new Error('a missing landmark must fail');
    if (!/no landmark named/.test(res.reason)) throw new Error(`unexpected reason: ${res.reason}`);
    return res.reason;
  });

  await check('chat: sanitize strips anything that could re-trigger a command', () => {
    if (sanitize('!chop 8') !== 'chop 8') throw new Error('leading ! not stripped');
    if (sanitize('/say hi') !== 'say hi') throw new Error('leading / not stripped');
    if (sanitize('a\nb') !== 'a b') throw new Error('newlines not collapsed');
    if (sanitize('   ') !== '') throw new Error('blank should be empty');
    if (sanitize('x'.repeat(300), { maxChars: 100 }).length !== 100) throw new Error('not truncated');
    return 'no leading ! or /, no newlines, capped at maxChars';
  });

  await check('chat: fingerprints ignore case and whitespace', () => {
    if (fingerprint('  Hello  There ') !== fingerprint('hello there')) throw new Error('fingerprints must normalise');
    return 'case and whitespace insensitive';
  });

  await checkAsync('chat: the echo filter stops the bot answering itself', async () => {
    const lines = ['<Steve> hello'];
    const body = { readChat: async () => ({ lines: lines.slice() }) };
    const handled = [];
    const listener = new ChatListener(body, { chat: { handle: async (c) => handled.push(c) }, log: silent }, { log: silent, prefix: '!' });
    // The first poll only seeds the baseline (chat from before the agent started is history),
    // so a test that wants a line acted on must poll once to seed and again to process.
    await listener.poll();
    listener.noteOwnSpeech('chop 8'); // what we said
    lines.push('<Steve> chop 8'); // ...coming back through the log
    await listener.poll();
    if (handled.length) throw new Error(`the echo was treated as a command: ${JSON.stringify(handled)}`);
    if (listener.stats.echoes !== 1) throw new Error(`echo not counted (echoes=${listener.stats.echoes})`);
    return 'own reply ignored';
  });

  await checkAsync('chat: non-command chatter is ignored, and a repeated command still runs', async () => {
    const lines = ['<Steve> hello there'];
    const body = { readChat: async () => ({ lines: lines.slice() }) };
    const handled = [];
    const listener = new ChatListener(
      body,
      { chat: { handle: async (c) => handled.push(c) }, log: silent },
      { log: silent, prefix: '!' }
    );
    await listener.poll(); // seed the baseline
    lines.push('<Steve> !chop 8', '<Steve> just chatting', '<Steve> !chop 8');
    await listener.poll();
    // Two identical commands in one batch must BOTH run: dedupe is by batch position, not by
    // content fingerprint, because fingerprint dedupe silently swallowed the second one.
    if (handled.length !== 2) throw new Error(`expected both identical commands to run, got ${handled.length}`);
    if (handled.some((c) => c !== 'chop 8')) throw new Error(`wrong command: ${JSON.stringify(handled)}`);
    if (listener.stats.ignored < 1) throw new Error('the distractor should be counted as ignored');
    // Re-polling the same window must not fire anything again.
    await listener.poll();
    if (handled.length !== 2) throw new Error(`a re-served window re-fired: ${handled.length} commands`);
    return 'chatter ignored, identical commands both ran, window not replayed';
  });

  await checkAsync('chat: the dialogue trigger routes to the LLM channel, not the command table', async () => {
    const lines = ['<Steve> hi'];
    const body = { readChat: async () => ({ lines: lines.slice() }) };
    const commands = [];
    const dialogues = [];
    const listener = new ChatListener(
      body,
      { chat: { handle: async (c) => commands.push(c) }, log: silent },
      { log: silent, prefix: '!', dialogueTrigger: '@T' }
    );
    listener.onDialogue = async (utterance) => dialogues.push(utterance);
    await listener.poll(); // seed the baseline
    lines.push('<Steve> @T 砍点树');
    await listener.poll();
    if (commands.length) throw new Error('a dialogue line must not hit the command table');
    if (dialogues.length !== 1 || dialogues[0] !== '砍点树') throw new Error(`bad dialogue: ${JSON.stringify(dialogues)}`);
    return 'trigger stripped and routed to the LLM';
  });

  await checkAsync('chat: a bare trigger with no text is ignored', async () => {
    const lines = ['<Steve> hi'];
    const body = { readChat: async () => ({ lines: lines.slice() }) };
    const dialogues = [];
    const listener = new ChatListener(body, { chat: { handle: async () => {} }, log: silent }, { log: silent, dialogueTrigger: '@T' });
    listener.onDialogue = async (u) => dialogues.push(u);
    await listener.poll(); // seed
    lines.push('<Steve> @T');
    await listener.poll();
    if (dialogues.length) throw new Error('an empty utterance must not be dispatched');
    return 'ignored';
  });

  await checkAsync('chat: command acks are debounced so they cannot spam the chat', async () => {
    const said = [];
    const ctx = {
      cfg: { agent: { chat: { replyInGame: true, maxChars: 100, minReplyGapMs: 60000 } } },
      body: { chat: async (m) => said.push(m) },
      log: silent
    };
    const first = await sendReply(ctx, '第一条', { ack: true });
    const second = await sendReply(ctx, '第二条', { ack: true });
    if (!first) throw new Error('the first ack should be sent');
    if (second) throw new Error('the second ack should be debounced');
    if (said.length !== 1) throw new Error(`expected 1 message sent, got ${said.length}`);
    // ...but an answer the player is waiting for must never be swallowed by that gap: the
    // LLM's reply and the task-finished follow-up both arrive on the heels of an ack.
    const answer = await sendReply(ctx, '砍完啦喵');
    if (!answer) throw new Error('a non-ack reply must not be debounced');
    if (said.length !== 2) throw new Error(`expected the answer to be sent, got ${said.length}`);
    return 'acks throttled, answers always sent';
  });

  await checkAsync('chat: replyInGame=false silences the in-game channel', async () => {
    const said = [];
    const ctx = {
      cfg: { agent: { chat: { replyInGame: false } } },
      body: { chat: async (m) => said.push(m) },
      log: silent
    };
    const sent = await sendReply(ctx, 'hi');
    if (sent || said.length) throw new Error('replyInGame=false must suppress output');
    return 'suppressed';
  });

  await checkAsync('facade: exposes reads, refuses to fake actions', async () => {
    const cfgFile = { agent: { bot: { username: 'Tester' } } };
    const body = { kind: 'clientmod', isReady: true, snapshot: () => ({ ready: true, position: { x: 1, y: 2, z: 3 }, inventory: { 'minecraft:oak_log': 2 } }) };
    const facade = createBotFacade(body, cfgFile, {});
    if (facade.username !== 'Tester') throw new Error('username not passed through');
    if (facade.inventory.items()[0].name !== 'minecraft:oak_log') throw new Error('inventory shape wrong');
    if (facade.entity.position.x !== 1) throw new Error('position getter wrong');
    let threw = false;
    try {
      facade.dig({});
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('facade.dig must throw: acting belongs to the Body');
    return 'reads work, dig throws';
  });

  await check('death: a disconnect is not treated as a death', () => {
    const ctx = { cfg: { agent: { death: {} } }, body: { snapshot: () => null }, log: silent, brain: { preempt() {} } };
    const watch = new DeathWatch(ctx, { log: silent });
    watch.tick();
    if (watch.dead) throw new Error('a missing snapshot must not mean death');
    return 'no snapshot -> no death';
  });

  await check('death: detection aborts everything and does not auto-resume', () => {
    const calls = [];
    const ctx = {
      cfg: { agent: { death: {} } },
      body: { snapshot: () => ({ ready: true, dead: true, position: { x: 5, y: 6, z: 7 } }), interrupt: () => calls.push('interrupt') },
      log: silent,
      brain: {
        preempt: () => calls.push('preempt'),
        stopForDeath: () => calls.push('stopForDeath'),
        resumeFromDeath: () => calls.push('resumeFromDeath')
      },
      memory: { recordDeath: () => calls.push('recordDeath'), save: () => calls.push('save'), data: {} }
    };
    const watch = new DeathWatch(ctx, { log: silent });
    watch.tick();
    if (!watch.dead) throw new Error('death not detected');
    for (const expected of ['preempt', 'stopForDeath', 'interrupt', 'recordDeath', 'save']) {
      if (!calls.includes(expected)) throw new Error(`${expected} was not called`);
    }
    // Now respawn: with autoResume false the brain must stay stopped.
    ctx.body.snapshot = () => ({ ready: true, dead: false, position: { x: 5, y: 6, z: 7 } });
    watch.tick();
    if (watch.dead) throw new Error('respawn not noticed');
    if (calls.includes('resumeFromDeath')) throw new Error('must NOT auto-resume when autoResume is false');
    return 'aborted on death, stayed stopped after respawn';
  });

  await check('death: nothing resumes work automatically, even if config asks for it', () => {
    /**
     * This check used to assert the opposite: that `autoResume: true` would resume. The
     * operator's rule is that a respawn must never restart work, so the switch is gone.
     *
     * The test still passes the old config key deliberately. A stale config file on someone's
     * disk must not be able to re-enable automatic recovery - the option has to be ignored, not
     * merely undocumented.
     */
    const calls = [];
    const ctx = {
      cfg: { agent: { death: { autoResume: true } } }, // legacy key: must have no effect
      // `ready: true` matters: tick() ignores a snapshot that is not ready, because a detached
      // client is not a death.
      body: { snapshot: () => ({ ready: true, dead: true, position: { x: 0, y: 64, z: 0 } }) },
      log: silent,
      /**
       * The brain stub records what it was asked to do.
       *
       * The first version of this check stubbed `stopForDeath` as a no-op and then asserted that
       * it had been called - which failed for the honest reason that nothing recorded it. An
       * assertion about behaviour needs a stub that observes behaviour.
       */
      brain: {
        preempt: () => calls.push('preempt'),
        stopForDeath: () => calls.push('stopForDeath'),
        resumeFromDeath: () => calls.push('resumeFromDeath')
      },
      memory: { recordDeath() {}, save() {}, data: {} }
    };
    const watch = new DeathWatch(ctx, { log: silent });
    if (watch.autoResume !== undefined) throw new Error('an autoResume flag is stored again');
    watch.tick();
    if (!watch.dead) throw new Error('death was not detected');
    if (!calls.includes('stopForDeath')) throw new Error('death did not stop the brain');
    ctx.body.snapshot = () => ({ ready: true, dead: false, position: { x: 0, y: 64, z: 0 } });
    watch.tick();
    if (calls.includes('resumeFromDeath')) throw new Error('a respawn resumed work - recovery must be manual');
    if (watch.status().autoResume !== false) throw new Error('status must report autoResume as impossible');
    // The human path still works, or a death would be a dead end.
    watch.resume();
    if (!calls.includes('resumeFromDeath')) throw new Error('manual resume is broken');
    return 'respawn ignores the legacy key; only an explicit resume restarts work';
  });

  await check('llm: the enum is the capability boundary (no command type exists)', () => {
    const bad = [
      { type: 'command', command: '/op me' },
      { type: 'task', task: 'give_diamonds', args: {} },
      { type: 'server_command', command: 'op' }
    ];
    for (const action of bad) {
      const res = normalizeIntent({ say: 'ok', action });
      if (res.ok) throw new Error(`intent with action.type=${action.type} must be rejected`);
    }
    return '3 out-of-enum actions refused';
  });

  await check('llm: nonsense numbers and shapes are rejected, not coerced', () => {
    const bad = [
      '{"action":{"type":"task","task":"chop","args":{"count":100000}}}',
      '{"action":{"type":"task","task":"chop","args":{"count":0}}}',
      '{"action":{"type":"task","task":"chop","args":{"count":"lots"}}}',
      '{"action":{"type":"task","task":"mine","args":{"count":2}}}',
      '{"action":{"type":"go_to","x":"there","y":1,"z":1}}',
      '{"action":[{"type":"stop"}]}'
    ];
    for (const text of bad) {
      const res = parseIntent(text);
      if (res.ok) throw new Error(`must reject: ${text}`);
    }
    return '6 malformed intents refused';
  });

  await check('llm: unknown extra args are dropped rather than passed through', () => {
    const res = normalizeIntent({ say: 'ok', action: { type: 'task', task: 'chop', args: { count: 4, command: '/kill' } } });
    if (!res.ok) throw new Error('a valid intent with extra args should still be accepted');
    if (res.intent.action.args.command !== undefined) throw new Error('the extra arg survived');
    if (res.intent.action.args.count !== 4) throw new Error('the count was lost');
    return 'count kept, command dropped';
  });

  await check('llm: models that wrap JSON in prose or fences are still understood', () => {
    const fenced = parseIntent('```json\n{"say":"hi","action":null}\n```');
    const prose = parseIntent('Sure! {"say":"hi","action":null} done');
    if (!fenced.ok || !prose.ok) throw new Error('tolerant extraction should handle both');
    return 'fenced and prose-wrapped both parsed';
  });

  await check('llm: describeIntent is stable for the trace and the panel', () => {
    if (describeIntent({ say: null, action: null }) !== 'say (nothing)') throw new Error('null action misdescribed');
    if (describeIntent({ action: { type: 'stop' } }) !== 'stop') throw new Error('stop misdescribed');
    if (describeIntent({ action: { type: 'go_to', x: 1, y: 2, z: 3 } }) !== 'go_to 1,2,3') throw new Error('go_to misdescribed');
    const task = describeIntent({ action: { type: 'task', task: 'chop', args: { count: 8 } } });
    if (task !== 'chop count=8') throw new Error(`task misdescribed: ${task}`);
    return 'all four action shapes';
  });

  await check('llm: the fallback router handles both languages', () => {
    const cases = [
      ['砍点树', 'chop'],
      ['挖点石头', 'mine'],
      ['捡一下掉落物', 'collect'],
      ['停下', 'stop'],
      ['chop some wood', 'chop']
    ];
    for (const [text, want] of cases) {
      const routed = fallbackRouter.route(text, { speakerPosition: { x: 0, y: 64, z: 0 } });
      if (!routed.ok) throw new Error(`"${text}" was not routed (${routed.reason})`);
      const got = routed.intent.action.task || routed.intent.action.type;
      if (got !== want) throw new Error(`"${text}" -> ${got}, expected ${want}`);
    }
    return '5 bilingual utterances routed';
  });

  await check('llm: "stop" wins over the verb it mentions', () => {
    const routed = fallbackRouter.route('别砍了', { speakerPosition: { x: 0, y: 64, z: 0 } });
    if (!routed.ok) throw new Error('should route');
    if (routed.intent.action.type !== 'stop') throw new Error('"别砍了" must stop, not chop');
    return 'stop precedence correct';
  });

  await check('llm: an unmatched message produces no action (honest, not a guess)', () => {
    const routed = fallbackRouter.route('今天天气怎么样');
    if (routed.ok) throw new Error('chit-chat must not become a task');
    return routed.reason;
  });

  await check('llm: go_to refuses to invent coordinates it does not have', () => {
    const routed = fallbackRouter.route('过来');
    if (routed.ok) throw new Error('"come here" without a speaker position must not produce coordinates');
    const withPosition = fallbackRouter.route('过来', { speakerPosition: { x: 7, y: 64, z: -3 } });
    if (!withPosition.ok || withPosition.intent.action.x !== 7) throw new Error('should use the speaker position when known');
    return 'refused without a position, resolved with one';
  });

  await check('llm: every persona/prompt build is stable without a live world', () => {
    const { systemPrompt, capabilities, listCapabilities } = require(path.join(ROOT, 'src/llm/blackboard'));
    const ctx = { body: { kind: 'clientmod', supportsCrafting: false }, world: { snapshot: () => null }, brain: { status: () => ({ current: null }) } };
    const prompt = systemPrompt(ctx, { persona: { name: 'X' } });
    if (!/CAPABILITIES/.test(prompt)) throw new Error('capability table missing');
    /**
     * The prompt must state the say/action agreement rule.
     *
     * This replaced an assertion that the prompt forbids unprompted speech. That rule was
     * removed on purpose: role play requires the bot to speak up on its own, so the guarantee
     * moved from prompt wording to code (`LlmCore.speakUp` drops any action an unprompted turn
     * proposes). Asserting the old sentence here would lock the feature out.
     */
    if (!/`say` and `action` must agree/i.test(prompt)) throw new Error('the say/action agreement rule is missing');
    // Tools are advertised only when they can actually be called, or the model answers with
    // a tool-call-shaped object that fails the intent schema.
    if (/TOOLS \(/.test(prompt)) throw new Error('tools must not be advertised when toolCalling is off');
    if (!/TOOLS \(/.test(systemPrompt(ctx, { toolCalling: true }))) throw new Error('tools must be advertised when toolCalling is on');
    const caps = capabilities(ctx);
    const craft = caps.find((c) => c.name === 'craft');
    if (craft.available) throw new Error('craft must read unavailable on a body that cannot craft');
    const say = caps.find((c) => c.name === 'say');
    if (!say || !say.available) throw new Error('say must read available now that proactive speech exists');
    if (listCapabilities(ctx).length !== caps.length) throw new Error('list_capabilities() must mirror capabilities()');
    return `${prompt.length} chars, craft correctly unavailable`;
  });

  await check('llm: an unprompted turn is told to speak and nothing else', () => {
    const { buildMessages, proactiveNote } = require(path.join(ROOT, 'src/llm/blackboard'));
    for (const kind of ['taskDone', 'hungry', 'lowHealth', 'respawn']) {
      const note = proactiveNote({ kind, detail: 'chop 8', taskOk: true });
      if (!/Nobody spoke to you/i.test(note)) throw new Error(`${kind}: the note must say no player turn exists`);
      if (!/action` to null/i.test(note)) throw new Error(`${kind}: the note must forbid acting`);
    }
    if (!/hungry/i.test(proactiveNote({ kind: 'hungry' }))) throw new Error('the hungry note must name the state');
    if (!/hurt/i.test(proactiveNote({ kind: 'lowHealth' }))) throw new Error('the lowHealth note must name the danger');
    const msgs = buildMessages({ proactive: { kind: 'hungry' } });
    if (msgs.length !== 1 || msgs[0].role !== 'user') throw new Error('a proactive turn is one user message');
    // A reactive turn must NOT carry the unprompted wording, or the model stops answering.
    const reactive = buildMessages({ text: '砍点树', speaker: '玩家' });
    if (/Nobody spoke to you/i.test(reactive[0].content)) throw new Error('a player turn must not look unprompted');
    return '4 trigger notes forbid acting; reactive turns unaffected';
  });

  await check('llm: the persona file drives the prompt, name and trigger', () => {
    const { parseFrontmatter, stripAuthorNotes } = require(path.join(ROOT, 'src/llm/persona'));
    // A fixture rather than the live config/persona.md: the operator edits that file, and a
    // test that breaks when they rewrite their character sheet is worse than useless.
    const fixture = [
      '---',
      'schema: 1',
      'name: 测试鱼        # trailing comment',
      'trigger: "@测试鱼"   # must survive the comment strip',
      'maxChars: 88',
      '---',
      '# 你是谁',
      '正文内容。',
      '',
      '# ── 结尾提醒（加载器会追加） ──',
      '# 加载器追加内容：',
      '#   ① 输出契约'
    ].join('\n');
    const { fields, body } = parseFrontmatter(fixture);
    if (fields.name !== '测试鱼') throw new Error(`name parsed as ${JSON.stringify(fields.name)}`);
    if (fields.trigger !== '@测试鱼') throw new Error(`trigger parsed as ${JSON.stringify(fields.trigger)}`);
    if (fields.maxChars !== 88) throw new Error('maxChars must parse as a number');
    const cleaned = stripAuthorNotes(body);
    if (/结尾提醒|加载器追加/.test(cleaned)) throw new Error('the maintenance block must not reach the prompt');
    if (!/正文内容/.test(cleaned)) throw new Error('the real body must survive');
    // A body without frontmatter still yields something usable rather than throwing.
    const bare = parseFrontmatter('just prose');
    if (bare.hadFrontmatter) throw new Error('prose must not be mistaken for frontmatter');
    if (bare.body !== 'just prose') throw new Error('prose must pass through unchanged');
    return 'frontmatter + comment stripping + maintenance-block removal verified';
  });

  await check('roleplay: the persona file on disk is loadable and consistent with config', () => {
    const { loadPersona } = require(path.join(ROOT, 'src/llm/persona'));
    const persona = loadPersona({ root: ROOT });
    if (!persona.loaded) throw new Error(`config/persona.md did not load: ${persona.error}`);
    if (!persona.name) throw new Error('the persona must have a name');
    if (!persona.body || persona.body.length < 200) throw new Error('the persona body looks empty');
    // The trigger is optional in the file (config may set it instead), but if present it must
    // be a single token - a trigger with a space could never match a chat line.
    if (persona.trigger && /\s/.test(persona.trigger)) throw new Error(`trigger "${persona.trigger}" contains whitespace`);
    return `${persona.name}${persona.species ? ` (${persona.species})` : ''}, trigger ${persona.trigger || '(from config)'}, ${persona.body.length} chars`;
  });

  await checkAsync('roleplay: proactive triggers respect their cooldowns', async () => {
    const { SpeechScheduler } = require(path.join(ROOT, 'src/chat/speechScheduler'));
    const spoken = [];
    const ctx = {
      cfg: { agent: { proactive: { enabled: true, triggers: { hungry: { cooldownMs: 60000, foodThreshold: 6 } } } } },
      body: { snapshot: () => ({ ready: true, health: 20, food: 3, inventory: {}, dead: false }) },
      llm: { speakUp: async (kind) => { spoken.push(kind); return { ok: true }; } }
    };
    const s = new SpeechScheduler(ctx, {});
    await s.tick();
    await s.tick();
    if (spoken.length !== 1) throw new Error(`expected 1 utterance inside the cooldown, got ${spoken.length}`);
    if (spoken[0] !== 'hungry') throw new Error(`expected the hungry trigger, got ${spoken[0]}`);
    /**
     * A bot that CARRIES food must stay quiet: it is about to eat, and asking the player for
     * food it already has is noise. This is the `hasFood` half of the condition.
     */
    const fed = new SpeechScheduler(
      {
        cfg: { agent: { proactive: { enabled: true, triggers: { hungry: { cooldownMs: 0, foodThreshold: 6 } } } } },
        body: { snapshot: () => ({ ready: true, health: 20, food: 3, inventory: { 'minecraft:cooked_beef': 4 }, dead: false }) },
        llm: { speakUp: async () => { throw new Error('must not speak when food is in the inventory'); } }
      },
      {}
    );
    await fed.tick();
    // No snapshot means "unknown" (client detached) - not hungry, not hurt.
    const offline = new SpeechScheduler(
      {
        cfg: { agent: { proactive: { enabled: true } } },
        body: { snapshot: () => null },
        llm: { speakUp: async () => { throw new Error('must not speak without a snapshot'); } }
      },
      {}
    );
    await offline.tick();
    return 'fires once, then cooldown holds; silent when fed or detached';
  });

  await checkAsync('roleplay: an unprompted turn can speak but never act', async () => {
    const { LlmCore } = require(path.join(ROOT, 'src/llm'));
    const said = [];
    const ctx = {
      cfg: { root: ROOT, agent: { chat: { maxChars: 100 }, proactive: { enabled: true } } },
      body: { snapshot: () => ({ ready: true, health: 5, food: 20, position: { x: 1, y: 2, z: 3 }, inventory: {} }), chat: async () => true },
      world: { snapshot: () => null },
      brain: { status: () => ({ current: null }) },
      reply: async (text) => { said.push(text); return true; }
    };
    /**
     * The guard under test. The model is fed an intent that *does* contain an action - the
     * shape a model produces when it decides to "help" - and the assertion is that only the
     * spoken part survives. This is what makes "no unprompted behaviour" structural.
     */
    const core = new LlmCore(ctx, { enabled: false }, { client: null });
    core.client = {
      configured: true,
      apiKey: 'test',
      model: 'test',
      baseUrl: 'test',
      complete: async () => ({
        ok: true,
        text: '{"say":"我快不行了，救命！","action":{"type":"task","task":"chop","args":{"count":8}}}',
        usage: { total_tokens: 7 }
      })
    };
    core.enabled = true;
    const res = await core.speakUp('lowHealth');
    if (!res.said) throw new Error('proactive speech produced nothing');
    if (said.length !== 1) throw new Error(`expected exactly one utterance, got ${said.length}`);
    // Nothing may have been dispatched: no chat.handle exists on this ctx, so a leaked action
    // would have thrown instead of being dropped. Confirm via the trace record as well.
    const last = core.turns[core.turns.length - 1];
    if (last.kind !== 'proactive') throw new Error('the turn was not recorded as proactive');
    if (!last.actionDropped) throw new Error('the proposed action was not recorded as dropped');

    // The deterministic fallback must carry the fact that matters, with no model at all.
    const bare = new LlmCore(ctx, { enabled: false }, { client: null });
    bare.enabled = false;
    said.length = 0;
    const fb = await bare.speakUp('hungry');
    if (fb.via !== 'template') throw new Error(`expected the template path, got ${fb.via}`);
    if (!/饿|食物/.test(fb.said)) throw new Error(`the fallback ignored the trigger: ${fb.said}`);
    const fb2 = await bare.speakUp('lowHealth');
    if (!/救命|血/.test(fb2.said)) throw new Error(`the danger fallback ignored the trigger: ${fb2.said}`);
    return 'action dropped and traced; template fallback carries the trigger facts';
  });

  await checkAsync('roleplay: player-requested work is announced, planner work is not', async () => {
    const { LlmCore } = require(path.join(ROOT, 'src/llm'));
    const { reply } = require(path.join(ROOT, 'src/chat/reply'));
    /**
     * Driven through the REAL reply() rather than a stub.
     *
     * Two things are being checked at once and a stub would hide the second: that a
     * player-sourced task produces a line, and that the line actually reaches the game
     * channel. `reply()` is the single output path (it sanitises, debounces and registers the
     * echo), so asserting on `ctx.replies` - the record it writes - is asserting on what the
     * player would have seen.
     */
    const ctx = {
      cfg: {
        root: ROOT,
        agent: {
          chat: { replyInGame: true, maxChars: 100, minReplyGapMs: 0 },
          proactive: { enabled: true, triggers: { taskDone: { enabled: true } } }
        }
      },
      body: { snapshot: () => ({ ready: true, health: 20, food: 20, position: { x: 0, y: 0, z: 0 }, inventory: {} }), chat: async () => true },
      world: { snapshot: () => null },
      brain: { status: () => ({ current: null }) }
    };
    ctx.reply = (text, options) => reply(ctx, text, options);

    const core = new LlmCore(ctx, { enabled: false }, { client: null });
    core.enabled = false; // template path: no network in a test
    await core.announceFinished({ name: 'chop', description: '砍 8 根木头', reason: 'collected 8 logs', source: 'chat' }, true);
    const spoken = (ctx.replies || []).map((r) => r.text);
    if (spoken.length !== 1) throw new Error(`a player-sourced task must be announced once, got ${spoken.length}`);
    if (!/砍 8 根木头/.test(spoken[0])) throw new Error(`the announcement ignored the task detail: ${spoken[0]}`);
    // A line starting with `!` or `/` would come back through the input pipe as a command.
    if (/^[!/]/.test(spoken[0])) throw new Error(`the announcement would re-enter as a command: ${spoken[0]}`);

    // The planner's own work is nobody's business and would read as unprompted chatter.
    await core.announceFinished({ name: 'dirt', description: '挖点土', reason: 'ok', source: 'autonomous' }, true);
    if ((ctx.replies || []).length !== 1) throw new Error('planner-owned work must stay silent');

    // Disabling the trigger must silence it too - the config is not decoration.
    core.ctx.cfg.agent.proactive.triggers.taskDone.enabled = false;
    await core.announceFinished({ name: 'mine', description: '挖石头', reason: 'ok', source: 'chat' }, true);
    if ((ctx.replies || []).length !== 1) throw new Error('a disabled taskDone trigger must not speak');
    return 'announced through the real reply path; autonomous and disabled cases silent';
  });

  await check('observability: the trace counter only reads newly appended bytes', () => {
    const file = path.join(ROOT, 'runtime', '_selftest-trace.jsonl');
    fs.rmSync(file, { force: true });
    appendTrace(file, { a: 1 });
    appendTrace(file, { a: 2 });
    const two = countTrace(file);
    appendTrace(file, { a: 3 });
    const three = countTrace(file);
    fs.rmSync(file, { force: true });
    if (two !== 2) throw new Error(`expected 2 lines, got ${two}`);
    if (three !== 3) throw new Error(`expected 3 lines after the append, got ${three}`);
    return 'incremental count correct';
  });

  await check('observability: the control panel is self-contained HTML', () => {
    const { PANEL_HTML } = require(path.join(ROOT, 'src/web/panel'));
    if (!/^<!doctype html>/i.test(PANEL_HTML.trim())) throw new Error('not an HTML document');
    if (/https?:\/\/(?!127\.0\.0\.1)/.test(PANEL_HTML)) throw new Error('the panel must not load anything from a CDN');
    for (const id of ['death', 'cmd', 'routing', 'log']) {
      if (!PANEL_HTML.includes(`id="${id}"`)) throw new Error(`missing #${id}`);
    }
    return `${PANEL_HTML.length} chars, no external resources`;
  });

  await check('observability: /ui/state is a summary and never carries the block scan', () => {
    const { uiState, emergencyStop } = require(path.join(ROOT, 'src/web/statusServer'));
    const cells = {};
    for (let i = 0; i < 500; i += 1) cells[`${i},64,0`] = 'minecraft:stone';
    const ctx = {
      cfg: { agent: { bot: { username: 'T' }, pathfinding: {}, llm: { trace: {} } } },
      bodyKind: 'clientmod',
      body: { isReady: true, kind: 'clientmod', snapshot: () => ({ ready: true, position: { x: 0, y: 64, z: 0 }, blocks: { cells } }), interrupt() {} },
      world: { summary: () => ({ ready: true, health: 20, food: 20, position: { x: 0, y: 64, z: 0 } }) },
      brain: { status: () => ({ running: true, queueLength: 0 }), preempt() {}, queue: [] },
      nav: { stop() {} },
      log: { recent: () => [], warn() {}, info() {}, debug() {} }
    };
    const state = uiState(ctx);
    const text = JSON.stringify(state);
    if (text.includes('cells')) throw new Error('/ui/state leaked the block scan');
    if (text.length > 20000) throw new Error(`/ui/state is too large: ${text.length} bytes`);
    if (state.identity.bodyKind !== 'clientmod') throw new Error('body kind missing');

    const stop = emergencyStop(ctx);
    if (!stop.ok) {
      throw new Error(`emergency stop reported a failure: ${JSON.stringify(stop.steps)}`);
    }
    if (typeof stop.ms !== 'number') throw new Error('emergency stop did not report its latency');
    return `state ${text.length} bytes; stop in ${stop.ms}ms, 3 stages reported`;
  });

  await check('one-click entry: start.ps1 stores both commands and knows the readiness rule', () => {
    /**
     * The one-click launcher is the entry point a human actually uses, so it gets the same
     * treatment as everything else. Three things must stay true or the failure looks like a
     * broken *agent* rather than a broken launcher:
     *
     *   1. both commands are still in the file (a launcher that "helpfully" delegates to
     *      something else is not what was asked for);
     *   2. it waits for `inWorld`, not for the port - the control mod answers on 8899 as soon
     *      as the game boots, well before any world is loaded;
     *   3. it is readable by Windows PowerShell 5.1, which means a UTF-8 BOM (without one the
     *      Chinese in the file is parsed as ANSI and every message turns to mojibake) and CRLF.
     */
    const fs = require('fs');
    const startPath = path.join(ROOT, 'start.ps1');
    const stopPath = path.join(ROOT, 'stop.ps1');
    for (const p of [startPath, stopPath]) {
      if (!fs.existsSync(p)) throw new Error(`${path.basename(p)} is missing`);
      const bytes = fs.readFileSync(p);
      if (!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) {
        throw new Error(`${path.basename(p)} lost its UTF-8 BOM (PowerShell 5.1 would garble the Chinese)`);
      }
      const raw = bytes.toString('utf8').replace(/^\uFEFF/, '');
      if (raw.split('\n').length !== raw.split('\r\n').length) {
        throw new Error(`${path.basename(p)} has LF-only line endings; Windows PowerShell wants CRLF`);
      }
    }

    const start = fs.readFileSync(startPath, 'utf8');
    // Command 1: the client. Command 2: the agent. Both must be visible in the file itself.
    if (!/launch-forge-client\.js/.test(start)) throw new Error('start.ps1 no longer launches the client');
    if (!/'--body', 'clientmod'/.test(start)) throw new Error('start.ps1 no longer starts the clientmod agent');
    if (!/inWorld/.test(start)) throw new Error('start.ps1 no longer waits for /health inWorld before starting the agent');
    if (!/agent\.lock/.test(start)) throw new Error('start.ps1 no longer respects the agent single-instance lock');
    if (!/screenOpen/.test(start)) throw new Error('start.ps1 no longer warns about an open GUI screen (movement is ignored then)');

    const stop = fs.readFileSync(stopPath, 'utf8');
    if (!/emergency-stop/.test(stop)) throw new Error('stop.ps1 no longer stops the agent gracefully first');
    if (!/charset=utf-8/.test(stop)) throw new Error('stop.ps1 lost the UTF-8 content type (Invoke-RestMethod would send Latin-1)');
    if (!/Client/.test(stop)) throw new Error('stop.ps1 lost the -Client switch');

    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    for (const key of ['play', 'play:stop']) {
      if (!pkg.scripts[key] || !/\.ps1/.test(pkg.scripts[key])) {
        throw new Error(`package.json ${key} no longer points at a .ps1`);
      }
    }
    return 'both commands stored, BOM+CRLF, inWorld readiness, lock respected, graceful stop';
  });

  await check('one-click entry: the launch failures it diagnoses are the ones we actually hit', () => {
    // The diagnosis table is only useful if it matches real log lines. These two were taken
    // from this machine (two clients fighting over 8899, and Java 25 failing to boot Forge).
    const start = require('fs').readFileSync(path.join(ROOT, 'start.ps1'), 'utf8');
    const cases = [
      ['port 8899 is already owned by another Minecraft instance', '两个客户端抢端口'],
      ['UnsupportedClassVersionError', 'Java 版本不对'],
      ['A fatal error has been detected', 'Java 崩溃'],
      ['Could not find or load main class', '整合包不完整'],
      ['multiplayer\\.disconnect', '没连上服务器']
    ];
    for (const [pattern, label] of cases) {
      if (!start.includes(pattern)) throw new Error(`start.ps1 no longer diagnoses: ${label} (${pattern})`);
    }
    // Every entry must carry both halves: what happened, and what to do about it.
    const blocks = start.split('@{ re =').slice(1);
    if (blocks.length < cases.length) throw new Error('the diagnosis table lost entries');
    for (const b of blocks) {
      if (!/why\s*=/.test(b) || !/fix\s*=/.test(b)) throw new Error('a diagnosis entry is missing its why or fix');
    }
    return `${blocks.length} known failures, each with a cause and a fix`;
  });

  await checkAsync('authme: refuses to register even when the server says the account is missing', async () => {
    const { AuthMeLogin } = require(path.join(ROOT, 'src/core/authme'));
    const sent = [];
    const body = {
      chat: async (m) => sent.push(m),
      command: async (c) => {
        sent.push(c);
        return { ok: true };
      },
      login: async (pw) => {
        sent.push(`login ${pw}`);
        return true;
      }
    };
    const auth = new AuthMeLogin(body, {}, { password: 'secret', log: silent });
    auth.observe('§cВы не зарегистрированы! /register <пароль>');
    const res = await auth.ensure('startup');
    if (res.ok) throw new Error('an unregistered account must not report success');
    if (res.action !== 'refuse') throw new Error(`expected a refusal, got ${res.action}`);
    if (sent.some((s) => /register|reg\b/i.test(s))) throw new Error(`register was sent: ${JSON.stringify(sent)}`);
    return 'registration refused, nothing sent';
  });

  await checkAsync('authme: logs in when the server refuses a command pre-login', async () => {
    const { AuthMeLogin } = require(path.join(ROOT, 'src/core/authme'));
    const sent = [];
    const body = {
      chat: async (m) => sent.push(m),
      command: async (c) => {
        sent.push(c);
        // The real server's answer to any command before login.
        setTimeout(() => auth.observe('§cКоманды недоступны до входа! Сначала §e/login§c.'), 0);
        return { ok: true };
      },
      login: async (pw) => {
        sent.push(`login ${pw}`);
        setTimeout(() => auth.observe('§aВход успешен!'), 10);
        return true;
      }
    };
    const auth = new AuthMeLogin(body, {}, { password: 'secret', log: silent, timeoutMs: 3000 });
    const res = await auth.ensure('startup');
    if (!res.ok) throw new Error(`expected a successful login, got ${res.action}: ${res.reason}`);
    if (!sent.includes('login secret')) throw new Error(`the login was not dispatched: ${JSON.stringify(sent)}`);
    if (sent.some((s) => /register/i.test(s))) throw new Error('register was sent');
    return 'probed, detected, logged in once';
  });

  await checkAsync('authme: stays quiet when there is no evidence either way', async () => {
    const { AuthMeLogin } = require(path.join(ROOT, 'src/core/authme'));
    const sent = [];
    const body = {
      chat: async (m) => sent.push(m),
      command: async (c) => {
        sent.push(c);
        return { ok: true };
      },
      login: async (pw) => {
        sent.push(`login ${pw}`);
        return true;
      }
    };
    const auth = new AuthMeLogin(body, {}, { password: 'secret', log: silent });
    const res = await auth.ensure('startup');
    if (res.ok) throw new Error('silence must not be reported as authenticated');
    if (sent.some((s) => /^login /.test(s))) throw new Error('a blind login was sent - that trips the rate limiter');
    return 'no blind login attempt';
  });

  await checkAsync('authme: respects the cooldown after a rate limit', async () => {
    const { AuthMeLogin } = require(path.join(ROOT, 'src/core/authme'));
    const sent = [];
    const body = {
      command: async () => ({ ok: true }),
      login: async (pw) => {
        sent.push(`login ${pw}`);
        return true;
      }
    };
    const auth = new AuthMeLogin(body, {}, { password: 'secret', log: silent, timeoutMs: 500, cooldownMs: 60000 });
    auth.observe('§cЧат недоступен до входа!');
    await auth.login('startup'); // first attempt (will time out, but consumes the slot)
    auth.loggedIn = false;
    const second = await auth.login('respawn');
    if (second.action !== 'cooldown') throw new Error(`expected the cooldown to hold, got ${second.action}`);
    if (sent.length !== 1) throw new Error(`expected exactly 1 dispatch, got ${sent.length}`);
    return `second attempt held for ${second.reason}`;
  });

  await check('tools: the tool list is exactly what the plans specify (P0 + Phase-3 do_skill + scan_around)', () => {
    const registry = require(path.join(ROOT, 'src/llm/tools/registry'));
    const names = registry.toolNames();
    const expected = ['observe', 'find_blocks', 'scan_around', 'lookup_item', 'do_task', 'do_skill', 'go_to', 'stop'];
    if (names.length !== 8) throw new Error(`expected 8 tools, got ${names.length}: ${names.join(', ')}`);
    for (const name of expected) {
      if (!names.includes(name)) throw new Error(`missing tool ${name}`);
    }
    return names.join(', ');
  });

  await check('tools: there is no say tool - speech cannot become a capability', () => {
    const registry = require(path.join(ROOT, 'src/llm/tools/registry'));
    const forbidden = ['say', 'chat', 'talk', 'command', 'run_command', 'craft', 'build', 'store', 'hunt', 'light', 'fish', 'web_search'];
    for (const name of forbidden) {
      if (registry.has(name)) throw new Error(`"${name}" must not be a tool`);
    }
    return `none of ${forbidden.length} excluded verbs exist`;
  });

  await checkAsync('tools: an unknown tool is refused before anything runs', async () => {
    const registry = require(path.join(ROOT, 'src/llm/tools/registry'));
    const res = await registry.call({ body: null, world: null, log: silent }, 'op_me', {});
    if (res.ok) throw new Error('an unknown tool must not run');
    if (!/unknown tool/.test(res.error)) throw new Error(`unexpected error: ${res.error}`);
    return res.error.slice(0, 60);
  });

  await check('tools: arguments are validated, not defaulted', () => {
    const registry = require(path.join(ROOT, 'src/llm/tools/registry'));
    const bad = [
      ['go_to', { x: 1, y: 'up', z: 3 }],
      ['go_to', { x: 1, y: 2 }],
      ['go_to', { x: 1, y: 2, z: 3, command: '/kill' }],
      ['do_task', { task: 'craft' }],
      ['do_task', {}],
      ['find_blocks', {}],
      ['find_blocks', { names: 'stone' }],
      ['lookup_item', {}]
    ];
    for (const [name, args] of bad) {
      const spec = registry.TOOLS.find((t) => t.name === name);
      const verdict = registry.validate(spec.parameters, args);
      if (verdict.ok) throw new Error(`${name}(${JSON.stringify(args)}) should have been rejected`);
    }
    return `${bad.length} malformed argument sets refused`;
  });

  await checkAsync('tools: an actuator refusal is reported as a failed call, not a success', async () => {
    const registry = require(path.join(ROOT, 'src/llm/tools/registry'));
    // `mine` with no block: the tool declines, and that must not look like "done".
    const res = await registry.call(
      { body: null, world: null, log: silent, chat: { handle: async () => ({ ok: true }) } },
      'do_task',
      { task: 'mine' }
    );
    if (res.ok) throw new Error('a refused request must not report ok');
    if (!/block/.test(res.error)) throw new Error(`unexpected error: ${res.error}`);
    return res.error;
  });

  await checkAsync('tools: observe reports the world instead of inventing it', async () => {
    const registry = require(path.join(ROOT, 'src/llm/tools/registry'));
    const { MockBody: Mock } = require(path.join(ROOT, 'src/body/mockBody'));
    const { BodyWorldView: View } = require(path.join(ROOT, 'src/world/bodyWorldView'));
    const cfgFile = loadConfig({ profile: null });
    const mock = new Mock(cfgFile, {
      blocks: [{ name: 'stone', position: { x: 2, y: 64, z: 0 } }],
      inventory: { oak_log: 2 }
    });
    await mock.connect();
    const ctx = {
      cfg: cfgFile,
      log: silent,
      body: mock,
      world: new View(mock, cfgFile, { log: silent }),
      brain: { status: () => ({ current: null }) }
    };
    const res = await registry.call(ctx, 'observe', {});
    if (!res.ok) throw new Error(`observe failed: ${res.error}`);
    if (!res.result.position || !Array.isArray(res.result.inventory)) throw new Error('observe result is not the documented shape');
    if (res.result.heldItem !== null) throw new Error('nothing is held, so heldItem must be null');
    const found = await registry.call(ctx, 'find_blocks', { names: ['stone'] });
    if (!found.ok || found.result.blocks.length !== 1) throw new Error('find_blocks did not find the stone');
    return `observe + find_blocks agree with the world (${found.result.blocks.length} stone)`;
  });

  await checkAsync('tools: lookup_item admits when it does not know a modded name', async () => {
    const registry = require(path.join(ROOT, 'src/llm/tools/registry'));
    const cfgFile = loadConfig({ profile: null });
    const ctx = { cfg: cfgFile, log: silent, body: null, world: null, mods: null };
    const known = await registry.call(ctx, 'lookup_item', { name: 'stone' });
    const unknown = await registry.call(ctx, 'lookup_item', { name: 'some_mod:weird_thing' });
    if (!known.ok || known.result.known !== true) throw new Error('stone should be known');
    if (!unknown.ok || unknown.result.known !== false) throw new Error('a modded name must not be claimed as known');
    return `stone -> ${known.result.kind}, some_mod:weird_thing -> unknown`;
  });

  // ====================================================== second batch
  section('second batch: task slot, recovery ladders, places, permissions');

  await checkAsync('task hub: accepts, replaces and reports through the brain', async () => {
    const { TaskHub } = require(path.join(ROOT, 'src/core/taskHub'));
    const holds = new Set();
    const events = [];
    const interrupts = [];
    const brain = {
      activeTask: { name: 'planner work' },
      preempted: false,
      preempt() {
        this.preempted = true;
      },
      hold(reason) {
        holds.add(reason);
      },
      release(reason) {
        holds.delete(reason);
      },
      emit(kind, info) {
        events.push({ kind, ...info });
      }
    };
    const ctx = {
      brain,
      nav: { interrupt: (reason) => interrupts.push(reason) },
      body: { interrupt: (reason) => interrupts.push(reason) },
      cfg: {}
    };
    const hub = new TaskHub(ctx, { log: silent, trace() {} });

    let finishFirst = null;
    const first = await hub.submit({
      name: 'first',
      source: 'selftest',
      run: () => new Promise((resolve) => {
        finishFirst = resolve;
      })
    });
    if (!first.accepted || first.async !== true || first.taskId !== 't1') throw new Error(`bad receipt ${JSON.stringify(first)}`);
    if (!hub.busy || !holds.has('task')) throw new Error('the hub did not take the body');
    if (!brain.preempted) throw new Error('the planner was not preempted');

    const secondPromise = hub.submit({
      name: 'second',
      source: 'selftest',
      run: async () => ({ ok: true, detail: 'second done' })
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishFirst({ ok: true, detail: 'finished late' });
    const second = await secondPromise;
    if (second.replaced !== 't1') throw new Error(`replacement not reported: ${JSON.stringify(second)}`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const firstEvent = events.find((e) => e.name === 'first');
    const secondEvent = events.find((e) => e.name === 'second');
    if (!firstEvent || firstEvent.ok || firstEvent.interrupted !== 'replaced') {
      throw new Error(`a replaced task must settle stopped, not ok: ${JSON.stringify(firstEvent)}`);
    }
    if (!secondEvent || !secondEvent.ok) throw new Error(`the replacement did not report success: ${JSON.stringify(secondEvent)}`);
    if (holds.size !== 0 || hub.busy) throw new Error('the hub did not release the body');
    if (interrupts.length < 2) throw new Error('nav/body were not interrupted on replacement');
    return 'accept -> replace -> settle, hold released, events emitted';
  });

  await checkAsync('task hub: a task that will not stop keeps the slot and blocks replacement', async () => {
    const { TaskHub } = require(path.join(ROOT, 'src/core/taskHub'));
    const ctx = { brain: null, nav: { interrupt() {} }, body: { interrupt() {} }, cfg: {} };
    const hub = new TaskHub(ctx, { log: silent, trace() {}, settleTimeoutMs: 80 });
    const stuck = await hub.submit({
      name: 'stuck',
      source: 'selftest',
      run: () => new Promise(() => {}) // never settles
    });
    const refused = await hub.submit({
      name: 'next',
      source: 'selftest',
      run: async () => ({ ok: true })
    });
    if (refused.accepted !== false || refused.reason !== 'busy') {
      throw new Error(`the replacement should have been refused: ${JSON.stringify(refused)}`);
    }
    if (!hub.current || hub.current.id !== stuck.taskId) throw new Error('the stuck task lost the slot');
    const cancelled = await hub.cancel('selftest stop');
    if (cancelled.ok !== false || !/did not stop/.test(String(cancelled.note))) {
      throw new Error(`cancel should report the un-stopped task: ${JSON.stringify(cancelled)}`);
    }
    if (!hub.current) throw new Error('cancel released a task that never stopped');
    return 'replacement refused, slot kept, cancel reports gracefully';
  });

  await checkAsync('recovery ladder: rungs catch only the causes they declare', async () => {
    const { RecoveryLadder } = require(path.join(ROOT, 'src/core/recoveryLadder'));
    const tried = [];
    const ladder = new RecoveryLadder('selftest', [
      {
        name: 'direct',
        handles: ['no_path'],
        maxAttempts: 2,
        run: async ({ attempt }) => {
          tried.push(`direct${attempt}`);
          return { ok: false, reason: 'noPath', failure: 'no_path' };
        }
      },
      {
        name: 'unrelated',
        handles: ['wrong_tool'],
        run: async () => {
          tried.push('unrelated');
          return { ok: false, reason: 'need a pickaxe', failure: 'wrong_tool' };
        }
      },
      {
        name: 'flank',
        handles: ['no_path'],
        run: async () => {
          tried.push('flank');
          return { ok: true, detail: 'flank worked', marker: 42 };
        }
      }
    ]);
    const result = await ladder.run();
    if (!result.ok || result.marker !== 42) throw new Error(`the flank rung did not win: ${JSON.stringify(result)}`);
    if (tried.join(',') !== 'direct1,direct2,flank') throw new Error(`wrong rung order: ${tried.join(',')}`);

    const stuck = new RecoveryLadder('stuck', [
      {
        name: 'only',
        handles: ['no_path'],
        run: async () => ({ ok: false, reason: 'permission denied', failure: 'refused' })
      }
    ]);
    const refused = await stuck.run();
    if (refused.ok || refused.failure !== 'refused' || !refused.ladder.exhausted) {
      throw new Error(`a cause nobody handles must fall through: ${JSON.stringify(refused)}`);
    }
    return `${tried.join(' -> ')}; refused falls through`;
  });

  await check('places: areas and routes survive a reload', () => {
    const fs = require('fs');
    const { Places } = require(path.join(ROOT, 'src/core/places'));
    const file = path.join(ROOT, '.tmp', 'places-selftest.json');
    fs.rmSync(file, { force: true });
    const places = new Places({ root: ROOT }, { file, log: silent });
    places.addArea('home', { type: 'box', from: { x: 0, y: 64, z: 0 }, to: { x: 4, y: 70, z: 4 } });
    places.addArea('pond', { type: 'radius', at: { x: 20, y: 64, z: 0 }, r: 3 });
    if (!places.areaContains('home', { x: 2, y: 65, z: 2 })) throw new Error('box containment failed');
    if (places.areaContains('home', { x: 9, y: 65, z: 2 })) throw new Error('box containment leaked');
    if (!places.areaContains('pond', { x: 22, y: 64, z: 2 })) throw new Error('radius containment failed');
    places.addRoutePoint('fishing', { x: 20, y: 64, z: 5 });
    places.setRoutePlan('fishing', { status: 'success', ok: true, at: 1 });
    const reloaded = new Places({ root: ROOT }, { file, log: silent });
    if (!reloaded.area('home')) throw new Error('the area did not survive the reload');
    if (reloaded.listRoutes()[0].planned !== 'success') throw new Error('the route plan did not survive the reload');
    fs.rmSync(file, { force: true });
    return '2 areas + 1 route round-tripped';
  });

  await check('permissions: deny > allow > ask, with globs, areas and self:placed', () => {
    const fs = require('fs');
    const { Places } = require(path.join(ROOT, 'src/core/places'));
    const { Permissions } = require(path.join(ROOT, 'src/core/permissions'));
    const placesFile = path.join(ROOT, '.tmp', 'perm-places-selftest.json');
    const rulesFile = path.join(ROOT, '.tmp', 'permissions-selftest.json');
    fs.rmSync(placesFile, { force: true });
    fs.rmSync(rulesFile, { force: true });
    const places = new Places({ root: ROOT }, { file: placesFile, log: silent });
    places.addArea('house', { type: 'box', from: { x: 0, y: 60, z: 0 }, to: { x: 8, y: 70, z: 8 } });
    const perms = new Permissions({ root: ROOT }, { file: rulesFile, log: silent, places });
    perms.addRule({ effect: 'allow', action: 'break', match: 'create:*' });
    perms.addRule({ effect: 'ask', action: 'break', match: '*' });
    perms.addRule({ effect: 'deny', action: 'break', match: 'area:house' });
    if (perms.check('break', { name: 'minecraft:dirt', position: { x: 1, y: 64, z: 1 } }).verdict !== 'deny') {
      throw new Error('deny did not win over ask');
    }
    if (perms.check('break', { name: 'create:cogwheel' }).verdict !== 'allow') throw new Error('namespace glob failed');
    if (perms.check('break', { name: 'minecraft:dirt' }).verdict !== 'ask') throw new Error('catch-all ask failed');
    if (perms.check('place', { name: 'minecraft:torch' }).verdict !== 'allow') throw new Error('no rule must default to allow');
    if (!perms.matches({ action: 'break', match: 'self:placed' }, 'break', { selfPlaced: true })) {
      throw new Error('self:placed did not match');
    }
    perms.setMode('observe');
    if (perms.check('break', { name: 'x' }).verdict !== 'deny') throw new Error('observe must deny');
    perms.setMode('bypass');
    if (perms.check('break', { name: 'x' }).verdict !== 'allow') throw new Error('bypass must allow');
    fs.rmSync(placesFile, { force: true });
    fs.rmSync(rulesFile, { force: true });
    return 'order + glob + area + self + modes';
  });

  await checkAsync('consent desk: answers, remembers and times out', async () => {
    const { ConsentDesk } = require(path.join(ROOT, 'src/core/permissions'));
    const said = [];
    const desk = new ConsentDesk({}, { log: silent, speak: (text) => said.push(text), timeoutMs: 60 });
    const first = desk.ask({ action: 'break', target: { name: 'minecraft:dirt', position: { x: 1, y: 2, z: 3 } } });
    if (!desk.status().pending) throw new Error('no pending question recorded');
    desk.answer('yes');
    if ((await first) !== 'allow') throw new Error('yes did not allow');
    const always = desk.ask({ action: 'break', target: { name: 'minecraft:stone' } });
    desk.answer('yes always');
    if ((await always) !== 'always') throw new Error('yes always did not answer');
    const timedOut = desk.ask({ action: 'place', target: { name: 'minecraft:torch' } });
    if ((await timedOut) !== 'deny') throw new Error('a timeout must deny');
    if (!said.length || !desk.status().recent.length) throw new Error('the question was not spoken/recorded');
    return `${said.length} question(s), allow/always/timeout`;
  });

  await checkAsync('permission gate: deny blocks, ask consents, placement is remembered', async () => {
    const fs = require('fs');
    const { Permissions, ConsentDesk } = require(path.join(ROOT, 'src/core/permissions'));
    const { installPermissionGate } = require(path.join(ROOT, 'src/core/permissionGate'));
    const file = path.join(ROOT, '.tmp', 'gate-selftest.json');
    fs.rmSync(file, { force: true });
    const perms = new Permissions({ root: ROOT }, { file, log: silent });
    const desk = new ConsentDesk({}, { log: silent, speak: () => {}, timeoutMs: 200 });
    const calls = [];
    /** Task identity the gate will ask about; null means "no task running". */
    let scope = null;
    const body = {
      dig: async (block) => {
        calls.push(`dig:${block.name}`);
        return true;
      },
      place: async (item) => {
        calls.push(`place:${item}`);
        return true;
      },
      useOn: async () => {
        calls.push('use');
        return true;
      },
      blockAt: () => null
    };
    const gate = installPermissionGate(body, {
      permissions: perms,
      consent: desk,
      log: silent,
      taskScope: () => scope
    });
    if (gate.installed.length !== 3) throw new Error(`gate installed ${gate.installed.length} methods`);

    perms.addRule({ effect: 'deny', action: 'break', match: 'minecraft:dirt' });
    if ((await body.dig({ name: 'minecraft:dirt', position: { x: 0, y: 64, z: 0 } })) !== false) {
      throw new Error('a denied dig must return false');
    }
    if (!body.lastRefusal || !/deny/.test(body.lastRefusal.reason)) throw new Error('the refusal was not recorded');

    perms.addRule({ effect: 'ask', action: 'break', match: '*' });
    const pending = body.dig({ name: 'minecraft:stone', position: { x: 1, y: 64, z: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    desk.answer('yes');
    if ((await pending) !== true) throw new Error('an allowed dig did not run');

    const askAlways = body.dig({ name: 'minecraft:stone', position: { x: 2, y: 64, z: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    desk.answer('yes always');
    if ((await askAlways) !== true) throw new Error('the always-allow dig did not run');
    if (perms.list().filter((r) => r.effect === 'allow' && r.match === 'minecraft:stone').length !== 1) {
      throw new Error('yes always did not append an allow rule');
    }

    await body.place('minecraft:torch', { x: 3, y: 64, z: 0 }, { x: 0, y: 1, z: 0 });
    perms.addRule({ effect: 'ask', action: 'break', match: 'self:placed' });
    const selfPlaced = body.dig({ name: 'minecraft:torch', position: { x: 3, y: 65, z: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    desk.answer('no');
    if ((await selfPlaced) !== false) throw new Error('self:placed ask + no must refuse');

    /**
     * Task-scoped consent: one `!yes` covers the same block for the rest of THIS task; the
     * next task asks again. Found live: a two-block dirt dig asked twice in a row.
     */
    scope = { id: 'task-1' };
    const firstGravel = body.dig({ name: 'minecraft:gravel', position: { x: 4, y: 64, z: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    desk.answer('yes');
    if ((await firstGravel) !== true) throw new Error('the task-scoped first dig did not run');
    const sameTask = body.dig({ name: 'minecraft:gravel', position: { x: 5, y: 64, z: 0 } });
    const raced = await Promise.race([
      sameTask,
      new Promise((resolve) => setTimeout(() => resolve('asked'), 80))
    ]);
    if (raced === 'asked') throw new Error('the same task was asked twice for the same block');
    scope = { id: 'task-2' };
    const nextTask = body.dig({ name: 'minecraft:gravel', position: { x: 6, y: 64, z: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!desk.status().pending) throw new Error('a new task must ask again');
    desk.answer('no');
    if ((await nextTask) !== false) throw new Error('the new-task deny did not refuse');
    fs.rmSync(file, { force: true });
    return `deny/ask/always/self:placed/task-scope verified (${calls.length} body calls)`;
  });

  await checkAsync('permission gate: a single-hop pillar is a place; multi-hop is refused', async () => {
    const fs = require('fs');
    const { Permissions, ConsentDesk } = require(path.join(ROOT, 'src/core/permissions'));
    const { installPermissionGate } = require(path.join(ROOT, 'src/core/permissionGate'));
    const file = path.join(ROOT, '.tmp', 'gate-pillar-selftest.json');
    fs.rmSync(file, { force: true });
    const perms = new Permissions({ root: ROOT }, { file, log: silent });
    const desk = new ConsentDesk({}, { log: silent, speak: () => {}, timeoutMs: 200 });
    const calls = [];
    const body = {
      pillar: async (count) => {
        calls.push(`pillar:${count}`);
        return { ok: true, steps: count };
      },
      snapshot: () => ({ position: { x: 0, y: 64, z: 0 }, heldItem: 'minecraft:cobblestone' }),
      dig: async () => true,
      place: async () => true,
      useOn: async () => true
    };
    const gate = installPermissionGate(body, { permissions: perms, consent: desk, log: silent, taskScope: () => null });
    if (!gate.installed.includes('pillar')) throw new Error('the gate did not wrap pillar');

    const multi = await body.pillar(2);
    if (multi.ok !== false || calls.length) throw new Error('multi-hop pillar must be refused before the body');

    const denyIndex = perms.addRule({ effect: 'deny', action: 'place', match: 'minecraft:cobblestone' }).index;
    const denied = await body.pillar(1);
    if (denied.ok !== false || calls.length) throw new Error('a denied placement must not reach the body');
    if (!body.lastRefusal || !/deny/.test(body.lastRefusal.reason)) throw new Error('the pillar refusal was not recorded');
    perms.removeRule(denyIndex);

    perms.addRule({ effect: 'allow', action: 'place', match: 'minecraft:cobblestone' });
    const hop = await body.pillar(1);
    if (hop.ok !== true || calls.length !== 1 || calls[0] !== 'pillar:1') throw new Error(`the allowed hop did not run: ${JSON.stringify(calls)}`);

    /**
     * The placed cell must be remembered as self:placed - that is the other half of the
     * "single pillar = one place" contract. A self:placed ask only fires when the set has
     * the feet cell, so a missing record would run the dig without asking.
     */
    perms.addRule({ effect: 'ask', action: 'break', match: 'self:placed' });
    const selfDig = body.dig({ name: 'minecraft:cobblestone', position: { x: 0, y: 64, z: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (!desk.status().pending) throw new Error('the pillar placement was not recorded in self:placed');
    desk.answer('yes');
    if ((await selfDig) !== true) throw new Error('the self:placed dig did not run after consent');
    fs.rmSync(file, { force: true });
    return 'multi-hop refused, deny blocked, allowed hop recorded as self:placed';
  });

  await check('mining plan: quotes price digging over distance, hazards refuse', () => {
    const { quoteApproach } = require(path.join(ROOT, 'src/skills/miningPlan'));
    const readFrom = (cells) => (cell) => cells.get(`${cell.x},${cell.y},${cell.z}`) || 'minecraft:air';
    const base = {
      from: { x: 0, y: 64, z: 0 },
      ore: { x: 6, y: 64, z: 0 },
      passable: (name) => /air/.test(name),
      mineable: () => true,
      hazard: (name) => /water|lava/.test(name),
      reachableCount: () => 1
    };
    const open = quoteApproach({ ...base, read: readFrom(new Map()) });
    // Chebyshev arrival: the last step lands on x=5, already within 1 of the ore at x=6.
    if (!open.ok || open.digs !== 0 || open.steps !== 5) throw new Error(`open quote wrong: ${JSON.stringify(open)}`);

    const stone = new Map();
    for (let x = 1; x <= 6; x += 1) {
      stone.set(`${x},64,0`, 'minecraft:stone');
      stone.set(`${x},65,0`, 'minecraft:stone');
    }
    const encased = quoteApproach({ ...base, read: readFrom(stone) });
    if (!encased.ok || encased.digs < 10) throw new Error(`encased quote wrong: ${JSON.stringify(encased)}`);
    if (encased.cost <= open.cost) throw new Error(`digging (${encased.cost}) must cost more than walking (${open.cost})`);

    const vein = quoteApproach({ ...base, read: readFrom(stone), reachableCount: () => 4 });
    if (!(vein.cost < encased.cost)) throw new Error(`the vein bonus did not lower the cost: ${vein.cost} vs ${encased.cost}`);

    const flooded = quoteApproach({ ...base, read: readFrom(new Map([['3,64,0', 'minecraft:water']])) });
    if (flooded.ok || !flooded.hazard) throw new Error(`a water cell must refuse the approach: ${JSON.stringify(flooded)}`);

    const risky = quoteApproach({
      ...base,
      read: readFrom(new Map([['2,64,0', 'minecraft:stone']])),
      risky: (cell) => (cell.x === 2 && cell.y === 64 ? 'falling sand above' : null)
    });
    if (risky.ok || !risky.hazard) throw new Error(`a physical risk must refuse the approach: ${JSON.stringify(risky)}`);
    return `open ${open.cost} vs encased ${encased.cost} (digs ${encased.digs}), vein ${vein.cost}, hazard + risk refused`;
  });

  await check('mining plan: the ledger separates planned from extra and enforces the budget', () => {
    const { DigLedger } = require(path.join(ROOT, 'src/skills/miningPlan'));
    const ledger = new DigLedger([
      { x: 1, y: 64, z: 0 },
      { x: 2, y: 64, z: 0 }
    ]);
    const planned = ledger.note({ x: 1, y: 64, z: 0 });
    const surprise = ledger.note({ x: 9, y: 64, z: 0 });
    ledger.note({ x: 8, y: 64, z: 0 });
    const summary = ledger.summary(1);
    if (planned !== false || surprise !== true) throw new Error('planned/extra classification is wrong');
    if (summary.planned !== 2 || summary.dug !== 3 || summary.extra !== 2) {
      throw new Error(`ledger counts wrong: ${JSON.stringify(summary)}`);
    }
    if (!summary.exceeded || !ledger.exceeded(1) || ledger.exceeded(2)) throw new Error('the budget gate is wrong');
    return `planned 2 / dug 3 / extra 2, budget 1 exceeded`;
  });

  // ------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(52)}\n`);
  process.stdout.write(`selftest: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write(`FAILED:\n${failed.map((f) => `  - ${f.name}: ${f.detail}`).join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('all good - run `npm run agent` to play\n');
  }
}

main().catch((err) => {
  process.stdout.write(`selftest crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
