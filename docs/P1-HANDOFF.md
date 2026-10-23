# P1 交接（2026-10-23 更新）

> **一句话**：P1 的**离线可交付部分**已实现并通过一键复验；**M1（适用子集）/M2/M3 已通过真机验收**；
> **P1 仍未整体验收、未发布**（M4 部分、M5 阻塞、M6/M7 部分）。
> 本文是交接入口；**阶段判定**以 [`P1-CLIENT-VERIFICATION.md`](P1-CLIENT-VERIFICATION.md) 为准，
> 逐项证据见 [`P1-M7.md`](P1-M7.md) 的 A01–A31 矩阵与 [`P1-M3.md`](P1-M3.md) §3。
>
> **2026-10-22 文档同步**：本文件此前停留在 2026-10-18 的“M3 仅接线、真机未执行”状态，
> 与 2026-10-20/21/22 的实测不符。本次回填：M3 真机通过、`p1:verify --fast` **9/9 套件**、
> 套件计数更新、DialogueRouter/`mc_say` 真机链路、客户端 Mod（Veil 输入崩溃）修复；
> 2026-10-23 增加统一语言脑门面（`p1:language:test 19/19`）。
> **未通过阶段仍不通过**；未执行项仍保持未执行。

## 1. 一键复验

```bash
npm run p1:verify            # P0 回归 + planner + contract + m3 + m6 + m7 + m4 + fault + audit p1
npm run p1:verify -- --fast  # 跳过 P0 回归
npm run p1:baseline -- --suites  # 记录提交/配置指纹/套件结果到 runtime/p1-baseline.json
```

最近一次实测（离线，2026-10-23）：

| 套件 | 结果 |
| --- | --- |
| P0 regression（8 suites，含 `selftest 181/181`） | **8/8** |
| `planner:test` | **35/35** |
| `p1:contract:test` | **206/206** |
| `p1:m3:test` | **44/44** |
| `p1:m6:test` | **24/24** |
| `p1:language:test` | **19/19** |
| `p1:m7:test` | **11/11** |
| `p1:m4:test` | **15/15** |
| `p1:fault:test` | **9/9** |
| `plan:audit --stage p1` | **105/105** |

`p1:verify --fast` 为 **9/9 套件**（跳过 P0 回归）。没有启动 Minecraft、没有 GUI 自动化、没有调用生成模型；
M4 测试在真实 Node 子进程中执行了探针技能，并用一次 DeepSeek Search 请求验证了搜索端点。

## 2. 已交付（按里程碑）

| 阶段 | 关键交付 | 真机状态 |
| --- | --- | --- |
| M0 | 基线脚本（提交/配置/jar 指纹）、问题复核、P0→P1 审计迁移、冻结评测集 v1 | 入口已用 |
| M1 | `TaskEvents`（seq/幂等/重放）、身份字段与 requestId 贯穿、`PlanStore` 单一写者、同端口 SSE、Capability 表、TaskResult 六态、`mine_ore` progress 值域、`PlanRunner`、`TurnLifecycle`、`HarnessAdapter` | **PASS（适用子集）** |
| M2 | 二值闸门 + `@` 通道（默认关闭）、严格 LLM 判定器、双脑工具清单、`say/silence`、`LanguageAgent`、可选语言对话通道（默认关闭）、快照 `observedAt`、`refreshPlan`、`ThreatObserver`、persona 注入、H1a/H1b | **PASS** |
| M3 | `PlanService`/`POST /plan`、`TurnService`/`/harness/events`、DSH `mc_plan`、原子持久化、`wait_for_player`、计划问题复用提案、`ResumeBridge`、`MethodLibrary`、`AnswerMemory`、`MemoryStore`、`Budget`、`verifier`、`draftGuard`、`!state`、`!method`；另：持久 goal（`/goal/pause`/`resume`）、`mc_propose`、`mc_state`、`mc_perception` | **PASS（2026-10-21，M3.1–M3.10）** |
| M4 | manifest 校验、生成管线、candidates/promoted 目录与指针、晋升/回退/下线、promoted-only 检索；2026-10-18 接真实生成、权限子进程试运行、证据、取消、DeepSeek Search、HTTP `/code-skills` | 部分：代码已接，A18–A20 未执行 |
| M5 | `WindowPolicy`（默认拒绝）+ `ComputerUseGuard`（拒绝不触达执行器） | **阻塞**：F1 未验证 |
| M6 | `ConversationState`（去重/过期/自回声/限速/截断）+ opt-in 守卫 + `ChatParticipation` 参与/沉默 + `ProposalChat` yes/no + **DialogueRouter + `mc_say`** | 部分：对话入口已真机，A23–A25 未执行 |
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
| `chat.harnessAgentId` | `""`（未预绑定；由 `/bind` 或 `/goal {agentId}` 绑定 live 对话） |
| `state.enabled` | `true`（A17/A29 测试窗口；`P1_STATE=off` 或改 `false` 可关） |
| `state.path` / `debounceMs` | `runtime/p1-state.json` / `1000` |
| `web.eventsToken` | `""`（仅本机；F3 真机鉴权未执行） |
| `web.testHooks` | `false`（A28 注入需 `P1_TEST_HOOKS=on` 启动） |

## 5. 剩余未交付（以及为什么）

| 项 | 现状 / 下一步 |
| --- | --- |
| M4 A18–A20（代码技能） | 生成/权限子进程/证据/晋升/回退代码已接；真机目标、失败注入与安全验收未执行，需安全评审与授权 |
| M4 A27（代码子项） | 只读/异步子项已通过；候选代码测试调用未执行 |
| M5 F1 / A21 / A22 | F1 未验证（CU 无已授权应用），阶段 BLOCKED；需先建 Full Access Ask CU 对话并授权 java 窗口 |
| M6 A23–A25 | 参与/沉默、提案 yes/no、DialogueRouter 已接；真实多人语料与提案四路径未执行（单操作员模拟需标注） |
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
3. **M4**：先做安全授权/评审，再跑 A18–A20；沙箱规则见 [`P1-M4-SANDBOX.md`](P1-M4-SANDBOX.md)。
4. **M5**：先跑 F1；F1 不通过则 A21/A22 记 N/A，不要开额外在线能力。
5. **M6**：按 40 组语料跑 A23/A24、按四路径跑 A25；单操作员时标注“非真实多人”。
6. 完成一项就回填清单，**未测不填、代码存在不算通过**。

## 7. 代码地图（P1 新增）

```
src/core/      taskEvents, planStore, planService, taskSlot, capabilities, stateStore,
               sessionState, planRunner, turnLifecycle
src/planner/   evaluator, proposals, budget, verifier, draftGuard, planQuestions
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
src/computer/  windowPolicy, guard
src/harness/   adapter, resumeBridge, turnService
dsh-plugin-mc-harness/lib/index.js   11 个 mc_* 工具（observe/step/plan/plan_status/cancel/
                                     finish/state/perception/memory/propose/say）
scripts/       p1-verify, p1-contract-test, p1-m3-test, p1-fault-test, p1-baseline
docs/          P1-M0 … P1-M7, P1-GAP-AUDIT, P1-CLIENT-TESTS
```

## 8. 已知风险

1. **真实模型行为只覆盖已跑场景**：A02 判定、H1a/H1b、M3 动作脑/真机注入已有真实回执；
   语言 agent、多人聊天（A23/A24）、提案措辞（A25）仍未实测。
2. **A30 按操作员口径通过**：success/compress/failure/cancel 可归属；retry 用量在 DSH 执行中
   无法获取，不再取证。
3. **代码技能已接但未验收**：vm 不是安全边界、permission model 无 OS 级网络隔离，
   `subprocess` 仍是高风险能力；A18–A20 未执行。
4. **持久化在测试窗口开启**：A17/A29 已验证等待计划/问题/预算恢复与不重放；
   发布前必须决定保持或回退。
5. **阈值空置**：`/state` 周期、感知成本、聊天节奏、预算数值都未测量（500ms/3 次检索是配置，不是结论）。
6. **两套规划循环**：默认 `off` 关闭自主规划；`legacy` 代码仍在，删除/切换需真机验收。

## 9. 建议顺序

1. **M7 回归**：A26 行走/破坏/拾取/取消/双通道 + R1–R4；同窗口补 F3 token 与 A31 最终组合。
2. **M6**：A23/A24 固定 40 组语料（单操作员需标注）+ A25 四路径。
3. **M4**：安全授权后跑 A18–A20 与 A27 代码子项。
4. **M5**：F1（Full Access Ask + java 授权）→ A21/A22；F1 不过则 N/A。
5. **修复遗留**：挖石 noPath、夜间入睡、A02 timeout、A10 跨维度/部分刷新、A11 天气/阶段注入。
6. 每次改动保持 `npm run p1:verify` 全绿（当前 10/10；`--fast` 9/9）；删除断言必须同提交替换。
