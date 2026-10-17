'use strict';

/**
 * StateStore - atomic JSON persistence for the P1 session state (A17/A29).
 *
 * Persistence is deliberately boring and hard to corrupt:
 *   - write to a sibling temp file, then `rename` (atomic on one filesystem), so a crash
 *     leaves either the old file or the new one, never a half-written JSON;
 *   - a file that fails to parse is renamed to `.corrupt-<timestamp>` and reported as
 *     "nothing to restore" instead of throwing the agent into a crash loop;
 *   - `load()` never mutates live state; the caller decides what to restore.
 *
 * The store knows nothing about plans/proposals/events - it stores one JSON object.
 */

const fs = require('fs');
const path = require('path');

class StateStore {
  /**
   * @param {object} options { file, now }
   */
  constructor(options = {}) {
    if (!options.file) throw new Error('StateStore needs a file path');
    this.file = options.file;
    this.now = options.now || (() => Date.now());
  }

  /** @returns {object|null} parsed state, or null when absent/corrupt */
  load() {
    if (!fs.existsSync(this.file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('state is not an object');
      return data;
    } catch (err) {
      this.quarantine(err);
      return null;
    }
  }

  /** Atomically replace the state file. Returns the path. */
  save(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(temp, this.file);
    return this.file;
  }

  /** Move a corrupt file aside so the next start can write a clean one. */
  quarantine(reason) {
    const target = `${this.file}.corrupt-${this.now()}`;
    try {
      fs.renameSync(this.file, target);
    } catch {
      /* nothing to move */
    }
    return { target, reason: reason && reason.message };
  }

  clear() {
    try {
      fs.unlinkSync(this.file);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { StateStore };
