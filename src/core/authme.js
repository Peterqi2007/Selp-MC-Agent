'use strict';

/**
 * AuthMeLogin: authenticate on an AuthMe-protected server, automatically.
 *
 * `mc.example.com` refuses *everything* before login - movement is frozen, chat is
 * disabled ("§cЧат недоступен до входа!"), commands are refused ("§cКоманды недоступны до
 * входа!"). An agent that starts unauthenticated therefore looks broken in the most
 * confusing possible way: it connects, it perceives, and then nothing it does has any
 * effect. The `bot.authme` config section existed for this but was never read by anything,
 * so this module is what actually consumes it.
 *
 * TWO RULES, both learned the hard way:
 *
 * 1. **`/register` is never sent.** On this server a `/register` for an existing name
 *    RESETS the character - experience and inventory are wiped. Authentication is `/login`
 *    only. `registerOnMissing` in the config is therefore not a switch we may honour by
 *    registering; it exists to be false, and the mod blocks the verb at four other layers.
 *    If the server says the account is not registered, the honest action is to report it.
 *
 * 2. **Never spam `/login`.** AuthMe rate-limits repeated attempts ("§cСлишком много
 *    попыток входа! Подожди §e55§c сек"), and a rate-limited login is indistinguishable
 *    from a wrong password unless you know to look for it. So the module only logs in when
 *    it has *evidence* that it is not authenticated, and otherwise keeps quiet.
 *
 * The evidence comes from the chat log: AuthMe's prompt, its refusal messages, and its
 * success messages are all recognisable, and they are all in Russian on this server (which
 * is why the patterns below are tri-lingual - an English-only check reported a false
 * failure the first time this was tested by hand).
 */

const { Logger } = require('../util/logger');

/**
 * Minecraft colour codes (`§a`, `§c`, ...) sit *inside* the phrases we match on.
 *
 * The real pre-login refusal from `mc.example.com` is
 * `§cКоманды недоступны до входа! Сначала §e/login§c или §e/register§c.` - note the `§e`
 * between "Сначала" and "/login". A pattern like `/Сначала\s*\/?login/` therefore misses it,
 * which is exactly the bug the offline check caught. Stripping the codes before matching is
 * the only approach that survives both colour changes and word order.
 */
const COLOR_CODE = /\u00A7./g;

/** Remove colour/formatting codes so patterns can match plain text. */
function plain(text) {
  return String(text || '').replace(COLOR_CODE, '');
}

/** The server is asking us to authenticate. */
const PROMPT = /\/login\s|请登录|请注册|Авторизац|введите пароль|please log ?in|use \/login/i;
/**
 * The server is refusing an action *because* we are not authenticated.
 *
 * `недоступн\S*` rather than `недоступен`: Russian inflects this word by gender and number,
 * and the server sends "Чат недоступен" (masc. sg.) for chat but "Команды недоступны" (pl.)
 * for commands. Matching only the singular silently ignored half the evidence.
 */
const NOT_AUTHED = /недоступн\S*\s+до\s+входа|Сначала[^!.]{0,16}\/?(login|register)|not logged in|请先登录|登录后才能|you need to log ?in/i;
/** The server accepted the login. */
const SUCCESS = /Вход успешен|Добро пожаловать|Авторизация успешна|выполнен|success(fully)? logged|已登录|登录成功|logged in/i;
/** Already authenticated before we asked. */
const ALREADY = /уже авторизован|already logged|已经登录/i;
/** Rate limited - wait, do not retry harder. */
const RATE_LIMITED = /Слишком много попыток|too many attempts|尝试次数过多/i;
/** No such account. NOT a reason to register (see rule 1). */
const NOT_REGISTERED = /не зарегистрирован|not registered|请先注册|未注册/i;
/** Wrong password. */
const BAD_PASSWORD = /неверный пароль|wrong password|密码错误|incorrect password/i;

class AuthMeLogin {
  /**
   * @param {object} body a Body with `chat`, `command` and `snapshot`
   * @param {object} ctx agent context (needs log)
   * @param {object} options the `bot.authme` config section plus { log }
   */
  constructor(body, ctx, options = {}) {
    this.body = body;
    this.ctx = ctx;
    this.log = options.log || new Logger('authme');
    this.enabled = options.enabled !== false;
    this.password = options.password || null;
    /** Kept for compatibility; registering is never performed (see rule 1 in the header). */
    this.registerOnMissing = false;
    this.timeoutMs = options.timeoutMs || 20000;
    /**
     * How long the startup probe waits for the server's refusal. The chat poller runs
     * every ~700ms and the server answers asynchronously; live 2026-10-17 a fixed 1200ms
     * sleep missed "commands unavailable before login" and the agent wrongly concluded it
     * was authenticated. Poll for evidence instead of sleeping a fixed amount.
     */
    this.probeWaitMs = options.probeWaitMs || 4000;
    /** Wait out ChatListener's first poll before probing (700ms interval + margin). */
    this.probeDelayMs = options.probeDelayMs || 1800;
    /** Minimum gap between two login attempts, to stay clear of the server's limiter. */
    this.cooldownMs = options.cooldownMs || 65000;

    /** Recent chat lines this module has seen, newest last. */
    this.lines = [];
    /** Fingerprints already observed, so a re-served window is not analysed twice. */
    this.seen = new Set();
    this.loggedIn = false;
    this.attempts = 0;
    this.lastAttemptAt = 0;
    this.lastOutcome = null;
    /** Set when the server says the account does not exist - a human must fix that. */
    this.needsRegistration = false;
  }

  get configured() {
    return !!(this.enabled && this.password && this.body);
  }

  /** Feed every chat line here (ChatListener.onAnyLine) so we notice prompts and refusals. */
  observe(line) {
    // Colour codes are stripped first: they sit inside the phrases we match on.
    const text = plain(line).trim();
    if (!text) return;
    const fp = text.toLowerCase();
    if (this.seen.has(fp)) return;
    this.seen.add(fp);
    if (this.seen.size > 300) this.seen.clear();
    this.lines.push(text);
    if (this.lines.length > 40) this.lines.shift();

    if (SUCCESS.test(text) || ALREADY.test(text)) this.loggedIn = true;
    if (NOT_REGISTERED.test(text)) {
      this.needsRegistration = true;
      this.log.warn('the server says this account is NOT registered');
      this.log.warn('refusing to send /register: on this server it RESETS the character');
    }
    if (RATE_LIMITED.test(text)) this.log.warn('AuthMe is rate-limiting login attempts - waiting before any retry');
  }

  /** Look for a reason to believe we are (not) authenticated in what we have seen. */
  evidence() {
    const recent = this.lines.join('\n');
    if (SUCCESS.test(recent) || ALREADY.test(recent)) return 'authenticated';
    if (NOT_REGISTERED.test(recent)) return 'not-registered';
    if (NOT_AUTHED.test(recent)) return 'not-authenticated';
    if (PROMPT.test(recent)) return 'prompted';
    return null;
  }

  /**
   * Ask the server a harmless question whose *refusal* is proof of being logged out.
   *
   * `list` works for every player on every server, needs no permission, and on an AuthMe
   * server a pre-login attempt is answered with the "commands unavailable before login"
   * message - which is exactly the evidence needed. Using a real command beats guessing
   * from a prompt that may have scrolled out of the 50-line chat buffer.
   */
  async probe() {
    /**
     * Let ChatListener finish its first poll first (it "seeds" the existing window without
     * processing it). Sending the probe before that seed means the server's refusal is
     * consumed by the baseline and never reaches `observe()` - live 2026-10-17 that made
     * the agent believe it was already authenticated after a client restart.
     */
    await sleep(this.probeDelayMs);
    const seenBefore = new Set(this.lines);
    try {
      await this.body.command('cmd list');
    } catch (err) {
      this.log.debug(`login probe failed to send: ${err.message}`);
      return null;
    }
    /**
     * Poll instead of a fixed sleep: the chat poller and the server reply are both
     * asynchronous. Return as soon as there is evidence; otherwise wait up to
     * `probeWaitMs` and report "no evidence" (never "authenticated").
     */
    const deadline = Date.now() + this.probeWaitMs;
    while (Date.now() < deadline) {
      await sleep(250);
      const fresh = this.lines.filter((line) => !seenBefore.has(line));
      const text = fresh.join('\n');
      if (NOT_AUTHED.test(text)) return 'not-authenticated';
      if (SUCCESS.test(text) || ALREADY.test(text)) return 'authenticated';
      if (RATE_LIMITED.test(text)) return 'rate-limited';
    }
    return null;
  }

  /**
   * Make sure we are authenticated, logging in only when there is a reason to.
   *
   * @param {string} reason 'startup' | 'respawn' | 'manual'
   * @returns {Promise<{ok:boolean, action:string, reason:string}>}
   */
  async ensure(reason = 'manual') {
    if (!this.configured) {
      return { ok: false, action: 'skip', reason: 'authme is not configured (no password)' };
    }
    if (this.loggedIn) {
      return { ok: true, action: 'skip', reason: 'already authenticated' };
    }
    if (this.needsRegistration) {
      return { ok: false, action: 'refuse', reason: 'the account is not registered; registering would reset the character' };
    }

    // Only act on evidence. Silence is not evidence.
    let verdict = this.evidence();
    if (!verdict) verdict = await this.probe();
    if (verdict === 'authenticated') {
      this.loggedIn = true;
      return { ok: true, action: 'skip', reason: 'the server already considers us authenticated' };
    }
    if (!verdict) {
      // Nothing in the chat log either way. Logging in blindly risks the rate limiter, so
      // report the uncertainty instead of burning an attempt.
      return { ok: false, action: 'skip', reason: 'no evidence of being logged out (no prompt or refusal seen)' };
    }
    if (verdict === 'not-registered') {
      this.needsRegistration = true;
      return { ok: false, action: 'refuse', reason: 'the account is not registered; registering would reset the character' };
    }

    return this.login(reason);
  }

  /** Send `/login <password>` and wait for the server's verdict. */
  async login(reason = 'manual') {
    const waited = Date.now() - this.lastAttemptAt;
    if (this.lastAttemptAt && waited < this.cooldownMs) {
      const seconds = Math.ceil((this.cooldownMs - waited) / 1000);
      this.log.warn(`not logging in again yet: ${seconds}s left of the ${Math.round(this.cooldownMs / 1000)}s cooldown`);
      return { ok: false, action: 'cooldown', reason: `waiting ${seconds}s before another attempt` };
    }

    if (typeof this.body.isForbidden === 'function' && this.body.constructor.isForbidden(`login ${this.password}`)) {
      // Defensive: `login` is not a forbidden verb, but if that ever changes this must not
      // become a silent bypass of the register gate.
      return { ok: false, action: 'refuse', reason: 'the login command was refused by the forbidden-verb gate' };
    }

    this.attempts += 1;
    this.lastAttemptAt = Date.now();
    this.log.info(`logging in (${reason}, attempt ${this.attempts}) as configured`);
    const sent = await this.body.login(this.password).catch((err) => {
      this.log.warn(`login dispatch failed: ${err.message}`);
      return false;
    });
    if (!sent) return { ok: false, action: 'send-failed', reason: 'the client refused to send the login command' };

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      const text = this.lines.join('\n');
      if (SUCCESS.test(text) || ALREADY.test(text)) {
        this.loggedIn = true;
        this.lastOutcome = 'authenticated';
        this.log.info('logged in');
        return { ok: true, action: 'login', reason: 'the server accepted the login' };
      }
      if (RATE_LIMITED.test(text)) {
        this.lastOutcome = 'rate-limited';
        return { ok: false, action: 'rate-limited', reason: 'AuthMe rate limit - wait about a minute' };
      }
      if (BAD_PASSWORD.test(text)) {
        this.lastOutcome = 'bad-password';
        return { ok: false, action: 'bad-password', reason: 'the server rejected the password' };
      }
      if (NOT_REGISTERED.test(text)) {
        this.needsRegistration = true;
        this.lastOutcome = 'not-registered';
        return { ok: false, action: 'refuse', reason: 'the account is not registered; registering would reset the character' };
      }
    }
    this.lastOutcome = 'no-answer';
    return { ok: false, action: 'no-answer', reason: `no recognisable answer within ${this.timeoutMs}ms` };
  }

  status() {
    return {
      configured: this.configured,
      enabled: this.enabled,
      loggedIn: this.loggedIn,
      attempts: this.attempts,
      lastOutcome: this.lastOutcome,
      needsRegistration: this.needsRegistration,
      cooldownMs: this.cooldownMs
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { AuthMeLogin, plain, PROMPT, NOT_AUTHED, SUCCESS, ALREADY, RATE_LIMITED, NOT_REGISTERED, BAD_PASSWORD };
