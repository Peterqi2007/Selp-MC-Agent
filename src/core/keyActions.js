'use strict';

/**
 * The controlled key vocabulary.
 *
 * The static tables below are the vanilla logical names. Mod keybindings are NOT baked in:
 * they are discovered at runtime via `mc_keybinds` and used by their stable namespaced id
 * (`modid:path`). The client mod re-resolves that id against the live `KeyMapping` table on
 * every tap/press, so a rebind changes the key code, not the id.
 *
 * Raw mod key names/codes (including `r`/`dismount`) are still rejected; the agent must ask
 * `mc_keybinds` for the id first.
 */

const HELD_KEYS = Object.freeze([
  'attack',
  'use',
  'forward',
  'back',
  'left',
  'right',
  'jump',
  'sprint',
  'sneak'
]);

/** Edge-triggered vanilla keys: one `KeyMapping.click` on `key <name> down`, no hold. */
const EDGE_KEYS = Object.freeze([
  'inventory',
  'drop',
  'chat',
  'swapoffhand',
  'pickitem',
  'hotbar1',
  'hotbar2',
  'hotbar3',
  'hotbar4',
  'hotbar5',
  'hotbar6',
  'hotbar7',
  'hotbar8',
  'hotbar9'
]);

const ALL_KEY_ACTIONS = Object.freeze([...HELD_KEYS, ...EDGE_KEYS]);

const MOD_KEY_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i;

const MOD_KEY_NOTE =
  'vanilla short names are limited to the listed actions; mod keys must use a stable ' +
  'namespaced id discovered via mc_keybinds (for example immersive_aircraft:dismount), ' +
  'never a raw key name/code such as r';

const EDGE_SET = new Set(EDGE_KEYS);
const HELD_SET = new Set(HELD_KEYS);

function isEdgeKey(name) {
  return EDGE_SET.has(String(name || '').trim().toLowerCase());
}

function isHeldKey(name) {
  return HELD_SET.has(String(name || '').trim().toLowerCase());
}

/** A safe, namespaced KeyMapping id; the client mod remains the final registry check. */
function isModKeyId(name) {
  return MOD_KEY_ID.test(String(name || '').trim());
}

/**
 * The raw-input channel verbs (2026-11-01 unification).
 *
 * One list for three surfaces that used to drift apart: the channel table, the failure
 * ladder's `input-required` rung and the escalation prose. `look`/`lookat` and the container
 * verbs are body-level raw actions too - leaving them out is how the ladder ended up able to
 * name `key` while a real `place` failure never mentioned the layer at all.
 */
const INPUT_VERBS = Object.freeze([
  'key',
  'hold',
  'tap',
  'look',
  'lookat',
  'shot',
  'menu',
  'click',
  'close',
  'select',
  'inputs'
]);

const INPUT_VERB_SET = new Set(INPUT_VERBS);

/**
 * Actions for which "do it with the keyboard/mouse" is a real alternative.
 *
 * Covers command-table verbs and Node task names (a task settle is its own receipt path:
 * the live 2026-11-01 incident was a `deposit` task failure whose receipt only said
 * `lookup_mod_content`, so the fallback never reached the model).
 */
const INPUT_ALTERNATIVE_ACTIONS = Object.freeze([
  // command verbs
  'place', 'useon', 'use', 'useitem', 'attack', 'shoot', 'dig', 'mine', 'tunnel', 'pillar',
  'moveto', 'goto', 'equip', 'select', 'menu', 'click', 'close', 'look', 'lookat', 'drop',
  // task names (src/tasks/*.name)
  'mine_ore', 'gather-wood', 'deposit', 'withdraw', 'craft', 'smelt', 'collect', 'farm',
  'chop', 'fish', 'hunt', 'light', 'shelter', 'follow', 'go-to', 'code_skill', 'eat',
  'armor', 'explore', 'come', 'sleep'
]);

const INPUT_ALTERNATIVE_SET = new Set(INPUT_ALTERNATIVE_ACTIONS);

function isInputVerb(name) {
  return INPUT_VERB_SET.has(String(name || '').trim().toLowerCase());
}

function hasInputAlternative(name) {
  return INPUT_ALTERNATIVE_SET.has(String(name || '').trim().toLowerCase());
}

/** Concrete examples put into refusals so the model has an action, not just a reason. */
const INPUT_EXAMPLES = Object.freeze([
  'look <yaw> <pitch>   (aim at the block/entity first)',
  'key forward down / key forward up',
  'hold attack 600',
  'tap inventory'
]);

module.exports = {
  HELD_KEYS,
  EDGE_KEYS,
  ALL_KEY_ACTIONS,
  MOD_KEY_NOTE,
  INPUT_VERBS,
  INPUT_ALTERNATIVE_ACTIONS,
  INPUT_EXAMPLES,
  isEdgeKey,
  isHeldKey,
  isModKeyId,
  isInputVerb,
  hasInputAlternative
};
