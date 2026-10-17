'use strict';

/**
 * reply: the ONLY way the agent speaks (P0-PLAN §4.3).
 *
 * P0 is strictly reactive - the bot never talks on its own. Not when a task finishes, not
 * when it is hungry, not when it is dying. The user was explicit about this, and the
 * consequence is that this file is tiny and there is no SpeechScheduler to get wrong.
 *
 * The one thing here that is not obvious is `sanitize()`. `ChatLog` records no sender, and
 * the agent's input pipe treats any line starting with `!` (or `/`) as a command. So a
 * reply beginning with `!` would be read back as a *new command from the player*, and
 * `!help` answering with a list starting "!status - ..." would make the bot command itself
 * in a loop. Stripping the leading `!` or `/` on the way out is what closes that loop, and
 * it is the reason replies are sanitised rather than merely truncated.
 */

const { Logger } = require('../util/logger');

const defaultLog = new Logger('reply');

/**
 * Make a string safe to say in chat.
 *
 * @param {string} text
 * @param {object} [options] { maxChars }
 * @returns {string} possibly empty, in which case the caller must not send it
 */
function sanitize(text, options = {}) {
  const maxChars = options.maxChars || 100;
  return String(text === undefined || text === null ? '' : text)
    // Newlines would split one reply into several chat lines and confuse the echo filter.
    .replace(/[\r\n]+/g, ' ')
    // Never lead with ! or / : that would come back as a command (see the header).
    .replace(/^\s*[!/]+/, '')
    // Strip control characters that some models like to emit.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}

/** Content fingerprint used by the echo filter. Collapses whitespace and case. */
function fingerprint(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Say something in game, subject to the `chat` config section.
 *
 * @param {object} ctx agent context (needs cfg, body, chatListener)
 * @param {string} text
 * @param {object} [options] { force, why }
 * @returns {Promise<boolean>} whether anything was actually sent
 */
async function reply(ctx, text, options = {}) {
  const log = (ctx && ctx.log) || defaultLog;
  const policy = (ctx && ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.chat) || {};
  if (!ctx || !ctx.body) return false;

  if (policy.replyInGame === false && !options.force) {
    log.debug(`not replying (replyInGame=false): ${text}`);
    return false;
  }

  let clean = sanitize(text, { maxChars: policy.maxChars || 100 });
  if (!clean) return false;

  /**
   * M6 wiring: only callers that opt in (`options.conversation`) go through the
   * ConversationState guard. Command acks, task follow-ups and forced/proactive lines keep
   * their existing path until the client window proves the new chat rhythm. With the guard
   * off (the default), this block is a no-op and the P0 behaviour is unchanged.
   */
  if (options.conversation && ctx.conversation) {
    const verdict = ctx.conversation.approve({ text: clean, requestId: options.requestId });
    if (!verdict.ok) {
      log.debug(`conversation guard dropped reply (${verdict.reason}): ${clean}`);
      return false;
    }
    clean = verdict.text;
  }

  /**
   * Debounce only *acknowledgements*.
   *
   * The gap exists so that a burst of commands cannot produce a wall of "ok, doing it" lines.
   * It must never swallow an answer the player is waiting for: the LLM's reply and the
   * task-finished follow-up ("chopped 32 logs") arrive right after an ack, and dropping those
   * would leave the player talking to a bot that goes silent exactly when it has news. So the
   * gate is opt-in via `ack`, not a blanket rate limit.
   */
  const gap = policy.minReplyGapMs === undefined ? 1200 : policy.minReplyGapMs;
  const last = ctx._lastReplyAt || 0;
  if (options.ack && !options.force && gap > 0 && Date.now() - last < gap) {
    log.debug(`ack debounced (${Date.now() - last}ms < ${gap}ms): ${clean}`);
    return false;
  }

  // Register the echo BEFORE sending: the poller may read the line back before the
  // promise resolves, and a late registration would let the echo through.
  if (ctx.chatListener && typeof ctx.chatListener.noteOwnSpeech === 'function') {
    ctx.chatListener.noteOwnSpeech(clean);
  }
  ctx._lastReplyAt = Date.now();

  // Remember what we said for the panel, so "did it answer?" is answerable.
  if (!ctx.replies) ctx.replies = [];
  ctx.replies.push({ at: new Date().toISOString(), text: clean, why: options.why || null });
  if (ctx.replies.length > 20) ctx.replies.shift();

  try {
    await ctx.body.chat(clean);
    if (options.conversation && ctx.conversation && typeof ctx.conversation.markSent === 'function') {
      ctx.conversation.markSent(clean);
    }
    log.info(`said: ${clean}`);
    return true;
  } catch (err) {
    log.warn(`could not speak: ${err.message}`);
    return false;
  }
}

module.exports = { reply, sanitize, fingerprint };
