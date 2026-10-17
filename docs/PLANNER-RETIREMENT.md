# 自主规划器退役：slowLoop → GoalEvaluator + 提案 + TaskSlot

> 2026-10-17 定稿。对应 [`P1-PLANNER-PLAN.md`](P1-PLANNER-PLAN.md) §1.10 与 §1.9 的动作脑接入。
> 本文是**实施设计**，不是已完成状态：S0–S4 均未开工，验收项均待跑。
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

开关：`planner.mode = legacy | proposals | off`，**默认 `legacy`** 直到各阶段验收通过。

## 5. 分四阶段（每阶段可独立合并、可回退）

| 阶段 | 做什么 | 不改什么 | 出口 |
| --- | --- | --- | --- |
| **S0 立抓手 ✅（离线）** | `progress()` 值域断言；`decide()` 可注入夹具（照 `mining-entry-test.js` 的 `buildAgent`）；`task:quarantined` 二选一（补 emit 或删文档依赖，P8） | 不改任何任务行为（只**新增**一个事件） | `planner:test` 17/17 全绿（2026-10-17） |
| **S1 抽 evaluator ✅（离线）** | 规则表搬进 `planner/evaluator.js`，输出声明式候选；`brain.decide()` 变薄壳 | 仍由 legacy 执行（`buildTask` 工厂留在 `brain.js`） | A10 改为直接测 evaluator；`plan:audit` 加"evaluator 不构造 Task 实例"；差分对照 28 组 |
| **S2a 所有权 ✅（离线）** | `src/core/taskSlot.js` 成为唯一身体所有者；brain 任务与 hub 作业都经 acquire/release；`activeTask`/`currentTask`/`hub.current` 变成视图；hub 从 brain 任务接管前等待其释放 | `!`/`do_task` 行为等价（52/37/176 等套件证明） | `control:test` 37/37、`selftest` 176/176；Q3 的"两套所有权"消除 |
| **S2b 执行器** | 把 B1/B2、超时、强制结算与统一事件出口迁进 TaskSlot（`runTask` 退化为调用执行器） | `!`/`do_task` 行为必须逐字节等价 | `control:test` 改走新执行器；事件仍只有一套出口 |
| **S3 接提案 + 授权** | `proposals.js` + A25 冷却/不答/拒绝 + 常驻授权；摘掉 `slowLoop` 的执行权 | `!`/`do_task` 不变 | A25；需要 P1 §1.4.4 事件面才能接 harness |
| **S4 删代码** | 删 legacy 路径与降级开关（或保留只读）；`plan:audit` 改阶段感知；`PLANNER-REFACTOR.md` 标注"已退役/已迁移" | — | P1–P10 逐条关闭或转下阶段 |

**安全姿势**："退役执行权"和"退役代码"分开——S3 先把 `slowLoop` 变成"只提议 + `mode=legacy` 仍可执行"，跑一段真机；确认常驻授权够用后，S4 再删代码。这样任何一步出问题都能用开关退回。

## 6. 阶段与 P1 的挂载

| 本方案 | P1 阶段 | 说明 |
| --- | --- | --- |
| S0 | M0 | 与基线复测、审计迁移清单同批交付 |
| S1、S2 | M1 | 与身份/能力/进度/结果重构同批（统一执行权本来就在 M1） |
| S3 | M3 | 需要 §1.4.4 事件面；A25 的聊天侧验收仍在 M6 |
| S4 | M7 | 删代码与阶段感知审计收尾 |

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

**S0 的边界**：只新增事件与测试，不改任务执行、不改规则选择、不改退避窗口。
`mine_ore` 的对象返回值是**已知违规**而不是被容忍——S2 改成值域/单调性契约时，测试会失败并提示更新条目。

**S1 的两处有意行为变化**（其余 28 组差分一致）：

1. `shelter`：旧代码引用未定义的 `bot`，`when()` 抛错被 debug 日志吞掉，规则**永远不生效**；
   现在按"有 mineflayer 实例 + 夜晚 + ≥16 建材"正常产出候选（P1 修复）。clientmod 无 `bot` ⇒ 显式跳过。
2. `light`：旧代码在无 mineflayer 实例的躯体上也会选中并必然失败（P2）；现在显式跳过，
   **可能落到下一条可行规则**（例如 hunt/mine），这是预期行为，不是规则顺序错乱。
   两处跳过都会带 `rule` 与原因进入 `onRuleSkip`（日志 debug），规则抛错则进 `onRuleError`（日志 warn）。

**S2a 的边界与一处语义收紧**：所有权与队列进了 slot，但 `runTask` 仍在 brain 里执行（S2b 才搬）。
hub 接管时现在会**等待**被取消的 brain 任务释放身体（最多 `settleTimeoutMs`）；原实现是"取消后立即
启动"，存在两个执行者短暂并存的窗口。这是 P1 §1.4.2 #4 要求的方向，所有套件通过。

下一步（S2b）：把 B1/B2、超时、强制结算与统一事件出口迁进 `src/core/taskSlot.js`，`brain.runTask`
退化为调用执行器；`!`/`do_task` 必须逐字节等价（用现有 52/37/176 等套件证明）。
`pickRule` 与 legacy 路径在 S4 删除。

## 9. 不做

- 不引入多 agent、树搜索或六个模型角色：GoalEvaluator 只是把现有规则表变纯函数，TaskSlot 只是合并两套所有权。
- 不在本方案里改 persona、聊天、感知采集（那些在 P1 的 M2/M6）。
- 不把"删掉 `slowLoop` 函数"当作完成；完成以 S4 的出口与 P1–P10 关闭表为准。
