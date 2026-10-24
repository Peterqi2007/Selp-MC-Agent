/**
 * Offline verification for `/goal` **goal mode** (no DSH, no Minecraft).
 *
 * The action brain used to get one text followup per goal, which ends after a turn or two.
 * Goal mode creates a durable `dsh-goal` goal instead, so `dsh-goal-round-driver` can keep
 * scheduling rounds until the model completes or blocks it. This harness applies the real
 * plugin with fake `agents`/`goals` services and a stub SSE control endpoint, then asserts:
 *
 *   - default POST /goal creates a goal (no followup, objective carries the GOAL text);
 *   - GET /goal returns the current goal;
 *   - a second goal without replace is refused with `goal-exists`;
 *   - `replace:true` clears the current goal and creates a new one (maxGoalRounds passed);
 *   - `mode:"text"` still uses the legacy single followup (H1 callers);
 *   - without a goals service, goal mode fails loudly instead of silently falling back.
 */
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const silent = { info() {}, warn() {}, debug() {}, error() {} };

async function rejects(fn, pattern, message) {
  try {
    await fn();
  } catch (err) {
    if (pattern.test(err.message || '')) return err;
    throw new Error(`${message}: got "${err.message}"`);
  }
  throw new Error(`${message}: did not reject`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

/** Stub control endpoint: keeps the turn SSE open and records mc_say lines. */
function startControlStub() {
  const said = [];
  const proposals = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && (req.url === '/observe' || req.url === '/propose')) {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(body || '{}');
          } catch {
            parsed = {};
          }
          if (req.url === '/propose') proposals.push(parsed);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(req.url === '/observe'
            ? { ok: true, fields: parsed.fields || [], full: true }
            : { ok: true, proposal: { id: 'p-test' }, autoAccepted: false }));
        });
        return;
      }
      if (req.method === 'POST' && req.url === '/say') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body || '{}');
            said.push(String(parsed.text || ''));
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, sent: true, text: parsed.text || '' }));
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end('{}');
          }
        });
        return;
      }
      if (String(req.url || '').startsWith('/harness/events')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(': connected\n\n');
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, said, proposals }));
  });
}

function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {}
      },
      (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(s);
          } catch {
            parsed = { raw: s };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function makeWorld({ withGoals = true } = {}) {
  const created = [];
  const cleared = [];
  const paused = [];
  const resumed = [];
  const completed = [];
  const followups = [];
  let current = null;
  const agent = {
    id: 'live-1',
    status: 'idle',
    session: { seq: 0, deriveMessages: () => [] },
    followup: async (message) => followups.push(message),
    whenIdle: async () => {}
  };
  const agents = { get: (id) => (id === 'live-1' ? agent : null), list: () => [agent] };
  const goals = withGoals
    ? {
        get: () => current,
        create: (_agent, request) => {
          created.push(request);
          current = {
            id: `goal-${created.length}`,
            revision: 1,
            objective: request.objective,
            phase: 'active',
            roundsStarted: 0,
            maxGoalRounds: request.maxGoalRounds || 256,
            activation: 'armed'
          };
          return current;
        },
        clear: (_agent, ref) => {
          cleared.push(ref);
          current = null;
          return { id: ref.id, revision: ref.revision + 1 };
        },
        pause: (_agent, ref) => {
          paused.push(ref);
          current = { ...current, phase: 'paused', revision: current.revision + 1, activation: 'disarmed' };
          return current;
        },
        resume: (_agent, ref) => {
          resumed.push(ref);
          current = { ...current, phase: 'active', revision: current.revision + 1, activation: 'armed' };
          return current;
        },
        complete: (_agent, ref) => {
          completed.push(ref);
          current = { ...current, phase: 'complete', revision: current.revision + 1, activation: 'disarmed' };
          return current;
        }
      }
    : null;
  const tools = [];
  const ctx = {
    logger: silent,
    get: (name) => (name === 'agents' ? agents : name === 'goals' ? goals : null),
    inject: (names, callback) =>
      callback({ tools: { register: (definition) => tools.push(definition) }, agents }),
    effect: (fn) => {
      const cleanup = fn();
      if (typeof cleanup === 'function') ctx.cleanups.push(cleanup);
    },
    cleanups: []
  };
  return { ctx, tools, created, cleared, paused, resumed, completed, followups, agent };
}

async function main() {
  const control = await startControlStub();
  const pluginPort = await freePort();
  const world = makeWorld();
  const mod = await import(pathToFileURL(path.join(ROOT, 'dsh-plugin-mc-harness', 'lib', 'index.js')).href);
  await mod.apply(world.ctx, { port: pluginPort, controlUrl: `http://127.0.0.1:${control.port}` });

  const first = await request(pluginPort, 'POST', '/goal', { agentId: 'live-1', goal: 'mine 2 dirt' });
  assert(first.status === 202, `goal mode must return 202, got ${first.status}`);
  assert(first.body.mode === 'goal', 'response must name goal mode');
  assert(first.body.goal && first.body.goal.id === 'goal-1', 'a durable goal must be created');
  assert(/GOAL: mine 2 dirt/.test(first.body.goal.objective), 'objective must carry the goal text');
  assert(world.followups.length === 0, 'goal mode must not inject a text followup');

  const read = await request(pluginPort, 'GET', '/goal');
  assert(read.status === 200 && read.body.goal && read.body.goal.id === 'goal-1', 'GET /goal must return the goal');

  const paused = await request(pluginPort, 'POST', '/goal/pause', { agentId: 'live-1' });
  assert(paused.status === 200 && paused.body.action === 'pause', 'pause must return 200');
  assert(paused.body.goal.phase === 'paused' && paused.body.goal.activation === 'disarmed', 'pause must stop continuation');
  assert(world.paused.length === 1 && world.paused[0].id === 'goal-1', 'pause must use the current {id,revision}');

  const resumed = await request(pluginPort, 'POST', '/goal/resume', { agentId: 'live-1' });
  assert(resumed.status === 200 && resumed.body.action === 'resume', 'resume must return 200');
  assert(resumed.body.goal.phase === 'active' && resumed.body.goal.activation === 'armed', 'resume must rearm');
  assert(world.resumed.length === 1 && world.resumed[0].revision === paused.body.goal.revision, 'resume must use the paused revision');

  const duplicate = await request(pluginPort, 'POST', '/goal', { agentId: 'live-1', goal: 'mine 3 dirt' });
  assert(duplicate.status === 409 && duplicate.body.error === 'goal-exists', 'active goal must refuse a new one');

  const replaced = await request(pluginPort, 'POST', '/goal', {
    agentId: 'live-1',
    goal: 'mine 3 dirt',
    replace: true,
    maxGoalRounds: 5
  });
  assert(replaced.status === 202, `replace must create a new goal, got ${replaced.status}`);
  assert(world.cleared.length === 1 && world.cleared[0].id === 'goal-1', 'replace must clear the old goal');
  assert(world.created.length === 2 && world.created[1].maxGoalRounds === 5, 'maxGoalRounds must pass through');

  const legacy = await request(pluginPort, 'POST', '/goal', { agentId: 'live-1', goal: 'legacy', mode: 'text' });
  assert(legacy.status === 200 && legacy.body.ok === true, 'text mode must keep the legacy response');
  assert(world.followups.length === 1, 'text mode must still use one followup');

  // The action brain's in-game voice: mc_say -> Node /say.
  const sayTool = world.tools.find((tool) => tool.name === 'mc_say');
  assert(sayTool, 'mc_say must be registered');
  const said = JSON.parse(await sayTool.execute({ text: '收到，开始挖' }));
  assert(said.ok === true && said.sent === true, 'mc_say must report the send result');
  assert(control.said.includes('收到，开始挖'), 'mc_say must reach the local /say endpoint');

  // No goals service: goal mode must fail loudly, not silently degrade to chat.
  const noGoalWorld = makeWorld({ withGoals: false });
  const secondPort = await freePort();
  await mod.apply(noGoalWorld.ctx, { port: secondPort, controlUrl: `http://127.0.0.1:${control.port}` });
  const unavailable = await request(secondPort, 'POST', '/goal', { agentId: 'live-1', goal: 'x' });
  assert(unavailable.status === 503, 'missing goal service must be a loud 503');

  // Pause with no current goal is a clear 404, not a silent no-op.
  const emptyWorld = makeWorld();
  const emptyPort = await freePort();
  await mod.apply(emptyWorld.ctx, { port: emptyPort, controlUrl: `http://127.0.0.1:${control.port}` });
  const noGoal = await request(emptyPort, 'POST', '/goal/pause', { agentId: 'live-1' });
  assert(noGoal.status === 404 && noGoal.body.error === 'no-goal', 'pause without a goal must be 404');

  // ------------------------------------------------------------- proposal prep
  const prepWorld = makeWorld();
  const prepPort = await freePort();
  await mod.apply(prepWorld.ctx, { port: prepPort, controlUrl: `http://127.0.0.1:${control.port}` });
  const prep = await request(prepPort, 'POST', '/goal', {
    agentId: 'live-1',
    goal: 'find something useful to propose',
    purpose: 'proposal'
  });
  assert(prep.status === 202 && prep.body.purpose === 'proposal', 'purpose=proposal must create a goal');
  assert(prepWorld.created.length === 1 && prepWorld.created[0].maxGoalRounds === 1, 'prep goal caps rounds at 1');
  assert(/mc_observe/.test(prepWorld.created[0].objective), 'prep objective must require observation');
  assert(/autonomous/.test(prepWorld.created[0].objective), 'prep objective must require mc_propose autonomous');
  assert(/do not|no execution|only observe/i.test(prepWorld.created[0].objective), 'prep objective must forbid execution');

  const prepTools = Object.fromEntries(prepWorld.tools.map((tool) => [tool.name, tool]));
  for (const name of ['mc_step', 'mc_plan', 'mc_say']) {
    await rejects(
      async () => prepTools[name].execute(
        name === 'mc_step'
          ? { command: 'goto 0 64 0' }
          : name === 'mc_plan'
            ? { goal: 'x', steps: [{ id: 's1', type: 'goto', args: { x: 0, y: 64, z: 0 } }] }
            : { text: 'hello' }
      ),
      /proposal-prep round/,
      `${name} must be rejected during proposal prep`
    );
  }
  const full = JSON.parse(await prepTools.mc_observe.execute({ full: true }));
  assert(full.ok === true && Array.isArray(full.fields) && full.fields.includes('inventory'), 'mc_observe full must request all fields');
  await rejects(
    async () => prepTools.mc_propose.execute({ type: 'mine', name: 'mine_dirt', args: { block: 'dirt' } }),
    /autonomous:true/,
    'mc_propose without autonomous must be rejected during prep'
  );
  const proposed = JSON.parse(
    await prepTools.mc_propose.execute({
      type: 'mine',
      name: 'mine_dirt',
      args: { block: 'dirt', count: 2 },
      reason: 'dirt is useful',
      autonomous: true
    })
  );
  assert(proposed.ok === true, 'mc_propose autonomous must reach the local /propose endpoint');
  assert(control.proposals.length === 1 && control.proposals[0].autonomous === true, 'autonomous flag must be forwarded');

  const done = await request(prepPort, 'POST', '/goal/complete', { agentId: 'live-1' });
  assert(done.status === 200 && prepWorld.completed.length === 1, '/goal/complete must complete the prep goal');
  await rejects(
    async () => prepTools.mc_propose.execute({ type: 'mine', name: 'x', args: {}, autonomous: true }),
    /only accepted inside an injected proposal-prep goal/,
    'autonomous proposal outside prep must be rejected'
  );

  for (const cleanup of [
    ...world.ctx.cleanups,
    ...noGoalWorld.ctx.cleanups,
    ...emptyWorld.ctx.cleanups,
    ...prepWorld.ctx.cleanups
  ].reverse()) {
    try { await cleanup(); } catch { /* closing anyway */ }
  }
  await new Promise((resolve) => control.server.close(resolve));
  control.server.closeAllConnections?.();
  console.log('goal mode: PASS (durable goal, GET, pause/resume, mc_say, goal-exists, replace, text fallback, loud 503, proposal prep guard)');
}

main().catch((err) => {
  console.error('goal mode: FAIL -', err.message);
  process.exit(1);
});
