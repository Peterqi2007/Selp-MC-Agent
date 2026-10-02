# 代码级核实：Bot 现状能力矩阵与指令通道

> **核实范围**：`src/`、`scripts/`、`mod-client/`、`config/` 全量源码阅读（未实机启动 PCL，全部为静态核实）。
> **核实目的**：回答「目前 bot 能自主工作吗？能给它下什么命令？命令能实现吗？」
> **修正声明**：本文修正了 [`CONTROL-PANEL-ANALYSIS.md`](CONTROL-PANEL-ANALYSIS.md) 中关于 AuthMe 的一处错误结论（见 §2）。

---

## 一、结论速览

| 问题 | 结论 |
| --- | --- |
| Bot 能自主工作吗？ | **不能。** 在 clientmod 模式下 `Brain` 两个循环从未启动，Bot 是个「能感知、能被手动驱动、但不会自己思考」的木偶 |
| 现在实际能给它下什么命令？ | **只有 8899 上的 16 个动作级 verb**，且其中 **6 个是坏的**，实际可用 **9 个** |
| Node 侧那 19 个任务级指令能用吗？ | **收得到请求，但任务永远不执行**（会躺在队列里） |
| AuthMe 是谁登录的？ | **一个测试脚本**（`scripts/client-real.js --login <pw>`），不是 Agent 自主行为，也不是 Mod 自动应答 |
| 为什么不能用 8899 作为主通道？ | 因为 **clientmod 没有寻路**（`WalkTo` 是直线贪心），而 `movement.js` 的 `Navigator`（A* + 卡死自救 + 空路径检测）是 Node 侧独有的、不可替代的资产 |
| 最小修复路径 | 在 `src/index.js` 加 **约 80 行** clientmod 分支 → 19 个指令全部激活 |

---

## 二、修正：AuthMe 登录到底是谁做的

### 2.1 我上一份文档的错误

我在 `CONTROL-PANEL-ANALYSIS.md` §1.2 写了「目前必须**人工**在客户端窗口里打 `/login`」。**这个结论是错的**，我基于 `src/` 目录的 grep 就下了判断，没有查 `scripts/`。实际证据链：

| 证据 | 位置 |
| --- | --- |
| 调用点在**测试脚本**里 | `scripts/client-real.js:182` `const sent = await body.login(password);` |
| 密码来自命令行参数 | `scripts/client-real.js:35` `const password = valueOf('--login');` |
| 用法是显式手工执行 | `scripts/client-real.js:17` 注释：`node scripts/client-real.js --login <your-password>` |
| 另一个调用点是协议测试 | `scripts/test-clientmod-protocol.js:218` `await body.login('<your-password>')` |
| **`src/` 下零调用点** | 全量 grep 确认，只有 `clientModBody.js:420` 的**定义** |

⇒ **是「bot 自己调用工具输入的」这个描述在实现层面成立，但调用者是测试脚本，不是 Agent。** 你说的没错 —— 它确实是程序发的，不是人手打的；只是发起的那个程序是 `scripts/client-real.js` 而不是 `src/index.js`。

### 2.2 Mod 侧没有任何自动登录

我一开始怀疑 `ClientModConfig.java:37` 那句 `Auto-answer an AuthMe style login prompt` 是自动登录的实现。核实结果是**它是遗留的注释**：

```java
// ClientModConfig.java:36-44 —— 注意 javadoc 在讲「自动应答」，但它标注的字段是 allowCommands
/**
 * Auto-answer an AuthMe style login prompt.
 *
 * The client mod does the sending (it owns the chat connection), but the decision to
 * log in belongs to the agent. Keeping the password out of the mod's config is
 * deliberate: it lives in the agent's config, which is the component that already
 * holds credentials.
 */
public boolean allowCommands = true;
```

证据：
- **`ClientModConfig` 没有 `password` / `username` 字段**（我 grep 到的 `password` 只是这段注释里的词）
- **`ChatLog` 只是记录器**（`ChatLog.java:35-51`）：`onChat` 唯一动作是 `LINES.add(text)`，没有任何模式匹配或应答
- **`AgentClientMod` 只注册了 `ChatLog`**（`AgentClientMod.java:45-49`），`onClientTick` 只调 `actions.tick()`（推进连续动作），没有任何登录相关定时器

⇒ **Mod 永远不会自己发 `/login`。它只能被要求发。**

### 2.3 这对方案意味着什么

| 事实 | 影响 |
| --- | --- |
| `config/agent.json` 的 `bot.authme` 块是死配置 | 里面的 `password: "<your-password>"` 从没被读过 |
| `ClientModBody.login()` 已实现且**已实测可用** | 好消息：底层是通的，`runtime/real-server-login.json` 记录服务器回过「欢迎 感谢！」 |
| 只需要一个调用点 | P0 接线里加 5 行即可 |

**⇒ 修复成本极低，但必须做，否则 Bot 在服上是个未登录的旁观者。**

---

## 三、实测能力矩阵：8899 上到底什么能用

### 3.1 完整 verb 表（`ControlHttpServer.java:391-461`）

| verb | 参数形态 | 实际行为 | 状态 |
| --- | --- | --- | --- |
| `chat <文本>` | 自由文本 | `ClientActions.chat()` → `sendChat()` | ✅ **可用** |
| `login <密码>` | 自由文本 | `actions.command("login " + rest)` | ✅ **可用**（需 `allowCommands=true`） |
| `cmd\|command <指令>` | 自由文本 | 逃生通道，原样转发为服务器指令 | ✅ **可用**（受禁用词闸门） |
| `say <文本>` | 自由文本 | `command("say " + rest)` | ✅ **可用** |
| `look <yaw> <pitch>` | 2 个数（`numbers(rest,3)` 需 ≥3 token，但只用前 2 个） | `setYRot/setXRot` | ✅ 可用（**必须多给一个占位数字**，否则被 `numbers()` 判为参数不足） |
| `lookat <x> <y> <z>` | 3 个数 | `lookAt` | ✅ **可用** |
| `moveto\|goto <x> <y> <z> [range]` | 3 个数 + 可选第 4 | `WalkTo` 连续动作 | ✅ **可用**（但**直线贪心，无寻路**，见 §3.3） |
| `dig\|mine <x> <y> <z>` | 3 个整数 | `DigBlock` 连续动作 | ✅ **可用**（要求距离 ≤4.5，否则直接 false） |
| `select <物品名>` | 物品名 | 仅在前 9 个快捷栏找 | ✅ **可用** |
| `drop [1]` | 可选 | `dropHeld` 整叠/单个 | ✅ **可用** |
| `stop` | 无 | 清连续动作 + 松键 + `stopDestroyBlock` | ✅ **可用** |
| `resync` | 无 | 手搓 `ServerboundMovePlayerPacket.PosRot` | ✅ **可用** |
| **`attack <id> [timeoutMs]`** | 1-2 个数 | — | ❌ **坏**：Node 发 2 token，mod 的 `numbers(rest, 2)` 要求 **≥3**，恒返回 usage 错误（`ControlHttpServer.java:443` + `numbers()` 的 `if (tokens.length < 3) return null`） |
| **`place x y z <face> <item>`** | — | — | ❌ **坏**：`nth(rest, 4)` / `nth(rest, 5)` 是 **0-based**，而 `face`/`item` 在 1-based 的第 4/5 位 ⇒ `face` 拿到物品名（解析失败落默认 UP），`item` 恒为空字符串 ⇒ **永不选中要放的物品**（`ControlHttpServer.java:435-436`） |
| `use\|useitem` | 无 | 吃食物靠它 | ⚠️ **未验证**（吃东西路径未实测；`/state` 未提供"正在使用"的进度） |
| `register` | — | 死分支，恒 `refused` | 🚫 **刻意禁用**（会清空角色数据） |

**合计：16 个 verb 里 9 个可用，1 个刻意禁用，2 个坏，1 个未验证。**

### 3.2 感知能力：`GET /state`

**可用字段**（`ClientStateSnapshot.java`）：`position` / `blockPosition` / `yaw` / `pitch` / `dimension` / `health` / `maxHealth` / `food` / `saturation` / `air` / `onGround` / `sprinting` / `inWater` / `inLava` / `dead` / `xpLevel` / `gamemode` / `heldItem` / `standingOn` / `feetBlock` / `time{timeOfDay,day,isDay}` / `weather` / `inventory{id:count}` / `emptySlots` / **`blocks.cells`（49×49×17 = 40817 格，含空气与 Mod 方块的真实注册表 id）** / `hostiles` / `itemDrops` / `players`

**两个关键缺口**：

| 缺口 | 证据 | 后果 |
| --- | --- | --- |
| **`hostiles` 只含 `instanceof Monster`** | `ClientStateSnapshot.java:177-179` | **牛/猪/鸡/羊/兔/鱼全部不出现在任何实体列表里** ⇒ `HuntTask` 在 clientmod 下没有任何目标，「打猎取食物」这条生存链是断的 |
| **`lightLevel` 字段不存在** | Node 侧 `clientModBody.js:205` 兜底成常量 `15` | 依赖光照的决策（插火把、洞穴安全性判断）全部失效 |

**好消息**：`entityJson()` 提供了 `id` / `type` / `name` / `kind` / `position` / `distance` / `health` / `mobType`。
⇒ **`attack` 的数据是齐的**（有 `id`），只要修掉 §3.1 的参数个数 bug，用「读 `/state` 拿 id → 发 `attack <id> <timeout>`」这个路径就能打怪。**但前提是把 `Monster` 过滤放宽成"敌对 + 被动"。**

### 3.3 最严重的限制：没有寻路

```java
// ClientActions.java:389-421 —— WalkTo.tick() 全文逻辑
double dx = target.x - player.getX();
double dz = target.z - player.getZ();          // ★ 只算水平距离
if (horizontal <= range) { arrived = true; return true; }   // ★ 到达判定忽略 Y
...
lookAtOnClient(target.x, player.getY() + 1.0, target.z);
setKeyInClient("forward", true);               // ★ 一直按住前进
setKeyInClient("sprint", horizontal > 3.0);
if (player.horizontalCollision && player.onGround()) {
    setKeyInClient("jump", true);              // ★ 撞墙就跳一格
}
```

这是一个**直线贪心 + 撞墙跳一格**的移动器。它**不绕开**：墙、水、栅栏、两格台阶、岩浆。它**没有**：A*、卡死检测、空路径检测、受困自救、下挖绕行。

**对比 Node 侧的 `Navigator`（`src/core/movement.js`）：**

| 能力 | `Navigator`（Node） | `WalkTo`（Mod） |
| --- | --- | --- |
| 算法 | mineflayer-pathfinder 的 **A\*** | 直线贪心 |
| 卡死检测 | ✅ `stuckCount` + `looksStuck` | ❌ |
| 空路径检测 | ✅ goto「成功」但没动 → 判失败 | ❌ |
| pathfinder latch 恢复 | ✅ `rearmPathfinder()` | N/A |
| 受困自救 | ✅ `recovery.js`（下挖/手动走/搭柱） | ❌ |
| 避水/避岩浆 | ✅ Movements 配置 | ❌ |
| 挖穿障碍 | ✅ `canDig` | ❌ |

⇒ **这是「为什么不能用 8899 当主通道」的核心理由。** 我可以把 8899 的 `dig` + `moveto` 串起来做出一个粗糙的采集器，但**任何需要绕路、跨水、上下地形的自然语言指令都会失败**，而这恰恰是任务二的主要场景。

**⇒ UI 指令必须走 Node 的 `Navigator`，也就必须修 §4 那个接线缺口。**

---

## 四、为什么现在「给命令也不动」

### 4.1 两个进程、两个端口，但 Node 侧是空转的

```
┌─────────────────────────────────────────┐
│ Minecraft 客户端进程（PCL 启动）           │
│  └─ mod-client (agent-client)            │
│       ControlHttpServer @ 127.0.0.1:8899 │  ← ★ 这个是活的
│       /state /command /progress /chatlog │
│       ClientActions + WalkTo + DigBlock   │
└─────────────────────────────────────────┘
                    ▲ HTTP
                    │
┌───────────────────┴─────────────────────┐
│ Node 进程（src/index.js）                 │
│  statusServer @ 127.0.0.1:8766           │  ← ★ 端口开着，但大脑没启动
│  /status /command /logs /mods /health    │
│                                          │
│  Brain.fastLoop  ✗ 从未 setInterval      │
│  Brain.slowLoop  ✗ 从未启动              │
│  ctx.bot         ✗ null（botCreated 未发）│
│  body.connect()  ✗ 从未调用              │
│  AuthMe 登录     ✗ 从未调用              │
└─────────────────────────────────────────┘
```

### 4.2 因果链（为什么端口开着却什么都不干）

```
body.kind = 'clientmod'
   ↓
index.js:253  if (kind === 'mock')  → 不成立，跳过
index.js:264  controller.on('spawn', ...)  → 注册了，但…
index.js:337  controller.connect()         → clientmod 下不产生 spawn 事件
   ↓
spawn 回调永不执行 ⇒ brain.start() 永不调用 ⇒ 两个 setInterval 从未建立
   ↓
body.connect() 从未调用 ⇒ ClientModBody.connected = false ⇒ snapshot() 返回 null
   ↓
Brain.attached = false ⇒ slowLoop() 第一行就 return
   ↓
★ 手动 POST /command {"command":"mine iron 3"} 
   → ChatController.handle → brain.push(task) → queue.push + slowLoop()
   → slowLoop 立刻 return（!attached）
   → 任务永远躺在 queue 里，不报错、不执行、不超时
```

**这就是「命令是什么以及是否能实现不清楚」的技术原因** —— 命令被**静默接受**了，返回 `{ok:true}`，但什么都不会发生。这比报错更难排查。

### 4.3 附带的静默失败

`ChatController.say()` 用 `ctx.bot.chat()`（`commands.js:95`），而 clientmod 下 `ctx.bot` 是 `null` ⇒ TypeError 被 `catch {}` 吞掉（`commands.js:96-98`）。
⇒ 即使任务能跑，**Bot 也不会说话**，UI 上看到的永远是「无回应」。

---

## 五、修订后的能力矩阵（修完接线之后）

| 指令（Node 侧 19 个） | 底层依赖 | clientmod 下能否实现 | 说明 |
| --- | --- | --- | --- |
| `status` / `where` / `inv` / `help` | `ctx.bot` facade | ✅ **可直接用**（facade 一加就好） |
| `stop` / `pause` / `resume` | 纯 Brain 状态 | ✅ **可直接用** |
| `eat` | `body.consume()` → `use` verb | ⚠️ **需验证**（`use` 未实测） |
| `mine <block> <n>` | `moveTo` + `dig` + **`findBlocks`** | ✅ **可实现**（Mod 有 `blocks.cells` 40817 格，找矿没问题） |
| `chop <n>` | 同上 + `isLog` | ✅ **可实现** |
| `goto <x> <y> <z>` | `moveTo` | ⚠️ **地形受限**（直线贪心，遇障碍失败） |
| `follow <player>` | `players[].position` + `moveTo` | ⚠️ **同上受限** |
| `home` | `memory.landmark` + `moveTo` | ⚠️ **同上受限** |
| `defend` | `hostiles` → `attack <id>` | ⚠️ **要先修 `attack` 参数 bug**，且只对敌对怪有效 |
| `hunt <n>` | 需要**被动生物**列表 | ❌ **做不到**：`hostiles` 只有 `Monster`，牛猪鸡羊看不到 |
| `craft <item>` | Body `craft()` | ❌ **`supportsCrafting = false`**（Mod 未暴露合成界面） |
| `shelter` | `placeBlock` + `digBlock` | ❌ **做不到**：4 处依赖未 Body 化（但**理论上可新增**：Mod 有 `place` verb，只是需要修 §3.1 的 `place` bug） |
| `light <n>` | 光照 + `placeBlock` | ❌ **光照字段缺失**（恒为 15）⇒ 判定「暗不暗」失效 |
| `store` | `openContainer` / `deposit` | ❌ **Mod 无容器 API**（无 `depositInto`） |
| `goal <自然语言>` | 路由到上面若干 | ⚠️ 取决于路由到的子能力 |

**统计**：19 个指令里，**4 个可直接用、4-5 个可实现但受限、5 个当前做不到**。

### 5.1 必须补的 Mod 侧能力（按性价比排序）

| 优先级 | 缺什么 | 工作量 | 解锁什么 |
| --- | --- | --- | --- |
| **P1** | 修 `attack` 参数个数（`numbers(rest, 3)` → 接受 ≥1） | **1 行** | `defend`、LLM 的「打那只僵尸」 |
| **P1** | 修 `place` 的 `nth()` off-by-one | **2 行** | `shelter`、`BuildTask`、LLM 的建造任务 |
| **P2** | `hostiles` 放开成「敌对 + 被动」，加 `passive` 数组 | ~20 行 Java | **`hunt` 整条食物链** |
| **P2** | `lightLevel` 字段（`level.getLightEmission` 或 `getMaxLocalRawBrightness`） | ~5 行 Java | `light` 指令、洞穴安全判断 |
| **P3** | 容器 API（`depositInto`） | ~60 行 Java | `store`、背包管理 |
| **P3** | 合成 API（打开合成界面或直接 `craftItem`） | ~80 行 Java | `craft` 整条工具链 |

> **注意 P1 两项加起来只要 3 行改动**，却解锁了「战斗」和「建造」两个主要能力。强烈建议在做 Node 接线时一起顺手修掉（需要重新 `npm run client:build` + 重启客户端）。

---

## 六、修订后的实现路径

### Step 1（必做，约 80 行）：让 Node Agent 真正跑起来

```
src/index.js        新增 clientmod 分支：body.connect() → AuthMe 登录 → bot facade → brain.start()
src/body/botFacade.js  (新建，约 60 行) 补 ctx.bot 的「读状态 + 说话」，故意不补写动作
```

**验收（不需要实机也能做一部分）**：
- 静态：`node --check src/index.js`，`npm run selftest` 通过
- 实机（你有条件时）：`npm run agent:client` → 日志出现 `AuthMe 登录已发送`；`curl 127.0.0.1:8766/status` 显示 `brain.running: true` 且有真实坐标

### Step 2（必做，约 80 行）：优先级与抢占

`Brain.enqueue(task, {level, source})`，三级：`URGENT`(0) 抢占一切 / `DIRECTIVE`(1) 抢占自主任务 / `AUTONOMOUS`(2) 排队。
`decide()` 产出的任务标 `AUTONOMOUS`。这是「更高优先级」的实体。

### Step 3（约 150 行）：控制面板

`statusServer.js` 加 `GET /panel`（内嵌单文件 HTML）+ `GET /ui/state` + `POST /command` 支持 `priority` 字段。
绑 `127.0.0.1`（你选的方案），零新依赖。

### Step 4（约 3 行 Java + 重新构建）：修 `attack` 与 `place`

解锁战斗与建造。**建议和 Step 1 一起做，因为都要重启客户端。**

### Step 5：把 4 个未 Body 化的任务迁移过来

`ShelterTask` / `HuntTask` / `LightTask` / `DepositTask` 从 `ctx.bot` 改到 `this.body` + `this.world`，
参考 `GatherWoodTask`。这一步做完，§5 表格里那些 ❌ 才会变成 ✅。

---

## 七、给你的一句话回答

> **「命令是什么以及是否能实现不清楚」的根源不是命令不清楚，而是 Node 侧那 19 个指令现在全部被静默吞掉了。**
>
> 修 `src/index.js` 里那段缺失的 clientmod 分支（约 80 行），19 个指令立刻有 4 个可用、5 个受限可用；
> 再顺手修 Java 侧 3 行（`attack` + `place` 的参数解析），战斗和建造也能上线。
>
> **`bot.authme` 的密码已经在配置里躺着了，只差一个调用点。**
