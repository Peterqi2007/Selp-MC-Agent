'use strict';

/**
 * In-game chat control - the deterministic command channel.
 *
 * This is channel A of the two input channels in P0: a human types `!chop 8` into the
 * Minecraft chat box, and it becomes a task. Channel B is the natural-language/LLM path
 * (the persona trigger), which lands in the same command table through `src/llm/`.
 *
 * It is intentionally transport-agnostic: the same table backs the in-game listener, the
 * HTTP control panel and the CLI, so adding a command adds it everywhere at once.
 *
 * Two changes P0 forced on this file, both of which were silent-failure bugs:
 *
 *   1. **Speaking goes through `ctx.reply`, not `ctx.bot.chat`.** `ctx.bot` is null under
 *      the client-mod body, and the old `try { bot.chat() } catch {}` swallowed the
 *      TypeError - so `!status` produced no answer at all and looked like the bot ignoring
 *      you. See `src/chat/reply.js`.
 *   2. **Reading state goes through the Body**, not `inventorySummary(ctx.bot)`.
 *      `src/body/botFacade.js` provides a bot-shaped read-only view for the helpers that
 *      still expect one.
 */

const { HuntTask } = require('../tasks/hunt');
const { ShelterTask } = require('../tasks/shelter');
const { CraftTask } = require('../tasks/craft');
const { DepositTask } = require('../tasks/deposit');
const { WithdrawTask } = require('../tasks/withdraw');
const { FollowTask } = require('../tasks/follow');
const { LightTask } = require('../tasks/light');
const { ChopWoodTask } = require('../tasks/chopWood');
const { MineBlockTask } = require('../tasks/mineBlock');
const { MineOreTask } = require('../tasks/mineOre');
const { FishTask } = require('../tasks/fish');
const { CodeSkillTask } = require('../tasks/codeSkill');
const { GoToTask } = require('../tasks/goto');
const { inventorySummary } = require('../world/items');
const { Logger } = require('../util/logger');
const { dispatchMining, classifyMining } = require('../core/miningDispatch');
const { expandBlockNames: expandTargetAliases } = require('../core/miningRequest');
const { routeGoal } = require('../core/goalRouter');

const HELP = [
  '!status - health, food, position, current goal',
  '!chop [n] - gather n logs (walk -> break -> collect)',
  '!mine <block> [n] - mine n blocks',
  '!goto <x> <y> <z> - walk there precisely (0.4-block arrival radius)',
  '!collect - pick up dropped items within 15x15x15 (fresh scan, A* walk)',
  '!eat [food] - eat the best food carried (or a named item)',
  '!equip <item> - hold an item from the inventory',
  '!armor - equip the best armour pieces carried',
  '!drop <item> [n] - drop n of an item',
  '!place <item> <x> <y> <z> [face] - place a block',
  '!use <x> <y> <z> [face] [item] - right-click a block (hoe, plant, bucket, open)',
  '!attack [type] - attack the nearest hostile',
  '!defend [range] - fight hostiles that come close',
  '!shoot [type|player <name>] [weapon] - shoot with a TACZ gun (16 blocks, 32 for snipers)',
  '!explore [distance] [direction] - walk somewhere new',
  '!withdraw <item> [n] - take exactly that many from pure containers within 15x15x9 (background task)',
  '!deposit <item> <count> - store exactly that many in a pure container (builds a chest if needed)',
  '!store <item> <count> - alias of !deposit',
  '!come <player> - walk to a visible player',
  '!follow <player> [seconds] - follow a player with high-frequency position polling + A* (default 300s)',
  '!look <yaw> <pitch> - turn the camera to absolute angles (degrees)',
  '!lookat <x> <y> <z> - look at a coordinate',
  '!target - what is under the crosshair right now',
  '!key <action> down|up - press or release one key in the client (input layer)',
  '!hold <action> [ms] - hold one key for at most 10s, then auto-release',
  '!shot [maxEdge] - capture the game frame to runtime/screenshots (no OS screen capture)',
  '!inputs - what keys are currently held, and since when',
  '!smelt <item> [n] - smelt in a nearby furnace',
  '!fish [n] - fish for food (cast, wait for the bite, sleep at night)',
  '!code-skill list | <name> [json] - list/run a promoted generated code skill (sandboxed)',
  '!farm [radius] - harvest ripe crops, till soil, plant seeds',
  '!sleep - sleep in a nearby bed until morning',
  '!goal <text> - queue a goal in words',
  '!hunt [n] - hunt animals for food',
  '!craft <item> [n] - craft an item',
  '!shelter - build a night shelter',
  '!light [n] - place torches',
  '!store - deposit loot in a chest',
  '!task status|stop - the background task slot',
  '!proposal status|accept [always]|reject - answer the planner\'s proposal',
  '!answer <text> - answer a waiting plan question (forwarded to the action brain)',
  '!state status|save - persisted session state (off by default)',
  '!method <goal> - look up a local method and remembered answer',
  '!area add|list|show|delete - named areas (permission rules can point at them)',
  '!route add|plan|go|list|show|delete - named routes; plan first, go walks it',
  '!rule list|allow|deny|ask|remove|mode - permission rules',
  '!yes [always] | !no - answer a pending permission question',
  '!stop - cancel current goal',
  '!pause | !resume - freeze or unfreeze the planner',
  '!inv - inventory summary',
  '!where - coordinates',
  '!help - this list'
];

class ChatController {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.prefix = options.prefix || '!';
    this.log = new Logger('chat');
    this.attached = false;
    /**
     * Who to attribute the instruction currently being handled to. Set per `handle()` call
     * so an LLM-dispatched command is tagged `llm` even though it travels through this same
     * table - which is what lets the LLM report back when *its* task finishes (plan 5.6).
     */
    this.dispatchSource = null;
    /** Last commands received, newest last: the panel shows these as "did it hear me?". */
    this.history = [];
    this.handlers = this.buildHandlers();
  }

  get bot() {
    // Still used by the mineflayer `attach()` path below; anything else should use
    // `ctx.body` or `ctx.botFacade`.
    return this.ctx.controller ? this.ctx.controller.bot : this.ctx.bot;
  }

  /**
   * Attach to a mineflayer `chat` event.
   *
   * Only meaningful for the mineflayer body. Under the client-mod body the events never
   * fire, and `ChatListener` polls `/chatlog` instead - which is why this method is now
   * a no-op unless there really is a mineflayer bot.
   */
  attach() {
    if (this.attached) return;
    const bot = this.bot;
    if (!bot) {
      this.log.debug('no mineflayer bot: chat input comes from ChatListener instead');
      return;
    }
    bot.on('chat', (username, message) => {
      if (!message || !message.startsWith(this.prefix)) return;
      if (username === bot.username) return;
      this.log.info(`command from ${username}: ${message}`);
      this.handle(message.slice(this.prefix.length), username).catch((err) => {
        this.log.error(`command failed: ${err.message}`);
        this.say(`error: ${err.message}`);
      });
    });
    this.attached = true;
  }

  detach() {
    this.attached = false;
  }

  /**
   * Say something. Fire-and-forget by design: command handlers should not have to await
   * their own acknowledgements, and a failed reply must never break the task it reports on.
   */
  say(message) {
    if (!this.ctx.reply) {
      this.log.debug(`(no reply channel) ${message}`);
      return Promise.resolve(false);
    }
    // `ack: true` subjects this to the anti-spam gap; answers the player is waiting for
    // (LLM replies, task follow-ups) are never debounced. See src/chat/reply.js.
    return Promise.resolve(this.ctx.reply(message, { why: 'command-ack', ack: true })).catch(() => false);
  }

  buildHandlers() {
    const ctx = this.ctx;
    return {
      help: () => this.say(HELP.join(' |')),
      status: () => {
        const s = ctx.world.summary();
        const brain = ctx.brain.status();
        this.say(
          `hp=${s.health} food=${s.food} pos=${s.position.x},${s.position.y},${s.position.z}` +
            `day=${s.day} night=${!s.isDay} goal=${brain.current ? brain.current.description : 'idle'}`
        );
      },
      where: () => {
        const s = ctx.world.summary();
        this.say(`I am at ${s.position.x} ${s.position.y} ${s.position.z} in ${s.dimension}`);
      },
      inv: () => {
        const items = inventorySummary(this.inventorySource());
        const text = Object.entries(items)
          .map(([k, v]) => `${k}x${v}`)
          .join(',');
        this.say(text ? `inventory: ${text}` : '背包是空的');
      },
      stop: () => {
        // A real stop: cancel everything AND silence the 2.5s planner (src/core/holds.js,
        // reason `owner-stop`). Without the hold the planner re-queued the next goal
        // immediately and the bot looked unstoppable. An explicit command still runs.
        ctx.brain.preempt();
        ctx.brain.hold('owner-stop', '!stop from chat');
        // The background task slot is separate from the brain queue; stop means both.
        if (ctx.hub) ctx.hub.cancel('!stop').catch(() => {});
        /**
         * Plans and harness turns are separate owners of the same body; a stop that leaves
         * a plan "running" would keep moving after the player said stop (M3).
         */
        if (ctx.planService) ctx.planService.cancelAll('!stop').catch(() => {});
        if (ctx.turnService) ctx.turnService.cancelAll('!stop');
        ctx.nav.stop();
        if (ctx.body && typeof ctx.body.interrupt === 'function') ctx.body.interrupt('!stop');
        this.say('停下来了（自动规划已暂停，发 !resume 继续）');
      },
      pause: () => {
        ctx.brain.pause();
        this.say('暂停了');
      },
      resume: () => {
        // A resume after death is the one thing that clears the post-death stop.
        if (ctx.brain.stopped) ctx.brain.resumeFromDeath();
        if (ctx.deathWatch) ctx.deathWatch.dead = false;
        ctx.brain.autoPlanDisabled = false;
        ctx.brain.resume();
        this.say('继续干活');
      },
      /**
       * One mining entry for the whole command channel (plan §5.6).
       *
       * Ore targets submit a single `mine_ore` job into the TaskHub and answer with an
       * acceptance receipt - the old path enqueued the walk-only `MineBlockTask`, which
       * reports "no diamond_ore nearby" for veins embedded in rock (live 2026-10-10).
       * Planner materials (stone/dirt/sand/...) keep their proven task, including its
       * count+2 overshoot: it counts *collected items*, so overshooting slightly beats
       * falling short.
       */
      mine: async (args) => {
        const block = args[0];
        if (!block) throw new Error('usage: !mine <block> [n]');
        /**
         * Capture the source now: a long dispatch must not read a mutable field that a
         * second message could overwrite while this one is still in flight (§5.6.3).
         */
        const source = this.dispatchSource || 'chat';
        const dispatched = await dispatchMining(
          ctx,
          { blocks: block, count: args[1] },
          { source, defaultCount: 8 }
        );
        if (!dispatched.ok) {
          this.say(`不行：${dispatched.reason}`);
          return dispatched;
        }
        if (dispatched.kind === 'ore') {
          this.say(`去挖 ${dispatched.count} 个 ${block}（${dispatched.blocks.join('/')}）`);
          return dispatched;
        }
        this.say(`去挖 ${dispatched.count} 个 ${block}`);
        return this.enqueue(new MineBlockTask(ctx, { block: dispatched.blocks, count: dispatched.count }));
      },
      chop: (args) => {
        const count = Number(args[0]) || 8;
        this.say(`去砍 ${count} 根木头`);
        return this.enqueue(new ChopWoodTask(ctx, { count }));
      },
      collect: () => this.runSkill('collect', {}),
      hunt: (args) => this.enqueue(new HuntTask(ctx, { count: Number(args[0]) || 3 })),
      eat: (args) => this.runSkill('eat', args[0] ? { food: args[0] } : {}),
      equip: (args) => {
        if (!args[0]) throw new Error('usage: !equip <item>');
        return this.runSkill('equip', { item: args[0] });
      },
      armor: () => this.runSkill('armor', {}),
      drop: (args) => {
        if (!args[0]) throw new Error('usage: !drop <item> [count]');
        return this.runSkill('drop', { item: args[0], count: Number(args[1]) || 1 });
      },
      place: (args) => {
        const [item, x, y, z] = args;
        if (!item || [x, y, z].some((value) => value === undefined)) {
          throw new Error('usage: !place <item> <x> <y> <z> [face]');
        }
        return this.runSkill('place', { item, x: Number(x), y: Number(y), z: Number(z), face: args[4] });
      },
      use: (args) => {
        const [x, y, z] = args;
        if ([x, y, z].some((value) => value === undefined)) {
          throw new Error('usage: !use <x> <y> <z> [face] [item]');
        }
        return this.runSkill('use_on', { x: Number(x), y: Number(y), z: Number(z), face: args[3], item: args[4] });
      },
      attack: (args) => this.runSkill('attack', args[0] ? { type: args[0] } : {}),
      defend: (args) => this.runSkill('defend', { range: Number(args[0]) || 6 }),
      /**
       * `!shoot [type] [weapon]` for monsters, `!shoot player <name> [weapon]` for PvP.
       * The weapon token is optional and pins one gun; without it the default priority
       * order picks (rifle > smg > mg > pistol, sniper first beyond 16 blocks).
       */
      shoot: (args) => {
        const params = {};
        if (args[0] === 'player' && args[1]) {
          params.player = args[1];
          if (args[2]) params.weapon = args[2];
        } else {
          if (args[0]) params.type = args[0];
          if (args[1]) params.weapon = args[1];
        }
        return this.runSkill('shoot', params);
      },
      explore: (args) => this.runSkill('explore', { distance: Number(args[0]) || 16, direction: args[1] }),
      withdraw: (args) => this.withdrawCommand(args),
      deposit: (args) => this.depositCommand(args),
      come: (args) => {
        if (!args[0]) throw new Error('usage: !come <player>');
        return this.runSkill('come', { player: args[0] });
      },
      look: async (args) => {
        const yaw = Number(args[0]) || 0;
        const pitch = Number(args[1]) || 0;
        if (typeof ctx.body.look !== 'function') throw new Error('this body cannot turn the view');
        const ok = await ctx.body.look(yaw, pitch);
        this.say(ok ? `看向 yaw=${yaw}° pitch=${pitch}°` : '转头失败');
        return { ok };
      },
      lookat: async (args) => {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((n) => Number.isNaN(n))) throw new Error('usage: !lookat <x> <y> <z>');
        if (typeof ctx.body.lookAt !== 'function') throw new Error('this body cannot turn the view');
        const ok = await ctx.body.lookAt({ x, y, z });
        this.say(ok ? `看向 ${x} ${y} ${z}` : '转头失败');
        return { ok };
      },
      target: async () => {
        const found = typeof ctx.body.targetBlock === 'function' ? await ctx.body.targetBlock() : null;
        const pos = found && found.position
          ? `${Math.floor(found.position.x)},${Math.floor(found.position.y)},${Math.floor(found.position.z)}`
          : '-';
        this.say(
          found
            ? `准心: ${found.name} @ ${pos}${found.distance !== undefined ?` (${Number(found.distance).toFixed(1)}m)` : ''}`
            : '准心没有对着方块（或这个身体没有准心）'
        );
        return found;
      },
      /**
       * Input layer (M5, 2026-10-29): explicit key press/release through the client mod.
       *
       * These are the same commands the DSH action brain can reach through `mc_step`
       * (`key forward down`), so no action-brain change is needed for the new capability.
       * Every press is recorded in the input ledger, and the ledger is what `!stop`,
       * death, pause and disconnect release (F1'b).
       */
      key: async (args) => {
        const action = String(args[0] || '').trim();
        const direction = String(args[1] || 'down').toLowerCase();
        if (!action || !['down', 'up'].includes(direction)) {
          throw new Error('usage: !key <action> down|up');
        }
        if (!ctx.brain || !ctx.brain.inputLedger) throw new Error('input ledger is not available');
        const result = direction === 'down'
          ? await ctx.brain.inputLedger.press(action)
          : await ctx.brain.inputLedger.release(action);
        this.say(`按键 ${action} ${direction}${result && result.ok === false ? '（失败）' : ''}`);
        return result;
      },
      hold: async (args) => {
        const action = String(args[0] || '').trim();
        if (!action) throw new Error('usage: !hold <action> [ms]');
        if (!ctx.brain || !ctx.brain.inputLedger) throw new Error('input ledger is not available');
        const ms = Number(args[1]);
        const result = await ctx.brain.inputLedger.hold(action, Number.isFinite(ms) && ms > 0 ? ms : 250);
        this.say(`按住 ${action} ${result.ms || ''}ms`.trim());
        return result;
      },
      inputs: async () => {
        const ledger = ctx.brain && ctx.brain.inputLedger ? ctx.brain.inputLedger.status() : null;
        const remote = typeof ctx.body.inputState === 'function' ? await ctx.body.inputState() : null;
        // Reconcile first: the mod releases on its own deadline, so a Node entry it no
        // longer reports is already up and must not be chased later.
        if (ledger && remote && Array.isArray(remote.held)) ctx.brain.inputLedger.sync(remote.held);
        const status = ctx.brain && ctx.brain.inputLedger ? ctx.brain.inputLedger.status() : ledger;
        const held = status ? status.held.map((entry) => entry.action) : [];
        this.say(held.length ? `按住中: ${held.join(', ')}` : '没有按住的按键');
        return { ...status, mod: remote };
      },
      shot: async (args) => {
        if (!ctx.body || typeof ctx.body.screenshot !== 'function') {
          throw new Error('this body cannot take screenshots');
        }
        const edge = Number(args[0]) > 0 ? Number(args[0]) : 1024;
        const shot = await ctx.body.screenshot({ maxEdge: edge });
        if (!shot.ok) {
          this.say(`截图失败: ${shot.error || '未知原因'}`);
          return shot;
        }
        this.say(`截图 ${shot.width}x${shot.height} → ${shot.path}`);
        return shot;
      },
      craft: (args) => {
        if (!args[0]) throw new Error('usage: !craft <item> [count]');
        // Menu-capable bodies (the real client) use the Phase-2 skill: recipe planning plus
        // real grid clicks. Other bodies keep the mineflayer-era task, which asks the body's
        // own recipe database.
        if (ctx.body && typeof ctx.body.menu === 'function' && typeof ctx.body.clickSlot === 'function') {
          return this.runSkill('craft', { item: args[0], count: Number(args[1]) || 1 });
        }
        return this.enqueue(new CraftTask(ctx, { item: args[0], count: Number(args[1]) || 1 }));
      },
      farm: (args) => this.runSkill('farm', { radius: Number(args[0]) || 6 }),
      sleep: () => this.runSkill('sleep', {}),
      smelt: (args) => {
        if (!args[0]) throw new Error('usage: !smelt <item> [count]');
        return this.runSkill('smelt', { item: args[0], count: Number(args[1]) || 1 });
      },
      /**
       * Fishing is a task, not an inline skill: the default budget is 15 minutes and the
       * command endpoint (`POST /command`, used by the panel and the DSH plugin) must
       * answer immediately. The task keeps cancellation/`!task status`/events intact.
       */
      fish: (args) => {
        const count = Number(args[0]);
        const options = Number.isFinite(count) && count > 0 ? { count: Math.min(count, 256) } : {};
        this.say(options.count ? `去钓鱼，最多 ${options.count} 条` : '去钓鱼');
        return this.enqueue(new FishTask(ctx, options));
      },
      /**
       * M4: run a promoted generated code skill (docs/P1-M4.md).
       *
       * Only the current promoted version is dispatchable; trials stay on the operator
       * HTTP entry. Registering this command plus `code_skill` in TASK_BUILDERS is what
       * lets the DSH action brain reach generated skills through `mc_step`
       * (`code-skill <name>`) and `mc_plan` steps (`{"type":"code_skill", "args":{...}}`).
       * The task keeps the body slot, cancellation and the event chain.
       */
      'code-skill': async (args) => {
        if (!ctx.codeSkills) throw new Error('code skills are not enabled on this agent');
        const first = String(args[0] || '').trim();
        const promoted = (ctx.codeSkills.status() || {}).promoted || [];
        if (!first || first === 'list') {
          this.say(
            promoted.length
              ? `代码技能: ${promoted.map((skill) => `${skill.name}@${skill.version}`).join(', ')}`
              : '还没有已晋升的代码技能'
          );
          return { ok: true, promoted };
        }
        const name = first === 'run' ? String(args[1] || '').trim() : first;
        if (!name) throw new Error('usage: !code-skill list | !code-skill <name> [json params]');
        if (!promoted.some((skill) => skill.name === name)) {
          throw new Error(`unknown promoted code skill "${name}" (try !code-skill list)`);
        }
        const rest = (first === 'run' ? args.slice(2) : args.slice(1)).join(' ').trim();
        let params = {};
        if (rest) {
          let parsed;
          try {
            parsed = JSON.parse(rest);
          } catch {
            throw new Error('code-skill params must be a JSON object');
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('code-skill params must be a JSON object');
          }
          params = parsed;
        }
        this.say(`运行代码技能 ${name}`);
        return this.enqueue(new CodeSkillTask(ctx, { name, params }));
      },
      shelter: () => this.enqueue(new ShelterTask(ctx)),
      light: (args) => this.enqueue(new LightTask(ctx, { count: Number(args[0]) || 4 })),
      store: (args) => this.depositCommand(args),
      /**
       * `ctx.onGoal` never existed - this called undefined in production and every
       * `!goal ...` answered with "ctx.onGoal is not a function" (found by the A-series
       * entry test). The controller owns the method.
       */
      goal: (args) => this.onGoal(args.join(' ')),
      goto: async (args) => {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((n) => Number.isNaN(n))) throw new Error('usage: !goto <x> <y> <z>');
        const task = new GoToTask(ctx, { position: { x, y, z }, range: 0.4, timeoutMs: 120000 });
        /**
         * Acceptance, not completion: the receipt comes back now and the arrival is
         * announced by the task event (the GoToTask reports the pathfinding reason itself,
         * so the follow-up says *why* when it fails).
         */
        const receipt = await this.enqueue(task);
        if (receipt && receipt.accepted === false) return receipt;
        this.say(`出发去 ${x} ${y} ${z}`);
        return receipt;
      },
      follow: (args) => {
        const name = String(args[0] || '').trim();
        if (!name) throw new Error('usage: !follow <player> [seconds]');
        let seconds = 300;
        if (args[1] !== undefined) {
          const parsed = Number(args[1]);
          if (!Number.isFinite(parsed) || parsed < 1) throw new Error('usage: !follow <player> [seconds]');
          seconds = Math.min(Math.floor(parsed), 3600);
        }
        this.say(`跟着 ${name}（${seconds}s）`);
        return this.enqueue(new FollowTask(this.ctx, { player: name, durationMs: seconds * 1000 }));
      },
      home: async () => {
        const shelter = ctx.memory.landmark('shelter');
        if (!shelter) {
          this.say('我还没造过庇护所');
          return;
        }
        const task = new GoToTask(ctx, { position: shelter, range: 2, timeoutMs: 90000 });
        const receipt = await this.enqueue(task);
        if (receipt && receipt.accepted === false) return receipt;
        this.say('往庇护所走');
        return receipt;
      },

      // ------------------------------------------------------------ second batch
      task: async (args) => {
        const sub = (args[0] || 'status').toLowerCase();
        if (sub === 'stop') {
          const result = ctx.hub ? await ctx.hub.cancel('!task stop') : { cancelled: null };
          this.say(result.cancelled ? `已停止后台任务 ${result.cancelled}` : '现在没有后台任务');
          return result;
        }
        const status = ctx.hub ? ctx.hub.status() : { busy: false, current: null, recent: [] };
        if (status.busy) {
          this.say(`后台任务 ${status.current.id}「${status.current.name}」跑了 ${Math.round(status.current.ms / 1000)} 秒`);
        } else {
          this.say('现在没有后台任务');
        }
        return status;
      },

      /**
       * The deterministic surface for ProposalDesk (RETIREMENT S3).
       *
       * The language brain will phrase the question and parse the answer in M3/M6; until
       * then this command is how a player answers, and the A25 offline tests drive the same
       * brain methods directly.
       */
      proposal: async (args) => {
        if (!ctx.brain || !ctx.brain.proposals) return { ok: false, reason: 'no proposal desk' };
        const sub = (args[0] || 'status').toLowerCase();
        if (sub === 'accept') {
          const always = args.includes('always');
          const result = await ctx.brain.acceptProposal(null, { by: 'player', always });
          if (!result.ok) {
            this.say(result.reason === 'no-such-proposal' ? '现在没有待答的提案' : `提案没能接受（${result.reason}）`);
            return result;
          }
          const autonomous = !!(result.proposal && result.proposal.candidate && result.proposal.candidate.autonomous);
          this.say(
            autonomous
              ? `好，已交给动作脑执行「${result.proposal.target}」`
              : `好，开始做 ${result.proposal.target}` + (always ? '（这类以后不用再问）' : '')
          );
          return result;
        }
        if (sub === 'reject') {
          const result = await ctx.brain.rejectProposal(null, { by: 'player' });
          const autonomous =
            result.ok && result.proposal && result.proposal.candidate && result.proposal.candidate.autonomous;
          this.say(
            result.ok
              ? autonomous
                ? `这次不做了（${result.proposal.target}，5 分钟后再考虑）`
                : `这次不做了（${result.proposal.target}，三分钟内不再提）`
              : '现在没有待答的提案'
          );
          return result;
        }
        const status = ctx.brain.proposals.status();
        if (status.pending) {
          const isPlanQuestion = status.pending.type === 'plan_question';
          this.say(
            `提案 ${status.pending.id}「${status.pending.target}」：${status.pending.reason || '（无说明）'}；` +
              (isPlanQuestion
                ? '回答：!answer <你的回答>，或 !proposal accept / !proposal reject'
                : '发 !proposal accept 或 !proposal reject')
          );
        } else {
          this.say('现在没有待答的提案');
        }
        return status;
      },

      /**
       * A14: free-text answer to a parked plan question, forwarded to the action brain.
       *
       * `!proposal accept` only says "yes"; the plan question can require information
       * ("where is the crafting table?"). The text is remembered with its conditions,
       * written to shared memory, forwarded to the bound harness conversation, and the
       * plan resumes - the model continues instead of asking the same question again.
       */
      answer: async (args) => {
        const text = args.join(' ').trim();
        if (!text) {
          this.say('用法：!answer <你的回答>');
          return { ok: false, reason: 'usage' };
        }
        if (!ctx.brain || typeof ctx.brain.answerPlanQuestion !== 'function') {
          this.say('这个版本没有计划问答通道');
          return { ok: false, reason: 'answer-channel-unavailable' };
        }
        const result = await ctx.brain.answerPlanQuestion(text, { by: 'player' });
        if (!result.ok) {
          this.say(
            result.reason === 'no-plan-question'
              ? '现在没有待回答的计划问题'
              : `回答没送到（${result.reason}）`
          );
          return result;
        }
        const forwardedOk = !!(result.forwarded && result.forwarded.ok);
        this.say(
          forwardedOk
            ? `已记录回答并转给动作脑，计划继续（${result.planId}）`
            : `已记录回答，计划继续（${result.planId}）；动作脑没收到（${
                (result.forwarded && result.forwarded.reason) || '未接线'
              }）`
        );
        return result;
      },

      /**
       * Persistence operator surface (P1 M3, A17).
       *
       * Persistence is opt-in (`state.enabled=false` by default); this command makes that
       * visible and gives a deterministic "save now" action. It never enables persistence.
       */
      state: async (args) => {
        const brain = ctx.brain;
        if (!brain) return { ok: false, reason: 'no brain' };
        const sub = (args[0] || 'status').toLowerCase();
        if (sub === 'save') {
          if (!brain.stateStore) {
            this.say('持久化未启用（config state.enabled=false）');
            return { ok: false, enabled: false, reason: 'state-disabled' };
          }
          const saved = brain.saveStateNow();
          this.say(saved ? `状态已保存：${brain.stateStore.file}` : '状态保存失败，见日志');
          return { ok: saved, enabled: true, file: brain.stateStore.file };
        }
        if (sub !== 'status') {
          this.say('用法：!state status 或 !state save');
          return { ok: false, reason: 'bad-subcommand' };
        }
        const status = {
          enabled: !!brain.stateStore,
          file: brain.stateStore ? brain.stateStore.file : null,
          plans: brain.plans ? brain.plans.status().plans : 0,
          pendingProposal: brain.proposals ? brain.proposals.pending() !== null : false,
          eventSeq: brain.events ? brain.events.status().seq : 0,
          methods: brain.methods ? brain.methods.status().methods : 0,
          answers: brain.answers ? brain.answers.status().facts : 0
        };
        this.say(
          status.enabled
            ? `持久化开启：${status.file}（事件 ${status.eventSeq}，计划 ${status.plans}，待答 ${status.pendingProposal ? 1 : 0}）`
            : '持久化未启用（config state.enabled=false）'
        );
        return status;
      },

      /**
       * Local knowledge lookup (P1 §1.6.2): best method + remembered answer.
       * Read-only; it never starts work.
       */
      method: (args) => {
        const goal = args.join(' ').trim();
        if (!goal) {
          this.say('用法：!method <目标>');
          return { ok: false, reason: 'goal-required' };
        }
        if (!ctx.brain || typeof ctx.brain.suggestMethod !== 'function') {
          this.say('现在还没有本地方法库');
          return { ok: false, reason: 'no-method-library' };
        }
        const suggestion = ctx.brain.suggestMethod(goal, {});
        const lines = [];
        if (suggestion.method) {
          lines.push(
            `方法「${suggestion.method.method}」（${suggestion.method.success} 成 / ${suggestion.method.failure} 败）`
          );
        }
        if (suggestion.answer) lines.push(`记得：${suggestion.answer.answer}`);
        if (suggestion.memories && suggestion.memories.length) {
          lines.push(`记忆：${suggestion.memories[0].text}`);
        }
        this.say(lines.length ? lines.join('；') : `没有关于「${goal}」的本地方法或回答`);
        return suggestion;
      },

      area: (args) => {
        const sub = (args[0] || 'list').toLowerCase();
        if (!ctx.places) throw new Error('this agent has no place store');
        if (sub === 'list') {
          const list = ctx.places.listAreas();
          this.say(list.length ? `区域: ${list.map((a) => a.name).join(', ')}` : '还没有命名区域');
          return list;
        }
        if (sub === 'show') {
          const area = ctx.places.area(args[1]);
          if (!area) throw new Error(`没有区域 ${args[1] || '?'}`);
          const text = area.parts.map((p) => require('../core/places').describePart(p)).join(' | ');
          this.say(`区域 ${area.name}: ${text}`);
          return area;
        }
        if (sub === 'delete') {
          const ok = ctx.places.deleteArea(args[1]);
          this.say(ok ? `删掉了区域 ${args[1]}` : `没有区域 ${args[1] || '?'}`);
          return { ok };
        }
        if (sub === 'add') {
          const name = args[1];
          if (!name) throw new Error('usage: !area add <name> <x1 y1 z1> [x2 y2 z2] | !area add <name> here <r>');
          if ((args[2] || '').toLowerCase() === 'here') {
            const r = Number(args[3]) || 8;
            const snap = ctx.world && typeof ctx.world.snapshot === 'function' ? ctx.world.snapshot(true) : null;
            if (!snap || !snap.position) throw new Error('no position yet');
            const at = { x: Math.floor(snap.position.x), y: Math.floor(snap.position.y), z: Math.floor(snap.position.z) };
            const added = ctx.places.addArea(name, { type: 'radius', at, r });
            if (!added.ok) throw new Error(added.reason);
            this.say(`区域 ${name} = 我周围 ${r} 格`);
            return added;
          }
          const nums = args.slice(2).map(Number);
          if (nums.length < 3 || nums.some((n) => Number.isNaN(n))) {
            throw new Error('usage: !area add <name> <x1 y1 z1> [x2 y2 z2] | !area add <name> here <r>');
          }
          const from = { x: nums[0], y: nums[1], z: nums[2] };
          const to = nums.length >= 6 ? { x: nums[3], y: nums[4], z: nums[5] } : from;
          const added = ctx.places.addArea(name, { type: 'box', from, to });
          if (!added.ok) throw new Error(added.reason);
          this.say(`区域 ${name} 已记住（${nums.length >= 6 ? '盒子' : '单点'}）`);
          return added;
        }
        throw new Error('usage: !area add|list|show|delete ...');
      },

      route: async (args) => {
        const sub = (args[0] || 'list').toLowerCase();
        if (!ctx.places) throw new Error('this agent has no place store');
        if (sub === 'list') {
          const list = ctx.places.listRoutes();
          this.say(list.length ? `路线: ${list.map((r) => r.name).join(', ')}` : '还没有命名路线');
          return list;
        }
        if (sub === 'show') {
          const route = ctx.places.route(args[1]);
          if (!route) throw new Error(`没有路线 ${args[1] || '?'}`);
          this.say(
            `路线 ${route.name}: ${route.points.length} 个途经点, 终点 ` +
              `${route.points[route.points.length - 1].x},${route.points[route.points.length - 1].y},${route.points[route.points.length - 1].z}` +
              (route.plan ? `, 上次计划 ${route.plan.status}` : '')
          );
          return route;
        }
        if (sub === 'delete') {
          const ok = ctx.places.deleteRoute(args[1]);
          this.say(ok ? `删掉了路线 ${args[1]}` : `没有路线 ${args[1] || '?'}`);
          return { ok };
        }
        if (sub === 'add') {
          const name = args[1];
          const nums = args.slice(2).map(Number);
          if (!name || nums.length < 3 || nums.some((n) => Number.isNaN(n))) {
            throw new Error('usage: !route add <name> <x> <y> <z>');
          }
          const added = ctx.places.addRoutePoint(name, { x: nums[0], y: nums[1], z: nums[2] });
          if (!added.ok) throw new Error(added.reason);
          this.say(`路线 ${name} 加了途经点 ${nums[0]} ${nums[1]} ${nums[2]}`);
          return added;
        }
        if (sub === 'plan' || sub === 'go') {
          const name = args[1];
          const route = ctx.places.route(name);
          if (!route || !route.points.length) throw new Error(`没有路线 ${name || '?'}`);
          const target = route.points[route.points.length - 1];
          const planner = ctx.body && typeof ctx.body.plan === 'function' ? ctx.body.plan.bind(ctx.body) : null;
          if (!planner) throw new Error('this body cannot preview a route');
          const plan = await planner(target, { range: 2, allowManMade: true });
          const stored = route.plan;
          if (sub === 'plan') {
            ctx.places.setRoutePlan(name, { ...plan, path: undefined, at: Date.now() });
            this.say(
              plan.ok
                ? `路线 ${name}: ${plan.waypoints} 个航点, ${plan.distance} 格, 纯步行不改地形`
                : `路线 ${name} 现在走不通: ${plan.reason}`
            );
            return plan;
          }
          /**
           * `go` is the commitment check: the stored plan said this route was walkable, so
           * if the world changed and it no longer is, the agent refuses and asks for a new
           * plan instead of strolling into a wall.
           */
          if (!plan.ok) {
            this.say(
              stored && stored.ok
                ? `不走了：世界变了（上次计划可走，现在 ${plan.reason}），先 !route plan ${name}`
                : `走不了：${plan.reason}`
            );
            return { ok: false, reason: plan.reason };
          }
          ctx.hub
            .submit({
              name: `route ${name}`,
              description: `walk route ${name} to ${target.x},${target.y},${target.z}`,
              source: 'chat',
              run: async () => {
                const ok = await ctx.body
                  .moveTo(target, { range: 2, timeoutMs: 120000, allowManMade: true })
                  .catch(() => false);
                return ok
                  ? { ok: true, detail: `arrived on route ${name} at ${target.x},${target.y},${target.z}` }
                  : { ok: false, reason: (ctx.body.lastMove && ctx.body.lastMove.reason) || 'walk failed' };
              }
            })
            .then((receipt) => ctx.places.recordWalk(name, { at: Date.now(), accepted: receipt.taskId }))
            .catch(() => {});
          this.say(`出发走路线 ${name}（${plan.waypoints} 个航点）`);
          return { ok: true, accepted: true, plan };
        }
        throw new Error('usage: !route add|plan|go|list|show|delete ...');
      },

      rule: (args) => {
        if (!ctx.permissions) throw new Error('this agent has no permission store');
        const sub = (args[0] || 'list').toLowerCase();
        if (sub === 'list') {
          const summary = ctx.permissions.summary();
          const rules = summary.rules.map((r) => `#${r.index} ${r.effect} ${r.action} ${r.match}`).join(' | ');
          this.say(`权限模式=${summary.mode}${rules ? `；${rules}` : '；没有规则'}`);
          return summary;
        }
        if (sub === 'remove') {
          const result = ctx.permissions.removeRule(args[1]);
          if (!result.ok) throw new Error(result.reason);
          this.say(`删掉了规则 #${args[1]}`);
          return result;
        }
        if (sub === 'mode') {
          const result = ctx.permissions.setMode((args[1] || '').toLowerCase());
          if (!result.ok) throw new Error(result.reason);
          this.say(`权限模式=${result.mode}`);
          return result;
        }
        if (['allow', 'deny', 'ask'].includes(sub)) {
          const action = args[1] || '*';
          const match = args[2] || '*';
          const result = ctx.permissions.addRule({ effect: sub, action, match });
          if (!result.ok) throw new Error(result.reason);
          this.say(`规则 #${result.index}: ${sub} ${action} ${match}`);
          return result;
        }
        throw new Error('usage: !rule list | !rule allow|deny|ask <action> <match> | !rule remove <n> | !rule mode <ask|bypass|observe>');
      },

      yes: (args) => {
        if (!ctx.consent) throw new Error('this agent has no consent desk');
        const always = (args[0] || '').toLowerCase() === 'always';
        const result = ctx.consent.answer(always ? 'yes always' : 'yes');
        if (!result.ok) throw new Error(result.reason);
        this.say(always ? '好，以后都允许' : '好，这次允许');
        return result;
      },

      no: () => {
        if (!ctx.consent) throw new Error('this agent has no consent desk');
        const result = ctx.consent.answer('no');
        if (!result.ok) throw new Error(result.reason);
        this.say('好，不做');
        return result;
      }
    };
  }

  /** Something with `.inventory.items()`; the facade under clientmod, the bot otherwise. */
  inventorySource() {
    if (this.ctx.botFacade) return this.ctx.botFacade;
    return this.bot;
  }

  /**
   * Queue a task, tagging it with where the instruction came from.
   *
   * The provenance is not decoration: the LLM layer uses it to decide whether a finished
   * task is one *it* dispatched and should therefore report back on (plan 5.6), while the
   * rule table's own work must never wake it. An LLM-dispatched command therefore has to
   * arrive tagged `llm` even though it travels through this same table - hence the per-call
   * `dispatchSource` rather than a hardcoded source in each handler.
   *
   * @param {import('../tasks/task').Task} task
   */
  enqueue(task) {
    const source = this.dispatchSource || 'chat';
    /**
     * Surface refusals. `brain.enqueue` now answers immediately, and it may refuse because
     * the body is held by a background task (`task` hold) or after death; without this the
     * handler's cheerful "on my way" line would be the last thing the player hears.
     */
    return Promise.resolve(this.ctx.brain.enqueue(task, { level: 'directive', source })).then((receipt) => {
      if (receipt && receipt.accepted === false) {
        const why =
          receipt.reason === 'body-busy'
            ? `后台任务占用中（${receipt.detail || 'task'}），先 !task stop`
            : receipt.reason === 'stopped-after-death'
              ? '死亡后停着，发 !resume 再继续'
              : receipt.reason || '任务被拒绝';
        /**
         * Force: a refusal is the answer the player is waiting for. The ack debounce
         * (minReplyGapMs) swallowed this exact line in live testing right after the
         * handler's "on my way" ack, leaving only the misleading half.
         */
        const text = `现在不行：${why}`;
        if (this.ctx.reply) {
          Promise.resolve(this.ctx.reply(text, { why: 'command-refusal', force: true })).catch(() => {});
        } else {
          this.say(text);
        }
      }
      return receipt;
    });
  }

  /**
   * `!deposit <item> <count>` and `!store <item> <count>` are the same command (2026-10-21).
   *
   * Both item and count are required: the deposit skill no longer has an implicit
   * "everything except tools" mode. The task runs in the background because it may walk up
   * to 15 blocks and craft+place a chest, and the command endpoint must answer immediately.
   */
  depositCommand(args = []) {
    const item = String(args[0] || '').trim();
    const count = Number(args[1]);
    if (!item || !Number.isFinite(count) || count < 1) {
      throw new Error('usage: !deposit <item> <count> (alias: !store <item> <count>)');
    }
    const capped = Math.min(Math.floor(count), 2304);
    this.say(`去存 ${capped} 个 ${item}`);
    return this.enqueue(new DepositTask(this.ctx, { item, count: capped }));
  }

  /**
   * `!withdraw <item> [count]` (2026-10-21 optimization).
   *
   * The skill now walks to each pure container with A* and reads it for the item, so the
   * command runs as a background task like deposit; the HTTP command endpoint must answer
   * immediately instead of blocking for the walk. `item` is required, `count` defaults to 1.
   */
  withdrawCommand(args = []) {
    const item = String(args[0] || '').trim();
    if (!item) throw new Error('usage: !withdraw <item> [count]');
    let count = 1;
    if (args[1] !== undefined) {
      const parsed = Number(args[1]);
      if (!Number.isFinite(parsed) || parsed < 1) throw new Error('usage: !withdraw <item> [count]');
      count = Math.min(Math.floor(parsed), 2304);
    }
    this.say(`去取 ${count} 个 ${item}`);
    return this.enqueue(new WithdrawTask(this.ctx, { item, count }));
  }

  /**
   * Run one registered skill (src/skills) and hand back its result.
   *
   * The `!` channel and the LLM actuator layer share this one catalogue, so a capability can
   * never be "available in chat but not to the model" or the reverse. Refusals are logged
   * with their reason, which is what the player then sees.
   */
  async runSkill(name, params = {}) {
    const skills = require('../skills');
    const result = await skills.run(name, this.ctx, params);
    const ok = !!(result && result.ok !== false);
    const detail = result && (result.detail || result.reason) ? result.detail || result.reason : '';
    // Always answer. A silent skill looked exactly like a broken command in live testing.
    this.say(ok ? `好（${name}）${detail ? '：' + detail : ''}` : `不行（${name}）：${detail || '失败'}`);
    if (!ok) this.log.warn(`skill ${name} failed (${result.failure || 'unknown'}): ${detail}`);
    return result;
  }

  /**
   * Natural-language-ish goal router.
   *
   * Shared by `!goal`, the CLI and the LLM fallback router (plan 5.5), which is why it must
   * keep working with no LLM configured at all. The verb set is deliberately clamped to the
   * five P0 actions; anything else throws so the caller can answer honestly.
   */
  async onGoal(text) {
    /**
     * One goal router for `!goal` and `--goal` (plan §5.6.1): the two copies drifted on
     * ordering, so "挖铁" mined stone in one of them. The router keeps the note/ack here
     * and the task construction there, so the answer the player hears still names the
     * right job.
     */
    const routed = routeGoal(this.ctx, text);
    if (!routed) throw new Error(`goal not understood: "${text}"`);
    this.say(routed.note);
    return this.enqueue(routed.task);
  }

  /**
   * Execute a command programmatically (chat listener / HTTP API / tests).
   *
   * @param {string} line the command without its prefix
   * @param {string} [username] origin label
   * @param {object} [options] { source } provenance tag for the tasks this creates
   */
  async handle(line, username = 'console', options = {}) {
    const parts = String(line).trim().split(/\s+/);
    const cmd = parts.shift();
    const handler = this.handlers[cmd];
    const entry = { at: new Date().toISOString(), command: cmd, args: parts, from: username };
    this.history.push(entry);
    if (this.history.length > 30) this.history.shift();

    if (!handler) {
      this.say(`unknown command "${cmd}" - try ${this.prefix}help`);
      entry.ok = false;
      entry.reason = 'unknown command';
      return { ok: false, reason: 'unknown command' };
    }

    const previousSource = this.dispatchSource;
    this.dispatchSource = options.source || 'chat';
    try {
      const result = await handler(parts, username);
      entry.ok = true;
      entry.source = this.dispatchSource;
      entry.result = result && result.accepted !== undefined ? result : undefined;
      return { ok: true, command: cmd, result };
    } catch (err) {
      entry.ok = false;
      entry.reason = err.message;
      throw err;
    } finally {
      this.dispatchSource = previousSource;
    }
  }

  status() {
    return {
      prefix: this.prefix,
      attached: this.attached,
      commands: Object.keys(this.handlers),
      recent: this.history.slice(-8)
    };
  }
}

function expandBlockNames(name) {
  /**
   * Compatibility wrapper: the alias table lives in `src/core/miningRequest.js` now, so
   * the command layer, the LLM dispatch and the skill boundary expand names identically
   * (plan §5.6.3: "别名规则只维护一份"; unknown `_ore` names no longer get an invented
   * deepslate twin such as `deepslate_nether_quartz_ore`).
   */
  return expandTargetAliases(name);
}

module.exports = { ChatController, HELP, expandBlockNames };
