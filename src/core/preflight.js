'use strict';

/**
 * Preflight: know whether a server will accept this bot *before* spamming logins.
 *
 * Two failure modes cost a lot of time otherwise:
 *   - the server requires the Forge/FML client handshake (mineflayer speaks vanilla
 *     only), producing an endless kick/reconnect cycle
 *   - the server is online-mode and the bot is configured for offline auth
 *
 * This module answers both from a single Server List Ping (no login), so the agent can
 * refuse to connect with a clear explanation instead of looping.
 */

const net = require('net');
const { Logger } = require('../util/logger');

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
    if (shift > 35) return null;
  }
  return null;
}

function writeString(text) {
  const data = Buffer.from(text, 'utf8');
  return Buffer.concat([writeVarInt(data.length), data]);
}

/**
 * Server List Ping. Costs no login slot and cannot get us banned.
 * @returns {Promise<{ok:boolean, status?:object, error?:string}>}
 */
function ping(host, port, protocolVersion = 763, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `ping timed out after ${timeoutMs}ms` }), timeoutMs);

    socket.once('error', (err) => finish({ ok: false, error: err.code || err.message }));
    socket.once('connect', () => {
      try {
        const handshake = Buffer.concat([
          writeVarInt(0),
          writeVarInt(protocolVersion),
          writeString(host),
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          writeVarInt(1)
        ]);
        socket.write(Buffer.concat([writeVarInt(handshake.length), handshake]));
        const body = Buffer.concat([writeVarInt(0), Buffer.alloc(0)]);
        socket.write(Buffer.concat([writeVarInt(body.length), body]));
      } catch (err) {
        finish({ ok: false, error: err.message });
      }
    });

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const length = readVarInt(buffer, 0);
      if (!length || buffer.length < length.size + length.value) return;
      const body = buffer.subarray(length.size, length.size + length.value);
      const id = readVarInt(body, 0);
      if (!id || id.value !== 0) return;
      const strLen = readVarInt(body, id.size);
      if (!strLen) return;
      const json = body.subarray(id.size + strLen.size, id.size + strLen.size + strLen.value).toString('utf8');
      try {
        finish({ ok: true, status: JSON.parse(json) });
      } catch (err) {
        finish({ ok: false, error: `bad status JSON: ${err.message}` });
      }
    });
  });
}

function flattenMotd(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  const parts = [];
  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') return void parts.push(node);
    if (node.text) parts.push(node.text);
    if (Array.isArray(node.extra)) node.extra.forEach(walk);
  };
  walk(description);
  return parts.join('');
}

/**
 * Probe a target and return a decision.
 * @param {object} cfg loaded config
 * @param {object} [options] { protocol, log }
 * @returns {Promise<{connect:boolean, reason:string, advice:string[], details:object}>}
 */
async function preflight(cfg, options = {}) {
  const log = options.log || new Logger('preflight');
  const b = cfg.agent.bot;
  const protocol = options.protocol || 763;
  const local = ['127.0.0.1', 'localhost', '::1'].includes(String(b.host).toLowerCase());

  const advice = [];
  const details = { host: b.host, port: b.port, local, auth: (b.auth || 'offline').toLowerCase(), proxy: b.proxy || null };

  const result = await ping(b.host, b.port, protocol);
  if (!result.ok) {
    return {
      connect: false,
      reason: `server unreachable (${result.error})`,
      advice: [
        'check the address and port, and that you have network access',
        'if the server is behind a proxy requirement, set bot.proxy (socks5:// or http://)'
      ],
      details
    };
  }

  const status = result.status;
  details.version = status.version || null;
  details.players = status.players ? { online: status.players.online, max: status.players.max } : null;
  details.motd = flattenMotd(status.description).replace(/\u00a7[0-9a-fk-orx]/gi, '');

  const haystack = `${details.version ? details.version.name : ''} ${details.motd}`;
  details.loaderHints = [];
  if (/neoforge/i.test(haystack)) details.loaderHints.push('NeoForge');
  else if (/forge/i.test(haystack)) details.loaderHints.push('Forge');
  if (/fabric/i.test(haystack)) details.loaderHints.push('Fabric');
  if (/paper|spigot|bukkit/i.test(haystack)) details.loaderHints.push('Paper/Spigot');

  if (details.version && details.version.protocol && details.version.protocol !== protocol) {
    advice.push(
      `server protocol is ${details.version.protocol} but the bot is configured for ${protocol} - ` +
        'set bot.version to match (or check that the server allows your client version)'
    );
  }

  if (!local) {
    advice.push('remote server: if it is online-mode you need bot.auth="microsoft" plus a real account');
    if (details.players && details.players.online >= details.players.max) {
      return { connect: false, reason: `server is full (${details.players.online}/${details.players.max})`, advice, details };
    }
    if (details.players && details.players.online > 0) {
      advice.push(`be considerate: ${details.players.online} player(s) online right now`);
    }
  }

  // A Forge server that marks any mod as client-required will refuse vanilla clients.
  // The ping cannot tell us that for sure (Forge only lists mods when the client speaks
  // FML), so we report what we know and let the login attempt confirm it.
  if (details.loaderHints.includes('Forge') || details.loaderHints.includes('NeoForge')) {
    advice.push('modded server advertised: mineflayer may be rejected with "requires Forge on the client"');
  }

  return {
    connect: true,
    reason: 'server reachable',
    advice,
    details
  };
}

module.exports = { preflight, ping, flattenMotd };
