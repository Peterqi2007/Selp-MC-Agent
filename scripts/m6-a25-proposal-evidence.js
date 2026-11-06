'use strict';

/**
 * `node scripts/m6-a25-proposal-evidence.js` - collect A25's four paths from the live logs.
 *
 * A25 (real client): accept / reject / no-answer / explicit-task-supersede must all be visible on a
 * proposal that the ACTION BRAIN proposed (not one planted by /test/proposal-plant).
 *
 * Sources: the agent logs (`proposal pN: target`, `autonomous proposal pN accepted`,
 * `proposal pN expired unanswered`, `autonomous proposal rejected|superseded`, `chat command: <who>
 * !...`, `task ... accepted: ... (action-brain)`) and the live proposal desk.
 *
 * Planted test proposals are recognised by their target prefix (`r3-restart-*` from the R3 probe)
 * and excluded from the A25 verdict - they prove the desk lifecycle, not the real four paths.
 *
 * Usage: node scripts/m6-a25-proposal-evidence.js [--minutes 120] [--out runtime/evidence]
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const args = process.argv.slice(2);
const argValue = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const AGENT_PORT = Number(argValue('--agent', 8766));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(ROOT, argValue('--out', path.join('runtime', 'evidence')));
const MINUTES = Number(argValue('--minutes', 120));

function request(port, method, urlPath, body, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: {
        'user-agent': 'a25-evidence/1',
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {})
      },
      timeout
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text)); } catch (err) { reject(new Error(`not JSON: ${text.slice(0, 120)}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function agentLogs() {
  const dir = path.join(ROOT, 'runtime', 'logs');
  return fs.readdirSync(dir)
    .filter((name) => /^agent.*\.log$/.test(name) && !name.includes('.err.'))
    .map((name) => ({ name, file: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function collect() {
  const since = new Date(Date.now() - MINUTES * 60 * 1000).toISOString().slice(0, 19);
  const lines = [];
  for (const log of agentLogs()) {
    for (const line of fs.readFileSync(log.file, 'utf8').split(String.fromCharCode(10))) {
      if (!line || line.slice(0, 19) < since) continue;
      if (/(proposal p\d+|autonomous proposal|chat command: <|task \S+ accepted:)/.test(line)) lines.push(line);
    }
  }
  lines.sort((a, b) => a.slice(0, 23).localeCompare(b.slice(0, 23)));
  return lines;
}

async function main() {
  const proposals = new Map();
  const ensure = (id) => {
    if (!proposals.has(id)) proposals.set(id, { id, target: null, created: null, outcome: null, superseded: null, command: null, executionTask: null, cooldown: null, lines: [] });
    return proposals.get(id);
  };
  const openOne = () => [...proposals.values()].filter((r) => !r.outcome && !r.superseded).pop() || null;

  for (const line of collect()) {
    const at = line.slice(0, 23);
    let m;
    if ((m = /proposal (p\d+): ([^ ]+) \(/.exec(line))) {
      const rec = ensure(m[1]);
      rec.created = at;
      rec.target = m[2];
      rec.lines.push(line);
      continue;
    }
    if ((m = /autonomous proposal (p\d+) accepted/.exec(line))) {
      const rec = ensure(m[1]);
      rec.outcome = { at, kind: 'accepted' };
      rec.lines.push(line);
      continue;
    }
    if ((m = /proposal (p\d+) expired unanswered/.exec(line))) {
      const rec = ensure(m[1]);
      rec.outcome = { at, kind: 'expired' };
      rec.lines.push(line);
      continue;
    }
    if (/autonomous proposal rejected/.test(line)) {
      const rec = openOne();
      if (rec) {
        rec.outcome = { at, kind: 'rejected' };
        rec.cooldown = line.slice(24);
        rec.lines.push(line);
      }
      continue;
    }
    if (/autonomous proposal superseded/.test(line)) {
      const rec = openOne();
      if (rec) {
        rec.superseded = { at };
        rec.cooldown = line.slice(24);
        rec.lines.push(line);
      }
      continue;
    }
    if ((m = /chat command: <([^>]+)> (!.+)$/.exec(line))) {
      const rec = openOne();
      if (rec) {
        rec.command = { at, who: m[1], text: m[2].trim() };
        rec.lines.push(line);
      }
      continue;
    }
    if ((m = /task (\S+) accepted: (\S+) \(action-brain\)/.exec(line))) {
      const rec = [...proposals.values()].filter((r) => r.outcome && r.outcome.kind === 'accepted' && !r.executionTask).pop();
      if (rec) {
        rec.executionTask = { at, id: m[1], kind: m[2] };
        rec.lines.push(line);
      }
    }
  }

  const records = [...proposals.values()].map((rec) => {
    const excluded = /^r3-restart-/.test(String(rec.target || ''));
    let path = null;
    if (excluded) path = 'excluded-test-hook';
    else if (rec.outcome && rec.outcome.kind === 'accepted') path = 'accept';
    else if (rec.outcome && rec.outcome.kind === 'rejected') path = 'reject';
    else if (rec.outcome && rec.outcome.kind === 'expired') path = 'no-answer';
    else if (rec.superseded) path = 'explicit-task-supersede';
    return {
      id: rec.id,
      target: rec.target,
      path,
      created: rec.created,
      outcome: rec.outcome,
      superseded: rec.superseded,
      explicitCommand: rec.command,
      executionTask: rec.executionTask,
      cooldownNote: rec.cooldown,
      lines: rec.lines
    };
  });

  const desk = await request(AGENT_PORT, 'POST', '/command', { command: 'proposal status' }).catch(() => null);
  const deskStatus = new Map(((desk && desk.result && desk.result.recent) || []).map((e) => [e.id, e.status]));
  for (const rec of records) rec.deskStatus = deskStatus.get(rec.id) || null;

  const paths = ['accept', 'reject', 'no-answer', 'explicit-task-supersede'];
  const covered = paths.filter((name) => records.some((r) => r.path === name));
  const evidence = {
    case: 'A25',
    claim: '自主提案四路径：接受才执行 / 拒绝后不重复 / 不答≠同意 / 显式任务优先（提案作废）',
    window: { since: new Date(Date.now() - MINUTES * 60 * 1000).toISOString(), minutes: MINUTES },
    proposals: records,
    covered,
    missing: paths.filter((name) => !covered.includes(name)),
    verdict: covered.length === paths.length ? 'PASS' : 'PARTIAL',
    note: 'real action-brain proposals only (test-hook planted proposals are listed but excluded)',
    generatedAt: new Date().toISOString()
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `a25-proposals-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  for (const rec of records) {
    process.stdout.write(`${rec.id} ${rec.path || 'unknown'} target=${rec.target} created=${rec.created} outcome=${JSON.stringify(rec.outcome)} superseded=${rec.superseded && rec.superseded.at} cmd=${rec.explicitCommand && rec.explicitCommand.text} task=${rec.executionTask && rec.executionTask.kind}\n`);
  }
  process.stdout.write(`\ncovered: ${covered.join(', ')}\nmissing: ${evidence.missing.join(', ') || '(none)'}\nverdict: ${evidence.verdict}\nevidence: ${path.relative(ROOT, file)}\n`);
  if (evidence.verdict !== 'PASS') process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
