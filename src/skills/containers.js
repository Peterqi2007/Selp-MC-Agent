'use strict';

/**
 * Container skills: withdraw from and deposit into a chest (or barrel/shulker).
 *
 * Built on the three menu primitives the control mod exposes - `useon` to open, `menu` to
 * read the slots, `click` to move stacks - which is exactly how a player does it.
 *
 * Both skills share the same optimized container path (2026-10-21):
 *   - a 15x15(x/z) x 9(y) scan whitelisted to pure containers;
 *   - an A* walk (`pathfind: true`) to each candidate;
 *   - an exact item/count transfer with a post-transfer menu check;
 *   - `deposit` crafts/places a chest when nothing is in range;
 *   - `withdraw` reads each chest and skips the ones that do not hold the item.
 *
 * They are marked `beta`: they work through the mod's click path, but no one has moved a
 * stack on a live server yet.
 */

const { register } = require('./registry');
const { bare } = require('../world/items');
const { FAILURE } = require('../core/failure');

/* --------------------------------------------------------------- scan + transfer helpers
 *
 * `deposit` and `withdraw` share the same container scan and exact-count transfer rules
 * (2026-10-21):
 *   - the scan is 15x15 in x/z (+/-7) and 9 tall (y +/-4), whitelisted to pure containers
 *     only (chest / trapped chest / ender chest / barrel / shulker box and the modded
 *     `*_chest`, `*_barrel`, `*_shulker_box` variants). Drawers, cabinets, crates, sacks
 *     etc. are deliberately not storage targets;
 *   - the walk to a container uses the A* navigator (`pathfind: true`), not the client's
 *     straight-line walker;
 *   - deposit crafts/places a chest when nothing is in range; withdraw reads each chest in
 *     the box and skips the ones that do not hold the requested item.
 */

/** 15 cells per axis in x/z, centred on the player. */
const BOX_HALF = 7;
/** 9 cells tall: +/-4 blocks vertically. */
const VERTICAL_HALF = 4;

const PURE_CONTAINER_EXACT = new Set(['chest', 'trapped_chest', 'ender_chest', 'barrel', 'shulker_box']);

/**
 * Pure storage blocks only.
 *
 * The old scan matched `chest|barrel|crate|shulker|drawer|cabinet|sack`, which treated a
 * drawer or a cabinet as a chest. The operator's rule is "only pure containers": chest,
 * barrel, loot chest and their variants. `*_chest` covers `iron_chest`, `lootr_chest`,
 * `trapped_chest`; `*_barrel` covers `oak_barrel`/`lootr_barrel`; `*_shulker_box` covers the
 * coloured boxes.
 */
function isPureContainer(name) {
  const n = bare(name || '');
  if (!n) return false;
  if (PURE_CONTAINER_EXACT.has(n)) return true;
  if (/_shulker_box$/.test(n)) return true;
  return /_chest$|_barrel$/.test(n);
}

const PLACEABLE = /^(air|cave_air|void_air|short_grass|grass|tall_grass|snow)$/;
const NOT_GROUND = /^(air|cave_air|void_air|water|lava|fire|soul_fire)$/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  const dz = Number(a.z) - Number(b.z);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function fmt(position) {
  if (!position) return '(unknown)';
  return `${Number(position.x).toFixed(1)},${Number(position.y).toFixed(1)},${Number(position.z).toFixed(1)}`;
}

/** Force a fresh body read; null when the body cannot answer (never falls back to the cache). */
async function freshSnapshot(ctx) {
  const body = ctx.body;
  if (!body) return null;
  if (typeof body.refreshStrict === 'function') {
    const outcome = await body.refreshStrict(true).catch(() => null);
    if (!outcome || outcome.ok !== true) return null;
  } else if (typeof body.refresh === 'function') {
    await body.refresh(true).catch(() => null);
  }
  return typeof body.snapshot === 'function' ? body.snapshot() : null;
}

function countInInventory(inventory, itemName) {
  let total = 0;
  for (const [name, count] of Object.entries(inventory || {})) {
    if (bare(name) === itemName) total += Number(count) || 0;
  }
  return total;
}

/** Sum one item across the player part of an open menu. */
function countInMenu(menu, itemName) {
  let total = 0;
  for (const slot of (menu && menu.slots) || []) {
    if (slot && slot.player === true && bare(slot.item || '') === itemName) total += Number(slot.count) || 0;
  }
  return total;
}

/** Sum one item across the container part of an open menu (what withdraw can take). */
function countInMenuContainer(menu, itemName) {
  let total = 0;
  for (const slot of (menu && menu.slots) || []) {
    if (slot && slot.player === false && bare(slot.item || '') === itemName) total += Number(slot.count) || 0;
  }
  return total;
}

/** First container-side slot with room for one more item of this kind. */
function containerRoom(menu, itemName) {
  for (const slot of (menu && menu.slots) || []) {
    if (!slot || slot.player !== false) continue;
    if (Number(slot.count) === 0) return slot;
    if (bare(slot.item || '') === itemName && Number(slot.count) < 64) return slot;
  }
  return null;
}

/** First player-side slot with room for one more item of this kind (withdraw direction). */
function playerRoom(menu, itemName) {
  for (const slot of (menu && menu.slots) || []) {
    if (!slot || slot.player !== true) continue;
    if (Number(slot.count) === 0) return slot;
    if (bare(slot.item || '') === itemName && Number(slot.count) < 64) return slot;
  }
  return null;
}

/**
 * The open menu must belong to a pure container. Class names cover vanilla
 * (`ChestMenu`, `BarrelMenu`, `ShulkerBoxMenu`) and the common modded subclasses
 * (`IronChestMenu`, `LootrChestMenu`, ...).
 */
function isPureContainerMenu(menu) {
  return !!(menu && /chest|barrel|shulker/i.test(menu.menuClass || ''));
}

function blockAt(ctx, position) {
  const world = ctx.world;
  if (!world) return null;
  if (typeof world.blockAtAbsolute === 'function') return world.blockAtAbsolute(position);
  if (typeof world.blockAt === 'function') return world.blockAt(position);
  return null;
}

/** All pure containers in the 15x15(x/z) x 9(y) box, nearest first. */
async function findContainers(ctx) {
  const snap = await freshSnapshot(ctx);
  const here = snap && snap.position;
  if (!here) return [];
  const world = ctx.world;
  const found =
    world && typeof world.findBlocksMatching === 'function'
      ? world.findBlocksMatching((name) => isPureContainer(name), { maxDistance: 12, count: 64 })
      : [];
  return found
    .filter((block) => block && block.position && isPureContainer(block.name))
    .filter(
      (block) =>
        Math.abs(block.position.x - here.x) <= BOX_HALF &&
        Math.abs(block.position.z - here.z) <= BOX_HALF &&
        Math.abs(block.position.y - here.y) <= VERTICAL_HALF
    )
    .map((block) => ({ ...block, distance: distance(here, block.position) }))
    .sort((a, b) => a.distance - b.distance);
}

/** The nearest pure container (deposit needs one target; withdraw iterates the list). */
async function findContainer(ctx) {
  return (await findContainers(ctx))[0] || null;
}

async function walkToContainer(ctx, position) {
  const body = ctx.body;
  if (typeof body.moveTo !== 'function') {
    return { ok: false, failure: FAILURE.UNSUPPORTED, reason: 'this body cannot walk' };
  }
  const ok = await body
    .moveTo({ ...position }, { range: 2.5, timeoutMs: 20000, pathfind: true })
    .catch(() => false);
  return ok
    ? { ok: true }
    : { ok: false, failure: FAILURE.NO_PATH, reason: `could not walk to the container at ${fmt(position)}` };
}

/** Open a container that has already been selected (and walked to). */
async function openContainerAt(ctx, position) {
  const body = ctx.body;
  if (typeof body.useOn !== 'function') {
    return { ok: false, failure: FAILURE.UNSUPPORTED, reason: 'this body cannot open containers' };
  }
  await body.useOn({ ...position }, { face: { x: 0, y: 1, z: 0 } }).catch(() => false);
  const menu = await body.menu().catch(() => null);
  if (!menu || !menu.open) {
    return { ok: false, failure: FAILURE.TARGET_LOST, reason: `no container menu opened at ${fmt(position)}` };
  }
  if (!isPureContainerMenu(menu)) {
    // The selected block opened a crafting table/furnace/other screen (or nothing at all).
    // Close what we just opened and let the caller try the next candidate.
    await body.closeMenu().catch(() => false);
    return {
      ok: false,
      failure: FAILURE.TARGET_LOST,
      reason: `the block at ${fmt(position)} opened ${menu.menuClass || 'a non-container menu'}, not a pure container`
    };
  }
  return { ok: true, menu, opened: true };
}

/** A free cell beside the player where a chest can stand (ground below, replaceable cell). */
function findPlaceSpot(ctx, here) {
  if (!here) return null;
  const fx = Math.floor(here.x);
  const fy = Math.floor(here.y);
  const fz = Math.floor(here.z);
  const offsets = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2]
  ];
  for (const [dx, dz] of offsets) {
    for (const groundY of [fy - 1, fy]) {
      const ground = { x: fx + dx, y: groundY, z: fz + dz };
      const cell = { x: ground.x, y: ground.y + 1, z: ground.z };
      // Never place into the cells the player is standing in.
      if ((cell.x === fx && cell.z === fz && (cell.y === fy || cell.y === fy + 1))) continue;
      const g = blockAt(ctx, ground);
      const c = blockAt(ctx, cell);
      if (!g || !c) continue;
      if (NOT_GROUND.test(bare(g.name))) continue;
      if (!PLACEABLE.test(bare(c.name))) continue;
      return { ground, cell };
    }
  }
  return null;
}

/**
 * Craft and place a chest when the scan found nothing.
 *
 * The craft/place work is delegated to the registered skills, exactly as the operator asked:
 * `craft` resolves planks/table, `place` performs the vanilla right-click placement.
 */
async function buildChest(ctx, cancelled) {
  const skills = require('../skills'); // lazy: containers.js is loaded by skills/index.js
  let snap = await freshSnapshot(ctx);
  if (!snap) {
    return { ok: false, failure: FAILURE.INTERRUPTED, reason: 'lost the body state before building a chest' };
  }
  if (countInInventory(snap.inventory, 'chest') === 0) {
    if (cancelled()) return { ok: false, failure: FAILURE.INTERRUPTED, reason: 'cancelled' };
    const crafted = await skills
      .run('craft', ctx, { item: 'chest', count: 1 })
      .catch((err) => ({ ok: false, reason: err.message }));
    if (!crafted || crafted.ok !== true) {
      return {
        ok: false,
        failure: (crafted && crafted.failure) || FAILURE.NO_MATERIAL,
        reason: `no container nearby and crafting a chest failed: ${
          (crafted && (crafted.reason || crafted.detail)) || 'unknown'
        }`
      };
    }
    snap = await freshSnapshot(ctx);
  }
  if (!snap || countInInventory(snap.inventory, 'chest') === 0) {
    return { ok: false, failure: FAILURE.INTERNAL, reason: 'crafted a chest but it is not in the inventory' };
  }
  const spot = findPlaceSpot(ctx, snap.position);
  if (!spot) {
    return { ok: false, failure: FAILURE.NO_MATERIAL, reason: 'no free cell next to me to place the chest' };
  }
  if (cancelled()) return { ok: false, failure: FAILURE.INTERRUPTED, reason: 'cancelled' };
  const placed = await skills
    .run('place', ctx, {
      item: 'chest',
      x: spot.ground.x,
      y: spot.ground.y,
      z: spot.ground.z,
      face: 'up'
    })
    .catch((err) => ({ ok: false, reason: err.message }));
  if (!placed || placed.ok !== true) {
    return {
      ok: false,
      failure: (placed && placed.failure) || FAILURE.UNKNOWN,
      reason: `crafted a chest but placing it failed: ${(placed && (placed.reason || placed.detail)) || 'unknown'}`
    };
  }
  // The place verb can answer before the block shows up in the client's scan; poll briefly.
  for (let i = 0; i < 6; i += 1) {
    await sleep(200);
    const fresh = await freshSnapshot(ctx);
    const block = fresh && blockAt(ctx, spot.cell);
    if (block && isPureContainer(block.name)) break;
  }
  return { ok: true, position: spot.cell, built: true };
}

/**
 * Move exactly `want` items from one oversized source stack, in either direction.
 *
 * Quick-move moves whole stacks, so the requested count cannot be met by shift-clicking when
 * the stack is bigger. This is the vanilla split: pick the stack up, right-click the
 * destination slot once per item, then put the remainder back. `roomFor` decides which side
 * is the destination (`containerRoom` for deposit, `playerRoom` for withdraw); the remainder
 * is returned in `finally` so a cancelled/failed split never leaves items on the cursor.
 */
async function splitMove(ctx, source, itemName, want, cancelled, { roomFor, fullReason = 'the destination is full' } = {}) {
  const body = ctx.body;
  const click = (slot, button) =>
    body.clickSlot(slot, { mode: 'pickup', button, attempts: 1, waitMs: 120 }).catch(() => false);
  const picked = await click(source.i, 0);
  if (!picked) {
    return { ok: false, placed: 0, reason: `could not pick up ${itemName} from slot ${source.i}` };
  }
  let placed = 0;
  let failure = null;
  try {
    while (placed < want) {
      if (cancelled()) {
        failure = { cancelled: true, reason: 'cancelled' };
        break;
      }
      const menu = await body.menu().catch(() => null);
      if (!menu || !menu.open) {
        failure = { reason: 'the container closed mid-transfer' };
        break;
      }
      const room = typeof roomFor === 'function' ? roomFor(menu, itemName) : null;
      if (!room) {
        failure = { reason: fullReason };
        break;
      }
      const ok = await click(room.i, 1);
      if (!ok) {
        failure = { reason: `the slot click at ${room.i} failed` };
        break;
      }
      placed += 1;
    }
  } finally {
    const menu = await body.menu().catch(() => null);
    const carried = menu && menu.carried && Number(menu.carried.count) > 0;
    if (carried) await click(source.i, 0);
  }
  return failure ? { ok: false, placed, ...failure } : { ok: true, placed };
}

/**
 * Take exactly `want` of `item` from the open menu's container side.
 *
 * Whole stacks are quick-moved; an oversized stack is split towards the player slots. The
 * menu is re-read afterwards and the actual container-side delta must equal `want`, so a
 * refused click or a full bag is a failure, not an optimistic success.
 */
async function transferFromMenu(ctx, menu, itemName, want, cancelled) {
  const body = ctx.body;
  const before = countInMenuContainer(menu, itemName);
  if (before < want) {
    return {
      ok: false,
      failure: FAILURE.NO_MATERIAL,
      moved: 0,
      reason: `the container has only ${before} ${itemName} (asked ${want})`
    };
  }
  let remaining = want;
  let failure = null;
  const sources = (menu.slots || [])
    .filter((slot) => slot.player === false && bare(slot.item || '') === itemName && Number(slot.count) > 0)
    .sort((a, b) => a.count - b.count);
  for (const slot of sources) {
    if (remaining <= 0) break;
    if (cancelled()) {
      failure = { cancelled: true, reason: (ctx.taskSignal && ctx.taskSignal.reason) || 'cancelled' };
      break;
    }
    if (Number(slot.count) <= remaining) {
      const ok = await body.clickSlot(slot.i, { mode: 'quickmove' }).catch(() => false);
      if (ok) remaining -= Number(slot.count);
      continue;
    }
    const split = await splitMove(ctx, slot, itemName, remaining, cancelled, {
      roomFor: playerRoom,
      fullReason: 'the bag is full'
    });
    remaining -= split.placed;
    if (!split.ok) {
      failure = split;
      break;
    }
  }
  const afterMenu = await body.menu().catch(() => null);
  const after = afterMenu ? countInMenuContainer(afterMenu, itemName) : before;
  const moved = Math.max(0, before - after);
  if (failure) {
    return { ...failure, moved, failure: failure.cancelled ? FAILURE.INTERRUPTED : FAILURE.UNKNOWN };
  }
  if (moved !== want) {
    return {
      ok: false,
      failure: FAILURE.UNKNOWN,
      moved,
      reason: `withdrew only ${moved} of ${want} ${itemName} - the bag may be full or the click was refused`
    };
  }
  return { ok: true, moved };
}

register({
  name: 'withdraw',
  title: '从箱子取物',
  description:
    'Take exactly <count> of <item> from pure containers within 15x15(x/z) x 9(y): reads ' +
    'each chest for the item, walks with A*, and verifies the transfer.',
  beta: true,
  params: {
    item: { type: 'string', required: true },
    count: { type: 'number', default: 1, min: 1, max: 2304 },
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' }
  },
  available: (ctx) => {
    const body = ctx.body || {};
    const capable = ['menu', 'clickSlot', 'useOn', 'moveTo'].every((method) => typeof body[method] === 'function');
    return capable
      ? { ok: true }
      : { ok: false, reason: 'this body cannot withdraw items (needs menu/clickSlot/useOn/moveTo)' };
  },
  async run(ctx, params) {
    const body = ctx.body;
    const item = bare(params.item);
    const count = params.count;
    const signal = ctx.taskSignal || null;
    const cancelled = () => !!(signal && signal.cancelled);
    const stop = () => ({
      ok: false,
      failure: FAILURE.INTERRUPTED,
      reason: (signal && signal.reason) || 'cancelled'
    });

    // An operator-opened pure container is read first. If it has none of the item, close it
    // so the search can open another chest; a crafting table/furnace must not be used.
    let existing = null;
    const current = await body.menu().catch(() => null);
    if (current && current.open && current.menuClass && !/InventoryMenu/.test(current.menuClass)) {
      if (!isPureContainerMenu(current)) {
        return {
          ok: false,
          failure: FAILURE.REFUSED,
          reason: `a ${current.menuClass} is open - close it before withdrawing (storage needs a chest/barrel/shulker)`
        };
      }
      if (countInMenuContainer(current, item) > 0) existing = current;
      else await body.closeMenu().catch(() => false);
    }

    /**
     * The scan is the same 15x15(x/z) x 9(y) box as deposit. Explicit coordinates override
     * the scan (and are still checked against the pure-container whitelist).
     */
    let positions = [];
    if (params.x !== undefined && params.y !== undefined && params.z !== undefined) {
      const position = { x: params.x, y: params.y, z: params.z };
      const block = blockAt(ctx, position);
      if (block && !isPureContainer(block.name)) {
        return {
          ok: false,
          failure: FAILURE.TARGET_LOST,
          reason: `${bare(block.name)} at ${fmt(position)} is not a pure container`
        };
      }
      positions = [{ position }];
    } else {
      positions = await findContainers(ctx);
    }

    const queue = [];
    if (existing) queue.push({ position: null, menu: existing, opened: false });
    for (const candidate of positions) queue.push({ position: candidate.position, opened: true });
    if (!queue.length) {
      return {
        ok: false,
        failure: FAILURE.TARGET_LOST,
        reason: 'no pure container within 15x15x9 blocks'
      };
    }

    let moved = 0;
    let remaining = count;
    const searched = [];
    for (const entry of queue) {
      if (remaining <= 0) break;
      if (cancelled()) {
        return { ...stop(), withdrawn: moved };
      }
      let menu = entry.menu;
      if (!menu) {
        const walked = await walkToContainer(ctx, entry.position);
        if (!walked.ok) {
          searched.push({ position: entry.position, error: walked.reason });
          continue;
        }
        if (cancelled()) return { ...stop(), withdrawn: moved };
        const opened = await openContainerAt(ctx, entry.position);
        if (!opened.ok) {
          searched.push({ position: entry.position, error: opened.reason });
          continue;
        }
        menu = opened.menu;
        entry.menu = menu;
        entry.opened = true;
      }

      const available = countInMenuContainer(menu, item);
      if (available <= 0) {
        searched.push({ position: entry.position, available: 0 });
        if (entry.opened) await body.closeMenu().catch(() => false);
        continue;
      }
      const take = Math.min(available, remaining);
      const transfer = await transferFromMenu(ctx, menu, item, take, cancelled);
      if (entry.opened) {
        await body.closeMenu().catch(() => false);
      } else if (remaining - take > 0) {
        // The operator's open chest is not enough; close it to walk to the next one.
        await body.closeMenu().catch(() => false);
      }
      if (!transfer.ok) {
        return { ...transfer, withdrawn: moved + (transfer.moved || 0) };
      }
      moved += transfer.moved;
      remaining -= transfer.moved;
      searched.push({ position: entry.position, available, took: transfer.moved });
    }

    if (remaining > 0) {
      const openedAny = searched.some((entry) => entry.available !== undefined);
      return {
        ok: false,
        failure: openedAny ? FAILURE.NO_MATERIAL : FAILURE.TARGET_LOST,
        reason:
          moved === 0
            ? `no reachable pure container has ${item} within 15x15x9`
            : `only found ${moved} ${item} in nearby containers (asked ${count})`,
        withdrawn: moved
      };
    }
    return { ok: true, withdrawn: moved, item, detail: `withdrew ${moved} ${item}` };
  }
});

register({
  name: 'deposit',
  title: '存物品到箱子',
  description:
    'Store exactly <count> of <item> in a pure container within 15x15(x/z) x 9(y): scans, ' +
    'walks there with A*, and crafts/places a chest when none is nearby.',
  beta: true,
  params: {
    item: { type: 'string', required: true },
    count: { type: 'number', required: true, min: 1, max: 2304 },
    x: { type: 'number' },
    y: { type: 'number' },
    z: { type: 'number' }
  },
  available: (ctx) => {
    const body = ctx.body || {};
    const capable = ['menu', 'clickSlot', 'useOn', 'moveTo'].every((method) => typeof body[method] === 'function');
    return capable
      ? { ok: true }
      : { ok: false, reason: 'this body cannot store items (needs menu/clickSlot/useOn/moveTo)' };
  },
  async run(ctx, params) {
    const body = ctx.body;
    const item = bare(params.item);
    const count = params.count;
    const signal = ctx.taskSignal || null;
    const cancelled = () => !!(signal && signal.cancelled);
    const stop = () => ({
      ok: false,
      failure: FAILURE.INTERRUPTED,
      reason: (signal && signal.reason) || 'cancelled'
    });
    const closeIfOurs = async (opened) => {
      if (opened && opened.opened) await body.closeMenu().catch(() => false);
    };

    /**
     * Count first. A caller that asks for 10 with 4 in the bag gets a refusal before any
     * menu is opened or any chest is crafted - not a half-done deposit.
     */
    const start = await freshSnapshot(ctx);
    if (!start) return { ok: false, failure: FAILURE.INTERRUPTED, reason: 'could not read a fresh body state' };
    const have = countInInventory(start.inventory, item);
    if (have < count) {
      return { ok: false, failure: FAILURE.NO_MATERIAL, reason: `only ${have} ${item} in the bag (asked ${count})` };
    }

    // An operator-opened pure container is reused and left open; anything the skill opens is
    // closed. A crafting table/furnace the operator left open is NOT a storage target: refuse
    // instead of shift-clicking loot into its input slots.
    let opened = null;
    let container = null;
    const current = await body.menu().catch(() => null);
    if (current && current.open && current.menuClass && !/InventoryMenu/.test(current.menuClass)) {
      if (isPureContainerMenu(current)) {
        opened = { menu: current, opened: false };
      } else {
        return {
          ok: false,
          failure: FAILURE.REFUSED,
          reason: `a ${current.menuClass} is open - close it before depositing (storage needs a chest/barrel/shulker)`
        };
      }
    }

    if (!opened) {
      let target = null;
      if (params.x !== undefined && params.y !== undefined && params.z !== undefined) {
        const position = { x: params.x, y: params.y, z: params.z };
        const block = blockAt(ctx, position);
        if (block && !isPureContainer(block.name)) {
          return {
            ok: false,
            failure: FAILURE.TARGET_LOST,
            reason: `${bare(block.name)} at ${fmt(position)} is not a pure container`
          };
        }
        target = { position };
      } else {
        target = await findContainer(ctx);
      }
      if (!target) {
        // Nothing in the 15x15x9 box: craft a chest with the craft skill, place it, use it.
        const built = await buildChest(ctx, cancelled);
        if (!built.ok) return built;
        target = built;
      }
      container = target.position;
      const walked = await walkToContainer(ctx, container);
      if (!walked.ok) return walked;
      if (cancelled()) return stop();
      const open = await openContainerAt(ctx, container);
      if (!open.ok) return open;
      opened = open;
    }

    const menu = opened.menu;
    const before = countInMenu(menu, item);
    if (before < count) {
      await closeIfOurs(opened);
      return {
        ok: false,
        failure: FAILURE.NO_MATERIAL,
        reason: `only ${before} ${item} in the open menu (asked ${count})`
      };
    }

    let remaining = count;
    let failure = null;
    const sources = (menu.slots || [])
      .filter((slot) => slot.player === true && bare(slot.item || '') === item && Number(slot.count) > 0)
      .sort((a, b) => a.count - b.count);

    for (const slot of sources) {
      if (remaining <= 0) break;
      if (cancelled()) {
        failure = { ...stop(), cancelled: true };
        break;
      }
      if (slot.count <= remaining) {
        // The whole stack fits: shift-click moves exactly this stack.
        const ok = await body.clickSlot(slot.i, { mode: 'quickmove' }).catch(() => false);
        if (ok) remaining -= slot.count;
        continue;
      }
      // The stack is bigger than what is left: split it so the count is exact.
      const split = await splitMove(ctx, slot, item, remaining, cancelled, {
        roomFor: containerRoom,
        fullReason: 'the container is full'
      });
      remaining -= split.placed;
      if (!split.ok) {
        failure = split.cancelled ? { ...stop(), cancelled: true } : split;
        break;
      }
    }

    const afterMenu = await body.menu().catch(() => null);
    const moved = Math.max(0, before - (afterMenu ? countInMenu(afterMenu, item) : before));
    await closeIfOurs(opened);

    if (failure) return { ...failure, deposited: moved };
    if (moved < count) {
      return {
        ok: false,
        failure: FAILURE.UNKNOWN,
        reason: `deposited only ${moved} of ${count} ${item} - the container may be full or refused the click`,
        deposited: moved
      };
    }
    return {
      ok: true,
      deposited: moved,
      item,
      container,
      detail: `deposited ${moved} ${item}${container ? ` into ${fmt(container)}` : ''}`
    };
  }
});

module.exports = { isPureContainer };
