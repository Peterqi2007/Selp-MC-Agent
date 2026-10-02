'use strict';

/**
 * Live end-to-end probe of the running agent.
 *
 * Assumes `npm run agent:client` is already up on the status port. It exercises, in order:
 *
 *   1. the HTTP control panel (`/panel`, `/ui/state`, `/llm`)
 *   2. channel A on real hardware: a `!status` line is typed into the real chat box through
 *      the mod, the agent's chat poller must pick it up and answer in game
 *   3. the emergency stop, with its latency
 *
 * Step 2 is the interesting one. The plan's P0 assumption is that the player and the bot
 * share one account, so the chat log carries no sender - which means the only way to prove
 * the input pipeline works without a human at the keyboard is to type as that account. The
 * line is not one the agent ever says, so the echo filter must let it through; if the filter
 * were broken, the agent would instead ignore it (or answer itself forever).
 *
 * Usage: node scripts/live-probe.js [--status-port 8766] [--mod-port 8899]
 */

const args = process.argv.slice(2);
function valueOf(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const next = args[i + 1];
  return !next || next.startsWith('--') ? null : next;
}

const STATUS_PORT = Number(valueOf('--status-port')) || 8766;
const MOD_PORT = Number(valueOf('--mod-port')) || 8899;
const STATUS = `http://127.0.0.1:${STATUS_PORT}`;
const MOD = `http://127.0.0.1:${MOD_PORT}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  process.stdout.write('live agent probe\n\n');

  // ---------------------------------------------------------------- panel
  process.stdout.write('1. control panel against the live agent\n');
  const html = await fetch(`${STATUS}/panel`).then((r) => r.text()).catch(() => '');
  check('GET /panel serves the page', /<!doctype html>/i.test(html), `${html.length} bytes`);

  const state = await get(`${STATUS}/ui/state`);
  check('GET /ui/state answers', state.status === 200, `status ${state.status}`);
  const s = state.body || {};
  check('body is attached through the control mod', s.identity && s.identity.bodyKind === 'clientmod', JSON.stringify(s.identity));
  check('live position reported', !!(s.world && s.world.position), JSON.stringify(s.world && s.world.position));
  check('block scan is NOT shipped to the panel', !JSON.stringify(s).includes('cells'), `${JSON.stringify(s).length} bytes`);
  check('LLM layer state is exposed', !!(s.llm && typeof s.llm.enabled === 'boolean'), `enabled=${s.llm && s.llm.enabled}`);

  const llm = await get(`${STATUS}/llm`);
  check('GET /llm answers', llm.status === 200 && Array.isArray(llm.body.capabilities), `${llm.body && llm.body.capabilities ? llm.body.capabilities.length : 0} capabilities`);

  // ------------------------------------------------------ channel A, live
  process.stdout.write('\n2. channel A on real hardware (a real chat line)\n');
  /**
   * A dead bot cannot be probed for chat: the client sits on the death screen and the server
   * may refuse the message. Rather than reporting a misleading failure, verify what a death
   * *should* look like (the E deliverable) and skip the chat step with a note. This branch
   * exists because it actually happened: the agent was shot by a Stray mid-chop while this
   * probe was being written.
   */
  const dead = !!(s.death && s.death.dead) || (s.world && s.world.health === 0);
  if (dead) {
    check('death was detected by the agent', !!(s.death && s.death.dead), JSON.stringify(s.death));
    check('all tasks were aborted (brain stopped)', s.brain.stopped === true, `stopped=${s.brain.stopped} reason=${s.brain.stoppedReason}`);
    check('the queue was cleared on death', s.brain.queueLength === 0, `queue=${s.brain.queueLength}`);
    check(
      'the death position and time were recorded',
      !!(s.death.lastDeath && s.death.lastDeath.position && s.death.lastDeath.at),
      JSON.stringify(s.death.lastDeath)
    );
    const deathBanner = await fetch(`${STATUS}/panel`).then((r) => r.text());
    check('the panel ships a death banner for this state', deathBanner.includes('id="death"') && deathBanner.includes('恢复运行'));
    process.stdout.write('  [note] chat cannot be probed while the client is on the death screen.\n');
    process.stdout.write('  [note] click "重生" in the game window, then re-run this probe for the chat test.\n');
  } else {
    await post(`${MOD}/command`, { command: 'chat/clear' }).catch(() => {});
    await fetch(`${MOD}/chatlog/clear`).catch(() => {});
    /**
     * Let the listener observe the empty buffer before typing.
     *
     * Clearing is a *shrink*, and the listener needs one poll to see it and reset its baseline;
     * typing into the same instant makes the new line indistinguishable from the tail of the
     * pre-clear window.
     */
    await sleep(1500);

    /**
     * Type a command as the player and require the *command itself* to be observed.
     *
     * The first version of this check only asked "did any reply ever appear", and it passed
     * while channel A was completely dead: replies from the operator's own API calls were
     * already in the list, so `replied` was true before the typed line had even been read. A
     * test that cannot fail is worse than no test. This one is specific - a *new* command must
     * appear in the listener's accepted list, and a *new* reply must follow it.
     */
    const marker = '!status';
    const before = await get(`${STATUS}/ui/state`);
    const repliesBefore = ((before.body && before.body.replies) || []).length;

    const typed = await post(`${MOD}/command`, { command: `chat ${marker}` });
    check('the probe line was typed into the game chat', !!(typed.body && typed.body.ok), JSON.stringify(typed.body));

    let sawCommand = false;
    let replied = false;
    let replyText = null;
    for (let i = 0; i < 14; i += 1) {
      await sleep(800);
      const live = await get(`${STATUS}/ui/state`);
      const inputs = (live.body && live.body.recentInputs) || [];
      if (inputs.some((r) => String(r.command || '').includes('status'))) sawCommand = true;
      const replies = (live.body && live.body.replies) || [];
      if (replies.length > repliesBefore) {
        replied = true;
        replyText = replies[replies.length - 1].text;
      }
      if (sawCommand && replied) break;
    }
    check(
      'the agent polled the chat log and recognised the typed command',
      sawCommand,
      sawCommand ? 'the command appeared in the accepted list' : 'the typed line never became a command - check the chat line format'
    );
    check('the agent answered it in game', replied, replyText || 'no NEW reply after typing');
    if (replyText) {
      const chatlog = await fetch(`${MOD}/chatlog?n=20`).then((r) => r.json()).catch(() => null);
      const echoed = ((chatlog && chatlog.lines) || []).some((l) => l.includes(replyText));
      check('the reply is visible in the real chat log', echoed, echoed ? 'found it in /chatlog' : JSON.stringify((chatlog && chatlog.lines) || []).slice(0, 2));
    }
  }

  // ------------------------------------------------------- emergency stop
  process.stdout.write('\n3. emergency stop\n');
  const started = Date.now();
  const stop = await post(`${STATUS}/emergency-stop`);
  const ms = Date.now() - started;
  check('emergency stop answered under 3s', ms < 3000, `${ms}ms`);
  check('every stage reported success', !!(stop.body && stop.body.ok), JSON.stringify(stop.body && stop.body.steps));

  const after = await get(`${STATUS}/ui/state`);
  check('queue is empty after the stop', !!(after.body && after.body.brain.queueLength === 0), `queue=${after.body && after.body.brain.queueLength}`);

  // Leave the agent paused but responsive: chat still works, the planner does not wander.
  const pause = await post(`${STATUS}/command`, { command: 'pause', priority: 'urgent' });
  check('the agent can still be commanded after a stop', !!(pause.body && pause.body.ok), JSON.stringify(pause.body));

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(62)}\nlive probe: ${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail || ''}\n`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
})().catch((err) => {
  process.stdout.write(`live probe crashed: ${err.stack}\n`);
  process.exit(1);
});
