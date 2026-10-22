#!/usr/bin/env node
'use strict';

/**
 * Extract real player chat from the Forge client logs into an A23/A24 corpus.
 *
 * Usage:
 *   node scripts/extract-chat-corpus.js
 *   node scripts/extract-chat-corpus.js --out fixtures/p1/chat-corpus
 *
 * Sources: runtime/logs/forge-client-*.log and runtime/logs/real-client.log (if present).
 * The agent's own accounts are excluded from the corpus but still shown as `prev`/`next`
 * context, because a human labeller needs to see what the agent said around the line.
 *
 * Output:
 *   <out>.json  - one entry per unique (speaker,text), `label`/`note` empty for manual labelling
 *   <out>.csv   - same rows, UTF-8 BOM so Excel opens Chinese correctly
 *   <out>.raw.jsonl - every incoming occurrence (for lines whose meaning changes by context)
 *
 * This script is read-only over the logs and idempotent: rerunning rewrites the three files.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'runtime', 'logs');
const DEFAULT_OUT = path.join(ROOT, 'fixtures', 'p1', 'chat-corpus');

/** Accounts known to be the agent side across the project's history. */
const AGENT_ACCOUNTS = new Set(['AgentDeepSeek', 'agent', 'AgentSteve']);

const CHAT_LINE = /^\[(\d{2}:\d{2}:\d{2})\].*?\[CHAT\]\s*<([^<>]{1,32})>\s?(.*)$/;

/** Logs whose filename has no date; keep their rows in chronological order. */
const KNOWN_SESSION_DATES = { 'real-client': '2026-09-30' };

function stripFormatting(text) {
  return String(text || '')
    .replace(/§[0-9a-fk-orx]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sessionDateKey(session) {
  if (KNOWN_SESSION_DATES[session]) return KNOWN_SESSION_DATES[session];
  const match = session.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}T${match[2]}:${match[3]}:${match[4]}`;
  return session;
}

function readSession(file) {
  const session = path.basename(file, '.log');
  const events = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(CHAT_LINE);
    if (!match) continue;
    const text = stripFormatting(match[3]);
    if (!text) continue;
    const speaker = match[2].trim();
    events.push({
      session,
      clock: match[1],
      speaker,
      text,
      self: AGENT_ACCOUNTS.has(speaker)
    });
  }
  return events;
}

function contextLabel(event) {
  if (!event) return '';
  return `${event.self ? '[agent] ' : ''}${event.speaker}: ${event.text}`;
}

function classify(text) {
  if (/^[!！]/.test(text)) return 'command';
  if (/^@/.test(text)) return 'addressed';
  return 'other';
}

function csvCell(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function main() {
  const outArg = process.argv.find((arg) => arg.startsWith('--out='));
  const outBase = outArg ? path.resolve(ROOT, outArg.slice('--out='.length)) : DEFAULT_OUT;

  const files = fs
    .readdirSync(LOG_DIR)
    .filter((name) => /^forge-client-.*\.log$/.test(name) || name === 'real-client.log')
    .map((name) => path.join(LOG_DIR, name))
    .sort((a, b) => sessionDateKey(path.basename(a, '.log')).localeCompare(sessionDateKey(path.basename(b, '.log'))));

  const sessions = [];
  const occurrences = [];
  for (const file of files) {
    const events = readSession(file);
    if (!events.length) continue;
    sessions.push({ session: path.basename(file, '.log'), events: events.length });
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      if (event.self) continue;
      occurrences.push({
        session: event.session,
        clock: event.clock,
        speaker: event.speaker,
        text: event.text,
        prev: contextLabel(events[index - 1]),
        next: contextLabel(events[index + 1])
      });
    }
  }

  const byKey = new Map();
  for (const occurrence of occurrences) {
    const key = `${occurrence.speaker}\u0000${occurrence.text}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        speaker: occurrence.speaker,
        text: occurrence.text,
        kind: classify(occurrence.text),
        count: 0,
        first: { session: occurrence.session, clock: occurrence.clock },
        last: { session: occurrence.session, clock: occurrence.clock },
        sessions: [],
        prev: occurrence.prev,
        next: occurrence.next,
        label: '',
        note: ''
      };
      byKey.set(key, entry);
    }
    entry.count += 1;
    entry.last = { session: occurrence.session, clock: occurrence.clock };
    if (!entry.sessions.includes(occurrence.session)) entry.sessions.push(occurrence.session);
  }

  const entries = [...byKey.values()].sort((a, b) => {
    const left = `${sessionDateKey(a.first.session)}T${a.first.clock}`;
    const right = `${sessionDateKey(b.first.session)}T${b.first.clock}`;
    return left.localeCompare(right);
  });
  entries.forEach((entry, index) => {
    entry.id = `c${String(index + 1).padStart(3, '0')}`;
    entry.addressed = entry.kind === 'addressed';
    const flags = [];
    if (entry.kind === 'command') flags.push('command');
    if (entry.kind === 'addressed') flags.push('addressed');
    if (!/[\p{L}\p{N}]/u.test(entry.text)) flags.push('punctuation-only');
    else if ([...entry.text].length <= 2) flags.push('very-short');
    if (entry.count > 1) flags.push('repeated');
    entry.flags = flags;
  });

  const bySpeaker = {};
  for (const occurrence of occurrences) bySpeaker[occurrence.speaker] = (bySpeaker[occurrence.speaker] || 0) + 1;
  const kinds = entries.reduce((acc, entry) => {
    acc[entry.kind] = (acc[entry.kind] || 0) + 1;
    return acc;
  }, {});

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'runtime/logs/forge-client-*.log + runtime/logs/real-client.log',
    note:
      'A23/A24 candidate chat lines from real sessions. Agent accounts are excluded as incoming ' +
      'samples but kept in prev/next for context. Fill label with participate | silent | exclude. ' +
      'A23 needs 20 participate + 20 silent unaddressed groups, each run 3 times; watch the 30s ' +
      'incoming-dedupe and 1.5s reply-gap when scheduling repetitions.',
    agentAccounts: [...AGENT_ACCOUNTS],
    labels: {
      participate: 'a natural line the agent should join',
      silent: 'a natural line the agent should stay quiet on',
      exclude: 'command / addressed / too context-dependent / unusable as a sample'
    },
    stats: {
      logFilesScanned: files.length,
      logFilesWithChat: sessions.length,
      sessionsWithChat: sessions.length,
      rawIncoming: occurrences.length,
      unique: entries.length,
      bySpeaker,
      byKind: kinds
    },
    entries
  };

  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(`${outBase}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const header = [
    'id',
    'label',
    'note',
    'speaker',
    'text',
    'kind',
    'addressed',
    'flags',
    'count',
    'first_session',
    'first_time',
    'prev',
    'next'
  ];
  const rows = entries.map((entry) =>
    [
      entry.id,
      entry.label,
      entry.note,
      entry.speaker,
      entry.text,
      entry.kind,
      entry.addressed ? 'yes' : 'no',
      entry.flags.join(';'),
      entry.count,
      entry.first.session,
      entry.first.clock,
      entry.prev,
      entry.next
    ].map(csvCell).join(',')
  );
  fs.writeFileSync(`${outBase}.csv`, `\uFEFF${header.join(',')}\n${rows.join('\n')}\n`, 'utf8');

  fs.writeFileSync(
    `${outBase}.raw.jsonl`,
    `${occurrences.map((occurrence) => JSON.stringify(occurrence)).join('\n')}\n`,
    'utf8'
  );

  process.stdout.write(
    [
      `sessions with chat: ${sessions.length}`,
      `incoming lines: ${occurrences.length}`,
      `unique lines: ${entries.length}`,
      `by speaker: ${JSON.stringify(bySpeaker)}`,
      `by kind: ${JSON.stringify(kinds)}`,
      `wrote ${path.relative(ROOT, outBase)}.json / .csv / .raw.jsonl`
    ].join('\n') + '\n'
  );
}

main();
