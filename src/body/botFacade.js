'use strict';

/**
 * botFacade: a minimal, *honest* stand-in for the mineflayer `bot` object.
 *
 * Why this exists (P0-PLAN §4.3.1)
 * --------------------------------
 * Large parts of the existing decision layer were written against `ctx.bot`:
 * `inventorySummary(ctx.bot)`, `ctx.bot.chat(...)`, `bot.entity.position`. Under the
 * client-mod body there is no mineflayer instance, so `ctx.bot` is null. The failure mode
 * is nasty rather than loud: `say()` wraps `ctx.bot.chat()` in `try {} catch {}`, so
 * `!status` simply produced no reply at all, and the missing `bot.players` lookup made
 * `!follow` silently do nothing.
 *
 * Two candidate fixes: rewrite every call site to speak Body, or hand those call sites
 * something shaped like a bot. This is the second, and it is the smaller change.
 *
 * The important design rule is what is **absent**: there is no `dig`, `place`, `equip`,
 * `attack` or `pathfinder`. Read-only state and speaking are safe to fake; *acting* must
 * go through the Body, where the real implementation (and its failure classification)
 * lives. Leaving the action methods off means a mistaken call throws
 * "not a function" immediately instead of silently doing nothing on the clientmod body -
 * the exact class of bug the plan calls out.
 */

/**
 * @param {object} body a Body implementation
 * @param {object} cfg loaded agent config
 * @param {object} [hooks] { noteOwnSpeech, players }
 * @returns {object} a bot-shaped read-only facade
 */
function createBotFacade(body, cfg, hooks = {}) {
  const snapshot = () => (body && typeof body.snapshot === 'function' ? body.snapshot() : null);

  const facade = {
    /** Only ever a string: log lines and chat commands interpolate it freely. */
    username: (cfg && cfg.agent && cfg.agent.bot && cfg.agent.bot.username) || 'agent',

    /** Mineflayer shape: `bot.inventory.items()` -> [{name, count, type}] */
    inventory: {
      items: () => {
        const snap = snapshot();
        return Object.entries((snap && snap.inventory) || {}).map(([name, count]) => ({
          name,
          count,
          type: name,
          displayName: name
        }));
      },
      emptySlotCount: () => {
        const snap = snapshot();
        return snap && typeof snap.emptySlots === 'number' ? snap.emptySlots : null;
      }
    },

    /** `bot.entity.position` is read as a value in several places, so it is a getter. */
    entity: {
      get position() {
        const snap = snapshot();
        return snap ? { ...snap.position } : null;
      }
    },

    /** Players are only known if the body reports them; never invent any. */
    get players() {
      const snap = snapshot();
      const list = (snap && snap.players) || [];
      /**
       * The clientmod body reports players as `{name, id, position, ...}` objects (the
       * id is what PvP gunfire aims at); older bodies report bare names. Accept both -
       * an object used as a lookup key silently becomes "[object Object]".
       */
      return Object.fromEntries(
        list.map((entry) => {
          const name = typeof entry === 'string' ? entry : entry.name;
          return [name, { username: name, entity: null }];
        })
      );
    },

    /**
     * Speak. Routed through the echo filter hook so the reply is never mistaken for a new
     * command by our own chat poller (§4.1.3).
     */
    chat: (message) => {
      const text = String(message);
      if (typeof hooks.noteOwnSpeech === 'function') hooks.noteOwnSpeech(text);
      return body.chat(text);
    },

    /** Diagnostics shown in `body:info` and the panel. */
    describe: () => ({ facade: true, kind: body ? body.kind : 'none', ready: !!(body && body.isReady) })
  };

  /**
   * Anything else is a programming error, not a graceful degradation. Throwing here is
   * deliberate: the alternative is a task that appears to run and does nothing.
   */
  return new Proxy(facade, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      throw new Error(
        `botFacade has no "${String(prop)}": acting must go through the Body (ctx.body), ` +
          'not through a mineflayer-shaped facade'
      );
    },
    has(target, prop) {
      return prop in target;
    }
  });
}

module.exports = { createBotFacade };
