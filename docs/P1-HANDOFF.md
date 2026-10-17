# P1 离线交接（2026-10-17）

> **一句话**：RETIREMENT 已完成；P1 的**离线可交付部分**已实现并通过一键复验；
> **客户端窗口已于 2026-10-17 开始**（协议/登录/寻路/砍树通过，挖石失败），
> **P1 仍未验收、未发布**。已执行项见
> [`CLIENT-TEST-2026-10-17.md`](CLIENT-TEST-2026-10-17.md)；其余真机/模型项仍以
> [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md) 为唯一权威，状态「未执行」。
> 本文是交接入口；逐项证据见 [`P1-M7.md`](P1-M7.md) 的 A01–A31 矩阵。

## 1. 一键复验

```bash
npm run p1:verify          # P0 回归 + planner + contract + fault + audit p1
npm run p1:verify -- --fast  # 跳过 P0 回归（约 2 秒）
npm run p1:baseline -- --suites  # 记录提交/配置指纹/套件结果到 runtime/p1-baseline.json
```

最近一次实测（离线）：

| 套件 | 结果 |
| --- | --- |
| P0 regression（8 suites） | **8/8** |
| `planner:test` | **32/32** |
| `p1:contract:test` | **148/148** |
| `p1:fault:test` | **7/7** |
| `plan:audit --stage p1` | **94/94** |

没有启动 Minecraft、没有调用模型、没有执行生成代码或 GUI 自动化。

## 2. 已交付（按里程碑）

| 阶段 | 关键交付 |
| --- | --- |
| M0 | 基线脚本（提交/配置/jar 指纹）、问题复核、P0→P1 审计迁移、冻结评测集 v1 |
| M1 | `TaskEvents`（seq/幂等/重放）、身份字段与 requestId 贯穿、`PlanStore` 单一写者、同端口 SSE、Capability 表、TaskResult 六态、`mine_ore` progress 值域、`PlanRunner`、`TurnLifecycle`、`HarnessAdapter` |
| M2 | 二值闸门 + `@` 通道（默认关闭）、严格 LLM 判定器、双脑工具清单、`say/silence`、`LanguageAgent`、可选语言对话通道（默认关闭）、快照 `observedAt`、`refreshPlan`、`ThreatObserver`、persona 注入 |
| M3 | 原子持久化（默认关闭）、`wait_for_player`、计划问题复用提案（接受/拒绝/过期）、`ResumeBridge`、`MethodLibrary`（执行反馈 + 检索）、`AnswerMemory`、`MemoryStore`、`Budget`、`verifier`、`draftGuard`、`!state`、`!method` |
| M4 | manifest 校验、生成管线（静态扫描，不执行）、candidates/promoted 目录与指针、晋升/回退/下线、dry-run runner、promoted-only 检索 |
| M5 | `WindowPolicy`（默认拒绝）+ `ComputerUseGuard`（拒绝不触达执行器） |
| M6 | `ConversationState`（去重/过期/自回声/限速/截断）+ LLM 回复 opt-in 守卫（默认关闭） |
| M7 | 故障演练 7/7、A01–A31 矩阵、`p1:verify`、本交接文档 |

## 3. 客户端窗口实测（2026-10-17）

| 项 | 结果 |
| --- | --- |
| `client:verify`（模组协议） | **23/23 PASS** |
| `client-real --login`（登录+谨慎寻路） | **7/7 PASS**，服务器确认 `Вход успешен` |
| `client-real --primitives` | 砍树 PASS；**独立 mine 2/2（库存 +2）PASS**；`--dig stone` 前置点位失败；一次复测因死亡/空背包无效 |
| Agent 自动 AuthMe 登录 | 首次失败（探针早于 ChatListener 首轮播种）；修复后 **PASS**，未发 `/register` |
| A01 面板 `!status` / 非法 `!mine` | PASS：3ms、模型 tokens 0→0、明确 usage |
| `/state` 空闲 | p50 43.8ms / p95 64.9ms（30 次，1.79MB，63,257 cells） |
| F1 CU 限窗 | **未执行**：helper 无已授权应用，读取 java 窗口被拒 |

**夜间安全**：`client-real` 在寻路/采集前检查时间（优先 `isDay`），夜里找床睡觉；
无床/走不到则中止。运行 Agent 时夜里用 `!sleep`。实测：门禁会中止；入夜入睡待床可达。
`--dig stone` 的前置检查在无石点位会失败；独立 `mine` 已 2/2 通过。

证据：`runtime/logs/client-verify-2026-10-17.log`、`client-real-login-2026-10-17.log`、
`client-real-primitives-2026-10-17.log`、`agent-authme-final-2026-10-17.log`、
`state-idle-2026-10-17.json`；摘要见 [`CLIENT-TEST-2026-10-17.md`](CLIENT-TEST-2026-10-17.md)。

## 4. 默认配置（未改变现网行为）

| 配置 | 默认 |
| --- | --- |
| `planner.mode` | `legacy`（S4 已删 `pickRule`；切 `proposals` 待语言脑接管） |
| `chat.addressedPrefix` | `null`（`@` 通道关闭） |
| `chat.gateTimeoutMs` | `1500` |
| `chat.languageAgent` | `false` |
| `chat.conversationGuard` | `false` |
| `state.enabled` | `false` |
| `state.path` / `debounceMs` | `runtime/p1-state.json` / `1000` |
| `web.eventsToken` | `""`（仅本机） |

## 5. 未交付（以及为什么）

| 项 | 原因 / 下一步 |
| --- | --- |
| 挖石路径（真机） | 独立 `mine` 已 2/2 PASS；`--dig stone` 前置检查需调整点位/顺序 |
| 夜间睡眠（真机） | 门禁生效（无床/走不到会中止）；实际入睡尚未成功，需床可达时重试 |
| 真实 harness 传输与插件 | 需要 DSH/Codex 宿主接线与单独批准；适配器/回合/续轮桥已就绪 |
| 真实模型判定与语言行为 | 需要模型端点/预算与客户端窗口；契约与 stub 已就绪（A02+ 未执行） |
| 代码技能真实生成/试运行/受限执行 | 需要编码后端与 A19 安全边界评审；当前只做静态检查与 dry-run |
| GUI/CU 闭环 | F1 未验证（helper 无授权应用）；F1 不通过则 CU 标 N/A |
| 联网搜索/学习 | 需要搜索/模型预算；本地方法/记忆已就绪 |
| 真机持久化重启恢复 | A17/A29 未执行；默认关闭 |
| 多人聊天观察 | A23/A24 未执行；状态机与规则已就绪 |

## 6. 客户端窗口怎么开始

1. 先读 [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md)（唯一权威清单），按 M0-C1/C2/C3 → F1/F2/F3 →
   A 类顺序执行；每项记录版本、账号、种子、日志/截图路径。
2. 执行前确认默认配置未被改动（§3），需要开启的开关逐项打开并在证据里注明。
3. F1 不通过：CU 保持 N/A，不要开 `chat.addressedPrefix` 之外的任何在线能力。
4. 完成一项就把结果回填清单，**未测不填、代码存在不算通过**。

## 7. 代码地图（P1 新增）

```
src/core/      taskEvents, planStore, taskSlot, capabilities, stateStore, sessionState,
               planRunner, turnLifecycle
src/planner/   evaluator, proposals, budget, verifier, draftGuard, planQuestions
src/chat/      commandGate, addressedHandler, conversation, languageDialogue
src/llm/       judge, toolSurface, languageAgent
src/world/     freshness, refreshPlan, threatObserver
src/learning/  methodLibrary, answerMemory
src/memory/    store
src/codeSkills/ manifest, store, catalog, runner, generator, directory
src/computer/  windowPolicy, guard
src/harness/   adapter, resumeBridge
scripts/       p1-verify, p1-contract-test, p1-fault-test, p1-baseline
docs/          P1-M0 … P1-M7, P1-GAP-AUDIT, P1-CLIENT-TESTS
```

## 8. 已知风险

1. 真实模型行为未测：判定器/语言 agent/对话通道只有 stub 回执。
2. 真实宿主未接：`TurnLifecycle`/`ResumeBridge` 是契约，不是运行中的 DSH 会话。
3. 代码技能闭环缺后半段：无编码后端、真实试运行与受限执行。
4. 持久化默认关闭且未经真机重启验证。
5. 所有阈值（`/state` 周期、感知成本、聊天节奏、预算）都未测量；500ms/3 次检索是配置，不是结论。

## 9. 建议顺序

1. **先修挖石 noPath**（本次唯一硬失败）：指定地表矿点/下挖入口复现，抓 `path-trace` 对应记录。
2. 客户端窗口剩余项：M0-C1 的移动/挖矿/反射/GUI 负载 → F1（需先授权 java 窗口）→ A02。
3. 通过后再接真实 harness 传输与受限执行（需单独批准）。
4. 每次改动保持 `npm run p1:verify` 全绿；删除断言必须同提交替换。
