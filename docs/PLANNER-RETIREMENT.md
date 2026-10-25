# 自主规划器退役：slowLoop → GoalEvaluator + 提案 + TaskSlot

> 2026-10-17 设计定稿；S0–S4 已离线交付，但 **S4 是“有范围退役”，不是删除全部 planner**。
> 对应 [`P1-PLANNER-PLAN.md`](P1-PLANNER-PLAN.md) §1.10 与 §1.9 的动作脑接入。
>
> **当前状态（2026-10-20 核对）**：`slowLoop`、`evaluator`、`ProposalDesk` 仍在，但
> `config/agent.json` 的 `planner.mode` 已调回 **`off`**：本地规则表不生成计划、不执行；
> 自主 proposal 只能由 DSH harness 的 `mc_propose` 提出。`decide()/buildTask()` 与
> `planner.mode` 作为 legacy 后端保留。真正多步计划的生成由 DSH 动作脑 `mc_plan` 承担，
> Node `PlanService`/`PlanRunner` 负责校验与执行。
>
> | 退役项 | 状态 |
> | --- | --- |
> | 规则表搬出 `brain.js` → `evaluator` | ✅ S1 完成 |
> | 唯一身体所有权/执行器 → `TaskSlot` | ✅ S2a/S2b 完成 |
> | 提案生命周期/常驻授权 | ✅ S3 完成 |
> | 删除无调用者的 `pickRule()` | ✅ S4 完成 |
> | 删除 `slowLoop`/`decide`/`buildTask`/`planner.mode` | ❌ **未完成，按 S4 设计有意保留** |
> | “未经授权的自主执行”退役 | ✅ 当前 `off` 模式不生成、不执行（`proposals` 仅历史路径） |
>
> 2026-10-18 `774db29` 曾把默认模式从 `legacy` 改成 `off`；2026-10-19 `d17e2a0` 又改成
> `proposals` 并重新启用自主提案入口（真机 craft furnace 通过）。2026-10-20 为 M3 测试改为
> **只测 DSH harness**，已将 `planner.mode` 调回 **`off`**；harness 通过 `mc_propose` 提案。
>
> 真机存活规则数"3～4 条"来自**操作员上一轮核对**（本文不重新取证）；P1–P10 的问题条目沿用
> [`PLANNER-REFACTOR.md`](PLANNER-REFACTOR.md)，实施前仍须对照当时提交重新核实。


## 1. 为什么必须"拆开"而不是"删个函数名"

`slowLoop` 现在把三件互不相关的东西捆在一起，退役必须分别处理：

| 捆绑物 | 代码位置 | 去留 | 理由 |
| --- | --- | --- | --- |
| ① 2500ms 心跳 + 兼作队列泵 | `brain.js:170-171`，`slowLoop` 内部 | **留，改事件驱动**（任务结束 / 指令到达 / 世界变化才 tick） | 队列必须有人抽；P1 要求"无变化采样不触发模型" |
| ② 规则表 `decide()` / `pickRule()` | `brain.js:505-627`、`:648-668` | **退役为 GoalEvaluator**：只产出声明式候选，不执行 | 保留规则资产，去掉"自己派活" |
| ③ 执行编排 + B1/B2 + quarantine + 三级抢占 | `runTask` `:672-737`、`maybeRetry` `:740-775`、`_noteProgress` `:795-815` | **迁到唯一执行器**（与 `!` / `do_task` 共用） | 这是各入口的公共机械，不是规划器私有物 |

**"彻底退役" = 删掉 ②③ 在 `brain.js` 里的实现 + ① 改成事件驱动**，不是把 `slowLoop` 这个名字删掉就算。

## 2. 收益（可点数）

[`PLANNER-REFACTOR.md`](PLANNER-REFACTOR.md) 的 P1–P10 里有 7 条直接长在这约 200 行里，一次重构可清掉：

| 问题 | 现状证据 | 退役后怎么消 |
| --- | --- | --- |
| P1 `shelter` 是死规则（`bot` 未定义，异常被吞） | `brain.js:581`、`:650-656` | 规则搬进 evaluator 后按纯函数单测，`when()` 抛错直接失败而不是静默 |
| P2 `light` 无能力门 | `:588`、`:608` | 统一 Capability（P1 §1.4.1）后按能力表生成候选 |
| P3/P4 矿石零进展无刹车（`progress()` 返回新对象；零收获返回 `ok:true`） | `mineOre.js:79-86`、`mining.js:2140` | B1 改成"值域 + 单调性"契约并进执行器 |
| P5 停牌粒度＝任务名、目标级黑名单是死代码 | `brain.js:806-808`、`memory.js:87-99` | 提案/步骤带 `targetId`，账本按目标记账 |
| P6 30s 是字面量、`failCounts` 永不重置 | `:808`、`:760-763` | 配置键 + 账本持久化 |
| P8 `task:quarantined` 从未 emit | `:702/:712` 只有两个 emit | 执行器统一事件出口（顺带解决跨进程投递） |
| P9 规则表 20+ 分支几乎无测试 | 仅 A10 三条 | evaluator 可注入 ctx，逐条断言 |

外加 Q1（内联 thunk）、Q3（两套所有权）、Q4（内存态、重启即忘）、Q5（无可观测状态机）、Q6（tasks/skills 双轨）、Q7（三套停滞语义）也基本都落在这块。

## 3. 代价：三处必须同时改的既有测试

碰到 P0 基线的明文约束，**不能绕过**：

| 文件 | 约束 | 处理 |
| --- | --- | --- |
| `scripts/plan-audit.js:93-98` | 明文要求规则表构造 `ChopWoodTask`/`MineBlockTask` | 改为"evaluator 存在且不构造 Task 实例"；删除旧断言须同提交新增替代（P1 §3.3） |
| `scripts/control-test.js:360` | 直接 `await agent.brain.slowLoop()` 驱动规划器 | 改走新执行器/事件驱动 tick |
| `scripts/mining-entry-test.js` A10（:435-444） | 直接调 `decide()`/`pickRule()`/`brain.quarantine` | 改为测 evaluator 候选 + TaskSlot 停牌键 |

P1 §3.3 已写明 `plan:audit` 要做"阶段感知审计、不能删也不能恒过"——这一步不能省。**没有事件面（P1 §1.4.4）之前，不要先接提案闭环**：提案结果/超时/拒绝都到不了 harness，A25/A28 无法验收。

## 4. 目标形状（具体到文件）

```text
src/planner/evaluator.js   // evaluate(ctx) → candidates[]:
                           // {skill,args,reason,preconditions,weight}
                           // 规则表搬出 brain，纯函数、可注入、可单测
                           // （吸收 Q1/Q2/P1/P2）
src/planner/proposals.js   // 提案生命周期：
                           // proposed/awaiting/answered/accepted/expired
                           // + 3 分钟冷却 + 去重账本 + 常驻授权清单（A25）
src/core/taskSlot.js       // 唯一执行器：合并 brain.queue/activeTask 与
                           // TaskHub.current；B1/B2 + holds + 超时/强制结算
                           // （吸收 Q3/P3-P6/P8/P10）
src/brain.js               // 只留 fastLoop（反射）+ 调度器；
                           // slowLoop/decide/pickRule/runTask 删除
```

开关：`planner.mode = legacy | proposals | off`。设计期默认 `legacy` 直到各阶段验收通过；
S3 交付时仍为 `legacy`，2026-10-18 改为 `off`，2026-10-19 起为 `proposals`（当前值）。

## 5. 分四阶段（每阶段可独立合并、可回退）

| 阶段 | 做什么 | 不改什么 | 出口 |
| --- | --- | --- | --- |
| **S0 立抓手 ✅（离线）** | `progress()` 值域断言；`decide()` 可注入夹具（照 `mining-entry-test.js` 的 `buildAgent`）；`task:quarantined` 二选一（补 emit 或删文档依赖，P8） | 不改任何任务行为（只**新增**一个事件） | `planner:test` 17/17 全绿（2026-10-17） |
| **S1 抽 evaluator ✅（离线）** | 规则表搬进 `planner/evaluator.js`，输出声明式候选；`brain.decide()` 变薄壳 | 仍由 legacy 执行（`buildTask` 工厂留在 `brain.js`） | A10 改为直接测 evaluator；`plan:audit` 加"evaluator 不构造 Task 实例"；差分对照 28 组 |
| **S2a 所有权 ✅（离线）** | `src/core/taskSlot.js` 成为唯一身体所有者；brain 任务与 hub 作业都经 acquire/release；`activeTask`/`currentTask`/`hub.current` 变成视图；hub 从 brain 任务接管前等待其释放 | `!`/`do_task` 行为等价（52/37/176 等套件证明） | `control:test` 37/37、`selftest` 176/176；Q3 的"两套所有权"消除 |
| **S2b 执行器 ✅（离线）** | B1/B2（停牌/罢工）、任务执行、结算与**统一事件出口**迁进 TaskSlot；`brain.runTask` 退化为委托；超时仍由 `Task.execute` 的 `timeoutMs` 承担（由 slot 调用） | `!`/`do_task` 行为等价（52/37/25/176 等套件证明） | `control:test` 37/37、`selftest` 176/176；事件只有 `slot.publish` 一个出口 |
| **S3 提案 + 授权 ✅（离线）** | `src/planner/proposals.js`：提案生命周期、3 分钟冷却、无答过期（不等于同意）、显式任务取代、常驻授权；`planner.mode=proposals` 时 `slowLoop` 只提议不执行；确定性入口 `!proposal status\|accept [always]\|reject` | `!`/`do_task` 不变（默认 `legacy`） | A25 四条离线路径全过；语言脑措辞/解析已在 M3/M6 接入；2026-10-24 真机四路径（accept 真 harness，其余受控） |
| **S4 删代码 ✅（范围完成，非全删）** | 只删除无调用者的 `pickRule()`；`plan:audit` 改 `--stage p0\|p1`；`PLANNER-REFACTOR.md` 加退休状态表；**明确保留** `decide()/buildTask`（legacy 后端）、`slowLoop`（调度器）、`planner.mode`（回退开关） | — | p0 29/29、p1 34/34；P1–P10 全部关闭或转 M1；**legacy 全删仍未完成** |

**安全姿势**："退役执行权"和"退役代码"分开——S3 先把 `slowLoop` 变成"只提议 + `mode=legacy` 仍可执行"，跑一段真机；确认常驻授权够用后，S4 只按范围删死代码，legacy 后端保留到 M6 再删。这样任何一步出问题都能用开关退回。

## 6. 阶段与 P1 的挂载

| 本方案 | P1 阶段 | 说明 |
| --- | --- | --- |
| S0 | M0 | 与基线复测、审计迁移清单同批交付 |
| S1、S2 | M1 | 与身份/能力/进度/结果重构同批（统一执行权本来就在 M1） |
| S3 | M3 / M6 | 状态机与 `!proposal` 入口已离线完成；M3 接 harness 事件面，M6 由语言脑措辞与解析回答（替换 `!proposal`，不换状态机） |
| S4 | M7 | 删除死代码与阶段感知审计收尾（legacy 后端按范围保留） |

## 7. 验收与回归（每阶段必跑）

`p0:verify`、`path:test`、`tasks:test`、`skills:test`、`mining:entry/collection/recovery`、`llm:dry`、`control:test`、`plan:audit`（S1/S4 会改它）。

真机判据：

- `!` / `do_task` 行为不变（逐字节等价，用现有套件 + 真机抽测证明）；
- 空闲行为按 P1 §2.4 的授权口径（未获准不执行）；
- 重启后提案/失败账本可恢复（A17/A29）。

> **本轮不执行任何真机项**：以上判据与 P1 的全部客户端测试统一登记在
> [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md)，状态均为「未执行」；执行需单独批准。

## 8. 实施进展

| 日期 | 阶段 | 内容 | 证据 |
| --- | --- | --- | --- |
| 2026-10-17 | S0 | 1) `scripts/planner-retirement-test.js`：progress 值域（11 个任务通过 + `mine_ore` 作为**已知违规**登记，修好后测试会要求删除该条目）、`decide()` 可注入夹具 3 条、`task:quarantined` 两条路径各一条断言；2) `brain.js` 在两处 quarantine 补 emit（`reason=strikes` / `reason=no-progress`）；3) `npm run planner:test` 入 `package.json` | `planner:test` 17/17；`p0:verify` 8/8；`plan:audit` 29/29 |
| 2026-10-17 | S1 | 1) 新增 `src/planner/evaluator.js`：22 条规则改为声明式候选（`rule/type/name/args/weight/reason`），`evaluate()` 纯函数、可注入规则与回调；2) `brain.decide()` 变薄壳（evaluator → quarantine 过滤 → legacy 工厂），`pickRule` 标记 deprecated 保留到 S4；3) `shelter`/`light` 加 `requiresBody:'mineflayer'`，跳过时记录原因（P1/P2）；4) A10 两条合成规则断言改为 evaluator 断言；`plan:audit` 的 primitive-task 检查扩到 evaluator | `planner:test` 21/21；`mining:entry:test` 25/25；`plan:audit` 29/29；`p0:verify` 8/8；旧/新 `decide()` 差分 28 组仅两处有意修复不同 |
| 2026-10-17 | S2a | 1) 新增 `src/core/taskSlot.js`：唯一所有者 `{kind:'brain'\|'hub'}`、共享队列、hold 只在 hub 上生效、`waitForRelease`；2) `brain.activeTask/currentTask` 变 slot 视图（getter），`runTask` 经 acquire/release；3) `TaskHub.current` 变 slot 视图，submit 在接管前等待被取消的 brain 任务释放（P1 §1.4.2 #4），settle 释放 slot；无 brain 的旧测试桩保留 `_current` 回退 | `planner:test` 24/24；`control:test` 37/37；`selftest` 176/176；`tasks:test` 52/52；`skills:test` 57/57；mining 三套 25/24/18；`p0:verify` 8/8 |
| 2026-10-17 | S2b | 1) B1/B2 状态（quarantine/failCounts/progressSeen/stalls/blockedGoal）移到 TaskSlot；2) `slot.runTask()` 承接执行、结算、内存记账、`task:done/failed` 与 `task:quarantined` 发布；3) `slot.publish()` 成为唯一事件出口，hub settle 也走它；4) `brain.runTask/maybeRetry/_noteProgress/isQuarantined` 改成委托，状态字段改成 slot 视图（测试读写不变） | `planner:test` 25/25；`control:test` 37/37；`selftest` 176/176；`tasks:test` 52/52；`skills:test` 57/57；mining 三套 25/24/18；`plan:audit` 29/29；`p0:verify` 8/8 |
| 2026-10-17 | S3 | 1) 新增 `src/planner/proposals.js`：`propose/accept/reject/sweep/supersede/revoke`，冷却与 TTL 可注入时钟；常驻授权让下一次同目标"生而通过"；事件 `proposal:new/accepted/rejected/expired/superseded`；2) brain 增加 `plannerMode`（legacy/proposals/off，默认 legacy）、`nextCandidate/proposeNext/_proposeOrRun/acceptProposal/rejectProposal`；`slowLoop` 在 proposals 模式只提议；显式任务/死亡/停机取代待答提案；3) `!proposal` 命令（语言脑接管前的确定性入口）；4) `config/agent.json` 增加 `planner.{mode,proposalCooldownMs,proposalTtlMs}`；5) `plan:audit` 的配置消费检查纳入 planner 三个键 | `planner:test` 31/31（A25 接受/拒绝冷却/过期/取代/常驻授权）；`control:test` 37/37；`selftest` 176/176；`tasks:test` 52/52；`skills:test` 57/57；mining 三套 25/24/18；`plan:audit` 29/29；`p0:verify` 8/8 |
| 2026-10-17 | S4 | 1) 删除无调用者的 `pickRule()`（44 行）；2) `plan:audit` 支持 `--stage p0\|p1`，p1 = P0 全集 + 5 条 P1 断言（planner.mode 消费、evaluator 声明式、TaskSlot 单一 owner、统一事件出口、ProposalDesk + `!proposal`）；3) `PLANNER-REFACTOR.md` 增加 P1–P10/Q1–Q7 的关闭/迁移状态表；4) `decide()/buildTask` 与 `planner.mode` 保留为 legacy 后端与回退开关（待 M6） | `plan:audit` p0 **29/29**、p1 **34/34**；`planner:test` 31/31；`p0:verify` 8/8 |

**S0 的边界**：只新增事件与测试，不改任务执行、不改规则选择、不改退避窗口。
`mine_ore` 的对象返回值是**已知违规**而不是被容忍——S2 改成值域/单调性契约时，测试会失败并提示更新条目。

**S1 的两处有意行为变化**（其余 28 组差分一致）：

1. `shelter`：旧代码引用未定义的 `bot`，`when()` 抛错被 debug 日志吞掉，规则**永远不生效**；
   现在按"有 mineflayer 实例 + 夜晚 + ≥16 建材"正常产出候选（P1 修复）。clientmod 无 `bot` ⇒ 显式跳过。
2. `light`：旧代码在无 mineflayer 实例的躯体上也会选中并必然失败（P2）；现在显式跳过，
   **可能落到下一条可行规则**（例如 hunt/mine），这是预期行为，不是规则顺序错乱。
   两处跳过都会带 `rule` 与原因进入 `onRuleSkip`（日志 debug），规则抛错则进 `onRuleError`（日志 warn）。

**S2a/S2b 的边界与一处语义收紧**：身体所有权、队列、B1/B2、任务执行与事件出口现在都在 slot；
`brain.runTask / maybeRetry / _noteProgress / isQuarantined` 只是委托。hub 接管时会**等待**被取消的
brain 任务释放身体（最多 `settleTimeoutMs`）；原实现是"取消后立即启动"，存在两个执行者短暂并存的
窗口，现在符合 P1 §1.4.2 #4。**超时语义未改**：仍由 `Task.execute()` 的 `timeoutMs` 决定，slot 只负责
调用与结算。`pickRule` 在 S4 被删除；legacy 任务工厂仍在 `brain.js`，按 S4 范围保留。

**S3 的边界**：S3 当时 `planner.mode` 默认 `legacy`，所以生产行为不变；`proposals` 模式下 `slowLoop` 只产出提案，
**不**执行。`!proposal` 是语言脑接管（P1 M3/M6）前的确定性入口，不是最终交互形态：最终由语言脑把提案
措辞成问句、解析玩家回答，再调用同一组 `acceptProposal/rejectProposal`。A25 的"接受/拒绝/不答/另派"
四条状态机已离线验收；**真机多人 A25 当时仍是未执行项**（见 [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md)）。
2026-10-24 已补四路径：accept 为真实动作脑提案，reject/不答/另派为测试钩子植入
（[`M6-A25-CLIENT-TESTS.md`](M6-A25-CLIENT-TESTS.md)）；真实动作脑逐条提案仍待重跑。

**S4 的边界（删什么、留什么）**：删除 `pickRule()`——S1 之后它已无调用者，是纯 legacy 死代码；
`decide()/buildTask()` **保留**为 `planner.mode=legacy` 的后端（S4 当时默认模式，生产行为不变），
`slowLoop` 保留为按模式分派的调度器。`planner.mode` 开关本身保留为回退手段：等 P1 M6 的语言脑
接管提案问答、并把默认模式切到 `proposals` 后，再删除 legacy 后端。`plan:audit` 现在有
`--stage p0|p1`：p1 跑 P0 全集 **加** 5 条 P1 断言，不做"整体放宽"。

## 9. 完成状态（2026-10-17，2026-10-20 补充）

### 9.1 已完成的范围

**RETIREMENT S0–S4 已全部离线交付**：规则表已迁到 `evaluator`，执行/所有权已迁到
`TaskSlot`，提案状态机已落地，`pickRule()` 已删除；`PLANNER-REFACTOR.md` 的 P1–P10/Q1–Q7
已逐条标注“关闭 / 转 P1 M1 / 口径统一”。

- **离线证据（2026-10-22 实跑）**：`planner:test` 35/35；`plan:audit` p0 29/29、**p1 105/105**；`p0:verify` 8/8；
  `control:test` 43/43；`selftest` 181/181；`tasks` 57/57；`skills` 74/74；mining 25/24/18。
- **真机判据未全部执行**：`!`/`do_task` 等价仅抽测（A26/R1 部分）、空闲授权口径与重启账本未测、
  A25 的真实动作脑逐条提案未执行（2026-10-24 已跑四路径：accept 为真实提案，其余受控）——
  统一登记在 [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md)。

### 9.2 当前运行状态（2026-10-20）

| 项 | 现状 |
| --- | --- |
| `planner.mode` | **`off`**（2026-10-20，M3 改为只测 DSH harness） |
| `Brain.slowLoop` | **仍存在但自主分支关闭**；`off` 下不评估、不提案、不执行 |
| `decide()/buildTask()` | **仍存在**，作为 `legacy` 后端，供回退/直接任务构造 |
| 自主 proposal | 只能由 DSH harness `mc_propose` 提出；本地 planner 不生成 |
| 多步计划生成 | 由 DSH 动作脑 `mc_plan` 生成；Node `PlanService` 校验、`PlanRunner` 执行 |
| legacy 全删 | **未完成**，S4 有意保留 |

历史开关变化：

- `774db29`（2026-10-18）：`planner.mode` 从 `legacy` 改为 `off`，默认关闭自主规划；
- `d17e2a0`（2026-10-19）：从 `off` 改为 `proposals`，重新启用“规则评估 + 提案”入口；
- 2026-10-20：为 M3 只测 DSH harness，调回 `off`；harness 用 `mc_propose` 提案。

因此 10-19 的“planner 还活着”是 **提案层被配置重新启用**，不是 S4 删除的代码复活；
2026-10-20 又调回 `off`，本地 planner 不再自主生成。S4 的“完成”只覆盖“删除死代码 +
阶段审计”，不覆盖“删除 `slowLoop`/legacy 后端”。

### 9.3 真正完全退役仍缺

1. 语言脑完全接管提案问答（当前 `chat.languageAgent=false`，仍走确定性入口/旧路径）；
2. 默认模式稳定在 `off`，不再需要 `legacy` 回退；
3. 删除 `decide()/buildTask()`、legacy 任务工厂和 `slowLoop` 的 legacy 分支；
4. 更新 `plan:audit`，让“legacy 已删除”成为可验证断言；
5. 真机验证 `!`/`do_task` 等价与提案授权口径。

在这些完成前，本文只能声明 **“执行权退役 + 部分代码退役”**，不能声明“planner 已全部删除”。


## 10. 不做

- 不引入多 agent、树搜索或六个模型角色：GoalEvaluator 只是把现有规则表变纯函数，TaskSlot 只是合并两套所有权。
- 不在本方案里改 persona、聊天、感知采集（那些在 P1 的 M2/M6）。
- 不把"删掉 `slowLoop` 函数"当作完成；完成以 S4 的出口与 P1–P10 关闭表为准。
