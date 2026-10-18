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
 * Soil/sand/gravel family matching.
 *
 * `!mine dirt` must work on a modded server, where the ground is as likely to be
 * `biomeswevegone:lush_grass_block` or `byg:peaty_dirt` as vanilla `dirt`. Matching the
 * requested name exactly meant "no dirt available nearby" while standing on dirt. The
 * families below match on name tokens, so `dirt` also accepts `coarse_dirt`, `rooted_dirt`
 * and any `*_dirt`; `grass_block` accepts modded `*_grass_block`, `podzol`, `mycelium`.
 */
const SOIL_TOKENS = '(dirt|grass_block|podzol|mycelium|mud|moss_block|soil)';
const TERRAIN_FAMILIES = {
  dirt: new RegExp(`(^|_)${SOIL_TOKENS}(_|$)`),
  grass_block: new RegExp(`(^|_)${SOIL_TOKENS}(_|$)`),
  coarse_dirt: new RegExp(`(^|_)${SOIL_TOKENS}(_|$)`),
  rooted_dirt: new RegExp(`(^|_)${SOIL_TOKENS}(_|$)`),
  sand: /(^|_)(sand|red_sand)(_|$)/,
  gravel: /(^|_)(gravel)(_|$)/,
  clay: /(^|_)(clay)(_|$)/,
  snow: /(^|_)(snow|snow_block)(_|$)/
};

/** Does `target` (a real block name, bare) belong to the family `requested`? */
function matchesFamily(target, requested) {
  const family = TERRAIN_FAMILIES[requested];
  return !!family && family.test(target);
}

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
    return this.blockNames.some((n) => n === target || matchesFamily(target, n));
  }

  countsAsHarvest(itemName) {
    const item = bare(itemName);
    // Ore blocks drop the raw item ("raw_iron", "diamond"), stone drops "cobblestone",
    // and dirt-like blocks drop themselves. So a harvest counts when the item is either
    // the block itself or the block's usual drop.
    return this.blockNames.some((n) => n === item || blockDrop(n) === item || matchesFamily(item, n));
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

    /**
     * Soil, sand and gravel are resources, not masonry.
     *
     * Rules 2-4 below refuse things that look like *built* structures: uniform courses,
     * exposed repeating faces. A natural grass field is a uniform course (4/4 identical
     * neighbours), so with `strictMining` on, every sod block was refused and the task
     * reported "no dirt available" while the bot stood in a meadow. The anti-masonry rules
     * still apply to stone/deepslate, which is what walls are actually made of.
     */
    const soil = /(^|_)(dirt|grass_block|podzol|mycelium|mud|moss_block|soil|sand|red_sand|gravel|clay|snow|snow_block)(_|$)/;
    if (soil.test(target)) return null;

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

    /**
     * Baseline before the aimed dig. `digWhatIAmLookingAt()` runs before `super.run()`, so
     * without this snapshot the first crosshair block was excluded from the inventory delta
     * and a 1-block task reported zero yield (live 2026-10-18, crosshair regression test).
     */
    if (this.baseline === null) this.baseline = this.countWhere((name) => this.countsAsHarvest(name));

    // ---- aimed mining first: what is already under the crosshair? ---------
    await this.digWhatIAmLookingAt();

    // ---- no exposed targets: start a shaft --------------------------------
    /**
     * Buried stone is not a walkable target: `findTargets()` sees it through the block map,
     * but `moveTo(range:1)` can never stand next to it. Live 2026-10-17 that produced 32
     * consecutive noPath failures. Only an *exposed* face counts as a target; if there is
     * none, open a shaft.
     */
    if (this.probeShaftEnabled && !this.hasExposedTarget()) {
      this.log.info(`no ${this.unitName()} exposed, digging a probe shaft`);
      await this.probeShaft();
    }

    return super.run();
  }

  /** A target with at least one air neighbour: reachable without rearranging the world. */
  isExposed(block) {
    const world = this.ctx.world;
    if (!world || typeof world.blockAtAbsolute !== 'function' || !block || !block.position) return false;
    const p = block.position;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const neighbour = world.blockAtAbsolute({
        x: Math.floor(p.x) + dx,
        y: Math.floor(p.y) + dy,
        z: Math.floor(p.z) + dz
      });
      if (neighbour && /^(air|cave_air|void_air)$/.test(bare(neighbour.name))) return true;
    }
    return false;
  }

  hasExposedTarget() {
    return this.findTargets().some((block) => this.isExposed(block));
  }

  /**
   * Approach, then fall back to "already within reach".
   *
   * A wall block beside a shaft cannot be approached by pathfinding (its own cell is solid),
   * but the body can dig it from a few blocks away. Only exposed targets get this fallback,
   * and the body still enforces its own reach/line-of-sight rules.
   */
  async approach(target) {
    const reached = await super.approach(target);
    if (reached) return true;
    if (!this.isExposed(target)) return false;
    const here = this.position;
    if (!here || !target.position) return false;
    const distance = Math.hypot(
      here.x - target.position.x,
      here.y - target.position.y,
      here.z - target.position.z
    );
    if (distance > 4) return false;
    this.log.info(`${this.name}: ${target.name} is exposed and within ${distance.toFixed(1)} blocks - digging without walking`);
    return true;
  }

  /** Is this crosshair target one of ours, and harvestable where it stands? */
  matchesCrosshair(target) {
    if (!target || !target.name || !target.position) return false;
    if (!this.isTarget(target.name)) return false;
    return this.canHarvest({ name: target.name, position: target.position });
  }

  /**
   * Dig the block the crosshair is on - no pathfinding, no jumping.
   *
   * Live feedback: "while looking for dirt the agent jumps around a lot; if the crosshair
   * is already on the target block it should just dig it." This is that path. When the
   * crosshair is on something else, the bot sweeps its view (a player's "look around")
   * before any walking happens; the sweep is bounded, so nothing here can turn into a spin.
   *
   * Bodies without a crosshair (mineflayer, mock fixtures without one) simply skip this;
   * the normal scan-and-walk path is unchanged.
   */
  async digWhatIAmLookingAt() {
    const body = this.body;
    if (!body || typeof body.targetBlock !== 'function') return;
    const budget = Math.min(this.target + 2, 64);
    for (let dug = 0; dug < budget; dug += 1) {
      if (this.cancelled || this.updateCollected() >= this.target) return;

      let target = await body.targetBlock().catch(() => null);
      if (!this.matchesCrosshair(target) && typeof body.sweepLook === 'function') {
        // Nothing useful in view: look around like a player would, before walking anywhere.
        target = await body
          .sweepLook({ steps: 8, pitch: 35, filter: (t) => this.matchesCrosshair(t) })
          .catch(() => null);
      }
      if (!this.matchesCrosshair(target)) return;

      const before = this.updateCollected();
      this.log.info(`${this.name}: crosshair on ${bare(target.name)} - digging it without walking`);
      const ok = await this.breakBlock({ name: target.name, position: target.position });
      if (!ok) return;
      await this.afterBreak({ name: target.name, position: target.position }).catch(() => {});
      await this.collectDrops({ radius: 6, attempts: 3 });
      if (this.updateCollected() <= before) {
        // The block broke but gave nothing (wrong tool / no drop): do not loop on it.
        return;
      }
    }
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
    /**
     * The shaft is measured from the feet cell at entry, not from the current snapshot on
     * every step. Live A13-3 2026-10-18:
     *
     *   probe shaft: y=63 below=grass_block at {x:19,y:62,z:73}
     *   probe shaft: y=63 below=air         at {x:19,y:62,z:73}
     *
     * The second line is the hole the first dig just made. The body's `position` had not
     * moved down yet, so re-reading `here.y - 1` looked at the same cell, saw the new air,
     * and treated it as natural void. No shaft was ever dug below the first block. Using
     * `startY - 1 - step` reads the next depth whether or not the snapshot has caught up.
     */
    const start = this.position;
    if (!start) return false;
    const startY = Math.floor(start.y);

    for (let step = 0; step < this.shaftDepth; step += 1) {
      if (this.cancelled) break;
      const here = this.position || start;

      /**
       * Dig the block *below the feet*, not the feet cell.
       *
       * The old code read `floor(here.y)` (the air the bot stands in) and therefore never
       * dug anything: live 2026-10-17 a surface with no exposed stone stayed untouched while
       * the task walked at buried targets and reported noPath.
       */
      const belowY = startY - 1 - step;
      const below = world.blockAtAbsolute({
        x: Math.floor(here.x),
        y: belowY,
        z: Math.floor(here.z)
      });
      const name = below ? bare(below.name) : null;
      this.log.info(
        `probe shaft: depth=${step + 1} fromY=${startY} belowY=${belowY} below=${name || 'null'}` +
          (below && below.position ? ` at ${JSON.stringify(below.position)}` : '')
      );
      if (!name || ['air', 'cave_air', 'void_air', 'water', 'lava', 'bedrock', 'barrier'].includes(name)) break;

      const ok = await this.breakBlock(below);
      if (ok) {
        advanced = true;
        await this.collectDrops({ radius: 6, attempts: 3 });
      } else {
        this.log.warn(`probe shaft: could not break ${below.name} at ${JSON.stringify(below.position || null)} - stopping the shaft`);
        break;
      }
      await sleep(300);

      // Stop as soon as the shaft opened an exposed face we can work on.
      if (this.hasExposedTarget()) break;
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
