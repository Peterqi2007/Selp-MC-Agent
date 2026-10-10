'use strict';

/**
 * The fallback router (P0-PLAN §5.5): deterministic intent extraction with no model.
 *
 * This is the component that makes the promise "`!chop 32` and `the dialogue trigger both work"
 * true *regardless of the LLM*. It runs in three situations, and the agent would be
 * unreliable without it in all three:
 *
 *   - no API key or `llm.json` missing  -> this is the only router
 *   - the request timed out (8s)        -> this answers instead of silence
 *   - the model returned invalid JSON   -> this answers instead of silence
 *
 * It is a content router, not a grammar: bilingual keywords (the user types Chinese, the
 * persona answers Chinese) mapped onto the same five P0 actions. Anything it cannot place
 * returns `null` so the caller can honestly say "I did not understand" rather than
 * guessing at a task that will run for three minutes in the wrong direction.
 */

const { normalizeIntent } = require('./intent');
const miningRequest = require('../core/miningRequest');

/** Keyword groups per action. Order matters: the first match wins. */
const RULES = [
  {
    name: 'stop',
    // Checked first: "别砍了 / stop chopping" contains the chop keyword too, and stopping
    // must win over the verb it mentions.
    pattern: /(停下|停止|别动|不要动|别砍|别挖|取消|中止|\bstop\b|\bcancel\b|\bhalt\b|\babort\b)/i,
    build: () => ({ type: 'stop' }),
    say: '好，停下了'
  },
  {
    name: 'chop',
    pattern: /(砍|木头|原木|树木|树|伐木|\bchop\b|\bwood\b|\blogs?\b|\btree\b|\btimber\b)/i,
    build: (count) => ({ type: 'task', task: 'chop', args: { count: count || 8 } }),
    say: (count) => `去砍 ${count || 8} 根木头`
  },
  /**
   * Phase 3 skill rules. Order matters the same way as the tasks above: eating must be
   * recognised before the generic "mine/dig" verbs, sleeping before anything that might
   * mention night, and the storage verbs before the gather rules ("收起来" is not "收集").
   */
  {
    name: 'eat',
    pattern: /(饿|吃东西|吃点|吃饭|进食|填饱|食物不够|\beat\b|\bhungry\b|\bfood\b)/i,
    build: () => ({ type: 'skill', skill: 'eat', args: {} }),
    say: '吃东西'
  },
  {
    name: 'sleep',
    pattern: /(睡觉|睡一觉|过夜|上床|天黑.*睡|\bsleep\b|\bbed\b)/i,
    build: () => ({ type: 'skill', skill: 'sleep', args: {} }),
    say: '去睡觉'
  },
  {
    name: 'farm',
    pattern: /(种地|种田|种庄稼|收庄稼|收割|种小麦|种点|\bfarm\b|\bharvest\b|\bplant\b)/i,
    build: (count, text) => ({ type: 'skill', skill: 'farm', args: count ? { radius: Math.min(16, Math.max(2, count)) } : {} }),
    say: '去种地'
  },
  {
    name: 'fish',
    pattern: /(钓鱼|钓点鱼|去钓鱼|钓一?会儿鱼|钓鱼竿|\bfish\b|\bfishing\b|\bcast\b)/i,
    build: (count) => ({ type: 'skill', skill: 'fish', args: count ? { maxCatches: Math.min(64, Math.max(1, count)) } : {} }),
    say: '去钓鱼'
  },
  {
    name: 'craft',
    pattern: /(合成|制作|做一?把|做一?个|\bcraft\b|\bmake\b)/i,
    build: (count, text) => {
      const item = itemIn(text);
      if (!item) return null; // do not guess an item from prose
      return { type: 'skill', skill: 'craft', args: { item, count: count || 1 } };
    },
    say: (count, text) => `去合成 ${itemIn(text) || '东西'}`
  },
  {
    name: 'smelt',
    pattern: /(熔炼|冶炼|烧矿|烧制|烧点|烧一下|\bsmelt\b|\bsmelting\b)/i,
    build: (count, text) => {
      const item = itemIn(text);
      if (!item) return null;
      return { type: 'skill', skill: 'smelt', args: { item, count: count || 1 } };
    },
    say: '去熔炼'
  },
  {
    name: 'defend',
    pattern: /(自卫|打我|被围|有怪|怪物|危险|保护我|\bdefend\b|\bhelp me\b)/i,
    build: () => ({ type: 'skill', skill: 'defend', args: {} }),
    say: '去自卫'
  },
  {
    name: 'attack',
    pattern: /(攻击|打怪|打它|杀掉|打死|\battack\b|\bkill\b)/i,
    build: () => ({ type: 'skill', skill: 'attack', args: {} }),
    say: '去打它'
  },
  {
    name: 'deposit',
    pattern: /(存起来|收起来|放进箱|存进箱|存一下|存东西|\bdeposit\b|\bstore\b)/i,
    build: () => ({ type: 'skill', skill: 'deposit', args: {} }),
    say: '去存东西'
  },
  {
    name: 'withdraw',
    pattern: /(取出来|拿出来|从箱子|取一点|取出|\bwithdraw\b)/i,
    build: (count, text) => {
      // "从箱子里取点火把" names the container as the location, not as the item.
      const item = itemIn(text, { exclude: ['chest', 'furnace', 'crafting_table'] });
      if (!item) return null;
      return { type: 'skill', skill: 'withdraw', args: { item, count: count || 1 } };
    },
    say: '去取东西'
  },
  {
    name: 'explore',
    pattern: /(探索|逛逛|四处看看|随便走走|\bexplore\b|\bwander\b)/i,
    build: (count) => ({ type: 'skill', skill: 'explore', args: count ? { distance: Math.min(64, Math.max(4, count)) } : {} }),
    say: '四处逛逛'
  },
  {
    name: 'mine',
    pattern: /(挖矿|挖|采矿|矿石|石头|圆石|铁|煤|钻石|金|沙|\bmine\b|\bdig\b|\bmining\b|\bstone\b|\bcobble(stone)?\b|\biron\b|\bcoal\b|\bdiamond\b|\bgold\b|\bsand\b)/i,
    build: (count, text) => {
      const names = blocksFor(text);
      const target = count || 8;
      /**
       * The router only extracts the intent and the count; which executor runs is the
       * shared classifier's decision (plan §5.6.1: "目标分类共用同一规则"). Ores go to
       * the dig-while-walking skill - the legacy `mine` task is walk-only and reports
       * "no X available nearby" for veins embedded in rock (live 2026-10-10) - while
       * stone/sand keep the proven harvest task.
       */
      const classified = miningRequest.normalizeMiningRequest({ blocks: names });
      if (classified.ok && classified.kind === 'ore') {
        return { type: 'skill', skill: 'mine_ore', args: { block: classified.blocks.join(','), count: target } };
      }
      return { type: 'task', task: 'mine', args: { block: names, count: target } };
    },
    say: (count) => `去挖 ${count || 8} 个`
  },
  {
    name: 'collect',
    pattern: /(捡|拾取|收集掉落|\bcollect\b|\bpick ?up\b|\bgrab\b|\bdrops?\b)/i,
    build: () => ({ type: 'task', task: 'collect', args: {} }),
    say: '去捡东西'
  },
  {
    name: 'go_to',
    pattern: /(过来|过来吧|到这里|去坐标|走到|过去|前往|\bcome\b|\bgo to\b|\bwalk to\b|\bmove to\b|\bgoto\b)/i,
    // Deliberately NOT resolved from the request text: "come here" means "walk to the
    // PLAYER", and the router cannot see the player's coordinates (the chat log has no
    // sender and no positions). Returning the action with no coordinates lets the caller
    // fill them in from the trigger position, or answer honestly if it cannot.
    build: () => ({ type: 'go_to', resolve: 'speaker' }),
    say: '我这就过去'
  }
];

/** Map the request text onto concrete block names the mining task understands. */
function blocksFor(text) {
  const t = String(text);
  if (/铁|iron/i.test(t)) return ['iron_ore', 'deepslate_iron_ore'];
  if (/钻石|diamond/i.test(t)) return ['diamond_ore', 'deepslate_diamond_ore'];
  if (/煤|coal/i.test(t)) return ['coal_ore', 'deepslate_coal_ore'];
  if (/金|gold/i.test(t)) return ['gold_ore', 'deepslate_gold_ore'];
  if (/沙|sand/i.test(t)) return ['sand', 'red_sand'];
  if (/圆石|cobble/i.test(t)) return ['cobblestone'];
  return ['stone', 'cobblestone', 'deepslate'];
}

/** zh -> item id aliases for the craft/smelt/withdraw rules. */
const ITEM_ALIASES = {
  石镐: 'stone_pickaxe',
  木镐: 'wooden_pickaxe',
  铁镐: 'iron_pickaxe',
  钻石镐: 'diamond_pickaxe',
  石剑: 'stone_sword',
  铁剑: 'iron_sword',
  工作台: 'crafting_table',
  箱子: 'chest',
  熔炉: 'furnace',
  火把: 'torch',
  木板: 'oak_planks',
  木棍: 'stick',
  棍子: 'stick',
  铁矿: 'raw_iron',
  金矿: 'raw_gold',
  铜矿: 'raw_copper',
  沙子: 'sand',
  圆石: 'cobblestone',
  石头: 'cobblestone',
  铁锭: 'iron_ingot',
  金锭: 'gold_ingot',
  钻石: 'diamond',
  煤: 'coal',
  铁: 'raw_iron'
};

/**
 * The item a request names, or null.
 *
 * Chinese aliases first; otherwise an English token is accepted only when minecraft-data
 * knows it as an item, so "craft me something please" cannot turn "me" into an item.
 */
function itemIn(text, options = {}) {
  const raw = String(text || '');
  const exclude = new Set(options.exclude || []);
  for (const [zh, en] of Object.entries(ITEM_ALIASES)) {
    if (raw.includes(zh) && !exclude.has(en)) return en;
  }
  let data = null;
  try {
    data = require('minecraft-data')('1.20.1');
  } catch {
    data = null;
  }
  if (!data || !data.itemsByName) return null;
  for (const token of raw.toLowerCase().match(/[a-z_:]{3,}/g) || []) {
    const bareToken = token.replace(/^[a-z_]+:/, '');
    if (data.itemsByName[bareToken] && !exclude.has(bareToken)) return bareToken;
  }
  return null;
}

/** First integer in the text, clamped by intent.js's own limit at validation time. */
function countIn(text) {
  const match = String(text).match(/(\d+)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Route a message without an LLM.
 *
 * @param {string} text
 * @param {object} [options] { speakerPosition, speaker }
 * @returns {{ok:true, intent:object, matched:string} | {ok:false, reason:string}}
 */
function route(text, options = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'empty message' };

  for (const rule of RULES) {
    if (!rule.pattern.test(raw)) continue;

    const count = countIn(raw);
    const action = rule.build(count, raw);
    // A rule can match the words yet be unable to name a concrete target ("craft me
    // something"); in that case fall through instead of guessing.
    if (!action) continue;

    // "come here" -> the speaker's own coordinates, when the caller knows them.
    if (action.resolve === 'speaker') {
      const at = options.speakerPosition;
      if (!at) return { ok: false, reason: 'go_to needs coordinates and the speaker position is unknown' };
      delete action.resolve;
      action.x = Math.round(at.x);
      action.y = Math.round(at.y);
      action.z = Math.round(at.z);
    }

    const normalized = normalizeIntent({ say: typeof rule.say === 'function' ? rule.say(count) : rule.say, action });
    if (!normalized.ok) return { ok: false, reason: `fallback rule "${rule.name}" produced an invalid intent: ${normalized.reason}` };
    return { ok: true, intent: normalized.intent, matched: rule.name };
  }

  return { ok: false, reason: 'no fallback rule matched' };
}

module.exports = { route, RULES, blocksFor, countIn, itemIn };
