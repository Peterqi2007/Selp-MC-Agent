'use strict';

/**
 * Movement helpers beyond `!goto`: explore (walk somewhere new) and come (walk to a player).
 *
 * Explore exists because "there is no tree in scan range" is the single most common live
 * failure: the scan is 24 blocks, and standing still re-planning the same goal is how the
 * agent burns a minute doing nothing. Walking 16 blocks in a fresh direction costs almost
 * nothing and changes what it can see.
 */

const { register } = require('./registry');
const { bare } = require('../world/items');

function currentPosition(ctx) {
  const snap = ctx.body && typeof ctx.body.snapshot === 'function' ? ctx.body.snapshot() : null;
  return (snap && snap.position) || null;
}

register({
  name: 'explore',
  title: '探索',
  description: 'Walk a stretch of blocks in a (new) direction to find resources or terrain.',
  params: {
    distance: { type: 'number', default: 16, min: 4, max: 64 },
    direction: { type: 'string', choices: ['north', 'south', 'east', 'west', 'random'], default: 'random' }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.moveTo === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot walk' }),
  async run(ctx, { distance, direction }) {
    const now = currentPosition(ctx);
    if (!now) return { ok: false, reason: 'position unknown' };
    const pick = direction === 'random'
      ? ['north', 'south', 'east', 'west'][Math.floor(Math.random() * 4)]
      : direction;
    const delta = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[pick];
    const target = { x: Math.round(now.x) + delta[0] * distance, y: Math.round(now.y), z: Math.round(now.z) + delta[1] * distance };
    const ok = await ctx.body.moveTo(target, { range: 3, timeoutMs: 30000 });
    return ok
      ? { ok: true, detail: `explored ${pick} to ${target.x},${target.y},${target.z}` }
      : { ok: false, reason: `could not walk ${pick} towards ${target.x},${target.y},${target.z}` };
  }
});

register({
  name: 'come',
  title: '走到玩家身边',
  description: 'Walk to a visible player (use after a request like "come here").',
  params: {
    player: { type: 'string', required: true },
    range: { type: 'number', default: 2, min: 1, max: 6 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.moveTo === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot walk' }),
  async run(ctx, { player, range }) {
    const snap = ctx.body.snapshot ? ctx.body.snapshot() : null;
    const players = (snap && snap.players) || [];
    const target = players.find((p) => bare(p.name || p) === bare(player));
    if (!target || !target.position) return { ok: false, reason: `${player} is not visible right now` };
    const ok = await ctx.body.moveTo(target.position, { range, timeoutMs: 30000 });
    return ok ? { ok: true, detail: `walked to ${bare(player)}` } : { ok: false, reason: `could not reach ${bare(player)}` };
  }
});
