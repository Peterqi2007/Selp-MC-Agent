# 完全自主模式（Fully Autonomous Mode）

> 状态（2026-11-01）：**已实现：离线 `p1:autonomous:test 33/33`、`p1:verify` 19/19（含 P0 为 20/20）、
> `plan:audit --stage p1 112/112`；真机 A33 部分执行**——**A33.1/A33.4/A33.7 已于 2026-11-01 重启
> DSH 后真机通过**（§4b），**A33.2/A33.3/A33.5/A33.6/A33.8 未执行**
> （需要真实游戏会话，尤其是「真的死一次」）。
> 代码：`src/core/autonomousMode.js`、`src/core/corpseRecovery.js`、`src/skills/corpse.js`；
> 提案侧改动在 `src/planner/autonomousProposals.js`；遗体交互与重生在客户端 Mod（`useentity` / `respawn`）。

## 1. 它是什么

一个**只能由 `!` 指令启动**的运行模式：Agent 围绕一个 Voyager 式目标，按已有 automatic curriculum
自己出题、自己执行、自己记账，**全程不需要玩家任何审批**；死亡后自行重生并走到遗体旁取回物品；
玩家派发的任务一律忙拒并报告当前活动与状态；普通聊天照常回复。

```
!autonomous on [目标]      # 启动（目标可选，默认「生存与发展（Voyager 风格）」）
!autonomous status         # 当前阶段 / 第几轮 / 正在做什么 / 完成与失败数
!autonomous off            # 退出模式（回到原有行为）
!stop                      # 暂停（模式保持 armed，发 !autonomous on 恢复）
```

非目标（刻意不做）：
- 不做「自动接受任何玩家任务」——模式内玩家任务是**拒绝**，不是自动执行；
- 不绕过难度带、安全反射、权限规则；
- 不做跨维度找回遗体（没有跨维度导航）；
- 不在模式启动以外的地方自动开启（重启也不会自己跑起来，见 §6）。

## 2. 状态机

```
off ──!autonomous on──► running ──!stop / 护栏──► paused ──!autonomous on──► running
                          │  ▲
         prep / execution  │  │  完成或 blocked
                          ▼  │
                       （下一轮，冷却 5s）
                          │
        死亡              ▼
                      dead ──respawn 成功──► respawning ──► recovering ──► running
                          └── 30s 仍未重生 / 已被 !stop ──► paused(respawn-failed|…)
```

- `phase` 是唯一真相：`off | running | dead | respawning | recovering | paused`；
- `isActive()` = `running|dead|respawning|recovering`，只有它为真时：自动接受提案、忙拒玩家任务、
  拒绝 `mc_ask_player`、把权限 `ask` 当 `deny`；
- `paused` 是**人为**状态（`!stop`、面板急停、护栏），不会自己恢复。

## 3. 一轮课程怎么跑

1. `brain.slowLoop` 每 2.5s 调 `proposalCoordinator.tick()`；模式内**空闲时间从 5 分钟降为
   `roundCooldownMs`（默认 5s）**。
2. 起一个 `purpose:"proposal"` 的 durable goal，正文 = 自主前言（无审批、不要问玩家、按目标推进）
   + `OBJECTIVE` + `curriculum.describe()`。
3. 动作脑 `mc_propose({autonomous:true})` → `proposal:new` → **立即** `accept(pending, {by:'autonomous'})`。
4. 执行 goal（`replace:true`）：动作脑用 `mc_step`/`mc_plan` 真的动手，目标终态 `complete|blocked`。
5. Node 把终态写回课程账本（`recordCompleted`/`recordFailed`），模式计数 `round++`，冷却后下一轮。

> **失败原因必须是文字（2026-11-01）**：动作脑把 goal 标成 `blocked` 时，DSH 的
> `goal.blockedReason` 是一个**对象**；`String(obj)` 一个字段都不保，于是
> `runtime/curriculum.json` 里留下了 `"reason": "[object Object]"`，而 `describe()` 会在下一轮
> 把这段文字原样喂回动作脑——它恰好是模型用来"退一步"的那条证据，等于把符号丢了。
> 现在 `src/planner/curriculum.js` 的 `reasonText()` 是唯一规则：优先取
> `.message`/`.reason`/`.detail`/`.text`/`.error`/`.code`，结构化体退 `JSON.stringify`
> （空对象、不可序列化对象记空，不编造），统一截 200 字；**账本写入与
> `autonomousProposals` 的 goal 轮询都走它**（轮询侧保留 `'blocked'` 兜底）。
> `p1:curriculum:test` 18→**20/20**：纯函数各形状 + 从 goal 轮询 → 账本 → `describe()` 的端到端断言。
> 加载时也会就地修掉旧账本里已经变成 `[object Object]` 的行（只改内存、不写回，与账本自净同一规则：
> 坏文件不该在启动时被改写）；那行的失败事实保留，原因记空——已经丢失的字符串不该被编造。

被否方案：一条超长 goal 自驱到底——会绕过难度带校验，也无法逐任务记账。

## 4. 玩家隔离（三层，各有唯一出口）

| 层 | 位置 | 行为 |
| --- | --- | --- |
| `!` 命令 | `ChatController.handle()` 顶部 | 白名单（`autonomous/stop/status/help/inv/where`）之外一律忙拒：**不建任务、不建 goal**，回一条忙句 |
| 自然语言动作请求 | `LanguageBrain._approval()`（`@`、面板对话、addressed 审批路径） | 不 forward 给动作脑，直接回忙句；`legacy` 的 `DialogueRouter` 与 addressed dispatch 同样有闸门 |
| 工具/权限 | `POST /ask_player`、`permissionGate.authorize()` | `mc_ask_player` → 409 `autonomous-no-approval`；权限 `ask` → `deny`（不弹询征） |

忙句同时回答三件事（一条 ≤100 字）：

```
正在忙：正在做「<当前任务>」（第 N 轮），难度 D；我在<维度> <x,y,z>，血 18/20 饥饿 15/20。
完全自主模式中，新任务暂时做不了。
```

普通聊天（未点名/非动作请求）仍走语言脑 roleplay；只在 system prompt 里多一句「你在忙、别承诺」。

## 4b. 操作员停止（`!stop` / `!autonomous off`）

2026-11-01 真机暴露：`!stop` 只停了 Node 的队列，**动作脑还在按 goal 继续调 `mc_step`**（它甚至在下
一条命令到达时新建 goal），操作员看到的是"按了没用"。现在的语义是两层、缺一不可：

1. **brake（DSH 侧）**：`stopActionBrain` 调插件 `POST /goal/pause`（暂停 goal 并取消它名下的
   in-flight turn 与 plan），再 `POST /goal/complete` 关闭 goal。只做 complete 不够——已开始的
   模型回合不会因为 goal 结束而停止。
2. **lock（Node 侧）**：`brain.hold('owner-stop')`。命令闸门对 `source:'action-brain'` 的调用
   检查这个 hold，除只读命令（`stop/state/status/help/inv/where/capabilities/keybinds/perception`）
   外一律返回 `operator-stop` + `requires:['operator-resume']`；`/plan`、`/propose`、`/ask_player`
   同样返回 409 `operator-stop`。这样即使有一个抢跑的回合，身体也不会动。

`!resume` 或 `!autonomous on` 调 `brain.resume()` 清掉 hold；模式启动时还会把遗留的 goal
complete 掉（否则插件会一直回 `goal:paused`，prep 永远起不来）。**启动是接管**：遗留的
**active** goal 也会被关闭（`clearActionBrainGoal({includeActive:true})`）——2026-11-01 真机
重测时，一个 `goto` 在回合开始前就失败，留下 active 任务 goal，`!autonomous on` 一直卡在
`goal:active` 起不了轮；现在启动会先关掉它再出题。

> **DSH 侧限制（2026-11-01 真机）**：宿主 goal-round-driver 在「agent 变 idle 时该回合消息还没被
> admit」的情况下会**自己 pause goal**（`roundsStarted:0`、`activation:disarmed`）。Node 会先 resume
> 两次；仍被 pause 就关掉这一轮、下一轮重建，连续 3 次则 `paused(prep-goals-paused)` 并写清楚原因，
> 不再假装在跑。遇到这种情况先重开一个干净的「动作脑」会话再 `!autonomous on`。

> **2026-11-01 重启 DSH 后真机重测（A33.1/4/7）**：`!autonomous on` 后 round 2→4，自动接受
> `deposit-surplus-blocks`/`deposit-dirt-stack` 并注入 execution goal（全程无 `!proposal accept`/
> `!yes`/`mc_ask_player`）；`!stop` 在回合执行中：goal `complete`、15s 内 body 无位移、
> `mc_step` 返回 `operator-stop`，`!autonomous on` 可再次起轮；`!autonomous off` 同样关闭并上锁，
> `!resume` 解锁。A33.2/A33.3/A33.8 与 A33.5/6（真实死亡/遗体）仍未执行。

## 5. 死亡 → 重生 → 回收遗体

1. `DeathWatch` 报死亡（`dead` hold 生效，所有任务中止）→ 模式 `phase=dead` 并关闭 prep/execution goal；
2. 每 1s 调 Mod 的 `respawn` 动词（= 死亡界面的按钮），直到 `dead:false`，上限 30s；
3. `phase=respawning`，等 AuthMe 登录完成（既有 respawn hook）+ 1.5s 稳定；
4. `phase=recovering`，`corpseRecovery`：
   - 同维度、距离 ≤ `maxCorpseDistance`（512）、死亡点非岩浆/火/仙人掌/细雪 → 否则诚实拒绝；
   - `moveTo` 死亡点（range 2.5，两段尝试）→ 在 16 格内按 `type` 含 `corpse` 找遗体（Corpse 模组实体）；
   - `useentity <id>` 右击 → `menu` 必须打开且 `menuClass` 含 `corpse`（否则拒绝，不乱开别的容器）；
   - 对每个非玩家槽位 `click <slot> 0 quickmove`，直到容器空或达上限；关界面；
   - 校验：容器空 / 遗体消失 / 背包净增；输出结构化证据（`slotsMoved`、`items`、前后数量、耗时）。
5. 回收结束（成功或诚实失败）→ `brain.resumeFromDeath()` → `phase=running` → 下一轮。

护栏：10 分钟内 3 次死亡 → `paused(death-loop)`；重生超时 → `paused(respawn-failed)`。
回收失败**不**暂停课程（遗体不是主任务），但要记 `recoveryFailures` 与原因。

> 依据：Corpse 模组「死亡点生成遗体、右击取回、不会被岩浆/虚空销毁」
> （[MC百科 · 遗体](https://www.mcmod.cn/class/3007.html)）；实体发现靠 `/state.entities`，
> 右击与重生是客户端 Mod 新增的两个动词。

## 6. 持久化与重启

- `sessionState` 保存 `phase/objective/round/stats/death/lastRecovery`；
- **重启后一律恢复为 `paused(restart)`**：只有 `!autonomous on` 能重新开始（严守「只能用 `!` 启动」），
  面板与启动日志会明确写出来；
- 恢复不重放任何动作。

## 7. 配置（`config/agent.json` → `planner.fullyAutonomous`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 功能可用性；启动仍需 `!autonomous on` |
| `defaultObjective` | 生存与发展… | 不传目标时使用 |
| `commandAllowlist` | autonomous/stop/status/help/inv/where | 模式内仍可执行的 `!` 命令 |
| `roundCooldownMs` | `5000` | 每轮之间的冷却（替代 5 分钟空闲） |
| `maxRoundsPerHour` / `maxPrepFailures` / `maxConsecutiveBlocked` | `60` / `3` / `1` | 三个护栏，触发即 `paused`。**受阻即退出**（2026-11-01）：执行目标被动作脑标成 `blocked` 时模式立刻 `paused(execution-blocked)`，把控制权还给操作员——否则模式继续 active，玩家任务会被忙拒 |
| `announce.*` | start/stop/death/recovery = true，tasks = false | 聊天播报开关（不逐任务刷屏） |
| `death.respawn*` | `true` / `30000` | 自行重生与超时 |
| `death.corpseRecovery` / `corpseEntityTypes` / `corpseRadius` / `maxCorpseDistance` | `true` / `["corpse:corpse"]` / `16` / `512` | 遗体回收范围与匹配 |
| `death.allowOtherDimension` | `false` | 跨维度找回（未实现导航，保持 false） |
| `death.deathLoopWindowMs` / `deathLoopMax` | `600000` / `3` | 防自杀循环 |

## 8. 观察面

- `GET /ui/state.autonomous`、`GET /autonomous`：phase/objective/round/activity/guards/stats/lastRecovery，
  以及 `coordinator` 子对象（prep/execution goal id、`lastError`、`lastBlockedReason`），
  用来回答「为什么这一轮没开始」（例如 `no-live-action-brain`）。
- `GET /curriculum`：课程账本（不变）。
- 日志标签：`autonomous`、`proposal-autonomy`、`death`、`corpse`（回收结果）。
- `!autonomous status`：一句话摘要。
- 面板 HTML 本轮未改（读 `/ui/state` 的 fields 已包含 `autonomous`）；要一行文字摘要请用 `!autonomous status`。

## 9. 验收（A33，真机部分执行）

> **状态（2026-11-01）**：**A33.1 / A33.4 / A33.7 真机 PASS**（重启 DSH 后重测，逐项回执见 §4b）；
> **A33.2 / A33.3 / A33.5 / A33.6 / A33.8 未执行**，需要真实游戏会话与一次真实死亡。
> 下表是通过标准，不是已完成记录。

| 编号 | 项 | 通过标准 |
| --- | --- | --- |
| A33.1 | 启动与自驱 | `!autonomous on` 后无玩家输入连续 3 轮；`runtime/curriculum.json` completed 增长；每轮 goal id 可追 |
| A33.2 | 任务忙拒 | 游戏内 `!mine dirt 1` 与面板同类：一条忙句、无任务入队、无新 goal |
| A33.3 | 对话忙拒 + 聊天正常 | `@大肥鱼 挖铁` → 忙句、无 forward；「在干嘛」→ 正常 roleplay 回复 |
| A33.4 | 无审批 | 全程无 `!proposal accept`、无 `!yes`、无 `mc_ask_player` 停车 |
| A33.5 | 死亡重生 | 死亡界面 30s 内消失、`dead:false`、AuthMe 已登录 |
| A33.6 | 遗体回收 | 走到遗体、打开、物品回背包（给前后数量）、遗体消失、课程继续 |
| A33.7 | 暂停/恢复 | `!stop` 后 10s 内无新 goal/mc_step；`!autonomous on` 恢复 |
| A33.8 | 重启 | 重启后 `paused(restart)`、轮次保留、无动作重放 |

## 10. 已知限制 / 风险

1. **遗体交互未在本服真机验证**：`corpse:corpse` 的实体 id 与「右击打开容器」来自上游源码与 MC百科；
   实现按 `type` 子串匹配（可配置），若模组改版打开的是自定义界面而非容器菜单，回收会以
   `unexpected-menu` 诚实失败（届时可在 Mod 增加「直接发送 TransferItems」的等价动词）。
2. `LocalPlayer.respawn()` 是 1.20.1 死亡界面按钮的同一条路径，编译已通过；真机仍需 A33.5 确认。
3. **成本**：模式会连续消耗模型轮次；用 `maxRoundsPerHour` 与连续失败暂停兜底，不设 token 硬上限
   （与 P1 Q2 裁决一致），但状态里可查轮次与 goal。
4. 改 Mod 必须重装并重启客户端；插件 `mc_ask_player` 描述已写明「模式内会被拒、应标 blocked」，
   **需要重启 DSH 才生效**（本轮只拷贝到 profile）。
5. 该模式与 M5 输入层共用一个身体；真机验收期间不要人工抢键盘。
