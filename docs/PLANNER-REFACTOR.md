# 规划器（autonomous planner）专项审计与重构边界（2026-10-14）

> ## 退休状态（2026-10-17，RETIREMENT S0–S4 已执行）
>
> 本文记录的问题已按 [`PLANNER-RETIREMENT.md`](PLANNER-RETIREMENT.md) 处理；下表是**关闭 / 迁移**的
> 唯一权威。证据只列离线套件（`planner:test`、`plan:audit --stage p1`、`p0:verify` 等）；
> 真机项仍登记在 [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md)；M1/M2/M3 相关真机已于 2026-10-17/21 通过，
> 退役判据仍部分执行（R1 部分、R2–R4 未执行）。
>
> | 项 | 状态 | 说明 |
> | --- | --- | --- |
> | **P1** shelter 死规则 | ✅ 已修（S1） | 规则移入 evaluator，去掉未定义 `bot`；无 mineflayer 实例时显式跳过 |
> | **P2** light 无能力门 | ✅ 已修（S1） | `requiresBody:'mineflayer'`，跳过带原因 |
> | **P3** 矿石零进展无刹车 | ✅ 已修（M1b） | `mine_ore.progress()` 改为稳定字符串 `mined/skipped`，B1 停牌对矿石路径生效 |
> | **P4** 零收获返回 `ok:true` | ⏭ 转 P1 M1 | 同上，属于结果语义统一（P1 §1.4.1） |
> | **P5** 停牌粒度=任务名 / 黑名单死代码 | ⏭ 转 P1 M1 | 提案已带 target；quarantine 仍按任务名，目标级账本未做 |
> | **P6** 30s 字面量 / 计数不重置 | ⏭ 转 P1 M1 | 提案冷却/TTL 已可配；B1/B2 窗口尚未提配置 |
> | **P7** 规则名≠任务名 | ✅ 已修（S1） | 候选同时带 `rule` 与 `name`，quarantine 用 `name` |
> | **P8** `task:quarantined` 从未 emit | ✅ 已修（S0/S2b） | 两条停牌路径均经 `slot.publish` 发布 |
> | **P9** 规则表几乎无测试 | ✅ 已修（S1） | `evaluator` 可注入，`planner:test` 覆盖候选/能力跳过/抛错上报；A10 改为 evaluator 断言 |
> | **P10** 两套停牌并存 | ⚖ 口径统一，代码合并转 M1 | holds（全局）与 quarantine（目标）仍在两处；文档口径已统一 |
> | **Q1** 规则表内联在 `decide()` | ✅ 已消除（S1） | 规则移至 `src/planner/evaluator.js` |
> | **Q2** 每 tick 重建快照/全量计数 | ⏭ 转 M1 | 未改；M1 的观察契约处理 |
> | **Q3** 两套所有权 | ✅ 已消除（S2a） | `TaskSlot` 是唯一 owner；brain/hub 只读视图 |
> | **Q4** 规划器状态全内存 | ⏭ 转 M1 | 提案历史/冷却仍在内存；A17/A29 的持久化待 M1/M3 |
> | **Q5** 无可观测状态机 | ⚖ 部分 | `lastDecision` + `proposals.status()` 可观测；完整状态机转 M1 |
> | **Q6** tasks/skills 双轨 | ⏭ 转 M1/M3 | 未动 |
> | **Q7** 三套停滞语义 | ⚖ 部分 | B1/B2 已统一进 slot；技能层 monitor 仍独立，转 M1 |
>
> **本文 §二 的代码地图与行号是 2026-10-14 快照**：S1 搬走了规则表、S2 搬走了执行/B1/B2/B3 状态，
> `pickRule()` 已删除，`decide()` 只做"候选→legacy 任务"的薄转换。读旧章节时按此校正。
>
> **本文只记规划器自身的问题。** 规划器是下一阶段重点重构对象，因此这里把它的**目标选择、失败语义、
> 退避与所有权**单独立账，不让它与 **`!` 命令回路**、**LLM `do_task`/`do_skill` 回路**的问题互相污染
> （典型错误：把规划器的停牌问题当成技能 bug 去修，或反过来要求技能层为规划器的空转负责）。
>
> 但"分账"≠"机制不相干"：**退避记账（B1/B2）发生在 `runTask`，是"规划器任务 + 命令表任务"共用的**，
> 只有 `quarantine` 的**拦截**是规划器专属——第一节的表把这个边界写死，重构前请先读它。
>
> 证据口径：2026-10-14 **只读代码核实**（未做客户端测试），行号为当日工作树。
> 凡属设计判断而非可核实缺陷的，一律标 **「判断」**。代码级缺陷同时登记在
> [`ARCHITECTURE.md`](ARCHITECTURE.md) §九 / §9.1；本文是规划器视角的**汇总与分路**。

---

## 一、三条派发回路（先分清谁是谁）

| | **A. 规划器回路** | **B. `!` 命令回路** | **C. LLM 回路** |
| --- | --- | --- | --- |
| 入口 | `Brain.slowLoop()`，周期 `idleThinkIntervalMs`=2500ms（`src/brain.js:170`） | ChatListener → `ChatController.handle` | `LlmCore` 回合 → 工具注册表 |
| 目标从哪来 | 规则表 `decide()` → `pickRule()`（`:485`、`:505-668`） | 命令表（`src/chat/commands.js`） | 模型选工具（`src/llm/tools/*`） |
| 执行路径 | `runTask()` → `src/tasks/*`；**矿石例外**：`MineOreTask` → `skills.run('mine_ore')`（`src/tasks/mineOre.js:63`） | 材料/木头/合成/睡觉等 → `brain.enqueue(new Task)`（`commands.js:230-340,666`）；**矿石** → `dispatchMining` → TaskHub | **`do_task` 复用同一张命令表**（`actuators.js:88`，设计意图见 `:3-13`）⇒ 与 `!` 同路；`do_skill`：`LONG_SKILLS` 进 TaskHub，其余直接 `skills.run`（`:150-164`） |
| **写入** B1/B2（零进展停牌 / 失败罢工） | ✅ 写（`runTask` 内，`:695`/`:740`） | ✅ **也写**（同一条 `enqueue → runTask`） | 部分：`do_task` 的材料类**写**；`do_skill` 直调与 TaskHub 作业**不写** |
| **被 `quarantine` 拦截** | ✅ 只在这里：`decide()/pickRule()`（`:661`） | ❌ 命令直接 `enqueue`，不经过规则选择 | ❌ |
| 受 `holds` 影响 | planning 类全挡；`task`/`owner-stop` 在 `slowLoop` 与 `enqueue` 两处拒绝 | 同左（`enqueue` 拒绝非 urgent：`:870-881`） | TaskHub 拒绝非 urgent 提交 |
| 完成事件 | `task:done` / `task:failed`（`:702`、`:712`） | 同左 | TaskHub 也回发同样两个事件（`src/core/taskHub.js:273`） |

**一句话**：B1/B2 的**记账**发生在 `runTask`（`brain.js:672`），所以它是"**规划器任务 + 命令表任务**"
共用的机制——`!` 的材料类、LLM `do_task` 的材料类都会写进去；而 `quarantine` 的**拦截**只发生在
`decide()/pickRule()`，即**只影响自主选目标**。**TaskHub 派发的作业**（矿石、`do_skill` 长技能）既不记账
也不被拦，它们的兜底是 TaskHub 的 settle（`taskHub.js:215-222`）与任务基类的 `timeoutMs`/`maxRetries`
（`src/tasks/task.js:41,121`）。

> **重构含义（重要）**：改 `_noteProgress`/`maybeRetry`（B1/B2）会**同时改变 `!` 与 `do_task` 的行为**；
> 改 `decide()`/规则表/`pickRule()` 才只影响自主行为。这条界线必须在重构开工前写死，否则"只改规划器"
> 的假设会立刻失效。

---

## 二、规划器代码地图

| 部分 | 位置 |
| --- | --- |
| 反射循环（600ms，**不属于规划器**） | `fastLoop()` `src/brain.js:190-356` |
| 规划循环（2500ms） | `slowLoop() :454-496` |
| 决策 | `decide() :505-627` → `pickRule() :648-668` |
| 执行与结果分支 | `runTask() :672-737` |
| 失败退避 **B2** | `maybeRetry() :740-775`（strikes → `min(120s, 20s×strikes)`） |
| 零进展停牌 **B1** | `_noteProgress() :795-815` + `isQuarantined() :818-827` |
| 规划器私有状态 | `:95-99`：`quarantine` / `failCounts` / `_progressSeen` / `_stalls`（+ `blockedGoal` `:93`） |
| 全局停牌表（**与规划器无关**） | `src/core/holds.js`（`dead`/`paused`/`owner-stop`/`task`） |

---

## 三、已核实的问题（P 系列，全部有代码证据）

| # | 问题 | 证据 | 影响 |
| --- | --- | --- | --- |
| **P1** | `shelter` 规则是**静默死规则**：`when()` 引用未定义变量 `bot`，ReferenceError 被规则表的 try/catch 以 **debug 级**吞掉 | `src/brain.js:581`（规则）+ `:650-656`（吞异常）；生产 `logging.level=info` 故日志不可见；自基线 `70eb462`（2026-10-02）起 | 夜间**自主** shelter 永不触发（三种 body 皆然）；`!shelter` 在 clientmod 另因 `ctx.bot=null` 失败 |
| **P2** | `light` 规则**无能力闸门**：只判"有煤/木炭" | `:588`、`:608`；`LightTask` 走 `ctx.bot`（`src/tasks/light.js:31,56,81`） | clientmod 下有煤即被反复选中并必然失败，只靠停牌缓解 |
| **P3** | 零进展判定对 `mine_ore` **完全失效**：`MineOreTask.progress()` 每次返回**新对象**，而 B1 用严格相等比较 | `src/tasks/mineOre.js:79-86` + `src/brain.js:803`；实测：数字型值 3 次即停牌，对象型值 5 次仍不停牌（同一引用才会命停） | **矿石路径在规划器层没有刹车**：每 2.5s 重选同一矿点（键修复也救不了它） |
| **P4** | 零收获的矿石运行返回 **`ok: true`**，因此也永不进 B2 | `src/skills/mining.js:2140`（`ok: !stats.planExceeded`） | 与 P3 叠加 ⇒ 规划器对该场景既不停牌也不罢工 |
| **P5** | 停牌粒度＝**任务名**，不是目标身份；同名规则连坐，且不记具体不可达目标 | `:806-808`；目标级黑名单 `src/core/memory.js:87-99` 是**死代码**（无调用者） | 30s 后原样重放同一目标；可达目标被同名规则连坐 |
| **P6** | 30s 是**字面量、无配置键**；`failCounts` **永不重置** | `:808`；`:760-763`；`config/agent.json` 无 quarantine/backoff 键 | 不可调；同一会话内越停越久（20s→40s→…→120s 封顶） |
| **P7** | 规则名 ≠ 任务名（`mine`→`mine_ore`、`gather-wood`→`chop-wood`），隐式契约 | 规则表 `:560-624` vs `src/tasks/chopWood.js:32`、`src/tasks/mineOre.js:30` | 曾导致停牌静默失效；键语义已于 2026-10-14 修复（回归用例 `scripts/mining-entry-test.js` A10 三条），但**命名不一致本身**仍是重构债 |
| **P8** | 文档声称的 `task:quarantined` 事件**代码里从未 emit** | `docs/LLM-INTEGRATION-PLAN.md:234,439,794` vs `src/brain.js` 仅 `:702`、`:712` 两个 emit | 依赖该事件做"失败求助/跟进"的设计无法实现 |
| **P9** | 规划器**几乎没有离线测试**：`decide()`/`pickRule()` 直到 2026-10-14 才有 3 条直接断言（A10：`decide()` 1 条 + `pickRule()` 2 条），规则表其余分支（20+ 条 `when`）无覆盖 | `scripts/mining-entry-test.js` A10 | 规划器行为主要靠真机日志观察，回归风险高 |
| **P10** | 两套停牌并存（全局 `holds` vs 目标级 `quarantine`），术语、日志、语义都不同却常被混谈 | `src/core/holds.js` vs `src/brain.js:795-827` | 排查成本高；本文档即为消除此混淆而建 |

---

## 四、判断类重构债（**未验证**，供重构时评估）

| # | 事项 | 依据 |
| --- | --- | --- |
| **Q1** | 规则表内联在 `decide()` 里（20+ 个 thunk），无注册表、无 schema、目标参数写死（count/priority 硬编码） | `:560-624` |
| **Q2** | 每个 tick 重建 `SnapshotInventory` 并做全量计数（`has`/`countMatching`/`bestTool`…），未评估开销与快照一致性 | `:519-555` |
| **Q3** | 所有权检查重复：`slowLoop` 的 `activeTask`（`:467`）与 TaskHub 的 `task` hold（`taskHub.js:140`）各管一套 | 同上 |
| **Q4** | 规划器状态全在内存，重启即忘；`memory.js` 有持久化能力却未接上（含 P5 的黑名单） | `:95-99` + `src/core/memory.js` |
| **Q5** | SAFE MODE、idle 告警、`blockedGoal` 混在 brain 内，没有可观测的规划器状态机（`planning idle` 每 20 tick 才 warn 一次） | `:489`、`blockedGoal :93/756` |
| **Q6** | 规划器仍以 `src/tasks/*` 为主干，与技能层双轨；矿石有适配器（`MineOreTask`），**2026-10-21 起 deposit/withdraw/follow 也改为技能适配器**（`DepositTask`/`WithdrawTask`/`FollowTask` → `skills.run(...)`，`!store`/`!deposit` 共用） | `:18-25` + `src/tasks/mineOre.js` / `src/tasks/deposit.js` / `src/tasks/withdraw.js` / `src/tasks/follow.js` |
| **Q7** | "零进展"与"失败"是两套语义（成功分支 vs 失败分支），没有统一的停滞模型；技能层另有第三套（monitor 六触发） | `:695` / `:736`；`src/core/miningProgress.js:25-32` |

---

## 五、验证缺口与最小抓手（重构前先立）

- **现有**：A10 三条（`decide()` 1 条 + `pickRule()` 2 条，只覆盖停牌键语义）；真机日志（`… parking it briefly`、`planning idle: …`）。
- **缺口**：规则表 20+ 条 `when` 无覆盖；`_noteProgress` 没有"连续零进展"用例；没有"同一目标连续失败/连续零收获"的端到端夹具。
- **建议抓手**（重构第一步，成本低、收益高）：
  1. 给 `decide()` 一个可注入 ctx 的离线夹具（像 `mining-entry-test.js` 的 `buildAgent` 那样），把"哪个规则会赢"变成断言；
  2. 把 **`progress()` 的值域约定**（必须是数字或字符串，禁止返回新对象）写成断言，防 P3 复发；
  3. 为 `task:quarantined`（P8）二选一：补 emit，或删掉文档里的依赖。

---

## 六、交叉引用

| 文档 | 与规划器相关的部分 |
| --- | --- |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | §3.2 决策与调度；§九 #1/#5/#10/#11/#13；§9.1 |
| [`../README.md`](../README.md) | §3 当前状态、§9 已知限制 |
| [`MINING-LLM-PLAN.md`](MINING-LLM-PLAN.md) | §5.6 统一入口（`MineOreTask` 适配器、不二次提交 TaskHub）；§6.4 阶段判定 |
| [`LLM-INTEGRATION-PLAN.md`](LLM-INTEGRATION-PLAN.md) | `task:quarantined` 事件（**P8：文档有、代码无**） |
| [`CONTROL-PANEL-ANALYSIS.md`](CONTROL-PANEL-ANALYSIS.md) / [`CONTROL-PANEL-IMPLEMENTATION.md`](CONTROL-PANEL-IMPLEMENTATION.md) | 早期对 `Brain.queue` / 优先级 / 重试的分析（**brain 行号已过期**，结论按当时版本读） |
