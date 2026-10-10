'use strict';

/**
 * Mining recovery session: the Node-side state machine that takes over when the
 * deterministic macro cannot progress (docs/MINING-LLM-PLAN.md §5.3/§5.7).
 *
 * Shape of one session:
 *   QUIESCE -> OBSERVE -> MODEL -> VALIDATE -> EXECUTE_ONE -> VERIFY -> (next batch)
 *   -> recovered (goal mined + product in the bag + standing still) -> back to the macro
 *   -> blocked / failed / cancelled -> stop the task with the partial result preserved
 *
 * Non-negotiables from the plan:
 *   - the session belongs to the running mine_ore task: same TaskHub/Brain owner, no
 *     TaskHub.submit, no nested tasks (recoveryId is only an internal sub-session id);
 *   - success is decided by acquisition evidence, never by a batch succeeding or the
 *     model claiming completion;
 *   - short batches (1 first / after failure, growing to 3 only after clean batches),
 *     call / token / wall-clock / primitive-action / placed-block budgets all enforced;
 *   - a repeated proposal in the same situation is refused without executing it.
 */

const { createRecoveryTools } = require('../llm/miningRecoveryTools');
const { SYSTEM, renderReport, parseRecoveryResponse } = require('../llm/miningRecoveryPrompt');

let sessionSeq = 0;

const DEFAULT_CFG = {
  enabled: false,
  maxActionsPerBatch: 3,
  maxCellsPerDig: 3,
  maxCallsPerSession: 12,
  maxSessionMs: 180000,
  maxSessionTokens: 32000,
  maxPrimitiveActions: 32,
  maxPlacedBlocks: 8,
  /**
   * 15s was too tight for a thinking provider on a full recovery report (live
   * 2026-10-10: one call timed out with maxTokens=4096). 30s still sits inside the
   * session wall clock.
   */
  modelTimeoutMs: 30000,
  /**
   * Thinking providers (deepseek-flash) spend output budget on reasoning first: 2000
   * tokens produced empty content with finish=length (live 2026-10-10). 4096 leaves room
   * for thinking plus the short-batch JSON; total session spend stays capped by
   * maxSessionTokens.
   */
  maxOutputTokens: 4096,
  maxInvalidRepairs: 1,
  maxRepeatedProposals: 2,
  maxLocalMoveMs: 8000
};

class MiningRecoverySession {
  /**
   * @param {object} options
   *   - ctx, io (world primitives built by the caller), goal, signal, cfg, llm, trace
   *   - monitor: MiningProgressMonitor (receipts also land there)
   *   - trigger / triggerReason
   */
  constructor(options) {
    this.ctx = options.ctx || {};
    this.io = options.io;
    this.goal = options.goal;
    this.taskId = (options.ctx && options.ctx.taskId) || options.taskId || null;
    sessionSeq += 1;
    this.recoveryId = `r${sessionSeq}`;
    this.signal = options.signal || { cancelled: false, reason: null, subscribe: () => () => {} };
    this.cfg = { ...DEFAULT_CFG, ...(options.cfg || {}) };
    this.llm = options.llm || null;
    this.trace = options.trace || (() => {});
    this.monitor = options.monitor || null;
    this.trigger = options.trigger || null;
    this.triggerReason = options.triggerReason || null;

    /** Observation revision: bumped by every world-modifying action this session takes. */
    this.revision = 0;
    this.callsUsed = 0;
    this.tokensUsed = 0;
    this.primitiveUsed = 0;
    this.placedUsed = 0;
    this.receipts = [];
    this.notes = [];
    this.repairHint = null;
    this.inspected = new Map(); // "x,y,z" -> name, from bounded inspect slices

    /** Real AbortSignal for the model transport; bridged from the task signal. */
    this.controller = new AbortController();
    if (typeof this.signal.subscribe === 'function') {
      this.signal.subscribe(() => this.controller.abort());
    } else if (this.signal.cancelled) {
      this.controller.abort();
    }

    this.budget = { spend: (n) => this.spend(n) };
    this.tools = createRecoveryTools(this);
  }

  spend(n) {
    if (this.primitiveUsed + n > this.cfg.maxPrimitiveActions) {
      return { ok: false, reason: `primitive action budget (${this.cfg.maxPrimitiveActions}) exhausted` };
    }
    this.primitiveUsed += n;
    return { ok: true };
  }

  bump() {
    this.revision += 1;
  }

  // ---- the interface miningRecoveryTools drives ----------------------------

  refresh() {
    return this.io.refresh();
  }

  feetOf(snapshot) {
    return this.io.feetOf(snapshot);
  }

  read(snapshot, cell) {
    return this.io.read(snapshot, cell);
  }

  passable(name) {
    return this.io.passable(name);
  }

  protectedName(name) {
    return this.io.protectedName(name);
  }

  async digCell(cell) {
    const result = await this.io.digCell(cell);
    if (result && result.ok) this.bump();
    return result;
  }

  async takeTarget() {
    const result = await this.io.takeTarget();
    if (result && result.ok && result.dug) this.bump();
    return result;
  }

  async pillarOne(options) {
    const result = await this.io.pillarOne(options);
    if (result && result.ok) this.bump();
    return result;
  }

  async moveLocal(stand, options) {
    const result = await this.io.moveLocal(stand, { ...options, timeoutMs: this.cfg.maxLocalMoveMs });
    this.bump();
    return result;
  }

  async placeBlock(item, reference, face) {
    if (this.placedUsed + 1 > this.cfg.maxPlacedBlocks) {
      return { ok: false, failure: 'budget', reason: `placed-block budget (${this.cfg.maxPlacedBlocks}) exhausted` };
    }
    const result = await this.io.placeBlock(item, reference, face);
    if (result && result.ok) {
      this.placedUsed += 1;
      this.bump();
    }
    return result;
  }

  pickScaffold(snapshot) {
    return this.io.pickScaffold(snapshot);
  }

  acquisitionState() {
    return this.io.acquisitionState();
  }

  async collectOnce(options) {
    const result = await this.io.collectOnce(options);
    this.bump();
    return result;
  }

  /**
   * Read-only inspect slice (plan §5.1): bounded, cached, and it does not raise the
   * revision - observation is not a world change.
   */
  async inspectSlice(slice) {
    const cells = await this.io.inspectSlice(slice);
    for (const cell of cells || []) {
      this.inspected.set(`${cell.x},${cell.y},${cell.z}`, cell.name);
    }
    if (this.inspected.size > 2048) {
      for (const key of this.inspected.keys()) {
        this.inspected.delete(key);
        if (this.inspected.size <= 1024) break;
      }
    }
    return cells;
  }

  // ---- report and model round ----------------------------------------------

  /** Batch-size escalation: 1 while nothing has gone clean yet, 2 after one clean batch, full after two. */
  allowedActions(consecutiveOk, lastFailed) {
    if (lastFailed || consecutiveOk === 0) return 1;
    if (consecutiveOk === 1) return Math.min(2, this.cfg.maxActionsPerBatch);
    return this.cfg.maxActionsPerBatch;
  }

  async buildReport({ maxActions }) {
    const snapshot = await this.io.refresh();
    const feet = snapshot ? this.io.feetOf(snapshot) : null;
    const acquisition = this.acquisitionState();
    const cells = await this.io.relevantCells({ inspected: this.inspected });
    const pending = acquisition.pendingDropsList || [];
    return {
      recoveryId: this.recoveryId,
      goalId: this.goal.goalId,
      revision: this.revision,
      mode: 'recovery',
      phase: acquisition.mined ? 'collect' : 'mine',
      target: { blockId: this.goal.target.blockId, position: { ...this.goal.target.position } },
      acquisition: {
        mined: acquisition.mined,
        verified: acquisition.verified,
        collectedItems: acquisition.collectedItems,
        pendingDrops: pending.length
      },
      pendingDropsList: pending.map((d) => ({ name: d.name, count: d.count, position: { ...d.position } })),
      position: feet || { x: 0, y: 0, z: 0 },
      grounded: snapshot ? snapshot.onGround !== false : false,
      held: (snapshot && snapshot.heldItem) || null,
      scaffold: (snapshot && this.io.pickScaffold(snapshot)) || null,
      canAccept: this.io.canAccept ? this.io.canAccept(snapshot) : true,
      trigger: this.trigger || 'unknown',
      triggerReason: this.triggerReason || '',
      maxActions,
      budget: {
        callsUsed: this.callsUsed,
        maxCalls: this.cfg.maxCallsPerSession,
        primitiveUsed: this.primitiveUsed,
        maxPrimitives: this.cfg.maxPrimitiveActions,
        placedUsed: this.placedUsed,
        maxPlaced: this.cfg.maxPlacedBlocks,
        sessionLeftMs: 0
      },
      cells,
      receipts: this.receipts.slice(-8),
      notes: this.notes.slice(-6),
      repairHint: this.repairHint
    };
  }

  async callModel(report) {
    if (!this.llm || typeof this.llm.complete !== 'function') {
      return { ok: false, reason: 'no model client available' };
    }
    if (this.tokensUsed >= this.cfg.maxSessionTokens) {
      return { ok: false, reason: 'session token budget exhausted' };
    }
    const user = renderReport(report);
    /**
     * One accounted model request. Book every request against the session budget: reported
     * usage when present, otherwise a conservative estimate - never zero (plan §5.8).
     */
    const request = async (maxTokens) => {
      this.callsUsed += 1;
      const reply = await this.llm.complete({
        system: SYSTEM,
        messages: [{ role: 'user', content: user }],
        maxTokens,
        timeoutMs: this.cfg.modelTimeoutMs,
        temperature: 0.1,
        signal: this.controller.signal
      });
      this.trace({
        kind: 'recovery-model',
        recoveryId: this.recoveryId,
        call: this.callsUsed,
        maxTokens,
        ok: reply.ok !== false,
        reason: reply.reason || null
      });
      if (reply.ok) {
        const usage = reply.usage || {};
        this.tokensUsed +=
          Number(usage.total_tokens) ||
          Math.ceil((SYSTEM.length + user.length + String(reply.text || '').length) / 4);
      } else {
        this.tokensUsed += Math.ceil((SYSTEM.length + user.length) / 4);
      }
      return reply;
    };

    let reply = await request(this.cfg.maxOutputTokens);
    /**
     * Thinking providers can burn the whole output budget on reasoning and return empty
     * content (finish=length). LlmCore already uses a one-shot doubled-budget retry for
     * exactly this failure; recovery does the same, and both requests are accounted.
     */
    if (reply.ok && !String(reply.text || '').trim() && this.tokensUsed < this.cfg.maxSessionTokens) {
      reply = await request(Math.min(8192, this.cfg.maxOutputTokens * 2));
    }
    return reply;
  }

  /** Situation fingerprint for the repeat guard: caller-provided, else feet+revision. */
  async snapshotFingerprint() {
    if (typeof this.io.fingerprint === 'function') return this.io.fingerprint();
    const snapshot = await this.io.refresh();
    const feet = snapshot ? this.io.feetOf(snapshot) : null;
    return `${feet ? `${feet.x},${feet.y},${feet.z}` : '?'}|${this.revision}`;
  }
}

function summarize(session, outcome, reason, failure, startedAt) {
  const acquisition = session.acquisitionState();
  const summary = {
    ok: outcome === 'recovered',
    outcome,
    reason: reason || null,
    failure: failure || null,
    recoveryId: session.recoveryId,
    goalId: session.goal.goalId,
    trigger: session.trigger,
    triggerReason: session.triggerReason,
    calls: session.callsUsed,
    tokens: session.tokensUsed,
    primitiveActions: session.primitiveUsed,
    placedBlocks: session.placedUsed,
    acquisition,
    pendingDrops: (acquisition.pendingDropsList || []).length,
    elapsedMs: Date.now() - startedAt
  };
  session.trace({ kind: 'recovery-ended', ...summary, acquisition: undefined });
  return summary;
}

/**
 * Run one recovery session to a conclusion.
 *
 * @returns {Promise<object>} summary {ok, outcome: recovered|blocked|failed|cancelled,
 *   reason, failure, recoveryId, goalId, trigger, calls, tokens, primitiveActions,
 *   placedBlocks, acquisition, pendingDrops, elapsedMs}
 */
async function runMiningRecovery(session) {
  const startedAt = Date.now();
  const cfg = session.cfg;
  const milestone = async () => {
    const acquisition = session.acquisitionState();
    if (!acquisition.mined || !acquisition.verified) return false;
    if (typeof session.io.stable === 'function' && !(await session.io.stable())) return false;
    return true;
  };

  /**
   * QUIESCE: the caller stopped its action before handing over; if the stop did not
   * confirm, no model action may start (plan §5.3.1).
   */
  if (typeof session.io.quiesced === 'function' && !(await session.io.quiesced())) {
    return summarize(session, 'blocked', 'the previous action did not stop before takeover', 'not_stopped', startedAt);
  }

  let consecutiveOk = 0;
  let lastFailed = false;
  let repairs = 0;
  let repeatCount = 0;
  let lastSignature = null;
  let lastFingerprint = null;
  let inspectRepeats = 0;
  let inspectFingerprint = null;

  for (let round = 0; ; round += 1) {
    if (session.signal.cancelled) {
      return summarize(session, 'cancelled', session.signal.reason || 'task cancelled', 'interrupted', startedAt);
    }
    if (Date.now() - startedAt > cfg.maxSessionMs) {
      return summarize(session, 'failed', 'session time budget exhausted', 'timeout', startedAt);
    }
    if (session.callsUsed >= cfg.maxCallsPerSession) {
      return summarize(session, 'failed', `call budget exhausted (${cfg.maxCallsPerSession})`, 'budget', startedAt);
    }
    if (await milestone()) return summarize(session, 'recovered', null, null, startedAt);

    const maxActions = session.allowedActions(consecutiveOk, lastFailed);
    const report = await session.buildReport({ maxActions });
    const reply = await session.callModel(report);
    if (!reply.ok) {
      if (session.signal.cancelled || reply.reason === 'cancelled') {
        return summarize(session, 'cancelled', 'cancelled during the model wait', 'interrupted', startedAt);
      }
      return summarize(session, 'failed', `recovery_unavailable: ${reply.reason}`, 'unsupported', startedAt);
    }
    const parsed = parseRecoveryResponse(reply.text);
    if (!parsed.ok) {
      if (repairs < cfg.maxInvalidRepairs) {
        repairs += 1;
        session.repairHint = parsed.reason;
        continue;
      }
      return summarize(session, 'failed', `invalid recovery response: ${parsed.reason}`, 'bad_argument', startedAt);
    }
    const batch = parsed.batch;
    if (batch.recoveryId !== session.recoveryId || batch.goalId !== session.goal.goalId) {
      return summarize(session, 'failed', 'the answer does not match the live session', 'bad_argument', startedAt);
    }
    if (batch.basedOnRevision > session.revision) {
      return summarize(session, 'failed', 'the answer refers to a revision the world never reached', 'bad_argument', startedAt);
    }
    if (batch.decision === 'stop') {
      return summarize(session, 'blocked', batch.reason || 'the model stopped the recovery', 'stopped', startedAt);
    }
    if (batch.decision === 'inspect') {
      await session.inspectSlice(batch.inspect);
      const fingerprint = await session.snapshotFingerprint();
      if (fingerprint === inspectFingerprint) {
        inspectRepeats += 1;
        if (inspectRepeats >= 2 && session.notes.length < 8) {
          session.notes.push('the same inspect slice was requested twice without any progress');
        }
      } else {
        inspectFingerprint = fingerprint;
        inspectRepeats = 0;
      }
      continue;
    }

    const validated = session.tools.validateBatch(batch.steps, { maxActions });
    if (!validated.ok) {
      if (repairs < cfg.maxInvalidRepairs) {
        repairs += 1;
        session.repairHint = validated.reason;
        continue;
      }
      return summarize(session, 'failed', `invalid batch: ${validated.reason}`, 'bad_argument', startedAt);
    }
    const signature = JSON.stringify(validated.steps.map((step) => [step.tool, step.args]));
    const fingerprint = await session.snapshotFingerprint();
    if (lastSignature === signature && lastFingerprint === fingerprint) {
      repeatCount += 1;
      session.receipts.push({ kind: 'batch-rejected', reason: 'repeat_rejected' });
      if (repeatCount >= cfg.maxRepeatedProposals) {
        return summarize(session, 'failed', 'no_valid_recovery', 'no_valid_recovery', startedAt);
      }
      continue;
    }
    lastSignature = signature;
    lastFingerprint = fingerprint;
    repeatCount = 0;

    let batchOk = true;
    for (let i = 0; i < validated.steps.length; i += 1) {
      if (session.signal.cancelled) {
        return summarize(session, 'cancelled', session.signal.reason || 'task cancelled', 'interrupted', startedAt);
      }
      const step = validated.steps[i];
      const stepId = step.id || `${session.recoveryId}-b${round}-s${i}`;
      const result = await session.tools.call(step.tool, step.args, { stepId });
      session.receipts.push({
        tool: step.tool,
        args: step.args,
        ok: result.ok !== false,
        failure: result.failure || null,
        reason: result.reason || null
      });
      if (session.receipts.length > 12) session.receipts.shift();
      if (session.monitor) {
        session.monitor.record({
          goalId: session.goal.goalId,
          phase: report.phase,
          action: step.tool,
          ok: result.ok !== false,
          failure: result.failure || null,
          reason: result.reason || null,
          fingerprint
        });
      }
      if (!result.ok) {
        batchOk = false;
        if (session.notes.length < 8) session.notes.push(`${step.tool} failed: ${result.reason || result.failure || 'unknown'}`);
        break; // the remaining steps of this batch are truncated, not executed
      }
      if (await milestone()) return summarize(session, 'recovered', null, null, startedAt);
    }
    lastFailed = !batchOk;
    consecutiveOk = batchOk ? consecutiveOk + 1 : 0;
  }
}

module.exports = { MiningRecoverySession, runMiningRecovery, DEFAULT_CFG };
