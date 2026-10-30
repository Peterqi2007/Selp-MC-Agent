'use strict';

/**
 * Legacy chat channels that the unified language brain makes inert.
 *
 * Two switches still exist in `config/agent.json` from the P0/M6 era:
 *
 *   `chat.languageAgent`  builds the old LanguageAgent + LanguageDialogue pair;
 *   `chat.participate`    builds M6's ChatParticipation (ordinary-chat reply-or-silence).
 *
 * Both objects are constructed only when `language.brain !== 'unified'` (src/index.js). Under
 * unified, `LanguageBrain` owns every non-`!` player line - addressed lines through its
 * `auto`/approval profiles, ordinary chat through `roleplay` - so neither object is ever
 * created. `docs/P1-M6.md` records the takeover, but the config still advertised the knobs,
 * which made setting them a *silent* no-op: the operator "turns on ordinary chat
 * participation", gets silence, and has no error to look at.
 *
 * Keeping this rule in a pure function (rather than inline in `main()`) means the contract
 * test can assert it without booting an agent, and the START path can refuse instead of
 * pretending.
 */

/** Switch names under `agent.chat` that only work with `language.brain="legacy"`. */
const LEGACY_CHAT_SWITCHES = ['languageAgent', 'participate'];

/**
 * @param {object} chatCfg the merged `agent.chat` config
 * @param {string} languageMode 'unified' | 'legacy'
 * @returns {string[]} switches explicitly set to `true` that cannot take effect
 */
function inertLegacyChatSwitches(chatCfg, languageMode) {
  if (languageMode !== 'unified' || !chatCfg) return [];
  return LEGACY_CHAT_SWITCHES.filter((key) => chatCfg[key] === true);
}

/**
 * The operator-facing explanation, or null when nothing is inert.
 *
 * @param {object} chatCfg
 * @param {string} languageMode
 * @returns {string|null}
 */
function inertLegacyChatMessage(chatCfg, languageMode) {
  const inert = inertLegacyChatSwitches(chatCfg, languageMode);
  if (!inert.length) return null;
  return (
    `chat.${inert.join(' / chat.')} cannot take effect while language.brain=unified: ` +
    'the language brain owns every non-"!" player line (its roleplay profile decides say/silence) ' +
    'and the legacy LanguageDialogue/ChatParticipation objects are never created. ' +
    'Set language.brain="legacy" to use those channels, or set these keys to false. ' +
    'See config/agent.json (chat._comment_languageAgent / chat._comment_participate).'
  );
}

module.exports = { LEGACY_CHAT_SWITCHES, inertLegacyChatSwitches, inertLegacyChatMessage };
