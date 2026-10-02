'use strict';

/**
 * Single-instance guard.
 *
 * Two agent processes logging in with the same username get kicked with
 * `multiplayer.disconnect.duplicate_login`, which looks like a mysterious
 * disconnect/reconnect loop. A pid file in runtime/ prevents that: if a live agent
 * already owns the lock we refuse to start instead of fighting it.
 */

const fs = require('fs');
const path = require('path');

function lockPath(cfg) {
  return path.join(cfg.paths.runtime, 'agent.lock');
}

function readLock(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || !raw.pid) return null;
    return raw;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Acquire the single-instance lock.
 * @returns {{ok: true, file: string, release: Function} | {ok: false, holder: object}}
 */
function acquireLock(cfg, options = {}) {
  const file = lockPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const existing = readLock(file);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    if (!options.force) return { ok: false, holder: existing };
  }

  const payload = {
    pid: process.pid,
    username: cfg.agent.bot.username,
    host: `${cfg.agent.bot.host}:${cfg.agent.bot.port}`,
    startedAt: new Date().toISOString()
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');

  const release = () => {
    try {
      const current = readLock(file);
      if (current && current.pid === process.pid) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  };
  return { ok: true, file, release };
}

/** True when another live agent already holds the lock. */
function isLockedByOther(cfg) {
  const existing = readLock(lockPath(cfg));
  return !!(existing && existing.pid !== process.pid && isAlive(existing.pid));
}

module.exports = { acquireLock, isLockedByOther, lockPath, isAlive };
