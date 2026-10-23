#!/usr/bin/env node
'use strict';

/**
 * Extract real chat from the Forge client logs into an A23/A24 transcript corpus.
 *
 * Usage:
 *   node scripts/extract-chat-corpus.js
 *   node scripts/extract-chat-corpus.js --out=fixtures/p1/chat-corpus
 *
 * Sources: runtime/logs/forge-client-*.log and runtime/logs/real-client.log (if present).
 *
 * Output is a chronological transcript: one row per chat line, from players AND from the
 * agent's own accounts. Agent rows are labelled `exclude` automatically; player rows keep
 * `label` empty for manual labelling. There are no prev/next columns - the row order is
 * the conversation, so a line's context is the rows above it.
 *
 * This script is read-only over the logs and idempotent: rerunning rewrites the outputs.
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

function sessionDay(session) {
  return sessionDateKey(session).slice(0, 10);
}

function readSession(file) {
  const session = path.basename(file, '.log');
  const events = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
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

function classify(text, self) {
  if (/^[!！]/.test(text)) return 'command';
  if (/^@/.test(text)) return 'addressed';
  return self ? 'agent' : 'other';
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

  const seen = new Set();
  const rows = [];
  const sessions = new Set();
  for (const file of files) {
    const events = readSession(file);
    if (!events.length) continue;
    sessions.add(path.basename(file, '.log'));
    for (const event of events) {
      /**
       * A line can be captured by two logs of the same session (e.g. a consolidated
       * real-client log plus the per-session Forge log). Keep one row per actual line.
       */
      const key = `${sessionDay(event.session)}|${event.clock}|${event.speaker}|${event.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(event);
    }
  }

  rows.forEach((event, index) => {
    event.id = `c${String(index + 1).padStart(4, '0')}`;
    event.role = event.self ? 'agent' : 'player';
    event.kind = classify(event.text, event.self);
    event.addressed = event.kind === 'addressed';
    event.label = event.self ? 'exclude' : '';
    event.note = '';
    const flags = [];
    if (event.self) flags.push('agent');
    if (event.kind === 'command') flags.push('command');
    if (event.kind === 'addressed') flags.push('addressed');
    if (!/[\p{L}\p{N}]/u.test(event.text)) flags.push('punctuation-only');
    else if ([...event.text].length <= 2) flags.push('very-short');
    event.flags = flags;
  });

  const bySpeaker = {};
  for (const row of rows) bySpeaker[row.speaker] = (bySpeaker[row.speaker] || 0) + 1;
  const byKind = {};
  for (const row of rows) byKind[row.kind] = (byKind[row.kind] || 0) + 1;
  const agentRows = rows.filter((row) => row.role === 'agent').length;
  const playerRows = rows.length - agentRows;

  const payload = {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: 'runtime/logs/forge-client-*.log + runtime/logs/real-client.log',
    note:
      'A23/A24 transcript from real sessions: one row per chat line, in chronological order. ' +
      'Agent rows are auto-labelled exclude; player rows keep label empty for manual labelling. ' +
      'There are no prev/next columns - context is the preceding rows. A23 needs 20 participate + ' +
      '20 silent unaddressed player groups, each run 3 times; watch the runtime context window ' +
      '(15 prior lines, own replies included) and the 30s incoming-dedupe / 1.5s reply gap.',
    agentAccounts: [...AGENT_ACCOUNTS],
    labels: {
      participate: 'a natural line the agent should join',
      silent: 'a natural line the agent should stay quiet on',
      exclude: 'agent line / command / addressed / too context-dependent / unusable as a sample'
    },
    stats: {
      logFilesScanned: files.length,
      sessionsWithChat: sessions.size,
      rows: rows.length,
      playerRows,
      agentRows,
      bySpeaker,
      byKind
    },
    entries: rows
  };

  fs.mkdirSync(path.dirname(outBase), { recursive: true });
  fs.writeFileSync(`${outBase}.json`, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const header = ['id', 'label', 'note', 'role', 'speaker', 'text', 'kind', 'addressed', 'flags', 'session', 'time'];
  const lines = rows.map((row) =>
    [
      row.id,
      row.label,
      row.note,
      row.role,
      row.speaker,
      row.text,
      row.kind,
      row.addressed ? 'yes' : 'no',
      row.flags.join(';'),
      row.session,
      row.clock
    ].map(csvCell).join(',')
  );
  fs.writeFileSync(`${outBase}.csv`, `\uFEFF${header.join(',')}\n${lines.join('\n')}\n`, 'utf8');

  /**
   * Earlier versions wrote a `.raw.jsonl` with per-occurrence context. The transcript is
   * already every occurrence, so remove the stale file instead of leaving two sources.
   */
  fs.rmSync(`${outBase}.raw.jsonl`, { force: true });

  process.stdout.write(
    [
      `sessions with chat: ${sessions.size}`,
      `rows: ${rows.length} (players ${playerRows}, agent ${agentRows})`,
      `by speaker: ${JSON.stringify(bySpeaker)}`,
      `by kind: ${JSON.stringify(byKind)}`,
      `wrote ${path.relative(ROOT, outBase)}.json / .csv`
    ].join('\n') + '\n'
  );
}

main();
