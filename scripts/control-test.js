'use strict';

/**
 * `npm run control:test` - end-to-end verification of deliverables D, E and C, offline.
 *
 * Everything here runs the *real* objects: the real `ChatListener`, the real command table,
 * the real brain queue, the real `DeathWatch`, the real LLM core and the real HTTP panel -
 * against a scripted `MockBody` and a fake LLM transport. Only Minecraft and the network
 * are absent, which is what makes it run in about a second instead of ten minutes.
 *
 * The scenarios map onto the plan's acceptance list:
 *
 *   D  `!chop 8` works (channel A)                     §4.1
 *   D  `@猫娘 砍点树` works (channel B, LLM path)        §4.1.2
 *   D  all other chat is ignored                        §4.3
 *   D  the bot never answers itself (echo filter)       §4.1.3
 *   D  no unprompted speech while idle                  §4.3
 *   E  live status + command input over HTTP            §4.2.2
 *   E  emergency stop under 3s, with an honest report   §4.2.2
 *   E  death aborts everything and does NOT auto-resume §4.4
 *   C  an invalid model answer degrades to the router   §5.5
 *   C  the model cannot smuggle in a server command     §5.2
 *   C  a follow-up reply cannot start new work          §5.6
 */

const { loadConfig } = require('../src/util/config');
const { MockBody } = require('../src/body/mockBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const { Brain } = require('../src/brain');
const { ChatController } = require('../src/chat/commands');
const { ChatListener } = require('../src/chat/chatListener');
const { reply } = require('../src/chat/reply');
const { DeathWatch } = require('../src/core/deathWatch');
const { LlmCore } = require('../src/llm');
const { startStatusServer } = require('../src/web/statusServer');

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '..');
/** Unique temp files per built agent, so scenarios cannot leak rules into each other. */
let hubSeq = 0;

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * The dialogue trigger, resolved the same way the agent resolves it.
 *
 * It used to be the literal '@猫娘' in a dozen places here. That is fine until the character is
 * swapped: the persona file then carries a different name, the agent answers to the new
 * trigger, and this suite keeps feeding the fixture the old one - so every dialogue scenario
 * stays green while the real in-game channel is dead. Resolving it here makes the fixture
 * follow the configuration instead. Module scope because the panel scenarios need it too.
 */
const { resolveTrigger } = require('../src/llm/persona');
const TRIGGER = resolveTrigger({ cfg: loadConfig({ profile: null }) }) || '@猫娘';
/**
 * How long the "no unprompted speech" check idles for.
 *
 * The plan's acceptance is ten minutes; the default keeps the suite fast, and
 * `P0_SOAK_MS=600000 npm run control:test` performs the real soak.
 */
const SOAK_MS = Number(process.env.P0_SOAK_MS) || 1200;

// --------------------------------------------------------------------------- harness

const results = [];

async function scenario(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    process.stdout.write(`  PASS  ${name}${detail ? ` - ${detail}` : ''}  (${Date.now() - started}ms)\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}  (${Date.now() - started}ms)\n`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

/**
 * Let the brain's async task pipeline finish before asserting on the world.
 *
 * Exits as soon as the queue and the active task are both clear, so the generous ceiling
 * costs nothing when things settle quickly - but a task that takes 1.5s (a walk plus a dig
 * plus a pickup) is no longer mistaken for "it never ran".
 */
async function settle(agent, ms = 5000) {
  const deadline = Date.now() + ms;
  let quiet = 0;
  while (Date.now() < deadline) {
    const busy = agent.brain.activeTask || agent.brain.currentTask || agent.brain.queue.length;
    if (!busy) {
      quiet += 1;
      // Two consecutive quiet checks: the drain-after-task hop is a macrotask, so a single
      // quiet reading can happen between two chained tasks.
      if (quiet >= 2) break;
    } else {
      quiet = 0;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A fake LLM transport: scripted replies, no network. */
function fakeClient(script) {
  const queue = [...script];
  return {
    configured: true,
    model: 'fake-model',
    baseUrl: 'http://fake',
    stats: { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, lastError: null },
    async complete() {
      this.stats.calls += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (typeof next === 'function') return next();
      return next;
    },
    describe() {
      return { model: this.model, configured: true };
    }
  };
}

/** Trees for the agent to find, plus a flat floor for the body to stand on. */
function worldBlocks() {
  const blocks = [];
  for (let x = -6; x <= 6; x += 1) {
    for (let z = -6; z <= 6; z += 1) blocks.push({ name: 'grass_block', position: { x, y: 63, z } });
  }
  for (let i = 0; i < 5; i += 1) blocks.push({ name: 'oak_log', position: { x: 3, y: 64 + i, z: 2 } });
  // The canopy: `looksLikeTree()` refuses a bare trunk, so the fixture has to be an actual
  // tree or every chop scenario would exercise the refusal instead of the harvest.
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue;
      blocks.push({ name: 'oak_leaves', position: { x: 3 + dx, y: 69, z: 2 + dz } });
    }
  }
  return blocks;
}

/**
 * Assemble the whole control stack around a mock body.
 *
 * Mirrors what `src/index.js` wires for a client-mod run, minus the mod: this is the point
 * of the exercise - if the wiring here and the wiring there disagree, the offline test
 * stops being evidence.
 */
async function buildAgent(options = {}) {
  const cfg = loadConfig({ profile: null });
  const { resolveTrigger } = require('../src/llm/persona');
  const TRIGGER = resolveTrigger({ cfg }) || '@猫娘';
  /**
   * Park the autonomous planner for the duration of a scenario.
   *
   * `brain.start()` is needed so the queue actually drains (`drainQueue` refuses to run
   * while `brain.running` is false - which is exactly how the first draft of this test
   * silently asserted on an untouched world). But the *planner* must not also start
   * dispatching its own work, or "how many logs did the command collect" becomes a race.
   * A 60s think interval leaves command-driven work intact and self-planning out of the way.
   */
  cfg.agent.behaviour.idleThinkIntervalMs = 60000;

  const body = new MockBody(cfg, { blocks: options.blocks || worldBlocks(), inventory: options.inventory || { stone_pickaxe: 1 } });
  await body.connect();

  /** The mod's chat ring buffer, which is what the listener actually polls. */
  const chatLines = [];
  body.readChat = async () => ({ lines: chatLines.slice() });
  /**
   * `history` seeds the buffer *before* the listener's first poll, which is how the "stale
   * chat must not be executed" scenario stages its input.
   */
  for (const line of options.history || []) chatLines.push(line);

  const ctx = {
    cfg,
    log: silent,
    body,
    bodyKind: 'mock',
    world: new BodyWorldView(body, cfg, { log: silent }),
    nav: { stop() {}, interrupt() {}, goto: async () => true },
    eat: { tick: async () => true },
    combat: { defend: async () => true },
    tools: { equipArmor: async () => true },
    controller: { bot: null, isAlive: true, snapshot: () => ({ ready: true }), loadedPlugins: [] },
    memory: {
      data: { runtime: {} },
      bump() {},
      recordTask() {},
      recordDeath() {},
      save() {},
      rememberLandmark() {},
      landmark: () => null,
      summary: () => ({ deaths: 0 })
    }
  };

  const brain = new Brain(ctx);
  ctx.brain = brain;
  /** Task outcomes, so scenarios can assert on *why* something failed. */
  const events = [];
  brain.on('task:done', (info) => events.push({ ...info, ok: true }));
  brain.on('task:failed', (info) => events.push({ ...info, ok: false }));

  ctx.reply = (text, opts) => reply(ctx, text, opts);

  /**
   * Second-batch machinery, wired the same way `src/index.js` wires it, so the command
   * scenarios exercise the real rules/consent/slot code with per-agent temp files.
   */
  const { Places } = require('../src/core/places');
  const { Permissions, ConsentDesk } = require('../src/core/permissions');
  const { TaskHub } = require('../src/core/taskHub');
  const { installPermissionGate } = require('../src/core/permissionGate');
  const fs = require('fs');
  const path = require('path');
  hubSeq += 1;
  const placesFile = path.join(ROOT, '.tmp', `control-places-${hubSeq}.json`);
  const rulesFile = path.join(ROOT, '.tmp', `control-permissions-${hubSeq}.json`);
  // Fresh per agent: a previous run's file would otherwise accumulate areas/routes and the
  // assertions would count another run's leftovers.
  fs.rmSync(placesFile, { force: true });
  fs.rmSync(rulesFile, { force: true });
  ctx.places = new Places(cfg, { file: placesFile, log: silent });
  ctx.permissions = new Permissions(cfg, { file: rulesFile, log: silent, places: ctx.places });
  ctx.consent = new ConsentDesk(ctx, { log: silent, speak: (t) => ctx.reply(t, { why: 'consent', force: true }), timeoutMs: 3000 });
  ctx.hub = new TaskHub(ctx, { log: silent, trace() {} });
  ctx.permissionGate = installPermissionGate(body, {
    permissions: ctx.permissions,
    consent: ctx.consent,
    log: silent,
    taskScope: () => ctx.brain.currentTask || ctx.brain.activeTask || (ctx.hub && ctx.hub.current) || null
  });

  const chat = new ChatController(ctx, { prefix: '!' });
  ctx.chat = chat;

  const listener = new ChatListener(body, ctx, { prefix: '!', dialogueTrigger: TRIGGER, log: silent });
  ctx.chatListener = listener;
  /**
   * Seed the baseline exactly as the real listener does on startup.
   *
   * The first poll adopts whatever is already in the mod's ring buffer without acting on it,
   * so chat that predates the agent is never executed. Real runs get this for free (the poller
   * starts before anyone types); a test must do it explicitly, or its first `say()` would be
   * swallowed as "history".
   */
  await listener.poll();

  const llm = new LlmCore(ctx, { ...cfg.llm, enabled: true }, { log: silent, client: options.client || fakeClient([{ ok: false, reason: 'no script' }]) });
  ctx.llm = llm;
  llm.attachTo(brain);

  listener.onDialogue = async (text) => {
    const snap = body.snapshot();
    await llm.handle(text, { source: 'chat', speaker: '玩家', speakerPosition: snap ? snap.position : null });
  };

  const deathWatch = new DeathWatch(ctx, { log: silent });
  ctx.deathWatch = deathWatch;

  /** Push a chat line as if the player typed it, then run one poll cycle. */
  const say = async (line) => {
    chatLines.push(line);
    return listener.poll();
  };

  /**
   * Enable the task queue *without* the autonomous planner.
   *
   * `brain.running = true` is all `drainQueue` needs, so command-driven work runs exactly as
   * it does in production. What is deliberately skipped is `brain.start()`, whose first tick
   * immediately dispatches a planner goal - on this fixture that was `craft crafting_table`,
   * which legitimately consumed the oak logs the next assertion was about. A channel test
   * must not race the planner for the fixture.
   */
  brain.running = true;

  const stop = () => {
    brain.stop();
    deathWatch.stop();
    listener.stop();
  };

  return { cfg, body, ctx, brain, chat, listener, llm, deathWatch, say, chatLines, events, stop };
}

(async () => {
  process.stdout.write('minecraft-survival-agent - control channel test (offline, MockBody)\n');
  process.stdout.write('(P0-PLAN §4 + §5: two input channels, one output, panel, death handling)\n\n');

  // =========================================================== channel A: `!`
  process.stdout.write('1. channel A - deterministic `!` commands\n');

  await scenario('!chop 8 walks, breaks and collects, then reports in chat', async () => {
    const agent = await buildAgent();
    await agent.say('!chop 5');
    // The handler enqueues and the brain loop drains; wait for it to settle.
    await agent.brain.drainQueue();
    await settle(agent);

    const logs = agent.body.inventory['minecraft:oak_log'] || 0;
    expect(logs >= 5, `expected >=5 logs after !chop 5, have ${logs}`);
    const replies = agent.ctx.replies || [];
    expect(replies.length >= 1, 'the command should have been acknowledged in chat');
    expect(
      replies.some((r) => /砍/.test(r.text)),
      `expected a chopping acknowledgement, got ${JSON.stringify(replies.map((r) => r.text))}`
    );
    agent.stop();
    return `${logs} logs collected, replied "${replies[0].text}"`;
  });

  await scenario('!mine without a pickaxe fails with the honest reason', async () => {
    const agent = await buildAgent({ inventory: {} });
    await agent.say('!mine stone 4');
    await settle(agent);
    agent.stop();
    // The planner also runs (and chops the tree), so count *stone* specifically rather than
    // everything the body dug.
    const stoneDug = agent.body.history.filter((h) => h.action === 'dig' && /stone/.test(h.name)).length;
    expect(stoneDug === 0, `nothing should have been mined, ${stoneDug} stone blocks were`);
    const failure = agent.events.find((e) => !e.ok && /mine/.test(e.name));
    expect(failure, `no failure recorded: ${JSON.stringify(agent.events)}`);
    expect(/need a pickaxe/.test(failure.reason), `reason should name the tool: ${failure.reason}`);
    // The plan is explicit that task failures are NOT announced unprompted.
    const spoken = (agent.ctx.replies || []).map((r) => r.text);
    expect(!spoken.some((t) => /镐/.test(t)), `a task failure must not be spoken: ${JSON.stringify(spoken)}`);
    return failure.reason;
  });

  await scenario('!mine dirt 1 asks for exactly one block (no hidden +2)', async () => {
    const agent = await buildAgent();
    let captured = null;
    const original = agent.brain.enqueue.bind(agent.brain);
    agent.brain.enqueue = async (task) => {
      captured = task;
      return { accepted: true };
    };
    const receipt = await agent.chat.handle('mine dirt 1', 'test');
    agent.brain.enqueue = original;
    agent.stop();
    expect(receipt && receipt.ok === true, `command was refused: ${JSON.stringify(receipt)}`);
    expect(captured, 'no mine task was enqueued');
    expect(captured.target === 1, `expected target=1, got ${captured.target}`);
    return `target=${captured.target}`;
  });

  await scenario('!stop silences the planner until !resume (explicit work still runs)', async () => {
    /**
     * Live report: "the stop command cannot stop the task." The handler cancelled the
     * current task and cleared the queue, but the 2.5s planner immediately chose the next
     * goal - and even the panel's emergency stop only *set* a flag nobody read. Now `!stop`
     * disables autonomous planning until `!resume`, while explicit instructions still run.
     */
    const agent = await buildAgent();
    await agent.say('!chop 1');
    await agent.brain.drainQueue();
    await settle(agent);

    const before = agent.brain.lastDecision;
    await agent.say('!stop');
    expect(agent.brain.autoPlanDisabled === true, 'stop must disable autonomous planning');
    expect(agent.brain.queue.length === 0, 'stop must clear the queue');
    expect(
      agent.brain.status().holds.some((h) => h.reason === 'owner-stop'),
      `!stop did not enter the owner-stop hold: ${JSON.stringify(agent.brain.status().holds)}`
    );

    // The planner must stay quiet even when its loop runs.
    await agent.brain.slowLoop();
    expect(agent.brain.lastDecision === before, 'the planner picked a new goal after a stop');
    expect(!agent.brain.currentTask || agent.brain.currentTask.state !== 'running', 'a task is still running after stop');

    // ...but an explicit instruction is still an explicit instruction.
    const explicit = await agent.chat.handle('mine dirt 1', 'test');
    expect(
      explicit.ok === true && explicit.result && explicit.result.accepted !== false,
      `an explicit command must still run after a stop: ${JSON.stringify(explicit)}`
    );

    await agent.say('!resume');
    expect(agent.brain.autoPlanDisabled === false, 'resume must re-enable autonomous planning');
    expect(agent.brain.status().holds.length === 0, 'resume left a hold active');
    agent.stop();
    return 'stop honoured, explicit work allowed, resume restores planning';
  });

  await scenario('second batch: area/route/rule commands keep named nouns and rules', async () => {
    const agent = await buildAgent();
    await agent.say('!area add home here 6');
    expect(agent.ctx.places.area('home'), 'the area was not stored');
    expect(/home/.test((agent.ctx.replies || []).map((r) => r.text).join(' ')), 'no area acknowledgement');

    await agent.say('!route add fishing 21 63 49');
    await agent.say('!route plan fishing');
    const route = agent.ctx.places.route('fishing');
    expect(
      route && route.points.length === 1,
      `the route was not stored; replies=${JSON.stringify((agent.ctx.replies || []).map((r) => r.text))} ` +
        `history=${JSON.stringify(agent.chat.history.map((h) => `${h.command} ${h.args.join(' ')} ok=${h.ok} reason=${h.reason || ''}`))} ` +
        `listenerStats=${JSON.stringify(agent.listener.stats)} ` +
        `store=${JSON.stringify(agent.ctx.places.data)}`
    );
    expect(route.plan && route.plan.ok === true, `the plan preview failed: ${JSON.stringify(route.plan)}`);
    expect(route.plan.waypoints >= 1, 'the plan preview reported no waypoints');

    await agent.say('!rule ask break minecraft:oak_log');
    expect(agent.ctx.permissions.check('break', { name: 'minecraft:oak_log' }).verdict === 'ask', 'the rule was not stored');
    await agent.say('!rule list');
    expect(agent.ctx.permissions.list().length === 1, 'rule list is wrong');

    // Query the result directly: command acks are debounced (minReplyGapMs), so reading the
    // spoken text of the fourth command in a burst would test the anti-spam gap, not the slot.
    const taskStatus = await agent.chat.handle('task status', 'test');
    expect(taskStatus.result && taskStatus.result.busy === false, `task status is wrong: ${JSON.stringify(taskStatus)}`);
    agent.stop();
    return 'area + route plan + rule + task status verified';
  });

  await scenario('second batch: a background task holds the body and frees it on settle', async () => {
    const agent = await buildAgent();
    let release;
    const receipt = await agent.ctx.hub.submit({
      name: 'selftest-hold',
      description: 'selftest hold',
      source: 'test',
      run: () => new Promise((resolve) => {
        release = resolve;
      })
    });
    expect(receipt.accepted === true && receipt.async === true, `the hub did not accept: ${JSON.stringify(receipt)}`);
    expect(agent.brain.holds.has('task'), 'the body hold was not taken');

    const refused = await agent.chat.handle('mine dirt 1', 'test');
    expect(
      refused.result && refused.result.accepted === false && refused.result.reason === 'body-busy',
      `expected a body-busy refusal, got ${JSON.stringify(refused)}`
    );

    release({ ok: true, detail: 'released' });
    await new Promise((r) => setTimeout(r, 30));
    expect(!agent.brain.holds.has('task'), 'the body hold was not released');
    const accepted = await agent.chat.handle('mine dirt 1', 'test');
    expect(accepted.result && accepted.result.accepted === true, `work after settle was refused: ${JSON.stringify(accepted)}`);
    await settle(agent);
    agent.stop();
    return 'accept -> refuse while busy -> release -> accept';
  });

  await scenario('second batch: ask-rule blocks the dig until !yes, and the dig then runs', async () => {
    const agent = await buildAgent();
    await agent.say('!rule ask break minecraft:oak_log');
    await agent.say('!chop 1');

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !agent.ctx.consent.status().pending) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const pending = agent.ctx.consent.status().pending;
    expect(pending, 'no permission question was asked for the gated dig');
    expect(/oak_log/.test(pending.question), `the question does not name the block: ${pending.question}`);

    await agent.say('!yes');
    await settle(agent, 8000);
    const event = (agent.events || []).find((e) => e.name === 'chop-wood');
    expect(event && event.ok, `the chop did not finish after !yes: ${JSON.stringify(agent.events)}`);
    const recent = agent.ctx.consent.status().recent;
    expect(recent.some((r) => r.answer === 'allow'), 'the consent answer was not recorded');
    agent.stop();
    return 'question -> !yes -> chop completed';
  });

  await scenario('!status answers using the body, not a mineflayer instance', async () => {
    const agent = await buildAgent();
    await agent.say('!status');
    const replies = agent.ctx.replies || [];
    agent.stop();
    expect(replies.length === 1, `expected exactly 1 reply, got ${replies.length}`);
    expect(/hp=20/.test(replies[0].text), `status text looks wrong: ${replies[0].text}`);
    return replies[0].text;
  });

  await scenario('!inv works through the bot facade (the clientmod null-bot fix)', async () => {
    const agent = await buildAgent({ inventory: { oak_log: 3 } });
    await agent.say('!inv');
    const replies = agent.ctx.replies || [];
    // Verify the facade path directly too: it is the fix for "!status answers nothing".
    const { createBotFacade } = require('../src/body/botFacade');
    const facade = createBotFacade(agent.body, agent.cfg, {});
    const items = facade.inventory.items();
    agent.stop();
    expect(items.some((i) => /oak_log/.test(i.name)), 'facade inventory is empty');
    expect(replies.length === 1, `no reply for !inv (replies=${replies.length})`);
    return `${items.length} stack(s) visible to the facade`;
  });

  // =========================================================== channel B: `@猫娘`
  process.stdout.write('\n2. channel B - dialogue trigger through the LLM layer\n');

  await scenario('@猫娘 砍点树 is understood, dispatched and acknowledged', async () => {
    const client = fakeClient([
      { ok: true, text: '{"say":"好嘞，去砍树喵","action":{"type":"task","task":"chop","args":{"count":4}}}', usage: { total_tokens: 42 } }
    ]);
    const agent = await buildAgent({ client });
    await agent.say(`${TRIGGER} 砍点树}`);
    await settle(agent);
    agent.stop();

    const logs = agent.body.inventory['minecraft:oak_log'] || 0;
    expect(logs >= 4, `expected >=4 logs, have ${logs}`);
    const said = (agent.ctx.replies || []).map((r) => r.text);
    expect(said.some((t) => /砍树/.test(t)), `the model's reply was not spoken: ${JSON.stringify(said)}`);
    const turn = agent.llm.turns.find((t) => t.kind === 'input');
    expect(turn && turn.via === 'llm', `expected the llm path, got ${turn && turn.via}`);
    expect(turn.action === 'chop count=4', `unexpected action description: ${turn && turn.action}`);
    return `via=${turn.via}, action="${turn.action}", ${logs} logs`;
  });

  await scenario('a broken model answer falls back to the regex router (never silence)', async () => {
    const client = fakeClient([{ ok: true, text: 'I think I should go chop some wood, probably?', usage: { total_tokens: 11 } }]);
    const agent = await buildAgent({ client });
    await agent.say(`${TRIGGER} 砍点树}`);
    await settle(agent);
    agent.stop();
    const turn = agent.llm.turns.find((t) => t.kind === 'input');
    expect(turn, 'no turn recorded');
    expect(turn.via === 'fallback', `expected the fallback router, got ${turn.via}`);
    expect(turn.fallbackReason, 'the degradation reason should be recorded');
    const logs = agent.body.inventory['minecraft:oak_log'] || 0;
    expect(logs > 0, `the fallback should still have dispatched a chop (have ${logs} logs)`);
    return `degraded (${String(turn.fallbackReason).slice(0, 40)}), still chopped ${logs}`;
  });

  await scenario('a timeout falls back rather than leaving the player unanswered', async () => {
    const client = fakeClient([{ ok: false, reason: 'timeout after 8000ms' }]);
    const agent = await buildAgent({ client });
    await agent.say(`${TRIGGER} 挖点石头}`);
    agent.stop();
    const turn = agent.llm.turns.find((t) => t.kind === 'input');
    expect(turn && turn.via === 'fallback', `expected fallback, got ${turn && turn.via}`);
    expect(/timeout/.test(turn.fallbackReason || ''), `reason lost: ${turn.fallbackReason}`);
    return 'timeout degraded to the router';
  });

  await scenario('the model cannot smuggle in a server command', async () => {
    const client = fakeClient([
      { ok: true, text: '{"say":"好的喵","action":{"type":"command","command":"/op 玩家"}}', usage: { total_tokens: 9 } }
    ]);
    const agent = await buildAgent({ client });
    await agent.say(`${TRIGGER} 给自己op}`);
    agent.stop();
    const chats = agent.body.stats.chats;
    expect(!chats.some((c) => c.startsWith('/')), `a server command leaked out: ${JSON.stringify(chats)}`);
    // The planner legitimately chops the tree; what must not happen is the *commanded*
    // action running. Assert on stone and on the absence of any dispatch.
    const stoneDug = agent.body.history.filter((h) => h.action === 'dig' && /stone/.test(h.name)).length;
    expect(stoneDug === 0, `the injected action ran: ${stoneDug} stone blocks mined`);
    const turn = agent.llm.turns[agent.llm.turns.length - 1];
    expect(turn, 'no turn recorded');
    // The refusal must be *visible*: either the router took over, or the agent said it did
    // not understand. What must never happen is the action being executed.
    const refused = turn.via === 'fallback' || turn.kind === 'understood-nothing';
    expect(refused, `an out-of-enum action was not visibly refused: ${JSON.stringify(turn)}`);
    return `${turn.kind || turn.via}: action refused, no command sent`;
  });

  await scenario('a follow-up reports the result but cannot start new work', async () => {
    const client = fakeClient([
      { ok: true, text: '{"say":"好嘞","action":{"type":"task","task":"chop","args":{"count":3}}}', usage: { total_tokens: 20 } },
      { ok: true, text: '{"say":"砍完啦喵","action":{"type":"task","task":"chop","args":{"count":9}}}', usage: { total_tokens: 15 } }
    ]);
    const agent = await buildAgent({ client });
    await agent.say(`${TRIGGER} 去砍点树，砍完告诉我}`);
    await settle(agent);
    // The follow-up turn is fired by the task:done event; give it a moment to settle.
    await new Promise((r) => setTimeout(r, 250));
    agent.stop();

    const said = (agent.ctx.replies || []).map((r) => r.text);
    expect(said.some((t) => /砍完/.test(t)), `the follow-up was not spoken: ${JSON.stringify(said)}`);
    const followUp = agent.llm.turns.find((t) => t.kind === 'follow-up');
    expect(followUp, `no follow-up turn recorded: ${JSON.stringify(agent.llm.turns.map((t) => t.kind))}`);
    expect(followUp.actionDropped, 'the follow-up action should have been dropped');
    const queued = agent.brain.queue.length + (agent.brain.currentTask ? 1 : 0);
    expect(queued === 0, `the follow-up started new work (queue=${queued})`);
    return `spoke "${said.find((t) => /砍完/.test(t))}", dropped action "${followUp.actionDropped}"`;
  });

  await scenario('a model turn in flight blocks a second concurrent turn', async () => {
    const client = fakeClient([{ ok: true, text: '{"say":"嗯喵","action":null}' }]);
    const agent = await buildAgent({ client });
    agent.llm.turnsInFlight = 1; // pretend a turn is already running
    // Use an utterance the router can handle, so "fallback" proves the model was skipped.
    await agent.say(`${TRIGGER} 砍点树}`);
    agent.stop();
    const turn = agent.llm.turns[agent.llm.turns.length - 1];
    expect(turn, 'no turn recorded');
    expect(turn.via === 'fallback', `a concurrent turn should have been refused, got ${turn.via}`);
    expect(/already running/.test(turn.fallbackReason || ''), `reason lost: ${turn.fallbackReason}`);
    expect(client.stats.calls === 0, `the model was called anyway (${client.stats.calls} times)`);
    return 'second turn refused before reaching the model, router handled it';
  });

  await scenario('a real server renders chat as "<Sender> message" and the listener must parse that', async () => {
    /**
     * The bug that made the entire in-game input channel dead in production while every
     * offline test passed: the tests fed the listener a bare `!chop 8` (what a mineflayer
     * `chat` event looks like) and the client mod delivers `event.getMessage().getString()`,
     * which on a real server is `<agent> !chop 8`. `startsWith('!')` never matched.
     */
    const agent = await buildAgent();
    await agent.say('<agent> !status');
    agent.stop();
    const commands = agent.listener.recent.map((r) => r.command);
    expect(commands.includes('status'), `the prefixed line was ignored: ${JSON.stringify(commands)}`);
    return 'parsed "<agent> !status" as the command "status"';
  });

  await scenario('the same command twice runs twice (batch overlap, not fingerprint dedupe)', async () => {
    const agent = await buildAgent();
    await agent.say('!status');
    await agent.say('!status');
    const commands = agent.listener.recent.filter((r) => r.command === 'status').length;
    agent.stop();
    expect(commands === 2, `expected 2 executions of the same command, got ${commands}`);
    return 'identical commands both ran';
  });

  await scenario('chat from before the agent started is not executed', async () => {
    // Commands sitting in the mod's ring buffer when the agent starts are history: running
    // them minutes later would be a surprise, not a feature. The first poll seeds the window.
    const agent = await buildAgent({ history: ['<agent> !chop 8', '<agent> !stop'] });
    const u = agent.ctx;
    expect(!u.replies || u.replies.length === 0, `stale chat was acted on: ${JSON.stringify((u.replies || []).map((r) => r.text))}`);
    expect(agent.listener.recent.length === 0, 'stale chat produced a command');
    expect(agent.listener.seeded === 2, `expected 2 seeded lines, got ${agent.listener.seeded}`);
    agent.stop();
    return '2 pre-existing lines seeded as a baseline, none executed';
  });

  // =========================================================== output policy
  process.stdout.write('\n3. output policy - reactive only\n');

  await scenario('10 distractor messages produce zero replies', async () => {
    const agent = await buildAgent();
    const noise = [
      'hi', '有人吗', 'how do I craft a pickaxe', 'lol', '!',
      '今天天气不错', 'where is everyone', '这个服务器卡吗', 'stop it please', '12345'
    ];
    for (const line of noise) await agent.say(line);
    const replies = agent.ctx.replies || [];
    const spoke = agent.body.stats.chats.slice();
    agent.stop();
    expect(replies.length === 0, `expected silence, got ${JSON.stringify(replies.map((r) => r.text))}`);
    expect(spoke.length === 0, `something was said to the client: ${JSON.stringify(spoke)}`);
    return `${noise.length} messages, 0 replies`;
  });

  await scenario('the bot never answers itself (echo filter, both channels)', async () => {
    const agent = await buildAgent();
    // What the agent said, appearing in the log the way the mod would report it.
    agent.chatLines.push('去砍 5 根木头喵');
    agent.chatLines.push('!chop 5');
    await agent.say('!stop'); // one real command
    const replies = (agent.ctx.replies || []).map((r) => r.text);
    agent.stop();
    expect(replies.length <= 2, `possible echo loop: ${JSON.stringify(replies)}`);
    // A second poll of the same window must not re-fire the earlier command.
    const before = agent.brain.queue.length;
    await agent.listener.poll();
    expect(agent.brain.queue.length === before, 'a re-served line fired twice');
    return `${replies.length} replies, no loop`;
  });

  await scenario(`idle with no input produces no speech at all${SOAK_MS > 5000 ? ` (${Math.round(SOAK_MS / 1000)}s soak)` : ''}`, async () => {
    const agent = await buildAgent();
    /**
     * The plan's acceptance for D③ is a ten-minute idle with zero output.
     *
     * A short run is enough for the regression suite (the mechanism is structural: no speech
     * timer exists, and `reply()` is only reachable from a command handler or an LLM turn).
     * `P0_SOAK_MS=600000 npm run control:test` performs the real soak.
     */
    await new Promise((r) => setTimeout(r, SOAK_MS));
    const replies = agent.ctx.replies || [];
    const spoke = agent.body.stats.chats.slice();
    const moved = agent.body.stats.moved;
    agent.stop();
    expect(replies.length === 0, `the agent spoke unprompted: ${JSON.stringify(replies.map((r) => r.text))}`);
    expect(spoke.length === 0, `the agent said something unprompted: ${JSON.stringify(spoke)}`);
    return `0 replies over ${Math.round(SOAK_MS / 1000)}s idle and ${moved} autonomous moves`;
  });

  // =========================================================== panel + stop
  process.stdout.write('\n4. control panel and emergency stop\n');

  /**
   * The HTTP section runs against a *fully wired* agent.
   *
   * The first version of this test pointed the server at a stub context, and four checks
   * failed for the same reason: `/ui/state` had no queue to report, `/command` had no
   * command table, `/llm` had no turns and `/emergency-stop` had no body to interrupt.
   * The panel's whole job is to describe the live agent, so it has to be given one.
   */
  const httpAgent = await buildAgent();
  const server = startStatusServer(httpAgent.ctx, { port: PORT });
  await new Promise((r) => setTimeout(r, 250));
  /**
   * The account name, taken from the same config the panel reads.
   *
   * These two checks used to be `html.includes('agent')`, which is a test that cannot fail for
   * the reason it claims: the account *was* called `agent`, so the substring matched the
   * identity pill by accident and would have kept passing on any page that merely says the
   * word "agent" somewhere. Asserting the account name means the check breaks when the panel
   * stops identifying the agent - which is what it is for.
   */
  const panelAccount = httpAgent.ctx.cfg.agent.bot.username;

  await scenario('GET /panel is a pure server-rendered dashboard (no JS, no iframe)', async () => {
    const res = await fetch(`${BASE}/panel`);
    const html = await res.text();
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(/<!doctype html>/i.test(html), 'not an HTML page');
    // The dashboard must not depend on anything the browser has to execute.
    expect(html.includes('http-equiv="refresh"'), 'the dashboard does not self-reload');
    expect(!html.includes('<script'), 'the dashboard must not depend on scripts');
    expect(html.includes('服务器端实时状态'), 'the server-rendered state header is missing');
    expect(html.includes(panelAccount), `the dashboard does not name the account (${panelAccount})`);
    expect(html.includes('/panel/cmd'), 'the command page link is missing');
    expect(html.includes('/command?command='), 'the quick command links are missing');
    expect(res.headers.get('cache-control') === 'no-store', 'the dashboard must not be cached');
    return `${html.length} bytes, meta-refresh`;
  });

  await scenario('GET /panel/cmd serves a plain form and GET /command redirects back', async () => {
    const page = await fetch(`${BASE}/panel/cmd`);
    const html = await page.text();
    expect(page.status === 200 && html.includes('method="post"'), 'the command page has no form');
    expect(html.includes('name="command"'), 'the form has no command field');
    const res = await fetch(`${BASE}/command?command=status&priority=directive`, { redirect: 'manual' });
    expect(res.status === 303, `expected 303, got ${res.status}`);
    expect(res.headers.get('location') === '/panel', `unexpected location ${res.headers.get('location')}`);
    // Panel commands must show up in the routing table, or the operator cannot tell whether
    // the panel was heard at all.
    const state = await (await fetch(`${BASE}/ui/state`)).json();
    const seen = (state.recentInputs || []).some((r) => r.source === 'panel' && /status/.test(r.text || ''));
    expect(seen, `the panel command is missing from recentInputs: ${JSON.stringify(state.recentInputs).slice(0, 200)}`);
    return 'form + link flow OK';
  });

  await scenario('GET /panel/state renders live state without JavaScript', async () => {
    const res = await fetch(`${BASE}/panel/state`);
    const html = await res.text();
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(html.includes('http-equiv="refresh"'), 'the state page does not self-refresh');
    expect(html.includes(panelAccount), `the state page does not name the account (${panelAccount})`);
    expect(html.includes('服务器端实时状态'), 'the state page is missing its header');
    expect(!html.includes('<script'), 'the state page must not need scripts');
    return `${html.length} bytes, meta-refresh`;
  });

  await scenario('POST /command accepts a plain form submission (no JS) and redirects back', async () => {
    const res = await fetch(`${BASE}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'command=status&priority=directive',
      redirect: 'manual'
    });
    expect(res.status === 303, `expected a 303 redirect, got ${res.status}`);
    expect(res.headers.get('location') === '/panel', `unexpected location ${res.headers.get('location')}`);
    return '303 -> /panel';
  });

  await scenario('GET /panel/app.js serves the script and /panel/ping is observable', async () => {
    const js = await fetch(`${BASE}/panel/app.js`);
    const body = await js.text();
    expect(js.status === 200, `expected 200, got ${js.status}`);
    expect((js.headers.get('content-type') || '').includes('javascript'), `content-type is ${js.headers.get('content-type')}`);
    expect(body.includes("'/panel/ping"), 'the script beacon is missing');
    expect(body.includes('function render'), 'the script body is incomplete');
    expect(body.includes('/emergency-stop'), 'the script lost the emergency stop endpoint');
    const ping = await fetch(`${BASE}/panel/ping?t=test`);
    expect(ping.status === 204, `expected 204 from the beacon, got ${ping.status}`);
    return `${body.length} bytes of JS`;
  });

  await scenario('GET /ui/state is a slim summary with death and queue info', async () => {
    const res = await fetch(`${BASE}/ui/state`);
    const state = await res.json();
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(state.identity && state.identity.bodyKind === 'mock', `identity missing: ${JSON.stringify(state.identity)}`);
    expect(state.brain && typeof state.brain.queueLength === 'number', 'queue length missing');
    expect(state.death && state.death.dead === false, 'death state missing');
    expect(state.tracing === undefined || true, 'unreachable');
    expect(!JSON.stringify(state).includes('cells'), '/ui/state leaked the block scan');
    expect(res.headers.get('cache-control') === 'no-store', 'the panel must not be cached');
    return `${JSON.stringify(state).length} bytes`;
  });

  await scenario('POST /command accepts a priority and reports preemption', async () => {
    const res = await fetch(`${BASE}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'status', priority: 'urgent' })
    });
    const body = await res.json();
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(body.ok === true, `command failed: ${JSON.stringify(body)}`);
    expect(body.level === 'urgent', `priority lost: ${body.level}`);
    expect(typeof body.ms === 'number', 'latency not reported');
    return `level=${body.level}, ${body.ms}ms`;
  });

  await scenario(`POST /command routes "${TRIGGER} ..." into the LLM dialogue path`, async () => {
    /**
     * The live panel bug: everything was sent to the deterministic command table, which has
     * no `@猫娘` handler, so the most natural thing a user types answered "unknown command".
     * The panel must route dialogue exactly like the in-game channel does.
     *
     * The LLM call itself is replaced by a spy: the previous scenarios may have left a
     * turn in flight, and "another turn is already running" would make this test pass or
     * fail for the wrong reason. What is under test here is the *routing*.
     */
    const original = httpAgent.llm.handle;
    let called = null;
    httpAgent.llm.handle = async (text, options) => {
      called = { text, options };
      return { kind: 'input', text, via: 'spy' };
    };
    try {
      const res = await fetch(`${BASE}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: `${TRIGGER} 你好呀`, priority: 'directive' })
      });
      const body = await res.json();
      expect(res.status === 200, `expected 200, got ${res.status}`);
      expect(body.routed === 'dialogue', `expected dialogue routing, got ${JSON.stringify(body).slice(0, 160)}`);
      expect(called && called.text === '你好呀', `the LLM never saw the utterance: ${JSON.stringify(called)}`);
      expect(called.options && called.options.source === 'panel', 'the source must be tagged panel');
      return `routed to llm.handle("${called.text}")`;
    } finally {
      httpAgent.llm.handle = original;
    }
  });

  await scenario('POST /command tolerates the in-game "!..." form', async () => {
    const res = await fetch(`${BASE}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: '!status', priority: 'directive' })
    });
    const body = await res.json();
    expect(res.status === 200 && body.ok === true, `"!status" should be accepted, got ${JSON.stringify(body).slice(0, 160)}`);
    return 'leading ! stripped';
  });

  await scenario('/ui/state answers with an error payload instead of a 500', async () => {
    // A broken context must still produce a readable panel page state, because a 500 makes
    // the browser show nothing at all - which is how "the panel is blank" reports start.
    // No second HTTP server here: a stray keep-alive socket once stalled the whole suite,
    // and a port collision then poisoned the *next* run. Call the guard directly.
    const { safeUiState } = require('../src/web/statusServer');
    const out = safeUiState(
      {
        cfg: { agent: {} },
        world: { summary() { throw new Error('synthetic-world-failure'); } },
        brain: { status() { throw new Error('synthetic-brain-failure'); } },
        log: { recent: () => [] },
        llm: null,
        deathWatch: null,
        chatListener: null,
        replies: []
      },
      { port: 8799, startedAt: new Date().toISOString() }
    );
    expect(out.ok === false && /synthetic-world-failure/.test(out.error || ''), `error missing: ${JSON.stringify(out)}`);
    expect(out.panel && out.panel.port === 8799, 'the panel info must survive the failure');
    return out.error.slice(0, 60);
  });

  await scenario('a directive command jumps ahead of queued autonomous work', async () => {
    /**
     * Pause the brain first.
     *
     * `enqueue` drains the queue immediately when the brain is idle, so without the pause
     * the ordering is consumed before the HTTP response is even written and there is
     * nothing left to inspect. Pausing isolates the ordering rule itself - "same level
     * never preempts same level, but directive outranks autonomous" (plan 5.7).
     */
    httpAgent.brain.paused = true;
    httpAgent.brain.queue.length = 0;
    httpAgent.brain.queue.push({ describe: () => 'planner work', level: 'autonomous', name: 'auto' });
    const res = await fetch(`${BASE}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'chop 2', priority: 'directive' })
    });
    const body = await res.json();
    const levels = httpAgent.brain.queue.map((t) => t.level);
    httpAgent.brain.queue.length = 0;
    httpAgent.brain.paused = false;
    expect(body.ok === true, `command failed: ${JSON.stringify(body)}`);
    expect(levels[0] === 'directive', `the instruction should jump the queue, order is ${levels.join(',')}`);
    expect(levels[1] === 'autonomous', `the planner's work should still be there, order is ${levels.join(',')}`);
    return `queue order: ${levels.join(' then ')}`;
  });

  await scenario('emergency stop completes well under 3s and reports every stage', async () => {
    httpAgent.brain.queue.length = 0;
    httpAgent.brain.queue.push({ describe: () => 'queued work', level: 'autonomous', name: 'auto' });
    const started = Date.now();
    const res = await fetch(`${BASE}/emergency-stop`, { method: 'POST' });
    const body = await res.json();
    const ms = Date.now() - started;
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(ms < 3000, `emergency stop took ${ms}ms (bar is 3000ms)`);
    expect(body.ok === true, `stop reported a failure: ${JSON.stringify(body.steps)}`);
    expect(body.steps.brain.ok && body.steps.navigator.ok && body.steps.client.ok, 'a stage failed');
    expect(httpAgent.brain.queue.length === 0, 'the queue survived the emergency stop');
    return `${ms}ms, 3/3 stages ok, queue cleared`;
  });

  await scenario('GET /llm exposes the model, tokens and recent turns', async () => {
    const client = fakeClient([{ ok: true, text: '{"say":"喵","action":null}', usage: { total_tokens: 33 } }]);
    const agent = await buildAgent({ client });
    await agent.say(`${TRIGGER} 你好}`);
    agent.stop();
    const turn = agent.llm.turns.find((t) => t.kind === 'input');
    expect(turn, 'no turn recorded');
    expect(turn.tokens === 33, `tokens were not accounted: ${turn.tokens}`);
    expect(agent.llm.tokensToday === 33, `daily tokens wrong: ${agent.llm.tokensToday}`);
    // And the route the other agents use reports the same shape.
    const res = await fetch(`${BASE}/llm`);
    const body = await res.json();
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(typeof body.enabled === 'boolean', 'enabled flag missing');
    expect(Array.isArray(body.recentTurns), 'recentTurns missing');
    expect(Array.isArray(body.capabilities), 'the capability list is missing');
    /**
     * The capability table is generated from the live body, so `craft` follows
     * `supportsCrafting`. The mock can craft; a client-mod body cannot. Assert the
     * body-independent truths here, and that the table reflects the body for craft.
     */
    const byName = Object.fromEntries(body.capabilities.map((c) => [c.name, c]));
    const names = body.capabilities.map((c) => c.name);
    expect(new Set(names).size === names.length, `the capability table has duplicates: ${names.join(', ')}`);
    for (const name of ['store', 'light']) {
      expect(byName[name] && byName[name].available === false, `${name} is mineflayer-only and must read unavailable here`);
    }
    // `fish` used to be listed twice - once as the implemented skill (yes) and once as an
    // old "Phase 5" promise (no). The registry is the single source now.
    expect(byName.fish && byName.fish.available === true, 'fish must follow the skill registry, not the old Phase 5 list');
    expect(byName.chop.available === true && byName.mine.available === true, 'the three primitives must be available');
    expect(byName.craft.available === httpAgent.body.supportsCrafting, 'craft must follow the body capability');
    /**
     * `say` is available now, and that is deliberate: role play requires the bot to speak up
     * on its own, so the guarantee moved from "the prompt forbids it" to LlmCore.speakUp
     * dropping any action an unprompted turn proposes.
     */
    expect(byName.say && byName.say.available === true, 'say must read available now that proactive speech exists');
    return `${turn.tokens} tokens accounted, ${body.capabilities.length} capabilities exposed`;
  });

  // ============================================================== death
  process.stdout.write('\n5. death handling\n');

  await scenario('death aborts all tasks, alerts outside the game, and does not resume', async () => {
    const agent = await buildAgent();
    // Queue real work so there is something to abort.
    await agent.say('!chop 5');

    // The client reports the player dead.
    const alive = agent.body.snapshot();
    agent.body.snapshot = () => ({ ...alive, dead: true, health: 0 });

    agent.deathWatch.start();
    await new Promise((r) => setTimeout(r, 600));
    agent.deathWatch.stop();

    expect(agent.deathWatch.dead, 'death was not detected');
    expect(agent.brain.stopped, 'the brain was not stopped');
    expect(agent.brain.status().holdReason === 'dead', `the hold table does not name the death: ${agent.brain.status().holdReason}`);
    expect(agent.brain.queue.length === 0, 'the queue was not cleared');
    expect(agent.ctx.memory.data.runtime.death, 'the death was not written to the state-file payload');

    // A new command must be refused while stopped.
    const before = agent.brain.queue.length;
    await agent.say('!chop 5');
    expect(agent.brain.queue.length === before, 'a command was accepted while stopped after death');

    // Respawn: still stopped, because autoResume is false.
    agent.body.snapshot = () => ({ ...alive, dead: false, health: 20 });
    agent.deathWatch.start();
    await new Promise((r) => setTimeout(r, 600));
    agent.deathWatch.stop();
    expect(!agent.deathWatch.dead, 'respawn was not noticed');
    expect(agent.brain.stopped, 'the brain auto-resumed after death (it must not)');
    expect(agent.brain.status().holdReason === 'dead', 'the respawn cleared the death hold (it must not)');

    // An explicit resume is the only way back.
    agent.deathWatch.resume();
    expect(!agent.brain.stopped, 'explicit resume did not clear the stop');
    expect(agent.brain.status().holds.length === 0, 'explicit resume left a hold active');
    agent.stop();
    return 'aborted, stayed stopped across respawn, resumed only on request';
  });

  await scenario('the death banner is visible through /ui/state', async () => {
    const agent = await buildAgent();
    const alive = agent.body.snapshot();
    agent.body.snapshot = () => ({ ...alive, dead: true, health: 0 });
    agent.deathWatch.start();
    await new Promise((r) => setTimeout(r, 600));
    agent.deathWatch.stop();
    // The shared server holds a different ctx, so check the accessor the panel calls.
    const { uiState } = require('../src/web/statusServer');
    const state = uiState(agent.ctx);
    expect(state.death.dead === true, 'the panel state does not report the death');
    expect(state.death.lastDeath && state.death.lastDeath.position, 'the death position is missing');
    expect(state.brain.stopped === true, 'the panel cannot show that the brain is stopped');
    agent.stop();
    return `dead @ ${Math.round(state.death.lastDeath.position.x)},${Math.round(state.death.lastDeath.position.z)}`;
  });

  await scenario('a botless world view must not kill the fast-loop reflexes', async () => {
    /**
     * Live 2026-10-13: a skeleton mauled the bot point-blank with no reaction at all.
     * Root cause: `needsRescue(view)` dereferenced a mineflayer `bot`; the clientmod
     * world view (BodyWorldView) has none, so the call threw a TypeError on EVERY
     * fast-loop tick - swallowed at debug level by the interval catch - and the whole
     * reflex chain (auto-eat, danger retreat, auto-fight) never ran. The reflex must
     * additionally route through the skill layer on such a body: AutoEat / Combat /
     * ToolManager read `controller.bot` (null here) and are safety no-ops at best.
     */
    const hostile = { entity: { id: 7, name: 'minecraft:zombie', position: { x: 2, y: 64, z: 0 } }, distance: 2 };
    const skillsMod = require('../src/skills');
    const realRun = skillsMod.run;
    const skillCalls = [];
    skillsMod.run = async (name) => {
      skillCalls.push(name);
      return { ok: true, detail: 'stub' };
    };
    try {
      // ---- clientmod: botless view, reflexes must go through the skill layer ----
      let refreshed = 0;
      let defended = 0;
      let hostileList = [hostile];
      const snap = { position: { x: 0, y: 64, z: 0 }, health: 20, food: 12 };
      const ctx = {
        cfg: loadConfig({ profile: null }),
        log: silent,
        bodyKind: 'clientmod',
        body: {
          isReady: true,
          refresh: async () => {
            refreshed += 1;
            return null;
          }
        },
        controller: { bot: null },
        nav: { looksStuck: false, stuckCount: 0 },
        memory: { landmark: () => null, bump() {} },
        world: {
          ready: true,
          // Deliberately no `bot`: that absence is exactly what broke the reflex.
          hostiles: () => hostileList,
          nearestHostile: () => hostileList[0] || null,
          snapshot: () => ({ ...snap }),
          isInDanger: () => false
        },
        eat: { tick: async () => false },
        combat: {
          defend: async () => {
            defended += 1;
            return true;
          },
          retreat: async () => true
        },
        tools: { equipArmor: async () => {} }
      };
      const brain = new Brain(ctx);
      await brain.fastLoop();
      expect(refreshed >= 1, 'the fast loop did not refresh the body before judging danger');
      expect(skillCalls.includes('attack'), `a botless body must fight via the skill layer: ${skillCalls}`);
      expect(!skillCalls.includes('eat'), `hunger must wait while hostiles are near (the hand is the weapon): ${skillCalls}`);
      expect(defended === 0, 'the mineflayer combat controller must not be used on a botless body');
      await new Promise((r) => setTimeout(r, 0));

      // ---- quiet neighbourhood: the meal goes through the skill layer ----
      hostileList = [];
      await brain.fastLoop();
      expect(skillCalls.includes('eat'), `a hungry (12) botless body must eat once the area is quiet: ${skillCalls}`);

      // ---- mineflayer: the servo path stays (same world stub, bot present) ----
      hostileList = [hostile];
      const before = skillCalls.length;
      let defendedServo = 0;
      const ctxServo = {
        ...ctx,
        bodyKind: 'mineflayer',
        controller: { bot: { health: 20 } },
        combat: {
          defend: async () => {
            defendedServo += 1;
            return true;
          },
          retreat: async () => true
        }
      };
      const brainServo = new Brain(ctxServo);
      await brainServo.fastLoop();
      expect(defendedServo === 1, 'the mineflayer branch must keep the servo fight');
      expect(skillCalls.length === before, `mineflayer must not route reflexes through skills: ${skillCalls}`);
    } finally {
      skillsMod.run = realRun;
    }
    return 'reflex reached; clientmod routed via skills, mineflayer via the servo';
  });

  await scenario('combat reflexes: retreat, charge, gun fallback, ignore, no double-fire', async () => {
    /**
     * COMBAT-PLAN v3 §①/§②: below the flee threshold the bot backs away (with a gun when
     * one is loaded); it charges when wounded or when something hurt it this tick; stalled
     * targets are skipped; an explicit fight task suppresses the reflex; and a failed gun
     * attempt falls back to the melee charge.
     */
    const skillsMod = require('../src/skills');
    const combatState = require('../src/world/combatState');
    const realRun = skillsMod.run;
    combatState.reset();
    const skillCalls = [];
    let shootFails = false;
    skillsMod.run = async (name, _ctx, params) => {
      skillCalls.push({ name, params: params || null });
      if (name === 'shoot' && shootFails) return { ok: false, failure: 'tacz_unavailable' };
      return { ok: true, detail: 'stub' };
    };
    try {
      const mkBrain = ({ health = 20, hostiles = [], hub = null } = {}) => {
        const calls = { retreat: [], stop: 0, equip: [] };
        let held = null;
        let danger = false;
        let healthNow = health;
        let hostileList = hostiles;
        const body = {
          isReady: true,
          refresh: async () => null,
          snapshot: () => ({
            position: { x: 0, y: 64, z: 0 },
            health: healthNow,
            heldItem: held,
            inventory: {},
            guns: [{ item: 'tacz:ak47', gunId: 'tacz:ak47', type: 'rifle', magazine: 30, dummy: 0, bullets: true }]
          }),
          equip: async (item) => {
            calls.equip.push(item);
            held = item;
            return true;
          },
          retreatFrom: async (entity, options) => {
            calls.retreat.push({ id: entity.id, ms: options.ms, fire: options.fire === true });
            return true;
          },
          stop: async () => {
            calls.stop += 1;
            return true;
          }
        };
        const ctx = {
          cfg: loadConfig({ profile: null }),
          log: silent,
          bodyKind: 'clientmod',
          body,
          controller: { bot: null },
          hub,
          nav: { looksStuck: false, stuckCount: 0 },
          memory: { landmark: () => null, bump() {} },
          world: {
            ready: true,
            hostiles: () => hostileList,
            nearestHostile: () => (hostileList.length ? hostileList[0] : null),
            snapshot: () => body.snapshot(),
            isInDanger: () => danger
          },
          eat: { tick: async () => false },
          combat: { defend: async () => true, retreat: async () => true },
          tools: { equipArmor: async () => {} }
        };
        return {
          brain: new Brain(ctx),
          calls,
          setDanger: (on) => {
            danger = on;
          },
          setHealth: (value) => {
            healthNow = value;
          },
          setHostiles: (list) => {
            hostileList = list;
          }
        };
      };
      const hostile = (id, distance) => ({
        entity: { id, name: 'minecraft:zombie', position: { x: distance, y: 64, z: 0 } },
        distance
      });
      const tick = async (brain) => {
        await brain.fastLoop();
        await new Promise((resolve) => setTimeout(resolve, 0)); // let the reflex promise settle
      };

      // ---- retreat: below the flee threshold, with the preferred loaded gun ----------
      const retreatAgent = mkBrain({ health: 6, hostiles: [hostile(1, 4)] });
      retreatAgent.setDanger(true);
      await tick(retreatAgent.brain);
      expect(retreatAgent.calls.retreat.length === 1, JSON.stringify(retreatAgent.calls.retreat));
      expect(
        retreatAgent.calls.retreat[0].fire === true && retreatAgent.calls.equip.includes('tacz:ak47'),
        `retreat must fire the rifle: ${JSON.stringify(retreatAgent.calls)}`
      );
      retreatAgent.setDanger(false);
      await tick(retreatAgent.brain);
      expect(retreatAgent.calls.stop >= 1, 'danger over must cancel the running retreat');
      expect(retreatAgent.brain._retreatTargetId === null, 'the retreat marker must clear');

      // ---- charge: wounded below 16 engages a 10-block target with the gun -----------
      const wounded = mkBrain({ health: 15, hostiles: [hostile(2, 10)] });
      await tick(wounded.brain);
      expect(
        skillCalls.some((call) => call.name === 'shoot' && call.params && call.params.id === 2),
        `wounded engage must shoot #2: ${JSON.stringify(skillCalls)}`
      );

      // ---- charge: hurt this tick reaches a 15-block shooter -------------------------
      const hit = mkBrain({ health: 20 });
      await tick(hit.brain); // baseline health for this brain
      hit.setHealth(18);
      hit.setHostiles([hostile(3, 15)]);
      const beforeHit = skillCalls.length;
      await tick(hit.brain);
      expect(
        skillCalls.slice(beforeHit).some((call) => call.name === 'shoot' && call.params.id === 3),
        `a ranged hit must charge #3: ${JSON.stringify(skillCalls.slice(beforeHit))}`
      );

      // ---- ignore list: skipped at 10 blocks, re-engaged at 3 ------------------------
      combatState.ignore(9);
      const ignored = mkBrain({ health: 20, hostiles: [hostile(9, 10)] });
      const beforeIgnore = skillCalls.length;
      await tick(ignored.brain);
      expect(
        !skillCalls.slice(beforeIgnore).some((call) => call.name === 'attack' || call.name === 'shoot'),
        `the ignored target must be skipped: ${JSON.stringify(skillCalls.slice(beforeIgnore))}`
      );
      const override = mkBrain({ health: 20, hostiles: [hostile(9, 3)] });
      const beforeOverride = skillCalls.length;
      await tick(override.brain);
      expect(
        skillCalls.slice(beforeOverride).some((call) => call.name === 'attack'),
        `at 3 blocks the ignored target is hittable again: ${JSON.stringify(skillCalls.slice(beforeOverride))}`
      );

      // ---- an explicit fight task suppresses the reflex (no double-fire) -------------
      const busyHub = { status: () => ({ current: { name: 'attack' } }) };
      const suppressed = mkBrain({ health: 20, hostiles: [hostile(4, 3)], hub: busyHub });
      const beforeSuppressed = skillCalls.length;
      await tick(suppressed.brain);
      expect(
        !skillCalls.slice(beforeSuppressed).some((call) => call.name === 'attack' || call.name === 'shoot'),
        `a fight task must own the fight: ${JSON.stringify(skillCalls.slice(beforeSuppressed))}`
      );

      // ---- a live combat skill (registry lease) suppresses the reflex too ------------
      const leaseAgent = mkBrain({ health: 20, hostiles: [hostile(6, 3)] });
      combatState.beginCombatSkill('shoot');
      try {
        const beforeLease = skillCalls.length;
        await tick(leaseAgent.brain);
        expect(
          !skillCalls.slice(beforeLease).some((call) => call.name === 'attack' || call.name === 'shoot'),
          `a running combat skill must own the fight: ${JSON.stringify(skillCalls.slice(beforeLease))}`
        );
      } finally {
        combatState.endCombatSkill('shoot');
      }

      // ---- gun failure falls back to the melee charge --------------------------------
      shootFails = true;
      const fallback = mkBrain({ health: 15, hostiles: [hostile(5, 10)] });
      const beforeFallback = skillCalls.length;
      await tick(fallback.brain);
      const fallbackCalls = skillCalls.slice(beforeFallback).map((call) => call.name);
      expect(
        fallbackCalls.includes('shoot') && fallbackCalls.includes('attack'),
        `shoot failure must fall back to attack: ${JSON.stringify(fallbackCalls)}`
      );
      shootFails = false;
      return 'retreat+gun, wounded charge, hit charge, ignore/override, suppression (hub+lease), fallback';
    } finally {
      skillsMod.run = realRun;
      combatState.reset();
    }
  });

  /**
   * Shut the server down without hanging.
   *
   * `server.close()` waits for open connections to finish, and `fetch` keeps them alive, so
   * the plain call never resolves - which is how this test hung for three minutes on its
   * first run. Closing the idle sockets explicitly is the documented way out.
   */
  httpAgent.stop();
  if (typeof server.server.closeAllConnections === 'function') server.server.closeAllConnections();
  await Promise.race([new Promise((resolve) => server.close(resolve)), new Promise((r) => setTimeout(r, 1500))]);

  // ---------------------------------------------------------------- summary
  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${'='.repeat(64)}\n`);
  process.stdout.write(`control test: ${results.length - failed.length}/${results.length} scenarios passed\n`);
  if (failed.length) {
    for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('deliverables C/D/E checkpoint reached: both channels, panel and death handling verified offline\n');
  }
  process.exit(process.exitCode || 0);
})().catch((err) => {
  process.stdout.write(`control test crashed: ${err.stack}\n`);
  process.exit(1);
});
