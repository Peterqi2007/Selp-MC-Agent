'use strict';

/**
 * ABANDONED (2026-10-29): the OS-level computer_use path was abandoned in favour of the
 * in-process Minecraft input layer (see docs/CU-ABANDONED.md). This module is kept only as
 * historical evidence and is not a delivery path; do not wire it into the action brain.
 */

/**
 * Window policy for computer use (P1 M5, A19/F1).
 *
 * The default state is **deny**: until F1 ("can dsh-computer-use be restricted to the game
 * window?") has been executed and recorded, every **act** (click/key) is refused with
 * `cu-unproven`. A window policy that has not been demonstrated must not silently claim safety.
 *
 * "Read" and "do" are separate gates, because they are separate risks:
 *
 *   - `check()`        - acts. Denied until `verify()` has accepted real F1 evidence.
 *   - `checkObserve()` - read-only observation (`state` / `screenshot`). Allowed before F1 **only**
 *                        for the unique candidate Minecraft window, with an explicit `windowId`
 *                        and no interaction fields. This exception exists so F1 *can* be measured;
 *                        it is not `verify()` and it grants no act.
 *
 * `verify()` accepts only F1 evidence: a successful screenshot **and** a rect from a real
 * geometry source. Rect may never be inferred from screenshot pixel size - `screenshot-size`
 * carries no position, so it is not an allowed source. This is what stops `verify()` from being
 * called early with made-up bounds.
 *
 * The policy is pure and has no dependency on the computer-use helper.
 */

const DEFAULT_ACTIONS = ['click', 'key', 'screenshot'];
/** Read-only kinds. `screenshot` appears in both lists: as an act it is gated, as an observation it is not. */
const OBSERVE_ACTIONS = ['observe', 'state', 'screenshot'];
/** Where a rect may come from. `screenshot-size` is deliberately absent. */
const RECT_SOURCES = ['helper', 'win32', 'dwm'];
/** A read-only observation must not carry any of these. */
const INTERACTION_FIELDS = ['x', 'y', 'button', 'key', 'text', 'click', 'keys'];

class WindowPolicy {
  constructor(options = {}) {
    this.gameWindowId = options.gameWindowId || null;
    this.bounds = options.bounds || null; // { x, y, width, height, source? }
    this.verified = options.verified === true;
    this.allowedActions = new Set(options.allowedActions || DEFAULT_ACTIONS);
    this.evidence = options.evidence || null;
    this.candidates = [...new Set((options.candidates || []).filter(Boolean))];
    this.readOnlyObservation = options.readOnlyObservation !== false;
  }

  /** Record the Minecraft window(s) the host currently sees. Observation needs exactly one. */
  setCandidates(ids = []) {
    this.candidates = [...new Set((ids || []).filter(Boolean))];
    return [...this.candidates];
  }

  /** The single candidate window id, or null when there is none / more than one. */
  candidateWindowId() {
    return this.candidates.length === 1 ? this.candidates[0] : null;
  }

  candidateStatus() {
    const unique = this.candidateWindowId();
    return {
      candidates: [...this.candidates],
      unique,
      reason: this.candidates.length === 0
        ? 'no-candidate'
        : this.candidates.length === 1 ? 'candidate-unique' : 'candidate-not-unique'
    };
  }

  /**
   * The only door to `verified`. Call it with real F1 evidence - never from a guess.
   *
   * @param {object} input { gameWindowId, bounds, evidence }
   *   evidence: { windowId, screenshot: { ok, width, height }, boundsSource }
   * @returns {{ok:boolean, reason:string}}
   */
  verify({ gameWindowId, bounds, evidence } = {}) {
    const ev = evidence || {};
    const target = gameWindowId || ev.windowId;
    if (!target || !bounds) return { ok: false, reason: 'game-window-required' };
    if (this.candidates.length && !this.candidates.includes(target)) {
      return { ok: false, reason: 'window-mismatch' };
    }
    if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return { ok: false, reason: 'bounds-invalid' };
    if (!(bounds.width > 0) || !(bounds.height > 0)) return { ok: false, reason: 'bounds-invalid' };

    // F1 needs a screenshot that actually came back; a failed capture proves nothing.
    const shot = ev.screenshot;
    if (!shot || shot.ok !== true || !(shot.width > 0) || !(shot.height > 0)) {
      return { ok: false, reason: 'screenshot-required' };
    }

    // ...and a position that came from real geometry, not from pixels.
    const source = ev.boundsSource || bounds.source;
    if (!RECT_SOURCES.includes(source)) return { ok: false, reason: 'bounds-source-invalid' };
    if (ev.windowId && gameWindowId && ev.windowId !== gameWindowId) {
      return { ok: false, reason: 'window-mismatch' };
    }

    this.gameWindowId = target;
    this.bounds = { ...bounds, source };
    this.verified = true;
    this.evidence = { ...ev, boundsSource: source };
    return { ok: true };
  }

  /**
   * Guards acts. @param {object} action { kind, windowId, x?, y? }
   * @returns {{ok:boolean, reason:string}}
   */
  check(action = {}) {
    if (!this.verified) return { ok: false, reason: 'cu-unproven' };
    if (!action || !action.kind) return { ok: false, reason: 'action-required' };
    if (!this.allowedActions.has(action.kind)) return { ok: false, reason: 'action-not-allowed' };
    if (!this.gameWindowId || action.windowId !== this.gameWindowId) {
      return { ok: false, reason: 'outside-window' };
    }
    if (action.kind === 'screenshot') return { ok: true, reason: 'window-screenshot' };
    if (action.kind === 'key') return { ok: true, reason: 'window-key' };
    if (!this.bounds) return { ok: false, reason: 'bounds-required' };
    const { x, y } = action;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, reason: 'coordinates-required' };
    const inside =
      x >= this.bounds.x &&
      x <= this.bounds.x + this.bounds.width &&
      y >= this.bounds.y &&
      y <= this.bounds.y + this.bounds.height;
    return inside ? { ok: true, reason: 'inside-window' } : { ok: false, reason: 'outside-bounds' };
  }

  /**
   * Guards read-only observation. This is the F1 measurement window, not a backdoor:
   * pre-F1 it admits exactly one window (the unique candidate), only for reads, and never
   * for anything carrying input.
   *
   * @param {object} action { kind, windowId }
   * @returns {{ok:boolean, reason:string}}
   */
  checkObserve(action = {}) {
    if (!this.readOnlyObservation) return { ok: false, reason: 'observation-disabled' };
    if (!action || !action.kind) return { ok: false, reason: 'action-required' };
    if (!OBSERVE_ACTIONS.includes(action.kind)) return { ok: false, reason: 'kind-not-allowed' };

    const touching = INTERACTION_FIELDS.filter((field) => action[field] !== undefined);
    if (touching.length) return { ok: false, reason: 'interaction-not-allowed' };

    if (!action.windowId) return { ok: false, reason: 'observe-window-required' };

    if (this.verified) {
      if (action.windowId !== this.gameWindowId) return { ok: false, reason: 'outside-window' };
      return { ok: true, reason: 'verified-window-observe' };
    }

    const unique = this.candidateWindowId();
    if (!unique) return { ok: false, reason: 'candidate-not-unique' };
    if (action.windowId !== unique) return { ok: false, reason: 'not-candidate-window' };
    return { ok: true, reason: 'candidate-observe' };
  }

  status() {
    return {
      verified: this.verified,
      gameWindowId: this.gameWindowId,
      bounds: this.bounds ? { ...this.bounds } : null,
      allowedActions: [...this.allowedActions],
      evidence: this.evidence,
      candidates: [...this.candidates],
      candidate: this.candidateStatus(),
      readOnlyObservation: this.readOnlyObservation
    };
  }
}

module.exports = { WindowPolicy, DEFAULT_ACTIONS, OBSERVE_ACTIONS, RECT_SOURCES };
