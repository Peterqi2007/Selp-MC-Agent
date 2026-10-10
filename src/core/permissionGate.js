'use strict';

/**
 * Permission gate: the two hands of the body go through one check before they touch the
 * world. Installed once at startup, so every skill and every task inherits it - the rules
 * cannot be bypassed by a code path that forgot to ask (`src/core/permissions.js` has the
 * rule table and the consent desk).
 *
 * The gate wraps three methods rather than adding checks inside skills on purpose: mining,
 * farming, building, chest work and the old task layer all end up in `dig` / `place` /
 * `useOn`, and a check written once here cannot drift from a check written in five skills.
 * It also records the blocks the agent placed itself, which powers the `self:placed` rule.
 */

function key(position) {
  return `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;
}

function faceOffset(position, face) {
  const f = face && typeof face === 'object' ? face : { x: 0, y: 1, z: 0 };
  const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);
  return { x: position.x + sign(f.x), y: position.y + sign(f.y), z: position.z + sign(f.z) };
}

function referencePosition(reference) {
  if (!reference) return null;
  return reference.position ? reference.position : reference;
}

/**
 * @param {object} body Body instance (its `dig`, `place` and `useOn` are patched in place)
 * @param {object} options { permissions, consent, log }
 * @returns {{installed:string[]}}
 */
function installPermissionGate(body, options = {}) {
  const { permissions, consent } = options;
  const log = options.log || { info() {}, warn() {}, debug() {} };
  /**
   * Identity of the work that is asking, supplied by the caller (brain task object or the
   * hub's current handle). A plain `!yes` is remembered for that same work only - numen's
   * rule ("允许的作用范围：本任务内，同一行规则问出来的同一种方块"): a mining task asks once
   * for grass_block, not once per block, and the next task asks again.
   */
  const taskScope = typeof options.taskScope === 'function' ? options.taskScope : () => null;
  if (!body || !permissions) return { installed: [] };

  const selfPlaced = new Set();
  /** `${action}:${name}` -> the task identity that was allowed once. */
  const allowances = new Map();
  const installed = [];

  const refuse = (action, target, verdict) => {
    const info = {
      action,
      name: target.name || null,
      position: target.position || null,
      reason: verdict && verdict.reason ? verdict.reason : 'refused',
      at: Date.now()
    };
    body.lastRefusal = info;
    log.warn(`permission: ${action} ${info.name || '?'} refused (${info.reason})`);
    return false;
  };

  /**
   * One authorisation pass: task-scoped allowance, explicit rules, consent desk.
   * Shared by the wrapped primitives and the single-hop pillar below.
   */
  const authorize = async (action, target) => {
    const allowanceKey = `${action}:${target.name || '*'}`;
    const scope = taskScope();
    const granted = allowances.get(allowanceKey);
    if (granted !== undefined && granted === scope && scope !== null) return { ok: true, target };
    if (granted !== undefined && granted !== scope) allowances.delete(allowanceKey);
    const verdict = permissions.check(action, target);
    if (verdict.verdict === 'deny') return { ok: false, target, reason: verdict.reason || 'refused' };
    if (verdict.verdict === 'ask') {
      const answer = await consent.ask({ action, target, reason: verdict.reason });
      if (answer === 'deny') return { ok: false, target, reason: 'operator did not allow it' };
      if (answer === 'always') permissions.addRule({ effect: 'allow', action, match: target.name || '*' });
      if (answer === 'allow' && scope !== null) allowances.set(allowanceKey, scope);
    }
    return { ok: true, target };
  };

  const wrap = (method, action, describe) => {
    const original = body[method];
    if (typeof original !== 'function' || original.__permissionGated) return;
    const wrapped = async function gated(...args) {
      const target = describe(args) || {};
      target.selfPlaced = target.position ? selfPlaced.has(key(target.position)) : false;
      const verdict = await authorize(action, target);
      if (!verdict.ok) return refuse(action, target, { reason: verdict.reason });

      const result = await original.apply(this, args);
      if (result !== false && action === 'place' && target.placeAt) {
        selfPlaced.add(key(target.placeAt));
        if (selfPlaced.size > 1024) {
          for (const first of selfPlaced) {
            selfPlaced.delete(first);
            break;
          }
        }
      }
      return result;
    };
    wrapped.__permissionGated = true;
    body[method] = wrapped;
    installed.push(method);
  };

  wrap('dig', 'break', (args) => {
    const block = args[0] || {};
    return { name: block.name || null, position: block.position || null };
  });

  wrap('place', 'place', (args) => {
    const [itemName, reference, face] = args;
    const position = referencePosition(reference);
    return {
      name: itemName || null,
      position,
      placeAt: position ? faceOffset(position, face) : null
    };
  });

  wrap('useOn', 'use', (args) => {
    const [position] = args;
    let name = null;
    try {
      const block = body.blockAt && position ? body.blockAt(position) : null;
      name = block && block.name ? block.name : null;
    } catch {}
    return { name, position: position || null };
  });

  /**
   * Single-hop pillar is one real `place`: the support block goes into the cell the
   * player's feet are in. Without this, `body.pillar(1)` was the one world-writing
   * primitive that bypassed the place gate entirely (plan §5.4.1 / §七).
   *
   * Multi-hop calls are refused rather than half-checked: per-cell placement cannot be
   * verified for hops the gate never sees, and the iterative executor only ever sends
   * one hop at a time.
   */
  const originalPillar = body.pillar;
  if (typeof originalPillar === 'function' && !originalPillar.__permissionGated) {
    const gatedPillar = async function gatedPillar(count, options) {
      const steps = Math.max(1, Math.floor(Number(count) || 1));
      if (steps > 1) {
        const info = { action: 'place', name: null, position: null, reason: 'multi-hop pillar is not permission-checked', at: Date.now() };
        body.lastRefusal = info;
        log.warn('permission: pillar(n>1) refused - single-cell hops are the checked form');
        return { ok: false, refused: true, steps: 0, reason: info.reason };
      }
      const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
      const position =
        snap && snap.position
          ? { x: Math.floor(snap.position.x), y: Math.floor(snap.position.y), z: Math.floor(snap.position.z) }
          : null;
      if (!position) {
        const info = { action: 'place', name: null, position: null, reason: 'no player position for the pillar placement', at: Date.now() };
        body.lastRefusal = info;
        log.warn(`permission: pillar refused (${info.reason})`);
        return { ok: false, refused: true, steps: 0, reason: info.reason };
      }
      const target = {
        name: (snap && snap.heldItem) || null,
        position: { ...position },
        placeAt: { ...position },
        selfPlaced: selfPlaced.has(key(position))
      };
      const verdict = await authorize('place', target);
      if (!verdict.ok) {
        refuse('place', target, { reason: verdict.reason });
        return { ok: false, refused: true, steps: 0, reason: verdict.reason };
      }
      const result = await originalPillar.call(this, steps, options);
      if (result && result.ok !== false) selfPlaced.add(key(target.placeAt));
      return result;
    };
    gatedPillar.__permissionGated = true;
    body.pillar = gatedPillar;
    installed.push('pillar');
  }

  log.info(`permission gate installed on: ${installed.join(', ') || '(nothing)'}`);
  return { installed, selfPlaced };
}

module.exports = { installPermissionGate };
