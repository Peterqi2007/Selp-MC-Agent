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
const { stampSnapshot, staleFields } = require('../world/freshness');
const { DEFAULT_BUDGET } = require('../world/refreshPlan');
const { Logger } = require('../util/logger');
const { chooseTool } = require('../world/toolPolicy');

/** Block scan radius the mod uses; mirrored here so findBlocks can filter cheaply. */
const SCAN_RADIUS = 24;

/**
 * A menu "fingerprint" for change detection: slots and cursor stack.
 *
 * The container index and class are part of it because a screen can swap underneath a
 * click (furnace -> inventory when it closes) and that counts as a change too.
 */
function menuSignature(menu) {
  if (!menu) return 'null';
  return JSON.stringify({
    open: !!menu.open,
    id: menu.containerId,
    cls: menu.menuClass,
    carried: menu.carried ? [menu.carried.item, menu.carried.count] : null,
    slots: (menu.slots || []).map((slot) => [slot.i, slot.item, slot.count])
  });
}

/**
 * Item names on the wire carry a namespace; a bare "crafting_table" means
 * minecraft:crafting_table. The mod compares names literally, so normalising here keeps
 * "equip torch" and "place ... torch" from silently doing nothing.
 */
function fullItemName(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  return text.includes(':') ? text : `minecraft:${text}`;
}

/**
 * Fields whose freshness is reported with the snapshot (P1 §1.5.3).
 *
 * They all come from the same `/state` response, so they share one timestamp - but the
 * timestamp is the **refresh** time, not the read time. A caller that re-reads a cached
 * snapshot must see the field age correctly, not "0 ms because I just called snapshot()".
 */
const OBSERVED_FIELDS = [
  'position',
  'yaw',
  'pitch',
  'dimension',
  'health',
  'food',
  'onGround',
  'dead',
  'screenOpen',
  'screen',
  'mouseGrabbed',
  'windowFocused',
  'target',
  'time',
  'weather',
  'inventory',
  'emptySlots',
  'heldItem',
  'standingOn',
  'lightLevel',
  'blockLight',
  'hostiles',
  'entities',
  'guns',
  'nearbyItems',
  'crops',
  'fishing',
  'heldDurability',
  'players',
  'blocks'
];

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
     * A10: actions must not be driven by an old position. The panel/state poll may lag
     * by one 500ms tick; 1500ms leaves room for that while rejecting a disconnected body.
     */
    this.actionFreshnessMs = options.actionFreshnessMs || cfgSection.actionFreshnessMs || 1500;
    this.freshnessBudget = options.freshnessBudget || cfgSection.freshnessBudget || DEFAULT_BUDGET;
    this._snapshotVersion = 0;
    this._lastRefreshErrorAt = null;
    this._lastRefreshError = null;
    /**
     * Keep that snapshot genuinely fresh while the agent is idle.
     *
     * Real report (2026-10-13): a zombie stood against the agent's face and nothing
     * happened - the 600ms reflex loop and the LLM `observe` tool both read a snapshot
     * that had not been refreshed since the agent's last *action* (`refresh()` calls
     * live inside action code paths only). `BodyWorldView.snapshot(true)` re-reads this
     * same cache, it does not poll the mod, so between actions the whole world view -
     * hostiles included - froze for minutes; the panel showed the bot 58 blocks from
     * where it really stood, and "@大肥鱼 攻击" truthfully answered from stale data
     * ("没看到怪物"). The background poll below keeps `_snapshot` <= statePollMs old
     * for every consumer (reflexes, observe, panel, death watch, tasks).
     */
    this.statePollMs = options.statePollMs || (cfgSection.statePollMs === undefined ? 500 : cfgSection.statePollMs);
    this._statePollTimer = null;
    this._statePollBusy = false;
    /**
     * Below this horizontal distance planning is pure overhead, so `moveTo` walks
     * straight there instead (P0-PLAN §3.6(6)).
     */
    this.directRange = options.directRange || (cfgSection.directRange === undefined ? 3 : cfgSection.directRange);
    /**
     * May the agent close a container screen when it needs to walk?
     *
     * Minecraft drops WASD while any screen is open, so a menu left open stalls movement. This
     * switch only ever applies to *container* screens (`isContainerScreen`): the chat box, the
     * Escape/pause menu, options, and any screen the agent does not recognise are waited on and
     * never dismissed, because they belong to the operator - who may be mid-sentence in a text
     * field, or may have deliberately paused the game.
     *
     * `false` refuses even a container, reporting `screen-open` and letting the human close it.
     */
    this.autoCloseScreens = options.autoCloseScreens === undefined
      ? (cfg.agent && cfg.agent.behaviour && cfg.agent.behaviour.autoCloseScreens) !== false
      : options.autoCloseScreens === true;
    /**
     * How long to wait for a screen that is not ours to close.
     *
     * Applies to chat, the Escape menu, options and anything unrecognised. While the operator
     * types we simply wait, and the mod freezes its stall timers so a long pause in a text
     * field does not look like a pathfinding failure. Live report that set the default:
     * "I cannot interrupt it any more" - an earlier version closed the chat mid-sentence.
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
          this._startStatePoll();
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
    this._stopStatePoll();
    this.connected = false;
    this._snapshot = null;
  }

  /**
   * Background refresh loop: the difference between a live world view and a frozen one.
   *
   * Every refresh() elsewhere in this class belongs to an action (dig, walk, attack...).
   * Without this poller the cache simply stops updating the moment the agent goes idle,
   * which is exactly when reflexes - self-defence most of all - must see the world.
   * TTL-aware and single-flight: a recent action refresh makes the tick a no-op, and
   * the poller never stacks requests on itself.
   */
  _startStatePoll() {
    if (this._statePollTimer || !(this.statePollMs > 0)) return;
    this._statePollTimer = setInterval(() => {
      if (this._statePollBusy || !this.connected) return;
      this._statePollBusy = true;
      this.refresh(false)
        .catch(() => null)
        .finally(() => {
          this._statePollBusy = false;
        });
    }, this.statePollMs);
    if (typeof this._statePollTimer.unref === 'function') this._statePollTimer.unref();
    this.log.debug(`state poll every ${this.statePollMs}ms`);
  }

  _stopStatePoll() {
    if (this._statePollTimer) {
      clearInterval(this._statePollTimer);
      this._statePollTimer = null;
    }
    this._statePollBusy = false;
  }

  /**
   * Strict refresh result: keeps the old `refresh()` contract (return snapshot, tolerate
   * errors) while giving the perception cache a way to distinguish success from a stale
   * fallback.
   */
  async refreshStrict(force = false) {
    if (!force && this._snapshot && Date.now() - this._snapshotAt < this._snapshotTtlMs) {
      return { ok: true, cached: true, state: this._snapshot };
    }
    try {
      const state = await this.request('/state', { timeoutMs: 4000 });
      this._snapshot = state;
      this._snapshotAt = Date.now();
      this._snapshotVersion += 1;
      this.connected = true;
      this._lastRefreshErrorAt = null;
      this._lastRefreshError = null;
      return { ok: true, cached: false, state };
    } catch (err) {
      this.lastError = err;
      this._lastRefreshErrorAt = Date.now();
      this._lastRefreshError = err.message;
      return { ok: false, cached: false, state: this._snapshot, error: err.message };
    }
  }

  /** Refresh the cached snapshot if it is stale. */
  async refresh(force = false) {
    const result = await this.refreshStrict(force);
    return result.state || this._snapshot;
  }

  /**
   * Lightweight follow poll: `GET /state?players=1` returns only ready/dimension/position/
   * players, skipping the 40817-cell block scan, inventory and entity scans.
   *
   * It deliberately does NOT replace `_snapshot`: that would erase the block scan the A*
   * pathfinder needs. The caller uses the returned state directly. An older mod ignores
   * the query and returns the full snapshot, which still works (just not cheaper).
   */
  async refreshPlayers() {
    try {
      const state = await this.request('/state?players=1', { timeoutMs: 1500 });
      if (!state || state.ready !== true) {
        return { ok: false, state, error: 'client is not ready' };
      }
      this.connected = true;
      return { ok: true, state };
    } catch (err) {
      this.lastError = err;
      return { ok: false, state: null, error: err.message };
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
    const snap = {
      ready: true,
      body: this.kind,
      position: state.position,
      yaw: typeof state.yaw === 'number' ? state.yaw : null,
      pitch: typeof state.pitch === 'number' ? state.pitch : null,
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
      /** What the crosshair points at, straight from the game's own raycast. */
      target:
        state.target && state.target.name
          ? {
              name: state.target.name,
              position: state.target.position,
              face: state.target.face,
              distance: state.target.distance
            }
          : null,
      time: state.time,
      weather: state.weather,
      inventory: state.inventory || {},
      emptySlots: state.emptySlots,
      heldItem: state.heldItem && state.heldItem !== 'null' ? state.heldItem : null,
      standingOn: state.standingOn ? { name: state.standingOn, position: below(state.position) } : null,
      lightLevel: Number.isFinite(state.lightLevel) ? state.lightLevel : 15,
      /** Torch-side light (block light); null on older mods that do not report it. */
      blockLight: Number.isFinite(state.blockLight) ? state.blockLight : null,
      hostiles: state.hostiles || [],
      /** TACZ guns carried, for the gun picker (see the shoot skill). */
      guns: Array.isArray(state.guns) ? state.guns : [],
      nearbyItems: state.itemDrops || [],
      /** Crops with growth stages (mod-side block-state scan), used by farming. */
      crops: Array.isArray(state.crops) ? state.crops : [],
      /** Fishing bobber state: { cast, biting, x, y, z, id } or null when no rod is out. */
      fishing: state.fishing && state.fishing.cast === true ? state.fishing : null,
      /** Durability of the held item, when the mod reports it (used to notice a breaking rod). */
      heldDurability:
        state.heldDurability && Number.isFinite(state.heldDurability.max)
          ? { remaining: state.heldDurability.remaining, max: state.heldDurability.max }
          : null,
      /**
       * Players as objects, not names: PvP gunfire needs the entity `id` to aim at
       * (the shoot verb addresses entities by id). `distance` saves a recompute for
       * every consumer that only wants "is the operator nearby".
       */
      players: (state.players || []).map((p) => ({
        name: p.name,
        id: p.id,
        position: p.position,
        distance: p.distance,
        health: p.health
      })),
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
    /**
     * Stamp with the last successful refresh, not `Date.now()`: mapping is cheap, but the
     * underlying data is as old as `_snapshotAt`. When the mod has not answered yet, fall
     * back to "now" (the snapshot is still the only data we have).
     */
    return stampSnapshot(snap, {
      now: this._snapshotAt || Date.now(),
      fields: OBSERVED_FIELDS
    });
  }

  /**
   * A10: per-field freshness as the HTTP layer and action guards consume it.
   *
   * `stale` is derived from age, not from `connected`: the poller keeps retrying after a
   * disconnect, but the snapshot must still be marked stale rather than silently fresh.
   */
  freshness(now = Date.now()) {
    const snap = this.snapshot();
    const stale = snap ? staleFields(snap, this.freshnessBudget, now) : [];
    return {
      observedAt: (snap && snap.observedAt) || null,
      staleFields: stale,
      stale: stale.length > 0,
      connected: this.connected,
      degraded: !!(this._lastRefreshErrorAt && (!this._snapshotAt || this._lastRefreshErrorAt > this._snapshotAt)),
      lastRefreshAt: this._snapshotAt || null,
      version: this._snapshotVersion,
      lastError: this._lastRefreshError || null
    };
  }

  /** Stale position/health fields under the action budget. */
  actionStaleFields(now = Date.now()) {
    const snap = this.snapshot();
    if (!snap) {
      return [{ field: 'snapshot', ageMs: Infinity, budgetMs: this.actionFreshnessMs }];
    }
    return staleFields(
      snap,
      { position: this.actionFreshnessMs, health: this.actionFreshnessMs },
      now
    );
  }

  /** Human-readable reason, or null when the cached state is fresh enough to act on. */
  staleActionReason(now = Date.now()) {
    const stale = this.actionStaleFields(now);
    if (!stale.length) return null;
    const fields = stale.map((entry) => `${entry.field} age=${Number.isFinite(entry.ageMs) ? Math.round(entry.ageMs) : 'inf'}ms>${entry.budgetMs}ms`);
    return `stale state: ${fields.join(', ')}`;
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
    const stale = this.staleActionReason();
    if (stale) {
      this.lastMove = { ok: false, reason: stale, target: { ...position }, from: null, ms: 0 };
      this.log.warn(`moveTo refused: ${stale}`);
      return false;
    }

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
        /**
         * Only a container screen may be closed by the agent. Everything else - chat, the
         * Escape/pause menu, options, and any screen whose class name we do not recognise as a
         * container - is waited on, never dismissed.
         *
         * "Do not recognise" is the important half. The previous version was a denylist, so an
         * unknown screen was closed by default; that is how a modded text-input screen loses
         * whatever the player was typing. Waiting costs a stall the operator can see, and the
         * failure is reported with the screen's name, which is recoverable. Closing their text
         * box is not.
         */
        const closable = ClientModBody.isContainerScreen(screen);
        const recovered = closable && this.autoCloseScreens
          ? await this._tryCloseScreen(screen)
          : await this._waitForScreenClose(this.chatWaitMs);
        if (!recovered) {
          this.lastMove = { ok: false, reason: 'screen-open', screen, target: { ...position }, ms: 0 };
          this.log.warn(
            `cannot walk: ${screen} is open in the game - ` +
              (closable ? 'close it first' : 'that screen is yours, so the agent will not touch it')
          );
          return false;
        }
      }
    }

    if (options.raw === true) return this._rawMoveTo(position, options);

    const snap = this.snapshot();
    const from = snap && snap.position;
    /**
     * `pathfind: true` skips the client's straight-line walker for near targets.
     *
     * The shortcut below is fine for ordinary walks, but a caller that must know whether a
     * route is actually walkable (the collect skill: a drop behind a wall has to come back
     * as "blocked", not as a body pressing into the wall) wants the planned route. Phrase
     * the hop inside `directRange` as a real A* plan instead.
     */
    if (options.pathfind !== true && from) {
      const flat = Math.hypot(position.x - from.x, position.z - from.z);
      if (flat < this.directRange && Math.abs(position.y - from.y) <= 1) {
        return this._rawMoveTo(position, options);
      }
    }

    const started = Date.now();
    let result;
    try {
      /**
       * `allowSwim: false` swaps in the dry navigator: shore work (fishing) must not route
       * through water. Everything else uses the normal one, still through this.navigator so
       * the plan audit can see the planner wiring.
       */
      if (options.allowSwim === false && options.allowManMade === true) {
        result = await this.dryManMadeNavigator.goTo(position, options);
      } else if (options.allowSwim === false) {
        result = await this.dryNavigator.goTo(position, options);
      } else if (options.allowManMade === true) {
        result = await this.manMadeNavigator.goTo(position, options);
      } else {
        result = await this.navigator.goTo(position, options);
      }
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
    /**
     * Second gate, and the one that actually holds.
     *
     * The caller already checks `isContainerScreen`, but this function is the only thing that
     * sends the `close` command, so the check lives here too: a future caller cannot reach the
     * verb for a screen that is not a container. The previous version guarded with a denylist
     * of human screens, which meant a screen outside that list was closable by default.
     */
    if (!ClientModBody.isContainerScreen(screen)) {
      this.log.info(`${screen || 'that screen'} is not a container - waiting instead of closing it`);
      return false;
    }
    this.log.info(`a container screen is open (${screen}) - closing it so the agent can move`);
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
    /**
     * `precise: true` keeps the coordinates untouched (the client parses doubles).
     *
     * Default callers think in cells, and the verb floors to the block corner, which the
     * client-side walker then uses as its aim point. A corner aim is a trap when the
     * approach starts laterally offset inside the source cell: the steer line converges
     * onto the corner and wedges the body against the neighbouring block row (live
     * 2026-10-12, the diagonal-sealed pocket: the bot stopped exactly half a body width
     * short, and both the raw and the planned attempt "arrived" without entering the
     * opened cell). A strict step can instead aim at the precise cell centre, giving the
     * approach a lateral component so the collision slide carries the body past the
     * corner instead of pressing into it.
     */
    const coord = (value) => {
      if (options.precise !== true) return String(Math.floor(value));
      const n = Number(value);
      return String(Number.isFinite(n) ? Number(n.toFixed(3)) : 0);
    };
    const sent = await this.command(`moveto ${coord(position.x)} ${coord(position.y)} ${coord(position.z)} ${range}`);
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
    if (!this._navigator) this._navigator = this._buildNavigator({});
    return this._navigator;
  }

  /**
   * Navigator that refuses to enter liquid.
   *
   * Shore work (fishing) must never wade: the walker is allowed to swim by default, so
   * "walk to the bank" could route straight through the pond. `moveTo(pos, { allowSwim:
   * false })` picks this one.
   */
  get dryNavigator() {
    if (!this._dryNavigator) this._dryNavigator = this._buildNavigator({ allowSwim: false });
    return this._dryNavigator;
  }

  /**
   * Navigator that may cross player-built ground and stays out of liquids.
   *
   * Walking to the operator's own bed means walking over their base - the default
   * `avoidManMade` guard (there to keep the bot off *other people's* roofs and farms)
   * makes that route unreachable, which is exactly how the fishing night-sleep failed.
   */
  get dryManMadeNavigator() {
    if (!this._dryManMadeNavigator) {
      this._dryManMadeNavigator = this._buildNavigator({ allowSwim: false, avoidManMade: false });
    }
    return this._dryManMadeNavigator;
  }

  /**
   * Navigator that may cross player-built ground and still swims.
   *
   * Farms and the operator's own base need this: `avoidManMade` alone (without
   * `allowSwim:false`) used to fall back to the default navigator and kept the guard on.
   */
  get manMadeNavigator() {
    if (!this._manMadeNavigator) {
      this._manMadeNavigator = this._buildNavigator({ avoidManMade: false });
    }
    return this._manMadeNavigator;
  }

  /**
   * Plan a walk without walking it - the query half of the route nouns (`!route plan`).
   *
   * Picks the same navigator `moveTo` would (dry / man-made variants) so the preview
   * matches the execution, then asks the planner for a path and moves nothing.
   */
  async plan(position, options = {}) {
    if (!position) {
      return { ok: false, status: 'bad-target', reason: 'no target given', waypoints: 0, distance: 0, nodes: 0, path: [] };
    }
    const navigator =
      options.allowSwim === false
        ? options.allowManMade === true
          ? this.dryManMadeNavigator
          : this.dryNavigator
        : options.allowManMade === true
          ? this.manMadeNavigator
          : this.navigator;
    return navigator.plan(position, options);
  }

  /** Build a navigator with the configured movement rules plus any overrides. */
  _buildNavigator(overrides) {
    const { ClientWorldAdapter } = require('../pathfinding/clientWorldAdapter');
    const { PathNavigator } = require('../pathfinding/navigator');

    const pathCfg = (this.cfg.agent && this.cfg.agent.pathfinding) || {};
    const safetyCfg = (this.cfg.agent && this.cfg.agent.safety) || {};
    this._world = new ClientWorldAdapter(this, { log: this.log });
    return new PathNavigator(this, {
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
      avoidManMade: safetyCfg.avoidManMade !== false,
      ...overrides
    });
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
    const stale = this.staleActionReason();
    if (stale) {
      this.lastError = stale;
      this.log.warn(`dig refused: ${stale}`);
      return false;
    }
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

  /**
   * Walk a planned tunnel as ONE continuous client action: hold forward, clear whatever
   * blocks the way, and jump only real one-block steps (the client controller checks the
   * step geometry and headroom before pressing jump, and reports the offending cell when
   * it gives up). This is the "dig while walking" primitive: no round trip per cell, no
   * stop-start between digging and stepping.
   *
   * @param {Array<{x:number,y:number,z:number}>} waypoints feet cells, in order
   * @param {object} [options] { timeoutMs }
   * @returns {Promise<{ok:boolean, reason:string|null, cell:object|null, block:string|null,
   *                     dugCells:Array<object>, ms:number}>}
   */
  async tunnel(waypoints, options = {}) {
    const list = (waypoints || []).map((w) => ({
      x: Math.floor(w.x),
      y: Math.floor(w.y),
      z: Math.floor(w.z)
    }));
    if (!list.length) {
      return { ok: false, reason: 'no waypoints', cell: null, block: null, dugCells: [], ms: 0 };
    }
    const stale = this.staleActionReason();
    if (stale) {
      return { ok: false, reason: stale, cell: null, block: null, dugCells: [], ms: 0 };
    }
    const started = Date.now();
    const timeoutMs = options.timeoutMs || Math.min(240000, 20000 * list.length);
    const cells = list.map((w) => `${w.x} ${w.y} ${w.z}`).join(' ');
    /**
     * Optional target protection: the controller stops before destroying a named block
     * (bare names) and reports `target_requires_acquisition` with the cell, so an
     * approach tunnel can never quietly eat the ore it is walking toward (C21).
     */
    const protect = options.protect && Array.isArray(options.protect.blocks)
      ? options.protect.blocks.map((name) => String(name || '').trim()).filter((n) => /^[A-Za-z0-9_:.-]+$/.test(n))
      : [];
    const args = protect.length ? `${cells} protect ${protect.join(',')}` : cells;
    const sent = await this.command(`tunnel ${args}`);
    if (!sent || sent.ok === false) {
      this.lastTunnel = { ok: false, reason: 'tunnel refused', cell: null, block: null, dugCells: [], target: list[list.length - 1], ms: Date.now() - started };
      return this.lastTunnel;
    }
    const ok = await this.awaitAction('tunnel', timeoutMs);
    const verdict = this.lastAction || {};
    this.lastTunnel = {
      ok,
      reason: ok ? null : verdict.reason || 'tunnel-failed',
      cell: verdict.cell || null,
      block: verdict.block || null,
      dugCells: Array.isArray(verdict.dugCells) ? verdict.dugCells : [],
      target: list[list.length - 1],
      ms: Date.now() - started
    };
    this.trace({ kind: 'tunnel', ...this.lastTunnel, waypoints: list.length });
    return this.lastTunnel;
  }

  /**
   * Pillar up: jump and place the held block under the feet, one block per hop. The caller
   * equips a scaffold block first. This is the move a 1-wide shaft needs - the stair climber
   * has no horizontal room and the walker cannot jump onto a block it is pressed against
   * (live 2026-10-10: the bot oscillated at one step until the run died).
   *
   * @param {number} count how many blocks to rise (1..64)
   * @param {object} [options] { timeoutMs }
   * @returns {Promise<{ok:boolean, reason:string|null, steps:number, cell:object|null, ms:number}>}
   */
  async pillar(count, options = {}) {
    const steps = Math.max(1, Math.min(64, Math.floor(Number(count) || 1)));
    const started = Date.now();
    const timeoutMs = options.timeoutMs || Math.min(90000, 6000 * steps + 8000);
    const stale = this.staleActionReason();
    if (stale) {
      return { ok: false, reason: stale, steps: 0, requested: steps, cell: null, ms: 0 };
    }
    /**
     * Never let a previous action's verdict stand in for this one's (plan §5.4.1): the
     * old code read whatever `lastAction` happened to hold and, worse, reported the
     * *requested* count as done when the client said nothing about `steps`.
     */
    this.lastAction = null;
    const sent = await this.command(`pillar ${steps}`);
    if (!sent || sent.ok === false) {
      this.lastPillar = { ok: false, reason: 'pillar refused', steps: 0, requested: steps, cell: null, ms: Date.now() - started };
      return this.lastPillar;
    }
    const ok = await this.awaitAction('pillar', timeoutMs);
    const verdict = this.lastAction && this.lastAction.action === 'pillar' ? this.lastAction : null;
    const reported = verdict && Number.isFinite(verdict.steps) ? verdict.steps : null;
    this.lastPillar = {
      /**
       * An explicit receipt is the only evidence of completion. A missing `steps` field
       * (old Mod, truncated progress payload) is reported as 0 performed - never padded
       * up to the requested count; the caller re-reads the world to decide what happened.
       */
      ok: !!ok && !!verdict && reported !== null,
      reason: ok
        ? verdict
          ? reported === null
            ? 'the client reported no pillar steps'
            : null
          : 'no pillar verdict from the client'
        : (verdict && verdict.reason) || 'pillar-failed',
      steps: reported === null ? 0 : Math.max(0, reported),
      requested: steps,
      cell: (verdict && verdict.cell) || null,
      start: (verdict && verdict.start) || null,
      end: (verdict && verdict.end) || null,
      placedCells: (verdict && verdict.placedCells) || [],
      detail: (verdict && verdict.detail) || null,
      ms: Date.now() - started
    };
    this.trace({ kind: 'pillar', ...this.lastPillar });
    return this.lastPillar;
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
          ? {
              action: progress.action || actionName,
              ok: done,
              reason: progress.reason || null,
              /** Structured failure location/block from the client controller (tunnel). */
              cell: progress.cell || null,
              block: progress.block || null,
              /** Steps completed, for the pillar controller. */
              steps: Number.isFinite(progress.steps) ? progress.steps : null,
              /** Per-hop location evidence the pillar controller reports (plan §5.4.1). */
              start: progress.start || null,
              end: progress.end || null,
              placedCells: Array.isArray(progress.placedCells) ? progress.placedCells : [],
              /** Free-form failure diagnostics (e.g. the pillar hop peak/held/floor line). */
              detail: progress.detail || null,
              /** Actual cells the client dug, for the mining ledger. */
              dugCells: Array.isArray(progress.dugCells) ? progress.dugCells : [],
              /** Rounds fired this burst (shoot/retreat controllers). */
              shots: Number.isFinite(progress.shots) ? progress.shots : null,
              /** True when every sight line to the target was covered (gunfire held). */
              blocked: progress.blocked === true,
              /** Gun diagnostics from the shoot/retreat controllers. */
              gunType: progress.gunType || null,
              magazine: Number.isFinite(progress.magazine) ? progress.magazine : null,
              distance: Number.isFinite(progress.distance) ? progress.distance : null,
              /**
               * Last TACZ ShootResult name (SUCCESS / NO_AMMO / IS_DRAWING / NOT_DRAW ...).
               * The live "gun equipped but zero rounds" hunt (2026-10-13) needs exactly
               * this: the burst can end with reason=timeout and zero shots, and the
               * result code is the only thing that says why.
               */
              lastResult: typeof progress.lastResult === 'string' && progress.lastResult ? progress.lastResult : null
            }
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
    const stale = this.staleActionReason();
    if (stale) {
      this.lastError = stale;
      this.log.warn(`place refused: ${stale}`);
      return false;
    }
    const face = faceName(faceVector);
    const res = await this.command(
      `place ${Math.floor(reference.x)} ${Math.floor(reference.y)} ${Math.floor(reference.z)} ${face} ${fullItemName(itemName)}`
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
    const stale = this.staleActionReason();
    if (stale) {
      this.lastError = stale;
      this.log.warn(`useOn refused: ${stale}`);
      return false;
    }
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
   * @param {object} [options] { button: 0|1, mode: 'pickup'|'quickmove'|'swap', waitMs, attempts }
   */
  async clickSlot(slot, options = {}) {
    const button = options.button === undefined ? 0 : options.button;
    const mode = options.mode || 'pickup';
    const waitMs = options.waitMs === undefined ? 150 : options.waitMs;
    /**
     * A container click can be silently dropped by the server (state-id race) while the
     * client answers "click sent". That is how the furnace ended up with an input stack
     * and no fuel: the fuel quick-move was acknowledged but nothing moved. Watch the menu
     * and send the click again when the screen did not change at all.
     *
     * The watch polls for up to `settleMs` instead of reading once: on this 150-mod
     * client a menu can lag a few hundred ms behind a click, and a single early read
     * would look like "nothing happened" and double-click.
     */
    const attempts = options.attempts === undefined ? 2 : Math.max(1, options.attempts);
    const settleMs = options.settleMs === undefined ? 600 : options.settleMs;
    let before = attempts > 1 ? await this.menu().catch(() => null) : null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const res = await this.command(`click ${slot} ${button} ${mode}`);
      if (!res || !res.ok) return false;
      if (!before || !before.open) {
        await sleep(waitMs);
        return true;
      }
      const deadline = Date.now() + Math.max(waitMs, settleMs);
      let changed = false;
      for (;;) {
        await sleep(Math.max(80, Math.min(waitMs, 200)));
        const after = await this.menu().catch(() => null);
        if (!after || !after.open) return true;
        if (menuSignature(after) !== menuSignature(before)) {
          changed = true;
          break;
        }
        if (Date.now() >= deadline) {
          before = after;
          break;
        }
      }
      if (changed) return true;
      if (attempt < attempts) {
        this.log.debug(`slot click ${slot} ${mode} changed nothing - retrying (attempt ${attempt})`);
      }
    }
    return true;
  }

  /**
   * Is this a screen the agent may close on its own?
   *
   * **An allowlist, deliberately.** The rule the operator set is "the text box and the Escape
   * menu belong to me" - and the honest reading of that is *only a plain container is ours to
   * close*. A denylist gets this backwards: anything it fails to recognise is treated as fair
   * game, so a screen the list missed gets dismissed mid-sentence.
   *
   * **No screen that takes typed text may appear here.** An anvil, a sign and a book are all
   * `ContainerScreen` subclasses in vanilla, and all three are places the player types - so
   * matching `anvil`/`sign`/`book` would close exactly the screens this list exists to protect.
   * They were in the first draft of this pattern, and the protocol test caught it. Anything
   * added later has to pass the same question: can a human be mid-sentence here?
   *
   * Container screens are otherwise safe because their contents return to the inventory, so
   * nothing is destroyed - and the agent only ever opens one itself (from the container,
   * crafting and smelting skills) before closing it again.
   *
   * The name is the vanilla/Forge screen class name, which the mod reports verbatim.
   */
  static isContainerScreen(screen) {
    const name = String(screen || '');
    if (!name || name === 'null') return false;
    return /(container|chest|furnace|smelt|craft|inventory|hopper|dispenser|dropper|shulker|barrel|brewing|beacon|enchant|grindstone|stonecutter|loom|cartography|smithing|merchant|villager|horse|minecart|boat|lectern|crafter)/i.test(
      name
    );
  }

  /**
   * Close the open container, if any.
   *
   * Kept for the container/crafting skills, which open a menu themselves and must put it away.
   * It is not a general "dismiss whatever is on screen": see `isContainerScreen`.
   */
  /**
   * Close a container screen before a reflex fight, not only when a walk needs it.
   *
   * Live GUI test 2026-10-18: a CraftingScreen stayed open for ~5s after a zombie entered
   * range because nothing tried to move until the shoot skill flanked; shots were blocked
   * and the bot died. Pause/chat/unknown screens remain human-owned and are refused.
   */
  async ensureCombatScreenClear() {
    const snap = this.snapshot();
    if (!snap || !snap.screenOpen) return true;
    const screen = snap.screen || 'a screen';
    if (!ClientModBody.isContainerScreen(screen) || !this.autoCloseScreens) {
      this.log.warn(`${screen} is open and not auto-closable - combat cannot start`);
      return false;
    }
    return this._tryCloseScreen(screen);
  }

  async closeMenu() {
    const res = await this.command('close');
    return !!(res && res.ok);
  }

  async equip(itemName) {
    const full = fullItemName(itemName);
    const first = await this.command(`select ${full}`);
    if (first && first.ok) return true;
    /**
     * The mod's `select` only searches the hotbar (that is where vanilla keeps the held
     * stack). An item sitting in the main inventory therefore "cannot be equipped" - which
     * is how a hoe in slot 26 turned six tilling clicks into wheat seeds on grass. Move it
     * into a spare hotbar slot with real menu clicks, then select it.
     */
    const menu = await this.menu().catch(() => null);
    if (!menu || !menu.open) return false;
    const wanted = bare(full);
    const source = (menu.slots || []).find(
      (slot) => slot.i >= 9 && slot.item && slot.item !== 'null' && bare(slot.item) === wanted
    );
    const hotbar = (menu.slots || []).filter((slot) => slot.i >= 36 && slot.i <= 44);
    const empty = hotbar.find((slot) => !slot.item || slot.item === 'null');
    /**
     * No free hotbar slot? Swap with the item that is currently held (its name is in the
     * snapshot), so the wanted stack takes its place and the held one lands in the bag.
     * Three ordinary pickup clicks: pick the wanted stack up, click the hotbar slot (that
     * swaps the cursor with it), then drop the old hotbar item into the now-empty bag slot.
     */
    const heldName = this._snapshot && this._snapshot.heldItem ? bare(this._snapshot.heldItem) : null;
    const heldSlot = heldName ? hotbar.find((slot) => slot.item && bare(slot.item) === heldName) : null;
    const target = empty || heldSlot || hotbar[hotbar.length - 1];
    if (!source || !target) return false;
    if (empty) {
      await this.clickSlot(source.i, { mode: 'pickup', button: 0 });
      await this.clickSlot(empty.i, { mode: 'pickup', button: 0 });
    } else {
      await this.clickSlot(source.i, { mode: 'pickup', button: 0 });
      await this.clickSlot(target.i, { mode: 'pickup', button: 0 });
      await this.clickSlot(source.i, { mode: 'pickup', button: 0 });
    }
    const again = await this.command(`select ${full}`);
    return !!(again && again.ok);
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

  /**
   * Use the held item in the air: cast/reel a fishing rod, throw a snowball, milk a cow.
   *
   * `holdMs` keeps the use key down (bow drawing, eating); a cast/reel is one instant use.
   */
  async useItem(holdMs) {
    const res = await this.command(holdMs ? `use ${Math.floor(holdMs)}` : 'use');
    return !!(res && res.ok);
  }

  /** Eat: select a food item and use it (holding right-click). */
  async consume(itemName) {
    if (itemName) {
      const selected = await this.equip(itemName);
      if (!selected) return false;
    }
    /**
     * Eating is a held action: "use 2500" holds the use key until the food is gone. A bare
     * "use" (one useItem call) only plays the animation - the live bug was the bot standing
     * there "clicking bread" and never getting fed.
     */
    const res = await this.command('use 2500');
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
    const stale = this.staleActionReason();
    if (stale) {
      this.lastAction = { action: 'attack', ok: false, reason: stale };
      this.log.warn(`attack refused: ${stale}`);
      return false;
    }
    const timeoutMs = options.timeoutMs || 15000;
    const res = await this.command(`attack ${id} ${timeoutMs}`);
    return !!(res && res.ok);
  }

  /** Trigger one explicit TACZ reload of the held gun. */
  async reload() {
    const res = await this.command('reload');
    return !!(res && res.ok);
  }

  /**
   * Fire the held TACZ gun at an entity: ONE bounded burst of ≤maxShots rounds.
   *
   * The client aims until the scope is ready, re-faces the target every tick (recoil
   * compensation), holds fire when every sight line is covered, and reloads when the
   * magazine runs dry. The agent re-evaluates range/ammo/cover between bursts
   * (docs/COMBAT-PLAN.md); the verdict lands on `lastAction` like the other
   * continuous actions, with `shots`/`blocked`/`gunType`/`reason` attached.
   */
  async shoot(entity, options = {}) {
    if (!entity) return false;
    const id = entity.id !== undefined ? entity.id : entity._entity && entity._entity.id;
    if (id === undefined) return false;
    const stale = this.staleActionReason();
    if (stale) {
      this.lastAction = { action: 'shoot', ok: false, reason: stale, shots: null, blocked: false };
      this.log.warn(`shoot refused: ${stale}`);
      return false;
    }
    const ms = Math.floor(options.ms || options.maxMs || 8000);
    const maxShots = Math.floor(options.maxShots || 6);
    const res = await this.command(`shoot ${id} ${ms} ${maxShots}`);
    if (!res || res.ok === false) {
      this.lastAction = {
        action: 'shoot',
        ok: false,
        reason: (res && res.error) || 'the client refused the shoot',
        shots: null,
        blocked: false
      };
      return false;
    }
    return this.awaitAction('shoot', ms + 3000);
  }

  /**
   * Back away from an entity while facing it, optionally firing the held gun.
   *
   * Fire-and-forget on purpose: the reflex renews it every few seconds and cancels with
   * `stop()` once the danger has passed (the client action self-expires as the last
   * backstop). `fire` only takes effect with a TACZ gun actually in the main hand.
   */
  async retreatFrom(entity, options = {}) {
    if (!entity) return false;
    const id = entity.id !== undefined ? entity.id : entity._entity && entity._entity.id;
    if (id === undefined) return false;
    const ms = Math.floor(options.ms || 3000);
    const fire = options.fire === true ? 1 : 0;
    const res = await this.command(`retreat ${id} ${ms} ${fire}`);
    return !!(res && res.ok);
  }

  /** Cancel any continuous client action (walk / dig / tunnel / pillar / shoot / retreat). */
  async stop() {
    this.stopContinuous('stop');
    return true;
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

  /** Set absolute view angles (degrees); 0 pitch is level, positive looks down. */
  async look(yaw, pitch = 0) {
    const res = await this.command(`look ${Number(yaw) || 0} ${Number(pitch) || 0}`);
    return !!(res && res.ok);
  }

  /**
   * What is under the crosshair right now?
   *
   * Prefers a fresh raycast (`target` command); falls back to whatever the last /state
   * reported. Returns null when looking at air or outside reach.
   */
  async targetBlock() {
    const res = await this.command('target').catch(() => null);
    if (res && res.target && res.target.name) {
      return {
        name: res.target.name,
        position: res.target.position,
        face: res.target.face,
        distance: res.target.distance
      };
    }
    const snap = this.snapshot();
    return snap ? snap.target || null : null;
  }

  /**
   * "Look around" like a player does: sweep the view in equal steps and report the first
   * crosshair target that matches, or null.
   *
   * This is the free-view search the live feedback asked for - the agent should not walk
   * (and jump) to a scanned coordinate when the block it wants is two metres away and
   * simply out of view.
   *
   * @param {object} [options] { steps, pitch, filter, settleMs }
   * @returns {Promise<{name:string,position:object}|null>}
   */
  async sweepLook(options = {}) {
    const steps = Math.max(2, Math.min(24, options.steps || 8));
    const pitch = options.pitch === undefined ? 30 : options.pitch;
    const settleMs = options.settleMs === undefined ? 120 : options.settleMs;
    const filter = typeof options.filter === 'function' ? options.filter : () => true;
    const startYaw = (this._snapshot && Number(this._snapshot.yaw)) || 0;
    for (let i = 0; i < steps; i += 1) {
      const yaw = startYaw + Math.round((360 / steps) * i);
      await this.look(yaw, pitch).catch(() => false);
      await sleep(settleMs);
      const target = await this.targetBlock().catch(() => null);
      if (target && filter(target)) return target;
    }
    return null;
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
