'use strict';

/**
 * `npm run doctor` - one command that answers "why can't the agent drive the game?".
 *
 * Built after a session where the answer took far too long to find. The chain has five links,
 * and a break in any of them looks identical from the outside ("nothing happens"):
 *
 *   1. a Forge client is running
 *   2. its control mod bound the port and answers /state
 *   3. the character is actually in a world, logged in, and not dead
 *   4. **the game is accepting input** - no GUI screen open, window focused
 *   5. the agent is running, pointed at that mod, with its brain unstopped
 *
 * Link 4 is the one that cost the time. Minecraft ignores movement input while *any* screen is
 * open (inventory, chest, chat), so a human who leaves a screen open makes the bot look broken
 * while every check in the game says it is perfectly healthy. This script tests it by asking
 * the client to walk two blocks and watching whether the position actually changes.
 *
 * It only *reports*. It never kills, restarts or changes anything - the operator decides.
 */

const { loadConfig } = require('../src/util/config');

const cfg = loadConfig({ profile: null });
const MOD_PORT = cfg.agent.clientMod.port || 8899;
const STATUS_PORT = cfg.agent.web.port || (cfg.server.bridgePort || 8765) + 1;
const MOD = `http://127.0.0.1:${MOD_PORT}`;
const STATUS = `http://127.0.0.1:${STATUS_PORT}`;

const findings = [];
function record(link, ok, detail) {
  findings.push({ link, ok, detail });
  process.stdout.write(`  ${ok === true ? 'OK  ' : ok === false ? 'FAIL' : '??  '}  ${link}${detail ? ` - ${detail}` : ''}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    return { ok: false, error: aborted ? `timed out after ${timeoutMs}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function post(url, payload, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    return { ok: res.ok, body: await res.json().catch(() => null) };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  process.stdout.write('agent doctor - is the whole chain working?\n\n');
  process.stdout.write(`  mod   : ${MOD}\n  agent : ${STATUS}\n\n`);

  // ---------------------------------------------------------------- link 2
  process.stdout.write('1-2. client and control mod\n');
  const health = await get(`${MOD}/health`, 3000);
  if (!health.ok) {
    record('control mod reachable', false, health.error);
    process.stdout.write('\n  the client is not answering, so nothing else can be checked.\n');
    process.stdout.write('    - is the Forge client running?      npm run client:launch -- --server mc.example.com:25565\n');
    process.stdout.write('    - is the mod installed?             npm run client:install\n');
    process.stdout.write('    - did the mod fail to bind the port? look for "agent-client is NOT usable" in the client log\n');
    process.stdout.write('    - only ONE client may run: two instances fight over the port and the loser has no API\n');
    process.exitCode = 1;
    return;
  }
  record('control mod reachable', true, `mod=${health.body.mod} inWorld=${health.body.inWorld} requests=${health.body.requests}`);

  // ---------------------------------------------------------------- link 3
  const state = await get(`${MOD}/state`);
  if (!state.ok || !state.body || state.body.ready !== true) {
    record('world state readable', false, state.error || 'the client reports ready=false (still loading?)');
    process.exitCode = 1;
    return;
  }
  const s = state.body;
  const cells = s.blocks && s.blocks.cells ? Object.keys(s.blocks.cells).length : 0;
  record('world state readable', true, `pos=(${Math.round(s.position.x)},${Math.round(s.position.y)},${Math.round(s.position.z)}) hp=${s.health} cells=${cells}`);
  record('character is alive', s.dead !== true, s.dead ? 'the character is DEAD - click 重生 in the game window, then resume' : 'alive');
  record('block scan present', cells > 1000, cells > 1000 ? `${cells} cells (enough for A*)` : 'the scan is empty - the world may still be loading');

  // ------------------------------------------------------- auth (best effort)
  const chat = await get(`${MOD}/chatlog?n=20`);
  const lines = (chat.ok && chat.body && chat.body.lines) || [];
  const joined = lines.join('\n');
  const loggedIn = /Вход успешен|Добро пожаловать|success(fully)? logged|Авторизация успешна|已登录/i.test(joined);
  const notLoggedIn = /Сначала авторизуйся|недоступен до входа|login first|请先登录/i.test(joined);
  record(
    'authentication',
    loggedIn ? true : notLoggedIn ? false : null,
    loggedIn
      ? 'the server confirmed a login recently'
      : notLoggedIn
        ? 'the server said "log in first" - type /login <your-password> in the game chat (never /register)'
        : 'no login evidence in the recent chat log - if commands do nothing, try /login <your-password>'
  );

  // ---------------------------------------------------------------- link 4
  process.stdout.write('\n3. can the game accept input?  (this is where "it will not move" usually lives)\n');
  if (s.screenOpen === undefined) {
    record(
      'no GUI screen open',
      null,
      'this client runs an older mod build that does not report screens - restart the client to get the check'
    );
  } else {
    record(
      'no GUI screen open',
      s.screenOpen !== true,
      s.screenOpen === true
        ? `a screen is OPEN (${s.screen}) - Minecraft ignores movement input while any screen is open. Press ESC / close it.`
        : 'no screen open'
    );
    record(
      'game window focused',
      s.windowFocused !== false,
      s.windowFocused === false ? 'the window is not focused (mouseGrabbed=false) - click the game window' : 'focused'
    );
  }

  // A real walk: the only way to be sure input is being applied.
  //
  // Deliberately more than one attempt. A single probe produced a false alarm the first time
  // this ran: the client was mid-interaction with a human at that instant, did not move, and
  // the check blamed "input ignored" - while the very same command moved the character three
  // seconds later. One sample from a live game is not evidence; three are.
  if (s.screenOpen === true) {
    record(
      'the client actually walks when told',
      false,
      `skipped: a screen is open (${s.screen}), and Minecraft ignores movement input while any screen is open. Close it and re-run.`
    );
  } else {
    const start = { x: s.position.x, y: s.position.y, z: s.position.z };
    const headings = [
      [2, 0],
      [0, 2],
      [-2, 0],
      [0, -2]
    ];
    let best = { moved: 0, heading: null };
    const attempts = [];

    for (const [dx, dz] of headings) {
      await post(`${MOD}/command`, { command: 'stop' });
      await sleep(350);
      const before = (await get(`${MOD}/state`, 3000)).body;
      if (!before) continue;
      const target = { x: Math.round(before.position.x + dx), y: Math.round(before.position.y), z: Math.round(before.position.z + dz) };
      await post(`${MOD}/command`, { command: `moveto ${target.x} ${target.y} ${target.z} 1` });

      let moved = 0;
      for (let i = 0; i < 6; i += 1) {
        await sleep(600);
        const now = await get(`${MOD}/state`, 3000);
        if (!now.ok || !now.body || !now.body.position) continue;
        moved = Math.hypot(now.body.position.x - before.position.x, now.body.position.z - before.position.z);
        if (moved > 0.8) break;
      }
      await post(`${MOD}/command`, { command: 'stop' });
      attempts.push(`${dx},${dz}:${moved.toFixed(1)}b`);
      if (moved > best.moved) best = { moved, heading: `${dx},${dz}` };
      if (best.moved > 0.8) break; // one good direction is enough
    }

    record(
      'the client actually walks when told',
      best.moved > 0.3,
      best.moved > 0.3
        ? `moved ${best.moved.toFixed(2)} blocks toward ${best.heading} (tries: ${attempts.join(' ')})`
        : `no direction moved (tries: ${attempts.join(' ')}). Movement input is being ignored: close any open screen, click the game window, and check nothing is holding a key.`
    );
    void start;
  }

  // ---------------------------------------------------------------- link 5
  process.stdout.write('\n4. agent process\n');
  const ui = await get(`${STATUS}/ui/state`, 4000);
  if (!ui.ok) {
    record('agent reachable', false, `${ui.error} - start it with: npm run agent:client`);
  } else {
    const u = ui.body;
    record('agent reachable', true, `body=${u.identity.bodyKind} ready=${u.identity.bodyReady}`);
    record('agent is attached to the mod', u.identity.bodyReady === true, u.identity.bodyReady ? 'attached' : 'the agent cannot see the client');
    record('brain is running', u.brain.running === true && u.brain.stopped !== true, u.brain.stopped ? `stopped: ${u.brain.stoppedReason} (send resume)` : `running, queue=${u.brain.queueLength}`);
    record('llm configured', u.llm.enabled === true, u.llm.enabled ? `${u.llm.model}, ${u.llm.tokensToday} tokens today` : `${u.llm.disabledReason} - the regex router still works`);
  }

  // ---------------------------------------------------------------- verdict
  const failed = findings.filter((f) => f.ok === false);
  const unknown = findings.filter((f) => f.ok === null);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  if (!failed.length && !unknown.length) {
    process.stdout.write('VERDICT: the whole chain is working. Try a command:\n');
    process.stdout.write('  in game chat : !chop 8      (or the persona dialogue trigger)\n');
    process.stdout.write(`  in the panel : http://127.0.0.1:${STATUS_PORT}/panel\n`);
    return;
  }
  process.stdout.write(`VERDICT: ${failed.length} problem(s)${unknown.length ? `, ${unknown.length} unknown` : ''}.\n`);
  for (const f of failed) process.stdout.write(`  - ${f.link}: ${f.detail}\n`);
  for (const u of unknown) process.stdout.write(`  ? ${u.link}: ${u.detail}\n`);
  // Only a real failure sets a non-zero exit code. "Unknown" means the check could not run
  // (usually an older mod build), which is not a fault in the current setup.
  process.exitCode = failed.length ? 1 : 0;
})().catch((err) => {
  process.stdout.write(`doctor crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
