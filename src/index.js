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
const { runMiningInline } = require('./core/miningDispatch');
const { applyGoal } = require('./core/goalRouter');
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
  const { ObservationCache } = require('./world/observation');
  ctx.observation = new ObservationCache({ body: ctx.body, log: new Logger('observation') });
  ctx.craft = (options) => new CraftTask(ctx, options).execute();
  /**
   * `ctx.mine` - the internal direct-executor contract ("the caller already owns the
   * task slot", plan §5.6.3). It keeps the old signature but routes through the shared
   * request normalization, so an ore request from an owning task reaches `mine_ore`
   * instead of the walk-only task, without submitting a second TaskHub job.
   */
  ctx.mine = (options = {}) =>
    runMiningInline(ctx, { blocks: options.block || options.ore, count: options.count, params: options });
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

  // ------------------------------------------------- second-batch machinery
  /**
   * Named places (area/route), the permission rules and the consent desk are created here,
   * before anything can act: the gate below wraps the body's two hands, so every later
   * skill/task goes through the rules whether it knows about them or not.
   */
  const { Places } = require('./core/places');
  const { Permissions, ConsentDesk } = require('./core/permissions');
  const { TaskHub } = require('./core/taskHub');
  const { installPermissionGate } = require('./core/permissionGate');

  ctx.places = new Places(cfg, { log: new Logger('places') });
  ctx.permissions = new Permissions(cfg, { log: new Logger('permissions'), places: ctx.places });
  ctx.consent = new ConsentDesk(ctx, {
    log: new Logger('consent'),
    speak: (text) => ctx.reply(text, { why: 'permission question', force: true })
  });
  ctx.hub = new TaskHub(ctx, { log: new Logger('task'), trace: (entry) => ctx.trace && ctx.trace(entry) });
  ctx.permissionGate = installPermissionGate(ctx.body, {
    permissions: ctx.permissions,
    consent: ctx.consent,
    log: new Logger('permission'),
    /**
     * A plain `!yes` is remembered for the work that asked: the running brain task, or the
     * background task slot's current job. A new task starts with a clean slate.
     */
    taskScope: () => ctx.brain.currentTask || ctx.brain.activeTask || (ctx.hub && ctx.hub.current) || null
  });
  log.info(
    `places: ${ctx.places.listAreas().length} area(s), ${ctx.places.listRoutes().length} route(s); ` +
      `permission mode=${ctx.permissions.summary().mode}, rules=${ctx.permissions.summary().rules.length}`
  );

  // ------------------------------------------------------- channel A: `!`
  const chatCfg = cfg.agent.chat || {};
  const chatListener = new ChatListener(ctx.body, ctx, {
    prefix: chatCfg.prefix === undefined ? '!' : chatCfg.prefix,
    intervalMs: chatCfg.pollIntervalMs || 700,
    addressedPrefix: chatCfg.addressedPrefix || null
  });
  ctx.chatListener = chatListener;

  /**
   * The approved natural-language path can be delivered to the DeepSeek harness (behavior
   * brain) instead of the legacy Node chat/action loop. The bridge only forwards the
   * original text; approval and rewriting stay outside it.
   */
  if (chatCfg.actionBrain === 'harness') {
    const { HarnessBridge } = require('./chat/harnessBridge');
    const bridge = new HarnessBridge({
      url: chatCfg.harnessUrl || 'http://127.0.0.1:8770',
      log: new Logger('harness-bridge')
    });
    ctx.forwardToActionBrain = (text, meta) => bridge.forward(text, meta);
  }

  /**
   * Channel A0: addressed instructions (`@...`), disabled by default.
   *
   * The judge is injected (a future LLM adapter sets `ctx.judgeInstruction`); with no judge
   * every instruction is refused, which is the honest default until M3 wires the gate.
   * An allowed instruction is dispatched as the **original** text.
   */
  if (chatCfg.addressedPrefix) {
    log.info(`addressed channel: prefix "${chatCfg.addressedPrefix}" (gate timeout ${chatCfg.gateTimeoutMs || 8000}ms)`);
    const { CommandGate } = require('./chat/commandGate');
    const { AddressedHandler } = require('./chat/addressedHandler');
    const gate = new CommandGate({
      /**
       * Resolve the judge lazily. This block runs before ctx.llm is constructed; capturing
       * the function now yields null and every instruction is refused with "no-judge"
       * (live A02 2026-10-17). Read ctx.llm at decision time instead.
       */
      judge: (text) => {
        if (typeof ctx.judgeInstruction === 'function') return ctx.judgeInstruction(text);
        if (ctx.llm && typeof ctx.llm.judgeInstruction === 'function') {
          return ctx.llm.judgeInstruction(text);
        }
        throw new Error('no judge available');
      },
      timeoutMs: chatCfg.gateTimeoutMs || 8000
    });
    const addressed = new AddressedHandler({
      gate,
      log,
      dispatch: (text, meta) => {
        /**
         * The gate is the persona-bottom-line approval tool. An allowed instruction is the
         * player's ORIGINAL text; when configured, hand it to the DeepSeek harness (action
         * brain) unchanged. The legacy Node chat loop remains the fallback only when the
         * harness path is not configured.
         */
        if (typeof ctx.forwardToActionBrain === 'function') {
          return ctx.forwardToActionBrain(text, meta);
        }
        return ctx.chat.handle(text, (meta && meta.from) || 'addressed', { source: 'addressed' });
      }
    });
    chatListener.onAddressed = (text, line) => addressed.handle(text, { line });
    ctx.addressedHandler = addressed;
  }

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
  const { UsageLedger } = require('./llm/usageLedger');
  const usageCfg = (cfg.llm && cfg.llm.usage) || {};
  const usageLedger =
    usageCfg.enabled === false
      ? null
      : new UsageLedger({
          file: usageCfg.file || 'runtime/llm-usage.jsonl',
          log: new Logger('usage')
        });
  const llm = new LlmCore(ctx, cfg.llm || {}, { log: new Logger('llm'), usageLedger });
  ctx.llm = llm;
  ctx.usageLedger = usageLedger;

  /**
   * M4 live loop: generation -> candidate -> sandbox trial -> evidence -> promotion.
   *
   * The service is present only when the config enables it. Generation writes files but
   * never imports them; the sandbox child is the only consumer. Search is the DeepSeek
   * Search API through this Node process (generated code has no direct network).
   */
  const codeCfg = (cfg.agent && cfg.agent.codeSkills) || {};
  const searchCfg = codeCfg.search || {};
  /**
   * Two search surfaces share the trusted WebSearch broker but not a tool:
   *   - language brain: `web_search`, read-only knowledge supplement, no preferred source;
   *   - behavior brain: `lookup_mod_content`, Node broker, MC百科/Minecraft Wiki priority.
   * Neither surface can turn a result into an action; the language brain has no executor.
   */
  let webSearch = null;
  if (searchCfg.enabled !== false) {
    const { WebSearch } = require('./llm/knowledge/webSearch');
    webSearch = new WebSearch({
      baseUrl: llm.client.baseUrl,
      apiKey: llm.client.apiKey,
      enabled: true,
      cacheFile: searchCfg.cacheFile || 'runtime/search-cache.json',
      timeoutMs: searchCfg.timeoutMs || 8000,
      log: new Logger('webSearch')
    });
    ctx.webSearch = webSearch;
    /**
     * Language brain: a read-only knowledge supplement with no source priority. It must
     * not reuse the behavior brain's MC百科/Minecraft Wiki ordering.
     */
    ctx.languageSearch = (query, options = {}) =>
      webSearch.search(query, { ...options, preferred: false });
    log.info(
      `web lookup ${webSearch.configured ? 'online' : 'configured-off'} ` +
        `(${webSearch.baseUrl}/v1/tools/search)`
    );
  }
  if (codeCfg.enabled !== false) {
    const { CodeSkillGeneration } = require('./codeSkills/generation');
    const { CodeSkillService } = require('./codeSkills/service');
    const codeGeneration = new CodeSkillGeneration({
      complete: async ({ system, messages, maxTokens, timeoutMs, usageContext }) => {
        const result = await llm.client.complete({
          system,
          messages,
          maxTokens,
          timeoutMs,
          usageContext
        });
        if (!result || !result.ok) throw new Error((result && result.reason) || 'model-failed');
        return result.text;
      },
      maxTokens: codeCfg.generateMaxTokens || 2600,
      timeoutMs: codeCfg.generationTimeoutMs || 30000,
      log: new Logger('code-gen')
    });
    ctx.codeSkills = new CodeSkillService({
      root: codeCfg.root || 'runtime/code-skills',
      evidenceDir: codeCfg.evidenceDir || 'runtime/code-skill-runs',
      sandboxRoot: codeCfg.sandboxRoot || 'runtime/code-skill-sandbox',
      timeoutMs: codeCfg.sandboxTimeoutMs || 30000,
      maxCalls: codeCfg.maxCalls || 100,
      generation: codeGeneration,
      search: webSearch,
      ctx,
      brain,
      log: new Logger('code-skills')
    });
    log.info(
      `code skills online: root=${codeCfg.root || 'runtime/code-skills'} ` +
        `(sandbox ${codeCfg.sandboxTimeoutMs || 30000}ms, search ${webSearch && webSearch.configured ? 'on' : 'off'})`
    );
  }

  /**
   * LLM mining recovery runner (P2, docs/MINING-LLM-PLAN.md §5.3). The mining skill calls
   * this from inside its own TaskHub task when the progress monitor fires a trigger; the
   * session shares that task's owner and budgets and never submits a second job.
   */
  const { runMiningRecovery, MiningRecoverySession } = require('./skills/miningRecovery');
  ctx.recoveryRunner = async ({ goal, io, monitor, trigger, triggerReason, signal, cfg: recoveryCfg }) => {
    /**
     * Shared model ledger (plan §5.8): a spent daily budget refuses the session up front,
     * and the session's usage is added to the same counter the chat path maintains.
     */
    if (ctx.llm && ctx.llm.budgetExceeded) {
      return {
        ok: false,
        outcome: 'failed',
        reason: 'daily token budget exhausted',
        failure: 'recovery_unavailable',
        goalId: goal && goal.goalId,
        calls: 0,
        tokens: 0
      };
    }
    const session = new MiningRecoverySession({
      ctx,
      io,
      goal,
      signal,
      cfg: recoveryCfg || (cfg.agent && cfg.agent.miningRecovery) || {},
      llm: (ctx.llm && ctx.llm.client) || null,
      monitor,
      trigger,
      triggerReason,
      trace: (entry) => ctx.trace && ctx.trace(entry)
    });
    const summary = await runMiningRecovery(session);
    if (ctx.llm && Number.isFinite(summary.tokens)) ctx.llm.tokensToday += summary.tokens;
    return summary;
  };
  llm.attachTo(brain);

  /**
   * A11: only edges reach the model; the 500ms snapshot sample does not. Threat edges are
   * recorded for status but handled by the reflex, so only chat/weather/phase wake the
   * language model (one short unprompted line per edge).
   */
  if (ctx.perceptionWake) {
    ctx.perceptionWake.subscribe((event) => {
      log.info(`perception wake: ${event.type}${event.detail ? ` - ${event.detail}` : ''}`);
      if (event.type !== 'chat:message' && event.type !== 'weather:change' && event.type !== 'phase:change') return;
      if (typeof llm.speakUp !== 'function') return;
      llm.speakUp('perception', { detail: event.detail }).catch((err) => {
        log.debug(`perception wake speech failed: ${err.message}`);
      });
    });
  }

  /**
   * Channel B: the natural-language trigger.
   *
   * Deliberately a *second* poller over the same chat log rather than a second code path
   * inside ChatListener: `!` is the deterministic fast path and the persona trigger is the
   * LLM path. They must not be able to interfere with each other's dedupe state, and a failure
   * in one must leave the other working. That is also why the trigger is a distinct prefix
   * rather than "any message that is not a command" - ignoring everything else is a
   * requirement, not an oversight.
   *
   * The trigger comes from `agent.chat.dialogueTrigger`, falling back to the persona file's own
   * frontmatter (see `resolveTrigger`). That ordering matters after a character swap:
   * `persona.md` already carries the name, so a mismatch (config still carrying the old name while the
   * character is 大肥鱼) would leave the in-game channel silently dead. An explicit config value
   * still wins, so an operator can point the trigger at a nickname without touching the sheet.
   */
  const { resolveTrigger, personaForConfig } = require('./llm/persona');
  const persona = personaForConfig(ctx, { log: new Logger('persona') });
  const dialogueTrigger = resolveTrigger(ctx, { log });
  if (chatCfg.addressedPrefix && dialogueTrigger && chatCfg.addressedPrefix === dialogueTrigger) {
    /** A02 needs the gate; ChatListener checks dialogue first, so equal prefixes bypass it. */
    log.warn(
      `addressedPrefix and dialogueTrigger are both "${dialogueTrigger}" - dialogue wins and the addressed gate is bypassed; use distinct prefixes for A02`
    );
  }
  /**
   * P1 M2h: optional language-brain dialogue channel. Default off; when on, plain dialogue
   * goes to LanguageAgent (read/say/silence only). Execution requests inside it are refused
   * and do NOT fall back to the action path; only a model outage falls back.
   */
  /**
   * Persona-bottom-line gate used by the language brain's `approve` tool. It is the same
   * judge as the addressed channel; it never approves action feasibility, only red lines.
   */
  ctx.approvalGate = (text) => ctx.llm.judgeInstruction(text);
  let languageDialogue = null;
  if (dialogueTrigger && chatCfg.languageAgent && llm && llm.client) {
    const { LanguageAgent } = require('./llm/languageAgent');
    const { LanguageDialogue } = require('./chat/languageDialogue');
    const agent = new LanguageAgent({
      ctx,
      persona:
        [persona.name, persona.body].filter(Boolean).join('\n').slice(0, 1500) || null,
      memoryFor: (text) =>
        ctx.memoryStore
          ? ctx.memoryStore.recall(text, { limit: 3 }).map(({ entry }) => ({
              category: entry.category,
              text: entry.text
            }))
          : [],
      complete: async ({ system, messages, maxTokens, usageContext }) => {
        const result = await llm.client.complete({
          system,
          messages,
          timeoutMs: 4000,
          maxTokens: maxTokens || 400,
          // Compression returns a plain-text summary; JSON mode would make the provider
          // reject a prompt that does not ask for JSON (live A30 2026-10-19: HTTP 400).
          json: !(usageContext && usageContext.kind === 'compress'),
          usageContext
        });
        if (!result || !result.ok) throw new Error((result && result.reason) || 'model-failed');
        return result.text;
      }
    });
    languageDialogue = new LanguageDialogue({
      agent,
      memory: ctx.memoryStore,
      chatMemory: ctx.chatMemory,
      fallback: async (text) => {
        const snap = ctx.body.snapshot();
        return llm.handle(text, {
          source: 'chat',
          speaker: '玩家',
          speakerPosition: snap ? snap.position : null
        });
      }
    });
    ctx.languageDialogue = languageDialogue;
  }
  if (dialogueTrigger) {
    log.info(`dialogue trigger: "${dialogueTrigger}" (character: ${persona.name}${persona.loaded ? '' : ' [default]'})`);
    chatListener.onDialogue = async (text, line) => {
      if (languageDialogue) {
        return languageDialogue.handle(text, line, { source: 'chat' });
      }
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

  /**
   * M6: ordinary multiplayer chat participation.
   *
   * This is a separate, opt-in path from the `@`/dialogue channels: it is the only place
   * where an unaddressed line may get a model-decided reply or deliberate silence. The
   * model sees no action tools; a malformed answer is silence. `ConversationState` supplies
   * incoming dedupe, request identity, stale-request refusal, rate limiting and echo rules
   * through the single `reply()` path.
   */
  let chatParticipation = null;
  if (chatCfg.participate && llm && llm.client) {
    const { ChatParticipation } = require('./chat/chatParticipation');
    chatParticipation = new ChatParticipation({
      ctx,
      enabled: true,
      conversation: ctx.conversation,
      reply: ctx.reply,
      persona: [persona.name, persona.body].filter(Boolean).join('\n').slice(0, 1500) || null,
      memoryFor: (text) =>
        ctx.memoryStore
          ? ctx.memoryStore.recall(text, { limit: 3 }).map(({ entry }) => ({
              category: entry.category,
              text: entry.text
            }))
          : [],
      maxTokens: chatCfg.participateMaxTokens || 120,
      timeoutMs: chatCfg.participateTimeoutMs || 4000,
      historyLimit: chatCfg.participateHistoryLimit || 8,
      maxChars: chatCfg.maxChars || 100,
      complete: async ({ system, messages, maxTokens, timeoutMs, usageContext }) => {
        const result = await llm.client.complete({
          system,
          messages,
          timeoutMs: timeoutMs || 4000,
          maxTokens: maxTokens || 120,
          usageContext
        });
        if (!result || !result.ok) throw new Error((result && result.reason) || 'model-failed');
        return result.text;
      },
      log: new Logger('chat-participate')
    });
    ctx.chatParticipation = chatParticipation;
    log.info(`ordinary chat participation enabled (max ${chatCfg.maxChars || 100} chars/reply)`);
  }

  /**
   * M6/A25: strict chat answers for a pending proposal. This is not a second proposal
   * state machine; it only calls the same `acceptProposal`/`rejectProposal` as `!proposal`.
   */
  let proposalChat = null;
  if (chatCfg.proposalChat) {
    const { ProposalChat } = require('./chat/proposalChat');
    proposalChat = new ProposalChat({ brain, log: new Logger('proposal-chat') });
    ctx.proposalChat = proposalChat;
    log.info('proposal chat answers enabled (standalone yes/no; ambiguous lines stay unanswered)');
  }

  /**
   * The only ordinary-chat intake. Commands, the dialogue trigger and the addressed channel
   * are handled earlier by ChatListener and never reach here. Server notices without a
   * `<player>` sender are not chat messages.
   */
  chatListener.onOther = (line) => {
    const match = String(line || '').match(/^\s*<([^<>]{1,32})>\s+(.+)$/);
    if (!match) return;
    const from = match[1].trim();
    const text = match[2].trim();
    if (!text || text.startsWith('!') || text.startsWith('@')) return;
    const ownName = String((cfg.agent.bot && cfg.agent.bot.username) || '').toLowerCase();
    if (ownName && from.toLowerCase() === ownName) return;
    if (ctx.proposalChat) {
      const handled = ctx.proposalChat.handle({ from, text, line });
      if (handled && handled.handled) return;
    }
    /**
     * A11's chat wake and M6's participation are alternatives, not two speakers: with
     * participation on, the participation path owns the reply decision and must not also
     * trigger a generic perception line. Weather/phase wakes are untouched.
     */
    if (ctx.perceptionWake && !ctx.chatParticipation) ctx.perceptionWake.noteChat(text, from);
    if (ctx.chatParticipation) {
      try {
        ctx.chatParticipation.handle({ from, text, line });
      } catch (err) {
        log.debug(`chat participation intake failed: ${err.message}`);
      }
    }
  };

  // --------------------------------------------------------- death handling
  const deathWatch = new DeathWatch(ctx, { log: new Logger('death') });
  ctx.deathWatch = deathWatch;

  /**
   * Proactive speech (role play): the bot speaks without being spoken to.
   *
   * Three triggers, and they come from two different mechanisms on purpose:
   *
   *  - **Finished work** is an event, and it is handled inside `LlmCore.announceFinished`,
   *    which is subscribed to the same brain events. A task result is only announced when it
   *    came from a player channel (chat / panel / llm) - the planner's own work stays silent,
   *    because nobody asked about it. That path used to live here as a plain template
   *    ("chop 搞定: ..."); it moved so the wording comes from the persona instead of a log line.
   *  - **Hungry with no food** and **badly hurt** are states rather than events, so they need a
   *    poller with per-trigger cooldowns. That is `SpeechScheduler`.
   *
   * Neither path can start work: every unprompted line goes through `LlmCore.speakUp`, which
   * drops any action the model proposes. "The bot decided to act on its own" is therefore
   * structurally impossible, not merely discouraged in the prompt.
   */
  const { SpeechScheduler } = require('./chat/speechScheduler');
  const speech = new SpeechScheduler(ctx, { log: new Logger('speech') });
  ctx.speech = speech;
  speech.start();

  /**
   * "I died and came back" is a one-shot event, so it is hooked rather than polled: DeathWatch
   * already detects the transition and exposes `onRespawn` for exactly this.
   */
  deathWatch.onRespawn = () => speech.onRespawn();

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
    if (ctx.speech) ctx.speech.stop();
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

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});

module.exports = { parseArgs, applyGoal };
