'use strict';

/**
 * In-game chat control - the deterministic command channel.
 *
 * This is channel A of the two input channels in P0: a human types `!chop 8` into the
 * Minecraft chat box, and it becomes a task. Channel B is the natural-language/LLM path
 * (`@猫娘 砍点树`), which lands in the same command table through `src/llm/`.
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
      help: () => this.say(HELP.join(' | ')),
      status: () => {
        const s = ctx.world.summary();
        const brain = ctx.brain.status();
        this.say(
          `hp=${s.health} food=${s.food} pos=${s.position.x},${s.position.y},${s.position.z} ` +
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
          .join(', ');
        this.say(text ? `inventory: ${text}` : '背包是空的喵');
      },
      stop: () => {
        // A real stop: cancel everything AND silence the 2.5s planner. Without the flag the
        // planner re-queued the next goal immediately and the bot looked unstoppable.
        ctx.brain.preempt();
        ctx.brain.autoPlanDisabled = true;
        ctx.nav.stop();
        if (ctx.body && typeof ctx.body.interrupt === 'function') ctx.body.interrupt('!stop');
        this.followTarget = null;
        this.say('停下来了喵（自动规划已暂停，发 !resume 继续）');
      },
      pause: () => {
        ctx.brain.pause();
        this.say('暂停了喵');
      },
      resume: () => {
        // A resume after death is the one thing that clears the post-death stop.
        if (ctx.brain.stopped) ctx.brain.resumeFromDeath();
        if (ctx.deathWatch) ctx.deathWatch.dead = false;
        ctx.brain.autoPlanDisabled = false;
        ctx.brain.resume();
        this.say('继续干活喵');
      },
      mine: (args) => {
        const block = args[0] || 'stone';
        const count = Number(args[1]) || 8;
        // Ask for a couple extra: the last block often drops nothing useful, and the task
        // counts *items collected*, so overshooting slightly beats falling short.
        this.say(`去挖 ${count} 个 ${block} 喵`);
        return this.enqueue(new MineBlockTask(ctx, { block: expandBlockNames(block), count: count + 2 }));
      },
      chop: (args) => {
        const count = Number(args[0]) || 8;
        this.say(`去砍 ${count} 根木头喵`);
        return this.enqueue(new ChopWoodTask(ctx, { count }));
      },
      collect: () => {
        this.say('去捡东西喵');
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
            ? `准心: ${found.name} @ ${pos}${found.distance !== undefined ? ` (${Number(found.distance).toFixed(1)}m)` : ''}`
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
      goal: (args) => ctx.onGoal(args.join(' ')),
      goto: async (args) => {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((n) => Number.isNaN(n))) throw new Error('usage: !goto <x> <y> <z>');
        const task = new GoToTask(ctx, { position: { x, y, z }, range: 2, timeoutMs: 120000 });
        await this.enqueue(task);
        // GoToTask reports the pathfinding reason itself, so the reply says *why* when the
        // walk fails rather than the useless "could not get there".
        const res = task.result || {};
        this.say(res.ok ? `到了 ${x} ${y} ${z} 喵` : `走不过去喵: ${res.reason || 'unknown'}`);
        return res;
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
          this.say('我还没造过庇护所喵');
          return;
        }
        const task = new GoToTask(ctx, { position: shelter, range: 2, timeoutMs: 90000 });
        await this.enqueue(task);
        this.say(task.result && task.result.ok ? '到家了喵' : '找不到回家的路喵');
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
    return this.ctx.brain.enqueue(task, { level: 'directive', source });
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
    this.say(ok ? `好喵（${name}）${detail ? '：' + detail : ''}` : `不行喵（${name}）：${detail || '失败'}`);
    if (!ok) this.log.warn(`skill ${name} refused: ${detail}`);
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
      return direct(new ChopWoodTask(this.ctx, { count: Number(count) || 16 }), `去砍 ${Number(count) || 16} 根木头喵`);
    }
    if (/iron|铁/.test(t)) {
      return direct(
        new MineBlockTask(this.ctx, {
          block: ['iron_ore', 'deepslate_iron_ore'],
          count: Number(count) || 3,
          timeoutMs: 240000
        }),
        '去挖铁喵'
      );
    }
    if (/stone|cobble|石头|圆石|挖矿|挖点/.test(t)) {
      return direct(
        new MineBlockTask(this.ctx, { block: ['stone', 'cobblestone', 'deepslate'], count: Number(count) || 16 }),
        '去挖石头喵'
      );
    }
    if (/food|hunt|meat|食物|打猎|吃肉/.test(t)) {
      return direct(new HuntTask(this.ctx, { count: Number(count) || 3 }), '去打猎喵');
    }
    if (/shelter|house|庇护|房子|基地/.test(t)) return direct(new ShelterTask(this.ctx), '去造庇护所喵');
    if (/light|torch|火把|照明/.test(t)) return direct(new LightTask(this.ctx, { count: Number(count) || 4 }), '去插火把喵');
    if (/store|chest|存|箱子/.test(t)) return direct(new DepositTask(this.ctx), '去存东西喵');
    if (/craft|合成/.test(t)) {
      const item = t.replace(/craft|合成|\d+|个/g, '').trim().replace(/\s+/g, '_');
      return direct(new CraftTask(this.ctx, { item, count: Number(count) || 1 }), `去合成 ${item} 喵`);
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
  return aliases[name] || [name];
}

module.exports = { ChatController, HELP, expandBlockNames };
