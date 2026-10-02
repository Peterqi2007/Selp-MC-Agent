#!/usr/bin/env node
'use strict';

/**
 * Run the `sleep` skill once, against the live client, with the world clock printed.
 *
 * The acceptance script skips this check during the day, so this probe exists to try it
 * on demand (the operator sets night, or the clock is already close enough). It prints
 * the time before and after plus the game's own chat lines when the bed refuses.
 *
 *   node scripts/sleep-probe.js [timeoutSeconds]
 */

const { loadConfig } = require('../src/util/config');
const { ClientModBody } = require('../src/body/clientModBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const skills = require('../src/skills');

function clock(state) {
  const time = state && state.time;
  if (!time) return 'unknown';
  const day = Number.isFinite(time.timeOfDay) ? !(time.timeOfDay % 24000 >= 12542 && time.timeOfDay % 24000 <= 23458) : null;
  return `timeOfDay=${time.timeOfDay} isDay(mod)=${time.isDay} derivedIsDay=${day}`;
}

async function main() {
  const timeoutMs = Number(process.argv[2] || 90) * 1000;
  const cfg = loadConfig();
  const body = new ClientModBody(cfg, { log: console });
  const attached = await body.connect({ waitMs: 15000 });
  if (!attached) {
    console.error('client mod is not answering on 127.0.0.1:8899');
    process.exitCode = 1;
    return;
  }
  await body.refresh(true);
  console.log('before:', clock(body.snapshot()));
  await body.clearChat();
  const ctx = { cfg, body, world: new BodyWorldView(body, cfg, { log: console }), log: console };
  const result = await skills.run('sleep', ctx, { timeoutMs });
  console.log('after :', clock(body.snapshot()));
  console.log('RESULT', JSON.stringify(result));
  const chat = await body.readChat(8);
  if (chat && chat.lines && chat.lines.length) console.log('chat:', JSON.stringify(chat.lines));
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((err) => {
  console.error('sleep probe failed:', err.stack || err.message);
  process.exitCode = 1;
});
