'use strict';

/**
 * Memory: durable notes the agent keeps between tasks and restarts.
 *
 * Deliberately small and JSON-serialisable so the whole agent state can be dumped
 * into runtime/agent-state.json and inspected from outside (that file doubles as the
 * observability surface for the web/GUI side of the project).
 */

const fs = require('fs');
const path = require('path');

class Memory {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.resolve(cfg.root, cfg.agent.logging.stateFile || 'runtime/agent-state.json');
    this.data = {
      createdAt: new Date().toISOString(),
      sessions: 0,
      deaths: 0,
      taskHistory: [],
      stats: {},
      landmarks: {},
      blacklist: []
    };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = { ...this.data, ...parsed };
      }
    } catch {
      /* corrupted state must never stop the agent */
    }
    this.data.sessions += 1;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* ignore disk errors */
    }
  }

  recordTask(name, info) {
    this.data.taskHistory.push({ task: name, ...info });
    if (this.data.taskHistory.length > 400) this.data.taskHistory.splice(0, this.data.taskHistory.length - 400);
    this.save();
  }

  bump(stat, amount = 1) {
    this.data.stats[stat] = (this.data.stats[stat] || 0) + amount;
    this.save();
  }

  recordDeath(cause) {
    this.data.deaths += 1;
    this.recordTask('death', { cause });
  }

  rememberLandmark(name, position) {
    this.data.landmarks[name] = {
      x: Math.round(position.x),
      y: Math.round(position.y),
      z: Math.round(position.z),
      dimension: position.dimension || 'overworld',
      at: Date.now()
    };
    this.save();
  }

  forgetLandmark(name) {
    delete this.data.landmarks[name];
    this.save();
  }

  landmark(name) {
    return this.data.landmarks[name] || null;
  }

  blacklistSpot(position, radius = 8) {
    this.data.blacklist.push({ x: Math.round(position.x), y: Math.round(position.y), z: Math.round(position.z), radius, at: Date.now() });
    if (this.data.blacklist.length > 100) this.data.blacklist.shift();
    this.save();
  }

  isBlacklisted(position) {
    return this.data.blacklist.some((b) => {
      const dx = b.x - position.x;
      const dz = b.z - position.z;
      return Math.sqrt(dx * dx + dz * dz) <= b.radius;
    });
  }

  recentTaskNames(limit = 8) {
    return this.data.taskHistory.slice(-limit).map((t) => t.task);
  }

  summary() {
    return {
      sessions: this.data.sessions,
      deaths: this.data.deaths,
      stats: this.data.stats,
      landmarks: Object.keys(this.data.landmarks),
      recentTasks: this.recentTaskNames(10)
    };
  }
}

module.exports = { Memory };
