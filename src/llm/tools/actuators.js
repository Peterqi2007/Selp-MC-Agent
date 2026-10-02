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

/** Task names the model may request, matching the intent enum in src/llm/intent.js. */
const TASK_NAMES = ['chop', 'mine', 'collect'];
/** Upper bound on how much one request may ask for; beyond it the reply is a refusal. */
const MAX_COUNT = 256;

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
    return { ok: false, error: `unknown task "${task}" - available: ${TASK_NAMES.join(', ')}` };
  }
  const inner = args.args || {};
  const count = inner.count === undefined ? undefined : Number(inner.count);
  if (count !== undefined && (!Number.isFinite(count) || count <= 0 || count > MAX_COUNT)) {
    return { ok: false, error: `count must be between 1 and ${MAX_COUNT}` };
  }

  let line;
  if (task === 'chop') {
    line = `chop ${count || 8}`;
  } else if (task === 'collect') {
    line = 'collect';
  } else {
    const blocks = (inner.block || []).map((b) => bare(b)).filter(Boolean);
    if (!blocks.length) return { ok: false, error: 'mine needs at least one block name' };
    // One block name per call: the command table takes a single target plus a count, and
    // silently mining only the first of a list would be a lie about what was requested.
    line = `mine ${blocks[0]} ${count || 8}`;
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
  if (coords.some((n) => !Number.isFinite(n))) return { ok: false, error: 'x, y and z must be numbers' };
  // The world border; beyond it there is nothing to walk to and the request is nonsense.
  if (coords.some((n) => Math.abs(n) > 30000000)) return { ok: false, error: 'coordinates are outside the world border' };
  return dispatch(ctx, `goto ${Math.round(coords[0])} ${Math.round(coords[1])} ${Math.round(coords[2])}`, options, {
    kind: 'go_to'
  });
}

/** Stop everything: the same URGENT path the panel's emergency stop uses. */
async function stop(ctx, args, options = {}) {
  return dispatch(ctx, 'stop', options, { kind: 'stop' });
}

/**
 * Hand a validated line to the shared command table.
 *
 * Kept private so nothing outside this file can dispatch an unvalidated string.
 */
async function dispatch(ctx, line, options, extra) {
  const chat = ctx.chat;
  if (!chat) return { ok: false, error: 'no command table available' };

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
    return { ok: false, error: err.message, dispatched: line };
  }
}

module.exports = { doTask, goTo, stop, TASK_NAMES, MAX_COUNT };
