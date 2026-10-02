#!/usr/bin/env node
'use strict';

/**
 * Run ONE skill against the live client, from the command line.
 *
 * The acceptance script owns the whole Phase-2/3 battery; this is the ad-hoc door for a
 * single action on whatever client is attached (personal server, single player, or - with
 * the operator's explicit say-so - the real server):
 *
 *   node scripts/run-skill.js craft wooden_hoe count=1
 *   node scripts/run-skill.js farm radius=6 plots=6 seed=wheat_seeds harvest=false
 *   node scripts/run-skill.js smelt raw_iron count=1
 *
 * Parameters are `key=value`; `true`/`false` become booleans and numeric text becomes a
 * number. The inventory before/after is printed so the caller can check the real result
 * instead of trusting the skill's own summary.
 */

const { loadConfig } = require('../src/util/config');
const { ClientModBody } = require('../src/body/clientModBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const skills = require('../src/skills');

function parseValue(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text !== '' && Number.isFinite(Number(text))) return Number(text);
  return text;
}

function parseParams(rest) {
  const params = {};
  for (const arg of rest) {
    const eq = arg.indexOf('=');
    if (eq > 0) params[arg.slice(0, eq)] = parseValue(arg.slice(eq + 1));
  }
  return params;
}

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name) {
    console.error('usage: node scripts/run-skill.js <skill> [key=value ...]');
    process.exitCode = 2;
    return;
  }
  const cfg = loadConfig();
  const body = new ClientModBody(cfg, { log: console });
  const attached = await body.connect({ waitMs: 15000 });
  if (!attached) {
    console.error('the control mod is not answering on 127.0.0.1:8899');
    process.exitCode = 1;
    return;
  }
  await body.refresh(true);
  const before = body.snapshot() || {};
  console.log('skill  :', name, JSON.stringify(parseParams(rest)));
  console.log('before :', JSON.stringify({ pos: before.position, held: before.heldItem, inv: before.inventory }));

  const ctx = { cfg, body, world: new BodyWorldView(body, cfg, { log: console }), log: console };
  const result = await skills.run(name, ctx, parseParams(rest));
  console.log('RESULT', JSON.stringify(result));

  await body.refresh(true);
  const after = body.snapshot() || {};
  console.log('after  :', JSON.stringify({ pos: after.position, held: after.heldItem, inv: after.inventory }));
  process.exitCode = result && result.ok ? 0 : 1;
}

main().catch((err) => {
  console.error('run-skill failed:', err.stack || err.message);
  process.exitCode = 1;
});
