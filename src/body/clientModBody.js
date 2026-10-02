'use strict';

/**
 * ClientModBody: drives a REAL Forge client through the agent-client control mod.
 *
 * This is the body that gets us onto Forge servers. mineflayer cannot, because Forge
 * 1.20.1 requires the FML handshake and mineflayer only speaks the vanilla protocol.
 * A real client does the handshake natively, so the agent attaches to it instead.
 *
 * What is better here than mineflayer:
 *   - Modded blocks and items arrive with their real registry ids, so `src/mods/knowledge.js`
 *     signature guessing becomes a fallback rather than the only option.
 *   - Modded recipes are whatever the client actually knows.
 *   - `/login` works because it is the client's own chat connection.
 *
 * What is worse:
 *   - Needs a graphics session; one instance per account; 30-60s to become usable.
 *   - Movement and digging are continuous (the client ticks them), so this body polls
 *     progress instead of awaiting a single call.
 *
 * Transport: plain HTTP against 127.0.0.1 (http://127.0.0.1:8899 by default). See
 * mod-client/ for why it is not a WebSocket.
 */

const { Body, BodyUnavailableError } = require('./body');
const { Logger } = require('../util/logger');
const { chooseTool } = require('../world/toolPolicy');

/** Block scan radius the mod uses; mirrored here so findBlocks can filter cheaply. */
const SCAN_RADIUS = 24;

class ClientModBody extends Body {
  /**
   * @param {object} cfg loaded config
   * @param {object} [options] { log, port, host, token, timeoutMs }
   */
  constructor(cfg, options = {}) {
    super(cfg);
    this.kind = 'clientmod';
    this.log = options.log || new Logger('clientmod');

    const cfgSection = (cfg.agent && cfg.agent.clientMod) || {};
    this.host = options.host || cfgSection.host || '127.0.0.1';
    this.port = options.port || cfgSection.port || 8899;
    this.token = options.token || cfgSection.token || '';
    this.timeoutMs = options.timeoutMs || cfgSection.timeoutMs || 5000;

    /** Last snapshot from the mod, refreshed on demand with a short TTL. */
    this._snapshot = null;
    this._snapshotAt = 0;
    this._snapshotTtlMs = options.snapshotTtlMs || 400;
    /**
     * Below this horizontal distance planning is pure overhead, so `moveTo` walks
     * straight there instead (P0-PLAN §3.6(6)).
     */
    this.directRange = options.directRange || (cfgSection.directRange === undefined ? 3 : cfgSection.directRange);
    /**
     * Close an open GUI automatically when the agent needs to walk.
     *
     * Minecraft drops WASD while any screen is open, and the operator's normal workflow is
     * to leave the inventory/pause screen open while commanding the bot. Set
     * `behaviour.autoCloseScreens: false` to get the old behaviour (refuse with
     * `screen-open` and let the human close it).
     */
    this.autoCloseScreens = options.autoCloseScreens === undefined
      ? (cfg.agent && cfg.agent.behaviour && cfg.agent.behaviour.autoCloseScreens) !== false
      : options.autoCloseScreens === true;
    /**
     * How long to wait for a *chat* screen to close before giving up on a move.
     *
     * The chat box is never closed automatically: the operator may be typing `!stop`, and
     * closing it mid-sentence was worse than waiting (live report: "I cannot interrupt it
     * any more"). While they type we simply wait; the mod also freezes its stall timers.
     */
    this.chatWaitMs = options.chatWaitMs
      || (cfg.agent && cfg.agent.behaviour && cfg.agent.behaviour.chatScreenWaitMs)
      || 20000;
    /** Lazily built on first long moveTo; see the `navigator` getter. */
    this._navigator = null;
    this._world = null;
    this._trace = null;
    /** Why the last moveTo ended, for GoToTask and the control panel. */
    this.lastMove = null;
    this.connected = false;
    this.lastError = null;
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  get isReady() {
    return !!(this.connected && this._snapshot && this._snapshot.ready);
  }

  // ------------------------------------------------------------- transport

  async request(path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: options.method || 'GET',
        headers: {
          ...(this.token ? { 'X-Agent-Token': this.token } : {}),
          ...(options.body ? { 'content-type': 'application/json' } : {})
        },
        body: options.body,
        signal: controller.signal
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`mod returned non-JSON: ${text.slice(0, 120)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send an action to the mod. Never throws; returns the parsed result or null. */
  async command(line) {
    try {
      const result = await this.request('/command', {
        method: 'POST',
        body: JSON.stringify({ command: line }),
        timeoutMs: Math.max(this.timeoutMs, 20000)
      });
      if (result && result.ok === false && result.error) {
        this.log.debug(`command "${line}" refused: ${result.error}`);
      }
      return result;
    } catch (err) {
      this.lastError = err;
      this.log.debug(`command "${line}" failed: ${err.message}`);
      return null;
    }
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Attach to a running client.
   *
   * Unlike mineflayer we do not *start* anything here: the client is already running
   * (launched by scripts/launch-forge-client.js). This performs a health check and
   * waits for the client to be in a world.
   */
  async connect(options = {}) {
    const waitMs = options.waitMs === undefined ? 120000 : options.waitMs;
    const deadline = Date.now() + waitMs;
    let announced = false;

    while (Date.now() < deadline) {
      try {
        const health = await this.request('/health', { timeoutMs: 2000 });
        if (!announced) {
          announced = true;
          this.log.info(`agent-client mod found (v${health.version}) at ${this.baseUrl}`);
        }
        this.connected = true;
        const state = await this.request('/state', { timeoutMs: 4000 });
        if (state && state.ready) {
          this._snapshot = state;
          this._snapshotAt = Date.now();
          this.log.info(
            `attached: ${state.dimension} at (${fmt(state.position)}) hp=${state.health} food=${state.food}`
          );
          return true;
        }
      } catch (err) {
        this.lastError = err;
        if (!announced) {
          this.log.info(`waiting for the client control mod on ${this.baseUrl} (${err.message})`);
          announced = true;
        }
      }
      await sleep(options.pollMs || 1000);
    }

    this.connected = false;
    throw new BodyUnavailableError(
      `no usable agent-client after ${Math.round(waitMs / 1000)}s on ${this.baseUrl} - ` +
        'is the Forge client running with the mod installed and a world loaded?'
    );
  }

  async disconnect() {
    this.connected = false;
    this._snapshot = null;
  }

  /** Refresh the cached snapshot if it is stale. */
  async refresh(force = false) {
    if (!force && this._snapshot && Date.now() - this._snapshotAt < this._snapshotTtlMs) {
      return this._snapshot;
    }
    try {
      const state = await this.request('/state', { timeoutMs: 4000 });
      this._snapshot = state;
      this._snapshotAt = Date.now();
      this.connected = true;
      return state;
    } catch (err) {
      this.lastError = err;
      return this._snapshot; // keep serving the last known state rather than nothing
    }
  }

  // ------------------------------------------------------------ perception

  /**
   * The Body contract wants a non-blocking snapshot, so this returns the cache. The
   * agent's loops call `refresh()` (awaited) once per tick and everything else reads
   * this synchronously - the same pattern a real client uses internally.
   */
  snapshot() {
    const state = this._snapshot;
    if (!state || !state.ready) return null;
    return {
      ready: true,
      body: this.kind,
      position: state.position,
      dimension: state.dimension,
      health: state.health,
      food: state.food,
      onGround: state.onGround,
      /**
       * `dead` was being dropped here even though the mod has always reported it
       * (`ClientStateSnapshot.java`: `player.isDeadOrDying()`). Without this field the
       * DeathWatch has nothing to watch - which is exactly why dying used to be silent.
       */
      dead: state.dead === true,
      /**
       * Interface state. The mod has reported these since the "bot will not move" incident,
       * but the Node body dropped them - so the movement guard below could not see that a
       * container screen was open and every walk silently keyed into a window that ignores
       * input. Same failure class as `dead` before it: the data existed, the mapping did not.
       */
      screenOpen: state.screenOpen === true,
      screen: state.screen && state.screen !== 'null' ? state.screen : null,
      mouseGrabbed: state.mouseGrabbed !== false,
      windowFocused: state.windowFocused !== false,
      time: state.time,
      weather: state.weather,
      inventory: state.inventory || {},
      emptySlots: state.emptySlots,
      heldItem: state.heldItem && state.heldItem !== 'null' ? state.heldItem : null,
      standingOn: state.standingOn ? { name: state.standingOn, position: below(state.position) } : null,
      lightLevel: state.lightLevel === undefined ? 15 : state.lightLevel,
      hostiles: state.hostiles || [],
      nearbyItems: state.itemDrops || [],
      players: (state.players || []).map((p) => p.name),
      /**
       * The block scan, exposed as a reference.
       *
       * `ClientWorldAdapter.cells()` reads `snapshot().blocks.cells`, and without this the
       * pathfinder sees "no scan" for every move and silently degrades to the client's own
       * walker - the entire A* layer was dead against the real body and looked merely
       * "unlucky". Kept as a reference (not a copy) because it holds 40817 cells: copying it
       * per poll would be the expensive part. Endpoints that must not ship it (`/ui/state`)
       * build their own summary.
       */
      blocks: state.blocks || null
    };
  }

  /**
   * Block at an absolute position, answered from the mod's block scan.
   *
   * The mod sends a flat "x,y,z" -> id map, so this is a lookup, not a request. Outside
   * the scanned box we return null (honest "unknown") instead of a wrong answer -
   * pretending a block is air would make the planner walk into walls.
   */
  blockAt(position) {
    if (!position) return null;
    const cells = this._snapshot && this._snapshot.blocks && this._snapshot.blocks.cells;
    if (!cells) return null;
    const key = `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
    const name = cells[key];
    return name ? { name, position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) } } : null;
  }

  findBlocks(names, options = {}) {
    const wanted = new Set(names.map(bare));
    return this.findBlocksMatching((name) => wanted.has(bare(name)), options);
  }

  /** Scan the mod's block map. Cheaper than it looks: it is an in-memory object. */
  findBlocksMatching(predicate, options = {}) {
    const state = this._snapshot;
    const cells = state && state.blocks && state.blocks.cells;
    if (!cells || !state.position) return [];
    const maxDistance = Math.min(options.maxDistance || 32, SCAN_RADIUS * 2);
    const limit = options.count || 32;
    const origin = state.position;
    const found = [];

    for (const [key, name] of Object.entries(cells)) {
      if (!predicate(name)) continue;
      const [x, y, z] = key.split(',').map(Number);
      const distance = Math.hypot(x + 0.5 - origin.x, y + 0.5 - origin.y, z + 0.5 - origin.z);
      if (distance > maxDistance) continue;
      found.push({ name, position: { x, y, z }, distance: +distance.toFixed(2) });
    }
    found.sort((a, b) => a.distance - b.distance);
    return found.slice(0, limit);
  }

  hostiles(maxDistance = 16) {
    const state = this._snapshot;
    if (!state || !state.hostiles) return [];
    return state.hostiles
      .filter((h) => h.distance <= maxDistance)
      .map((h) => ({
        id: h.id,
        name: h.name || h.type,
        position: h.position,
        distance: h.distance,
        kind: 'hostile',
        health: h.health
      }));
  }

  itemDrops(maxDistance = 8) {
    const state = this._snapshot;
    if (!state || !state.itemDrops) return [];
    return state.itemDrops
      .filter((d) => d.distance <= maxDistance)
      .map((d) => ({ id: d.id, name: d.item, position: d.position, distance: d.distance, kind: 'item', count: d.count }));
  }

  /**
   * Read recent chat lines (the in-game input channel, P0-PLAN §4.1).
   *
   * The mod keeps a 50-line ring buffer of everything the client saw, at
   * `GET /chatlog?n=`. It carries NO sender field - just rendered text - which is why the
   * caller must filter echoes itself; see `src/chat/chatListener.js`.
   *
   * @param {number} [n] how many lines back to fetch
   * @returns {Promise<{lines:string[]}>}
   */
  async readChat(n = 25) {
    const count = Math.max(1, Math.min(50, Math.floor(n) || 25));
    const res = await this.request(`/chatlog?n=${count}`, { timeoutMs: 3000 });
    if (!res) return { lines: [] };
    if (Array.isArray(res.lines)) return { lines: res.lines };
    // Older mods answered with a bare array; accept both shapes.
    if (Array.isArray(res)) return { lines: res };
    return { lines: [] };
  }

  /** Clear the mod's chat buffer. Used by tests so a stale line cannot re-trigger. */
  async clearChat() {
    try {
      await this.request('/chatlog/clear', { timeoutMs: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- action

  /**
   * Walk toward a position and wait for arrival.
   *
   * Two paths (P0-PLAN §3.6):
   *   - **short hop** (`< 3` blocks) or an explicit `{raw:true}` leg from the walker ->
   *     send `moveto` straight to the client. Planning a 2-block walk costs more than it
   *     saves, and the walker already has a path it wants executed verbatim.
   *   - **anything further** -> A* over the mod's own block scan, then walk the waypoints.
   *     This is the whole point of deliverable A: the client's built-in WalkTo walks into
   *     obstacles and has no idea it is stuck until its own 60s timeout.
   *
   * Returns a boolean like the rest of the Body contract, and records the failure reason
   * on `lastMove` so callers that care (`GoToTask`, the panel) can report *why*.
   */
  async moveTo(position, options = {}) {
    if (!position) return false;

    /**
     * A game screen that is open swallows every movement key.
     *
     * This is a hard physical limit of the client, not a pathfinding problem: while the
     * inventory, a chest or the pause menu is open, Minecraft ignores WASD entirely.
     *
     * The operator's workflow is "leave a screen open, ask the bot to do something", so the
     * default is now to close the screen ourselves and walk on (see `_tryCloseScreen`).
     * `behaviour.autoCloseScreens: false` restores the old honest refusal, and
     * `options.ignoreScreen` skips even that for the operator scripts that know better.
     */
    const snapForScreen = this._snapshot;
    if (snapForScreen && snapForScreen.screenOpen && options.ignoreScreen !== true) {
      const screen = snapForScreen.screen || 'a screen';
      /**
       * The cached snapshot may be older than the command.
       *
       * Live report: "I typed the command while the chat screen was open; as soon as I hit
       * Enter it decided it could not run." The chat screen closes the instant the player
       * sends, but the body's snapshot (400ms TTL) still said `screenOpen: true`, so the
       * walk was refused before it even started. Re-check against a *fresh* /state for a
       * moment before believing that a screen is really in the way.
       */
      const stillOpen = await this._screenStillOpen(900);
      if (stillOpen) {
        const isChat = /chat/i.test(String(screen || ''));
        const recovered = isChat
          ? await this._waitForScreenClose(this.chatWaitMs)
          : this.autoCloseScreens
            ? await this._tryCloseScreen(screen)
            : false;
        if (!recovered) {
          this.lastMove = { ok: false, reason: 'screen-open', screen, target: { ...position }, ms: 0 };
          this.log.warn(
            `cannot walk: ${screen} is open in the game - ` +
              (isChat ? 'finish typing or press Escape' : 'close it first')
          );
          return false;
        }
      }
    }

    if (options.raw === true) return this._rawMoveTo(position, options);

    const snap = this.snapshot();
    const from = snap && snap.position;
    if (from) {
      const flat = Math.hypot(position.x - from.x, position.z - from.z);
      if (flat < this.directRange && Math.abs(position.y - from.y) <= 1) {
        return this._rawMoveTo(position, options);
      }
    }

    const started = Date.now();
    let result;
    try {
      result = await this.navigator.goTo(position, options);
    } catch (err) {
      this.lastError = err;
      this.lastMove = { ok: false, reason: `throw: ${err.message}`, target: position, ms: Date.now() - started };
      this.log.debug(`navigation threw: ${err.message}`);
      return false;
    }

    /**
     * No usable block scan -> degrade to the client's own walker.
     *
     * `unknown-block` means the planner cannot even identify the cell the bot is standing
     * in: the mod has not sent a block map yet (right after connecting, or an older mod
     * without the scan). Refusing to move in that state would be a regression - the point of
     * keeping `_rawMoveTo()` is that a blind walk still beats standing still. Every other
     * failure is a real finding and must NOT be papered over this way.
     */
    if (!result.ok && result.reason === 'unknown-block') {
      this.log.debug('no block scan available yet - falling back to a direct walk');
      return this._rawMoveTo(position, options);
    }

    this.lastMove = {
      ok: !!result.ok,
      reason: result.reason,
      target: { ...position },
      iterations: result.iterations,
      from: from ? { ...from } : null,
      ms: Date.now() - started
    };
    if (!result.ok) this.log.debug(`pathfinding failed (${result.reason}) -> ${fmt(position)}`);
    this.trace({ kind: 'moveTo', ...this.lastMove });
    return !!result.ok;
  }

  /**
   * Close a GUI screen so movement becomes possible again.
   *
   * Uses the mod's `close` verb (the same path as pressing Escape / closing the container)
   * and waits for /state to report `screenOpen: false`. Returns false when the screen
   * survives - some servers re-open a menu, and a container mid-transaction may refuse to
   * close - in which case the caller reports `screen-open` honestly.
   */
  async _tryCloseScreen(screen) {
    this.log.info(`a game screen is open (${screen}) - closing it so the agent can move`);
    const res = await this.command('close').catch(() => null);
    if (!res || !res.ok) return false;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      await sleep(150);
      const state = await this.refresh(true).catch(() => null);
      if (state && state.screenOpen === false) {
        this.log.info('screen closed - walking on');
        return true;
      }
    }
    return false;
  }

  /**
   * Is a GUI screen *still* open, according to fresh polls?
   *
   * Returns false as soon as a live /state says the screen is gone - which is the normal
   * case right after the player pressed Enter in chat. Only when it stays open for the
   * whole window do we treat it as a real obstacle.
   */
  async _screenStillOpen(waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const state = await this.refresh(true).catch(() => null);
      if (state && state.screenOpen === false) return false;
      if (Date.now() >= deadline) return true;
      await sleep(150);
    }
  }

  /** Wait (without touching anything) for the player to close the screen themselves. */
  async _waitForScreenClose(waitMs) {
    const deadline = Date.now() + waitMs;
    this.log.info(`waiting up to ${Math.round(waitMs / 1000)}s for the open screen to close (never closing chat ourselves)`);
    while (Date.now() < deadline) {
      await sleep(250);
      const state = await this.refresh(true).catch(() => null);
      if (state && state.screenOpen === false) return true;
    }
    return false;
  }

  /**
   * The pre-pathfinding behaviour: hand the target to the client and wait.
   *
   * Kept as the degradation path. If the block scan is unavailable (fresh connection, mod
   * older than the scan) the planner cannot plan anything, and a dumb walk is still better
   * than refusing to move.
   */
  async _rawMoveTo(position, options = {}) {
    const range = options.range === undefined ? 1.5 : options.range;
    const timeoutMs = options.timeoutMs || 30000;
    const started = Date.now();
    const started_at = this.snapshot();
    this.lastAction = null; // stale reasons from a previous action must not leak into this one
    const sent = await this.command(
      `moveto ${Math.floor(position.x)} ${Math.floor(position.y)} ${Math.floor(position.z)} ${range}`
    );
    if (!sent || sent.ok === false) {
      throw new BodyUnavailableError(`moveto rejected at ${fmt(position)}`);
    }
    const ok = await this.awaitAction('walkTo', timeoutMs);
    /**
     * Record the outcome even on the dumb path.
     *
     * `raw: true` is how a caller (and the protocol test) can tell "the client walked
     * there" from "the planner walked there" - and it is the only way to observe that the
     * degradation actually happened rather than silently looking like a normal move.
     */
    this.lastMove = {
      ok,
      raw: true,
      // Prefer the client's own verdict ("jump-blocked", "stuck") over a generic failure.
      reason: ok ? 'arrived' : (this.lastAction && this.lastAction.reason) || 'walk-failed',
      target: { ...position },
      from: started_at && started_at.position ? { ...started_at.position } : null,
      ms: Date.now() - started
    };
    this.trace({ kind: 'moveTo', ...this.lastMove, range, timeoutMs });
    return ok;
  }

  /**
   * Navigator, built on first use.
   *
   * Lazy because it needs a live snapshot to be meaningful, and because the offline body
   * tests never move: constructing it in the constructor would make every ClientModBody
   * pay for pathfinding it may not use.
   */
  get navigator() {
    if (this._navigator) return this._navigator;
    const { ClientWorldAdapter } = require('../pathfinding/clientWorldAdapter');
    const { PathNavigator } = require('../pathfinding/navigator');

    const pathCfg = (this.cfg.agent && this.cfg.agent.pathfinding) || {};
    const safetyCfg = (this.cfg.agent && this.cfg.agent.safety) || {};
    this._world = new ClientWorldAdapter(this, { log: this.log });
    this._navigator = new PathNavigator(this, {
      log: this.log,
      world: this._world,
      trace: (record) => this.trace(record),
      /**
       * These all come from `config/agent.json` -> `pathfinding`, and they used to be
       * declared there while nothing read them - worse than not existing, because the file
       * looked authoritative while only the code defaults applied. The plan is explicit that
       * a config key must be consumed or deleted.
       */
      allowSwim: pathCfg.allowSwim !== false,
      allowDig: pathCfg.allowDig === true,
      waypointRange: pathCfg.waypointRange === undefined ? 1.0 : pathCfg.waypointRange,
      // The walker calls it `stallThreshold`; the config calls it `stuckThreshold` to match
      // the plan's §7 wording. Mapped here rather than renaming it in two places.
      stallThreshold: pathCfg.stuckThreshold === undefined ? 2 : pathCfg.stuckThreshold,
      nodeTimeoutMs: pathCfg.nodeTimeoutMs,
      tickTimeoutMs: pathCfg.tickTimeoutMs,
      maxPathLength: pathCfg.maxPathLength,
      maxIterations: pathCfg.maxIterations,
      replanEvery: pathCfg.replanEvery,
      /**
       * "Stop jumping, go around." `jumpStreakLimit` is how many failed jump/step-up legs
       * the walker tolerates before it reports `jump-blocked` instead of retrying, and
       * `maxSidesteps` is how many different directions the navigator may try before it
       * calls the target unreachable. Both are in config/agent.json because they are
       * tuning, not constants - see src/pathfinding/navigator.js.
       */
      jumpStreakLimit: pathCfg.jumpStreakLimit,
      maxSidesteps: pathCfg.maxSidesteps,
      /**
       * Keep the bot off player-built terrain. Default on: this agent runs on a public
       * server where "walk there" must not mean "walk across someone's roof" or
       * "stand in their farm". See src/world/safety.js.
       */
      avoidManMade: safetyCfg.avoidManMade !== false
    });
    return this._navigator;
  }

  /** Path trace sink (P0-PLAN §8); no-op unless a trace path is configured. */
  trace(record) {
    if (!this._trace) {
      const cfg = this.cfg.agent || {};
      const file =
        (cfg.pathfinding && cfg.pathfinding.trace) ||
        (cfg.observability && cfg.observability.pathTrace) ||
        null;
      this._trace = file ? require('../util/trace').tracer(file, { body: this.kind }) : () => {};
    }
    this._trace(record);
  }

  async dig(block, options = {}) {
    if (!block || !block.position) return false;
    const timeoutMs = options.timeoutMs || 20000;
    const started = await this.command(
      `dig ${Math.floor(block.position.x)} ${Math.floor(block.position.y)} ${Math.floor(block.position.z)}`
    );
    if (!started || started.ok === false) {
      this.log.debug(`dig refused at ${fmt(block.position)}`);
      return false;
    }
    return this.awaitAction('dig', timeoutMs);
  }

  /** Poll /progress until the named action finishes. */
  async awaitAction(actionName, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      let progress = null;
      try {
        progress = await this.request('/progress', { timeoutMs: 3000 });
      } catch (err) {
        this.lastError = err;
        return false;
      }
      if (!progress || progress.busy === false) {
        // Finished (or never started). Refresh state so callers see the result.
        await this.refresh(true);
        const done = progress ? progress.done !== false && progress.failed !== true : false;
        /**
         * Keep the client's own verdict.
         *
         * The mod distinguishes `jump-blocked` (it pressed jump and got nowhere) from
         * `stuck` and `timeout`, and that difference is exactly what the walker and the log
         * need - "the bot kept jumping" is a diagnosis, "walk failed" is not.
         */
        this.lastAction = progress
          ? { action: progress.action || actionName, ok: done, reason: progress.reason || null }
          : null;
        return done;
      }
      await sleep(250);
    }
    this.log.debug(`${actionName} timed out after ${timeoutMs}ms`);
    await this.command('stop');
    return false;
  }

  async place(itemName, referenceBlock, faceVector) {
    const reference = referenceBlock && referenceBlock.position ? referenceBlock.position : referenceBlock;
    if (!reference) return false;
    const face = faceName(faceVector);
    const res = await this.command(
      `place ${Math.floor(reference.x)} ${Math.floor(reference.y)} ${Math.floor(reference.z)} ${face} ${itemName || ''}`
    );
    return !!(res && res.ok);
  }

  /**
   * Right-click a block face with whatever is held.
   *
   * One primitive covers a lot of play: hoeing dirt, planting seeds, filling a bucket,
   * bone-mealing a crop, pressing a button, and "open this chest / crafting table / furnace".
   *
   * @param {{x:number,y:number,z:number}} position the block to click
   * @param {object} [options] { face: {x,y,z}, waitMs }
   */
  async useOn(position, options = {}) {
    if (!position) return false;
    const face = faceName(options.face || { x: 0, y: 1, z: 0 });
    const res = await this.command(
      `useon ${Math.floor(position.x)} ${Math.floor(position.y)} ${Math.floor(position.z)} ${face}`
    );
    if (!res || !res.ok) return false;
    // The menu opens on the next server round trip; callers that need it wait a beat.
    await sleep(options.waitMs === undefined ? 350 : options.waitMs);
    return true;
  }

  /**
   * Dump the currently open menu.
   *
   * The player's own inventory menu is always "open", so this also answers "what is in my
   * inventory, slot by slot" without a screen.
   *
   * @returns {Promise<{open:boolean,containerId?:number,size?:number,menuClass?:string,slots:Array,carried:object}|null>}
   */
  async menu() {
    const res = await this.command('menu');
    if (!res || !res.ok || !res.menu || res.menu.open === false) return res && res.menu ? res.menu : null;
    return res.menu;
  }

  /**
   * Click a slot in the open menu (the vanilla mouse path).
   *
   * @param {number} slot slot index from `menu()`
   * @param {object} [options] { button: 0|1, mode: 'pickup'|'quickmove'|'swap', waitMs }
   */
  async clickSlot(slot, options = {}) {
    const button = options.button === undefined ? 0 : options.button;
    const mode = options.mode || 'pickup';
    const res = await this.command(`click ${slot} ${button} ${mode}`);
    if (!res || !res.ok) return false;
    await sleep(options.waitMs === undefined ? 150 : options.waitMs);
    return true;
  }

  /** Close the open container, if any. */
  async closeMenu() {
    const res = await this.command('close');
    return !!(res && res.ok);
  }

  async equip(itemName) {
    const res = await this.command(`select ${itemName}`);
    return !!(res && res.ok);
  }

  /**
   * Drop items: select the stack, then ask the mod to drop one or all of it.
   *
   * The mod's `drop` verb drops the whole held stack and `drop 1` drops a single item, so a
   * partial count is a short loop of single drops. Checking the count first keeps a request
   * for 64 from turning into 64 round trips when only 3 are left.
   */
  async dropItem(itemName, count = 1) {
    const state = await this.refresh(true);
    if (!state) return false;
    const inventory = state.inventory || {};
    const name = Object.keys(inventory).find((n) => bare(n) === bare(itemName));
    if (!name) return false;
    const have = inventory[name] || 0;
    if (!(await this.equip(name))) return false;
    if (count >= have) {
      const res = await this.command('drop');
      return !!(res && res.ok);
    }
    for (let i = 0; i < count; i += 1) {
      const res = await this.command('drop 1');
      if (!res || !res.ok) return false;
    }
    return true;
  }

  async equipBest(kind) {
    const state = await this.refresh(true);
    if (!state) return false;
    const tiers = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'];
    for (const tier of tiers) {
      const candidate = `minecraft:${tier}_${kind}`;
      if ((state.inventory || {})[candidate]) return this.equip(candidate);
    }
    return false;
  }

  async equipForBlock(block) {
    const state = await this.refresh(true);
    if (!state) return false;
    const items = Object.keys(state.inventory || {}).map((name) => ({ name, count: state.inventory[name] }));
    const chosen = chooseTool(block && block.name, items);
    if (!chosen) return false;
    return this.equip(chosen);
  }

  async equipArmor() {
    return false; // the mod has no armour API yet; the game will not auto-equip for us
  }

  /** Eat: select a food item and use it (holding right-click). */
  async consume(itemName) {
    if (itemName) {
      const selected = await this.equip(itemName);
      if (!selected) return false;
    }
    const res = await this.command('use');
    if (!res || !res.ok) return false;
    // Eating takes ~1.6s of held use; poll state until food rises or we give up.
    const before = this._snapshot ? this._snapshot.food : 0;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await sleep(400);
      const state = await this.refresh(true);
      if (state && state.food > before) return true;
    }
    return false;
  }

  async attack(entity, options = {}) {
    if (!entity) return false;
    const id = entity.id !== undefined ? entity.id : entity._entity && entity._entity.id;
    if (id === undefined) return false;
    const timeoutMs = options.timeoutMs || 15000;
    const res = await this.command(`attack ${id} ${timeoutMs}`);
    return !!(res && res.ok);
  }

  /**
   * Chat or run a command.
   *
   * Routing rule (learned from a live test): a string starting with '/' is ALREADY a
   * command, so it must go through the `cmd` verb *as-is* - prefixing it into
   * "cmd /login pw" makes the mod look for a command literally named "/login" and fail.
   * A string without a slash is plain chat.
   *
   * Both "/login pw" and "login pw" therefore end up as a server command; only the mod's
   * normalisation decides the final wire form.
   */
  async chat(message) {
    const text = String(message);
    if (ClientModBody.isForbidden(text)) {
      this.log.warn(`refusing to send "${text}": registering resets the character`);
      return false;
    }
    const res = await this.command(text.startsWith('/') ? `cmd ${text}` : `chat ${text}`);
    return !!(res && res.ok);
  }

  /** Dedicated AuthMe login, so the agent does not need to know the slash rules. */
  async login(password) {
    const res = await this.command(`login ${password}`);
    return !!(res && res.ok);
  }

  /**
   * Send a command and report only whether the *mod accepted and sent* it.
   *
   * Deliberately does not interpret the server's reply: on a server without AuthMe,
   * `/login` is correctly rejected by the server even though the mod and the client did
   * exactly the right thing. Use `chat()`/`command()` when the response body matters.
   *
   * @returns {Promise<boolean>}
   */
  async commandSent(line) {
    const res = await this.command(line);
    return !!(res && res.ok === true);
  }

  /**
   * Refuse to send a command that destroys data.
   *
   * `/register` on this server RESETS an existing character - experience and inventory are
   * wiped. The mod blocks it too; this is the agent-side half of the same guard so no code
   * path can reach it even if the mod were replaced.
   */
  static isForbidden(command) {
    const lower = String(command || '')
      .trim()
      .replace(/^\/+/, '')
      .toLowerCase();
    return lower === 'register' || lower.startsWith('register ') || lower === 'reg' || lower.startsWith('reg ');
  }

  /** Guarded command send: throws rather than silently doing damage. */
  async safeCommand(line) {
    if (ClientModBody.isForbidden(line)) {
      throw new Error(
        `refusing "${line}": registering resets the character (experience and inventory are lost)`
      );
    }
    return this.command(line);
  }

  async lookAt(position) {
    const res = await this.command(`lookat ${position.x} ${position.y} ${position.z}`);
    return !!(res && res.ok);
  }

  /**
   * Tell the client to stop whatever continuous action it is running.
   *
   * Terminal on purpose: this is the bottom of the interrupt chain. `interrupt()` calls the
   * navigator, the navigator calls the walker, and the walker calls *this* - if the walker
   * called `interrupt()` instead, the three would recurse into each other forever. That is
   * not hypothetical: it crashed the agent with `RangeError: Maximum call stack size
   * exceeded` the first time a death interrupt fired with a live navigator.
   */
  stopContinuous(reason = 'stop') {
    this.command('stop').catch(() => {});
    return true;
  }

  interrupt(reason) {
    /**
     * Stop the planner first: it may be mid-replan and would otherwise immediately issue
     * a fresh `moveto` after the `stop` below, which looks exactly like "the stop button
     * does nothing".
     */
    if (this._navigator) {
      // The navigator unwinds to `stopContinuous()` at the bottom of the chain.
      this._navigator.stop();
      return;
    }
    this.stopContinuous(reason);
  }

  // -------------------------------------------------------------- optional

  get supportsCrafting() {
    return false; // the mod does not expose the crafting UI yet
  }

  canMine(block) {
    if (!block) return false;
    return !['minecraft:bedrock', 'minecraft:barrier', 'minecraft:command_block'].includes(block.name);
  }

  describe() {
    return {
      kind: this.kind,
      ready: this.isReady,
      url: this.baseUrl,
      connected: this.connected,
      lastError: this.lastError ? this.lastError.message : null
    };
  }

  /** Health probe used by scripts to decide whether a client is attached. */
  async health() {
    return this.request('/health', { timeoutMs: 2000 });
  }
}

function bare(name) {
  if (!name) return '';
  const idx = String(name).indexOf(':');
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

function fmt(position) {
  if (!position) return '(unknown)';
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function below(position) {
  if (!position) return null;
  return { x: Math.floor(position.x), y: Math.floor(position.y) - 1, z: Math.floor(position.z) };
}

function faceName(vector) {
  if (!vector) return 'up';
  if (vector.y > 0) return 'up';
  if (vector.y < 0) return 'down';
  if (vector.x > 0) return 'east';
  if (vector.x < 0) return 'west';
  if (vector.z > 0) return 'south';
  if (vector.z < 0) return 'north';
  return 'up';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { ClientModBody };
