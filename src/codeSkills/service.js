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
const { BODY_PERMISSIONS } = require('./capabilities');
const { SandboxRunner } = require('./sandboxRunner');
const { ClientModBody } = require('../body/clientModBody');

const MAX_SUBPROCESS_MS = 10000;
const MAX_SUBPROCESS_OUTPUT = 16 * 1024;
/** Direct-body limits (M4 v2, 2026-10-25). */
const BODY_LIMITS = {
  moveDistance: 64,
  moveTimeoutMs: 30000,
  digDistance: 5,
  digTimeoutMs: 15000,
  useDistance: 5,
  useTimeoutMs: 6000,
  clickTimeoutMs: 6000,
  lookTimeoutMs: 1500,
  attackDistance: 6,
  attackTimeoutMs: 12000
};

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
    /**
     * A19 live 2026-10-25: a hard-killed host leaves its throwaway `run-*` sandbox behind
     * (the parent is the only cleaner). The child does die on IPC disconnect, but the
     * directory cannot remove itself. Sweep stale run dirs once at startup; never touch
     * anything that is not a `run-*` dir.
     */
    this._sweepStaleSandbox();
    this._load();
  }

  _sweepStaleSandbox() {
    const root = this.sandbox && this.sandbox.sandboxRoot;
    if (!root) return 0;
    let removed = 0;
    try {
      if (!fs.existsSync(root)) return 0;
      for (const name of fs.readdirSync(root)) {
        if (!/^run-/.test(name)) continue;
        try {
          fs.rmSync(path.join(root, name), { recursive: true, force: true });
          removed += 1;
        } catch {
          /* a locked dir is left for the next start */
        }
      }
    } catch {
      return removed;
    }
    if (removed > 0) this.log.info(`code skills: removed ${removed} stale sandbox dir(s) from an interrupted run`);
    return removed;
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
     * Direct-body trials must be the only body owner. A live agent task holds the slot; an
     * HTTP trial takes it for the duration and fails honestly with `body-busy` instead of
     * moving/digging behind another executor.
     */
    const needsBody = (onDisk.manifest.permissions || []).some((permission) => BODY_PERMISSIONS.has(permission));
    let lease = null;
    if (needsBody) {
      lease = this._acquireBodyLease(`${name}@${version}`);
      if (!lease.ok) return { ok: false, name, version, reason: lease.reason, current: lease.current || null };
    }

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
      if (lease) this._releaseBodyLease(lease);
      if (run && (run.cancelled === true || run.timeout === true)) this._interruptBody('code-skill trial ended');
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
    /**
     * Live dispatch runs inside CodeSkillTask, which already owns the TaskSlot (slotHeld).
     * A direct HTTP `/code-skills/<name>/run` is outside that task, so it takes the slot
     * itself and refuses with `body-busy` when someone else owns the body.
     */
    const needsBody = (onDisk.manifest.permissions || []).some((permission) => BODY_PERMISSIONS.has(permission));
    const slotHeld = options.slotHeld === true;
    let lease = null;
    if (needsBody && !slotHeld) {
      lease = this._acquireBodyLease(`${name}@${pointer.version}`);
      if (!lease.ok) return { ok: false, name, version: pointer.version, reason: lease.reason, current: lease.current || null };
    }
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
      if (lease) this._releaseBodyLease(lease);
      if (run && (run.cancelled === true || run.timeout === true)) this._interruptBody('code-skill run ended');
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
      read_state: async (args) => {
        if (args && args.includeMenu === true) await this._refreshBody();
        const state = this._readState(args);
        if (args && args.includeMenu === true && state.ok === true) state.menu = await this._menuSummary();
        return state;
      },
      block_at: async (args) => this._bodyBlockAt(args),
      find_blocks: async (args) => this._bodyFindBlocks(args),
      submit_task: async (args) => this._submitTask(args),
      chat: async (args) => this._chat(args),
      search: async (args) => this._search(args),
      generate: async (args) => this._generateFromSandbox(args),
      subprocess: async (args, context) => this._subprocess(args, context),
      body_move: async (args, context) => this._bodyMove(args, context),
      body_dig: async (args, context) => this._bodyDig(args, context),
      body_place: async (args, context) => this._bodyPlace(args, context),
      body_use: async (args, context) => this._bodyUse(args, context),
      body_click: async (args, context) => this._bodyClick(args, context),
      body_look: async (args, context) => this._bodyLook(args, context),
      body_look_at: async (args, context) => this._bodyLookAt(args, context),
      body_attack: async (args, context) => this._bodyAttack(args, context)
    };
  }

  _slotRef() {
    return (this.ctx && this.ctx.slot) || (this.brain && this.brain.slot) || null;
  }

  /** Take the single body owner for a direct-body run; refuse (never queue) when busy. */
  _acquireBodyLease(key) {
    const slot = this._slotRef();
    if (!slot || typeof slot.acquire !== 'function') return { ok: false, reason: 'no-task-slot' };
    const acquired = slot.acquire({ kind: 'code_skill', id: key, note: `code skill ${key}`, holdsBody: true });
    if (!acquired || acquired.ok !== true) {
      const current = acquired && acquired.current ? acquired.current : null;
      return {
        ok: false,
        reason: 'body-busy',
        current: current ? { kind: current.kind, id: current.id || null, note: current.note || null } : null
      };
    }
    return { ok: true, slot, owner: acquired.owner };
  }

  _releaseBodyLease(lease) {
    try {
      if (lease && lease.slot && lease.owner) lease.slot.release(lease.owner);
    } catch {
      /* released elsewhere */
    }
  }

  _interruptBody(reason) {
    const body = this.ctx.body;
    try {
      if (body && typeof body.interrupt === 'function') body.interrupt(reason);
    } catch {
      /* best-effort */
    }
  }

  _readState(args = {}) {
    const body = this.ctx.body;
    const snap = body && typeof body.snapshot === 'function' ? body.snapshot() : null;
    if (!snap) return { ok: false, reason: 'no-live-state' };
    const opts = args && typeof args === 'object' ? args : {};
    const inventory = {};
    if (opts.includeInventory !== false) {
      for (const [name, count] of Object.entries(snap.inventory || {})) {
        if (!name || !Number.isFinite(Number(count)) || Number(count) <= 0) continue;
        inventory[String(name).replace(/^minecraft:/, '')] = Number(count);
      }
    }
    const state = {
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
      screen: snap.screen || null,
      mouseGrabbed: snap.mouseGrabbed !== false,
      dead: snap.dead === true,
      heldItem: snap.heldItem || null,
      weather: snap.weather || null,
      lightLevel: snap.lightLevel,
      blockLight: snap.blockLight,
      emptySlots: snap.emptySlots,
      inventory,
      hostiles: (snap.hostiles || []).slice(0, 8).map((hostile) => ({
        id: hostile.id,
        name: String(hostile.name || ''),
        position: hostile.position || null,
        distance: hostile.distance
      })),
      observedAt: snap.observedAt || null,
      freshness: body && typeof body.freshness === 'function' ? body.freshness() : null
    };
    if (opts.includePlayers === true) {
      state.players = (snap.players || []).slice(0, 16).map((player) => ({
        name: String(player.name || ''),
        distance: player.distance
      }));
    }
    if (opts.includeCrops === true) {
      state.crops = (snap.crops || []).slice(0, 32).map((crop) => ({
        name: String(crop.name || crop.block || ''),
        position: crop.position || null,
        age: crop.age === undefined ? null : crop.age,
        mature: crop.mature === undefined ? null : crop.mature === true
      }));
    }
    if (opts.includeItems === true) {
      state.items = (snap.nearbyItems || []).slice(0, 16).map((item) => ({
        name: String(item.name || item.item || ''),
        count: item.count,
        distance: item.distance
      }));
    }
    if (opts.blocks && typeof opts.blocks === 'object') {
      state.blocks = this._blockWindow(snap, opts.blocks);
    }
    return state;
  }

  /** Bounded /state block projection: a small palette + relative cells, never the 63k map. */
  _blockWindow(snap, spec = {}) {
    const cells = snap.blocks && snap.blocks.cells;
    if (!cells || !snap.position) return { palette: [], cells: [], truncated: false, count: 0 };
    const radiusXZ = Math.min(Math.max(Number(spec.radiusXZ) || 8, 1), 16);
    const radiusY = Math.min(Math.max(Number(spec.radiusY) || 4, 1), 8);
    const limit = Math.min(Math.max(Number(spec.limit) || 2000, 1), 4000);
    const origin = snap.position;
    const palette = [];
    const index = new Map();
    const out = [];
    for (const [key, name] of Object.entries(cells)) {
      if (out.length >= limit) break;
      const [x, y, z] = key.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const dx = x - Math.floor(origin.x);
      const dy = y - Math.floor(origin.y);
      const dz = z - Math.floor(origin.z);
      if (Math.abs(dx) > radiusXZ || Math.abs(dz) > radiusXZ || Math.abs(dy) > radiusY) continue;
      let paletteIndex = index.get(name);
      if (paletteIndex === undefined) {
        paletteIndex = palette.length;
        palette.push(name);
        index.set(name, paletteIndex);
      }
      out.push([dx, dy, dz, paletteIndex]);
    }
    let truncated = out.length >= limit;
    const build = () => ({ palette, cells: out, count: out.length, truncated, origin: { x: Math.floor(origin.x), y: Math.floor(origin.y), z: Math.floor(origin.z) } });
    let value = build();
    /** Keep the RPC result well under the runner's 32KB cap. */
    while (Buffer.byteLength(JSON.stringify(value)) > 24000 && out.length > 1) {
      out.length = Math.floor(out.length / 2);
      truncated = true;
      value = build();
    }
    return value;
  }

  async _menuSummary() {
    const body = this.ctx.body;
    if (!body || typeof body.menu !== 'function') return null;
    const menu = await body.menu().catch(() => null);
    if (!menu || menu.open !== true) return null;
    return {
      open: true,
      size: menu.size,
      screen: menu.screen || menu.menuClass || null,
      slots: (menu.slots || []).slice(0, 46).map((slot) => ({
        i: slot.i,
        item: slot.item && slot.item !== 'null' ? slot.item : null,
        count: slot.count
      }))
    };
  }

  /**
   * The body caches /state between perception ticks. A code skill that opens a container
   * and immediately clicks needs the screen fields to be current, so screen-dependent
   * host calls force one refresh. Offline/mock bodies without refresh() are unaffected.
   */
  async _refreshBody() {
    const body = this.ctx.body;
    if (body && typeof body.refresh === 'function') {
      try {
        await body.refresh(true);
      } catch {
        /* keep the cached snapshot */
      }
    }
  }

  // ------------------------------------------------------- direct body primitives

  _bodyReady() {
    const body = this.ctx.body;
    const snap = body && typeof body.snapshot === 'function' ? body.snapshot() : null;
    if (!snap) return { ok: false, reason: 'no-live-state' };
    if (snap.ready !== true) return { ok: false, reason: 'body-not-ready' };
    return { ok: true, body, snap };
  }

  _positionArg(args = {}, name = 'position') {
    const raw = args[name] || (args.x !== undefined ? args : null);
    if (!raw || typeof raw !== 'object') return null;
    const x = Number(raw.x);
    const y = Number(raw.y);
    const z = Number(raw.z);
    if (![x, y, z].every((n) => Number.isFinite(n))) return null;
    return { x, y, z };
  }

  _distance(a, b) {
    if (!a || !b) return Infinity;
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  _blockNameAt(snap, position) {
    const body = this.ctx.body;
    if (body && typeof body.blockAt === 'function') {
      const block = body.blockAt(position);
      return block && block.name ? block.name : null;
    }
    const cells = snap.blocks && snap.blocks.cells;
    if (!cells) return null;
    return cells[`${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`] || null;
  }

  /**
   * Run one body call with abort/timeout and a guaranteed interrupt. Cancelling the
   * sandbox must stop the physical action too; a killed child alone does not release a
   * held forward key or a pending dig.
   */
  _bodyCall(fn, context, timeoutMs) {
    const body = this.ctx.body;
    const signal = context && context.signal;
    if (signal && signal.aborted) return Promise.resolve({ ok: false, reason: 'cancelled', cancelled: true });
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      let onAbort = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (onAbort && signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
        resolve(value);
      };
      const interrupt = (reason) => {
        try {
          if (body && typeof body.interrupt === 'function') body.interrupt(reason);
        } catch {
          /* best-effort */
        }
      };
      timer = setTimeout(() => {
        interrupt('code-skill timeout');
        finish({ ok: false, reason: 'timeout' });
      }, timeoutMs);
      if (timer.unref) timer.unref();
      if (signal && typeof signal.addEventListener === 'function') {
        onAbort = () => {
          interrupt('code-skill cancelled');
          finish({ ok: false, reason: 'cancelled', cancelled: true });
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      Promise.resolve()
        .then(() => fn())
        .then((value) => finish(value), (err) => finish({ ok: false, reason: err && err.message ? String(err.message) : String(err) }));
    });
  }

  async _bodyBlockAt(args = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const position = this._positionArg(args);
    if (!position) return { ok: false, reason: 'position-required' };
    const name = this._blockNameAt(ready.snap, position);
    return name ? { ok: true, name, position } : { ok: false, reason: 'block-not-loaded', position };
  }

  async _bodyFindBlocks(args = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const names = (Array.isArray(args.names) ? args.names : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean)
      .slice(0, 8);
    if (!names.length) return { ok: false, reason: 'names-required' };
    const maxDistance = Math.min(Math.max(Number(args.maxDistance) || 16, 1), 32);
    const count = Math.min(Math.max(Number(args.count) || 16, 1), 32);
    const body = this.ctx.body;
    const found =
      typeof body.findBlocks === 'function'
        ? body.findBlocks(names, { maxDistance, count })
        : typeof body.findBlocksMatching === 'function'
          ? body.findBlocksMatching((name) => names.some((wanted) => name === wanted || name.endsWith(`:${wanted.split(':').pop()}`)), { maxDistance, count })
          : [];
    return { ok: true, blocks: (found || []).slice(0, count) };
  }

  async _bodyMove(args = {}, context = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const position = this._positionArg(args);
    if (!position) return { ok: false, reason: 'position-required' };
    const distance = this._distance(ready.snap.position, position);
    if (distance > BODY_LIMITS.moveDistance) {
      return { ok: false, reason: 'target-too-far', distance: Math.round(distance), limit: BODY_LIMITS.moveDistance };
    }
    const range = Math.min(Math.max(Number(args.range) || 1, 0), 4);
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 20000, 500), BODY_LIMITS.moveTimeoutMs);
    const body = this.ctx.body;
    if (typeof body.moveTo !== 'function') return { ok: false, reason: 'body-cannot-move' };
    const result = await this._bodyCall(() => body.moveTo(position, { range, timeoutMs }), context, timeoutMs + 2000);
    if (result.ok === false) return result;
    const after = body.snapshot();
    return {
      ok: result === true,
      position: after && after.position ? { ...after.position } : null,
      reason: result === true ? null : 'move-failed'
    };
  }

  async _bodyDig(args = {}, context = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const position = this._positionArg(args);
    if (!position) return { ok: false, reason: 'position-required' };
    const distance = this._distance(ready.snap.position, position);
    if (distance > BODY_LIMITS.digDistance) {
      return { ok: false, reason: 'target-too-far', distance: Math.round(distance), limit: BODY_LIMITS.digDistance };
    }
    const name = this._blockNameAt(ready.snap, position);
    if (!name) return { ok: false, reason: 'block-not-loaded', position };
    const body = this.ctx.body;
    if (typeof body.dig !== 'function') return { ok: false, reason: 'body-cannot-dig' };
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 12000, 500), BODY_LIMITS.digTimeoutMs);
    const result = await this._bodyCall(() => body.dig({ name, position }, { timeoutMs }), context, timeoutMs + 3000);
    if (result.ok === false) return result;
    const reason = result === true ? null : (body.lastRefusal && body.lastRefusal.reason) || 'dig-failed';
    return { ok: result === true, block: name, position, reason };
  }

  async _bodyPlace(args = {}, context = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const position = this._positionArg(args, 'reference') || this._positionArg(args);
    if (!position) return { ok: false, reason: 'reference-required' };
    const item = String(args.item || '').trim();
    if (!item) return { ok: false, reason: 'item-required' };
    const distance = this._distance(ready.snap.position, position);
    if (distance > BODY_LIMITS.useDistance) {
      return { ok: false, reason: 'target-too-far', distance: Math.round(distance), limit: BODY_LIMITS.useDistance };
    }
    const referenceName = this._blockNameAt(ready.snap, position);
    if (!referenceName) return { ok: false, reason: 'block-not-loaded', position };
    const face = args.face && typeof args.face === 'object' ? args.face : { x: 0, y: 1, z: 0 };
    const body = this.ctx.body;
    if (typeof body.place !== 'function') return { ok: false, reason: 'body-cannot-place' };
    const result = await this._bodyCall(
      () => body.place(item, { name: referenceName, position }, face),
      context,
      BODY_LIMITS.useTimeoutMs
    );
    if (result.ok === false) return result;
    return { ok: result === true, item, position, reference: referenceName, reason: result === true ? null : 'place-failed' };
  }

  async _bodyUse(args = {}, context = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const position = this._positionArg(args);
    if (!position) return { ok: false, reason: 'position-required' };
    const distance = this._distance(ready.snap.position, position);
    if (distance > BODY_LIMITS.useDistance) {
      return { ok: false, reason: 'target-too-far', distance: Math.round(distance), limit: BODY_LIMITS.useDistance };
    }
    const name = this._blockNameAt(ready.snap, position);
    if (!name) return { ok: false, reason: 'block-not-loaded', position };
    const face = args.face && typeof args.face === 'object' ? args.face : { x: 0, y: 1, z: 0 };
    const item = args.item ? String(args.item) : null;
    const body = this.ctx.body;
    if (typeof body.useOn !== 'function') return { ok: false, reason: 'body-cannot-use' };
    const result = await this._bodyCall(async () => {
      /** The plan allows `item`: equip it first (e.g. hoe/seeds/bucket), then use. */
      if (item && typeof body.equip === 'function') {
        const equipped = await body.equip(item);
        if (!equipped) return false;
      }
      return body.useOn(position, { face });
    }, context, BODY_LIMITS.useTimeoutMs);
    if (result.ok === false) return result;
    if (result === true) await this._refreshBody();
    return { ok: result === true, block: name, position, item, reason: result === true ? null : 'use-failed' };
  }

  async _bodyClick(args = {}, context = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const body = this.ctx.body;
    let snap = ready.snap;
    if (!snap.screenOpen) {
      await this._refreshBody();
      const fresh = typeof body.snapshot === 'function' ? body.snapshot() : null;
      if (fresh && fresh.ready === true) snap = fresh;
    }
    const screen = snap.screen || null;
    if (!snap.screenOpen) return { ok: false, reason: 'no-screen' };
    if (!ClientModBody.isContainerScreen(screen)) return { ok: false, reason: 'operator-screen', screen };
    const slot = Number(args.slot);
    if (!Number.isInteger(slot) || slot < 0) return { ok: false, reason: 'slot-invalid' };
    if (typeof body.menu !== 'function' || typeof body.clickSlot !== 'function') {
      return { ok: false, reason: 'body-cannot-click' };
    }
    const menu = await body.menu().catch(() => null);
    if (!menu || menu.open !== true) return { ok: false, reason: 'no-menu', screen };
    if (Number.isFinite(Number(menu.size)) && slot >= Number(menu.size)) {
      return { ok: false, reason: 'slot-out-of-range', slot, size: Number(menu.size) };
    }
    const button = args.button === 1 ? 1 : 0;
    const result = await this._bodyCall(() => body.clickSlot(slot, { button }), context, BODY_LIMITS.clickTimeoutMs);
    if (result.ok === false) return result;
    return { ok: result === true, slot, screen, reason: result === true ? null : 'click-failed' };
  }

  async _bodyLook(args = {}, context = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const yaw = Number(args.yaw);
    const pitch = Number(args.pitch);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return { ok: false, reason: 'yaw-pitch-required' };
    const body = this.ctx.body;
    if (typeof body.look !== 'function') return { ok: false, reason: 'body-cannot-look' };
    const result = await this._bodyCall(() => body.look(yaw, pitch), context, BODY_LIMITS.lookTimeoutMs);
    if (result.ok === false) return result;
    return { ok: result === true, yaw, pitch, reason: result === true ? null : 'look-failed' };
  }

  async _bodyLookAt(args = {}, context = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const position = this._positionArg(args);
    if (!position) return { ok: false, reason: 'position-required' };
    const body = this.ctx.body;
    if (typeof body.lookAt !== 'function') return { ok: false, reason: 'body-cannot-look' };
    const result = await this._bodyCall(() => body.lookAt(position), context, BODY_LIMITS.lookTimeoutMs);
    if (result.ok === false) return result;
    return { ok: result === true, position, reason: result === true ? null : 'look-failed' };
  }

  async _bodyAttack(args = {}, context = {}) {
    const ready = this._bodyReady();
    if (!ready.ok) return ready;
    const wantedId = args.entityId === undefined ? null : args.entityId;
    const wantedName = args.name ? String(args.name) : null;
    if (wantedId === null && !wantedName) return { ok: false, reason: 'target-required' };
    const hostiles = ready.snap.hostiles || [];
    const target = hostiles.find((hostile) => {
      if (wantedId !== null && String(hostile.id) === String(wantedId)) return true;
      return wantedName !== null && String(hostile.name || '') === wantedName;
    });
    if (!target) return { ok: false, reason: 'not-hostile' };
    if (Number.isFinite(target.distance) && target.distance > BODY_LIMITS.attackDistance) {
      return { ok: false, reason: 'target-too-far', distance: target.distance, limit: BODY_LIMITS.attackDistance };
    }
    const body = this.ctx.body;
    if (typeof body.attack !== 'function') return { ok: false, reason: 'body-cannot-attack' };
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || 8000, 500), BODY_LIMITS.attackTimeoutMs);
    const result = await this._bodyCall(
      () => body.attack({ id: target.id, name: target.name, position: target.position }, { timeoutMs }),
      context,
      timeoutMs + 2000
    );
    if (result.ok === false) return result;
    return { ok: result === true, name: target.name, reason: result === true ? null : 'attack-failed' };
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
    const guardPath = path.join(__dirname, 'subprocessGuard.js');
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn(
        process.execPath,
        [
          '--permission',
          `--allow-fs-read=${sandboxDir}`,
          `--allow-fs-read=${guardPath}`,
          '--max-old-space-size=128',
          '--no-warnings',
          '--require',
          guardPath,
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
