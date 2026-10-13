'use strict';

/**
 * Config loader: reads config/*.json, deep-merges with defaults, resolves ${ENV} style
 * overrides and paths relative to the project root.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(ROOT, 'config');

const DEFAULTS = {
  agent: {
    /**
     * How the agent attaches to a world.
     *   mineflayer - headless vanilla protocol (vanilla/Paper/Spigot/pure-server Fabric)
     *   clientmod  - a real Forge client + control mod (Forge/NeoForge servers)
     *   mock       - scripted world, for tests
     */
    body: { kind: 'mineflayer' },
    bot: {
      username: 'agent',
      auth: 'offline',
      host: '127.0.0.1',
      port: 25565,
      version: '1.20.1',
      viewDistance: 'far',
      proxy: null,
      profilesFolder: null,
      microsoft: { email: null }
    },
    behaviour: {
      autoEat: true,
      autoCloseScreens: true,
      chatScreenWaitMs: 20000,
      autoFight: true,
      autoArmor: true,
      autoTool: true,
      /** Retreat trigger: at or below this health the reflex backs away (COMBAT-PLAN §①). */
      fleeHealthThreshold: 8,
      /** Engage trigger: wounded below this, the reflex starts the fight (COMBAT-PLAN §②). */
      engageHealthThreshold: 16,
      eatFoodThreshold: 16,
      idleThinkIntervalMs: 2500,
      chatPrefix: '!',
      publicServerMode: false,
      respondToChat: true,
      maxChatPerMinute: 6
    },
    /**
     * LLM mining recovery (docs/MINING-LLM-PLAN.md §5.8). Disabled until the operator
     * explicitly turns it on after the acceptance run; while disabled the triggers are
     * still recorded and the macro fails honestly.
     */
    miningRecovery: {
      enabled: false,
      historySize: 12,
      sameFailureLimit: 2,
      falseArrivalLimit: 3,
      noProgressActiveMs: 30000,
      maxActionsPerBatch: 3,
      maxCellsPerDig: 3,
      maxCallsPerSession: 12,
      maxSessionMs: 180000,
      maxSessionTokens: 32000,
      maxPrimitiveActions: 32,
      maxPlacedBlocks: 8,
      modelTimeoutMs: 30000,
      maxOutputTokens: 4096,
      maxInvalidRepairs: 1,
      maxRepeatedProposals: 2
    },
    /** Shared pickup loop (docs/MINING-COLLECTION-PLAN.md §七). */
    miningCollection: {
      dropSpawnWaitMs: 2000,
      pickupConfirmMs: 2500,
      maxGoalCollectionMs: 45000,
      maxLocalStands: 3,
      maxLocalEdits: 6,
      maxLocalPillarSteps: 2,
      standRadiusXZ: 2,
      standRangeY: 3,
      unresolvedPolicy: 'stop'
    },
    survival: {
      targetWood: 16,
      shelterAtNight: true,
      torchLightLevel: 4,
      maxDigDistance: 4,
      mineUnknownModBlocks: false,
      avoidClaimedChunks: true,
      /**
       * May the *planner* fell trees on its own? Off means it still chops when told to
       * (`!chop`), but will not go looking for trees while idle - which is what you want on a
       * shared server where the trees are scenery rather than a resource.
       */
      allowWoodChopping: true
    },
    /**
     * The control mod that drives a real Forge client (P0-PLAN §7.1). Host/port must match
     * the mod's HTTP server; nothing here needs a Java rebuild.
     */
    clientMod: {
      host: '127.0.0.1',
      port: 8899,
      timeoutMs: 5000,
      directRange: 3
    },
    /**
     * Pathfinding (P0-PLAN §7.1). These are consumed by src/pathfinding/*; a value that
     * is never read is worse than no option at all, so each one has a reader.
     */
    pathfinding: {
      maxPathLength: 200,
      replanEvery: 20,
      nodeTimeoutMs: 3000,
      tickTimeoutMs: 2500,
      allowSwim: true,
      allowDig: false,
      waypointRange: 1.0,
      stuckThreshold: 2,
      /**
       * How many failed jump/step-up legs in one trip before the walker concludes that
       * jumping is not getting us anywhere (see WaypointWalker). 2 is deliberately small:
       * the client jumps in place against a wall, so every extra attempt costs seconds of
       * a visibly silly animation.
       */
      jumpStreakLimit: 2,
      /** How many "try a different direction" steps a blocked route gets before giving up. */
      maxSidesteps: 2,
      trace: 'runtime/path-trace.jsonl'
    },
    /**
     * Staying away from what players built (P0 safety, not optional on a public server).
     * Consumed by the pathfinder (routes never cross built blocks) and the harvest tasks
     * (a chop targets a tree, never a log wall). See src/world/safety.js.
     */
    safety: {
      avoidManMade: true,
      requireNaturalTrees: true,
      /**
       * A trunk with no canopy is refused as a tree. Turn this off only on a server whose
       * trees genuinely have no leaves (a custom pack), because with it off a player's log
       * pillar standing on grass is indistinguishable from a tree.
       */
      requireLeaves: true,
      strictMining: false
    },
    /** Chat input/output policy (P0-PLAN §7.1). */
    chat: {
      prefix: '!',
      dialogueTrigger: null,
      pollIntervalMs: 700,
      ignoreOtherChat: true,
      replyInGame: true,
      maxChars: 100,
      minReplyGapMs: 1200
    },
    /**
     * Proactive speech - the bot speaking when NOT spoken to (role-play requirement).
     *
     * Three triggers, matching the operator's list: a finished task, being hungry with no
     * food, and being in danger. Each has its own cooldown because the states persist: a
     * starving bot is hungry every tick, and without a cooldown the chat would be unusable.
     *
     * `fireOnRespawn` is separate on purpose - "I died" is a one-shot event, not a state.
     */
    proactive: {
      enabled: true,
      intervalMs: 1000,
      triggers: {
        taskDone: { enabled: true, cooldownMs: 30000, alsoOnFailure: true },
        hungry: { enabled: true, cooldownMs: 60000, foodThreshold: 6 },
        lowHealth: { enabled: true, cooldownMs: 45000, healthThreshold: 6 },
        fireOnRespawn: { enabled: true, cooldownMs: 15000 }
      }
    },
    /**
     * Death handling (P0-PLAN §7.1).
     *
     * There is no `autoResume` key: recovering from a death is always an explicit human action
     * (panel resume button, or `POST /command {"command":"resume"}`). Respawning must never
     * restart work on its own, so the option is absent rather than switched off - a flag that
     * can be enabled is a flag that eventually is.
     */
    death: {
      detectIntervalMs: 500,
      alertConsole: true,
      alertPanel: true,
      alertStateFile: true
    },
    /** Control panel (P0-PLAN §7.1). */
    web: { bind: '127.0.0.1', port: null },
    logging: { level: 'info', stateFile: 'runtime/agent-state.json' }
  },
  /**
   * The LLM layer (P0-PLAN §7.2). Kept in its own file and merged here so a missing
   * `config/llm.json` simply means "no natural language", never a crash.
   */
  llm: {
    enabled: true,
    provider: 'openai-compatible',
    baseUrl: null,
    apiKey: null,
    model: 'deepseek-chat',
    timeouts: { intentMs: 8000, followUpMs: 8000 },
    limits: { maxTurnsPerRequest: 2, maxToolCallsPerTurn: 4, dailyTokenBudget: 300000, concurrentTurns: 1 },
    /**
     * Native tool calling (P0-PLAN §5.3). Off by default because it needs a provider that
     * supports it; the intent-JSON path is the verified one and works everywhere.
     */
    toolCalling: false,
    persona: {
      name: 'agent',
      style: null,
      honesty: '只说自己观察到的；不认识的方块要承认；不承诺做不到的事'
    },
    history: { perPlayer: 8, global: 30 },
    trace: { enabled: true, file: 'runtime/llm-trace.jsonl' }
  },
  server: {
    mcVersion: '1.20.1',
    // 'vanilla' (Mojang server.jar) or 'forge' (Forge 1.20.1 dedicated server).
    loader: 'vanilla',
    forgeVersion: '1.20.1-47.4.10',
    port: 25565,
    onlineMode: false,
    difficulty: 'normal',
    levelName: 'agent-world',
    levelSeed: 'minecraft-agent',
    viewDistance: 10,
    simulationDistance: 8,
    allowCheats: true,
    installBridgeMod: true,
    bridgePort: 8765
  },
  pcl: { pclExe: null, minecraftDir: null, clientVersion: null, javaCandidates: [] }
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (key.startsWith('_')) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Cannot parse ${file}: ${err.message}`);
  }
}

const SERVER_LOADERS = ['vanilla', 'forge'];

/**
 * Normalise `server.loader`. Missing/empty means 'vanilla' so configs written before
 * Forge support keep behaving exactly as they used to. Throws on an unknown value.
 */
function normalizeLoader(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (!v) return 'vanilla';
  if (!SERVER_LOADERS.includes(v)) {
    throw new Error(`unknown server.loader "${value}" (expected one of: ${SERVER_LOADERS.join(', ')})`);
  }
  return v;
}

function loadConfig(overrides = {}) {
  const files = {
    agent: path.join(CONFIG_DIR, 'agent.json'),
    server: path.join(CONFIG_DIR, 'server.json'),
    pcl: path.join(CONFIG_DIR, 'pcl.json'),
    llm: path.join(CONFIG_DIR, 'llm.json')
  };

  const merged = {};
  for (const [key, file] of Object.entries(files)) {
    merged[key] = deepMerge(DEFAULTS[key], readJsonIfExists(file));
  }

  // Named server profiles (config/servers.json) let one checkout target several
  // servers: local lab server, a friend's world, a public multiplayer server.
  const profileName = overrides.profile || process.env.MC_PROFILE;
  if (profileName) {
    const profiles = readJsonIfExists(path.join(CONFIG_DIR, 'servers.json')).profiles || {};
    const profile = profiles[profileName];
    if (!profile) {
      throw new Error(`unknown server profile "${profileName}" (available: ${Object.keys(profiles).join(', ') || 'none'})`);
    }
    merged.agent = deepMerge(merged.agent, {
      bot: {
        host: profile.host,
        port: profile.port,
        auth: profile.auth,
        username: profile.username,
        version: profile.version,
        proxy: profile.proxy
      },
      behaviour: {
        publicServerMode: profile.publicServerMode
      }
    });
    merged.activeProfile = profileName;
  }

  const cfg = deepMerge(merged, overrides);

  try {
    cfg.server.loader = normalizeLoader(cfg.server.loader);
  } catch (err) {
    process.stderr.write(`[config] ${err.message} - falling back to vanilla\n`);
    cfg.server.loader = 'vanilla';
  }

  // Environment overrides keep CI / one-off runs scriptable.
  if (process.env.MC_HOST) cfg.agent.bot.host = process.env.MC_HOST;
  if (process.env.MC_PORT) cfg.agent.bot.port = Number(process.env.MC_PORT);
  if (process.env.MC_USERNAME) cfg.agent.bot.username = process.env.MC_USERNAME;
  if (process.env.MC_VERSION) cfg.agent.bot.version = process.env.MC_VERSION;
  if (process.env.MC_AUTH) cfg.agent.bot.auth = process.env.MC_AUTH;
  if (process.env.MC_PROXY) cfg.agent.bot.proxy = process.env.MC_PROXY;
  if (process.env.MC_ADDRESS) applyAddress(cfg, process.env.MC_ADDRESS);

  cfg.root = ROOT;
  cfg.paths = {
    root: ROOT,
    runtime: path.join(ROOT, 'runtime'),
    server: path.join(ROOT, 'runtime', 'server'),
    logs: path.join(ROOT, 'runtime', 'logs'),
    modBridge: path.join(ROOT, 'mod-bridge')
  };
  return cfg;
}

/**
 * Accept an "host:port" or "host" address and write it into cfg.agent.bot.
 * Used by MC_ADDRESS and the --server flag so the same checkout can be pointed at a
 * public multiplayer server without editing JSON.
 *
 * A bare host keeps whatever port the config already uses, so `--server example.org`
 * still targets the port you configured rather than silently forcing 25565.
 *
 * @param {object} cfg
 * @param {string} address
 * @param {number} [defaultPort] only used when the config has no port yet
 */
function applyAddress(cfg, address, defaultPort) {
  if (!address) return cfg;
  const text = String(address).trim();
  if (!text) return cfg;
  if (!cfg.agent.bot.port) cfg.agent.bot.port = defaultPort || 25565;
  // IPv6 literals in brackets, otherwise split on the last colon only.
  const m = text.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (m) {
    cfg.agent.bot.host = m[1];
    if (m[2]) cfg.agent.bot.port = Number(m[2]);
    return cfg;
  }
  const idx = text.lastIndexOf(':');
  if (idx > 0 && /^\d+$/.test(text.slice(idx + 1))) {
    cfg.agent.bot.host = text.slice(0, idx);
    cfg.agent.bot.port = Number(text.slice(idx + 1));
  } else {
    cfg.agent.bot.host = text;
  }
  return cfg;
}

module.exports = { loadConfig, applyAddress, ROOT, CONFIG_DIR, deepMerge, normalizeLoader, SERVER_LOADERS };
