'use strict';

/**
 * Mining request normalization: the single interpreter between "what was asked" and
 * "which concrete targets, how many, which executor".
 *
 * The plan (docs/MINING-LLM-PLAN.md §5.6) found six entry points - `!mine`, `do_task`,
 * the LLM JSON task, the fallback router, `do_skill("mine_ore")` and the autonomous
 * brain - each with its own idea of what `iron` means and whether a deepslate variant
 * counts. This module is the one table they all share:
 *
 *   - alias words (`iron`, `diamond`, `stone`, `sand`, ...) expand here, once;
 *   - a plain overworld ore name (`diamond_ore`) expands to the real pair
 *     (`diamond_ore` + `deepslate_diamond_ore`), an explicit deepslate name stays exact,
 *     and nether/modded names never get an invented deepslate twin;
 *   - `_ore`-suffixed names this table does not know are only accepted when a
 *     knowledge resolver confirms they are real mineable ores - no guessing;
 *   - `count` is a strict 1..256 integer when given (no `Number(x) || 8` masking);
 *   - mixing ores with plain materials in one request is a bad_argument, because the
 *     two go to different executors.
 *
 * Pure by construction: no chat, no LLM, no Brain, no Body.
 */

/**
 * Plain overworld ore -> the concrete pair that actually generates. The deepslate set is
 * an explicit registry fact, not an `_ore` -> `deepslate__ore` string trick, so
 * `nether_quartz_ore` and modded ores can never pick up a variant that does not exist.
 */
const OVERWORLD_ORE_VARIANTS = {
  coal_ore: ['coal_ore', 'deepslate_coal_ore'],
  iron_ore: ['iron_ore', 'deepslate_iron_ore'],
  copper_ore: ['copper_ore', 'deepslate_copper_ore'],
  gold_ore: ['gold_ore', 'deepslate_gold_ore'],
  redstone_ore: ['redstone_ore', 'deepslate_redstone_ore'],
  emerald_ore: ['emerald_ore', 'deepslate_emerald_ore'],
  lapis_ore: ['lapis_ore', 'deepslate_lapis_ore'],
  diamond_ore: ['diamond_ore', 'deepslate_diamond_ore']
};

/** Ores with no deepslate twin, accepted exactly as written. */
const SINGLE_ORES = new Set(['nether_quartz_ore', 'nether_gold_ore', 'ancient_debris']);

/** Every ore name this module treats as a confirmed vanilla ore target. */
const ORE_BLOCKS = new Set([...SINGLE_ORES]);
for (const pair of Object.values(OVERWORLD_ORE_VARIANTS)) {
  for (const name of pair) ORE_BLOCKS.add(name);
}
for (const name of Object.keys(OVERWORLD_ORE_VARIANTS)) ORE_BLOCKS.add(name);

/** Words the players and the model actually say, mapped to concrete block names. */
const TARGET_ALIASES = {
  iron: ['iron_ore'],
  coal: ['coal_ore'],
  diamond: ['diamond_ore'],
  gold: ['gold_ore'],
  copper: ['copper_ore'],
  redstone: ['redstone_ore'],
  emerald: ['emerald_ore'],
  lapis: ['lapis_ore'],
  quartz: ['nether_quartz_ore'],
  netherite: ['ancient_debris'],
  debris: ['ancient_debris'],
  stone: ['stone', 'cobblestone', 'deepslate'],
  cobble: ['cobblestone'],
  cobblestone: ['cobblestone'],
  sand: ['sand', 'red_sand'],
  gravel: ['gravel'],
  // The whole vanilla soil family: the live server's ground is often a biome-mod variant,
  // and `MineBlockTask` additionally matches modded `*_dirt` / `*_grass_block` names.
  dirt: ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium', 'moss_block', 'mud'],
  wood: ['oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log']
};

/** Skill parameters the unified layer passes through untouched (the skill schema validates). */
const PASSTHROUGH_PARAMS = ['maxXZ', 'maxY', 'maxMs', 'maxApproachDigs', 'maxExtraDigs', 'eatAt', 'food', 'torch', 'lightThreshold'];

const MAX_COUNT = 256;

/** Strip the vanilla namespace and normalise case; other namespaces stay intact. */
function cleanName(name) {
  const text = String(name == null ? '' : name).trim().toLowerCase();
  if (!text) return '';
  return text.startsWith('minecraft:') ? text.slice('minecraft:'.length) : text;
}

function namespaceOf(name) {
  const text = String(name || '');
  const at = text.indexOf(':');
  return at > 0 ? text.slice(0, at) : null;
}

/**
 * Expand one requested name into concrete block names.
 *
 * @param {string} name raw target (alias, comma-free)
 * @returns {string[]} concrete names, order preserved, may be empty for empty input
 */
function expandTarget(name) {
  const clean = cleanName(name);
  if (!clean) return [];
  const alias = TARGET_ALIASES[clean];
  const seeds = alias || [clean];
  const out = [];
  for (const seed of seeds) {
    const pair = OVERWORLD_ORE_VARIANTS[seed];
    if (pair) {
      for (const variant of pair) out.push(variant);
    } else {
      out.push(seed);
    }
  }
  return [...new Set(out)];
}

/**
 * Old `expandBlockNames` contract, kept as the one alias table for the command layer.
 * (`commands.js` re-exports this so there is a single implementation.)
 */
function expandBlockNames(name) {
  const clean = cleanName(name);
  if (!clean) return [];
  const expanded = expandTarget(clean);
  return expanded.length ? expanded : [clean];
}

/**
 * Known-or-conservative classification of one concrete block name.
 *
 * @param {string} name bare or namespaced block name
 * @param {(name:string) => ({category?:string, mineable?:boolean}|null)} [resolver]
 * @returns {'ore'|'material'|'unknown'}
 */
function classifyTarget(name, resolver) {
  const raw = String(name || '').toLowerCase();
  const bareName = cleanName(raw);
  if (!bareName) return 'unknown';
  const modded = namespaceOf(raw) && namespaceOf(raw) !== 'minecraft';

  if (!modded && ORE_BLOCKS.has(bareName)) return 'ore';
  if (!modded && !/_ore$/.test(bareName)) return 'material';

  /**
   * Non-vanilla or unknown `_ore` names need confirmation. The resolver (mod knowledge +
   * tool policy, injected by the caller) answers "is this a real, mineable block, and is
   * it an ore?". Without a positive answer the request is refused - the plan's rule is
   * "无法确认不猜测挖掘".
   */
  if (/_ore$/.test(bareName) || ORE_BLOCKS.has(bareName)) {
    const verdict = typeof resolver === 'function' ? resolver(raw) : null;
    if (verdict && verdict.mineable !== false && verdict.category === 'ore') return 'ore';
    return 'unknown';
  }
  // Other modded names are materials; the old material task reports honestly if it
  // cannot find them, and the resolver can still flag an ore-category surprise.
  const verdict = typeof resolver === 'function' ? resolver(raw) : null;
  if (verdict && verdict.mineable !== false && verdict.category === 'ore') return 'ore';
  return 'material';
}

/**
 * Build a resolver from an agent context (mod knowledge), duck-typed so this module
 * stays independent of the knowledge implementation.
 *
 * @param {object} ctx
 * @returns {(name:string) => ({category:string, mineable:boolean}|null)}
 */
function resolverFromCtx(ctx) {
  const knowledge = ctx && ctx.modKnowledge;
  if (!knowledge || typeof knowledge.classify !== 'function') return null;
  return (name) => {
    try {
      const cls = knowledge.classify(name);
      const mineable = typeof knowledge.isMineable === 'function' ? knowledge.isMineable(name) : cls.category !== 'unknown';
      return { category: cls && cls.category ? cls.category : 'unknown', mineable };
    } catch {
      return null;
    }
  };
}

/**
 * Parse a strict count: integer 1..256; anything else is refused.
 *
 * @returns {{ok:true, value:number|undefined} | {ok:false, reason:string}}
 */
function parseCount(value, defaultCount) {
  if (value === undefined || value === null || value === '') {
    if (defaultCount === undefined) return { ok: true, value: undefined };
    return parseCount(defaultCount);
  }
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    return { ok: false, reason: `count must be a whole number, got ${JSON.stringify(value)}` };
  }
  if (number < 1 || number > MAX_COUNT) {
    return { ok: false, reason: `count must be between 1 and ${MAX_COUNT}, got ${number}` };
  }
  return { ok: true, value: number };
}

/**
 * Normalize a mining request from any entry point.
 *
 * @param {object} spec
 *   - `blocks`: string (comma list allowed) or string[] - the raw request;
 *   - `count`: explicit count (strictly validated when present);
 *   - `params`: extra skill parameters copied through when whitelisted.
 * @param {object} [options]
 *   - `resolver(name)`: knowledge confirmation for non-vanilla ore names;
 *   - `defaultCount`: value applied only when the request names no count at all
 *     (command/do_task default 8; omitted for a direct `mine_ore` call, which keeps its
 *     "scan until budget" meaning).
 *   - `oreOnly`: refuse anything that is not an ore (the `mine_ore` skill boundary).
 * @returns {{ok:true, kind:'ore'|'material', blocks:string[], count:number|undefined, params:object}
 *          | {ok:false, failure:'bad_argument', reason:string}}
 */
function normalizeMiningRequest(spec, options = {}) {
  const source = spec || {};
  const rawList = Array.isArray(source.blocks) ? source.blocks : [source.blocks];
  const tokens = rawList
    .flatMap((entry) => String(entry == null ? '' : entry).split(','))
    .map((entry) => cleanName(entry))
    .filter(Boolean);
  if (!tokens.length) {
    return { ok: false, failure: 'bad_argument', reason: 'no mining target given' };
  }

  const blocks = [];
  for (const token of tokens) {
    for (const name of expandTarget(token)) {
      if (!blocks.includes(name)) blocks.push(name);
    }
  }
  if (!blocks.length) {
    return { ok: false, failure: 'bad_argument', reason: 'no mining target given' };
  }

  const kinds = new Map();
  for (const name of blocks) {
    const kind = classifyTarget(name, options.resolver);
    if (kind === 'unknown') {
      return {
        ok: false,
        failure: 'bad_argument',
        reason: `unknown mining target "${name}" - not a confirmed ore or material`
      };
    }
    kinds.set(name, kind);
  }

  const anyOre = [...kinds.values()].includes('ore');
  const anyMaterial = [...kinds.values()].includes('material');
  if (anyOre && anyMaterial) {
    return {
      ok: false,
      failure: 'bad_argument',
      reason: 'ores and plain materials cannot be mixed in one request - split it'
    };
  }
  if (options.oreOnly && anyMaterial) {
    return {
      ok: false,
      failure: 'bad_argument',
      reason: 'mine_ore only takes ores; plain materials use the ordinary mining task'
    };
  }

  const count = parseCount(source.count, options.defaultCount);
  if (!count.ok) return { ok: false, failure: 'bad_argument', reason: count.reason };

  const params = {};
  for (const key of PASSTHROUGH_PARAMS) {
    if (source.params && source.params[key] !== undefined) params[key] = source.params[key];
  }

  return {
    ok: true,
    kind: anyOre ? 'ore' : 'material',
    blocks,
    count: count.value,
    params
  };
}

/**
 * Normalize the `mine_ore` skill's own `ore` / `block` parameters.
 *
 * The skill boundary runs this so a direct `do_skill("mine_ore")` or `run-skill.js`
 * invocation cannot bypass the alias/variant rules. `ore` and `block` may both be given
 * when they agree after normalization; disagreeing values are a bad_argument instead of
 * silently preferring one.
 *
 * @param {{ore?:string, block?:string}} raw
 * @param {object} [options] {resolver}
 * @returns {{ok:true, blocks:string[]} | {ok:false, reason:string}}
 */
function normalizeOreParams(raw, options = {}) {
  const ore = cleanName(raw && raw.ore);
  const block = cleanName(raw && raw.block);
  if (ore && block) {
    const a = expandTarget(ore).sort().join(',');
    const b = expandTarget(block).sort().join(',');
    if (a !== b) {
      return { ok: false, reason: `ore "${raw.ore}" and block "${raw.block}" disagree` };
    }
  }
  const chosen = ore || block || 'iron_ore';
  const normalized = normalizeMiningRequest({ blocks: chosen }, { resolver: options.resolver, oreOnly: true });
  if (!normalized.ok) {
    return { ok: false, reason: normalized.reason };
  }
  return { ok: true, blocks: normalized.blocks };
}

/**
 * Does a world block name satisfy one of the normalized targets?
 *
 * Exact set membership on the normalized names; bare targets match vanilla names only,
 * namespaced targets must match the full name (no end-anchored regex that would make
 * `diamond_ore` swallow a modded `foo:diamond_ore`).
 */
function targetMatches(worldName, targets) {
  const raw = String(worldName == null ? '' : worldName).toLowerCase();
  const bareName = cleanName(raw);
  const set = targets instanceof Set ? targets : new Set(targets || []);
  if (set.has(raw)) return true;
  const modded = namespaceOf(raw) && namespaceOf(raw) !== 'minecraft';
  if (modded) return false;
  return set.has(bareName);
}

module.exports = {
  OVERWORLD_ORE_VARIANTS,
  SINGLE_ORES,
  ORE_BLOCKS,
  TARGET_ALIASES,
  MAX_COUNT,
  cleanName,
  namespaceOf,
  expandTarget,
  expandBlockNames,
  classifyTarget,
  resolverFromCtx,
  parseCount,
  normalizeMiningRequest,
  normalizeOreParams,
  targetMatches
};
