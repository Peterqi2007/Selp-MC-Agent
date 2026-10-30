'use strict';

/**
 * Block-interaction skills: place a block, and right-click a block face.
 *
 * `use_on` is deliberately one skill rather than a dozen: the same "right-click this face"
 * primitive hoes soil, plants seeds, fills a bucket, bonemeals a crop, presses a button and
 * opens a chest or crafting table. The caller says where; the item in hand decides what.
 */

const { register } = require('./registry');

register({
  name: 'place',
  title: '放置方块',
  description: 'Place a carried block against the given reference block face.',
  params: {
    item: { type: 'string', required: true },
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    z: { type: 'number', required: true },
    face: { type: 'string', default: 'up', choices: ['up', 'down', 'north', 'south', 'east', 'west'] }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.place === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot place blocks' }),
  async run(ctx, { item, x, y, z, face }) {
    const vector = { up: { x: 0, y: 1, z: 0 }, down: { x: 0, y: -1, z: 0 }, north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 }, east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 } }[face];
    /**
     * Effect-verified when the body supports it: a mod item that did not actually appear
     * must come back as `place-unverified` (knowledge ladder), not as a weak receipt the
     * model reads as success.
     */
    if (typeof ctx.body.placeDetailed === 'function') {
      const detail = await ctx.body.placeDetailed(item, { x, y, z }, vector);
      if (detail.ok) {
        return { ok: true, detail: `placed ${item} against ${x},${y},${z} (${face})`, evidence: detail.evidence || null };
      }
      return {
        ok: false,
        reason: detail.reason || `could not place ${item}`,
        failure: detail.failure || null,
        code: detail.code || null,
        evidence: detail.evidence || null,
        lookupQuery: detail.lookupQuery || null
      };
    }
    const ok = await ctx.body.place(item, { x, y, z }, vector);
    return ok ? { ok: true, detail: `placed ${item} against ${x},${y},${z} (${face})` } : { ok: false, reason: `could not place ${item}` };
  }
});

register({
  name: 'use_on',
  title: '对方块使用物品',
  description: 'Right-click a block face with the held item: hoe, plant, bucket, button, open a container.',
  params: {
    x: { type: 'number', required: true },
    y: { type: 'number', required: true },
    z: { type: 'number', required: true },
    face: { type: 'string', default: 'up', choices: ['up', 'down', 'north', 'south', 'east', 'west'] },
    item: { type: 'string' }
  },
  available: (ctx) => {
    const body = ctx.body || {};
    if (typeof body.useOn === 'function' || typeof body.place === 'function') return { ok: true };
    return { ok: false, reason: 'this body cannot interact with blocks' };
  },
  async run(ctx, { x, y, z, face, item }) {
    const position = { x, y, z };
    if (item && typeof ctx.body.equip === 'function') await ctx.body.equip(item);
    const vector = { up: { x: 0, y: 1, z: 0 }, down: { x: 0, y: -1, z: 0 }, north: { x: 0, y: 0, z: -1 }, south: { x: 0, y: 0, z: 1 }, east: { x: 1, y: 0, z: 0 }, west: { x: -1, y: 0, z: 0 } }[face];
    if (typeof ctx.body.useOnDetailed === 'function') {
      const detail = await ctx.body.useOnDetailed(position, { face: vector });
      if (detail.ok) {
        return { ok: true, detail: `used the held item on ${x},${y},${z} (${face})`, evidence: detail.evidence || null };
      }
      return {
        ok: false,
        reason: detail.reason || `the interaction at ${x},${y},${z} failed`,
        failure: detail.failure || null,
        code: detail.code || null,
        evidence: detail.evidence || null,
        lookupQuery: detail.lookupQuery || null
      };
    }
    const ok = typeof ctx.body.useOn === 'function'
      ? await ctx.body.useOn(position, { face: vector })
      : await ctx.body.place(null, position, vector);
    return ok ? { ok: true, detail: `used the held item on ${x},${y},${z} (${face})` } : { ok: false, reason: `the interaction at ${x},${y},${z} failed` };
  }
});
