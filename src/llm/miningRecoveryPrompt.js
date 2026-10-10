'use strict';

/**
 * Recovery prompt + response contract (docs/MINING-LLM-PLAN.md §5.7.2).
 *
 * The recovery session speaks a schema-constrained short-batch JSON - not the chat
 * persona prompt, and not the public tool catalogue. Everything the model sees is
 * assembled here from Node-verified observations; everything it answers is parsed here
 * before a single tool call is allowed to run.
 */

const { toolNames } = require('./miningRecoveryTools');

const SYSTEM = [
  'You are the exception-recovery controller for one Minecraft mining task.',
  'The deterministic macro has stopped because it could not make progress; you decide the next small batch of actions.',
  '',
  'Rules:',
  '- Answer with ONE JSON object, no prose, matching the schema below.',
  '- You may only use these tools: ' + toolNames().join(', ') + '.',
  '- A batch has 1..N steps (N is given in the state); each step is {"id","tool","args","purpose","expected"}.',
  '- Coordinates must be integer block cells. Lines that are not in the provided scan are unknown - never invent them.',
  '- The locked target ore is mined only through mine_block(goalId). dig_cells must never touch it or any other ore of the task set.',
  '- pillar_up never digs; clear the headroom with dig_cells first, one hop per call.',
  '- collect_target runs one bounded pickup attempt; it never digs or climbs.',
  '- Success for you is: the target has a confirmed dig AND at least one product is in the inventory. A vanished item entity or an arrived walk is NOT success.',
  '- If no legal action can make progress, answer decision "stop" with a short reason.',
  '',
  'Response schema:',
  '{"recoveryId": string, "goalId": string, "basedOnRevision": number,',
  ' "decision": "execute" | "inspect" | "stop",',
  ' "steps": [{"id": string, "tool": string, "args": object, "purpose": string, "expected": {"type": string}}],',
  ' "inspect": {"center": {x,y,z}, "radiusXZ": number, "yMin": number, "yMax": number},',
  ' "reason": string}',
  'decision "execute" requires steps and no inspect; "inspect" requires inspect and no steps; "stop" requires a reason.'
].join('\n');

/**
 * Render the per-round user message from a Node-built report.
 *
 * @param {object} report built by MiningRecoverySession.buildReport()
 */
function renderReport(report) {
  const lines = [];
  lines.push(`recoveryId=${report.recoveryId} goalId=${report.goalId} basedOnRevision=${report.revision}`);
  lines.push(`mode=${report.mode} phase=${report.phase} decision budget: up to ${report.maxActions} base action(s) this batch`);
  lines.push(`target: ${report.target.blockId} @ ${report.target.position.x},${report.target.position.y},${report.target.position.z}`);
  lines.push(`mined=${report.acquisition.mined} verified=${report.acquisition.verified} collected=${report.acquisition.collectedItems} pendingDrops=${report.acquisition.pendingDrops}`);
  lines.push(`feet: ${report.position.x},${report.position.y},${report.position.z} grounded=${report.grounded}`);
  lines.push(`held=${report.held || 'nothing'} support=${report.scaffold || 'none'} inventoryCanAccept=${report.canAccept}`);
  lines.push(`trigger: ${report.trigger} (${report.triggerReason})`);
  lines.push(`budget: calls ${report.budget.callsUsed}/${report.budget.maxCalls}, primitives ${report.budget.primitiveUsed}/${report.budget.maxPrimitives}, placed ${report.budget.placedUsed}/${report.budget.maxPlaced}, sessionLeftMs=${report.budget.sessionLeftMs}`);
  if (report.pendingDropsList && report.pendingDropsList.length) {
    lines.push('pending products:');
    for (const drop of report.pendingDropsList) {
      lines.push(`  - ${drop.name} x${drop.count} @ ${drop.position.x},${drop.position.y},${drop.position.z}`);
    }
  }
  lines.push('local blocks (bare names; unknown = not scanned):');
  for (const cell of report.cells || []) {
    lines.push(`  ${cell.x},${cell.y},${cell.z} = ${cell.name}`);
  }
  if (report.notes && report.notes.length) {
    lines.push('notes:');
    for (const note of report.notes) lines.push(`  - ${note}`);
  }
  lines.push('recent action receipts:');
  for (const receipt of report.receipts || []) {
    lines.push(`  ${JSON.stringify(receipt)}`);
  }
  if (report.repairHint) lines.push(`your previous answer was rejected: ${report.repairHint}`);
  return lines.join('\n');
}

/**
 * Parse and envelope-validate one model response.
 *
 * @param {string} text
 * @returns {{ok:true, batch:object} | {ok:false, reason:string}}
 */
function parseRecoveryResponse(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, reason: 'empty response' };
  let json = raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) json = fenced[1];
  else {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) json = raw.slice(start, end + 1);
  }
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'the answer must be a JSON object' };
  if (typeof parsed.recoveryId !== 'string' || !parsed.recoveryId) return { ok: false, reason: 'recoveryId is required' };
  if (typeof parsed.goalId !== 'string' || !parsed.goalId) return { ok: false, reason: 'goalId is required' };
  if (!Number.isInteger(parsed.basedOnRevision)) return { ok: false, reason: 'basedOnRevision must be an integer' };
  if (!['execute', 'inspect', 'stop'].includes(parsed.decision)) return { ok: false, reason: `unknown decision "${parsed.decision}"` };
  if (parsed.decision === 'execute') {
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) return { ok: false, reason: 'execute needs a non-empty steps array' };
    if (parsed.inspect !== undefined) return { ok: false, reason: 'execute cannot carry an inspect request' };
  }
  if (parsed.decision === 'inspect') {
    if (parsed.steps !== undefined) return { ok: false, reason: 'inspect cannot carry steps' };
    const insp = parsed.inspect;
    if (!insp || typeof insp !== 'object' || !insp.center || typeof insp.center !== 'object') {
      return { ok: false, reason: 'inspect needs a center' };
    }
    for (const axis of ['x', 'y', 'z']) {
      if (!Number.isInteger(insp.center[axis])) return { ok: false, reason: 'inspect center must use integer coordinates' };
    }
    const radius = Number(insp.radiusXZ);
    if (!Number.isFinite(radius) || radius <= 0 || radius > 4) return { ok: false, reason: 'inspect radiusXZ must be 1..4' };
    const yMin = Number(insp.yMin);
    const yMax = Number(insp.yMax);
    if (!Number.isFinite(yMin) || !Number.isFinite(yMax) || yMax < yMin || yMax - yMin > 7) {
      return { ok: false, reason: 'inspect yMin/yMax must span at most 7 layers' };
    }
  }
  if (parsed.decision === 'stop') {
    if (typeof parsed.reason !== 'string' || !parsed.reason.trim() || parsed.reason.length > 300) {
      return { ok: false, reason: 'stop needs a short written reason' };
    }
    if (parsed.steps !== undefined || parsed.inspect !== undefined) return { ok: false, reason: 'stop cannot carry steps or inspect' };
  }
  return { ok: true, batch: parsed };
}

module.exports = { SYSTEM, renderReport, parseRecoveryResponse };
