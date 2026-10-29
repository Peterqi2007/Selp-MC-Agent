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
const { GoToTask } = require('./tasks/goto');
const { MineBlockTask } = require('./tasks/mineBlock');
const { MineOreTask } = require('./tasks/mineOre');
const { FishTask } = require('./tasks/fish');
const { CodeSkillTask } = require('./tasks/codeSkill');
const { ShelterTask } = require('./tasks/shelter');
const { HuntTask } = require('./tasks/hunt');
const { LightTask } = require('./tasks/light');
const { DepositTask } = require('./tasks/deposit');
const { WithdrawTask } = require('./tasks/withdraw');
const { FollowTask } = require('./tasks/follow');
const { Logger } = require('./util/logger');
const { sleep } = require('./core/movement');
const { Holds } = require('./core/holds');
const { InputLedger } = require('./core/inputLedger');
const { needsRescue, escapeToGround, hideUnderground, isDaytime } = require('./core/recovery');
const { evaluate } = require('./planner/evaluator');
const { TaskSlot } = require('./core/taskSlot');
const { ProposalDesk } = require('./planner/proposals');
const { TaskEvents } = require('./core/taskEvents');
const { PerceptionWake } = require('./world/perceptionWake');
const { PlanStore } = require('./core/planStore');
const { PlanRunner } = require('./core/planRunner');
const { PlanService } = require('./core/planService');
const { PlanQuestionBridge } = require('./planner/planQuestions');
const { verifyStep } = require('./planner/verifier');
const { TurnLifecycle } = require('./core/turnLifecycle');
const { HarnessAdapter } = require('./harness/adapter');
const { TurnService } = require('./harness/turnService');
const { StateStore } = require('./core/stateStore');
const { captureState, restoreState } = require('./core/sessionState');
const { MethodLibrary } = require('./learning/methodLibrary');
const { AnswerMemory } = require('./learning/answerMemory');
const { Budget } = require('./planner/budget');
const { ConversationState } = require('./chat/conversation');
const { MemoryStore } = require('./memory/store');
const { ChatMemory } = require('./memory/chatMemory');
const nodePath = require('path');
const { bare } = require('./world/items');
/**
 * The skill layer, for reflex work on bodies without a mineflayer instance.
 *
 * AutoEat / Combat / ToolManager all read `controller.bot`, which is null on the
 * client-mod body - they no-op (or throw: `needsRescue` used to kill the whole fast
 * loop every tick). The skills drive `ctx.body` and are the same code path the `!`
 * commands and the LLM already use, so for those bodies the fast reflexes route
 * through here (see `skillDriven` in fastLoop).
 */
const skills = require('./skills');
const combatSkills = require('./skills/combat');
const combatState = require('./world/combatState');

/** Priority levels for `enqueue` (P0-PLAN §5.7). Lower number wins. */
const LEVELS = { urgent: 0, directive: 1, autonomous: 2 };
const LEVEL_NAMES = { 0: 'urgent', 1: 'directive', 2: 'autonomous' };
/** Gun failures the reflex answers by falling back to the melee charge (plan §④). */
const GUN_FALLBACK = new Set(['tacz_unavailable', 'no_gun', 'not_a_gun', 'no_ammo', 'blocked']);
/** Sentinel for a control-only enqueue that carries no task. */
const NO_TASK = Symbol('no-task');

class Brain {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.options = options;
    this.cfg = ctx.cfg.agent;
    this.log = new Logger('brain');
    this.running = false;
    this.fastTimer = null;
    this.slowTimer = null;
    /**
     * RETIREMENT S2: one body, one owner - and the owner lives in the slot, not here.
     *
     * `queue` is the slot's queue (the same array, so existing call sites keep working);
     * `activeTask` / `currentTask` are read-only views (getters below).
     */
    this.slot = new TaskSlot(ctx, { log: this.log });
    this.slot.brain = this;
    ctx.slot = this.slot;
    this.queue = this.slot.queue;

    /**
     * RETIREMENT S3: `legacy` executes the selected goal (P0 behaviour), `proposals` only
     * offers it for player approval, `off` plans nothing. Default legacy so nothing changes
     * until the stage is accepted.
     */
    const plannerCfg = (ctx.cfg.agent && ctx.cfg.agent.planner) || {};
    this.plannerMode =
      plannerCfg.mode === 'proposals' || plannerCfg.mode === 'off' ? plannerCfg.mode : 'legacy';
    this.proposals = new ProposalDesk(ctx, {
      brain: this,
      log: this.log,
      cooldownMs: plannerCfg.proposalCooldownMs,
      ttlMs: plannerCfg.proposalTtlMs
    });
    /**
     * P1 §1.4.4: task facts go to one hub (SSE/panel/ledger read it), and plans have a
     * single writer - this process. Neither replaces the listener map yet; both exist so a
     * second process can consume facts without polling.
     */
    this.events = new TaskEvents();
    ctx.events = this.events;
    this.plans = new PlanStore();
    ctx.plans = this.plans;
    /**
     * M1c: steps of a parent plan run through the same executor (never a second TaskHub
     * submit), and each LLM turn has one lifecycle (wait -> one matching event -> resume).
     */
    this.planRunner = new PlanRunner({
      plans: this.plans,
      createTask: (step, ids) =>
        buildTask(this.ctx, { type: step.type, args: { ...(step.args || {}), ...ids } }),
      runTask: (task) => this.runTask(task),
      verify: (step, observation) => verifyStep(step, observation),
      observe: () => (this.ctx.world.snapshot ? this.ctx.world.snapshot(true) : null),
      // A task can finish one tick before the body snapshot shows its inventory change.
      postconditionRetryMs: 300,
      postconditionRetryAttempts: 2,
      recordMethod: (step, ok) => this.methods.recordOutcome(step.methodId, ok),
      onStep: (event) => this.planService && this.planService.onStep(event),
      log: this.log
    });
    ctx.planRunner = this.planRunner;
    this.planQuestions = new PlanQuestionBridge({
      plans: this.plans,
      proposals: this.proposals,
      /**
       * A14: announce the question in the player's channel. `ctx.reply` may be absent in
       * fixtures; a failed announcement must never disturb the parked plan.
       */
      notify: (text) => {
        try {
          if (!this.ctx) return;
          /**
           * Unified language brain: a plan question is a help/status output from the action
           * side, so the player-facing wording comes from the language brain. If it cannot
           * speak, fall back to the original question so a parked plan is not stranded.
           */
          if (this.ctx.languageBrain) {
            Promise.resolve(
              this.ctx.languageBrain.handle({
                text: String(text),
                source: 'plan-question',
                kind: 'question',
                profile: 'roleplay'
              })
            )
              .then((result) => {
                if ((!result || result.spoke !== true) && typeof this.ctx.reply === 'function') {
                  return this.ctx.reply(text, { why: 'plan-question-fallback' });
                }
                return null;
              })
              .catch(() => {});
            return;
          }
          if (typeof this.ctx.reply === 'function') {
            Promise.resolve(this.ctx.reply(text, { why: 'plan-question' })).catch(() => {});
          }
        } catch {
          /* announcing a question must never break the plan */
        }
      }
    });
    ctx.planQuestions = this.planQuestions;
    /**
     * M3 live entry: the missing submit/start/cancel/answer surface for plans. It writes
     * through PlanStore and executes through PlanRunner, so it adds no second writer,
     * executor or question state machine.
     */
    this.planService = new PlanService({
      plans: this.plans,
      runner: this.planRunner,
      questions: this.planQuestions,
      events: this.events,
      proposals: this.proposals,
      log: this.log,
      knownStepTypes: [...Object.keys(TASK_BUILDERS), 'wait_for_player'],
      waitIdleMs: (this.cfg.planner && this.cfg.planner.planWaitIdleMs) || 30000,
      isBodyBusy: () => !!(this.activeTask || (this.slot && this.slot.busy)),
      /** Loops may not have started yet (offline fixture); pause/death are the hard gates. */
      canRun: () => !this.paused && !this.stopped,
      onChange: () => this.scheduleStateSave()
    });
    ctx.planService = this.planService;
    this.turns = new TurnLifecycle();
    ctx.turns = this.turns;
    this.harness = new HarnessAdapter({ turns: this.turns, events: this.events });
    ctx.harness = this.harness;
    this.turnService = new TurnService({
      turns: this.turns,
      adapter: this.harness,
      planService: this.planService,
      log: this.log
    });
    ctx.turnService = this.turnService;
    ctx.turnEvents = this.turnService.turnEvents;
    /**
     * A11: sampling produces no wake; only an edge does. The model consumer subscribes in
     * index.js, keeping this class independent of the LLM and safe to run offline.
     */
    this.perceptionWake = new PerceptionWake({
      radius: this.cfg.behaviour && this.cfg.behaviour.perceptionRadius,
      log: this.log
    });
    ctx.perceptionWake = this.perceptionWake;
    /** M3: local methods and remembered player answers (both persisted when state is on). */
    this.methods = new MethodLibrary();
    ctx.methods = this.methods;
    this.answers = new AnswerMemory();
    ctx.answers = this.answers;
    /** M3: finite search/replan/retry budgets for the planning loop. */
    this.budget = new Budget();
    ctx.budget = this.budget;
    /** M6: deterministic chat dedupe/rate-limit/stale-request state (persisted). */
    this.conversation = new ConversationState();
    ctx.conversation = this.conversation;
    /** M3: classified memory (episodic/semantic/relational); ctx.memory is untouched. */
    this.memoryStore = new MemoryStore();
    ctx.memoryStore = this.memoryStore;
    /** Persistent language-chat memory: save/grep/context/compact, captured with state. */
    this.chatMemory = new ChatMemory({
      onChange: () => this.scheduleStateSave(),
      log: this.log
    });
    ctx.chatMemory = this.chatMemory;
    /**
     * Memory write closure: task/plan terminal events become episodic entries that the
     * language prompt can recall. The event hub already dedupes by eventId, so a repeated
     * completion cannot be written twice.
     */
    this._memoryUnsubscribe = this.events.subscribe((event) => this.rememberEvent(event));
    /**
     * Input ledger (M5, F1'b): every key the agent presses is recorded here, and every
     * "stop touching the world" signal releases it. The mod keeps its own cap, so a dead
     * Node cannot leave a key down either (two independent limits on purpose).
     */
    this.inputLedger = new InputLedger({
      log: this.log,
      write: (action, down) => (this.ctx.body && typeof this.ctx.body.key === 'function'
        ? this.ctx.body.key(action, down)
        : Promise.resolve(null)),
      writeHold: (action, ms) => (this.ctx.body && typeof this.ctx.body.hold === 'function'
        ? this.ctx.body.hold(action, ms)
        : Promise.resolve(null))
    });
    /**
     * Holds: the single table of "why is the brain not working" (src/core/holds.js).
     *
     * `paused` / `stopped` / `autoPlanDisabled` are accessors over it, kept because the
     * panel, the CLI, the doctor and the tests have read them since P0. The table is the
     * one place that says what each reason blocks and what clears it, so the flags cannot
     * drift apart again (the post-death stop once resumed itself on respawn).
     *
     * `onHold` connects the two tables: any new hold (dead/paused/owner-stop/task) also
     * releases the input ledger, so "stopped" means no key is still pressed.
     */
    this.holds = new Holds({ onHold: (reason) => this.releaseInput(reason) });
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
    /**
     * A plan question that expires unanswered must not leave the plan parked forever.
     * Only the expired event is handled here; accept/reject already resume explicitly.
     */
    this.on('proposal:expired', (proposal) => {
      if (!proposal || proposal.type !== 'plan_question' || !proposal.planId) return;
      const resumed = this.planService
        ? this.planService.resume(proposal.planId, false, { reason: 'expired' })
        : this.planRunner.resume(proposal.planId, false);
      if (resumed && resumed.promise) {
        resumed.promise.catch((err) => {
          this.log.warn(`expired plan question could not resume ${proposal.planId}: ${err.message}`);
        });
      } else if (resumed && typeof resumed.catch === 'function') {
        resumed.catch((err) => {
          this.log.warn(`expired plan question could not resume ${proposal.planId}: ${err.message}`);
        });
      }
    });

    /**
     * P1 M3/A17/A29: persistence. `config/agent.json` turns it on; an explicit
     * `options.state` lets an offline fixture point at a temp file, and `P1_STATE=off`
     * keeps the many Brain-constructing suites from reading/writing the live state file.
     *
     * Restore never starts a plan and never replays a task: plans/proposals/event ring and
     * the plan budgets come back; in-flight tasks and harness turns do not.
     */
    const stateCfg = options.state || (ctx.cfg.agent && ctx.cfg.agent.state) || {};
    const stateDisabled = !options.state && process.env.P1_STATE === 'off';
    this.stateStore = null;
    this.stateDebounceMs = stateCfg.debounceMs === undefined ? 1000 : stateCfg.debounceMs;
    this._stateTimer = null;
    /** Set by index.js when the M6 participation module is wired. */
    this.chatParticipation = null;
    /** Set by index.js when language.brain=unified; the single language owner. */
    this.languageBrain = null;
    /** Restored chat window, consumed by index.js after ChatParticipation is constructed. */
    this.pendingChatParticipation = null;
    /** Restored unified-language window, consumed after LanguageBrain is constructed. */
    this.pendingLanguageBrain = null;
    if (stateCfg.enabled && !stateDisabled) {
      const stateFile = stateCfg.file
        ? nodePath.resolve(stateCfg.file)
        : nodePath.resolve(__dirname, '..', stateCfg.path || 'runtime/p1-state.json');
      this.stateStore = new StateStore({ file: stateFile });
      const saved = this.stateStore.load();
      if (saved) {
        const restored = this.restoreState(saved);
        this.log.info(`state restored: ${JSON.stringify(restored.restored || {})}`);
        /**
         * A plan can be saved between "step waiting" and "proposal created"; re-ask so an
         * unanswered question is visible after restart (A17) without running the plan.
         */
        try {
          const questions = this.planService.restoreQuestions();
          if (questions.length) {
            this.log.info(`plan questions restored: ${JSON.stringify(questions)}`);
            this.scheduleStateSave();
          }
        } catch (err) {
          this.log.warn(`plan questions restore failed: ${err.message}`);
        }
      }
      for (const event of [
        'task:done',
        'task:failed',
        'proposal:new',
        'proposal:accepted',
        'proposal:rejected',
        'proposal:expired',
        'proposal:superseded'
      ]) {
        this.on(event, () => this.scheduleStateSave());
      }
    }
    this.lastDecision = null;
    this.completedGoals = [];
    this.lastRescueAt = 0;
    /** Set when repeated deaths show the current strategy is losing. */
    this.safeMode = false;
    this.hiding = false;
    this.nextHideAt = 0;
    /** Timestamps of recent deaths, used to trigger safe mode. */
    this.recentDeaths = [];
    /** Reflex bookkeeping for the skill-driven (non-mineflayer) path. */
    this._reflexFight = false;
    this._reflexFightAt = 0;
    this._reflexEatBusy = false;
    this._reflexEatAt = 0;
    this._reflexArmorBusy = false;
    this._reflexArmorAt = 0;
    /** Retreat state (skillRetreat): the target we are backing away from, and its expiry. */
    this._retreatTargetId = null;
    this._retreatUntil = 0;
    this._retreatStart = null;
    this._retreatCheckAt = 0;
    /** Last observed health, for the "hurt this tick -> charge" reflex (plan §②). */
    this._lastHealth = null;
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

  /**
   * Read-only views of the single owner (RETIREMENT S2).
   *
   * The authoritative state is `this.slot.current`; these names stay because the panel,
   * the tests and `preempt()` have read them since P0.
   */
  get activeTask() {
    return this.slot.brainTask;
  }

  get currentTask() {
    return this.slot.brainTask;
  }

  /** B1/B2 state lives in the slot (S2b); these views keep callers and tests working. */
  get blockedGoal() {
    return this.slot.blockedGoal;
  }

  get quarantine() {
    return this.slot.quarantine;
  }

  get failCounts() {
    return this.slot.failCounts;
  }

  get _progressSeen() {
    return this.slot._progressSeen;
  }

  get _stalls() {
    return this.slot._stalls;
  }

  /** The live mineflayer instance (may be null while reconnecting). */
  get bot() {
    return this.ctx.controller.bot;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.log.info('brain online');
    /**
     * A loop that throws every tick must not hide at debug level.
     *
     * Live 2026-10-13: `needsRescue` threw for the clientmod body on every fast-loop
     * tick; the debug-level catch kept the log clean while auto-eat, danger retreat
     * and the auto-fight reflex were silently dead. First failure of each loop is now
     * a WARN, then rate-limited to once a minute so a permanently broken loop stays
     * visible without flooding the log.
     */
    this._loopErrorAt = this._loopErrorAt || new Map();
    const reportLoopError = (loop) => (e) => {
      const now = Date.now();
      const last = this._loopErrorAt.get(loop) || 0;
      if (now - last > 60000) {
        this._loopErrorAt.set(loop, now);
        this.log.warn(`${loop} loop error: ${e.message} - reflexes are disabled while this repeats`);
      } else {
        this.log.debug(`${loop} loop: ${e.message}`);
      }
    };
    this.fastTimer = setInterval(() => this.fastLoop().catch(reportLoopError('fast')), 600);
    this.slowTimer = setInterval(() => this.slowLoop().catch(reportLoopError('slow')), this.cfg.behaviour.idleThinkIntervalMs);
    this.slowLoop().catch(reportLoopError('slow'));
  }

  stop() {
    this.running = false;
    if (this.fastTimer) clearInterval(this.fastTimer);
    if (this.slowTimer) clearInterval(this.slowTimer);
    if (this.currentTask) this.currentTask.cancel();
    this.proposals.supersede('brain stopped');
    this.saveStateNow();
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
    if (this.perceptionWake && this.ctx.body && typeof this.ctx.body.snapshot === 'function') {
      try {
        // Edge detection only: no model call happens here; subscribers own that policy.
        this.perceptionWake.observe(this.ctx.body.snapshot());
      } catch (err) {
        this.log.debug(`perception wake failed: ${err.message}`);
      }
    }
    /**
     * Safety valve: a combat skill must not freeze every later reflex forever. Live
     * 2026-10-18 a no-ammo shoot left the guard set while zombies closed in; the bot
     * stood still until an explicit !attack. The skill timeout is 45s, so 20s is a
     * deliberately aggressive release for a stuck promise; the double-engage risk is
     * bounded by combatState's own lease.
     */
    if (this._reflexFight && this._reflexFightAt && Date.now() - this._reflexFightAt > 20000) {
      this.log.warn(`reflex fight guard stuck for ${Math.round((Date.now() - this._reflexFightAt) / 1000)}s - releasing`);
      this._reflexFight = false;
      this._reflexFightAt = 0;
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

    /**
     * Which executor the reflexes use.
     *
     * The servo classes (AutoEat / Combat / ToolManager) read `controller.bot`, which
     * is null on a client-mod body: they no-op, or - as `needsRescue` did until
     * 2026-10-13 - throw and take the whole loop down. For those bodies every reflex
     * goes through the skill layer instead, the same code the `!` commands and the
     * LLM drive (live-proven: the chat `attack` skill killed a point-blank skeleton).
     */
    const skillDriven = this.ctx.bodyKind !== 'mineflayer';

    /**
     * A container screen blocks aiming/attack/movement. Close it as soon as a hostile is
     * actually present, before danger/engage; waiting for a flank movement cost ~5s and
     * a life in the 2026-10-18 GUI test. Pause/chat screens are not auto-closable and
     * remain an explicit blocked state.
     */
    if (skillDriven && this.ctx.body && typeof this.ctx.body.ensureCombatScreenClear === 'function') {
      // Only a hostile inside the active combat radius should close the operator's GUI;
      // using the 24-block scan made a workbench close for a mob 20 blocks away.
      const nearby = this.ctx.world.hostiles(15) || [];
      if (nearby.length) {
        const clear = await this.ctx.body.ensureCombatScreenClear().catch(() => false);
        if (!clear) {
          this.log.warn('reflex blocked by an open non-container screen');
          return;
        }
      }
    }

    if (world.isInDanger()) {
      /**
       * A melee fallback is already running: do not start another retreat, or its next
       * tick cancels the sword attack (live 2026-10-18: blocked retreat -> attack was
       * immediately overridden by another danger tick and the bot died).
       */
      if (this._reflexFight) return;
      this.log.warn('danger detected, retreating');
      if (skillDriven) {
        /**
         * The old code only ran the mineflayer retreat - on a client-mod body the branch
         * spammed "danger detected, retreating" and did nothing (live 2026-10-13: the
         * bot stood in the open at 4.8 hp until it died). Now it backs away for real.
         */
        const handled = await this.skillRetreat();
        if (handled) return;
        // Danger with no hostile inside 7 blocks: do not silently stand here; let the
        // eat/engage chain below run (live 2026-10-18: 20s of "danger detected" while
        // the gun was dry and the nearest zombie was outside the retreat list).
        this.log.warn('danger but no retreat target within 7 blocks - continuing reflexes');
      } else {
        await combat.retreat(12);
        await eat.tick(true);
        return;
      }
    }

    /** Danger over: cancel a retreat that is still running so its keys are released. */
    if (skillDriven && this._retreatTargetId !== null && Date.now() < this._retreatUntil + 1000) {
      if (this.ctx.body && typeof this.ctx.body.stop === 'function') {
        await this.ctx.body.stop().catch(() => false);
      }
      this._retreatTargetId = null;
      this._retreatUntil = 0;
    }

    if (skillDriven) {
      await this.reflexEat();
    } else {
      await eat.tick();
    }

    /**
     * Engage reflex (COMBAT-PLAN v3 §②).
     *
     * Fight when: something is within 5 blocks; OR we are wounded below the engage
     * threshold (16 by config); OR we were hurt THIS tick with anything hostile in the
     * 24-block scan - a pillager shooting from 15 blocks must be charged, not ignored.
     * Stalled-and-ignored targets are skipped (combatState), and an explicit fight task
     * (attack/defend/shoot through the hub) suppresses the reflex so the same target is
     * not engaged twice.
     */
    const snapNow = typeof world.snapshot === 'function' ? world.snapshot() : null;
    const hpNow = snapNow && typeof snapNow.health === 'number' ? snapNow.health : null;
    const hurtThisTick = hpNow !== null && this._lastHealth !== null && hpNow < this._lastHealth - 0.01;
    if (hpNow !== null) this._lastHealth = hpNow;
    const engageHealthThreshold = (this.cfg.behaviour && this.cfg.behaviour.engageHealthThreshold) || 16;
    /**
     * Operator rule 2026-10-18: active combat radius is 15 blocks on X/Z; the vertical
     * window keeps the original attack-skill +-4. The body can still see 24 blocks, but
     * the reflex must not chase a target 20 blocks away just because the scan sees it.
     */
    const engageRadiusXZ = (this.cfg.behaviour && this.cfg.behaviour.engageRadiusXZ) || 15;
    const engageRadiusY = (this.cfg.behaviour && this.cfg.behaviour.engageRadiusY) || 4;
    const origin = snapNow && snapNow.position ? snapNow.position : null;
    const candidates = (world.hostiles(24) || [])
      .map((h) => {
        const pos = h.entity && h.entity.position;
        const xzDistance = origin && pos ? Math.hypot(pos.x - origin.x, pos.z - origin.z) : h.distance;
        const verticalDistance = origin && pos ? Math.abs(pos.y - origin.y) : null;
        return { ...h, xzDistance, verticalDistance };
      })
      .filter((h) => !combatState.shouldSkip(h.entity.id, h.distance))
      .filter((h) => !origin || (h.xzDistance <= engageRadiusXZ && (h.verticalDistance === null || h.verticalDistance <= engageRadiusY)))
      .sort((a, b) => (a.xzDistance || 0) - (b.xzDistance || 0));
    const nearest = candidates.length ? candidates[0] : null;
    /**
     * Proactive radius: any hostile inside the 15-block XZ / +-4 Y window is engaged;
     * the old "only <=5 or wounded" condition made the 15-block radius meaningless.
     */
    const wantFight = !!nearest;
    if (wantFight && this.cfg.behaviour.autoFight && !this._reflexFight && !this.hostileFightTaskActive()) {
      this.log.info(`hostile ${nearest.entity.name} at ${nearest.distance.toFixed(1)} blocks (xz ${nearest.xzDistance.toFixed(1)}) - engaging`);
      this.preempt();
      if (skillDriven) {
        // Fire-and-forget with a guard: the fight can run for tens of seconds and
        // must not block the other reflexes (eat/armor/refresh keep ticking).
        this._reflexFight = true;
        this._reflexFightAt = Date.now();
        /**
         * Prefer the gun whenever one is available, even point-blank. The shoot skill
         * owns the close-range policy: it backs away while firing when there is room,
         * and switches to the sword/axe only when that retreat cannot move. Choosing
         * melee here (the old `distance <= 4.5` rule) made a healthy bot punch with the
         * gun's stock while a retreat was still possible - operator report 2026-10-18.
         */
        const useGun = !!(snapNow && combatSkills.chooseGun(snapNow, { distance: nearest.distance }).ok);
        const run = useGun
          ? skills.run('shoot', this.ctx, { id: nearest.entity.id })
          : skills.run('attack', this.ctx, {});
        Promise.resolve(run)
          .then((result) => {
            /**
             * The gun path may be unavailable or the target fully covered - the melee
             * charge is the fallback, never a refusal to fight.
             */
            if (useGun && result && result.ok === false && GUN_FALLBACK.has(result.failure)) {
              return skills.run('attack', this.ctx, {});
            }
            return result;
          })
          .catch((e) => this.log.debug(`reflex fight failed: ${e.message}`))
          .finally(async () => {
            // A burst can kill the target on its last round; that exits through
            // target_gone, not no_ammo, leaving an empty gun for the next fight.
            await this.reloadAfterFight();
            this._reflexFight = false;
            this._reflexFightAt = 0;
          });
      } else {
        await combat.defend();
      }
    }

    if (!skillDriven) {
      await tools.equipArmor();
    } else if (!this._reflexArmorBusy && Date.now() - this._reflexArmorAt > 30000) {
      this._reflexArmorAt = Date.now();
      this._reflexArmorBusy = true;
      skills
        .run('armor', this.ctx)
        .catch(() => null)
        .finally(() => {
          this._reflexArmorBusy = false;
        });
    }
  }

  /**
   * Skill-driven auto-eat for bodies whose servo layer has no mineflayer instance
   * (see `skillDriven` in fastLoop). The threshold decision stays here; the skill
   * layer owns the eating. Rate-limited so a hungry bag with no food cannot flood
   * the task lane every tick.
   */
  async reflexEat() {
    if (this._reflexEatBusy || this._reflexFight) return;
    /**
     * Do not brandish food with a hostile actually in reach.
     *
     * Eating equips the food, and the hand is the weapon's seat: live 2026-10-13 an
     * auto-eat mid-fight swapped the sword for bread and the fight swung bread for
     * its whole 15s timeout. A hostile 6-10 blocks away is NOT in reach: blocking on
     * the old 10-block radius left a hungry bot neither eating nor fighting when
     * auto-fight did not engage. The engage reflex owns that band; only a threat
     * within melee reach suppresses the meal.
     */
    if (typeof this.ctx.world.nearestHostile === 'function' && this.ctx.world.nearestHostile(5)) return;
    const snap = typeof this.ctx.world.snapshot === 'function' ? this.ctx.world.snapshot() : null;
    const food = snap && typeof snap.food === 'number' ? snap.food : null;
    const threshold = (this.cfg.behaviour && this.cfg.behaviour.eatFoodThreshold) || 16;
    if (food === null || food > threshold) return;
    if (Date.now() - this._reflexEatAt < 5000) return;
    this._reflexEatAt = Date.now();
    this._reflexEatBusy = true;
    try {
      await skills.run('eat', this.ctx);
    } catch (e) {
      this.log.debug(`reflex eat failed: ${e.message}`);
    } finally {
      this._reflexEatBusy = false;
    }
  }

  /**
   * The skill-driven retreat (COMBAT-PLAN v3 §①): below the flee threshold, back away
   * from the closest threat while facing it, and keep shooting while a loaded gun is
   * in hand (preference rifle > smg > mg > pistol > anything else).
   *
   * Issued once and left running for ~3s; this tick only re-issues after the window
   * expires. When the danger passes the main loop cancels it with stop() - and the
   * no-gun case still backs away while swinging (the client action owns that fallback).
   */
  async skillRetreat() {
    const body = this.ctx.body;
    if (!body || typeof body.retreatFrom !== 'function') return false;
    const list = (this.ctx.world.hostiles(7) || [])
      .filter((h) => !combatState.shouldSkip(h.entity.id, h.distance))
      .sort((a, b) => (a.distance || 0) - (b.distance || 0));
    if (!list.length) return false; // no hostile to retreat from: let the other reflexes run
    const threat = list[0];
    const now = Date.now();

    /**
     * A retreat command lasts ~3s, but we cannot trust "accepted" as "moving". While one
     * is running, re-check displacement every ~700ms. Live 2026-10-18: a 2.7s early return
     * here hid a blocked retreat until the bot was nearly dead; the melee fallback then
     * started, was cancelled by the next danger tick, and the bot died.
     */
    if (this._retreatTargetId === threat.entity.id && now < this._retreatUntil) {
      if (now < this._retreatCheckAt) return true;
      const moved = await this.confirmRetreatMovement(body, this._retreatStart);
      if (moved !== null && moved < 0.35) {
        return this.runMeleeFallback(threat, moved);
      }
      this._retreatCheckAt = Date.now() + 700;
      return true;
    }

    const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
    let fire = false;
    const chosen = combatSkills.chooseGun(snap, { distance: threat.distance });
    if (chosen.ok) {
      const held = snap && snap.heldItem ? bare(snap.heldItem) : null;
      if (held !== bare(chosen.gun.item)) {
        await combatSkills.equipVerified(this.ctx, chosen.gun.item);
      }
      fire = true;
    }
    const before = snap && snap.position ? { ...snap.position } : null;
    this.log.info(`danger: retreating from ${bare(threat.entity.name)} at ${Math.round(threat.distance || 0)} blocks (${fire ? 'fire' : 'no gun'})`);
    const accepted = await body.retreatFrom({ id: threat.entity.id }, { ms: 3000, fire }).catch(() => false);
    /**
     * A retreat command is not a retreat: the client can accept it while a pit/wall
     * pins the body. Do not call a single 700ms sample "blocked" - the first sample may
     * land during client startup/knockback. Require two consecutive samples without
     * horizontal movement; a single snapshot was the false-positive source on 2026-10-18.
     */
    const moved = accepted ? await this.confirmRetreatMovement(body, before) : null;
    if (!accepted || (moved !== null && moved < 0.35)) {
      return this.runMeleeFallback(threat, moved);
    }
    this._retreatTargetId = threat.entity.id;
    this._retreatUntil = now + 2700;
    this._retreatStart = before;
    this._retreatCheckAt = Date.now() + 700;
    return true;
  }

  /**
   * Measure real horizontal displacement from the retreat start at 700ms intervals.
   * Two consecutive samples below 0.35 blocks are required before declaring "blocked";
   * returns the largest observed displacement (null when refresh has no position data).
   */
  async confirmRetreatMovement(body, before) {
    if (!before || typeof body.refresh !== 'function') return null;
    let moved = null;
    for (let i = 0; i < 2; i += 1) {
      await sleep(700);
      const after = await body.refresh(true).catch(() => null);
      if (!after || !after.position) continue;
      moved = Math.hypot(after.position.x - before.x, after.position.z - before.z);
      if (moved >= 0.35) return moved; // movement started; not blocked
    }
    return moved;
  }

  /**
   * Refill the held gun after a fight when the burst emptied it but the target died
   * before the shoot skill reached its no_ammo branch.
   */
  async reloadAfterFight() {
    const body = this.ctx.body;
    if (!body || typeof body.reload !== 'function' || typeof body.snapshot !== 'function') return;
    try {
      const snap = body.snapshot();
      const held = snap && snap.heldItem ? String(snap.heldItem) : null;
      const gun = held && Array.isArray(snap.guns) ? snap.guns.find((g) => g.item === held) : null;
      if (!gun || gun.inventoryAmmo || (gun.magazine || 0) + (gun.dummy || 0) > 0) return;
      this.log.info(`post-fight reload: ${gun.item} magazine=0`);
      await body.reload();
      const deadline = Date.now() + 4500;
      let refilled = null;
      while (Date.now() < deadline) {
        await sleep(500);
        const after = typeof body.refresh === 'function' ? await body.refresh(true).catch(() => null) : null;
        refilled = after && Array.isArray(after.guns)
          ? after.guns.find((g) => g.item === gun.item)
          : null;
        if (refilled && (refilled.magazine || 0) + (refilled.dummy || 0) > 0) break;
      }
      this.log.info(
        `post-fight reload: ${gun.item} -> magazine=${refilled && Number.isFinite(refilled.magazine) ? refilled.magazine : '?'}`
      );
    } catch (err) {
      this.log.warn(`post-fight reload failed: ${err.message}`);
    }
  }

  /**
   * Sword/axe fallback for a blocked retreat. The `_reflexFight` guard prevents the
   * danger branch from issuing another retreat and cancelling this attack mid-swing.
   */
  async runMeleeFallback(threat, moved = null) {
    this.log.warn(
      `danger: retreat blocked (${moved === null ? 'no movement data' : `moved ${moved.toFixed(2)} blocks`}) ` +
      `- switching to melee against ${bare(threat.entity.name)}`
    );
    this._retreatTargetId = null;
    this._retreatUntil = 0;
    this._retreatCheckAt = 0;
    this._retreatStart = null;
    this._reflexFight = true;
    this._reflexFightAt = Date.now();
    try {
      const melee = await skills.run('attack', this.ctx, { timeoutMs: Math.min(5000, 1500 + threat.distance * 400) });
      this.log.info(`danger: melee fallback ${melee && melee.ok ? 'killed' : 'failed'}: ${(melee && (melee.reason || melee.detail)) || 'no result'}`);
    } catch (err) {
      this.log.warn(`danger: melee fallback failed: ${err.message}`);
    } finally {
      this._reflexFight = false;
      this._reflexFightAt = 0;
    }
    return true;
  }

  /**
   * True while an explicit fight task owns the fight (attack/defend/shoot submitted
   * through the task hub) - the reflex must not double-fire on the same target
   * (live 2026-10-13: the command attack and the reflex both engaged one pillager).
   *
   * A live combat skill counts too, no matter who launched it: the `!` channel and the
   * LLM actuator run skills straight through the registry and bypass the task hub, so
   * the hub check alone cannot see them (live 2026-10-13: the explicit `!shoot` and a
   * reflex shoot replaced each other's bursts until a melee fallback swapped the gun
   * out of the hand and both flows died with not_a_gun).
   */
  hostileFightTaskActive() {
    if (combatState.combatSkillActive()) return true;
    const hub = this.ctx.hub;
    const current = hub && typeof hub.status === 'function' ? hub.status().current : null;
    const name = (this.currentTask && this.currentTask.name) || (current && current.name) || '';
    return /^(attack|defend|shoot)$/.test(name);
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
    /**
     * A28/A14: an unanswered question must not keep a plan parked forever.
     *
     * `ProposalDesk.sweep()` existed from S3 but nothing called it in the live loop; with
     * `planner.mode=off` no new proposal is ever made, so the "swept on the next propose"
     * comment never fired and a `wait_for_player` plan stayed parked past its TTL (live
     * 2026-10-20). Sweep on every heartbeat, before the pause/attached gates: expiry is a
     * fact about the question, not a request to plan. The `proposal:expired` listener below
     * turns it into `resume(planId, false)` - no answer is still not consent.
     */
    try {
      this.proposals.sweep();
    } catch (err) {
      this.log.warn(`proposal sweep failed: ${err.message}`);
    }
    /**
     * Action-brain autonomous proposals: the coordinator owns the 5min/30s clocks and the
     * prep/execution goal injection. It never touches the body; keep it off the critical
     * path so a slow goal endpoint cannot delay reflexes or task scheduling.
     */
    if (this.ctx.proposalCoordinator) {
      Promise.resolve(this.ctx.proposalCoordinator.tick()).catch((err) => {
        this.log.debug(`autonomous proposal tick failed: ${err.message}`);
      });
    }
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
    if (this.plannerMode === 'off') {
      this.lastDecision = { at: Date.now(), decision: 'off', note: 'planner disabled by config (planner.mode=off)' };
      return;
    }
    if (this.plannerMode === 'proposals') {
      await this._proposeOrRun();
      return;
    }

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
  /**
   * The next goal as a declarative candidate, or null (idle).
   *
   * RETIREMENT S1/S3: the rule table lives in `src/planner/evaluator.js`; this method picks
   * the first candidate whose TASK name is not quarantined. `decide()` builds it (legacy),
   * `proposeNext()` offers it to the ProposalDesk (proposals mode).
   */
  nextCandidate() {
    const candidates = evaluate(this.ctx, {
      cfg: this.cfg,
      onRuleError: ({ rule, error }) => this.log.warn(`rule ${rule} threw: ${error}`),
      onRuleSkip: ({ rule, reason }) => this.log.debug(`rule ${rule} skipped: ${reason}`)
    });
    for (const candidate of candidates) {
      if (this.isQuarantined(candidate.name)) {
        this.log.debug(`skipping quarantined goal ${candidate.name} (rule ${candidate.rule})`);
        continue;
      }
      return candidate;
    }
    return null;
  }

  /**
   * The rule table as a Task. Order matters: earlier rules win. Reads everything through
   * the Body snapshot, so the same planner drives mineflayer, mock and client-mod bodies.
   * @returns {import('../tasks/task').Task|null}
   */
  decide() {
    const candidate = this.nextCandidate();
    if (!candidate) return null;
    return buildTask(this.ctx, candidate);
  }

  /** Proposals mode: offer the next candidate, never execute it here. */
  proposeNext() {
    const candidate = this.nextCandidate();
    if (!candidate) return null;
    return this.proposals.propose(candidate);
  }

  /** Proposals mode step used by `slowLoop`: propose, or run a standing-authorized target. */
  async _proposeOrRun() {
    const outcome = this.proposeNext();
    if (!outcome || !outcome.ok) {
      if (outcome && outcome.reason === 'cooldown') {
        this.lastDecision = {
          at: Date.now(),
          decision: 'proposal-cooling',
          note: { target: outcome.target, retryAt: outcome.retryAt }
        };
      } else if (outcome && outcome.reason === 'pending') {
        this.lastDecision = { at: Date.now(), decision: 'proposal-pending', note: outcome.proposal.id };
      } else {
        this.lastDecision = { at: Date.now(), decision: 'idle', note: 'no applicable rule (goals may be quarantined)' };
        this._idleTicks = (this._idleTicks || 0) + 1;
      }
      return;
    }
    this._idleTicks = 0;
    if (outcome.autoAccepted) {
      const task = buildTask(this.ctx, outcome.proposal.candidate);
      this.lastDecision = {
        at: Date.now(),
        decision: `proposal:${outcome.proposal.target}`,
        description: 'standing authorization'
      };
      if (task) await this.runTask(task);
      return;
    }
    this.lastDecision = {
      at: Date.now(),
      decision: `propose:${outcome.proposal.target}`,
      description: outcome.proposal.reason
    };
    this.log.info(`proposed ${outcome.proposal.target} - waiting for the player (!proposal accept)`);
  }

  /**
   * Local knowledge for a goal: best method + best remembered answer (P1 §1.6.2).
   *
   * Retrieval only - it never executes anything and never calls a model. The planner,
   * the language brain and `!method` all read the same result shape.
   */
  suggestMethod(goal, context = {}) {
    const matches = this.methods ? this.methods.search(goal, context, { limit: 1 }) : [];
    const answer = this.answers ? this.answers.recall(goal, context) : null;
    const memories = this.memoryStore
      ? this.memoryStore.recall(goal, { limit: 2 }).map(({ entry, score }) => ({
          category: entry.category,
          text: entry.text,
          tags: entry.tags,
          source: entry.source,
          at: entry.at,
          score
        }))
      : [];
    return {
      goal,
      method: matches[0]
        ? {
            id: matches[0].method.id,
            goal: matches[0].method.goal,
            method: matches[0].method.method,
            conditions: matches[0].method.conditions,
            success: matches[0].method.success,
            failure: matches[0].method.failure,
            score: matches[0].score
          }
        : null,
      answer: answer
        ? {
            question: answer.fact.question,
            answer: answer.fact.answer,
            conditions: answer.fact.conditions,
            at: answer.fact.at,
            score: answer.score
          }
        : null,
      memories
    };
  }

  /** Run a plan; a question step becomes a proposal instead of a second question system. */
  async runPlan(planId, options = {}) {
    const result = await this.planRunner.run(planId, options);
    if (result && result.waiting) {
      return { ...result, question: this.planQuestions.ask(planId) };
    }
    return result;
  }

  /**
   * Continue a parked plan from an answer.
   *
   * The live PlanService path publishes `plan:resumed`/step events and persists; the raw
   * PlanRunner path is kept for a Brain fixture that deliberately runs without it.
   */
  async _answerPlan(planId, answer, reason) {
    if (this.planService) {
      const started = this.planService.resume(planId, answer, { reason });
      if (!started.ok) return started;
      const settled = await started.promise.catch((err) => ({ ok: false, reason: err.message, results: [] }));
      return { ...settled, accepted: true, plan: this.planService.get(planId) };
    }
    return this.planRunner.resume(planId, answer);
  }

  /**
   * A14: a free-text player answer to a parked `wait_for_player` question.
   *
   * The answer is not just a "yes": it is remembered with its conditions, written to the
   * shared memory store (`mc_memory` can recall it), forwarded to the bound action brain,
   * and only then resumes the plan. Progress is kept; the model gets the answer text plus
   * the resume event, so it can continue with the information instead of asking again.
   */
  async answerPlanQuestion(text, options = {}) {
    const answer = String(text || '').trim();
    if (!answer) return { ok: false, reason: 'empty-answer' };

    let pending = this.proposals.pending();
    if (!pending || !pending.candidate || pending.candidate.type !== 'plan_question') {
      /** After a restart the plan can be waiting while the proposal is gone: re-ask once. */
      const waiting = this.planService
        ? this.planService.list().find((plan) => plan.state === 'waiting' && plan.planId)
        : null;
      if (waiting) this.planQuestions.ask(waiting.planId);
      pending = this.proposals.pending();
    }
    if (!pending || !pending.candidate || pending.candidate.type !== 'plan_question') {
      return { ok: false, reason: 'no-plan-question' };
    }
    const args = pending.candidate.args || {};
    const planId = args.planId;
    const stepId = args.stepId || null;
    if (!planId) return { ok: false, reason: 'no-plan-question' };
    const question = pending.reason || pending.candidate.reason || `plan ${planId}`;

    const snap =
      this.ctx && this.ctx.body && typeof this.ctx.body.snapshot === 'function'
        ? this.ctx.body.snapshot()
        : null;
    const dimension = snap && (snap.dimension || (snap.world && snap.world.dimension));
    const conditions = dimension ? { dimension } : {};
    const fact = this.answers
      ? this.answers.remember({ question, answer, conditions, source: 'player' })
      : null;
    const memory = this.memoryStore
      ? this.memoryStore.remember('episodic', {
          text: `玩家回答计划问题「${question}」：${answer}`,
          tags: ['a14', 'player-answer', String(planId), stepId].filter(Boolean),
          source: 'player-answer',
          data: { planId, stepId, question, answer }
        })
      : null;

    /** The action brain must see the answer before the resume event tells it to continue. */
    let forwarded = null;
    if (this.ctx && typeof this.ctx.forwardToActionBrain === 'function') {
      try {
        forwarded = await this.ctx.forwardToActionBrain(
          `[PLAYER ANSWER] plan=${planId} step=${stepId || '-'} question="${question}" answer="${answer}"`,
          { source: 'player-answer' }
        );
      } catch (err) {
        forwarded = { ok: false, reason: err.message };
      }
    }

    let resumed;
    if (this.planService) {
      const started = this.planService.resume(planId, true, { reason: 'player-answer' });
      if (!started.ok) {
        return { ok: false, reason: started.reason || 'resume-failed', fact, memory, forwarded };
      }
      resumed = { ok: true, planId };
    } else if (this.planRunner) {
      resumed = await this.planRunner.resume(planId, true).catch((err) => ({ ok: false, reason: err.message }));
    } else {
      return { ok: false, reason: 'no-plan-runner', fact, memory, forwarded };
    }
    /** Mark the question answered only after the plan actually resumed. */
    if (this.proposals && typeof this.proposals.accept === 'function') {
      this.proposals.accept(pending.id, { by: options.by || 'player', note: 'answer' });
    }
    return {
      ok: true,
      planId,
      stepId,
      question,
      answer,
      fact,
      memory: memory && memory.entry ? memory.entry : null,
      forwarded,
      resumed
    };
  }

  /** Player accepted a proposal: build the task and enqueue it as an explicit directive. */
  async acceptProposal(id = null, options = {}) {
    const pending = this.proposals.pending();
    const candidate = pending && pending.candidate ? pending.candidate : null;
    /**
     * Action-brain autonomous proposals are not local tasks. The coordinator injects the
     * execution goal first; only an accepted goal lets the harness execute.
     */
    if (candidate && candidate.autonomous === true && (!id || pending.id === id)) {
      const coordinator = this.ctx.proposalCoordinator;
      if (!coordinator || typeof coordinator.accept !== 'function') {
        return { ok: false, reason: 'proposal-autonomy-unavailable' };
      }
      return coordinator.accept(pending);
    }
    const result = this.proposals.accept(id, options);
    if (!result.ok) return result;
    const acceptedCandidate = result.proposal.candidate;
    if (acceptedCandidate && acceptedCandidate.type === 'plan_question') {
      const args = acceptedCandidate.args || {};
      const resumed = await this._answerPlan(args.planId, true, 'accepted');
      return { ...result, resumed };
    }
    const task = buildTask(this.ctx, acceptedCandidate);
    if (!task) return { ok: false, reason: 'unknown-task-type' };
    /** The accepted proposal is the request; its id is the provenance of the work. */
    if (!task.requestId) task.requestId = result.proposal.id;
    const receipt = await this.enqueue(task, { level: 'directive', source: 'proposal' });
    return { ...result, receipt };
  }

  /**
   * A proposal generated by the DeepSeek harness (not the local rule table).
   * With planner.mode=off this is the only autonomous-proposal entry point; the local
   * ProposalDesk still owns the question/cooldown/standing-authorization lifecycle.
   */
  async proposeFromHarness(candidate = {}) {
    const type = String(candidate.type || '').trim();
    const name = String(candidate.name || type).trim();
    if (!type || !name) return { ok: false, reason: 'type-required' };
    const autonomous = candidate.autonomous === true;
    let normalized = {
      rule: 'deepseek-harness',
      name,
      type,
      args: candidate.args && typeof candidate.args === 'object' ? candidate.args : {},
      reason: String(candidate.reason || '').slice(0, 500)
    };
    if (autonomous) {
      const coordinator = this.ctx.proposalCoordinator;
      if (!coordinator || coordinator.awaitingProposal !== true) {
        return { ok: false, reason: 'not-in-proposal-round' };
      }
      normalized = {
        ...normalized,
        rule: 'action-brain-autonomous',
        autonomous: true,
        ttlMs: Number(coordinator.responseMs) > 0 ? Number(coordinator.responseMs) : 30000,
        allowStandingAuth: false,
        source: 'action-brain'
      };
      /** Validate before the player is asked; a bad proposal must not consume the 30s window. */
      const builder = TASK_BUILDERS[type];
      const commandType =
        !builder &&
        COMMAND_PROPOSAL_TYPES.has(type) &&
        this.ctx.chat &&
        this.ctx.chat.handlers &&
        typeof this.ctx.chat.handlers[type] === 'function';
      if (!builder && !commandType) return { ok: false, reason: 'unknown-task-type' };
      if (builder) {
        const task = buildTask(this.ctx, normalized);
        if (!task) return { ok: false, reason: 'unknown-task-type' };
      } else {
        /**
         * `farm`/`sleep`/`smelt` etc. are real commands in the local command table but
         * have no TASK_BUILDERS factory. The autonomous path does not build a local task:
         * it only asks the player, then the action brain executes via mc_step. Accepting
         * the command-table proposal keeps "propose what the body can actually do" honest.
         */
        normalized.commandType = true;
      }
      /**
       * Automatic curriculum (Voyager-style, 2026-10-29): the proposal must not fall below
       * the band the completed-task ledger has earned. A refusal is a tool result the model
       * can react to (it sees `reason`/`required`) and the coordinator allows two retries
       * before relaxing, so the round cannot deadlock.
       */
      const curriculum = this.ctx && this.ctx.curriculum;
      if (curriculum && typeof curriculum.validate === 'function') {
        const verdict = curriculum.validate({ type, name, args: normalized.args });
        if (!verdict.ok) {
          return {
            ok: false,
            reason: verdict.reason,
            required: verdict.required,
            actual: verdict.actual,
            level: verdict.level,
            detail:
              `curriculum: this proposal is difficulty ${verdict.actual}, but the current band is ` +
              `${verdict.required} (level ${verdict.level}). Propose a harder-but-reachable single action ` +
              `(see the AUTOMATIC CURRICULUM block in this goal).`
          };
        }
        normalized.difficulty = verdict.actual;
        normalized.curriculum = {
          level: verdict.level,
          required: verdict.required,
          relaxed: verdict.reason === 'curriculum-relaxed'
        };
      }
    }
    const outcome = this.proposals.propose(normalized);
    if (!outcome.ok || !outcome.autoAccepted) return outcome;
    /** Autonomous proposals disable standing authorization; this is a defensive branch. */
    if (autonomous) {
      this.proposals.reject(outcome.proposal.id, { reason: 'autonomous-requires-explicit-approval' });
      return { ok: false, reason: 'autonomous-requires-explicit-approval' };
    }
    const task = buildTask(this.ctx, outcome.proposal.candidate);
    if (!task) return { ...outcome, ok: false, reason: 'unknown-task-type' };
    if (!task.requestId) task.requestId = outcome.proposal.id;
    const receipt = await this.enqueue(task, { level: 'autonomous', source: 'harness-proposal' });
    return { ...outcome, receipt };
  }

  async rejectProposal(id = null, options = {}) {
    const pending = this.proposals.pending();
    const planQuestion =
      pending && pending.candidate && pending.candidate.type === 'plan_question'
        ? pending.candidate.args
        : null;
    const result = this.proposals.reject(id, options);
    if (result.ok && planQuestion) {
      const resumed = await this._answerPlan(planQuestion.planId, false, 'rejected');
      return { ...result, resumed };
    }
    return result;
  }

  // ------------------------------------------------------------- task runner

  /**
   * Turn one terminal task/plan event into a natural-language episodic memory entry.
   * This is the write side of the shared-memory loop; `LanguageAgent.memoryFor` and the
   * method/answer libraries read it later.
   *
   * @param {object} event TaskEvents event
   * @returns {boolean} true when a new memory entry was written
   */
  rememberEvent(event) {
    if (!event || typeof event.type !== 'string' || !this.memoryStore) return false;
    let text;
    let tags;
    let source;
    let data;
    if (event.type === 'task:done' || event.type === 'task:failed' || event.type === 'task:cancelled') {
      const status = event.type.split(':')[1];
      const taskId = event.taskId || event.name || 'task';
      const reason = event.reason ? String(event.reason).slice(0, 400) : '';
      text = `任务 ${taskId} ${status}${reason ? `：${reason}` : ''}`;
      tags = ['task', String(taskId)];
      source = 'task-event';
      data = {
        taskId,
        planId: event.planId || null,
        stepId: event.stepId || null,
        status,
        reason: reason || null
      };
    } else if (
      event.type === 'plan:completed' ||
      event.type === 'plan:partial' ||
      event.type === 'plan:failed' ||
      event.type === 'plan:cancelled'
    ) {
      const status = event.type.split(':')[1];
      const plan = this.plans && typeof this.plans.get === 'function' ? this.plans.get(event.planId) : null;
      const goal = plan && plan.goal ? String(plan.goal).slice(0, 240) : '';
      const reason = event.reason ? String(event.reason).slice(0, 400) : '';
      text = `计划${goal ? `「${goal}」` : ''} ${status}${reason ? `：${reason}` : ''}`;
      tags = ['plan', String(event.planId || '')];
      source = 'plan-event';
      data = { planId: event.planId || null, status, reason: reason || null };
    } else {
      return false;
    }
    try {
      const stored = this.memoryStore.remember('episodic', { text, tags, source, data });
      return !!(stored && stored.ok);
    } catch (err) {
      this.log.warn(`task memory write failed: ${err.message}`);
      return false;
    }
  }

  /**
   * M4/A19: the only task-submission surface for a sandboxed code skill.
   *
   * The code skill never calls the body directly; it submits a normal task candidate here,
   * which goes through `buildTask` + `enqueue` (and therefore TaskSlot + the permission gate).
   * The call returns the acceptance receipt, not the task result; completion is a task event.
   */
  async submitExternalTask(candidate = {}, options = {}) {
    const type = String(candidate.type || '').trim();
    if (!type || !TASK_BUILDERS[type]) {
      return { ok: false, reason: 'unknown-task-type', type: type || null };
    }
    let task;
    try {
      task = buildTask(this.ctx, { type, args: candidate.args || {} });
    } catch (err) {
      return { ok: false, reason: 'task-build-failed', error: err.message };
    }
    if (!task) return { ok: false, reason: 'task-build-failed' };
    task.source = 'code-skill';
    const receipt = await this.enqueue(task, {
      level: 'directive',
      source: 'code-skill',
      requestId: options.requestId || `code-skill-${Date.now()}`
    });
    return { ...receipt, taskId: task.taskId || null, type };
  }

  /** Task execution, settlement and lifecycle events live in the slot (S2b). */
  async runTask(task) {
    return this.slot.runTask(task);
  }


  /** B2 (strike backoff) lives in the slot (S2b). */
  maybeRetry(task) {
    return this.slot.maybeRetry(task);
  }


  /** Run whatever is waiting in the queue, one task at a time. */
  async drainQueue() {
    if (this.activeTask || this.paused || this.stopped || !this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.log.info(`dequeued ${next.describe()}`);
    await this.runTask(next);
  }

  /** B1 (zero-progress park) lives in the slot (S2b). */
  _noteProgress(task) {
    return this.slot.noteProgress(task);
  }


  /** Quarantine lives in the slot (S2b). */
  isQuarantined(name) {
    return this.slot.isQuarantined(name);
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
    /** P1 §1.4.1: a caller that knows the originating request can attach it. */
    if (options.requestId && !task.requestId) task.requestId = options.requestId;
    /** S3: an explicit task (or an urgent control verb) answers the pending question by replacing it. */
    if (this.proposals && (level === LEVELS.directive || level === LEVELS.urgent)) {
      this.proposals.supersede(`${levelName} task`);
    }

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
    this.proposals.supersede('death');
    this.stoppedReason = 'death';
    this.queue.length = 0;
    if (this.currentTask && this.currentTask.state === 'running') this.currentTask.cancel();
    /** A plan/turn is work too: death must not leave a parent plan driving the body. */
    if (this.planService) this.planService.cancelAll('death').catch(() => {});
    if (this.turnService) this.turnService.cancelAll('death');
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
      plannerMode: this.plannerMode,
      proposals: this.proposals ? this.proposals.status() : null,
      events: this.events ? this.events.status() : null,
      perceptionWake: this.perceptionWake ? this.perceptionWake.status() : null,
      plans: this.plans ? this.plans.status() : null,
      planRunner: this.planRunner ? { busy: this.planRunner.busy } : null,
      planService: this.planService ? this.planService.status() : null,
      turns: this.turns ? { activeId: this.turns.activeId } : null,
      harness: this.harness ? this.harness.status() : null,
      turnService: this.turnService ? this.turnService.status() : null,
      methods: this.methods ? this.methods.status() : null,
      answers: this.answers ? this.answers.status() : null,
      budget: this.budget ? this.budget.status() : null,
      conversation: this.conversation ? this.conversation.status() : null,
      memoryStore: this.memoryStore ? this.memoryStore.status() : null,
    chatMemory: this.chatMemory ? this.chatMemory.status() : null,
      completedGoals: this.completedGoals.slice(-10),
      memory: this.ctx.memory.summary()
    };
  }

  captureState() {
    return captureState(this);
  }

  restoreState(data) {
    return restoreState(this, data);
  }

  /** Debounced atomic save; no-op when persistence is disabled. */
  scheduleStateSave() {
    if (!this.stateStore) return;
    if (this._stateTimer) clearTimeout(this._stateTimer);
    this._stateTimer = setTimeout(() => {
      this._stateTimer = null;
      this.saveStateNow();
    }, this.stateDebounceMs);
    if (this._stateTimer.unref) this._stateTimer.unref();
  }

  saveStateNow() {
    if (!this.stateStore) return false;
    try {
      this.stateStore.save(this.captureState());
      return true;
    } catch (err) {
      this.log.warn(`state save failed: ${err.message}`);
      return false;
    }
  }

  // ------------------------------------------------------------- task events

  /** Subscribe to `task:done` / `task:failed` / `task:quarantined`. Returns an unsubscribe function. */
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
    /**
     * A paused brain must not let a running plan step continue behind the hold, but a plan
     * parked on a player question should survive the pause (it is not doing anything).
     */
    if (this.planService && this.planService.active) {
      this.planService.cancel(this.planService.active.planId, 'paused');
    }
    if (this.turnService) this.turnService.cancelAll('paused');
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

  /**
   * Let go of every key the agent is holding (M5, F1'b).
   *
   * Called by the Holds listener on dead/paused/owner-stop/task, and available directly
   * for shutdown and disconnect paths. Never throws: a stop path that throws is a stop
   * path that leaves keys down.
   */
  releaseInput(reason = 'stop') {
    if (!this.inputLedger) return Promise.resolve({ ok: true, released: [], reason });
    return this.inputLedger.releaseAll(reason).catch((err) => {
      this.log.warn(`input release failed (${reason}): ${err.message}`);
      return { ok: false, released: [], reason, error: err.message };
    });
  }
}

/**
 * The legacy task factory for evaluator candidates (RETIREMENT S1).
 *
 * The evaluator speaks in data (`{type, name, args}`); building a Task is still this
 * module's job until S4 retires the legacy task classes. Keeping the factory here also
 * preserves the P0 audit's "the planner uses primitive tasks, not legacy ones" check.
 */
/**
 * Command-table actions that are safe to offer as autonomous proposals even though they
 * have no TASK_BUILDERS factory. The proposal only asks; execution happens in the action
 * brain's execution goal through mc_step. Control/admin/read-only commands are excluded.
 */
const COMMAND_PROPOSAL_TYPES = new Set([
  'mine',
  'chop',
  'collect',
  'hunt',
  'eat',
  'equip',
  'armor',
  'drop',
  'place',
  'use',
  'attack',
  'defend',
  'shoot',
  'explore',
  'withdraw',
  'deposit',
  'come',
  'craft',
  'farm',
  'sleep',
  'smelt',
  'fish',
  'shelter',
  'light',
  'goto',
  'follow',
  'home'
]);

const TASK_BUILDERS = {
  deposit: (ctx, args) => new DepositTask(ctx, args),
  withdraw: (ctx, args) => new WithdrawTask(ctx, args),
  follow: (ctx, args) => new FollowTask(ctx, args),
  hunt: (ctx, args) => new HuntTask(ctx, args),
  'chop-wood': (ctx, args) => new ChopWoodTask(ctx, args),
  craft: (ctx, args) => new CraftTask(ctx, args),
  shelter: (ctx, args) => new ShelterTask(ctx, args),
  goto: (ctx, args) => new GoToTask(ctx, args),
  mine: (ctx, args) => new MineBlockTask(ctx, args),
  'mine-ore': (ctx, args) => new MineOreTask(ctx, args),
  fish: (ctx, args) => new FishTask(ctx, args),
  /**
   * M4 live entry: `code_skill` steps run the CURRENT PROMOTED version through the sandbox
   * (docs/P1-M4.md). Registered here so PlanService.knownStepTypes, mc_plan/mc_propose and
   * submitExternalTask all accept it; only promotion makes a skill reachable.
   */
  code_skill: (ctx, args) => new CodeSkillTask(ctx, args),
  light: (ctx, args) => new LightTask(ctx, args)
};

function buildTask(ctx, candidate) {
  const build = TASK_BUILDERS[candidate.type];
  if (!build) throw new Error(`evaluator returned an unknown task type: ${candidate.type}`);
  return build(ctx, candidate.args || {});
}

module.exports = { Brain };
