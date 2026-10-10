'use strict';

/**
 * Actuators: the only side-effecting tools (P0-PLAN §5.3).
 *
 * Everything in this file ends up in the same command table the `!` channel uses, which is the
 * point: `do_task('chop')` and `!chop 8` must not be two implementations that can drift apart,
 * and a guard added to one must apply to the other. The actuator layer is therefore a thin,
 * validated adapter - not a second way to act.
 *
 * `source: 'llm'` travels with every dispatch so the brain can tell the LLM's work from the
 * planner's own, which is what makes the bounded "tell me when you're done" follow-up possible.
 */

const { bare } = require('../../world/safety');
const skills = require('../../skills');
const { fold } = require('../../core/failure');
const { dispatchMining } = require('../../core/miningDispatch');
const { ctxWithSignal } = require('../../core/taskHub');

/** Task names the model may request, matching the intent enum in src/llm/intent.js. */
const TASK_NAMES = ['chop', 'mine', 'collect'];
/** Upper bound on how much one request may ask for; beyond it the reply is a refusal. */
const MAX_COUNT = 256;
/**
 * Skills whose duration depends on the world (walking, waiting, digging) - numen's
 * "unbounded" half of the dispatch rule. They are accepted into the background task slot and
 * report via a `task_finished` event; instant skills (equip/eat/drop/armor/place/use_on)
 * still run inline because the answer is the action itself.
 */
const LONG_SKILLS = new Set([
  'mine_ore',
  'fish',
  'farm',
  'sleep',
  'explore',
  'come',
  'withdraw',
  'deposit',
  'craft',
  'smelt',
  'attack',
  'defend'
]);

/**
 * Start a gathering task.
 *
 * @param {object} ctx
 * @param {object} args { task, args: { count, block } }
 * @param {object} [options] { source, speaker }
 */
async function doTask(ctx, args, options = {}) {
  const task = String(args.task || '').trim();
  if (!TASK_NAMES.includes(task)) {
    return fold({
      ok: false,
      error: `unknown task "${task}" - available: ${TASK_NAMES.join(', ')}`,
      failure: 'bad_argument'
    });
  }
  const inner = args.args || {};
  const count = inner.count === undefined ? undefined : Number(inner.count);
  if (count !== undefined && (!Number.isFinite(count) || count <= 0 || count > MAX_COUNT)) {
    return fold({ ok: false, error: `count must be between 1 and ${MAX_COUNT}`, failure: 'bad_argument' });
  }

  let line;
  if (task === 'chop') {
    line = `chop ${count || 8}`;
  } else if (task === 'collect') {
    line = 'collect';
  } else {
    /**
     * Mining goes through the shared dispatcher, with the full target array preserved
     * (plan §5.6.1: the old code took `blocks[0]` and silently dropped the rest). Ores
     * submit `mine_ore` once; materials come back as a normalized descriptor and keep
     * the command-table path.
     */
    const blocks = (inner.block || []).map((b) => bare(b)).filter(Boolean);
    if (!blocks.length) return fold({ ok: false, error: 'mine needs at least one block name', failure: 'bad_argument' });
    const dispatched = await dispatchMining(ctx, { blocks, count }, { source: options.source || 'llm', speaker: options.speaker, defaultCount: 8 });
    if (!dispatched.ok) return fold({ ok: false, error: dispatched.reason || dispatched.error || 'mine refused', failure: 'bad_argument' });
    if (dispatched.kind === 'ore') return { ...dispatched, task };
    line = `mine ${dispatched.blocks.join(',')} ${dispatched.count}`;
  }

  return dispatch(ctx, line, options, { task });
}

/**
 * Walk to a coordinate.
 *
 * The plan marks landmark lookup as P1, so this takes explicit numbers only.
 */
async function goTo(ctx, args, options = {}) {
  const coords = ['x', 'y', 'z'].map((axis) => Number(args[axis]));
  if (coords.some((n) => !Number.isFinite(n))) {
    return fold({ ok: false, error: 'x, y and z must be numbers', failure: 'bad_argument' });
  }
  // The world border; beyond it there is nothing to walk to and the request is nonsense.
  if (coords.some((n) => Math.abs(n) > 30000000)) {
    return fold({ ok: false, error: 'coordinates are outside the world border', failure: 'bad_argument' });
  }
  return dispatch(ctx, `goto ${Math.round(coords[0])} ${Math.round(coords[1])} ${Math.round(coords[2])}`, options, {
    kind: 'go_to'
  });
}

/** Stop everything: the same URGENT path the panel's emergency stop uses. */
async function stop(ctx, args, options = {}) {
  return dispatch(ctx, 'stop', options, { kind: 'stop' });
}

/**
 * `do_skill`: run one named entry of the skill catalogue.
 *
 * The catalogue (`src/skills`) is the same one the `!` commands drive, so "available to the
 * model" and "available to the player" cannot drift apart. The name is checked against the
 * live registry and the parameters against the skill's own schema; both refusals are
 * reported as failed calls, never as silent successes.
 */
async function doSkill(ctx, args, options = {}) {
  const name = String((args && (args.name || args.skill)) || '').trim();
  if (!name) return fold({ ok: false, error: 'do_skill needs a name', failure: 'bad_argument' });
  const skill = skills.get(name);
  if (!skill) {
    return fold({
      ok: false,
      error: `unknown skill "${name}" - available: ${skills.names().join(', ')}`,
      failure: 'bad_argument'
    });
  }
  const gate = skill.available ? skill.available(ctx) : { ok: true };
  if (gate && gate.ok === false) {
    return fold({
      ok: false,
      error: gate.reason || `${name} is unavailable on this body`,
      failure: 'unsupported'
    });
  }
  const params = (args && args.params) || {};

  /**
   * Long skills go through the task slot: accepted now, finished later, reported as a
   * `task_finished` event into the same pipeline the brain's own tasks use. A new task
   * replaces the running one (TaskHub), which is what makes "change of mind" work while a
   * ten-minute job is in flight.
   */
  if (ctx.hub && LONG_SKILLS.has(name)) {
    const receipt = await ctx.hub.submit({
      name,
      description: `skill ${name}`,
      source: options.source || 'llm',
      /**
       * The task's cancellation token travels into the skill as `ctx.taskSignal`; the
       * scoped wrapper leaves the shared context untouched for other callers.
       */
      run: (signal) => skills.run(name, ctxWithSignal(ctx, signal), params)
    });
    return { ...receipt, skill: name };
  }

  const result = await skills.run(name, ctx, params);
  return result.ok
    ? { ok: true, skill: name, detail: result.detail || result.reason || null, result }
    : { ...fold({ ok: false, error: result.reason || `${name} failed`, failure: result.failure }), skill: name };
}

/**
 * Hand a validated line to the shared command table.
 *
 * Kept private so nothing outside this file can dispatch an unvalidated string.
 */
async function dispatch(ctx, line, options, extra) {
  const chat = ctx.chat;
  if (!chat) return fold({ ok: false, error: 'no command table available', failure: 'internal' });

  const started = Date.now();
  try {
    const result = await chat.handle(line, options.speaker || 'llm', { source: 'llm' });
    return {
      ok: true,
      dispatched: line,
      accepted: result && result.result ? result.result.accepted !== false : true,
      detail: result && result.result ? result.result : null,
      ms: Date.now() - started,
      ...extra
    };
  } catch (err) {
    return { ...fold({ ok: false, error: err.message, failure: 'internal' }), dispatched: line };
  }
}

module.exports = { doTask, goTo, stop, doSkill, TASK_NAMES, MAX_COUNT, LONG_SKILLS };
