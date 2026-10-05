'use strict';

/**
 * Mining plan: the "look -> plan" half of the mining skill, kept pure so it is testable
 * without a world.
 *
 * numen's DigQuote/Goals.dig in miniature (docs/look-plan-act.md §五/§十一, nav/DigQuote.java):
 * a target is chosen by **what reaching it will cost in terrain edits and steps**, not by
 * straight-line distance. A far ore behind open air is cheaper than a near one behind six
 * blocks of stone, and a target whose arrival cell can reach several ore blocks is cheaper
 * still ("同样划算的站位里，优先一次能够到最多目标格的").
 *
 * The quote simulates exactly the sloped stair the walker will dig - it shares `stepVector`
 * and `stepCells` with the executor in `mining.js`, so the plan and the execution cannot
 * drift apart. `DigLedger` is the other half: execution reports which planned cells it dug
 * and how many cells it had to dig that the plan never named (numen: the plan is a
 * commitment, the receipt is the actual account).
 */

/** One dug block is several walk steps' worth of time; these weights only order targets. */
const DIG_WEIGHT = 4;
const STEP_WEIGHT = 1;
/** Each extra ore block reachable from the arrival stand is worth this many walk steps. */
const VEIN_BONUS = 2;

const MAX_QUOTE_STEPS = 200;

/**
 * One step of the sloped stair toward `target`, or null when already within reach
 * (Chebyshev distance <= 1, the same "arrived" rule the walker uses).
 *
 * A target directly above/below has no horizontal offset; the caller must pick a side
 * (`vertical: true`), because a vertical shaft cannot be climbed.
 */
function stepVector(here, target) {
  const dx = target.x - here.x;
  const dz = target.z - here.z;
  const dy = target.y - here.y;
  if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && Math.abs(dy) <= 1) return null;
  const stepY = dy >= 2 ? 1 : dy <= -2 ? -1 : 0;
  if (dx === 0 && dz === 0) return { sx: null, sz: null, stepY, vertical: true };
  let sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
  let sz = sx === 0 ? Math.sign(dz) : 0;
  return { sx, sz, stepY, vertical: false };
}

/**
 * The cells a step will dig, and where the feet end up.
 *
 * Climb: the ceiling over the bot's own head (jumping needs three free cells), the new foot
 * and the new head. Descent and flat steps keep the same three/two-cell shapes the live
 * bugs were fixed around.
 */
function stepCells(here, step) {
  const next = { x: here.x + step.sx, y: here.y + step.stepY, z: here.z + step.sz };
  let cells;
  if (step.stepY === 1) {
    cells = [
      { x: here.x, y: here.y + 2, z: here.z },
      { x: next.x, y: here.y + 1, z: next.z },
      { x: next.x, y: here.y + 2, z: next.z }
    ];
  } else if (step.stepY === -1) {
    cells = [
      { x: next.x, y: here.y - 1, z: next.z },
      { x: next.x, y: here.y, z: next.z },
      { x: next.x, y: here.y + 1, z: next.z }
    ];
  } else {
    cells = [
      { x: next.x, y: here.y, z: next.z },
      { x: next.x, y: here.y + 1, z: next.z }
    ];
  }
  return { next, cells };
}

function key(cell) {
  return `${cell.x},${cell.y},${cell.z}`;
}

/**
 * Quote the approach to one ore.
 *
 * @param {object} options
 * @param {{x:number,y:number,z:number}} options.from bot feet
 * @param {{x:number,y:number,z:number}} options.ore target block
 * @param {(cell:{x:number,y:number,z:number}) => string} options.read block name
 * @param {(name:string) => boolean} options.passable air-like: no dig needed
 * @param {(name:string) => boolean} options.mineable the bot's tool can break it
 * @param {(name:string) => boolean} options.hazard water/lava: the route is refused
 * @param {(cell:object) => (string|null)} [options.risky] physical dig risk for a cell
 *        (falling sand above, water beside): the approach is refused, like numen's
 *        "挖不动、贴着流体、顶着落沙" admission check before a job is accepted
 * @param {(here:{x:number,y:number,z:number}) => {sx:number,sz:number}} [options.chooseSide]
 *        side for a vertical target, shared with the executor
 * @param {(arrival:{x:number,y:number,z:number}) => number} [options.reachableCount]
 *        same-type ore blocks reachable from the arrival cell (>=1)
 * @param {number} [options.maxSteps]
 * @param {number} [options.maxDigs] refuse an approach that would need more digs than this
 * @returns {{ok:true, digs:number, steps:number, travel:number, vein:number, cost:number,
 *            arrival:object, edits:Array<object>, plan:Array<{waypoint:object, dig:Array<object>}>}
 *          | {ok:false, reason:string, failure:string, hazard?:boolean, digs?:number}}
 */
function quoteApproach(options) {
  const { from, ore, read, passable, mineable, hazard } = options;
  const maxSteps = Math.min(options.maxSteps || MAX_QUOTE_STEPS, MAX_QUOTE_STEPS);
  const maxDigs = options.maxDigs === undefined ? Infinity : options.maxDigs;
  const chooseSide = typeof options.chooseSide === 'function' ? options.chooseSide : () => ({ sx: 1, sz: 0 });
  let here = { x: from.x, y: from.y, z: from.z };
  const edits = [];
  const seenEdits = new Set();
  const seenSteps = new Set();
  let digs = 0;
  let steps = 0;
  /** The ordered execution plan: one entry per stair step, with the cells that step digs. */
  const plan = [];

  for (let i = 0; i < maxSteps; i += 1) {
    const step = stepVector(here, ore);
    if (!step) break; // within reach
    if (step.vertical) {
      const side = chooseSide(here) || { sx: 1, sz: 0 };
      step.sx = side.sx;
      step.sz = side.sz;
    }
    const { next, cells } = stepCells(here, step);
    const stepKey = key(next);
    if (seenSteps.has(stepKey)) {
      return { ok: false, reason: 'the approach loops on itself', failure: 'no_path', digs };
    }
    seenSteps.add(stepKey);
    const stepDigs = [];
    for (const cell of cells) {
      const name = read(cell);
      if (hazard(name)) {
        return { ok: false, reason: `hazard (${name}) on the approach`, failure: 'hazard', hazard: true, digs, plan };
      }
      if (passable(name)) continue;
      const risk = typeof options.risky === 'function' ? options.risky(cell) : null;
      if (risk) {
        return { ok: false, reason: `physical risk: ${risk}`, failure: 'hazard', hazard: true, digs, plan };
      }
      if (!mineable(name)) {
        return { ok: false, reason: `blocked by ${name}`, failure: 'occluded', digs, plan };
      }
      const cellKey = key(cell);
      if (!seenEdits.has(cellKey)) {
        seenEdits.add(cellKey);
        edits.push({ ...cell });
      }
      stepDigs.push({ ...cell });
      digs += 1;
      if (digs > maxDigs) {
        return { ok: false, reason: `would need more than ${maxDigs} digs`, failure: 'no_path', digs, plan };
      }
    }
    plan.push({ waypoint: { ...next }, dig: stepDigs });
    here = next;
    steps += 1;
  }

  if (stepVector(here, ore)) {
    return { ok: false, reason: `more than ${maxSteps} steps away`, failure: 'no_path', digs, plan };
  }

  const vein = Math.max(1, typeof options.reachableCount === 'function' ? options.reachableCount(here) : 1);
  const travel = Math.hypot(ore.x - from.x, ore.z - from.z) + Math.abs(ore.y - from.y);
  const cost = digs * DIG_WEIGHT + steps * STEP_WEIGHT - (vein - 1) * VEIN_BONUS;
  return { ok: true, digs, steps, travel, vein, cost, arrival: here, edits, plan };
}

/**
 * The actual account of one planned approach: planned cells vs cells dug that the plan
 * never named. Extra digs mean the world was not what the quote saw (a stale scan, a
 * changed wall) - the caller decides when they exceed the budget and the task stops with
 * the ledger instead of silently reshapening more terrain than promised.
 */
class DigLedger {
  constructor(plannedCells = []) {
    this.planned = new Set(plannedCells.map(key));
    this.dug = 0;
    this.extra = 0;
    this.extraCells = [];
  }

  /** Record one dug cell. @returns {boolean} true when it was NOT part of the plan. */
  note(position) {
    this.dug += 1;
    if (this.planned.has(key(position))) return false;
    this.extra += 1;
    if (this.extraCells.length < 8) this.extraCells.push({ ...position });
    return true;
  }

  exceeded(limit) {
    return this.extra > limit;
  }

  summary(limit) {
    return {
      planned: this.planned.size,
      dug: this.dug,
      extra: this.extra,
      extraCells: this.extraCells,
      exceeded: limit === undefined ? undefined : this.exceeded(limit)
    };
  }
}

module.exports = { quoteApproach, stepVector, stepCells, DigLedger, DIG_WEIGHT, STEP_WEIGHT, VEIN_BONUS };
