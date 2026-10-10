'use strict';

/**
 * AcquisitionGoal: one target ore, tracked from the pre-dig baseline to verified pickup.
 *
 * The collection plan (docs/MINING-COLLECTION-PLAN.md §3/§4) exists because "the block is
 * gone" and "the item is in the bag" are different facts, and the old code conflated them:
 * `takeOre` counted the ore before collecting, and `collectDrops` counted an item as
 * collected when its entity vanished - off range, merged into another stack, or picked up
 * by someone else all counted as success.
 *
 * This module is the single source for:
 *   - the product table (what an ore really drops, with silk-touch / fortune rules);
 *   - the goal record created *before* the dig, with the inventory/entity baseline sealed
 *     before the first target dig;
 *   - the observation and verification functions both the macro and the LLM recovery path
 *     call - no second pickup implementation anywhere.
 *
 * Pure data + pure functions; no Body, no chat, no LLM.
 */

const { bare } = require('../world/items');

let goalSeq = 0;

/**
 * Vanilla ore -> product mapping.
 *
 * `silk` is the block's own item (silk touch), `normal` the ordinary drop, and `fortuneMax`
 * the highest count a fortune III tool can produce. A hardcoded "one ore = one item" is
 * exactly the lie the plan forbids: fortune changes the count, silk changes the item.
 */
const PRODUCTS = {
  coal_ore: { normal: 'coal', silk: 'coal_ore', fortuneMax: 1 },
  deepslate_coal_ore: { normal: 'coal', silk: 'deepslate_coal_ore', fortuneMax: 1 },
  iron_ore: { normal: 'raw_iron', silk: 'iron_ore', fortuneMax: 1 },
  deepslate_iron_ore: { normal: 'raw_iron', silk: 'deepslate_iron_ore', fortuneMax: 1 },
  copper_ore: { normal: 'raw_copper', silk: 'copper_ore', fortuneMax: 1 },
  deepslate_copper_ore: { normal: 'raw_copper', silk: 'deepslate_copper_ore', fortuneMax: 1 },
  gold_ore: { normal: 'raw_gold', silk: 'gold_ore', fortuneMax: 1 },
  deepslate_gold_ore: { normal: 'raw_gold', silk: 'deepslate_gold_ore', fortuneMax: 1 },
  redstone_ore: { normal: 'redstone', silk: 'redstone_ore', fortuneMax: 4 },
  deepslate_redstone_ore: { normal: 'redstone', silk: 'deepslate_redstone_ore', fortuneMax: 4 },
  diamond_ore: { normal: 'diamond', silk: 'diamond_ore', fortuneMax: 4 },
  deepslate_diamond_ore: { normal: 'diamond', silk: 'deepslate_diamond_ore', fortuneMax: 4 },
  emerald_ore: { normal: 'emerald', silk: 'emerald_ore', fortuneMax: 4 },
  deepslate_emerald_ore: { normal: 'emerald', silk: 'deepslate_emerald_ore', fortuneMax: 4 },
  lapis_ore: { normal: 'lapis_lazuli', silk: 'lapis_ore', fortuneMax: 9 },
  deepslate_lapis_ore: { normal: 'lapis_lazuli', silk: 'deepslate_lapis_ore', fortuneMax: 9 },
  nether_quartz_ore: { normal: 'quartz', silk: 'nether_quartz_ore', fortuneMax: 4 },
  nether_gold_ore: { normal: 'gold_nugget', silk: 'nether_gold_ore', fortuneMax: 24 },
  ancient_debris: { normal: 'ancient_debris', silk: 'ancient_debris', fortuneMax: 1 }
};

/**
 * Resolve what one ore block yields (plan §4.1).
 *
 * @param {string} blockId block name (namespaced or bare)
 * @param {object} [toolState] { item, silkTouch, fortune }
 * @param {object} [options] { modKnowledge }
 * @returns {{ok:true, products:string[], block:string, silk:boolean, expectedMax:number}
 *          | {ok:false, reason:string, failure:'product_unknown'}}
 */
function resolveMiningProducts(blockId, toolState = {}, options = {}) {
  const block = bare(blockId);
  const text = String(blockId || '');
  const modded = text.includes(':') && !text.startsWith('minecraft:');

  if (!modded && PRODUCTS[block]) {
    const entry = PRODUCTS[block];
    if (toolState.silkTouch) {
      return { ok: true, products: [entry.silk], block, silk: true, expectedMax: 1 };
    }
    const fortune = Math.max(0, Math.min(3, Number(toolState.fortune) || 0));
    const expectedMax = fortune > 0 ? Math.max(1, entry.fortuneMax) : 1;
    return { ok: true, products: [entry.normal], block, silk: false, expectedMax };
  }

  /**
   * Modded ore: trust only the knowledge base. No guessing a name for a block whose drop
   * table we have never seen - the plan's `product_unknown` answer.
   */
  const knowledge = options.modKnowledge;
  if (knowledge && typeof knowledge.classify === 'function') {
    const cls = knowledge.classify(blockId);
    if (cls && cls.category === 'ore' && cls.knownDrop) {
      return { ok: true, products: [cls.knownDrop], block, silk: !!toolState.silkTouch, expectedMax: 1 };
    }
  }
  return { ok: false, reason: `no verified drop table for ${blockId}`, failure: 'product_unknown' };
}

/** Count one item across the snapshot inventory (bare-name matching). */
function inventoryCount(snapshot, item) {
  const wanted = bare(item);
  let total = 0;
  for (const [name, count] of Object.entries((snapshot && snapshot.inventory) || {})) {
    if (bare(name) === wanted) total += Number(count) || 0;
  }
  return total;
}

/** Nearby dropped items of the accepted product types, normalised to a stable shape. */
function productDrops(snapshot, products) {
  const wanted = new Set(products.map((p) => bare(p)));
  const items = (snapshot && (snapshot.nearbyItems || snapshot.itemDrops)) || [];
  return items
    .filter((drop) => drop && drop.position && wanted.has(bare(drop.name || drop.item || '')))
    .map((drop) => ({
      id: drop.id !== undefined ? drop.id : null,
      name: bare(drop.name || drop.item),
      count: Number(drop.count) || 1,
      position: { ...drop.position },
      distance: Number.isFinite(drop.distance) ? drop.distance : undefined
    }));
}

/**
 * Create the goal record. Call this *before* the target dig and then seal the baseline:
 * the inventory/entity baseline must reflect the world right before the dig, or products
 * the bot picked up while walking are credited to this ore (plan §3.1).
 */
function prepareAcquisition({ taskId, target, tool, products, snapshot, worldSessionId, dimension }) {
  goalSeq += 1;
  const itemList = products.slice();
  const inventoryBaseline = {};
  for (const item of itemList) inventoryBaseline[bare(item)] = inventoryCount(snapshot, item);
  return {
    goalId: `g${goalSeq}`,
    taskId: taskId || null,
    worldSessionId: worldSessionId || null,
    dimension: dimension || (snapshot && snapshot.dimension) || null,
    target: { blockId: bare(target.blockId || ''), position: { ...target.position } },
    phase: 'mine',
    status: 'prepared',
    preparedAt: Date.now(),
    inventoryBaseline,
    baselineRevision: null,
    baselineSealedAt: null,
    dropsBefore: productDrops(snapshot, itemList),
    tool: tool ? { ...tool } : null,
    acceptedProducts: itemList,
    mined: { confirmed: false, actionId: null, at: null, before: null, after: null },
    trackedDrops: [],
    candidateStands: [],
    triedStands: [],
    collectedItems: 0,
    observedProducedItems: null,
    pendingDrops: [],
    evidence: [],
    evidenceLevel: null,
    failure: null,
    reason: null,
    lastVerifiedRevision: null
  };
}

/** Freeze the baseline: from here on it must not be re-read to hide a loss (C22). */
function sealBaseline(goal, snapshot) {
  if (goal.mined.confirmed) return goal; // already dug: too late
  for (const item of goal.acceptedProducts) {
    goal.inventoryBaseline[bare(item)] = inventoryCount(snapshot, item);
  }
  goal.dropsBefore = productDrops(snapshot, goal.acceptedProducts);
  goal.baselineSealedAt = Date.now();
  return goal;
}

/**
 * Record the dig result. Only a real, re-verified dig makes the goal `pending`; a stale
 * scan where the block is already air never confirms a mine (plan §3.1).
 */
function recordMineResult(goal, { receipt = {}, before = null, after = null } = {}) {
  if (goal.status === 'lost') return goal;
  if (receipt.ok && receipt.dug) {
    goal.mined.confirmed = true;
    goal.mined.actionId = receipt.actionId || null;
    goal.mined.at = Date.now();
    goal.mined.before = before || null;
    goal.mined.after = after || null;
    goal.phase = 'collect';
    goal.status = 'pending';
  } else if (receipt.failure === 'target_lost') {
    goal.status = 'lost';
    goal.failure = 'target_lost';
    goal.reason = receipt.reason || 'the target block was already gone';
  } else {
    goal.failure = receipt.failure || null;
    goal.reason = receipt.reason || null;
  }
  return goal;
}

/**
 * One observation pass: compare inventory and visible drops against the sealed baseline
 * and update the goal.
 *
 * @returns {{goal:object, delta:number, drops:Array, evidenceLevel:string}}
 */
function observeAcquisition(goal, snapshot) {
  let delta = 0;
  for (const item of goal.acceptedProducts) {
    const key = bare(item);
    delta += inventoryCount(snapshot, item) - (goal.inventoryBaseline[key] || 0);
  }
  const drops = productDrops(snapshot, goal.acceptedProducts);
  const baselineIds = new Set(goal.dropsBefore.map((d) => d.id));
  const fresh = drops.filter((d) => d.id === null || !baselineIds.has(d.id));

  /**
   * Evidence level (plan §4.2). Correlated is allowed only in the controlled case: no
   * same-product drops existed before the dig and nobody else is picking. Anything else
   * stays ambiguous until a pickup-event capability can name the collector.
   */
  let evidenceLevel = 'correlated';
  if (goal.dropsBefore.length > 0) evidenceLevel = 'ambiguous';

  goal.pendingDrops = fresh.map((d) => ({ ...d }));
  return { goal, delta: Math.max(0, delta), drops: fresh, evidenceLevel };
}

/**
 * Fold one observation into the goal's evidence ledger.
 *
 * Rules that must not regress (R25 / C06-C08):
 *   - only an inventory increase counts as a pickup; a vanished entity never does;
 *   - one positive delta is consumed by exactly one goal (the caller passes the amount
 *     `claimable` so cross-goal attribution cannot double-count);
 *   - a partially picked stack keeps its remainder in pendingDrops.
 */
function verifyAcquisition(goal, observation, options = {}) {
  const claimable = options.claimable === undefined
    ? observation.delta
    : Math.max(0, Math.min(observation.delta, options.claimable));
  const collected = Math.max(0, Math.floor(claimable));
  if (collected > 0) {
    goal.collectedItems += collected;
    goal.evidenceLevel = observation.evidenceLevel;
    goal.evidence.push({
      at: Date.now(),
      kind: 'inventory-delta',
      items: collected,
      evidenceLevel: observation.evidenceLevel
    });
    if (goal.mined.confirmed) goal.status = 'verified';
    else goal.reason = 'product picked up before the dig was confirmed';
  }
  const pending = observation.drops.filter((d) => d.count > 0);
  goal.pendingDrops = pending;
  return {
    verified: goal.status === 'verified',
    evidenceLevel: goal.evidenceLevel,
    collectedItems: goal.collectedItems,
    delta: collected,
    pendingDrops: pending
  };
}

/** Human summary used in task results, logs and the panel. */
function describeAcquisition(goal) {
  return (
    `${goal.target.blockId}@${goal.target.position.x},${goal.target.position.y},${goal.target.position.z} ` +
    `[${goal.status}] collected=${goal.collectedItems} pending=${goal.pendingDrops.length}`
  );
}

module.exports = {
  PRODUCTS,
  resolveMiningProducts,
  inventoryCount,
  productDrops,
  prepareAcquisition,
  sealBaseline,
  recordMineResult,
  observeAcquisition,
  verifyAcquisition,
  describeAcquisition
};
