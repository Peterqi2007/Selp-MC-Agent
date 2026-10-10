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
const { LightTask } = require('../tasks/light');
const { ChopWoodTask } = require('../tasks/chopWood');
const { MineBlockTask } = require('../tasks/mineBlock');
const { GoToTask } = require('../tasks/goto');
const { inventorySummary } = require('../world/items');
const { Logger } = require('../util/logger');

const HELP = [
  '!status - health, food, position, current goal',
  '!chop [n] - gather n logs (walk -> break -> collect)',
  '!mine <block> [n] - mine n blocks',
  '!goto <x> <y> <z> - walk there using pathfinding',
  '!collect - pick up nearby dropped items',
  '!eat [food] - eat the best food carried (or a named item)',
  '!equip <item> - hold an item from the inventory',
  '!armor - equip the best armour pieces carried',
  '!drop <item> [n] - drop n of an item',
  '!place <item> <x> <y> <z> [face] - place a block',
  '!use <x> <y> <z> [face] [item] - right-click a block (hoe, plant, bucket, open)',
  '!attack [type] - attack the nearest hostile',
  '!defend [range] - fight hostiles that come close',
  '!explore [distance] [direction] - walk somewhere new',
  '!withdraw <item> [n] - take items out of a nearby chest',
  '!deposit [item] - store items in a nearby chest',
  '!come <player> - walk to a visible player',
  '!look <yaw> <pitch> - turn the camera to absolute angles (degrees)',
  '!lookat <x> <y> <z> - look at a coordinate',
  '!target - what is under the crosshair right now',
  '!smelt <item> [n] - smelt in a nearby furnace',
  '!farm [radius] - harvest ripe crops, till soil, plant seeds',
  '!sleep - sleep in a nearby bed until morning',
  '!goal <text> - queue a goal in words',
  '!hunt [n] - hunt animals for food',
  '!craft <item> [n] - craft an item',
  '!shelter - build a night shelter',
  '!light [n] - place torches',
  '!store - deposit loot in a chest',
  '!task status|stop - the background task slot',
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
    this.followTarget = null;
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
        ctx.nav.stop();
        if (ctx.body && typeof ctx.body.interrupt === 'function') ctx.body.interrupt('!stop');
        this.followTarget = null;
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
      mine: (args) => {
        const block = args[0] || 'stone';
        const count = Number(args[1]) || 8;
        /**
         * A comma list arrives from the LLM dispatch, which now passes the whole target list
         * instead of only its first name; each entry expands into its variants (see
         * expandBlockNames). Dropping all but one name is how a diamond job at y=-59 searched
         * for `diamond_ore` while every block down there is `deepslate_diamond_ore`.
         */
        const blocks = String(block)
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
          .flatMap((n) => expandBlockNames(n));
        // Ask for a couple extra: the last block often drops nothing useful, and the task
        // counts *items collected*, so overshooting slightly beats falling short.
        this.say(`去挖 ${count} 个 ${block}`);
        return this.enqueue(new MineBlockTask(ctx, { block: blocks, count: count + 2 }));
      },
      chop: (args) => {
        const count = Number(args[0]) || 8;
        this.say(`去砍 ${count} 根木头`);
        return this.enqueue(new ChopWoodTask(ctx, { count }));
      },
      collect: () => {
        this.say('去捡东西');
        return this.enqueue(new ChopWoodTask(ctx, { count: 1, searchRadius: 24 }));
      },
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
      explore: (args) => this.runSkill('explore', { distance: Number(args[0]) || 16, direction: args[1] }),
      withdraw: (args) => {
        if (!args[0]) throw new Error('usage: !withdraw <item> [count]');
        return this.runSkill('withdraw', { item: args[0], count: Number(args[1]) || 1 });
      },
      deposit: (args) => this.runSkill('deposit', args[0] ? { item: args[0] } : {}),
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
      shelter: () => this.enqueue(new ShelterTask(ctx)),
      light: (args) => this.enqueue(new LightTask(ctx, { count: Number(args[0]) || 4 })),
      store: () => this.enqueue(new DepositTask(ctx)),
      goal: (args) => ctx.onGoal(args.join('')),
      goto: async (args) => {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((n) => Number.isNaN(n))) throw new Error('usage: !goto <x> <y> <z>');
        const task = new GoToTask(ctx, { position: { x, y, z }, range: 2, timeoutMs: 120000 });
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
        const name = args[0];
        if (!name) throw new Error('usage: !follow <player>');
        this.followTarget = name;
        this.startFollowLoop();
        this.say(`following ${name}`);
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
    const t = String(text).toLowerCase();
    const count = (t.match(/(\d+)/) || [])[1];
    const direct = (task, note) => {
      if (note) this.say(note);
      return this.enqueue(task);
    };
    if (/wood|log|tree|木头|原木|砍树|砍点|砍些/.test(t)) {
      return direct(new ChopWoodTask(this.ctx, { count: Number(count) || 16 }), `去砍 ${Number(count) || 16} 根木头`);
    }
    if (/iron|铁/.test(t)) {
      return direct(
        new MineBlockTask(this.ctx, {
          block: ['iron_ore', 'deepslate_iron_ore'],
          count: Number(count) || 3,
          timeoutMs: 240000
        }),
        '去挖铁'
      );
    }
    if (/stone|cobble|石头|圆石|挖矿|挖点/.test(t)) {
      return direct(
        new MineBlockTask(this.ctx, { block: ['stone', 'cobblestone', 'deepslate'], count: Number(count) || 16 }),
        '去挖石头'
      );
    }
    if (/food|hunt|meat|食物|打猎|吃肉/.test(t)) {
      return direct(new HuntTask(this.ctx, { count: Number(count) || 3 }), '去打猎');
    }
    if (/shelter|house|庇护|房子|基地/.test(t)) return direct(new ShelterTask(this.ctx), '去造庇护所');
    if (/light|torch|火把|照明/.test(t)) return direct(new LightTask(this.ctx, { count: Number(count) || 4 }), '去插火把');
    if (/store|chest|存|箱子/.test(t)) return direct(new DepositTask(this.ctx), '去存东西');
    if (/craft|合成/.test(t)) {
      const item = t.replace(/craft|合成|\d+|个/g, '').trim().replace(/\s+/g, '_');
      return direct(new CraftTask(this.ctx, { item, count: Number(count) || 1 }), `去合成 ${item}`);
    }
    throw new Error(`goal not understood: "${text}"`);
  }

  startFollowLoop() {
    if (this.followTimer) return;
    this.followTimer = setInterval(async () => {
      const target = this.followTarget && this.bot && this.bot.players ? this.bot.players[this.followTarget] : null;
      if (!target || !target.entity) {
        this.followTarget = null;
        clearInterval(this.followTimer);
        this.followTimer = null;
        return;
      }
      const distance = this.bot.entity.position.distanceTo(target.entity.position);
      if (distance > 4) {
        await this.ctx.nav.goto(target.entity.position, { range: 3, timeoutMs: 8000, canDig: true, freshMovements: true });
      }
    }, 1500);
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
      followTarget: this.followTarget,
      commands: Object.keys(this.handlers),
      recent: this.history.slice(-8)
    };
  }
}

function expandBlockNames(name) {
  const clean = String(name).replace(/^minecraft:/, '').trim();
  const aliases = {
    stone: ['stone', 'cobblestone', 'deepslate'],
    cobble: ['cobblestone'],
    cobblestone: ['cobblestone'],
    iron: ['iron_ore', 'deepslate_iron_ore'],
    coal: ['coal_ore', 'deepslate_coal_ore'],
    diamond: ['diamond_ore', 'deepslate_diamond_ore'],
    gold: ['gold_ore', 'deepslate_gold_ore'],
    sand: ['sand', 'red_sand'],
    gravel: ['gravel'],
    // The whole vanilla soil family: the live server's ground is often a biome-mod variant,
    // and `MineBlockTask` additionally matches modded `*_dirt` / `*_grass_block` names.
    dirt: ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'moss_block', 'mud'],
    wood: ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log']
  };
  if (aliases[clean]) return aliases[clean];
  /**
   * Deepslate twins: below y=0 every `<x>_ore` generates as `deepslate_<x>_ore`. The model
   * says "diamond_ore"; passing that through unchanged made a deep-mine job search for
   * blocks that cannot exist there (live 2026-10-10).
   */
  if (/_ore$/.test(clean) && !clean.startsWith('deepslate_')) {
    return [clean, `deepslate_${clean}`];
  }
  return [clean];
}

module.exports = { ChatController, HELP, expandBlockNames };
