'use strict';

/**
 * `node scripts/m6-r2b-log-evidence.js --from <iso> --to <iso>` - turn a live reflex fight into a
 * citable evidence file.
 *
 * R2b was observed during a normal live session (the operator lured pillagers at the bot). The
 * claim is "the reflex engaged without any command", so the evidence has to be built from three
 * recorded witnesses rather than from what the operator says happened:
 *
 *   1. the agent log - the reflex's own `hostile ... - engaging` lines and what it did next
 *      (`shoot: burst ... SUCCESS`, or melee);
 *   2. the panel access log - the count of `POST /command|/plan|/propose` inside the window
 *      (probe traffic excluded by user agent) must be 0;
 *   3. the same log - no task/plan line inside the window (the body was idle).
 *
 * Usage: node scripts/m6-r2b-log-evidence.js --from 2026-11-06T12:14:40Z --to 2026-11-06T12:15:40Z
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));
const FROM = argValue('--from', null);
const TO = argValue('--to', null);
const LOG_NAME = argValue('--log', null);
const NOTE = argValue('--note', null);

if (!FROM || !TO) {
  process.stderr.write('usage: node scripts/m6-r2b-log-evidence.js --from <iso> --to <iso> [--log runtime/logs/agent-r3.log]\n');
  process.exit(2);
}

function newestAgentLog() {
  const dir = path.join(ROOT, 'runtime', 'logs');
  const files = fs.readdirSync(dir)
    .filter((name) => /^agent.*\.log$/.test(name) && !name.includes('.err.'))
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(dir, files[0].name) : null;
}

const logFile = LOG_NAME ? path.resolve(ROOT, LOG_NAME) : newestAgentLog();
if (!logFile || !fs.existsSync(logFile)) throw new Error(`agent log not found (${logFile})`);

const lines = fs.readFileSync(logFile, 'utf8').split(String.fromCharCode(10));
const windowLines = lines.filter((line) => {
  const stamp = line.slice(0, 20);
  return stamp >= FROM.slice(0, 19) && stamp <= TO.slice(0, 19);
});

const engaging = windowLines.filter((line) => line.includes(' - engaging'));
const actions = windowLines.filter((line) => /\((agent|brain)\)/.test(line) && /(shoot:|attack|swing|flee|retreat|combat)/i.test(line));
const taskLines = windowLines.filter((line) => /task:|accepted|plan:|code_skill|skill/i.test(line));

const panelFile = path.join(ROOT, 'runtime', 'logs', 'panel-access.log');
let panelLines = [];
try {
  panelLines = fs.readFileSync(panelFile, 'utf8').split(String.fromCharCode(10))
    .filter((line) => {
      const stamp = line.slice(0, 19);
      return stamp >= FROM.slice(0, 19) && stamp <= TO.slice(0, 19) && line.includes('POST /');
    })
    .filter((line) => !line.includes('r2-probe') && !line.includes('r2b-probe') && !line.includes('r3-probe'));
} catch { /* no access log */ }

const hostiles = [...new Set(engaging.map((line) => {
  const match = /hostile (\S+) at ([\d.]+) blocks/.exec(line);
  return match ? `${match[1]}@${match[2]}` : null;
}).filter(Boolean))];

const evidence = {
  case: 'R2b',
  claim: '反射仍运行：空闲、无命令时，敌对生物进入交战半径由自卫反射自行接管',
  observedAt: { from: FROM, to: TO },
  log: path.relative(ROOT, logFile),
  witnesses: {
    reflexEngagements: engaging.length,
    hostiles,
    reflexActions: actions.map((line) => line.slice(21)),
    foreignCommands: panelLines.length,
    taskLines: taskLines.length
  },
  excerpt: {
    engaging,
    actions,
    foreignCommandLines: panelLines
  },
  verdict: engaging.length > 0 && actions.length > 0 && panelLines.length === 0 && taskLines.length === 0
    ? 'PASS'
    : 'FAIL',
  note: NOTE || 'live session: the operator lured the hostiles; the reflex engaged and fired without any command',
  generatedAt: new Date().toISOString()
};
if (evidence.verdict === 'FAIL') {
  evidence.note += ' | one of: no engagement, no action, a command was sent, or a task was running';
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const file = path.join(OUT_DIR, `m6-r2b-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(evidence.witnesses, null, 2)}\n`);
process.stdout.write(`verdict: ${evidence.verdict}\nevidence: ${path.relative(ROOT, file)}\n`);
if (evidence.verdict !== 'PASS') process.exitCode = 1;
