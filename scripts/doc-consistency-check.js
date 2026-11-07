'use strict';

/**
 * `npm run docs:check` - guard against documentation drift.
 *
 * The repository keeps status claims in ~10 documents that are edited by hand. A single round
 * of live testing touches most of them, and "the doc still says 未通过" is exactly the class of
 * drift that makes a handoff misleading. These assertions are cheap to run and intentionally
 * narrow: they only check facts that are *supposed* to be uniform across the status documents.
 *
 * Historical passages are allowed to keep their numbers; every check below either looks at the
 * current claim only, or requires the mention to sit inside an explicitly dated/qualified window
 * (当时/当日/历史/收口/…, or a `docs/P1-WORK-*` dated work log).
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);

/** Files that carry the current status of the P1 stages (technical reference + status docs). */
const STATUS_DOCS = [
  'TECHNICAL.md',
  'docs/P1-M5.md',
  'docs/P1-CLIENT-TESTS.md',
  'docs/P1-CLIENT-VERIFICATION.md',
  'docs/P1-M7.md',
  'docs/P1-HANDOFF.md',
  'docs/P1-GAP-AUDIT.md',
  'docs/table.md',
  'docs/CU-ABANDONED.md'
];

const read = (file) => fs.readFileSync(file, 'utf8');
const allDocs = () => [
  'README.md',
  'TECHNICAL.md',
  ...fs.readdirSync('docs').filter((name) => name.endsWith('.md')).map((name) => path.join('docs', name))
];

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: ok === true, detail });
  process.stdout.write(`  ${ok === true ? 'PASS' : 'FAIL'} ${name}${ok === true ? '' : ` :: ${JSON.stringify(detail)}`}\n`);
};

// 1. The mod's frozen facts: jar size and dispatcher verb counts live in exactly one form.
{
  const stale = [];
  for (const file of allDocs()) {
    const text = read(file);
    if (text.includes('97418')) stale.push(`${file}: jar 97418`);
    if (/33 个 case 分支/.test(text)) stale.push(`${file}: 33 case labels`);
    if (/别名展开 42 个 verb/.test(text)) stale.push(`${file}: 42 verb names`);
  }
  check('no stale jar size / verb counts', stale.length === 0, stale);
}

// 2. M5's verdict must be stated as PASS everywhere it is presented as current.
{
  const missing = STATUS_DOCS.filter((file) => !/M5[^\n]{0,60}PASS/.test(read(file)));
  check('M5 PASS stated in every status doc', missing.length === 0, missing);
}

// 3. The A12 split: the M2 threat/performance item is A12; the deferred GUI re-run is A12-GUI.
//    The deferral must never silently become a pass, and the two must not be merged again.
{
  const missing = STATUS_DOCS.filter((file) => !/A12-GUI[^\n]{0,60}暂缓|暂缓[^\n]{0,60}A12-GUI/.test(read(file)));
  check('A12-GUI is recorded as deferred', missing.length === 0, missing);
  const merged = STATUS_DOCS.filter((file) => /A12[ \t]*(?:（GUI 内自卫反射）|按操作员口径暂缓)/.test(read(file)));
  check('the deferred GUI item is named A12-GUI (not plain A12)', merged.length === 0, merged);
}

// 3a. A08 is closed by the F1'b evidence, never left as "partial: death/disconnect untested".
{
  const docs = ['docs/P1-CLIENT-TESTS.md', 'docs/P1-M7.md', 'docs/P1-CLIENT-VERIFICATION.md', 'docs/table.md'];
  const missing = docs.filter((file) => !read(file).split('\n').some((line) => /A08/.test(line) && /F1'b/.test(line)));
  check('A08 is closed with F1b evidence', missing.length === 0, missing);
  const stale = docs.filter((file) => /A08[^\n]{0,160}(?:死亡|断线)[^\n]{0,60}(?:未测|未执行)/.test(read(file)));
  check('A08 no longer claims death/disconnect untested', stale.length === 0, stale);
}

// 3b. A23 is closed by an explicit operator judgement, never presented as a statistical pass.
{
  const docs = ['docs/P1-CLIENT-TESTS.md', 'docs/P1-CLIENT-VERIFICATION.md', 'docs/M6-LANGUAGE-TESTS.md', 'docs/table.md'];
  const bad = docs.filter((file) => {
    const text = read(file);
    if (!/A23/.test(text)) return true;
    return !/A23[\s\S]{0,400}?操作员口径/.test(text);
  });
  check('A23 pass is marked as an operator judgement', bad.length === 0, bad);
  const falseStat = docs.filter((file) => {
    const text = read(file);
    const at = text.indexOf('A23');
    if (at < 0) return false;
    const windowText = text.slice(at, at + 500);
    return /40 组 ×3[^，。；]{0,40}(通过|PASS)/.test(windowText);
  });
  check('A23 does not claim the 40x3 statistics', falseStat.length === 0, falseStat);
}

// 3c. M6 is closed on the real-client record (A23 operator judgement, A24 controlled, A25 four paths).
{
  const docs = ['TECHNICAL.md', 'docs/P1-CLIENT-VERIFICATION.md', 'docs/P1-HANDOFF.md', 'docs/P1-M7.md'];
  const stageDocs = ['TECHNICAL.md', 'docs/P1-CLIENT-VERIFICATION.md', 'docs/P1-HANDOFF.md'];
  const missing = stageDocs.filter((file) => {
    const docLines = read(file).split(String.fromCharCode(10));
    return !docLines.some((line, index) => /M6/.test(line) && (/PASS/.test(line) || /PASS/.test(docLines[index + 1] || '')));
  });
  check('M6 PASS stated in the status docs', missing.length === 0, missing);
}

// 4. The operator's scope decision on container screens stays recorded.
{
  const hits = allDocs().filter((file) => /容器界面[^\n]{0,40}不(算|释放)|不算暂停|不[“"]打开即释放[”"]/.test(read(file)));
  check('container-screen scope decision recorded', hits.length >= 2, hits);
}

// 5. A current `m5 35/35` claim is drift; historical passages must say so.
{
  const bad = [];
  for (const file of allDocs()) {
    if (file.indexOf('P1-WORK-') >= 0) continue; // dated work logs keep their own numbers
    const lines = read(file).split('\n');
    lines.forEach((line, index) => {
      if (!/35\/35/.test(line) || !/m5|M5/.test(line)) return;
      if (!/m5[^\d]{0,24}35\/35|35\/35[^\d]{0,24}m5/i.test(line)) return;
      const window = [lines[index - 1] || '', line, lines[index + 1] || ''].join(' ');
      if (!/(当时|当日|历史|收口|2026-10-2|2026-10-3|2026-11-01 实跑)/.test(window)) bad.push(`${file}:${index + 1}`);
    });
  }
  check('no unqualified current "m5 35/35"', bad.length === 0, bad);
}

// 6. The M5 closure section exists and is the reference used by the other docs.
{
  check('P1-M5 §13 (closure) exists', /^## 13\./m.test(read('docs/P1-M5.md')), null);
  const refs = allDocs().filter((file) => /§13/.test(read(file)));
  check('the closure section is referenced', refs.length >= 5, refs.length);
}

// 6b. table.md and the M7 gate table carry the same M7 rows (A26/F03/E03), not one empty and one filled.
{
  const pair = ['docs/table.md', 'docs/P1-CLIENT-VERIFICATION.md'];
  const missing = pair.filter((file) => !/M7-A26/.test(read(file)) || !/M7-F03/.test(read(file)) || !/M7-E03/.test(read(file)));
  check('table.md and the M7 gate table share A26/F03/E03', missing.length === 0, missing);
}

const failed = results.filter((entry) => !entry.ok);
process.stdout.write(`\ndoc consistency: ${results.length - failed.length}/${results.length}\n`);
if (failed.length) {
  process.stderr.write('Documentation drift detected - fix the claims, do not weaken this check.\n');
  process.exitCode = 1;
}
