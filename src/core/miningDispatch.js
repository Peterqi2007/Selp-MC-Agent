'use strict';

/**
 * Mining dispatch: validate a mining request once, then choose the one executor.
 *
 * The plan (docs/MINING-LLM-PLAN.md §5.6.2/5.6.3) asks for a module that turns a
 * normalized request into *either*:
 *
 *   - an ore job submitted once into the TaskHub (the `mine_ore` skill), or
 *   - a material descriptor handed back to the caller's existing path (the legacy
 *     `MineBlockTask`, which keeps its proven count/collection semantics).
 *
 * It exists so `commands -> actuators -> commands` cannot grow a cycle and so the six
 * entry points cannot each re-implement "is this an ore?" and "how many?".
 *
 * Dispatch rules that matter:
 *   - ore requests submit to the hub with the caller's captured source; when there is no
 *     hub (unit tests, diagnose runs) they fall back to running the skill inline;
 *   - a material request never masquerades as accepted work - the caller gets the
 *     normalized blocks/count and owns the actual submission;
 *   - nothing here reads `ChatController.dispatchSource`, so a second message arriving
 *     during a long dispatch cannot relabel the first one.
 */

const { fold } = require('./failure');
const { normalizeMiningRequest, resolverFromCtx } = require('./miningRequest');

/**
 * Normalize + dispatch a mining request.
 *
 * @param {object} ctx agent context (needs `hub` for ore jobs; `skills` come from the registry)
 * @param {object} spec { blocks, count, params }
 * @param {object} [options] { source, speaker, defaultCount, description }
 * @returns {Promise<object>} ore: an acceptance receipt ({ok, accepted, async, taskId, kind:'ore',
 *          skill:'mine_ore', blocks, count}) or a refusal; material: a descriptor
 *          ({ok:true, kind:'material', blocks, count, params}) for the caller to submit.
 */
async function dispatchMining(ctx, spec, options = {}) {
  const normalized = normalizeMiningRequest(spec, {
    resolver: resolverFromCtx(ctx),
    defaultCount: options.defaultCount
  });
  if (!normalized.ok) {
    return fold({ ok: false, failure: 'bad_argument', error: normalized.reason, reason: normalized.reason });
  }
  if (normalized.kind === 'material') {
    return { ok: true, kind: 'material', blocks: normalized.blocks, count: normalized.count, params: normalized.params };
  }
  return submitOre(ctx, normalized, options);
}

/**
 * Submit the normalized ore request as one TaskHub job (one body owner, replace-old
 * semantics). Falls back to an inline run when no hub exists.
 */
async function submitOre(ctx, normalized, options = {}) {
  const params = { block: normalized.blocks.join(',') };
  if (normalized.count !== undefined) params.count = normalized.count;
  Object.assign(params, normalized.params);
  const description = options.description || `mine ${normalized.blocks.join('/')}${normalized.count ? ` x${normalized.count}` : ''}`;

  if (!ctx || !ctx.hub || typeof ctx.hub.submit !== 'function') {
    const skills = require('../skills');
    const result = await skills.run('mine_ore', ctx || {}, params);
    return {
      ok: result.ok !== false,
      accepted: result.ok !== false,
      async: false,
      taskId: null,
      kind: 'ore',
      skill: 'mine_ore',
      blocks: normalized.blocks,
      count: normalized.count,
      result,
      reason: result.reason || null
    };
  }

  const receipt = await ctx.hub.submit({
    name: 'mine_ore',
    description,
    source: options.source || 'unknown',
    run: () => require('../skills').run('mine_ore', ctx, params)
  });
  return { ...receipt, kind: 'ore', skill: 'mine_ore', blocks: normalized.blocks, count: normalized.count };
}

/**
 * Run a mining request inline, under a task the caller already owns.
 *
 * This is the internal contract for the autonomous brain and `ctx.mine`: they hold the
 * TaskHub/Brain slot already, so submitting another job would fight their own task for
 * the body. Ore -> the `mine_ore` skill; material -> the legacy `MineBlockTask`.
 *
 * @param {object} ctx
 * @param {object} spec { blocks, count, params }
 * @returns {Promise<object>} the executor's result (not an acceptance receipt)
 */
async function runMiningInline(ctx, spec) {
  const normalized = normalizeMiningRequest(spec, { resolver: resolverFromCtx(ctx) });
  if (!normalized.ok) {
    return fold({ ok: false, failure: 'bad_argument', reason: normalized.reason });
  }
  if (normalized.kind === 'ore') {
    const params = { block: normalized.blocks.join(',') };
    if (normalized.count !== undefined) params.count = normalized.count;
    Object.assign(params, normalized.params);
    return require('../skills').run('mine_ore', ctx, params);
  }
  const { MineBlockTask } = require('../tasks/mineBlock');
  const task = new MineBlockTask(ctx, {
    block: normalized.blocks,
    count: normalized.count,
    ...normalized.params
  });
  return task.execute();
}

/**
 * Classify a spec without dispatching - for routers that only produce an action
 * descriptor (the fallback router) or map free text onto a task (applyGoal).
 */
function classifyMining(spec, ctx) {
  return normalizeMiningRequest(spec, { resolver: resolverFromCtx(ctx) });
}

module.exports = { dispatchMining, runMiningInline, classifyMining };
