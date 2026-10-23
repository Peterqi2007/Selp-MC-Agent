'use strict';

/**
 * Persistent chat-memory recorder (P1 M6/A17).
 *
 * Rule: **every player chat line that is not a `!` command is written to ChatMemory**.
 * That includes `@`/dialogue lines and unaddressed ordinary chat; server notices never
 * reach this module because ChatListener only calls it after parsing a `<player>` sender.
 *
 * Deliberate exclusions:
 *   - `!` commands (prefix configurable, default `!`): they are operations, not conversation;
 *   - the agent's own account: its lines are either the agent speaking or the operator
 *     typing on the shared client, and writing them as player messages would corrupt the
 *     memory (the 15-line live window uses a separate, verified-send path for our replies).
 *
 * `ChatMemory.saveTurn` without a reply stores a user entry only; that is enough here.
 * LanguageDialogue later attaches the assistant reply through `ChatMemory.attachReply`
 * when it is active, so the player line is not duplicated.
 */

function cleanMessage(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Senders that some servers render like players but are not people. */
const NON_PLAYER_SENDERS = new Set(['server', 'system', 'console', 'unknown']);

/**
 * @param {object|null} chatMemory ChatMemory instance (needs saveTurn)
 * @param {object} input { from, text, prefix, ownName }
 * @returns {{ok:boolean, reason?:string}}
 */
function recordPlayerMessage(chatMemory, { from = null, text = '', prefix = '!', ownName = '' } = {}) {
  const clean = cleanMessage(text);
  if (!clean) return { ok: false, reason: 'empty' };

  const commandPrefix = String(prefix || '');
  if (commandPrefix && clean.startsWith(commandPrefix)) return { ok: false, reason: 'command' };

  if (!from) return { ok: false, reason: 'no-sender' };
  const sender = String(from);
  if (NON_PLAYER_SENDERS.has(sender.toLowerCase())) return { ok: false, reason: 'not-player' };
  if (ownName && sender.toLowerCase() === String(ownName).toLowerCase()) {
    return { ok: false, reason: 'self' };
  }

  if (!chatMemory || typeof chatMemory.saveTurn !== 'function') {
    return { ok: false, reason: 'no-chat-memory' };
  }

  chatMemory.saveTurn({ text: clean, speaker: from || null });
  return { ok: true };
}

module.exports = { recordPlayerMessage };
