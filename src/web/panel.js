'use strict';

/**
 * The control panel: one HTML page, no framework, no build step, no CDN (P0-PLAN §4.2.1).
 *
 * Why a single embedded string instead of a file on disk: the panel must work from a
 * packaged checkout and from the CLI, with no static-file serving, no MIME guessing and no
 * path traversal surface. It is ~200 lines of HTML/CSS/JS and it ships inside the bundle.
 *
 * What the panel is actually *for*, beyond buttons: it is the only place you can see
 * whether the bot understood you. P0 deliberately forbids unprompted speech, so when you
 * type a dialogue line there is no chatty confirmation loop to watch - the "recent input ->
 * routing" table is the feedback channel. That is why it shows the raw line, the router
 * used (llm or fallback) and the resulting action, not just "ok".
 *
 * 1-second polling of `/ui/state`, which is deliberately a *summary*: the full `/status`
 * payload contains the 40817-cell block scan and would be megabytes per second.
 */

const PANEL_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Minecraft Agent 控制面板</title>
<style>
  :root { --bg:#14161a; --panel:#1c1f26; --line:#2b3038; --fg:#e6e8ec; --dim:#8b93a1;
          --ok:#3fb950; --warn:#d29922; --err:#f85149; --accent:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:13px/1.5 "Segoe UI","Microsoft YaHei",system-ui,sans-serif; }
  .wrap { max-width:960px; margin:0 auto; padding:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px;
          padding:10px 12px; margin-bottom:10px; }
  .row { display:flex; flex-wrap:wrap; gap:14px; align-items:center; }
  .dim { color:var(--dim); }
  .bar { display:flex; justify-content:space-between; gap:12px; align-items:baseline; }
  .pill { border:1px solid var(--line); border-radius:999px; padding:2px 9px; font-size:12px; }
  .ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); }
  #death { display:none; background:#3d1418; border:1px solid var(--err); border-radius:8px;
           padding:12px; margin-bottom:10px; }
  #death h2 { margin:0 0 6px; font-size:15px; color:#ffb3b3; }
  /* Connection diagnostics: the panel must never be silently empty. */
  #diag { display:none; border-radius:8px; padding:9px 12px; margin-bottom:10px;
          background:#1d2733; border:1px solid #2b4d7d; color:#cfe4ff; }
  #diag.bad { background:#3d1418; border-color:var(--err); color:#ffd7d7; }
  input[type=text] { flex:1; min-width:220px; background:#0e1013; color:var(--fg);
                     border:1px solid var(--line); border-radius:6px; padding:8px 10px; font:inherit; }
  input[type=text]:focus { outline:none; border-color:var(--accent); }
  button { background:#22272e; color:var(--fg); border:1px solid var(--line); border-radius:6px;
           padding:7px 12px; font:inherit; cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button.danger { background:#4a1d1d; border-color:#7d2b2b; color:#ffd7d7; font-weight:600; }
  button.resume { background:#1d3a24; border-color:#2f6b3d; color:#c8f7d4; font-weight:600; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { text-align:left; padding:3px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:500; }
  #log { height:210px; overflow:auto; font-family:Consolas,"Cascadia Mono",monospace;
         font-size:12px; white-space:pre-wrap; }
  #log div { padding:1px 0; border-bottom:1px solid #20242b; }
  .tag { font-size:11px; padding:1px 5px; border-radius:4px; border:1px solid var(--line); color:var(--dim); }
  .tag.urgent { color:#ffd7d7; border-color:#7d2b2b; }
  .tag.directive { color:#cfe4ff; border-color:#2b4d7d; }
  .tag.autonomous { color:#d7d0ff; border-color:#4a3f7d; }
  label { user-select:none; }
</style>
</head>
<body>
<div class="wrap">

<!--BOOT-->

  <div id="death">
    <h2>🪦 BOT 已死亡 · 所有任务已中止</h2>
    <div class="row">
      <span id="death-info" class="dim"></span>
      <button class="resume" onclick="resume()">🔄 恢复运行</button>
    </div>
    <div class="dim" style="margin-top:6px">若游戏窗口停在死亡画面，需要手动点「重生」—— P0 没有自动重生能力。</div>
  </div>

  <div id="diag"></div>

  <!--
    Server-rendered live state, in an iframe that refreshes itself with <meta refresh>.
    This is the fallback that works even when the browser refuses to run scripts: the state
    block below still fills in when JavaScript runs, but the iframe never depends on it.
  -->
  <iframe id="state-frame" src="/panel/state" title="实时状态（服务端渲染）"
          style="width:100%;height:210px;border:1px solid var(--line);border-radius:8px;background:#14161a">
  </iframe>

  <div class="card">
    <div class="bar">
      <div class="row">
        <strong id="name">agent</strong>
        <span class="pill" id="body">body: ?</span>
        <span class="pill" id="brain">大脑: ?</span>
        <span class="pill" id="llm">LLM: ?</span>
      </div>
      <span class="dim" id="updated">-</span>
    </div>
    <div class="row" style="margin-top:8px">
      <span id="hp">hp -</span>
      <span id="food">food -</span>
      <span id="pos">pos -</span>
      <span id="held">手持 -</span>
      <span id="deaths" class="dim"></span>
    </div>
    <div class="row" style="margin-top:6px">
      <span class="dim">当前:</span><span id="current">idle</span>
      <span class="dim">队列:</span><span id="queue">0</span>
    </div>
  </div>

  <div class="card">
    <!--
      A real form: with JavaScript the button calls send() and onsubmit stops navigation;
      without JavaScript the same button performs a normal POST and the server redirects
      back here - so commands work in both worlds.
    -->
    <form method="post" action="/command" onsubmit="return false">
      <div class="row">
        <input type="text" id="cmd" name="command" placeholder="输入指令后回车（↑↓ 历史，Tab 补全）"
               autocomplete="off" spellcheck="false">
        <label><input type="radio" name="priority" value="directive" checked> 指令</label>
        <label><input type="radio" name="priority" value="urgent"> 紧急</label>
        <button type="submit" onclick="send()">发送</button>
      </div>
    </form>
    <div class="row" style="margin-top:8px">
      <button class="danger" id="btn-estop">⏹ 急停</button>
      <button data-cmd="status">📊 状态</button>
      <button data-cmd="inv">🎒 背包</button>
      <button data-cmd="where">🧭 位置</button>
      <button data-cmd="chop 8">🪓 砍树</button>
      <button data-cmd="mine stone 8">⛏ 挖矿</button>
      <button data-cmd="click">🚶 走过来</button>
      <button id="btn-resume">▶ 恢复</button>
    </div>
    <div id="ack" class="dim" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <div class="dim" style="margin-bottom:6px">最近识别到的输入 → 路由结果（这是唯一能看见「它听懂了吗」的地方）</div>
    <table>
      <thead><tr><th style="width:34%">输入</th><th style="width:14%">来源</th><th style="width:14%">路由</th><th>动作 / 结果</th></tr></thead>
      <tbody id="routing"><tr><td colspan="4" class="dim">暂无</td></tr></tbody>
    </table>
  </div>

  <div class="card">
    <div class="bar"><span class="dim">日志</span><span class="dim" id="traceinfo"></span></div>
    <div id="log"></div>
  </div>

</div>
<script src="/panel/app.js" defer></script>
</body>
</html>`;

/**
 * The panel's JavaScript, served from `/panel/app.js` instead of inlined.
 *
 * Live experience: a browser rendered the server-side HTML (so the page definitely came
 * from the agent), showed no `<noscript>` warning (so it thinks JavaScript is enabled) and
 * still never executed the inline script - the classic signature of an extension or a
 * policy that blocks inline scripts. A same-origin external file is what those tools usually
 * allow, and it makes the failure visible: the fetch happens, or the server sees nothing.
 *
 * The first statement is a beacon to `/panel/ping`, so "did the browser run this at all?"
 * is answerable from the agent's own log.
 */
const PANEL_JS = `
'use strict';
try { (new Image()).src = '/panel/ping?t=' + Date.now(); } catch (e) { /* beacon only */ }
var history = [], hIndex = -1;
var COMPLETIONS = ['status','chop','mine','collect','goto','stop','pause','resume','inv','where',
                   'help','goal','eat','defend','mine stone 8','chop 8','chop 32','goto '];

function el(id) { return document.getElementById(id); }
function text(id, value) { var n = el(id); if (n) n.textContent = value; }
function diag(message, bad) {
  var n = el('diag');
  if (!n) return;
  if (!message) { n.style.display = 'none'; return; }
  n.textContent = message;
  n.className = bad ? 'bad' : '';
  n.style.display = 'block';
}

function post(path, payload) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {})
  }).then(function (r) { return r.json(); });
}

function send() {
  var input = el('cmd');
  var line = input.value.trim();
  if (!line) return;
  var checked = document.querySelector('input[name=priority]:checked');
  var prio = checked ? checked.value : 'directive';
  history.push(line); hIndex = history.length;
  input.value = '';
  post('/command', { command: line, priority: prio }).then(function (res) {
    var bits = [];
    if (res.level) bits.push('级别=' + res.level);
    if (res.preempted) bits.push('抢占了 ' + res.preempted);
    if (res.queuedBehind) bits.push('前面还有 ' + res.queuedBehind + ' 个');
    if (res.ok === false) bits.push('失败: ' + (res.error || res.reason || '未知'));
    el('ack').textContent = line + ' → ' + (bits.length ? bits.join(', ') : '已接受');
  }).catch(function (e) { el('ack').textContent = '出错: ' + e.message; });
}

function quick(cmd) {
  if (cmd === 'click') { post('/command', { command: 'goto-here', priority: 'directive' }); return; }
  el('cmd').value = cmd; send();
}

function estop() {
  el('ack').textContent = '急停中…';
  var started = Date.now();
  post('/emergency-stop', {}).then(function (res) {
    el('ack').textContent = '急停已发送 (' + (Date.now() - started) + 'ms): ' +
      JSON.stringify(res.steps || res);
  }).catch(function (e) { el('ack').textContent = '急停失败: ' + e.message; });
}

function resume() { post('/command', { command: 'resume', priority: 'urgent' }).then(refresh); }

function render(s) {
  // A payload without identity/brain/death is an error payload, not a state payload:
  // say why instead of throwing inside the render and leaving the page blank.
  if (!s || !s.identity || !s.brain || !s.death) {
    var why = (s && s.error) || 'agent 未响应';
    text('updated', '⚠ 面板数据不可用: ' + why);
    diag('⚠ 面板数据不可用: ' + why, true);
    return;
  }
  text('name', s.identity.name);
  text('body', 'body: ' + s.identity.bodyKind + (s.identity.bodyReady ? '' : ' (未连接)'));
  text('brain', '大脑: ' + (s.brain.stopped ? '⛔ 已停止' : s.brain.paused ? '⏸ 暂停' : s.brain.running ? '▶ 运行' : '· 未启动'));
  text('llm', 'LLM: ' + (s.llm.enabled ? '✅ ' + s.llm.model : '❌ ' + (s.llm.disabledReason || 'off') + ' (正则兜底)'));
  text('updated', '更新于 ' + new Date(s.updatedAt).toLocaleTimeString() + (s.error ? ' ⚠ ' + s.error : ''));

  var w = s.world || {};
  text('hp', 'hp ' + fmt(w.health) + '/20');
  text('food', 'food ' + fmt(w.food));
  text('pos', 'pos ' + (w.position ? Math.round(w.position.x) + ',' + Math.round(w.position.y) + ',' + Math.round(w.position.z) : '-'));
  text('held', '手持 ' + (w.heldItem || '空'));
  if (w.screenOpen) {
    text('held', '⚠ 游戏界面开着 (' + (w.screen || '?') + ')，机器人无法移动 — 请先关闭');
  }
  text('deaths', s.death.deaths ? ('死亡次数 ' + s.death.deaths) : '');

  var cur = s.brain.current;
  var hubCur = s.hub && s.hub.current;
  text('current', hubCur
    ? (hubCur.description + ' · ' + hubCur.id + ' (' + Math.round((hubCur.ms || 0) / 1000) + 's)')
    : (cur ? (cur.description + ' (' + (cur.progress === null || cur.progress === undefined ? '?' : cur.progress) + ')') : 'idle'));
  /**
   * The last finished task keeps its partial/pending/recovery facts visible: "mined 2,
   * banked 1, 1 pending" must not look like a clean success in the panel either.
   */
  var hubLast = s.hub && s.hub.recent && s.hub.recent.length ? s.hub.recent[s.hub.recent.length - 1] : null;
  var hubNote = '';
  if (hubLast) {
    if (hubLast.partial) hubNote += ' · 部分完成: ' + (hubLast.pending || 0) + ' 待收';
    else if (hubLast.pending) hubNote += ' · 待收 ' + hubLast.pending;
    if (hubLast.recoveryRuns) hubNote += ' · 接管 ' + hubLast.recoveryRuns + ' 次';
  }
  text('queue', String(s.brain.queueLength) + hubNote);

  var death = el('death');
  if (s.death.dead || s.brain.stopped) {
    death.style.display = 'block';
    var at = s.death.lastDeath && s.death.lastDeath.position;
    text('death-info', (at ? ('@ ' + Math.round(at.x) + ',' + Math.round(at.y) + ',' + Math.round(at.z) + ' · ') : '') +
      (s.death.lastDeath ? new Date(s.death.lastDeath.at).toLocaleTimeString() : '') + ' · 任务已中止');
  } else {
    death.style.display = 'none';
  }

  var tb = el('routing');
  var rows = (s.recentInputs || []).slice().reverse();
  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="4" class="dim">暂无</td></tr>';
  } else {
    tb.innerHTML = rows.map(function (r) {
      var act = r.action || (r.kind === 'understood-nothing' ? '未听懂 → 已回问' : '(仅回话)');
      if (r.executed && r.executed.line) act += '  [' + r.executed.line + ']';
      if (r.tokens) act += '  ' + r.tokens + ' tok';
      if (r.ms) act += '  ' + r.ms + 'ms';
      return '<tr><td>' + esc(r.text || '') + '</td><td>' + esc(r.source || '') + '</td>' +
             '<td>' + esc(r.via || (r.kind === 'input' ? '!' : '')) + '</td><td>' + esc(act) + '</td></tr>';
    }).join('');
  }

  var log = el('log');
  log.innerHTML = (s.logs || []).map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('');
  log.scrollTop = log.scrollHeight;
  text('traceinfo', 'path-trace ' + s.traces.pathLines + ' 行 · llm-trace ' + s.traces.llmLines + ' 行' +
    (s.panel ? ' · 面板端口 ' + s.panel.port : ''));
  diag('已连接 · 端口 ' + (s.panel ? s.panel.port : '?') + ' · body ' + s.identity.bodyKind +
    (s.identity.bodyReady ? '' : '（未连接 —— 请让客户端进入世界）') +
    (s.world && s.world.screenOpen ? ' · 游戏界面开着（' + (s.world.screen || '?') + '），机器人无法移动' : ''),
    !s.identity.bodyReady || !!(s.world && s.world.screenOpen));
}

function fmt(n) { return (n === null || n === undefined) ? '-' : n; }
function esc(s) { return String(s === undefined || s === null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function refresh() {
  fetch('/ui/state').then(function (r) { return r.json(); }).then(render)
    .catch(function (e) {
      text('updated', '连接中断');
      diag('⚠ 无法连接 agent（' + location.host + '）：' + (e && e.message ? e.message : 'fetch failed') +
        ' —— 请确认 agent 正在运行（.\\start.ps1），然后刷新本页', true);
    });
}

var input = el('cmd');
input.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { send(); return; }
  if (e.key === 'ArrowUp') {
    if (hIndex > 0) { hIndex--; input.value = history[hIndex]; }
    e.preventDefault(); return;
  }
  if (e.key === 'ArrowDown') {
    if (hIndex < history.length - 1) { hIndex++; input.value = history[hIndex]; }
    else { hIndex = history.length; input.value = ''; }
    e.preventDefault(); return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    var v = input.value;
    var hit = COMPLETIONS.filter(function (c) { return c.indexOf(v) === 0; })[0];
    if (hit) input.value = hit;
  }
});

// The form works without any inline handler: when JavaScript is alive, intercept the submit
// and use fetch; when it is not, the browser performs a normal POST and the server redirects
// back. Inline onsubmit/onclick attributes can be blocked even when external scripts are allowed,
// which is exactly why the listeners are attached from this file.
var cmdForm = document.querySelector('form[action="/command"]');
if (cmdForm) {
  cmdForm.addEventListener('submit', function (e) {
    e.preventDefault();
    send();
  });
}
var quickButtons = document.querySelectorAll('[data-cmd]');
for (var i = 0; i < quickButtons.length; i += 1) {
  (function (node) {
    node.addEventListener('click', function () {
      if (node.getAttribute('data-cmd') === 'click') {
        post('/command', { command: 'goto-here', priority: 'directive' });
      } else {
        el('cmd').value = node.getAttribute('data-cmd');
        send();
      }
    });
  })(quickButtons[i]);
}
if (el('btn-estop')) el('btn-estop').addEventListener('click', estop);
if (el('btn-resume')) el('btn-resume').addEventListener('click', resume);

refresh();
setInterval(refresh, 1000);
`;

module.exports = { PANEL_HTML, PANEL_JS };
