'use strict';

/**
 * Situational recovery.
 *
 * mineflayer-pathfinder is very reliable on terrain and very unreliable on
 * "awkward" spawns: standing on tree canopy, inside a 1-block hole, in water, in
 * a cave. In those spots A* returns `partial`/`noPath` and - critically - the
 * `goto()` promise can resolve with an *empty* path, i.e. the bot silently does
 * nothing. Every open-source mineflayer agent hits this; the fix is to detect it
 * and physically move the bot with raw controls until it is somewhere sane.
 *
 * Exports:
 *   needsRescue(view)      - are we standing somewhere the pathfinder hates?
 *   escapeToGround(...)    - dig straight down / walk off until solid ground
 */

const { sleep, digBlock } = require('./movement');
const { isPassable } = require('../world/items');
const { Logger } = require('../util/logger');

/** Blocks that are safe to stand on. */
function isSolidGround(block) {
  if (!block) return false;
  if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return false;
  if (isPassable(block.name) && !/leaves$/.test(block.name)) return false;
  return true;
}

/**
 * True when the bot is genuinely somewhere the pathfinder cannot work with.
 *
 * Kept deliberately strict. A false positive here is expensive: the rescue routine
 * takes over the bot and cancels whatever the planner was doing, so "standing on
 * dirt next to a tree" must never look like "stuck".
 */
function needsRescue(view, options = {}) {
  if (!view.ready) return false;
  /**
   * The heuristic is written against the mineflayer `bot`; a client-mod world view
   * (BodyWorldView) has none. Live 2026-10-13: the missing bot made this throw a
   * TypeError on EVERY fast-loop tick - swallowed at debug level by the interval
   * catch - so auto-eat, danger retreat and the auto-fight reflex were all dead for
   * the clientmod body while a skeleton mauled the bot point-blank with no reaction.
   * A view without a mineflayer instance cannot be judged by this heuristic: report
   * "not trapped" instead of throwing.
   */
  const bot = view.bot;
  if (!bot || !bot.entity) return false;
  const feet = bot.entity.position;
  if (!feet) return false;
  const floored = feet.floored();
  const feetBlock = bot.blockAt(floored);
  const below1 = bot.blockAt(floored.offset(0, -1, 0));
  const below2 = bot.blockAt(floored.offset(0, -2, 0));
  const below3 = bot.blockAt(floored.offset(0, -3, 0));
  if (!feetBlock || !below1) return false; // chunk not loaded: we cannot judge

  // Swimming / burning is a different subsystem's problem.
  if (['lava', 'fire', 'water'].includes(feetBlock.name)) return false;
  if (['lava', 'fire', 'water'].includes(below1.name)) return false;

  // 1. Standing on foliage: A* cannot plan a descent through a canopy.
  if (/leaves$/.test(below1.name)) return true;

  // 2. Suffocating inside a solid block.
  if (!isPassable(feetBlock.name) && !/leaves$/.test(feetBlock.name)) return true;

  // 3. Truly airborne with nothing to land on for several blocks.
  const nothingBelow = !isSolidGround(below1) && !isSolidGround(below2) && !isSolidGround(below3);
  if (nothingBelow && !bot.entity.onGround) return true;

  // 4. Walled in: a solid block straight above and no room to walk (the classic
  //    "fell into a 1x1 hole" case that A* cannot solve).
  const above = bot.blockAt(floored.offset(0, 2, 0));
  const headRoom = bot.blockAt(floored.offset(0, 1, 0));
  if (above && isSolidGround(above)) {
    const sides = [
      floored.offset(1, 0, 0),
      floored.offset(-1, 0, 0),
      floored.offset(0, 0, 1),
      floored.offset(0, 0, -1)
    ].map((p) => bot.blockAt(p));
    const walled = sides.every((b) => b && !isPassable(b.name) && !/leaves$/.test(b.name));
    if (walled) return true;
  }
  if (headRoom && !isPassable(headRoom.name) && !/leaves$/.test(headRoom.name)) return true;

  return false;
}

/** True when the block under the bot's feet is something it can stand on. */
function onSolidGround(bot) {
  if (!bot || !bot.entity) return false;
  const pos = bot.entity.position.floored();
  const below = bot.blockAt(pos.offset(0, -1, 0));
  if (!below) return false;
  return isSolidGround(below) && !/leaves$/.test(below.name);
}

/**
 * Get the bot onto solid ground using whatever works.
 * @returns {Promise<boolean>} true if we ended up on solid ground
 */
async function escapeToGround(ctx, options = {}) {
  const log = options.log || new Logger('rescue');
  const { bot, nav } = ctx;
  const timeoutMs = options.timeoutMs || 20000;
  const deadline = Date.now() + timeoutMs;

  // Block state is the reliable signal; entity.onGround flickers mid-fall and made
  // earlier versions of this loop retry forever.
  const grounded = () => onSolidGround(bot);

  log.warn(`stuck at ${bot.entity.position.floored()} - escaping to solid ground`);
  if (grounded()) return true;

  // 1. Try to path straight down first (works when standing on a solid canopy edge).
  try {
    const { goals } = require('mineflayer-pathfinder');
    const pos = bot.entity.position;
    const downGoal = new goals.GoalNear(Math.floor(pos.x), Math.floor(pos.y) - 4, Math.floor(pos.z), 1);
    const ok = await Promise.race([
      bot.pathfinder.goto(downGoal).then(() => true).catch(() => false),
      sleep(6000).then(() => false)
    ]);
    if (ok && grounded()) {
      log.info(`descended via pathfinder to ${bot.entity.position.floored()}`);
      return true;
    }
  } catch {
    /* fall through to manual movement */
  }
  nav.stop();

  // 2. Walk in a few directions until we fall onto something solid.
  const directions = ['forward', 'back', 'left', 'right'];
  for (const dir of directions) {
    if (Date.now() > deadline) break;
    log.info(`manual escape: walking ${dir}`);
    // Look in the direction of travel so 'forward' actually goes there.
    const yaw = { forward: bot.entity.yaw, back: bot.entity.yaw + Math.PI, left: bot.entity.yaw + Math.PI / 2, right: bot.entity.yaw - Math.PI / 2 }[dir];
    await bot.look(yaw, 0, true).catch(() => {});
    bot.setControlState(dir, true);
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      await sleep(200);
      if (grounded()) break;
    }
    bot.setControlState(dir, false);
    await sleep(250);
    if (grounded()) {
      const pos = bot.entity.position.floored();
      log.info(`reached solid ground at ${pos}`);
      return true;
    }
  }

  // 3. Last resort: dig straight down a few blocks.
  log.warn('walking did not help, digging straight down');
  for (let i = 0; i < 6 && Date.now() < deadline; i += 1) {
    const pos = bot.entity.position.floored();
    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || below.name === 'bedrock' || below.name === 'water' || below.name === 'lava') break;
    await digBlock(ctx.controller, below, { log, timeoutMs: 6000 });
    await sleep(400);
    if (grounded()) {
      log.info(`dug down to ${bot.entity.position.floored()}`);
      return true;
    }
  }

  // 4. Nothing worked: we are probably walled in. Climb out by pillaring.
  const climbed = await climbOut(ctx, { log, deadline });
  if (climbed) return true;

  log.warn('escapeToGround could not confirm solid ground');
  return grounded();
}

const SCAFFOLD_PREFERENCE = ['cobblestone', 'dirt', 'oak_planks', 'spruce_planks', 'birch_planks', 'netherrack', 'sand', 'gravel', 'andesite', 'diorite', 'granite'];

/**
 * Escape a 1-2 block hole by digging the ceiling and pillaring up one block at a
 * time. This is the manual equivalent of the classic "jump and place" trick and it
 * works where A* refuses to plan (its canDig cost model explodes in tight spaces).
 */
async function climbOut(ctx, options = {}) {
  const log = options.log || new Logger('rescue');
  const { bot } = ctx;
  const deadline = options.deadline || Date.now() + 25000;
  const maxSteps = options.steps || 6;

  const scaffold = () => {
    for (const name of SCAFFOLD_PREFERENCE) {
      const item = bot.inventory.items().find((i) => i.name === name);
      if (item) return item;
    }
    return null;
  };

  let climbed = 0;
  for (let step = 0; step < maxSteps && Date.now() < deadline; step += 1) {
    const feetPos = bot.entity.position.floored();
    const head = bot.blockAt(feetPos.offset(0, 1, 0));
    const above = bot.blockAt(feetPos.offset(0, 2, 0));

    // Clear the space above the head so we have somewhere to go.
    for (const block of [head, above]) {
      if (block && !isPassable(block.name) && block.name !== 'bedrock' && !/leaves$/.test(block.name)) {
        await digBlock(ctx.controller, block, { log, timeoutMs: 6000 });
        await sleep(150);
      }
    }

    const under = bot.blockAt(feetPos.offset(0, -1, 0));
    if (!under) break;
    const item = scaffold();
    if (!item) {
      log.warn('no scaffold blocks in the inventory - cannot pillar up');
      break;
    }

    // Jump, then place the block below the feet to gain one block of height.
    try {
      await bot.equip(item, 'hand');
      bot.setControlState('jump', true);
      await sleep(320);
      bot.setControlState('jump', false);
      await bot.placeBlock(under, { x: 0, y: 1, z: 0 });
      climbed += 1;
      await sleep(250);
      if (onSolidGround(bot) && bot.entity.position.y > feetPos.y + 0.4) {
        const open = bot.blockAt(bot.entity.position.floored().offset(0, 1, 0));
        if (!open || isPassable(open.name)) {
          log.info(`climbed out to ${bot.entity.position.floored()} (${climbed} blocks)`);
          return true;
        }
      }
    } catch (err) {
      log.debug(`climb step failed: ${err.message}`);
      bot.setControlState('jump', false);
    }
  }
  bot.setControlState('jump', false);
  return false;
}

/**
 * Emergency "hide" behaviour for death loops.
 *
 * When the agent keeps dying (night, no weapon, mobs everywhere) the correct move is
 * not a better fight - it is to stop being findable. Dig a 1x1 shaft three blocks
 * down, then cap it. Mobs cannot reach a sealed hole, and the bot survives until
 * daylight instead of feeding the zombie population.
 *
 * @returns {Promise<boolean>} true when the bot is sealed in
 */
async function hideUnderground(ctx, options = {}) {
  const log = options.log || new Logger('hide');
  const { bot, nav } = ctx;
  const depth = options.depth || 3;

  log.warn(`hiding underground at ${bot.entity.position.floored()} (depth ${depth})`);
  nav.interrupt('hiding');

  const startY = Math.floor(bot.entity.position.y);
  for (let i = 0; i < depth; i += 1) {
    const pos = bot.entity.position.floored();
    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || below.name === 'bedrock' || below.name === 'water' || below.name === 'lava') break;
    const dug = await digBlock(ctx.controller, below, { log, timeoutMs: 8000 });
    if (!dug) break;
    await sleep(500);
  }

  // Cap the shaft with whatever solid block we are carrying.
  const cap = bot.inventory.items().find((i) => /^(cobblestone|dirt|stone|_planks|deepslate|andesite|granite|diorite)$/.test(i.name));
  const landed = bot.entity.position.floored();
  const ceiling = bot.blockAt(landed.offset(0, depth - 1, 0));
  if (cap && ceiling) {
    try {
      await bot.equip(cap, 'hand');
      await bot.placeBlock(ceiling, { x: 0, y: -1, z: 0 });
      log.info('shaft capped - mobs cannot reach us');
    } catch (err) {
      log.debug(`could not cap the shaft: ${err.message}`);
    }
  }

  const descended = startY - Math.floor(bot.entity.position.y);
  if (descended > 0) {
    log.info(`hidden ${descended} block(s) below the surface`);
    return true;
  }
  log.warn('could not dig down (hard ground?) - staying put instead');
  return false;
}

/** Are we in daylight yet? Used to decide when safe mode can end. */
function isDaytime(view) {
  try {
    return !view.isNight();
  } catch {
    return true;
  }
}

/**
 * Detect the "empty path" no-op: mineflayer-pathfinder can resolve goto() with a
 * partial path of length 0 and leave the bot exactly where it was. Called by the
 * Navigator after every successful goto to make sure we actually moved.
 */
function didNotMove(from, to, tolerance = 1.5) {
  if (!from || !to) return false;
  return from.distanceTo(to) < tolerance;
}

module.exports = {
  needsRescue,
  escapeToGround,
  hideUnderground,
  isDaytime,
  isSolidGround,
  onSolidGround,
  didNotMove
};
