'use strict';

/**
 * Navigation + interaction primitives shared by every task.
 *
 * All movement goes through mineflayer-pathfinder with movements configured for a
 * *survival* bot: no digging through the world unless explicitly enabled, parkour
 * off, and a hard timeout so a stuck path can never freeze the whole agent.
 */

const { isPassable, countItem, bestTool } = require('../world/items');
const { Logger } = require('../util/logger');

class Navigator {
  constructor(controller) {
    this.controller = controller;
    this.cfg = controller.cfg;
    this.log = new Logger('nav');
    this.pathfinder = null;
    this.movements = null;
    this.busy = false;
    this.stuckCount = 0;
    this.lastError = null;
    this.interrupted = null;
    this.armed = false;
  }

  get bot() {
    return this.controller.bot;
  }

  get available() {
    return !!(this.bot && this.bot.pathfinder);
  }

  /** (Re)build the Movements profile; call after a version change or plugin load. */
  refreshMovements(options = {}) {
    if (!this.available) return null;
    const { Movements } = require('mineflayer-pathfinder');
    const movements = new Movements(this.bot);
    movements.canDig = options.canDig === true;
    movements.allow1by1towers = true;
    movements.allowParkour = options.allowParkour === true;
    movements.allowSprinting = true;
    movements.maxDropDown = 4;
    movements.dontMineUnderFallingBlock = true;
    movements.canOpenDoors = true;
    movements.scafoldingBlocks = this.scaffoldingItems();
    this.movements = movements;
    this.bot.pathfinder.setMovements(movements);
    return movements;
  }

  scaffoldingItems() {
    if (!this.bot || !this.bot.registry) return [];
    const ids = [];
    for (const name of ['dirt', 'cobblestone', 'oak_planks', 'netherrack', 'sand', 'gravel']) {
      const item = this.bot.registry.itemsByName[name];
      if (item) ids.push(item.id);
    }
    return ids;
  }

  /** Stop any in-flight pathfinding. */
  stop() {
    if (this.available) {
      try {
        this.bot.pathfinder.stop();
      } catch {
        /* ignore */
      }
    }
    this.busy = false;
  }

  /**
   * Stop for a *reason* (reflex, rescue, shutdown) and remember that the rejection
   * we are about to receive is expected rather than a navigation failure.
   */
  interrupt(reason = 'preempted') {
    this.interrupted = reason;
    this.stop();
  }

  /**
   * Walk to a world position.
   *
   * Handles the three classic mineflayer-pathfinder failure modes:
   *   1. the internal `stopPathing` flag latches and every goto() rejects instantly
   *      (it even starts latched on a fresh bot) - cleared via controller.rearmPathfinder()
   *   2. goto() resolves with an *empty* path and the bot never moves
   *   3. the goal is already satisfied - return immediately instead of asking A*
   *
   * @returns {Promise<boolean>} true when the goal was reached
   */
  async goto(position, options = {}) {
    if (!this.available) {
      this.log.warn('pathfinder plugin missing - falling back to look-at movement');
      return this.crudeMove(position, options.timeoutMs || 8000);
    }
    const { goals } = require('mineflayer-pathfinder');
    const timeoutMs = options.timeoutMs || 30000;
    const range = options.range === undefined ? 1 : options.range;
    const goal = options.goal || new goals.GoalNear(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z), range);
    const entity = this.bot.entity;
    if (!entity) return false;

    // Already there: A* would emit an empty path and reject, which is not a failure.
    try {
      if (goal.isEnd && goal.isEnd(entity.position)) return true;
    } catch {
      /* isEnd is best-effort */
    }

    if (!this.movements || options.freshMovements) this.refreshMovements(options);
    // A latched pathfinder rejects everything: make sure it is armed first.
    if (!this.armed) {
      await this.controller.rearmPathfinder();
      this.armed = true;
    }

    const start = entity.position.clone();
    let lastStatus = 'unknown';
    const onUpdate = (r) => {
      lastStatus = r.status;
    };
    this.bot.on('path_update', onUpdate);

    this.busy = true;
    this.interrupted = null;
    try {
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`goto timeout after ${timeoutMs}ms`)), timeoutMs))
      ]);

      const now = this.bot.entity ? this.bot.entity.position : null;
      const moved = now ? start.distanceTo(now) : 0;
      const reached = goal.isEnd ? goal.isEnd(this.bot.entity.position) : true;
      if (!reached && moved < 1) {
        this.lastError = new Error(`path was empty (status=${lastStatus}); bot did not move`);
        this.stuckCount += 1;
        this._warnOnce(`noop|${fmtGoal(position)}`, `goto ${fmtGoal(position)} no-op: status=${lastStatus}, moved ${moved.toFixed(2)} blocks`);
        return false;
      }
      this.stuckCount = 0;
      return reached;
    } catch (err) {
      if (this.interrupted) {
        this.log.debug(`goto ${fmtGoal(position)} interrupted by ${this.interrupted}`);
        return false;
      }

      // Latched stop flag: re-arm once and retry, instead of degrading the session.
      if (/Path was stopped before it could be completed/i.test(err.message)) {
        if (!options._retried) {
          this._warnOnce(`latch|${fmtGoal(position)}`, `pathfinder was latched; re-arming and retrying ${fmtGoal(position)}`);
          const ok = await this.controller.rearmPathfinder();
          this.armed = ok;
          if (ok) return this.goto(position, { ...options, _retried: true });
        }
        this.log.warn(`goto ${fmtGoal(position)} could not be armed; skipping this target`);
        return false;
      }

      this.lastError = err;
      if (start && this.bot.entity && start.distanceTo(this.bot.entity.position) < 1) this.stuckCount += 1;
      // warn (not debug): a silently failing path is the single most common reason
      // an agent "does nothing", so it must be visible - but rate-limited per spot,
      // because a stuck bot retries the same goal many times per second.
      this._warnOnce(`${fmtGoal(position)}|${err.message.slice(0, 40)}`, `goto ${fmtGoal(position)} failed: ${err.message}`);
      return false;
    } finally {
      this.bot.removeListener('path_update', onUpdate);
      this.busy = false;
    }
  }

  /** Collapse repeated identical warnings within a short window. */
  _warnOnce(key, message, windowMs = 5000) {
    const now = Date.now();
    const last = this._warnCache && this._warnCache.get(key);
    if (last && now - last < windowMs) {
      this._suppressed = (this._suppressed || 0) + 1;
      return;
    }
    if (!this._warnCache) this._warnCache = new Map();
    this._warnCache.set(key, now);
    const extra = this._suppressed ? ` (${this._suppressed} similar messages suppressed)` : '';
    this._suppressed = 0;
    this.log.warn(`${message}${extra}`);
    if (this._warnCache.size > 200) this._warnCache.clear();
  }

  /**
   * True when the last few navigations all failed without moving - the signal that
   * the bot needs to be physically rescued (see core/recovery.js).
   */
  get looksStuck() {
    return this.stuckCount >= 2;
  }

  /** Walk to a block, optionally digging it first if it is in the way (pathfinder handles that). */
  gotoBlock(block, options = {}) {
    return this.goto(block.position, { ...options, range: options.range || 1 });
  }

  /** Get close enough to interact with a block (containers/crafting tables need ~3 blocks). */
  gotoTouchable(block, options = {}) {
    return this.goto(block.position, { ...options, range: options.range || 2, timeoutMs: options.timeoutMs || 25000 });
  }

  /**
   * Emergency fallback: rotate the bot toward a point and hold forward for a while.
   * Used only when the pathfinder plugin is unavailable.
   */
  async crudeMove(position, durationMs) {
    if (!this.bot || !this.bot.entity) return false;
    const target = position.clone ? position.clone() : position;
    const dir = target.minus(this.bot.entity.position);
    const yaw = Math.atan2(-dir.x, -dir.z);
    await this.bot.look(yaw, 0, true).catch(() => {});
    this.bot.setControlState('forward', true);
    await sleep(durationMs);
    this.bot.setControlState('forward', false);
    return this.bot.entity.position.distanceTo(target) < 3;
  }

  /** Jump once (used to escape a 1-block hole). */
  async jump() {
    if (!this.bot) return;
    this.bot.setControlState('jump', true);
    await sleep(220);
    this.bot.setControlState('jump', false);
  }
}

/**
 * Dig a block, choosing the best tool first and waiting for the block to actually break.
 * @returns {Promise<boolean>}
 */
async function digBlock(controller, block, options = {}) {
  const log = options.log || new Logger('dig');
  const bot = controller.bot;
  if (!bot || !block) return false;
  const timeoutMs = options.timeoutMs || 15000;

  try {
    const current = bot.blockAt(block.position);
    if (!current || current.name === 'air') return true;

    if (bot.tool && bot.tool.equipForBlock) {
      await bot.tool.equipForBlock(current).catch(() => {});
    } else {
      const pick = bestTool(bot, 'pickaxe');
      if (pick) {
        const item = bot.inventory.items().find((i) => i.name === pick.name);
        if (item) await bot.equip(item, 'hand').catch(() => {});
      }
    }

    const done = new Promise((resolve) => {
      const onGone = (oldBlock) => {
        if (oldBlock && oldBlock.position.equals(current.position)) {
          bot.removeListener('blockUpdate', onGone);
          resolve(true);
        }
      };
      bot.on('blockUpdate', onGone);
      setTimeout(() => {
        bot.removeListener('blockUpdate', onGone);
        resolve(false);
      }, timeoutMs);
    });

    await bot.dig(current, options.forceLook === true);
    return await done;
  } catch (err) {
    log.debug(`dig failed for ${block.name}: ${err.message}`);
    return false;
  }
}

/** Walk over and pick up nearby dropped items. */
async function collectNearbyDrops(controller, navigator, radius = 6, attempts = 6) {
  const { WorldView } = require('../world/worldView');
  const view = new WorldView(controller);
  for (let i = 0; i < attempts; i += 1) {
    const drops = view.nearbyItemEntities(radius);
    if (!drops.length) return;
    const target = drops[0];
    await navigator.goto(target.position, { range: 0, timeoutMs: 8000 });
    await sleep(250);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtGoal(position) {
  if (!position) return '(null)';
  const x = position.x !== undefined ? position.x : '?';
  const y = position.y !== undefined ? position.y : '?';
  const z = position.z !== undefined ? position.z : '?';
  return `(${Number(x).toFixed(1)}, ${Number(y).toFixed(1)}, ${Number(z).toFixed(1)})`;
}

/** Try to place a block against a reference block face. */
async function placeBlockAgainst(controller, itemName, referenceBlock, faceVector) {
  const bot = controller.bot;
  if (!bot || !referenceBlock) return false;
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) return false;
  try {
    await bot.equip(item, 'hand');
    await bot.placeBlock(referenceBlock, faceVector);
    return true;
  } catch {
    return false;
  }
}

/** Equip the best available tool for a given kind. */
async function equipBest(controller, kind) {
  const bot = controller.bot;
  const best = bestTool(bot, kind);
  if (!best) return false;
  const item = bot.inventory.items().find((i) => i.name === best.name);
  if (!item) return false;
  try {
    await bot.equip(item, 'hand');
    return true;
  } catch {
    return false;
  }
}

function hasItem(bot, name, count = 1) {
  return countItem(bot, name) >= count;
}

module.exports = {
  Navigator,
  digBlock,
  collectNearbyDrops,
  placeBlockAgainst,
  equipBest,
  hasItem,
  isPassable,
  sleep
};
