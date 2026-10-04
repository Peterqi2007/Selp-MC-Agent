'use strict';

/**
 * DeathWatch: notice that the bot died, stop everything, and shout about it *outside* the
 * game (P0-PLAN §4.4).
 *
 * The mod has reported `player.isDeadOrDying()` in `/state` all along
 * (`ClientStateSnapshot.java`), and `ClientModBody.snapshot()` was dropping the field on
 * the floor. The existing `controller.on('death')` handlers are mineflayer events, which
 * never fire under the client-mod body - so nothing at all happened when the bot died.
 *
 * Why polling rather than an event: the Body contract is pull-only (there is no event
 * channel), and `/state` is already being read every 400ms, so riding along costs nothing.
 *
 * Two deliberate decisions:
 *
 *   - **A disconnect is not a death.** If the snapshot goes away the client is gone; that
 *     is a different problem with a different fix, and treating it as death would fire
 *     false alarms every time the client restarts.
 *   - **No auto-resume.** The user asked for "abort everything on death", so waking up
 *     again must be an explicit human act. Rejoining the fight automatically is precisely
 *     the behaviour that was complained about.
 */

const { Logger } = require('../util/logger');

class DeathWatch {
  /**
   * @param {object} ctx agent context (body, brain, memory, log, cfg)
   * @param {object} [options] { intervalMs, log }
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.log = options.log || new Logger('death');
    const cfgDeath = (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.death) || {};
    this.intervalMs = options.intervalMs || cfgDeath.detectIntervalMs || 500;
    /**
     * There is deliberately no auto-resume.
     *
     * The operator's rule is that coming back from a death is a human decision, so respawning
     * must never restart work on its own. An earlier version had an `autoResume` switch for it;
     * the switch is gone rather than merely defaulted off, because a flag that can be turned on
     * is a flag that will be turned on, and the failure it produces - the bot quietly walking
     * back into whatever killed it - is exactly what "stop everything" was meant to prevent.
     *
     * Recovery is always explicit: the panel's resume button, or POST /command {"command":
     * "resume"}, both of which land in `resume()` below.
     */
    /**
     * The three alert landing spots from §4.4.3, each individually switchable.
     *
     * Separate flags because they serve different operators: a headless run wants the console
     * banner, someone watching the panel may not have the terminal in front of them, and an
     * external watchdog polls the state file. All three default to on.
     */
    this.alertConsole = options.alertConsole === undefined ? cfgDeath.alertConsole !== false : options.alertConsole !== false;
    this.alertPanelFlag = options.alertPanel === undefined ? cfgDeath.alertPanel !== false : options.alertPanel !== false;
    this.alertStateFileFlag =
      options.alertStateFile === undefined ? cfgDeath.alertStateFile !== false : options.alertStateFile !== false;
    this.dead = false;
    /** When and where the current death happened, for the panel and the state file. */
    this.death = null;
    /** Total deaths observed this run. */
    this.count = 0;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.log.debug(`death watch online (every ${this.intervalMs}ms)`);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check. Never throws: this runs on a timer. */
  tick() {
    try {
      const snap = this.ctx.body ? this.ctx.body.snapshot() : null;
      if (!snap || snap.ready !== true) {
        // No client. Deliberately NOT treated as death (see the header).
        return;
      }
      const nowDead = snap.dead === true;
      if (nowDead && !this.dead) this.onDeath(snap);
      else if (!nowDead && this.dead) this.onRespawned(snap);
    } catch (err) {
      this.log.debug(`death watch tick failed: ${err.message}`);
    }
  }

  /** Death detected for the first time in this death episode. */
  onDeath(snap) {
    this.dead = true;
    this.count += 1;
    this.death = { at: new Date().toISOString(), position: snap.position ? { ...snap.position } : null, dimension: snap.dimension || null };
    const { brain, memory } = this.ctx;

    // 1. Abort everything, including autonomous planning. `stopped` is stronger than
    //    `paused`: it refuses new work until a human resumes, rather than just idling.
    if (brain) {
      if (typeof brain.preempt === 'function') brain.preempt();
      if (typeof brain.stopForDeath === 'function') brain.stopForDeath(this.death);
      // The background task slot is separate from the brain queue; death means both.
      if (this.ctx.hub && typeof this.ctx.hub.cancel === 'function') {
        this.ctx.hub.cancel('death').catch(() => {});
      }
    }

    // 2. Stop the client too - otherwise it may still be holding the forward key.
    if (this.ctx.body && typeof this.ctx.body.interrupt === 'function') {
      try {
        const res = this.ctx.body.interrupt('death');
        if (res && typeof res.catch === 'function') res.catch(() => {});
      } catch {
        /* best effort */
      }
    }

    // 3. Alert outside the game (three landing spots, per §4.4.3 - each independently
    //    switchable, see the constructor).
    if (memory && this.alertStateFileFlag) {
      try {
        if (typeof memory.recordDeath === 'function') memory.recordDeath('clientmod');
        if (memory.data) {
          memory.data.runtime = memory.data.runtime || {};
          memory.data.runtime.death = this.death;
          memory.data.runtime.deaths = (memory.data.runtime.deaths || 0) + 1;
        }
        if (typeof memory.save === 'function') memory.save();
      } catch (err) {
        this.log.debug(`could not persist the death record: ${err.message}`);
      }
    }
    if (this.alertConsole) this.alert();
  }

  /** Console banner. Ours is the terminal the user launched the agent from. */
  alert() {
    const at = this.death && this.death.position ? `${fmt(this.death.position)}` : '(unknown position)';
    const line = '─'.repeat(62);
    this.log.error(line);
    this.log.error(`BOT 已死亡 @ ${at} — 所有任务已中止 (deaths this run: ${this.count})`);
    this.log.error('  面板: http://127.0.0.1:8766/panel  （顶部红色横幅 + 恢复按钮）');
    this.log.error('  恢复: 面板点「恢复」，或 POST /command {"command":"resume"}');
    this.log.error('  注意: 若游戏窗口停在死亡画面，需要手动点「重生」（P0 没有自动重生能力）');
    this.log.error(line);
  }

  /**
   * The bot is alive again.
   *
   * Nothing is resumed here, and that is the whole contract: death stops every task, and coming
   * back is a human decision (the panel's resume button or `POST /command {"command":"resume"}`).
   * A bot that restarts itself walks straight back into whatever killed it.
   *
   * The post-respawn hook still fires, because re-authenticating is not "resuming" - an
   * unauthenticated bot can neither move nor talk, so skipping it would leave the agent stuck in
   * a state that looks healthy.
   */
  onRespawned(snap) {
    this.dead = false;
    /**
     * Re-authenticate after a respawn.
     *
     * Most AuthMe servers drop the session on death, and an unauthenticated bot can neither
     * move nor talk - it just stands there while the console shows a healthy connection.
     */
    if (typeof this.onRespawn === 'function') {
      try {
        Promise.resolve(this.onRespawn()).catch((err) => this.log.debug(`post-respawn hook failed: ${err.message}`));
      } catch (err) {
        this.log.debug(`post-respawn hook threw: ${err.message}`);
      }
    }
    this.log.warn('bot respawned - tasks remain STOPPED, resume manually (panel or !resume)');
  }

  /** Human-initiated recovery. */
  resume() {
    if (this.ctx.brain && typeof this.ctx.brain.resumeFromDeath === 'function') this.ctx.brain.resumeFromDeath();
    this.dead = false;
    this.log.info('death stop cleared by an explicit resume');
    return { ok: true, deaths: this.count };
  }

  status() {
    return {
      dead: this.dead,
      deaths: this.count,
      lastDeath: this.death,
      /**
       * Reported as a constant so the panel can show the rule rather than a setting. There is
       * no way to make recovery automatic, so there is nothing to configure.
       */
      autoResume: false,
      /**
       * `alertPanel` decides whether the panel *renders* the red banner. It is reported here
       * rather than hidden, so the panel can honour the operator's choice instead of always
       * shouting about a death they asked not to be shown.
       */
      alertPanel: this.alertPanelFlag,
      alertConsole: this.alertConsole,
      alertStateFile: this.alertStateFileFlag
    };
  }
}

function fmt(position) {
  if (!position) return '(unknown)';
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

module.exports = { DeathWatch };
