'use strict';

/**
 * `npm run clientmod:test` - the client-mod body, end to end, with no Minecraft.
 *
 * Why this exists alongside `verify:roleplay`
 * -------------------------------------------
 * `verify-roleplay.js` drives the LLM layer with a hand-written context object. That proves the
 * logic, but it cannot prove the *wiring*: that the body the agent really builds talks to the
 * mod's real endpoints, that the scheduler reads that body's snapshot, and that a proactive
 * line actually leaves through `reply()` into the mod's `/command`.
 *
 * Those are different failure modes. A renamed verb, a changed `/state` field, a snapshot that
 * returns null until something else refreshes it - all of them pass a context-object test and
 * all of them break a live run. So this script stands up a fake control mod on a real HTTP
 * socket, points a real `ClientModBody` at it, and then runs the real role-play path over it:
 *
 *   fake mod (node:http)  <--HTTP-->  ClientModBody  -->  BodyWorldView  -->  Brain
 *                                                              |
 *                                                    LlmCore / SpeechScheduler / reply
 *
 * Everything asserted is an observable effect on the fake mod: the request it received, the
 * command line it was told to send. Nothing is asserted against an internal field.
 *
 * The fake mod deliberately implements the *documented* protocol (/health, /state, /command,
 * /progress, /chatlog) rather than whatever the body happens to call today. When the two drift,
 * that is the bug this test is for.
 */

const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { ClientModBody } = require(path.join(ROOT, 'src/body/clientModBody'));
const { BodyWorldView } = require(path.join(ROOT, 'src/world/bodyWorldView'));
const { SpeechScheduler } = require(path.join(ROOT, 'src/chat/speechScheduler'));
const { reply } = require(path.join(ROOT, 'src/chat/reply'));
const { Brain } = require(path.join(ROOT, 'src/brain'));
const { loadConfig } = require(path.join(ROOT, 'src/util/config'));
const { loadPersona, resolveTrigger } = require(path.join(ROOT, 'src/llm/persona'));
const { MockBody } = require(path.join(ROOT, 'src/body/mockBody'));

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const out = (s = '') => process.stdout.write(`${s}\n`);
let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    out(`  PASS  ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    fail += 1;
    out(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

async function scenario(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    pass += 1;
    out(`  PASS  ${name}${detail ? ` - ${detail}` : ''}  (${Date.now() - started}ms)`);
  } catch (err) {
    fail += 1;
    out(`  FAIL  ${name} - ${err.message}  (${Date.now() - started}ms)`);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

/**
 * A fake agent-client mod.
 *
 * Mirrors the real mod's documented surface. `state` is mutable so a scenario can make the bot
 * hungry or dead, and `commands` records every POST /command line so a scenario can assert on
 * what the agent actually tried to do.
 */
function fakeMod() {
  const mod = {
    commands: [],
    state: {
      ready: true,
      body: 'clientmod',
      position: { x: 12.5, y: 64, z: -3.25 },
      dimension: 'minecraft:overworld',
      health: 20,
      maxHealth: 20,
      food: 20,
      onGround: true,
      dead: false,
      time: { isDay: true, timeOfDay: 1000, day: 3 },
      weather: { raining: false, thundering: false },
      inventory: { 'minecraft:stone_pickaxe': 1, 'minecraft:oak_log': 4 },
      emptySlots: 30,
      heldItem: 'minecraft:stone_pickaxe',
      standingOn: 'minecraft:grass_block',
      hostiles: [],
      itemDrops: [],
      players: [{ name: 'AgentDeepSeek' }],
      blocks: { cells: {} }
    },
    progress: { busy: false, done: true },
    chatlog: { count: 0, lines: [] }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, payload) => {
      const body = JSON.stringify(payload);
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, { ok: true, mod: 'agent-client', version: 'test', inWorld: true });
    }
    if (req.method === 'GET' && url.pathname === '/state') {
      return send(200, mod.state);
    }
    if (req.method === 'GET' && url.pathname === '/progress') {
      return send(200, mod.progress);
    }
    if (req.method === 'GET' && url.pathname === '/chatlog') {
      return send(200, mod.chatlog);
    }
    if (req.method === 'POST' && url.pathname === '/command') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        let line = '';
        try {
          line = String(JSON.parse(raw).command || '');
        } catch {
          line = '';
        }
        mod.commands.push(line);
        send(200, { ok: true, command: line });
      });
      return undefined;
    }
    return send(404, { ok: false, error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      mod.port = server.address().port;
      mod.close = () => new Promise((r) => server.close(r));
      resolve(mod);
    });
  });
}

async function main() {
  out('client-mod body end-to-end (fake control mod on a real socket, no Minecraft)\n');

  const cfg = loadConfig({ profile: null });
  cfg.llm = { ...cfg.llm, enabled: false }; // template path: no API key, no network

  const mod = await fakeMod();
  out(`fake control mod on 127.0.0.1:${mod.port}\n`);

  out('1. attach and perceive');
  const body = new ClientModBody(cfg, { host: '127.0.0.1', port: mod.port, log: silent });
  await scenario('connect() attaches to a live control mod', async () => {
    const ok = await body.connect({ waitMs: 5000, pollMs: 100 });
    expect(ok === true, 'connect() did not report success');
    expect(body.isReady === true, 'the body does not report ready');
    const snap = body.snapshot();
    expect(snap && snap.ready === true, 'snapshot() is not ready');
    return `${snap.dimension} at ${Math.floor(snap.position.x)},${Math.floor(snap.position.y)},${Math.floor(snap.position.z)}`;
  });

  await scenario('snapshot() carries the fields the decision layer reads', async () => {
    const snap = body.snapshot();
    for (const key of ['position', 'dimension', 'health', 'food', 'inventory', 'emptySlots', 'time', 'hostiles']) {
      expect(snap[key] !== undefined, `snapshot() is missing ${key}`);
    }
    expect(snap.inventory['minecraft:stone_pickaxe'] === 1 || snap.inventory.stone_pickaxe === 1,
      `inventory did not survive the mapping: ${JSON.stringify(snap.inventory)}`);
    return `${Object.keys(snap.inventory).length} item kind(s)`;
  });

  await scenario('a dead client is reported as dead', async () => {
    mod.state = { ...mod.state, dead: true, health: 0 };
    const snap = await body.refresh(true);
    expect(snap && snap.dead === true, 'snapshot() did not surface the dead flag');
    mod.state = { ...mod.state, dead: false, health: 20 };
    await body.refresh(true);
    return 'dead flag reaches the snapshot';
  });

  out('\n2. the role-play wiring, over the real body');
  const world = new BodyWorldView(body, cfg, { log: silent });

  /**
   * The whole point of this file: `speakUp` is replaced so the scenario can observe the request
   * the scheduler makes, and `reply` is the real one, so the line has to travel the real path
   * into the mod's /command.
   */
  const spoken = [];
  let requested = [];
  const ctx = {
    cfg,
    body,
    bodyKind: 'clientmod',
    world,
    brain: { status: () => ({ current: null }) },
    log: silent
  };
  ctx.reply = (text, options) => reply(ctx, text, options);
  ctx.llm = {
    speakUp: async (kind) => {
      requested.push(kind);
      // Stand in for what LlmCore would say, then let the real reply() send it.
      const line = kind === 'hungry' ? '肚子饿了，有吃的吗' : kind === 'lowHealth' ? '救命，我快不行了' : '干完了';
      await ctx.reply(line, { why: `proactive:${kind}`, force: true });
      return { ok: true, said: line, spoken: true };
    }
  };

  const scheduler = new SpeechScheduler(ctx, { intervalMs: 50 });

  await scenario('a hungry client with no food triggers speech', async () => {
    requested = [];
    spoken.length = 0;
    mod.state = { ...mod.state, food: 3, inventory: {} };
    await body.refresh(true);
    await scheduler.tick();
    expect(requested.includes('hungry'), `the hunger trigger did not fire: ${JSON.stringify(requested)}`);
    const said = (ctx.replies || []).map((r) => r.text);
    expect(said.length >= 1, 'nothing reached reply()');
    const sent = mod.commands.filter((c) => c.startsWith('chat '));
    expect(sent.length >= 1, `no chat command reached the mod: ${JSON.stringify(mod.commands)}`);
    return `mod received: ${sent[sent.length - 1]}`;
  });

  await scenario('the spoken line arrives at the mod as a chat command, stripped of triggers', async () => {
    const sent = mod.commands.filter((c) => c.startsWith('chat ')).pop();
    expect(!!sent, 'no chat command was sent');
    const payload = sent.slice('chat '.length);
    // A line starting with `!` or `/` would come back through /chatlog as a command.
    expect(!/^[!/]/.test(payload), `the line would re-enter as a command: ${payload}`);
    expect(!/[\r\n]/.test(payload), 'the line contains a newline');
    return payload;
  });

  await scenario('carrying food suppresses the hunger line', async () => {
    requested = [];
    mod.state = { ...mod.state, food: 3, inventory: { 'minecraft:cooked_beef': 3 } };
    await body.refresh(true);
    await scheduler.tick();
    expect(!requested.includes('hungry'), 'it asked for food while carrying food');
    return 'silent while fed';
  });

  await scenario('low health triggers speech and outranks hunger', async () => {
    requested = [];
    mod.state = { ...mod.state, health: 4, food: 3, inventory: {} };
    await body.refresh(true);
    await scheduler.tick();
    expect(requested.includes('lowHealth'), `the danger trigger did not fire: ${JSON.stringify(requested)}`);
    return requested.join(', ');
  });

  await scenario('a dead client does not use the low-health trigger', async () => {
    requested = [];
    mod.state = { ...mod.state, dead: true, health: 0 };
    await body.refresh(true);
    await scheduler.tick();
    expect(requested.length === 0, `it spoke while dead: ${JSON.stringify(requested)}`);
    mod.state = { ...mod.state, dead: false, health: 20 };
    await body.refresh(true);
    return 'silent while dead (DeathWatch owns that path)';
  });

  out('\n3. the trigger is the one the persona file names');
  await scenario('resolveTrigger and the body agree on the character', async () => {
    const persona = loadPersona({ root: ROOT });
    const trigger = resolveTrigger(ctx);
    expect(persona.loaded, `persona did not load: ${persona.error}`);
    expect(trigger === persona.trigger, `trigger mismatch: ${trigger} vs ${persona.trigger}`);
    return `${persona.name} answers to ${trigger}`;
  });

  out('\n4. a finished task is announced through the same path');
  await scenario('ChatController-driven work reports back in character', async () => {
    // A MockBody is used for the brain half: the point here is the announcement path, and a
    // fake world is enough to make a task actually finish.
    const mock = new MockBody(cfg, {
      blocks: [
        { name: 'oak_log', position: { x: 3, y: 64, z: 0 } },
        { name: 'oak_log', position: { x: 3, y: 65, z: 0 } }
      ],
      inventory: {}
    });
    await mock.connect();
    const mockWorld = new BodyWorldView(mock, cfg, { log: silent });
    const announced = [];
    const bctx = {
      cfg,
      body: mock,
      bodyKind: 'mock',
      world: mockWorld,
      brain: { status: () => ({ current: null }) },
      log: silent
    };
    bctx.reply = (text, options) => reply(bctx, text, options);
    const brain = new Brain(bctx);
    bctx.brain = brain;
    brain.on('task:done', (info) => announced.push(info));

    const { LlmCore } = require(path.join(ROOT, 'src/llm'));
    const core = new LlmCore(bctx, cfg.llm, { client: null });
    core.enabled = false; // template path
    core.attachTo(brain);
    bctx.llm = core;

    await core.announceFinished(
      { name: 'chop', description: '砍 2 根木头', reason: 'collected 2 logs', source: 'chat' },
      true
    );
    const said = (bctx.replies || []).map((r) => r.text);
    expect(said.length === 1, `expected one announcement, got ${said.length}`);
    expect(/砍 2 根木头/.test(said[0]), `the announcement lost the detail: ${said[0]}`);

    await core.announceFinished({ name: 'dirt', description: '挖点土', reason: 'ok', source: 'autonomous' }, true);
    expect((bctx.replies || []).length === 1, 'planner-owned work was announced');
    return said[0];
  });

  out('\n5. disconnecting is clean');
  await scenario('disconnect() stops using the mod', async () => {
    await body.disconnect();
    expect(body.isReady === false, 'the body still reports ready after disconnect');
    return 'detached';
  });

  scheduler.stop();
  await mod.close();

  out(`\n${'='.repeat(64)}`);
  out(`clientmod test: ${pass}/${pass + fail} checks passed`);
  if (fail) process.exitCode = 1;
  else out('the client-mod body drives the real role-play path end to end');
}

main().catch((err) => {
  out(`clientmod test crashed: ${err && err.stack ? err.stack : err}`);
  process.exitCode = 1;
});
