/**
 * M5/F1 local gate for dsh-computer-use.
 *
 * This file is a profile-local adapter, not part of the upstream bundle. It is intentionally
 * dependency-free so it can be loaded by the generated lib/index.js.
 *
 * Policy:
 *   - Until a Minecraft window has been enumerated, the guard is inactive and normal
 *     computer-use behavior is unchanged.
 *   - Once computer_use_apps sees Minecraft window(s), the guard locks observation to the
 *     unique candidate and refuses every other window.
 *   - Acts are always denied until a real F1 policy file exists. The policy file is written
 *     only after F1 evidence (screenshot + real geometry source) exists.
 *
 * The file is read on each decision; deleting it immediately returns acts to default-deny.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POLICY_FILE =
  process.env.DSH_CU_POLICY_FILE ||
  path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cu-f1-policy.json');
const TITLE = /minecraft/i;
const JAVA = /(?:^|[\\/])(java|javaw)\.exe$/i;
const RECT_SOURCES = new Set(['helper', 'win32', 'dwm']);
const COORD_ACTIONS = new Set(['click', 'scroll', 'drag']);

function isMinecraftWindow(window) {
  if (!window || typeof window !== 'object') return false;
  const app = String(window.app || '');
  const title = String(window.title || '');
  return JAVA.test(app) && TITLE.test(title);
}

function validRect(bounds) {
  return (
    bounds &&
    typeof bounds === 'object' &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(bounds[key]))) &&
    Number(bounds.width) > 0 &&
    Number(bounds.height) > 0
  );
}

function validPolicy(value) {
  if (!value || typeof value !== 'object') return null;
  const id = Number(value.gameWindowId);
  if (!Number.isFinite(id) || id <= 0) return null;
  if (!validRect(value.bounds)) return null;
  const evidence = value.evidence && typeof value.evidence === 'object' ? value.evidence : {};
  const shot = evidence.screenshot;
  if (!shot || shot.ok !== true || !(Number(shot.width) > 0) || !(Number(shot.height) > 0)) return null;
  if (!RECT_SOURCES.has(evidence.boundsSource)) return null;
  return {
    gameWindowId: id,
    bounds: {
      x: Number(value.bounds.x),
      y: Number(value.bounds.y),
      width: Number(value.bounds.width),
      height: Number(value.bounds.height),
    },
    evidence: { ...evidence, boundsSource: evidence.boundsSource },
  };
}

class CuGuard {
  constructor() {
    this.candidates = [];
    this.policy = null;
    this.policyError = null;
    this.policyReadAt = 0;
    this.lastDecision = null;
  }

  setCandidates(windows = []) {
    const ids = [];
    for (const window of Array.isArray(windows) ? windows : []) {
      if (isMinecraftWindow(window) && !ids.includes(window.id)) ids.push(window.id);
    }
    this.candidates = ids;
    return this.status();
  }

  get active() {
    return this.candidates.length > 0 || this.policy !== null;
  }

  readPolicy(force = false) {
    const now = Date.now();
    if (!force && now - this.policyReadAt < 1000) return this.policy;
    this.policyReadAt = now;
    try {
      const raw = fs.readFileSync(POLICY_FILE, 'utf8');
      const parsed = validPolicy(JSON.parse(raw));
      if (!parsed) {
        this.policy = null;
        this.policyError = 'policy-invalid';
      } else {
        this.policy = parsed;
        this.policyError = null;
      }
    } catch (error) {
      this.policy = null;
      this.policyError = error && error.code === 'ENOENT' ? 'policy-missing' : 'policy-unreadable';
    }
    return this.policy;
  }

  checkObserve(window) {
    this.readPolicy();
    if (!this.active && JAVA.test(String((window && window.app) || ''))) {
      return { ok: false, reason: 'candidate-required' };
    }
    if (!this.active) return { ok: true, reason: 'guard-inactive' };
    if (!window || !Number.isFinite(Number(window.id))) {
      return { ok: false, reason: 'observe-window-required' };
    }
    if (this.policy) {
      return Number(window.id) === this.policy.gameWindowId
        ? { ok: true, reason: 'verified-window-observe' }
        : { ok: false, reason: 'outside-window' };
    }
    if (this.candidates.length === 0) return { ok: false, reason: 'no-candidate' };
    if (this.candidates.length !== 1) return { ok: false, reason: 'candidate-not-unique' };
    return Number(window.id) === this.candidates[0]
      ? { ok: true, reason: 'candidate-observe' }
      : { ok: false, reason: 'not-candidate-window' };
  }

  checkAct(action, args, window) {
    this.readPolicy();
    if (!this.active && JAVA.test(String((window && window.app) || ''))) {
      return { ok: false, reason: 'candidate-required' };
    }
    if (!this.active) return { ok: true, reason: 'guard-inactive' };
    const policy = this.policy;
    if (!policy) {
      return { ok: false, reason: 'cu-unproven', detail: this.policyError || 'policy-missing' };
    }
    if (!window || Number(window.id) !== policy.gameWindowId) {
      return { ok: false, reason: 'outside-window' };
    }
    if (!COORD_ACTIONS.has(action)) return { ok: true, reason: 'verified-window' };

    const bounds = policy.bounds;
    const inside = (x, y) =>
      Number.isFinite(Number(x)) &&
      Number.isFinite(Number(y)) &&
      Number(x) >= bounds.x &&
      Number(x) <= bounds.x + bounds.width &&
      Number(y) >= bounds.y &&
      Number(y) <= bounds.y + bounds.height;
    if (action === 'drag') {
      return inside(args.from_x, args.from_y) && inside(args.to_x, args.to_y)
        ? { ok: true, reason: 'inside-window' }
        : { ok: false, reason: 'outside-bounds' };
    }
    return inside(args.x, args.y) ? { ok: true, reason: 'inside-window' } : { ok: false, reason: 'outside-bounds' };
  }

  status() {
    this.readPolicy();
    return {
      active: this.active,
      candidates: [...this.candidates],
      verified: this.policy !== null,
      gameWindowId: this.policy ? this.policy.gameWindowId : null,
      bounds: this.policy ? { ...this.policy.bounds } : null,
      policyError: this.policyError,
      policyFile: POLICY_FILE,
    };
  }
}

export const cuGuard = new CuGuard();
