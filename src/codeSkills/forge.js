'use strict';

/**
 * SkillForge - let the ACTION BRAIN obtain a script mid-task (2026-10-29).
 *
 * Live finding: a goal that needs tick-accurate jump+place (climb out of a 1-wide shaft) made
 * the brain call the raw input layer one `mc_step` at a time - 27 calls, one block of height,
 * then stuck. The right answer is a script (`pillar({count})` inside a v3 code skill), but
 * generation was operator-HTTP-only, so the brain had no way to get one.
 *
 * The forge is that channel: `code-skill forge <prompt>` runs the normal M4 repair loop
 * (<=4 rounds, verbatim error feedback, verification) in the background, promotes on success
 * (config `codeSkills.autoPromote`), and reports the concrete `code-skill <name>` to run.
 *
 * It is still the same safety envelope: candidate on disk, sandboxed trial, declarative
 * preconditions/verification, evidence per run. The forge only removes the operator from the
 * *clicking*, not from the budget: one job at a time, bounded rounds, bounded jobs kept.
 */

const MAX_KEEP = 20;

class SkillForge {
  /**
   * @param {object} deps { service, reply, log, maxRounds, autoPromote, now }
   */
  constructor(deps = {}) {
    this.service = deps.service || null;
    this.reply = typeof deps.reply === 'function' ? deps.reply : null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.now = deps.now || (() => Date.now());
    this.maxRounds = Math.min(Math.max(Number(deps.maxRounds) || 4, 1), 4);
    this.autoPromote = deps.autoPromote !== false;
    /** jobId -> { id, prompt, state, startedAt, finishedAt, result, error } */
    this.jobs = new Map();
    this.seq = 0;
    this._running = null;
  }

  get busy() {
    return this._running !== null;
  }

  /**
   * Start one forge job. Returns immediately; the job reports through `reply` and status.
   * @param {string} prompt
   * @returns {{ok:boolean, jobId?:string, reason?:string}}
   */
  start(prompt) {
    const text = String(prompt || '').trim();
    if (!text) return { ok: false, reason: 'empty-prompt' };
    if (!this.service || typeof this.service.generateAndTrial !== 'function') {
      return { ok: false, reason: 'code-skills-unavailable' };
    }
    if (this._running) return { ok: false, reason: 'forge-busy', jobId: this._running };
    this.seq += 1;
    const jobId = `forge-${this.now()}-${this.seq}`;
    const job = {
      id: jobId,
      prompt: text,
      state: 'running',
      attempts: null,
      result: null,
      error: null,
      promoted: null,
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null
    };
    this.jobs.set(jobId, job);
    this._running = jobId;
    while (this.jobs.size > MAX_KEEP) {
      this.jobs.delete(this.jobs.keys().next().value);
    }
    this.log.info(`skill forge started: ${jobId} (${text.slice(0, 80)})`);
    this.run(job).catch((err) => {
      job.state = 'failed';
      job.error = err.message;
      job.finishedAt = new Date(this.now()).toISOString();
      this._running = null;
      this.log.warn(`skill forge crashed: ${err.message}`);
      this.say(`生成脚本失败：${err.message}`);
    });
    return { ok: true, jobId, maxRounds: this.maxRounds, autoPromote: this.autoPromote };
  }

  /** The forge job itself: generate+trial (<=4 rounds), then promote when configured. */
  async run(job) {
    const outcome = await this.service.generateAndTrial({
      prompt: job.prompt,
      maxRounds: this.maxRounds,
      params: {}
    });
    job.attempts = Array.isArray(outcome.attempts) ? outcome.attempts.map((entry) => ({
      round: entry.round,
      stage: entry.stage,
      version: entry.version || null,
      reason: entry.reason || null
    })) : null;
    if (!outcome.ok) {
      job.state = 'failed';
      job.error = outcome.reason || 'generation-failed';
      job.result = { rounds: outcome.rounds || this.maxRounds, name: outcome.last && outcome.last.name || null };
      job.finishedAt = new Date(this.now()).toISOString();
      this._running = null;
      this.log.warn(`skill forge failed: ${job.error}`);
      this.say(`脚本没生成成功（${job.error}）：${job.attempts ? job.attempts.map((a) => `r${a.round}:${a.stage}`).join(' ') : ''}`);
      return;
    }

    job.result = {
      name: outcome.name,
      version: outcome.version,
      rounds: outcome.rounds,
      description: outcome.manifest && outcome.manifest.description ? outcome.manifest.description : ''
    };
    if (this.autoPromote) {
      const promoted = this.service.promote(outcome.name, outcome.version);
      job.promoted = promoted && promoted.ok ? { name: outcome.name, version: outcome.version } : null;
      if (!promoted || promoted.ok !== true) {
        job.state = 'trialled';
        job.error = (promoted && promoted.reason) || 'promote-failed';
        job.finishedAt = new Date(this.now()).toISOString();
        this._running = null;
        this.log.warn(`skill forge trialled but not promoted: ${job.error}`);
        this.say(`脚本 ${outcome.name}@${outcome.version} 试运行通过，但晋升失败：${job.error}`);
        return;
      }
    } else {
      job.state = 'trialled';
      job.finishedAt = new Date(this.now()).toISOString();
      this._running = null;
      this.say(`脚本 ${outcome.name}@${outcome.version} 试运行通过，等待晋升`);
      return;
    }

    job.state = 'promoted';
    job.finishedAt = new Date(this.now()).toISOString();
    this._running = null;
    this.log.info(`skill forge promoted: ${outcome.name}@${outcome.version} in ${outcome.rounds} round(s)`);
    this.say(`脚本 ${outcome.name}@${outcome.version} 已生成并晋升，可以用 code-skill ${outcome.name} 执行`);
  }

  say(text) {
    if (!this.reply) return;
    try {
      Promise.resolve(this.reply(text, { why: 'skill-forge' })).catch(() => {});
    } catch (err) {
      this.log.debug(`forge reply failed: ${err.message}`);
    }
  }

  status(jobId = null) {
    if (jobId) {
      const job = this.jobs.get(String(jobId));
      return job ? { ok: true, job: { ...job } } : { ok: false, reason: 'unknown-job', jobId };
    }
    return {
      ok: true,
      busy: this.busy,
      running: this._running,
      autoPromote: this.autoPromote,
      maxRounds: this.maxRounds,
      jobs: [...this.jobs.values()].map((job) => ({ ...job }))
    };
  }
}

module.exports = { SkillForge };
