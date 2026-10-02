'use strict';

/**
 * Manual probe for the client mod's menu/click API.
 *
 * The `craft` and `smelt` skills failed on a real client while the offline fake-mod tests
 * passed, so the difference has to be found by driving the same clicks by hand and watching
 * the menu after every step. This script is that hand: it talks to the live mod over
 * localhost and prints the slots that matter after each click.
 *
 * Usage:
 *   node scripts/menu-probe.js                 summary of the current menu
 *   node scripts/menu-probe.js raw             full menu JSON
 *   node scripts/menu-probe.js click <slot> [button] [pickup|quickmove|swap]
 *   node scripts/menu-probe.js useon <x> <y> <z> [face]
 *                                              right-click a block (opens containers)
 *   node scripts/menu-probe.js grid2x2 <sourceSlot> <gridSlot>
 *                                              pickup a stack, right-click one into the 2x2
 *                                              grid, report result slots, shift-click 0
 *   node scripts/menu-probe.js grid3x3 <sourceSlot> <gridSlot>
 *                                              same but for the 3x3 crafting-table grid
 *   node scripts/menu-probe.js put <sourceSlot> <gridSlot> [button]
 *   node scripts/menu-probe.js take <slot>     shift-click a slot (quickmove)
 */

const BASE = process.env.AGENT_MOD_URL || 'http://127.0.0.1:8899';

async function get(action) {
  const res = await fetch(`${BASE}/${action}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${action} -> HTTP ${res.status}`);
  return res.json();
}

/** The mod takes actions as POST /command {"command":"..."}; this is the same door the body uses. */
async function tell(command) {
  const res = await fetch(`${BASE}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`command "${command}" -> HTTP ${res.status}`);
  return res.json();
}

async function menu() {
  const res = await tell('menu');
  if (!res || res.ok !== true) throw new Error(`menu failed: ${JSON.stringify(res)}`);
  if (typeof res.menu === 'string') return JSON.parse(res.menu);
  return res.menu;
}

function fmtSlot(slot) {
  if (!slot) return '?';
  const item = slot.item && slot.item !== 'null' ? slot.item.replace(/^minecraft:/, '') : '-';
  return `${slot.i}:${item}x${slot.count}${slot.player ? '(p)' : ''}`;
}

function summary(menu) {
  if (!menu) return 'menu=null';
  if (!menu.open) return `menu closed (${menu.reason || '?'})`;
  const carried = menu.carried && menu.carried.item
    ? `${menu.carried.item.replace(/^minecraft:/, '')}x${menu.carried.count}`
    : 'empty';
  const head = menu.menuClass || 'menu';
  const size = menu.size;
  const grid = (menu.slots || []).filter((s) => s.i >= 1 && s.i <= 9 && !s.player);
  const result = (menu.slots || []).find((s) => s.i === 0);
  const filled = (menu.slots || []).filter((s) => s.item && s.item !== 'null');
  return [
    `${head} id=${menu.containerId} size=${size}`,
    `  carried: ${carried}`,
    `  result[0]: ${fmtSlot(result)}`,
    `  grid: ${grid.map(fmtSlot).join(' ')}`,
    `  filled: ${filled.map(fmtSlot).join(' ')}`
  ].join('\n');
}

function findSlot(menu, index) {
  return (menu.slots || []).find((s) => s.i === index);
}

async function click(slot, button = 0, mode = 'pickup') {
  const res = await tell(`click ${slot} ${button} ${mode}`);
  console.log(`click ${slot} ${button} ${mode} -> ok=${res.ok}${res.error ? ` (${res.error})` : ''}`);
  await new Promise((r) => setTimeout(r, 250));
  return res;
}

async function show(label) {
  const m = await menu();
  console.log(`--- ${label}\n${summary(m)}`);
  return m;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (!cmd) {
    await show('current menu');
    return;
  }
  if (cmd === 'raw') {
    console.log(JSON.stringify(await menu(), null, 2));
    return;
  }
  if (cmd === 'click') {
    await show('before');
    await click(Number(args[0]), args[1] === undefined ? 0 : Number(args[1]), args[2] || 'pickup');
    await show('after');
    return;
  }
  if (cmd === 'useon') {
    const [x, y, z, face] = args;
    await show('before');
    const res = await tell(`useon ${Number(x)} ${Number(y)} ${Number(z)} ${face || 'up'}`);
    console.log(`useon ${x} ${y} ${z} ${face || 'up'} -> ok=${res.ok}`);
    await new Promise((r) => setTimeout(r, 400));
    await show('after useon');
    return;
  }
  if (cmd === 'put') {
    const source = Number(args[0]);
    const grid = Number(args[1]);
    const button = args[2] === undefined ? 1 : Number(args[2]);
    await show('before');
    const menu = await show('step 0');
    if (menu && menu.carried && menu.carried.item) {
      console.log('carried is not empty, aborting');
      return;
    }
    console.log(`source slot: ${fmtSlot(findSlot(menu, source))}`);
    await click(source, 0, 'pickup');
    await show('after pickup');
    await click(grid, button, 'pickup');
    await show(`after place (button ${button})`);
    return;
  }
  if (cmd === 'take') {
    const slot = Number(args[0]);
    await show('before');
    await click(slot, 0, 'quickmove');
    await show('after quickmove');
    return;
  }
  if (cmd === 'grid2x2' || cmd === 'grid3x3') {
    const source = Number(args[0]);
    const grid = Number(args[1]) || 1;
    const button = args[2] === undefined ? 1 : Number(args[2]);
    let menu = await show(`${cmd} step 0`);
    if (menu && menu.carried && menu.carried.item) {
      console.log('carried is not empty, aborting');
      return;
    }
    console.log(`source slot: ${fmtSlot(findSlot(menu, source))}`);
    await click(source, 0, 'pickup');
    await show('after pickup');
    await click(grid, button, 'pickup');
    menu = await show(`after place (button ${button})`);
    if (menu && menu.carried && menu.carried.item) {
      console.log('cursor still full after placing, not taking the result');
      return;
    }
    await click(0, 0, 'quickmove');
    await show('after quickmove result');
    return;
  }

  console.log('unknown command; see header for usage');
  process.exitCode = 2;
}

main().catch((err) => {
  console.error('probe failed:', err.message);
  process.exitCode = 1;
});
