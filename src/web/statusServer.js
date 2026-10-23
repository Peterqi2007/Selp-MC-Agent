'use strict';

/**
 * Tiny zero-dependency HTTP control server (P0-PLAN §4.2.2).
 *
 * Endpoints:
 *   GET  /panel                     the single-page control panel
 *   GET  /ui/state                  slim state for the panel's 1s poll (NO block scan)
 *   GET  /status                    full snapshot, including brain state
 *   GET  /health                    liveness
 *   GET  /inventory, /logs, /mods
 *   GET  /llm                       provider/model, tokens today, the last 10 turns
 *   POST /command  {command, priority}   same command table as the chat channel
 *   POST /emergency-stop            four-stage stop, reports what actually happened
 *
 * P1 M3 live entry (localhost, same trust boundary as /command):
 *   POST /plan  {planId?, steps, start?, turn?, wait?, baseVersion?}
 *   GET  /plan | /plan/<id>
 *   POST /plan/<id>/start | /resume | /cancel
 *   POST /harness/turn  {requestId?, planId?} ; /harness/turn/<id>/{wait,finish,cancel}
 *   GET  /harness/turns ; GET /harness/events (SSE, token-aware)
 *
 * The plan endpoints are acceptance surfaces, not completion claims: `/plan` returns 202
 * while the plan runs, and the outcome is on `/events` (plan:*) or `/plan/<id>`.
 *
 * Two design notes worth keeping:
 *
 *   - **`/ui/state` is not `/status`.** The body snapshot carries a 40817-cell block map;
 *     at one poll per second that is megabytes of JSON for data the panel never renders.
 *     The panel gets a summary, and `/status` stays available for tooling.
 *   - **The emergency stop is honest.** It reports the outcome of each of its four stages
 *     instead of always claiming success. A stop button that lies is worse than no button:
 *     you would keep playing while the bot walks into lava.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { inventorySummary } = require('../world/items');
const { countTrace } = require('../util/trace');
const { PANEL_HTML, PANEL_JS } = require('./panel');
const { Logger } = require('../util/logger');
const { resolveTrigger, personaForConfig } = require('../llm/persona');
const { streamEvents } = require('./eventStream');
const { HarnessInjector } = require('../harness/inject');
const { recordPlayerMessage } = require('../chat/playerChatLog');

function startStatusServer(ctx, options = {}) {
  const log = new Logger('http');
  /**
   * A28 injection surface - test-only, default off.
   *
   * `POST /harness/inject` manufactures duplicate/out-of-order/cancelled events for the
   * turn machinery so the "at most one wake-up per turn" claim can be exercised against a
   * live agent. It is gated three ways: a config flag (`web.testHooks`), an explicit
   * option (offline fixtures) or `P1_TEST_HOOKS=on`; otherwise the route does not exist.
   */
  const testHooks =
    options.testHooks === true ||
    (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.web && ctx.cfg.agent.web.testHooks === true) ||
    process.env.P1_TEST_HOOKS === 'on';
  let harnessInject = null;
  /**
   * `port: 0` means "pick a free port" - offline fixtures rely on it, and `|| 8766` used to
   * silently turn 0 into 8766 (which then collided with a live agent on the same machine).
   */
  const requestedPort = options.port === undefined || options.port === null ? 8766 : Number(options.port);
  const port = Number.isFinite(requestedPort) ? requestedPort : 8766;
  const host = options.host || (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.web && ctx.cfg.agent.web.bind) || '127.0.0.1';
  /**
   * Access log for the panel endpoints.
   *
   * "The panel never updates" has three possible layers: the agent does not send fresh
   * state, the browser never asks for it, or the browser asks and renders something stale.
   * Guessing between them cost several rounds - this file answers the middle question
   * directly: if a manual refresh does not appear here, the request never arrived.
   */
  const accessFile = path.join((ctx.cfg && ctx.cfg.root) || process.cwd(), 'runtime', 'logs', 'panel-access.log');
  const access = (req, url) => {
    try {
      fs.mkdirSync(path.dirname(accessFile), { recursive: true });
      fs.appendFileSync(
        accessFile,
        `${new Date().toISOString()} ${req.method} ${url.pathname}${url.search} from ${req.socket.remoteAddress} ` +
          `ua="${String(req.headers['user-agent'] || '').slice(0, 60)}"\n`
      );
    } catch {
      /* logging must never break the panel */
    }
  };
  /** The port we actually ended up on; changes when 8766 is already taken. */
  let boundPort = port;
  const startedAt = new Date().toISOString();

  /**
   * Build the panel payload, never throwing.
   *
   * The panel used to go blank whenever anything in the state assembly threw (a 500 makes
   * the browser's fetch chain show "连接中断" and leaves every field at its placeholder).
   * A panel whose job is diagnosis must not fail silently: on error it now returns the
   * message itself, and the port the agent is really reachable on - which also catches the
   * "an older agent still owns 8766" case that looks identical from the browser.
   */
  const buildUiState = () => {
    const state = safeUiState(ctx, { port: boundPort, startedAt });
    if (state.ok === false) log.warn(`ui/state failed: ${state.error}`);
    return state;
  };

  /** Panel commands are inputs too: remember them so the routing table can show them. */
  const rememberPanelInput = (entry) => {
    if (!ctx.panelCommands) ctx.panelCommands = [];
    ctx.panelCommands.push({ at: new Date().toISOString(), kind: 'input', source: 'panel', ...entry });
    if (ctx.panelCommands.length > 20) ctx.panelCommands.shift();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/panel') || url.pathname === '/ui/state' || url.pathname === '/command') {
      access(req, url);
    }
    try {
      // ------------------------------------------------------- task events (SSE, P1 §1.4.4)
      /**
       * Same port, same token: the panel already owns :8766 and falls back to :8767 when it
       * is busy, so a second listener here would race that fallback (Q1).
       */
      if (req.method === 'GET' && url.pathname === '/events') {
        const web = (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.web) || {};
        streamEvents(req, res, { events: ctx.events, token: web.eventsToken || '' });
        return; // the stream owns the response until the client disconnects
      }

      /**
       * Autonomous-perception read surface for the behavior brain's `mc_perception` tool.
       * Read-only edge log; `type` is the perception family (threat/weather/phase/chat/all).
       */
      if (req.method === 'GET' && url.pathname === '/perception') {
        if (!ctx.perceptionWake || typeof ctx.perceptionWake.events !== 'function') {
          return json(res, 503, { ok: false, error: 'perception unavailable' });
        }
        return json(res, 200, {
          ok: true,
          seq: ctx.perceptionWake.seq,
          events: ctx.perceptionWake.events({
            type: url.searchParams.get('type') || 'all',
            since: Number(url.searchParams.get('since') || 0),
            limit: Number(url.searchParams.get('limit') || 20)
          })
        });
      }

      /**
       * Explicit state observation for the behavior brain's pre-task state skill.
       * No push: the action brain asks once with the fields it needs.
       */
      if (req.method === 'POST' && url.pathname === '/observe') {
        if (!ctx.observation || typeof ctx.observation.observe !== 'function') {
          return json(res, 503, { ok: false, error: 'observation unavailable' });
        }
        let body = {};
        try {
          body = JSON.parse((await readRaw(req)) || '{}');
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const result = await ctx.observation.observe({
          fields: body.fields,
          area: body.area,
          maxAgeMs: body.maxAgeMs,
          purpose: body.purpose
        });
        return json(res, 200, result);
      }

      /**
       * Task/plan memory shared with the behavior brain. The DSH `mc_memory` tool uses
       * this endpoint: grep reads saved episodic/task/plan/action-brain entries; save writes
       * natural text with source/conditions. It is not automatic context injection.
       */
      if (url.pathname === '/memory' && (req.method === 'GET' || req.method === 'POST')) {
        if (!ctx.memoryStore || typeof ctx.memoryStore.recall !== 'function') {
          return json(res, 503, { ok: false, error: 'memory unavailable' });
        }
        if (req.method === 'GET') {
          const tags = String(url.searchParams.get('tags') || '')
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean);
          const sources = String(url.searchParams.get('sources') || '')
            .split(',')
            .map((source) => source.trim())
            .filter(Boolean);
          const hits = ctx.memoryStore.recall(url.searchParams.get('query') || '', {
            category: url.searchParams.get('category') || undefined,
            source: url.searchParams.get('source') || undefined,
            sources,
            tags,
            limit: Math.min(Math.max(Number(url.searchParams.get('limit') || 10), 1), 100)
          });
          return json(res, 200, {
            ok: true,
            entries: hits.map(({ entry, score }) => ({ ...entry, score }))
          });
        }
        let body = {};
        try {
          body = JSON.parse((await readRaw(req)) || '{}');
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { ok: false, error: 'text required' });
        const stored = ctx.memoryStore.remember(body.category || 'episodic', {
          text,
          tags: Array.isArray(body.tags) ? body.tags : [],
          source: body.source || 'action-brain',
          data: body.data || null
        });
        if (!stored.ok) return json(res, 400, { ok: false, error: stored.reason });
        if (ctx.brain && typeof ctx.brain.scheduleStateSave === 'function') ctx.brain.scheduleStateSave();
        return json(res, 201, { ok: true, entry: stored.entry });
      }

      /**
       * Behavior-brain web lookup (A16). This is the Node network broker behind the
       * DeepSeek-harness `lookup_mod_content` tool. The language brain never sees a route
       * or tool for it; results are untrusted data and never an action.
       */
      if (req.method === 'POST' && url.pathname === '/lookup_mod_content') {
        let body = {};
        try {
          body = JSON.parse((await readRaw(req)) || '{}');
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const query = String(body.query || '').trim();
        if (!query) return json(res, 400, { ok: false, error: 'query required' });
        /**
         * A16 adversarial test hook: `P1_LOOKUP_FIXTURE=on` (src/index.js) installs a
         * fixture only for the magic query. Real lookups keep using the broker; the
         * fixture exists so "web page tells the agent to change permissions" is
         * reproducible without controlling a real search result.
         */
        if (typeof ctx.lookupFixture === 'function') {
          const fixture = ctx.lookupFixture(query);
          if (fixture) {
            return json(res, 200, { ...fixture, source: 'p1-lookup-fixture', untrusted: true });
          }
        }
        if (!ctx.webSearch || typeof ctx.webSearch.lookup !== 'function') {
          return json(res, 503, { ok: false, error: 'web lookup unavailable' });
        }
        const result = await ctx.webSearch.lookup(query, {
          count: body.count,
          needContent: body.needContent === true,
          oriQuestion: body.oriQuestion
        });
        return json(res, result.ok ? 200 : 502, {
          ...result,
          source: 'deepseek-web-search',
          untrusted: true
        });
      }

      // -------------------------------------------- plans (M3 live entry, localhost)
      /**
       * Harness-generated proposal: the action brain decides what to propose; Node's
       * ProposalDesk owns only the ask/cooldown/authorization lifecycle. With
       * planner.mode=off this is the only autonomous-proposal source.
       */
      if (req.method === 'POST' && url.pathname === '/propose') {
        if (!ctx.brain || typeof ctx.brain.proposeFromHarness !== 'function') {
          return json(res, 503, { ok: false, error: 'proposal service unavailable' });
        }
        let body = {};
        try {
          body = JSON.parse((await readRaw(req)) || '{}');
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const result = await ctx.brain.proposeFromHarness({
          type: body.type,
          name: body.name,
          args: body.args,
          reason: body.reason
        });
        return json(res, result.ok ? 202 : 400, result);
      }

      /**
       * `POST /plan` is the harness's plan-entry: a draft is validated by PlanService
       * (replan guard/budget), written through PlanStore and, unless `start:false`, run
       * through PlanRunner. The HTTP response is an acceptance, not a completion; clients
       * poll `GET /plan/<id>`, read `/events`, or pass `wait:true` for a bounded wait.
       *
       * These endpoints share `/command`'s localhost trust boundary. They do not expose a
       * remote control surface (the server binds 127.0.0.1 by default).
       */
      if (url.pathname === '/plan' && (req.method === 'GET' || req.method === 'POST')) {
        if (!ctx.planService) return json(res, 503, { ok: false, error: 'plan service unavailable' });
        if (req.method === 'GET') return json(res, 200, { ok: true, ...ctx.planService.status() });

        let body = {};
        try {
          body = JSON.parse((await readRaw(req)) || '{}');
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        /**
         * A turn needs the plan id before submission, because `trackPlan` must be installed
         * before the first step event; generate the id here when the caller omitted it.
         */
        const wantsTurn = body.start !== false && (body.turn === true || (body.turn && typeof body.turn === 'object'));
        const planId =
          body.planId ||
          (wantsTurn ? `plan-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` : undefined);
        const requestId = body.requestId || (body.turn && body.turn.requestId) || null;
        let turn = null;
        if (wantsTurn) {
          if (!ctx.turnService) return json(res, 503, { ok: false, error: 'turn service unavailable' });
          const begun = ctx.turnService.begin({ requestId, planId });
          if (!begun.ok) {
            return json(res, 409, { ok: false, error: begun.reason, activeTurn: begun.activeId || null });
          }
          turn = begun.turn;
        }
        const submitted = ctx.planService.submit(
          {
            planId,
            goal: body.goal,
            requestId,
            baseVersion: body.baseVersion,
            constraints: body.constraints,
            steps: body.steps
          },
          { source: wantsTurn ? 'harness' : 'http' }
        );
        if (!submitted.ok) {
          if (turn) ctx.turnService.cancel(turn.id, 'plan-rejected');
          const status = submitted.reason === 'stale' || submitted.reason === 'plan-busy' ? 409 : 400;
          return json(res, status, { ok: false, error: submitted.reason, planId: planId || null, detail: submitted });
        }
        if (turn) {
          const tracked = ctx.turnService.trackPlan(turn.id, submitted.plan.planId, 'mc_plan');
          if (!tracked.ok) {
            ctx.turnService.cancel(turn.id, 'plan-track-failed');
            return json(res, 409, { ok: false, error: tracked.reason, planId: submitted.plan.planId });
          }
        }
        if (body.start === false) {
          return json(res, 202, {
            ok: true,
            accepted: true,
            started: false,
            planId: submitted.plan.planId,
            version: submitted.version,
            turnId: turn ? turn.id : null,
            plan: submitted.plan
          });
        }
        const started = ctx.planService.start(submitted.plan.planId, { requestId });
        if (!started.ok) {
          if (turn) ctx.turnService.cancel(turn.id, started.reason || 'plan-start-failed');
          return json(res, 409, {
            ok: false,
            error: started.reason,
            planId: submitted.plan.planId,
            plan: ctx.planService.get(submitted.plan.planId)
          });
        }
        if (body.wait === true) {
          const timeout = Math.min(Math.max(Number(body.waitMs) || 10000, 100), 60000);
          const view = await ctx.planService.waitFor(submitted.plan.planId, timeout);
          return json(res, 200, {
            ok: true,
            accepted: true,
            waited: timeout,
            planId: submitted.plan.planId,
            version: submitted.version,
            turnId: turn ? turn.id : null,
            state: view ? view.state : null,
            plan: view
          });
        }
        return json(res, 202, {
          ok: true,
          accepted: true,
          started: true,
          planId: submitted.plan.planId,
          version: submitted.version,
          turnId: turn ? turn.id : null,
          state: ctx.planService.get(submitted.plan.planId).state,
          plan: ctx.planService.get(submitted.plan.planId)
        });
      }

      if (url.pathname.startsWith('/plan/')) {
        if (!ctx.planService) return json(res, 503, { ok: false, error: 'plan service unavailable' });
        const parts = url.pathname.split('/').filter(Boolean);
        const planId = decodeURIComponent(parts[1] || '');
        const action = parts[2] || '';
        if (!planId) return json(res, 400, { ok: false, error: 'planId required' });
        if (req.method === 'GET' && !action) {
          const plan = ctx.planService.get(planId);
          if (!plan) return json(res, 404, { ok: false, error: 'unknown-plan', planId });
          return json(res, 200, { ok: true, plan });
        }
        let body = {};
        if (req.method === 'POST') {
          try {
            body = JSON.parse((await readRaw(req)) || '{}');
          } catch {
            return json(res, 400, { ok: false, error: 'invalid JSON' });
          }
        }
        if (req.method === 'POST' && action === 'start') {
          const started = ctx.planService.start(planId, { requestId: body.requestId || null });
          if (!started.ok) {
            return json(res, 409, { ok: false, error: started.reason, planId, plan: ctx.planService.get(planId) });
          }
          return json(res, 202, {
            ok: true,
            accepted: true,
            planId,
            plan: ctx.planService.get(planId)
          });
        }
        if (req.method === 'POST' && action === 'resume') {
          const answer = body.answer === undefined ? true : body.answer;
          const started = ctx.planService.resume(planId, answer, { reason: body.reason || 'http' });
          if (!started.ok) {
            return json(res, 409, { ok: false, error: started.reason, planId, plan: ctx.planService.get(planId) });
          }
          if (body.wait === true) {
            const timeout = Math.min(Math.max(Number(body.waitMs) || 10000, 100), 60000);
            const settled = await Promise.race([
              started.promise,
              new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), timeout))
            ]);
            return json(res, 200, {
              ok: !!(settled && settled.ok),
              accepted: true,
              planId,
              result: settled,
              plan: ctx.planService.get(planId)
            });
          }
          return json(res, 202, { ok: true, accepted: true, planId, plan: ctx.planService.get(planId) });
        }
        if (req.method === 'POST' && action === 'cancel') {
          const cancelled = ctx.planService.cancel(planId, body.reason || 'http');
          const status = cancelled.ok ? 200 : 409;
          return json(res, status, {
            ...cancelled,
            planId,
            plan: ctx.planService.get(planId)
          });
        }
        return json(res, 404, { ok: false, error: 'not found' });
      }

      // -------------------------------------- harness turns (M3/F2, localhost)
      if (url.pathname === '/harness/events' && req.method === 'GET') {
        const web = (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.web) || {};
        if (!ctx.turnEvents) return json(res, 503, { ok: false, error: 'turn events unavailable' });
        streamEvents(req, res, { events: ctx.turnEvents, token: web.eventsToken || '' });
        return;
      }

      if (url.pathname === '/harness/turns' && req.method === 'GET') {
        if (!ctx.turnService) return json(res, 503, { ok: false, error: 'turn service unavailable' });
        return json(res, 200, { ok: true, ...ctx.turnService.status() });
      }

      if (url.pathname === '/harness/turn' && req.method === 'POST') {
        if (!ctx.turnService) return json(res, 503, { ok: false, error: 'turn service unavailable' });
        let body = {};
        try {
          body = JSON.parse((await readRaw(req)) || '{}');
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const begun = ctx.turnService.begin({ requestId: body.requestId, planId: body.planId });
        if (!begun.ok) return json(res, 409, { ok: false, error: begun.reason, activeTurn: begun.activeId || null });
        return json(res, 200, { ok: true, turn: begun.turn });
      }

      if (url.pathname.startsWith('/harness/turn/')) {
        if (!ctx.turnService) return json(res, 503, { ok: false, error: 'turn service unavailable' });
        const parts = url.pathname.split('/').filter(Boolean);
        const turnId = decodeURIComponent(parts[2] || '');
        const action = parts[3] || '';
        if (!turnId) return json(res, 400, { ok: false, error: 'turnId required' });
        let body = {};
        if (req.method === 'POST') {
          try {
            body = JSON.parse((await readRaw(req)) || '{}');
          } catch {
            return json(res, 400, { ok: false, error: 'invalid JSON' });
          }
        }
        if (req.method === 'POST' && action === 'wait') {
          let waited;
          if (body.planId) waited = ctx.turnService.trackPlan(turnId, String(body.planId), body.tool || 'mc_plan');
          else if (body.taskId) waited = ctx.turnService.waitTask(turnId, String(body.taskId), body.tool || null);
          else return json(res, 400, { ok: false, error: 'taskId or planId required' });
          return json(res, waited.ok ? 200 : 409, { ...waited, turn: ctx.turns.get(turnId) });
        }
        if (req.method === 'POST' && action === 'finish') {
          const finished = ctx.turnService.finish(turnId);
          return json(res, finished.ok ? 200 : 409, { ...finished, turn: ctx.turns.get(turnId) });
        }
        if (req.method === 'POST' && action === 'cancel') {
          const cancelled = ctx.turnService.cancel(turnId, body.reason || 'http');
          return json(res, cancelled.ok ? 200 : 409, { ...cancelled, turn: ctx.turns.get(turnId) });
        }
        if (req.method === 'GET' && !action) {
          const turn = ctx.turns.get(turnId);
          if (!turn) return json(res, 404, { ok: false, error: 'unknown-turn' });
          return json(res, 200, { ok: true, turn });
        }
        return json(res, 404, { ok: false, error: 'not found' });
      }

      /**
       * A28 injection (test hook; `web.testHooks` / `P1_TEST_HOOKS=on`).
       *
       *   GET  /harness/inject          what the injector is attached to
       *   POST /harness/inject          {kind:'plan',  planId, type, ...}  -> TurnService.onPlanEvent
       *                                 {kind:'turn',  turnId, type?, ...}  -> publish on the SSE ring
       *
       * Duplicate/out-of-order events go through the same entry points a real completion
       * uses, so the test covers the real dedupe path instead of a mock of it.
       */
      if (url.pathname === '/harness/inject' && (req.method === 'GET' || req.method === 'POST')) {
        if (!testHooks || !ctx.turnService) return json(res, 404, { ok: false, error: 'not found' });
        harnessInject = harnessInject || new HarnessInjector({ turnService: ctx.turnService, log });
        if (req.method === 'GET') return json(res, 200, harnessInject.status());
        let body = {};
        try {
          body = JSON.parse((await readRaw(req)) || '{}');
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const kind = String(body.kind || 'plan').toLowerCase();
        const result = kind === 'turn' ? harnessInject.turn(body) : harnessInject.plan(body);
        return json(res, result.ok ? 200 : 400, result);
      }

      // ------------------------------------------------------------ panel
      if (req.method === 'GET' && (url.pathname === '/panel' || url.pathname === '/panel/')) {
        /**
         * THE dashboard: server-rendered, zero JavaScript, whole page auto-reloads via
         * `<meta http-equiv="refresh" content="2">`.
         *
         * Three rounds of live debugging showed that anything the browser has to *execute*
         * (inline script, external script, iframe) can be missing in a given environment,
         * and the panel then looks dead while the agent is perfectly healthy. A plain HTML
         * page that reloads itself has no such dependency: the timestamp and the data are
         * re-rendered by the server every two seconds. Commands live on /panel/cmd (no
         * auto-refresh, so typing is not interrupted) and quick actions are ordinary links.
         */
        const html = dashboardPage(buildUiState());
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      if (req.method === 'GET' && url.pathname === '/panel/cmd') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(commandPage());
      }

      /**
       * The panel's script, as a separate same-origin file.
       *
       * Inline `<script>` blocks are what script-blocking extensions and some policies
       * refuse; an external file is the compatible form. It also makes "did the browser run
       * our code?" observable: the script's first statement beacons /panel/ping.
       */
      if (req.method === 'GET' && url.pathname === '/panel/app.js') {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store'
        });
        return res.end(PANEL_JS);
      }

      /**
       * Beacon target: proves the browser executed `/panel/app.js`.
       *
       * If this line never appears in the log while someone is looking at the panel, the
       * browser never ran the script - no amount of state plumbing on this side can help.
       */
      if (req.method === 'GET' && url.pathname === '/panel/ping') {
        log.info(`panel script executed in a browser (ping ${url.searchParams.get('t') || '?'})`);
        res.writeHead(204, { 'cache-control': 'no-store' });
        return res.end();
      }

      /**
       * The live state block, server-rendered and self-refreshing.
       *
       * Loaded in an iframe by the panel so it can never depend on JavaScript: `<meta
       * http-equiv="refresh">` re-fetches it every two seconds. If the browser refuses to
       * run scripts (or an extension blocks them), this is still a working live panel.
       */
      if (req.method === 'GET' && url.pathname === '/panel/state') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(statePage(buildUiState()));
      }

      if (req.method === 'GET' && url.pathname === '/ui/state') {
        return json(res, 200, buildUiState());
      }

      if (req.method === 'GET' && url.pathname === '/llm') {
        return json(res, 200, ctx.llm ? ctx.llm.status() : { enabled: false, disabledReason: 'no llm layer' });
      }

      // ------------------------------------------------------------ status
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true, alive: isAlive(ctx), body: bodyKind(ctx), state: controllerState(ctx) });
      }

      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, {
          bot: controllerSnapshot(ctx),
          world: ctx.world.summary(),
          brain: ctx.brain.status(),
          inventory: inventorySummary(inventorySource(ctx)),
          plugins: ctx.controller ? ctx.controller.loadedPlugins : undefined,
          mods: ctx.mods ? ctx.mods.summary() : undefined,
          target: ctx.target ? ctx.target : undefined,
          death: ctx.deathWatch ? ctx.deathWatch.status() : undefined,
          llm: ctx.llm ? { enabled: ctx.llm.enabled, model: ctx.llm.client.model, tokensToday: ctx.llm.tokensToday } : undefined,
          chatParticipation: ctx.chatParticipation ? ctx.chatParticipation.status() : undefined,
          proposalChat: ctx.proposalChat ? ctx.proposalChat.status() : undefined,
          codeSkills: ctx.codeSkills
            ? {
                candidates: ctx.codeSkills.list().length,
                promoted: ctx.codeSkills.store.promoted.size,
                active: ctx.codeSkills.status().active
              }
            : undefined,
          updatedAt: new Date().toISOString()
        });
      }

      if (req.method === 'GET' && url.pathname === '/mods') {
        if (!ctx.mods) return json(res, 503, { ok: false, error: 'mod knowledge unavailable' });
        return json(res, 200, {
          detected: ctx.mods.detected,
          report: ctx.mods.report,
          guidance: ctx.mods.guidance(),
          learned: {
            items: Object.keys(ctx.mods.learned.items || {}).length,
            blocks: Object.keys(ctx.mods.learned.blocks || {}).length,
            servers: Object.keys(ctx.mods.learned.servers || {}).length
          }
        });
      }

      if (req.method === 'GET' && url.pathname === '/inventory') {
        return json(res, 200, inventorySummary(inventorySource(ctx)));
      }

      if (req.method === 'GET' && url.pathname === '/logs') {
        const n = Number(url.searchParams.get('n')) || 50;
        return json(res, 200, { lines: ctx.log.recent(n) });
      }

      // ---------------------------------------------------- code skills (M4)
      if (req.method === 'GET' && url.pathname === '/code-skills') {
        if (!ctx.codeSkills) return json(res, 503, { ok: false, error: 'code skills unavailable' });
        return json(res, 200, { ok: true, ...ctx.codeSkills.status() });
      }

      if (req.method === 'POST' && url.pathname === '/code-skills/generate') {
        if (!ctx.codeSkills) return json(res, 503, { ok: false, error: 'code skills unavailable' });
        const body = await readBody(req);
        if (!body || !body.prompt) return json(res, 400, { ok: false, error: 'missing "prompt"' });
        try {
          const result =
            body.trial === true
              ? await ctx.codeSkills.generateAndTrial({
                  prompt: body.prompt,
                  manifest: body.manifest || null,
                  params: body.params || {},
                  timeoutMs: body.timeoutMs
                })
              : await ctx.codeSkills.generateCandidate({
                  prompt: body.prompt,
                  manifest: body.manifest || null
                });
          let promoted = null;
          if (body.promote === true && result.ok && result.name && result.version && result.trial && result.trial.ok) {
            promoted = ctx.codeSkills.promote(result.name, result.version);
          }
          return json(res, 200, { ...result, promoted });
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/code-skills/cancel') {
        if (!ctx.codeSkills) return json(res, 503, { ok: false, error: 'code skills unavailable' });
        const body = await readBody(req);
        if (body && body.all === true) return json(res, 200, ctx.codeSkills.cancelAll());
        if (body && body.name) {
          return json(res, 200, ctx.codeSkills.cancel(String(body.name), String(body.version || '')));
        }
        return json(res, 400, { ok: false, error: 'missing "name" or "all"' });
      }

      if (req.method === 'POST' && url.pathname === '/code-skills/rollback') {
        if (!ctx.codeSkills) return json(res, 503, { ok: false, error: 'code skills unavailable' });
        const body = await readBody(req);
        if (!body || !body.name) return json(res, 400, { ok: false, error: 'missing "name"' });
        return json(res, 200, ctx.codeSkills.rollback(String(body.name)));
      }

      const codeSkillRun = url.pathname.match(/^\/code-skills\/([^/]+)\/run$/);
      if (req.method === 'POST' && codeSkillRun) {
        if (!ctx.codeSkills) return json(res, 503, { ok: false, error: 'code skills unavailable' });
        const body = await readBody(req);
        try {
          const result = await ctx.codeSkills.runPromoted(
            decodeURIComponent(codeSkillRun[1]),
            (body && body.params) || {},
            { timeoutMs: body && body.timeoutMs }
          );
          return json(res, 200, result);
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      const codeSkillTrial = url.pathname.match(/^\/code-skills\/([^/]+)\/([^/]+)\/trial$/);
      if (req.method === 'POST' && codeSkillTrial) {
        if (!ctx.codeSkills) return json(res, 503, { ok: false, error: 'code skills unavailable' });
        const body = (await readBody(req)) || {};
        try {
          const result = await ctx.codeSkills.trial(decodeURIComponent(codeSkillTrial[1]), decodeURIComponent(codeSkillTrial[2]), {
            params: body.params || {},
            timeoutMs: body.timeoutMs
          });
          return json(res, 200, result);
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      const codeSkillAction = url.pathname.match(/^\/code-skills\/([^/]+)\/([^/]+)\/(promote|retire)$/);
      if (req.method === 'POST' && codeSkillAction) {
        if (!ctx.codeSkills) return json(res, 503, { ok: false, error: 'code skills unavailable' });
        const name = decodeURIComponent(codeSkillAction[1]);
        const version = decodeURIComponent(codeSkillAction[2]);
        if (codeSkillAction[3] === 'promote') {
          return json(res, 200, ctx.codeSkills.promote(name, version));
        }
        return json(res, 200, ctx.codeSkills.retire(name, version));
      }

      /**
       * Action-brain speech (A16/M3 live entry): the DSH `mc_say` tool posts one short line
       * here. This is deliberately not a command channel: reply() sanitizes it (no leading
       * `!`/`/`), applies maxChars and registers the echo before sending.
       */
      if (req.method === 'POST' && url.pathname === '/say') {
        if (typeof ctx.reply !== 'function') {
          return json(res, 503, { ok: false, error: 'reply unavailable' });
        }
        let body = {};
        try {
          body = JSON.parse((await readRaw(req)) || '{}');
        } catch {
          return json(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { ok: false, error: 'text required' });
        const max =
          (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.chat && ctx.cfg.agent.chat.maxChars) || 100;
        const line = text.slice(0, Math.max(Number(max) || 100, 1));
        /**
         * Unified language brain (docs/LANGUAGE-BRAIN-REPAIR.md): the action brain does not
         * message the player directly. `mc_say` posts source=action-brain, the language brain
         * rewords it (or chooses silence), and only then does it reach reply().
         *
         * Silence is honored. If the language brain itself fails (model/no channel), the
         * original line falls back to reply() rather than dropping a failure/status report;
         * this is the only direct action-brain path and is marked as fallback.
         */
        if (ctx.languageBrain && body.source === 'action-brain') {
          let rendered;
          try {
            rendered = await ctx.languageBrain.renderActionOutput(text, {
              meta: { requestId: body.requestId || null }
            });
          } catch (err) {
            return json(res, 500, { ok: false, error: err.message });
          }
          if (rendered.ok === false) {
            let sent = false;
            try {
              sent = await ctx.reply(line, { why: 'action-brain-say-fallback' });
            } catch (err) {
              return json(res, 500, { ok: false, error: err.message });
            }
            return json(res, 200, {
              ok: sent === true,
              sent: sent === true,
              text: line,
              via: 'fallback',
              reason: rendered.reason || 'language-failed',
              fallback: true
            });
          }
          return json(res, 200, {
            ok: true,
            sent: rendered.spoke === true,
            text: rendered.text || null,
            via: 'language-brain',
            reason: rendered.spoke === true ? null : rendered.reason || 'language-silence'
          });
        }
        let sent = false;
        try {
          sent = await ctx.reply(line, { why: 'action-brain-say' });
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
        return json(res, 200, {
          ok: sent === true,
          sent: sent === true,
          text: line,
          reason: sent === true ? null : 'not-sent'
        });
      }

      // ----------------------------------------------------------- control
      if ((req.method === 'POST' || req.method === 'GET') && url.pathname === '/command') {
        /**
         * Two content types, on purpose:
         *  - JSON from the panel's fetch (and tooling);
         *  - form-encoded from the plain `<form>` fallback, which works with JavaScript
         *    completely disabled. A form post gets a 303 back to the panel so the browser
         *    lands on a fresh state page.
         */
        const raw = await readRaw(req);
        const isForm = String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded');
        let body = {};
        if (isForm) {
          const params = new URLSearchParams(raw);
          body = { command: params.get('command') || '', priority: params.get('priority') || '' };
        } else {
          try {
            body = raw ? JSON.parse(raw) : {};
          } catch {
            body = {};
          }
        }
        const command = (body && body.command) || url.searchParams.get('command');
        if (!command) return json(res, 400, { ok: false, error: 'missing "command"' });
        if (!ctx.chat) return json(res, 503, { ok: false, error: 'chat controller unavailable' });

        // "goto-here" is the panel's 🚶 button: walk to the player's own position, which
        // is only knowable from the live body snapshot (the chat log carries no sender).
        const line = String(command).trim() === 'goto-here' ? gotoHereLine(ctx) : command;
        if (!line) return json(res, 400, { ok: false, error: 'no position available for goto-here' });

        const priority = normalizePriority((body && body.priority) || url.searchParams.get('priority'));
        const started = Date.now();

        /**
         * Route the panel exactly like the in-game channels do.
         *
         * In game, `!cmd` goes to the deterministic command table and `<trigger> ...` goes to
         * the LLM. The panel used to send everything to the command table, so the most natural
         * thing a user types - `@大肥鱼 挖点土` - answered "unknown command @大肥鱼" and never
         * reached the model. A leading `!` is tolerated here as well, because people paste the
         * in-game form into the box.
         *
         * The trigger is resolved through `resolveTrigger` rather than read from the config
         * directly: both this file and the chat listener need it, and two independent
         * hardcoded fallbacks is how the panel ends up routing a dead trigger after a
         * character swap.
         */
        const trimmed = String(line).trim();
        const trigger = resolveTrigger(ctx, { log });
        const isDialogue =
          !!trigger &&
          trimmed.startsWith(trigger) &&
          (!!ctx.languageBrain ||
            !!ctx.dialogueRouter ||
            (ctx.llm && typeof ctx.llm.handle === 'function'));
        if (isDialogue) {
          const utterance = trimmed.slice(trigger.length).trim();
          const snap = ctx.body && typeof ctx.body.snapshot === 'function' ? ctx.body.snapshot() : null;
          /**
           * Unified mode: the panel is just another player-style entry, so it enters the same
           * language brain. An action request is approved and forwarded as original text; a
           * chat/knowledge line is answered (or silenced) by the language brain itself.
           */
          if (ctx.languageBrain) {
            recordPlayerMessage(ctx.chatMemory, {
              from: 'panel',
              text: utterance,
              prefix: '!',
              ownName: null
            });
            const record = await ctx.languageBrain.handle({
              text: utterance,
              source: 'panel',
              speaker: 'panel',
              profile: 'auto',
              meta: { agentPosition: snap ? snap.position : null }
            });
            rememberPanelInput({
              text: utterance,
              via: 'panel-dialogue',
              action: record.profile || record.mode || null
            });
            return json(res, 200, {
              ok: record.ok !== false,
              routed: 'dialogue',
              mode: 'language-brain',
              profile: record.profile || null,
              decision: record.decision || null,
              forwarded: record.forwarded || null,
              reason: record.reason || null,
              level: priority,
              ms: Date.now() - started
            });
          }
          /**
           * The panel must follow the same brain as the in-game channel. In harness mode a
           * failure is reported, not routed to the local planner.
           */
          if (ctx.dialogueRouter) {
            const routed = await ctx.dialogueRouter.route(utterance, {
              source: 'panel',
              speaker: 'panel',
              agentPosition: snap ? snap.position : null
            });
            rememberPanelInput({
              text: utterance,
              via: 'panel-dialogue',
              action: routed.mode || null
            });
            return json(res, 200, {
              ok: routed.ok !== false,
              routed: 'dialogue',
              mode: routed.mode,
              handoff: routed.handoff === true,
              forwarded: routed.forwarded || null,
              reason: routed.reason || null,
              level: priority,
              ms: Date.now() - started
            });
          }
          const record = await ctx.llm.handle(utterance, {
            source: 'panel',
            speaker: 'panel',
            speakerPosition: snap ? snap.position : null
          });
          rememberPanelInput({ text: utterance, via: 'panel-dialogue', action: record && record.action ? record.action : null });
          return json(res, 200, { ok: true, routed: 'dialogue', record, level: priority, ms: Date.now() - started });
        }

        const commandLine = trimmed.startsWith('!') ? trimmed.slice(1).trim() : trimmed;
        const result = await ctx.chat.handle(commandLine, `http:${priority}`);
        rememberPanelInput({ text: trimmed, via: 'panel', action: commandLine });
        if (isForm || req.method === 'GET') {
          res.writeHead(303, { location: '/panel', 'cache-control': 'no-store' });
          return res.end();
        }
        return json(res, 200, { ...result, level: priority, ms: Date.now() - started });
      }

      if (req.method === 'POST' && url.pathname === '/emergency-stop') {
        return json(res, 200, emergencyStop(ctx));
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      log.warn(`request failed: ${err.message}`);
      return json(res, 500, { ok: false, error: err.message });
    }
  });

  server.listen(port, host, () => {
    boundPort = server.address() && server.address().port ? server.address().port : port;
    log.info(`control panel on http://${host}:${boundPort}/panel  (API: /ui/state, /command, /emergency-stop, /llm)`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && port !== 0) {
      // Another agent (or an older instance) owns the port: not fatal, the bot itself is
      // what matters. Say so loudly, because a browser still pointed at the old port will
      // show an empty panel and look broken while a forgotten agent answers its commands.
      log.warn(
        `port ${port} is already owned by another agent - the panel moves to ` +
          `http://${host}:${port + 1}/panel. Stop the old agent and restart to get ${port} back.`
      );
      boundPort = port + 1;
      server.listen(port + 1, host, () => {
        log.info(`control panel on http://${host}:${port + 1}/panel (fallback; ${port} was busy)`);
      });
      return;
    }
    log.warn(`status server error: ${err.message}`);
  });

  return {
    server,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// --------------------------------------------------------------------- helpers

/** Slim state for the panel. Explicitly excludes `blocks.cells`. */
function uiState(ctx) {
  const world = ctx.world && ctx.world.summary ? ctx.world.summary() : { ready: false };
  const brain = ctx.brain ? ctx.brain.status() : { running: false };
  const cfg = (ctx.cfg && ctx.cfg.agent) || {};
  // Resolved once here: the panel shows which character is loaded, and a failed load is
  // otherwise invisible (the bot just answers out of character).
  const character = personaForConfig(ctx);
  const pathFile = (cfg.pathfinding && cfg.pathfinding.trace) || 'runtime/path-trace.jsonl';
  const llmFile = (ctx.cfg && ctx.cfg.llm && ctx.cfg.llm.trace && ctx.cfg.llm.trace.file) || 'runtime/llm-trace.jsonl';

  return {
    identity: {
      name: (cfg.bot && cfg.bot.username) || 'agent',
      /**
       * The character sheet's name, shown next to the account name.
       *
       * They are usually different (`agent` the account, 大肥鱼 the character) and the operator
       * needs to see which persona is loaded - a persona file that silently failed to load is
       * otherwise invisible until the bot says something out of character.
       */
      character: character.name,
      characterLoaded: !!character.loaded,
      trigger: resolveTrigger(ctx),
      bodyKind: bodyKind(ctx),
      bodyReady: isAlive(ctx)
    },
    world: {
      ready: world.ready,
      health: world.health,
      food: world.food,
      position: world.position || null,
      dimension: world.dimension,
      heldItem: world.heldItem || null,
      emptySlots: world.emptySlots,
      screenOpen: world.screenOpen === true,
      screen: world.screen || null,
      mouseGrabbed: world.mouseGrabbed !== false
    },
    brain: {
      running: brain.running,
      paused: brain.paused,
      stopped: brain.stopped,
      autoPlanDisabled: brain.autoPlanDisabled === true,
      stoppedReason: brain.stoppedReason,
      holdReason: brain.holdReason || null,
      holds: Array.isArray(brain.holds) ? brain.holds : [],
      safeMode: brain.safeMode,
      current: brain.current,
      queueLength: brain.queueLength,
      queued: (brain.queued || []).slice(0, 8)
    },
    /**
     * Second-batch machinery: the background task slot, the pending permission question,
     * the rules and the named places. Same reasoning as the block scan: summaries only, so
     * the one-second panel poll stays small.
     */
    hub: ctx.hub ? ctx.hub.status() : { busy: false, current: null, recent: [] },
    consent: ctx.consent ? ctx.consent.status() : { pending: null, recent: [] },
    permissions: ctx.permissions ? ctx.permissions.summary() : null,
    places: ctx.places
      ? { areas: ctx.places.listAreas().length, routes: ctx.places.listRoutes().length }
      : null,
    death: ctx.deathWatch ? ctx.deathWatch.status() : { dead: false, deaths: 0, lastDeath: null },
    llm: ctx.llm
      ? {
          enabled: ctx.llm.enabled,
          disabledReason: ctx.llm.disabledReason,
          model: ctx.llm.client.model,
          tokensToday: ctx.llm.tokensToday,
          budgetExceeded: ctx.llm.budgetExceeded,
          /** What the model is allowed to *do*, not just say - a security-relevant view. */
          tools: ctx.llm.status().tools
        }
      : { enabled: false, disabledReason: 'no llm layer' },
    /**
     * Last natural-language routing decision. It exists so "why did the bot not act?" is
     * answerable from the panel: harness / planner-first / planner, and whether a forward
     * failed or the local planner handed off.
     */
    dialogue: ctx.lastDialogueRoute || null,
    /** Input -> routing, so the panel can show "did it understand me?" */
    recentInputs: [
      ...((ctx.llm && ctx.llm.turns) || []),
      ...((ctx.chatListener && ctx.chatListener.recent) || []).slice(-3),
      ...(ctx.panelCommands || [])
    ]
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
      .slice(-8),
    replies: (ctx.replies || []).slice(-4),
    logs: (ctx.log && ctx.log.recent ? ctx.log.recent(60) : []).slice(-60),
    traces: {
      pathFile,
      llmFile,
      pathLines: countTrace(pathFile),
      llmLines: countTrace(llmFile)
    },
    updatedAt: new Date().toISOString()
  };
}

/**
 * `uiState` that can never throw.
 *
 * The panel used to go fully blank whenever any part of the state assembly raised: the
 * handler answered 500, the browser's fetch chain failed and every field stayed at its
 * HTML placeholder - which reads exactly like "the agent is gone". A diagnostic page must
 * survive its own subject failing, so errors are returned as data instead.
 *
 * @param {object} ctx
 * @param {{port:number, startedAt:string}} panel
 */
function safeUiState(ctx, panel) {
  try {
    const state = uiState(ctx);
    state.panel = panel;
    return state;
  } catch (err) {
    return {
      ok: false,
      error: `panel state failed: ${err.message}`,
      panel,
      updatedAt: new Date().toISOString()
    };
  }
}

/**
 * Server-rendered snapshot for the top of the panel page.
 *
 * Written into the HTML at request time, so it needs no JavaScript: a reader whose browser
 * blocks scripts (or who is looking at a cached copy from somewhere else) can still tell
 * whether the page really came from a live agent, and can see position/health on load. The
 * `<noscript>` note explains why the buttons and the 1-second refresh are inert.
 */
function bootBlock(state) {
  const esc = (value) =>
    String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const at = new Date().toISOString();
  if (!state || state.ok === false) {
    return (
      '<div id="boot" style="background:#3d1418;border:1px solid #f85149;border-radius:8px;padding:10px 12px;margin-bottom:10px;color:#ffd7d7">' +
      `<b>⚠ 面板状态不可用</b>（服务端于 ${esc(at)} 生成）：${esc(state && state.error)}` +
      '<div style="margin-top:4px">agent 还在运行，但它无法读取游戏状态；请查看 agent 控制台日志。</div>' +
      '<noscript><div style="margin-top:6px">另外：你的浏览器没有执行 JavaScript，实时刷新与按钮都不可用。</div></noscript>' +
      '</div>'
    );
  }
  const world = state.world || {};
  const identity = state.identity || {};
  const pos = world.position
    ? `${Math.round(world.position.x)}, ${Math.round(world.position.y)}, ${Math.round(world.position.z)}`
    : '-';
  const screen = world.screenOpen
    ? `<span style="color:#f85149">⚠ 游戏界面开着（${esc(world.screen || '?')}），机器人无法移动</span>`
    : '';
  return (
    '<div id="boot" style="background:#1d2733;border:1px solid #2b4d7d;border-radius:8px;padding:10px 12px;margin-bottom:10px;color:#cfe4ff">' +
    `<b>服务器端快照</b>（${esc(at)} · 端口 ${esc(state.panel ? state.panel.port : '?')}） · ` +
    `agent <b>${esc(identity.name)}</b> · body ${esc(identity.bodyKind)}${identity.bodyReady ? '' : '（未连接）'} · ` +
    `pos ${esc(pos)} · hp ${esc(world.health)}/20 · food ${esc(world.food)} ${screen}` +
    '<div style="margin-top:4px;color:#8b93a1">这一段由服务器直接写入页面，不需要 JavaScript。' +
    '若刷新后时间戳不变，说明你打开的不是这份 agent 的页面。</div>' +
    '<div style="margin-top:6px;color:#ffd7d7;font-weight:600">⚠ 必须通过地址栏的 ' +
    '<span style="color:#ffb3b3">http://127.0.0.1:8766/panel</span> 打开本页。' +
    '如果地址栏是 <span style="color:#ffb3b3">file:///…（另存为到本地的副本）</span>，' +
    '时间戳会永远停在保存那一刻、按钮也不会生效 —— 请关闭该文件，改用上面的网址。</div>' +
    '<noscript><div style="margin-top:6px;color:#f85149">⚠ 你的浏览器没有执行 JavaScript（被禁用或被扩展拦截）：' +
    '实时刷新与按钮都不可用。请允许此站点运行脚本，或换一个浏览器。</div></noscript>' +
    '</div>'
  );
}

/**
 * Standalone, server-rendered state page for `/panel/state` (the iframe fallback).
 *
 * No JavaScript anywhere: a `<meta http-equiv="refresh" content="2">` keeps it current, so a
 * browser that refuses to execute scripts still shows live data. Everything is escaped.
 */
/** Shared CSS for the server-rendered pages. */
const PANEL_CSS =
  'body{margin:0;padding:10px 12px;background:#14161a;color:#e6e8ec;' +
  'font:13px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}' +
  '.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}' +
  '.pill{border:1px solid #2b3038;border-radius:999px;padding:1px 9px}' +
  '.dim{color:#8b93a1}.err{color:#f85149}.ok{color:#3fb950}' +
  'a.btn,button{display:inline-block;background:#22272e;color:#e6e8ec;border:1px solid #2b3038;' +
  'border-radius:6px;padding:6px 11px;margin:2px 4px 2px 0;text-decoration:none;font:inherit}' +
  'a.btn:hover,button:hover{border-color:#58a6ff}' +
  'input[type=text]{background:#0e1013;color:#e6e8ec;border:1px solid #2b3038;border-radius:6px;' +
  'padding:8px 10px;font:inherit;min-width:340px}' +
  'table{width:100%;border-collapse:collapse;margin-top:6px}' +
  'th,td{text-align:left;border-bottom:1px solid #2b3038;padding:2px 5px;font-size:12px}' +
  '#log{margin-top:6px;font-family:Consolas,monospace;white-space:pre-wrap;max-height:150px;overflow:auto}' +
  '.card{background:#1c1f26;border:1px solid #2b3038;border-radius:8px;padding:9px 11px;margin-bottom:8px}';

/**
 * The main dashboard: pure server-rendered HTML, whole-page meta refresh every 2 seconds.
 *
 * No JavaScript, no iframe, no fetch - just a page the browser reloads, so the data always
 * updates even in the most locked-down environment. Commands are ordinary links; the text
 * box lives on /panel/cmd so a reload cannot wipe what someone is typing.
 */
function dashboardPage(state) {
  const esc = (value) =>
    String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const at = new Date().toISOString();
  const head =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="2"><title>Minecraft Agent 控制面板</title>' +
    `<style>${PANEL_CSS}</style></head><body>`;
  const quick = (command, label) =>
    `<a class="btn" href="/command?command=${encodeURIComponent(command)}&priority=directive">${label}</a>`;
  const foot =
    '<div class="dim" style="margin-top:8px">本页由服务器每 2 秒自动重载（浏览器原生 meta refresh，' +
    '不需要 JavaScript）。指令请到 <a href="/panel/cmd" style="color:#58a6ff">✍ 发送指令</a> 页面输入。</div>' +
    '</body></html>';

  if (!state || state.ok === false) {
    return `${head}<div class="card err">⚠ 面板状态不可用（${esc(at)}）：${esc(state && state.error)}</div></body></html>`;
  }
  const identity = state.identity || {};
  const world = state.world || {};
  const brain = state.brain || {};
  const llm = state.llm || {};
  const pos = world.position
    ? `${Math.round(world.position.x)}, ${Math.round(world.position.y)}, ${Math.round(world.position.z)}`
    : '-';
  const rows = (state.recentInputs || [])
    .slice(-8)
    .reverse()
    .map((r) => {
      const action = r.action || (r.kind === 'understood-nothing' ? '未听懂 → 已回问' : '(仅回话)');
      return `<tr><td>${esc(r.text)}</td><td>${esc(r.source)}</td><td>${esc(r.via || '')}</td><td>${esc(action)}</td></tr>`;
    })
    .join('');
  const logs = (state.logs || [])
    .slice(-16)
    .map((l) => `<div>${esc(l)}</div>`)
    .join('');

  return (
    head +
    '<div class="card">' +
    '<div class="row">' +
    `<span class="pill">服务器端实时状态 · ${esc(at)} · 端口 ${esc(state.panel ? state.panel.port : '?')}</span>` +
    `<span class="pill">${esc(identity.name)} / ${esc(identity.bodyKind)}${identity.bodyReady ? '' : '（未连接）'}</span>` +
    `<span class="pill">hp ${esc(world.health)}/20</span>` +
    `<span class="pill">food ${esc(world.food)}</span>` +
    `<span class="pill">pos ${esc(pos)}</span>` +
    `<span class="pill">${esc(world.dimension)}</span>` +
    (world.screenOpen ? `<span class="err">⚠ 游戏界面开着（${esc(world.screen || '?')}），无法移动</span>` : '') +
    '</div>' +
    '<div class="row" style="margin-top:6px">' +
    `<span class="dim">大脑:</span><span class="${brain.stopped ? 'err' : 'ok'}">${brain.stopped ? '已停止' : brain.paused ? '暂停' : brain.running ? '运行中' : '未启动'}</span>` +
    `<span class="dim">当前:</span><span>${esc(brain.current ? brain.current.description : 'idle')}</span>` +
    `<span class="dim">队列:</span><span>${esc(brain.queueLength)}</span>` +
    `<span class="dim">LLM:</span><span>${llm.enabled ? '✅ ' + esc(llm.model) : '未启用'}</span>` +
    `<span class="dim">手持:</span><span>${esc(world.heldItem || '空')}</span>` +
    (brain.autoPlanDisabled
      ? '<span class="err">⏹ 自动规划已停（发 !resume 继续；!mine/!chop 等明确指令仍可执行）</span>'
      : '') +
    '</div>' +
    '<div class="row" style="margin-top:6px">' +
    '<a class="btn" href="/panel/cmd" style="background:#1d3a24;border-color:#2f6b3d">✍ 发送指令</a>' +
    quick('status', '📊 状态') + quick('inv', '🎒 背包') + quick('where', '🧭 位置') +
    quick('chop 8', '🪓 砍树') + quick('mine dirt 8', '⛏ 挖泥土') + quick('mine stone 8', '⛏ 挖石') +
    quick('defend 6', '🛡 自卫') + '<a class="btn" href="/emergency-stop" style="background:#4a1d1d;border-color:#7d2b2b">⏹ 急停</a>' +
    '</div></div>' +
    '<div class="card"><div class="dim">最近识别到的输入 → 路由结果</div>' +
    '<table><thead><tr><th style="width:34%">输入</th><th style="width:14%">来源</th><th style="width:14%">路由</th><th>动作 / 结果</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="4" class="dim">暂无</td></tr>') +
    '</tbody></table></div>' +
    `<div class="card"><div class="dim">日志（最近 ${Math.min(16, (state.logs || []).length)} 条）</div><div id="log">${logs || '<span class="dim">（暂无日志）</span>'}</div></div>` +
    foot
  );
}

/** The command page: a plain form, no auto-refresh, so typing is never interrupted. */
function commandPage() {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>发送指令 · Minecraft Agent</title>' +
    `<style>${PANEL_CSS}</style></head><body>` +
    '<div class="card"><div class="row"><strong>发送指令</strong>' +
    '<span class="dim">`!mine dirt 8` 是指令通道；`@<角色名> 挖点土` 是自然语言通道</span></div>' +
    '<form method="post" action="/command" style="margin-top:8px">' +
    '<div class="row"><input type="text" name="command" autofocus autocomplete="off" spellcheck="false" placeholder="例如 !mine dirt 8 或 @<角色名> 挖点土">' +
    '<label><input type="radio" name="priority" value="directive" checked> 指令</label>' +
    '<label><input type="radio" name="priority" value="urgent"> 紧急</label>' +
    '<button type="submit">发送</button></div></form>' +
    '<div class="dim" style="margin-top:8px">发送后会返回面板；面板每 2 秒自动刷新。' +
    '<a href="/panel" style="color:#58a6ff">← 返回面板</a></div></div>' +
    '</body></html>'
  );
}

function statePage(state) {
  const esc = (value) =>
    String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const at = new Date().toISOString();
  const style =
    'body{margin:0;padding:8px 10px;background:#14161a;color:#e6e8ec;' +
    'font:12px/1.55 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}' +
    '.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}' +
    '.pill{border:1px solid #2b3038;border-radius:999px;padding:1px 8px}' +
    '.dim{color:#8b93a1}.err{color:#f85149}.ok{color:#3fb950}' +
    'table{width:100%;border-collapse:collapse;margin-top:6px}' +
    'th,td{text-align:left;border-bottom:1px solid #2b3038;padding:2px 4px;font-size:12px}' +
    '#log{margin-top:6px;font-family:Consolas,monospace;white-space:pre-wrap;max-height:70px;overflow:hidden}';
  const head =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta http-equiv="refresh" content="2"><title>状态</title>' +
    `<style>${style}</style></head><body>`;

  if (!state || state.ok === false) {
    return `${head}<div class="err">⚠ 面板状态不可用（${esc(at)}）：${esc(state && state.error)}</div></body></html>`;
  }
  const identity = state.identity || {};
  const world = state.world || {};
  const brain = state.brain || {};
  const llm = state.llm || {};
  const pos = world.position
    ? `${Math.round(world.position.x)}, ${Math.round(world.position.y)}, ${Math.round(world.position.z)}`
    : '-';
  const rows = (state.recentInputs || [])
    .slice(-6)
    .reverse()
    .map((r) => {
      const action = r.action || (r.kind === 'understood-nothing' ? '未听懂 → 已回问' : '(仅回话)');
      return `<tr><td>${esc(r.text)}</td><td>${esc(r.source)}</td><td>${esc(r.via || '')}</td><td>${esc(action)}</td></tr>`;
    })
    .join('');
  const logs = (state.logs || [])
    .slice(-12)
    .map((l) => `<div>${esc(l)}</div>`)
    .join('');

  return (
    head +
    '<div style="margin-bottom:6px;color:#ffd7d7">⚠ 本页必须通过 http://127.0.0.1:8766/panel/state 访问；' +
    '另存为到本地的副本不会更新。</div>' +
    '<div class="row">' +
    `<span class="pill">服务器端实时状态 · ${esc(at)} · 端口 ${esc(state.panel ? state.panel.port : '?')}</span>` +
    `<span class="pill">${esc(identity.name)} / ${esc(identity.bodyKind)}${identity.bodyReady ? '' : '（未连接）'}</span>` +
    `<span class="pill">hp ${esc(world.health)}/20</span>` +
    `<span class="pill">food ${esc(world.food)}</span>` +
    `<span class="pill">pos ${esc(pos)}</span>` +
    `<span class="pill">${esc(world.dimension)}</span>` +
    (world.screenOpen ? `<span class="err">⚠ 游戏界面开着（${esc(world.screen || '?')}），无法移动</span>` : '') +
    '</div>' +
    '<div class="row" style="margin-top:6px">' +
    `<span class="dim">大脑:</span><span class="${brain.stopped ? 'err' : 'ok'}">${brain.stopped ? '已停止' : brain.paused ? '暂停' : brain.running ? '运行中' : '未启动'}</span>` +
    `<span class="dim">当前:</span><span>${esc(brain.current ? brain.current.description : 'idle')}</span>` +
    `<span class="dim">队列:</span><span>${esc(brain.queueLength)}</span>` +
    `<span class="dim">LLM:</span><span>${llm.enabled ? '✅ ' + esc(llm.model) : '未启用'}</span>` +
    '<span class="dim">本块每 2 秒由服务器自刷新，不需要 JavaScript</span>' +
    '</div>' +
    '<table><thead><tr><th>最近输入</th><th>来源</th><th>路由</th><th>动作 / 结果</th></tr></thead><tbody>' +
    (rows || '<tr><td colspan="4" class="dim">暂无</td></tr>') +
    `</tbody></table><div id="log">${logs || '<span class="dim">（暂无日志）</span>'}</div>` +
    '</body></html>'
  );
}

/**
 * The four-stage emergency stop (§4.2.2), reporting each stage.
 *
 * Order matters: the Node-side cancel is instant and idempotent, and it must happen before
 * the HTTP stop so the navigator cannot issue a fresh `moveto` in between.
 */
function emergencyStop(ctx) {
  const started = Date.now();
  const steps = {};

  try {
    if (ctx.brain) {
      ctx.brain.preempt();
      ctx.brain.queue.length = 0;
      // The hold table is the preferred entry; a lightweight brain stub (selftest, doctor)
      // may not have it, and silently missing the stop would be worse than the flag.
      if (typeof ctx.brain.hold === 'function') ctx.brain.hold('owner-stop', 'panel emergency stop');
      else ctx.brain.autoPlanDisabled = true;
      // The background task slot is not the brain queue; an emergency stop means both.
      if (ctx.hub && typeof ctx.hub.cancel === 'function') ctx.hub.cancel('panel emergency stop').catch(() => {});
      // Plans and harness turns drive the same body; stop them before reporting success.
      if (ctx.planService && typeof ctx.planService.cancelAll === 'function') {
        ctx.planService.cancelAll('panel emergency stop').catch(() => {});
      }
      if (ctx.turnService && typeof ctx.turnService.cancelAll === 'function') {
        ctx.turnService.cancelAll('panel emergency stop');
      }
      if (ctx.codeSkills && typeof ctx.codeSkills.cancelAll === 'function') {
        ctx.codeSkills.cancelAll();
      }
      ctx.log.warn('EMERGENCY STOP: queue cleared, current task cancelled');
    }
    steps.brain = { ok: true, ms: Date.now() - started };
  } catch (err) {
    steps.brain = { ok: false, error: err.message };
  }

  try {
    if (ctx.nav) ctx.nav.stop();
    steps.navigator = { ok: true };
  } catch (err) {
    steps.navigator = { ok: false, error: err.message };
  }

  try {
    if (ctx.body && typeof ctx.body.interrupt === 'function') {
      // Synchronous by contract (it just fires a `stop` at the mod); the HTTP request it
      // makes is fire-and-forget, so this cannot hang the response.
      ctx.body.interrupt('emergency stop');
      steps.client = { ok: true, note: 'sent "stop" to the control mod' };
    } else {
      steps.client = { ok: false, note: 'body has no interrupt()' };
    }
  } catch (err) {
    steps.client = { ok: false, error: err.message };
  }

  const allOk = steps.brain.ok && steps.navigator.ok && steps.client.ok;
  return {
    ok: allOk,
    ms: Date.now() - started,
    steps,
    note: allOk
      ? '紧急停止已生效（大脑/寻路/客户端三处都已停手）'
      : '部分阶段失败，请检查 steps —— 不要假定它停下了'
  };
}

/** "walk to me": the player and the bot share a body, so this is the bot's own position. */
function gotoHereLine(ctx) {
  const snap = ctx.body && ctx.body.snapshot ? ctx.body.snapshot() : null;
  if (!snap || !snap.position) return null;
  const p = snap.position;
  return `goto ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;
}

function normalizePriority(value) {
  const text = String(value || '').toLowerCase();
  return text === 'urgent' || text === 'emergency' ? 'urgent' : 'directive';
}

function bodyKind(ctx) {
  if (ctx.bodyKind) return ctx.bodyKind;
  return ctx.body ? ctx.body.kind : 'none';
}

function isAlive(ctx) {
  if (ctx.body && typeof ctx.body.isReady === 'boolean') return ctx.body.isReady;
  return !!(ctx.controller && ctx.controller.isAlive);
}

function controllerState(ctx) {
  return ctx.controller ? ctx.controller.state : bodyKind(ctx);
}

function controllerSnapshot(ctx) {
  if (ctx.controller && typeof ctx.controller.snapshot === 'function') return ctx.controller.snapshot();
  const snap = ctx.body && ctx.body.snapshot ? ctx.body.snapshot() : null;
  return snap
    ? { body: snap.body, ready: snap.ready, health: snap.health, food: snap.food, position: snap.position }
    : { ready: false };
}

/** Something with `.inventory.items()`: the facade under clientmod, the bot otherwise. */
function inventorySource(ctx) {
  if (ctx.botFacade) return ctx.botFacade;
  if (ctx.bot) return ctx.bot;
  return { inventory: { items: () => [] } };
}

function json(res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** Raw request body (for form posts, where JSON parsing would destroy the payload). */
function readRaw(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => resolve(data));
  });
}

module.exports = { startStatusServer, uiState, safeUiState, emergencyStop, PANEL_HTML };
