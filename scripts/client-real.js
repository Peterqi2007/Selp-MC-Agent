'use strict';

/**
 * `npm run client:real` - real-server login + cautious pathfinding test.
 *
 * SAFETY FIRST. By default this script is deliberately non-destructive:
 *
 *   - it never digs, breaks, or places anything
 *   - movement uses the game's own travel (moveTo only presses keys), so farmland is not
 *     trampled by us "using" it and no block is modified
 *   - before walking, the destination is inspected and REFUSED if it looks man-made:
 *     containers, workstations, crops/farmland, or any modded block that is not natural
 *     terrain. `--allow-blocks` can override, but the default is to abort.
 *   - the walk target is chosen from a whitelist of natural surface blocks
 *
 * `--primitives` opts into the P0-PLAN §6.6 acceptance run, which by definition changes the
 * world: it walks, chops ONE natural tree block, collects the drop and reports the mining
 * prerequisite. Even then it refuses man-made targets, refuses to touch anything that is
 * not a whitelisted natural block, and never sends /register.
 *
 * `--no-login` skips the AuthMe step for when you already typed `/login` in the game
 * window - re-sending it trips the server's rate limiter, which looks like a bad password.
 *
 * Usage:
 *   node scripts/client-real.js --login <your-password>
 *   node scripts/client-real.js --login <your-password> --walk 6
 *   node scripts/client-real.js --login <your-password> --primitives        # world-changing
 *   node scripts/client-real.js --no-login --primitives --dig dirt:8,stone:4
 *   node scripts/client-real.js --no-login --primitives            # already logged in
 *   node scripts/client-real.js --status                           # no login, just report
 */

const { loadConfig } = require('../src/util/config');
const { ClientModBody } = require('../src/body/clientModBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const { GoToTask } = require('../src/tasks/goto');
const { ChopWoodTask } = require('../src/tasks/chopWood');
const { MineBlockTask } = require('../src/tasks/mineBlock');
/**
 * The man-made policy lives in ONE place (src/world/safety.js) and is used by both this
 * operator script and the running agent. Keeping a private copy here is how a "safe" test
 * ends up sitting next to an agent that walks through someone's farm.
 */
const { manMadeReason: classify, assessStandability, looksLikeTree } = require('../src/world/safety');
const { isDaytime } = require('../src/world/daytime');
const { findBedNear } = require('../src/world/beds');

const args = process.argv.slice(2);
function valueOf(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const next = args[i + 1];
  return !next || next.startsWith('--') ? null : next;
}

const cfg = loadConfig();
const port = Number(valueOf('--port')) || 8899;
const password = valueOf('--login');
const walkDistance = Number(valueOf('--walk')) || 0;
const statusOnly = args.includes('--status');
const allowRisky = args.includes('--allow-blocks');
const primitives = args.includes('--primitives');
const noLogin = args.includes('--no-login');
const chopCount = Number(valueOf('--chop-count')) || 1;
/**
 * `--dig dirt:4,stone:8` - test the break/collect primitives on plain blocks.
 *
 * Parsed here rather than deep in the flow so a typo fails immediately with the accepted
 * syntax, instead of silently digging nothing.
 */
const digSpec = String(valueOf('--dig') || '')
  .split(',')
  .map((part) => part.trim())
  .filter(Boolean)
  .map((part) => {
    const [name, count] = part.split(':');
    return { name: name.trim(), count: Number(count) || 4 };
  });
if (digSpec.some((d) => !/^[a-z_]+$/.test(d.name))) {
  process.stdout.write('--dig expects "block[:count]" pairs, e.g. --dig dirt:8,stone:4\n');
  process.exit(2);
}

// There is deliberately no --register flag: see the header comment and the login section.
const refusedFlags = args.filter((a) => a === '--register');
if (refusedFlags.length) {
  process.stdout.write(
    'refusing --register: on this server /register RESETS the character (experience and\n' +
      'inventory are lost). Authentication is /login only, and the mod blocks /register.\n'
  );
  process.exit(2);
}

const out = (s = '') => process.stdout.write(`${s}\n`);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  out(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}
function note(s) {
  out(`  [note] ${s}`);
}

(async () => {
  out('minecraft-survival-agent - REAL SERVER test (non-destructive)');
  out(`target: http://127.0.0.1:${port}`);
  out(`policy: never dig/place; refuse man-made destinations${allowRisky ? ' (OVERRIDDEN by --allow-blocks)' : ''}`);
  out('');

  const body = new ClientModBody(cfg, {
    port,
    log: { info: (m) => out(`  [body] ${m}`), warn: (m) => out(`  [warn] ${m}`), debug() {}, error() {} }
  });

  // ---------------------------------------------------------------- attach
  out('1. attach to the live client');
  try {
    await body.connect({ waitMs: 5000 });
    check('attached', body.isReady);
  } catch (err) {
    check('attached', false, err.message);
    out('\nstart a client first: npm run client:launch -- --server mc.example.com:25565');
    process.exitCode = 1;
    return;
  }

  await body.refresh(true);
  let snap = body.snapshot();
  out(`  position ${JSON.stringify(snap.position)}  dimension ${snap.dimension}  hp/food ${snap.health}/${snap.food}`);

  // Which server are we on? The mod cannot tell us directly; the player list and the
  // world contents do. Report what we can see.
  const cells = Object.keys(body._snapshot.blocks.cells || {}).length;
  const moddedNamespaces = new Set();
  for (const name of Object.values(body._snapshot.blocks.cells)) {
    const ns = String(name).split(':')[0];
    if (ns !== 'minecraft') moddedNamespaces.add(ns);
  }
  check('block map populated', cells > 1000, `${cells} cells`);
  if (moddedNamespaces.size) {
    note(`modded block namespaces visible here: ${[...moddedNamespaces].slice(0, 12).join(', ')}`);
    note('this confirms we are reading a MODDED world through the client, not a vanilla registry');
  }

  // ------------------------------------------------------- AuthMe detection
  out('');
  out('2. chat state (looking for the AuthMe prompt)');
  await body.request('/chatlog/clear');
  await new Promise((r) => setTimeout(r, 1500));
  let log = await body.request('/chatlog?n=25');
  const lines = (log && log.lines) || [];
  out(`  ${lines.length} line(s) captured since clear`);
  for (const line of lines.slice(-8)) out(`    | ${line}`);

  // Older lines survive a clear only if they arrived after it, so also ask for a big window
  // including whatever was there before the clear.
  const promptSeen = lines.some((l) => /\/login|\/register|login|register|请登录|请注册|注册/i.test(l));
  if (promptSeen) {
    check('AuthMe prompt visible in chat', true);
  } else {
    note('no login/register prompt in the recent buffer - it may have scrolled past already');
  }

  if (statusOnly || (!password && !noLogin)) {
    out('');
    out('3. login skipped (no --login given)');
    out('   run:  node scripts/client-real.js --login <password>');
    out('');
    out('   NOTE: there is deliberately NO --register option. On this server /register');
    out('         resets the character (experience and inventory are lost), so the mod');
    out('         blocks the command outright and authentication is /login only.');
    out('');
    out('   If you already typed /login in the game window, use --no-login to run the');
    out('   checks without sending a second login (AuthMe rate-limits repeated attempts).');
    await body.disconnect();
    summarise();
    return;
  }

  // ---------------------------------------------------------------- login
  //
  // `--no-login` is for the common case where the operator already typed `/login` in the
  // game window: re-sending it trips AuthMe's rate limiter ("Слишком много попыток входа"),
  // which looks like an authentication failure but is really the server protecting itself.
  if (noLogin) {
    out('');
    out('3. AuthMe login skipped (--no-login): assuming the session is already authenticated');
  } else {
    out('');
    out('3. AuthMe login');
    await body.request('/chatlog/clear');
    const sent = await body.login(password);
    check('login command dispatched', sent === true);
    await new Promise((r) => setTimeout(r, 2500));

    log = await body.request('/chatlog?n=20');
    const after = (log && log.lines) || [];
    out('  server said:');
    for (const line of after.slice(-6)) out(`    | ${line}`);

    const success = after.some((l) => /成功|success|logged in|已登录|欢迎|welcome|Добро пожаловать|Авторизация успешна|выполнен/i.test(l));
    const already = after.some((l) => /已登录|already logged|уже авторизован/i.test(l));
    const notRegistered = after.some((l) => /未注册|not registered|请注册|не зарегистрирован/i.test(l));
    const wrongPassword = after.some((l) => /密码错误|wrong password|неверный пароль|incorrect/i.test(l));
    const rateLimited = after.some((l) => /Слишком много попыток|too many attempts|尝试次数过多/i.test(l));

    if (success || already) {
      check('LOGGED IN to the server', true, already ? 'was already authenticated' : 'server confirmed');
    } else if (rateLimited) {
      check('LOGGED IN to the server', false, 'AuthMe rate limit - wait ~60s, or re-run with --no-login if you are already in');
      note('this is the server protecting itself, not a wrong password');
    } else if (notRegistered) {
      check('LOGGED IN to the server', false, 'account is NOT registered on this server');
      note('do NOT run /register - it resets the character. Ask the server owner to create it.');
    } else if (wrongPassword) {
      check('LOGGED IN to the server', false, 'wrong password');
    } else {
      // No recognisable reply: report honestly rather than claiming success.
      check('LOGGED IN to the server', false, 'no recognisable confirmation in chat');
      note('the command was sent; the server reply may be worded differently or suppressed');
    }
  }

  // ----------------------------------------------------------- pathfinding
  out('');
  out('4. cautious pathfinding test (no digging, no placing)');
  if (!(await ensureDaytime(body))) {
    check('night safety: daytime or slept in a bed before walking', false, 'no usable bed - aborted');
    await body.disconnect();
    summarise();
    return;
  }

  const PROTECTED_DEST = /minecraft/; // placeholder, real check below
  // Pick a destination on natural ground, refusing anything man-made.
  await body.refresh(true);
  snap = body.snapshot();
  const here = { x: Math.floor(snap.position.x), y: Math.floor(snap.position.y), z: Math.floor(snap.position.z) };

  const distance = walkDistance > 0 ? walkDistance : 3;
  const candidates = [];
  const refused = [];
  for (const [dx, dz] of [[distance, 0], [-distance, 0], [0, distance], [0, -distance], [distance, distance], [-distance, -distance]]) {
    for (let dy = 1; dy >= -2; dy -= 1) {
      const pos = { x: here.x + dx, y: here.y + dy, z: here.z + dz };
      const surface = body.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z });
      const space = body.blockAt({ x: pos.x, y: pos.y, z: pos.z });
      const verdict = assessStandability(surface && surface.name, space && space.name);
      if (!verdict.ok) {
        if (!allowRisky) {
          refused.push(`(${pos.x},${pos.y},${pos.z}) ${verdict.why}`);
          continue;
        }
      }
      candidates.push({ ...pos, surface: surface.name, space: space.name });
    }
    if (candidates.length) break;
  }

  if (refused.length) {
    note(`${refused.length} candidate(s) refused for safety:`);
    for (const r of refused.slice(0, 6)) note(`  ${r}`);
  }

  if (!candidates.length) {
    check('found a safe destination', false, 'every nearby candidate looked man-made or unstandable');
    note('refusing to walk rather than risk damaging something - this is the intended behaviour');
  } else {
    const target = candidates[0];
    check('found a safe destination', true, `${target.surface} at (${target.x},${target.y},${target.z})`);
    const before = { ...body.snapshot().position };
    const arrived = await body.moveTo(target, { range: 1.5, timeoutMs: 25000 });
    await body.refresh(true);
    const afterPos = body.snapshot().position;
    const moved = Math.hypot(afterPos.x - before.x, afterPos.z - before.z);
    check('moveTo() completed', arrived === true, `moved ${moved.toFixed(2)} blocks`);
    check('position actually changed', moved > 0.5, `${JSON.stringify(before)} -> ${JSON.stringify(afterPos)}`);
    await body.command('stop');
  }

  // ------------------------------------------------------- the three primitives
  if (primitives) {
    out('');
    out('5. P0 primitives on the real server (walk / break / collect) - WORLD-CHANGING');
    out(`   policy: natural logs only, ${chopCount} block(s), no man-made targets, never /register`);

    const ctx = buildTaskContext(body);
    await body.refresh(true);
    if (!(await ensureDaytime(body))) {
      check('night safety: daytime or slept in a bed before primitives', false, 'no usable bed - aborted');
      await body.disconnect();
      summarise();
      return;
    }
    /**
     * A screen-open session makes every movement key a no-op. The 2026-10-17 retest lost
     * its inventory (death) and kept running: the stone task reported 32 noPath failures
     * while the real cause was the death screen. Abort before changing anything, so the
     * verdict cannot be mistaken for a pathfinding bug.
     */
    const preflight = body.snapshot();
    if (preflight && preflight.screenOpen) {
      check(
        'P0 primitives start from a usable session (no screen open)',
        false,
        `${preflight.screen || 'a screen'} is open - close it and re-run`
      );
      out('aborting primitives before any world change; these results are not valid');
      await body.disconnect();
      summarise();
      return;
    }

    // ---- primitive 1: walk ------------------------------------------------
    const walkTarget = pickSafeDestination(body, walkDistance > 0 ? walkDistance : 5);
    if (!walkTarget) {
      check('primitive 1 walk: safe destination', false, 'no natural standable spot nearby');
    } else {
      const before = { ...body.snapshot().position };
      const task = new GoToTask(ctx, { position: walkTarget, range: 1.5, timeoutMs: 45000 });
      const res = await task.execute();
      await body.refresh(true);
      const now = body.snapshot().position;
      const moved = Math.hypot(now.x - before.x, now.z - before.z);
      check(
        'primitive 1 walk: GoToTask walked to the target',
        res.ok && moved > 0.5,
        `${res.reason} (moved ${moved.toFixed(2)} blocks)`
      );
      if (!res.ok) note(`pathfinding said: ${res.reason} - that IS the deliverable-A classification`);
      await body.command('stop');
    }

    if (chopCount > 0) {
      /**
       * The scan radius is only 24 blocks, so "no tree nearby" usually means "not here", not
       * "nowhere". Roaming a few legs is what a player does, and each leg is itself more
       * evidence for primitive 1 - the planner has to find a route through whatever terrain
       * the world actually has, not the terrain a test author imagined.
       */
      let tree = pickSafeTree(body);
      const roamLegs = [];
      for (let attempt = 0; !tree && attempt < 6; attempt += 1) {
        const spot = pickSafeDestination(body, 12 + attempt * 3);
        if (!spot) {
          note(`roam ${attempt + 1}: no safe destination found - stopping the search`);
          break;
        }
        const task = new GoToTask(ctx, { position: spot, range: 2, timeoutMs: 40000 });
        const res = await task.execute();
        const moved = distanceMoved(body, spot);
        roamLegs.push(`${res.ok ? 'ok' : res.reason}->${spot.x},${spot.z}(${moved.toFixed(1)}b)`);
        tree = pickSafeTree(body);
      }
      if (roamLegs.length) note(`roamed ${roamLegs.length} leg(s): ${roamLegs.join(' ')}`);

      if (!tree) {
        note('no natural tree found after roaming - skipping the chop/collect check');
        note('(nothing was dug; re-run near a forest, or use --dig dirt,stone instead)');
      } else {
        note(`target tree: ${tree.name} at (${tree.position.x},${tree.position.y},${tree.position.z}), ${tree.distance} blocks away`);
        const beforeCount = countLogs(body);
        const task = new ChopWoodTask(ctx, { count: chopCount, timeoutMs: 90000, warmupMs: 1000 });
        const res = await task.execute();
        await body.refresh(true);
        const gained = countLogs(body) - beforeCount;
        check(
          'primitive 2+3 chop: the log really entered the inventory',
          gained >= 1,
          `${res.reason} (inventory +${gained} log(s), ${res.ok ? 'task ok' : 'task reported partial/failed'})`
        );
        if (gained === 0) {
          note('the block may have been broken without the drop being collected - this is exactly');
          note('the failure the "count items, not swings" rule exists to catch');
        }
      }
    }

    // ---- primitive 2 + 3: break, then collect the drop --------------------
    /**
     * `--dig dirt:4,stone:8` adds break/collect checks on plain terrain.
     *
     * ADDITIVE, not a replacement: the tree check above still runs, so one
     * invocation covers both "can it fell a tree" and "can it dig ordinary ground". Dirt needs
     * no tool and is never part of anything; stone is the material the plan's acceptance names
     * and exercises the prerequisite rule - bare-handed stone mining breaks the block and
     * drops *nothing*, so the task refuses it up front rather than leaving an empty bag.
     */
    if (digSpec.length) {
      for (const entry of digSpec) {
        const name = entry.name;
        const want = entry.count;
        /**
         * Count the block's DROP, not its name: stone drops cobblestone, deepslate drops
         * cobbled_deepslate. The first live run counted `stone` and reported "+0" while the
         * task had actually put cobblestone in the bag.
         */
        const harvested = (clientBody) => {
          const names =
            name === 'stone'
              ? ['stone', 'cobblestone']
              : name === 'deepslate'
                ? ['deepslate', 'cobbled_deepslate']
                : [name];
          return names.reduce((sum, item) => sum + countOf(clientBody, item), 0);
        };
        const before = harvested(body);
        const task = new MineBlockTask(ctx, {
          block: name === 'dirt' ? ['dirt', 'grass_block'] : [name],
          count: want,
          probeShaft: name === 'stone',
          timeoutMs: 90000,
          warmupMs: 500
        });
        const res = await task.execute();
        await body.refresh(true);
        const gained = harvested(body) - before;
        const hasPick = Object.keys(body.snapshot().inventory || {}).some((n) => /pickaxe/.test(n));
        if (/stone|cobble|deepslate|_ore/.test(name) && !hasPick) {
          check(
            `dig ${name}: refuses without a pickaxe instead of breaking blocks for nothing`,
            !res.ok && /need a pickaxe/.test(res.reason),
            res.reason
          );
        } else {
          check(
            `dig ${name}: blocks broke and the drop entered the inventory`,
            gained >= 1,
            `${res.reason} (inventory +${gained})`
          );
        }
      }
    }

    // ---- mining prerequisite ---------------------------------------------
    const mine = new MineBlockTask(ctx, { block: ['stone', 'cobblestone'], count: 2, probeShaft: false, warmupMs: 0 });
    const stoneBefore = countOf(body, 'stone') + countOf(body, 'cobblestone');
    const mineRes = await mine.execute();
    await body.refresh(true);
    const stoneGained = countOf(body, 'stone') + countOf(body, 'cobblestone') - stoneBefore;
    const hasPick = Object.keys(body.snapshot().inventory || {}).some((n) => /pickaxe/.test(n));
    if (hasPick) {
      /**
       * Count the DROP, not the task's own verdict: the previous check only proved that the
       * task ran. On 2026-10-17 it collected 2/2 while this line still said "task ran".
       */
      check(
        'mine: stone actually entered the inventory with a pickaxe',
        stoneGained >= 1,
        `${mineRes.reason} (inventory +${stoneGained} stone/cobblestone)`
      );
    } else {
      check(
        'mine: refuses cleanly without a pickaxe',
        !mineRes.ok && /need a pickaxe/.test(mineRes.reason),
        mineRes.reason
      );
    }

    // ---- the observable outcome of all of it -----------------------------
    const traceLines = require('fs').existsSync('runtime/path-trace.jsonl')
      ? require('fs').readFileSync('runtime/path-trace.jsonl', 'utf8').trim().split('\n').length
      : 0;
    note(`runtime/path-trace.jsonl now holds ${traceLines} record(s)`);
  } else if (!statusOnly) {
    out('');
    out('5. primitives skipped');
    out('   `--primitives` runs the P0 §6.6 acceptance on this server (walks, chops ONE');
    out('   natural tree block, collects the drop). It changes the world, so it is opt-in.');
  }

  await body.disconnect();
  summarise();

  /**
   * Night safety for live tests: the operator's rule is that the game must not be played
   * through the night unattended. Sleep in a bed when night falls; if no bed can be used,
   * stop the test instead of walking/digging in the dark.
   *
   * This is a safety gate, not an acceptance item.
   */
  async function ensureDaytime(clientBody) {
    let snap = await clientBody.refresh(true).catch(() => null);
    if (!snap || !snap.time) snap = clientBody.snapshot();
    if (isDaytime(snap && snap.time) !== false) return true;

    note('night fell: looking for a bed within 60x10x60 before continuing (safety rule)');
    const center = snap && snap.position ? snap.position : null;
    const bed = findBedNear(clientBody, center, {
      halfX: 30,
      halfY: 5,
      halfZ: 30,
      maxDistance: 64
    });
    if (!bed) {
      note('night and no bed within 60x10x60 - stopping instead of playing through the night');
      return false;
    }
    note(`sleeping in ${bed.name} at (${bed.position.x},${bed.position.y},${bed.position.z})`);
    const reached = await clientBody
      .moveTo(bed.position, { range: 3, timeoutMs: 30000 })
      .catch(() => false);
    if (!reached) {
      note('could not reach the bed - stopping (safety)');
      return false;
    }
    await clientBody.useOn(bed.position, { face: { x: 0, y: 1, z: 0 } }).catch(() => false);
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const state = await clientBody.refresh(true).catch(() => null);
      if (isDaytime(state && state.time) === true) {
        note('slept until morning, continuing');
        return true;
      }
    }
    note('still night after 120s - stopping (safety)');
    return false;
  }

  /** A task context backed by the live client - the same shape index.js builds. */
  function buildTaskContext(clientBody) {
    const log = { debug() {}, info: (m) => out(`  [task] ${m}`), warn: (m) => out(`  [warn] ${m}`), error: (m) => out(`  [err] ${m}`) };
    const ctx = {
      cfg,
      log,
      body: clientBody,
      bodyKind: 'clientmod',
      world: new BodyWorldView(clientBody, cfg, { log }),
      memory: { landmark: () => null, recordTask() {}, rememberLandmark() {}, bump() {}, save() {}, data: { runtime: {} } },
      brain: { enqueue: async () => ({ accepted: true }), preempt() {}, queue: [], status: () => ({}) },
      nav: { stop() {}, interrupt() {}, goto: async () => true }
    };
    return ctx;
  }

  /** Nearest whitelisted natural log that is really part of a tree. */
  function pickSafeTree(clientBody) {
    const logs = clientBody.findBlocksMatching((name) => /(_log|_stem|_wood)$/i.test(name), { maxDistance: 20, count: 20 });
    for (const block of logs) {
      const veto = classify(block.name);
      if (veto) {
        note(`refusing ${block.name} at (${block.position.x},${block.position.y},${block.position.z}): ${veto}`);
        continue;
      }
      /**
       * The same structural test the agent's ChopWoodTask uses (src/world/safety.js): a log
       * in a wall, a fence post or a decorative pillar must be refused, and only the tree
       * check can tell them apart from a forest.
       */
      const verdict = looksLikeTree(clientBody, block);
      if (!verdict.ok) {
        note(`refusing ${block.name} at (${block.position.x},${block.position.y},${block.position.z}): ${verdict.why}`);
        continue;
      }
      return block;
    }
    return null;
  }

  function countLogs(clientBody) {
    const inv = (clientBody.snapshot() || {}).inventory || {};
    return Object.entries(inv)
      .filter(([name]) => /(_log|_stem|_wood)$/i.test(name))
      .reduce((sum, [, n]) => sum + n, 0);
  }

  /** How many of an item the bot is carrying (bare or namespaced name). */
  function countOf(clientBody, itemName) {
    const inv = (clientBody.snapshot() || {}).inventory || {};
    const wanted = String(itemName).replace(/^minecraft:/, '');
    return Object.entries(inv)
      .filter(([name]) => String(name).replace(/^minecraft:/, '') === wanted)
      .reduce((sum, [, n]) => sum + n, 0);
  }

  /** How far the body actually moved toward a target, for honest reporting. */
  function distanceMoved(clientBody, target) {
    const snap = clientBody.snapshot();
    if (!snap || !snap.position) return 0;
    return Math.hypot(snap.position.x - target.x, snap.position.z - target.z);
  }

  /** The same safety filter the walk test uses, exposed for the primitives section. */
  function pickSafeDestination(clientBody, distance) {
    const snap = clientBody.snapshot();
    const here = { x: Math.floor(snap.position.x), y: Math.floor(snap.position.y), z: Math.floor(snap.position.z) };
    for (const [dx, dz] of [[distance, 0], [-distance, 0], [0, distance], [0, -distance], [distance, distance], [-distance, -distance]]) {
      for (let dy = 1; dy >= -2; dy -= 1) {
        const pos = { x: here.x + dx, y: here.y + dy, z: here.z + dz };
        const surface = clientBody.blockAt({ x: pos.x, y: pos.y - 1, z: pos.z });
        const space = clientBody.blockAt({ x: pos.x, y: pos.y, z: pos.z });
        const verdict = assessStandability(surface && surface.name, space && space.name);
        if (verdict.ok || allowRisky) return pos;
      }
    }
    return null;
  }

  function summarise() {
    const failed = results.filter((r) => !r.ok);
    out('');
    out('='.repeat(62));
    out(`real-server test: ${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
      for (const f of failed) out(`  FAILED: ${f.name} - ${f.detail}`);
      process.exitCode = 1;
    }
  }
})().catch((err) => {
  out(`real-server test crashed: ${err.stack}`);
  process.exitCode = 1;
});
