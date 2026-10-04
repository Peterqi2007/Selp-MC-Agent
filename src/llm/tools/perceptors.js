'use strict';

/**
 * Perceptors: the read-only half of the tool set (P0-PLAN §5.3).
 *
 * `observe()` is the core tool - it is what makes the difference between a model that
 * describes the world it can see and one that invents it. The other two answer narrower
 * questions ("where is the nearest oak_log", "does `create:cogwheel` exist at all") that would
 * otherwise cost a whole observe round trip.
 *
 * None of these touch the world. That is enforced by never importing an actuator here, and it
 * is why several may run in a single turn.
 */

const { bare } = require('../../world/safety');
const { renderSpatialGrid } = require('../../world/spatialGrid');

/** How many block types to summarise in `observe`, most common first. */
const TOP_BLOCKS = 8;
/** Radius for the block census. */
const CENSUS_RADIUS = 16;

/**
 * The state summary the plan asks for:
 * position / dimension / health / food / time / held / inventory / itemDrops / nearby blocks /
 * players.
 *
 * @param {object} ctx
 * @returns {object} plain JSON, safe to hand straight back to the model
 */
function observe(ctx) {
  const snap = ctx.world && typeof ctx.world.snapshot === 'function' ? ctx.world.snapshot(true) : null;
  if (!snap || !snap.ready) {
    return { ready: false, note: 'not connected to a world right now' };
  }

  const inventory = Object.entries(snap.inventory || {})
    .map(([name, count]) => ({ name: bare(name), count }))
    .sort((a, b) => b.count - a.count);

  const drops = (snap.nearbyItems || []).map((d) => ({
    name: bare(d.name || d.item || ''),
    count: d.count || 1,
    distance: d.distance,
    position: d.position
  }));

  const brain = ctx.brain && typeof ctx.brain.status === 'function' ? ctx.brain.status() : {};

  return {
    ready: true,
    position: round(snap.position),
    dimension: snap.dimension,
    health: snap.health,
    food: snap.food,
    time: snap.time ? { isDay: !!snap.time.isDay, day: snap.time.day } : null,
    weather: snap.weather || null,
    heldItem: snap.heldItem ? bare(snap.heldItem) : null,
    lightLevel: snap.lightLevel === undefined ? null : snap.lightLevel,
    inventory,
    emptySlots: snap.emptySlots === undefined ? null : snap.emptySlots,
    droppedItems: drops,
    nearbyBlocks: census(ctx, CENSUS_RADIUS),
    players: snap.players || [],
    hostiles: (snap.hostiles || []).slice(0, 5).map((h) => ({ name: bare(h.name || ''), distance: h.distance })),
    currentTask: brain.current ? brain.current.description : null,
    busy: !!brain.current,
    /**
     * Named places the operator/agent stored (src/core/places.js). The model can point at
     * "home" or "ore field" without spending a scan round trip; unknown coordinates are
     * still one `find_blocks` away.
     */
    places: ctx.places && typeof ctx.places.summary === 'function' ? ctx.places.summary() : undefined
  };
}

/** Count block types around the bot: "what is this place made of?". */
function census(ctx, radius) {
  const world = ctx.world;
  const body = ctx.body;
  if (!body || typeof body.findBlocksMatching !== 'function') return [];
  let found = [];
  try {
    found = body.findBlocksMatching(() => true, { maxDistance: radius, count: 4096 }) || [];
  } catch {
    return [];
  }
  const counts = new Map();
  for (const block of found) {
    const name = bare(block.name);
    if (name === 'air' || name === 'cave_air' || name === 'void_air') continue;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_BLOCKS)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Nearest matching blocks.
 *
 * @param {object} ctx
 * @param {object} args { names: string[], maxDistance }
 */
function findBlocks(ctx, args) {
  const names = (args.names || []).map((n) => bare(n)).filter(Boolean);
  if (!names.length) return { ok: false, error: 'names must contain at least one block name' };

  const world = ctx.world;
  const body = ctx.body;
  if (!body) return { ok: false, error: 'no body attached' };

  const maxDistance = clamp(Number(args.maxDistance) || 32, 1, 48);
  const wanted = new Set(names);
  let found = [];
  try {
    found = body.findBlocksMatching((name) => wanted.has(bare(name)), { maxDistance, count: 16 }) || [];
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // Report whether each requested name exists at all, so "none found" and "wrong name" are
  // distinguishable without a second call.
  const seen = new Set(found.map((b) => bare(b.name)));
  return {
    searched: names,
    maxDistance,
    blocks: found.map((b) => ({ name: bare(b.name), position: round(b.position), distance: b.distance })),
    notFound: names.filter((n) => !seen.has(n))
  };
}

/**
 * Egocentric terrain map: the dense, near-field half of perception.
 *
 * `find_blocks` answers "where is X"; this answers "what is around me" - walls, water,
 * cliffs and hazards as a small grid the model can trace a route on. It reads the same
 * body scan the pathfinder uses (`body.blockAt`), so unknown cells stay `?` instead of
 * being invented as air.
 *
 * @param {object} ctx
 * @param {object} args { radius }
 */
function scanAround(ctx, args = {}) {
  const body = ctx.body;
  if (!body || typeof body.blockAt !== 'function' || typeof body.snapshot !== 'function') {
    return { ok: false, error: 'no body attached - connect the agent first', failure: 'unsupported' };
  }
  const snap =
    (ctx.world && typeof ctx.world.snapshot === 'function' ? ctx.world.snapshot(true) : null) || body.snapshot();
  if (!snap || !snap.ready || !snap.position) {
    return { ok: false, error: 'no world data yet - the body is not attached', failure: 'unsupported' };
  }
  const radius = Math.max(4, Math.min(16, Math.floor(Number(args.radius) || 8)));
  const read = (x, y, z) => {
    const block = body.blockAt({ x, y, z });
    return block && block.name ? block.name : null;
  };
  const grid = renderSpatialGrid({ read, position: snap.position, radius });
  return {
    ok: true,
    radius: grid.radius,
    position: grid.position,
    legend: grid.legend,
    grid: grid.text
  };
}

/**
 * Does this item or block exist?
 *
 * Backed by `minecraft-data` for vanilla names. A modded name is reported as unknown **on
 * purpose**: the honest answer is "I do not recognise that", and the plan's §5.4 exists
 * precisely so the model admits that instead of promising to fetch something that may not
 * exist. `ctx.mods` is consulted first when it has learned the name from this server.
 */
function lookupItem(ctx, args) {
  const raw = String(args.name || '').trim();
  if (!raw) return { ok: false, error: 'name is required' };
  const name = bare(raw);
  const namespace = raw.includes(':') ? raw.split(':')[0] : 'minecraft';

  /** @type {{known:boolean, name:string, kind?:string, source?:string, note?:string}} */
  const answer = { known: false, name: raw };

  // 1. Anything this server has already taught us wins: it is first-hand knowledge.
  const mods = ctx.mods;
  if (mods && typeof mods.classify === 'function') {
    try {
      const verdict = mods.classify(raw);
      if (verdict && (verdict.known || verdict.kind)) {
        return { ...answer, known: true, kind: verdict.kind || 'block-or-item', source: 'observed on this server' };
      }
    } catch {
      /* the registry below is the fallback */
    }
  }

  // 2. Vanilla registry via minecraft-data.
  try {
    const mcData = require('minecraft-data')((ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.bot && ctx.cfg.agent.bot.version) || '1.20.1');
    if (mcData) {
      if (mcData.itemsByName && mcData.itemsByName[name]) {
        return { ...answer, known: true, kind: 'item', source: 'minecraft-data', displayName: mcData.itemsByName[name].displayName };
      }
      if (mcData.blocksByName && mcData.blocksByName[name]) {
        return { ...answer, known: true, kind: 'block', source: 'minecraft-data', displayName: mcData.blocksByName[name].displayName };
      }
    }
  } catch (err) {
    answer.note = `registry unavailable: ${err.message}`;
  }

  return {
    ...answer,
    note:
      namespace === 'minecraft'
        ? 'not in the vanilla registry - check the spelling'
        : `not in the vanilla registry; "${namespace}" is a mod namespace, so it may exist on this server even though I do not know it`
  };
}

function round(position) {
  if (!position) return null;
  return {
    x: Math.round(position.x * 10) / 10,
    y: Math.round(position.y * 10) / 10,
    z: Math.round(position.z * 10) / 10
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = { observe, findBlocks, scanAround, lookupItem, census };
