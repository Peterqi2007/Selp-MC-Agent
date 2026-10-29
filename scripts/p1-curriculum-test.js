'use strict';

/**
 * Voyager-style automatic curriculum (2026-10-29).
 *
 * Offline contract for `src/planner/curriculum.js` and its two integration points:
 *
 *   - the proposal-prep goal carries completed/failed tasks + a difficulty band
 *     (automatic curriculum, `refs/Voyager/voyager/prompts/curriculum.txt`);
 *   - `Brain.proposeFromHarness` refuses below-band autonomous proposals up to a retry
 *     budget, then relaxes (no deadlock);
 *   - the execution goal's phase feeds the completed/failed ledger, which persists.
 *
 * No model, no DSH, no Minecraft.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { Curriculum } = require(path.join(ROOT, 'src/planner', 'curriculum'));
const { AutonomousProposalCoordinator } = require(path.join(ROOT, 'src/planner', 'autonomousProposals'));

const silent = { info() {}, warn() {}, debug() {} };
const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    process.stdout.write(`  FAIL  ${name}\n    ${err && err.message}\n`);
  }
}

function makeCurriculum(extra = {}) {
  return new Curriculum({ file: null, log: silent, now: () => extra.now || 1_000_000, ...extra });
}

async function main() {
  process.stdout.write('Automatic curriculum (Voyager-style, offline)\n\n');

  await check('difficulty is a table over command-table types, not a guess', () => {
    const c = makeCurriculum();
    assert.strictEqual(c.difficultyOf({ type: 'chop' }), 1);
    assert.strictEqual(c.difficultyOf({ type: 'mine', args: { block: 'stone', count: 4 } }), 1);
    assert.strictEqual(c.difficultyOf({ type: 'mine', args: { block: 'iron_ore', count: 4 } }), 2);
    assert.strictEqual(c.difficultyOf({ type: 'mine', args: { block: 'diamond_ore', count: 4 } }), 4);
    assert.strictEqual(c.difficultyOf({ type: 'mine-ore', args: { block: 'deepslate_gold_ore' } }), 3);
    assert.strictEqual(c.difficultyOf({ type: 'attack' }), 2);
    assert.strictEqual(c.difficultyOf({ type: 'mine', args: { block: 'stone', count: 32 } }), 2);
    assert.strictEqual(c.difficultyOf({ type: 'unknown' }), 1);
  });

  await check('the band grows with completed tasks and is capped', () => {
    const c = makeCurriculum();
    assert.strictEqual(c.level(), 1);
    c.recordCompleted({ name: 'chop', type: 'chop', difficulty: 1 });
    assert.strictEqual(c.level(), 1);
    c.recordCompleted({ name: 'mine', type: 'mine', difficulty: 1 });
    assert.strictEqual(c.level(), 2);
    c.recordCompleted({ name: 'craft', type: 'craft', difficulty: 2 });
    c.recordCompleted({ name: 'smelt', type: 'smelt', difficulty: 2 });
    assert.strictEqual(c.level(), 3);
    for (let i = 0; i < 20; i += 1) c.recordCompleted({ name: `t${i}`, type: 'mine', difficulty: 3 });
    assert.strictEqual(c.level(), c.cfg.maxLevel);
  });

  await check('a below-band proposal is refused, retried, then relaxed (no deadlock)', () => {
    const c = makeCurriculum();
    c.recordCompleted({ name: 'a', type: 'chop', difficulty: 1 });
    c.recordCompleted({ name: 'b', type: 'mine', difficulty: 1 });
    assert.strictEqual(c.level(), 2);
    const first = c.validate({ type: 'chop' });
    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.reason, 'difficulty-below-curriculum');
    assert.strictEqual(first.required, 2);
    assert.strictEqual(first.actual, 1);
    const second = c.validate({ type: 'chop' });
    assert.strictEqual(second.ok, false);
    const third = c.validate({ type: 'chop' });
    assert.strictEqual(third.ok, true);
    assert.strictEqual(third.reason, 'curriculum-relaxed');
    assert.strictEqual(c.validate({ type: 'mine', args: { block: 'iron_ore' } }).ok, true);
    // A successful validation clears the retry counter for the next round.
    assert.strictEqual(c.rejections, 0);
  });

  await check('the prep context carries history, band, focus and Voyager rules', () => {
    const c = makeCurriculum();
    c.recordCompleted({ name: 'chop 8', type: 'chop', difficulty: 1 });
    c.recordFailed({ name: 'mine diamond', type: 'mine', difficulty: 4, reason: 'no pickaxe' });
    const text = c.describe();
    assert.match(text, /AUTOMATIC CURRICULUM/);
    assert.match(text, /Completed tasks so far \(1\)/);
    assert.match(text, /chop 8/);
    assert.match(text, /Failed tasks that were too hard: mine diamond — no pickaxe/);
    assert.match(text, /difficulty band: level 1\/4/);
    assert.match(text, /Novel and useful/);
    assert.match(text, /do not repeat the last completed task/i);
    assert.match(text, /Do not build or dig shelter/);
    assert.match(text, /complete the goal instead of inventing work/);
  });

  await check('the ledger survives a restart (atomic temp+rename)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-'));
    const file = path.join(dir, 'curriculum.json');
    const first = new Curriculum({ file, log: silent });
    first.recordCompleted({ name: 'chop', type: 'chop', difficulty: 1 });
    first.recordCompleted({ name: 'craft', type: 'craft', difficulty: 2 });
    first.recordFailed({ name: 'diamond', type: 'mine', difficulty: 4, reason: 'no pickaxe' });
    assert(fs.existsSync(file));
    const second = new Curriculum({ file, log: silent });
    assert.strictEqual(second.completed.length, 2);
    assert.strictEqual(second.failed.length, 1);
    assert.strictEqual(second.level(), 2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('the proposal-prep goal carries the curriculum context', async () => {
    const curriculum = makeCurriculum();
    curriculum.recordCompleted({ name: 'chop', type: 'chop', difficulty: 1 });
    curriculum.recordCompleted({ name: 'craft', type: 'craft', difficulty: 2 });
    const created = [];
    const bridge = {
      async boundAgentId() {
        return 'agent-1';
      },
      async goalOf() {
        return null;
      },
      async createGoal(request) {
        created.push(request);
        return { ok: true, goal: { id: 'goal-prep', revision: 1 }, agentId: 'agent-1' };
      },
      async completeGoal() {
        return { ok: true };
      }
    };
    const coordinator = new AutonomousProposalCoordinator({
      brain: {},
      bridge,
      curriculum,
      cfg: { idleMs: 0 },
      now: () => 1000,
      log: silent
    });
    const result = await coordinator.startPrep();
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(created.length, 1);
    assert.strictEqual(created[0].purpose, 'proposal');
    assert.match(created[0].goal, /Autonomous task proposal request/);
    assert.match(created[0].goal, /AUTOMATIC CURRICULUM/);
    assert.match(created[0].goal, /difficulty band: level 2\/4/);
    await coordinator.completePrep('test');
  });

  await check('an execution goal phase feeds the ledger (complete vs blocked)', async () => {
    const curriculum = makeCurriculum();
    const phases = ['complete', 'blocked'];
    const bridge = {
      async boundAgentId() {
        return 'agent-1';
      },
      async goalOf() {
        return phases.length ? { phase: phases.shift(), blockedReason: 'no pickaxe' } : null;
      }
    };
    const coordinator = new AutonomousProposalCoordinator({
      brain: {},
      bridge,
      curriculum,
      cfg: { idleMs: 0 },
      now: () => 1000,
      log: silent
    });
    coordinator.executionGoal = {
      id: 'g1',
      agentId: 'agent-1',
      candidate: { type: 'mine', name: 'mine iron', difficulty: 2 }
    };
    await coordinator.tick();
    assert.strictEqual(curriculum.completed.length, 1);
    assert.strictEqual(curriculum.completed[0].name, 'mine iron');
    coordinator.executionGoal = {
      id: 'g2',
      agentId: 'agent-1',
      candidate: { type: 'mine', name: 'mine diamond', difficulty: 4 }
    };
    await coordinator.tick();
    assert.strictEqual(curriculum.failed.length, 1);
    assert.strictEqual(curriculum.failed[0].reason, 'no pickaxe');
  });

  await check('the brain and plugin are wired to the curriculum', () => {
    const brain = fs.readFileSync(path.join(ROOT, 'src', 'brain.js'), 'utf8');
    assert.match(brain, /curriculum\.validate\(/);
    assert.match(brain, /verdict\.reason/);
    assert.match(brain, /normalized\.difficulty/);
    const plugin = fs.readFileSync(path.join(ROOT, 'dsh-plugin-mc-harness', 'lib', 'index.js'), 'utf8');
    assert.match(plugin, /CONTEXT: \$\{goal\}/, 'the prep prompt must carry the goal text (and its curriculum block)');
    const index = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
    assert.match(index, /new Curriculum\(/);
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'agent.json'), 'utf8'));
    assert.strictEqual(config.planner.autonomousProposals.curriculum.enabled, true);
    assert.strictEqual(config.planner.autonomousProposals.curriculum.bandStep, 2);
  });

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write('FAILED\n');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
