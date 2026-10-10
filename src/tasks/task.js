'use strict';

/**
 * Task base class.
 *
 * A task is a resumable, cancellable unit of work with a hard timeout. The planner
 * ("brain") owns the queue and depends on these guarantees:
 *   - run() always settles (never hangs) because of Task.run's timeout wrapper
 *   - a task reports why it finished so the planner can learn from it
 *   - checkpoint() persists progress so a crash does not lose the plan
 */

const { Logger } = require('../util/logger');
const { SnapshotInventory } = require('../world/snapshotInventory');
const { countItem: countIn, countMatching, isLog } = require('../world/items');

/**
 * Task base class.
 *
 * A task is a resumable, cancellable unit of work with a hard timeout. The planner
 * ("brain") owns the queue and depends on these guarantees:
 *   - run() always settles (never hangs) because of Task.run's timeout wrapper
 *   - a task reports why it finished so the planner can learn from it
 *   - checkpoint() persists progress so a crash does not lose the plan
 *
 * Body-aware helpers
 * ------------------
 * Tasks must not talk to mineflayer directly. `this.body`, `this.world_state`,
 * `this.inventory`, `this.countItem()` and `this.position` all come from the Body
 * contract, so the same task runs against a real bot, a scripted mock world, or a
 * Forge client.
 */
class Task {
  constructor(ctx, options = {}) {
    // { cfg, body, world, nav, combat, eat, tools, memory, log, controller? }
    this.ctx = ctx;
    this.name = options.name || 'task';
    this.description = options.description || this.name;
    this.priority = options.priority === undefined ? 50 : options.priority;
    this.timeoutMs = options.timeoutMs || 60000;
    this.maxRetries = options.maxRetries === undefined ? 2 : options.maxRetries;
    this.retries = 0;
    this.state = 'pending'; // pending | running | done | failed | cancelled
    this.result = null;
    this.startedAt = null;
    this.finishedAt = null;
    this.cancelled = false;
    this.log = new Logger(`task:${this.name}`);
  }

  /** The body this task drives. May be null in tests that only exercise progress(). */
  get body() {
    return this.ctx.body || null;
  }

  /**
   * Legacy accessor kept for the few places that genuinely need the mineflayer handle
   * (registry lookups). Prefer `this.body` in anything new.
   */
  get bot() {
    return this.ctx.controller ? this.ctx.controller.bot : this.ctx.bot;
  }

  /** Latest world/self state from the body, or null when detached. (Named world_state because 	his.state is the task's own state machine.) */
  get world_state() {
    if (!this.body) return null;
    return this.body.snapshot();
  }

  /** A mineflayer-shaped inventory facade, so item helpers keep working. */
  get inventory() {
    const snap = this.world_state;
    return new SnapshotInventory((snap && snap.inventory) || {}, { emptySlots: snap ? snap.emptySlots : undefined });
  }

  /**
   * Count one item by name (bare names accepted).
   *
   * Named `countItem` rather than `count` because `this.count` is already the requested
   * quantity - a collision that silently shadowed the method and produced
   * "this.count is not a function" on every craft attempt.
   */
  countItem(name) {
    return countIn({ inventory: this.inventory }, name);
  }

  /** Count items matching a name predicate. */
  countWhere(predicate) {
    return countMatching({ inventory: this.inventory }, predicate);
  }

  /** Logs currently held. */
  countLogs() {
    return this.countWhere(isLog);
  }

  /** Current position, or null. */
  get position() {
    const snap = this.world_state;
    return snap ? snap.position : null;
  }

  async execute() {
    this.state = 'running';
    this.startedAt = Date.now();
    /**
     * The timeout is cleared as soon as `run()` settles.
     *
     * Without the clear, every task leaves a pending timer of its full `timeoutMs`
     * behind it. That is invisible while the agent runs, but it keeps the Node event loop
     * alive for up to three minutes after the work is done - so the CLI never exits, a
     * `--diagnose` run appears to hang, and a long-lived agent accumulates one dead timer
     * per task. Found exactly that way: the offline task test printed its summary and then
     * sat there.
     */
    let timer = null;
    try {
      const res = await Promise.race([
        this.run(),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, reason: `timeout after ${this.timeoutMs}ms` }), this.timeoutMs);
        })
      ]);
      const normalized = normalizeResult(res);
      this.state = normalized.ok ? 'done' : 'failed';
      this.result = normalized;
      return normalized;
    } catch (err) {
      this.state = 'failed';
      this.result = { ok: false, reason: `throw: ${err.message}` };
      this.log.debug(`task threw: ${err.stack || err.message}`);
      return this.result;
    } finally {
      if (timer) clearTimeout(timer);
      this.finishedAt = Date.now();
    }
  }

  /** Subclasses implement this. Should resolve {ok, reason} or a plain string. */
  async run() {
    throw new Error(`${this.name}.run() not implemented`);
  }

  /** Rough progress indicator used for logging and for the survival loop. */
  progress() {
    return null;
  }

  cancel() {
    this.cancelled = true;
    this.state = 'cancelled';
    if (this.ctx.nav) this.ctx.nav.interrupt(`task ${this.name} cancelled`);
  }

  succeed(reason = 'ok') {
    return { ok: true, reason };
  }

  fail(reason = 'failed') {
    return { ok: false, reason };
  }

  checkpoint() {
    if (this.ctx.memory) {
      this.ctx.memory.recordTask(this.name, {
        description: this.description,
        progress: this.progress(),
        at: Date.now()
      });
    }
  }

  describe() {
    return `${this.name}: ${this.description}`;
  }

  snapshot() {
    return {
      name: this.name,
      description: this.description,
      state: this.state,
      priority: this.priority,
      retries: this.retries,
      progress: safeProgress(this),
      result: this.result,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt
    };
  }
}

function safeProgress(task) {
  try {
    return task.progress();
  } catch {
    return null;
  }
}

function normalizeResult(res) {
  if (res === undefined || res === null) return { ok: true, reason: 'completed' };
  if (typeof res === 'string') return { ok: true, reason: res };
  if (typeof res === 'boolean') return { ok: res, reason: res ? 'completed' : 'returned false' };
  /**
   * Objects keep their fields.
   *
   * The old shape kept only ok/reason, which threw away `mined`/`ledger`/`minedAt` from
   * the mine_ore adapter and made the planner unable to report what a mining task
   * actually produced (plan §5.6.3: "修正 Task.normalizeResult 当前只保留 ok/reason
   * 的行为"). `ok` and `reason` are still normalised here so every caller keeps the
   * same contract.
   */
  if (typeof res === 'object') {
    return { ...res, ok: res.ok !== false, reason: res.reason || res.message || 'completed' };
  }
  return { ok: true, reason: String(res) };
}

module.exports = { Task, normalizeResult };
