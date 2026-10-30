'use strict';

/**
 * The self-defense reflex is a Node-side fast-loop behaviour: when `behaviour.autoFight` is
 * on and a hostile is close (or the agent is wounded / was just hit), the reflex can preempt
 * the current task and attack on its own. The action brain must know this for two reasons:
 *
 *   1. It must not attribute those attacks to its own command (or think a task "moved" by
 *      itself for no reason).
 *   2. When a task is preempted by combat, the honest explanation is "reflex", not a silent
 *      failure of the model's plan.
 *
 * The value below is deliberately derived from the same config the fast loop reads; it is a
 * status field, not a second source of truth. `engaging` is filled by the Brain when available
 * so the action brain can distinguish "enabled" from "currently fighting".
 */

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function behaviourOf(cfg) {
  if (!cfg) return {};
  return (
    (cfg.agent && cfg.agent.behaviour) ||
    (cfg.behaviour && cfg.behaviour) ||
    {}
  );
}

/**
 * @param {object} cfg full agent config or the agent section
 * @param {object|null} [brain] live Brain, used only for `engaging`
 * @returns {object} JSON-safe status field
 */
function selfDefenseStatus(cfg, brain = null) {
  const b = behaviourOf(cfg);
  /** Same truthiness test as brain.js: `if (wantFight && this.cfg.behaviour.autoFight ...)`. */
  const enabled = b.autoFight === true;
  const engageHealthThreshold = numberOr(b.engageHealthThreshold, 16);
  const engageRadiusXZ = numberOr(b.engageRadiusXZ, 15);
  const engageRadiusY = numberOr(b.engageRadiusY, 4);
  const fleeHealthThreshold = numberOr(b.fleeHealthThreshold, 8);
  return {
    enabled,
    source: 'agent.behaviour.autoFight',
    engaging: !!(brain && brain._reflexFight),
    engageHealthThreshold,
    engageRadiusXZ,
    engageRadiusY,
    fleeHealthThreshold,
    note: enabled
      ? `ON: the self-defense reflex may preempt the current task and attack hostile mobs ` +
        `on its own (radius XZ ${engageRadiusXZ} / Y ±${engageRadiusY}; wounded <= ` +
        `${engageHealthThreshold} or hit this tick). Those attacks are reflex actions, not ` +
        `commands from the action brain.`
      : 'OFF: the self-defense reflex will not attack hostiles on its own; hostiles are ' +
        'only reported, and combat happens only when a task or the action brain asks for it.'
  };
}

/** Short one-line status for request envelopes / goal text; null when disabled. */
function selfDefenseLine(status) {
  if (!status || !status.enabled) return null;
  return (
    `selfDefense: ON (autoFight; reflex may attack hostiles within XZ ` +
    `${status.engageRadiusXZ}/Y ±${status.engageRadiusY} or when wounded, and may preempt ` +
    `the current task; those attacks are not your command)`
  );
}

module.exports = { selfDefenseStatus, selfDefenseLine, behaviourOf };
