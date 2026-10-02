# 需求分析：外置控制台（UI 指令通道）

> **需求**：Bot 通过 PCL 客户端在 Forge 服务器上运行，玩家无法用第二个账号上线（会失去对 Agent 的控制权）。
> 因此需要一个**游戏外**的界面来输入指令，且该指令**具备更高优先级**。
>
> 本文回答：**可行吗？当前架构里缺什么？怎么实现？**
>
> 前置阅读：[`ARCHITECTURE.md`](ARCHITECTURE.md)（含 §六 clientmod 接线缺口）、[`LLM-INTEGRATION-PLAN.md`](LLM-INTEGRATION-PLAN.md)。
>
> ⚠️ **本文的缺口清单已由 [`CAPABILITY-AUDIT.md`](CAPABILITY-AUDIT.md) 做代码级核实并修正**（AuthMe 结论、8899 可用 verb 清单、寻路缺失的影响）。两份文档一起看。

---

## 〇、结论先行

| 问题 | 结论 |
| --- | --- |
| 技术上可行吗？ | **完全可行，而且 80% 的零件已经存在。** `127.0.0.1:8766` 上跑着一个零依赖 HTTP 服务器，它的 `POST /command` 已经暴露了**全部 19 个指令**（`mine`/`chop`/`craft`/`goto`/`shelter`/`stop`/`pause`…），而且它在 **clientmod 模式下也会启动** |
| 最大的障碍是什么？ | **不是缺 UI，而是 clientmod 模式下 `Brain` 根本没启动**。任何从 UI 发来的任务都会被推进队列后**永远躺着不动** |
| 「更高优先级」现在有吗？ | **没有。** `Brain.queue` 是普通 FIFO 数组（`brain.js:40`），`runTask` 只看 `activeTask` 引用是否相等，没有任何优先级或抢占语义 |
| 工作量 | **最小可用面板约 250 行新代码 + 1 处 `index.js` 接线修复**。不需要新依赖，不需要改 Java Mod |
| 需要先修的前置 | 1 处 architecture blocker（`index.js` 的 clientmod 分支），1 处静默失败（`ctx.bot` 为 null 导致回复丢失） |

**一句话**：这个需求不是「新增一个界面」的问题，而是**把已经存在的控制链路接通**的问题。而且接通它同时解决了「Agent 无法自主运行」这个更根本的问题。

---

## 一、现状盘点：已经有的 vs. 缺的

### 1.1 已有的零件（比预期多）

| 零件 | 位置 | 说明 |
| --- | --- | --- |
| **零依赖 HTTP 控制服务器** | `src/web/statusServer.js` | `http.createServer`，绑 `127.0.0.1`，端口 = `cfg.server.bridgePort + 1` = **8766** |
| **完整指令入口** | `POST /command` | body `{"command":"mine iron 3"}` → `ctx.chat.handle()` → **与游戏内 `!` 指令完全同一张表**（19 个指令） |
| **状态查询** | `GET /status` | bot / world / brain / inventory / plugins / mods / target 全套 |
| **日志流** | `GET /logs?n=50` | 根 logger 的 500 行环形缓冲 |
| **Mod 认知** | `GET /mods` | 加载器、Mod 命名空间、已学内容 |
| **clientmod 的底层动作** | `127.0.0.1:8899` | `POST /command` 支持 16 个 verb（`moveto`/`dig`/`place`/`attack`/`chat`/`cmd`…）；`GET /state` 返回含 40817 格方块的真实快照 |
| **AuthMe 登录方法** | `clientModBody.js:420` `login(password)` | 已实现、已实测可用（`runtime/real-server-login.json` 记录 `/login` 成功） |

**关键发现**：`startStatusServer` 在 `src/index.js:330-332` 被调用，位置在 **mock 分支（253 行）之前、任何 body 判定之后**。也就是说：

```js
// index.js 的顺序
createBody(...)                      // 200 行
if (kind !== 'mineflayer') { ... }   // 213 行：换 WorldView
... shim / Brain / ChatController    // 218-233 行
if (!args.noStatus) startStatusServer(...)   // ★ 330 行：无条件启动
controller.connect(); chat.attach();         // 337-338 行
```

⇒ **`--body clientmod` 下 8766 端口是开着的，`POST /command` 是可以收到请求的。**

### 1.2 缺的零件（四个，其中一个致命）

| # | 缺口 | 后果 | 证据 |
| --- | --- | --- | --- |
| **G1** 🔴 | **clientmod 模式下 `Brain` 永远不启动** | UI 发来的任务**进了队列但永远不执行** | `body.connect()` 只在 mock 分支被调用（`index.js:253-262`）；`brain.start()` 只在 mineflayer 的 `spawn` 回调里（`index.js:309`）；`controller.connect()` 在 clientmod 下是 no-op。⇒ `ClientModBody.connected=false` ⇒ `snapshot()` 返回 null ⇒ `Brain.attached` 为 false ⇒ `slowLoop()` 第一行就 `return` |
| **G2** 🔴 | **clientmod 模式下 `ctx.bot` 是 `null`** | 所有「即时指令」和**所有回复**静默失效 | `ctx.bot` 只由 `controller.on('botCreated')` 赋值（`index.js:228-230`）。clientmod 不调 `controller.connect()` ⇒ 该事件永不触发。而 `ChatController.say()` 用 `ctx.bot.chat()`（`commands.js:95`），抛 TypeError 被 `catch{}` **吞掉**（`commands.js:96-98`） |
| **G3** 🔴 | **Bot 无法自主登录 AuthMe** | 「自动跑」根本无从谈起 | `config/agent.json` 的 `bot.authme` 块（`enabled/password/registerOnMissing/timeoutMs`）**全项目零消费者**；`ClientModBody.login()`（`clientModBody.js:420`）在 `src/` 下**没有任何调用点**。唯二的调用者是测试脚本 `scripts/client-real.js:182`（`--login <pw>`）与 `scripts/test-clientmod-protocol.js:218`。**Mod 侧也没有自动登录**（`ClientModConfig` 无 password 字段，`ChatLog` 只记录不应答）。⇒ 登录目前靠手工跑一个脚本，**Agent 自身不会登录** |
| **G4** 🟡 | **没有优先级 / 抢占机制** | 「更高优先级」无从实现 | `Brain.queue` 是 `[]`（`brain.js:40`），`push()` 直接 `push` 到尾部（`brain.js:432`）；`runTask` 只在 `activeTask` 引用相等时排队（`brain.js:323-327`），不比较 `priority`。`Task.priority` 这个字段**被赋值但从未被读取** |
| **G5** 🟡 | **8766 没有任何认证** | 本机任意进程都能指挥 Bot | `statusServer.js` 无 token 校验（对比：两个 Java Mod 都支持 `authToken`） |

### 1.3 附带发现的两个 bug（顺手记下）

| 位置 | 问题 |
| --- | --- |
| `clientModBody.js:434-437` | `commandSent()` 调用了**不存在的 `this.command()`**。该类只有 `request()` / `chat()` / `safeCommand()`，没有 `command()`。调用会抛 TypeError。当前**无调用点**（注释说用途，代码里没人用），但它是死的错误代码 |
| `clientModBody.js:446-452` | `ClientModBody.isForbidden()` 把 `'reg'` / `'register'` 前缀当成禁用**命令**。所以猫娘用中文正常说话时，如果有人叫 "Reg"、或句子以 "reg…" 开头，发言会被**误拦**。应在说话路径上放宽为「精确匹配指令形态」 |

---

## 二、可行性分析

### 2.1 为什么「游戏外指令」这条路是本项目唯一的正确解

三种可能的控制通道对比：

| 通道 | 是否需要第二个账号 | 在 Forge 服上可行 | 实时性 | 结论 |
| --- | --- | --- | --- | --- |
| 游戏内 `!` 前缀聊天 | ❌ **需要**（Bot 占用了唯一的账号） | 可行 | 好 | **被需求排除** |
| `mod-bridge` 的 `!!agent` 中继 | ❌ 需要（要有人在线打字） | **不可行**（Fabric-only，当前服务器是 Forge） | 好 | **双重不可行** |
| **游戏外 HTTP（8766 / 8899）** | ✅ **不需要** | ✅ 可行（走 localhost，与服务器类型无关） | 好 | **唯一解** |

⇒ 用户的需求不是「想要一个 UI」，而是**识别出了这个架构下唯一的控制通道**。这个判断是正确的。

### 2.2 为什么 UI 应该挂在 Node 侧（8766）而不是 Mod 侧（8899）

| 维度 | Node 侧（8766，`statusServer`） | Mod 侧（8899，`ControlHttpServer`） |
| --- | --- | --- |
| 已支持的指令 | **19 个任务级指令**（`mine iron 3`、`shelter`、`chop 32`…） | 16 个**动作级** verb（`dig x y z`、`moveto x y z`） |
| 语义层级 | 「去挖 3 个铁」 | 「挖这个坐标的方块」 |
| 有任务队列/重试/隔离吗 | ✅ 有 | ❌ 无，单次动作 |
| 能改代码就生效吗 | ✅ 纯 JS，改完重启进程 | ❌ 要重新 `gradlew build` + 重启 Minecraft 客户端 |
| 有 Agent 状态吗 | ✅ `/status` 全套 | ⚠️ 只有客户端视角 |
| **单点故障** | ❌ Node 挂了 UI 一起挂 | ✅ 独立进程，Node 挂了 UI 还在 |

**结论：UI 主界面挂 Node 侧（8766）**，因为它能表达「意图」而不是「坐标」。Mod 侧的 8899 保留为**逃生通道**（Node 挂掉或卡死时，直接手动拖拽/急停）。

### 2.3 一个必须说清的控制论问题

用户担心「失去对 Agent 的控制权」。拆开看其实是三件事：

| 子问题 | 现在有解吗 |
| --- | --- |
| ① 我能不能给它下指令？ | ✅ 能（8766 已在跑）—— 但**指令落不了地**（G1） |
| ② 我能不能让它立刻停下？ | ⚠️ 部分能（`stop` 指令 → `brain.preempt()`），但 G1 让它也失效 |
| ③ 我知不知道它现在在干什么？ | ✅ 能（`GET /status`） |

⇒ ①③ 已具备，② 需要 G1 + G4 一起修。修完这三件事，「控制权」就完整了 —— **不需要第二个账号，也不需要它退出游戏**。

### 2.4 致命前提：Agent 进程到底跑在哪？

这是必须向用户确认的一点，因为两种可能的现状会导致完全不同的工作量：

**情形 A（假定）**：Node 进程负责一切（`src/index.js --body clientmod`），只是接线的 G1/G2 没修。
→ 工作量中等（约 250 行 UI + 1 处接线修复）。

**情形 B（也可能）**：目前完全没有用 Node Agent，只是手动用 PCL 开客户端 + curl 打 8899。
→ 那么「控制面板」实际上是**第一次把 Node Agent 真正跑起来**，工作量是完整实施 `LLM-INTEGRATION-PLAN.md` 的 M0 + clientmod 接线。

两个情形的**第一步是同一个**：修 `index.js` 的 clientmod 分支。所以可以直接开工，边做边确认。

---

## 三、实现路径

### 3.1 阶段 P0 —— 让 clientmod 下的 Agent 真正跑起来（**前置，必做**）

**目标**：`node src/index.js --body clientmod` 之后，Agent 能自主感知、规划、执行，并且能说话。

**改动清单**：

```js
// src/index.js —— 新增 clientmod 分支（位置：mock 分支之前/之后均可，建议紧随 mock 之后）

// ------------------------------------------------------------------ clientmod body
if (bodySelection.kind === 'clientmod') {
  // 1) 让 ctx.bot 有东西可用 —— 这是 G2 的修复
  //    ChatController 与若干任务仍读 ctx.bot，用 body 做一个最小适配层
  ctx.bot = createBotFacade(ctx.body, controller);   // 见下

  // 2) 连上已在运行的客户端（内含 health + /state 轮询，最多等 120s）
  await ctx.body.connect();

  // 3) AuthMe 自动登录 —— 这是 G3 的修复
  const authme = cfg.agent.bot.authme || {};
  if (authme.enabled && authme.password) {
    const ok = await ctx.body.login(authme.password).catch(() => false);
    if (!ok) {
      log.error('AuthMe 登录失败 —— 客户端可能还没进世界，或密码不对');
      // 关键：不要静默继续。没登录的 Bot 在服务器上是个"站着的木桩"
      if (!authme.continueOnFailure) { process.exitCode = 5; return; }
    } else {
      log.info('AuthMe 登录已发送');
    }
    await sleep(authme.settleMs || 1500);   // 等服务器回执
  }

  // 4) 武装 Navigator 状态标志（mineflayer 路径下由 spawn 回调做）
  nav.armed = true;

  // 5) 启动大脑 —— 这是 G1 的修复
  brain.start();
  log.info('clientmod body online - planning against the live Forge client');
  if (args.goal) await applyGoal(ctx, args.goal);
  return;   // 不走 controller.connect()
}
```

**`createBotFacade` 的作用**（放在 `src/body/botFacade.js`，约 60 行）：
把 `ctx.bot` 上被读到的少数几个面转成 `body` 调用，让**尚未 Body 化的 4 个任务**（`ShelterTask`/`HuntTask`/`LightTask`/`DepositTask`）以及 `ChatController.say()` 不再炸：

```js
function createBotFacade(body, controller) {
  return {
    username: cfg.agent.bot.username,
    entity: { position: () => body.snapshot()?.position },   // 只读
    inventory: {
      items: () => Object.entries(body.snapshot()?.inventory || {})
                         .map(([name, count]) => ({ name, count, type: name }))
    },
    chat: (m) => body.chat(m),                 // ★ 修 G2 的说话路径
    whisper: (u, m) => body.chat(`/tell ${u} ${m}`),
    // 明确不提供：dig / place / equip / attack ——
    // 这些必须走 body，facade 上故意留空，让误用立刻炸出来而不是静默失败
  };
}
```

> **设计意图**：facade 只补「读状态」和「说话」，**不补任何写动作**。
> 这样 4 个未 Body 化的任务在 clientmod 下会**明确报错**（而不是静默做错事），
> 同时把它们暴露为待迁移清单 —— 比现在「看起来能用其实什么都不做」好得多。

**P0 验收**：
1. `npm run agent:client` → 日志出现 `AuthMe 登录已发送`，且 clientmod 的 `/chatlog` 能看到服务器回执
2. `curl http://127.0.0.1:8766/status` → `brain.running === true`、`bot.alive` 有真实坐标
3. `curl -X POST http://127.0.0.1:8766/command -d '{"command":"status"}'` → **返回体里有真实的血量/坐标**（证明 `ctx.bot` facade 生效）
4. 等 30s，`brain.current` 或 `brain.lastDecision` 应出现规律表决策（证明大脑在跑）

---

### 3.2 阶段 P1 —— 优先级与抢占（**这是「更高优先级」的实体**）

**设计：三级优先级 + 抢占语义**

| 级别 | 来源 | 语义 | 例子 |
| --- | --- | --- | --- |
| **P0 紧急** | UI + `!stop`/`!pause` | **立刻抢占**：取消当前任务、清空队列、立即执行 | 急停、暂停、`goto`（救命用） |
| **P1 直接指令** | UI + 玩家聊天 + LLM 意图 | **抢占当前任务，但保留队列** | `mine iron 3`、`build hut`、`follow me` |
| **P2 自主规划** | 规则表 + LLM 自主 | **排队**，不抢占 | `gather-wood`、`light`、`deposit` |

**实现**（约 80 行，改 `src/brain.js`）：

```js
/** 指令优先级常量 */
const PRIORITY = { URGENT: 0, DIRECTIVE: 1, AUTONOMOUS: 2 };

/**
 * 高优先级入队。
 * @param {Task} task
 * @param {{level?:number, preempt?:boolean, source?:string}} options
 */
async enqueue(task, options = {}) {
  const level = options.level ?? PRIORITY.DIRECTIVE;
  task.source = options.source || 'unknown';   // 'ui' | 'chat' | 'llm' | 'rule'
  task.queueLevel = level;

  // P0：取消一切 —— 包括正在跑的任务和所有排队中的
  if (level === PRIORITY.URGENT) {
    this.log.warn(`URGENT ${task.name} from ${task.source} - pre-empting everything`);
    if (this.activeTask) this.activeTask.cancel();
    this.queue.length = 0;
  }

  // P1：抢占当前任务（它会被重试，除非是自主任务 —— 自主任务直接丢弃）
  if (level === PRIORITY.DIRECTIVE && this.activeTask) {
    if (this.activeTask.queueLevel === PRIORITY.AUTONOMOUS) {
      this.log.info(`pre-empting autonomous ${this.activeTask.name} for ${task.name}`);
      this.activeTask.cancel();
    } else {
      // 已经有直接指令在跑：排队，别打断（避免玩家连发两条互相取消）
      this.queue.push(task);
      return task.snapshot();
    }
  }

  // 按级别插入队列（P0 最前，同级 FIFO）
  const idx = this.queue.findIndex((t) => (t.queueLevel ?? PRIORITY.AUTONOMOUS) > level);
  if (idx === -1) this.queue.push(task);
  else this.queue.splice(idx, 0, task);

  if (!this.activeTask) await this.slowLoop();
  return task.snapshot();
}
```

**同时要改的地方**：
- `decide()` 产出的任务标记为 `AUTONOMOUS`（规则表自己挑的，随时可被打断）
- `runTask()` 结束时的 `maybeRetry()`：**自主任务失败不再重试**（用户已经不关心它了），直接丢弃
- `ChatController.handle()` 里给「急停类」指令（`stop`/`pause`）标 `URGENT`，其余标 `DIRECTIVE`
- `Task.priority` 那个死字段：**要么删掉，要么接上**。建议接上并改名为 `queueLevel`，避免两个「优先级」概念并存

**P1 验收**（单测，用 MockBody）：
1. 正在跑 `gather-wood`（自主）时发 `mine iron 3`（直接）→ **gather-wood 立即 cancel，mine 开始跑**
2. 正在跑 `mine iron 3`（直接）时再发 `chop 32`（直接）→ **mine 继续跑完，chop 排在后面**（不互相取消）
3. 发 `stop`（紧急）→ 当前任务取消 + 队列清空
4. 自主任务失败 3 次 → 进入 quarantine，**但不产生重试风暴**

---

### 3.3 阶段 P2 —— 外置控制面板（UI）

**方案选择**

| 方案 | 做法 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- | --- |
| **A（推荐）** | 在 `statusServer` 上加 `GET /panel`，返回**单文件内嵌 HTML**（含 CSS+JS） | 零新依赖、同源无 CORS、复用 `/command`+`/status`、约 250 行、**跟着 Agent 进程一起启动** | Node 挂了 UI 一起挂 | ✅ **先做这个** |
| B | 独立 Node 静态服务 / 独立端口 | Node 挂了 UI 还在，能报警 | CORS + 双份配置 + 多一个进程要管 | ⏳ 做完 A 后作为「看门狗」补充 |
| C | 做成 `mod-client` 里的游戏内 UI | 不依赖 Node | 要改 Java + 重新 build + 重启客户端；且做不了任务级指令 | ❌ 不做 |

**方案 A 的界面布局**

```
┌──────────────────────────────────────────────────────────────────────┐
│  🐱 AgentSteve 控制台          body: clientmod   brain: ▶ running     │  ← 顶部状态条（1s 轮询）
│  hp 18/20  food 12  pos -28,68,32  当前: mine iron (2/3)  队列: 1     │
├──────────────────────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ ▸ 输入指令（回车发送，↑↓ 翻历史，Tab 补全）                      │  │  ← 主输入框
│  └────────────────────────────────────────────────────────────────┘  │
│  优先级:  ( ) 紧急   (•) 直接   ( ) 自主                              │  ← 优先级单选
├──────────────────────────────────────────────────────────────────────┤
│  [⏹ 急停] [⏸ 暂停] [▶ 继续] [📊 状态] [🎒 背包] [🧭 位置] [💬 说话]     │  ← 快捷按钮
├──────────────────────────────────────────────────────────────────────┤
│  日志 / 执行结果（滚动，500 行）                                       │
│  12:31:02  ▸ mine iron 3         [直接] → 抢占 gather-wood，已入队      │
│  12:31:05    挖到 iron_ore x1 (1/3)                                   │
│  12:31:18  ▸ build hut 5x3x5     [直接] ⚠️ 缺 42 块木板               │
└──────────────────────────────────────────────────────────────────────┘
```

**要新增的后端路由**（都加在 `statusServer.js`）：

| 路由 | 作用 |
| --- | --- |
| `GET /panel` | 返回内嵌的单文件 HTML |
| `POST /command`（**改**） | body 增加可选 `priority` 字段（`urgent`/`directive`/`autonomous`，默认 `directive`）；响应增加 `{accepted, level, preempted}` |
| `GET /ui/state` | 为面板裁剪的精简状态（避免每次拉全量 `/status` 的 40817 格方块） |
| `GET /ui/events` | **SSE**（`text/event-stream`）推送：任务开始/完成/失败、状态变化、日志行。**替代轮询，实时性从 1s 提升到即时，且开销更低** |
| `GET /health`（已有） | 供方案 B 的看门狗用 |

> **SSE 而不是 WebSocket**：与 mod 侧选 HTTP 同一个理由 —— Node 侧 SSE 是纯 `res.write()`，零依赖；而 `statusServer` 已经是 `http.createServer`，加一个 `text/event-stream` 路由不到 30 行。

**前端要点**：
- 单文件 HTML，**不用框架**（项目哲学：零依赖）。原生 `fetch` + 模板字符串渲染
- 输入历史存 `localStorage`（↑↓ 翻）
- 指令补全：从 `/ui/state` 拉一个静态指令名列表（`mine/chop/craft/goto/...`）做 Tab 补全
- **急停按钮固定左上角**，红色，`POST /command {"command":"stop","priority":"urgent"}`
- 危险指令二次确认：`stop` / 任何「拆」类意图

### 3.4 阶段 P3 —— 安全加固（可选但建议）

| 项 | 做法 |
| --- | --- |
| **认证** | `config/agent.json` 加 `web: { token: "...", bind: "127.0.0.1" }`。**默认 `127.0.0.1`**；想让手机在同一 WiFi 上控制就设 `bind: "0.0.0.0"` **并强制要求 token**（此时必须拒绝无 token 请求） |
| **LAN 访问** | 绑 `0.0.0.0` + token + 简单的失败次数限流。这样你能用手机浏览器控制 Bot |
| **看门狗** | `scripts/watchdog.js`：独立进程，每 5s 拉 `127.0.0.1:8766/health`；连续 3 次失败 → 用 `child_process.spawn` 重启 Agent，并（可选）用 8899 的 `/command` 让客户端发一句「我掉线了」到游戏公屏 |
| **审计** | 所有 UI 指令写进 `runtime/ui-commands.jsonl`（时间、指令、优先级、是否抢占、结果） |

---

## 四、与 LLM 计划的关系（重要）

这份需求实际上**简化**了 `LLM-INTEGRATION-PLAN.md`：

| 原计划的内容 | 变化 |
| --- | --- |
| **M0 聊天事件探针**（验证 `bot.on('chat')`） | ❌ **整个作废**。mineflayer 不参与，改为在 `mod-client` 的 `ChatLog` 上加**出站推送**（SSE 或 `/chatlog` 轮询）给 Node。这反而更简单 —— `ChatLog` 已经抓到了结构化聊天 |
| **任务一的对话触发** | ✅ 保留，但入站来源从 `bot.on('chat')` 改成 `ClientModBody` 的聊天读取 |
| **任务二的自然语言指令** | ✅ 保留。而且**控制面板正好是它的输入源** —— 面板输入 = 天然的「非格式自然语言指令」入口 |
| **§六 安全守卫（B3 权限/限流）** | ✅ 重要性上升。面板是**唯一**的指令入口，所以权限检查放在这里一处即可 |
| **M1 的 `whisper` 回复** | ⚠️ 需要改：clientmod 下没有 `bot.whisper`，要走 `body.chat('/tell ...')`（`ClientModBody.chat()` 已支持 `/` 开头走 `cmd`） |

**建议的合并执行顺序**：

```
Step 1  clientmod 接线（本文 P0）      ← 让 Agent 真的能自主跑
Step 2  优先级/抢占（本文 P1）          ← 让"更高优先级"成真
Step 3  控制面板（本文 P2）             ← 你终于有一个能用的界面
───────────────────────── 到这里"控制权"问题完整解决 ─────────────────────────
Step 4  面板接 LLM 对话（原 M1）         ← 面板同时也是和它聊天的窗口
Step 5  自然语言指令（原 M2）            ← 面板输入"帮我盖个 5x5 木屋"
Step 6  BuildTask + Mod 规则（原 M3）
```

**Step 1-3 是自成一体的里程碑**，做完你就能：打开浏览器 → 看到 Bot 在干什么 → 输入指令 → 它立刻执行 → 卡住了按急停。**这三步不依赖任何 LLM**，所以风险最低、收益最快。

---

## 五、风险与注意点

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | **`AuthMe` 自动登录失败会导致 Bot 变木桩** | 登录失败**必须显式报错并可选退出**（`exitCode 5`），不能静默继续。同时在面板顶部显示登录状态 |
| R2 | **Node 进程挂了 = 失去一切** | 面板右上角显示 `health`；P3 的看门狗；同时保留 8899 作为手工逃生通道（直接拖 `/command` 发 `stop`） |
| R3 | **未 Body 化的 4 个任务在 clientmod 下会失效** | P0 的 facade 故意**不补写动作**，让它们明确报错。面板要对这些指令回明确提示：「`shelter` 在客户端模式下暂不可用」，而不是静默失败 |
| R4 | **`stop` 也停不下来**（如果 G1 没修） | P0 必须先做完。`stop` → `brain.preempt()` 依赖 `activeTask` 有值，而 activeTask 只在任务真跑起来时才有值 |
| R5 | **面板被本机其他程序滥用** | P3 的 token；至少在 `README` 里写清「8766 谁都能调」 |
| R6 | **`ClientModBody.isForbidden` 误拦正常发言** | 说话路径走 `body.chat()` 时，把禁用检查放宽为「整条消息形如 `register`/`reg ...`」而非前缀包含 |
| R7 | **SSE 在长时间运行后连接泄漏** | 面板关闭时 `EventSource` 自动断开；服务端在 `req.on('close')` 里清理订阅者集合，并加上限（最多 4 个订阅者） |
| R8 | **面板输入的中文/空格/引号** | `POST /command` 已按空白切词（`commands.js:229`）。中文目标（`!goal 砍32个木头`）可用；但**含空格的物品名或复杂自然语言**建议直接走 LLM 通道（Step 4 之后） |

---

## 六、需要你确认的三件事

| # | 问题 | 为什么必须问 |
| --- | --- | --- |
| **Q1** | **现在到底是谁在驱动 Bot？** 是 `node src/index.js --body clientmod` 在跑（只是 G1/G2 让任务不执行），还是完全没用 Node、只手动 curl 打 8899？ | 决定 Step 1 是"修接线"还是"从零接通"，工作量差一倍 |
| **Q2** | **AuthMe 现在是怎么过的？** 每次手动在客户端窗口里打 `/login`？还是客户端有自动登录 Mod？ | G3 的修法不同：手动 → 要加自动登录；已有 Mod → Node 侧不用管，但要防止重复发送 |
| **Q3** | **面板要不要支持手机/局域网访问？** | 决定 P3 是「只绑 127.0.0.1」还是「绑 0.0.0.0 + token」。后者要额外做认证和限流 |

---

## 七、最小可交付切片（如果只想先看到效果）

```powershell
# 1) 修 index.js 的 clientmod 分支（P0）—— 约 60 行
#    加 createBotFacade + body.connect() + AuthMe 登录 + brain.start()

# 2) 加优先级（P1）—— 约 80 行
#    Brain.enqueue(task, {level, source}) + decide() 标 AUTONOMOUS

# 3) 加面板（P2 的最小版）—— 约 150 行
#    只做：状态条 + 输入框 + 急停按钮 + 日志区
#    先不做 SSE（用 1s 轮询 /ui/state + /logs 就够）先把链路打通

npm run agent:client
# 浏览器打开 http://127.0.0.1:8766/panel
```

**总计约 290 行新代码 + 1 处接线修复**，不新增任何依赖，不改任何 Java 代码。
