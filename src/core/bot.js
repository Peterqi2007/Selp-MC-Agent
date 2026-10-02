'use strict';

const mineflayer = require('mineflayer');
const { EventEmitter } = require('events');
const { Logger } = require('../util/logger');
const { installPlugins } = require('./plugins');
const { parseProxy, createProxyAgent, buildAuthOptions } = require('./network');

/**
 * Low-level wrapper around a mineflayer instance.
 *
 * Responsibilities:
 *  - own the connection lifecycle (connect, spawn, kick, error, reconnect w/ backoff)
 *  - expose a small, promise-friendly surface used by the survival systems
 *  - publish lifecycle events the higher layers (brain/planner) subscribe to
 *
 * It deliberately contains no decision making: everything survival-specific lives
 * in src/survival and src/tasks so the controller stays easy to reason about.
 */
class BotController extends EventEmitter {
  constructor(cfg, logger) {
    super();
    this.cfg = cfg;
    this.log = logger || new Logger('bot');
    this.bot = null;
    this.state = 'idle'; // idle | connecting | spawned | dead | disconnected
    this.attempts = 0;
    this.shuttingDown = false;
    this.loadedPlugins = [];
    this.lastError = null;
    this.connectedAt = null;
  }

  get isAlive() {
    return !!(this.bot && this.bot.entity && this.bot.entity.isValid !== false && this.state === 'spawned');
  }

  connect() {
    if (this.bot) this.disconnect();
    this.state = 'connecting';
    const b = this.cfg.agent.bot;
    const options = {
      host: b.host,
      port: b.port,
      version: b.version,
      viewDistance: b.viewDistance || 'far',
      checkTimeoutInterval: b.checkTimeoutInterval || 30000,
      hideErrors: true,
      brand: b.brand || 'mineflayer-survival-agent'
    };
    // Auth (offline vs real Microsoft account) and proxy are resolved in core/network
    // so the same agent can point at localhost or a remote multiplayer server.
    Object.assign(options, buildAuthOptions(this.cfg, new Logger('auth')));

    if (b.proxy) {
      try {
        const proxy = parseProxy(b.proxy);
        options.agent = createProxyAgent(proxy, new Logger('proxy'));
        this.log.info(`using ${proxy.protocol} proxy ${proxy.host}:${proxy.port}`);
      } catch (err) {
        this.log.error(`proxy config rejected: ${err.message} - connecting directly`);
      }
    }

    const remote = !['127.0.0.1', 'localhost', '::1'].includes(String(b.host).toLowerCase());
    this.log.info(
      `connecting to ${options.host}:${options.port} as ${options.username || '(msa profile)'} ` +
        `(mc ${options.version}, auth=${options.auth}, ${remote ? 'remote' : 'local'})`
    );
    this.bot = mineflayer.createBot(options);
    this.loadedPlugins = installPlugins(this.bot, this.cfg, this.log);
    this._installLifecycle();

    // Expose a lightweight admin surface to the task layer.
    this.bot.agent = { controller: this, cfg: this.cfg, log: this.log };
    this.emit('botCreated', this.bot);
    return this.bot;
  }

  _installLifecycle() {
    const b = this.bot;

    // Plugin channels are the reliable way to tell which mod loader is on the other
    // end: Forge registers `fml:*`/`forge:*`, Fabric registers `fabric:*`, regardless
    // of what the version string says.
    this.pluginChannels = new Set();
    this.serverBrand = null;
    try {
      b._client.on('packet', (data, meta) => {
        try {
          if (meta && meta.name === 'custom_payload' && data && data.channel) {
            this.pluginChannels.add(String(data.channel));
          }
          if (meta && meta.name === 'server_data' && data && data.brand) {
            this.serverBrand = String(data.brand);
          }
        } catch {
          /* never let diagnostics break the connection */
        }
      });
    } catch {
      /* older protocol shapes may not expose _client */
    }

    b.once('spawn', () => {
      this.state = 'spawned';
      this.attempts = 0;
      this.connectedAt = Date.now();
      this.log.info(`spawned at ${fmtVec(b.entity.position)} in ${b.game.dimension}`);
      if (this.pluginChannels.size) {
        const interesting = [...this.pluginChannels].filter((c) => /^(fml|forge|fabric|minecraft|neoforge)/i.test(c));
        if (interesting.length) this.log.info(`plugin channels: ${interesting.slice(0, 12).join(', ')}${interesting.length > 12 ? ` (+${interesting.length - 12})` : ''}`);
      }
      if (this.serverBrand) this.log.info(`server brand: ${this.serverBrand}`);
      this.emit('spawn');
    });

    b.on('death', () => {
      this.state = 'dead';
      this.log.warn('bot died');
      this.emit('death');
    });

    b.on('respawn', () => {
      this.state = 'spawned';
      this.log.info('respawned');
      this.emit('respawn');
    });

    b.on('health', () => this.emit('health'));

    b.on('kicked', (reason) => {
      const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
      this.log.warn(`kicked: ${text}`);
      // "You logged in from another location" means the server still holds our old
      // session. Reconnecting immediately produces a tight duplicate_login storm
      // (one reconnect per two seconds, forever), so back off hard instead.
      if (/another location|duplicate_login|already connected/i.test(text)) {
        this.duplicateLoginKicks = (this.duplicateLoginKicks || 0) + 1;
        this._reconnectBackoffMs = Math.min(120000, 15000 * this.duplicateLoginKicks);
        this.log.warn(
          `server still holds a previous session for "${b.username}" - waiting ${Math.round(this._reconnectBackoffMs / 1000)}s ` +
            'before retrying (another agent process with the same username is the usual cause)'
        );
      }
      // A Forge server that requires the FML client handshake will reject us every
      // single time. Retrying is pointless and looks like a broken agent, so stop and
      // explain instead.
      if (/require Forge|requires Forge|FML|Forge to be installed/i.test(text)) {
        this.fatalKick = text;
        this.shuttingDown = true;
        this.log.error('----------------------------------------------------------------');
        this.log.error('this server requires a Forge client and mineflayer speaks vanilla only.');
        this.log.error('reconnect disabled - see docs/EXTERNAL-SERVERS.md for the options.');
        this.log.error('------------------------------------------------------------');
      }
      this.emit('kicked', reason);
    });

    b.on('error', (err) => {
      this.lastError = err;
      this.log.error(`socket error: ${err.message}`);
      this.emit('socketError', err);
    });

    b.on('end', (reason) => {
      this.state = 'disconnected';
      this.log.warn(`disconnected (${reason || 'unknown'})`);
      this.emit('end', reason);
      if (!this.shuttingDown) this._scheduleReconnect();
    });

    b.on('message', (jsonMsg, position) => {
      this.emit('chat', { text: jsonMsg.toString(), position });
    });
  }

  _scheduleReconnect() {
    if (this.shuttingDown) return;
    this.attempts += 1;
    const base = Math.min(30000, 2000 * this.attempts);
    const delay = Math.max(base, this._reconnectBackoffMs || 0);
    this._reconnectBackoffMs = 0;
    this.log.info(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => {
      if (!this.shuttingDown) {
        try {
          this.connect();
        } catch (err) {
          this.log.error(`reconnect failed: ${err.message}`);
          this._scheduleReconnect();
        }
      }
    }, delay);
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.bot) {
      const old = this.bot;
      // Drop our own listeners first so the 'end' handler cannot schedule a
      // reconnect for a socket we are deliberately closing.
      try {
        old.removeAllListeners('end');
        old.removeAllListeners('kicked');
        old.removeAllListeners('error');
      } catch {
        /* ignore */
      }
      try {
        old.quit('agent reconnect');
      } catch {
        try {
          old.end();
        } catch {
          /* ignore */
        }
      }
      this.bot = null;
    }
    this.state = 'idle';
  }

  shutdown() {
    this.shuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.bot) {
      try {
        this.bot.quit('agent shutdown');
      } catch {
        /* ignore */
      }
    }
    this.state = 'idle';
  }

  // ---------------------------------------------------------------- utilities

  chat(message) {
    if (!this.bot) return;
    this.bot.chat(message);
    this.log.info(`chat> ${message}`);
  }

  // ------------------------------------------------------- pathfinder control

  /**
   * Arm mineflayer-pathfinder.
   *
   * The plugin keeps a `stopPathing` flag in a module closure, and it starts out
   * **true** on a fresh bot (calling `stop()` sets it too). While it is true the
   * physicsTick handler returns early, so every `goto()` rejects instantly with
   * "Path was stopped before it could be completed" - even on a brand new
   * connection with no prior navigation. Nothing is exposed to clear it directly,
   * so the only reliable way is to set a goal and let one physics tick run: the
   * tick clears the flag (`stopPathing = false`) before anything else happens.
   *
   * This routine is idempotent and safe to call at any time.
   */
  async rearmPathfinder() {
    if (!this.bot || !this.bot.pathfinder) return false;
    const { goals } = require('mineflayer-pathfinder');
    try {
      const pos = this.bot.entity ? this.bot.entity.position : null;
      if (!pos) return false;

      // Cancel whatever is in flight first: stop() latches the flag, the physics
      // tick below clears it again - that ordering matters.
      this.bot.pathfinder.stop();

      // A goal that is already satisfied forces the next physics tick down the
      // "path is empty" branch, which is where the plugin clears `stopPathing`.
      const settled = this.bot.pathfinder.setGoal(
        new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z), 0)
      );
      if (settled && typeof settled.catch === 'function') settled.catch(() => {});

      let ticked = false;
      await new Promise((resolve) => {
        const finish = () => {
          if (ticked) return;
          ticked = true;
          this.bot.removeListener('physicsTick', finish);
          resolve();
        };
        this.bot.once('physicsTick', finish);
        setTimeout(finish, 300);
      });

      // Clear the leftover goal without relying on stop() semantics.
      if (this.bot.pathfinder.goal) {
        const pending = this.bot.pathfinder.setGoal(null);
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      }
      this.log.debug(`pathfinder armed (physicsTick seen: ${ticked})`);
      return true;
    } catch (err) {
      this.log.debug(`rearmPathfinder failed: ${err.message}`);
      return false;
    }
  }

  position() {
    return this.bot && this.bot.entity ? this.bot.entity.position.clone() : null;
  }

  /** Run a bot action but never let it hang forever: resolves false on timeout. */
  async guarded(promise, timeoutMs = 20000, label = 'action') {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((resolve) => {
          timer = setTimeout(() => {
            this.log.warn(`${label} timed out after ${timeoutMs}ms`);
            resolve(false);
          }, timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  snapshot() {
    const b = this.bot;
    if (!b || !b.entity) {
      return { state: this.state, alive: false };
    }
    return {
      state: this.state,
      alive: this.isAlive,
      username: b.username,
      position: b.entity.position ? { x: +b.entity.position.x.toFixed(2), y: +b.entity.position.y.toFixed(2), z: +b.entity.position.z.toFixed(2) } : null,
      dimension: b.game && b.game.dimension,
      health: b.health,
      food: b.food,
      foodSaturation: b.foodSaturation,
      experience: { level: b.experience && b.experience.level },
      time: b.time && { timeOfDay: b.time.timeOfDay, day: b.time.day, isDay: b.time.isDay },
      weather: b.thunderState !== undefined ? { isRaining: b.isRaining, thunder: b.thunderState } : undefined,
      players: Object.keys(b.players || {}),
      entities: Object.keys(b.entities || {}).length,
      heldItem: b.heldItem ? b.heldItem.name : null,
      connectedAt: this.connectedAt
    };
  }
}

function fmtVec(v) {
  if (!v) return '(unknown)';
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
}

module.exports = { BotController };
