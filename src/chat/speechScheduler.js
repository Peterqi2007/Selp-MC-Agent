'use strict';

/**
 * SpeechScheduler: the state half of the three role-play triggers that make the bot speak
 * unprompted.
 *
 * The requirement was explicit: speak up when work finishes, when hungry with no food, and
 * when badly hurt. Those three split across two mechanisms by their nature, and this file is
 * the complete index of them:
 *
 *   taskDone    an EVENT   -> LlmCore.announceFinished, subscribed to the brain's task events
 *   hungry      a STATE    -> polled here, needs a cooldown
 *   lowHealth   a STATE    -> polled here, needs a cooldown
 *   (respawn)   an EVENT   -> DeathWatch's onRespawn hook, also polled here for the wording
 *
 * The split is the reason this file exists at all. A finished task happens once, so an event
 * handler is the natural fit. Hunger and injury are *states* - a starving bot is starving on
 * every tick - so they need a poller plus a per-trigger cooldown. Putting the event case in
 * here as well would have meant a poller pretending to detect a one-shot change.
 *
 * Why a separate loop instead of adding rules to the Brain
 * --------------------------------------------------------
 * The Brain's fast loop is the reflex layer: it may pre-empt any task, and its 600ms cadence
 * is for things where a second of delay means death. Speaking is neither urgent nor allowed to
 * cancel work, so folding it in would have meant either a 600ms speech check (chat spam) or a
 * special case inside the reflex loop. A 1s poller over a body snapshot is simpler and cannot
 * interfere with navigation.
 *
 * The two guards that matter
 * --------------------------
 * 1. **Cooldowns are per trigger and generous.** `hungry` fires every 60s at most, and the
 *    condition stays true until someone feeds the bot - without the cooldown it would repeat
 *    forever and the chat channel would be unusable.
 * 2. **Nothing here can act.** Every path funnels into `llm.speakUp`, which drops any action
 *    the model proposes. An unprompted "I'm hungry" can therefore never turn into the bot
 *    wandering off to find food on its own.
 */

const { Logger } = require('../util/logger');

/** Default per-trigger policy. Mirrors config/agent.json -> agent.proactive.triggers. */
const DEFAULTS = {
  hungry: { enabled: true, cooldownMs: 60000, foodThreshold: 6 },
  lowHealth: { enabled: true, cooldownMs: 45000, healthThreshold: 6 },
  fireOnRespawn: { enabled: true, cooldownMs: 15000 }
};

class SpeechScheduler {
  /**
   * @param {object} ctx agent context (needs cfg, body, llm)
   * @param {object} [options] { log, intervalMs, triggers, enabled }
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    const agentCfg = (ctx && ctx.cfg && ctx.cfg.agent) || {};
    const cfg = agentCfg.proactive || {};
    this.cfg = cfg;
    this.enabled = options.enabled === undefined ? cfg.enabled !== false : options.enabled;
    this.intervalMs = options.intervalMs || cfg.intervalMs || 1000;
    this.log = options.log || new Logger('speech');

    const triggers = options.triggers || cfg.triggers || {};
    this.triggers = {
      hungry: { ...DEFAULTS.hungry, ...(triggers.hungry || {}) },
      lowHealth: { ...DEFAULTS.lowHealth, ...(triggers.lowHealth || {}) },
      fireOnRespawn: { ...DEFAULTS.fireOnRespawn, ...(triggers.fireOnRespawn || {}) }
    };

    /** Last time each trigger spoke, for the cooldown. */
    this.lastFired = new Map();
    /** Counters for the panel / selftest. */
    this.stats = { hungry: 0, lowHealth: 0, respawn: 0, skippedCooldown: 0, skippedDisabled: 0 };
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running || !this.enabled) {
      if (!this.enabled) this.log.info('proactive speech is off (agent.proactive.enabled=false)');
      return;
    }
    this.running = true;
    this.timer = setInterval(() => this.tick().catch((err) => this.log.debug(`speech tick: ${err.message}`)), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.log.info(`proactive speech online (interval ${this.intervalMs}ms): hungry / lowHealth / respawn`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** True when this trigger is allowed to speak right now. */
  ready(kind, now = Date.now()) {
    const trigger = this.triggers[kind];
    if (!trigger || trigger.enabled === false) {
      this.stats.skippedDisabled += 1;
      return false;
    }
    const cooldown = trigger.cooldownMs === undefined ? 60000 : trigger.cooldownMs;
    const last = this.lastFired.get(kind) || 0;
    if (cooldown > 0 && now - last < cooldown) {
      this.stats.skippedCooldown += 1;
      return false;
    }
    return true;
  }

  /** One evaluation pass over the two state triggers. */
  async tick() {
    if (!this.enabled) return;
    const body = this.ctx.body;
    if (!body || typeof body.snapshot !== 'function') return;
    const snap = body.snapshot();
    // No snapshot means the client is not attached. That is not "hurt" or "hungry" - it is
    // "unknown", and speaking about it would be a lie.
    if (!snap || snap.ready !== true) return;
    if (snap.dead === true) return; // the death path has its own alerting (DeathWatch)

    if (this.lowHealthDue(snap)) return this.fire('lowHealth', { snap });
    if (this.hungryDue(snap)) return this.fire('hungry', { snap });
    return undefined;
  }

  lowHealthDue(snap) {
    const t = this.triggers.lowHealth;
    if (!t || t.enabled === false) return false;
    const health = Number(snap.health);
    if (!Number.isFinite(health)) return false;
    if (health > (t.healthThreshold === undefined ? 6 : t.healthThreshold)) return false;
    return this.ready('lowHealth');
  }

  hungryDue(snap) {
    const t = this.triggers.hungry;
    if (!t || t.enabled === false) return false;
    const food = Number(snap.food);
    if (!Number.isFinite(food)) return false;
    if (food > (t.foodThreshold === undefined ? 6 : t.foodThreshold)) return false;
    /**
     * "Hungry AND no food" - the second half is what makes the line worth saying.
     *
     * A bot with a full inventory of cooked beef is hungry for two seconds and then eats; asking
     * the player for food then is noise. Only when the inventory has nothing edible is the
     * player actually the solution.
     */
    if (this.hasFood(snap)) return false;
    return this.ready('hungry');
  }

  /** Does the inventory hold anything the eat logic would accept? */
  hasFood(snap) {
    const inventory = (snap && snap.inventory) || {};
    let isFood;
    try {
      ({ isFood } = require('../world/items'));
    } catch {
      return false;
    }
    const registry = (this.ctx.bot && this.ctx.bot.registry) || null;
    return Object.keys(inventory).some((raw) => {
      const bare = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
      return isFood(bare, registry);
    });
  }

  /**
   * Deliver one trigger.
   *
   * @param {'hungry'|'lowHealth'|'respawn'} kind
   * @param {object} [data] { snap }
   */
  async fire(kind, data = {}) {
    if (!this.ready(kind)) return false;
    this.lastFired.set(kind, Date.now());
    this.stats[kind] = (this.stats[kind] || 0) + 1;

    const llm = this.ctx.llm;
    if (!llm || typeof llm.speakUp !== 'function') {
      this.log.warn(`proactive[${kind}] wanted to speak but there is no LLM layer`);
      return false;
    }
    // speakUp owns the wording (model or template) and can never act - see LlmCore.speakUp.
    const result = await llm.speakUp(kind, { snap: data.snap }).catch((err) => {
      this.log.debug(`proactive[${kind}] failed: ${err.message}`);
      return null;
    });
    return !!(result && result.ok);
  }

  /** Called by DeathWatch when the bot comes back, so it can mention having died. */
  async onRespawn() {
    return this.fire('respawn');
  }

  status() {
    return {
      enabled: this.enabled,
      running: this.running,
      intervalMs: this.intervalMs,
      triggers: Object.fromEntries(
        Object.entries(this.triggers).map(([name, t]) => [
          name,
          {
            enabled: t.enabled !== false,
            cooldownMs: t.cooldownMs,
            lastFiredAt: this.lastFired.get(name) ? new Date(this.lastFired.get(name)).toISOString() : null
          }
        ])
      ),
      stats: { ...this.stats }
    };
  }
}

module.exports = { SpeechScheduler, DEFAULTS };
