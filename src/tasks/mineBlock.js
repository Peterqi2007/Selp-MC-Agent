'use strict';

/**
 * MineBlockTask: collect stone, cobblestone, ores, sand - anything that is not a log
 * (P0-PLAN §6.3).
 *
 * Two behaviours this class owns, both of which the plan calls out explicitly:
 *
 *   - **A pickaxe is a hard prerequisite, and its absence is a clear failure.** P0 does
 *     not craft, so "need a pickaxe to mine stone" is the honest answer. Mining stone
 *     bare-handed destroys the block and drops nothing, so *pretending* to succeed here
 *     would be the worst possible behaviour: an empty bag and a "done" message.
 *   - **A probe shaft when nothing is visible.** Standing on the surface with no exposed
 *     stone is the normal case, not an error; digging down a few blocks is how a player
 *     starts a mine, and every block dug is itself a harvest.
 *
 * `canHarvest()` also consults the mod knowledge base, which is the safety gate for
 * unknown modded blocks: a Create machine that happens to match "ore" in its name should
 * not be eaten by the agent.
 */

const { HarvestTask } = require('./harvest');
const { sleep } = require('../core/movement');
const {
  TOOL_TIERS,
  blockDrop,
  requiredTierFor,
  harvestLevel,
  tierRank
} = require('../world/items');
const { manMadeReason } = require('../world/safety');
const { toolPlan, chooseTool } = require('../world/toolPolicy');

/** Blocks that are never worth breaking, whatever the request said. */
const NEVER_MINE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'end_portal', 'nether_portal', 'command_block', 'structure_block', 'water', 'lava', 'air', 'cave_air']);

/**
 * Tie-break order among pickaxes of the SAME harvest level.
 *
 * Gold mines stone-class blocks fastest by a wide margin, so among equals it wins; then comes
 * the durability ladder. Only used to choose between tools that are already equivalent for the
 * block in front of us.
 */
const SPEED_PREFERENCE = ['golden', 'netherite', 'diamond', 'iron', 'stone', 'wooden'];

class MineBlockTask extends HarvestTask {
  /**
   * @param {object} ctx
   * @param {object} options { block: string|string[], count, searchRadius, probeShaft }
   */
  constructor(ctx, options = {}) {
    const names = [].concat(options.block || []);
    super(ctx, {
      ...options,
      name: options.name || 'mine',
      description: options.description || `mine ${options.count || 8}x ${names.join('/')}`,
      timeoutMs: options.timeoutMs || 180000
    });
    this.blockNames = names.map(bare);
    /** Dig a short shaft down when the surface has nothing exposed. */
    this.probeShaftEnabled = options.probeShaft !== false;
    this.shaftDepth = options.shaftDepth || 4;
    /**
     * Structural anti-masonry heuristics (see `extraSafetyCheck`).
     *
     * OFF by default, because they are tuned for a *shared* server and strict enough to
     * refuse ordinary work: an exposed stone face in a cliff, or a patch of surface dirt,
     * trips them - and digging dirt is a normal thing to ask for. The name-based gate in
     * `canHarvest` stays on regardless; it costs nothing and never blocks legitimate digging.
     * The offline wall test turns this on explicitly.
     */
    const cfgSafety = (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.safety) || {};
    this.strictMining = options.strictMining === undefined ? cfgSafety.strictMining === true : options.strictMining === true;
  }

  isTarget(name) {
    const target = bare(name);
    return this.blockNames.some((n) => n === target);
  }

  countsAsHarvest(itemName) {
    const item = bare(itemName);
    // Ore blocks drop the raw item ("raw_iron", "diamond"), stone drops "cobblestone",
    // and dirt-like blocks drop themselves. So a harvest counts when the item is either
    // the block itself or the block's usual drop.
    return this.blockNames.some((n) => n === item || blockDrop(n) === item);
  }

  /** Safety gate: refuse blocks the body, the mod knowledge, or our pickaxe says are unmineable. */
  canHarvest(block) {
    const name = bare(block && block.name);
    if (NEVER_MINE.has(name)) return false;

    /**
     * Hardness gate, evaluated per *block* rather than once per task.
     *
     * A task can be asked for several names at once (`stone` and `iron_ore`): the loop must
     * take the stone it can reach while leaving the iron ore alone, instead of either refusing
     * everything or smashing ore with a wooden pickaxe for no drop.
     */
    const plan = toolPlan(name, this.inventory.items());
    if (!plan.ok) {
      if (!this.toolBlocked) this.toolBlocked = [];
      if (!this.toolBlocked.includes(name)) {
        this.toolBlocked.push(name);
        this.log.debug(`cannot mine ${name}: ${plan.reason}`);
      }
      return false;
    }

    const world = this.ctx.world;
    if (world && typeof world.canMine === 'function' && !world.canMine(block)) return false;
    const mods = this.ctx.mods;
    if (mods && typeof mods.isMineable === 'function' && !mods.isMineable(block && block.name)) return false;
    return true;
  }

  /**
   * Hold the right pickaxe before swinging.
   *
   * Overrides the base "ask the body for a tool of the right kind" with the explicit choice
   * made in `toolFor()`: highest harvest level first, then the fastest among equals. A block
   * with no requirement returns null and nothing is equipped.
   */
  async equipFor(block) {
    const item = this.toolFor(block);
    if (!item) return false;
    const body = this.body;
    if (!body || typeof body.equip !== 'function') return false;
    return body.equip(item).catch(() => false);
  }

  /**
   * Structural safety: a mineable block must look like terrain, not like masonry.
   *
   * The name gate above catches planks and bricks by family. This one catches what a name
   * cannot: a player who built out of `stone` or `deepslate` - the two most common building
   * materials there are. Three structural signals, in order of strength:
   *
   *   1. anything built touching the block -> it is part of a construction
   *   2. a uniform course of identical blocks -> a wall or a floor
   *   3. **an exposed face plus matching neighbours** -> a built surface
   *
   * Rule 3 is the one that catches a wall's *upper* courses, where the block below is also
   * stone: a natural vein is buried (no air neighbours), while a wall has air beside it and
   * repeats itself along its length. `null` means "outside the scan", never "air" - treating
   * unknown as air made every sparse test map look like an open field.
   */
  extraSafetyCheck(block) {
    if (!this.strictMining) return null;
    const world = this.ctx.world;
    if (!world || typeof world.blockAtAbsolute !== 'function' || !block.position) return null;
    const at = (dx, dy, dz) => {
      const found = world.blockAtAbsolute({
        x: Math.floor(block.position.x) + dx,
        y: Math.floor(block.position.y) + dy,
        z: Math.floor(block.position.z) + dz
      });
      return found ? found.name : null;
    };
    const target = bare(block.name);
    const isAir = (name) => name !== null && /^air$|^cave_air$|^void_air$/.test(bare(name));

    // 1. Anything built touching the block means it belongs to a construction.
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const family = manMadeReason(at(dx, dy, dz));
      if (family) return `it is part of a construction (a ${family} is touching it)`;
    }

    const horizontal = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(([dx, dy, dz]) => at(dx, dy, dz));
    const sameType = horizontal.filter((name) => name !== null && bare(name) === target).length;

    // 2. A uniform course is a wall or a floor. `>= 3` rather than all four, because a
    //    two-block-wide wall only has two horizontal neighbours to begin with.
    if (sameType >= 3) {
      return `it is a uniform course of ${target} (${sameType}/4 neighbours identical), like a wall or a floor`;
    }

    const exposed = horizontal.some((name) => isAir(name)) || isAir(at(0, 1, 0));
    if (!exposed) return null; // buried rock: a vein, not a structure

    // 3. Exposed and repeating itself along the surface: a built face.
    if (sameType >= 2) {
      return `it looks like a built surface: exposed to air and repeating ${target} along it`;
    }

    /**
     * 4. Exposed at all, and not the block we are standing on.
     *
     * This is the rule that catches a wall's *end* columns, where nothing repeats: an
     * exposed block is either part of something someone placed, or a cave face we have no
     * business rearranging. The one exemption is the block directly beneath the bot - that is
     * how a probe shaft starts, and digging straight down cannot damage a structure the bot
     * is standing on top of.
     */
    const here = this.position;
    const directlyBelow =
      here &&
      Math.floor(here.x) === Math.floor(block.position.x) &&
      Math.floor(here.z) === Math.floor(block.position.z) &&
      Math.floor(here.y) - 1 === Math.floor(block.position.y);
    if (directlyBelow) return null;

    return `it is an exposed ${target} face - refusing to reshape terrain that might be built`;
  }

  unitName() {
    return this.blockNames.join('/') || 'blocks';
  }

  async run() {
    /**
     * ---- prerequisite: the right pickaxe, chosen from what we are carrying ----
     *
     * Two steps, in this order:
     *   1. take the best pickaxe in the inventory (highest harvest level, then the fastest);
     *   2. check it against the block's hardness requirement from `BLOCK_TIER_REQUIREMENT`.
     *
     * Failing here rather than on the first swing matters: the walk happens before the dig, so
     * discovering "my pickaxe is too weak" after walking 40 blocks wastes the whole trip - and
     * a block broken below its tier drops *nothing*, so pressing on would fill the log with
     * "mined 8/8" while the bag stays empty.
     *
     * The requirement is per *block*, so a task carrying several names (stone + iron ore) is
     * gated on the strictest one it could actually meet, and re-checked per block in
     * `toolFor()`.
     */
    const requirements = this.blockNames
      .map((name) => ({ name, tier: requiredTierFor(name) }))
      .filter((entry) => entry.tier);

    if (requirements.length) {
      const pick = this.bestPickaxe();
      if (!pick) {
        const need = requirements.map((r) => `${r.name} needs ${r.tier}`).join(', ');
        return this.fail(`need a pickaxe to mine ${this.blockNames.join('/')} (${need}; P0 does not craft one)`);
      }

      // Only name the blocks the pickaxe genuinely cannot handle.
      const blocked = requirements.filter((r) => harvestLevel(r.tier) > harvestLevel(pick.tier));
      const reachable = requirements.filter((r) => harvestLevel(r.tier) <= harvestLevel(pick.tier));

      if (!reachable.length) {
        return this.fail(
          `pickaxe too weak for ${blocked.map((b) => b.name).join('/')} ` +
            `(have ${pick.tier} ${pick.name.replace(/^minecraft:/, '')}, need ${blocked[0].tier})`
        );
      }
      if (blocked.length) {
        // Some targets are out of reach, the rest are not: mine what we can, and say what was
        // skipped instead of failing the whole task.
        this.log.warn(
          `${blocked.map((b) => b.name).join('/')} needs ${blocked[0].tier} but we have ${pick.tier} - skipping those`
        );
        this.skippedForTool = blocked.map((b) => b.name);
      }
      this.chosenTool = pick;
    }

    // ---- no exposed targets: start a shaft --------------------------------
    if (this.probeShaftEnabled && !this.findTargets().length) {
      this.log.info(`no ${this.unitName()} exposed, digging a probe shaft`);
      await this.probeShaft();
    }

    return super.run();
  }

  /**
   * The best pickaxe we are carrying: highest harvest level, then fastest among equals.
   *
   * Read from the inventory snapshot rather than asked of the body, so the choice is visible
   * in a log line and identical on every body (mineflayer, mock, client mod).
   *
   * @returns {{name:string, tier:string}|null}
   */
  bestPickaxe() {
    let best = null;
    for (const stack of this.inventory.items()) {
      const name = bare(stack.name);
      const match = name.match(/^([a-z_]+)_pickaxe$/);
      if (!match) continue;
      const tier = match[1];
      if (!TOOL_TIERS.includes(tier)) continue;
      const level = harvestLevel(tier);
      // Among the same harvest level prefer gold (fastest) then netherite/diamond (durable).
      const speed = SPEED_PREFERENCE.indexOf(tier);
      if (
        !best ||
        level > best.level ||
        (level === best.level && speed !== -1 && (best.speed === -1 || speed < best.speed))
      ) {
        best = { name: stack.name, tier, level, speed, count: stack.count };
      }
    }
    return best;
  }

  /**
   * Which tool to hold for this block, or null to leave the hand as it is.
   *
   * A block with no requirement (dirt, sand, gravel, modded blocks we have no opinion about)
   * is dug bare-handed per the operator's rule; `null` means "do not bother equipping
   * anything", not "empty the hand".
   */
  toolFor(block) {
    if (!block) return null;
    // The shared policy: pickaxe for tiered blocks, shovel for dirt, axe for logs, shears for
    // leaves - and nothing at all when the block has no tool requirement and none is carried.
    return chooseTool(block.name, this.inventory.items());
  }

  /** Blocks this task had to skip because the pickaxe is too weak (for the log and the panel). */
  requiredTier() {
    const tiers = this.blockNames.map((n) => requiredTierFor(n)).filter(Boolean);
    if (!tiers.length) return null;
    // The strictest requirement among the targets, as a tier index (kept for compatibility).
    return Math.max(...tiers.map((t) => tierRank(t)));
  }

  /**
   * Dig straight down a few blocks looking for the target.
   *
   * Deliberately shallow (4 by default) and it stops as soon as a target appears. A deep
   * shaft would need ladder placement to get back out, and placing blocks is not one of
   * the three P0 primitives.
   */
  async probeShaft() {
    const world = this.ctx.world;
    let advanced = false;

    for (let step = 0; step < this.shaftDepth; step += 1) {
      if (this.cancelled) break;
      const here = this.position;
      if (!here) break;

      const feet = world.blockAtAbsolute({ x: Math.floor(here.x), y: Math.floor(here.y), z: Math.floor(here.z) });
      if (feet && !['air', 'cave_air', 'water', 'lava'].includes(bare(feet.name))) {
        const ok = await this.breakBlock(feet);
        if (ok) advanced = true;
      }
      await sleep(200);

      if (this.findTargets().length) break;
    }

    if (!advanced) this.log.debug('probe shaft found nothing and dug nothing');
    return advanced;
  }
}

/**
 * Kept as a thin alias so existing callers (and the offline test) keep working; the
 * authoritative table now lives in `src/world/items.js` next to the other item knowledge,
 * where MockBody can share it.
 */
function dropOf(blockName) {
  return blockDrop(blockName);
}

/** Strip a namespace: "minecraft:stone" -> "stone". */
function bare(name) {
  if (!name) return '';
  const idx = String(name).indexOf(':');
  return idx === -1 ? String(name) : String(name).slice(idx + 1);
}

module.exports = { MineBlockTask, dropOf, NEVER_MINE };
