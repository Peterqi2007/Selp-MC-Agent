'use strict';

/**
 * `npm run p1:verify` - the offline P1 acceptance gate.
 *
 * It runs the deterministic suites in sequence (not in parallel: several create a Brain and
 * would compete for the same runtime files):
 *
 *   - P0 regression (8 suites) unless `--fast`
 *   - planner:test      (S0-S4 retirement + proposals)
 *   - p1:contract:test  (M1-M6 offline contracts)
 *   - p1:language:test  (unified language-brain facade: profiles/tools/memory/approval)
 *   - p1:fault:test     (timeout/cancel/takeover/restart drills)
 *   - plan:audit --stage p1
 *
 * It never starts Minecraft, never calls a model, and never executes generated code. Passing
 * this gate does NOT mean P1 is accepted: client/model items are listed in
 * docs/P1-CLIENT-TESTS.md and remain unexecuted.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const fast = process.argv.includes('--fast');

const suites = [
  ...(fast ? [] : [{ name: 'P0 regression', script: 'scripts/p0-verify.js' }]),
  { name: 'planner:test', script: 'scripts/planner-retirement-test.js' },
  { name: 'p1:contract:test', script: 'scripts/p1-contract-test.js' },
  { name: 'p1:m3:test', script: 'scripts/p1-m3-test.js' },
  { name: 'p1:m6:test', script: 'scripts/p1-m6-test.js' },
  { name: 'p1:proposal-autonomy:test', script: 'scripts/p1-proposal-autonomy-test.js' },
  { name: 'p1:language:test', script: 'scripts/p1-language-test.js' },
  { name: 'p1:m7:test', script: 'scripts/p1-m7-test.js' },
  { name: 'p1:m4:test', script: 'scripts/p1-m4-test.js' },
  { name: 'p1:fault:test', script: 'scripts/p1-fault-test.js' },
  { name: 'plan:audit p1', script: 'scripts/plan-audit.js', args: ['--stage', 'p1'] }
];

process.stdout.write(`P1 offline verification${fast ? ' (fast: P0 regression skipped)' : ''}\n\n`);

const results = [];
for (const suite of suites) {
  const started = Date.now();
  process.stdout.write(`\n=== ${suite.name} ===\n`);
  const result = spawnSync(process.execPath, [suite.script, ...(suite.args || [])], {
    cwd: ROOT,
    stdio: 'inherit',
    // Offline suites must never touch the live session-state file (config enables it).
    env: { ...process.env, P1_STATE: 'off' }
  });
  results.push({
    name: suite.name,
    ok: result.status === 0,
    status: result.status,
    ms: Date.now() - started
  });
}

const failed = results.filter((result) => !result.ok);
process.stdout.write(`\n${'='.repeat(64)}\n`);
for (const result of results) {
  process.stdout.write(
    `  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name.padEnd(22)} ${(result.ms / 1000).toFixed(1)}s\n`
  );
}
process.stdout.write(
  `\nP1 offline verification: ${results.length - failed.length}/${results.length} suites passed\n`
);
if (failed.length) {
  process.stdout.write('FAILED\n');
  process.exit(1);
}
process.stdout.write(
  'Offline contracts hold. Client/model items are NOT verified - docs/P1-CLIENT-TESTS.md is authoritative.\n'
);
