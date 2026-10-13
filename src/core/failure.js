'use strict';

/**
 * Failure taxonomy: one vocabulary for "why did that not work".
 *
 * Borrowed from numen's `FailureType` (docs/architecture-mind-model.md §六, core/FailureType.java)
 * and trimmed to what this agent can actually act on. Two kinds, and the difference decides
 * who gets to react:
 *
 *   - **in-skill**: another way to reach the same goal is worth trying inside the skill
 *     (`no_path`, `out_of_reach`, `occluded`, `hazard`); a recovery ladder may branch on it;
 *   - **kick-back**: the goal cannot be met without a decision the skill must not make
 *     (`no_material`, `wrong_tool`, `target_lost`, `refused`); it goes back to the LLM/operator
 *     with a hint instead of being retried in place.
 *
 * The classifier is deliberately a pure function over the strings the body, the navigator and
 * the skills already produce, so no behaviour changes until a caller starts branching on the
 * type. `fold(result)` attaches `{failure, hint}` to a failed result in one place.
 */

const FAILURE = Object.freeze({
  BAD_ARGUMENT: 'bad_argument',
  NO_PATH: 'no_path',
  OUT_OF_REACH: 'out_of_reach',
  OCCLUDED: 'occluded',
  HAZARD: 'hazard',
  NO_MATERIAL: 'no_material',
  WRONG_TOOL: 'wrong_tool',
  TARGET_LOST: 'target_lost',
  REFUSED: 'refused',
  UNSUPPORTED: 'unsupported',
  INTERRUPTED: 'interrupted',
  TIMEOUT: 'timeout',
  INTERNAL: 'internal',
  /** Firing-line / TACZ vocabulary (COMBAT-PLAN v3): these codes must survive fold(). */
  STALLED: 'stalled',
  BLOCKED: 'blocked',
  NO_AMMO: 'no_ammo',
  NO_GUN: 'no_gun',
  NOT_A_GUN: 'not_a_gun',
  TACZ_UNAVAILABLE: 'tacz_unavailable',
  IGNORED: 'ignored',
  OUT_OF_RANGE: 'out_of_range',
  SHOOT_FAILED: 'shoot_failed',
  UNKNOWN: 'unknown'
});

/** One copy-able next step per type - what the receipt tells the model (and the log). */
const HINTS = Object.freeze({
  [FAILURE.BAD_ARGUMENT]: 'fix the call (see usage) and retry',
  [FAILURE.NO_PATH]: 'no walkable route: try a nearer target, clear the obstruction, or dig a step',
  [FAILURE.OUT_OF_REACH]: 'move closer to the target, then retry',
  [FAILURE.OCCLUDED]: 'something is in the way (screen, ceiling, wall): clear it or step around',
  [FAILURE.HAZARD]: 'danger present (lava, hostiles, cliff): retreat first, then decide',
  [FAILURE.NO_MATERIAL]: 'get the required item first: craft it, withdraw it, or ask the operator',
  [FAILURE.WRONG_TOOL]: 'equip the right tool (pickaxe tier matters) and retry',
  [FAILURE.TARGET_LOST]: 'scan again - the target moved, despawned, or was already taken',
  [FAILURE.REFUSED]: 'the request was refused or a screen belongs to the operator: wait or ask',
  [FAILURE.UNSUPPORTED]: 'this body cannot do that: pick one of the available alternatives',
  [FAILURE.INTERRUPTED]: 'stopped by stop/death/pause: only continue if the operator asks',
  [FAILURE.TIMEOUT]: 'retry with a smaller job or a longer budget',
  [FAILURE.INTERNAL]: 'an agent bug: report it instead of retrying blindly',
  [FAILURE.STALLED]: 'the fight is a stand-off (no contact for 30s): pick another target, or dig through',
  [FAILURE.BLOCKED]: 'every sight line is covered: flank around, break through, or close in with melee',
  [FAILURE.NO_AMMO]: 'out of rounds: reload, switch to another loaded gun, or fight with melee',
  [FAILURE.NO_GUN]: 'no usable TACZ gun: carry one, or let the melee charge take over',
  [FAILURE.NOT_A_GUN]: 'the held item is not a gun: select one that is',
  [FAILURE.TACZ_UNAVAILABLE]: 'TACZ is not loaded on this client: use melee',
  [FAILURE.IGNORED]: 'that target is on the stand-off cooldown: pick another or wait',
  [FAILURE.OUT_OF_RANGE]: 'close the distance, or pick a longer-range gun',
  [FAILURE.SHOOT_FAILED]: 'read the detail, then retry or switch guns',
  [FAILURE.UNKNOWN]: 'read the detail, then choose a different approach'
});

/** Exact reasons the navigator/walker already use (src/pathfinding/{navigator,walker}.js). */
const MOVE_TYPES = Object.freeze({
  timeout: FAILURE.TIMEOUT,
  blocked: FAILURE.NO_PATH,
  'no-progress': FAILURE.NO_PATH,
  'body-lost': FAILURE.INTERRUPTED,
  'empty-path': FAILURE.NO_PATH,
  'jump-blocked': FAILURE.OCCLUDED,
  noPath: FAILURE.NO_PATH,
  'out-of-grid': FAILURE.NO_PATH,
  'max-iterations': FAILURE.NO_PATH,
  'unknown-block': FAILURE.NO_PATH,
  'screen-open': FAILURE.OCCLUDED,
  'walk-failed': FAILURE.NO_PATH
});

/** `stopped:` codes the skills already return (src/skills/*). */
const STOPPED_TYPES = Object.freeze({
  danger: FAILURE.HAZARD,
  hostile: FAILURE.HAZARD,
  drowned: FAILURE.HAZARD,
  'no-water': FAILURE.TARGET_LOST,
  'no-bed': FAILURE.TARGET_LOST,
  'no-tree': FAILURE.TARGET_LOST,
  'no-target': FAILURE.TARGET_LOST,
  'rod-broken': FAILURE.NO_MATERIAL,
  'rod-worn': FAILURE.NO_MATERIAL,
  'no-pickaxe': FAILURE.WRONG_TOOL,
  'no-path': FAILURE.NO_PATH,
  noPath: FAILURE.NO_PATH,
  timeout: FAILURE.TIMEOUT,
  interrupted: FAILURE.INTERRUPTED,
  refused: FAILURE.REFUSED,
  unsupported: FAILURE.UNSUPPORTED
});

/**
 * Ordered keyword rules for free-text reasons. Order matters: "no pickaxe" is a tool
 * problem before it is a material problem, "could not reach the bed" is a route problem
 * before it is a lost target, and an operator stop is never retried as a path issue.
 */
const RULES = [
  [/cancel|interrupt|暂停|中断|stopped by|was stopped/i, FAILURE.INTERRUPTED],
  [/timed?\s?out|timeout|超时/i, FAILURE.TIMEOUT],
  [/screen|界面|pause menu|esc menu/i, FAILURE.OCCLUDED],
  [/ceiling|overhead|blocked overhead|obstruct|挡|headroom/i, FAILURE.OCCLUDED],
  /**
   * "No hostile nearby" is a missing target, not danger - checked before the hazard rule,
   * which matches the word "hostile" itself (found while planning the live receipt test:
   * the attack skill's honest "no hostile within 24 blocks" came back as `hazard`).
   */
  [/no (hostile|mob|monster|entity|entities|animal)s?\b/i, FAILURE.TARGET_LOST],
  [/lava|fire|magma|hostile|hostiles|danger|悬崖|cliff|drown|溺水/i, FAILURE.HAZARD],
  [/pickaxe|镐|tool|工具/i, FAILURE.WRONG_TOOL],
  [/rod (broke|broken|worn)|no torches|no (food|bread|seed|item|material)|not enough|need (a |an )?(torch|food|item|material)|缺|没有(火把|食物|种子)/i, FAILURE.NO_MATERIAL],
  [/no (water|bed|tree|target|crop|ore|chest|furnace|container)|none found|nothing to|找不到|没有(水|床|树|目标)/i, FAILURE.TARGET_LOST],
  [/refus|denied|forbidden|not allowed|is not available|unavailable|不能|不允许/i, FAILURE.REFUSED],
  [/no body|body is not|not connected|no world (data|snapshot)/i, FAILURE.UNSUPPORTED],
  [/could not walk|cannot walk|no ?path|unreachable|no route|stuck|out-?of-?grid|走不|无路/i, FAILURE.NO_PATH],
  [/out of reach|too far|够不着|reach/i, FAILURE.OUT_OF_REACH],
  [/unknown (parameter|argument|skill|task|block)|missing (parameter|argument)|usage|invalid|must be|needs a name|bad argument/i, FAILURE.BAD_ARGUMENT]
];

/** Classify a free-text reason. Pure; never throws. */
function classify(text) {
  const reason = String(text === undefined || text === null ? '' : text);
  if (!reason) return FAILURE.UNKNOWN;
  for (const [pattern, type] of RULES) {
    if (pattern.test(reason)) return type;
  }
  return FAILURE.UNKNOWN;
}

/** Classify a navigator/walker reason string (`lastMove.reason`). */
function classifyMove(reason) {
  const key = String(reason || '').replace(/^throw:\s*/, '');
  return MOVE_TYPES[key] || classify(key);
}

/**
 * Derive `{failure, hint, detail}` from any failed result shape:
 * `{ok:false, reason}` (skills), `{ok:false, error}` (tools) or `{stopped}`.
 */
function fromResult(result) {
  const record = result || {};
  const detail = record.reason || record.error || record.detail || null;
  let type = record.failure && Object.values(FAILURE).includes(record.failure) ? record.failure : null;
  if (!type && record.stopped && STOPPED_TYPES[record.stopped]) type = STOPPED_TYPES[record.stopped];
  if (!type && record.lastMove && record.lastMove.reason) type = classifyMove(record.lastMove.reason);
  if (!type) type = classify(detail);
  return {
    failure: type,
    hint: record.hint || HINTS[type] || HINTS[FAILURE.UNKNOWN],
    detail
  };
}

/**
 * Attach `{failure, hint}` to a failed result, leaving successful results untouched.
 * This is the single place the skills registry, the actuators and the tool registry call,
 * so every failure that reaches the model carries the same two extra fields.
 */
function fold(result) {
  if (!result || typeof result !== 'object' || result.ok !== false) return result;
  if (result.failure && result.hint) return result;
  const info = fromResult(result);
  return { ...result, failure: info.failure, hint: info.hint };
}

module.exports = { FAILURE, HINTS, MOVE_TYPES, STOPPED_TYPES, classify, classifyMove, fromResult, fold };
