# 外置控制台：可行性结论与实现路径（修订版）

> **需求原话**：「需要额外一个界面输入对 agent 的指令，该指令具备更高优先级。」
>
> **本文的定位**：这是 [`CONTROL-PANEL-ANALYSIS.md`](CONTROL-PANEL-ANALYSIS.md) 的**修订版** ——
> 那一版写在掌握完整事实之前，其中关于优先级的前提是错的。
> 代码级事实见 [`CAPABILITY-AUDIT.md`](CAPABILITY-AUDIT.md)，架构背景见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。
>
> 全部结论为**静态代码核实**，未实机启动 PCL。
>
> ⚠️ **行号已过期（2026-10-14）**：本文引用的 `brain.js:180/312/354` 等行号属于当时版本
> （`src/brain.js` 现为 1063 行）。涉及**规划器**（`decide()`/`runTask()`/`maybeRetry()`/`quarantine`）的
> 部分请以 [`PLANNER-REFACTOR.md`](PLANNER-REFACTOR.md) 为准——包括它纠正的边界：B1/B2 退避**记账**在
> `runTask`，规划器与命令表任务共用（所以 `!` 材料类、LLM `do_task` 材料类同样受影响）；
> `quarantine` 的**拦截**才是规划器专属；TaskHub 派发的作业（矿石、`do_skill` 长技能）两者都不适用。

---

## 一、可行性：可行，但定位需要修正

| 问题 | 结论 |
| --- | --- |
| 技术上可行吗？ | **可行。** 端口 8766 的 HTTP 服务已在跑，`POST /command` 已暴露全部 19 个指令，无需新增依赖 |
| 是「给自主 Agent 加一个干预界面」吗？ | ❌ **不是。** 当前 Agent **不会自主工作**（`Brain` 从未启动），所以在 UI 做出来之前，**根本不存在被抢占的自主任务** |
| 那它是什么？ | ✅ **它是「唯一的总机」** —— 眼下 Agent 完全没有指令入口，这个界面是第一个 |
| 「更高优先级」现在有意义吗？ | ⚠️ **暂时没有对象**。优先级是「相对自主任务」而言的。必须先让自主任务存在，优先级才有意义 |
| 工作量 | 约 **300 行新代码 + 1 处 `index.js` 接线 + 3 行 Java**（Java 部分可选） |
| 最先要修的前置 | `src/index.js` 缺 clientmod 分支（不修则 UI 收到的指令**静默失效**） |

### 1.1 我要修正的两个前提（来自代码核实）

**修正一：不存在「优先级不够高」的问题，只存在「指令落不了地」的问题。**

我最初把它理解成「LLM/规则表在自主干活时，玩家的指令要能插队」。但实测事实是：

```
Body 发出指令 → Brain.push(task) → queue.push + slowLoop()
                                     ↓
                     slowLoop 第一行：if (paused || !attached) return;
                                     ↓
                     attached === false（body.connect() 从未被调用）
                                     ↓
                     ★ 任务永远躺在队列里，但接口返回 {ok:true}
```

⇒ 现在加优先级排序**没有任何效果**，因为队列里的东西从来不执行。
⇒ 正确的第一步是**修接线让队列跑起来**，优先级是第二步。

**修正二：必须把「输入」和「输出」拆成两条独立通道 —— 这直接来自你的账号约束。**

你说「没有第二个账号，否则会失去控制权」。这句话推出来的结论比表面更微妙：

| 你实际处于的状态 | 后果 |
| --- | --- |
| 你在**同一个账号里打字**（PCL 客户端里） | 你的输入**和 Bot 共用一个角色**。所以 `bot.on('chat', (username, ...))` 那种「另一个玩家说话」的模型**不成立** |
| 但**你在客户端里打字，Bot 能看到** —— 走 Mod 的 `ChatLog`（`ClientChatEvents` → 50 条环形缓冲 → `GET /chatlog`） | ✅ **所以「输入」有一个不需要第二个账号的原生通道：MC 聊天框** |
| Bot 回复用 `say` / `chat` verb | ✅ 你能在客户端里看到，**且它不会占用你的打字** |

⇒ 结论：**「输入」有两条路（游戏内聊天框 / 外置面板），「输出」有一条（游戏内聊天）。三条都不需要第二个账号。**
这个发现让方案比原设想更省事：**游戏内聊天框可以保留为主要输入方式**，面板是它的补充（结构化、可看全状态、可急停）。

---

## 二、三条通道的定位

```
                    ┌──────────────────────────────────────────────┐
   输入通道 A        │ MC 聊天框（你在 PCL 客户端里打字）              │  零改造
   （原生、已存在）    │   → ChatLog(ClientChatReceivedEvent)         │  仅需读日志
                    │   → GET 127.0.0.1:8899/chatlog               │
                    │   → Node 轮询并解析                            │
                    └──────────────────────────────────────────────┘
                    ┌──────────────────────────────────────────────┐
   输入通道 B        │ 外置控制面板（浏览器）                          │  ★ 本需求
   （结构化、可急停）  │   → POST 127.0.0.1:8766/command              │  新建
                    │   → ChatController.handle()                   │
                    └──────────────────────────────────────────────┘
                    ┌──────────────────────────────────────────────┐
   输出通道 C        │ Bot 说话 → body.chat() → 8899 cmd/chat        │  ★ 需修
   （唯一）          │   → 你在游戏聊天栏看到                          │  ctx.bot 现在是 null
                    └──────────────────────────────────────────────┘
```

| 通道 | 优点 | 缺点 | 建议用途 |
| --- | --- | --- | --- |
| **A 聊天框** | 零改造（Mod 已有 `ChatLog`）；**和游戏在一起，注意力不分散**；支持任意中文 | 无结构化状态；看不到队列；急停要打字；日志只留 50 条 | **日常下指令**（「@猫娘 去挖点铁」） |
| **B 面板** | 状态条实时可见；**红色急停按钮**；指令历史（↑↓）；参数补全；执行结果回显 | 要切窗口；输入长文本不如聊天框顺手 | **监视 + 急停 + 精确指令** |
| **C 说话** | 你和 Bot 共用一个屏幕，看得见 | 需要先修 `ctx.bot` facade | 对话、报错、求救 |

> **设计含义**：不要把面板做成「唯一入口」，而是做成**「副驾驶仪表盘」** ——
> 聊天框负责说话，面板负责看和刹车。这样面板的交互复杂度可以大幅降低（不需要富文本编辑、不需要多行输入）。

---

## 三、优先级机制的设计（等自主任务存在之后）

### 3.1 三级模型

| 级别 | 名称 | 来源 | 语义 | 例子 |
| --- | --- | --- | --- | --- |
| **0** | `URGENT` | 面板急停按钮、`stop`/`pause` | **取消一切**：当前任务 + 全部队列 | 急停、暂停 |
| **1** | `DIRECTIVE` | 面板输入、聊天框指令、未来 LLM 意图 | **抢占自主任务，但不抢占其他指令** | `mine iron 3`、`build hut` |
| **2** | `AUTONOMOUS` | 规则表 `decide()`、未来 LLM 自主规划 | **排队**，随时可被 1 级打断 | `gather-wood`、`light`、`deposit` |

### 3.2 关键设计决策：同级别不互相抢占

这一条很容易做错。考虑玩家连发两条：

```
12:31:02  面板输入 "mine iron 3"   → 开始挖矿
12:31:05  面板输入 "chop 32"       → ❓ 该不该取消挖矿？
```

- **如果取消**：玩家每次手滑/改主意都会打断正在进行的工作，且两条指令互相取消会退化成「谁最后发谁执行」，很不稳定。
- **正确做法**：同级别**排队**，只有 1 级抢占 2 级。玩家真想改主意就按 `URGENT`（急停）再发新指令，或者输入 `stop`。

**⇒ 这条规则让「优先级」这个概念变得可预测：级别决定「能不能打断别人」，而不是「谁先跑」。**

### 3.3 实现（改 `src/brain.js`，约 80 行）

```js
/** 指令优先级。数值越小越优先。 */
const LEVEL = { URGENT: 0, DIRECTIVE: 1, AUTONOMOUS: 2 };

/**
 * 带优先级入队。与 push() 的区别是它会**按级别插入**并可能**抢占正在跑的任务**。
 * @param {Task} task
 * @param {{level?:number, source?:string}} [options]
 *   source: 'panel' | 'chat' | 'llm' | 'rule'
 */
async enqueue(task, options = {}) {
  const level = options.level ?? LEVEL.DIRECTIVE;
  task.queueLevel = level;
  task.source = options.source || 'unknown';

  // L0 URGENT：核弹。取消当前任务 + 清空队列。
  if (level === LEVEL.URGENT) {
    this.log.warn(`URGENT ${task.name} (${task.source}) - pre-empting everything`);
    if (this.activeTask) this.activeTask.cancel();
    this.queue.length = 0;
  }

  // L1 DIRECTIVE：只抢占「自主」任务。若已有指令在跑，就排队等它。
  if (level === LEVEL.DIRECTIVE && this.activeTask) {
    const running = this.activeTask.queueLevel ?? LEVEL.AUTONOMOUS;
    if (running >= LEVEL.DIRECTIVE) {
      this.log.info(`${task.name} queued behind ${this.activeTask.name} (both directive)`);
      this.queue.push(task);
      return task.snapshot();
    }
    this.log.info(`pre-empting autonomous ${this.activeTask.name} for ${task.name}`);
    this.activeTask.cancel();
  }

  // 按级别插入（同级 FIFO，保持稳定）
  const idx = this.queue.findIndex((t) => (t.queueLevel ?? LEVEL.AUTONOMOUS) > level);
  if (idx === -1) this.queue.push(task);
  else this.queue.splice(idx, 0, task);

  if (!this.activeTask) await this.slowLoop();
  return task.snapshot();
}
```

**配套改动**：

| 文件 | 改动 |
| --- | --- |
| `brain.js:312` `decide()` 的返回 | 所有规则产出的任务标 `queueLevel = LEVEL.AUTONOMOUS` |
| `brain.js:354` `maybeRetry()` | **自主任务失败不再重试**（玩家已经不关心它了），直接丢弃；指令任务保留重试 |
| `brain.js:180` `preempt()` | 保持原样（它是被 `URGENT` 和反射层调用的底层动作） |
| `chat/commands.js:227` `handle()` | `stop`/`pause` 标 `URGENT`；其余标 `DIRECTIVE`，`source='chat'` |
| `web/statusServer.js` `POST /command` | 接受可选 `priority` 字段（`urgent`/`directive`/`autonomous`，默认 `directive`），`source='panel'` |
| `tasks/task.js` | `priority` 字段**当前是死字段**（被赋值从未被读）。建议**删掉**，改用 `queueLevel`，避免两个"优先级"概念并存 |

---

## 四、面板的实现

### 4.1 形态选择

| 方案 | 做法 | 评价 |
| --- | --- | --- |
| **A（推荐）** | `statusServer` 加 `GET /panel`，返回**单文件内嵌 HTML**（CSS+JS 都内联） | 零新依赖、同源无 CORS、复用 `/command`+`/status`、跟着 Agent 进程启动。**约 150 行** |
| B | 独立 Node 进程 / 独立端口 | Node 挂了面板还在，能报警。但要处理 CORS + 双份配置。**作为 P3 的看门狗补充** |
| C | 做成 `mod-client` 里的游戏内 GUI | ❌ **核实结论：Mod 侧完全没有 GUI 能力** —— 只有 `mc.player.swing()` 这种动画调用，无 `Screen`/`KeyMapping`/按键注入。要做就得从零写 Forge GUI 并重新构建 |

### 4.2 界面（最小可用版）

```
┌──────────────────────────────────────────────────────────────────────┐
│ 🐱 AgentSteve 控制台     body:clientmod  大脑:▶运行中  登录:✅已登录    │ ← 1s 轮询 /ui/state
│ hp 18/20  🍗12  📍-28,68,32  手持:iron_pickaxe  在线:我                │
├──────────────────────────────────────────────────────────────────────┤
│ 当前任务: mine iron (2/3)  [指令]        队列: 1 项                    │
│   ▸ 12:31:02 build hut 5x3x5  [指令] (排队中)                         │
├──────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ ▸ 输入指令（回车发送，↑↓ 翻历史，Tab 补全）                          │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ 优先级: ( ) 紧急  (•) 指令  ( ) 自主                                   │
├──────────────────────────────────────────────────────────────────────┤
│ [⏹ 急停] [⏸ 暂停] [▶ 继续] [📊 状态] [🎒 背包] [🧭 位置]                  │
├──────────────────────────────────────────────────────────────────────┤
│ 执行日志                                                              │
│  12:31:02 ▸ mine iron 3      [指令] ⚡抢占 gather-wood → 已入队         │
│  12:31:05   挖到 iron_ore ×1 (1/3)                                    │
│  12:31:18 ▸ build hut        [指令] ⚠️ 缺 42 块木板，已排队             │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.3 后端路由（都加在 `src/web/statusServer.js`）

| 路由 | 作用 | 工作量 |
| --- | --- | --- |
| `GET /panel` | 内嵌单文件 HTML | ~120 行（字符串常量） |
| `GET /ui/state` | 为面板裁剪的精简状态（**不返回 40817 格方块**，只给摘要） | ~30 行 |
| `GET /ui/events` | **SSE** 推送：任务开始/完成/失败、状态变化、日志行 | ~35 行 |
| `POST /command`（改） | 加 `priority` 字段；响应加 `{accepted, level, preempted, queuedBehind}` | ~15 行 |

> **SSE 而不是 WebSocket**：与 Java 侧选 HTTP 同一个理由 —— Node 侧 SSE 就是 `res.write('data: ...\n\n')`，零依赖；`statusServer` 已经是 `http.createServer`，加一个 `text/event-stream` 路由很轻。
> 但**最小可用版可以先用 1s 轮询**，SSE 放 P2。

### 4.4 前端要点（不用框架，遵循项目零依赖哲学）

- 原生 `fetch` + 模板字符串；状态条 1s 轮询（或 SSE）
- 指令历史存 `localStorage`，↑↓ 翻
- Tab 补全：从静态指令名列表补全（`mine`/`chop`/`craft`/`goto`/…）
- **急停按钮固定左上角，红色**，走 `URGENT`
- 危险指令二次确认（`stop` 之外，未来任何"拆"类意图）
- **登录状态显式显示**（`AuthMe` 是否成功），因为它决定 Bot 是不是木桩

---

## 五、实现路径（三个阶段）

### P1 —— 让链路通（**必做，约 220 行**）

| 改动 | 文件 | 工作量 |
| --- | --- | --- |
| clientmod 分支：`body.connect()` → AuthMe 登录 → `brain.start()` | `src/index.js` | ~40 行 |
| `botFacade`：补 `ctx.bot` 的「读状态 + 说话」，**故意不补写动作** | `src/body/botFacade.js`（新） | ~60 行 |
| 三级优先级 + 按级插入 | `src/brain.js` | ~80 行 |
| 精简状态路由 + 面板 HTML（含急停） | `src/web/statusServer.js` | ~40 + 120 行 |

**P1 验收**（大部分可离线验证）：
1. `npm run selftest` 通过；`node --check` 无语法错误
2. MockBody 单测：自主任务跑着时下 `DIRECTIVE` → **自主任务被 cancel，指令开始跑**
3. MockBody 单测：两个 `DIRECTIVE` 连发 → **第一个跑完，第二个从队列出队**（不互相取消）
4. MockBody 单测：`URGENT` → 当前任务 cancel + 队列清空
5. 实机（你有条件时）：`npm run agent:client` → 日志见 `AuthMe 登录已发送`；浏览器开 `127.0.0.1:8766/panel` 看到实时血量坐标；输入 `mine iron 3` 能真的开始挖

### P2 —— 让它好用（约 100 行）

`GET /ui/events`（SSE）替代轮询；指令历史与补全；`⚠️` 明确提示哪些指令在当前 body 下不支持（`hunt`/`craft`/`store`/`light`）；任务进度条。

### P3 —— 让它可靠（约 120 行）

**看门狗**（`scripts/watchdog.js`，独立进程）：每 5s 拉 `127.0.0.1:8766/health`，连续 3 次失败 → 重启 Agent 进程；可选通过 8899 让客户端在游戏里说一句「我掉线了」。
**认证**：`config/agent.json` 加 `web.token`（默认 `127.0.0.1` 不要求；设了 `bind: "0.0.0.0"` 则强制要求）。
**审计**：所有面板指令写 `runtime/ui-commands.jsonl`。

---

## 六、可选：顺手修 3 行 Java，解锁战斗与建造

这部分**不是面板需求的一部分**，但既然 P1 要重启客户端，一起做最省事：

| 改动 | 文件 | 工作量 | 解锁 |
| --- | --- | --- | --- |
| `attack` 参数个数：`numbers(rest, 2)` 内部要求 `tokens.length >= 3`，而 Node 只发 2 个 | `ControlHttpServer.java:443` | ~1 行 | 战斗（`defend`、未来的「打那只僵尸」） |
| `place` 的 `nth(rest,4)`/`nth(rest,5)` off-by-one（0-based vs 1-based） | `ControlHttpServer.java:435-436` | ~2 行 | 建造（`shelter`、未来的 `BuildTask`） |
| `hostiles` 放开成「敌对 + 被动」，新增 `passive` 数组 | `ClientStateSnapshot.java:177-179` | ~20 行 | `hunt` 整条食物链 |
| 新增 `lightLevel` 字段 | `ClientStateSnapshot.java` | ~5 行 | `light`、洞穴安全判断 |

改完需要 `npm run client:build` + 重启客户端。

---

## 七、风险

| # | 风险 | 缓解 |
| --- | --- | --- |
| **R1** | **AuthMe 登录失败 → Bot 变木桩**，而且面板上看不出来 | 登录失败必须 `log.error` + 面板顶部红字显示；可选 `exitCode 5` 退出 |
| **R2** | Node 进程挂了 = 面板和 Agent 一起没了 | P3 看门狗；同时保留 8899 作为手工逃生通道（直接 `curl` 发 `stop`） |
| **R3** | **指令静默失效**（就是现在的问题） | 面板必须显示「已入队 / 已抢占 / 被拒绝」三态，**不能只显示 ok** |
| **R4** | 部分指令在 clientmod 下做不到（`hunt`/`craft`/`store`/`light`） | 面板对当前 body 做能力过滤，做不到的按钮置灰并给出原因，而不是让它失败 |
| **R5** | 8766 无认证，本机任意进程可指挥 Bot | P3 的 token；至少在 README 写明 |
| **R6** | 游戏内聊天框输入会被 `ChatLog` 50 条上限挤出 | 轮询间隔要短（≤1s）；或让 Mod 暴露「自上次读取以来的新行」语义（`/chatlog?since=<seq>`），这是个小改进 |
| **R7** | 中文/空格在 `POST /command` 里的切词 | `handle()` 按空白切词（`commands.js:229`），中文可用；含空格的复杂自然语言留给未来的 LLM 通道 |

---

## 八、和 LLM 计划的关系

面板是 LLM 层的**天然输入输出口**，两者应该一起设计：

| 面板元素 | LLM 接入后 |
| --- | --- |
| 输入框 | 变成「自然语言指令」入口 —— 你打「帮我盖个 5×5 木屋」，LLM 路由成 `build` |
| 输出/回复 | 变成猫娘对话的显示位（同时也是游戏内聊天的镜像） |
| 优先级单选 | 保留。LLM 自主规划的任务走 `AUTONOMOUS`，你的输入走 `DIRECTIVE` |
| 急停按钮 | 不变，永远 `URGENT` |

**建议的执行顺序**：

```
P1 接通（本文 §5）           ← 你现在最需要的：能下命令、能看到、能刹车
Java 3 行修复（§6，可选）      ← 顺手解锁战斗/建造
LLM M1 对话（原计划）         ← 面板输入框接上猫娘
LLM M2 自然语言（原计划）      ← 面板输入「帮我盖个 5×5 木屋」
LLM M3 BuildTask（原计划）
```

**P1 不依赖任何 LLM**，所以它风险最低、收益最快，而且做完之后你对 Agent 的控制权问题就**完整解决**了（能下指令、能看状态、能立刻停）。

---

## 九、一句话总结

> 这个需求**不是「给自主 Agent 加一个干预界面」**（因为 Agent 现在还不会自主工作），
> 而是**「给一个没接线的 Agent 装上总机」**。
>
> 而且你的账号约束推出一个好消息：**MC 聊天框本身就是一个可用的输入通道**（你的打字会被 Mod 的 `ChatLog` 捕获），
> 所以方案不必把面板做成唯一入口 —— **聊天框负责说话，面板负责看和刹车**，交互复杂度大幅降低。
>
> 落地成本：**约 220 行 JS + 1 处接线修复**（+ 可选 3 行 Java）。优先级机制本身只有约 80 行，但它必须建立在「任务队列真的会跑」这个前提上。
