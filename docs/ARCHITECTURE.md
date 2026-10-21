# 架构说明：核心模块与数据流（2026-10-07 版）

> 本文是对 `<repo>` 的**代码级架构分析**，回答三个问题：
> **它是怎么分层的？每个模块负责什么？一个决策从产生到生效，数据在哪些模块之间流动？**
>
> 结论先行的版本见 [`../README.md`](../README.md)；重写计划的逐批进展与验证记录见
> [`REWRITE-PLAN.md`](REWRITE-PLAN.md)。
>
> **与 2026-09-30 旧版的最大区别**：主线躯体已经从 mineflayer 换成「真实 Forge 客户端 + 控制 Mod」，
> 决策层新增了**技能目录 / 任务槽 / 失败阶梯 / 权限闸门 / LLM 工具层**；旧版里那份「clientmod 接线缺口」
> 清单大部分已修复或被新结构取代（残留项统一收进 §九）。
>
> **§九 例外**：技术债表已在 **2026-10-14 按代码逐条复核**（见 §九 开头的复核说明），其余章节仍为 2026-10-07 版；
> **§十 的套件计数已刷新到 2026-10-14 实测值**（与 [`../README.md`](../README.md) §8 同源）。

---

## 一、一句话定位

一个**本机运行**的《我的世界》生存 Agent：Node.js 进程承载「大脑」，通过 **Body 抽象**驱动物游戏动作。

* **手**：`mod-client/`（Forge 1.20.1 客户端 Mod）只提供「人的手能做到的最小原子动作」——移动、挖掘、
  放置、右键、菜单点击、攻击、切手持、丢弃、连续隧道动作 `tunnel`。它不懂策略。
* **脑**：Node 侧负责一切决策——快反射（保命）、慢规划（自主生存）、**确定性技能目录**（玩家/LLM 指令）、
  **任务槽**（长任务受理即回执）、**失败阶梯**（每级只接自己声明接得住的失败）、**权限闸门**（动手前
  deny/allow/ask）。
* **嘴**：`!` 前缀是指令快路径；`@大肥鱼 <自然语言>` 走 LLM。**LLM 不是决策核心，只是路由与表达层**：
  它只能从技能目录里挑动作，执行全部是确定性代码，且没有任何「发服务器指令」「主动行动」的能力。

躯体可替换：`clientmod`（主线，能进带客户端 Mod 的 Forge 服）、`mineflayer`（原版/Paper/纯服务端 Fabric
的备选）、`mock`（脚本世界，离线测试）。默认 `config/agent.json → body.kind = "clientmod"`。

---

## 二、分层架构

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ L0  外部世界                                                                │
│   Forge/NeoForge 服务器（客户端必需 Mod）  原版/Paper/Fabric 服务器  PCL2 客户端 │
└──────────────┬──────────────────────────────────────┬───────────────────────┘
               │ 真实游戏会话（含 150+ 客户端 Mod）      │ 原版协议（备选）
┌──────────────▼──────────────────┐    ┌──────────────▼───────────────────────┐
│ mod-client/（Forge 客户端 Mod）  │    │ src/body/mineflayerBody.js           │
│  ControlHttpServer :8899         │    │  （包装 BotController/Navigator）     │
│  ClientActions（动作状态机）      │    └──────────────────────────────────────┘
└──────────────┬──────────────────┘
               │ HTTP 127.0.0.1:8899（GET /state /progress /chatlog，POST /command）
┌──────────────▼──────────────────────────────────────────────────────────────┐
│ L1  躯体层 src/body/                                                        │
│   Body 契约（感知/动作/连续动作/可选能力）  +  clientmod / mineflayer / mock   │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │ Body 契约（决策层不出现 mineflayer / Minecraft 类名）
┌──────────────▼──────────────────────────────────────────────────────────────┐
│ L2  决策层                                                                  │
│   src/brain.js    快反射(600ms) + 慢规划(idleThinkIntervalMs) + 停牌表        │
│   src/skills/*    18 个确定性技能 + miningPlan（报价/几何/台账）              │
│   src/llm/*       意图路由 + 8 个工具 + persona（config/persona.md）+ 语料     │
│   src/chat/*      `!` 指令表 / 对话触发 / 回复策略 / 主动发言                 │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────────────┐
│ L3  支撑设施                                                                │
│   src/core/   taskHub / recoveryLadder / failure / holds / permissions(+Gate)│
│               places / memory / lockfile / authme / deathWatch / preflight   │
│               network / recovery / plugins / bot.js（mineflayer 遗产）       │
│   src/world/  知识表 / 安全 / 工具策略 / 感知网格 / Body 世界适配             │
│   src/web/    零依赖面板与状态 API（:8766）                                  │
└──────────────┬──────────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────────────┐
│ L4  运行环境编排                                                            │
│   start.ps1 / stop.ps1        客户端 + Agent 一键启停（主线）                │
│   scripts/                    launch-forge-client / install / selftest …    │
│   src/pcl/                    PCL2 探测与启动                                │
│   src/server/                 本地无头服务器（原版/Forge，旧路径）            │
│   mod-bridge/                 可选的 Fabric 服务端桥（未接线，见 §九）        │
└─────────────────────────────────────────────────────────────────────────────┘
```

**关键设计约束**：

1. **技能层只依赖 Body 契约 + 技能自己的参数 Schema**。`src/skills/*` 不允许出现 mineflayer 类名；
   换躯体不改技能。
2. **LLM 的能力边界 = 工具注册表**。没有 `say` 工具，没有发指令的工具；模型唯一能造成的副作用是
   `do_task` / `do_skill` / `go_to` / `stop`，参数逐个过 Schema 校验。
3. **权限闸门装在 Body 的三个入口**（`dig` / `place` / `useOn`），启动时一次安装——任何技能、任务、
   LLM 路径都绕不过它（`src/core/permissionGate.js`）。

---

## 三、核心模块详解

### 3.1 装配与生命周期：`src/index.js`

启动顺序（`clientmod` 主线）：

```
parseArgs() → loadConfig({profile})
   ↓  preflight()      仅 body.kind === 'mineflayer' 时做（mock/clientmod 没有可探测的连接）
   ↓  acquireLock()    runtime/agent.lock（单实例，防 duplicate_login）
构造 ctx：
   BotController / WorldView / Navigator / Memory / AutoEat / Combat / ToolManager / ModKnowledge
   （这些是 mineflayer 时代的服务，clientmod 下多数退化为空转，见 §九）
   ↓
createBody(cfg, deps)         clientmod / mineflayer / mock；不可用则退出码 4，不假装连上
   ↓ 非 mineflayer → ctx.world = BodyWorldView(body)
   ↓ ctx.craft/mine/chop/hunt/shelter = 旧任务层的便捷入口
new Brain(ctx) → new ChatController(ctx) → ctx.reply（唯一发言出口）
   ↓ 第二批结构
Places / Permissions / ConsentDesk / TaskHub / installPermissionGate(body)
   ↓ 双通道
ChatListener(! + 对话触发轮询)  /  LlmCore（persona、工具、trace）
   ↓ 安全与角色
DeathWatch（死亡即停 + 三处告警）/ SpeechScheduler（3 个主动发言触发器）/ AuthMeLogin
   ↓ 面板（所有 body 都有）
startStatusServer(:8766)
   ↓ 分支
mock      → body.connect() + brain.start()
clientmod → body.connect(waitMs) → chatListener.start() → deathWatch.start()
            → authme.ensure('startup') → brain.start() → （--goal 时）applyGoal()
mineflayer→ controller.connect()，在 'spawn' 事件里 rearm/scan/rescue/tools，再 brain.start()
```

值得单独记的两点：

* **AuthMe 登录发生在 brain.start() 之前**：未认证的 bot 在 AuthMe 服上能看见世界但一切动作被服务端忽略，
  若不先登录，所有失败都会伪装成寻路 bug。登录只 `/login`，**永不 `/register`**（会重置角色数据）。
* **`ctx.reply` 是唯一发言出口**：指令回执、LLM 回复、任务完工汇报、权限征询全部走它，
  回声过滤 / 防抖（`minReplyGapMs`）/ 长度截断只实现一次。

### 3.2 决策与调度

> **规划器专项**：本节描述的自主规划器（`slowLoop` → `decide()` → `runTask`）是**下一阶段重构对象**。
> 它的已核实问题清单（P1–P10）、重构债（Q1–Q7），以及它与 **`!` 命令回路**、**LLM `do_task`/`do_skill` 回路**
> 的边界，统一记在 [`PLANNER-REFACTOR.md`](PLANNER-REFACTOR.md)；本节与 §九只保留结论摘要。
> **边界要点**：B1/B2 的**记账**在 `runTask`，故为"规划器任务 + 命令表任务"共用（`!` 材料类、LLM `do_task`
> 材料类同样会写）；`quarantine` 的**拦截**只在 `decide()/pickRule()`，只影响自主选目标；TaskHub 派发的
> 作业（矿石、长技能）两者都不适用。改退避机制前必须先看这条边界。

#### `src/brain.js` —— 快反射 + 慢规划 + 停牌表

* **快循环（600ms，纯反射）**：安全模式、卡死救援、危险撤退、自动吃、自卫、自动穿甲。
  反射优先于规划（`preempt()` 取消当前任务）。注意：AutoEat / Combat / ToolManager 仍是
  controller(mineflayer) 绑定的服务，clientmod 下这些调用是**安全空转**（见 §九技术债）。
* **慢循环（`behaviour.idleThinkIntervalMs`）**：串行闸门 `activeTask` → 队列 → `decide()` 规则表
  （代码里约 20+ 条 `when`，按生存进度 wood → table → tools → stone → coal → food → shelter → storage
  命中第一条胜出）→ 生成**旧任务层**的任务（`src/tasks/`）。规则级故障隔离（单条规则抛错只跳过它）。
* **防死循环三件套**：串行闸门 `activeTask`；重试 + 隔离（quarantine，`min(120s, 20s × strikes)`）；
  零进展检测（任务"成功"但 `progress()` 不动 → 停 30s）。另 `noteDeath()`：4 分钟内死 2 次 → SAFE MODE。
* **停牌表 `src/core/holds.js`**：`dead` / `paused` / `owner-stop` / `task` 四个原因，逐个声明
  它挡什么（反射/规划/显式任务）和谁能清除（`!resume` / 后台任务结束 / `!stop`）。
  `Brain` 里 `paused`/`stopped`/`autoPlanDisabled` 只是这张表的访问器。
* **事件**：任务完成/失败通过 `task:done` / `task:failed` 广播——LLM 的跟进回合、面板、主动汇报都订阅它。

#### `src/core/taskHub.js` —— 后台任务槽（受理即回执）

一个身体一个后台槽。长技能（`mine_ore` / `fish` / `farm` / 走路 / 睡觉 / 容器 / 合成 / 熔炼 / 战斗）
通过 `do_skill` 校验与可用性门后提交：调用方立刻拿到 `{accepted, taskId}`，完成/失败以事件回来。
新任务顶掉正在跑的（被顶者结算为 `interrupted: replaced`，不算成功）；占槽期间 brain 进入 `task` hold，
自动规划停止、新显式任务被拒绝并说明原因；`!stop` / 死亡 / 面板急停都会取消槽内任务。
命令：`!task status` / `!task stop`；`/ui/state` 带 `hub`。

#### `src/core/recoveryLadder.js` —— 失败阶梯

每一级声明它能接住的 `failure` 类型与重试上限；没人接的失败原样上抛，绝不跨级乱试。落地：

* **mining**：`tunnel`（客户端走挖一体）→ `clear-retry`（客户端报出卡住的格子 → 挖掉 → 重跑）→
  `direct`（Node 斜井，供没有 `tunnel` 的 body 兜底）→ `flank`（从另一侧绕）。
* **fishing**：`open-water` → `next-bank`（最多两次）。
* **farm**：`direct` → `fresh-scan-wide`（强制刷新 + 放宽到达范围重试同一株）。

#### `src/core/failure.js` —— 统一失败词汇

所有技能/任务回执带 `{ok, reason, failure, hint?, detail?}`；`failure` 是固定枚举（`no_path` /
`occluded` / `hazard` / `refused` / `target_lost` / `out_of_reach` / `timeout` / `bad_argument` /
`internal` 等），阶梯与面板只认这一套，杜绝"字符串天气"。

### 3.3 技能层：`src/skills/`

技能 = **确定性操作 + 声明式 Schema**，注册在 `registry.js`，`require('../skills')` 暴露
`{register, get, all, names, run, describe, validate}`。一个技能声明：

```js
{
  name, title, description,
  params: { … JSON Schema 风格的声明 … },   // 默认值 / 范围 / 类型
  available: (ctx) => ({ok, reason}),        // 这个躯体能不能做
  run: async (ctx, params) => ({ok, reason, failure?, detail?, …})
}
```

当前 20 个技能：

| 分类 | 技能 |
| --- | --- |
| 物品 | `equip` `eat` `drop` `armor` |
| 方块与交互 | `place` `use_on` `withdraw` `deposit` |
| 战斗 | `attack` `defend` |
| 移动 | `explore` `come` |
| 生产 | `craft` `smelt` `farm` `sleep` |
| 采集 | `mine_ore`（报价选矿 + tunnel + 台账） `collect`（15×15×15 新鲜扫描 + A* 走位） `fish` |

两个入口共用同一张表：

* `!` 指令（`src/chat/commands.js`）——新操作（eat/equip/armor/place/use/attack/explore/withdraw/
  deposit/come/craft/smelt/farm/sleep…）走 `runSkill()`；老操作（mine/chop/hunt/shelter/light/store/goto）
  仍指旧任务层；`fish` 走 `FishTask` 适配器（任务层包装 `fish` 技能，供 `mc_plan`/`mc_propose`
  的 `fish` 步骤与 `!fish` 共用）；
* LLM 的 `do_skill` / `do_task` 工具（`src/llm/tools/actuators.js`）。

**`src/skills/miningPlan.js`（numen 式采矿的核心）**：

* `quoteApproach()` 给每个候选矿报价：`挖格数 × 4 + 步数 − (矿脉格数 − 1) × 2`，
  模拟的正是执行器要走的斜向台阶（`stepVector`/`stepCells` 与执行共用同一几何）；
* 受理前物理准入：落沙/砾石正上方、水平邻格是水、水/岩浆在计划格 → 拒绝该目标（`rejectedTargets`）；
* `DigLedger`：目标选中即生成承诺清单（planned），执行中每挖一格记账，计划外记 `extra` 并留坐标，
  超 `maxExtraDigs` 即停（"计划即承诺，执行交实际账"）；
* `mine_ore` 的阶梯见 §3.2；`tunnel` 的客户端实现见 §3.4。

### 3.4 躯体层：`src/body/`

#### 契约（`body.js`）五条原则

| 约定 | 原因 |
| --- | --- |
| 每个方法 `async` 且**必须 settle** | 躯体自己负责超时，绝不能把大脑挂死 |
| 不支持的能力抛 `BodyUnavailableError` | 决策层据此降级而不是崩溃 |
| `snapshot()` **不阻塞**，返回最近缓存 | 真客户端只能在 tick 里更新状态 |
| 接口里**不出现 mineflayer / Minecraft 类名** | 否则抽象层白做 |
| `interrupt()` 同步且可重复调用 | 反射层要能随时打断 |

感知：`snapshot()`（位置/维度/血量/饥饿/时间/背包/手持/脚下/光照/敌对/掉落物/玩家）、
`blockAt` / `findBlocks` / `findBlocksMatching` / `hostiles` / `itemDrops`。
动作：`connect` / `moveTo` / `dig` / `place` / `useOn` / `equip` / `consume` / `attack` / `chat` /
`look` / `lookAt` / `drop` / `interrupt`；可选：`craft` / `menu`+`clickSlot` / `tunnel` 等。

#### ClientModBody（主线）

* 通过 HTTP `127.0.0.1:8899` 驱动真实 Forge 客户端；`snapshot()` 带 400ms TTL 缓存。
* `moveTo`/`dig`/`tunnel` 是**连续动作**：`POST /command` 之后轮询 `/progress` 直到 `busy === false`；
  超时会主动发 `stop`。
* **最终 verdict 保留到下一个动作开始**（done/failed/reason/cell/block/dugCells）——这条修复之前，
  晚到的轮询看到 `{busy:false}` 会把"没走到"当成功，是 A* 跳跃/横移判定失效的根因。
* 走路由 `src/pathfinding/clientWorldAdapter.js + navigator` 做 Node 侧 A*，再换算成 mod 的
  `moveto` 航点；`tunnel` 则整段交给客户端控制器（见下）。
* **跨网格目标 = 子目标接力（2026-10-14，10-15 修陡坎乱走 + 游泳过湖）**：感知只有 ±24 水平 / +8−8
  垂直，网格外是"未知"而非空气。`out-of-grid` 时导航器不再朝目标盲走，而是 `planner.pickSubgoal()`
  取"直线方向上距目标最近、≤23 格、可落脚"的格子（**干格优先**：脚位+头位可通过，甘蔗等非碰撞方块
  放行；整条射线全是水时退回**可踩水的水面格**作过渡航点——游泳已实现、客户端行为正确，拒绝水格只会
  把 bot 困在岸上：10-15 真机 27 格宽的湖曾让行程 19ms 判死），A\* 规划过去 → 走到 → 重规划；
  规划不通则用 `planner.subgoalCandidates()` 在其 ±5 格内按"先就近、再靠 bot"的顺序重试（上限 8 次 /
  6s，候选须比 `range+2` 更远，避免"已经到达"式的假跳）；全部失败即诚实 `out-of-grid`/`stalled` 且
  **一步不迈**。落在容差内的主子目标改用**严格容差再走一次**（向前迈步是进展，但绝不因此去问横向邻居）。
  落脚高度在**整列** −8..+8 内按"离直线高度最近"排序选取（`subgoalHeights`）——只在直线那一层找，
  会在陡坎/河谷处把子目标滑回 bot 脚下，退化成 1 格一跳的横向抖动（10-15 真机"随机游走"）。
  运动模型另加 `canSwimAt`：**踩水横渡不要求下方有地板**（深海原本不可通行：湖底 6 格深 → 既走不进也
  跳不进 → noPath），岩浆与"其下有岩浆"仍一律拒绝。`planner.toward()` 已删除。水域移动代价
  `COST.SWIM = 2.0`（= 2× 平地，操作员口径）：桥顺路时 A\* 会走桥，但窄河仍可能直接游过去——那是代价
  口径的既定结果，不是缺陷。**台阶/半砖（含含水 waterlogged）一律算陆地**：`PARTIAL_BUT_WALKABLE`
  让它们 `solid + standable + 永不算液体`，向上走按完整方块处理；块名先剥掉 `[...]` 状态再分类
  （否则 `oak_fence[waterlogged=true]` 会被误判成可站）。真要踩水时，导航器先在 ±5 格内找**能走过去的
  干格**（桥面即干格），找不到才游泳。**脚位格按"实际站着的方块"修正**（`PathPlanner.feetCell()`）：
  站在农田（15/16）、土径、下置半砖（顶面 y+0.5）或台阶上时，`floor(y)` 返回的是**脚下那块方块**，
  于是 A\* 从"实心方块内部"出发、没有任何合法邻居 → 子目标滑回自身 → `already within range` → 9ms
  判 stalled（真机 (75,63,65)）。`_plan` 起点、子目标基准高度、`hopTo` 原地判定与 `sidestep` 起点
  全部改用它，子目标另加"不能是自己所在那一格"（`Math.round` 会把 x=75.8 的一步舍回 75）。
  回归：`npm run path:test` 第 11 组（11a–11l）+ 3b。

#### Mod 侧 `mod-client/`

* `ControlHttpServer`（JDK HttpServer，`127.0.0.1:8899`，2 线程）只做 I/O；世界读写全部
  `mc.execute` 投到**客户端线程**；`TickEvent.ClientTickEvent`(END, 20Hz) 推进 `Continuous` 状态机。
* 动作 verb：`chat` / `login` / `register`(死分支，恒拒) / `cmd|command` / `say` / `look` / `lookat` /
  `moveto|goto` / `dig|mine` / **`tunnel`** / `place` / `useon` / `menu` / `click` / `close` /
  `use` / `select` / `drop` / `attack` / `stop` / `resync` / `target`。
* `tunnel` 控制器：朝 waypoint **方块中心**转向、按住前进；逐 tick 用碰撞箱判断——脚/头都空 → 走，
  真 1 格台阶 → 落地且贴住才按一次跳，其余 → 对准挡路格按住攻击直到挖穿；**下坡永不按跳**；
  严格到达（脚格含 y）；结构化失败 `jump-blocked / stuck / timeout / unbreakable / hazard / falling / ledge`。
* **防坠落**：走路分支向下探 1–3 格——2 格内见地板 = 正常下台阶；3 格空气或先见液体 → `ledge` 停住。
  Node 侧另有 waypoint 预检（悬空 >2 格 / 岩浆 / 怪物）与 tunnel 跑完的洞窟复查（openness ≥ 45% 停）。
* **`/register` 四道闸门**：HTTP dispatch 前（含递归剥离 `cmd` 前缀）、动作到达网络前、Node 侧
  `isForbidden`、CLI；实测封堵 `register`、`/register`、`cmd register`、`cmd /register`、
  `command reg`、`cmd cmd /register` 六条路径。

#### MockBody / MineflayerBody

* `MockBody`：脚本世界 + 动作历史 + 计数器，毫秒级验证决策逻辑（技能测试、任务测试都靠它）。
* `MineflayerBody`：包装旧 `BotController`/`Navigator`，保留 pathfinder latch 复原、物理脱困等行为；
  只适用于原版/Paper/纯服务端 Fabric。

### 3.5 核心服务：`src/core/`

| 模块 | 职责与要点 |
| --- | --- |
| `taskHub.js` | 后台任务槽（§3.2） |
| `recoveryLadder.js` | 失败阶梯（§3.2） |
| `failure.js` | 统一失败词汇（§3.2） |
| `holds.js` | 停牌表：dead / paused / owner-stop / task |
| `permissions.js` + `permissionGate.js` | `deny`/`allow`/`ask` 规则 + 动手前征询（ConsentDesk）；闸门装在 body 的 `dig`/`place`/`useOn` |
| `places.js` | 命名 area / route，持久化到 `runtime/places.json`；`route plan` 只算不走 |
| `memory.js` | 跨会话记忆：会话/死亡/任务历史/统计/地标，`runtime/agent-state.json` |
| `lockfile.js` | 单实例锁 `runtime/agent.lock`（防同名 duplicate_login 踢人循环） |
| `authme.js` | AuthMe 自动登录：只在有证据需要时发 `login <pw>`，永不 `register` |
| `deathWatch.js` | 死亡检测 → 停一切（hold `dead`）+ 三处告警（控制台/面板/状态文件），不自动恢复 |
| `preflight.js` | 手写 Server List Ping（mineflayer 路径）：可达性/协议/加载器嗅探，不占登录名额 |
| `network.js` | 代理解析（socks5/http CONNECT 自实现）+ 微软设备码登录（token 缓存） |
| `recovery.js` | 卡死判定 + 四级物理脱困 + SAFE MODE 的 hideUnderground |
| `plugins.js` | 5 个可选 mineflayer 插件（缺包降级不崩） |
| `bot.js` / `movement.js` | mineflayer 时代的 BotController / Navigator（备选躯体使用） |

### 3.6 聊天与语音：`src/chat/`

* **`chatListener.js`**：对 clientmod 是轮询 `GET /chatlog`（700ms），对 mineflayer 是 `bot.on('chat')`。
  职责：去重（含自己发的回声）、只认 `!` 前缀的第一遍、`@大肥鱼` 触发的第二遍、把每一行交给
  `authme.observe()`。两条通道互为独立状态机——一条坏了不影响另一条。
* **`commands.js`**：`!` 指令表（help/status/mine/chop/…/farm/craft/smelt/sleep/`!task`/`!area`/
  `!route`/`!rule`/`!yes`/`!no`/stop/pause/resume…）。新指令走 `runSkill()`，老指令仍指旧任务层；
  `fish` 没有 `!` 指令，走 LLM 或兜底路由（`@大肥鱼 去钓鱼`）。
  老任务指令进 brain 队列（串行闸门），LLM 的长技能进 TaskHub（受理即回执）。
* **`reply.js`**：唯一发言出口的防抖与截断（`minReplyGapMs` 抑制连发；玩家在等的回答可 `force`；
  单句长度按 persona 的 `maxChars`）。
* **`speechScheduler.js`**：主动发言的**状态**触发器（1Hz）：`hungry`（食物 ≤6 且无食物，冷却 60s）、
  `lowHealth`（血 ≤6，冷却 45s）、`respawn`（事件钩子）。**完工汇报**走 LLM 的 `announceFinished`
  （只对玩家发起的任务播报）。所有主动发言经 `LlmCore.speakUp`，**丢弃模型提出的任何 action**——
  "自己给自己派活"在结构上不可能。
* **一件事只播一次**（2026-10-15）：`announceFinished` 按 `任务名|描述|成功与否` 记一次时间戳，在触发器
  声明的 `proactive.triggers.taskDone.cooldownMs`（默认 30s）内**重复的同一件事不再播**；不同的完工
  （哪怕 1 秒后）照常播，成功后再失败也照常播。真机故障：玩家两次说同一句"到(31,63,59)"，两趟任务各自
  完工 → 先模型措辞、632ms 后模板兜底（因为 `another turn is already running`）重复播报；根因是那个
  `cooldownMs` 此前只被 speechScheduler 的**状态**触发器消费，`speakUp` 根本没读它。模板文案同时去掉
  寻路的 `(moved N blocks in M ms)` 遥测，理由重复时不再复述。回归：`llm:dry` 四条断言。

### 3.7 LLM 层：`src/llm/`

一轮对话的流水线：

```
@大肥鱼 <文本>  → ChatListener 第二遍 → LlmCore.handle(text)
    ↓ 组装系统提示词（blackboard.systemPrompt）
      ① config/persona.md 正文（原样放最前） ② 输出 JSON 契约 + 能力边界
      ③ 实时状态摘要 ④ 最近 6 条对话 ⑤ 工具清单（toolCalling 开启时）
    ↓ 一次 HTTP 回合（LlmClient，OpenAI-compatible；超时/无 key → 兜底正则路由）
       ┌ 无工具：模型返回意图 JSON
       └ 有工具：模型可先调只读工具（observe/find_blocks/lookup_item/scan_around）再回答
    ↓ parseIntent() 严格校验（action.type ∈ task/go_to/skill/stop；skill 参数过技能 Schema）
    ↓ 落到与 `!` 完全相同的命令表执行（不存在第二份实现）
    ↓ say → ctx.reply；长技能进 TaskHub，完成事件触发第二回合（最多两回合/请求）
```

护栏（每条都对应一次真实失败）：

1. **枚举即能力边界**：模型只能命名表里的技能；`/op` 这类消息无路可走。
2. **每请求最多两轮**：第一轮决定，任务完成事件唤醒第二轮汇报；没有原始请求的唤醒不能行动。
3. **日 token 预算 + 同时 1 回合**；超限关 LLM，回退正则路由。
4. **全量 trace**：`runtime/llm-trace.jsonl`（提示词摘要、路由、tokens、护栏动作）。

`persona.js` 是**角色卡加载器**：读 `config/persona.md`（frontmatter 机器字段 + 正文 + 示例对话），
按 (path, mtime, size) 缓存热更新，解析顺序为 `llm.persona.file` > `PERSONA_FILE` > `config/persona.md`；
触发词解析顺序为 `agent.chat.dialogueTrigger` > persona frontmatter > 旧默认（配置优先并会对不一致告警）。

### 3.8 世界模型：`src/world/`

| 模块 | 说明 |
| --- | --- |
| `items.js` | 生存知识表：食物优先级/生食/燃料/原木/工具等级/需镐方块/可穿行；`isLog` 带正则兜底 |
| `toolPolicy.js` | 工具策略唯一来源：镐的等级门槛只作用于需镐方块，锹/斧/剪刀只是偏好 |
| `safety.js` | 树木/人造方块等安全判据（26 连通原木簇 + 底座/树冠规则） |
| `spatialGrid.js` | 感知网格（`scan_around` 工具的数据源）：把扫描变成俯视字符图，标出水/坡/建筑/树/悬崖 |
| `bodyWorldView.js` | Body 后端世界视图：`blockAt`/`findBlocksMatching`/`canMine`，命名空间两侧归一 |
| `snapshotInventory.js` | 把 `{name:count}` 快照伪装成 mineflayer inventory 接口，让旧知识表原样工作 |
| `worldView.js` | mineflayer 专用只读视图（备选躯体） |

### 3.9 面板与 API：`src/web/`

零依赖 `http.createServer`，只绑 `127.0.0.1`（默认 8766，被占自动退到 +1）：

| 路由 | 作用 |
| --- | --- |
| `GET /panel`（+ `/panel/cmd`、`/panel/state`） | 单页控制面板：实时状态、当前任务与队列、最近输入→路由、停牌原因、死亡红条 |
| `GET /ui/state` | 面板用的精简状态（含 holds/hub/permissions/death/llm） |
| `POST /command` `{command, priority}` | 与聊天同一张指令表；`priority` 支持 urgent 抢占 |
| `POST /emergency-stop` | 四级降级急停，逐级汇报实际结果 |
| `GET /llm` | provider/model/tokens/最近回合 |
| `GET /health` `/status` `/inventory` `/logs` `/mods` | 状态查询 |

### 3.10 运行环境层

* **`scripts/launch-forge-client.js`**：直接解析 PCL 留下的版本 JSON（libraries + 参数模板），
  用 Java 17–21 无头拉起真实客户端；支持 `--server`（直连服务器）、`--singleplayer`、`--username`、
  `--memory`、`--wait-for-menu`。`start.ps1` 在此之上编排「客户端 → 等 8899 → 等进世界 → 起 Agent」。
* **`src/pcl/`**：探测 PCL2 路径、`.minecraft`、Java 注册表、`LatestLaunch.bat` 真实命令行。
* **`src/server/`**：本地原版/Forge 专用服务器的下载、安装、启动与优雅停止（旧路径）。
* **`mod-bridge/`**：Fabric 服务端桥（服务器权威状态 + `!!agent` 聊天转发）。代码完整，但当前
  checkout 未安装、未接入 Agent 决策回路，且服务器实为 Forge ⇒ 只能算可选增强（见 §九）。

### 3.11 旧任务层与生存服务（兼容保留）

* `src/tasks/`：早期任务层（chopWood / craft / mineBlock / shelter / hunt / light / deposit /
  harvest / goto 等），供**自主慢规划**与部分老 `!` 指令使用。
  基于 `harvest.js` 的任务已经 Body 化（走 `body.moveTo`/`dig`），clientmod 下可工作；
  `hunt` / `shelter` / `deposit` 仍直接使用 `ctx.bot`（mineflayer 绑定，见 §九）。
* `src/survival/`：AutoEat / Combat / ToolManager——mineflayer 服务，供快反射与 MineflayerBody 使用。
* 这两层**不会再接收新功能**：新操作一律写进 `src/skills/`。

---

## 四、端到端数据流

### 4.1 指令 → 执行主链路（最核心的一张图）

```
玩家聊天 / 面板 POST /command / LLM 意图
        │
        ├─ `!` 前缀 ──────► ChatController（确定性指令表）
        │                     ├─ 新操作 → skills.run()
        │                     └─ 老操作 → 旧任务层 / brain.enqueue()
        │
        └─ @大肥鱼 ────────► LlmCore.handle()
                              模型 or 兜底路由 → 校验后的意图 → 同一张指令表
                              └─ 长技能（mine_ore/fish/…）→ TaskHub.accept()（受理即回执）
        │
        ▼
   TaskHub（后台槽；受理即回执） 或 Brain 队列（legacy 任务）
        │
        ▼
   skills.run() ──► RecoveryLadder（失败分级重试）
        │
        ▼
   Body 契约（body.moveTo/dig/place/useOn/tunnel/…）
        │                                   ▲
        │ permissionGate（dig/place/useOn）  │ 每次动手前过 deny/allow/ask
        ▼
   ClientModBody（HTTP）→ mod-client → 客户端 tick 执行 → 真实游戏
        │
        └─ /progress 轮询 → 结构化 verdict（含 cell/block/dugCells）
             ↓
   结果账本：DigLedger / 失败词汇 / 事件（task:done|failed）→ 面板 + LLM 跟进 + Memory
```

### 4.2 感知数据流

```
Forge 客户端（ClientStateSnapshot，客户端线程构建）
   /state: position/health/food/time/inventory/blocks.cells(49×49×17≈40817 格，含 Mod 方块真名)
        │ HTTP 8899
        ▼
ClientModBody.snapshot()（400ms TTL 缓存）
        ▼
BodyWorldView（namespace 归一 + matchNames）
        ▼
技能 / 任务 / LLM 黑板（blackboard 的实时状态摘要）
```

mineflayer 备选路径同形，只是数据源换成 mineflayer 的 registry（Mod 内容需靠签名推断兜底）。
两套路径的命名空间归一都发生在 `BodyWorldView` / `SnapshotInventory`，这是"知识表不用改"的关键。

### 4.3 LLM 对话与工具轮

```
chatlog 轮询 ──(触发词)──► LlmCore.handle
    ├─ system prompt（persona 正文 + JSON 契约 + 实时状态 + 历史 + 工具清单）
    ├─ HTTP 回合（OpenAI-compatible；超时 8s 级）
    │     └─ toolCalling=true：模型可调 observe/find_blocks/lookup_item/scan_around（只读）
    ├─ parseIntent 校验 → 执行（与 `!` 同一张表）
    └─ say → ctx.reply（防抖/截断）

任务完成事件 ──► announceFinished（只播报玩家发起的任务）
饥饿/低血/复活 ─► SpeechScheduler / onRespawn → speakUp（丢弃 action）
无 key/超时/非法 JSON ─► fallbackRouter（中英正则）→ 同一张指令表
全过程 ──► runtime/llm-trace.jsonl
```

### 4.4 反馈与持久化

```
技能/任务结果 ──► failure 词汇 + hint ──► 事件（task:done/failed）
DigLedger    ──► 计划 vs 实际账（planned/dug/extra）──► 面板 / 回执
权限征询      ──► 游戏内发问 ──► !yes/!no ──► 决策
死亡          ──► hold `dead` + 三处告警
Memory        ──► runtime/agent-state.json（会话/死亡/任务史/地标/统计）
Places        ──► runtime/places.json；LLM 轨迹 ──► runtime/llm-trace.jsonl
```

---

## 五、并发流

| 流 | 频率 | 职责 | 互斥/协调 |
| --- | --- | --- | --- |
| A 快反射 | 600ms | 保命（吃/自卫/脱困/SAFE MODE） | `preempt()` 可取消任何任务；受 holds 约束 |
| B 慢规划 | `idleThinkIntervalMs` | `decide()` → 旧任务层 | 串行闸门 `activeTask`；任务槽占用时 hold `task` |
| C 后台任务槽 | 事件驱动 | 长技能（mine_ore/fish/farm/…） | 一身体一槽；新顶旧；`!stop`/死亡取消 |
| D 聊天/Dialogue 轮询 | 700ms | `!` 与 `@大肥鱼` 两条独立通道 | 去重 + 回声过滤；LLM 同时只 1 回合 |
| E 主动发言 | 1Hz | hungry / lowHealth / respawn | 触发器各自冷却；`speakUp` 丢弃 action |
| F 状态落盘/面板 | 5s 级 | Memory + /ui/state | 只读快照，无锁 |

任何"手"的操作最终都串行经过同一个 Body 与权限闸门——这是"一个身体"假设的兑现方式。

---

## 六、三个 Body 的对比矩阵

| 维度 | ClientModBody（主线） | MineflayerBody（备选） | MockBody（测试） |
| --- | --- | --- | --- |
| 传输 | 真实 Forge 客户端 + HTTP 8899 | 原版协议（minecraft-protocol） | 进程内 Map |
| 能进客户端 Mod 服 | ✅ | ❌（FML2 无实现） | — |
| 感知 | `/state`：40817 格真实注册表 + Mod 方块真名 | registry 仅原版，Mod 靠签名推断 | 脚本方块表 |
| 移动 | Node A* + mod WalkTo | mineflayer-pathfinder | 瞬移到点 |
| 采矿 | 技能 `mine_ore`（报价 + tunnel + 台账） | 技能/旧任务均可 | 同技能（模拟） |
| 连续动作 | ✅（moveTo/dig/tunnel，轮询 verdict） | pathfinder 原生 | 即时 |
| 菜单/容器 | ✅（menu/click） | 部分（旧任务直连 bot） | ✅（菜单桩） |
| 反射层（AutoEat/Combat/ToolManager） | ⚠️ 空转（mineflayer 绑定，见 §九） | ✅ | 不适用 |
| 主要用途 | 联机主线（mc.example.com） | 原版/Paper/本地快速测试 | 离线测试全部技能 |

---

## 七、启动方式决策树

```
要进带客户端 Mod 的 Forge 服（如 mc.example.com）？
  └─ 是 → start.ps1（客户端 + Agent 一键；含 AuthMe 登录）
           分步：npm run client:launch → npm run client:check → npm run agent:client

只做离线测试 / 开发？
  └─ npm run skills:test / selftest / p0:verify；或 --body mock

原版 / Paper / 纯服务端 Fabric + 想省资源？
  └─ body.kind=mineflayer（npm run server:setup + 本地服务器；或直接连目标服务器）

要在本机起验证服务器？
  └─ npm run server:setup → node scripts/run-all.js --no-agent → 客户端指向 127.0.0.1:25565
     （旧的一键 npm start 是 mineflayer 时代流程，当前默认 body=clientmod，沿用前先看配置）
```

---

## 八、安全边界（防回归清单）

1. **`/register` 永久禁止**（会重置角色数据）：HTTP dispatch 前、动作发网络前、Node `isForbidden`、
   CLI 四道闸门；递归剥离 `cmd` 前缀。
2. **权限闸门**装在 Body 的 `dig`/`place`/`useOn`：`deny` 优先、`ask` 动手前征询；漏写检查的新代码
   也绕不过。`!yes` 在当前任务内对同种方块持续有效，新任务重新征询。
3. **LLM 无 `say` 工具、无指令工具**：说话只能是对玩家的回复；主动发言路径 `speakUp` 丢弃一切 action。
4. **未知 Mod 方块保守**：mineflayer 路径 `mods.isMineable()` 默认不挖；clientmod 路径能看到真实注册表，
   但未知/不可挖判定仍然生效。
5. **防坠落**：Node waypoint 预检（悬空 >2 格 / 岩浆 / 怪物）+ Mod tick 探底（`ledge`）+
   tunnel 后洞窟复查（openness ≥ 45% 停）；正常 1–2 格台阶不受影响。
6. **单实例锁** + `duplicate_login` 退避（15s→120s）。
7. **死亡不自动恢复**：hold `dead` 只有显式 `!resume` 能解除。

---

## 九、已知缺口与技术债

> **复核说明（2026-10-14）**：下表 9 条原写于 2026-10-08；2026-10-14 以**代码为唯一真相**逐条静态复核
> （只读，未做客户端测试），结论：**#2 已修复；#5 的停牌键一致性已修（同条其余子项仍成立）；#4、#7 部分成立；
> #9 逐项混合（①②成立／③部分）；其余仍成立**；描述已按复核结果限定或拆分，另新增 §9.1 复核发现。
> **行号为 2026-10-14 修复后**（quarantine 键修复见 #5）的工作树行号。
> 其中属于**规划器**的条目（#1、#5 与 §9.1 的 #10–#13）另有一份规划器视角的完整清单与分路说明：
> [`PLANNER-REFACTOR.md`](PLANNER-REFACTOR.md)（P1–P10 / Q1–Q7）。

| # | 事项 | 复核裁定 | 说明 / 证据 |
| --- | --- | --- | --- |
| 1 | 两套执行层并存 | **仍成立**（边界需修正） | 自主慢规划全走 `src/tasks/`（导入 `src/brain.js:18-25`、规则表 `:560-624`），矿石经适配器进技能层（`src/tasks/mineOre.js:57-63` → `skills.run('mine_ore')`）。但"玩家/LLM 指令走 `src/skills/`"不成立：`!chop`/`!mine`(材料)/`!hunt`/`!craft`/`!shelter`/`!light` 仍 `new` 旧 Task（`src/chat/commands.js`），只有矿石分流进技能层。且"新功能只进技能层"已有破例：2026-10-10 的 `fca9a91`、`22d73e0` 仍改 `src/tasks`。**2026-10-21 更新**：`!store` 与 `!deposit` 已统一为同一条 `depositCommand → DepositTask → deposit 技能` 路径，`DepositTask` 只是技能适配器。 |
| 2 | 反射层的 mineflayer 绑定 | **已修复（技能驱动）** | `src/brain.js:258` `skillDriven = this.ctx.bodyKind !== 'mineflayer'`：进食 `:285-289`→`reflexEat`（`:364-389`）→`skills.run('eat')`；危险撤退 `:260-283`→`skillRetreat`（`:400-423`）；遭遇战 `:316-338`→`skills.run('shoot'\|'attack')`；穿甲 `:344-355`→`skills.run('armor')`（30s 限频）。servo 类仍读 controller（`src/survival/autoEat.js:25`、`combat.js:32`、`toolManager.js:22`）且仍在 `src/index.js:213-215` 构造，但只在 mineflayer 分支被调用（`:270-271,288,340,345`）⇒ 对 clientmod 是**兼容残留，不再是"安全空转的反射"**。`needsRescue` 崩溃已修（`src/core/recovery.js:48-49`）；残留 `escapeToGround` 仍直连 `ctx.bot`（`src/core/recovery.js:107,113,121-124`，当前不可达）。真机活动证据：10-13 日志多次 `hostile … - engaging` 与 `danger detected, retreating` |
| 3 | 部分旧任务未 Body 化 | **仍成立**（清单要加 `light`） | bot 直连：`src/tasks/hunt.js:33,43`、`shelter.js:33,44,114`、**`light.js:31,56,81`（原表漏项）**，另有辅助 getter `src/tasks/task.js:60-62`。clientmod 下 `ctx.bot` 恒为 null（只有 mineflayer 的 `botCreated` 才赋值：`src/index.js:258-259`，说明见 `:315-319`）。能力位：`src/body/body.js:260,272` 默认 false，`src/body/clientModBody.js` 只覆盖 `supportsCrafting` ⇒ hunting false；`hostiles` 只含敌对（`ClientStateSnapshot.java:363-375` 的 `instanceof Monster`）⇒ 被动生物在任何 body 都不可见。**2026-10-21 更新**：`deposit` 任务已改成技能适配器（`deposit.js` 只 `skills.run('deposit')`，不再直连 bot），能力表按 menu API 判定；hunt/shelter/light 仍直连 `ctx.bot`。统一后 `deposit` 不再有 mineflayer 直连实现，mineflayer body 报告 storage 不支持（clientmod 用菜单路径）。 |
| 4 | 断开/离开世界检测缺失 | **部分成立**（拆两条） | **已修**：快照不再冻结——TTL 400ms（`src/body/clientModBody.js:79`）、后台轮询 `statePollMs` 默认 500／设 0 可关（`:93,256-269`）、反射每 tick 兜底 `refresh(false)`（`src/brain.js:205`）、视图每次向 body 取最新（`src/world/bodyWorldView.js:55-59`），并有离线回归 `scripts/test-clientmod-protocol.js:717-721`；回主菜单 ⇒ `ready:false`（`ClientStateSnapshot.java:64-68`）⇒ `snapshot()=null` ⇒ 双循环 early-return（`src/brain.js:483`），walk/nav/plan 报 `body-lost`。**仍缺**：无显式检测/停牌/告警（`src/core/deathWatch.js:86` 直接 return，不走 hold 表）；维度变化无比较；**Mod 不可达时 `refresh()` 的 catch 返回旧快照且不置 `connected=false`（`src/body/clientModBody.js:290-293`）⇒ `isReady` 恒真、大脑无限期按冻结快照规划**；LLM 感知工具读缓存不刷新（`src/llm/tools/perceptors.js`，`statePollMs=0` 时无上限）；走位中退回主菜单时 `WalkTo` 把 `player==null` 当到达（`ClientActions.java:811-813`）而 busy 恒真 ⇒ Node 空轮询到超时（Tunnel/Pillar 正确 `no-body`：`:1513,1853`；DigBlock 有同缺陷） |
| 5 | 自主采矿目标的失败退避 | **部分修复**（键一致性 2026-10-14 已修；矿石路径仍无刹车） | **键一致性已修**：`decide()` 改为 `return this.pickRule(rules)`（`src/brain.js:626`），`pickRule`（`:648-668`）在 `when()` 通过后**先构造任务、再按 `task.name` 检疫**（`:661`）。修复前查的是 `rule.name`，使"矿石规则 `mine` → 任务 `mine_ore`"与"木头规则 `gather-wood` → 任务 `chop-wood`"两条路径的 30s 停牌**静默失效**。回归用例：`scripts/mining-entry-test.js` A10 三条（套件 20/20 → **25/25**，A11 另加"全矿种 × 六入口"深板岩矩阵）；把旧键放回去会立刻失败两条（实测）。**但要看清它修好了什么**：真正恢复停牌的是**木头路径**（`chop-wood`，`progress()` 返回数字）与材料路径（本来就正常）；**矿石路径仍然没有刹车**——`MineOreTask.progress()` 每次返回**新对象**（`src/tasks/mineOre.js:79-86`），B1 的严格相等永不成立，且零收获的矿石运行返回 `ok:true`（`src/skills/mining.js:2140`）⇒ 既不停牌也不罢工（详见 [`PLANNER-REFACTOR.md`](PLANNER-REFACTOR.md) P3/P4）。**仍成立**：① 粒度是任务名而非目标 ⇒ 同名规则连坐、却不记住具体不可达矿点，30s 后原样重放（停牌时 `_stalls` 被清零：`:809`；quarantine 过期即删：`:823`）；② 目标级黑名单仍是死代码（`src/core/memory.js:87-99` 无调用者）；③ 30s 为字面量、**无配置键**（`:808`，`config/agent.json` 内无 quarantine/backoff 键）。④ **设计选择而非缺陷**：采矿在"一块都没拿到但见过目标"时返回**成功**（`src/tasks/harvest.js:265-270`，理由见 `:256-264`——曾把"候选全都够不到"误报成"附近没有土"），因此**失败惩罚阶梯（`src/brain.js:762`，20s→120s 递增）对该场景永不适用**，只剩固定 30s 的零进展停牌。**日志辨识**：零进展停牌 = `made no progress (N) for K runs - parking it briefly`（`:807`）；失败退避 = `failed <name>: ...`（`:710`）+ `exhausted retries`（`:755`）；指令停止 = `brain hold: owner-stop`（`holds` 表） |
| 6 | 通用 WalkTo 无落差保护 | **成立**（限定：Mod 端无保护；Node 端仅"规划期有界"） | Mod 端 `WalkTo`（`ClientActions.java:744-999`）无 ledge/液体探底——`"ledge"` 全文件只出现在 Tunnel（`:1733`）；Node 端 A\* 有 `MAX_DROP = 3`（`src/pathfinding/movementsAdapter.js:44`），但 `src/pathfinding/walker.js:254` 临发前不复检，且两条通路绕过规划：`src/pathfinding/navigator.js:64-65,145-146`（≤directRange 直走）与 `src/body/clientModBody.js:555-564`（短跳直发）。落差预检 `dangerAt` 只在采矿技能内（`src/skills/mining.js:335,1609`）⇒ goto/explore/come 仍可能一脚踩空 |
| 7 | 采矿批次真机已通过（遗留两项） | **前句成立；遗留拆两条** | **真机通过**：2026-10-08 首轮（金矿 26+15 块、tunnel 全程 `jumps=0`、`ledge` 实测）＋ 10-10～10-12 续测（逐格垫柱/共享收集/有限清障/对角密闭），证据见 MINING-LLM-PLAN 附二/附三。**仍缺(a)**："吃饭→tunnel"只有离线用例（`scripts/skills-test.js:873-911`），待自然饥饿复测。**仍缺(b)**：镐子**耐久管理未实现**——唯一耐久消费者是钓竿（`src/skills/fishing.js:377,381,388`），`heldDurability` 只报主手（`ClientStateSnapshot.java:139`），选镐完全不读耐久（`src/world/toolPolicy.js:67-92`、`src/tasks/mineBlock.js:366`；同级并列时速度优先，而金为木级见 `src/world/items.js:163-165`） |
| 8 | mod-bridge 未接线 | **仍成立** | `mod-bridge/README.md` 自述 Fabric-only 服务端 Mod；仓库无消费（`src/` 内无相关 require，`scripts/bridge-client.js` 只能手动 `npm run bridge`）。`bridgePort` 唯一真实用途是推导面板端口（`src/index.js:56`）；`installBridgeMod`（`src/util/config.js:244`）与 `paths.modBridge`（`:351`）**无读取者** |
| 9 | 旧路径残留 | ①**成立** ②**成立** ③**部分成立（客户端行为）** | ①`npm start` = `scripts/run-all.js`：`:143-144` 自称"mineflayer agent"且子进程只带 `--force`（不传 `--body`）⇒ body 取 `config/agent.json:4` 的 `clientmod`（`src/body/factory.js:28`），而它启动的是本地 vanilla 专服，clientmod 需要已运行的 Forge 客户端（`src/body/factory.js:78-82`）；附加：`run-all.js:68-71` 的 `--port` 只改父进程 cfg，不传子进程。②`scripts/gen-srg-names.js:25` 自标 `STATUS: NOT WORKING YET`，仍挂在 `package.json:37` 的 `client:srg`。③`servers.dat` 重连属客户端自身行为：仓库无读写/清理代码（`scripts/launch-forge-client.js:23,35,525` 只拼 `--quickPlayMultiplayer`），无人值守前需操作员处理 |

### 9.1 复核新增发现（2026-10-14，原表未记载）

> #10–#13 中有 4 条属于**规划器**（自主决策回路）。规划器的完整清单——含 P3 `MineOreTask.progress()`
> 返回新对象导致零进展判定失效、P4 零收获矿石运行返回 `ok:true`、P8 文档声称的 `task:quarantined`
> 事件从未 emit——见 [`PLANNER-REFACTOR.md`](PLANNER-REFACTOR.md)。

| # | 事项 | 说明 / 证据 |
| --- | --- | --- |
| 10 | **`shelter` 规则是静默死规则（bug）** | `src/brain.js:581` 在 `when()` 中引用未定义变量 `bot`（该作用域只有 `view` 与 `this.bot`），规则表 try/catch（`:650-656`）以 **debug 级**吞掉 ReferenceError ⇒ **夜间自主 shelter 永不触发**（三种 body 皆然），自基线提交 `70eb462`（2026-10-02）起就存在；生产 `logging.level=info`，故日志里看不到。`!shelter` 在 clientmod 下同样失败（`ctx.bot` 为 null）。一行可修 |
| 11 | **`light` 规则无能力闸门** | `src/brain.js:588,608` 只判"有煤/木炭"，不判 body 能力 ⇒ clientmod 下会被反复选中而 `LightTask` 必失败（`src/tasks/light.js:31,56,81`），仅靠 #5 的 30s 停牌缓解 |
| 12 | **挖矿恢复提示词缺工具参数说明** | `src/llm/miningRecoveryPrompt.js:20,32` 只给工具**名**与通用 step 形状（`"args": object`），模型无从得知 `move_to_cell` 需要 `stand` ⇒ 这正是 2026-10-10 真机 L02 一次失败的来源（Schema 护栏按设计拒绝、零副作用） |
| 13 | **接管接线的离线覆盖边界** | `scripts/mining-recovery-test.js` 只覆盖监控器与会话（require 列表无 `src/skills/mining.js`）；`src/skills/mining.js:1989,2017` 的两处接管接线**无离线断言** ⇒ "监控器 + 会话通过"不等于"接线被验证"，真机 L02+ 修后未复测 |

---

## 十、验证体系

| 套件 | 覆盖 | 现状（2026-10-14 实测） |
| --- | --- | --- |
| `npm run selftest` | 模块图 / 插件 / 寻路 / 三原语 / 意图 Schema / 工具白名单 / 死亡处理 | 177/177 |
| `npm run p0:verify` | 一次跑 8 个套件（path/tasks/llm:dry/control/roleplay/clientmod/selftest/plan:audit） | 8/8 |
| `npm run skills:test` | 20 个技能（含采矿报价/台账/防坠落/垫柱/共享收集、collect 新鲜扫描、deposit 精确搬运、fish 任务适配器、战斗与枪械） | 68/68（2026-10-21） |
| `npm run client:test` | 假 Mod 协议（含 tunnel / pillar / verdict / 空闲刷新 / shoot / retreat） | 74/74 |
| `npm run clientmod:test` | clientmod 躯体角色扮演端到端 | 11/11 |
| `npm run mining:entry:test` | 统一挖矿入口 A 系列（含 A10 规划器停牌键、A11 全矿种深板岩矩阵） | 25/25 |
| `npm run mining:collection:test` | 掉落物共享收集 C 系列 | 24/24 |
| `npm run mining:recovery:test` | LLM 异常接管 R 系列（脚本化模型，不调付费模型） | 18/18 |
| `npm run verify:roleplay` | 角色扮演审计（无游戏、无网络） | 34/34 |
| `npm run path:test` / `tasks:test` / `control:test` / `llm:dry` / `plan:audit` | 寻路 35 / 三原语 57 / 双通道+面板+反射 41 / 路由 67+工具 43 / 计划符合性 33（p1 103） | 全绿 |
| `npm run client:verify` / `scripts/client-real.js` | 真机协议验收 / 三原语验收 | 需要客户端在跑 |

离线全绿 ≠ 真机通过：真机测试需要操作员确认环境（`start.ps1` → 面板 → 按 REWRITE-PLAN §12 清单）。
计数口径：本表为 2026-10-14 实跑值（与 `README.md` §8 同源）；改代码后请重跑 `npm run p0:verify` 与相关套件并同步两处。
2026-10-21 复跑（fish 入口 + collect 修复 + deposit 统一）：`selftest 177/177`、`skills:test 68/68`、`tasks:test 57/57`、
`control:test 41/41`、`client:test 74/74`、`p1:contract:test 206/206`、`plan:audit 33/33`（`--stage p1 103/103`）。

---

## 十一、模块速查：要改代码时看哪里

| 想改什么 | 看哪里 |
| --- | --- |
| 加一个新操作 | `src/skills/<new>.js` + `registry` 注册；测试进 `scripts/skills-test.js` |
| 改 LLM 的工具/边界 | `src/llm/tools/*` + `src/llm/tools/registry.js`；`llm:dry` 的 tools 断言 |
| 改人设/触发词 | `config/persona.md`（`src/llm/persona.js` 热加载）；`agent.chat.dialogueTrigger` 可覆盖 |
| 改采矿策略 | `src/skills/miningPlan.js` + `src/skills/mining.js`；阶梯 `src/core/recoveryLadder.js` |
| 改客户端动作 | `mod-client/src/main/java/dev/agentclient/ClientActions.java` → `npm run client:build/install`（必须重启客户端） |
| 改权限/征询 | `src/core/permissions.js` + `permissionGate.js`；命令 `!rule` `!yes` `!no` |
| 改面板 | `src/web/statusServer.js` + `panel.js`；`/ui/state` 是数据契约 |
| 新躯体 | 实现 `src/body/body.js` 契约 + `factory.js` 注册；用 MockBody 思路做假实现测试 |
| 排查"它不动" | `/ui/state` → `bodyReady/screenOpen/mouseGrabbed`；客户端窗口失焦或 GUI 打开时游戏忽略输入 |
