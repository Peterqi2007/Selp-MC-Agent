'use strict';

/**
 * Agent-side client for the optional `agent-bridge` Fabric mod.
 *
 * The mod (see `mod-bridge/README.md`) runs inside a Fabric 1.20.1 dedicated server and exposes a
 * localhost HTTP API with *server-authoritative* state: /health, /state, /players, POST /command.
 *
 * Everything here degrades gracefully: the mod is optional, so on a vanilla (or Forge) server every
 * call fails with a clear `bridge-unreachable` error and the CLI exits 0 instead of dumping a stack
 * trace. Connection refused is the expected normal case, not a bug.
 *
 * Zero dependencies — plain CommonJS plus the global `fetch` (Node >= 18).
 *
 * CLI:
 *   node scripts/bridge-client.js health
 *   node scripts/bridge-client.js state
 *   node scripts/bridge-client.js players
 *   node scripts/bridge-client.js command "time set day"
 *
 * Library:
 *   const bridge = require('./scripts/bridge-client');
 *   await bridge.getHealth();          // -> parsed JSON
 *   await bridge.getState();           // -> parsed JSON
 *   await bridge.getPlayers();         // -> parsed JSON
 *   await bridge.sendCommand('time set day');
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8765,
  botPlayerName: 'AgentSteve',
  timeoutMs: 3000,
};

/** Where the agent-side status API of the Node bot itself lives (for manual comparison). */
const AGENT_STATUS_URL = 'http://127.0.0.1:8766/status';

/** Error code used when nothing is listening on the bridge port (the normal "mod not installed" case). */
const UNREACHABLE = 'bridge-unreachable';

class BridgeError extends Error {
  constructor(message, code, cause) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** True for the "mod is not installed / not running" family of failures. */
function isUnreachable(err) {
  return Boolean(err) && err.code === UNREACHABLE;
}

/**
 * Read `config/server.json` for `bridgePort` (and an optional `bridgeHost`).
 * Never throws: a missing or broken config just means the defaults are used.
 */
function readServerConfig() {
  const file = path.join(ROOT, 'config', 'server.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return { file, config: parsed && typeof parsed === 'object' ? parsed : {} };
  } catch (err) {
    return { file, config: {}, error: err };
  }
}

/** Resolve `{ host, port, timeoutMs, botPlayerName, source }` for the bridge. */
function resolveTarget(options = {}) {
  const { file, config } = readServerConfig();

  const cfgPort = Number(config.bridgePort);
  const port = Number(options.port) || (Number.isFinite(cfgPort) && cfgPort > 0 ? cfgPort : DEFAULTS.port);

  const host = options.host || config.bridgeHost || DEFAULTS.host;
  const botPlayerName = options.botPlayerName || config.botPlayerName || DEFAULTS.botPlayerName;
  const timeoutMs = Number(options.timeoutMs) || DEFAULTS.timeoutMs;

  return {
    host,
    port,
    timeoutMs,
    botPlayerName,
    baseUrl: `http://${host}:${port}`,
    source: Number.isFinite(cfgPort) && cfgPort > 0 ? `${file} (bridgePort)` : `${file} missing bridgePort -> default`,
  };
}

/** One-line human description of what we are about to talk to. */
function describeTarget(options = {}) {
  const t = resolveTarget(options);
  return `${t.baseUrl}  [port from ${t.source}]`;
}

function unreachableMessage(target, err) {
  const reason = (err && (err.cause?.code || err.cause?.message || err.message)) || 'unknown error';
  return [
    `[bridge] the agent-bridge mod is not installed (${target.baseUrl})`,
    `[bridge] reason: connection refused / unreachable (${reason})`,
    '[bridge] this is expected on a vanilla or Forge server - the agent works without it.',
    '[bridge] to enable server-authoritative state, install the Fabric mod: see mod-bridge/README.md',
    '[bridge] if the mod IS installed, make sure "port" in the server\'s config/agent-bridge.json',
    `[bridge] and "bridgePort" in the agent's config/server.json agree (currently ${target.port}).`,
  ].join('\n');
}

async function request(method, route, body, options = {}) {
  const target = resolveTarget(options);
  const url = `${target.baseUrl}${route}`;

  const headers = { accept: 'application/json' };
  if (options.token) headers['X-Agent-Token'] = options.token;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(target.timeoutMs),
    });
  } catch (err) {
    // fetch() throws a TypeError with a `cause` for ECONNREFUSED / ENOTFOUND / timeout.
    throw new BridgeError(unreachableMessage(target, err), UNREACHABLE, err);
  }

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
    const detail = (json && (json.error || json.message)) || text.slice(0, 200) || res.statusText;
    throw new BridgeError(
      `[bridge] ${method} ${route} -> HTTP ${res.status}: ${detail}`,
      res.status === 403 || res.status === 401 || res.status === 400 ? 'bridge-rejected' : 'bridge-error',
    );
  }

  if (json === null) {
    throw new BridgeError(`[bridge] ${method} ${route} -> HTTP ${res.status} but the body was not JSON`, 'bridge-error');
  }

  return json;
}

/** `GET /health` — liveness only; never touches the server thread. */
function getHealth(options = {}) {
  return request('GET', '/health', undefined, options);
}

/** `GET /state` — world state, TPS estimate and one object per online player. */
function getState(options = {}) {
  return request('GET', '/state', undefined, options);
}

/** `GET /players` — online players with positions and health. */
function getPlayers(options = {}) {
  return request('GET', '/players', undefined, options);
}

/**
 * `POST /command` — run a whitelisted server command (`time`, `weather`, `give`, `tp`, `gamemode`,
 * `say`). Runs as `botPlayerName` when that player is online.
 */
function sendCommand(cmd, options = {}) {
  if (typeof cmd !== 'string' || !cmd.trim()) {
    return Promise.reject(new BridgeError('[bridge] sendCommand(cmd) needs a non-empty string', 'bridge-rejected'));
  }
  return request('POST', '/command', { command: cmd.trim() }, options);
}

// ---------------------------------------------------------------------------------------------
// Presentation helpers (used by the CLI; handy from the agent too)
// ---------------------------------------------------------------------------------------------

const fmtNum = (n, digits = 1) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : String(n));

function findBotPlayer(state, botPlayerName) {
  const players = Array.isArray(state?.players) ? state.players : [];
  return players.find((p) => p.name === botPlayerName) || players[0] || null;
}

function printHealth(health, target) {
  const out = [];
  out.push(`bridge   ${target.baseUrl}`);
  out.push(`ok       ${health.ok === true ? 'yes' : 'NO'}`);
  out.push(`mod      ${health.mod || '(unknown)'} ${health.version ? `v${health.version}` : ''}`.trimEnd());
  return out.join('\n');
}

function printState(state, botPlayerName) {
  const out = [];
  out.push(`world    ${state.minecraftVersion || '?'}  difficulty=${state.difficulty ?? '?'}  tps=${fmtNum(state.tps)}`);
  const time = state.isDay === true ? 'day' : state.isDay === false ? 'night' : '?';
  let weather = 'clear';
  if (state.thundering) weather = 'thunder';
  else if (state.raining) weather = 'rain';
  out.push(`time     tick=${state.tick ?? '?'}  dayTime=${state.dayTime ?? '?'}  (${time})  weather=${weather}`);
  out.push(`players  ${state.playerCount ?? '?'}/${state.maxPlayers ?? '?'}  online=[${(state.onlinePlayerNames || []).join(', ')}]`);
  out.push(`bridge   running=${state.bridge?.running === true}  allowCommands=${state.bridge?.allowCommands === true}`);

  // Server-authoritative view of the bot, for manual comparison against the agent's own /status.
  const bot = findBotPlayer(state, botPlayerName);
  out.push('');
  if (!bot) {
    out.push(`bot      '${botPlayerName}' is NOT online (no server-authoritative position available)`);
  } else {
    const p = bot.position || {};
    const b = bot.blockPosition || {};
    out.push(`bot      ${bot.name}  (server-authoritative)`);
    out.push(`  position   x=${fmtNum(p.x, 2)} y=${fmtNum(p.y, 2)} z=${fmtNum(p.z, 2)}   block=${b.x ?? '?'},${b.y ?? '?'},${b.z ?? '?'}`);
    out.push(`  health     ${bot.health ?? '?'}/${bot.maxHealth ?? '?'}  food=${bot.food ?? '?'}  gamemode=${bot.gamemode ?? '?'}`);
    out.push(`  dimension  ${bot.dimension ?? '?'}  ping=${bot.pingMs ?? '?'}ms  onGround=${bot.onGround ?? '?'}`);
    const inv = bot.inventory && typeof bot.inventory === 'object' ? Object.keys(bot.inventory).length : 0;
    out.push(`  inventory  ${inv} distinct item type(s)  held=${bot.heldItem || '(empty)'}`);
  }
  out.push('');
  out.push(`compare  with the agent's own view: ${AGENT_STATUS_URL}`);
  return out.join('\n');
}

function printPlayers(payload) {
  const players = Array.isArray(payload?.players) ? payload.players : [];
  const out = [`players  ${payload?.count ?? players.length}`];
  for (const p of players) {
    const pos = p.position || {};
    out.push(
      `  ${String(p.name).padEnd(16)} ${fmtNum(pos.x, 1)}, ${fmtNum(pos.y, 1)}, ${fmtNum(pos.z, 1)}` +
        `  hp=${p.health ?? '?'}/${p.maxHealth ?? '?'} food=${p.food ?? '?'} ${p.gamemode ?? ''}`.trimEnd(),
    );
  }
  if (!players.length) out.push('  (nobody online)');
  return out.join('\n');
}

function printCommandResult(result) {
  const out = [`ok       ${result.ok === true ? 'yes' : 'NO'}`];
  if (result.command) out.push(`command  ${result.command}`);
  if (result.executedAs) out.push(`as       ${result.executedAs}`);
  if (result.result !== undefined) out.push(`result   ${result.result}`);
  if (result.output) out.push(`output   ${result.output}`);
  if (result.error) out.push(`error    ${result.error}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function main(argv) {
  const [action, ...rest] = argv;
  const target = resolveTarget();

  const usage = [
    'usage: node scripts/bridge-client.js <health|state|players|command> ["<cmd>"]',
    '',
    '  health          GET /health   (is the bridge mod listening?)',
    '  state           GET /state    (world + players + server-authoritative bot position/health)',
    '  players         GET /players  (online players)',
    '  command "<cmd>" POST /command (whitelisted: time, weather, give, tp, gamemode, say)',
    '',
    `target: ${target.baseUrl}`,
  ].join('\n');

  if (!action || action === '-h' || action === '--help' || action === 'help') {
    process.stdout.write(`${usage}\n`);
    return 0;
  }

  try {
    if (action === 'health') {
      process.stdout.write(`${printHealth(await getHealth(), target)}\n`);
      return 0;
    }
    if (action === 'state') {
      process.stdout.write(`${printState(await getState(), target.botPlayerName)}\n`);
      return 0;
    }
    if (action === 'players') {
      process.stdout.write(`${printPlayers(await getPlayers())}\n`);
      return 0;
    }
    if (action === 'command') {
      const cmd = rest.join(' ').trim();
      if (!cmd) {
        process.stderr.write('error: `command` needs a command string, e.g. command "time set day"\n');
        return 2;
      }
      process.stdout.write(`${printCommandResult(await sendCommand(cmd))}\n`);
      return 0;
    }

    process.stderr.write(`error: unknown action '${action}'\n\n${usage}\n`);
    return 2;
  } catch (err) {
    if (isUnreachable(err)) {
      // Expected normal case on a server without the mod: explain, do not fail.
      process.stdout.write(`${err.message}\n`);
      return 0;
    }
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`[bridge] unexpected failure: ${err && err.stack ? err.stack : err}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  getHealth,
  getState,
  getPlayers,
  sendCommand,
  // extras, useful for callers that need to know where we are pointing
  resolveTarget,
  describeTarget,
  isUnreachable,
  BridgeError,
  DEFAULTS,
  AGENT_STATUS_URL,
};
