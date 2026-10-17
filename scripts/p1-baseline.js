'use strict';

/**
 * `npm run p1:baseline` - a reproducible P1 baseline record (offline only).
 *
 * M0 requires "可复现基线". This script records the facts that make a later run
 * comparable: the exact commit, whether the tree was dirty, Node and dependency versions,
 * hashes of the configuration that changes behaviour, the client jar identity, and
 * optionally the result of the offline suites.
 *
 * What it deliberately does NOT do: start Minecraft, touch the network, call a model, or
 * read anything from `runtime/` other than writing its own output. Client measurements are
 * registered in docs/P1-CLIENT-TESTS.md and must be run in a separate, approved window.
 *
 * Usage:
 *   node scripts/p1-baseline.js              # facts only (fast)
 *   node scripts/p1-baseline.js --suites      # also run planner:test and plan:audit --stage p1
 *
 * Output: runtime/p1-baseline.json (gitignored; paste the relevant block into an M0 record
 * when freezing a milestone).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'runtime', 'p1-baseline.json');
const args = process.argv.slice(2);
const withSuites = args.includes('--suites');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeoutMs || 180000
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function hashOf(relative) {
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  return { bytes: stat.size, sha256: sha256(full) };
}

function git(...commandArgs) {
  const result = run('git', commandArgs);
  return result.ok ? result.stdout : null;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const dirty = git('status', '--porcelain');
const jarDir = path.join(ROOT, 'mod-client', 'dist');
const jar = fs.existsSync(jarDir)
  ? fs.readdirSync(jarDir).find((name) => name.endsWith('.jar')) || null
  : null;

const record = {
  kind: 'p1-baseline',
  recordedAt: new Date().toISOString(),
  project: pkg.name,
  version: pkg.version,
  git: {
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    commit: git('rev-parse', 'HEAD'),
    shortCommit: git('rev-parse', '--short', 'HEAD'),
    commitDate: git('log', '-1', '--format=%cI'),
    dirty: !!dirty,
    dirtyEntries: dirty ? dirty.split('\n') : []
  },
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch
  },
  dependencies: pkg.dependencies || {},
  config: Object.fromEntries(
    ['config/agent.json', 'config/llm.json', 'config/persona.md', 'config/safety.md'].map((file) => [
      file,
      hashOf(file)
    ])
  ),
  clientMod: jar
    ? {
        file: `mod-client/dist/${jar}`,
        ...hashOf(`mod-client/dist/${jar}`)
      }
    : null,
  /** Values that must be measured in a client window; recorded as deferred, never guessed. */
  deferredToClientWindow: [
    '/state latency, scan count and cache age while idle / moving / mining / reflex / GUI',
    'CPU and event-loop delays under the same workloads',
    'CU feasibility F1: can dsh-computer-use be restricted to the Minecraft window',
    'real-client baseline re-run (one chop / mine / goto on the target server)'
  ]
};

if (withSuites) {
  record.suites = {};
  for (const [name, commandArgs] of [
    ['planner:test', ['scripts/planner-retirement-test.js']],
    ['plan:audit:p1', ['scripts/plan-audit.js', '--stage', 'p1']]
  ]) {
    const started = Date.now();
    const result = run(process.execPath, commandArgs);
    const tail = result.stdout.split('\n').filter(Boolean).slice(-1)[0] || result.stderr;
    record.suites[name] = {
      ok: result.ok,
      status: result.status,
      ms: Date.now() - started,
      tail
    };
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`p1 baseline -> ${path.relative(ROOT, OUT)}\n`);
process.stdout.write(
  `  commit ${record.git.shortCommit} (${record.git.branch})${record.git.dirty ? ' DIRTY' : ' clean'}\n`
);
process.stdout.write(`  node ${record.runtime.node}\n`);
if (record.clientMod) process.stdout.write(`  client mod ${record.clientMod.file} (${record.clientMod.bytes} bytes)\n`);
if (record.suites) {
  for (const [name, suite] of Object.entries(record.suites)) {
    process.stdout.write(`  ${suite.ok ? 'PASS' : 'FAIL'} ${name}: ${suite.tail}\n`);
  }
}
process.stdout.write('  client measurements remain deferred (docs/P1-CLIENT-TESTS.md)\n');
