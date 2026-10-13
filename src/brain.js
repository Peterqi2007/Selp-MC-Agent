'use strict';

/**
 * The brain: a reactive survival layer wrapped around a small goal-driven planner.
 *
 * Two loops:
 *   - FAST loop (every ~600ms): reflexes. Eat when hungry, run when nearly dead,
 *     fight what is biting us, escape lava. These can pre-empt anything.
 *   - SLOW loop (every cfg.idleThinkIntervalMs): planning. Look at the world and the
 *     inventory, then push the next useful task onto the queue.
 *
 * Priorities follow the classic survival progression used by open-source mineflayer
 * agents: wood -> crafting table -> tools -> stone -> coal/torches -> food ->
 * shelter at night -> storage. Each rule is a small, independently testable
 * function returning a task or null.
 */

const { ChopWoodTask } = require('./tasks/chopWood');
const { CraftTask } = require('./tasks/craft');
const { MineBlockTask } = require('./tasks/mineBlock');
const { MineOreTask } = require('./tasks/mineOre');
const { ShelterTask } = require('./tasks/shelter');
const { HuntTask } = require('./tasks/hunt');
const { LightTask } = require('./tasks/light');
const { DepositTask } = require('./tasks/deposit');
const { Logger } = require('./util/logger');
const { countItem, countMatching, isFood, isLog, bestTool, TOOL_TIERS } = require('./world/items');
const { SnapshotInventory } = require('./world/snapshotInventory');
const { sleep } = require('./core/movement');
const { Holds } = require('./core/holds');
const { needsRescue, escapeToGround, hideUnderground, isDaytime } = require('./core/recovery');

/** Priority levels for `enqueue` (P0-PLAN §5.7). Lower number wins. */
const LEVELS = { urgent: 0, directive: 1, autonomous: 2 };
const LEVEL_NAMES = { 0: 'urgent', 1: 'directive', 2: 'autonomous' };
/** Sentinel for a control-only enqueue that carries no task. */
const NO_TASK = Symbol('no-task');

class Brain {
  constructor(ctx) {
    this.ctx = ctx;
    this.cfg = ctx.cfg.agent;
    this.log = new Logger('brain');
    this.running = false;
    this.fastTimer = null;
    this.slowTimer = null;
    this.currentTask = null;
    this.queue = [];
    /**
     * Holds: the single table of "why is the brain not working" (src/core/holds.js).
     *
     * `paused` / `stopped` / `autoPlanDisabled` are accessors over it, kept because the
     * panel, the CLI, the doctor and the tests have read them since P0. The table is the
     * one place that says what each reason blocks and what clears it, so the flags cannot
     * drift apart again (the post-death stop once resumed itself on respawn).
     */
    this.holds = new Holds();
    Object.defineProperty(this, 'paused', {
      configurable: true,
      get: () => this.holds.has('paused') || this.holds.has('dead'),
      set: (on) => (on ? this.holds.hold('paused') : this.holds.release('paused'))
    });
    Object.defineProperty(this, 'stopped', {
      configurable: true,
      get: () => this.holds.has('dead'),
      set: (on) => (on ? this.holds.hold('dead') : this.holds.release('dead'))
    });
    Object.defineProperty(this, 'autoPlanDisabled', {
      configurable: true,
      get: () => this.holds.has('owner-stop'),
      set: (on) => (on ? this.holds.hold('owner-stop') : this.holds.release('owner-stop'))
    });
    this.stoppedReason = null;
    this.deathDetail = null;
    /** Task lifecycle listeners, used by the LLM for event-driven follow-ups (§5.6). */
    this.listeners = new Map();
    this.lastDecision = null;
    this.blockedGoal = null;
    this.completedGoals = [];
    this.quarantine = new Map();
    this.failCounts = new Map();
    /** Per-goal last-seen progress, used to detect goals that spin without effect. */
    this._progressSeen = new Map();
    this._stalls = new Map();
    this.activeTask = null;
    this.lastRescueAt = 0;
    /** Set when repeated deaths show the current strategy is losing. */
    this.safeMode = false;
    this.hiding = false;
    this.nextHideAt = 0;
    /** Timestamps of recent deaths, used to trigger safe mode. */
    this.recentDeaths = [];
  }

  /**
   * Called on every death. Repeated deaths inside a short window flip the agent into
   * safe mode rather than letting it walk back into the same fight.
   */
  noteDeath() {
    const now = Date.now();
    this.recentDeaths.push(now);
    this.recentDeaths = this.recentDeaths.filter((t) => now - t < 240000);
    if (this.recentDeaths.length >= 2 && !this.safeMode) {
      this.safeMode = true;
      this.nextHideAt = 0;
      this.ctx.memory.bump('safemode:enter');
      this.log.warn(
        `${this.recentDeaths.length} deaths in 4 minutes - entering SAFE MODE ` +
          '(no goals, hide underground, wait for daylight)'
      );
    }
  }

  /** The live mineflayer instance (may be null while reconnecting). */
  get bot() {
    return this.ctx.controller.bot;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log.info('brain online');
    this.fastTimer = setInterval(() => this.fastLoop().catch((e) => this.log.debug(`fast loop: ${e.message}`)), 600);
    this.slowTimer = setInterval(() => this.slowLoop().catch((e) => this.log.debug(`slow loop: ${e.message}`)), this.cfg.behaviour.idleThinkIntervalMs);
    this.slowLoop().catch(() => {});
  }

  stop() {
    this.running = false;
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    if (this.currentTask) this.currentTask.cancel();
    this.log.info('brain offline');
  }

  /** Is the agent attached to a usable world? Body-agnostic. */
  get attached() {
    if (this.ctx.body && typeof this.ctx.body.isReady === 'boolean') return this.ctx.body.isReady;
    return !!(this.bot && this.ctx.controller.isAlive);
  }

  // ------------------------------------------------------------ fast reflexes

  async fastLoop() {
    const { world, eat, combat, tools } = this.ctx;
    // Guard on the *body*, not on mineflayer: a mock or client-mod body has no `bot`.
    if (this.paused || this.stopped || !this.attached) return;
    if (this.ctx.bodyKind === 'mock') return; // scripted world: no physics, no mobs to fight

    /**
     * Pull fresh state before judging danger: the reflex must see the world as it is
     * NOW, not as it was when the last action ended. Live 2026-10-13: the cached
     * snapshot froze between actions, so a zombie standing against the agent's face
     * stayed invisible to both the reflex and the LLM's observe. The body also polls
     * in the background (ClientModBody._startStatePoll); this awaited refresh is the
     * belt to that braces - TTL-deduped, it turns every loop tick into fresh data.
     */
    if (this.ctx.body && typeof this.ctx.body.refresh === 'function') {
      await this.ctx.body.refresh(false).catch(() => null);
    }

    // ---- safe mode: stop feeding the mobs -------------------------------------
    // Several quick deaths in a row mean the current strategy is losing. Drop all
    // goals, hide underground and wait for daylight instead of charging back in.
    if (this.safeMode) {
      const safe = this.ctx.memory.landmark('shelter') && this.ctx.world.hostiles(10).length === 0;
      if (isDaytime(world) && !world.hostiles(8).length) {
        this.log.info('daylight and no hostiles - leaving safe mode');
        this.safeMode = false;
        this.ctx.memory.bump('safemode:exit');
      } else if (!this.hiding && Date.now() > (this.nextHideAt || 0)) {
        this.nextHideAt = Date.now() + 60000;
        this.hiding = true;
        this.preempt();
        try {
          await hideUnderground(this.ctx);
        } catch (err) {
          this.log.debug(`hide failed: ${err.message}`);
        } finally {
          this.hiding = false;
        }
      }
      return; // no planning while in safe mode
    }

    // Trapped on a canopy / in a hole: planning cannot fix this, so rescue first.
    // Only when no task is mid-flight, otherwise the rescue cancels live navigation
    // and we end up in a rescue/plan/retry loop.
    const now = Date.now();
    const rescueDue =
      now > this.lastRescueAt + 30000 &&
      !this.activeTask &&
      (needsRescue(world) || (this.ctx.nav.looksStuck && this.ctx.nav.stuckCount >= 3));
    if (rescueDue) {
      this.lastRescueAt = now;
      this.log.warn('bot appears trapped - attempting physical rescue');
      this.preempt();
      await escapeToGround(this.ctx).catch((e) => this.log.debug(`rescue failed: ${e.message}`));
      this.ctx.nav.stuckCount = 0;
      return;
    }

    if (world.isInDanger()) {
      this.log.warn('danger detected, retreating');
      await combat.retreat(12);
      await eat.tick(true);
      return;
    }

    await eat.tick();

    const hostile = world.nearestHostile(8);
    if (hostile && this.cfg.behaviour.autoFight) {
      // Reflex: fight back only if it is already close, otherwise keep working.
      if (hostile.distance <= 5 || this.bot.health < 12) {
        this.log.info(`hostile ${hostile.entity.name} at ${hostile.distance.toFixed(1)} blocks - engaging`);
        this.preempt();
        await combat.defend();
      }
    }

    await tools.equipArmor();
  }

  /** Cancel the current task so a reflex can take over. */
  preempt() {
    if (this.currentTask && this.currentTask.state === 'running') {
      this.log.debug(`pre-empting ${this.currentTask.name}`);
      this.currentTask.cancel();
    }
    this.queue.length = 0;
  }
  // ---------------------------------------------------------------- planning

  async slowLoop() {
    if (this.paused || this.stopped || !this.attached) return;
    /**
     * A TaskHub job owns the body right now.
     *
     * The 'task' hold was only checked in enqueue, so the planner kept deciding while a
     * background task ran - live 2026-10-12 a `!mine diamond` hub task and the planner's
     * own iron job issued commands to the same body at the same time (the tunnel controller
     * was stopped and restarted by two skills, the plan-exceeded ledger tripped, and the
     * diamond run finished with zero diamonds).
     */
    if (this.holds.has('task')) return;
    if (this.safeMode) return; // reflexes only until the coast is clear
    if (this.activeTask) return;
    if (this.queue.length) {
      await this.drainQueue();
      return;
    }
    /**
     * Operator stop: no *new* autonomous work until an explicit resume.
     *
     * The check sits after the queue drain on purpose: `!stop` must silence the planner
     * while still letting the next explicit command run (`!mine dirt 8` enqueues, the queue
     * drains, and then the planner goes quiet again). Before this flag was honoured, the
     * 2.5s planning loop simply picked the next goal and "stop" looked broken.
     */
    if (this.autoPlanDisabled) return;
    // Don't plan before we can actually perceive anything.
    const snap = this.ctx.world.snapshot ? this.ctx.world.snapshot(true) : null;
    if (!snap || !snap.ready) return;

    const task = this.decide();
    if (!task) {
      this.lastDecision = { at: Date.now(), decision: 'idle', note: 'no applicable rule (goals may be quarantined)' };
      this._idleTicks = (this._idleTicks || 0) + 1;
      if (this._idleTicks % 20 === 0) this.log.warn('planner idle: every goal is either done or quarantined');
      return;
    }
    this._idleTicks = 0;
    this.lastDecision = { at: Date.now(), decision: task.name, description: task.description };
    this.log.info(`plan -> ${task.describe()}`);
    await this.runTask(task);
  }

  /**
   * The rule table. Order matters: earlier rules win.
   *
   * Reads everything through the Body snapshot rather than `this.bot`, so the same
   * planner drives mineflayer, a scripted mock world, or a real Forge client.
   * @returns {import('../tasks/task').Task|null}
   */
  decide() {
    const world = this.ctx.world;
    const ctx = this.ctx;
    /**
     * Whether the planner may fell trees on its own.
     *
     * Off means the agent still chops when told to (`!chop`) - an explicit instruction is an
     * explicit instruction - but it will not go looking for trees while idle. That matters on
     * a shared server, where a tree is often part of the scenery rather than a resource.
     */
    const mayChop = this.cfg.survival.allowWoodChopping !== false;

    // Perception comes from the body. `view` is a plain object with the two things the
    // rule table needs: `inventory` (mineflayer-shaped) and `health`/`food`.
    const snap = world.snapshot ? world.snapshot(true) : null;
    const inventory = new SnapshotInventory((snap && snap.inventory) || {}, {
      emptySlots: snap ? snap.emptySlots : undefined
    });
    const view = {
      inventory,
      health: snap ? snap.health : 20,
      food: snap ? snap.food : 20,
      registry: this.bot && this.bot.registry ? this.bot.registry : null
    };

    const has = (name, n = 1) => countItem(view, name) >= n;
    const planks = countMatching(view, (n) => /_planks$/.test(n));
    const logs = countMatching(view, isLog);
    const wood = logs + planks;
    const pick = bestTool(view, 'pickaxe');
    const pickRank = pick ? pick.rank : -1;
    const hasSword = !!bestTool(view, 'sword');
    const food = countMatching(view, (n) => isFood(n, view.registry));
    const emptySlots = inventory.emptySlotCount();
    const cobble = countItem(view, 'cobblestone');
    const stoneRank = TOOL_TIERS.indexOf('stone');
    /**
     * What this body can actually do, asked once per planning tick.
     *
     * These two flags are the difference between a planner that adapts and one that spins:
     * under the client-mod body `craft()` always fails ("no recipe support" - the mod exposes
     * no crafting UI), and mining stone without a pickaxe always fails by design. Without the
     * guards below the rule table retried those two forever and everything after them was
     * unreachable. The plan's §5.4 capability list is the same idea applied to the LLM; this is
     * its counterpart in the rule table.
     */
    const canCraft = !!(ctx.body && ctx.body.supportsCrafting);
    const hasPick = pickRank >= 0;
    const canDeposit = !!(ctx.body && ctx.body.supportsDeposit);
    /** The control mod cannot see passive animals, so hunting is not a goal it can meet. */
    const canHunt = !!(ctx.body && ctx.body.supportsHunting);

    // Each entry is a lazy rule: the first one that produces a task wins. Keeping
    // them as thunks means the cheap checks (counts) always run but expensive
    // construction only happens for the chosen branch.
    const rules = [
      { name: 'deposit', when: () => canDeposit && emptySlots <= 2, make: () => new DepositTask(ctx, { priority: 5 }) },
      {
        // Low health does not regenerate without food, so hunting becomes urgent
        // well before the hunger bar is empty.
        name: 'hunt',
        when: () => canHunt && food === 0 && (view.food < 17 || view.health < 12),
        make: () => new HuntTask(ctx, { count: 3, priority: 10 })
      },
      { name: 'gather-wood', when: () => mayChop && wood < 4, make: () => new ChopWoodTask(ctx, { count: 8, priority: 20 }) },
      { name: 'craft', when: () => canCraft && !has('crafting_table'), make: () => new CraftTask(ctx, { item: 'crafting_table', count: 1, requireTable: false, priority: 25 }) },
      { name: 'craft', when: () => canCraft && pickRank < 0 && planks < 3 && logs > 0, make: () => new CraftTask(ctx, { item: plankName(view), count: 4, requireTable: false, priority: 27 }) },
      { name: 'gather-wood', when: () => mayChop && pickRank < 0 && planks < 3, make: () => new ChopWoodTask(ctx, { count: 8, priority: 27 }) },
      { name: 'craft', when: () => canCraft && pickRank < 0 && planks >= 3 && !has('stick', 2), make: () => new CraftTask(ctx, { item: 'stick', count: 4, requireTable: false, priority: 28 }) },
      { name: 'craft', when: () => canCraft && pickRank < 0, make: () => new CraftTask(ctx, { item: 'wooden_pickaxe', count: 1, priority: 30 }) },
      {
        name: 'shelter',
        when: () =>
          this.cfg.survival.shelterAtNight &&
          world.isNight() &&
          !ctx.memory.landmark('shelter') &&
          countMatching(bot, (n) => /_planks$/.test(n) || ['cobblestone', 'stone', 'dirt', 'sand'].includes(n)) >= 16,
        make: () => new ShelterTask(ctx, { priority: 35 })
      },
      { name: 'mine', when: () => hasPick && (pickRank < stoneRank || !hasSword) && cobble < 3, make: () => new MineBlockTask(ctx, { block: ['stone', 'cobblestone', 'deepslate'], count: 8, priority: 40 }) },
      { name: 'craft', when: () => canCraft && (pickRank < stoneRank || !hasSword) && !has('stick', 2) && planks >= 2, make: () => new CraftTask(ctx, { item: 'stick', count: 4, requireTable: false, priority: 41 }) },
      { name: 'craft', when: () => canCraft && pickRank < stoneRank, make: () => new CraftTask(ctx, { item: 'stone_pickaxe', count: 1, priority: 42 }) },
      { name: 'craft', when: () => canCraft && !hasSword, make: () => new CraftTask(ctx, { item: 'stone_sword', count: 1, priority: 43 }) },
      { name: 'light', when: () => !has('torch') && (has('coal') || has('charcoal')), make: () => new LightTask(ctx, { count: 4, priority: 45 }) },
      { name: 'mine', when: () => hasPick && !has('furnace') && cobble < 8, make: () => new MineBlockTask(ctx, { block: ['stone', 'cobblestone', 'deepslate'], count: 8, priority: 47 }) },
      { name: 'craft', when: () => canCraft && !has('furnace'), make: () => new CraftTask(ctx, { item: 'furnace', count: 1, priority: 48 }) },
      { name: 'hunt', when: () => canHunt && food < 3, make: () => new HuntTask(ctx, { count: 3, priority: 50 }) },
      {
        name: 'craft',
        when: () => canCraft && pickRank >= stoneRank && !has('iron_ingot', 3) && countItem(view, 'raw_iron') + countItem(view, 'iron_ore') >= 3,
        make: () => new CraftTask(ctx, { item: 'iron_pickaxe', count: 1, priority: 55 })
      },
      {
        name: 'mine',
        when: () => hasPick && pickRank >= stoneRank && !has('iron_ingot', 3),
        /**
         * The autonomous iron run uses the ore executor through the MineOreTask adapter:
         * it runs inside the planner's own ownership (no second TaskHub submission) and
         * shares the alias/variant normalization with every explicit entry (plan §5.6.1).
         */
        make: () => new MineOreTask(ctx, { block: ['iron_ore'], count: 3, priority: 56, timeoutMs: 240000 })
      },
      { name: 'gather-wood', when: () => mayChop && wood < 16, make: () => new ChopWoodTask(ctx, { count: 16, priority: 60 }) },
      { name: 'light', when: () => has('coal') || has('charcoal'), make: () => new LightTask(ctx, { count: 6, priority: 62 }) },
      { name: 'mine', when: () => hasPick, make: () => new MineBlockTask(ctx, { block: ['stone', 'cobblestone', 'deepslate'], count: 16, priority: 70 }) }
      /**
       * There is deliberately no always-true fallback rule here.
       *
       * The last entry used to be `dig-dirt` with `when: () => true` (gated only on a
       * `allowDirtDigging` switch): it was the "keep busy" goal, justified because dirt needs no
       * tool and is never valuable. The operator removed it - an idle planner is better than a
       * bot that rearranges the ground to look occupied, and on a shared server the hillside is
       * scenery rather than a resource.
       *
       * Idling is a supported state, not a failure: `slowLoop` records
       * `lastDecision.decision = 'idle'`, and warns every 20th tick so a genuinely stuck planner
       * is still visible. Explicit requests are unaffected - `!mine dirt 8` and "挖点土" both
       * still work, because an instruction is an instruction.
       */
    ];

    for (const rule of rules) {
      let applicable = false;
      try {
        applicable = rule.when();
      } catch (err) {
        this.log.debug(`rule ${rule.name} threw: ${err.message}`);
        continue;
      }
      if (!applicable) continue;
      if (this.isQuarantined(rule.name)) {
        this.log.debug(`skipping quarantined goal ${rule.name}`);
        continue;
      }
      return rule.make();
    }
    return null;
  }

  // ------------------------------------------------------------- task runner

  async runTask(task) {
    // Serialise execution: exactly one task may drive the bot at a time. Without
    // this, a slow loop, a retry timer and a reflex can all call runTask() and end
    // up fighting over the pathfinder (every goto instantly cancelled by the other).
    if (this.activeTask && this.activeTask !== task) {
      this.queue.push(task);
      this.log.debug(`${task.name} queued behind ${this.activeTask.name}`);
      return;
    }
    this.activeTask = task;
    this.currentTask = task;
    try {
      await task.execute();
      const res = task.result || { ok: false, reason: 'no result' };
      if (res.ok) {
        this.log.info(`done ${task.name}: ${res.reason}`);
        this.completedGoals.push({ name: task.name, reason: res.reason, at: Date.now() });
        if (this.completedGoals.length > 50) this.completedGoals.shift();
        if (task.name === 'shelter') {
          const pos = this.ctx.body.snapshot();
          if (pos && pos.position) this.ctx.memory.rememberLandmark('shelter', { ...pos.position });
        }
        this.ctx.memory.bump(`task:${task.name}:ok`);
        this._noteProgress(task);
        /**
         * Task lifecycle events (P0-PLAN §5.6). The LLM subscribes so it can finish a
         * request *after* a long task - "go chop some wood and tell me when you're done" -
         * without ever polling or blocking. Only tasks it dispatched itself wake it; the
         * payload carries `source` so that decision stays with the listener.
         */
        this.emit('task:done', {
          name: task.name,
          reason: res.reason,
          description: task.description,
          source: task.source || 'autonomous',
          level: task.level || null
        });
      } else {
        this.log.warn(`failed ${task.name}: ${res.reason}`);
        this.ctx.memory.bump(`task:${task.name}:fail`);
        this.emit('task:failed', {
          name: task.name,
          reason: res.reason,
          description: task.description,
          source: task.source || 'autonomous',
          level: task.level || null
        });
        this.maybeRetry(task);
      }
    } finally {
      if (this.currentTask === task) this.currentTask = null;
      if (this.activeTask === task) this.activeTask = null;
      /**
       * Pick up anything that was queued while this task ran.
       *
       * Without this, a chat command issued during a long task waits for the *next planning
       * tick* - up to `idleThinkIntervalMs` after a three-minute job already finished. The
       * user sees "nothing happened" and sends the command again. Chaining through
       * `setTimeout(0)` keeps the stack flat when a long queue drains in one go.
       */
      if (this.queue.length && this.running && !this.paused && !this.stopped) {
        setTimeout(() => {
          this.drainQueue().catch((err) => this.log.debug(`drain after task: ${err.message}`));
        }, 0);
      }
    }
  }

  maybeRetry(task) {
    const reason = task.result ? task.result.reason : null;
    /**
     * Never resurrect deliberate cancellation.
     *
     * `preempt()`, `pause()` and the post-death stop all cancel the running task, and a retry
     * would quietly undo exactly what the user just asked for - "stop" would be followed by
     * the same job starting again 1.5s later, which is how a stop button loses its meaning.
     */
    if (reason && /cancel/i.test(reason)) {
      this.log.debug(`${task.name} was cancelled - not retrying`);
      this.drainQueue();
      return;
    }
    if (task.retries >= task.maxRetries) {
      this.log.warn(`${task.name} exhausted retries`);
      this.blockedGoal = { name: task.name, at: Date.now(), reason: task.result ? task.result.reason : null };
      // Quarantine the goal so a permanently impossible task cannot spin the
      // planner, but keep the window short: on a real map "no trees nearby" is
      // usually temporary (we simply wandered into a clearing).
      this.failCounts.set(task.name, (this.failCounts.get(task.name) || 0) + 1);
      const strikes = this.failCounts.get(task.name);
      const windowMs = Math.min(120000, 20000 * strikes);
      this.quarantine.set(task.name, Date.now() + windowMs);
      this.log.debug(`${task.name} quarantined for ${Math.round(windowMs / 1000)}s (strike ${strikes})`);
      this.drainQueue();
      return;
    }
    task.retries += 1;
    task.state = 'pending';
    this.log.info(`retrying ${task.name} (attempt ${task.retries + 1})`);
    // Short delay so the world can change (night -> day, mobs wander off...).
    setTimeout(() => {
      if (this.running && !this.paused && !this.stopped) this.runTask(task).catch((e) => this.log.debug(`retry failed: ${e.message}`));
    }, 1500);
  }

  /** Run whatever is waiting in the queue, one task at a time. */
  async drainQueue() {
    if (this.activeTask || this.paused || this.stopped || !this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.log.info(`dequeued ${next.describe()}`);
    await this.runTask(next);
  }

  /**
   * Track per-goal progress so a goal that "succeeds" without changing anything cannot
   * spin the planner forever.
   *
   * Real example: on a map with two trees, `gather-wood` correctly reports success
   * ("no trees nearby") but the wood count never reaches the target, so the rule table
   * picks the same goal again - and again, every 2.5s, silently. Two stalls and the
   * goal is parked for a while, which lets the planner do something else instead.
   */
  _noteProgress(task) {
    const value = typeof task.progress === 'function' ? safeCall(() => task.progress()) : null;
    if (value === null || value === undefined) {
      this._progressSeen && this._progressSeen.delete(task.name);
      return;
    }
    if (!this._progressSeen) this._progressSeen = new Map();
    const previous = this._progressSeen.get(task.name);
    if (previous !== undefined && previous === value) {
      const stalls = (this._stalls.get(task.name) || 0) + 1;
      this._stalls.set(task.name, stalls);
      if (stalls >= 2 && !this.isQuarantined(task.name)) {
        this.log.warn(`${task.name} made no progress (${value}) for ${stalls} runs - parking it briefly`);
        this.quarantine.set(task.name, Date.now() + 30000);
        this._stalls.delete(task.name);
      }
    } else {
      this._stalls && this._stalls.delete(task.name);
    }
    this._progressSeen.set(task.name, value);
  }

  /** True when a goal failed so recently that we should not immediately re-plan it. */
  isQuarantined(name) {
    if (!this.quarantine) return false;
    const until = this.quarantine.get(name);
    if (!until) return false;
    if (Date.now() > until) {
      this.quarantine.delete(name);
      return false;
    }
    return true;
  }

  /** Add an explicit goal (used by chat commands and the web API). */
  async push(task) {
    this.queue.push(task);
    this.log.info(`queued goal: ${task.describe()}`);
    if (!this.activeTask) await this.slowLoop();
    return task.snapshot();
  }

  /**
   * Three-level priority queue (P0-PLAN §5.7).
   *
   *   URGENT (0)     panel emergency stop, `!stop` / `!pause` -> cancel everything
   *   DIRECTIVE (1)  panel or chat command, LLM dispatch      -> preempts AUTONOMOUS only
   *   AUTONOMOUS (2) the rule table                           -> waits its turn
   *
   * The rule that matters: **same level never preempts same level.** Sending `!chop 8`
   * twice must queue two jobs rather than have the second silently kill the first. That is
   * easy to get wrong with a naive "newest wins" queue, and it is the difference between a
   * control panel that obeys and one that appears to ignore every other command.
   *
   * @param {import('./tasks/task').Task} task
   * @param {object} [options] { level, source }
   * @returns {{accepted:boolean, level:string, preempted:string|null, queuedBehind:number}}
   */
  async enqueue(task, options = {}) {
    const levelName = LEVEL_NAMES[options.level] || options.level || 'directive';
    const level = LEVELS[levelName] === undefined ? LEVELS.directive : LEVELS[levelName];
    const source = options.source || 'unknown';
    task.source = source;
    task.level = levelName;

    // While stopped for death, only URGENT work (i.e. resuming) is allowed through.
    if (this.stopped) {
      this.log.warn(`refusing ${task.describe()}: stopped after death (resume first)`);
      return { accepted: false, level: levelName, preempted: null, queuedBehind: this.queue.length, reason: 'stopped-after-death' };
    }
    /**
     * One body, one task. A background task (src/core/taskHub.js) holds the body while it
     * runs; explicit work is refused with the reason instead of silently fighting it for
     * the same keyboard. Urgent control verbs (`!stop`) still pass - they are how it ends.
     */
    if (this.holds.has('task') && level !== LEVELS.urgent) {
      const hold = this.holds.list().find((h) => h.reason === 'task');
      this.log.warn(`refusing ${task.describe()}: body is busy (${hold ? hold.note || 'background task' : 'background task'})`);
      return {
        accepted: false,
        level: levelName,
        preempted: null,
        queuedBehind: this.queue.length,
        reason: 'body-busy',
        detail: hold ? hold.note || null : null
      };
    }

    let preempted = null;

    if (level === LEVELS.urgent) {
      if (this.currentTask && this.currentTask.state === 'running') {
        preempted = this.currentTask.name;
        this.currentTask.cancel();
      }
      this.queue.length = 0;
      this.ctx.nav.interrupt('urgent command');
    } else if (level === LEVELS.directive && this.currentTask && this.currentTask.level === 'autonomous') {
      // Preempt the planner's own work, never another instruction.
      preempted = this.currentTask.name;
      this.currentTask.cancel();
    }

    // URGENT commands are usually control verbs (`stop`, `pause`) with no task attached.
    if (task && task !== NO_TASK) {
      // Instructions jump ahead of autonomous work but keep their relative order.
      if (level === LEVELS.directive) {
        const firstAuto = this.queue.findIndex((t) => t.level === 'autonomous');
        if (firstAuto === -1) this.queue.push(task);
        else this.queue.splice(firstAuto, 0, task);
      } else {
        this.queue.push(task);
      }
    }

    this.log.info(
      `enqueue(${levelName}${source ? `,${source}` : ''}): ${task && task.describe ? task.describe() : 'control'}` +
        (preempted ? ` [preempted ${preempted}]` : '')
    );

    /**
     * Accept and return - do not wait for the work to finish.
     *
     * The old `await this.slowLoop()` made every command receipt mean "finished": the panel
     * POST blocked for the whole task (29s for two dirt blocks in live testing) and an LLM
     * turn could not answer until the job was over. numen's TaskDispatch draws the line at
     * "accepted" = "this can start now"; the completion is a separate task event, which the
     * LLM/proactive wiring already consumes (`brain.emit('task:done'|'task:failed')`).
     */
    if (!this.activeTask && !this.paused && !this.stopped) {
      setTimeout(() => {
        this.drainQueue().catch((err) => this.log.debug(`drain after enqueue: ${err.message}`));
      }, 0);
    }

    return { accepted: true, level: levelName, preempted, queuedBehind: Math.max(0, this.queue.length - 1) };
  }

  /**
   * Freeze the planner because the bot died.
   *
   * Deliberately stronger than `pause()`: `paused` can be cleared by the planner itself on
   * the next tick, whereas `stopped` only clears through `resumeFromDeath()`. "Abort
   * everything on death" has to survive an autonomous loop that would otherwise re-plan
   * three seconds later.
   */
  stopForDeath(detail = null) {
    this.holds.hold('dead', detail ? String(detail) : null);
    this.stoppedReason = 'death';
    this.queue.length = 0;
    if (this.currentTask && this.currentTask.state === 'running') this.currentTask.cancel();
    this.deathDetail = detail;
    this.log.warn('brain STOPPED after death - no tasks will run until an explicit resume');
    return this.status();
  }

  /** Clear the post-death stop. Only a human (or the panel) should call this. */
  resumeFromDeath() {
    this.holds.release('dead');
    this.holds.release('paused');
    this.stoppedReason = null;
    this.log.info('brain resumed after death');
    return this.status();
  }

  status() {
    return {
      running: this.running,
      paused: this.paused,
      stopped: this.stopped,
      autoPlanDisabled: !!this.autoPlanDisabled,
      holdReason: this.holds.primary() ? this.holds.primary().reason : null,
      holds: this.holds.list(),
      stoppedReason: this.stoppedReason,
      death: this.deathDetail,
      safeMode: this.safeMode,
      recentDeaths: this.recentDeaths ? this.recentDeaths.length : 0,
      current: this.currentTask ? this.currentTask.snapshot() : null,
      currentLevel: this.currentTask ? this.currentTask.level || null : null,
      queued: this.queue.map((t) => ({ description: t.describe(), level: t.level || null, source: t.source || null })),
      queueLength: this.queue.length,
      lastDecision: this.lastDecision,
      blockedGoal: this.blockedGoal,
      completedGoals: this.completedGoals.slice(-10),
      memory: this.ctx.memory.summary()
    };
  }

  // ------------------------------------------------------------- task events

  /** Subscribe to `task:done` / `task:failed`. Returns an unsubscribe function. */
  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.listeners.get(event).delete(handler);
  }

  emit(event, payload) {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        this.log.debug(`${event} listener failed: ${err.message}`);
      }
    }
  }

  pause() {
    this.holds.hold('paused', '!pause');
    if (this.currentTask) this.currentTask.cancel();
    this.ctx.nav.interrupt('brain paused');
    this.log.warn('brain paused');
  }

  resume() {
    if (this.holds.has('dead')) {
      this.log.warn('resume ignored: the brain is stopped after a death (use resumeFromDeath)');
      return this.status();
    }
    this.holds.release('paused');
    this.holds.release('owner-stop');
    this.log.info('brain resumed');
    return this.status();
  }

  /**
   * Enter a named hold (src/core/holds.js). Every reason a component wants to freeze the
   * brain goes through here or its accessor, so `status()` can answer "why" in one place.
   */
  hold(reason, note = null) {
    this.holds.hold(reason, note);
    this.log.warn(`brain hold: ${reason}${note ? ` (${note})` : ''}`);
    return this.status();
  }

  /** Clear a named hold. */
  release(reason) {
    const wasActive = this.holds.release(reason);
    if (wasActive) this.log.info(`brain hold released: ${reason}`);
    return this.status();
  }
}

/**
 * Which plank type should we craft? Derived from the logs in hand, so it works from a
 * Body snapshot (`view.inventory`) rather than a mineflayer instance.
 */
function plankName(view) {
  const logItem = view.inventory.find((name) => isLog(name));
  if (!logItem) return 'oak_planks';
  const base = logItem.name.replace(/_log$/, '').replace(/_stem$/, '').replace(/^stripped_/, '');
  const candidate = `${base}_planks`;
  const registry = view.registry;
  if (!registry || !registry.itemsByName) return candidate;
  return registry.itemsByName[candidate] ? candidate : 'oak_planks';
}

module.exports = { Brain };

/** Call a function that might throw, returning null instead of propagating. */
function safeCall(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}
