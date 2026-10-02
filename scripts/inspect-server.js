'use strict';

/**
 * `npm run inspect:server -- --host mc.example.com --port 25565`
 *
 * Characterises a Minecraft server *without* logging in:
 *
 *   1. Server List Ping  - always works, gives MOTD, player counts, protocol number,
 *                          the advertised version string and the favicon.
 *   2. Forge markers     - Forge/Fabric servers put loader hints in the version name
 *                          or the MOTD ("Forge", "Fabric", "NeoForge"), and Forge
 *                          often embeds a mod list in the ping when the client sends
 *                          a `forgeData`-aware handshake.
 *   3. Login attempt     - optional, tells us whether vanilla clients (and therefore
 *                          mineflayer) are accepted, and why not if they are not.
 *
 * Why this matters for the agent: mineflayer speaks the *vanilla* protocol. A server
 * that requires the modern FML handshake will reject it, and the honest thing to do is
 * detect that up front and say so instead of reconnect-looping forever.
 */

const net = require('net');
const dns = require('dns');
const { loadConfig, applyAddress } = require('../src/util/config');
const { Logger } = require('../src/util/logger');

const log = new Logger('server-inspect');
const args = process.argv.slice(2);
const cfg = loadConfig();

function valueOf(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const next = args[i + 1];
  return !next || next.startsWith('--') ? null : next;
}

const address = valueOf('--server') || valueOf('--address');
if (address) applyAddress(cfg, address);
if (valueOf('--host')) cfg.agent.bot.host = valueOf('--host');
if (valueOf('--port')) cfg.agent.bot.port = Number(valueOf('--port'));

const HOST = cfg.agent.bot.host;
const PORT = cfg.agent.bot.port;

/** VarInt writer/reader - the only protocol plumbing the ping needs. */
function writeVarInt(value) {
  const bytes = [];
  let v = value;
  do {
    let temp = v & 0b01111111;
    v >>>= 7;
    if (v !== 0) temp |= 0b10000000;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer, offset = 0) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buffer.length) {
    const byte = buffer[pos++];
    result |= (byte & 0b01111111) << shift;
    if ((byte & 0b10000000) === 0) return { value: result, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('VarInt too big');
  }
  return null;
}

function packet(id, payload) {
  const body = Buffer.concat([writeVarInt(id), payload]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function writeString(text) {
  const data = Buffer.from(text, 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

/**
 * Perform a Server List Ping (handshake + status request).
 * @returns {Promise<object>} the parsed status JSON
 */
function ping(host, port, protocolVersion = 763, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`ping timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once('connect', () => {
      const handshake = Buffer.concat([
        writeVarInt(0), // packet id
        writeVarInt(protocolVersion), // protocol version (-1 would probe, 763 = 1.20.1)
        writeString(host),
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        writeVarInt(1) // next state: status
      ]);
      socket.write(Buffer.concat([writeVarInt(handshake.length), handshake]));
      socket.write(packet(0, Buffer.alloc(0))); // status request
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const length = readVarInt(buffer, 0);
      if (!length) return;
      if (buffer.length < length.size + length.value) return;
      const body = buffer.subarray(length.size, length.size + length.value);
      const id = readVarInt(body, 0);
      if (!id || id.value !== 0) return;
      const strLen = readVarInt(body, id.size);
      const json = body.subarray(id.size + strLen.size, id.size + strLen.size + strLen.value).toString('utf8');
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(json));
      } catch (err) {
        reject(new Error(`could not parse status JSON: ${err.message}`));
      }
    });
  });
}

function stripFormatting(text) {
  return String(text || '').replace(/\u00a7[0-9a-fk-orx]/gi, '');
}

function flattenMotd(description) {
  if (!description) return '';
  if (typeof description === 'string') return stripFormatting(description);
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') return void parts.push(node);
    if (node.text) parts.push(node.text);
    if (Array.isArray(node.extra)) node.extra.forEach(walk);
  };
  walk(description);
  return stripFormatting(parts.join(''));
}

/** Loader hints from the version name / MOTD; Forge also embeds a mod list. */
function analyseLoader(status) {
  const versionName = status.version ? String(status.version.name) : '';
  const motd = flattenMotd(status.description);
  const haystack = `${versionName} ${motd}`;
  const hints = [];

  if (/neoforge/i.test(haystack)) hints.push('NeoForge');
  else if (/forge/i.test(haystack)) hints.push('Forge');
  if (/fabric/i.test(haystack)) hints.push('Fabric');
  if (/paper|spigot|bukkit/i.test(haystack)) hints.push('Bukkit/Spigot/Paper');
  if (/purpur/i.test(haystack)) hints.push('Purpur');

  // Forge appends its own marker to the version string, e.g. "1.20.1-forge-47.4.10".
  const forgeVersion = (haystack.match(/forge[-\s]?(\d+\.\d+\.\d+(?:\.\d+)?)/i) || [])[1] || null;
  const mods = Array.isArray(status.forgeData && status.forgeData.mods)
    ? status.forgeData.mods.map((m) => `${m.modId || m.modid || '?'}@${m.modmarker || m.version || '?'}`)
    : [];

  return { hints, forgeVersion, mods, motd, versionName, protocol: status.version ? status.version.protocol : null };
}

/** Which minecraft-data versions cover this protocol number? */
function protocolNote(protocol) {
  const minecraftData = require('minecraft-data');
  const versions = minecraftData.versions.pc.filter((v) => v.version === protocol);
  if (!versions.length) return `protocol ${protocol} is not in minecraft-data (unknown modded protocol?)`;
  return `protocol ${protocol} maps to ${versions.map((v) => v.minecraftVersion).join(', ')}`;
}

async function resolveDns(host) {
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    return addrs.map((a) => `${a.address} (IPv${a.family})`);
  } catch (err) {
    return [`resolution failed: ${err.code || err.message}`];
  }
}

async function tryLogin() {
  // A minimal login attempt is enough: if the server has mods that require the Forge
  // client, it disconnects during login with a very specific reason.
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let controller;
    try {
      const { BotController } = require('../src/core/bot');
      controller = new BotController(cfg, new Logger('login-probe', { level: 'warn' }));
    } catch (err) {
      return done({ ok: false, reason: `could not build controller: ${err.message}` });
    }

    const timer = setTimeout(() => {
      controller.shutdown();
      done({ ok: false, reason: 'timeout after 20s' });
    }, 20000);

    controller.on('spawn', () => {
      clearTimeout(timer);
      const snapshot = controller.snapshot();
      controller.shutdown();
      done({ ok: true, snapshot });
    });
    controller.on('kicked', (reason) => {
      clearTimeout(timer);
      controller.shutdown();
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      done({ ok: false, reason: text, kicked: true });
    });
    controller.on('socketError', (err) => {
      clearTimeout(timer);
      controller.shutdown();
      done({ ok: false, reason: err.message });
    });
    try {
      controller.connect();
    } catch (err) {
      clearTimeout(timer);
      done({ ok: false, reason: err.message });
    }
  });
}

(async () => {
  const out = (s = '') => process.stdout.write(`${s}\n`);
  out('minecraft-survival-agent - server inspector');
  out(`target: ${HOST}:${PORT}`);
  out('');

  const addresses = await resolveDns(HOST);
  out('DNS');
  for (const a of addresses) out(`  ${a}`);

  let status = null;
  out('');
  out('Server list ping');
  try {
    status = await ping(HOST, PORT, 763);
    out('  OK');
  } catch (err) {
    out(`  FAILED: ${err.message}`);
  }

  if (status) {
    const info = analyseLoader(status);
    out(`  version string   ${info.versionName}  (protocol ${info.protocol})`);
    out(`  protocol note    ${protocolNote(info.protocol)}`);
    out(`  MOTD             ${info.motd.replace(/\n/g, ' / ')}`);
    if (status.players) {
      out(`  players          ${status.players.online}/${status.players.max}`);
      const sample = (status.players.sample || []).slice(0, 8).map((p) => p.name);
      if (sample.length) out(`  online now       ${sample.join(', ')}${status.players.online > sample.length ? ', ...' : ''}`);
    }
    out(`  favicon          ${status.favicon ? 'present' : 'none'}`);
    out(`  loader hints     ${info.hints.length ? info.hints.join(', ') : '(none in the ping)'}`);
    if (info.forgeVersion) out(`  forge version    ${info.forgeVersion}`);
    if (info.mods.length) {
      out(`  mods advertised  ${info.mods.length}`);
      for (const m of info.mods.slice(0, 40)) out(`    - ${m}`);
      if (info.mods.length > 40) out(`    ... and ${info.mods.length - 40} more`);
    } else {
      out('  mods advertised  (none - Forge only lists mods when the client speaks forge)');
    }
  }

  const wantLogin = !args.includes('--no-login');
  let login = null;
  if (wantLogin) {
    out('');
    out(`Login attempt (vanilla protocol, username "${cfg.agent.bot.username}")`);
    login = await tryLogin();
    if (login.ok) {
      out('  ACCEPTED - the server speaks plain vanilla, mineflayer can play here');
      out(`  spawned at ${JSON.stringify(login.snapshot.position)} in ${login.snapshot.dimension}`);
    } else {
      out(`  REJECTED - ${login.reason}`);
      if (/require Forge|FML|forge/i.test(login.reason)) {
        out('');
        out('  DIAGNOSIS: this server demands the Forge/FML client handshake.');
        out('  mineflayer speaks the vanilla protocol only, so it cannot join as-is.');
        out('  Options:');
        out('    a) ask the operator for a vanilla-compatible endpoint, or set');
        out('       "removeErroringEntities"/"removeErroringBlockEntities" style');
        out('       compatibility (Forge servers can allow vanilla clients only when no');
        out('       mod marks itself client-required)');
        out('    b) run your own server (npm start, or --loader forge) and play there');
        out('    c) join through a real Forge client and let the bot act locally');
      }
    }
  }

  out('');
  const verdict = login && login.ok ? 'PLAYABLE by mineflayer' : 'NOT directly playable by mineflayer';
  out(`verdict: ${verdict}`);
  process.exitCode = login && login.ok ? 0 : 1;
})().catch((err) => {
  process.stdout.write(`inspector crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
