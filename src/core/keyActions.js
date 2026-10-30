'use strict';

/**
 * The controlled key vocabulary shared by the Node input ledger, `mc_capabilities` and the
 * command help. The client mod owns the authoritative KeyMapping table; this list must stay a
 * subset of it, never a free-form key injector.
 *
 * `R` and other mod keybindings (Immersive Aircraft dismount, etc.) are deliberately absent:
 * they are registered by mods outside `Options`, and this channel only exposes a small,
 * auditable set of vanilla KeyMappings. If a task needs one, the action brain must say the
 * key is unavailable instead of asking the player to guess.
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

const MOD_KEY_NOTE =
  'mod keybindings are not exposed (including Immersive Aircraft R/dismount); ' +
  'only vanilla KeyMapping actions are available';

const EDGE_SET = new Set(EDGE_KEYS);
const HELD_SET = new Set(HELD_KEYS);

function isEdgeKey(name) {
  return EDGE_SET.has(String(name || '').trim().toLowerCase());
}

function isHeldKey(name) {
  return HELD_SET.has(String(name || '').trim().toLowerCase());
}

module.exports = {
  HELD_KEYS,
  EDGE_KEYS,
  ALL_KEY_ACTIONS,
  MOD_KEY_NOTE,
  isEdgeKey,
  isHeldKey
};
