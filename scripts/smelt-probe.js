#!/usr/bin/env node
'use strict';

/**
 * Step-by-step probe for the `smelt` skill against the live client.
 *
 * The acceptance run showed "no iron_ingot came out of the furnace" while the same clicks
 * driven by hand worked, so this runs the *real* skill through a logging proxy: every
 * menu() and clickSlot() the skill makes is printed with the menu state around it, which
 * turns "it failed somewhere" into "it failed on this click".
 *
 *   node scripts/smelt-probe.js [item] [count]
 */

const { loadConfig } = require('../src/util/config');
const { ClientModBody } = require('../src/body/clientModBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const skills = require('../src/skills');

function slotLine(slot) {
  const item = slot.item && slot.item !== 'null' ? slot.item : '-';
  return `${slot.i}:${item}x${slot.count}`;
}

function fmtMenu(menu) {
  if (!menu) return 'null';
  if (!menu.open) return `closed (${menu.reason || '?'})`;
  const points = (menu.slots || [])
    .filter((s) => s.i <= 4 || (s.item && s.item !== 'null'))
    .map(slotLine)
    .join(' ');
  const carried = menu.carried && menu.carried.item ? `${menu.carried.item}x${menu.carried.count}` : 'empty';
  return `${menu.menuClass} carried=${carried} | ${points}`;
}

async function main() {
  const item = process.argv[2] || 'raw_iron';
  const count = Number(process.argv[3] || 1);
  const cfg = loadConfig();
  const body = new ClientModBody(cfg, { log: console });
  const attached = await body.connect({ waitMs: 15000 });
  if (!attached) {
    console.error('client mod is not answering on 127.0.0.1:8899');
    process.exitCode = 1;
    return;
  }

  const proxy = Object.create(body);
  proxy.useOn = async (position, options) => {
    console.log(`[skill] useOn ${JSON.stringify(position)} ${JSON.stringify(options || {})}`);
    const ok = await body.useOn(position, options);
    console.log(`        -> ${ok}`);
    return ok;
  };
  proxy.menu = async () => {
    const menu = await body.menu();
    console.log(`[skill] menu -> ${fmtMenu(menu)}`);
    return menu;
  };
  proxy.clickSlot = async (slot, options) => {
    const before = await body.menu();
    console.log(`[skill] click ${slot} ${JSON.stringify(options || {})}   before: ${fmtMenu(before)}`);
    const ok = await body.clickSlot(slot, options);
    const after = await body.menu();
    console.log(`        -> ${ok}   after: ${fmtMenu(after)}`);
    return ok;
  };
  proxy.closeMenu = async () => {
    console.log('[skill] closeMenu');
    return body.closeMenu();
  };

  const ctx = { cfg, body: proxy, world: new BodyWorldView(proxy, cfg, { log: console }), log: console };
  const result = await skills.run('smelt', ctx, { item, count, timeoutMs: 90000 });
  console.log('RESULT', JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err) => {
  console.error('smelt probe failed:', err.stack || err.message);
  process.exitCode = 1;
});
