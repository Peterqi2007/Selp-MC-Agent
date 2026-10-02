'use strict';

/**
 * Body: the "躯体" abstraction — everything about *how* the agent affects and senses
 * a world, separated from *what* it wants to do.
 *
 * Why this exists
 * ---------------
 * The original agent was welded to mineflayer: tasks called `bot.dig()`,
 * `nav.goto()`, `bot.inventory` directly. That is fine until we need a second way to
 * play — specifically a real Forge client, because Forge 1.20.1 servers reject
 * vanilla-protocol clients (mineflayer) with "This server has mods that require Forge
 * to be installed on the client".
 *
 * So the decision layer (`brain.js`, `tasks/`, `survival/`) must talk to a Body, and
 * there are two implementations:
 *
 *   MineflayerBody  - headless, vanilla protocol, many instances, ~1s startup
 *   ClientModBody   - a real Forge client + control mod, works on modded servers
 *   MockBody        - scripted tests for the decision layer, no game at all
 *
 * Contract notes
 * --------------
 * - Every method is async and must settle. Implementations own their own timeouts:
 *   a Body must never hang the brain.
 * - `snapshot()` is the perception entry point: one flat, serialisable object.
 *   Bodies that can only update on a tick (a real client) implement it by returning
 *   the most recent cached snapshot rather than blocking.
 * - Nothing in this interface mentions mineflayer or Minecraft classes. If you need
 *   to add something here, add it in terms the decision layer understands.
 */

/** Error thrown when a Body cannot perform a request at all (not a normal failure). */
class BodyUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BodyUnavailableError';
    this.reason = 'unavailable';
  }
}

/**
 * @typedef {object} BlockRef  A block the decision layer wants to act on.
 * @property {string} name     e.g. "minecraft:oak_log" or "create:cogwheel"
 * @property {{x:number,y:number,z:number}} position  integer block coords
 *
 * @typedef {object} EntityRef
 * @property {number|string} id
 * @property {string} name
 * @property {{x:number,y:number,z:number}} position
 * @property {number} distance
 * @property {string} kind     "hostile" | "passive" | "player" | "other"
 *
 * @typedef {object} StateSnapshot
 * @property {boolean} ready
 * @property {string} body              "mineflayer" | "clientmod" | "mock"
 * @property {{x:number,y:number,z:number}} position
 * @property {string} dimension
 * @property {number} health
 * @property {number} food
 * @property {boolean} onGround
 * @property {{isDay:boolean, timeOfDay:number, day:number}} time
 * @property {{raining:boolean, thundering:boolean}} weather
 * @property {Object<string,number>} inventory   item name -> total count
 * @property {number} emptySlots
 * @property {string|null} heldItem
 * @property {BlockRef|null} standingOn
 * @property {number} lightLevel
 * @property {EntityRef[]} hostiles
 * @property {EntityRef[]} nearbyItems          dropped item entities
 * @property {string[]} players
 */

/**
 * Base class documenting the contract. Implementations override what they support and
 * may leave the rest to throw `BodyUnavailableError` — the decision layer treats that
 * as "this body cannot do that" and degrades, rather than crashing.
 */
class Body {
  /** @param {object} cfg loaded agent config */
  constructor(cfg) {
    this.cfg = cfg;
    this.kind = 'abstract';
  }

  // ------------------------------------------------------------- lifecycle

  /** @returns {Promise<void>} resolves once the body can act (spawned / in world) */
  async connect() {
    throw new BodyUnavailableError('connect() not implemented');
  }

  async disconnect() {
    throw new BodyUnavailableError('disconnect() not implemented');
  }

  /** @returns {boolean} */
  get isReady() {
    return false;
  }

  // ------------------------------------------------------------ perception

  /**
   * Latest world/self state. Must not block: return the cached snapshot.
   * @returns {StateSnapshot|null}
   */
  snapshot() {
    return null;
  }

  /**
   * Block at an absolute position, or null when unknown/not loaded.
   * @param {{x:number,y:number,z:number}} position
   * @returns {BlockRef|null}
   */
  blockAt(position) {
    return null;
  }

  /**
   * Nearest matching blocks within `maxDistance`.
   * @param {string[]} names  exact names, e.g. ['minecraft:iron_ore']
   * @param {{maxDistance?:number, count?:number}} [options]
   * @returns {BlockRef[]} sorted by distance
   */
  findBlocks(names, options = {}) {
    return [];
  }

  /**
   * Blocks whose name satisfies a predicate. Bodies with a cheap registry should
   * implement this (it is how "any log" is expressed without enumerating species).
   * @param {(name:string)=>boolean} predicate
   * @param {{maxDistance?:number, count?:number}} [options]
   * @returns {BlockRef[]}
   */
  findBlocksMatching(predicate, options = {}) {
    return [];
  }

  /** @returns {EntityRef[]} hostile mobs within maxDistance, nearest first */
  hostiles(maxDistance = 16) {
    return [];
  }

  /** @returns {EntityRef[]} dropped item entities within maxDistance */
  itemDrops(maxDistance = 8) {
    return [];
  }

  // ---------------------------------------------------------------- action

  /**
   * Walk to a position.
   * @param {{x:number,y:number,z:number}} position
   * @param {{range?:number, timeoutMs?:number}} [options]
   * @returns {Promise<boolean>} true when within `range` of the target
   */
  async moveTo(position, options = {}) {
    throw new BodyUnavailableError('moveTo() not implemented');
  }

  /**
   * Break a block. Implementation is responsible for tool selection.
   * @returns {Promise<boolean>} true when the block is gone
   */
  async dig(block, options = {}) {
    throw new BodyUnavailableError('dig() not implemented');
  }

  /**
   * Place an item from the inventory against a reference block face.
   * @returns {Promise<boolean>}
   */
  async place(itemName, referenceBlock, faceVector) {
    throw new BodyUnavailableError('place() not implemented');
  }

  /** @returns {Promise<boolean>} equipped the best matching item, if any */
  async equip(itemName) {
    throw new BodyUnavailableError('equip() not implemented');
  }

  /** @returns {Promise<boolean>} consumed something edible */
  async eat(itemName) {
    throw new BodyUnavailableError('eat() not implemented');
  }

  /** @returns {Promise<boolean>} attacked until the target died or we gave up */
  async attack(entity, options = {}) {
    throw new BodyUnavailableError('attack() not implemented');
  }

  /**
   * Send a chat message or command. `/login ...` goes through here, which is how the
   * agent authenticates on AuthMe-protected servers.
   * @returns {Promise<boolean>}
   */
  async chat(message) {
    throw new BodyUnavailableError('chat() not implemented');
  }

  /** Look at a point (used before interacting). */
  async lookAt(position) {
    throw new BodyUnavailableError('lookAt() not implemented');
  }

  /** Cancel anything in flight. Must be synchronous and safe to call repeatedly. */
  interrupt(reason) {
    /* optional */
  }

  // -------------------------------------------------------------- optional

  /**
   * Crafting is OPTIONAL: it needs recipe knowledge that not every body has.
   *
   *   mineflayer - full recipe database via prismarine-recipe
   *   mock       - a small table, enough to exercise the planner
   *   clientmod  - the real client knows every recipe, including modded ones
   *
   * A body that cannot craft returns `{ ok: false, reason: '...' }` rather than
   * throwing, and `supportsCrafting` is false so the planner can degrade instead of
   * looping on an impossible goal.
   *
   * @returns {Promise<{ok:boolean, produced?:number, reason?:string}>}
   */
  async craft(itemName, count = 1) {
    return { ok: false, reason: `${this.kind} body cannot craft` };
  }

  /** @returns {boolean} whether craft() can do anything useful */
  get supportsCrafting() {
    return false;
  }

  /**
   * Cost of digging a block, in the body's own units (mineflayer: ms).
   * Optional; used by the planner to skip hopeless targets.
   */
  canMine(block) {
    return !!block;
  }

  /**
   * Open a container and move items. Optional (used by the stash task).
   *
   * `supportsDeposit` exists for the same reason as `supportsCrafting`: the planner has to be
   * able to ask "can this body do that at all?" and skip the goal, instead of retrying a call
   * that is guaranteed to fail. The client-mod body has no container API yet, so on a real
   * server the deposit goal is now skipped rather than burning a retry-and-quarantine cycle
   * on every planning tick.
   */
  async depositInto(containerBlock, itemNames) {
    return { ok: false, reason: `${this.kind} body cannot deposit` };
  }

  /** @returns {boolean} whether depositInto() can do anything useful */
  get supportsDeposit() {
    return false;
  }

  /**
   * Can this body hunt?
   *
   * The control mod reports hostile mobs but not passive animals, so there is nothing to hunt
   * on a client-mod body - and the old HuntTask, written against mineflayer entities, threw
   * `Cannot read properties of undefined (reading 'entity')` when the planner asked it to.
   * Asking first turns a crash loop into a skipped goal.
   */
  get supportsHunting() {
    return false;
  }

  // ------------------------------------------------------------- diagnostics

  /** Free-form status for logs and the HTTP API. */
  describe() {
    return { kind: this.kind, ready: this.isReady };
  }
}

/** True when an error means "this body cannot do that", as opposed to a normal failure. */
function isUnavailable(err) {
  return !!err && (err instanceof BodyUnavailableError || err.reason === 'unavailable');
}

module.exports = { Body, BodyUnavailableError, isUnavailable };
