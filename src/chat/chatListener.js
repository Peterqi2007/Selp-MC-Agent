'use strict';

/**
 * ChatListener: the in-game chat input channel (P0-PLAN §4.1).
 *
 * The client mod already captures every chat line it receives (`ChatLog.java`, hung off
 * `ClientChatReceivedEvent`) and exposes them at `GET /chatlog?n=`. This class polls that
 * endpoint and turns the lines into agent input. It is the cheapest input channel
 * available: no Java changes, no extra permissions, and it works on any server.
 *
 * Four problems it exists to solve
 * --------------------------------
 * 1. **The line is not the message.** `ChatLog` stores `getMessage().getString()` - the
 *    *rendered* line - so a player message arrives as `<agent> !chop 8` with the server's
 *    own decoration around it. Matching the prefix against the raw line never fires on a real
 *    server; `messageContent()` strips the furniture first. (This was a live-only bug: the
 *    offline tests fed bare `!chop 8`, which is what a mineflayer `chat` event looks like.)
 * 2. **There is no sender field.** On a shared account the bot and the player are the *same
 *    name*, so text cannot be attributed. The design turns this into a feature: only content
 *    starting with the configured prefix (`!`) is a command, and the bot never starts a
 *    sentence with `!` (enforced on the output side in reply.js).
 * 3. **Echo.** The bot's own replies arrive through the same log. Every outgoing line is
 *    fingerprinted into `said`, and matching incoming lines are dropped.
 * 4. **Replays.** `GET /chatlog` re-delivers the same tail on every poll. `newLines()` finds
 *    the overlap with the previous batch, so each line is acted on exactly once - and, unlike
 *    fingerprint dedupe, the *same command sent twice still works*.
 */

const { fingerprint } = require('./reply');
const { Logger } = require('../util/logger');

/** Minecraft formatting/colour codes (`§a`, `§l`, ...). */
const COLOR_CODE = /\u00A7./g;

/**
 * Leader decorations a server puts in front of the actual message.
 *
 * The mod stores `event.getMessage().getString()` - the *rendered* line - so a player message
 * arrives as `<agent> !chop 8`, not `!chop 8`. Servers and chat plugins add their own
 * furniture on top: rank tags, faction names, vote badges, and on this server an `<name>`
 * prefix. None of that is the message.
 *
 * This is the bug that made the whole in-game input channel dead in production while every
 * unit test passed: the tests fed the listener a bare `!chop 8`, which is what a mineflayer
 * `chat` event delivers, and the client mod delivers something else entirely. Matching the
 * raw line meant `!` and the dialogue trigger never matched on a real server.
 */
const LEADER_PATTERNS = [
  // <Name> message        - vanilla and most plugins
  /^\s*<[^<>]{1,32}>\s*/,
  // [Rank] <Name> message / 【称号】<Name> message
  /^\s*[[【][^\]】]{1,32}[\]】]\s*/,
  // Name » message / Name: message / Name > message
  /^\s*[A-Za-z0-9_]{1,16}\s*(?:»|:|>)\s+/
];

/**
 * Reduce a rendered chat line to the text the player actually wrote.
 *
 * Strips colour codes, a single leading timestamp, and any leading decoration patterns.
 * Deliberately conservative: it removes only *prefix* furniture, never anything inside the
 * message, so a command containing `<` or `[` is left alone.
 *
 * @param {string} line
 * @returns {string}
 */
function messageContent(line) {
  let text = String(line || '').replace(COLOR_CODE, '').trim();

  // A timestamp is common on servers that log chat to the client ("[12:31:02] <A> hi").
  text = text.replace(/^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/, '');

  // Remove decoration repeatedly: "[VIP] <Steve> !chop" needs two passes.
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (const pattern of LEADER_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        text = text.slice(match[0].length).trim();
        changed = true;
      }
    }
    if (!changed) break;
  }
  return text;
}

class ChatListener {
  /**
   * @param {object} body Body with `readChat(n)` (ClientModBody)
   * @param {object} ctx agent context
   * @param {object} [options] { prefix, intervalMs, window, onCommand }
   */
  constructor(body, ctx, options = {}) {
    this.body = body;
    this.ctx = ctx;
    this.log = options.log || new Logger('chat');
    this.prefix = options.prefix === undefined ? '!' : options.prefix;
    this.intervalMs = options.intervalMs || 700;
    /** How many lines to fetch per poll; matches the mod's 50-line ring buffer cap. */
    this.window = options.window || 25;
    /** Fingerprints of lines we sent, so we can drop our own echo. */
    this.said = [];
    /**
     * The previous poll's batch, used to work out which lines are new.
     *
     * `null` means "nothing seen yet": the first poll adopts the current window as the
     * baseline without acting on it, so chat from before the agent started is not executed.
     */
    this.lastBatch = null;
    /** How many lines the first poll seeded (reported in `describe()`). */
    this.seeded = 0;
    /**
     * Natural-language channel (P0-PLAN §4.1.2). the dialogue trigger goes to the LLM while
     * `!chop 8` goes to the command table. Kept as a separate test so a bug in one channel
     * cannot silently disable the other - the plan requires both to work regardless of
     * whether the LLM is available. Dedupe is shared: `newLines()` already guarantees each
     * line is seen once.
     */
    this.dialogueTrigger = options.dialogueTrigger || null;
    /**
     * Addressed channel (P1 M2): when set, lines starting with this prefix are routed through
     * a binary gate before the command table. Default null = channel disabled, so the
     * existing `!`/dialogue behaviour is unchanged.
     */
    this.addressedPrefix = options.addressedPrefix || null;
    this.onAddressed = null;
    this.onDialogue = null;
    /** Plain player chat (not `!`/dialogue/addressed), for A11 edge wake. */
    this.onOther = null;
    /** Every non-command line, for the panel and for prompt history. */
    this.heard = [];
    /** Last few accepted commands, for the control panel ("did it hear me?"). */
    this.recent = [];
    this.timer = null;
    this.running = false;
    this.stats = { polls: 0, lines: 0, commands: 0, dialogues: 0, addressed: 0, echoes: 0, ignored: 0, errors: 0 };
  }

  /** Fingerprint a line the same way the filter does, for `noteOwnSpeech`. */
  noteOwnSpeech(text) {
    const fp = fingerprint(text);
    if (!fp) return;
    this.said.push(fp);
    if (this.said.length > 10) this.said.shift();
  }

  start() {
    if (this.running) return;
    if (!this.body || typeof this.body.readChat !== 'function') {
      this.log.warn('chat listener not started: this body cannot read chat');
      return;
    }
    this.running = true;
    this.timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs);
    this.log.info(`chat listener online (prefix "${this.prefix}", every ${this.intervalMs}ms)`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Which lines in this batch are genuinely new?
   *
   * The mod serves a 50-line ring buffer, so every poll re-delivers the tail. The obvious
   * dedupe - remember a fingerprint per line and skip repeats - has a fatal flaw: the *same
   * command sent twice* has the same fingerprint, and because the first copy is still inside
   * the window, the second one is dropped. Typing `!status` twice simply never worked.
   *
   * The mod's `count` cannot help either: it is the current buffer size, capped at 50, not a
   * monotonic sequence (the plan lists a `GET /chatlog?since=<seq>` endpoint as the P1 fix).
   *
   * So compare batches instead. The new batch normally contains the previous one as a prefix,
   * so the largest overlap tells us exactly where the new lines start. Two identical commands
   * are then handled correctly: the batch has one more occurrence than the previous batch, so
   * exactly one new line is processed.
   *
   * @param {string[]} batch the lines the mod returned this poll
   * @returns {string[]} the lines to act on
   */
  newLines(batch) {
    // First poll: adopt the window as the baseline and act on none of it. Chat that was on
    // screen before the agent started is history, and executing a stale `!chop 8` minutes
    // later would be a surprise, not a feature.
    if (this.lastBatch === null) {
      this.seeded = batch.length;
      return [];
    }

    const previous = this.lastBatch;
    if (!batch.length) return [];

    // Largest k where the tail of `previous` equals the head of `batch`.
    let overlap = 0;
    const max = Math.min(previous.length, batch.length);
    for (let k = max; k > 0; k -= 1) {
      let same = true;
      for (let i = 0; i < k; i += 1) {
        if (previous[previous.length - k + i] !== batch[i]) {
          same = false;
          break;
        }
      }
      if (same) {
        overlap = k;
        break;
      }
    }

    if (overlap > 0) return batch.slice(overlap);

    /**
     * The buffer shrank, so it was cleared rather than rotated.
     *
     * A ring buffer only ever grows to its cap and then stays there, so a *smaller* batch can
     * only mean someone called `/chatlog/clear`. Treating the whole batch as new is correct -
     * and necessary, because otherwise a line identical to one from before the clear (the
     * obvious case: a test types the same probe command twice) is mistaken for a replay and
     * silently dropped.
     */
    if (batch.length < previous.length) return batch;

    /**
     * Otherwise the window rotated past this batch. Fall back to "anything not in the previous
     * batch", which is right whenever the two do not interleave - and cannot loop, because it
     * is applied once.
     */
    const previousSet = new Set(previous);
    return batch.filter((line) => !previousSet.has(line));
  }

  /** One poll. Never throws: a chat outage must not take the agent down. */
  async poll() {
    this.stats.polls += 1;
    let res;
    try {
      res = await this.body.readChat(this.window);
    } catch (err) {
      this.stats.errors += 1;
      this.log.debug(`chatlog read failed: ${err.message}`);
      return [];
    }

    const batch = ((res && res.lines) || []).map((line) => String(line || ''));
    this.stats.lines += batch.length;
    const fresh = this.newLines(batch);
    const handled = [];
    const dialogues = [];
    const addressed = [];

    for (const line of fresh) {
      const text = line.trim();
      if (!text) continue;
      const fp = fingerprint(text);
      /**
       * The message *content*, with the server's decoration removed.
       *
       * Everything below matches on this, not on the raw line: a real server renders a player
       * message as `<agent> !chop 8`, so both the trigger check and the echo check are
       * comparing against furniture if they use `text`.
       */
      const content = messageContent(text);

      /**
       * Every line, before any filtering, goes to whoever else needs to see raw chat.
       *
       * AuthMe lives here: its prompts and its "chat unavailable before login" refusals are
       * not commands and not dialogue, but they are the only evidence that the agent is
       * unauthenticated. Hooking in before the filters means the login watcher sees them
       * even though the command and dialogue channels correctly ignore them.
       */
      if (typeof this.onAnyLine === 'function') {
        try {
          this.onAnyLine(text);
        } catch (err) {
          this.log.debug(`onAnyLine hook failed: ${err.message}`);
        }
      }

      /**
       * Our own reply coming back around.
       *
       * Compared on the *content* as well as the raw line: our reply arrives as
       * `<agent> <what we said>`, so a raw-line comparison never matches on a real server
       * and the guard is dead exactly where it is needed. It matters because the reply could
       * otherwise start with the trigger (the model echoing the player) and send the agent into a
       * conversation with itself.
       */
      if (this.said.includes(fp) || this.said.includes(fingerprint(content))) {
        this.stats.echoes += 1;
        continue;
      }

      // ---- channel B: natural language ----------------------------------
      // `content` (computed above) already has the sender prefix and colour codes stripped.
      if (this.dialogueTrigger && content.startsWith(this.dialogueTrigger)) {
        const utterance = content.slice(this.dialogueTrigger.length).trim();
        this.heard.push({ at: new Date().toISOString(), line: text, utterance, kind: 'dialogue' });
        if (this.heard.length > 20) this.heard.shift();
        if (utterance && this.onDialogue) {
          this.stats.dialogues += 1;
          this.log.info(`dialogue: ${text}`);
          dialogues.push({ utterance, line: text });
        } else if (!utterance) {
          this.stats.ignored += 1;
        }
        continue;
      }

      // ---- channel A0: addressed instructions (`@...`) -------------------
      if (this.addressedPrefix && content.startsWith(this.addressedPrefix)) {
        const utterance = content.slice(this.addressedPrefix.length).trim();
        if (utterance) {
          addressed.push({ utterance, line: text });
          this.stats.addressed += 1;
          this.heard.push({ at: new Date().toISOString(), line: text, kind: 'addressed' });
          if (this.heard.length > 20) this.heard.shift();
        } else {
          this.stats.ignored += 1;
        }
        continue;
      }

      // ---- channel A: the deterministic prefix ---------------------------
      if (!this.prefix || !content.startsWith(this.prefix)) {
        this.heard.push({ at: new Date().toISOString(), line: text, kind: 'other' });
        if (this.heard.length > 20) this.heard.shift();
        this.stats.ignored += 1;
        if (this.onOther) {
          try {
            await this.onOther(text);
          } catch (err) {
            this.log.debug(`other-chat hook failed: ${err.message}`);
          }
        }
        continue;
      }

      const command = content.slice(this.prefix.length).trim();
      if (!command) continue;
      this.stats.commands += 1;
      const entry = { at: new Date().toISOString(), source: 'chat', line: text, command };
      this.recent.push(entry);
      if (this.recent.length > 10) this.recent.shift();
      this.log.info(`chat command: ${text}`);
      handled.push(command);
    }

    this.lastBatch = batch;

    for (const command of handled) {
      try {
        await this.ctx.chat.handle(command, 'chat');
      } catch (err) {
        this.log.error(`chat command failed: ${err.message}`);
        if (this.ctx.reply) await this.ctx.reply(`出错了: ${err.message}`).catch(() => {});
      }
    }

    for (const item of addressed) {
      if (!this.onAddressed) continue;
      try {
        await this.onAddressed(item.utterance, item.line);
      } catch (err) {
        this.log.error(`addressed handling failed: ${err.message}`);
      }
    }

    for (const item of dialogues) {
      try {
        await this.onDialogue(item.utterance, item.line);
      } catch (err) {
        this.log.error(`dialogue handling failed: ${err.message}`);
        if (this.ctx.reply) await this.ctx.reply('我这边出错了').catch(() => {});
      }
    }

    return handled;
  }

  describe() {
    return {
      running: this.running,
      prefix: this.prefix,
      dialogueTrigger: this.dialogueTrigger,
      intervalMs: this.intervalMs,
      ...this.stats,
      recent: this.recent.slice(-5)
    };
  }
}

module.exports = { ChatListener, messageContent };
