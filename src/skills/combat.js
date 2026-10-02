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

function pickTarget(ctx, { type, maxDistance }) {
  const body = ctx.body;
  if (!body || typeof body.hostiles !== 'function') return { ok: false, reason: 'this body cannot see hostiles' };
  let list = body.hostiles(maxDistance) || [];
  if (type) list = list.filter((entity) => bare(entity.name) === bare(type));
  if (!list.length) {
    return { ok: false, reason: type ? `no ${bare(type)} within ${maxDistance} blocks` : `no hostile within ${maxDistance} blocks` };
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
    maxDistance: { type: 'number', default: 8, min: 1, max: 32 },
    timeoutMs: { type: 'number', default: 15000, min: 500, max: 120000 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.attack === 'function' && typeof ctx.body.hostiles === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot fight' }),
  async run(ctx, params) {
    const picked = pickTarget(ctx, params);
    if (!picked.ok) return picked;
    const ok = await ctx.body.attack(picked.target, { timeoutMs: params.timeoutMs });
    return ok
      ? { ok: true, detail: `killed ${bare(picked.target.name)}` }
      : { ok: false, reason: `${bare(picked.target.name)} is still alive (or out of reach)` };
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
