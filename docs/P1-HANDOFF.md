# P1 交接（2026-10-30 更新）

> **一句话**：P1 的**离线可交付部分**已实现并通过一键复验；**M1（适用子集）/M2/M3/M4（A19 适用子集）已通过真机验收**；
> **P1 仍未整体验收、未发布**（M5 输入层已实现并真机验证链路，但 F1'/A21/A22 未收口；CU 路径**已放弃**；M6/M7 部分）。
> **M4：编排子集曾判 PASS，2026-10-25 需求变更重开后 v2 已实现，A18–A20、A28–A30 真机 PASS**；
> A19 残余（真实 PauseScreen/第二玩家）仅离线；方案见 [`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md)。
> 2026-10-24 补 M6 受控测试（A24/C03/F02 受控 PASS、A25 四路径仅 accept 为真实 harness、
> A23 仍缺 40 组 ×3），**M6 仍 PARTIAL**。
> 2026-10-30 补：CU 标为 ABANDONED（[`CU-ABANDONED.md`](CU-ABANDONED.md)）、载具感知、`@` 请求 → goal、
> 截图 steer 主动提交、Voyager 式自动课程；**当天白天已拉起真实客户端补真机**：`@` goal、
> biplane `mounted/inventory/integrity`、steer 落在 turn 70 step 2（带图）、curriculum prep level 1/4→2/4（两次完成）
> 同时修掉 judge 预算/解析、unified 语言脑绕过 goal、旧插件 delivery 误报三个缺陷
> （[`P1-WORK-2026-10-30.md`](P1-WORK-2026-10-30.md) §8）。
> 2026-10-31 补：自卫反射状态 `selfDefense` 进入 `/ui/state`、`mc_observe`、`mc_state`、
> 请求 envelope 与 goal 文本；动作脑现在知道反射可能自行攻击/抢占任务（§9）。
> **动作脑改绑到 `Minecraft动作脑3`（`session-d2ad5dc4-…`，`config/agent.local.json`）**；
> 输入层新增受控 `key <name>`（仅原版 KeyMapping；edge 点击；R/mod 键位明确不可用），
> 真机验证见 [`P1-WORK-2026-10-30.md`](P1-WORK-2026-10-30.md) §10。
> 本文是交接入口；**阶段判定**以 [`P1-CLIENT-VERIFICATION.md`](P1-CLIENT-VERIFICATION.md) 为准，
> 逐项证据见 [`P1-M7.md`](P1-M7.md) 的 A01–A31 矩阵与 [`P1-M3.md`](P1-M3.md) §3。
>
> **2026-10-22 文档同步**：本文件此前停留在 2026-10-18 的“M3 仅接线、真机未执行”状态，
> 与 2026-10-20/21/22 的实测不符。本次回填：M3 真机通过、`p1:verify --fast` **9/9 套件**（当时；2026-10-25 为 10/10）、
> 套件计数更新、DialogueRouter/`mc_say` 真机链路、客户端 Mod（Veil 输入崩溃）修复；
> 2026-10-23 增加统一语言脑门面（`p1:language:test 20/20`）。
> **未通过阶段仍不通过**；未执行项仍保持未执行。
>
> **2026-10-29：M5 口径变更（见 [`P1-M5.md`](P1-M5.md) §7）**——CU 路径放弃（WGC 取不到 OpenGL
> 窗口帧 + 策略接不进只读的打包插件），M5 改走 Minecraft 进程内输入层；F1 作废，闸门改为
> F1'（结构性不可出界 + 键鼠台账）；A21/A22 不再标 N/A，待执行。

## 1. 一键复验

```bash
npm run p1:verify            # P0 回归 + planner + contract + m3 + m6 + m7 + m4 + fault + audit p1
npm run p1:verify -- --fast  # 跳过 P0 回归
npm run p1:baseline -- --suites  # 记录提交/配置指纹/套件结果到 runtime/p1-baseline.json
```

最近一次实测（离线，2026-10-30）：

| 套件 | 结果 |
| --- | --- |
| P0 regression（8 suites，含 `selftest 183/183`） | **8/8** |
| `planner:test` | **35/35** |
| `p1:contract:test` | **213/213** |
| `p1:m3:test` | **58/58** |
| `p1:m6:test` | **25/25** |
| `p1:proposal-autonomy:test` | **16/16** |
| `p1:language:test` | **22/22** |
| `p1:m7:test` | **11/11** |
| `p1:m4:test` | **35/35** |
| `p1:m4:evolve:test` | **17/17** |
| `p1:m5:test` | **34/34** |
| `p1:channel:test` | **18/18** |
| `p1:shot:test` | **20/20** |
| `p1:steer:test` | **9/9** |
| `p1:taskgoal:test` | **13/13** |
| `p1:curriculum:test` | **8/8** |
| `p1:fault:test` | **9/9** |
| `plan:audit --stage p1` | **105/105** |

`p1:verify --fast` 为 **17/17 套件**，完整含 P0 为 **18/18**（跳过 P0 回归）。
没有启动 Minecraft、没有 GUI 自动化、没有调用生成模型；M4 测试在真实 Node 子进程中执行了探针技能，
并用一次 DeepSeek Search 请求验证了搜索端点。

## 2. 已交付（按里程碑）

| 阶段 | 关键交付 | 真机状态 |
| --- | --- | --- |
| M0 | 基线脚本（提交/配置/jar 指纹）、问题复核、P0→P1 审计迁移、冻结评测集 v1 | 入口已用 |
| M1 | `TaskEvents`（seq/幂等/重放）、身份字段与 requestId 贯穿、`PlanStore` 单一写者、同端口 SSE、Capability 表、TaskResult 六态、`mine_ore` progress 值域、`PlanRunner`、`TurnLifecycle`、`HarnessAdapter` | **PASS（适用子集）** |
| M2 | 二值闸门 + `@` 通道（默认关闭）、严格 LLM 判定器、双脑工具清单、`say/silence`、`LanguageAgent`、可选语言对话通道（默认关闭）、快照 `observedAt`、`refreshPlan`、`ThreatObserver`、persona 注入、H1a/H1b | **PASS** |
| M3 | `PlanService`/`POST /plan`、`TurnService`/`/harness/events`、DSH `mc_plan`、原子持久化、`wait_for_player`、计划问题复用提案、`ResumeBridge`、`MethodLibrary`、`AnswerMemory`、`MemoryStore`、`Budget`、`verifier`、`draftGuard`、`!state`、`!method`；另：持久 goal（`/goal/pause`/`resume`）、`mc_propose`、`mc_state`、`mc_perception` | **PASS（2026-10-21，M3.1–M3.10）** |
| M4 | manifest 校验、生成管线、candidates/promoted 目录与指针、晋升/回退/下线、promoted-only 检索；2026-10-18 接真实生成、权限子进程试运行、证据、取消、DeepSeek Search、HTTP `/code-skills`；2026-10-25 接实时入口；需求变更后 v2 实现（离线 35/35）并完成 **A18–A20、A28–A30 真机**（A19 适用子集） | **PASS（A19 适用子集）**；方案 [`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md) |
| M5 | 进程内输入层（按键/长按/视角/容器槽位点击/帧缓冲截图）+ 键鼠台账；**CU 路径已放弃（ABANDONED）** | **未通过**：输入/截图/GUI 链路已真机验证（`m5-gui-live 93/93`），但 F1' 四类注入未跑完、A21 部分（探针直连）、A22/M5.3 未执行 |
| M6 | `ConversationState`（去重/过期/自回声/限速/截断）+ opt-in 守卫 + `ChatParticipation` 参与/沉默 + `ProposalChat` yes/no + **DialogueRouter + `mc_say`**；2026-10-24 受控测试 A24/C03/F02 PASS、A25 四路径（accept 真 harness） | 部分：A23 缺 40 组 ×3；A25 仅 accept 为真实提案；R2/R3 未执行 |
| M7 | 故障演练 9/9、A01–A31 矩阵、`p1:verify`、本交接文档；TaskSlot 失败账本持久化 + UsageLedger 逐请求 usage | 部分：R1 部分，R2–R4/F3/A31 最终组合未执行 |

## 3. 客户端窗口实测

### 3.1 2026-10-17（历史记录，保持不变）

| 项 | 结果 |
| --- | --- |
| `client:verify`（模组协议） | **23/23 PASS** |
| `client-real --login`（登录+谨慎寻路） | **7/7 PASS**，服务器确认 `Вход успешен` |
| `client-real --primitives` | 砍树 PASS；独立 mine 一次 2/2、另一次厚土柱 0/2；`--dig stone` 点位失败；一次复测因死亡/空背包无效 |
| Agent 自动 AuthMe 登录 | 首次失败（探针早于 ChatListener 首轮播种）；修复后 **PASS**，未发 `/register` |
| A01 面板 `!status` / 非法 `!mine` | PASS：3ms、模型 tokens 0→0、明确 usage |
| `/state` 空闲 | p50 43.8ms / p95 64.9ms（30 次，1.79MB，63,257 cells） |
| F1 CU 限窗 | **未执行**：helper 无已授权应用，读取 java 窗口被拒 |

### 3.2 2026-10-20/21/22（新增，真机）

| 项 | 结果 |
| --- | --- |
| A13–A17、A27（只读/异步）、A28、A29、A30、F2 | **PASS**（`planner.mode=off`，DSH 动作脑/真机注入；逐项见 [`P1-M3.md`](P1-M3.md) §3.3–§3.5） |
| `goal` 持久目标 | `goal-4c197708…` 4/8 轮 complete；`/goal/pause` 取消 turn+plan 且身体停，`/goal/resume` 继续 |
| DialogueRouter + `mc_say` | 面板 `@` 与游戏内 `source=chat` 均进 DSH 动作脑；`mc_say` turn 90 单次调用、单次发言 |
| 客户端 Mod（2026-10-22） | 修复 Aeronautics/Sable/Veil 下按任意键崩溃（ImGui 防护 Mixin，转发原版 KeyboardHandler）；ESC/E/T/W 真机验证 |

**夜间安全**：`client-real` 在寻路/采集前检查时间（优先 `isDay`），夜里在 **60×10×60**
内找最近的床睡觉；无床/走不到则中止。运行 Agent 时夜里用 `!sleep`。实测：门禁会中止；
入夜入睡待床可达。

证据：`runtime/logs/` 下 `client-verify-2026-10-17.log`、`client-real-login-2026-10-17.log`、
`client-real-primitives-2026-10-17.log`、`agent-authme-final-2026-10-17.log`、
`state-idle-2026-10-17.json`；M3 证据见 `runtime/` 计划/事件与 `.tmp/*-evidence-*.md`（工作副本）。
摘要见 [`CLIENT-TEST-2026-10-17.md`](CLIENT-TEST-2026-10-17.md) 与 [`P1-M3.md`](P1-M3.md)。

### 3.3 2026-10-23/24（语言脑 unified 与 M6 受控）

| 项 | 结果 |
| --- | --- |
| unified 语言脑真机 | 面板与游戏内同一 `LanguageBrain` 路径；roleplay/expert/approval；`mc_say` 输出经 roleplay 改写；重启恢复 13→15 行窗口；启动自动绑定动作脑（[`LANGUAGE-BRAIN-REPAIR.md`](LANGUAGE-BRAIN-REPAIR.md)） |
| M1-A01 / M2 回归（10-23） | `!` 免审查（tokens 0→0）；A02 20 条 approval（应拒 10/10、应放 10/10）；A03 工具面/真实玩家插话；B01 原文身份链；C01 记忆隔离；D01/D02 操作员手工 PASS；语料沉默学习（40 条，真实玩家 6 条全沉默） |
| M2/M3 语言脑补充（10-24） | E01/F01/A14/C02/E02/D03 全过（[`M2-M3-LANGUAGE-TESTS.md`](M2-M3-LANGUAGE-TESTS.md)） |
| M6 受控（10-24） | A24 4 并发 4 user/1 assistant；C03 compact 41 entries + 跨重启 grep；F02 无 chat wake；A25 四路径（accept p14 真 harness，reject/不答/另派为测试钩子植入，[`M6-A25-CLIENT-TESTS.md`](M6-A25-CLIENT-TESTS.md)） |
| 动作脑自主任务申请（10-24） | 空闲 5 分钟 → prep goal（禁 step/plan/say，只能 `mc_propose(autonomous)`）→ 30 秒窗口 → 接受后 execution goal；Node 不建本地任务；`p1:proposal-autonomy:test 16/16` |

证据：`.tmp/` 下 `m1-a01-2026-10-23.md`、`m2-a02-2026-10-23.md`、`m2-a03-2026-10-23.md`、
`m2-b01-2026-10-23.md`、`m2-c01-2026-10-23.md`、`language-brain-live-2026-10-23.md`、
`silence-corpus-live-2026-10-23.md`（工作副本）；M6 证据已入库为
[`M6-LANGUAGE-TESTS.md`](M6-LANGUAGE-TESTS.md) 与 [`M6-A25-CLIENT-TESTS.md`](M6-A25-CLIENT-TESTS.md)。

### 3.4 2026-10-25（M4 代码技能窗口；编排子集，同日因需求变更重开）

| 项 | 结果 |
| --- | --- |
| 需求变更 | 操作员要求生成代码**直接读 `/state` 并移动/挖掘/点击**；旧编排子集 A18 不成立，M4 重开（[`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md)） |
| A18 代码技能（编排） | 旧证据：2 类目标真实生成/试运行/晋升；dirt 0→1；动作脑 `mc_step`（2 次）+ `mc_plan` 单步 `code_skill`（`plan-1792896332472-ievp8` completed、postcondition 成立）；**不含直接 move/dig/click** |
| A19（历史子集） | raw `fs`/`require('fs')`/未晋升 run 被拒；vm 逃逸后 `require` 与全部模块被拒、`process.report/chdir` 被 permission model 拒绝；OS 子进程 fs/child 拒绝、网络经 `subprocessGuard` 关闭；覆盖内置、死循环、子进程/宿主失联、清理与启动清扫实测 |
| A20（旧编排候选） | `agent.boom` quarantine、rollback 1.1.0→1.0.0、retire 移除 promoted 与命令入口 |
| A27 代码 | 9 次真实 `code-generation` 调用（2 次 token 截断失败，修复预算后 7 次成功），usage 可归属 |
| A28–A30 编码回合（编排） | `agent.slow_wait` 15.1s 长步骤单次结算（动作脑 turn 1→0、postcondition 成立）；取消后 14s 无迟到 `done`；硬杀恢复 pending v1/s1 pending 且不重放、启动清扫 1 个残留目录；本回合 1 条 `code-generation` 用量（1064 tok），沙箱运行无 LLM 用量 |
| 安全加固 | 模块 denylist→全拒；新增 `subprocessGuard.js`（子进程无网络/模块）；启动清扫宿主硬杀留下的 `run-*` 目录（本次 4 个） |
| 真机修复 | `read_state.isDay` 恒空、`code_skill` progress 误停牌、promote/rollback 多版本同时 promoted |
| 配置 | `codeSkills.generateMaxTokens 2600→16000`、`generationTimeoutMs 30000→180000`（思考模型 reasoning 计入 completion） |
| 环境/安全 | 动作脑「Minecraft动作脑1」；开窗时游戏内为夜，`!sleep` 床不可达 → 天亮后执行；直接 `computer_use` 仅用于读取游戏窗口确认无暂停界面 |

证据：[`M4-CLIENT-TESTS.md`](M4-CLIENT-TESTS.md)；日志 `runtime/logs/start-agent3/4/5/6-20261025.log`。

## 4. 默认配置（2026-10-22 测试窗口）

| 配置 | 默认 |
| --- | --- |
| `planner.mode` | `off`（自主规划关闭；明确 `!` 命令仍执行） |
| `chat.actionBrain` | `harness`（`@` 自然语言统一转 DSH 动作脑；`planner-first`/`planner` 为回滚） |
| `chat.addressedPrefix` | `null`（`@` 通道关闭；测试时按需开启） |
| `chat.gateTimeoutMs` | `8000`（A02 真实 judge 延迟；原 1500 会误判 timeout） |
| `chat.languageAgent` | `false` |
| `chat.conversationGuard` | `false` |
| `chat.participate` / `chat.proposalChat` | `false` / `false`（M6 客户端窗口显式打开） |
| `chat.harnessAgentId` | `session-8d816775-c46e-4ed7-9b08-115622a84616`（预绑定「Minecraft动作脑1」；置空则由 auto-bind/`/bind` 决定） |
| `language.brain` | `unified`（2026-10-23 起默认；`legacy` 可完整回退） |
| `planner.autonomousProposals` | `enabled=true`，`idleMs=300000`、`responseMs=30000`、`prepTimeoutMs=90000`、`maxGoalRounds=3`（动作脑自主提案；未接受不执行） |
| `agent.codeSkills.generateMaxTokens` / `generationTimeoutMs` | `16000` / `180000`（2026-10-25 真机调参：思考模型 reasoning 计入 completion，2600/30000 会截断） |
| `state.enabled` | `true`（A17/A29 测试窗口；`P1_STATE=off` 或改 `false` 可关） |
| `state.path` / `debounceMs` | `runtime/p1-state.json` / `1000` |
| `web.eventsToken` | `""`（仅本机；F3 真机鉴权未执行） |
| `web.testHooks` | `false`（A28 注入需 `P1_TEST_HOOKS=on` 启动） |

## 5. 剩余未交付（以及为什么）

| 项 | 现状 / 下一步 |
| --- | --- |
| M4（已完成） | **PASS（A19 适用子集）**：v2 离线 35/35；A18 `grass_dig`/`table_click`、A19 越界/抢身体/取消/deny/无屏点击/非敌对攻击/硬杀、A20 `half_fail`、A28 长任务 15.57s、A29 硬杀恢复、A30 用量 10,352 tok 真机通过；残余：真实 PauseScreen/第二玩家仅离线 |
| M5 F1' / A21 / A22 | CU 路径已放弃：①WGC 取不到 OpenGL 窗口帧（两轮真机 `截图未产出` + `Declared image type does not match its bytes`）；②`WindowPolicy`/`ComputerUseGuard` 接不进只读的打包插件（`resources/app.asar`），真机“未 verify 前默认拒绝”不成立。改为 Minecraft 进程内输入层；前置是 **F1'**（F1'a 结构性不可出界 + F1'b 键鼠台账，**无 N/A 出口**）；A21/A22 待执行（命题不变、证据重记）。详见 [`P1-M5.md`](P1-M5.md) §7 |
| M6 A23 / A25 剩余 | A24/C03/F02 受控 PASS；A23 缺真实第二名玩家 40 组 ×3 与 ≥80%/≤10% 阈值；A25 仅 accept 为真 harness，reject/不答/另派需在真实动作脑提案下重跑（单操作员/合成发送者需标注）；R2/R3 未执行 |
| M7 A26 / R1–R4 | A26 仅 2026-10-17 分项基线；R1 部分，R2–R4 未执行 |
| M7 F3 / A31 最终组合 | F3 真机 token 端点未验；A31 双 emitter/planVersion 未验 |
| M0-C1 剩余负载 | 仅空闲 30 次测时；移动/挖矿/反射/GUI 负载未测，阈值不得回填 |
| 挖石路径（真机） | 一次 2/2、一次厚土柱 0/2；强依赖地质，需固定裸露石层测试点或更深下挖设计 |
| 夜间睡眠（真机） | 门禁生效（无床/走不到会中止）；实际入睡尚未成功，需床可达时重试 |
| 发布前配置决定 | `state.enabled` 保持或回退 `false`；移除 `P1_TEST_HOOKS`；复核最终配置 |

## 6. 接下来怎么开始

1. 先读 [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md)（唯一权威清单）与
   [`P1-CLIENT-VERIFICATION.md`](P1-CLIENT-VERIFICATION.md) §0（阶段判定）。
2. **M7 回归**：A26 完整回归、R1–R4、F3 真机 token、A31 最终组合；每项记录版本/账号/日志路径。
3. **M4**：**A18 v2 真机 PASS；A19/A20/A28–A30 待验**——`grass_dig` dirt 1→2/2→3、
   `table_click` 槽 10→11/11→10；残余风险记录在案。沙箱规则见 [`P1-M4-SANDBOX.md`](P1-M4-SANDBOX.md)。
4. **M5**：先做进程内输入层（mod 按键/视角/槽位点击 + 帧缓冲截图）与 `InputLedger`，过 F1'a/F1'b
   后再跑 A21/A22；F1' 不通过则实现不合并，A21/A22 **不标 N/A**。详见 [`P1-M5.md`](P1-M5.md) §7。
5. **M6**：按 40 组 ×3 语料跑 A23（A24 受控并发已过，随语料复跑）、按四路径跑 A25 的真实动作脑部分；单操作员时标注“非真实多人”。
6. 完成一项就回填清单，**未测不填、代码存在不算通过**。

## 7. 代码地图（P1 新增）

```
src/core/      taskEvents, planStore, planService, taskSlot, capabilities, stateStore,
               sessionState, planRunner, turnLifecycle
src/planner/   evaluator, proposals, autonomousProposals, budget, verifier, draftGuard, planQuestions
src/chat/      commandGate, addressedHandler, harnessBridge, conversation,
               languageDialogue, chatParticipation, proposalChat, dialogueRouter,
               playerChatLog（非 ! 玩家消息 → ChatMemory）
src/tasks/     follow, withdraw, deposit, fish（FollowTask/WithdrawTask/DepositTask/FishTask）
src/codeSkills/ manifest, generator, store, directory, sandboxRunner, sandboxWorker,
               service, generation, catalog
src/llm/knowledge/ webSearch（DeepSeek /v1/tools/search；语言脑 web_search 无首选，
               行为脑 lookup_mod_content 优先 MC百科）
src/llm/       judge, toolSurface, languageAgent
src/world/     freshness, refreshPlan, threatObserver, perceptionWake, observation
src/learning/  methodLibrary, answerMemory
src/memory/    store, chatMemory
src/computer/  windowPolicy, guard（CU 已放弃（ABANDONED）；M5 已改走进程内输入层）
src/harness/   adapter, resumeBridge, turnService
dsh-plugin-mc-harness/lib/index.js   11 个 mc_* 工具（observe/step/plan/plan_status/cancel/
                                     finish/state/perception/memory/propose/say）
scripts/       p1-verify, p1-contract-test, p1-m3-test, p1-fault-test, p1-baseline
docs/          P1-M0 … P1-M7, P1-GAP-AUDIT, P1-CLIENT-TESTS
```

## 8. 已知风险

1. **真实模型行为只覆盖已跑场景**：A02 判定、H1a/H1b、M3 动作脑/真机注入、unified 语言脑
   已有真实回执；A23 的 40 组 ×3、A25 三条真实提案（reject/不答/另派）仍未实测；
   A24 仅受控并发（合成发送者）。
2. **A30 按操作员口径通过**：success/compress/failure/cancel 可归属；retry 用量在 DSH 执行中
   无法获取，不再取证。
3. **代码技能 v2 已真机验收（A19 适用子集）**：A18–A20、A28–A30 已按直接身体原语在真实客户端
   通过；残余：真实 PauseScreen 点击、真实第二玩家攻击仅离线；vm 不是内核边界（逃逸可读 worker
   进程元数据/env，无密钥），子进程网络由 `subprocessGuard` 关闭但无内核级网络隔离；
   实时 `code_skill` 持 body slot，技能内 `submit_task` 会排到自身之后。
4. **持久化在测试窗口开启**：A17/A29 已验证等待计划/问题/预算恢复与不重放；
   发布前必须决定保持或回退。
5. **阈值空置**：`/state` 周期、感知成本、聊天节奏、预算数值都未测量（500ms/3 次检索是配置，不是结论）。
6. **两套规划循环**：默认 `off` 关闭自主规划；`legacy` 代码仍在，删除/切换需真机验收。

## 9. 建议顺序

1. **M7 回归**：A26 行走/破坏/拾取/取消/双通道 + R1–R4；同窗口补 F3 token 与 A31 最终组合。
2. **M6**：A23 固定 40 组 ×3（单操作员需标注；A24 受控并发已过，随语料复跑）+ A25 真实动作脑四路径。
3. **M4**：已完成（PASS，A19 适用子集）；v2 离线 35/35，A18–A20、A28–A30 真机通过；残余记录在案。
4. **M5**：进程内输入层 + 键鼠台账 → F1'（结构断言 + 台账归零）→ A21/A22；F1' 不过则实现不合并，
   A21/A22 不标 N/A（[`P1-M5.md`](P1-M5.md) §7）。
5. **修复遗留**：挖石 noPath、夜间入睡、A02 timeout、A10 跨维度/部分刷新、A11 天气/阶段注入。
6. 每次改动保持 `npm run p1:verify` 全绿（当前 11/11，含 P0 回归；`--fast` 10/10）；删除断言必须同提交替换。
