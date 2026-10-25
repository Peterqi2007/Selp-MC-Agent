'use strict';

/**
 * CodeSkillService - the live M4 loop: generate -> candidate -> sandbox trial -> evidence ->
 * promote / rollback / retire.
 *
 * The generated code lives on disk in CodeSkillDirectory and metadata/lifecycle state lives
 * in CodeSkillStore. This service is the only object that touches both, and it is the host
 * for the sandbox capability RPC:
 *
 *   read_state   sanitized snapshot (no raw block map)
 *   submit_task  through Brain.buildTask + enqueue, i.e. the normal TaskSlot/permission path
 *   chat         the single reply() path with the conversation guard
 *   wait         handled inside the worker (bounded)
 *   search       DeepSeek Search through WebSearch (Node network broker)
 *   generate     another candidate through the generation backend (bounded per run)
 *   subprocess   a Node script inside the run's sandbox dir, with the same permission flags
 *
 * Approval policy for the 2026-10-18 window: the operator authorized real generation and
 * real sandbox execution once; there is no per-action approval. The hard limits in
 * SandboxRunner (timeout/call budget/result cap) and the permission list stay in force.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { CodeSkillStore } = require('./store');
const { CodeSkillDirectory } = require('./directory');
const { CodeSkillGenerator, scanCode } = require('./generator');
const { isDaytime } = require('../world/daytime');
const { validateManifest, ALLOWED_PERMISSIONS } = require('./manifest');
const { SandboxRunner } = require('./sandboxRunner');

const MAX_SUBPROCESS_MS = 10000;
const MAX_SUBPROCESS_OUTPUT = 16 * 1024;

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

function summarizeRun(result) {
  return {
    ok: result.ok === true,
    executed: result.executed === true,
    runId: result.runId || null,
    reason: result.reason || null,
    result: result.result === undefined ? null : result.result,
    timeout: result.timeout === true,
    cancelled: result.cancelled === true,
    durationMs: result.durationMs || null,
    callCount: result.callCount || 0,
    calls: result.calls || [],
    logs: result.logs || [],
    exit: result.exit || null
  };
}

class CodeSkillService {
  constructor(deps = {}) {
    if (!deps.root) throw new Error('CodeSkillService needs a root');
    this.root = path.resolve(deps.root);
    this.storeFile = path.join(this.root, 'store.json');
    this.evidenceDir = deps.evidenceDir || path.join('runtime', 'code-skill-runs');
    this.store = deps.store || new CodeSkillStore();
    this.directory = deps.directory || new CodeSkillDirectory({ root: this.root });
    this.generator =
      deps.generator || new CodeSkillGenerator({ generate: deps.generate || null, maxBytes: deps.maxBytes || 64 * 1024 });
    this.generation = deps.generation || null;
    this.sandbox =
      deps.sandbox ||
      new SandboxRunner({
        workerPath: deps.workerPath,
        sandboxRoot: deps.sandboxRoot || path.join('runtime', 'code-skill-sandbox'),
        timeoutMs: deps.timeoutMs,
        maxTimeoutMs: deps.maxTimeoutMs,
        maxCalls: deps.maxCalls,
        keepDirs: deps.keepDirs,
        log: deps.log
      });
    this.search = deps.search || null;
    this.ctx = deps.ctx || {};
    this.brain = deps.brain || (this.ctx && this.ctx.brain) || null;
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.now = deps.now || (() => Date.now());
    this.maxGeneratePerRun = deps.maxGeneratePerRun || 1;
    this._runGeneration = new Map();
    this._active = new Map();
    this._chatAt = 0;
    this._load();
  }

  status() {
    return {
      root: this.root,
      candidates: this.store.list(),
      promoted: [...this.store.promoted.entries()].map(([name, pointer]) => ({ name, ...pointer })),
      sandbox: { timeoutMs: this.sandbox.timeoutMs, maxCalls: this.sandbox.maxCalls },
      active: [...this._active.keys()],
      search: this.search && typeof this.search.status === 'function' ? this.search.status() : null,
      generation: {
        backends: {
          generator: !!(this.generator && this.generator.generate),
          model: !!this.generation
        }
      }
    };
  }

  list() {
    return this.store.list();
  }

  get(name, version) {
    return this.store.getCandidate(name, version);
  }

  /**
   * Generate a real candidate and write it to candidates/. The model output is validated
   * and statically scanned first; it is never imported here.
   */
  async generateCandidate({ prompt, manifest = null, source = 'generated', requestId = null } = {}) {
    if (!this.generation || typeof this.generation.generate !== 'function') {
      return { ok: false, reason: 'no-generation-backend' };
    }
    if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, reason: 'empty-prompt' };
    if (prompt.length > 4000) return { ok: false, reason: 'prompt-too-long' };
    const generated = await this.generation.generate({ prompt, manifest, requestId });
    if (!generated.ok) return generated;
    const validation = validateManifest(generated.manifest);
    if (!validation.ok) return { ok: false, reason: 'invalid-manifest', errors: validation.errors };
    const scan = scanCode(generated.code, { maxBytes: 64 * 1024 });
    if (!scan.ok) return { ok: false, reason: 'unsafe-code', errors: scan.errors };
    const name = generated.manifest.name;
    const version = generated.manifest.version;
    if (this.store.getCandidate(name, version)) {
      return { ok: false, reason: 'duplicate-version', name, version };
    }
    const written = this.directory.writeCandidate(generated.manifest, generated.code);
    if (!written.ok) return written;
    const added = this.store.addCandidate(generated.manifest, { source });
    if (!added.ok) return added;
    this._save();
    this.log.info(`code skill candidate written: ${name}@${version} (${scan.bytes} bytes)`);
    return {
      ok: true,
      name,
      version,
      key: added.key,
      status: 'candidate',
      bytes: scan.bytes,
      dir: written.dir,
      manifest: generated.manifest
    };
  }

  /** Run a real sandbox trial, write evidence, and record the result on the candidate. */
  async trial(name, version, options = {}) {
    const candidate = this.store.getCandidate(name, version);
    if (!candidate) return { ok: false, reason: 'unknown-candidate' };
    if (!['candidate', 'trialled'].includes(candidate.status)) {
      return { ok: false, reason: `candidate-${candidate.status}` };
    }
    const onDisk = this.directory.readCandidate(name, version);
    if (!onDisk) return { ok: false, reason: 'candidate-code-missing' };

    /**
     * Revocation: the operator can abort one trial by name/version or all trials from the
     * control surface. The controller is forwarded to SandboxRunner, which kills the child
     * and removes the throwaway directory. Cancellation is not a failed trial and does not
     * quarantine the candidate.
     */
    const key = `${name}@${version}`;
    const controller = new AbortController();
    this._active.set(key, controller);
    const forwardAbort = () => controller.abort();
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    let run;
    try {
      run = await this.sandbox.run({
        name,
        version,
        entry: onDisk.manifest.entry,
        code: onDisk.code,
        manifest: onDisk.manifest,
        params: options.params || {},
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
        host: this._host()
      });
    } catch (err) {
      run = {
        ok: false,
        executed: false,
        runId: `service-error-${Date.now()}`,
        reason: `sandbox-error: ${err.message}`,
        calls: [],
        logs: []
      };
    } finally {
      this._active.delete(key);
      if (options.signal && typeof options.signal.removeEventListener === 'function') {
        options.signal.removeEventListener('abort', forwardAbort);
      }
    }

    const evidence = {
      kind: 'code-skill-trial',
      name,
      version,
      manifest: onDisk.manifest,
      params: options.params || {},
      ...run
    };
    let evidencePath = null;
    try {
      fs.mkdirSync(this.evidenceDir, { recursive: true });
      evidencePath = path.join(this.evidenceDir, `${name}@${version}-${run.runId || Date.now()}.json`);
      atomicWrite(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    } catch (err) {
      this.log.warn(`trial evidence write failed: ${err.message}`);
    }
    if (run.cancelled) {
      return {
        ok: false,
        cancelled: true,
        name,
        version,
        status: candidate.status,
        reason: 'cancelled',
        result: summarizeRun(run),
        evidencePath,
        evidence
      };
    }
    const record = this.store.recordTrial(name, version, {
      ok: run.ok === true,
      report: { ...summarizeRun(run), evidencePath }
    });
    this._save();
    return {
      ok: run.ok === true,
      name,
      version,
      status: record.status || null,
      result: summarizeRun(run),
      evidencePath,
      evidence
    };
  }

  /**
   * Execute the CURRENT PROMOTED version. This is the normal dispatch path after promotion;
   * it never looks at candidates. The same sandbox/limits/evidence rules apply.
   */
  async runPromoted(name, params = {}, options = {}) {
    const pointer = this.store.getPromoted(name);
    if (!pointer) return { ok: false, reason: 'not-promoted' };
    const onDisk = this.directory.readPromoted(name, pointer.version);
    if (!onDisk) return { ok: false, reason: 'promoted-code-missing' };
    const key = `${name}@${pointer.version}`;
    const controller = new AbortController();
    this._active.set(key, controller);
    const forwardAbort = () => controller.abort();
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', forwardAbort, { once: true });
    }
    let run;
    try {
      run = await this.sandbox.run({
        name,
        version: pointer.version,
        entry: onDisk.manifest.entry,
        code: onDisk.code,
        manifest: onDisk.manifest,
        params,
        timeoutMs: options.timeoutMs,
        signal: controller.signal,
        host: this._host()
      });
    } catch (err) {
      run = {
        ok: false,
        executed: false,
        runId: `promoted-error-${Date.now()}`,
        reason: `sandbox-error: ${err.message}`,
        calls: [],
        logs: []
      };
    } finally {
      this._active.delete(key);
      if (options.signal && typeof options.signal.removeEventListener === 'function') {
        options.signal.removeEventListener('abort', forwardAbort);
      }
    }
    let evidencePath = null;
    try {
      fs.mkdirSync(this.evidenceDir, { recursive: true });
      evidencePath = path.join(this.evidenceDir, `${name}@${pointer.version}-${run.runId || Date.now()}-run.json`);
      atomicWrite(evidencePath, `${JSON.stringify({ kind: 'code-skill-promoted-run', name, version: pointer.version, params, ...run }, null, 2)}\n`);
    } catch (err) {
      this.log.warn(`promoted run evidence write failed: ${err.message}`);
    }
    return {
      ok: run.ok === true,
      name,
      version: pointer.version,
      result: summarizeRun(run),
      evidencePath
    };
  }

  /** Revoke one running trial; returns whether an active run was found. */
  cancel(name, version) {
    const keys = version
      ? [`${name}@${version}`]
      : [...this._active.keys()].filter((key) => key.startsWith(`${name}@`));
    const found = keys.filter((key) => this._active.has(key));
    for (const key of found) this._active.get(key).abort();
    if (!found.length) return { ok: false, reason: 'not-running' };
    return { ok: true, name, version: version || null, action: 'abort-requested', keys: found };
  }

  /** Revoke every running trial (emergency stop / shutdown). */
  cancelAll() {
    const active = [...this._active.keys()];
    for (const controller of this._active.values()) controller.abort();
    return { ok: true, aborted: active };
  }

  /** Generate + immediately trial (the HTTP convenience entry). */
  async generateAndTrial(options = {}) {
    const generated = await this.generateCandidate(options);
    if (!generated.ok) return generated;
    const trial = await this.trial(generated.name, generated.version, options);
    return { ...generated, trial };
  }

  promote(name, version) {
    const candidate = this.store.getCandidate(name, version);
    if (!candidate) return { ok: false, reason: 'unknown-candidate' };
    if (candidate.status !== 'trialled' || !candidate.tests || candidate.tests.ok !== true) {
      return { ok: false, reason: 'not-trialled' };
    }
    const copied = this.directory.promote(name, version);
    if (!copied.ok) return copied;
    const promoted = this.store.promote(name, version);
    if (!promoted.ok) {
      this.directory.rollback(name);
      return promoted;
    }
    this._save();
    return { ok: true, name, version, previous: promoted.previous || null };
  }

  rollback(name) {
    const directory = this.directory.rollback(name);
    const store = this.store.rollback(name);
    if (store.ok) this._save();
    return { ok: store.ok && directory.ok, store, directory };
  }

  retire(name, version) {
    const directory = this.directory.retire(name, version);
    const store = this.store.retire(name, version);
    if (store.ok) this._save();
    return { ok: store.ok && directory.ok, store, directory };
  }

  /** The sandbox host. The runner has already checked the manifest permission; this also
   * checks it again so a future caller cannot bypass the runner. */
  _host() {
    return {
      read_state: async () => this._readState(),
      submit_task: async (args) => this._submitTask(args),
      chat: async (args) => this._chat(args),
      search: async (args) => this._search(args),
      generate: async (args) => this._generateFromSandbox(args),
      subprocess: async (args, context) => this._subprocess(args, context)
    };
  }

  _readState() {
    const body = this.ctx.body;
    const snap = body && typeof body.snapshot === 'function' ? body.snapshot() : null;
    if (!snap) return { ok: false, reason: 'no-live-state' };
    const inventory = {};
    for (const [name, count] of Object.entries(snap.inventory || {})) {
      if (!name || !Number.isFinite(Number(count)) || Number(count) <= 0) continue;
      inventory[String(name).replace(/^minecraft:/, '')] = Number(count);
    }
    return {
      ok: true,
      position: snap.position ? { ...snap.position } : null,
      health: snap.health,
      food: snap.food,
      dimension: snap.dimension,
      time: snap.time || (this.ctx.world && typeof this.ctx.world.summary === 'function' ? this.ctx.world.summary().time : null),
      /**
       * A18 live 2026-10-25: `snap.isDay` did not exist on the client body, so every
       * generated status report said "夜晚" while the game was in daylight. Derive it from
       * the same shared clock rule as the rest of the agent (timeOfDay authoritative,
       * isDay only a fallback) instead of exposing an always-undefined field.
       */
      isDay:
        isDaytime(snap.time) !== null
          ? isDaytime(snap.time)
          : typeof snap.isDay === 'boolean'
            ? snap.isDay
            : null,
      screenOpen: snap.screenOpen === true,
      inventory,
      hostiles: (snap.hostiles || []).slice(0, 8).map((hostile) => ({
        name: String(hostile.name || ''),
        distance: hostile.distance
      })),
      observedAt: snap.observedAt || null,
      freshness: body && typeof body.freshness === 'function' ? body.freshness() : null
    };
  }

  async _submitTask(args = {}) {
    if (!this.brain || typeof this.brain.submitExternalTask !== 'function') {
      return { ok: false, reason: 'no-task-host' };
    }
    const type = String(args.type || '').trim();
    if (!type) return { ok: false, reason: 'task-type-required' };
    return this.brain.submitExternalTask(
      { type, args: args.args && typeof args.args === 'object' ? args.args : {} },
      { source: 'code-skill' }
    );
  }

  async _chat(args = {}) {
    const text = String(args.text || '').trim();
    if (!text) return { ok: false, reason: 'text-required' };
    if (text.length > 100) return { ok: false, reason: 'text-too-long' };
    if (this.now() - this._chatAt < 1200) return { ok: false, reason: 'rate-limited' };
    if (typeof this.ctx.reply !== 'function' && !this.ctx.languageBrain) {
      return { ok: false, reason: 'no-reply-path' };
    }
    this._chatAt = this.now();
    /**
     * Unified language brain: even a code-skill report is player-facing speech, so it goes
     * through roleplay first instead of calling reply() directly.
     */
    if (this.ctx.languageBrain) {
      const result = await this.ctx.languageBrain.handle({
        text,
        source: 'code-skill',
        kind: 'action-output',
        profile: 'roleplay'
      });
      return { ok: result && result.spoke === true, spoke: result && result.spoke === true, via: 'language-brain' };
    }
    const spoke = await this.ctx.reply(text, { conversation: true, why: 'code-skill' });
    return { ok: spoke === true, spoke: spoke === true };
  }

  async _search(args = {}) {
    if (!this.search || typeof this.search.search !== 'function') {
      return { ok: false, reason: 'search-unavailable' };
    }
    const query = String(args.query || '').trim();
    if (!query) return { ok: false, reason: 'query-required' };
    if (query.length > 128) return { ok: false, reason: 'query-too-long' };
    return this.search.search(query, {
      count: Math.min(Math.max(Number(args.count) || 5, 1), 10),
      needContent: args.needContent === true,
      oriQuestion: args.oriQuestion
    });
  }

  async _generateFromSandbox(args = {}, context = {}) {
    const runId = context.runId || 'sandbox';
    const used = this._runGeneration.get(runId) || 0;
    if (used >= this.maxGeneratePerRun) return { ok: false, reason: 'generation-budget-exhausted' };
    this._runGeneration.set(runId, used + 1);
    return this.generateCandidate({
      prompt: args.prompt,
      manifest: args.manifest || null,
      source: 'sandbox-generated'
    });
  }

  /**
   * Controlled subprocess: only a Node script inside the run's sandbox dir, no shell, with
   * the same permission flags and a hard 10s cap. The script's stdout/stderr are capped.
   */
  async _subprocess(args = {}, context = {}) {
    const sandboxDir = context && context.sandboxDir ? path.resolve(context.sandboxDir) : null;
    if (!sandboxDir || !fs.existsSync(sandboxDir)) return { ok: false, reason: 'no-sandbox-dir' };
    const code = String(args.code || '');
    if (!code.trim()) return { ok: false, reason: 'code-required' };
    if (Buffer.byteLength(code) > 32 * 1024) return { ok: false, reason: 'code-too-large' };
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 5000, 100), MAX_SUBPROCESS_MS);
    const scriptPath = path.join(sandboxDir, `sub-${Date.now()}-${Math.floor(Math.random() * 1e6)}.js`);
    if (!path.resolve(scriptPath).startsWith(`${sandboxDir}${path.sep}`)) return { ok: false, reason: 'script-escape' };
    fs.writeFileSync(scriptPath, code);
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(
        process.execPath,
        [
          '--permission',
          `--allow-fs-read=${sandboxDir}`,
          '--max-old-space-size=128',
          '--no-warnings',
          scriptPath
        ],
        {
          cwd: sandboxDir,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        }
      );
      let onAbort = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (onAbort && context.signal && typeof context.signal.removeEventListener === 'function') {
          context.signal.removeEventListener('abort', onAbort);
        }
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout', stdout, stderr }), timeoutMs);
      if (context.signal) {
        onAbort = () => finish({ ok: false, cancelled: true, reason: 'cancelled', stdout, stderr });
        if (context.signal.aborted) onAbort();
        else if (typeof context.signal.addEventListener === 'function') {
          context.signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      child.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_SUBPROCESS_OUTPUT) stdout += chunk.toString().slice(0, MAX_SUBPROCESS_OUTPUT - stdout.length);
      });
      child.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_SUBPROCESS_OUTPUT) stderr += chunk.toString().slice(0, MAX_SUBPROCESS_OUTPUT - stderr.length);
      });
      child.on('error', (err) => finish({ ok: false, reason: `spawn-error: ${err.message}`, stdout, stderr }));
      child.on('exit', (exitCode, signal) => {
        finish({ ok: exitCode === 0, exitCode, signal, stdout, stderr });
      });
    });
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      this.store.restore(data);
    } catch {
      /* first run or unreadable metadata: start empty; directory files remain inspectable */
    }
  }

  _save() {
    try {
      atomicWrite(this.storeFile, `${JSON.stringify(this.store.toJSON(), null, 2)}\n`);
    } catch (err) {
      this.log.warn(`code-skill store save failed: ${err.message}`);
    }
  }
}

module.exports = { CodeSkillService, summarizeRun, ALLOWED_PERMISSIONS };
