'use strict';

/**
 * A compact, relevance-filtered snapshot of the live world for the code-generation prompt
 * (2026-11-01 operator request).
 *
 * Why: the generator used to receive only the task text, so the model wrote scripts blind to
 * the situation (which blocks are around, what is in the inventory, whether something is
 * attacking). It then had to guess, and the first trial paid for the guess.
 *
 * Two rules keep this from ruining generalization:
 *
 *   1. Only sections the task actually needs are included (mining -> blocks/inventory,
 *      fighting -> hostiles). A generic prompt gets only the cheap always-on fields.
 *   2. The block is labelled write-time context, and the prompt tells the model not to
 *      hardcode its coordinates/counts - the skill must re-read them through ctx.state().
 */

const BASE_SECTIONS = ['position', 'health', 'time', 'held'];

const RELEVANCE = [
  {
    section: 'blocks',
    patterns: [
      /\b(?:block|dig|mine|mining|place|build|building|tunnel|pillar|bridge|wall|stair|excavat)/i,
      /挖|矿|方块|搭|建造|放置|放一?块|填|坑|洞|墙|台阶|楼梯|路|桥|柱|竖|铺|隧道|开采/
    ]
  },
  {
    section: 'hostiles',
    patterns: [
      /\b(?:fight|attack|combat|danger|hostile|mob|zombie|skeleton|creeper|phantom|spider|enderman)/i,
      /怪|敌|打|攻击|战斗|危险|逃跑|僵尸|骷髅|苦力怕|蜘蛛|幻翼|末影|战斗/
    ]
  },
  {
    section: 'inventory',
    patterns: [
      /\b(?:item|inventory|collect|gather|craft|material|eat|food|tool|pickaxe|shovel|axe|hoe|sword|gun|equip|chest|deposit|withdraw|store)/i,
      /物品|背包|收集|采集|合成|材料|吃|食物|工具|装备|箱子|存放|取出|库存/
    ]
  }
];

function wantedSections(prompt) {
  const text = String(prompt || '');
  const sections = new Set(BASE_SECTIONS);
  for (const rule of RELEVANCE) {
    if (rule.patterns.some((pattern) => pattern.test(text))) sections.add(rule.section);
  }
  return sections;
}

function bare(name) {
  return String(name || '').replace(/^minecraft:/, '');
}

function inventoryLine(snapshot, maxItems) {
  const entries = Object.entries(snapshot.inventory || {})
    .map(([name, count]) => [bare(name), Number(count)])
    .filter(([name, count]) => name && Number.isFinite(count) && count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxItems);
  if (!entries.length) return 'inventory: (empty)';
  return `inventory (top ${entries.length}): ${entries.map(([name, count]) => `${name} x${count}`).join(', ')}`;
}

function hostilesLine(snapshot, maxHostiles) {
  const hostiles = (snapshot.hostiles || []).slice(0, maxHostiles);
  if (!hostiles.length) return 'nearby hostiles: none';
  return `nearby hostiles: ${hostiles
    .map((hostile) => `${bare(hostile.name)} ${Number(hostile.distance || 0).toFixed(1)}m`)
    .join(', ')}`;
}

/** Palette counts from the body's bounded block window, top N by frequency. */
function blocksLine(snapshot, maxPalette) {
  const cells = snapshot.blocks && snapshot.blocks.cells;
  if (!cells || typeof cells !== 'object') return null;
  const origin = snapshot.position;
  if (!origin) return null;
  const counts = new Map();
  let seen = 0;
  for (const [key, name] of Object.entries(cells)) {
    const [x, y, z] = String(key).split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (Math.abs(x - Math.floor(origin.x)) > 8) continue;
    if (Math.abs(z - Math.floor(origin.z)) > 8) continue;
    if (Math.abs(y - Math.floor(origin.y)) > 4) continue;
    counts.set(bare(name), (counts.get(bare(name)) || 0) + 1);
    seen += 1;
  }
  if (!seen) return null;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxPalette);
  return `blocks around (r8/±4, ${seen} cells): ${top.map(([name, count]) => `${name} x${count}`).join(', ')}`;
}

/**
 * @param {object} snapshot body snapshot (ClientModBody/WorldView shape)
 * @param {object} [options] { prompt, maxInventory, maxHostiles, maxPalette, maxChars }
 * @returns {{text:string, sections:string[]}|null} null when there is no usable snapshot
 */
function buildStateDigest(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.ready === false) return null;
  const prompt = options.prompt || '';
  const sections = wantedSections(prompt);
  const maxInventory = Math.min(Math.max(Number(options.maxInventory) || 12, 1), 32);
  const maxHostiles = Math.min(Math.max(Number(options.maxHostiles) || 3, 1), 8);
  const maxPalette = Math.min(Math.max(Number(options.maxPalette) || 6, 1), 12);
  const maxChars = Math.min(Math.max(Number(options.maxChars) || 1200, 200), 4000);

  const lines = [];
  const pos = snapshot.position;
  const where = pos
    ? `${Number(pos.x).toFixed(1)}, ${Number(pos.y).toFixed(1)}, ${Number(pos.z).toFixed(1)}`
    : 'unknown';
  const dimension = bare(snapshot.dimension) || 'unknown';
  const health = snapshot.health === undefined ? '?' : snapshot.health;
  const food = snapshot.food === undefined ? '?' : snapshot.food;
  lines.push(`position: ${where} (${dimension}) | health ${health}/20 | food ${food}/20`);
  const time = snapshot.time && typeof snapshot.time === 'object' ? snapshot.time : null;
  if (time) lines.push(`time: day ${time.day === undefined ? '?' : time.day}, ${time.isDay === true ? 'day' : 'night'}`);
  lines.push(`held: ${snapshot.heldItem ? bare(snapshot.heldItem) : 'empty hand'}`);
  if (sections.has('inventory')) lines.push(inventoryLine(snapshot, maxInventory));
  const blocks = sections.has('blocks') ? blocksLine(snapshot, maxPalette) : null;
  if (blocks) lines.push(blocks);
  if (sections.has('hostiles')) lines.push(hostilesLine(snapshot, maxHostiles));

  let text = lines.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 12)}\n...[cut]`;
  return { text, sections: [...sections] };
}

module.exports = { buildStateDigest, wantedSections };
