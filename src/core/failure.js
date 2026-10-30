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
  /** The mod mechanic is unknown (how to place/use this mod item); knowledge, not luck. */
  KNOWLEDGE: 'knowledge',
  /** The receipt claimed success but the world shows no effect (place/useon evidence). */
  UNVERIFIED: 'unverified',
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
  [FAILURE.KNOWLEDGE]: 'the mod mechanic is unknown: lookup_mod_content first, then ask the player',
  [FAILURE.UNVERIFIED]: 'the world shows no effect: do not retry the same spot; lookup or ask first',
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
  /** Settle reasons often carry the stopped code verbatim ("no-tree"); honor that mapping too. */
  if (!type && detail && STOPPED_TYPES[String(detail).trim()]) type = STOPPED_TYPES[String(detail).trim()];
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

/**
 * Failure classes - the escalation ladder branches on the class, not on the reason text.
 *
 *   transient     server lag / a stand-off: re-observe, then one backoff retry;
 *   precondition  missing item/tool/route: fix the prerequisite first (a different action);
 *   knowledge     the mod mechanic is unknown: lookup_mod_content -> ask the player;
 *   unverified    ok receipt but no world effect: same ladder as knowledge, no blind retry;
 *   capability    no verb/key covers it: input layer, else propose code generation;
 *   permission    refused / operator stop / hazard: stop or ask, never auto-retry;
 *   unknown       unclassified: retryable=false; observe or ask, never blind-retry.
 */
const CLASSES = Object.freeze({
  TRANSIENT: 'transient',
  PRECONDITION: 'precondition',
  KNOWLEDGE: 'knowledge',
  UNVERIFIED: 'unverified',
  CAPABILITY: 'capability',
  PERMISSION: 'permission',
  UNKNOWN: 'unknown'
});

/** One class per failure type; the single mapping every surface (gate, envelope, docs) reads. */
const FAILURE_CLASS = Object.freeze({
  [FAILURE.TIMEOUT]: CLASSES.TRANSIENT,
  [FAILURE.STALLED]: CLASSES.TRANSIENT,
  [FAILURE.IGNORED]: CLASSES.TRANSIENT,
  [FAILURE.SHOOT_FAILED]: CLASSES.TRANSIENT,
  [FAILURE.BAD_ARGUMENT]: CLASSES.PRECONDITION,
  [FAILURE.NO_MATERIAL]: CLASSES.PRECONDITION,
  [FAILURE.WRONG_TOOL]: CLASSES.PRECONDITION,
  [FAILURE.NO_PATH]: CLASSES.PRECONDITION,
  [FAILURE.OCCLUDED]: CLASSES.PRECONDITION,
  [FAILURE.TARGET_LOST]: CLASSES.PRECONDITION,
  [FAILURE.OUT_OF_REACH]: CLASSES.PRECONDITION,
  [FAILURE.OUT_OF_RANGE]: CLASSES.PRECONDITION,
  [FAILURE.BLOCKED]: CLASSES.PRECONDITION,
  [FAILURE.NO_AMMO]: CLASSES.PRECONDITION,
  [FAILURE.NO_GUN]: CLASSES.PRECONDITION,
  [FAILURE.NOT_A_GUN]: CLASSES.PRECONDITION,
  [FAILURE.KNOWLEDGE]: CLASSES.KNOWLEDGE,
  [FAILURE.UNVERIFIED]: CLASSES.UNVERIFIED,
  [FAILURE.UNSUPPORTED]: CLASSES.CAPABILITY,
  [FAILURE.TACZ_UNAVAILABLE]: CLASSES.CAPABILITY,
  [FAILURE.REFUSED]: CLASSES.PERMISSION,
  [FAILURE.INTERRUPTED]: CLASSES.PERMISSION,
  [FAILURE.HAZARD]: CLASSES.PERMISSION,
  [FAILURE.INTERNAL]: CLASSES.UNKNOWN,
  [FAILURE.UNKNOWN]: CLASSES.UNKNOWN
});

/**
 * What each class demands next. `blindBudget` is how many same-signature attempts the gate
 * tolerates before refusing; `requires`/`next` are the machine-readable instruction the
 * action brain follows (the goal text says the same thing in prose).
 */
const CLASS_POLICY = Object.freeze({
  [CLASSES.TRANSIENT]: {
    retryable: true, blindBudget: 2,
    requires: ['re-observe'], next: 'reobserve-then-retry-once'
  },
  [CLASSES.PRECONDITION]: {
    retryable: true, blindBudget: 2,
    requires: ['fix-precondition'], next: 'fix-precondition-then-retry'
  },
  [CLASSES.KNOWLEDGE]: {
    retryable: false, blindBudget: 2,
    requires: ['lookup_mod_content'], next: 'lookup-then-ask-then-input'
  },
  [CLASSES.UNVERIFIED]: {
    retryable: false, blindBudget: 2,
    requires: ['lookup_mod_content'], next: 'lookup-then-ask-then-input'
  },
  [CLASSES.CAPABILITY]: {
    retryable: false, blindBudget: 1,
    requires: ['input-layer'], next: 'input-layer-or-propose-codegen'
  },
  [CLASSES.PERMISSION]: {
    retryable: false, blindBudget: 0,
    requires: ['ask-or-stop'], next: 'stop-or-ask'
  },
  [CLASSES.UNKNOWN]: {
    retryable: false, blindBudget: 1,
    requires: ['re-observe'], next: 'observe-or-ask'
  }
});

/** The class of one failure type; unknown types are CLASSES.UNKNOWN (never blind-retried). */
function classOf(type) {
  return FAILURE_CLASS[type] || CLASSES.UNKNOWN;
}

/**
 * The full failure envelope (failure + hint + class policy + escalation context).
 *
 * `fold()` stays the minimal two-field shape its existing callers (tool registry,
 * actuators, mining dispatch) rely on; `envelope()` is the harness-facing shape carried by
 * mc_step receipts, task:failed events and plan step settlements. `context` is what the
 * escalation ledger knows: { verb, target, attempt:{count,budget}, lookupQuery, askQuestion }.
 */
function envelope(result, context = {}) {
  if (!result || typeof result !== 'object' || result.ok !== false) return result;
  const info = result.failure && result.hint ? { failure: result.failure, hint: result.hint, detail: result.reason || result.error || result.detail || null } : fromResult(result);
  const className = result.class || classOf(info.failure);
  const policy = CLASS_POLICY[className] || CLASS_POLICY[CLASSES.UNKNOWN];
  const out = {
    ...result,
    ok: false,
    failure: info.failure,
    hint: info.hint,
    class: className,
    retryable: policy.retryable,
    retryBudget: policy.blindBudget,
    requires: [...policy.requires],
    next: policy.next
  };
  if (context.signature) out.signature = context.signature;
  if (context.verb) out.verb = context.verb;
  if (context.target !== undefined) out.target = context.target;
  if (context.attempt) out.attempt = context.attempt;
  if (context.lookupQuery) out.lookupQuery = context.lookupQuery;
  if (context.askQuestion) out.askQuestion = context.askQuestion;
  if (context.evidence) out.evidence = context.evidence;
  return out;
}

/**
 * One-line class directory for mc_capabilities (generated from the same tables, so the
 * prompt text, the gate and the receipts cannot drift).
 */
function describePolicy() {
  const lines = {};
  for (const className of Object.values(CLASSES)) {
    const policy = CLASS_POLICY[className];
    lines[className] = `${policy.next} (retryable=${policy.retryable}, blindBudget=${policy.blindBudget}, requires=${policy.requires.join('|')})`;
  }
  return {
    classes: Object.values(CLASSES),
    policy: lines,
    realtimeControl:
      'ms-level continuous control (piloting a vehicle, mounted=true, moving steering, aim ' +
      'tracking): do NOT drive it with atomic mc_step key/hold calls - each call is one ' +
      'conversation round (seconds), the input arrives stale, and a first failure can be ' +
      'unrecoverable. Use a promoted code skill or propose generation; the script runs the ' +
      'loop inside Node with ctx.state() + ctx.key/ctx.hold/ctx.tap + ctx.wait(ms).',
    granularity:
      'escalation is per action signature, never a task-level mode: only the failed action ' +
      'moves to the input layer; movement/observation stay on the command channel (goto for ' +
      'walking to the next plot). A success, TTL expiry or goal end clears the record, so ' +
      'the next same-kind action starts capability-first again.'
  };
}

module.exports = {
  FAILURE, HINTS, MOVE_TYPES, STOPPED_TYPES, CLASSES, FAILURE_CLASS, CLASS_POLICY,
  classify, classifyMove, classOf, fromResult, fold, envelope, describePolicy
};
