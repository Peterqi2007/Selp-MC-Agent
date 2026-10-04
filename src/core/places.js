'use strict';

/**
 * Places: the named nouns the operator and the model can point at - areas and routes.
 *
 * numen's "look -> plan -> act" model (docs/look-plan-act.md) keeps three durable nouns:
 * area, route and design. This is the first two, in the smallest shape that pays for itself:
 *
 *   - **area**  a named set of blocks (box / point / radius around here). Used by permission
 *               rules (`area:home`) and by the operator to say "this patch, not that one".
 *   - **route** a named list of waypoints plus the last plan the agent computed for it. A
 *               plan is a *query* (no walking: `navigator.plan`), and `route go` re-plans
 *               from where the bot actually stands, compares the result with the stored plan,
 *               and refuses to walk a promise the world has invalidated. Our movement model
 *               never digs or bridges (`allowDig: false`), so a plan is walk-only by
 *               construction - the "commitment" is that the route was walkable when planned.
 *
 * Stored as JSON under runtime/ so it survives restarts and is inspectable from outside,
 * matching the memory/state convention the panel already reads.
 */

const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_POINTS = 64;
const MAX_PARTS = 32;

function toBlock(position) {
  return {
    x: Math.floor(Number(position.x)),
    y: Math.floor(Number(position.y)),
    z: Math.floor(Number(position.z))
  };
}

function inBox(part, pos) {
  const from = part.from;
  const to = part.to;
  return (
    pos.x >= Math.min(from.x, to.x) &&
    pos.x <= Math.max(from.x, to.x) &&
    pos.y >= Math.min(from.y, to.y) &&
    pos.y <= Math.max(from.y, to.y) &&
    pos.z >= Math.min(from.z, to.z) &&
    pos.z <= Math.max(from.z, to.z)
  );
}

function partContains(part, pos) {
  if (!part || !pos) return false;
  if (part.type === 'box') return inBox(part, pos);
  if (part.type === 'point') {
    const at = part.at;
    return pos.x === at.x && pos.y === at.y && pos.z === at.z;
  }
  if (part.type === 'radius') {
    const at = part.at;
    const r = Number(part.r) || 0;
    return Math.abs(pos.x - at.x) <= r && Math.abs(pos.y - at.y) <= r && Math.abs(pos.z - at.z) <= r;
  }
  return false;
}

function describePart(part) {
  if (part.type === 'box') {
    return `box ${part.from.x},${part.from.y},${part.from.z} .. ${part.to.x},${part.to.y},${part.to.z}`;
  }
  if (part.type === 'point') return `point ${part.at.x},${part.at.y},${part.at.z}`;
  if (part.type === 'radius') return `around ${part.at.x},${part.at.y},${part.at.z} r=${part.r}`;
  return part.type || '?';
}

class Places {
  /**
   * @param {object} cfg loaded agent config (uses cfg.root)
   * @param {object} [options] { log, file }
   */
  constructor(cfg, options = {}) {
    this.log = options.log || { debug() {}, warn() {} };
    this.file = options.file || path.resolve(cfg.root, 'runtime/places.json');
    this.data = { areas: {}, routes: {} };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = {
          areas: parsed.areas && typeof parsed.areas === 'object' ? parsed.areas : {},
          routes: parsed.routes && typeof parsed.routes === 'object' ? parsed.routes : {}
        };
      }
    } catch (err) {
      this.log.warn(`places: could not read ${this.file} (${err.message}) - starting empty`);
      this.data = { areas: {}, routes: {} };
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (err) {
      this.log.warn(`places: could not write ${this.file}: ${err.message}`);
      return false;
    }
  }

  static validName(name) {
    return NAME_RE.test(String(name || ''));
  }

  // ------------------------------------------------------------------ areas

  /** @returns {{ok:boolean, reason?:string, area?:object}} */
  addArea(name, part) {
    if (!Places.validName(name)) return { ok: false, reason: 'area names are letters/digits/_/- (max 32)' };
    const area = this.data.areas[name] || { name, kind: 'area', parts: [], createdAt: Date.now() };
    if (area.parts.length >= MAX_PARTS) return { ok: false, reason: `an area holds at most ${MAX_PARTS} parts` };
    area.parts.push(part);
    area.updatedAt = Date.now();
    this.data.areas[name] = area;
    this.save();
    return { ok: true, area };
  }

  area(name) {
    return this.data.areas[name] || null;
  }

  listAreas() {
    return Object.values(this.data.areas).map((area) => ({
      name: area.name,
      parts: area.parts.length,
      description: area.parts.map(describePart).join(' | ')
    }));
  }

  deleteArea(name) {
    const had = !!this.data.areas[name];
    delete this.data.areas[name];
    if (had) this.save();
    return had;
  }

  /** Is a block position inside the named area? Unknown areas answer false. */
  areaContains(name, position) {
    const area = this.data.areas[name];
    if (!area || !position) return false;
    const pos = toBlock(position);
    return area.parts.some((part) => partContains(part, pos));
  }

  /** Names of every area containing the position (used by permission rules). */
  areasContaining(position) {
    return Object.keys(this.data.areas).filter((name) => this.areaContains(name, position));
  }

  // ----------------------------------------------------------------- routes

  /**
   * Append a waypoint (creating the route on first use).
   * @returns {{ok:boolean, reason?:string, route?:object}}
   */
  addRoutePoint(name, position) {
    if (!Places.validName(name)) return { ok: false, reason: 'route names are letters/digits/_/- (max 32)' };
    const route = this.data.routes[name] || { name, kind: 'route', points: [], createdAt: Date.now() };
    if (route.points.length >= MAX_POINTS) return { ok: false, reason: `a route holds at most ${MAX_POINTS} waypoints` };
    route.points.push(toBlock(position));
    route.updatedAt = Date.now();
    this.data.routes[name] = route;
    this.save();
    return { ok: true, route };
  }

  route(name) {
    return this.data.routes[name] || null;
  }

  setRoutePlan(name, plan) {
    const route = this.data.routes[name];
    if (!route) return false;
    route.plan = plan;
    route.updatedAt = Date.now();
    this.save();
    return true;
  }

  recordWalk(name, walk) {
    const route = this.data.routes[name];
    if (!route) return false;
    route.walks = (route.walks || []).slice(-9);
    route.walks.push(walk);
    route.updatedAt = Date.now();
    this.save();
    return true;
  }

  listRoutes() {
    return Object.values(this.data.routes).map((route) => ({
      name: route.name,
      points: route.points.length,
      target: route.points[route.points.length - 1] || null,
      planned: route.plan ? route.plan.status : null,
      walks: (route.walks || []).length
    }));
  }

  deleteRoute(name) {
    const had = !!this.data.routes[name];
    delete this.data.routes[name];
    if (had) this.save();
    return had;
  }

  /** Compact view for `observe()` - names and coordinates, no full part lists. */
  summary(limit = 12) {
    return {
      areas: this.listAreas()
        .slice(0, limit)
        .map((a) => ({ name: a.name, parts: a.parts })),
      routes: this.listRoutes()
        .slice(0, limit)
        .map((r) => ({ name: r.name, target: r.target }))
    };
  }
}

module.exports = { Places, describePart, partContains };
