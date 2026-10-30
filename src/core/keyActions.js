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

module.exports = {
  HELD_KEYS,
  EDGE_KEYS,
  ALL_KEY_ACTIONS,
  MOD_KEY_NOTE,
  isEdgeKey,
  isHeldKey,
  isModKeyId
};
