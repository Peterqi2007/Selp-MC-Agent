'use strict';

/**
 * Stopping the DSH action brain (2026-11-01 operator report).
 *
 * `!stop` used to stop Node's own queues and close the autonomous goals, but the action brain
 * kept working: its current model turn kept calling `mc_step`, and a *new* goal could be
 * created by the next player task, so the character kept moving after the operator said stop.
 * Completing a goal only stops *future* goal rounds; only the plugin's `/goal/pause` also
 * cancels the plugin-owned turns and the active plan.
 *
 * This module is the one place that knows the sequence:
 *   pause (brake: cancels turns + plan)  ->  complete (close the goal)
 * and the inverse for an explicit resume (nothing to resume: the next task creates a goal).
 *
 * It is deliberately best-effort: a stop must never throw into the command handler, and every
 * failure is reported so the caller can log it.
 */

const silentLog = { info() {}, warn() {}, debug() {} };

/** The node-side lock that gates the action brain while the operator has stopped it. */
const STOP_HOLD = 'owner-stop';

function hasStopLock(ctx) {
  const holds = ctx && ctx.brain && ctx.brain.holds;
  if (!holds || typeof holds.has !== 'function') return false;
  try {
    return holds.has(STOP_HOLD) === true;
  } catch {
    return false;
  }
}

/** Commands an action brain may still issue while the operator's stop lock is on. */
const ALLOWED_WHILE_STOPPED = new Set([
  'stop',
  'state',
  'status',
  'help',
  'inv',
  'where',
  'capabilities',
  'keybinds',
  'perception',
  'observe'
]);

function allowedWhileStopped(command) {
  return ALLOWED_WHILE_STOPPED.has(String(command || '').trim().toLowerCase());
}

/**
 * Pause the bound agent's goal and close it.
 *
 * @param {object} ctx agent context (needs `harnessBridge`)
 * @param {string} reason short reason for the logs/goal
 * @returns {Promise<{ok:boolean, agentId?:string, goalId?:string, paused?:object, completed?:object, reason?:string}>}
 */
async function stopActionBrain(ctx, reason = '!stop') {
  const log = (ctx && ctx.log) || silentLog;
  const bridge = ctx && ctx.harnessBridge;
  if (!bridge || typeof bridge.boundAgentId !== 'function') return { ok: false, reason: 'no-bridge' };
  let agentId = null;
  try {
    agentId = await bridge.boundAgentId();
  } catch (err) {
    return { ok: false, reason: `agent-lookup-failed: ${err.message}` };
  }
  if (!agentId) return { ok: false, reason: 'no-bound-agent', agentId: null };

  let goal = null;
  try {
    goal = typeof bridge.goalOf === 'function' ? await bridge.goalOf(agentId) : null;
  } catch (err) {
    log.debug(`stopActionBrain: goal lookup failed: ${err.message}`);
  }
  const goalId = goal && goal.id ? String(goal.id) : null;
  const revision = goal && Number.isFinite(Number(goal.revision)) ? Number(goal.revision) : undefined;
  if (!goalId) {
    return { ok: true, agentId, goalId: null, note: 'no-active-goal' };
  }

  let paused = { ok: false, reason: 'not-attempted' };
  if (typeof bridge.pauseGoal === 'function') {
    try {
      paused = await bridge.pauseGoal({ agentId, goalId, revision });
    } catch (err) {
      paused = { ok: false, reason: err.message };
    }
    if (!paused.ok) log.debug(`stopActionBrain: pause failed for ${goalId}: ${paused.reason || paused.error}`);
  }

  let completed = { ok: false, reason: 'not-attempted' };
  if (typeof bridge.completeGoal === 'function') {
    try {
      completed = await bridge.completeGoal({ agentId, goalId, revision });
    } catch (err) {
      completed = { ok: false, reason: err.message };
    }
    if (!completed.ok) log.debug(`stopActionBrain: complete failed for ${goalId}: ${completed.reason || completed.error}`);
  }
  log.info(`action brain ${reason}: goal ${goalId} paused=${paused.ok === true} completed=${completed.ok === true}`);
  return { ok: true, agentId, goalId, paused, completed };
}

/**
 * Clear a leftover paused/active goal before a fresh start (`!autonomous on`, new task).
 *
 * A paused goal blocks the coordinator's prep (`goal:paused`) and makes the plugin think the
 * agent is busy; completing it here keeps "start" meaning "start a new round".
 */
async function clearActionBrainGoal(ctx) {
  const bridge = ctx && ctx.harnessBridge;
  if (!bridge || typeof bridge.boundAgentId !== 'function') return { ok: false, reason: 'no-bridge' };
  let agentId = null;
  try {
    agentId = await bridge.boundAgentId();
  } catch (err) {
    return { ok: false, reason: `agent-lookup-failed: ${err.message}` };
  }
  if (!agentId) return { ok: false, reason: 'no-bound-agent' };
  let goal = null;
  try {
    goal = typeof bridge.goalOf === 'function' ? await bridge.goalOf(agentId) : null;
  } catch (err) {
    return { ok: false, reason: `goal-lookup-failed: ${err.message}` };
  }
  if (!goal || !goal.id || goal.phase === 'complete') return { ok: true, agentId, cleared: false };
  /**
   * Only a **paused** goal is a leftover from a stop. An active goal belongs to whatever is
   * running now (a player task, or a round that legitimately started) and must not be killed
   * just because the operator re-armed the autonomous mode.
   */
  if (goal.phase !== 'paused') return { ok: true, agentId, cleared: false, phase: goal.phase };
  const revision = Number.isFinite(Number(goal.revision)) ? Number(goal.revision) : undefined;
  try {
    const completed = await bridge.completeGoal({ agentId, goalId: goal.id, revision });
    return { ok: completed.ok !== false, agentId, cleared: completed.ok !== false, goalId: goal.id };
  } catch (err) {
    return { ok: false, agentId, reason: err.message };
  }
}

module.exports = {
  STOP_HOLD,
  ALLOWED_WHILE_STOPPED,
  hasStopLock,
  allowedWhileStopped,
  stopActionBrain,
  clearActionBrainGoal
};
