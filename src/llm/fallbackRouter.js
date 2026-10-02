'use strict';

/**
 * The fallback router (P0-PLAN §5.5): deterministic intent extraction with no model.
 *
 * This is the component that makes the promise "`!chop 32` and `@猫娘 砍点树` both work"
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

/** Keyword groups per action. Order matters: the first match wins. */
const RULES = [
  {
    name: 'stop',
    // Checked first: "别砍了 / stop chopping" contains the chop keyword too, and stopping
    // must win over the verb it mentions.
    pattern: /(停下|停止|别动|不要动|别砍|别挖|取消|中止|\bstop\b|\bcancel\b|\bhalt\b|\babort\b)/i,
    build: () => ({ type: 'stop' }),
    say: '好，停下了喵'
  },
  {
    name: 'chop',
    pattern: /(砍|木头|原木|树木|树|伐木|\bchop\b|\bwood\b|\blogs?\b|\btree\b|\btimber\b)/i,
    build: (count) => ({ type: 'task', task: 'chop', args: { count: count || 8 } }),
    say: (count) => `去砍 ${count || 8} 根木头喵`
  },
  {
    name: 'mine',
    pattern: /(挖矿|挖|采矿|矿石|石头|圆石|铁|煤|钻石|金|沙|\bmine\b|\bdig\b|\bmining\b|\bstone\b|\bcobble(stone)?\b|\biron\b|\bcoal\b|\bdiamond\b|\bgold\b|\bsand\b)/i,
    build: (count, text) => ({ type: 'task', task: 'mine', args: { block: blocksFor(text), count: count || 8 } }),
    say: (count) => `去挖 ${count || 8} 个喵`
  },
  {
    name: 'collect',
    pattern: /(捡|拾取|收集掉落|\bcollect\b|\bpick ?up\b|\bgrab\b|\bdrops?\b)/i,
    build: () => ({ type: 'task', task: 'collect', args: {} }),
    say: '去捡东西喵'
  },
  {
    name: 'go_to',
    pattern: /(过来|过来吧|到这里|去坐标|走到|过去|前往|\bcome\b|\bgo to\b|\bwalk to\b|\bmove to\b|\bgoto\b)/i,
    // Deliberately NOT resolved from the request text: "come here" means "walk to the
    // PLAYER", and the router cannot see the player's coordinates (the chat log has no
    // sender and no positions). Returning the action with no coordinates lets the caller
    // fill them in from the trigger position, or answer honestly if it cannot.
    build: () => ({ type: 'go_to', resolve: 'speaker' }),
    say: '我这就过去喵'
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

module.exports = { route, RULES, blocksFor, countIn };
