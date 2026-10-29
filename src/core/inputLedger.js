'use strict';

/**
 * Input ledger: the one record of which keys the agent has pressed (M5, F1'b).
 *
 * The 2026-10-29 M5 decision moved the GUI/keyboard path from OS-level computer use to
 * the Minecraft client mod. That is safer in one structural way (input can only reach the
 * game, never another window) and riskier in another: a key pressed in-process can stay
 * pressed. A stuck `attack` keeps mining, a stuck `forward` keeps walking into lava.
 *
 * So every press goes through this table:
 *
 *   - `press/`hold` record the action; `release` clears it;
 *   - `releaseAll(reason)` is called on every "stop touching the world" signal (the Holds
 *     table: dead / paused / owner-stop / task) and on shutdown;
 *   - a Node-side deadline exists as a backstop, and the mod enforces its own cap too -
 *     two independent limits, because the failure we care about is *both* sides failing;
 *   - `sync(remoteHeld)` reconciles with the ledger the mod reports in `/state`, so a
 *     dropped HTTP reply cannot leave the two tables disagreeing forever.
 *
 * It is deliberately dumb: it does not decide what to press, only remembers what was
 * pressed and makes sure it can always be released.
 */

/** Longest a single Node-side hold is allowed to live before the ledger force-releases it. */
const MAX_HOLD_MS = 10_000;

/**
 * Release order. Attack/use first: those are the actions that change the world, and
 * releasing movement first would let a held attack keep running while the bot walks.
 */
const RELEASE_ORDER = [
  'attack',
  'use',
  'drop',
  'inventory',
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'sprint',
  'sneak'
];

const ALIASES = new Map([
  ['mine', 'attack'],
  ['hit', 'attack'],
  ['dig', 'attack'],
  ['shift', 'sneak'],
  ['crouch', 'sneak'],
  ['eat', 'use']
]);

const KNOWN = new Set(RELEASE_ORDER);

/** Normalise a key name; unknown names are rejected instead of silently ignored. */
function normaliseAction(action) {
  const name = String(action || '').trim().toLowerCase();
  if (!name) return null;
  if (KNOWN.has(name)) return name;
  const alias = ALIASES.get(name);
  return alias && KNOWN.has(alias) ? alias : null;
}

class InputLedger {
  /**
   * @param {object} deps
   * @param {object} deps.log logger (info/warn/debug)
   * @param {(action:string, down:boolean)=>Promise<any>} [deps.write] real press/release
   * @param {(action:string, ms:number)=>Promise<any>} [deps.writeHold] bounded hold
   * @param {()=>number} [deps.now] clock, injectable for tests
   * @param {number} [deps.maxHeld] refuse a new press beyond this many keys down
   */
  constructor(deps = {}) {
    this.log = deps.log || console;
    this.write = typeof deps.write === 'function' ? deps.write : null;
    this.writeHold = typeof deps.writeHold === 'function' ? deps.writeHold : null;
    this.now = typeof deps.now === 'function' ? deps.now : () => Date.now();
    this.maxHeld = Number.isFinite(deps.maxHeld) ? Math.max(1, deps.maxHeld) : 4;
    /** @type {Map<string,{since:number,until:number,reason:string|null}>} */
    this.held = new Map();
    this.releaseReasons = [];
    this.everPressed = 0;
  }

  /** True when the ledger has no key down; the state every stop path must reach. */
  isClear() {
    return this.held.size === 0;
  }

  /** Actions currently down, in release order (stable for logs and tests). */
  list() {
    const order = new Map(RELEASE_ORDER.map((name, index) => [name, index]));
    return [...this.held.entries()]
      .map(([action, entry]) => ({ action, since: entry.since, until: entry.until, reason: entry.reason }))
      .sort((a, b) => (order.get(a.action) ?? 99) - (order.get(b.action) ?? 99) || a.action.localeCompare(b.action));
  }

  _expired(entry) {
    return Number.isFinite(entry.until) && this.now() >= entry.until;
  }

  /** Drop entries whose deadline passed; returns the actions dropped. */
  expire() {
    const dropped = [];
    for (const [action, entry] of this.held) {
      if (this._expired(entry)) {
        this.held.delete(action);
        dropped.push(action);
      }
    }
    if (dropped.length) {
      this.log.warn(`input ledger: hold expired without release: ${dropped.join(', ')}`);
    }
    return dropped;
  }

  /**
   * Press a key.
   *
   * The press is recorded *before* the HTTP call resolves: if the call times out after the
   * client already applied it, forgetting the key would be worse than recording a press
   * that did not happen (releaseAll would then send a harmless extra release).
   */
  async press(action) {
    const name = normaliseAction(action);
    if (!name) throw new Error(`unknown key "${action}" (${RELEASE_ORDER.join('|')})`);
    this.expire();
    if (this.held.has(name)) return { ok: true, already: true, action: name };
    if (this.held.size >= this.maxHeld) {
      throw new Error(`input ledger full: ${this.held.size} keys already down (${this.list().map((k) => k.action).join(', ')})`);
    }
    const entry = {
      since: this.now(),
      until: this.now() + MAX_HOLD_MS,
      reason: null
    };
    this.held.set(name, entry);
    this.everPressed += 1;
    try {
      const result = await this._write(name, true);
      return { ok: true, action: name, result: result || null };
    } catch (err) {
      // The press may or may not have landed; keep it recorded and let releaseAll/expire
      // clean it up. Never pretend it did not happen.
      this.log.warn(`input ledger: press ${name} failed after being recorded: ${err.message}`);
      return { ok: false, action: name, error: err.message };
    }
  }

  /** Release a single key. Idempotent: releasing what is not held is not an error. */
  async release(action) {
    const name = normaliseAction(action);
    if (!name) throw new Error(`unknown key "${action}"`);
    const wasHeld = this.held.delete(name);
    try {
      const result = await this._write(name, false);
      return { ok: true, action: name, wasHeld, result: result || null };
    } catch (err) {
      if (wasHeld) this.held.set(name, { since: this.now(), until: this.now() + MAX_HOLD_MS, reason: 'release-failed' });
      this.log.warn(`input ledger: release ${name} failed: ${err.message}`);
      return { ok: false, action: name, wasHeld, error: err.message };
    }
  }

  /**
   * Bounded hold: press, let the caller's deadline (or the mod's own cap) release it.
   *
   * Recorded with a deadline so `expire()` can clean up if the client never confirms.
   */
  async hold(action, ms = 250) {
    const name = normaliseAction(action);
    if (!name) throw new Error(`unknown key "${action}"`);
    const bounded = Math.max(1, Math.min(Number.isFinite(Number(ms)) ? Number(ms) : 250, MAX_HOLD_MS));
    this.expire();
    if (this.held.size >= this.maxHeld && !this.held.has(name)) {
      throw new Error(`input ledger full: ${this.held.size} keys already down`);
    }
    this.held.set(name, { since: this.now(), until: this.now() + bounded + 500, reason: 'hold' });
    this.everPressed += 1;
    try {
      const result = await this._writeHold(name, bounded);
      return { ok: true, action: name, ms: bounded, result: result || null };
    } catch (err) {
      this.log.warn(`input ledger: hold ${name} failed after being recorded: ${err.message}`);
      return { ok: false, action: name, ms: bounded, error: err.message };
    }
  }

  /**
   * Release everything. This is the only path stop/death/disconnect need to call.
   *
   * Failures are reported but never throw: a stop path that throws is a stop path that
   * leaves keys down.
   */
  async releaseAll(reason = 'release-all') {
    this.releaseReasons.push({ reason: String(reason), at: this.now(), count: this.held.size });
    if (this.releaseReasons.length > 20) this.releaseReasons.shift();
    const actions = this.list().map((entry) => entry.action);
    if (!actions.length) return { ok: true, released: [], reason };
    this.held.clear();
    const failures = [];
    for (const action of actions) {
      try {
        await this._write(action, false);
      } catch (err) {
        failures.push({ action, error: err.message });
      }
    }
    if (failures.length) {
      this.log.warn(`input ledger: releaseAll(${reason}) could not release: ${failures.map((f) => f.action).join(', ')}`);
    } else {
      this.log.info(`input ledger: released ${actions.length} key(s) on ${reason}`);
    }
    return { ok: failures.length === 0, released: actions, failures, reason };
  }

  /**
   * Reconcile with the mod's own ledger (`/state.input.held`).
   *
   * The mod releases a hold on its own deadline; when that happens first, Node must drop
   * the entry too, otherwise releaseAll would chase keys that are already up.
   */
  sync(remoteHeld) {
    if (!Array.isArray(remoteHeld)) return { dropped: [] };
    const remote = new Set(remoteHeld.map((entry) => String(entry && entry.action ? entry.action : entry)));
    const dropped = [];
    for (const action of [...this.held.keys()]) {
      if (!remote.has(action)) {
        this.held.delete(action);
        dropped.push(action);
      }
    }
    return { dropped };
  }

  /** Status for `!inputs`, the panel and tests. */
  status() {
    this.expire();
    return {
      held: this.list(),
      count: this.held.size,
      clear: this.isClear(),
      everPressed: this.everPressed,
      maxHeld: this.maxHeld,
      lastReleases: this.releaseReasons.slice(-5)
    };
  }

  _write(action, down) {
    if (!this.write) return Promise.resolve(null);
    return Promise.resolve(this.write(action, down));
  }

  _writeHold(action, ms) {
    if (this.writeHold) return Promise.resolve(this.writeHold(action, ms));
    // No dedicated hold channel: approximate with press + a timer that releases. The mod
    // still caps the press, so a lost timer cannot hold forever.
    return this._write(action, true).then((result) =>
      new Promise((resolve) => {
        setTimeout(() => {
          this._write(action, false).then(() => resolve(result)).catch(() => resolve(result));
        }, ms).unref?.();
      })
    );
  }
}

module.exports = { InputLedger, normaliseAction, RELEASE_ORDER, MAX_HOLD_MS };
