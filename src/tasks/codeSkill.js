'use strict';

/**
 * CodeSkillTask: run one PROMOTED generated code skill through the normal task path.
 *
 * M4 integration (2026-10-25): generation, the restricted trial and promotion already
 * existed, and a promoted skill could be executed over HTTP, but the live agent had no way
 * to invoke it. This adapter registers `code_skill` in TASK_BUILDERS so the `!code-skill`
 * command, the DSH action brain's `mc_step` and `mc_plan` steps all reach the same
 * promotion-only dispatch:
 *
 *   - only the current promoted version runs (`runPromoted` never looks at candidates);
 *   - the sandbox keeps its permission model, timeout, call budget and evidence;
 *   - cancellation aborts the sandbox child through the service's AbortController;
 *   - the task slot keeps one body owner and the event chain keeps planId/stepId.
 *
 * Arguments (command table, plan step or proposal):
 *   { name: "namespace.skill", params: { ... } }
 */

const { Task } = require('./task');

class CodeSkillTask extends Task {
  constructor(ctx, options = {}) {
    const skill = String(options.name || options.skill || '').trim();
    super(ctx, {
      name: 'code_skill',
      description: options.description || `run promoted code skill ${skill || '(missing name)'}`,
      timeoutMs: options.timeoutMs || 120000,
      priority: options.priority
    });
    this.skillName = skill;
    this.params =
      options.params && typeof options.params === 'object' && !Array.isArray(options.params)
        ? { ...options.params }
        : {};
    /** Bridges Task.cancel() into the sandbox runner's AbortController. */
    this._controller = new AbortController();
    this._ran = false;
    this.last = null;
  }

  /**
   * Deliberately no progress(): a code skill is one atomic sandbox run, and reporting a
   * constant "1" made the B1 stall detector see two identical progress values and park the
   * task ("made no progress (1) for 2 runs", live 2026-10-25). null = no comparable progress.
   */
  async run() {
    const service = this.ctx.codeSkills;
    if (!service || typeof service.runPromoted !== 'function') return this.fail('code-skills-unavailable');
    if (!this.skillName) return this.fail('skill-name-required');

    const result = await service
      .runPromoted(this.skillName, this.params, {
        timeoutMs: this.timeoutMs,
        signal: this._controller.signal
      })
      .catch((err) => ({ ok: false, reason: `code-skill-error: ${err.message}` }));

    this._ran = true;
    this.last = result || null;

    if (this.cancelled || this._controller.signal.aborted) {
      return { ok: false, status: 'cancelled', reason: 'code skill cancelled' };
    }
    if (result && result.ok === true) {
      return {
        ok: true,
        name: this.skillName,
        version: result.version || null,
        evidencePath: result.evidencePath || null,
        result: result.result || null,
        reason: `code skill ${this.skillName} succeeded`
      };
    }
    const reason =
      (result && (result.reason || (result.result && result.result.reason))) ||
      `code skill ${this.skillName} failed`;
    return {
      ok: false,
      name: this.skillName,
      version: (result && result.version) || null,
      evidencePath: (result && result.evidencePath) || null,
      result: (result && result.result) || null,
      reason
    };
  }

  cancel() {
    this._controller.abort();
    super.cancel();
  }
}

module.exports = { CodeSkillTask };
