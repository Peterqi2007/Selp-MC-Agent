#!/usr/bin/env node
'use strict';

/**
 * Learn the ordinary-chat silence policy from the manually labelled corpus.
 *
 * Input : fixtures/p1/chat-corpus.csv  (label = silent | participate | exclude)
 * Output: config/chat-silence-profile.json
 *
 * The runtime does not fine-tune a model. It injects a compact, deterministic set of
 * labelled examples (20 participate + 20 silent by default) into the LanguageBrain prompt
 * for unaddressed ordinary chat. These are the same 40 samples required by A23.
 *
 * The CSV may be UTF-8 or GB18030 (Excel on a Chinese Windows saves GBK). Selection is
 * deterministic: by speaker round-robin, then by id, with duplicate texts removed.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_IN = path.join(ROOT, 'fixtures', 'p1', 'chat-corpus.csv');
const DEFAULT_OUT = path.join(ROOT, 'config', 'chat-silence-profile.json');

function argValue(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function decode(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buffer.subarray(3));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('gb18030').decode(buffer);
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') {
      cell += ch;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((line) => line.some((value) => String(value).trim() !== ''));
}

function selectDiverse(rows, limit, usedTexts) {
  const groups = new Map();
  for (const row of rows) {
    const speaker = row.speaker || '(unknown)';
    if (!groups.has(speaker)) groups.set(speaker, []);
    groups.get(speaker).push(row);
  }
  const speakers = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const cursor = new Map(speakers.map((speaker) => [speaker, 0]));
  const selected = [];
  /**
   * Prefer examples that teach the boundary rather than random short noise:
   * participate = question/request/agent mention; silent = statement/reaction.
   */
  const score = (row) => {
    const text = String(row.text || '');
    let value = 0;
    if (/[?？]|吗|什么|怎么|哪|谁|多少|需要|缺|帮|一起|要不要|能不能|可以|来|吃|睡|搞|建|打|物资|木头|食物/.test(text)) value += 2;
    if (/agent|bot|机器人|大肥鱼|人还是机|机器/i.test(text)) value += 4;
    if (/你们|大家|有人|谁/.test(text)) value += 1;
    if (/punctuation-only|very-short/.test(row.flags || '')) value -= 1;
    return row.label === 'participate' ? value : -value;
  };
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => score(b) - score(a) || String(a.id).localeCompare(String(b.id)));
  }
  while (selected.length < limit) {
    let progressed = false;
    for (const speaker of speakers) {
      const bucket = groups.get(speaker);
      while (cursor.get(speaker) < bucket.length) {
        const row = bucket[cursor.get(speaker)];
        cursor.set(speaker, cursor.get(speaker) + 1);
        progressed = true;
        const text = String(row.text || '').trim();
        if (!text || usedTexts.has(text)) continue;
        usedTexts.add(text);
        selected.push({
          id: row.id || null,
          label: row.label,
          text,
          speaker: row.speaker || null,
          session: row.session || null,
          flags: row.flags ? String(row.flags).split(';').filter(Boolean) : []
        });
        break;
      }
      if (selected.length >= limit) break;
    }
    if (!progressed) break;
  }
  return selected;
}

function main() {
  const input = path.resolve(ROOT, argValue('in', DEFAULT_IN));
  const output = path.resolve(ROOT, argValue('out', DEFAULT_OUT));
  const perLabel = Math.max(1, Number(argValue('per-label', 20)) || 20);
  const raw = fs.readFileSync(input);
  const text = decode(raw);
  const rows = parseCsv(text);
  if (!rows.length) throw new Error('empty corpus');
  const header = rows.shift().map((value) => String(value).trim());
  const index = Object.fromEntries(header.map((name, i) => [name, i]));
  for (const required of ['id', 'label', 'role', 'speaker', 'text', 'kind', 'session']) {
    if (!(required in index)) throw new Error(`missing column: ${required}`);
  }

  const labelled = rows
    .map((row) => ({
      id: row[index.id] || null,
      label: String(row[index.label] || '').trim().toLowerCase(),
      role: String(row[index.role] || '').trim(),
      speaker: String(row[index.speaker] || '').trim(),
      text: String(row[index.text] || '').trim(),
      kind: String(row[index.kind] || '').trim(),
      flags: String(row[index.flags] || '').trim(),
      session: String(row[index.session] || '').trim(),
      note: String(row[index.note] || '').trim()
    }))
    .filter((row) => row.role === 'player' && row.kind === 'other')
    .filter((row) => row.label === 'silent' || row.label === 'participate');

  const silentRows = labelled.filter((row) => row.label === 'silent').sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const participateRows = labelled
    .filter((row) => row.label === 'participate')
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (silentRows.length < perLabel || participateRows.length < perLabel) {
    throw new Error(
      `need ${perLabel} each, have silent=${silentRows.length} participate=${participateRows.length}`
    );
  }

  const used = new Set();
  const examples = [
    ...selectDiverse(silentRows, perLabel, used),
    ...selectDiverse(participateRows, perLabel, used)
  ];
  const profile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      file: path.relative(ROOT, input).replace(/\\/g, '/'),
      sha256: crypto.createHash('sha256').update(raw).digest('hex')
    },
    counts: {
      silent: silentRows.length,
      participate: participateRows.length,
      selected: {
        silent: examples.filter((row) => row.label === 'silent').length,
        participate: examples.filter((row) => row.label === 'participate').length
      }
    },
    policy:
      'Default to silence on unaddressed background chat. Participate only when the line directly asks the agent/group a question, mentions the agent, offers or requests help, or continues a conversation the agent is part of. Silence on reactions, acknowledgements, third-party dialogue and fragments.',
    examples
  };

  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  process.stdout.write(
    `learned ${examples.length} examples ` +
      `(silent=${profile.counts.selected.silent}, participate=${profile.counts.selected.participate}) ` +
      `from ${labelled.length} labelled rows -> ${path.relative(ROOT, output)}\n`
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`learn-chat-corpus: ${err.message}\n`);
  process.exitCode = 1;
}
