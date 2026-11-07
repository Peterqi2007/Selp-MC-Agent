# Selp

> **Selp** — a Minecraft survival agent. It drives a real 1.20.1 Forge client: Node decides, a client-side mod does the hands.
> **Selp** —— 一个《我的世界》生存 Agent。它驱动真实的 1.20.1 Forge 客户端：Node 负责决策，客户端 Mod 只做手。

[中文](#中文) · [English](#english) · [技术参考 / Technical reference](TECHNICAL.md)

---

## 中文

### 优势

**1. 联机只需客户端配置，服务器端零安装**
Agent 驱动的是一个真实 Forge 1.20.1 客户端：控制 Mod 在 `127.0.0.1:8899` 暴露 HTTP 原语
（移动 / 挖掘 / 放置 / 右键 / 菜单 / 攻击 / 键鼠注入 / 截图），Node 侧做全部决策。
服务器上不装插件、不发伪造封包，因此能进「要求客户端 Mod 握手（FML2）」的 Forge 服——
这正是 mineflayer 一类协议机器人进不去的场景。登录只走 AuthMe `/login`，
`/register` 在四道闸门上被永久拒绝（它会重置角色数据）。
*边界：客户端必须和 Agent 同机跑，用你自己的账号，并自行确认服务器规则允许自动化。*

**2. 截图识图**
Mod 在游戏进程内抓帧缓冲（默认 768×432，全程不用 OS 级截屏 API，F1'a 结构性闸门），
经 HTTP 交 Node。触发是事件驱动的（失败、卡住、计划 partial/failed），带去重、每任务 ≤3 张、
90 秒兜底、保留最近 20 张；开启 `screenshot.steer` 时，图片会连同文字一起作为 `steer`
送进动作脑的当前回合（真机验证落在 turn 70 step 2，而不是等整轮结束）。
*边界：这是「取帧 + 把图交给模型」，不是本地 CV 管线；没接模型时没有识图能力。*

**3. 自主学习**
计划成功结算时，把「目标 + 步骤类型序列 + 条件」写进方法库，同形复跑只累加证据；
`lookup_mod_content`（MC百科优先）的结果自动落到 semantic 记忆，重查替换、空结果不落库；
Voyager 式自动课程用「难度带 + completed/failed 账本」自出题，失败降带、账本自净、不重复卡同一题；
代码技能可以「生成 → 权限子进程试运行 → 晋升 → 复用」，复用记录里是 0 次生成调用。
*边界：学到的是「这台客户端看到的世界」；跨存档/服务器的记忆分区（`worldKey`）仍是 P2 设计。*

**4. 完整的公屏聊天**
读服务器公屏聊天（Mod `/chatlog`），三条路径并存：
`!` 确定性命令通道（不花模型 token）、人设触发词 `@大肥鱼` 的自然语言通道（严格二值判定器 +
超时拒绝，可选 `chat.addressedPrefix` 先审批再转发）、普通公屏聊天参与/沉默策略
（15 行短窗口 + ChatMemory 持久化，支持 grep/compact）。自回声、重复、过时回复一律拒绝；
同一句话只由一个发言者发出，语言脑决定 `silence` 时就真的不说。
*边界：A23 的「40 组 ×3」多人统计未执行，当前是操作员口径通过。*

**5. 人格设定**
角色表在 `config/persona.md` / `config/persona.language.md` 的 frontmatter：名字、称呼触发词
（默认 `@大肥鱼`）、字数上限、说话风格。语言脑按它改写每一句公开输出（`mc_say`、任务播报、
计划提问、代码技能播报都过同一层），换一个角色只需要改这两个文件。
*边界：人格不改变能力边界——它没有「执行服务器指令」的通道，说话只能是对玩家的回复。*

**6. 动作审批**
权限规则是 `deny / allow / ask`：`ask` 会在动手前在游戏里发问，`!yes` / `!no` 应答，超时按拒绝算；
危险操作（`/register`）永久拒绝。`!stop` 会同时停 Node 队列与动作脑 goal，运行中任务取消实测 629ms，
`owner-stop` 期间动作脑的 `mc_step` / `plan` / `propose` 全部被硬拒，`!resume` 才解锁。
完全自主模式（`!autonomous on`）则相反：提案自动接受、`mc_ask_player` 被拒、玩家任务一律忙拒。
*边界：审批是「规则 + 征询」，不是安全沙箱；代码技能跑在权限子进程里，但 vm 不是内核边界（见技术参考）。*

### 劣势

**1. 没有服务端数据**
只有客户端视角：方块扫描半径 ±24 水平、+8/−8 垂直，网格外是「未知」而不是空气（A* 不会往未知里走）；
客户端注册表里没有的方块默认不挖；箱子内容必须打开界面才读得到；没有服务端日志、控制台、种子或区块地图。
可选的 `mod-bridge`（Fabric 服务端桥）只作历史保留，未接线。

**2. 任务执行成功率低**
项目自己的验收就是证据：A33.6 遗体回收在约 50 格山地上 `path-failed`，操作员判定「该功能不可交付」；
一次挖石在厚土柱上是 0/2；矿物采集强依赖地质与暴露面；模组机制（如 Create 的旋转动力）会直接失败；
模型回合会超时或返回非法 JSON。失败会诚实报 partial/failed、不会假装成功——但成功率就是不高。

**3. 寻路算法差**
自研 A* 只跑在客户端那 24 格自我中心网格上，没有区块级地图、没有全局规划；出网格靠
「子目标接力 + ±5 格重试」，不通就 `out-of-grid` 原地不动；不会搭桥或挖隧道翻越任意地形
（遗体回收正是这样失败的）；跳跃只过「脚 + 头两格净空」的空隙；水域代价是经验值。
平坦地形和室内够用，山地、跨谷、封闭口袋不可靠。

**4. 任务执行时间长**
每一步都是「模型一轮 + HTTP 轮询」：长步骤实测 15.57 秒，挖矿批次以分钟计，钓鱼上限 15 分钟，
存/取箱子要先做 15×15×9 容器扫描再 A* 走过去；A* 每 20 tick 重规划；工具轮上限 2 轮、单轮 8 秒超时。
急停很快（24–629ms），但「做完」慢，模型延迟是主因。

**5. 配置复杂**
7 个配置文件（`agent` / `llm` / `pcl` / `persona` / `safety` / `servers` / `server`）加本机覆盖层，
优先级是「环境变量 > `*.local.json` > 入库 `*.json` > 默认值」；几十个旋钮（截图预算、寻路参数、
挖矿模型接管、课程难度带、自主模式护栏）；没有配置向导，也没有配置 UI。
动作脑绑定还依赖「按 durable goal 自动发现会话」，DSH 一重启就可能静默失效。

**6. 难以安装**
需要 Windows + Node ≥18 + Java 17–21 + Forge 1.20.1 客户端 + Gradle 离线构建 Mod +
版本隔离的 mods 目录 + PCL2（可自动探测）+ 外部 DSH 桌面端 + 插件安装 + 模型 key。
没有安装包、没有发布产物、没有向导；PowerShell 执行策略还会拦 `start.ps1`（脚本头部写了绕过办法）。
改了 Mod 必须重编、重装、重启客户端。完整步骤见下方「部署与配置」。

### 部署与配置

> Selp 目前是**源码分发**（没有安装包/发布产物）。以下流程按 2026-11 的仓库状态编写。

#### 0. 前置条件

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 | 一键脚本是 PowerShell（`.ps1`）；Linux/macOS 需手工起各进程 |
| Node.js | ≥ 18（建议 20/22） | Agent 与全部脚本 |
| Java | 17–21（1.20.1 Forge 必需） | `start.ps1` 会自动从 PCL 的 Java 列表里挑 |
| Minecraft | **1.20.1 Forge 47.x** 客户端 | 必须是真实客户端，且与 Mod 版本配对 |
| PCL2 | 可选 | 只用于版本/账号/Mod 管理；留空则自动探测 |
| 模型 | OpenAI 兼容端点 + key | 默认 `deepseek-flash`；没有 key 时 `!` 指令仍可用 |
| DSH 桌面端 | 可选（动作脑） | 不装则没有自然语言动作脑，只有 `!` 命令与本地兜底路由 |

#### 1. 取得源码并安装依赖

```powershell
git clone <repo>
cd <repo>
npm install
```

#### 2. 指向你的游戏实例

`config/pcl.json` 留空即自动探测 `%APPDATA%` / `%LOCALAPPDATA%`；探测失败再手填：

```jsonc
// config/pcl.json
{
  "minecraftDir": "D:\\Minecraft\\.minecraft",
  "clientVersion": "1.20.1-Forge_47.4.10"
}
```

注意 Mod 必须装到**版本隔离**目录：`versions/<版本>/mods`，不是 `.minecraft/mods`。

#### 3. 构建并安装控制 Mod

```powershell
npm run client:build     # mod-client 的 Gradle 离线构建（需要 JDK 17–21）
npm run client:install   # 复制 dist/agent-client-1.0.0.jar 到 versions/<版本>/mods
npm run client:check     # 探测 8899：Mod 在不在、是否已进入世界
```

首次构建时若本机没有 Gradle 依赖缓存，`client:build` 里的 `--offline` 会失败：
先去掉 `--offline` 联网构建一次，或手工在 `mod-client` 下跑 `gradlew.bat build`。
安装后必须**重启客户端**才生效。

#### 4. 填配置（凭据只放本机覆盖层）

入库的 `config/*.json` 不含任何密钥；`config/*.local.json` 被 `.gitignore` 忽略，自动合并覆盖。

```jsonc
// config/agent.local.json —— 服务器地址与 AuthMe 密码
{
  "bot": {
    "host": "your-server.example",
    "port": 25565,
    "authme": { "password": "<your-login-password>" }
  }
}
// config/llm.local.json —— 模型 key
{ "apiKey": "<your-key>" }
```

或用环境变量（优先级最高）：`LLM_API_KEY`（回退 `OPENAI_API_KEY`）、`OPENAI_BASE_URL`、
`MC_AUTHME_PASSWORD`、`MC_ADDRESS`。凭据放置、`secrets:scan` 与历史清理见 [SECURITY.md](SECURITY.md)。

其余配置按需改：`config/agent.json`（躯体、聊天、截图、寻路、自主学习、完全自主模式）、
`config/llm.json`（provider / model / 预算）、`config/persona.md` 与 `config/persona.language.md`（人格）、
`config/safety.md`（安全约束）、`config/servers.json`（常用服务器）。

#### 5. 启动

```powershell
# 客户端 + Agent；客户端已在跑就只起 Agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1

# 常用参数
.\start.ps1 -Server your-server.example:25565   # 换服务器
.\start.ps1 -NoClient                            # 客户端已开，只起 Agent
.\start.ps1 -Wait 420                            # 多等一会儿（默认 300 秒）
```

`start.ps1` 会：拉起 Forge 客户端 → 等控制 Mod 的 `/health` 报 `inWorld=true` → 启动 Node Agent
（含 AuthMe 登录）→ 打印面板地址。**不要**在「8899 端口通但还没进世界」时起 Agent，
那会得到一连串看起来像 bug 的失败——脚本已经帮你等这个点。

控制面板：<http://127.0.0.1:8766/panel>。游戏里用 `!` 指令或 `@大肥鱼 <自然语言>` 指挥。

停止：`.\stop.ps1`（只停 Agent）或 `.\stop.ps1 -Client`（连客户端一起停）。

#### 6. 接入动作脑（可选，DSH）

```powershell
npm run dsh:install     # 安装 dsh-plugin-mc-harness（15 个工具）
```

然后在 DSH 里建一个「动作脑」会话。`chat.harnessAgentId` 入库值是空字符串，启动时按
durable goal **自动发现**当前活会话；要钉死就写进 `config/agent.local.json`（该文件不进 git）。
`planner.mode` 默认 `off`：不装 DSH 也能用 `!` 指令，只是没有模型动作脑。

#### 7. 自检

```powershell
npm run client:check                 # 8899 / 是否在世界里
npm run p1:verify -- --fast          # 离线门禁（19 个套件）
npm run docs:check                   # 文档一致性
npm run secrets:scan                 # 提交前查有没有把凭据写进去
```

#### 8. 端口与数据

| 端口 | 用途 |
| --- | --- |
| `127.0.0.1:8899` | 控制 Mod 的 HTTP（`/state` `/chatlog` `/progress` `/health` `/keybinds`，`POST /command`） |
| `127.0.0.1:8766` | Node 控制面板与 API（`/panel` `/ui/state` `POST /command` `POST /emergency-stop`） |
| `127.0.0.1:8770` | DSH 插件桥（仅在接动作脑时） |
| `127.0.0.1:25565` | 可选的本地无头服务器（旧路径） |

运行数据都在 `runtime/`（日志、状态、账本、证据、锁），**删掉即重置**；
`config/*.local.json` 是你的本机凭据，不属于仓库。

#### 9. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `client:check` 说 8899 不通 | 客户端没起，或 jar 装错目录（版本隔离：`versions/<版本>/mods`） |
| 端口通但 Agent 一连串失败 | 客户端还没进入世界；等 `/health` 的 `inWorld=true` |
| `start.ps1` 被「禁止运行脚本」拦 | 用 `powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1`，或把项目复制到新目录 |
| 它站着不动 | 窗口未聚焦，或开着 GUI；看 `/state` 的 `screenOpen` / `mouseGrabbed` |
| `@大肥鱼` 没反应 | 没配模型 key（会退回正则兜底），或 DSH 动作脑未绑定（看插件 `/health.boundAgentId`） |
| 面板打不开 | 8766 被占用，或 `web.port` 被改 |
| 改了 Mod 不生效 | 必须 `client:build` + `client:install` + 重启客户端；改 Node 只需重启 Agent |

#### 10. 卸载

```powershell
.\stop.ps1 -Client
node scripts/install-client-mod.js --remove   # 移除控制 Mod
```

删除项目目录即可；`runtime/` 与 `config/*.local.json` 是仅有的本机残留。

---

## English

### Advantages

**1. Multiplayer needs client-side setup only — nothing on the server.**
The agent drives a real Forge 1.20.1 client: a control mod exposes HTTP primitives on
`127.0.0.1:8899` (move / dig / place / right-click / menus / attack / key injection / screenshots)
and Node makes every decision. No server plugin, no forged packets — so it can join Forge servers
that require the FML2 client handshake, which protocol bots such as mineflayer cannot.
Login uses AuthMe `/login` only; `/register` is permanently refused at four gates because it
resets character data. *Boundary: the client must run on the same machine, with your own account,
and you are responsible for whether the server rules allow automation.*

**2. Screenshots the model can see.**
The mod captures the frame buffer inside the game process (768×432 by default, no OS-level screen
capture API — the F1'a structural gate) and ships it to Node over HTTP. Capture is event-driven
(failure, stuck, plan partial/failed) with de-duplication, ≤3 per task, a 90 s fallback and the
last 20 kept. With `screenshot.steer` enabled the image is attached to the action brain's `steer`
mid-turn (verified live at turn 70 step 2) instead of waiting for the turn to end.
*Boundary: this is frame capture plus image delivery to a model, not a local CV pipeline; without
a model there is no image understanding.*

**3. Learns on its own.**
A successful plan writes "goal + step-type sequence + conditions" into the method library, and a
similar plan only accumulates evidence on it. `lookup_mod_content` results (MC百科 first) land in
semantic memory automatically — replaced on re-query, empty results never stored. A Voyager-style
automatic curriculum picks its own tasks from a difficulty band plus a completed/failed ledger,
lowers the band after failures and cleans up contradictory entries. Code skills can be generated →
trial-run in a permissioned subprocess → promoted → reused, and reuse records zero generation calls.
*Boundary: what it learns is "the world this client sees"; cross-save/server memory partitioning
(`worldKey`) is still a P2 design.*

**4. Full public-chat handling.**
It reads server chat (mod `/chatlog`) and runs three paths side by side: the deterministic `!`
command channel (zero model tokens), the persona trigger `@大肥鱼` natural-language channel
(strict binary judge plus timeout refusal; optional `chat.addressedPrefix` gate), and an
ordinary public-chat participate/silence policy over a 15-line short window with persisted
ChatMemory (grep/compact). Own echoes, duplicates and stale replies are rejected, exactly one
speaker emits a line, and when the language brain decides `silence` it really stays quiet.
*Boundary: the A23 "40 groups ×3" multiplayer statistics were never run; the current pass is an
operator judgement.*

**5. Persona.**
The character sheet lives in the frontmatter of `config/persona.md` / `config/persona.language.md`:
name, address trigger (default `@大肥鱼`), character limit and speaking style. The language brain
rewrites every public line through it (`mc_say`, task announcements, plan questions, code-skill
announcements). Swapping the character means editing those two files.
*Boundary: a persona does not widen capability — there is no "run a server command" channel;
speech is only a reply to players.*

**6. Action approval.**
Permission rules are `deny / allow / ask`: `ask` questions the player in-game before acting,
`!yes` / `!no` answers it, and a timeout counts as a refusal; `/register` is permanently denied.
`!stop` stops both the Node queue and the action-brain goal; a running task cancelled in 629 ms live,
and while `owner-stop` is set the action brain's `mc_step` / `plan` / `propose` are hard-refused
until `!resume`.
Fully autonomous mode (`!autonomous on`) inverts this: proposals are auto-accepted,
`mc_ask_player` is refused, and player tasks are busy-refused.
*Boundary: this is rules plus asking, not a sandbox; code skills run in a permissioned subprocess,
but the vm is not a kernel boundary (see the technical reference).*

### Limitations

**1. No server-side data.**
Client view only: the block scan is ±24 horizontal and +8/−8 vertical, and outside that grid a cell
is "unknown", not air (A* will not walk into it). Blocks missing from the client registry are never
mined. Container contents are readable only while the container screen is open. There are no server
logs, console, seed or chunk map. The optional `mod-bridge` (Fabric server bridge) is historical and
not wired.

**2. Low task success rate.**
The project's own acceptance is the evidence: A33.6 corpse recovery fails with `path-failed` across
~50 blocks of mountain terrain and was judged "not deliverable" by the operator; one stone-mining run
was 0/2 in a thick dirt column; ore collection depends on geology and exposed faces; modded mechanics
(e.g. Create rotational power) simply fail; model turns can time out or return malformed JSON.
Failures are reported honestly as partial/failed rather than faked — but the rate is simply not high.

**3. Weak pathfinding.**
The hand-rolled A* runs only over the client's 24-block egocentric grid: no chunk-level map and no
global planner. Out-of-grid movement is "subgoal relay + ±5 block retries"; when that fails it reports
`out-of-grid` and stands still. It will not bridge or tunnel through arbitrary terrain (that is exactly
how corpse recovery failed); jumps only clear gaps where feet and head are both free; water cost is a
heuristic. Fine on flat ground and indoors, unreliable on mountains, across valleys or inside pockets.

**4. Slow task execution.**
Every step is "one model turn + HTTP polling": a long step measured 15.57 s, mining batches take
minutes, fishing is capped at 15 minutes, deposit/withdraw first scans 15×15×9 for containers and then
walks there with A*; A* replans every 20 ticks; a tool round is at most 2 turns with an 8 s timeout.
Cancelling is fast (24–629 ms), finishing is slow, and model latency dominates.

**5. Complex configuration.**
Seven config files (`agent` / `llm` / `pcl` / `persona` / `safety` / `servers` / `server`) plus a
local overlay with the precedence "env vars > `*.local.json` > tracked `*.json` > defaults"; dozens of
knobs (screenshot budget, pathfinding, mining model recovery, curriculum bands, autonomy guards); no
wizard and no config UI. Action-brain binding relies on auto-discovery via a durable goal, so a DSH
restart can silently leave it unbound.

**6. Hard to install.**
You need Windows + Node ≥18 + Java 17–21 + a Forge 1.20.1 client + a Gradle offline build of the mod +
a version-isolated mods directory + PCL2 (auto-detected) + the external DSH desktop app + plugin
installation + a model key. There is no installer, no release artifact and no wizard; PowerShell's
execution policy blocks `start.ps1` (the workaround is documented in the script header). Mod changes
require rebuild + reinstall + client restart. The full procedure is below.

### Deployment & configuration

> Selp currently ships **as source** (no installer, no release artifact). The steps below match
> the repository as of November 2026.

#### 0. Prerequisites

| Item | Requirement | Notes |
| --- | --- | --- |
| OS | Windows 10/11 | The one-click scripts are PowerShell; on Linux/macOS start each process by hand |
| Node.js | ≥ 18 (20/22 recommended) | Agent and all scripts |
| Java | 17–21 (required by 1.20.1 Forge) | `start.ps1` picks one from PCL's Java list |
| Minecraft | **1.20.1 Forge 47.x** client | A real client, matching the mod build |
| PCL2 | Optional | Version/account/mod management only; auto-detected when empty |
| Model | OpenAI-compatible endpoint + key | Default `deepseek-flash`; `!` commands work without a key |
| DSH desktop | Optional (action brain) | Without it you get `!` commands and the local fallback router |

#### 1. Get the source and install dependencies

```powershell
git clone <repo>
cd <repo>
npm install
```

#### 2. Point it at your game instance

`config/pcl.json` may stay empty (auto-detected from `%APPDATA%` / `%LOCALAPPDATA%`). If detection
fails, fill it in:

```jsonc
// config/pcl.json
{
  "minecraftDir": "D:\\Minecraft\\.minecraft",
  "clientVersion": "1.20.1-Forge_47.4.10"
}
```

The mod must go into the **version-isolated** directory: `versions/<version>/mods`, not `.minecraft/mods`.

#### 3. Build and install the control mod

```powershell
npm run client:build     # offline Gradle build of mod-client (needs JDK 17–21)
npm run client:install   # copies dist/agent-client-1.0.0.jar into versions/<version>/mods
npm run client:check     # probes 8899: is the mod up, are we in a world yet
```

On a machine without a Gradle dependency cache, `--offline` inside `client:build` fails: build once
online (drop `--offline`, or run `gradlew.bat build` in `mod-client` first). Restart the client after
installing.

#### 4. Configure (credentials in the local overlay only)

Tracked `config/*.json` files contain no secrets; `config/*.local.json` is git-ignored and merged on top.

```jsonc
// config/agent.local.json — server address and AuthMe password
{
  "bot": {
    "host": "your-server.example",
    "port": 25565,
    "authme": { "password": "<your-login-password>" }
  }
}
// config/llm.local.json — model key
{ "apiKey": "<your-key>" }
```

Environment variables take the highest precedence: `LLM_API_KEY` (falls back to `OPENAI_API_KEY`),
`OPENAI_BASE_URL`, `MC_AUTHME_PASSWORD`, `MC_ADDRESS`. See [SECURITY.md](SECURITY.md) for credential
handling, `secrets:scan` and history cleanup.

Other files as needed: `config/agent.json` (body, chat, screenshots, pathfinding, learning, fully
autonomous mode), `config/llm.json` (provider / model / budgets), `config/persona.md` and
`config/persona.language.md` (persona), `config/safety.md` (safety constraints),
`config/servers.json` (known servers).

#### 5. Start

```powershell
# client + agent; if the client is already running it only starts the agent
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1

# common options
.\start.ps1 -Server your-server.example:25565   # different server
.\start.ps1 -NoClient                            # client already open, agent only
.\start.ps1 -Wait 420                            # wait longer (default 300 s)
```

`start.ps1` launches the Forge client, waits until the control mod's `/health` reports
`inWorld=true`, starts the Node agent (including AuthMe login) and prints the panel URL.
Do **not** start the agent while port 8899 is up but the client has not joined a world — that yields a
string of bug-looking failures; the script already waits for the right moment.

Control panel: <http://127.0.0.1:8766/panel>. In game, use `!` commands or `@大肥鱼 <natural language>`.

Stop: `.\stop.ps1` (agent only) or `.\stop.ps1 -Client` (agent and client).

#### 6. Optional: attach the action brain (DSH)

```powershell
npm run dsh:install     # installs dsh-plugin-mc-harness (15 tools)
```

Then create an "action brain" session in DSH. `chat.harnessAgentId` ships empty: on startup the agent
auto-discovers the live session via its durable goal. To pin one, put it in `config/agent.local.json`
(git-ignored). `planner.mode` defaults to `off`: without DSH you still have `!` commands, just no
model-driven action brain.

#### 7. Verify

```powershell
npm run client:check                 # 8899 / in-world status
npm run p1:verify -- --fast          # offline gate (19 suites)
npm run docs:check                   # documentation consistency
npm run secrets:scan                 # make sure no credential is about to be committed
```

#### 8. Ports and data

| Port | Purpose |
| --- | --- |
| `127.0.0.1:8899` | Control mod HTTP (`/state` `/chatlog` `/progress` `/health` `/keybinds`, `POST /command`) |
| `127.0.0.1:8766` | Node control panel and API (`/panel` `/ui/state` `POST /command` `POST /emergency-stop`) |
| `127.0.0.1:8770` | DSH plugin bridge (only when an action brain is attached) |
| `127.0.0.1:25565` | Optional local headless server (legacy path) |

All runtime data lives under `runtime/` (logs, state, ledgers, evidence, lock) — deleting it resets
everything. `config/*.local.json` holds your local credentials and is not part of the repository.

#### 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `client:check` says 8899 is down | Client not running, or the jar is in the wrong place (needs `versions/<version>/mods`) |
| Port is up but the agent fails repeatedly | The client has not entered a world yet; wait for `/health` `inWorld=true` |
| `start.ps1` blocked by execution policy | Use `powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1`, or copy the project to a fresh directory |
| It stands still | Window not focused, or a GUI is open; check `screenOpen` / `mouseGrabbed` in `/state` |
| `@大肥鱼` gets no reply | No model key (regex fallback only), or the DSH action brain is unbound (check `/health.boundAgentId`) |
| Panel unreachable | Port 8766 taken, or `web.port` was changed |
| Mod changes do nothing | Rebuild + reinstall + restart the client; Node changes only need an agent restart |

#### 10. Uninstall

```powershell
.\stop.ps1 -Client
node scripts/install-client-mod.js --remove   # remove the control mod
```

Deleting the project directory is enough after that; `runtime/` and `config/*.local.json` are the only
local leftovers.
