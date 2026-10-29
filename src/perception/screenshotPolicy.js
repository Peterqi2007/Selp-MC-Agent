'use strict';

/**
 * Screenshot policy - when a frame is worth capturing, and how it reaches the brain.
 *
 * Before this module the only capture path was `!shot`: a human (or a probe) asking. That is
 * useless for "show me what happened when the step failed", which is exactly when a picture
 * carries information structured state does not.
 *
 * The policy is event-driven with a low-frequency fallback, and it is deliberately stingy:
 * one frame per reason, a global minimum interval, a per-task cap, a perceptual-hash dedupe,
 * and a bounded folder. Every capture is paired with a steer message into the action-brain
 * conversation that says *where* the file is and *that structured state still decides*.
 *
 * Not every trigger in the spec is observable yet:
 *   - biome change:   the snapshot has no biome field           -> not wired
 *   - new structure:  no structure field                        -> not wired
 *   - mod block:      `blocks` names are visible                -> wired
 *   - dimension:      `dimension` is visible                    -> wired
 */

const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');

const DEFAULTS = Object.freeze({
  enabled: true,
  maxEdge: 768,
  maxPerTask: 3,
  minIntervalMs: 15_000,
  fallbackMs: 90_000,
  keepFiles: 20,
  dedupeDistance: 5,
  steer: true,
  scanIntervalMs: 15_000,
  repeatedFailureCount: 3
});

/** Failure evidence outranks "here is the starting state": a step that fails 27 ms after the
 * plan starts must not lose its frame to the 15 s minimum interval. */
const FAILURE_REASONS = new Set(['plan-partial', 'plan-failed', 'task-failed', 'task-quarantined', 'step-failed', 'repeated-failure']);

const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;

// ------------------------------------------------------------------ tiny PNG reader

/** Decode a non-interlaced 8-bit PNG to {width, height, channels, get(x,y) -> luma}. */
function readPngLuma(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error('not a png');
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error('not a png');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) break;
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      interlace = buffer[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height) throw new Error('png without IHDR');
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported png (depth ${bitDepth}, interlace ${interlace})`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0;
  if (!channels) throw new Error(`unsupported png colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const out = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : (pb <= pc ? up : upLeft);
      }
      out[x] = value & 0xff;
    }
    out.copy(pixels, y * stride);
    previous = out;
  }
  return {
    width,
    height,
    channels,
    luma(x, y) {
      const base = y * stride + x * channels;
      if (channels === 1) return pixels[base];
      if (channels === 2) return pixels[base];
      if (channels === 3) return (pixels[base] * 299 + pixels[base + 1] * 587 + pixels[base + 2] * 114) / 1000;
      return (pixels[base] * 299 + pixels[base + 1] * 587 + pixels[base + 2] * 114) / 1000;
    }
  };
}

/** Difference hash: 9x8 sampled luma, compare each pixel with its right neighbour. */
function dhash(buffer) {
  const image = readPngLuma(buffer);
  const sample = (cx, cy) => {
    const x = Math.min(image.width - 1, Math.floor((cx / HASH_WIDTH) * image.width));
    const y = Math.min(image.height - 1, Math.floor((cy / HASH_HEIGHT) * image.height));
    return image.luma(x, y);
  };
  let bits = '';
  for (let y = 0; y < HASH_HEIGHT; y += 1) {
    for (let x = 0; x < HASH_WIDTH - 1; x += 1) {
      bits += sample(x, y) > sample(x + 1, y) ? '1' : '0';
    }
  }
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return { hash: hex, width: image.width, height: image.height };
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let distance = 0;
  for (let i = 0; i < a.length; i += 1) {
    let value = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (value) {
      distance += value & 1;
      value >>= 1;
    }
  }
  return distance;
}

// ------------------------------------------------------------------ the policy

class ScreenshotPolicy {
  /**
   * @param {object} deps
   *   body, bridge, events, brain, log, now, cfg, dir
   *   fsImpl   injectable fs (tests); defaults to fs/promises
   */
  constructor(deps = {}) {
    this.body = deps.body || null;
    this.bridge = deps.bridge || null;
    this.events = deps.events || null;
    this.brain = deps.brain || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.now = deps.now || (() => Date.now());
    this.cfg = { ...DEFAULTS, ...(deps.cfg || {}) };
    this.fs = deps.fsImpl || fs;
    this.dir = path.resolve(deps.dir || path.join('runtime', 'screenshots'));
    this.timer = null;
    this.unsubscribe = null;
    this.lastShot = null;
    this.lastShotAt = 0;
    this.shots = [];
    this.hashes = [];
    this.perTask = new Map();
    this.failures = new Map();
    this.seenModBlocks = new Set();
    this.lastScanAt = 0;
    this.lastDimension = null;
    this._inflight = null;
    this._startedAt = null;
  }

  start() {
    if (this._startedAt) return { ok: true, already: true };
    this._startedAt = this.now();
    if (this.events && typeof this.events.subscribe === 'function') {
      this.unsubscribe = this.events.subscribe((event) => this.onEvent(event));
    }
    this.timer = setInterval(() => this.tick().catch(() => {}), Math.max(1000, Math.min(15_000, this.cfg.scanIntervalMs)));
    this.timer.unref?.();
    this.log.info(`screenshot policy online (fallback ${this.cfg.fallbackMs}ms, max ${this.cfg.maxPerTask}/task, keep ${this.cfg.keepFiles})`);
    return { ok: true };
  }

  stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._startedAt = null;
    return { ok: true };
  }

  /** Map one event to a capture reason (or null). */
  reasonFor(event) {
    const type = event && event.type;
    if (type === 'plan:partial') return 'plan-partial';
    if (type === 'plan:failed') return 'plan-failed';
    if (type === 'task:failed') return 'task-failed';
    if (type === 'task:quarantined') return 'task-quarantined';
    if (type === 'plan:started' || type === 'proposal:accepted') return 'pre-task';
    return null;
  }

  /** A failed plan step is also a failure signal, even if the plan recovers. */
  stepFailure(event) {
    if (!event || event.type !== 'plan:step') return null;
    const status = String(event.status || '');
    if (status !== 'failed' && status !== 'partial') return null;
    const key = String(event.reason || event.error || status);
    const count = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, count);
    if (this.failures.size > 20) this.failures.delete(this.failures.keys().next().value);
    return count >= this.cfg.repeatedFailureCount ? 'repeated-failure' : 'step-failed';
  }

  onEvent(event) {
    const reason = this.reasonFor(event) || this.stepFailure(event);
    if (!reason) return null;
    const taskKey = String(event.planId || event.taskId || event.requestId || 'global');
    return this.capture(reason, { taskKey, event });
  }

  /** Periodic: fallback frame while a task is active, plus cheap novelty detection. */
  async tick() {
    if (!this.cfg.enabled) return;
    const active = this.activeTaskKey();
    await this.scanNovelty(active);
    if (!active) return;
    if (this.now() - this.lastShotAt < this.cfg.fallbackMs) return;
    await this.capture('fallback', { taskKey: active });
  }

  /** The task the action brain is currently working on, or null. */
  activeTaskKey() {
    const brain = this.brain;
    const plan = brain && brain.ctx && brain.ctx.planService;
    const hub = brain && brain.ctx && brain.ctx.hub;
    const current = brain && typeof brain.currentTask === 'object' && brain.currentTask
      ? String(brain.currentTask.planId || brain.currentTask.requestId || brain.currentTask.name || 'task')
      : null;
    if (current) return current;
    if (plan && plan.busy) {
      const active = plan.active || plan.current || null;
      return String((active && (active.planId || active.id)) || 'plan');
    }
    if (hub && hub.busy) return 'task-hub';
    const queue = brain && Array.isArray(brain.queue) ? brain.queue.length : 0;
    return queue > 0 ? 'brain-queue' : null;
  }

  /** Dimension change and first sighting of a mod block are worth one frame each. */
  async scanNovelty(taskKey) {
    if (!this.body || typeof this.body.snapshot !== 'function') return;
    if (this.now() - this.lastScanAt < this.cfg.scanIntervalMs) return;
    this.lastScanAt = this.now();
    const snap = this.body.snapshot();
    if (!snap) return;
    const dimension = snap.dimension ? String(snap.dimension) : null;
    if (dimension && this.lastDimension && dimension !== this.lastDimension) {
      await this.capture('dimension-change', { taskKey: taskKey || 'global', detail: { from: this.lastDimension, to: dimension } });
    }
    if (dimension) this.lastDimension = dimension;

    const blocks = snap.blocks && snap.blocks.cells ? snap.blocks.cells : snap.blocks;
    if (!blocks || typeof blocks !== 'object') return;
    let novel = null;
    for (const name of Object.values(blocks)) {
      const id = String(name);
      if (!id || id.startsWith('minecraft:')) continue;
      if (this.seenModBlocks.has(id)) continue;
      this.seenModBlocks.add(id);
      if (!novel) novel = id;
    }
    if (this.seenModBlocks.size > 5000) this.seenModBlocks.clear();
    if (novel) {
      await this.capture('mod-block-first-seen', { taskKey: taskKey || 'global', detail: { block: novel } });
    }
  }

  budgetAllows(taskKey, reason) {
    if (!this.cfg.enabled) return { ok: false, reason: 'disabled' };
    if (this.now() - this.lastShotAt < this.cfg.minIntervalMs) {
      /**
       * One exception, measured live: a plan whose first step fails immediately emits
       * `plan:started` and `plan:failed` 27 ms apart, so the failure frame would always be
       * throttled by the pre-task frame. A failure may replace a lower-priority frame of the
       * same task; a failure after a failure is still throttled.
       */
      const last = this.lastShot;
      const override = FAILURE_REASONS.has(reason) && last && last.taskKey === taskKey
        && !FAILURE_REASONS.has(last.reason);
      if (!override) return { ok: false, reason: 'min-interval' };
    }
    const used = this.perTask.get(taskKey) || 0;
    if (used >= this.cfg.maxPerTask) return { ok: false, reason: 'task-budget' };
    return { ok: true, used };
  }

  isDuplicate(hash) {
    return this.hashes.some((entry) => hamming(entry.hash, hash) <= this.cfg.dedupeDistance);
  }

  /**
   * Capture one frame for `reason`, respecting the budget, dedupe and folder cap.
   * @returns {Promise<{ok:boolean, reason:string, path?:string, skipped?:string}>}
   */
  async capture(reason, meta = {}) {
    const taskKey = String(meta.taskKey || 'global');
    if (!this.cfg.enabled) return { ok: false, reason, skipped: 'disabled' };
    if (!this.body || typeof this.body.screenshot !== 'function') return { ok: false, reason, skipped: 'no-body' };
    /**
     * A pre-task frame and its own failure can be milliseconds apart (live: plan:started and
     * task:failed 5 ms apart). Dropping the failure as "inflight" would lose exactly the frame
     * worth keeping, so a failure waits for the routine capture instead of being discarded.
     */
    if (this._inflight) {
      if (!FAILURE_REASONS.has(reason)) return { ok: false, reason, skipped: 'inflight' };
      try {
        await this._inflight;
      } catch (err) {
        /* the failed capture must not block the failure frame */
      }
    }
    const budget = this.budgetAllows(taskKey, reason);
    if (!budget.ok) {
      this.log.debug(`screenshot skipped (${reason}): ${budget.reason}`);
      return { ok: false, reason, skipped: budget.reason };
    }
    this._inflight = (async () => {
      let shot;
      try {
        shot = await this.body.screenshot({ maxEdge: this.cfg.maxEdge, dir: this.dir });
      } catch (err) {
        this.log.warn(`screenshot failed (${reason}): ${err.message}`);
        return { ok: false, reason, skipped: 'capture-failed', error: err.message };
      }
      if (!shot || !shot.ok) return { ok: false, reason, skipped: 'capture-failed', error: shot && shot.error };
      let hash = null;
      try {
        hash = dhash(await this.fs.readFile(shot.path)).hash;
      } catch (err) {
        this.log.debug(`screenshot hash unavailable: ${err.message}`);
      }
      // A duplicate is only noise for routine triggers; for a failure the frame is the
      // evidence that it happened at that pose, so keep it (the per-task budget still caps).
      if (hash && !FAILURE_REASONS.has(reason) && this.isDuplicate(hash)) {
        await this.fs.rm(shot.path, { force: true }).catch(() => {});
        this.log.debug(`screenshot skipped (${reason}): duplicate frame`);
        return { ok: false, reason, skipped: 'duplicate' };
      }
      const record = {
        path: shot.path,
        width: shot.width,
        height: shot.height,
        bytes: shot.bytes,
        reason,
        taskKey,
        hash,
        at: new Date(this.now()).toISOString(),
        detail: meta.detail || null,
        eventType: meta.event ? meta.event.type : null
      };
      await this.writeSidecar(record).catch(() => {});
      await this.prune().catch(() => {});
      this.lastShot = record;
      this.lastShotAt = this.now();
      this.shots.push(record);
      if (this.shots.length > 50) this.shots.shift();
      if (hash) {
        this.hashes.push({ hash, at: this.now() });
        if (this.hashes.length > 20) this.hashes.shift();
      }
      this.perTask.set(taskKey, (this.perTask.get(taskKey) || 0) + 1);
      if (this.perTask.size > 50) this.perTask.delete(this.perTask.keys().next().value);
      try {
        const steered = await this.steer(record);
        if (!steered || steered.ok !== true) {
          this.log.debug(`screenshot steer not delivered (${(steered && (steered.reason || 'unknown')) || 'unknown'})`);
        }
      } catch (err) {
        this.log.warn(`screenshot steer failed: ${err.message}`);
      }
      this.log.info(`screenshot ${reason} -> ${shot.path} (${shot.width}x${shot.height})`);
      return { ok: true, reason, path: shot.path, hash };
    })().finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  /** A small JSON next to the frame: why it exists, so a later review does not guess. */
  async writeSidecar(record) {
    const file = record.path.replace(/\.png$/i, '.json');
    await this.fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    record.sidecar = file;
    return file;
  }

  /** Keep the newest `keepFiles` frames (and their sidecars); delete the rest. */
  async prune() {
    let names = [];
    try {
      names = await this.fs.readdir(this.dir);
    } catch (err) {
      return;
    }
    const frames = names.filter((name) => name.endsWith('.png'));
    if (frames.length <= this.cfg.keepFiles) return;
    const stats = [];
    for (const name of frames) {
      const full = path.join(this.dir, name);
      try {
        stats.push({ name, full, mtime: (await this.fs.stat(full)).mtimeMs });
      } catch (err) {
        /* ignore */
      }
    }
    stats.sort((a, b) => b.mtime - a.mtime);
    for (const stale of stats.slice(this.cfg.keepFiles)) {
      await this.fs.rm(stale.full, { force: true }).catch(() => {});
      await this.fs.rm(stale.full.replace(/\.png$/i, '.json'), { force: true }).catch(() => {});
    }
  }

  /**
   * The active DSH goal on the action-brain conversation, or null.
   *
   * A message is only meaningful as a steer when a goal is running: `followup` alone is one
   * user message with no goal service behind it, which is exactly why the first version of
   * this policy "spoke into the void" (live 2026-10-29, operator review).
   */
  async activeGoal() {
    if (!this.bridge || typeof this.bridge.boundAgentId !== 'function' || typeof this.bridge.goalOf !== 'function') {
      return { ok: false, reason: 'goal-query-unavailable' };
    }
    let agentId = null;
    try {
      agentId = await this.bridge.boundAgentId();
    } catch (err) {
      return { ok: false, reason: `agent-id-failed: ${err.message}` };
    }
    if (!agentId) return { ok: false, reason: 'no-bound-agent' };
    let goal = null;
    try {
      goal = await this.bridge.goalOf(agentId);
    } catch (err) {
      return { ok: false, reason: `goal-query-failed: ${err.message}` };
    }
    if (!goal || !goal.id) return { ok: false, reason: 'no-goal' };
    if (goal.phase !== 'active') return { ok: false, reason: `goal-${goal.phase || 'unknown'}`, goal };
    return { ok: true, agentId, goal };
  }

  /**
   * Tell the action brain a frame exists - as a steer into its ACTIVE goal, never as a bare
   * chat message. With no active goal the steer is dropped (operator decision, 2026-10-29):
   * a text injection without a goal is not a steer, it is noise.
   *
   * The message states the structured-state rule explicitly: the image is auxiliary evidence,
   * never an upgrade of a failed structured check.
   */
  async steer(record) {
    if (!this.cfg.steer) return { ok: false, reason: 'steer-disabled' };
    if (!this.bridge || typeof this.bridge.forward !== 'function') return { ok: false, reason: 'no-bridge' };
    const active = await this.activeGoal();
    if (!active.ok) {
      this.log.info(`screenshot steer dropped (${record.reason}): ${active.reason}`);
      return { ok: false, reason: active.reason };
    }
    const relative = (path.relative(process.cwd(), record.path) || record.path).split(path.sep).join('/');
    const text = [
      `[截图/${record.reason}] ${relative} (${record.width}x${record.height}, ${record.at})`,
      `当前 goal: ${active.goal.id}（phase=active，轮次 ${active.goal.roundsStarted || 0}/${active.goal.maxGoalRounds || '?'}）`,
      record.eventType ? `事件: ${record.eventType}${record.taskKey ? ` · task=${record.taskKey}` : ''}` : null,
      '结构化状态优先：仅当 mc_state/mc_observe 的结构化字段不足以判断时，才读取这张图；',
      '成功/失败判定仍以结构化条件为准，图片只作辅助证据，不能把失败升级为成功。'
    ].filter(Boolean).join('\n');
    return this.bridge.forward(text, { from: 'screenshot' });
  }

  /** Latest frame for `/observe` aux and for the panel. */
  latest() {
    return this.lastShot ? { ...this.lastShot } : null;
  }

  status() {
    return {
      enabled: this.cfg.enabled,
      startedAt: this._startedAt,
      lastShot: this.latest(),
      shots: this.shots.length,
      perTask: Object.fromEntries(this.perTask),
      hashes: this.hashes.length,
      dir: this.dir,
      cfg: { ...this.cfg }
    };
  }
}

module.exports = {
  ScreenshotPolicy,
  DEFAULTS,
  dhash,
  hamming,
  readPngLuma
};
