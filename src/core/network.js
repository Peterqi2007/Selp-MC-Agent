'use strict';

/**
 * Outbound connection configuration for playing on *external* Minecraft servers.
 *
 * When the agent runs on a home machine and joins a remote server, two things
 * usually need adjusting that a localhost-only bot never cares about:
 *
 *   1. a proxy (many players route game traffic through SOCKS5 or HTTP CONNECT)
 *   2. real authentication (public servers are `online-mode=true`, so an offline
 *      username is rejected with "Failed to verify username")
 *
 * This module keeps both concerns in one place and turns config into the exact
 * shapes mineflayer/minecraft-protocol expect.
 */

const { SocksClient } = require('socks');
const { Logger } = require('../util/logger');

/**
 * Parse a proxy string into a normalised descriptor.
 * Accepted forms:
 *   socks5://user:pass@host:1080
 *   socks4://host:1080
 *   http://host:8080            (CONNECT tunnel)
 *   host:1080                   (defaults to socks5)
 *
 * @returns {{protocol:string,host:string,port:number,userId?:string,password?:string,raw:string}|null}
 */
function parseProxy(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `socks5://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`invalid proxy url: ${raw}`);
  }

  const protocol = url.protocol.replace(':', '').toLowerCase();
  const allowed = ['socks5', 'socks5h', 'socks4', 'socks4a', 'http', 'https'];
  if (!allowed.includes(protocol)) {
    throw new Error(`unsupported proxy protocol "${protocol}" (use socks5, socks4 or http)`);
  }
  if (!url.hostname) throw new Error(`proxy url has no host: ${raw}`);

  return {
    protocol,
    host: url.hostname,
    port: Number(url.port || (protocol.startsWith('socks') ? 1080 : 8080)),
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    raw
  };
}

/** True when the proxy speaks SOCKS rather than HTTP CONNECT. */
function isSocks(proxy) {
  return !!proxy && proxy.protocol.startsWith('socks');
}

/**
 * Build a `net.Socket` connected to `host:port` through the configured proxy.
 * This is the shape minecraft-protocol expects for `options.agent` when it is a
 * function (it must return a socket-like object).
 */
function createProxyAgent(proxy, log) {
  if (!proxy) return undefined;
  return function agent(_cb) {
    // minecraft-protocol accepts a function returning a socket directly.
    return createProxySocket(proxy, this && this.host ? this.host : null, this && this.port ? this.port : null, log);
  };
}

/**
 * Open a single tunnelled socket to the destination.
 * @returns {Promise<import('net').Socket>}
 */
async function createProxySocket(proxy, host, port, log = new Logger('proxy')) {
  if (isSocks(proxy)) {
    const { socket } = await SocksClient.createConnection({
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: proxy.protocol.startsWith('socks4') ? 4 : 5,
        userId: proxy.userId,
        password: proxy.password
      },
      command: 'connect',
      destination: { host, port }
    });
    log.debug(`socks tunnel established to ${host}:${port} via ${proxy.host}:${proxy.port}`);
    return socket;
  }
  return httpConnect(proxy, host, port, log);
}

/** Minimal HTTP CONNECT tunnel (no extra dependency needed). */
function httpConnect(proxy, host, port, log) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const onError = (err) => {
      socket.destroy();
      reject(new Error(`proxy ${proxy.host}:${proxy.port} failed: ${err.message}`));
    };
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.removeListener('error', onError);
      const auth = proxy.userId
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.userId}:${proxy.password || ''}`).toString('base64')}\r\n`
        : '';
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      let buffer = '';
      const onData = (chunk) => {
        buffer += chunk.toString('latin1');
        if (!buffer.includes('\r\n\r\n')) return;
        socket.removeListener('data', onData);
        const status = Number((buffer.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
        if (status !== 200) {
          socket.destroy();
          reject(new Error(`proxy CONNECT rejected with HTTP ${status || '???'}`));
          return;
        }
        log.debug(`http tunnel established to ${host}:${port} via ${proxy.host}:${proxy.port}`);
        resolve(socket);
      };
      socket.on('data', onData);
    });
  });
}

/**
 * Authentication options for mineflayer.
 *
 * - `offline`   : classic cracked login, only works on offline-mode servers
 * - `microsoft` : real account via device-code flow (public servers)
 *
 * Tokens are cached under runtime/auth-cache so repeated restarts do not re-prompt.
 */
function buildAuthOptions(cfg, log = new Logger('auth')) {
  const b = cfg.agent.bot;
  const auth = (b.auth || 'offline').toLowerCase();
  const options = {};

  if (auth === 'microsoft' || auth === 'msa') {
    options.auth = 'microsoft';
    options.username = b.username && b.username.includes('@') ? b.username : undefined;
    options.profilesFolder = b.profilesFolder || require('path').join(cfg.paths.runtime, 'auth-cache');
    options.onMsaCode = (data) => {
      log.warn('----------------------------------------------------------------');
      log.warn('Microsoft login required:');
      log.warn(`  1. open ${data.verification_uri}`);
      log.warn(`  2. enter code: ${data.user_code}`);
      log.warn('  3. the token is cached in runtime/auth-cache for next time');
      log.warn('----------------------------------------------------------------');
    };
  } else {
    options.auth = 'offline';
    options.username = b.username;
  }

  if (b.password) options.password = b.password;
  // Optional explicit device-code / refresh token override for unattended setups.
  if (b.microsoft && b.microsoft.email) options.username = b.microsoft.email;
  return options;
}

/** Human-readable summary used by `npm run server:info` / diagnostics. */
function describeTarget(cfg) {
  const b = cfg.agent.bot;
  const proxy = safeParse(b.proxy);
  const local = ['127.0.0.1', 'localhost', '::1'].includes(String(b.host).toLowerCase());
  return {
    address: `${b.host}:${b.port}`,
    version: b.version,
    auth: (b.auth || 'offline').toLowerCase(),
    username: b.username,
    scope: local ? 'local' : 'external (remote multiplayer server)',
    proxy: proxy ? `${proxy.protocol}://${proxy.host}:${proxy.port}` : null,
    notes: [
      local ? 'local server: offline auth is fine' : 'remote server: set auth to "microsoft" if online-mode=true',
      proxy ? 'traffic is tunnelled through the configured proxy' : 'direct connection (no proxy)'
    ]
  };
}

function safeParse(proxy) {
  try {
    return parseProxy(proxy);
  } catch {
    return null;
  }
}

module.exports = {
  parseProxy,
  createProxyAgent,
  createProxySocket,
  buildAuthOptions,
  describeTarget,
  isSocks
};
