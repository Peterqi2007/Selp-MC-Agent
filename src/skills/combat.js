'use strict';

/**
 * Combat skills: attack the nearest hostile, or stand and fight what comes close.
 *
 * The P0 agent had no combat at all, which is why it was shot to death by a stray in the
 * first live run. These skills are deliberately simple: pick a target from what the body
 * actually reports (`hostiles()`), attack it, and let the body decide the swing cadence.
 * There is no pathfinding chase yet - a target that cannot be reached is reported, not
 * followed into a cave.
 */

const { register } = require('./registry');
const { bare } = require('../world/items');

const WEAPON_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

/**
 * Pick the best weapon in the bag: swords by tier first, then axes.
 *
 * The live run started swinging at a zombie while holding bread - the skill never equipped
 * anything, so a full inventory of weapons did nothing.
 */
function pickWeapon(inventory) {
  const names = Object.keys(inventory || {});
  for (const tier of WEAPON_TIERS) {
    const sword = names.find((name) => bare(name) === `${tier}_sword`);
    if (sword) return sword;
  }
  for (const tier of WEAPON_TIERS) {
    const axe = names.find((name) => bare(name) === `${tier}_axe`);
    if (axe) return axe;
  }
  return names.find((name) => /_(sword|axe)$/.test(bare(name))) || null;
}

/**
 * Equip the best weapon before a fight, then verify the hand really holds it.
 *
 * `equip()` is a two-step story on a real client: a hotbar `select`, and - when the
 * stack sits in the bag - menu clicks that move it into the hotbar first. The final
 * select can race the server on a busy moment, the call answers false, and the old
 * version trusted that call: live 2026-10-13 the bot punched a pillager with the
 * shovel that happened to be in hand while its sword sat unused. Read the hand back
 * from a fresh snapshot and retry once; on a body that cannot report the hand, trust
 * the call as before.
 */
async function equipWeapon(ctx) {
  const body = ctx.body;
  if (!body || typeof body.equip !== 'function') return null;
  const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
  const weapon = pickWeapon((snap && snap.inventory) || {});
  if (!weapon) return null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await body.equip(weapon).catch(() => false);
    if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
    const check = typeof body.snapshot === 'function' ? body.snapshot() : null;
    const held = check && check.heldItem ? check.heldItem : null;
    if (!held || bare(held) === bare(weapon)) return weapon;
  }
  const check = typeof body.snapshot === 'function' ? body.snapshot() : null;
  const held = check && check.heldItem ? check.heldItem : null;
  if (ctx && ctx.log && typeof ctx.log.warn === 'function') {
    ctx.log.warn(
      `could not get ${bare(weapon)} into the hand (holding ${held ? bare(held) : 'nothing'}) - fighting with what is held`
    );
  }
  return weapon;
}

function pickTarget(ctx, { type, maxDistance, vertical }) {
  const body = ctx.body;
  if (!body || typeof body.hostiles !== 'function') return { ok: false, reason: 'this body cannot see hostiles' };
  let list = body.hostiles(maxDistance) || [];
  if (type) list = list.filter((entity) => bare(entity.name) === bare(type));
  /**
   * Ignore targets on another floor.
   *
   * The chase is a straight "hold forward" walk, so a zombie in a cave 15 blocks below is
   * not a target - it is a cliff to fall down. Keeping the vertical window small is what
   * stops the bot from diving into a ravine after underground spawns.
   */
  if (vertical !== undefined) {
    const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
    const botY = snap && snap.position ? snap.position.y : null;
    if (botY !== null) {
      list = list.filter((entity) => {
        const y = entity.position ? entity.position.y : botY;
        return Math.abs(y - botY) <= vertical;
      });
    }
  }
  if (!list.length) {
    return {
      ok: false,
      reason: type
        ? `no ${bare(type)} within ${maxDistance} blocks`
        : `no hostile within ${maxDistance} blocks (on this level)`
    };
  }
  list.sort((a, b) => (a.distance || 0) - (b.distance || 0));
  return { ok: true, target: list[0] };
}

register({
  name: 'attack',
  title: '攻击最近的敌对目标',
  description: 'Attack the nearest hostile (optionally of one type) until it dies or times out.',
  params: {
    type: { type: 'string' },
    /**
     * 16 rather than 8. The live report was "!attack was refused while zombies were
     * nearby" - the zombies were around ten blocks away and the old default simply did
     * not look that far. The mod tracks hostiles out to 24 blocks.
     */
    maxDistance: { type: 'number', default: 16, min: 1, max: 32 },
    /** How far above/below the bot a target may be; keeps a straight-line chase on one floor. */
    vertical: { type: 'number', default: 4, min: 1, max: 32 },
    timeoutMs: { type: 'number', default: 15000, min: 500, max: 120000 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.attack === 'function' && typeof ctx.body.hostiles === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot fight' }),
  async run(ctx, params) {
    // A dead or post-death-stopped bot cannot fight; say that instead of "no hostile".
    const snap = ctx.body && typeof ctx.body.snapshot === 'function' ? ctx.body.snapshot() : null;
    if (snap && snap.dead) return { ok: false, reason: 'the bot is dead - respawn before fighting' };
    if (ctx.brain && ctx.brain.stopped) return { ok: false, reason: 'tasks are stopped after death - say !resume first' };

    let picked = pickTarget(ctx, params);
    if (!picked.ok && params.maxDistance < 24) {
      // One escalation step before refusing: a hostile at 10-20 blocks is still "nearby".
      picked = pickTarget(ctx, { ...params, maxDistance: 24 });
    }
    if (!picked.ok) return picked;
    await equipWeapon(ctx);
    let ok = await ctx.body.attack(picked.target, { timeoutMs: params.timeoutMs });
    /**
     * The mod answers "the target is still alive" by returning false - including when it
     * just died (its loop ends on `!living.isAlive()`). Confirm against a fresh hostile
     * list before calling a fight lost: a target that was in melee range and is gone now
     * was killed, not missed.
     */
    if (!ok && typeof ctx.body.refresh === 'function') {
      const after = await ctx.body.refresh(true).catch(() => null);
      if (after) {
        const stillThere = (after.hostiles || []).some((h) => h.id === picked.target.id);
        const wasClose = (picked.target.distance || 99) <= 6;
        if (!stillThere && wasClose) ok = true;
      }
    }
    const name = bare(picked.target.name);
    const screenNote = snap && snap.screenOpen
      ? ` (a game screen "${snap.screen || '?'}" is open - the client ignores movement while it is)`
      : '';
    return ok
      ? { ok: true, detail: `killed ${name} at ${Math.round(picked.target.distance || 0)} blocks` }
      : {
          ok: false,
          reason: `${name} is still alive (or out of reach) - it was ${Math.round(picked.target.distance || 0)} blocks away${screenNote}`
        };
  }
});

register({
  name: 'defend',
  title: '自卫',
  description: 'Keep attacking hostiles that come within range, up to a few rounds.',
  params: {
    range: { type: 'number', default: 6, min: 1, max: 16 },
    rounds: { type: 'number', default: 4, min: 1, max: 20 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.attack === 'function' && typeof ctx.body.hostiles === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot fight' }),
  async run(ctx, { range, rounds }) {
    let kills = 0;
    await equipWeapon(ctx);
    for (let round = 0; round < rounds; round += 1) {
      const picked = pickTarget(ctx, { maxDistance: range });
      if (!picked.ok) break;
      const ok = await ctx.body.attack(picked.target, { timeoutMs: 15000 });
      if (!ok) break;
      kills += 1;
    }
    return kills
      ? { ok: true, detail: `defended against ${kills} hostile(s)` }
      : { ok: true, detail: 'nothing hostile in range' };
  }
});
