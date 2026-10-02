'use strict';

/**
 * HarvestTask: the shared "find -> walk -> break -> collect -> repeat" skeleton
 * (P0-PLAN §6.1).
 *
 * The three primitives of P0 are walk / break / collect, and this class is where all
 * three are wired together. `ChopWoodTask` and `MineBlockTask` differ only in which
 * blocks they consider targets, so everything else lives here.
 *
 * The behaviour that is NOT obvious, and that each of these rules was paid for with a
 * real bug:
 *
 *   1. **Count drops, not swings.** `collected` is an *inventory delta*, not a count of
 *      successful `dig()` calls. Mining stone bare-handed destroys the block and drops
 *      nothing, so a dig-counting task reports success while the bag stays empty.
 *   2. **Zero harvest is success.** On a map with no trees nearby, failing makes the
 *      planner re-queue the identical goal forever. Reporting "nothing here" lets it
 *      move on. Progress that falls short of the target *is* a failure, because that
 *      means the area had resources and we fumbled them.
 *   3. **A full inventory fails early.** Otherwise the bot digs, the drops despawn
 *      uncollected, and the loop runs until the timeout with nothing to show.
 *   4. **Unreachable targets are remembered.** `noPath` on one tree must not stop the
 *      task; it must try the next one. Re-testing the same unreachable block every
 *      iteration is what made the old implementation wander in place.
 *   5. **Wait before concluding "nothing here".** Right after connecting, the block scan
 *      is still filling in, and a premature empty result looks exactly like a bare world.
 */

const { Task } = require('./task');
const { sleep } = require('../core/movement');
const { manMadeReason } = require('../world/safety');

/** Drops further than this below the bot are skipped rather than chased off a cliff. */
const MAX_DROP_Y_DELTA = 2;

class HarvestTask extends Task {
  constructor(ctx, options = {}) {
    super(ctx, {
      name: options.name || 'harvest',
      description: options.description || `harvest ${options.count || 8}`,
      timeoutMs: options.timeoutMs || 180000
    });
    /** Requested quantity. `this.count` is a number, hence `countItem()` on Task. */
    this.target = options.count || 8;
    this.searchRadius = options.searchRadius || 48;
    /** Successful harvests, measured as an inventory delta (see note 1 above). */
    this.collected = 0;
    /** Blocks we could not reach, so the loop stops retrying them. */
    this.failedTargets = [];
    /** Blocks refused because they are player-built, kept for the log and the panel. */
    this.refusedTargets = [];
    /** When false, the man-made check is skipped (offline worlds, private test servers). */
    this.avoidManMade = options.avoidManMade !== false;
    /** How many consecutive target picks failed to move us anywhere. */
    this.consecutiveFailures = 0;
    this.perTargetTimeoutMs = options.perTargetTimeoutMs || 20000;
    this.iterationGuard = options.iterationGuard || 60;
    /** How long to wait before believing "there is nothing here" (rule 5). */
    this.warmupMs = options.warmupMs === undefined ? 3000 : options.warmupMs;
    /** How many short legs to walk when a scan comes back empty. */
    this.roamsLeft = options.roamSteps === undefined ? 4 : options.roamSteps;
    this.roamStep = options.roamStep || 12;
    this.roamTimeoutMs = options.roamTimeoutMs || 20000;
    this.roamCount = 0;
    /** Blocks broken successfully; used in the success message. */
    this.breakCount = 0;
  }

  // ------------------------------------------------------------- subclass API

  /** @param {string} name block name, namespaced or bare @returns {boolean} */
  isTarget() {
    throw new Error(`${this.name}.isTarget() not implemented`);
  }

  /** Last-resort safety gate for blocks that look like targets. */
  canHarvest() {
    return true;
  }

  /**
   * Optional follow-up after a block breaks: dig the rest of the column, take the whole
   * tree, etc. Default is nothing - a stone vein is happy with one block at a time.
   *
   * @param {{name:string, position:{x:number,y:number,z:number}}} block
   */
  async afterBreak() {
    /* optional */
  }

  /** Item names that count toward `collected`; defaults to "anything isTarget()". */
  countsAsHarvest(itemName) {
    return this.isTarget(itemName);
  }

  // ------------------------------------------------------------------ progress

  progress() {
    return this.collected;
  }

  /** Refresh `collected` from the inventory, so drops that landed count immediately. */
  updateCollected() {
    const now = this.countWhere((name) => this.countsAsHarvest(name));
    this.collected = Math.max(0, now - this.baseline);
    return this.collected;
  }

  // ---------------------------------------------------------------------- run

  async run() {
    const { world, log } = this.ctx;
    const body = this.body;
    if (!body) return this.fail('no body attached');

    this.baseline = this.countWhere((name) => this.countsAsHarvest(name));

    // ---- perception warm-up ------------------------------------------------
    if (!this.findTargets().length) {
      log.info(`${this.name}: no target visible yet, waiting for world data`);
      await sleep(this.warmupMs);
      if (this.cancelled) return this.fail('cancelled');
    }

    let guard = 0;
    while (this.updateCollected() < this.target && guard < this.iterationGuard) {
      guard += 1;
      if (this.cancelled) return this.fail('cancelled');
      if (!body.isReady) return this.fail('body is gone');

      // ---- the inventory-full guard (note 3) ------------------------------
      const snap = this.world_state;
      if (snap && snap.emptySlots === 0 && !this.canPickUpMore()) {
        return this.fail(
          `inventory is full (${this.progress()}/${this.target} collected) - dropping or storing items is not part of P0`
        );
      }

      const candidates = this.findTargets();
      if (!candidates.length) {
        /**
         * Nothing in range: go and look somewhere else before giving up.
         *
         * The scan radius is 24 blocks, so "no dirt here" almost never means "no dirt
         * anywhere" - and a task that stops at the first empty scan leaves the agent standing
         * on a beach reporting that there is no dirt, forever, next to a hillside. Roaming a
         * few short legs is what a player does, and it exercises the pathfinder, which is the
         * whole point of the primitive.
         */
        if (this.roamsLeft > 0) {
          this.roamsLeft -= 1;
          const moved = await this.roam();
          if (moved) continue;
        }
        log.info(`${this.name}: no more targets in range`);
        break;
      }

      let brokeThisRound = 0;
      for (const candidate of candidates) {
        if (this.cancelled) return this.fail('cancelled');
        if (this.updateCollected() >= this.target) break;

        /**
         * Never break anything a player built.
         *
         * Checked per candidate, right before acting, because the block map is a snapshot:
         * the block may have been replaced since the scan, and the *current* identity is
         * what decides whether touching it is safe.
         */
        const veto = this.unsafeReason(candidate);
        if (veto) {
          this.refusedTargets.push({ position: candidate.position, name: candidate.name, why: veto });
          this.log.debug(`refusing ${candidate.name} at ${fmt(candidate.position)}: ${veto}`);
          this.failedTargets.push(candidate.position);
          continue;
        }

        if (!this.canHarvest(candidate)) {
          this.failedTargets.push(candidate.position);
          continue;
        }

        // ---- primitive 1: walk ------------------------------------------
        const reached = await this.approach(candidate);
        if (!reached) {
          // Note 4: remember it and try the next target instead of giving up.
          this.failedTargets.push(candidate.position);
          this.consecutiveFailures += 1;
          this.log.debug(
            `${this.name}: cannot reach ${candidate.name} at ${fmt(candidate.position)} ` +
              `(${this.failureReason()}) - skipping`
          );
          if (this.consecutiveFailures >= 3) {
            log.warn(`${this.name}: ${this.consecutiveFailures} targets in a row were unreachable`);
            break;
          }
          continue;
        }
        this.consecutiveFailures = 0;

        // A cancel can arrive while we were walking; do not swing the pick anyway.
        if (this.cancelled) return this.fail('cancelled');

        // ---- primitive 2: break -----------------------------------------
        const broke = await this.breakBlock(candidate);
        if (!broke) {
          this.failedTargets.push(candidate.position);
          this.log.debug(`${this.name}: could not break ${candidate.name} at ${fmt(candidate.position)}`);
          continue;
        }
        brokeThisRound += 1;

        // Subclass hook: a tree wants its whole trunk, an ore wants just the one block.
        await this.afterBreak(candidate).catch((err) => this.log.debug(`${this.name}: afterBreak threw: ${err.message}`));

        // ---- primitive 3: collect the drops ------------------------------
        await this.collectDrops({ radius: 6, attempts: 5 });
      }

      this.checkpoint();

      if (brokeThisRound === 0 && !this.findTargets().length && this.updateCollected() < this.target) {
        // Everything in range is now in failedTargets: stop rather than spin.
        break;
      }
    }

    // ---- verdict (note 2) --------------------------------------------------
    const have = this.updateCollected();
    if (have >= this.target) {
      return this.succeed(`collected ${have}/${this.target} ${this.unitName()} (${this.breakCount} blocks broken)`);
    }
    if (have === 0) {
      return this.succeed(
        `no ${this.unitName()} available nearby (still ${this.countWhere((n) => this.countsAsHarvest(n))} in inventory)`
      );
    }
    return this.fail(`only collected ${have}/${this.target} ${this.unitName()}`);
  }

  // ------------------------------------------------------------------ primitives

  /**
   * Primitive 1: walk to a target, using the pathfinding stack.
   *
   * `range: 1` rather than the body default: the mod's dig refuses beyond 4.5 blocks and
   * stops feeling reliable past ~3, so stopping "1 block away" is what makes the dig work
   * first try.
   *
   * @returns {Promise<boolean>}
   */
  async approach(target) {
    try {
      return await this.body.moveTo(target.position, { range: 1, timeoutMs: this.perTargetTimeoutMs });
    } catch (err) {
      this.log.debug(`${this.name}: moveTo threw: ${err.message}`);
      return false;
    }
  }

  /** Why the last approach failed, when the body can say (ClientModBody records it). */
  failureReason() {
    const body = this.body;
    if (body && body.lastMove && body.lastMove.reason) return body.lastMove.reason;
    return 'unreachable';
  }

  /**
   * Walk a short leg in a fresh direction, looking for targets.
   *
   * Distances stay well inside the 24-block scan radius so the next scan actually covers new
   * ground, and the direction rotates rather than being random - a deterministic sweep is
   * easier to reason about in a log, and two runs of the same task behave the same way.
   *
   * Several headings are tried before giving up: a single blocked direction is common (a
   * wall, a cliff, someone's fence) and treating it as "nowhere to go" left the agent
   * standing still while reporting that the world had no dirt in it.
   *
   * @returns {Promise<boolean>} whether the body moved
   */
  async roam() {
    const step = this.roamStep || 12;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const here = this.position;
      if (!here) return false;
      const angle = (this.roamCount * 137.5 * Math.PI) / 180; // golden-angle sweep
      this.roamCount += 1;
      const target = {
        x: Math.round(here.x + Math.cos(angle) * step),
        y: Math.round(here.y),
        z: Math.round(here.z + Math.sin(angle) * step)
      };
      this.log.info(`${this.name}: nothing in range, roaming to (${target.x},${target.z})`);
      try {
        const moved = await this.body.moveTo(target, { range: 3, timeoutMs: this.roamTimeoutMs || 20000 });
        if (moved) return true;
        this.log.debug(`${this.name}: roam leg to (${target.x},${target.z}) did not arrive (${this.failureReason()})`);
      } catch (err) {
        this.log.debug(`${this.name}: roam leg threw: ${err.message}`);
      }
    }
    return false;
  }

  /**
   * Is this target something a player built? Returns the reason, or null when it is safe.
   *
   * Re-reads the block so a build that appeared after the scan is still caught, and defers to
   * the subclass hook `extraSafetyCheck` for structural tests (a log is only a *tree* if it is
   * rooted in natural ground - see ChopWoodTask).
   */
  unsafeReason(block) {
    if (!this.avoidManMade) return null;
    const world = this.ctx.world;

    let current = block;
    if (world && typeof world.blockAtAbsolute === 'function') {
      const fresh = world.blockAtAbsolute(block.position);
      if (fresh) current = fresh;
    }

    const family = manMadeReason(current && current.name ? current.name : block.name);
    if (family) return `it is a ${family}`;

    return this.extraSafetyCheck(current) || null;
  }

  /** Subclass hook for structural safety checks. Returns a reason string, or null. */
  extraSafetyCheck() {
    return null;
  }

  /**
   * Primitive 2: break one block.
   *
   * Equips the right tool first. This is not cosmetic - mining stone with a bare hand in
   * Minecraft destroys the block and yields **no drop at all**, so digging without a
   * pickaxe looks like success and produces nothing. That is precisely the failure mode
   * rule 1 in the header exists to catch, and equipping prevents it.
   */
  async breakBlock(block) {
    const body = this.body;
    await this.equipFor(block);
    this.breakCount = (this.breakCount || 0) + 1;
    const ok = await body.dig(block, { timeoutMs: this.digTimeoutMs || 15000 }).catch((err) => {
      this.log.debug(`${this.name}: dig threw: ${err.message}`);
      return false;
    });
    if (!ok) this.breakCount -= 1;
    return ok;
  }

  /**
   * Put the right tool in hand before breaking a block.
   *
   * The default defers to the body ("pick whatever suits this block"), which is right for
   * tasks with no opinion - chopping a tree wants an axe, and the body knows its own
   * inventory. `MineBlockTask` overrides this because ore has a *hardness gate*: the tool
   * has to meet a minimum tier or the block drops nothing at all.
   *
   * @param {{name:string, position:object}} block
   * @returns {Promise<boolean|void>}
   */
  async equipFor(block) {
    const body = this.body;
    if (body && typeof body.equipForBlock === 'function') {
      return body.equipForBlock(block).catch(() => false);
    }
    return false;
  }

  /**
   * Primitive 3: pick up nearby drops by walking over them (P0-PLAN §6.4.1).
   *
   * Pickup itself is vanilla behaviour - the client collects any ItemEntity the player's
   * hitbox touches - so there is no "pickup" command to send. All we do is walk there.
   *
   * @returns {Promise<number>} how many items the inventory gained
   */
  async collectDrops(options = {}) {
    const radius = options.radius === undefined ? 6 : options.radius;
    const attempts = options.attempts === undefined ? 5 : options.attempts;
    const before = this.countWhere((name) => this.countsAsHarvest(name));

    for (let i = 0; i < attempts; i += 1) {
      if (this.cancelled) break;
      const drops = this.nearbyDrops(radius);
      if (!drops.length) break;

      const target = this.pickDrop(drops);
      if (!target) {
        this.log.debug(`${this.name}: drops are all out of reach vertically - skipping`);
        break;
      }

      const reached = await this.body
        .moveTo(target.position, { range: 1, timeoutMs: 8000 })
        .catch(() => false);
      if (!reached) this.log.debug(`${this.name}: could not reach ${target.name} at ${fmt(target.position)}`);

      // Give the client a tick to register the pickup.
      await sleep(options.settleMs === undefined ? 200 : options.settleMs);
    }

    const gained = this.countWhere((name) => this.countsAsHarvest(name)) - before;
    if (gained > 0) this.log.info(`${this.name}: picked up ${gained} (${this.updateCollected()}/${this.target})`);
    return gained;
  }

  /** Nearby item entities, via the world view so any Body works. */
  nearbyDrops(radius) {
    const world = this.ctx.world;
    if (!world || typeof world.nearbyItemEntities !== 'function') return [];
    return world.nearbyItemEntities(radius) || [];
  }

  /**
   * Choose which drop to chase.
   *
   * Drops more than 2 blocks below the bot are skipped outright: chasing one means
   * walking off a ledge or into a ravine for a single item, and the walk usually fails
   * anyway. Skipping is cheap; falling is not.
   */
  pickDrop(drops) {
    const here = this.position;
    if (!here) return null;
    const reachable = drops
      .filter((d) => d.position && Math.abs(d.position.y - here.y) <= MAX_DROP_Y_DELTA)
      .sort((a, b) => (a.distance || 0) - (b.distance || 0));
    return reachable.length ? reachable[0] : null;
  }

  // ------------------------------------------------------------------- helpers

  /** Target blocks in range, nearest first, minus the ones we already failed on. */
  findTargets() {
    const world = this.ctx.world;
    if (!world) return [];
    const found = world.findBlocksMatching
      ? world.findBlocksMatching((name) => this.isTarget(name), {
          maxDistance: this.searchRadius,
          count: 32
        })
      : [];
    return found.filter((block) => !this.isFailed(block.position));
  }

  isFailed(position) {
    if (!position) return true;
    return this.failedTargets.some(
      (p) => Math.floor(p.x) === Math.floor(position.x) && Math.floor(p.y) === Math.floor(position.y) && Math.floor(p.z) === Math.floor(position.z)
    );
  }

  /** Some inventories can still accept stacks of what we are collecting. */
  canPickUpMore() {
    return false;
  }

  unitName() {
    return 'items';
  }

  describe() {
    return `${this.name}: ${this.description}`;
  }
}

function fmt(position) {
  if (!position) return '(unknown)';
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

module.exports = { HarvestTask, MAX_DROP_Y_DELTA };
