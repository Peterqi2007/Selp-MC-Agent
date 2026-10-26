'use strict';

/**
 * `npm run secrets:scan` - fail with a non-zero exit code if a credential-shaped string is
 * about to be committed.
 *
 * Why this exists: this repository's first 306 commits shipped a live provider API key, an
 * in-game AuthMe password, two server addresses and the author's `C:\Users\<name>` paths. All of
 * that had to be rewritten out of history, which changes every commit SHA and cannot be undone
 * once published. A scanner that runs before the commit is cheap; a history rewrite is not.
 *
 * Two modes:
 *   node scripts/scan-secrets.js             scan the tracked working tree (default, fast)
 *   node scripts/scan-secrets.js --history   scan every blob reachable from any ref (slow, use
 *                                            before publishing or after a config change)
 *
 * The rule set is deliberately narrow: it looks for shapes that are unambiguously secrets, plus
 * credential assignments whose value is not an obvious placeholder. It is not a replacement for
 * GitHub push protection / secret scanning - enable those too.
 */

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** Values that mean "no secret here" - empty, null, env reference, documentation placeholder. */
const PLACEHOLDER =
  /^(?:|null|none|true|false|undefined|~|<[^>]*>|\$\{[^}]*\}|\$[A-Z_]+|x+|test|test-key|test-token|k|probe-password|secret|dummy|fake|pw|pass|change-me|changeme|your-[a-z-]+|\.\.\.)$/i;

/** A package version range (`^9.0.0`) is a lockfile dependency called "token", not a secret. */
const SEMVER = /^\^?~?\d+(?:\.\d+){0,2}(?:[-+][\w.]+)?$/;

const RULES = [
  {
    name: 'provider API key',
    // DeepSeek/OpenAI `sk-`, GitHub PATs, AWS access key ids, Slack tokens.
    re: /(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/g
  },
  {
    name: 'private key block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g
  },
  {
    name: 'credential assigned a literal value',
    // `(?<![\w-])` keeps `_comment_apiKey` (documentation) from matching as `apiKey`.
    re: /(?<![\w-])["']?(api[_-]?key|apikey|secret|secret[_-]?key|token|access[_-]?token|password|passwd|authme[_-]?password)["']?\s*[:=]\s*["']([^"'\n]{4,})["']/gi,
    // Only the captured value decides; see PLACEHOLDER.
    valueGroup: 2
  },
  {
    name: 'URL with embedded credentials',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]+@[^\s/]+/gi,
    // Documentation examples (`socks5://user:pass@host:1080`) are not secrets.
    allow: (m) => /socks5:\/\/user:(pass|pw)@/i.test(m)
  }
];

const SKIP_EXT = new Set([
  '.jar', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.class', '.bin', '.log'
]);

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28, ...opts });
}

function scanText(text, where) {
  const hits = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const matched = m[0];
      if (rule.allow && rule.allow(matched)) continue;
      if (rule.valueGroup !== undefined) {
        const value = m[rule.valueGroup];
        if (PLACEHOLDER.test(value) || SEMVER.test(value)) continue;
      }
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ where, line, rule: rule.name, sample: matched.slice(0, 120) });
    }
  }
  return hits;
}

function scanWorktree() {
  const files = git(['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  const hits = [];
  for (const rel of files) {
    if (SKIP_EXT.has(path.extname(rel).toLowerCase())) continue;
    let text;
    try {
      // Read from disk, not from the index: the point is to catch the file as it is now,
      // before and after `git add` alike.
      text = require('fs').readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue; // deleted in the working tree, or not valid UTF-8 (binary)
    }
    if (text.includes('\0')) continue;
    hits.push(...scanText(text, rel));
  }
  return hits;
}

function scanHistory() {
  const objects = git(['rev-list', '--objects', '--all']).toString('utf8').split('\n').filter(Boolean);
  const shas = [];
  const pathOf = new Map();
  for (const line of objects) {
    const sp = line.indexOf(' ');
    const sha = sp < 0 ? line : line.slice(0, sp);
    shas.push(sha);
    if (sp > 0) pathOf.set(sha, line.slice(sp + 1));
  }
  const kinds = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    input: `${shas.join('\n')}\n`
  })
    .toString('utf8')
    .split('\n')
    .filter(Boolean);

  const blobs = [];
  for (const line of kinds) {
    const [sha, type, size] = line.split(' ');
    if (type === 'blob' && Number(size) < 2_000_000) blobs.push(sha);
  }

  const batch = git(['cat-file', '--batch'], { input: `${blobs.join('\n')}\n` });
  const hits = [];
  let offset = 0;
  while (offset < batch.length) {
    const nl = batch.indexOf(0x0a, offset);
    if (nl < 0) break;
    const header = batch.slice(offset, nl).toString('utf8').split(' ');
    offset = nl + 1;
    if (header[1] !== 'blob') continue;
    const size = Number(header[2]);
    const body = batch.slice(offset, offset + size);
    offset += size + 1;
    const text = body.toString('utf8');
    if (text.includes('\0')) continue;
    const label = pathOf.get(header[0]) || `blob ${header[0].slice(0, 10)}`;
    hits.push(...scanText(text, label));
  }
  return hits;
}

const history = process.argv.includes('--history');
const hits = history ? scanHistory() : scanWorktree();

if (hits.length === 0) {
  process.stdout.write(history
    ? 'secrets:scan - clean: no credential-shaped string in any reachable object\n'
    : 'secrets:scan - clean: no credential-shaped string in the tracked tree\n');
  process.exit(0);
}

process.stderr.write(`secrets:scan - ${hits.length} candidate secret(s) found:\n\n`);
for (const h of hits) {
  process.stderr.write(`  ${h.where}${h.line ? `:${h.line}` : ''}\n`);
  process.stderr.write(`     rule: ${h.rule}\n`);
  process.stderr.write(`     ${h.sample}\n\n`);
}
process.stderr.write(
  'Remove the value (move it to an env var / untracked file). If it is already committed, rotate\n' +
    'the credential first, then rewrite history - see README "泄露的历史怎么清理".\n'
);
process.exit(1);
