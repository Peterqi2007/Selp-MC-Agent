'use strict';

/**
 * Combat skills: melee attack/defend and the TACZ gun routine (docs/COMBAT-PLAN.md v3).
 *
 * Ground rules that came out of live testing (2026-10-13):
 *  - the weapon must be VERIFIED in the hand before swinging (a sword in the bag and a
 *    shovel in the hand lost a fight the bot should have won);
 *  - a target that stays in melee reach for 30s without any contact is abandoned and
 *    ignored for a while - the reflex re-engaged an unreachable zombie forever;
 *  - gunfire is bounded: ≤6-round bursts, aim before the first shot, hold fire under
 *    full cover, and ammo exhaustion switches to another loaded gun before giving up.
 *  - if the gun leaves the hand mid-burst (a manual hotbar swap or a melee fallback),
 *    re-equip and retry a couple of times instead of losing the whole fight.
 */

const { register } = require('./registry');
const { bare } = require('../world/items');
const { sleep } = require('../core/movement');
const combatState = require('../world/combatState');

const WEAPON_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];

/** Gun policy constants (docs/COMBAT-PLAN.md §④). */
const GUN_BURST_SHOTS = 6;
const BURST_PAUSE_MS = 500;
/** Close-range preference order, operator policy: rifle > smg > mg > pistol. */
const GUN_CLOSE_ORDER = ['rifle', 'smg', 'mg', 'pistol'];
const GUN_DEFAULT_RANGE = 16;
const GUN_SNIPER_RANGE = 32;
const KITE_DISTANCE = 3;
const APPROACH_MARGIN = 2;
const SNIPER_SWITCH_DISTANCE = 8;
const APPROACH_LEGS = 2;
const SHOOT_BURST_MS = 8000;
/** How many times a not_a_gun burst is recovered by re-equipping before giving up. */
const NOT_A_GUN_RETRIES = 2;

/** Effective range for a gun type: the sniper reaches 32, everything else 16. */
function rangeOf(gunType) {
  return gunType === 'sniper' ? GUN_SNIPER_RANGE : GUN_DEFAULT_RANGE;
}

/**
 * Pick the best weapon in the bag: swords by tier first, then axes.
 *
 * The live run started swinging at a zombie while holding bread - the skill never equipped
 * anything, so a full inventory of weapons did nothing.
 */
function pickWeapon(inventory) {
  const names = Object.keys(inventory || {});
  for (const tier of WEAPON_TIERS) {
    const sword = names.find((name) => bare(name) === `${tier}_sword`);
    if (sword) return sword;
  }
  for (const tier of WEAPON_TIERS) {
    const axe = names.find((name) => bare(name) === `${tier}_axe`);
    if (axe) return axe;
  }
  return names.find((name) => /_(sword|axe)$/.test(bare(name))) || null;
}

/**
 * Equip an item, then verify the hand really holds it; one retry.
 *
 * `equip()` is a two-step story on a real client (hotbar select, or menu clicks to move
 * the stack from the bag first) and the final select can race the server. Live
 * 2026-10-13 the bot punched a pillager with the shovel that happened to be in hand
 * while its sword sat in the bag - the call had answered true and nobody looked.
 */
async function equipVerified(ctx, itemName) {
  const body = ctx.body;
  if (!body || typeof body.equip !== 'function') return false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await body.equip(itemName).catch(() => false);
    if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
    const check = typeof body.snapshot === 'function' ? body.snapshot() : null;
    const held = check && check.heldItem ? check.heldItem : null;
    if (!held || bare(held) === bare(itemName)) return true;
  }
  return false;
}

/** Equip the best melee weapon before a fight; keep the held item when there is none. */
async function equipWeapon(ctx) {
  const body = ctx.body;
  if (!body || typeof body.equip !== 'function') return null;
  const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
  const weapon = pickWeapon((snap && snap.inventory) || {});
  if (!weapon) return null;
  const verified = await equipVerified(ctx, weapon);
  if (!verified && ctx && ctx.log && typeof ctx.log.warn === 'function') {
    const check = typeof body.snapshot === 'function' ? body.snapshot() : null;
    const held = check && check.heldItem ? check.heldItem : null;
    ctx.log.warn(
      `could not get ${bare(weapon)} into the hand (holding ${held ? bare(held) : 'nothing'}) - fighting with what is held`
    );
  }
  return weapon;
}

/** Gun entries the client reported for its inventory ([] when none / no TACZ). */
function gunsOf(snapshot) {
  return snapshot && Array.isArray(snapshot.guns) ? snapshot.guns : [];
}

/** The gun currently in the main hand, matched by item id; null when the hand is not a gun. */
function heldGun(snapshot) {
  const held = snapshot && snapshot.heldItem ? bare(snapshot.heldItem) : null;
  if (!held) return null;
  return gunsOf(snapshot).find((gun) => bare(gun.item) === held) || null;
}

/**
 * Choose a gun.
 *
 * `weapon` forces one (only manual `!shoot`/LLM calls ever pass it - the reflex always
 * uses the default order). Otherwise: loaded guns only; beyond 16 blocks the sniper is
 * the first candidate, within 16 blocks the close order rifle > smg > mg > pistol wins
 * and the sniper is the last resort.
 */
function chooseGun(snapshot, { distance, weapon, excludeSniper, excludeItems = [] } = {}) {
  const guns = gunsOf(snapshot);
  const excluded = new Set(excludeItems.map((item) => bare(item)));
  if (weapon) {
    const wanted = bare(weapon);
    const found = guns.find(
      (gun) => bare(gun.item) === wanted || bare(gun.gunId) === wanted || bare(gun.item).endsWith(wanted)
    );
    if (!found) return { ok: false, reason: `weapon "${weapon}" is not a TACZ gun in the inventory` };
    return { ok: true, gun: found, forced: true };
  }
  let candidates = guns.filter((gun) => gun.bullets === true && !excluded.has(bare(gun.item)));
  if (excludeSniper) candidates = candidates.filter((gun) => gun.type !== 'sniper');
  if (!candidates.length) {
    return {
      ok: false,
      reason: excludeSniper ? 'no other loaded gun in the inventory' : 'no loaded gun in the inventory'
    };
  }
  const order = (gun) => {
    if (gun.type === 'sniper') return distance > GUN_DEFAULT_RANGE ? -1 : 100;
    const index = GUN_CLOSE_ORDER.indexOf(gun.type);
    return index === -1 ? 50 : index;
  };
  candidates = candidates.slice().sort((a, b) => order(a) - order(b));
  return { ok: true, gun: candidates[0] };
}

function pickTarget(ctx, { type, maxDistance, vertical }) {
  const body = ctx.body;
  if (!body || typeof body.hostiles !== 'function') return { ok: false, reason: 'this body cannot see hostiles' };
  let list = body.hostiles(maxDistance) || [];
  if (type) list = list.filter((entity) => bare(entity.name) === bare(type));
  /**
   * Ignore targets on another floor.
   *
   * The chase is a straight "hold forward" walk, so a zombie in a cave 15 blocks below is
   * not a target - it is a cliff to fall down. Keeping the vertical window small is what
   * stops the bot from diving into a ravine after underground spawns.
   */
  if (vertical !== undefined) {
    const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
    const botY = snap && snap.position ? snap.position.y : null;
    if (botY !== null) {
      list = list.filter((entity) => {
        const y = entity.position ? entity.position.y : botY;
        return Math.abs(y - botY) <= vertical;
      });
    }
  }
  /** Stalled-and-ignored targets are skipped unless they closed into melee reach. */
  list = list.filter((entity) => !combatState.shouldSkip(entity.id, entity.distance));
  if (!list.length) {
    return {
      ok: false,
      reason: type
        ? `no ${bare(type)} within ${maxDistance} blocks`
        : `no hostile within ${maxDistance} blocks (on this level)`
    };
  }
  list.sort((a, b) => (a.distance || 0) - (b.distance || 0));
  return { ok: true, target: list[0] };
}

/** Poll the magazine for up to ~4.5s after asking TACZ to reload. */
async function waitForReload(ctx, itemName, timeoutMs = 4500) {
  const body = ctx.body;
  if (!body || typeof body.refresh !== 'function') return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const fresh = await body.refresh(true).catch(() => null);
    const gun = fresh && Array.isArray(fresh.guns)
      ? fresh.guns.find((g) => bare(g.item) === bare(itemName))
      : null;
    if (gun && (gun.magazine + (gun.dummy || 0)) > 0) return gun;
  }
  return null;
}

/**
 * Run one melee engagement in 3s chunks, re-checking contact at every boundary.
 *
 * The operator rule (§③): while the target sits ≤5 blocks and NOTHING has hurt us for
 * 30s - accumulated across calls; the live symptom was three 15s attack runs in a row
 * against an unreachable zombie - the fight is a stand-off. Abort, stop the client
 * action and ignore the target for 180s. Any health loss resets the contactless clock.
 */
async function fightTarget(ctx, target, timeoutMs) {
  const body = ctx.body;
  const started = Date.now();
  combatState.rememberEngagement(target.id, target.distance);
  const pre = typeof body.snapshot === 'function' ? body.snapshot() : null;
  let lastHealth = pre && typeof pre.health === 'number' ? pre.health : null;
  while (Date.now() - started < timeoutMs) {
    const chunkMs = Math.max(1000, Math.min(3000, timeoutMs - (Date.now() - started)));
    const ok = await body.attack(target, { timeoutMs: chunkMs });
    if (ok) return { ok: true };
    const after = typeof body.refresh === 'function' ? await body.refresh(true).catch(() => null) : null;
    if (!after) continue;
    if (lastHealth !== null && typeof after.health === 'number' && after.health < lastHealth - 0.01) {
      combatState.noteHealthDrop();
    }
    if (typeof after.health === 'number') lastHealth = after.health;
    const still = (after.hostiles || []).find((entity) => entity.id === target.id);
    if (!still) return { ok: true }; // died / vanished mid-fight
    combatState.rememberEngagement(target.id, still.distance);
    if (still.distance <= combatState.STALL_RANGE && combatState.isStalled(target.id)) {
      if (typeof body.stop === 'function') await body.stop().catch(() => false);
      combatState.ignore(target.id);
      return {
        ok: false,
        stalled: true,
        reason:
          `no contact with ${bare(target.name)} for ${Math.round(combatState.STALL_MS / 1000)}s ` +
          `at ${Math.round(still.distance)} blocks - ignoring it`
      };
    }
  }
  return { ok: false };
}

register({
  name: 'attack',
  title: '攻击最近的敌对目标',
  description: 'Attack the nearest hostile (optionally of one type) until it dies or times out.',
  params: {
    type: { type: 'string' },
    /**
     * 16 rather than 8. The live report was "!attack was refused while zombies were
     * nearby" - the zombies were around ten blocks away and the old default simply did
     * not look that far. The mod tracks hostiles out to 24 blocks.
     */
    maxDistance: { type: 'number', default: 16, min: 1, max: 32 },
    /** How far above/below the bot a target may be; keeps a straight-line chase on one floor. */
    vertical: { type: 'number', default: 4, min: 1, max: 32 },
    timeoutMs: { type: 'number', default: 15000, min: 500, max: 120000 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.attack === 'function' && typeof ctx.body.hostiles === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot fight' }),
  async run(ctx, params) {
    // A dead or post-death-stopped bot cannot fight; say that instead of "no hostile".
    const snap = ctx.body && typeof ctx.body.snapshot === 'function' ? ctx.body.snapshot() : null;
    if (snap && snap.dead) return { ok: false, reason: 'the bot is dead - respawn before fighting' };
    if (ctx.brain && ctx.brain.stopped) return { ok: false, reason: 'tasks are stopped after death - say !resume first' };

    let picked = pickTarget(ctx, params);
    if (!picked.ok && params.maxDistance < 24) {
      // One escalation step before refusing: a hostile at 10-20 blocks is still "nearby".
      picked = pickTarget(ctx, { ...params, maxDistance: 24 });
    }
    if (!picked.ok) return picked;
    await equipWeapon(ctx);
    const fight = await fightTarget(ctx, picked.target, params.timeoutMs);
    if (fight.ok) {
      return { ok: true, detail: `killed ${bare(picked.target.name)} at ${Math.round(picked.target.distance || 0)} blocks` };
    }
    if (fight.stalled) return { ok: false, failure: 'stalled', reason: fight.reason };
    const screenNote = snap && snap.screenOpen
      ? ` (a game screen "${snap.screen || '?'}" is open - the client ignores movement while it is)`
      : '';
    return {
      ok: false,
      reason: `${bare(picked.target.name)} is still alive (or out of reach) - it was ${Math.round(
        picked.target.distance || 0
      )} blocks away${screenNote}`
    };
  }
});

register({
  name: 'defend',
  title: '自卫',
  description: 'Keep attacking hostiles that come within range, up to a few rounds.',
  params: {
    range: { type: 'number', default: 6, min: 1, max: 16 },
    rounds: { type: 'number', default: 4, min: 1, max: 20 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.attack === 'function' && typeof ctx.body.hostiles === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot fight' }),
  async run(ctx, { range, rounds }) {
    let kills = 0;
    await equipWeapon(ctx);
    for (let round = 0; round < rounds; round += 1) {
      const picked = pickTarget(ctx, { maxDistance: range });
      if (!picked.ok) break;
      const fight = await fightTarget(ctx, picked.target, 15000);
      if (!fight.ok) break;
      kills += 1;
    }
    return kills
      ? { ok: true, detail: `defended against ${kills} hostile(s)` }
      : { ok: true, detail: 'nothing hostile in range' };
  }
});

register({
  name: 'shoot',
  title: '用枪射击目标',
  description:
    'Shoot a target with a TACZ gun: aims first, ≤6-round bursts, reloads, keeps the effective range (16 blocks, 32 for snipers).',
  params: {
    type: { type: 'string' },
    player: { type: 'string' },
    id: { type: 'number' },
    weapon: { type: 'string' },
    maxDistance: { type: 'number', default: 24, min: 1, max: 48 },
    timeoutMs: { type: 'number', default: 45000, min: 2000, max: 120000 }
  },
  available: (ctx) => (ctx.body && typeof ctx.body.shoot === 'function' && typeof ctx.body.snapshot === 'function'
    ? { ok: true }
    : { ok: false, reason: 'this body cannot shoot' }),
  async run(ctx, params) {
    const body = ctx.body;
    if (!body || typeof body.shoot !== 'function') return { ok: false, reason: 'this body cannot shoot' };
    const logInfo = (message) => {
      if (ctx.log && typeof ctx.log.info === 'function') ctx.log.info(message);
    };
    if (typeof body.refresh === 'function') await body.refresh(true).catch(() => null);
    const deadline = Date.now() + params.timeoutMs;
    const selfName = ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.bot ? ctx.cfg.agent.bot.username : null;

    /**
     * Resolve the target from the freshest snapshot.
     *
     * Players are never auto-targeted - PvP only happens when the operator names one
     * (`player` or `id`). Explicit ids also honor the ignore list, so the reflex cannot
     * sneak a stalled target back in through this path.
     */
    const resolve = () => {
      const snap = typeof body.snapshot === 'function' ? body.snapshot() : null;
      if (!snap) return { ok: false, reason: 'no world state' };
      if (params.id !== undefined) {
        const hostile = (snap.hostiles || []).find((entity) => entity.id === params.id);
        if (hostile) {
          if (combatState.shouldSkip(hostile.id, hostile.distance)) {
            return { ok: false, failure: 'ignored', reason: `target #${params.id} is on the ignore list` };
          }
          return { ok: true, snap, target: { ...hostile, kind: 'hostile' } };
        }
        const player = (snap.players || []).find((entity) => entity.id === params.id);
        if (player) return { ok: true, snap, target: { ...player, kind: 'player' } };
        return { ok: false, gone: true, reason: `target #${params.id} is gone` };
      }
      if (params.player) {
        if (selfName && bare(params.player) === bare(selfName)) {
          return { ok: false, reason: 'refusing to target myself' };
        }
        const found = (snap.players || []).find((entity) => bare(entity.name) === bare(params.player));
        if (!found) return { ok: false, gone: true, reason: `${params.player} is not visible right now` };
        return { ok: true, snap, target: { ...found, kind: 'player' } };
      }
      const picked = pickTarget(ctx, { type: params.type, maxDistance: params.maxDistance, vertical: 6 });
      /**
       * The auto path has no single named target: an empty scan is "gone" for the loop's
       * bookkeeping. Without the flag the loop reported a kill as "target_lost" right
       * after the burst removed the last hostile (caught by the offline gun suite).
       */
      if (!picked.ok) return { ...picked, gone: true };
      return { ok: true, snap, target: { ...picked.target, kind: 'hostile' } };
    };

    let targetName = null;
    let firstResolve = true;
    let flanksLeft = 1;
    let approachesLeft = APPROACH_LEGS;
    let bursts = 0;
    let shotsTotal = 0;
    let notAGunRetries = 0;
    let retreatBlocked = false;
    const dryGuns = new Set(); // item ids that answered "no_ammo"; never re-select them
    const reloadAttempts = new Set(); // one explicit reload attempt per gun per shoot call

    for (;;) {
      if (Date.now() > deadline) {
        return { ok: false, failure: 'timeout', reason: `shoot budget spent (${bursts} burst(s), ${shotsTotal} shots)` };
      }
      const resolved = resolve();
      if (!resolved.ok) {
        if (resolved.gone && !firstResolve) {
          return { ok: true, detail: `shot ${bare(targetName || 'target')} down (${bursts} burst(s), ${shotsTotal} shots)` };
        }
        return { ok: false, failure: resolved.failure || 'target_lost', reason: resolved.reason };
      }
      firstResolve = false;
      const snap = resolved.snap;
      const target = resolved.target;
      targetName = target.name;
      const distance = target.distance;

      /** Ensure a loaded gun is in hand; equip at most one per loop pass. */
      let gun = heldGun(snap);
      if (params.weapon) {
        /**
         * An explicit weapon meant to pin the fight - even when another gun is already
         * in hand. Once the pinned gun itself runs dry the no_ammo handover owns the
         * choice, so the pin is not enforced anymore (it would ping-pong forever).
         */
        const forced = chooseGun(snap, { weapon: params.weapon });
        if (!forced.ok) return { ok: false, failure: 'no_gun', reason: forced.reason };
        if (!dryGuns.has(bare(forced.gun.item))) {
          if (!gun || bare(gun.item) !== bare(forced.gun.item)) {
            if (!(await equipVerified(ctx, forced.gun.item))) {
              return { ok: false, failure: 'no_gun', reason: `could not equip ${bare(forced.gun.item)}` };
            }
          }
          gun = forced.gun;
        }
      }
      if (!gun) {
        const choice = chooseGun(snap, {
          distance,
          excludeItems: [...dryGuns]
        });
        if (!choice.ok) {
          return {
            ok: false,
            failure: dryGuns.size ? 'no_ammo' : 'no_gun',
            reason: choice.reason
          };
        }
        if (!(await equipVerified(ctx, choice.gun.item))) {
          return { ok: false, failure: 'no_gun', reason: `could not equip ${bare(choice.gun.item)}` };
        }
        gun = choice.gun;
      }
      const gunType = gun.type || 'unknown';
      const effectiveRange = rangeOf(gunType);

      if (distance > effectiveRange) {
        if (approachesLeft <= 0) {
          return {
            ok: false,
            failure: 'out_of_range',
            reason: `${bare(target.name)} stayed beyond ${effectiveRange} blocks for ${bare(gun.item)}`
          };
        }
        approachesLeft -= 1;
        if (typeof body.moveTo !== 'function') {
          return { ok: false, failure: 'no_path', reason: 'this body cannot chase into range' };
        }
        logInfo(`shoot: closing to ${Math.max(2, effectiveRange - APPROACH_MARGIN)} blocks for ${bare(gun.item)}`);
        await body
          .moveTo(target.position, { range: Math.max(2, effectiveRange - APPROACH_MARGIN), timeoutMs: 8000 })
          .catch(() => false);
        await sleep(BURST_PAUSE_MS);
        continue;
      }
      if (distance <= KITE_DISTANCE) {
        /**
         * Operator rule (2026-10-18): try to back out first. Only when the retreat cannot
         * move at all (pit/wall/stuck) switch to the sword/axe already in the bag. The old
         * code kited forever and the operator saw a zombie being "hit with the gun".
         */
        if (!retreatBlocked && typeof body.retreatFrom === 'function') {
          const before = typeof body.snapshot === 'function' ? body.snapshot() : null;
          const ok = await body.retreatFrom({ id: target.id }, { ms: 900, fire: true }).catch(() => false);
          await sleep(900);
          const after = typeof body.refresh === 'function'
            ? await body.refresh(true).catch(() => null)
            : null;
          const moved = before && before.position && after && after.position
            ? Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z)
            : null;
          if (ok && (moved === null || moved >= 0.35)) {
            logInfo(`shoot: target inside ${KITE_DISTANCE} blocks - retreating`);
            continue;
          }
          retreatBlocked = true;
          logInfo(`shoot: retreat blocked (${moved === null ? 'no movement data' : `moved ${moved.toFixed(2)} blocks`}) - switching to melee`);
        }

        const melee = await equipWeapon(ctx);
        if (melee) {
          logInfo(`shoot: fighting ${bare(target.name)} with ${bare(melee)} (retreat unavailable)`);
          const remaining = Math.max(1000, Math.min(3000, deadline - Date.now()));
          const fight = await fightTarget(ctx, target, remaining);
          if (fight.ok) {
            return { ok: true, detail: `killed ${bare(target.name)} at ${Math.round(distance || 0)} blocks with ${bare(melee)}` };
          }
          return {
            ok: false,
            failure: fight.stalled ? 'stalled' : 'melee_failed',
            reason: fight.reason || `${bare(target.name)} survived the melee switch`
          };
        }
        if (retreatBlocked) {
          return {
            ok: false,
            failure: 'retreat_blocked',
            reason: `retreat is blocked and there is no melee weapon for ${bare(target.name)}`
          };
        }
        continue;
      }
      if (gunType === 'sniper' && distance < SNIPER_SWITCH_DISTANCE) {
        /** A sniper inside 8 blocks is a liability: switch to any loaded closer-range gun. */
        const swap = chooseGun(snap, { distance, excludeSniper: true, excludeItems: [...dryGuns] });
        if (swap.ok && bare(swap.gun.item) !== bare(gun.item)) {
          if (await equipVerified(ctx, swap.gun.item)) {
            /**
             * The positional rule beats the pin: the operator asked for the sniper, the
             * operator's own "sniper inside 8 blocks" rule now wants a closer gun. Left
             * pinned, the loop would re-equip the sniper and ping-pong forever.
             */
            params.weapon = null;
            logInfo(`shoot: sniper too close (${Math.round(distance)}) - switching to ${bare(swap.gun.item)}`);
            continue;
          }
        }
        // No alternative: keep the sniper and fall through to the normal burst.
      }

      /** Normal case: re-aim (the burst does that) after a 500ms pause between bursts. */
      if (bursts > 0) await sleep(BURST_PAUSE_MS);
      const ok = await body
        .shoot({ id: target.id }, { ms: SHOOT_BURST_MS, maxShots: GUN_BURST_SHOTS })
        .catch(() => false);
      const verdict = body.lastAction || {};
      if (Number.isFinite(verdict.shots)) shotsTotal += verdict.shots;
      bursts += 1;
      /**
       * One line per burst: the live zero-shot hunt needs the TACZ result code here,
       * not a silent loop (2026-10-13: the gun was equipped and 8s bursts ended with
       * nothing fired and no trace anywhere).
       */
      logInfo(
        `shoot: burst ${bursts} ok=${ok} shots=${Number.isFinite(verdict.shots) ? verdict.shots : '?'} ` +
          `reason=${verdict.reason || '-'} result=${verdict.lastResult || '-'} ` +
          `gun=${bare(gun.item)} mag=${Number.isFinite(verdict.magazine) ? verdict.magazine : '?'} ` +
          `dist=${Math.round(distance)}`
      );
      if (ok) continue; // target may be gone; the next resolve() decides
      const reason = verdict.reason || 'unknown';
      if (reason === 'target_gone') continue; // resolve() reports the kill next pass
      if (reason === 'no_ammo') {
        /**
         * The client controller already tries to reload at magazine 0, but gives up after
         * 4s and returns no_ammo. Before marking the gun dry (and before the reflex falls
         * back to a sword), ask the mod for one explicit reload and re-read the magazine.
         */
        const gunId = bare(gun.item);
        if (!reloadAttempts.has(gunId) && typeof body.reload === 'function') {
          reloadAttempts.add(gunId);
          logInfo(`shoot: ${gunId} empty - explicit reload`);
          const reloadAccepted = await body.reload().catch(() => false);
          const reloadedGun = await waitForReload(ctx, gunId, 4500);
          if (reloadedGun) {
            dryGuns.delete(gunId);
            logInfo(`shoot: ${gunId} reloaded (mag ${reloadedGun.magazine}) - continuing`);
            continue;
          }
          logInfo(`shoot: ${gunId} reload did not fill the magazine within 4.5s (accepted=${reloadAccepted}) - falling through`);
        }
        dryGuns.add(gunId);
        const alt = chooseGun(snap, { distance, excludeItems: [...dryGuns] });
        if (!alt.ok) {
          return { ok: false, failure: 'no_ammo', reason: `out of ammo: no other loaded gun (${shotsTotal} shots fired)` };
        }
        if (!(await equipVerified(ctx, alt.gun.item))) {
          return { ok: false, failure: 'no_gun', reason: `could not equip ${bare(alt.gun.item)}` };
        }
        logInfo(`shoot: ${gunId} dry - switching to ${bare(alt.gun.item)}`);
        continue;
      }
      if (reason === 'blocked') {
        if (flanksLeft > 0 && typeof body.moveTo === 'function') {
          flanksLeft -= 1;
          logInfo(`shoot: fully covered - flanking once`);
          await body.moveTo(target.position, { range: 4, timeoutMs: 6000 }).catch(() => false);
          await sleep(BURST_PAUSE_MS);
          continue;
        }
        return { ok: false, failure: 'blocked', reason: `${bare(target.name)} is fully behind cover` };
      }
      if (reason === 'not_a_gun') {
        /**
         * The hand changed under the burst - a manual hotbar swap or a melee fallback
         * equipping a sword. Re-verify and retry instead of losing the whole fight
         * (live 2026-10-13: two concurrent fights swapped the gun out and the explicit
         * shoot died with not_a_gun after two rounds had already left the barrel).
         */
        if (notAGunRetries < NOT_A_GUN_RETRIES) {
          notAGunRetries += 1;
          logInfo(`shoot: ${bare(gun.item)} left the hand - re-equipping (attempt ${notAGunRetries}/${NOT_A_GUN_RETRIES})`);
          if (await equipVerified(ctx, gun.item)) {
            await sleep(BURST_PAUSE_MS);
            continue;
          }
        }
        return { ok: false, failure: 'not_a_gun', reason: 'gun path unavailable (not_a_gun)' };
      }
      if (reason === 'tacz_unavailable') {
        return { ok: false, failure: 'tacz_unavailable', reason: 'gun path unavailable (tacz_unavailable)' };
      }
      if (reason === 'out_of_range') {
        approachesLeft -= 1;
        continue;
      }
      if (reason === 'timeout') continue; // burst stalled; the outer deadline still bounds us
      if (bursts > 1) return { ok: false, failure: 'shoot_failed', reason: `burst failed: ${reason}` };
    }
  }
});

module.exports = { chooseGun, equipVerified, rangeOf, GUN_CLOSE_ORDER };
