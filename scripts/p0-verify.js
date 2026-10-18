'use strict';

/**
 * `npm run p0:verify` - the whole P0 acceptance suite, offline, in one command.
 *
 * Runs every deliverable's own test in sequence and reports a single verdict. It exists
 * because P0 has five deliverables with five different proofs, and "did I break anything"
 * should be one command, not five remembered ones. Nothing here needs Minecraft, the
 * control mod or an API key - which is the point: the fast, deterministic checks cover the
 * logic, and the real-server checks (client:verify, client-real) cover the integration.
 *
 *   path:test       deliverable A - planner, walker, navigator (7 scenarios + 7 more)
 *   tasks:test      deliverable B - walk / break / collect primitives against a mock world
 *   llm:dry         deliverable C - intent schema, tool whitelist, fallback routing accuracy
 *   control:test    deliverables D + E - both chat channels, output policy, panel, death
 *   verify:roleplay the role-play layer - persona from file, the three proactive triggers,
 *                   and the guard that an unprompted turn can speak but never act
 *   clientmod:test  the client-mod body end to end against a fake control mod on a real socket
 *   selftest        the whole module graph plus the P0 control layer checks
 *   plan:audit      the plan's own §11 "做/不做" checklist, asserted against the code
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SUITES = [
  { name: 'path:test', script: 'scripts/path-test.js', deliverable: 'A  寻路' },
  { name: 'tasks:test', script: 'scripts/tasks-test.js', deliverable: 'B  三原语' },
  { name: 'llm:dry', script: 'scripts/llm-dry.js', deliverable: 'C  LLM 大脑 + 工具层' },
  { name: 'control:test', script: 'scripts/control-test.js', deliverable: 'D+E 通道与面板' },
  { name: 'verify:roleplay', script: 'scripts/verify-roleplay.js', deliverable: 'F  Role play' },
  { name: 'clientmod:test', script: 'scripts/clientmod-test.js', deliverable: 'F  clientmod 躯体' },
  { name: 'selftest', script: 'scripts/selftest.js', deliverable: '全量自检' },
  { name: 'plan:audit', script: 'scripts/plan-audit.js', deliverable: '计划符合性 §11' }
];

process.stdout.write('P0 acceptance suite (offline: no Minecraft, no control mod, no API key)\n\n');

const outcomes = [];
for (const suite of SUITES) {
  process.stdout.write(`${'='.repeat(70)}\n${suite.deliverable}  ->  npm run ${suite.name}\n${'='.repeat(70)}\n`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(ROOT, suite.script)], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, P1_STATE: 'off' }
  });
  const ms = Date.now() - started;
  outcomes.push({ ...suite, code: result.status, ms });
  process.stdout.write(`\n[${suite.name}] exit=${result.status} in ${ms}ms\n\n`);
}

const failed = outcomes.filter((o) => o.code !== 0);
process.stdout.write(`${'='.repeat(70)}\nP0 acceptance summary\n${'='.repeat(70)}\n`);
for (const o of outcomes) {
  process.stdout.write(`  ${o.code === 0 ? 'PASS' : 'FAIL'}  ${o.deliverable.padEnd(18)} npm run ${o.name.padEnd(14)} (${o.ms}ms)\n`);
}
process.stdout.write(
  `\n${outcomes.length - failed.length}/${outcomes.length} suites passed` +
    `${failed.length ? ` - FAILED: ${failed.map((f) => f.name).join(', ')}` : ''}\n`
);
if (failed.length) {
  process.exitCode = 1;
} else {
  process.stdout.write(
    '\nEverything P0 claims offline is verified. The remaining acceptance items need the\n' +
      'real server: `npm run client:verify` (mod protocol) and `node scripts/client-real.js`\n' +
      '(one real chop / mine / goto on mc.example.com).\n'
  );
}
