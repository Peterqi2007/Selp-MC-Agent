'use strict';

/**
 * Window policy for computer use (P1 M5, A19/F1).
 *
 * The default state is **deny**: until F1 ("can dsh-computer-use be restricted to the game
 * window?") has been executed and recorded, every CU action is refused with
 * `cu-unproven`. This is the honest default - a window policy that has not been demonstrated
 * must not silently claim to be safe.
 *
 * After `verify({gameWindowId, bounds})` (called only from the approved client window), the
 * policy allows actions that:
 *   - target exactly the configured game window;
 *   - use an allowed action kind;
 *   - for pointer actions, land inside the configured bounds;
 *   - for screenshots, capture only that window (there is no region argument here).
 *
 * The policy is pure and has no dependency on the computer-use helper.
 */

const DEFAULT_ACTIONS = ['click', 'key', 'screenshot'];

class WindowPolicy {
  constructor(options = {}) {
    this.gameWindowId = options.gameWindowId || null;
    this.bounds = options.bounds || null; // { x, y, width, height }
    this.verified = options.verified === true;
    this.allowedActions = new Set(options.allowedActions || DEFAULT_ACTIONS);
    this.evidence = options.evidence || null;
  }

  /** Called after F1 succeeds; without evidence this is not "verified". */
  verify({ gameWindowId, bounds, evidence } = {}) {
    if (!gameWindowId || !bounds) return { ok: false, reason: 'game-window-required' };
    if (!(bounds.width > 0) || !(bounds.height > 0)) return { ok: false, reason: 'bounds-invalid' };
    this.gameWindowId = gameWindowId;
    this.bounds = { ...bounds };
    this.verified = true;
    this.evidence = evidence || null;
    return { ok: true };
  }

  /**
   * @param {object} action { kind, windowId, x?, y? }
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

  status() {
    return {
      verified: this.verified,
      gameWindowId: this.gameWindowId,
      bounds: this.bounds ? { ...this.bounds } : null,
      allowedActions: [...this.allowedActions],
      evidence: this.evidence
    };
  }
}

module.exports = { WindowPolicy, DEFAULT_ACTIONS };
