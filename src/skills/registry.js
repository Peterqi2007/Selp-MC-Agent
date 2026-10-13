'use strict';

/**
 * The skill registry: one catalogue of everything the agent can *do*, with a declaration
 * of what each skill needs and whether the current body can run it.
 *
 * This follows the shape both reference projects converged on (mindcraft's `skills.js`
 * library + mc_aiplayer's registered tool list): the model (or the `!` channel) picks a
 * *named* skill with *validated* parameters, and a deterministic routine executes it. No
 * free-form code, no unvalidated strings - the name and the parameter schema are the
 * capability boundary.
 *
 * A skill is:
 *
 *   {
 *     name:        'eat',                       // unique id, lowercase snake_case
 *     title:       '吃东西',                     // human label (panel / help)
 *     description: 'Eat the best food carried',  // one line for logs and the LLM
 *     params:      { food: { type: 'string' } }, // validated, defaults applied
 *     available:   (ctx) => ({ ok, reason }),    // per-body gate (honest when false)
 *     run:         async (ctx, params) => ({ ok, detail })
 *   }
 */

const skills = new Map();

const { fold } = require('../core/failure');
const combatState = require('../world/combatState');

/**
 * Combat skills hold a cross-module lease while they execute (see combatState's header
 * note). The fast-loop reflex reads it and refuses to start a second fight - the `!`
 * channel and the LLM actuator run skills straight through this registry and bypass the
 * task hub, so the hub-based guard alone never saw them (live 2026-10-13: an explicit
 * `!shoot` and a reflex shoot replaced each other's bursts until both failed).
 */
const COMBAT_SKILLS = new Set(['attack', 'defend', 'shoot']);

function register(skill) {
  if (!skill || !skill.name || typeof skill.run !== 'function') {
    throw new Error('a skill needs a name and a run()');
  }
  if (!/^[a-z][a-z0-9_]*$/.test(skill.name)) {
    throw new Error(`skill name "${skill.name}" must be lowercase snake_case`);
  }
  if (skills.has(skill.name)) {
    throw new Error(`skill "${skill.name}" is already registered`);
  }
  skills.set(skill.name, {
    title: skill.name,
    description: '',
    params: {},
    beta: false,
    available: () => ({ ok: true }),
    ...skill
  });
  return skill.name;
}

function get(name) {
  return skills.get(name) || null;
}

function all() {
  return [...skills.values()];
}

/** Names only, sorted - handy for help text and assertions. */
function names() {
  return [...skills.keys()].sort();
}

/**
 * Validate raw parameters against the skill's schema.
 *
 * Deliberately strict: unknown parameters are refused rather than ignored, because a typo
 * that silently changes nothing looks exactly like a bug in the skill.
 */
function validate(skill, raw) {
  const params = raw || {};
  const known = new Set(Object.keys(skill.params || {}));
  for (const key of Object.keys(params)) {
    if (!known.has(key)) return { ok: false, error: `unknown parameter "${key}" for ${skill.name}` };
  }
  const out = {};
  for (const [key, spec] of Object.entries(skill.params || {})) {
    let value = params[key];
    if (value === undefined || value === null || value === '') {
      if (spec.required) return { ok: false, error: `missing parameter "${key}"` };
      if (spec.default !== undefined) value = spec.default;
      else continue;
    }
    if (spec.type === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) return { ok: false, error: `"${key}" must be a number` };
    } else if (spec.type === 'string') {
      value = String(value);
    } else if (spec.type === 'boolean') {
      value = value === true || value === 'true' || value === 1 || value === '1';
    }
    if (spec.min !== undefined && value < spec.min) {
      return { ok: false, error: `"${key}" must be >= ${spec.min}` };
    }
    if (spec.max !== undefined && value > spec.max) {
      return { ok: false, error: `"${key}" must be <= ${spec.max}` };
    }
    if (spec.choices && !spec.choices.includes(value)) {
      return { ok: false, error: `"${key}" must be one of ${spec.choices.join(', ')}` };
    }
    out[key] = value;
  }
  return { ok: true, params: out };
}

/**
 * Run a skill by name with raw parameters.
 *
 * @param {string} name
 * @param {object} ctx the same context tasks get (cfg/body/world/log/mods)
 * @param {object} [raw] parameters straight from the caller - validated here, never before
 * @returns {Promise<{ok:boolean, detail?:string, reason?:string, [key:string]:any}>}
 */
async function run(name, ctx, raw) {
  const skill = get(name);
  if (!skill) {
    return fold({
      ok: false,
      reason: `unknown skill "${name}" - have: ${names().join(', ')}`,
      failure: 'bad_argument',
      hint: `use one of: ${names().join(', ')}`
    });
  }

  const validated = validate(skill, raw);
  if (!validated.ok) return fold({ ok: false, reason: validated.error, failure: 'bad_argument' });

  let gate;
  try {
    gate = skill.available(ctx || {}) || { ok: true };
  } catch (err) {
    return fold({
      ok: false,
      reason: `skill ${name} availability check failed: ${err.message}`,
      failure: 'internal'
    });
  }
  if (gate.ok === false) {
    return fold({
      ok: false,
      reason: gate.reason || `${name} is not available on this body`,
      failure: 'unsupported'
    });
  }

  const combatLease = COMBAT_SKILLS.has(name);
  if (combatLease) combatState.beginCombatSkill(name);
  try {
    const result = await skill.run(ctx || {}, validated.params);
    if (!result || typeof result !== 'object') {
      return fold({ ok: false, reason: `${name} returned nothing`, failure: 'internal' });
    }
    return fold({ ok: result.ok !== false, ...result });
  } catch (err) {
    return fold({ ok: false, reason: `${name} failed: ${err.message}`, failure: 'internal' });
  } finally {
    if (combatLease) combatState.endCombatSkill(name);
  }
}

/** Describe every skill against a live context (for the panel, help and prompt tables). */
function describe(ctx) {
  return all().map((skill) => {
    let gate = { ok: true };
    try {
      gate = skill.available(ctx || {}) || { ok: true };
    } catch (err) {
      gate = { ok: false, reason: err.message };
    }
    return {
      name: skill.name,
      title: skill.title,
      description: skill.description,
      beta: skill.beta,
      available: gate.ok !== false,
      reason: gate.reason || null
    };
  });
}

module.exports = { register, get, all, names, run, describe, validate };
