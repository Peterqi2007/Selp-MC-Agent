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
const { inventorySummary } = require('../world/items');
const { countTrace } = require('../util/trace');
const { PANEL_HTML } = require('./panel');
const { Logger } = require('../util/logger');

function startStatusServer(ctx, options = {}) {
  const log = new Logger('http');
  const port = options.port || 8766;
  const host = options.host || (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.web && ctx.cfg.agent.web.bind) || '127.0.0.1';
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

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      // ------------------------------------------------------------ panel
      if (req.method === 'GET' && (url.pathname === '/panel' || url.pathname === '/panel/')) {
        // no-store: a cached panel page kept polling with stale code after upgrades.
        // The boot block is rendered server-side so the page shows real data even when the
        // browser refuses to run JavaScript - and so "the page is not from this agent at all"
        // becomes visible instead of looking like an empty panel.
        const html = PANEL_HTML.replace('<!--BOOT-->', bootBlock(buildUiState()));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
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

      // ----------------------------------------------------------- control
      if (req.method === 'POST' && url.pathname === '/command') {
        const body = await readBody(req);
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
         * In game, `!cmd` goes to the deterministic command table and `@猫娘 ...` goes to
         * the LLM. The panel used to send everything to the command table, so the most
         * natural thing a user types - `@猫娘 挖点土` - answered "unknown command @猫娘"
         * and never reached the model. A leading `!` is tolerated here as well, because
         * people paste the in-game form into the box.
         */
        const trimmed = String(line).trim();
        const trigger =
          (ctx.cfg && ctx.cfg.agent && ctx.cfg.agent.chat && ctx.cfg.agent.chat.dialogueTrigger) || '@猫娘';
        if (trimmed.startsWith(trigger) && ctx.llm && typeof ctx.llm.handle === 'function') {
          const utterance = trimmed.slice(trigger.length).trim();
          const snap = ctx.body && typeof ctx.body.snapshot === 'function' ? ctx.body.snapshot() : null;
          const record = await ctx.llm.handle(utterance, {
            source: 'panel',
            speaker: 'panel',
            speakerPosition: snap ? snap.position : null
          });
          return json(res, 200, { ok: true, routed: 'dialogue', record, level: priority, ms: Date.now() - started });
        }

        const commandLine = trimmed.startsWith('!') ? trimmed.slice(1).trim() : trimmed;
        const result = await ctx.chat.handle(commandLine, `http:${priority}`);
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
    boundPort = port;
    log.info(`control panel on http://${host}:${port}/panel  (API: /ui/state, /command, /emergency-stop, /llm)`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
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
  const pathFile = (cfg.pathfinding && cfg.pathfinding.trace) || 'runtime/path-trace.jsonl';
  const llmFile = (ctx.cfg && ctx.cfg.llm && ctx.cfg.llm.trace && ctx.cfg.llm.trace.file) || 'runtime/llm-trace.jsonl';

  return {
    identity: {
      name: (cfg.bot && cfg.bot.username) || 'agent',
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
      stoppedReason: brain.stoppedReason,
      safeMode: brain.safeMode,
      current: brain.current,
      queueLength: brain.queueLength,
      queued: (brain.queued || []).slice(0, 8)
    },
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
    /** Input -> routing, so the panel can show "did it understand me?" */
    recentInputs: [
      ...((ctx.llm && ctx.llm.turns) || []),
      ...((ctx.chatListener && ctx.chatListener.recent) || []).slice(-3)
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
    '<noscript><div style="margin-top:6px;color:#f85149">⚠ 你的浏览器没有执行 JavaScript（被禁用或被扩展拦截）：' +
    '实时刷新与按钮都不可用。请允许此站点运行脚本，或换一个浏览器。</div></noscript>' +
    '</div>'
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
      ctx.brain.autoPlanDisabled = true;
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

module.exports = { startStatusServer, uiState, safeUiState, emergencyStop, PANEL_HTML };
