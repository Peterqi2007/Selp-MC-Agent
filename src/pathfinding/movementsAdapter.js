'use strict';

/**
 * MovementsAdapter: the movement model A* searches over.
 *
 * `mineflayer-pathfinder`'s A* only ever touches the world through one method -
 * `movements.getNeighbors(node)` (astar.js:85) - so we can reuse its solver, its heap and
 * its path reconstruction while replacing the movement rules entirely. That is the whole
 * reason the plan chose this route (P0-PLAN §3.2): the expensive, well-tested part is
 * reused and only the part we can actually get wrong is ours.
 *
 * DESIGN BIAS: CONSERVATIVE.
 * It is far better to return `noPath` than to hand the walker a route the bot cannot
 * execute. A wrong path costs minutes of wandering and looks like a movement bug; a
 * clean `noPath` is instant and lets the task pick a different target. So the neighbour
 * set here is deliberately narrow:
 *
 *   - no digging through obstacles (P0 has `allowDig: false`)
 *   - no scaffolding/block placing
 *   - no parkour, no 2-block jumps
 *   - never enter lava, fire, cactus or powder snow
 *   - never enter an UNKNOWN cell (outside the mod's scan grid)
 *
 * Documented as "P0 conservatism" in the plan; widening it is a P1 concern.
 */

const { v3, toPathVec } = require('./vec3util');
const { isPassableBlock } = require('./clientWorldAdapter');

/**
 * Costs are relative, not physical. They encode "prefer this over that", which is all A*
 * needs. Tuned so the planner prefers a flat walk over a drop, and a drop over a climb.
 */
const COST = {
  WALK: 1.0,
  STEP_UP: 1.5,
  DROP_BASE: 1.0,
  DROP_PER_BLOCK: 0.5,
  /**
   * Twice a flat walk (operator's rule, 2026-10-14: "水域移动需增加代价，但不要惩罚太大，
   * 相较于平地 *2 即可").
   *
   * It has to be *more* than a walk or the planner would treat a river as open ground and
   * never look at the bridge; it must not be so much more that a short swim is refused in
   * favour of an enormous detour - crossing water is implemented and the client does it
   * correctly, so the model should use it when it is genuinely the better route. Note the
   * honest consequence: with 2.0 a narrow river is still cheaper to swim than to walk around
   * to a distant bridge, and that is intended - preferring the bridge needs a finer model of
   * water and bank height, not a bigger constant.
   */
  SWIM: 2.0,
  CLIMB: 2.0
};

/** Maximum fall the model will plan for. Minecraft survives 3; we plan up to 3. */
const MAX_DROP = 3;

/**
 * How a move is performed, tagged onto every neighbour A* returns.
 *
 * This exists because the *client* executes a leg by holding "forward" and jumping whenever
 * it collides (ClientActions.WalkTo), which means "walk" and "get over that step" are the
 * same command with very different odds of working. Without the tag the walker cannot tell
 * "the route is blocked" from "the route needs a jump I cannot make", and the bot answers a
 * wall by jumping at it again - see WaypointWalker's jump streak.
 */
const MOVE = {
  WALK: 'walk',
  STEP_UP: 'step-up',
  DROP: 'drop',
  JUMP: 'jump',
  SWIM: 'swim',
  CLIMB: 'climb'
};

/** Moves that only work if the client can actually jump: these are the ones that get stuck. */
const JUMPY_MOVES = new Set([MOVE.JUMP, MOVE.STEP_UP]);

class MovementsAdapter {
  /**
   * @param {ClientWorldAdapter} world
   * @param {object} [options] { allowSwim, allowDig, allowClimb, log }
   */
  constructor(world, options = {}) {
    this.world = world;
    this.log = options.log || { debug() {} };
    /** Liquid is traversable when true. P0 default on. */
    this.allowSwim = options.allowSwim !== false;
    /** P0 keeps digging OFF - a conservative model beats an optimistic one. */
    this.allowDig = options.allowDig === true;
    this.allowClimb = options.allowClimb !== false;
    /** Hard ceiling on neighbours considered per node, so a pathological map cannot stall A*. */
    this.maxNeighbors = options.maxNeighbors || 64;
    /**
     * Cells this trip has already failed to enter, as hashes.
     *
     * The block scan is a snapshot and it is sometimes wrong about the *client's* ability to
     * execute a move: a step under a low ceiling, a gap the bot falls into instead of
     * jumping. When that happens, replanning produces the identical route with the identical
     * move, forever. Remembering the cell that failed is what turns "jump at the wall again"
     * into "route around it" - the navigator owns this set and empties it per trip.
     *
     * @type {Set<string>|null}
     */
    this.avoid = options.avoid || null;
  }

  /** Refuse a cell for the rest of the trip. */
  avoidCell(position) {
    if (!this.avoid) this.avoid = new Set();
    if (!position) return null;
    const key = v3(position.x, position.y, position.z).hash;
    this.avoid.add(key);
    return key;
  }

  /** Forget every avoided cell (a new trip, or the avoided route turned out to be the only one). */
  clearAvoid() {
    if (this.avoid) this.avoid.clear();
  }

  /**
   * Block lookup for the movement model.
   *
   * Mirrors mineflayer's `Movements.getBlock(pos, dx, dy, dz)` shape so this object is a
   * drop-in for anything written against the plugin's model.
   */
  getBlock(position, dx = 0, dy = 0, dz = 0) {
    const base = toPathVec(position);
    if (!base) return null;
    return this.world.blockAt(v3(Math.floor(base.x) + dx, Math.floor(base.y) + dy, Math.floor(base.z) + dz));
  }

  /** Can the bot occupy this cell (feet at `pos`)? Unknown or solid means no. */
  canStandAt(pos) {
    const feet = this.world.blockAt(pos);
    if (feet === null) return false; // unknown: refuse
    if (feet.dangerous) return false;
    if (feet.solid) return false;
    // A liquid you can swim in is fine; lava is not.
    if (feet.liquid && !this.allowSwim) return false;

    const head = this.world.blockAt(v3(pos.x, pos.y + 1, pos.z));
    if (head === null) return false;
    if (head.dangerous) return false;
    if (head.solid) return false;
    return true;
  }

  /**
   * Is there ground to stand on directly below?
   *
   * The floor must not merely be *solid*: a fence, a cobblestone wall, a pane or a closed door
   * is solid and gives you nothing to stand on. Treating those as floors is what let the
   * planner route the bot "up onto" a fence - a move whose only possible outcome is jumping
   * at it until something times out. See `NOT_STANDABLE` in clientWorldAdapter.js.
   */
  hasFloorAt(pos) {
    const below = this.world.blockAt(v3(pos.x, pos.y - 1, pos.z));
    if (below === null) return false;
    return below.solid && below.standable !== false;
  }

  /**
   * Neighbours of a node.
   *
   * IMPORTANT: A* reads the traversal cost off the neighbour object itself -
   * `const gFromThisNode = node.g + neighborData.cost` (astar.js:96). A plain position
   * without `cost` yields NaN and the search silently degrades, so every returned vector
   * carries its own cost.
   *
   * @param {import('./vec3util').PathVec3} node a block position
   * @returns {Array<import('./vec3util').PathVec3 & {cost:number, move:string}>}
   */
  getNeighbors(node) {
    const here = toPathVec(node);
    if (!here) return [];
    const out = [];
    const push = (dx, dy, dz, move) => {
      if (out.length >= this.maxNeighbors) return;
      const candidate = v3(here.x + dx, here.y + dy, here.z + dz);
      if (!this.world.inGrid(candidate)) return; // unknown terrain: refuse
      if (!this.canStandAt(candidate)) return;
      /**
       * A cell this trip already failed to walk into is not a move.
       *
       * Checked before the cost work, and before the man-made guard, because this is a
       * *learned* refusal: the map says the move is fine, the client disagreed. It is the
       * only mechanism that stops A* from re-deriving the route that just failed.
       */
      if (this.avoid && this.avoid.has(candidate.hash)) return;
      /**
       * Never route over anything a player built.
       *
       * Enforced here rather than only at the destination, because the *path* is what does
       * the damage: crossing a plank floor, a carpet or a farm treads on someone's base even
       * when the destination was innocent. The guard is optional, so a world without one
       * (the offline tests) behaves exactly as before.
       */
      if (typeof this.world.veto === 'function' && this.world.veto(candidate)) return;
      candidate.cost = this.getMoveCost(here, candidate);
      candidate.move = move;
      out.push(candidate);
    };

    // ---- horizontal moves ------------------------------------------------
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const flat = v3(here.x + dx, here.y, here.z + dz);

      // 1. walk straight across
      const flatBlock = this.world.blockAt(flat);
      if (flatBlock && !flatBlock.solid && this.canStandAt(flat) && this.hasFloorAt(flat)) {
        push(dx, 0, dz, flatBlock.liquid ? MOVE.SWIM : MOVE.WALK);
        continue;
      }

      // 2. step up one block (headroom above must be clear)
      const stepUp = v3(flat.x, flat.y + 1, flat.z);
      if (this.world.inGrid(stepUp) && this.canStandAt(stepUp)) {
        // The step block must be something you can actually stand on top of - not a fence.
        if (this.hasFloorAt(stepUp)) {
          push(dx, 1, dz, MOVE.STEP_UP);
          continue;
        }
      }

      // 3. drop down 1..MAX_DROP blocks onto solid ground
      for (let drop = 1; drop <= MAX_DROP; drop += 1) {
        const below = v3(here.x + dx, here.y - drop, here.z + dz);
        if (!this.world.inGrid(below)) break;
        const landing = this.world.blockAt(below);
        if (landing === null) break; // unknown below: stop probing
        if (landing.dangerous) break;
        if (this.canStandAt(below) && this.hasFloorAt(below)) {
          push(dx, -drop, dz, MOVE.DROP);
          break;
        }
        if (landing.solid) break; // blocked: no further fall in this column
      }

      // 4. jump a 1-block gap (both sides standable)
      if (flatBlock === null) continue; // unknown: do not gamble
      const far = v3(here.x + dx * 2, here.y, here.z + dz * 2);
      if (this.world.inGrid(far) && this.canStandAt(far) && this.hasFloorAt(far) && !flatBlock.solid) {
        push(dx * 2, 0, dz * 2, MOVE.JUMP);
      }
    }

    // ---- vertical moves --------------------------------------------------
    // Swim upward through liquid (cheap) so a bot in water can reach the surface.
    if (this.allowSwim) {
      const above = v3(here.x, here.y + 1, here.z);
      if (this.world.inGrid(above)) {
        const block = this.world.blockAt(above);
        if (block && block.liquid) push(0, 1, 0, MOVE.SWIM);
      }
      const below = v3(here.x, here.y - 1, here.z);
      if (this.world.inGrid(below)) {
        const block = this.world.blockAt(below);
        if (block && block.liquid && !block.lava) push(0, -1, 0, MOVE.SWIM);
      }
    }

    // Climbable blocks (ladders/vines) allow straight up movement.
    if (this.allowClimb) {
      const at = this.world.blockAt(here);
      if (at && at.climbable) {
        const up = v3(here.x, here.y + 1, here.z);
        if (this.world.inGrid(up) && this.canStandAt(up)) push(0, 1, 0, MOVE.CLIMB);
      }
    }

    return out;
  }

  /**
   * Cost of moving between two adjacent nodes.
   *
   * A* only needs a lower bound that is consistent with the heuristic, but the shape
   * matters: climbing and swimming must cost more than walking or the planner will
   * prefer them and produce silly routes.
   */
  getMoveCost(from, to) {
    const a = toPathVec(from);
    const b = toPathVec(to);
    if (!a || !b) return COST.WALK;

    const dy = b.y - a.y;
    const target = this.world.blockAt(b);
    const inLiquid = !!(target && target.liquid);
    const onClimbable = !!(this.world.blockAt(a) && this.world.blockAt(a).climbable);

    if (inLiquid) return COST.SWIM;
    if (onClimbable && dy > 0) return COST.CLIMB;
    if (dy > 0) return COST.STEP_UP;
    if (dy < 0) return COST.DROP_BASE + Math.abs(dy) * COST.DROP_PER_BLOCK;
    return COST.WALK;
  }

  /**
   * The interface A* actually calls. This is what makes the adapter a legal `movements`
   * argument to `new AStar(start, movements, goal, ...)`.
   */
  getNeighborsOf(node) {
    return this.getNeighbors(node);
  }
}

module.exports = { MovementsAdapter, COST, MAX_DROP, MOVE, JUMPY_MOVES };
