'use strict';

/**
 * Corpse looting skill - right-click an entity that opens a container (the Corpse mod).
 *
 * Why this is a skill and not a task: fully autonomous mode must recover items even when the
 * action brain is busy, unbound or broken. The sequence is deterministic (interact -> read the
 * container menu -> quick-move every non-player slot -> close), so it belongs next to the
 * other body primitives, not behind a model round.
 *
 * The mod's `entities` list is the source of truth for what we are aiming at
 * (`corpse:corpse` and friends, matched by type substring because the exact registry id is a
 * server-side detail). `useentity` is the mod verb; `interact` was already taken by the
 * block-face form.
 *
 * Rules learned the hard way elsewhere in this repo, applied here:
 *   - **"opened" must be observed, not assumed**: `useentity` returning true only means the
 *     client delivered a right-click; the menu is what proves the container opened.
 *   - **an unexpected menu is a refusal, not loot**: a mod that opens something else must not
 *     silently turn into "emptied a random chest".
 *   - **cancellation is checked between slots**, so `!stop` during a loot does not leave the
 *     body clicking.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bare(name) {
  const text = String(name || '');
  const index = text.indexOf(':');
  return index >= 0 ? text.slice(index + 1) : text;
}

function cancelled(signal) {
  return typeof signal === 'function' && signal() === true;
}

function normaliseTypes(types) {
  const list = Array.isArray(types) ? types : [types];
  return list.map((entry) => String(entry || '').trim()).filter(Boolean);
}

/**
 * Corpse-like entities from the body snapshot, nearest first.
 *
 * Matching is by `type` substring on purpose: the registry id can be `corpse:corpse`,
 * `corpse:corpse_skeleton` or a fork's id, and the default list is only a hint. The distance
 * comes from the entity record so the caller does not recompute it.
 *
 * @param {object} snapshot body snapshot
 * @param {{types?:string[], radius?:number, position?:{x,y,z}}} [options]
 * @returns {Array<{id:number, type:string, position:object, distance:number}>}
 */
function findCorpseEntities(snapshot, options = {}) {
  const entities = (snapshot && Array.isArray(snapshot.entities) ? snapshot.entities : []);
  const types = normaliseTypes(options.types || ['corpse:corpse']);
  const radius = Number.isFinite(Number(options.radius)) ? Number(options.radius) : 16;
  const origin = options.position || (snapshot && snapshot.position) || null;
  const found = [];
  for (const entity of entities) {
    if (!entity || entity.id === undefined) continue;
    /**
     * Match against every identifier the mod may expose. The live 1.20.1 client reports
     * `type: "entity.corpse.corpse"` (a Java-shaped id) while the registry name sits in
     * `name: "corpse:corpse"`; matching only `type` missed every real corpse (live A33.6
     * 2026-11-07: `no-corpse` while the entity was 5 blocks away).
     */
    const candidates = [entity.type, entity.name, entity.registryName, entity.entityType]
      .filter((value) => typeof value === 'string' && value)
      .map((value) => value.toLowerCase());
    if (!candidates.length) continue;
    const matches = candidates.some((candidate) => types.some((entry) => {
      const wanted = entry.toLowerCase();
      return candidate === wanted || candidate.includes(wanted) || (wanted.includes(':') === false && candidate.includes(`:${wanted}`));
    }));
    if (!matches) continue;
    const position = entity.position || (entity.x !== undefined ? { x: entity.x, y: entity.y, z: entity.z } : null);
    let distance = null;
    if (position && origin) {
      const dx = Number(position.x) - Number(origin.x);
      const dy = Number(position.y) - Number(origin.y);
      const dz = Number(position.z) - Number(origin.z);
      distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    } else if (Number.isFinite(Number(entity.distance))) {
      distance = Number(entity.distance);
    }
    if (distance !== null && distance > radius) continue;
    found.push({
      id: entity.id,
      type: String(entity.type || ''),
      name: entity.name || null,
      position: position ? { x: Number(position.x), y: Number(position.y), z: Number(position.z) } : null,
      distance
    });
  }
  found.sort((a, b) => (a.distance === null ? Infinity : a.distance) - (b.distance === null ? Infinity : b.distance));
  return found;
}

/** Poll `body.menu()` until a container menu is open or the budget runs out. */
async function waitForMenu(ctx, options = {}) {
  const body = ctx && ctx.body;
  if (!body || typeof body.menu !== 'function') return null;
  const tries = Number.isFinite(Number(options.tries)) ? Number(options.tries) : 8;
  const delayMs = Number.isFinite(Number(options.delayMs)) ? Number(options.delayMs) : 120;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    let menu = null;
    try {
      menu = await body.menu();
    } catch {
      menu = null;
    }
    if (menu && menu.open !== false && Array.isArray(menu.slots) && menu.slots.length) return menu;
    if (cancelled(options.cancelled)) return null;
    await sleep(delayMs);
  }
  return null;
}

/** Container-side slots that still hold something. */
function remainingSlots(menu) {
  return ((menu && menu.slots) || []).filter(
    (slot) => slot && slot.player !== true && slot.item && slot.item !== 'null' && Number(slot.count) > 0
  );
}

/**
 * Open a corpse and move everything into the player inventory.
 *
 * @param {object} ctx agent context (needs body)
 * @param {object} options
 *   entityId   target entity id (required)
 *   cancelled  () => boolean, checked between slots
 *   menuClassPattern  RegExp matched against `menu.menuClass`; default /corpse/i
 *   allowAnyMenu  when true, skip the menu-class check (off by default)
 *   maxRounds  drain rounds (default 12)
 * @returns {Promise<object>} { ok, reason?, menuClass?, slotsMoved, items, remaining, ms }
 */
async function lootCorpse(ctx, options = {}) {
  const started = Date.now();
  const body = ctx && ctx.body;
  const log = (ctx && ctx.log) || { info() {}, warn() {}, debug() {} };
  const entityId = options.entityId;
  if (!body) return { ok: false, reason: 'no-body', slotsMoved: 0 };
  if (entityId === undefined || entityId === null) return { ok: false, reason: 'no-entity-id', slotsMoved: 0 };
  if (typeof body.useEntity !== 'function') return { ok: false, reason: 'body-cannot-use-entity', slotsMoved: 0 };
  if (cancelled(options.cancelled)) return { ok: false, reason: 'cancelled', slotsMoved: 0 };

  const pattern = options.menuClassPattern instanceof RegExp ? options.menuClassPattern : /corpse/i;
  const allowAnyMenu = options.allowAnyMenu === true;
  const interactTries = Number.isFinite(Number(options.interactTries)) ? Number(options.interactTries) : 3;

  let menu = null;
  let interact = null;
  for (let attempt = 1; attempt <= interactTries; attempt += 1) {
    if (cancelled(options.cancelled)) return { ok: false, reason: 'cancelled', slotsMoved: 0 };
    interact = await body.useEntity(entityId, { ignoreStale: attempt > 1 });
    if (!interact || interact.ok !== true) {
      /**
       * "out of reach" is worth retrying after the caller walks closer; anything else means
       * the entity is gone (already looted / despawned) and retrying only wastes time.
       */
      if (interact && /reach|distance/i.test(String(interact.reason || ''))) {
        return { ok: false, reason: 'out-of-reach', detail: interact.reason, slotsMoved: 0 };
      }
      return { ok: false, reason: (interact && interact.reason) || 'useentity-failed', slotsMoved: 0 };
    }
    menu = await waitForMenu(ctx, { cancelled: options.cancelled });
    if (menu) break;
  }
  if (!menu) {
    log.warn('corpse: right-click delivered but no container menu opened');
    return { ok: false, reason: 'no-menu', slotsMoved: 0 };
  }

  const menuClass = String(menu.menuClass || '');
  if (!allowAnyMenu && !pattern.test(menuClass)) {
    /**
     * A different container opened. That is evidence about the mod, not loot: close and say
     * so instead of quick-moving a chest the agent did not mean to touch.
     */
    await body.closeMenu().catch(() => false);
    log.warn(`corpse: unexpected menu "${menuClass}" - refusing to loot it`);
    return { ok: false, reason: 'unexpected-menu', menuClass, slotsMoved: 0 };
  }

  let slotsMoved = 0;
  const items = {};
  const maxRounds = Number.isFinite(Number(options.maxRounds)) ? Number(options.maxRounds) : 12;
  let rounds = 0;
  let consecutiveEmptyClicks = 0;
  while (rounds < maxRounds) {
    rounds += 1;
    const pending = remainingSlots(menu);
    if (!pending.length) break;
    for (const slot of pending) {
      if (cancelled(options.cancelled)) {
        await body.closeMenu().catch(() => false);
        return { ok: false, reason: 'cancelled', menuClass, slotsMoved, items, remaining: remainingSlots(menu).length };
      }
      let clicked = false;
      try {
        clicked = await body.clickSlot(slot.i, { button: 0, mode: 'quickmove' });
      } catch (err) {
        log.debug(`corpse: quick-move slot ${slot.i} failed: ${err.message}`);
        clicked = false;
      }
      if (clicked) {
        slotsMoved += 1;
        const key = bare(slot.item);
        items[key] = (items[key] || 0) + (Number(slot.count) || 0);
      } else {
        consecutiveEmptyClicks += 1;
      }
    }
    if (consecutiveEmptyClicks >= 3) break;
    const fresh = await waitForMenu(ctx, { tries: 3, delayMs: 100, cancelled: options.cancelled });
    if (!fresh) break;
    menu = fresh;
  }

  const remaining = remainingSlots(menu).length;
  await body.closeMenu().catch(() => false);
  const ms = Date.now() - started;
  if (remaining > 0) {
    /**
     * Items left behind is a real failure mode (full inventory, restricted corpse). Report the
     * count rather than claiming success - the caller decides whether to continue.
     */
    return { ok: false, reason: 'not-empty', menuClass, slotsMoved, items, remaining, ms };
  }
  return { ok: true, reason: null, menuClass, slotsMoved, items, remaining: 0, ms };
}

module.exports = { findCorpseEntities, waitForMenu, remainingSlots, lootCorpse };
