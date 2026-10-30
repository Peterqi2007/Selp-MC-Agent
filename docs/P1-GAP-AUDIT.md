# P1 全文差距审计（2026-10-17，2026-10-22/10-25 增补，2026-10-29 口径变更）

> 目的：对照 [`P1-PLANNER-PLAN.md`](P1-PLANNER-PLAN.md) §1.4–§1.9，逐节列出**已落地 /
> 仅契约 / 未开始**，并给出离线可继续的优先级。本文不改变任何验收结论：真机/模型项
> 以 [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md) 为准（2026-10-22 已按实际执行回填）。
> 当前一键离线验收：`npm run p1:verify`（见 [`P1-M7.md`](P1-M7.md)）。
>
> **2026-10-18 更新**：`P1-M3.md` 的 live 入口已接（PlanService/`POST /plan`、TurnService/
> `/harness/events`、DSH `mc_plan`、持久化测试窗口开启）。
>
> **2026-10-22 增补**：本文 §1 是 2026-10-17 的快照，其中“未接动作脑/未接真实 harness/
> 真机未执行”等结论已被后续证据覆盖。**以本节为准**：
>
> | 审计要点 | 2026-10-22 现状 |
> | --- | --- |
> | §1.5.3 观察契约 | `ObservationCache` + `mc_state(fields)` 已接入动作脑（2026-10-20） |
> | §1.6.2 学习入口 | 语言脑 `web_search` 与行为脑 `lookup_mod_content` 均真机通过；A16 同条件复用/重查/网页对抗通过（2026-10-21） |
> | §1.7.2 受限执行 | 权限子进程试运行/超时/取消/清理已接（`p1:m4:test 35/35`）；v2 直接原语 A18–A20 真机通过（A19 适用子集） |
> | §1.7.3 / §1.9 双脑与 harness | DSH 插件 15 工具（14 个 `mc_*` + `lookup_mod_content`）已加载并真机跑通（H1、A13–A17、A27–A30、F2） |
> | §1.8.1 / §1.8.3 CU | `WindowPolicy`/`ComputerUseGuard` 仍只有离线拒绝语义；F1 BLOCKED（历史，2026-10-29 已被取代：改进程内输入层 + F1'） |
> | 真机验收 | M1（适用子集）/M2/M3/M4（A19 适用子集）PASS；A02/A03/A06/A09–A17/A18–A20/A27–A30 有真机证据；A24/C03/F02 受控 PASS、A25 四路径（accept 真 harness）、A23 仅 6 条真实沉默；A21–A22、A23 的 40×3、A25 三条真实提案、A31 最终组合、R1–R4、F3 未执行 |

> **2026-10-24/25 增量**：M6 受控测试完成——A24/C03/F02 受控 PASS（发送者由测试钩子合成）、
> A25 四路径（accept p14 为真实 action-brain 提案，reject/不答/另派由 `/test/proposal-plant` 植入）、
> A23 仅真实玩家 6 条全沉默（40 组 ×3 未执行）；M1-A01、M2 八项、M3 四项语言脑补充回归 PASS。
> **M4 真机（2026-10-25）**：编排子集（read_state/submit_task/chat/wait）一度 PASS，
> A18/A19/A20/A27 代码 + A28–A30 编码回合有真机证据；同日需求变更：生成代码必须直接读
> `/state` 并移动/挖掘/点击，M4 重开。v2 实现后（离线 35/35）完成 **A18–A20、A28–A30 真机 PASS**
> （A19 适用子集：越界/抢身体/取消/deny/无屏点击/非敌对攻击/硬杀；残余 PauseScreen/第二玩家仅离线）。
> 方案 [`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md)。
> 阶段判定：**M4 PASS（A19 适用子集）、M6 PARTIAL、P1 未发布**。详见
> [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md)、[`M4-CLIENT-TESTS.md`](M4-CLIENT-TESTS.md) 与
> [`M6-A25-CLIENT-TESTS.md`](M6-A25-CLIENT-TESTS.md)。

> **2026-10-29 增量（M5 口径变更 + CU 放弃）**：M5 的执行底座从 OS 级 `computer_use` 改为 Minecraft **进程内输入层**
> （mod 在游戏进程内注入按键/视角/槽位点击 + 帧缓冲截图，经 HTTP 交 Node；Node 持有唯一身体执行权与键鼠台账）。
> **CU 路径已放弃（ABANDONED）**：WGC 取不到 OpenGL 窗口帧、`WindowPolicy` 接不进只读打包插件，两项均不可控；
> `src/computer/*` 与契约测试只作历史证据保留（[`CU-ABANDONED.md`](CU-ABANDONED.md)）。
> 原闸门 **F1 作废**，改 **F1'a（结构性不可出界）/F1'b（键鼠台账）**；**A21/A22 不再标 N/A**（命题不变、证据重记）。
> **输入层已实现并真机验证输入/截图/GUI 链路**（`p1:m5:test 35/35`、`m5-gui-live 93/93`）；**A21 部分通过**
> （探针直连 mod、未走技能层）、**A22/M5.3 未执行**、**F1'b 的暂停/死亡/断连/退出注入未跑完**，**M5 仍未通过**。
> 完整口径见 [`P1-M5.md`](P1-M5.md) §7/§8。

## 1. 逐节状态

状态口径：
- **已落地**：有实现 + 离线断言，默认配置可回退；
- **部分**：有契约/一半接线，或默认关闭、未接真实输入；
- **仅契约**：只有数据结构/校验，没有执行路径；
- **未开始**：无实现。

| 节 | 要求 | 状态 | 证据 / 缺口 |
| --- | --- | --- | --- |
| §1.4.1 | 身份链 + 六态结果 | **部分** | Task 有 `taskId/requestId/planId/stepId`、`attemptId`、六态；**提案→任务、hub→事件已带 requestId**；普通命令入口仍未普遍填 requestId |
| §1.4.2 | 唯一身体执行权 | **已落地** | `TaskSlot` 单一 owner、hub 接管等待、`p1:fault:test` 9/9 |
| §1.4.3 | 任务闭环/部分完成/后置验证 | **部分** | 六态、超时、事件；**步骤后置验证刚接入 PlanRunner**；TaskHub/长技能结果尚未统一 |
| §1.4.4 | 事件汇聚/SSE/planVersion 单一写者 | **已落地（离线）** | `TaskEvents`、`/events` 重放、`PlanStore` stale；真机 SSE 未验 |
| §1.5.1 | 感知证据边界 | **已落地（文档）** | M0 基线、问题复核、测量模板 |
| §1.5.2 | 按用途采集/分频 | **部分** | `refreshPlan` 按预算/关键字段给出待刷新集合；**Mod 采集边界与真机测量未做** |
| §1.5.3 | 观察契约/缓存/订阅/最小威胁观测 | **已落地（2026-10-20）** | `ObservationCache` per-field observedAt/revision/dimension/source/area、TTL single-flight、失败 stale、维度/死亡/断线失效；已由 `mc_state(fields)` 接入动作脑；反射边沿走 `PerceptionWake`/`mc_perception` |
| §1.6.1 | 分类记忆 | **部分** | `MemoryStore` 三类 + 中文 unigram/bigram 检索 + 持久化；`ChatMemory` 持久化聊天 save/grep/context/compact；task/plan 终态写 episodic；`/memory` + `mc_memory` 显式共享给行为脑；尚未驱动规划决策 |
| §1.6.2 | 两个学习入口（搜索/指导） | **已落地（真机通过）** | 方法库/回答记忆 + 计划执行回写 + `suggestMethod`/`!method`；语言脑 `web_search`（无首选）与行为脑 `lookup_mod_content`（MC百科优先）均真机通过；A16 验证同条件复用不联网、不同物品重查、网页按不可信处理 |
| §1.7.1 | 代码技能目录/生命周期 | **已落地（真机 2026-10-25）** | manifest、目录布局（candidates/promoted + 指针）、晋升/回退/下线、promoted-only 检索；真实生成→试运行→晋升→实时派发已真机；**v2 直接原语技能 A18 真机 PASS** |
| §1.7.2 | 受限执行/后置验证/隔离 | **已落地（v2 真机，A19 适用子集）** | 权限子进程 + 超时/取消/清理 + 证据（`p1:m4:test 35/35`）；vm/OS/覆盖内置/失联/清理已测；**直接 `body_*`、有界 read_state、slot 租约/中断已实现**；A18–A20、A28–A30 真机 PASS（A19 残余 PauseScreen/第二玩家仅离线）；方案 [`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md) |
| §1.7.3 | 动作脑工具面/语言脑收窄 | **已落地（2026-10-17）** | 两套清单、`say/silence`、语言 agent、可选对话通道、persona 注入；M2 真机确认语言面无 body 工具 |
| §1.8.1 | CU 观察—动作闭环 | **已变更：CU 已放弃；进程内输入层已落地** | 原 CU 契约 `WindowPolicy` + `ComputerUseGuard` **标为 ABANDONED**（只作历史证据）；新路径的按键/视角/槽位点击/帧缓冲截图已实现并真机验证（模组 `key/hold/tap/look/shot` + Node 命令面；[`P1-M5.md`](P1-M5.md) §8） |
| §1.8.2 | CU 中断与复用 | **部分（新路径：键鼠台账 + 释放语义）** | `InputLedger` 已实现：按下集合可枚举、长按 ≤10s 双上限、`Holds` 的 dead/paused/owner-stop/task 全部 `releaseAll()`、`sync()` 与 `/state.input` 对账；真机已验证 `stop`/长按到期归零；**暂停/死亡/断连/退出四类故障注入未跑完**（[`P1-M5.md`](P1-M5.md) §8.4） |
| §1.8.3 | F1 可行性闸门 | **F1 作废；F1' 部分验证** | F1（CU 限窗）2026-10-29 作废。F1'a 结构性断言（`p1:m5:test` 35/35、仓库无 OS 级输入/截屏符号）+ F1'b 契约与部分真机已过；**不通过则实现不得合并，无 N/A 出口**（[`P1-M5.md`](P1-M5.md) §7.3/§8） |
| §1.9.1–1.9.4 | harness 选型/接口/接入边界 | **已落地（插件真机）** | `HARNESS-INTERFACES.md`、`P1-M0.md`、`DSH-HARNESS.md`；DSH 插件 **15 工具**（14 个 `mc_*` + `lookup_mod_content`）已加载并真机跑通（H1/A13–A17/A27–A30/F2） |

## 2. 离线可继续的优先级

> **2026-10-22 注**：下表是 2026-10-17 的优先级快照。其中的 P0 两项（感知盖章、requestId 贯穿）、
> 目录落盘、步骤后置验证、persona、方法检索与真实 harness 均已完成；剩余项见 §4。

| 优先级 | 事项 | 为什么离线可做 | 落在 |
| --- | --- | --- | --- |
| **P0** | 感知快照接线 `observedAt`（构建快照时盖章、只读契约） | 纯数据层，可注入时钟；为 A09/A10 的代码半边 | M2 |
| **P0** | `requestId` 贯穿入口（命令/提案/计划→任务） | 身份链已在事件里，缺来源传递；可离线断言 | M1/M3 |
| **P1** | 候选/正式目录的真实文件布局 + 原子写入 | 不执行代码；可测目录/哈希/晋升落盘 | M4 |
| **P1** | 步骤后置验证接入更多入口（TaskHub 长技能） | 复用 `verifyStep`，可注入观察 | M3 |
| **P2** | 语言 agent 的 persona 指令注入 | 纯提示词拼装 + stub 断言 | M2/M6 |
| **P2** | 方法检索接入规划（只读建议） | 本地库，不接模型 | M3 |
| **需批准** | 真实 harness 传输/插件 | 需要宿主/端点与审批；客户端清单外 | M3 |
| **需批准** | 代码技能受限执行 | 安全敏感，需 A19 边界评审与真机 | M4 |
| **客户端** | GUI/键鼠（进程内输入层）、真实模型判定、多人聊天、重启恢复 | 必须在客户端窗口执行 | M0/M2/M5/M6 |

## 3. 与验收矩阵的关系

本审计不改变 [`P1-M7.md`](P1-M7.md) 的 A01–A31 矩阵。**2026-10-29 现状**：M1（适用子集）/M2/M3/M4（A19 适用子集）已通过；
A02/A03/A06/A09–A17/A18–A20/A27–A30 有真机证据（A19 适用子集）；A01/A26 部分；**A08 口径**：M1 适用子集已 PASS（运行中 `mine dirt` stop 816ms、current 清空），但死亡/断线/人工接管/按键释放未测，故 A08 整项仍记“部分”——两处不矛盾，见 [`P1-CLIENT-VERIFICATION.md`](P1-CLIENT-VERIFICATION.md) §M1.5 与 [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md) A08 行；
v2 直接身体原语已实现（`p1:m4:test 35/35`），A18–A20/A28–A30 真机 PASS；
A24/C03/F02 受控 PASS、A25 四路径（accept 真 harness）、A23 仅真实玩家 6 条沉默；
**A21 部分通过**（2 类 GUI ×3、93/93，探针直连 mod、未走技能层）；**A22、M5.3、F1'b 四类故障注入未执行**；
A23 的 40×3、A25 三条真实提案、A31 最终组合、R1–R4、F3 未执行。
上表的“已落地”只表示实现与夹具齐全，不代表未执行项的真机/模型验收。

## 4. 下一步建议

1. 离线侧已完成 10-17 审计的 P0 两项（感知盖章、requestId 贯穿）；剩余离线债按 `p1:verify` 维持全绿。
2. 真机侧：**M4 直接身体原语**（[`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md)）、
   **M5 F1'/A21/A22**（进程内输入层；F1 已于 2026-10-29 作废）、
   **M6 A23 的 40 组 ×3 与 A25 三条真实提案**（A24/C03/F02 已受控通过）、
   **M7 A26/R1–R4/F3/A31 最终组合**。
   按 [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md) 逐项执行。
3. 未批准前保持当前默认配置（`planner.mode=off`、`state.enabled=true` 仅测试窗口）。
