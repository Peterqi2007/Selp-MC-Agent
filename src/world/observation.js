'use strict';

/**
 * ObservationCache - the shared, field-granular perception contract (P1 §1.5.3).
 *
 * This is the M1 transitional implementation: Node-side per-field timestamps plus on-demand
 * `body.refresh(true)`, without splitting `/state` into per-field Mod endpoints yet. It is
 * intentionally NOT wired into the language/action brains and does not emit perception
 * events; it gives task code and a future action-brain tool one cached observation surface.
 *
 * Contract:
 *   observe({ fields, area, maxAgeMs, purpose })
 *     -> per-field { value, observedAt, revision, dimension, area, source, valid, stale }
 *
 * Guarantees:
 *   - a field refreshed at one time is stamped with that time; fields from an earlier refresh
 *     keep their own older `observedAt` (no atomic-snapshot lie);
 *   - a stale field triggers at most one single-flight refresh; concurrent callers join it;
 *   - refresh failure returns `ok:false` plus the last successful time; old values remain
 *     `known` but are marked `stale`, never relabelled as current;
 *   - dimension change / death / disconnect invalidate the cache;
 *   - `area` filters position-bearing values; fields with no position are returned whole;
 *   - no model calls, no new subscriptions, no extra scans.
 *
 * Field families are resolved by name or group; unavailable fields (oxygen/burning/effects/
 * armor, biome/surface/water) return `unknown` instead of being invented.
 */

const FIELD_GROUPS = {
  /** Survival/reflex essentials; already collected by the fast reflex loop. */
  survival: ['health', 'food', 'dead', 'onGround', 'standingOn'],
  /** Minimal threat observation; no full entity tracking. */
  threat: ['hostiles'],
  /** Cheap self state and environment summary. */
  self: ['position', 'dimension', 'yaw', 'pitch', 'time', 'weather'],
  /** Inventory/hotbar/durability. */
  inventory: ['inventory', 'emptySlots', 'heldItem', 'heldDurability'],
  /** On-demand task entities (adult animals, combat targets, drops, other players). */
  taskEntities: ['players', 'nearbyItems', 'target'],
  /** Workspace/special blocks currently exposed as a block scan and crosshair target. */
  workspace: ['target', 'standingOn', 'blocks', 'crops', 'fishing'],
  /** Terrain/environment fields that the body currently exposes. */
  terrain: ['blocks', 'lightLevel', 'blockLight']
};

/** Known fields that the body does not currently expose. */
const UNAVAILABLE_FIELDS = new Set([
  'oxygen',
  'burning',
  'effects',
  'armor',
  'biome',
  'surface',
  'water',
  'containers',
  'beds',
  'doors',
  'workstations',
  'modDevices',
  'farmland'
]);

const ALIASES = {
  coordinates: 'position',
  pos: 'position',
  hp: 'health',
  hunger: 'food',
  hotbar: 'heldItem',
  itemDrops: 'nearbyItems',
  entities: 'hostiles'
};

const DEFAULT_FIELDS = ['position', 'health', 'food', 'dimension', 'time', 'weather'];

const DEFAULT_FIELD_TTL = {
  position: 500,
  yaw: 500,
  pitch: 500,
  health: 500,
  dead: 500,
  onGround: 500,
  target: 250,
  heldItem: 500,
  hostiles: 750,
  food: 1000,
  nearbyItems: 1000,
  heldDurability: 1000,
  standingOn: 1000,
  fishing: 1000,
  inventory: 2000,
  emptySlots: 2000,
  players: 2000,
  lightLevel: 2000,
  blockLight: 2000,
  blocks: 5000,
  time: 5000,
  weather: 5000,
  crops: 5000,
  dimension: 60000
};

const PURPOSE_TTL = {
  survival: 500,
  reflex: 500,
  task: 1000,
  decision: 2000,
  answer: 5000,
  explore: 5000
};

const DEFAULT_TTL = 2000;
/** A partial environment summary may survive up to three game days; moving entities may not. */
const MAX_ENVIRONMENT_TTL = 3 * 20 * 60 * 1000;

function resolveFields(fields) {
  const input = fields === undefined || fields === null ? DEFAULT_FIELDS : Array.isArray(fields) ? fields : [fields];
  const out = [];
  for (const raw of input) {
    const name = String(raw || '').trim();
    if (!name) continue;
    const expanded = FIELD_GROUPS[name] || [name];
    for (const field of expanded) if (!out.includes(field)) out.push(field);
  }
  return out.length ? out : DEFAULT_FIELDS.slice();
}

function normalizeArea(area) {
  if (!area || typeof area !== 'object') return null;
  if (area.min && area.max) {
    return {
      min: { x: Number(area.min.x), y: Number(area.min.y), z: Number(area.min.z) },
      max: { x: Number(area.max.x), y: Number(area.max.y), z: Number(area.max.z) }
    };
  }
  if (Number.isFinite(area.x) && Number.isFinite(area.y) && Number.isFinite(area.z)) {
    return {
      x: Number(area.x),
      y: Number(area.y),
      z: Number(area.z),
      radius: Math.max(0, Number(area.radius) || 16)
    };
  }
  return null;
}

function inArea(position, area) {
  if (!area) return true;
  if (!position || typeof position !== 'object') return true;
  if (area.radius !== undefined) {
    const dx = Number(position.x) - area.x;
    const dy = Number(position.y) - area.y;
    const dz = Number(position.z) - area.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= area.radius;
  }
  return (
    position.x >= area.min.x &&
    position.x <= area.max.x &&
    position.y >= area.min.y &&
    position.y <= area.max.y &&
    position.z >= area.min.z &&
    position.z <= area.max.z
  );
}

function filterByArea(value, area) {
  if (!area || value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.filter((entry) => entry && inArea(entry.position, area));
  }
  if (typeof value === 'object') {
    if (value.position && !inArea(value.position, area)) return null;
    if (value.cells && typeof value.cells === 'object') {
      const cells = {};
      for (const [key, cell] of Object.entries(value.cells)) {
        const [x, y, z] = key.split(',').map(Number);
        if (inArea({ x, y, z }, area)) cells[key] = cell;
      }
      return { ...value, cells };
    }
  }
  return value;
}

function ttlFor(field, purpose, maxAgeMs, fieldTtls, purposeTtls) {
  if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0) return maxAgeMs;
  if (purpose && purposeTtls[purpose] !== undefined) return purposeTtls[purpose];
  return fieldTtls[field] === undefined ? DEFAULT_TTL : fieldTtls[field];
}

/** Turning the camera this much makes the cached crosshair target meaningless. */
const FACING_EPSILON_DEG = 2.0;

/** {yaw, pitch} from a snapshot, or null when the body does not report a facing. */
function facingFrom(snapshot) {
  if (!snapshot) return null;
  const yaw = Number(snapshot.yaw);
  const pitch = Number(snapshot.pitch);
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
  return { yaw, pitch };
}

/** True when the camera moved by more than `epsilon` degrees on either axis. */
function facingChanged(before, after, epsilon = FACING_EPSILON_DEG) {
  if (!before || !after) return false;
  const deltaYaw = Math.abs(((after.yaw - before.yaw + 540) % 360) - 180);
  const deltaPitch = Math.abs(after.pitch - before.pitch);
  return deltaYaw > epsilon || deltaPitch > epsilon;
}

class ObservationCache {
  /**
   * @param {object} deps
   *   body          Body with refresh()/snapshot()
   *   refresh       optional async function (overrides body.refresh)
   *   now           injectable clock
   *   fieldTtls     per-field max age overrides
   *   purposeTtls   per-purpose max age overrides
   *   log
   */
  constructor(deps = {}) {
    this.body = deps.body || null;
    this.refresh = deps.refresh || null;
    this.now = deps.now || (() => Date.now());
    this.fieldTtls = { ...DEFAULT_FIELD_TTL, ...(deps.fieldTtls || {}) };
    this.purposeTtls = { ...PURPOSE_TTL, ...(deps.purposeTtls || {}) };
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.cache = new Map();
    this.revision = 0;
    this.lastSuccessAt = null;
    this.lastError = null;
    this._inflight = null;
    this._lastSnapshot = null;
    this._dimension = undefined;
    this._dead = false;
    this._connected = true;
    this._invalidatedAt = null;
    this._invalidatedReason = null;
  }

  /**
   * @param {object} [request]
   *   fields      name/group or array; defaults to necessary self state
   *   area        {x,y,z,radius} or {min,max}
   *   maxAgeMs    overrides purpose/field TTL for this call
   *   purpose     survival/task/decision/answer/explore (selects a TTL)
   * @returns {Promise<object>}
   */
  async observe(request = {}) {
    const fields = resolveFields(request.fields);
    const area = normalizeArea(request.area);
    const purpose = request.purpose ? String(request.purpose) : null;
    const requestedAt = this.now();
    const currentFacing = facingFrom(this._currentSnapshot());
    const staleFields = fields.filter((field) => {
      const entry = this.cache.get(field);
      if (!entry) return true;
      const ttl = ttlFor(field, purpose, request.maxAgeMs, this.fieldTtls, this.purposeTtls);
      if (requestedAt - entry.observedAt > ttl) return true;
      /**
       * The crosshair target is a *pose* observation: it is valid only for the camera that
       * captured it. TTL alone let `target` stay "fresh" for 250 ms after a 90-degree turn,
       * so a look-then-click sequence could act on what the player was aiming at before.
       */
      if (field === 'target' && entry.facing && currentFacing && facingChanged(entry.facing, currentFacing)) {
        return true;
      }
      return false;
    });

    let refreshResult = null;
    if (staleFields.length > 0 || !this._lastSnapshot) {
      refreshResult = await this._refresh();
    }

    const snapshot = this._lastSnapshot;
    const failed = !snapshot || (refreshResult && refreshResult.ok === false);
    const values = {};
    const unknownFields = [];
    const unavailableFields = [];
    const staleAfter = [];

    /**
     * A refresh returns one /state response, but only the fields this caller asked for are
     * claimed fresh. Other cached fields keep their original observedAt timestamps.
     */
    if (!failed && refreshResult && refreshResult.ok === true) {
      const observedAt = this.lastSuccessAt || requestedAt;
      for (const field of fields) {
        if (UNAVAILABLE_FIELDS.has(field)) continue;
        const raw = snapshot[field];
        if (raw !== undefined) {
          this.cache.set(field, {
            value: raw,
            observedAt,
            revision: this.revision,
            dimension: snapshot.dimension || null,
            // The target is only valid for the camera that captured it; remember the pose.
            facing: field === 'target' ? facingFrom(snapshot) : undefined,
            source: this.body && this.body.kind ? this.body.kind : 'body'
          });
        } else {
          this.cache.delete(field);
        }
      }
    }

    for (const field of fields) {
      const ttl = ttlFor(field, purpose, request.maxAgeMs, this.fieldTtls, this.purposeTtls);
      const entry = this.cache.get(field);
      if (UNAVAILABLE_FIELDS.has(field)) {
        unavailableFields.push(field);
        values[field] = {
          value: null,
          known: false,
          unavailable: true,
          stale: true,
          valid: false,
          observedAt: null,
          ageMs: null,
          revision: null,
          dimension: entry ? entry.dimension : null,
          area,
          source: entry ? entry.source : null
        };
        continue;
      }
      if (!entry) {
        unknownFields.push(field);
        values[field] = {
          value: null,
          known: false,
          unavailable: false,
          stale: true,
          valid: false,
          observedAt: null,
          ageMs: null,
          revision: null,
          dimension: snapshot ? snapshot.dimension || null : null,
          area,
          source: null
        };
        continue;
      }
      const ageMs = Math.max(0, requestedAt - entry.observedAt);
      const facingStale = field === 'target' && entry.facing && currentFacing
        && facingChanged(entry.facing, currentFacing);
      const stale = ageMs > ttl || failed || facingStale;
      if (stale) staleAfter.push(field);
      values[field] = {
        value: filterByArea(entry.value, area),
        known: true,
        unavailable: false,
        stale,
        valid: !stale,
        staleBecause: facingStale ? 'facing-changed' : (ageMs > ttl ? 'age' : (failed ? 'refresh-failed' : null)),
        observedAt: entry.observedAt,
        ageMs,
        revision: entry.revision,
        dimension: entry.dimension,
        area,
        source: entry.source
      };
    }

    return {
      ok: !failed && unknownFields.length === 0 && unavailableFields.length === 0,
      requestedAt,
      revision: this.revision,
      purpose,
      fields: values,
      staleFields: staleAfter,
      unknownFields,
      unavailableFields,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      refresh: refreshResult
    };
  }

  /** Drop all cached fields; used on dimension change, death, disconnect. */
  invalidate(reason = 'manual') {
    this.cache.clear();
    this.revision += 1;
    this._invalidatedAt = this.now();
    this._invalidatedReason = reason;
    this._lastSnapshot = null;
    this.log.debug(`observation cache invalidated: ${reason}`);
    return { revision: this.revision, reason, at: this._invalidatedAt };
  }

  /**
   * The newest snapshot the body can give us.
   *
   * The body polls /state in the background, so its snapshot can be newer than the one this
   * cache last refreshed from - and the camera can have moved since. Prefer it for the facing
   * comparison; fall back to the refresh copy when the body cannot answer.
   */
  _currentSnapshot() {
    try {
      if (this.body && typeof this.body.snapshot === 'function') {
        const snap = this.body.snapshot();
        if (snap) return snap;
      }
    } catch (err) {
      // A body that cannot answer must not break an observation.
    }
    return this._lastSnapshot;
  }

  status() {
    return {
      revision: this.revision,
      cachedFields: [...this.cache.keys()],
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      invalidatedAt: this._invalidatedAt,
      invalidatedReason: this._invalidatedReason,
      dimension: this._dimension
    };
  }

  async _refresh() {
    if (this._inflight) return this._inflight;
    const startedAt = this.now();
    this._inflight = (async () => {
      try {
        if (typeof this.refresh === 'function') {
          const outcome = await this.refresh();
          if (outcome && outcome.ok === false) throw new Error(outcome.error || outcome.reason || 'refresh-failed');
        } else if (this.body && typeof this.body.refreshStrict === 'function') {
          const outcome = await this.body.refreshStrict(true);
          if (!outcome || outcome.ok !== true) {
            throw new Error((outcome && (outcome.error || outcome.reason)) || 'refresh-failed');
          }
        } else if (this.body && typeof this.body.refresh === 'function') {
          await this.body.refresh(true);
        }
      } catch (err) {
        this.lastError = err.message;
        return { ok: false, reason: 'refresh-failed', error: err.message, ms: this.now() - startedAt };
      }
      const snapshot =
        this.body && typeof this.body.snapshot === 'function' ? this.body.snapshot() : null;
      if (!snapshot || snapshot.ready === false) {
        this.lastError = 'snapshot-not-ready';
        return { ok: false, reason: 'snapshot-not-ready', ms: this.now() - startedAt };
      }

      const previousDimension = this._dimension;
      const previousDead = this._dead;
      this._dimension = snapshot.dimension || null;
      this._dead = snapshot.dead === true;
      this._connected = this.body ? this.body.connected !== false : true;
      if (previousDimension !== undefined && previousDimension !== this._dimension) {
        this.invalidate('dimension-change');
      } else if (this._dead && !previousDead) {
        this.invalidate('death');
      } else if (!this._connected) {
        this.lastError = 'disconnected';
        this.invalidate('disconnect');
        return { ok: false, reason: 'disconnected', ms: this.now() - startedAt };
      }

      this._lastSnapshot = snapshot;
      this.revision += 1;
      this.lastSuccessAt = this.now();
      this.lastError = null;
      return { ok: true, revision: this.revision, ms: this.now() - startedAt };
    })().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }
}

module.exports = {
  ObservationCache,
  FIELD_GROUPS,
  UNAVAILABLE_FIELDS,
  DEFAULT_FIELDS,
  DEFAULT_FIELD_TTL,
  PURPOSE_TTL,
  MAX_ENVIRONMENT_TTL,
  FACING_EPSILON_DEG,
  facingFrom,
  facingChanged,
  resolveFields,
  normalizeArea,
  filterByArea,
  ttlFor
};
