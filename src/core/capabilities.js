'use strict';

/**
 * Capability table - one answer to "can this body do X", separate from "does it have the
 * materials right now" (P1 §1.4.1, A05).
 *
 * Why this exists: the evaluator used to read `ctx.body.supportsCrafting` and friends inline,
 * and each entry point wrote its own checks. That is how "the mod cannot open a crafting UI"
 * and "there are no planks in the inventory" ended up looking the same to the planner, and how
 * a single field silently excluded menu crafting.
 *
 * Two kinds of support:
 *   - **body flags** - the Body contract says the body can do it (`supportsCrafting`, ...);
 *   - **host requirements** - the task drives the mineflayer handle directly (torches,
 *     shelter), so a body without one cannot run it no matter what the inventory says.
 *
 * Current preconditions (materials, tools, permissions, world state) are deliberately NOT
 * answered here: they change between two planning ticks and belong to the executor. The
 * `reason` field says *why it is unsupported*, which is what A05 asks to distinguish.
 */

const SPECS = {
  crafting: { flag: 'supportsCrafting', label: 'crafting', reason: 'this body has no crafting support' },
  deposit: { flag: 'supportsDeposit', label: 'chest storage', reason: 'this body has no container support' },
  hunting: { flag: 'supportsHunting', label: 'hunting', reason: 'this body cannot see or fight animals' },
  light: { host: 'mineflayer', label: 'placing torches', reason: 'this body has no mineflayer instance' },
  shelter: { host: 'mineflayer', label: 'building a shelter', reason: 'this body has no mineflayer instance' }
};

/**
 * @param {object} ctx agent context
 * @returns {Record<string, {name:string, supported:boolean, reason:string|null}>}
 */
function capabilities(ctx) {
  const body = ctx && ctx.body;
  const hasBot = !!(ctx && ctx.controller && ctx.controller.bot);
  const table = {};
  for (const [name, spec] of Object.entries(SPECS)) {
    const supported = spec.flag ? !!(body && body[spec.flag]) : spec.host === 'mineflayer' ? hasBot : false;
    table[name] = { name, supported, reason: supported ? null : spec.reason, label: spec.label };
  }
  return table;
}

/** Convenience for callers that only need the boolean. */
function supports(ctx, name) {
  const table = capabilities(ctx);
  return !!(table[name] && table[name].supported);
}

module.exports = { capabilities, supports, SPECS };
