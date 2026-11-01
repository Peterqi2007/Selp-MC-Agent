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
  crafting: {
    flag: 'supportsCrafting',
    label: 'crafting',
    /**
     * The real client has no recipe database (`supportsCrafting=false`) but DOES expose the
     * open menu + slot clicks, which is all the registered `craft` skill needs. Reading only
     * the flag made A05 report "cannot craft" while `!craft` worked (live 2026-10-18).
     */
    menu: true,
    reason: 'this body has neither a recipe database nor a crafting menu'
  },
  deposit: {
    label: 'chest storage',
    /**
     * 2026-10-21: the `deposit` skill goes through the open-menu + slot-click path, and the
     * old mineflayer `bot.openContainer` task was removed in the store/deposit unification.
     * `supportsDeposit` is therefore no longer read here: a body either has the menu API or
     * it reports storage as unsupported (the mineflayer body is the latter now).
     */
    menu: true,
    reason: 'this body has no container menu (storage needs menu/clickSlot)'
  },
  hunting: { flag: 'supportsHunting', label: 'hunting', reason: 'this body cannot see or fight animals' },
  /**
   * Fully autonomous mode needs two body verbs the older contract did not have:
   * right-clicking an entity (Corpse mod looting) and leaving the death screen. A body that
   * lacks them says so here instead of failing later with a generic "no effect".
   */
  corpseRecovery: { method: 'useEntity', label: 'looting a corpse', reason: 'this body cannot right-click an entity' },
  respawn: { method: 'respawn', label: 'respawning', reason: 'this body cannot leave the death screen' },
  light: { host: 'mineflayer', label: 'placing torches', reason: 'this body has no mineflayer instance' },
  shelter: { host: 'mineflayer', label: 'building a shelter', reason: 'this body has no mineflayer instance' }
};

/** A body that can open a menu and click slots can craft through the registered skill. */
function menuCapable(body) {
  return !!(body && typeof body.menu === 'function' && typeof body.clickSlot === 'function');
}

/**
 * @param {object} ctx agent context
 * @returns {Record<string, {name:string, supported:boolean, reason:string|null}>}
 */
function capabilities(ctx) {
  const body = ctx && ctx.body;
  const hasBot = !!(ctx && ctx.controller && ctx.controller.bot);
  const table = {};
  for (const [name, spec] of Object.entries(SPECS)) {
    const byFlag = spec.flag ? !!(body && body[spec.flag]) : false;
    const byMenu = spec.menu === true && menuCapable(body);
    /** A named body method is the most direct answer there is ("can it right-click an entity"). */
    const byMethod = spec.method ? !!(body && typeof body[spec.method] === 'function') : false;
    /**
     * `menu` is a first-class capability (not just a fallback of `flag`): deposit has no
     * flag any more, and crafting wants the menu path even when the body lacks a recipe DB.
     */
    const supported = byMenu
      ? true
      : spec.method
        ? byMethod
        : spec.flag
          ? byFlag
          : spec.host === 'mineflayer'
            ? hasBot
            : false;
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
