'use strict';

/**
 * Entry point: wire the controller, the world view, the survival systems and the
 * brain together, then keep them alive until Ctrl-C.
 *
 *   npm run agent            # connect to the configured server and survive
 *   npm run agent -- --goal "gather 32 logs"   # start with an explicit objective
 *
 * This process is the "agent" half of the project. The PCL half (see src/pcl) is
 * what launches the interactive client so a human can watch the bot play.
 */

const path = require('path');
const { loadConfig, applyAddress } = require('./util/config');
const { Logger } = require('./util/logger');
const { BotController } = require('./core/bot');
const { Navigator, sleep } = require('./core/movement');
const { needsRescue, escapeToGround } = require('./core/recovery');
const { WorldView } = require('./world/worldView');
const { Memory } = require('./core/memory');
const { AutoEat } = require('./survival/autoEat');
const { Combat } = require('./survival/combat');
const { ToolManager } = require('./survival/toolManager');
const { Brain } = require('./brain');
const { ChatController } = require('./chat/commands');
const { startStatusServer } = require('./web/statusServer');
const { acquireLock } = require('./core/lockfile');
const { ModKnowledge } = require('./mods/knowledge');
const { describeTarget } = require('./core/network');
const { preflight } = require('./core/preflight');
const { createBody } = require('./body/factory');
const { createBotFacade } = require('./body/botFacade');
const { ChatListener } = require('./chat/chatListener');
const { reply } = require('./chat/reply');
const { DeathWatch } = require('./core/deathWatch');
const { AuthMeLogin } = require('./core/authme');
const { ChopWoodTask } = require('./tasks/chopWood');
const { MineBlockTask } = require('./tasks/mineBlock');
const { HuntTask } = require('./tasks/hunt');
const { ShelterTask } = require('./tasks/shelter');
const { CraftTask } = require('./tasks/craft');

/**
 * Where the control panel listens.
 *
 * `web.port: null` in the config means "next to the bridge port", which keeps a second
 * checkout from colliding with the first (P0-PLAN §7.1). An explicit `--status-port` or
 * `web.port` always wins.
 */
function statusServerPort(cfg, args = {}) {
  if (args.statusPort) return args.statusPort;
  const web = (cfg.agent && cfg.agent.web) || {};
  if (web.port) return web.port;
  const bridge = (cfg.server && cfg.server.bridgePort) || 8765;
  return bridge + 1;
}

function parseArgs(argv) {
  const args = {
    goal: null,
    headless: false,
    once: false,
    statusPort: null,
    noStatus: false,
    diagnose: false,
    force: false,
    day: false,
    noPreflight: false,
    server: null,
    profile: null,
    body: null,
    auth: null,
    proxy: null,
    username: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--goal') args.goal = argv[++i];
    else if (a === '--headless') args.headless = true;
    else if (a === '--once') args.once = true;
    else if (a === '--no-status') args.noStatus = true;
    else if (a === '--diagnose') args.diagnose = true;
    else if (a === '--force') args.force = true;
    else if (a === '--day') args.day = true;
    else if (a === '--no-preflight') args.noPreflight = true;
    else if (a === '--server' || a === '--address') args.server = argv[++i];
    else if (a === '--profile') args.profile = argv[++i];
    else if (a === '--body') args.body = argv[++i];
    else if (a === '--auth') args.auth = argv[++i];
    else if (a === '--proxy') args.proxy = argv[++i];
    else if (a === '--username') args.username = argv[++i];
    else if (a === '--status-port') args.statusPort = Number(argv[++i]);
    else if (a === '--once-ms') args.onceMs = Number(argv[++i]);
    else if (a === '--connect-wait-ms') args.connectWaitMs = Number(argv[++i]);
  }
  return args;
}

/**
 * Instrumented single-task run: reports what the perception layer sees and then
 * runs exactly one goal, logging every failure path. `npm run agent -- --diagnose`
 */
async function runDiagnostics(ctx, brain) {
  const { controller, world, log } = ctx;
  const bot = ctx.bot;
  const { isLog } = require('./world/items');
  const { ChopWoodTask } = require('./tasks/chopWood');

  log.info('=== diagnostics ===');
  const pos = bot.entity.position.floored();
  log.info(`position ${pos} dimension ${world.dimension()} ground=${world.groundLevel()}`);
  log.info(`health=${bot.health} food=${bot.food} emptySlots=${bot.inventory.emptySlotCount()}`);
  log.info(`timeOfDay=${world.timeOfDay()} isNight=${world.isNight()} light=${world.lightLevel()}`);

  const census = new Map();
  for (let dx = -24; dx <= 24; dx += 2) {
    for (let dz = -24; dz <= 24; dz += 2) {
      for (let dy = -6; dy <= 10; dy += 2) {
        const b = bot.blockAt(pos.offset(dx, dy, dz));
        if (!b || b.name === 'air') continue;
        census.set(b.name, (census.get(b.name) || 0) + 1);
      }
    }
  }
  log.info(`blocks: ${[...census.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => `${n}:${c}`).join(', ')}`);

  const nearestLog = world.findNearestLog(48);
  log.info(`world.findNearestLog(48) -> ${nearestLog ? `${nearestLog.name} @ ${nearestLog.position}` : 'null'}`);
  log.info(`mineflayer findBlock(log,48) -> ${String(bot.findBlock({ matching: (b) => isLog(b.name), maxDistance: 48 }))}`);
  log.info(`pathfinder available=${!!bot.pathfinder} tool=${!!bot.tool} collectBlock=${!!bot.collectBlock}`);
  log.info(`hostiles(12)=${world.hostiles(12).length}`);

  if (nearestLog) {
    log.info('goto the nearest log (canDig=true)...');
    ctx.nav.refreshMovements({ canDig: true });
    const ok = await ctx.nav.gotoBlock(nearestLog, { range: 1, timeoutMs: 20000 });
    log.info(`gotoBlock -> ${ok}`);
    const { digBlock } = require('./core/movement');
    const dug = await digBlock(ctx, bot.blockAt(nearestLog.position), { log });
    log.info(`digBlock -> ${dug}`);
    await new Promise((r) => setTimeout(r, 1500));
    log.info(`inventory after dig: ${bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', ') || '(empty)'}`);
  }

  log.info('running one ChopWoodTask{count:2}...');
  const task = new ChopWoodTask(ctx, { count: 2 });
  const res = await task.execute();
  log.info(`task result: ${JSON.stringify(res)}`);
  log.info(`inventory after task: ${bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', ') || '(empty)'}`);
  log.info('=== diagnostics done ===');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig({ profile: args.profile });

  // Point the same checkout at any server without editing JSON:
  //   node src/index.js --server mc.example.com:25565 --auth offline
  if (args.server) applyAddress(cfg, args.server);
  if (args.body) cfg.agent.body = { ...(cfg.agent.body || {}), kind: args.body };
  if (process.env.MC_BODY) cfg.agent.body = { ...(cfg.agent.body || {}), kind: process.env.MC_BODY };
  if (args.auth) cfg.agent.bot.auth = args.auth;
  if (args.proxy) cfg.agent.bot.proxy = args.proxy;
  if (args.username) cfg.agent.bot.username = args.username;

  const log = new Logger('agent', {
    level: cfg.agent.logging.level,
    file: path.join(cfg.paths.logs, 'agent.log')
  });

  log.info('minecraft-survival-agent starting');
  log.info(`target ${cfg.agent.bot.host}:${cfg.agent.bot.port} as ${cfg.agent.bot.username} (mc ${cfg.agent.bot.version})`);

  // Preflight only makes sense for bodies that actually open a network connection.
  // A mock body runs a scripted world with no server at all, so probing one (and
  // refusing to start when it is Forge/modded) would be nonsense.
  const needsNetwork = ((cfg.agent.body && cfg.agent.body.kind) || 'mineflayer') === 'mineflayer';
  if (!args.noPreflight && needsNetwork) {
    try {
      const probe = await preflight(cfg, { log: new Logger('preflight') });
      log.info(`preflight: ${probe.reason}`);
      for (const line of probe.advice) log.info(`preflight: ${line}`);
      if (!probe.connect) {
        log.error('refusing to connect - see the preflight messages above');
        process.exitCode = 3;
        return;
      }
    } catch (err) {
      log.warn(`preflight failed (${err.message}) - continuing anyway`);
    }
  }

  // One agent per username: a second login gets kicked as duplicate_login.
  const lock = acquireLock(cfg, { force: args.force });
  if (!lock.ok) {
    log.error(
      `another agent is already running (pid ${lock.holder.pid}, started ${lock.holder.startedAt}). ` +
        'Stop it first, or start with --force to take over the username.'
    );
    process.exitCode = 2;
    return;
  }
  process.on('exit', lock.release);

  const controller = new BotController(cfg, new Logger('bot'));
  const mods = new ModKnowledge(cfg, { log: new Logger('mods') });
  controller.mods = mods;
  let world = new WorldView(controller, { mods });
  const nav = new Navigator(controller);
  const memory = new Memory(cfg);
  const eat = new AutoEat(controller);
  const combat = new Combat(controller, nav);
  const tools = new ToolManager(controller);

  const ctx = { cfg, log, controller, world, nav, memory, eat, combat, tools, mods };
  ctx.target = describeTarget(cfg);

  // The Body is how the decision layer touches the world. `mineflayer` keeps the
  // existing behaviour; `clientmod` will drive a real Forge client; `mock` is a
  // scripted world for tests. See src/body/.
  const bodySelection = createBody(cfg, { controller, world, nav, combat, eat, tools, log: new Logger('body') });
  ctx.body = bodySelection.body;
  ctx.bodyKind = bodySelection.kind;
  log.info(`body: ${bodySelection.kind}${bodySelection.reason ? ` (${bodySelection.reason})` : ''}`);
  if (!bodySelection.usable) {
    log.error(`body "${bodySelection.kind}" is not usable yet: ${bodySelection.reason}`);
    log.error('set body.kind to "mineflayer" in config/agent.json, or finish the client-mod path');
    process.exitCode = 4;
    return;
  }

  // When the body is not mineflayer, the planner must read the world through the body
  // too - otherwise it would query a game that is not connected.
  if (bodySelection.kind !== 'mineflayer') {
    const { BodyWorldView } = require('./world/bodyWorldView');
    ctx.world = new BodyWorldView(bodySelection.body, cfg, { log: new Logger('world') });
    world = ctx.world;
  }
  ctx.craft = (options) => new CraftTask(ctx, options).execute();
  ctx.mine = (options) => new MineBlockTask(ctx, options).execute();
  ctx.chop = (options) => new ChopWoodTask(ctx, options).execute();
  ctx.hunt = (options) => new HuntTask(ctx, options).execute();
  ctx.shelter = (options) => new ShelterTask(ctx, options).execute();

  const brain = new Brain(ctx);
  ctx.brain = brain;

  // ctx.bot always points at the live mineflayer instance, including reconnects.
  controller.on('botCreated', (bot) => {
    ctx.bot = bot;
  });

  const chat = new ChatController(ctx, { prefix: cfg.agent.behaviour.chatPrefix });
  ctx.chat = chat;

  // ---------------------------------------------------------------- output
  /**
   * The single speech path (P0-PLAN §4.3). Everything that talks - command acks, LLM
   * replies, task follow-ups - goes through here, which is what makes the echo filter's
   * "remember what we said" guarantee actually hold.
   */
  ctx.reply = (text, options) => reply(ctx, text, options);

  // ------------------------------------------------------- channel A: `!`
  const chatCfg = cfg.agent.chat || {};
  const chatListener = new ChatListener(ctx.body, ctx, {
    prefix: chatCfg.prefix === undefined ? '!' : chatCfg.prefix,
    intervalMs: chatCfg.pollIntervalMs || 700
  });
  ctx.chatListener = chatListener;

  /**
   * botFacade: a read-only, bot-shaped view over the Body.
   *
   * Under the client-mod body there is no mineflayer instance, so `ctx.bot` stays null and
   * the helpers that expect one (`inventorySummary`, `say`) used to fail silently. See
   * src/body/botFacade.js - it deliberately exposes no action methods.
   */
  if (bodySelection.kind !== 'mineflayer') {
    ctx.botFacade = createBotFacade(ctx.body, cfg, {
      noteOwnSpeech: (text) => chatListener.noteOwnSpeech(text)
    });
  }

  // ------------------------------------------------------------ LLM layer
  const { LlmCore } = require('./llm');
  const llm = new LlmCore(ctx, cfg.llm || {}, { log: new Logger('llm') });
  ctx.llm = llm;
  llm.attachTo(brain);

  /**
   * Channel B: the natural-language trigger.
   *
   * Deliberately a *second* poller over the same chat log rather than a second code path
   * inside ChatListener: `!` is the deterministic fast path and `@猫娘` is the LLM path.
   * They must not be able to interfere with each other's dedupe state, and a failure in
   * one must leave the other working. That is also why the trigger is a distinct prefix
   * rather than "any message that is not a command" - ignoring everything else is a
   * requirement, not an oversight.
   */
  const dialogueTrigger = chatCfg.dialogueTrigger || '@猫娘';
  if (dialogueTrigger) {
    chatListener.onDialogue = async (text, line) => {
      const snap = ctx.body.snapshot();
      await llm.handle(text, {
        source: 'chat',
        speaker: '玩家',
        speakerPosition: snap ? snap.position : null
      });
    };
    // ChatListener treats only `prefix` lines as commands; the dialogue trigger is a
    // separate, opt-in second pass so neither can starve the other.
    chatListener.dialogueTrigger = dialogueTrigger;
    chatListener.ignoreOtherChat = chatCfg.ignoreOtherChat !== false;
  }

  // --------------------------------------------------------- death handling
  const deathWatch = new DeathWatch(ctx, { log: new Logger('death') });
  ctx.deathWatch = deathWatch;

  /**
   * Optional "the task you asked for is done" line (P0-PLAN §7.1 `chat.replyOnTaskResult`).
   *
   * Off by default, because P0's rule is that the bot speaks only when spoken to. When it is
   * switched on it stays *reactive in spirit*: it only reports tasks that came from a player
   * channel (chat, panel, LLM) - never the planner's own work, which the player never asked
   * about and would experience as unprompted chatter.
   */
  if ((cfg.agent.chat || {}).replyOnTaskResult === true) {
    const announce = (info, ok) => {
      if (!info || info.source === 'autonomous') return;
      const verb = ok ? '搞定' : '没做成';
      reply(ctx, `${info.description || info.name} ${verb}喵: ${String(info.reason || '').slice(0, 60)}`, {
        why: 'task-result'
      }).catch(() => {});
    };
    brain.on('task:done', (info) => announce(info, true));
    brain.on('task:failed', (info) => announce(info, false));
    log.info('chat.replyOnTaskResult is on: player-requested task results will be announced');
  }

  /**
   * AuthMe auto-login.
   *
   * `cfg.agent.bot.authme` used to be a dead config section - present in the file, read by
   * nothing - so a run against `mc.example.com` started unauthenticated and every action
   * was silently ignored by the server. See src/core/authme.js for why `/register` is never
   * sent and why a login is only attempted when there is evidence it is needed.
   */
  const authme = new AuthMeLogin(ctx.body, ctx, {
    ...(cfg.agent.bot.authme || {}),
    log: new Logger('authme')
  });
  ctx.authme = authme;
  chatListener.onAnyLine = (line) => authme.observe(line);

  let statusServer = null;
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`shutting down (${signal})`);
    brain.stop();
    chat.detach();
    chatListener.stop();
    deathWatch.stop();
    if (ctx.llm) ctx.llm.stop();
    if (statusServer) await statusServer.close().catch(() => {});
    memory.save();
    if (ctx.body && needsNetwork) controller.shutdown();
    await sleep(400);
    process.exit(0);
  };

  /**
   * Control panel / status API.
   *
   * Started before the body-specific branches so every body gets it. It used to be started
   * only on the mineflayer path, which meant the client-mod run - the one where the panel
   * matters most, because it is the only outside view of a GUI game - had no panel at all.
   */
  if (!args.noStatus) {
    statusServer = startStatusServer(ctx, { port: statusServerPort(cfg, args) });
  }

  // ------------------------------------------------------------------ mock body
  // With a scripted body there is no server to join: connect the mock, skip the
  // mineflayer-only startup path, and let the brain plan against the fake world.
  if (bodySelection.kind === 'mock') {
    await ctx.body.connect();
    brain.start();
    log.info('mock body online - planning against a scripted world (no server involved)');
    if (args.once) {
      log.info('--once set: exiting after 30s mock run');
      setTimeout(() => shutdown('once'), args.onceMs || 30000);
    }
    return;
  }

  /**
   * Client-mod startup.
   *
   * There is no `spawn` event to wait for - the body polls the mod, and the mod knows when
   * the client is in a world. So the three input/output services start as soon as the body
   * says it is ready, which is also the first moment a `/chatlog` poll can return anything.
   */
  if (bodySelection.kind === 'clientmod') {
    /**
     * Attach to the running Forge client.
     *
     * The wait is long on purpose - a cold client takes 30-60s to reach a world - but a
     * failure here is a *normal* situation (client not started yet, mod not installed, still
     * on the title screen), so it gets a plain explanation with the fix rather than a stack
     * trace. `shutdown()` also takes the panel down, so the port is free for the next try.
     */
    try {
      await ctx.body.connect({ waitMs: args.connectWaitMs || 120000 });
    } catch (err) {
      log.error(`could not attach to the control mod: ${err.message}`);
      log.error('  1. is the Forge client running?    npm run client:launch -- --server mc.example.com:25565');
      log.error('  2. is the agent-client mod installed?    npm run client:install');
      log.error(`  3. is a world loaded?    (the mod answers on http://127.0.0.1:${cfg.agent.clientMod.port}/health)`);
      await shutdown('client-unavailable');
      process.exitCode = 5;
      return;
    }
    const chatCfgLive = cfg.agent.chat || {};
    chatListener.start();
    deathWatch.start();

    /**
     * Authenticate before planning anything.
     *
     * On an AuthMe server an unauthenticated bot cannot move, chat or run commands - it
     * connects, perceives a healthy world, and then every action silently does nothing. So
     * the login attempt happens *before* the brain starts, and a failure is reported loudly
     * rather than left to look like a pathfinding bug.
     */
    const login = await authme.ensure('startup');
    if (login.ok) {
      log.info(`authentication: ${login.reason}`);
    } else if (login.action === 'skip' && /no evidence/.test(login.reason)) {
      log.info(`authentication: ${login.reason} - assuming the session is already valid`);
    } else {
      log.warn(`authentication: ${login.action} - ${login.reason}`);
      if (authme.needsRegistration) {
        log.warn('  the agent will NOT register: on this server /register wipes the character.');
        log.warn('  ask the server owner to create the account, or register it yourself by hand once.');
      }
    }
    deathWatch.onRespawn = () => authme.ensure('respawn');

    brain.start();
    log.info(`in-game chat: "${chatCfgLive.prefix || '!'}<command>" for actions, "${dialogueTrigger}" to talk`);
    log.info(`control panel: http://${cfg.agent.web.bind || '127.0.0.1'}:${statusServerPort(cfg, args)}/panel`);

    if (args.goal) {
      log.info(`explicit goal requested: ${args.goal}`);
      await applyGoal(ctx, args.goal);
    }
    if (args.once) {
      log.info('--once set: exiting after the configured run');
      setTimeout(() => shutdown('once'), args.onceMs || 60000);
    }
    return;
  }

  controller.on('spawn', async () => {
    nav.refreshMovements({ canDig: true });
    await tools.equipArmor().catch(() => {});

    // Work out what kind of server we landed on before planning anything: on a
    // modded server most content is unknown to mineflayer, and knowing that changes
    // which goals are safe to attempt.
    try {
      const detected = mods.scan(controller.bot);
      if (detected) {
        log.info(`server type: ${detected.loader}${detected.modNamespaces.length ? ` (${detected.modNamespaces.length} mod namespaces)` : ''}`);
        for (const line of mods.guidance()) log.info(`mods: ${line}`);
        if (mods.report.unknownContent.itemCount) {
          log.info(`mods: ${mods.report.unknownContent.itemCount} registry entries have no name in minecraft-data`);
        }
      }
    } catch (err) {
      log.warn(`mod scan failed: ${err.message}`);
    }

    // Spawning on a treetop / cliff edge is common and breaks A*: drop to solid
    // ground before planning anything.
    if (needsRescue(world)) {
      await escapeToGround(ctx).catch((e) => log.debug(`initial rescue failed: ${e.message}`));
      nav.stuckCount = 0;
    }
    // Make sure the pathfinder is armed before the first plan (its stop flag starts
    // latched on a fresh connection).
    await controller.rearmPathfinder().catch(() => {});
    nav.armed = true;
    if (args.day) {
      // Handy for demos and for first runs: skip the "spawn into a mob night".
      ctx.bot.chat('/time set day');
      log.info('requested daytime');
      await sleep(500);
    }
    if (args.diagnose) {
      try {
        await runDiagnostics(ctx, brain);
      } catch (err) {
        log.error(`diagnostics failed: ${err.message}`);
      }
      await shutdown('diagnose');
      return;
    }
    brain.start();
    if (args.goal) {
      log.info(`explicit goal requested: ${args.goal}`);
      await applyGoal(ctx, args.goal);
    }
  });

  controller.on('death', () => {
    memory.recordDeath('unknown');
    brain.noteDeath();
    brain.preempt();
  });

  controller.on('respawn', () => {
    nav.refreshMovements({ canDig: true });
  });

  controller.on('chat', ({ text, position }) => {
    if (cfg.agent.logging.chatToConsole) log.info(`chat< ${text}`);
  });

  if (!args.noStatus) {
    statusServer = startStatusServer(ctx, { port: statusServerPort(cfg, args) });
  }

  if (bodySelection.kind === 'mock') {
    log.info(`control panel: http://127.0.0.1:${statusServerPort(cfg, args)}/panel (mock body)`);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  controller.connect();
  chat.attach();
  // Periodic state dump: the GUI/tooling reads this file.
  const dumpTimer = setInterval(() => {
    memory.data.runtime = {
      ...controller.snapshot(),
      world: world.summary(),
      brain: { current: brain.currentTask ? brain.currentTask.name : null, lastDecision: brain.lastDecision },
      updatedAt: new Date().toISOString()
    };
    memory.save();
  }, 5000);
  dumpTimer.unref();

  if (args.once) {
    log.info('--once set: exiting after 60s sanity run');
    setTimeout(() => shutdown('once'), 60000);
  }
}

/** Map a free-text goal onto a task (minimal NL layer, extended by chat commands). */
async function applyGoal(ctx, goal) {
  const text = String(goal).toLowerCase();
  const numMatch = text.match(/(\d+)/);
  const count = numMatch ? Number(numMatch[1]) : undefined;
  if (/wood|log|tree|木头|原木|砍/.test(text)) return ctx.brain.push(new ChopWoodTask(ctx, { count: count || 16 }));
  // Dirt before stone: "挖泥土" also matches the stone branch below via 挖, and answering a
  // request for dirt with a stone task looks like the agent ignoring what was asked.
  if (/dirt|泥土|土块|挖土/.test(text)) {
    return ctx.brain.push(new MineBlockTask(ctx, { block: ['dirt', 'grass_block'], count: count || 16, probeShaft: false }));
  }
  if (/stone|cobble|石头|圆石|挖/.test(text)) return ctx.brain.push(new MineBlockTask(ctx, { block: ['stone', 'cobblestone', 'deepslate'], count: count || 16 }));
  if (/iron|铁/.test(text)) return ctx.brain.push(new MineBlockTask(ctx, { block: ['iron_ore', 'deepslate_iron_ore'], count: count || 3, timeoutMs: 240000 }));
  if (/food|hunt|meat|食物|打猎|肉/.test(text)) return ctx.brain.push(new HuntTask(ctx, { count: count || 3 }));
  if (/shelter|house|base|庇护|房子|基地/.test(text)) return ctx.brain.push(new ShelterTask(ctx));
  if (/craft|合成/.test(text)) {
    const item = text.replace(/craft|合成|\d+/g, '').trim().replace(/\s+/g, '_');
    return ctx.brain.push(new CraftTask(ctx, { item, count: count || 1 }));
  }
  ctx.log.warn(`goal not understood: "${goal}"`);
  return null;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});

module.exports = { parseArgs, applyGoal };
