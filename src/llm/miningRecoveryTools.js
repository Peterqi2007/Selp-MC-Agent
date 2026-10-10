'use strict';

/**
 * Recovery-only block tools: the private registry the LLM may call *inside* a mining
 * recovery session (docs/MINING-LLM-PLAN.md §5.1).
 *
 * Boundaries that matter:
 *   - not part of the public eight-tool catalogue: without a live recovery context
 *     (recoveryId + taskId + goalId) every call is refused (§R28);
 *   - tools execute through the session's controlled primitives, which reuse the same
 *     admission (4.5-block reach, permissions, ledger, cancellation) as the macro -
 *     nothing here submits a TaskHub job or calls `do_skill`;
 *   - `dig_cells` may never destroy the locked target (`mine_block` owns that) and never
 *     "accidentally" eats another ore of the task set during clearing;
 *   - batches are validated statically before the first step: sizes, enums, unique ids,
 *     base-action budgeting (dig_cells counts per cell, collect_target counts its one move).
 */

const { validate } = require('./tools/registry');

const PURPOSES = [
  'clear_next_step',
  'clear_next_jump',
  'reach_ore_stand',
  'reach_pickup_stand',
  'support_next_step',
  'mine_target',
  'collect_target'
];

const EXPECTED_TYPES = [
  'cells_passable',
  'at_safe_stand',
  'grounded_one_block_higher',
  'support_present',
  'target_mined',
  'acquisition_checked'
];

const CELL = {
  type: 'object',
  properties: {
    x: { type: 'integer' },
    y: { type: 'integer' },
    z: { type: 'integer' }
  },
  required: ['x', 'y', 'z'],
  additionalProperties: false
};

/** Tool schemas (the same validator the public registry uses; unknown keys rejected). */
const TOOLS = [
  {
    name: 'mine_block',
    description: 'Mine the locked target ore once. The coordinates come from the goal record; the Node validates tool/reach/permission and reports mined + acquisition status separately.',
    parameters: {
      type: 'object',
      properties: { goalId: { type: 'string' } },
      required: ['goalId'],
      additionalProperties: false
    }
  },
  {
    name: 'dig_cells',
    description: 'Clear 1..3 cells, in order, with no hidden movement or retry. Never the locked target and never another ore of the task set.',
    parameters: {
      type: 'object',
      properties: { cells: { type: 'array', items: CELL, minItems: 1, maxItems: 3 } },
      required: ['cells'],
      additionalProperties: false
    }
  },
  {
    name: 'move_to_cell',
    description: 'Walk to one local safe stand (each axis at most 4 cells from the current feet). Local timeout; returns the actual landing position.',
    parameters: {
      type: 'object',
      properties: { stand: CELL },
      required: ['stand'],
      additionalProperties: false
    }
  },
  {
    name: 'pillar_up',
    description: 'Rise exactly one cell by placing the held support block under the feet. The headroom must already be clear; this never digs anything itself.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'place_block',
    description: 'Place one support block against a legal reference face. Item, reach, collision, support and permissions are validated and the world re-checked afterwards.',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string' },
        reference: CELL,
        face: { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'] }
      },
      required: ['item', 'reference', 'face'],
      additionalProperties: false
    }
  },
  {
    name: 'collect_target',
    description: 'Run one bounded pickup attempt for the locked goal through the shared collector. No hidden digging, no climbing, no model call.',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string' },
        standId: { type: 'string' }
      },
      required: ['goalId'],
      additionalProperties: false
    }
  }
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Base actions a step costs (plan §5.7: dig_cells counts per attempted cell). */
function baseActionCount(tool, args) {
  if (tool === 'dig_cells') return Math.max(1, (args.cells || []).length);
  return 1; // mine_block / move_to_cell / pillar_up / place_block / collect_target
}

function toolNames() {
  return TOOLS.map((t) => t.name);
}

/**
 * Validate one step's shape (tool known, args pass the schema, enums legal).
 *
 * @returns {{ok:true, step:object, actions:number} | {ok:false, reason:string}}
 */
function validateStep(step) {
  if (!step || typeof step !== 'object') return { ok: false, reason: 'a step must be an object' };
  const tool = String(step.tool || '');
  const spec = BY_NAME.get(tool);
  if (!spec) return { ok: false, reason: `unknown recovery tool "${tool}"` };
  const verdict = validate(spec.parameters, step.args || {});
  if (!verdict.ok) return { ok: false, reason: `${tool}: ${verdict.reason}` };
  if (step.purpose !== undefined && !PURPOSES.includes(step.purpose)) {
    return { ok: false, reason: `unknown purpose "${step.purpose}"` };
  }
  const expectedType = step.expected && step.expected.type;
  if (expectedType !== undefined && !EXPECTED_TYPES.includes(expectedType)) {
    return { ok: false, reason: `unknown expected.type "${expectedType}"` };
  }
  return {
    ok: true,
    step: { id: step.id || null, tool, args: verdict.value, purpose: step.purpose || null, expected: step.expected || null },
    actions: baseActionCount(tool, verdict.value)
  };
}

/**
 * Validate a whole batch before anything runs.
 *
 * @param {Array<object>} steps
 * @param {object} [options] { maxActions }
 * @returns {{ok:true, steps:Array, actions:number} | {ok:false, reason:string}}
 */
function validateBatch(steps, options = {}) {
  const maxActions = options.maxActions || 3;
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, reason: 'the batch needs at least one step' };
  if (steps.length > maxActions) {
    return { ok: false, reason: `too many steps: ${steps.length} > ${maxActions}` };
  }
  const ids = new Set();
  const validated = [];
  let actions = 0;
  for (const step of steps) {
    const verdict = validateStep(step);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    if (verdict.step.id) {
      if (ids.has(verdict.step.id)) return { ok: false, reason: `duplicate step id "${verdict.step.id}"` };
      ids.add(verdict.step.id);
    }
    actions += verdict.actions;
    validated.push(verdict.step);
  }
  if (actions > maxActions) {
    return { ok: false, reason: `the batch would spend ${actions} base actions (limit ${maxActions})` };
  }
  return { ok: true, steps: validated, actions };
}

function cellKey(cell) {
  return `${cell.x},${cell.y},${cell.z}`;
}

function sameCell(a, b) {
  return !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
}

const FACE_VECTORS = {
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 }
};

/**
 * Bind the tool registry to one live recovery session.
 *
 * Session interface the executors rely on (all provided by MiningRecoverySession):
 *   recoveryId, taskId, goal, signal, cfg
 *   refresh() -> snapshot|null            full valid read
 *   feetOf(snapshot) -> cell
 *   read(snapshot, cell) -> bare name
 *   passable(name) -> bool
 *   protectedName(name) -> bool           any task ore (never a clearing target)
 *   digCell(cell) -> {ok, reason?, failure?}
 *   takeTarget() -> {ok, dug?, failure?, reason?}
 *   pillarOne({timeoutMs}) -> {ok, steps, reason?}
 *   moveLocal(stand, {timeoutMs}) -> {ok, position?, reason?}
 *   placeBlock(item, reference, face) -> {ok, reason?}
 *   pickScaffold(snapshot) -> item|null
 *   acquisitionState() -> {mined:boolean, verified:boolean, collectedItems:number, pendingDrops:number}
 *   collectOnce({standId}) -> CollectionResult (shared collector, recovery mode)
 *   budget {spend(n) -> {ok, reason?}}
 *   trace(entry)
 */
function createRecoveryTools(session) {
  const executedIds = new Set();

  const contextError = () => {
    if (!session || !session.recoveryId || !session.taskId || !session.goal) {
      return { ok: false, failure: 'bad_argument', reason: 'no active recovery context - these tools only work inside a running recovery session' };
    }
    if (executedIds.size > 512) executedIds.clear();
    if (session.signal && session.signal.cancelled) {
      return { ok: false, failure: 'interrupted', reason: session.signal.reason || 'cancelled' };
    }
    return null;
  };
  const spend = (n) => {
    if (!session.budget || typeof session.budget.spend !== 'function') {
      return { ok: false, reason: 'the recovery budget is unavailable' };
    }
    return session.budget.spend(n);
  };

  async function mineBlock(args) {
    if (args.goalId !== session.goal.goalId) {
      return { ok: false, failure: 'bad_argument', reason: `goalId ${args.goalId} is not the locked goal ${session.goal.goalId}` };
    }
    if (session.goal.mined.confirmed) {
      return { ok: false, failure: 'repeat_rejected', reason: 'the locked target is already mined - work on collection instead' };
    }
    const budget = spend(1);
    if (!budget.ok) return { ok: false, failure: 'budget', reason: budget.reason };
    const take = await session.takeTarget();
    if (take && take.ok && take.dug) {
      const acquisition = session.acquisitionState();
      return {
        ok: true,
        mined: true,
        acquisition,
        note: acquisition.verified ? 'product already in the bag' : 'dig confirmed; collection is a separate step'
      };
    }
    return {
      ok: false,
      failure: (take && take.failure) || 'no_path',
      reason: (take && take.reason) || 'the target dig did not happen'
    };
  }

  async function digCells(args) {
    const cells = args.cells || [];
    const maxCells = (session.cfg && session.cfg.maxCellsPerDig) || 3;
    if (cells.length > maxCells) {
      return { ok: false, failure: 'bad_argument', reason: `at most ${maxCells} cells per dig_cells call` };
    }
    const did = [];
    const skipped = [];
    const notExecuted = [];
    let failed = null;
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (sameCell(cell, session.goal.target.position)) {
        for (let j = i; j < cells.length; j += 1) notExecuted.push({ ...cells[j] });
        return {
          ok: false,
          failure: 'bad_argument',
          reason: 'the locked target goes through mine_block(goalId), not dig_cells',
          did,
          skipped,
          failed: { cell: { ...cell }, reason: 'locked target' },
          notExecuted
        };
      }
      const snapshot = await session.refresh();
      if (!snapshot) return { ok: false, failure: 'internal', reason: 'no valid world state', did, skipped, failed, notExecuted: cells.slice(i) };
      const name = session.read(snapshot, cell);
      if (session.passable(name)) {
        skipped.push({ ...cell }); // already air: no progress, no charge beyond the batch check
        continue;
      }
      if (session.protectedName(name)) {
        for (let j = i + 1; j < cells.length; j += 1) notExecuted.push({ ...cells[j] });
        return {
          ok: false,
          failure: 'protected_ore',
          reason: `${name} at ${cellKey(cell)} is another task ore and must not be cleared`,
          did,
          skipped,
          failed: { cell: { ...cell }, block: name },
          notExecuted
        };
      }
      const budget = spend(1);
      if (!budget.ok) {
        for (let j = i; j < cells.length; j += 1) notExecuted.push({ ...cells[j] });
        return { ok: false, failure: 'budget', reason: budget.reason, did, skipped, failed: null, notExecuted };
      }
      const dug = await session.digCell(cell);
      if (!dug || !dug.ok) {
        for (let j = i + 1; j < cells.length; j += 1) notExecuted.push({ ...cells[j] });
        return {
          ok: false,
          failure: (dug && dug.failure) || 'occluded',
          reason: (dug && dug.reason) || `could not clear ${cellKey(cell)}`,
          did,
          skipped,
          failed: { cell: { ...cell }, block: name },
          notExecuted
        };
      }
      const after = await session.refresh();
      const now = after ? session.read(after, cell) : name;
      if (!session.passable(now)) {
        for (let j = i + 1; j < cells.length; j += 1) notExecuted.push({ ...cells[j] });
        return {
          ok: false,
          failure: 'occluded',
          reason: `${now} is still at ${cellKey(cell)} after digging it`,
          did,
          skipped,
          failed: { cell: { ...cell }, block: now },
          notExecuted
        };
      }
      did.push({ ...cell });
    }
    return { ok: true, did, skipped, failed, notExecuted };
  }

  async function moveToCell(args) {
    const snapshot = await session.refresh();
    if (!snapshot) return { ok: false, failure: 'internal', reason: 'no valid world state' };
    const feet = session.feetOf(snapshot);
    const stand = args.stand;
    if (!feet) return { ok: false, failure: 'internal', reason: 'no player position' };
    for (const axis of ['x', 'y', 'z']) {
      if (Math.abs(stand[axis] - feet[axis]) > 4) {
        return { ok: false, failure: 'bad_argument', reason: `the stand is more than 4 cells away on ${axis}` };
      }
    }
    if (sameCell(stand, feet)) return { ok: true, stand: { ...feet }, note: 'already there' };
    const body = session.read(snapshot, stand);
    const head = session.read(snapshot, { x: stand.x, y: stand.y + 1, z: stand.z });
    if (!session.passable(body) || !session.passable(head)) {
      return { ok: false, failure: 'occluded', reason: `the stand ${cellKey(stand)} is not passable yet` };
    }
    const budget = spend(1);
    if (!budget.ok) return { ok: false, failure: 'budget', reason: budget.reason };
    const moved = await session.moveLocal(stand, { timeoutMs: 8000 });
    const after = await session.refresh();
    const actual = after ? session.feetOf(after) : null;
    if (!moved || !moved.ok || !actual || Math.abs(actual.x - stand.x) > 1 || Math.abs(actual.z - stand.z) > 1 || Math.abs(actual.y - stand.y) > 1) {
      return {
        ok: false,
        failure: (moved && moved.failure) || 'no_path',
        reason: (moved && moved.reason) || `did not arrive at ${cellKey(stand)}`,
        position: actual
      };
    }
    return { ok: true, stand: { ...actual } };
  }

  async function pillarUp() {
    const snapshot = await session.refresh();
    if (!snapshot) return { ok: false, failure: 'internal', reason: 'no valid world state' };
    const feet = session.feetOf(snapshot);
    if (!feet) return { ok: false, failure: 'internal', reason: 'no player position' };
    const low = { x: feet.x, y: feet.y + 2, z: feet.z };
    const high = { x: feet.x, y: feet.y + 3, z: feet.z };
    const blocked = [];
    for (const cell of [low, high]) {
      const name = session.read(snapshot, cell);
      if (!session.passable(name)) blocked.push({ cell, block: name });
    }
    if (blocked.length) {
      return {
        ok: false,
        failure: 'occluded',
        reason: 'clear the headroom first with dig_cells',
        blocked
      };
    }
    if (!session.pickScaffold(snapshot)) {
      return { ok: false, failure: 'no_material', reason: 'no support block in the inventory' };
    }
    const budget = spend(1);
    if (!budget.ok) return { ok: false, failure: 'budget', reason: budget.reason };
    const hop = await session.pillarOne({ timeoutMs: 8000 });
    const after = await session.refresh();
    const nowFeet = after ? session.feetOf(after) : null;
    if (!hop || !hop.ok || !nowFeet || nowFeet.x !== feet.x || nowFeet.z !== feet.z || nowFeet.y !== feet.y + 1) {
      return {
        ok: false,
        failure: (hop && hop.failure) || 'no_path',
        reason: (hop && hop.reason) || 'the hop did not rise exactly one cell',
        feet: nowFeet
      };
    }
    return { ok: true, risen: 1, placedCell: { ...feet } };
  }

  async function placeBlock(args) {
    const snapshot = await session.refresh();
    if (!snapshot) return { ok: false, failure: 'internal', reason: 'no valid world state' };
    const feet = session.feetOf(snapshot);
    const reference = args.reference;
    const face = FACE_VECTORS[args.face];
    if (!feet || !face) return { ok: false, failure: 'bad_argument', reason: 'a legal reference and face are required' };
    const reach = Math.hypot(reference.x - feet.x, reference.y - (feet.y + 0.5), reference.z - feet.z);
    if (reach > 4.5) return { ok: false, failure: 'out_of_reach', reason: `the reference is ${reach.toFixed(1)} blocks away` };
    const placeAt = { x: reference.x + face.x, y: reference.y + face.y, z: reference.z + face.z };
    const targetName = session.read(snapshot, placeAt);
    if (!session.passable(targetName)) {
      return { ok: false, failure: 'occluded', reason: `${cellKey(placeAt)} is already ${targetName}` };
    }
    const budget = spend(1);
    if (!budget.ok) return { ok: false, failure: 'budget', reason: budget.reason };
    const placed = await session.placeBlock(args.item, reference, face);
    if (!placed || !placed.ok) {
      return { ok: false, failure: (placed && placed.failure) || 'refused', reason: (placed && placed.reason) || 'the placement was refused' };
    }
    const after = await session.refresh();
    const now = after ? session.read(after, placeAt) : 'minecraft:air';
    const wanted = String(args.item).replace(/^[a-z0-9_]+:/, '');
    if (String(now).replace(/^[a-z0-9_]+:/, '') !== wanted) {
      return { ok: false, failure: 'internal', reason: `the world shows ${now} at ${cellKey(placeAt)} after placing ${args.item}` };
    }
    return { ok: true, placedAt: placeAt };
  }

  async function collectTarget(args) {
    if (args.goalId !== session.goal.goalId) {
      return { ok: false, failure: 'bad_argument', reason: `goalId ${args.goalId} is not the locked goal` };
    }
    const budget = spend(1);
    if (!budget.ok) return { ok: false, failure: 'budget', reason: budget.reason };
    const collected = await session.collectOnce({ standId: args.standId || null });
    return {
      ok: collected.outcome === 'verified',
      outcome: collected.outcome,
      collectedDelta: collected.collectedDelta || 0,
      pendingDrops: (collected.pendingDrops || []).map((d) => ({ name: d.name, count: d.count, position: d.position })),
      reason: collected.reason || null,
      failure: collected.failure || null
    };
  }

  const EXECUTORS = {
    mine_block: mineBlock,
    dig_cells: digCells,
    move_to_cell: moveToCell,
    pillar_up: pillarUp,
    place_block: placeBlock,
    collect_target: collectTarget
  };

  /**
   * Run one validated step. Duplicate step ids are refused before any world touch
   * (replayed batches must never re-dig or re-place - plan §5.3.2).
   */
  async function call(name, rawArgs, options = {}) {
    const invalid = contextError();
    if (invalid) return invalid;
    const verdict = validateStep({ id: options.stepId, tool: name, args: rawArgs });
    if (!verdict.ok) return { ok: false, failure: 'bad_argument', reason: verdict.reason };
    if (options.stepId) {
      if (executedIds.has(options.stepId)) {
        return { ok: false, failure: 'repeat_rejected', reason: `step ${options.stepId} was already executed` };
      }
      executedIds.add(options.stepId);
    }
    const started = Date.now();
    let result;
    try {
      result = await EXECUTORS[name](verdict.step.args);
    } catch (err) {
      result = { ok: false, failure: 'internal', reason: `${name} threw: ${err.message}` };
    }
    if (session.trace) {
      session.trace({ kind: 'recovery-action', recoveryId: session.recoveryId, tool: name, args: rawArgs, ok: result.ok !== false, failure: result.failure || null, ms: Date.now() - started });
    }
    return result;
  }

  return {
    names: toolNames(),
    call,
    validateStep,
    validateBatch,
    describe: () =>
      TOOLS.map((t) => {
        const required = t.parameters.required || [];
        const optional = Object.keys(t.parameters.properties || {}).filter((k) => !required.includes(k));
        return `  ${t.name}(${[...required, ...optional.map((k) => `${k}?`)].join(', ')}) - ${t.description}`;
      }).join('\n')
  };
}

module.exports = { TOOLS, PURPOSES, EXPECTED_TYPES, toolNames, validateStep, validateBatch, createRecoveryTools, baseActionCount, BY_NAME };
