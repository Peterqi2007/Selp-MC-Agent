'use strict';

/**
 * Place/use effect evidence - the Node half of the "thin hand" contract.
 *
 * The mod only *collects* (ClientActions.placeJson/useJson): block states around the
 * target, the held item count and the nearby entity list before/after the interaction.
 * It never judges. This module is the judge: an interaction counts as successful only when
 * the world itself changed -
 *
 *   - a block state around the target changed (door/bed parts land on neighbours, so the
 *     comparison covers the face-adjacent cell and the target's neighbours, not one cell);
 *   - the used item's count decreased;
 *   - a NEW entity appeared whose type matches the used item (type contains the item path
 *     or its mod id) - a wandering pig nearby must not pass as "the biplane appeared".
 *
 * "Item consumed but nothing visible" is reported as `consumed-without-visible-effect`:
 * not a hard failure (the server may lag), but never a silent success either.
 */

const { FAILURE } = require('../core/failure');

/** Latest usable after-snapshot: the ~600ms one settles server lag; fall back to the 2-tick. */
function afterOf(evidence) {
  return (evidence && (evidence.after12 || evidence.after2 || evidence.after1)) || null;
}

function blockChanges(before, after) {
  const a = (before && before.blocks) || {};
  const b = (after && after.blocks) || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const key of keys) {
    if (a[key] !== b[key]) changed.push({ pos: key, from: a[key] || null, to: b[key] || null });
  }
  return changed;
}

/** Entity ids present in `after` but absent from `before`, with their type names. */
function newEntities(before, after) {
  const seen = new Set(((before && before.entities) || []).map((entity) => entity && entity.id));
  return (((after && after.entities) || []).filter(
    (entity) => entity && !seen.has(entity.id)
  ));
}

/** Does the entity type look like it came from this item? ("biplane" / mod id match). */
function entityMatchesItem(entityType, itemName) {
  const type = String(entityType || '').toLowerCase();
  const item = String(itemName || '').toLowerCase();
  if (!type || !item) return false;
  const [modid, path] = item.includes(':') ? item.split(':', 2) : ['minecraft', item];
  if (modid && modid !== 'minecraft' && type.startsWith(`${modid}:`)) return true;
  if (path && type.includes(path)) return true;
  /** Spawn eggs: `minecraft:chicken_spawn_egg` -> entity `minecraft:chicken`. */
  if (path && path.endsWith('_spawn_egg')) {
    const entity = path.slice(0, -'_spawn_egg'.length);
    if (entity && type.includes(entity)) return true;
  }
  return false;
}

function summarizeEvidence(before, after, extra = {}) {
  return {
    blocksChanged: blockChanges(before, after).length,
    itemCountBefore: before && Number.isFinite(before.itemCount) ? before.itemCount : null,
    itemCountAfter: after && Number.isFinite(after.itemCount) ? after.itemCount : null,
    screenBefore: before && before.screen !== undefined ? before.screen : null,
    screenAfter: after && after.screen !== undefined ? after.screen : null,
    entitiesBefore: before && Array.isArray(before.entities) ? before.entities.length : null,
    entitiesAfter: after && Array.isArray(after.entities) ? after.entities.length : null,
    ...extra
  };
}

/** A menu opening IS an effect (crafting table / chest / furnace interactions). */
function screenOpened(before, after) {
  const was = before && before.screen ? before.screen : null;
  const now = after && after.screen ? after.screen : null;
  return !was && !!now;
}

/**
 * Judge one mod evidence receipt.
 *
 * @param {object} receipt the parsed mod response: { ok, dispatched, consumesAction, evidence }
 * @param {object} context { item, target:{x,y,z} }
 * @returns {object} { ok:true, evidence } | { ok:false, failure:'unverified', code, evidence, ... }
 *          or `null` when the receipt carries no evidence (legacy mod: caller falls back).
 */
function judgeEffect(receipt, context = {}) {
  const evidence = receipt && receipt.evidence;
  if (!evidence || typeof evidence !== 'object') return null;
  const before = evidence.before || null;
  const after = afterOf(evidence);
  const item = context.item || evidence.item || null;
  const changed = blockChanges(before, after);
  const countBefore = before && Number.isFinite(before.itemCount) ? before.itemCount : null;
  const countAfter = after && Number.isFinite(after.itemCount) ? after.itemCount : null;
  const consumed = countBefore !== null && countAfter !== null && countAfter < countBefore;
  const spawned = newEntities(before, after);
  const matched = spawned.filter((entity) => entityMatchesItem(entity && (entity.type || entity.name), item));
  const menuOpened = screenOpened(before, after);

  /**
   * An item count decrease alone is NOT proof of the requested effect: a cancelled use,
   * a projectile that vanished, or a server-side rollback can consume without spawning
   * the block/entity. The mod already gave us the +12-tick settle snapshot; after that,
   * "consumed but nothing visible" is unverified, never success. This is exactly the
   * weak-receipt failure the evidence path exists to remove.
   */
  if (changed.length || matched.length || menuOpened) {
    return {
      ok: true,
      /** A matched new entity is the strongest evidence (the biplane appeared). */
      effect: matched.length ? 'entity' : changed.length ? 'blocks' : 'screen',
      evidence: summarizeEvidence(before, after, {
        changed: changed.slice(0, 8),
        newEntities: spawned.slice(0, 8).map((entity) => ({ id: entity.id, type: entity.type || entity.name || null })),
        matched: matched.slice(0, 4).map((entity) => ({ id: entity.id, type: entity.type || entity.name || null }))
      })
    };
  }

  if (consumed) {
    const summary = summarizeEvidence(before, after, {
      incomplete: evidence.incomplete === true || undefined,
      consumedWithoutVisibleEffect: true
    });
    const modid = item && item.includes(':') && !item.startsWith('minecraft:') ? item.split(':', 1)[0] : null;
    return {
      ok: false,
      failure: FAILURE.UNVERIFIED,
      code: 'consumed-without-visible-effect',
      effect: 'none',
      item: item || null,
      mod: modid,
      target: context.target || null,
      reason: `${item || 'the held item'} was consumed but no block/entity/menu appeared`,
      evidence: summary,
      retryable: true,
      requiresLookup: true,
      lookupQuery: modid ? `${modid} ${String(item).split(':')[1]} 怎么放置 使用` : null,
      hint: 'do not retry the same coordinates; look up the mod mechanic or ask the player first'
    };
  }

  const summary = summarizeEvidence(before, after, {
    incomplete: evidence.incomplete === true || undefined,
    newEntities: spawned.slice(0, 8).map((entity) => ({ id: entity.id, type: entity.type || entity.name || null }))
  });
  const modid = item && item.includes(':') && !item.startsWith('minecraft:') ? item.split(':', 1)[0] : null;
  return {
    ok: false,
    failure: FAILURE.UNVERIFIED,
    code: 'place-unverified',
    effect: 'none',
    item: item || null,
    mod: modid,
    target: context.target || null,
    reason: `no world effect after using ${item || 'the held item'}` +
      (context.target ? ` at ${context.target.x},${context.target.y},${context.target.z}` : ''),
    evidence: summary,
    retryable: true,
    requiresLookup: true,
    lookupQuery: modid ? `${modid} ${String(item).split(':')[1]} 怎么放置 使用` : null,
    hint: 'do not retry the same coordinates; look up the mod mechanic or ask the player first'
  };
}

module.exports = { judgeEffect, blockChanges, newEntities, entityMatchesItem };
