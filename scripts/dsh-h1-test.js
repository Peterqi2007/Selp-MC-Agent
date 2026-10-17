#!/usr/bin/env node
/**
 * H1a/H1b client for the real DSH plugin.
 *
 * Prereqs:
 *   1. DSH restarted with dsh-mc-harness installed (http://127.0.0.1:8770/health).
 *   2. Minecraft agent running on http://127.0.0.1:8766.
 *   3. H1 does NOT require Full Access Ask (that is a per-conversation preset, only for M5 CU).
 *
 * Usage:
 *   node scripts/dsh-h1-test.js
 *   node scripts/dsh-h1-test.js --port 8770
 */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 8770;
const BASE = `http://127.0.0.1:${port}`;

async function get(pathname) {
  const res = await fetch(`${BASE}${pathname}`);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function goal(goalText, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/goal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: goalText }),
      signal: controller.signal
    });
    return { status: res.status, body: await res.json() };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const health = await get('/health');
  console.log('DSH plugin health:', JSON.stringify(health.body));
  if (health.status !== 200) {
    console.error('DSH plugin is not up. Install/restart DSH first (scripts/install-dsh-plugin.js).');
    process.exit(1);
  }
  const mc = await fetch('http://127.0.0.1:8766/ui/state').then((r) => r.json()).catch(() => null);
  if (!mc) {
    console.error('Minecraft agent panel 8766 is not up; start the agent first.');
    process.exit(1);
  }
  console.log('Minecraft agent:', JSON.stringify({ position: mc.world && mc.world.position, current: mc.brain && mc.brain.current }));

  const feasible = '获取 2 个泥土，然后停止。用 mc_step 一步一步执行。';
  console.log('\n[H1a] GOAL:', feasible);
  const a = await goal(feasible);
  console.log(JSON.stringify(a, null, 2));

  const impossible = '帮我合成一把钻石镐；我现在没有钻石，也没有工作台。做不到就说明缺什么，不要编造步骤。';
  console.log('\n[H1b] GOAL:', impossible);
  const b = await goal(impossible);
  console.log(JSON.stringify(b, null, 2));

  const okA = a.body && a.body.ok && Array.isArray(a.body.steps) && a.body.steps.length >= 2;
  const okB = b.body && b.body.ok && Array.isArray(b.body.steps) && b.body.steps.length === 0 && b.body.finish && b.body.finish.achieved === false;
  console.log(`\nH1a steps>=2: ${okA ? 'PASS' : 'FAIL'}`);
  console.log(`H1b no steps + achieved=false: ${okB ? 'PASS' : 'FAIL'}`);
  process.exitCode = okA && okB ? 0 : 1;
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
