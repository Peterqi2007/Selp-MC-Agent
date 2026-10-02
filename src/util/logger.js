'use strict';

/**
 * Lightweight structured logger with optional file mirroring and in-memory ring buffer.
 * Keeps dependencies at zero so the agent can boot even before `npm install` finishes.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const COLORS = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  debug: '\u001b[90m',
  trace: '\u001b[90m',
  reset: '\u001b[0m'
};

class Logger {
  constructor(scope = 'agent', options = {}) {
    this.scope = scope;
    this.level = options.level || process.env.AGENT_LOG_LEVEL || 'info';
    this.color = options.color !== false && process.stdout.isTTY;
    this.buffer = [];
    this.bufferLimit = options.bufferLimit || 500;
    this.stream = null;
    this.listeners = new Set();

    if (options.file) {
      const file = path.resolve(options.file);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      this.stream = fs.createWriteStream(file, { flags: 'a' });
    }
  }

  child(scope) {
    const l = new Logger(`${this.scope}:${scope}`, { level: this.level, color: this.color });
    l.buffer = this.buffer;
    l.listeners = this.listeners;
    return l;
  }

  onLine(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(n = 50) {
    return this.buffer.slice(-n);
  }

  _enabled(level) {
    return LEVELS[level] <= (LEVELS[this.level] ?? LEVELS.info);
  }

  _emit(level, args) {
    if (!this._enabled(level)) return;
    const message = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    const ts = new Date().toISOString();
    const line = `${ts} [${level.toUpperCase().padEnd(5)}] (${this.scope}) ${message}`;

    this.buffer.push(line);
    if (this.buffer.length > this.bufferLimit) this.buffer.splice(0, this.buffer.length - this.bufferLimit);

    for (const fn of this.listeners) {
      try {
        fn({ ts, level, scope: this.scope, message, line });
      } catch {
        /* listener errors must never break logging */
      }
    }

    const tag = this.color ? `${COLORS[level] || ''}${level.toUpperCase().padEnd(5)}${COLORS.reset}` : level.toUpperCase().padEnd(5);
    process.stdout.write(`${ts} ${tag} (${this.scope}) ${message}\n`);
    if (this.stream) this.stream.write(`${line}\n`);
  }

  error(...a) { this._emit('error', a); }
  warn(...a) { this._emit('warn', a); }
  info(...a) { this._emit('info', a); }
  debug(...a) { this._emit('debug', a); }
  trace(...a) { this._emit('trace', a); }
}

function safeStringify(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = { Logger, LEVELS };
