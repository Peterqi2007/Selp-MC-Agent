'use strict';

/**
 * MockBody: a scripted, in-memory world so the decision layer can be tested without a
 * game at all.
 *
 * This is the payoff of the Body abstraction. It lets us answer questions that were
 * previously untestable without a live Minecraft server, e.g.:
 *
 *   - does `tasks/` actually work against the contract, or does it secretly depend on
 *     mineflayer specifics?
 *   - does the wood -> planks -> sticks -> pickaxe chain terminate on a world with
 *     only 2 trees?
 *   - what happens when the inventory is full, or every hostile is adjacent?
 *
 * The world model is deliberately crude: a flat plane with a configurable list of
 * blocks, unlimited movement, instant digging. Crude is fine — we are testing the
 * *decision* logic, not physics.
 */

const { Body, BodyUnavailableError } = require('./body');
const { isLog, planksFor, isFood, foodScore, blockDrop, blockDropCount, findScaffold } = require('../world/items');
const { chooseTool } = require('../world/toolPolicy');

class MockBody extends Body {
  /**
   * @param {object} cfg
   * @param {object} [options]
   * @param {object} [options.log]
   * @param {Array<{name:string, position:{x:number,y:number,z:number}}>} [options.blocks]
   * @param {Object<string,number>} [options.inventory] initial inventory (short names)
   * @param {number} [options.health]
   * @param {number} [options.food]
   * @param {boolean} [options.night]
   * @param {Array<{name:string,position:object,kind?:string}>} [options.entities]
   * @param {{name:string,position:object}} [options.crosshair] target under the crosshair
   * @param {Object<string,number>} [options.recipes] item name -> result count
   * @param {number} [options.actionDelayMs] simulated latency per action
   */
  constructor(cfg, options = {}) {
    super(cfg);
    this.kind = 'mock';
    this.log = options.log || { debug() {}, info() {}, warn() {}, error() {} };
    this.actionDelayMs = options.actionDelayMs === undefined ? 0 : options.actionDelayMs;

    this.world = new Map();
    for (const block of options.blocks || []) {
      this.world.set(key(block.position), { name: normalize(block.name), position: { ...block.position } });
    }

    this.inventory = {};
    for (const [name, count] of Object.entries(options.inventory || {})) {
      this.inventory[normalize(name)] = count;
    }

    this.state = {
      health: options.health === undefined ? 20 : options.health,
      food: options.food === undefined ? 20 : options.food,
      night: !!options.night,
      timeOfDay: options.night ? 15000 : 1000,
      day: 1
    };
    this.entities = (options.entities || []).map((e, i) => ({
      id: e.id === undefined ? i + 1 : e.id,
      name: e.name,
      position: { ...e.position },
      kind: e.kind || 'hostile',
      alive: true
    }));

    /**
     * TACZ gun fixtures (COMBAT-PLAN v3): [{item, gunId?, type, magazine, dummy?, shotsToKill?}].
     * The snapshot exposes them in the client's `guns` shape; shoot() burns magazine and
     * kills the target once the tally reaches `shotsToKill` (default 2) - raise it to
     * model multi-burst fights.
     */
    this.guns = (options.guns || []).map((gun) => ({
      item: normalize(gun.item),
      gunId: gun.gunId ? normalize(gun.gunId) : normalize(gun.item),
      type: gun.type || 'unknown',
      magazine: Number.isFinite(gun.magazine) ? gun.magazine : 0,
      dummy: Number.isFinite(gun.dummy) ? gun.dummy : 0,
      shotsToKill: Number.isFinite(gun.shotsToKill) ? gun.shotsToKill : 2
    }));
    /** Players visible to the body: [{name, id?, position, health?}] (objects, like the client). */
    this.players = (options.players || [{ name: 'MockPlayer', id: 99, position: { x: 3, y: 64, z: 3 } }]).map(
      (p, i) => ({
        name: p.name,
        id: p.id === undefined ? 100 + i : p.id,
        position: { ...p.position },
        health: p.health === undefined ? 20 : p.health,
        alive: true
      })
    );
    /** Gun-fire test state: calls, damage tallies, scripted outcomes. */
    this.shootCalls = [];
    this.retreatCalls = [];
    this.lastAction = null;
    this.shootBlocked = false;
    this.shootUnavailable = false;
    this._shotTally = new Map();

    /** What the crosshair points at, for exercising aimed mining without a client. */
    this.crosshair = options.crosshair ? { ...options.crosshair, position: { ...options.crosshair.position } } : null;
    /** Crop fixtures with growth stages: [{name, position, age, maxAge}] */
    this.crops = (options.crops || []).map((c) => ({ ...c, position: { ...c.position } }));

    /**
     * Fishing simulation: a bobber that takes `bitesAfter` refreshes to bite, and a rod
     * with `rodUses` casts before it breaks. Mirrors the real client's /state.fishing.
     */
    this.fishing = { cast: false, biting: false, countdown: 0 };
    this.bitesAfter = options.bitesAfter === undefined ? 2 : options.bitesAfter;
    this.rodUses = options.rodUses === undefined ? 20 : options.rodUses;

    this.position = { ...(options.start || { x: 0, y: 64, z: 0 }) };
    this.ready = false;

    /** Recipes the mock "server" knows: item -> {ingredients:{name:count}, result:count, needsTable?:boolean} */
    this.recipes = options.recipes || DEFAULT_RECIPES;
    /** Dropped items waiting to be picked up: [{name, count, position}] */
    this.drops = [];
    /** Action log, so tests can assert on behaviour rather than internals. */
    this.history = [];
    /** Counters for assertions. */
    this.stats = { dug: 0, placed: 0, moved: 0, ate: 0, attacked: 0, chats: [], crafted: {} };
  }

  get isReady() {
    return this.ready;
  }

  async connect() {
    this.ready = true;
    this.history.push({ action: 'connect' });
  }

  /** Same contract as ClientModBody.refresh: hand back the current snapshot. */
  async refresh() {
    await this._delay();
    if (this.fishing.cast && !this.fishing.biting) {
      this.fishing.countdown -= 1;
      if (this.fishing.countdown <= 0) this.fishing.biting = true;
    }
    return this.snapshot();
  }

  async disconnect() {
    this.ready = false;
    this.history.push({ action: 'disconnect' });
  }

  // ------------------------------------------------------------ perception

  snapshot() {
    if (!this.ready) return null;
    const inv = { ...this.inventory };
    const emptySlots = Math.max(0, 36 - Object.keys(inv).length);
    const here = this.position;
    return {
      ready: true,
      body: this.kind,
      position: { ...here },
      dimension: 'minecraft:overworld',
      health: this.state.health,
      food: this.state.food,
      onGround: true,
      time: { isDay: !this.state.night, timeOfDay: this.state.timeOfDay, day: this.state.day },
      weather: { raining: false, thundering: false },
      inventory: inv,
      emptySlots,
      heldItem: this.held || null,
      standingOn: this.blockAt({ x: Math.floor(here.x), y: Math.floor(here.y) - 1, z: Math.floor(here.z) }),
      lightLevel: this.state.night ? 3 : 15,
      hostiles: this.hostiles(16),
      nearbyItems: this.itemDrops(8),
      guns: this.guns.map((gun) => ({
        item: gun.item,
        gunId: gun.gunId,
        type: gun.type,
        magazine: gun.magazine,
        dummy: gun.dummy,
        bullets: gun.magazine > 0 || gun.dummy > 0
      })),
      players: this.players.filter((p) => p.alive !== false).map((p) => ({
        name: p.name,
        id: p.id,
        position: { ...p.position },
        health: p.health,
        distance: +Math.hypot(p.position.x - here.x, p.position.y - here.y, p.position.z - here.z).toFixed(2)
      })),
      target: this.crosshair,
      crops: this.crops,
      fishing: this.fishing.cast ? { cast: true, biting: this.fishing.biting } : null,
      heldDurability:
        this.held && this.rodUses !== null && /fishing_rod/.test(this.held)
          ? { remaining: this.rodUses, max: this.rodUses }
          : null,
      /**
       * The scripted world as the client-mod scan would report it: a flat `"x,y,z" -> name`
       * table. Without this, any skill that reads through `snapshot.blocks.cells` (mining's
       * cellAt, for one) sees air everywhere - which is how an offline mine run "mined" the
       * same ore a million times without ever removing the block.
       */
      blocks: {
        cells: Object.fromEntries([...this.world].map(([k, entry]) => [k, entry.name]))
      }
    };
  }

  /** Cast / reel the rod, exactly as the client's single `use` does. */
  async useItem() {
    await this._delay();
    this.history.push({ action: 'useItem', cast: this.fishing.cast });
    if (!this.rodUses || !Object.keys(this.inventory).some((n) => /fishing_rod$/.test(n))) {
      return false;
    }
    if (!this.fishing.cast) {
      this.rodUses -= 1;
      if (this.rodUses <= 0) {
        for (const name of Object.keys(this.inventory)) {
          if (/fishing_rod$/.test(name)) delete this.inventory[name];
        }
        this.rodUses = 0;
      }
      this.fishing = { cast: true, biting: false, countdown: this.bitesAfter };
      return true;
    }
    // Reeling: a bite fills the bag, an early reel just ends the cast.
    if (this.fishing.biting) {
      this.inventory['minecraft:cod'] = (this.inventory['minecraft:cod'] || 0) + 1;
    }
    this.fishing = { cast: false, biting: false, countdown: 0 };
    return true;
  }

  /** Mock crosshair raycast: returns the configured target, if any. */
  async targetBlock() {
    await this._delay();
    return this.crosshair ? { ...this.crosshair, position: { ...this.crosshair.position } } : null;
  }

  /** Mock "look around": the fixture does not rotate, it just reports its crosshair. */
  async sweepLook() {
    await this._delay();
    return this.crosshair ? { ...this.crosshair, position: { ...this.crosshair.position } } : null;
  }

  blockAt(position) {
    if (!position) return null;
    const entry = this.world.get(key(position));
    return entry ? { name: entry.name, position: { ...entry.position } } : null;
  }

  /**
   * Mock plan preview: the scripted world always walks in a straight line, so the preview
   * is a straight-line summary. Exists so `!route plan` and its tests do not need a real
   * client; the real planning belongs to ClientModBody.plan.
   */
  async plan(position) {
    if (!position) return { ok: false, status: 'bad-target', reason: 'no target given', waypoints: 0, distance: 0, nodes: 0, path: [] };
    const dist = distance(this.position, position);
    return {
      ok: true,
      status: 'success',
      reason: 'mock world: every walk is a straight line',
      waypoints: 1,
      distance: +dist.toFixed(1),
      nodes: 1,
      edits: 0,
      path: [{ x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) }]
    };
  }

  findBlocks(names, options = {}) {
    const set = new Set(names.map(normalize));
    return this.findBlocksMatching((n) => set.has(n), options);
  }

  findBlocksMatching(predicate, options = {}) {
    const maxDistance = options.maxDistance || 32;
    const count = options.count || 32;
    const out = [];
    for (const entry of this.world.values()) {
      if (!predicate(entry.name)) continue;
      const d = distance(this.position, entry.position);
      if (d > maxDistance) continue;
      out.push({ name: entry.name, position: { ...entry.position }, distance: +d.toFixed(2) });
    }
    out.sort((a, b) => a.distance - b.distance);
    return out.slice(0, count);
  }

  hostiles(maxDistance = 16) {
    return this.entities
      .filter((e) => e.alive && e.kind === 'hostile')
      .map((e) => ({ id: e.id, name: e.name, position: { ...e.position }, distance: +distance(this.position, e.position).toFixed(2), kind: 'hostile', _entity: e }))
      .filter((e) => e.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);
  }

  itemDrops(maxDistance = 8) {
    return this.drops
      .map((d, i) => ({ id: `drop-${i}`, name: d.name, position: { ...d.position }, distance: +distance(this.position, d.position).toFixed(2), kind: 'item', _drop: d }))
      .filter((d) => d.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);
  }

  // ---------------------------------------------------------------- action

  async moveTo(position, options = {}) {
    await this._delay();
    this.position = { ...position };
    this.stats.moved += 1;
    this._pickUpDrops();
    const range = options.range === undefined ? 1 : options.range;
    return distance(this.position, position) <= Math.max(range, 1.5);
  }

  async dig(block, options = {}) {
    await this._delay();
    if (!block || !block.position) return false;
    const k = key(block.position);
    const entry = this.world.get(k);
    if (!entry) return false;
    // Unknown-to-vanilla blocks behave like an unbreakable tech block.
    if (options.mineable === false) return false;
    this.world.delete(k);
    this.stats.dug += 1;
    this.history.push({ action: 'dig', name: entry.name, position: block.position });
    /**
     * Push the block's real DROP, not the block (`stone` -> `cobblestone`).
     *
     * This matters more than it looks: a task that counts broken blocks instead of
     * collected items passes against a mock that drops the block itself and then fails
     * in a real game, where stone yields cobblestone and bare-handed mining yields
     * nothing at all. Keeping the mock's drop table honest is what makes the offline
     * test above actually predictive.
     */
    const dropName = options.drop === undefined ? blockDrop(entry.name) : options.drop;
    if (dropName) {
      this.drops.push({ name: dropName, count: blockDropCount(entry.name), position: this._landingSpot(entry.position) });
    }
    this._pickUpDrops();
    return true;
  }

  /**
   * Mock tunnel: walk the planned waypoint list in order, clearing the foot/head cell of
   * each step the way the real client's dig-while-walking controller does, and report the
   * cells it dug so the mining ledger can be checked offline.
   *
   * The real controller digs whatever blocks the way and jumps real one-block steps; the
   * mock is a teleport, but the *accounting shape* is identical, which is what the skill's
   * tunnel rung depends on.
   */
  async tunnel(waypoints = [], options = {}) {
    await this._delay();
    const dugCells = [];
    /**
     * Target protection (collection plan §6.2): a protected block in the corridor's way
     * stops the run *before* it is destroyed, exactly like the real controller.
     */
    const protect = new Set(
      ((options.protect && options.protect.blocks) || []).map((name) => bare(String(name)))
    );
    for (const wp of waypoints) {
      const cell = { x: Math.floor(wp.x), y: Math.floor(wp.y), z: Math.floor(wp.z) };
      for (const c of [cell, { x: cell.x, y: cell.y + 1, z: cell.z }]) {
        const entry = this.world.get(key(c));
        if (!entry) continue;
        // Carved corridor cells are stored as explicit `air` entries; the real controller
        // only digs solid blocks, so the mock must not report an air cell as dug either.
        if (/(^|:)air$/.test(String(entry.name))) continue;
        if (protect.size && protect.has(bare(entry.name))) {
          return {
            ok: false,
            reason: 'target_requires_acquisition',
            cell: { ...c },
            block: entry.name,
            dugCells
          };
        }
        this.world.delete(key(c));
        this.stats.dug += 1;
        this.history.push({ action: 'dig', name: entry.name, position: { ...c } });
        dugCells.push({ ...c });
      }
      this.position = { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
      this._pickUpDrops();
    }
    return { ok: true, reason: null, cell: null, block: null, dugCells };
  }

  /**
   * Mock pillar: rise `count` blocks the way the client controller does (jump + place the
   * support block under the feet).
   *
   * The mock enforces the constraints that make offline pillar scenarios predictive
   * (plan §5.4.1: "不能仅靠模拟器直接修改 y 判成功"):
   *   - a scaffold block must exist in the inventory, and one is consumed per hop;
   *   - the two cells above the head a jump needs (feet+2, feet+3) must be clear;
   *   - the block is really written into the world at the old feet cell.
   * "Just add 1 to y" hid three separate live bugs; it is not good enough any more.
   */
  async pillar(count = 1) {
    await this._delay();
    const steps = Math.max(1, Math.min(64, Math.floor(Number(count) || 1)));
    let done = 0;
    let reason = null;
    const placedCells = [];
    for (let i = 0; i < steps; i += 1) {
      const here = {
        x: Math.floor(this.position.x),
        y: Math.floor(this.position.y),
        z: Math.floor(this.position.z)
      };
      for (const dy of [2, 3]) {
        const overhead = this.world.get(key({ x: here.x, y: here.y + dy, z: here.z }));
        if (overhead && !/air$/.test(String(overhead.name))) {
          reason = 'no-headroom';
          break;
        }
      }
      if (reason) break;
      const scaffold = findScaffold(this.inventory);
      if (!scaffold) {
        reason = 'no_material';
        break;
      }
      /**
       * The real controller places whatever is held. "Holding the wrong thing" is exactly
       * how a live run ends up eating bread and then trying to pillar with it (2026-10-08),
       * so the mock refuses instead of silently consuming from the bag.
       */
      if (!this.held || String(this.held).replace(/^[a-z0-9_]+:/, '') !== String(scaffold).replace(/^[a-z0-9_]+:/, '')) {
        reason = 'not-holding-scaffold';
        break;
      }
      this.inventory[scaffold] -= 1;
      if (this.inventory[scaffold] <= 0) delete this.inventory[scaffold];
      this.world.set(key(here), { name: scaffold, position: { ...here } });
      this.position = { ...this.position, y: this.position.y + 1 };
      placedCells.push({ ...here, block: scaffold });
      this.history.push({ action: 'place', name: scaffold, position: { ...here } });
      this.stats.placed += 1;
      done += 1;
    }
    this.stats.pillared = (this.stats.pillared || 0) + done;
    this.history.push({ action: 'pillar', steps: done, placed: placedCells });
    return { ok: done === steps, reason: done === steps ? null : reason || 'hop-failed', steps: done, placedCells };
  }

  async place(itemName, referenceBlock) {
    await this._delay();
    const name = normalize(itemName);
    if (!this.inventory[name]) return false;
    // Accept both a block object and a bare position, the same way ClientModBody does.
    const reference = referenceBlock && referenceBlock.position ? referenceBlock.position : referenceBlock;
    if (!reference) return false;
    this.inventory[name] -= 1;
    if (this.inventory[name] <= 0) delete this.inventory[name];
    const target = {
      x: reference.x,
      y: reference.y + 1,
      z: reference.z
    };
    this.world.set(key(target), { name, position: target });
    this.stats.placed += 1;
    this.history.push({ action: 'place', name, position: target });
    return true;
  }

  async equip(itemName) {
    const name = normalize(itemName);
    if (!this.inventory[name]) return false;
    this.held = name;
    return true;
  }

  async equipForBlock(block) {
    const items = Object.keys(this.inventory).map((name) => ({ name, count: this.inventory[name] }));
    const chosen = chooseTool(block && block.name, items);
    if (!chosen) return false;
    this.held = normalize(chosen);
    return true;
  }

  async dropItem(itemName, count = 1) {
    await this._delay();
    const name = normalize(itemName);
    const have = this.inventory[name] || 0;
    if (!have) return false;
    const dropped = Math.min(have, Math.max(1, Math.floor(count)));
    this.inventory[name] -= dropped;
    if (this.inventory[name] <= 0) delete this.inventory[name];
    this.history.push({ action: 'drop', name, count: dropped });
    return true;
  }

  /** Right-click a block: recorded so skills can be asserted, no world mutation. */
  async useOn(position, options = {}) {
    await this._delay();
    if (!position) return false;
    this.history.push({ action: 'use', position: { ...position }, face: options.face || null });
    /**
     * Simulate the two world-changing uses the farm skill verifies: hoeing dirt into
     * farmland, and planting a seed on it. The real client only answers `ok` for the
     * interaction attempt, so both are judged by the world/inventory afterwards - the mock
     * has to actually change them or the offline farm test would "pass" a no-op.
     */
    const target = this.world.get(key(position));
    const name = target ? target.name : null;
    const bareName = name ? name.replace(/^[a-z0-9_]+:/, '') : null;
    if (bareName && /^(dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium)$/.test(bareName)) {
      this.world.set(key(position), { name: 'farmland', position: { ...position } });
      return true;
    }
    if (bareName === 'farmland') {
      const seeds = Object.keys(this.inventory).find((item) => /_seeds$/.test(item));
      if (seeds && this.inventory[seeds] > 0) {
        this.inventory[seeds] -= 1;
        if (this.inventory[seeds] <= 0) delete this.inventory[seeds];
        // The crop sits on top; the farmland below it stays farmland.
        this.world.set(key({ x: position.x, y: position.y + 1, z: position.z }), {
          name: 'wheat',
          position: { x: position.x, y: position.y + 1, z: position.z }
        });
        this.crops.push({ name: 'minecraft:wheat', position: { x: position.x, y: position.y + 1, z: position.z }, age: 0, maxAge: 7 });
        this.history.push({ action: 'plant', name: seeds, position: { ...position } });
      }
      return true;
    }
    return true;
  }

  async equipBest(kind) {
    const candidate = Object.keys(this.inventory).find((n) => n.endsWith(`_${kind}`));
    return candidate ? this.equip(candidate) : false;
  }

  async equipArmor() {
    return false;
  }

  async consume(itemName) {
    await this._delay();
    const food = itemName ? normalize(itemName) : this._bestFood();
    if (!food || !this.inventory[food]) return false;
    this.inventory[food] -= 1;
    if (this.inventory[food] <= 0) delete this.inventory[food];
    // Eating holds the food in the main hand, exactly like the real client. Skills that
    // dig after a meal must put their tool back first (live bug 2026-10-08).
    this.held = food;
    this.state.food = Math.min(20, this.state.food + 6);
    this.stats.ate += 1;
    this.history.push({ action: 'eat', name: food });
    return true;
  }

  async attack(entity, options = {}) {
    await this._delay();
    const target = entity && entity._entity ? entity._entity : entity;
    if (!target || !target.alive) return false;
    this.stats.attacked += 1;
    target.alive = false;
    this.history.push({ action: 'attack', name: target.name });
    return true;
  }

  /**
   * Mock gunfire: one bounded burst at an entity (COMBAT-PLAN v3 shape).
   *
   * Mirrors the client contract: returns ok/done and lands the verdict on `lastAction`
   * ({reason, shots, blocked}). `shootBlocked`/`shootUnavailable` script the cover and
   * no-TACZ outcomes; the magazine burns per shot and the target dies when the tally
   * crosses `shotsToKill`.
   */
  async shoot(entity, options = {}) {
    await this._delay();
    const id = entity && (entity.id !== undefined ? entity.id : entity._entity && entity._entity.id);
    const target =
      (this.entities || []).find((e) => e.id === id) ||
      (this.players || []).find((p) => p.id === id) ||
      null;
    const maxShots = Math.max(1, Math.floor(options.maxShots || 6));
    this.shootCalls.push({ target: id, maxShots });
    const finish = (ok, reason, shots = 0) => {
      this.lastAction = { action: 'shoot', ok, reason, shots, blocked: reason === 'blocked' };
      return ok;
    };
    if (this.shootUnavailable) return finish(false, 'tacz_unavailable');
    if (this.shootBlocked) return finish(false, 'blocked');
    if (!target || !target.alive) return finish(false, 'target_gone');
    const gun = this.guns.find((g) => normalize(g.item) === normalize(this.held || ''));
    if (!gun) return finish(false, 'not_a_gun');
    const available = gun.magazine + gun.dummy;
    if (available <= 0) return finish(false, 'no_ammo');
    const shots = Math.min(maxShots, available);
    const fromMagazine = Math.min(shots, gun.magazine);
    gun.magazine -= fromMagazine;
    gun.dummy -= shots - fromMagazine;
    this.stats.attacked += 1;
    const tally = (this._shotTally.get(target.id) || 0) + shots;
    this._shotTally.set(target.id, tally);
    if (tally >= gun.shotsToKill) target.alive = false;
    this.history.push({ action: 'shoot', name: target.name, shots });
    return finish(true, null, shots);
  }

  /** Mock retreat: record the call and take one step directly away from the target. */
  async retreatFrom(entity, options = {}) {
    await this._delay();
    const id = entity && (entity.id !== undefined ? entity.id : entity._entity && entity._entity.id);
    const target =
      (this.entities || []).find((e) => e.id === id) ||
      (this.players || []).find((p) => p.id === id) ||
      null;
    this.retreatCalls.push({ target: id, ms: options.ms || 3000, fire: options.fire === true });
    if (target && target.position) {
      const dx = this.position.x - target.position.x;
      const dz = this.position.z - target.position.z;
      const length = Math.hypot(dx, dz) || 1;
      this.position = { ...this.position, x: this.position.x + dx / length, z: this.position.z + dz / length };
    }
    this.history.push({ action: 'retreat', target: target && target.id });
    return true;
  }

  /** Mock stop: record that the caller cancelled a continuous action. */
  async stop() {
    this.stopCalls = (this.stopCalls || 0) + 1;
    this.history.push({ action: 'stop' });
    return true;
  }

  async chat(message) {
    this.stats.chats.push(message);
    this.history.push({ action: 'chat', message });
    return true;
  }

  async lookAt() {
    return true;
  }

  interrupt() {
    this.history.push({ action: 'interrupt' });
  }

  /**
   * Mock-only: crafting, so the craft chain can be tested.
   * Emulates enough of the real behaviour: consumes ingredients, produces the result,
   * fails when ingredients are missing (so prerequisite resolution gets exercised).
   */
  async craft(itemName, count = 1) {
    await this._delay();
    const name = normalize(itemName);
    const recipe = this.recipes[name];
    if (!recipe) return { ok: false, reason: `no recipe for ${name}` };
    const proceed = { manufactured: 0 };
    for (let i = 0; i < count; i += 1) {
      const missing = [];
      for (const [ing, need] of Object.entries(recipe.ingredients)) {
        const have = this.inventory[normalize(ing)] || 0;
        if (have < need) missing.push(`${ing}x${need}`);
      }
      if (missing.length) {
        if (proceed.manufactured === 0) return { ok: false, reason: `missing ${missing.join(', ')}` };
        break;
      }
      for (const [ing, need] of Object.entries(recipe.ingredients)) {
        const key2 = normalize(ing);
        this.inventory[key2] -= need;
        if (this.inventory[key2] <= 0) delete this.inventory[key2];
      }
      this.inventory[name] = (this.inventory[name] || 0) + recipe.result;
      proceed.manufactured += recipe.result;
      this.stats.crafted[name] = (this.stats.crafted[name] || 0) + recipe.result;
    }
    this.history.push({ action: 'craft', name, produced: proceed.manufactured });
    return { ok: true, produced: proceed.manufactured };
  }

  /** The mock can craft against its own small recipe table. */
  get supportsCrafting() {
    return true;
  }

  /** The scripted world has entities, so hunting can be exercised offline. */
  get supportsHunting() {
    return true;
  }

  describe() {
    return {
      kind: this.kind,
      ready: this.ready,
      position: { ...this.position },
      blocks: this.world.size,
      entities: this.entities.filter((e) => e.alive).length,
      inventory: { ...this.inventory },
      stats: this.stats
    };
  }

  // ---------------------------------------------------------------- helpers

  /** Advance time; tests can flip a mock world into night mid-run. */
  setNight(night) {
    this.state.night = !!night;
    this.state.timeOfDay = night ? 15000 : 1000;
  }

  addBlocks(list) {
    for (const block of list) {
      this.world.set(key(block.position), { name: normalize(block.name), position: { ...block.position } });
    }
  }

  addEntity(entity) {
    this.entities.push({
      id: entity.id === undefined ? this.entities.length + 1 : entity.id,
      name: entity.name,
      position: { ...entity.position },
      kind: entity.kind || 'hostile',
      alive: true
    });
  }

  addInventory(name, count) {
    const key2 = normalize(name);
    this.inventory[key2] = (this.inventory[key2] || 0) + count;
  }

  _bestFood() {
    // The food tables work on bare names ("cooked_beef"), but the mock stores
    // namespaced keys ("minecraft:cooked_beef") like a real registry would.
    const candidates = Object.keys(this.inventory)
      .filter((n) => isFood(bare(n), null))
      .sort((a, b) => foodScore(bare(b)) - foodScore(bare(a)));
    return candidates[0] || null;
  }

  _pickUpDrops() {
    const remaining = [];
    for (const drop of this.drops) {
      if (distance(this.position, drop.position) <= 2) {
        const k = normalize(drop.name);
        this.inventory[k] = (this.inventory[k] || 0) + (drop.count || 1);
        this.history.push({ action: 'pickup', name: k });
      } else {
        remaining.push(drop);
      }
    }
    this.drops = remaining;
  }

  /**
   * Where a broken block's drop ends up: it falls to the first solid block below.
   *
   * Without this the mock leaves drops hovering in mid-air, so chopping a five-block trunk
   * produced drops four blocks up that no walk can reach - and a test asserting "the log
   * really entered the inventory" failed against a world where that was physically
   * impossible. Real drops fall; the mock should too, or it stops being predictive.
   *
   * The world model is sparse (only explicitly added blocks exist), so if there is no solid
   * block below within a reasonable depth the drop simply stays where the block was.
   */
  _landingSpot(position) {
    const x = Math.floor(position.x);
    const z = Math.floor(position.z);
    for (let y = Math.floor(position.y); y > Math.floor(position.y) - 64; y -= 1) {
      const below = this.world.get(key({ x, y: y - 1, z }));
      if (!below) continue;
      if (/air|cave_air|void_air|water|_leaves$/.test(bare(below.name))) continue;
      return { x, y, z };
    }
    return { ...position };
  }

  async _delay() {
    if (this.actionDelayMs > 0) await new Promise((r) => setTimeout(r, this.actionDelayMs));
    if (!this.ready) throw new BodyUnavailableError('mock body is not connected');
  }
}

/** Recipe table used when a test does not supply one (mirrors vanilla essentials). */
const DEFAULT_RECIPES = {
  'minecraft:oak_planks': { ingredients: { 'minecraft:oak_log': 1 }, result: 4 },
  'minecraft:spruce_planks': { ingredients: { 'minecraft:spruce_log': 1 }, result: 4 },
  'minecraft:birch_planks': { ingredients: { 'minecraft:birch_log': 1 }, result: 4 },
  'minecraft:stick': { ingredients: { 'minecraft:oak_planks': 2 }, result: 4 },
  'minecraft:crafting_table': { ingredients: { 'minecraft:oak_planks': 4 }, result: 1 },
  'minecraft:wooden_pickaxe': { ingredients: { 'minecraft:oak_planks': 3, 'minecraft:stick': 2 }, result: 1, needsTable: true },
  'minecraft:stone_pickaxe': { ingredients: { 'minecraft:cobblestone': 3, 'minecraft:stick': 2 }, result: 1, needsTable: true },
  'minecraft:stone_sword': { ingredients: { 'minecraft:cobblestone': 2, 'minecraft:stick': 1 }, result: 1, needsTable: true },
  'minecraft:furnace': { ingredients: { 'minecraft:cobblestone': 8 }, result: 1, needsTable: true },
  'minecraft:chest': { ingredients: { 'minecraft:oak_planks': 8 }, result: 1, needsTable: true },
  'minecraft:torch': { ingredients: { 'minecraft:coal': 1, 'minecraft:stick': 1 }, result: 4 }
};

function key(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function normalize(name) {
  if (!name) return '';
  return name.includes(':') ? name : `minecraft:${name}`;
}

/** Strip the namespace: "minecraft:cooked_beef" -> "cooked_beef". */
function bare(name) {
  if (!name) return '';
  const idx = name.indexOf(':');
  return idx === -1 ? name : name.slice(idx + 1);
}

module.exports = { MockBody, DEFAULT_RECIPES, normalize, bare };
