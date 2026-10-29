'use strict';

/**
 * Channel policy - "capability first" (2026-10-29, L2 decision A).
 *
 * The action brain can reach the body through four channels. Before this module existed the
 * choice was implicit: the plugin prompt listed eight hand-written commands, and the new
 * input layer (key/hold/shot) and the code-skill channel were invisible. That is why a real
 * session showed "no reaction" - the model never learned the channels existed.
 *
 * The order below is the policy, not a suggestion list:
 *
 *   1. code-skill       an already promoted generated skill matches -> reuse it
 *   2. command          a registered command-table action covers it (skills live here too)
 *   3. input            only when no skill/command covers it: raw keys / bounded holds / frames
 *   4. code-generation  nothing covers it -> PROPOSE generation (operator-approved, never auto)
 *
 * "Capability first" means the raw input channel is never the default: it is the fallback for
 * things the deterministic layer cannot express (a mod GUI, a key the command table has no
 * verb for). Generation is last and always needs a human-written prompt.
 */

/** Commands that are the raw input layer rather than a semantic skill. */
const INPUT_COMMANDS = Object.freeze(['key', 'hold', 'tap', 'shot', 'inputs']);
const INPUT_SET = new Set(INPUT_COMMANDS);

/** Ordered channels, most deterministic first. */
const CHANNELS = Object.freeze([
  {
    id: 'code-skill',
    order: 1,
    label: 'promoted generated skill',
    when: 'the task is already solved by a promoted code skill (reuse before writing new code)',
    example: 'code-skill mine_iron_pillar',
    requires: 'the skill must be promoted; candidates and trials are operator-only'
  },
  {
    id: 'command',
    order: 2,
    label: 'registered command / deterministic skill',
    when: 'the command table has a verb for the action (chop, mine, craft, farm, goto, sleep, ...)',
    example: 'chop 2',
    requires: null
  },
  {
    id: 'input',
    order: 3,
    label: 'raw input layer (keys / bounded holds / frames)',
    when: 'no skill covers it: a mod GUI, a key the command table has no verb for, or a look-only need',
    example: 'key forward down | hold attack 600 | shot 768',
    requires: 'F1\'b ledger: the press is recorded and released on stop/death/disconnect'
  },
  {
    id: 'code-generation',
    order: 4,
    label: 'generate a new code skill (proposal only)',
    when: 'nothing above covers the action and it will repeat - propose it, do not silently retry',
    example: 'ask the operator: POST /code-skills/generate {"prompt": "..."}',
    requires: 'human-written prompt + trial + promotion; there is NO automatic generation'
  }
]);

function normaliseAction(action) {
  return String(action || '').trim().replace(/^!+/, '').split(/\s+/)[0].toLowerCase();
}

/** Promoted code skills, whatever shape the service reports. */
function promotedSkills(ctx) {
  try {
    const status = ctx && ctx.codeSkills && typeof ctx.codeSkills.status === 'function'
      ? ctx.codeSkills.status()
      : null;
    const promoted = (status && status.promoted) || [];
    return promoted
      .map((entry) => (typeof entry === 'string' ? { name: entry } : entry))
      .filter((entry) => entry && entry.name);
  } catch (err) {
    return [];
  }
}

/** Command-table verbs, from the live controller (never a hardcoded list). */
function commandVerbs(ctx) {
  const chat = ctx && ctx.chat;
  const handlers = chat && chat.handlers;
  return handlers && typeof handlers === 'object' ? Object.keys(handlers).sort() : [];
}

/**
 * Resolve one action name to a channel, capability first.
 *
 * @param {object} ctx agent context
 * @param {string} action command or intent name ("mine", "key", "mine_iron_pillar", ...)
 * @returns {{action:string, channel:string|null, covered:boolean, order:number, reason:string, next:string|null}}
 */
function resolveChannel(ctx, action) {
  const name = normaliseAction(action);
  if (!name) {
    return {
      action: '',
      channel: null,
      covered: false,
      order: null,
      reason: 'no action given - call mc_capabilities for the channel table',
      next: 'mc_capabilities'
    };
  }

  const promoted = promotedSkills(ctx);
  const promotedHit = promoted.find((entry) => String(entry.name).toLowerCase() === name);

  // 1. a promoted code skill that is literally named like the action
  if (promotedHit) {
    return {
      action: name,
      channel: 'code-skill',
      covered: true,
      order: 1,
      reason: `promoted code skill "${promotedHit.name}" matches`,
      next: `code-skill ${promotedHit.name}`
    };
  }

  // 2. the deterministic command table (skills and plain verbs live here)
  const verbs = commandVerbs(ctx);
  if (verbs.includes(name) && !INPUT_SET.has(name)) {
    return {
      action: name,
      channel: 'command',
      covered: true,
      order: 2,
      reason: 'the command table has this verb',
      next: name
    };
  }

  // 3. the raw input layer - only as its own verbs, never as a substitute for a skill
  if (INPUT_SET.has(name)) {
    return {
      action: name,
      channel: 'input',
      covered: true,
      order: 3,
      reason: 'raw input command (used when no skill covers the action)',
      next: name
    };
  }

  // 4. nothing covers it: propose generation, do not improvise
  return {
    action: name,
    channel: 'code-generation',
    covered: false,
    order: 4,
    reason: 'no skill, command or input verb covers this action',
    next: 'propose generation to the operator (human prompt required)'
  };
}

/**
 * The whole table, for `mc_capabilities` and `!capabilities`.
 *
 * Deliberately data-only (no advice prose beyond what the plugin prompt already says), so a
 * model can read it and a test can assert on it.
 */
function describe(ctx) {
  const verbs = commandVerbs(ctx);
  const promoted = promotedSkills(ctx);
  return {
    ok: true,
    policy: 'capability-first',
    order: CHANNELS.map((channel) => channel.id),
    channels: CHANNELS.map((channel) => ({ ...channel })),
    skills: verbs.filter((verb) => !INPUT_SET.has(verb)),
    inputCommands: [...INPUT_COMMANDS],
    codeSkills: {
      promoted: promoted.map((entry) => ({ name: entry.name, version: entry.version || null })),
      generation: 'operator-only: POST /code-skills/generate {"prompt": "..."} (never automatic)'
    }
  };
}

module.exports = {
  CHANNELS,
  INPUT_COMMANDS,
  commandVerbs,
  describe,
  normaliseAction,
  promotedSkills,
  resolveChannel
};
