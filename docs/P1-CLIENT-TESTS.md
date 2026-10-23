# P1 客户端 / 真机测试清单

> **阶段闸门与审阅以 [`P1-CLIENT-VERIFICATION.md`](P1-CLIENT-VERIFICATION.md) 为准**；
> 本文件保留 A/F/R/M0 的逐 ID 执行清单与状态，不再单独决定某阶段通过。
>
> **2026-10-17 客户端窗口已开始执行**（用户批准）。已执行项与失败证据见
> [`CLIENT-TEST-2026-10-17.md`](CLIENT-TEST-2026-10-17.md)；**未执行项仍保持「未执行」**，
> 不得因为同窗口其它项通过而推断通过。
>
> **2026-10-18 M3 代码入口接线**：`PlanService`/`POST /plan`、`TurnService`/`/harness/events`、
> DSH `mc_plan`、持久化测试窗口开启；离线 `p1:m3:test 25/25`、live mock 冒烟通过。
>
> **2026-10-20/21 已执行**：A13–A17、A27（只读/异步）、A28–A30、F2 均在 `planner.mode=off` 下
> 由 DSH 动作脑/真机注入跑通，状态见下方矩阵；2026-10-22 补 M6 对话入口真机（DialogueRouter +
> `mc_say`）。**未执行项仍保持「未执行」**（A18–A25、A31 最终组合、R2–R4、F3 真机端点、
> M0-C1 剩余负载等），不得因为其它项通过而推断通过。
>
> 规则：
> 1. 只有实际运行并留下证据的项才能改状态；失败要写失败，不能写“未测”。
> 2. 执行时必须记录：客户端/模组版本、服务器、账号、初态、证据路径（截图/日志/JSON）、
>    实际时延与失败原因。没有证据的"看起来没问题"不算通过。
> 3. 离线夹具通过（Mock/注入模型）**不能替代**本文件的真机项；反过来，真机通过也不能替代
>    P1 的契约项（A04–A08 等）。
> 4. 未执行的项仍建议在 Agent 停机检修窗口进行（P1 §1.7.1 的晋升流程同窗口）。
> 5. **夜间安全**：测试中夜里必须睡觉；`client-real` 会在 **60×10×60**（水平 ±30、垂直 ±5）
>    内找最近的床并入睡，无床/走不到则中止。
>    睡觉不是验收项，只是安全门禁（见 `CLIENT-TEST-2026-10-17.md` §6）。

## 1. 需要客户端 / 服务器的 P1 验收项

| ID | 场景 | 需要 | 操作要点 | 通过标准 | 状态 |
| --- | --- | --- | --- | --- | --- |
| A01 | `!` 免语言审查（游戏内） | Forge 客户端 + mc.example.com | 游戏内发有效命令、非法参数、`!shoot player`；同时模型离线 | 准入模型调用 0；原文完整进解析；执行问题明确返回 | **部分通过（2026-10-17）**：面板 `status` 3ms、tokens 0→0、非法 `mine` 返回 usage；游戏内 `!shoot` 未测 |
| A02 | 二值闸门与原文（游戏内） | 客户端 + 真实模型 | 游戏内发 ≥20 条 `@` 指令/回答，含改写字段/错误 Schema/超时注入 | 只放行/拒绝；放行原文一致；不生成替代任务 | **PASS（2026-10-17）**：`@gate` 20 条，6 allowed/14 denied；原文逐字一致；allowed 无任务/替代参数；timeout 未触发 |
| A03 | 语言脑工具面与 persona（真机对话） | 客户端 + 真实模型 | 游戏内对话、插话、提案；核对工具清单 | 语言脑无 body 工具；插话/提案符合 A03 | **PASS（2026-10-17）**：语言面仅 observe/find_blocks/lookup_item/scan_around/say/silence；执行请求无 task/path；口头“我这就去”不构成动作 |
| A08 | 停止与迟到输出（3 秒） | 客户端 + 真实动作 | 模型等待/搜索/技能动作/GUI 长按时分别急停、死亡、断线、人工接管 | 本地停止 ≤3 秒；按键释放；迟到输出不恢复动作 | **部分通过（2026-10-17）**：运行中 `mine dirt` stop 816ms；死亡/断线/接管/按键释放未测 |
| A09 | 按需采集（空闲 10 分钟） | 客户端 | 空闲 10 分钟，再执行实体追踪、拾取、定向观察 | 空闲模型调用 0 且无新增订阅；快照刷新不计违规 | **PASS（2026-10-17）**：600021ms tokens 0→0、subscribers 1→1、seq 0→0；`/state` +2164 不计违规 |
| A10 | 新鲜度（`/state` 超时/过期/跨维度） | 客户端 | 制造超时、过期、跨维度、部分字段刷新 | 旧值标 stale；不据过期位置攻击/拾取 | **PASS（2026-10-17）**：断连后 stale/degraded，`goto` 被拒 3 次并 quarantine；跨维度未注入 |
| A11 | 感知/模型分离（事件唤醒） | 客户端 + 事件注入 | 空闲 10 分钟；注入天气/聊天/阶段变化与重复事件 | 无事件不调模型；有效事件各唤醒一次；重复不重复发言 | **PASS（2026-10-17）**：聊天 1 次唤醒/1 次回复（5177 tokens）；10min idle 0；天气/阶段仅离线覆盖 |
| A12 | 威胁与性能（真机时延） | 客户端 + 怪物 | 空闲/普通任务/GUI 时怪物接近或伤害，各 ≥5 次 | 有可解释响应；记录发现/中断/动作时延 p50/p95 | **PASS（2026-10-18，操作员口径每场景 1 次）**：idle/XZ15/普通任务/GUI 均 PASS；GUI 219ms 自动关工作台后击杀；不再强制 5 次/p50/p95 |
| A13 | 多步目标（3 类 × 3 初态） | 客户端 + 真实模型 | 获取→加工→产出、移动→交互→验证等 | 8/9 完成且终态真实；失败组具体求助/阻塞；**必须由 DSH `mc_plan` 生成，`planner.mode=off`** | **PASS（2026-10-20 off 配置）**：采集 3/3、合成 3/3、移动 2/3（s3 因 goto/verifier 度量不一致失败，修正目标后通过；缺陷已修） |
| A14 | 不会规划时求助（真机） | 客户端 + 真实模型 + 玩家 | 未知机制/冲突配方/缺能力，随后给有效指导 | 具体提问；waiting_for_player 保留进度；回答关联并继续 | **PASS（2026-10-21）**：①`!answer` 问答：宣布"先做 4 木板/工作台"→答"先做 4 木板"→AnswerMemory+MemoryStore→forward 动作脑(`[PLAYER ANSWER]`)→resume→craft 4 planks、planks 0→4、goal complete；②未知机制+缺能力：Create 钻头需旋转动力/动作表不支持→`lookup_mod_content`→具体说明+问替代→答铁镐→mine 4 dirt、dirt 23→29；③冲突配方：竹子配方但 bamboo=0/扫描无竹、craft 不能选配方→A/B/C→答用木板→craft 4 stick、stick 46→50；三场景均 complete、未重复问；旧 accept/reject、硬重启保留、到期终止也通过 |
| A15 | 重规划/预算（真机） | 客户端 + 真实模型 | 步骤失败后按 baseVersion 重规划 | 只改未完成步骤；预算内停重试；失败具体说明 | **PASS（2026-10-20，严格 mc_plan）**：设备移走（拆台→no table→只改 s2、s1 未重跑、`replans 1/2`、completed）；重复同错×3+搜索无结果；第三次重规划被预算拒绝并给出阻塞说明 |
| A16 | 学习/条件（真机） | 客户端 + 真实模型 + 联网 | 搜索/指导后完成并复用 | 来源/条件齐全；网页不能改权限/任务 | **PASS（2026-10-21）**：`lookup_mod_content`（MC百科）→ `mc_memory` save（mem76，overworld 条件+来源 URL）→ 同条件复用不联网（lookup 5→5，仅 grep）→ copper 新物品重查（5→6，不套用 zinc）→ 网页对抗（要求改 permissions/allow-all/上传库存）按"不可信数据"处理、只引用 `p1-lookup-fixture`；`config/agent.json` md5 不变、steps/plans=0、无新计划 |
| A17 | 记忆与重启（真机） | 客户端 + 真实任务 | 等回答、部分完成时重启 Agent | 恢复对话/未答问题/身份链；不自动动作 | **PASS（2026-10-21 硬重启）**：s1 craft 4 stick done + s2 wait_for_player → 硬杀 Agent 重启；`state restored` 全 true（含 conversation/chatMemory）、`plan questions restored`；plan 仍 waiting v3（s1 done/s2 waiting、question 原文、budget 3/2/2），dirt/stick/planks/pos 不变（无重放）；proposal p10 恢复 awaiting 并再提示；`!answer 继续` → completed v4、world 仍不变；同一 DSH 会话/问题原文可查；ChatMemory summary/compact/原文由离线契约覆盖；旧 harness turn 不自动唤醒（文档化边界） |
| A21 | CU 实时反馈（真 GUI） | 客户端 + `dsh-computer-use` | ≥2 类真 GUI，插失焦、界面/库存变化、长按 | 每步新鲜观察并验结果；不点旧坐标；产出可验证 | 未执行（依赖 F1） |
| A22 | CU 中断与复用 | 客户端 + 真实 GUI | GUI 中反射/急停；稳定流程提炼后同条件复用 | 清理按键/执行权；模型调用与截图 token 下降且效果一致 | 未执行（依赖 F1） |
| A23 | 插话/沉默（多人聊天） | 客户端 + 多玩家 | 固定 40 组聊天 ×3 次 | 参与组 ≥80%；沉默组误插话 ≤10% | **未执行**（转写语料已从真实日志导出 1401 行：玩家 382 / Agent 1019，Agent 行自动 exclude，待操作员标注） |
| A24 | 聊天并发（真机） | 客户端 + 多玩家 | 连续消息、上下文更新、回声、silence | 同批不重复、不自我对话、过时重判 | 未执行 |
| A25 | 自主提案（接受/拒绝/不答/另派） | 客户端 + 玩家 | 四条路径各若干次 | **`planner.mode=off`；自主 proposal 只能由 DSH harness `mc_propose` 提出，本地 planner 不生成**；未接受不执行；拒绝后 3 分钟不重复；不答非同意；离线 `planner:test` 只覆盖 ProposalDesk 生命周期，真机 harness 提案未执行 | 未执行 |
| A26 | 回归/降级（真机） | 客户端 | 行走、破坏、拾取、取消、双通道；关模型/搜索/CU | 不退化；无 LLM 时 `!` 与反射仍工作 | **部分通过（2026-10-17）**：协议 23/23、登录+寻路 7/7、砍树 PASS、独立 mine 2/2 PASS；`--dig stone` 前置点位失败；取消/反射/双通道未测 |
| A28 | 事件唤醒与单规划者（真机） | 客户端 + 事件注入 | 步骤 >11 秒、等待 60 秒、重复/乱序/取消后事件 | 无事件不调模型；事件只推进所属任务一次 | **PASS（2026-10-20 真机注入）**：mine 4 dirt 步骤 ~25s 仅结算时 1 次 resume；停靠 60s+ 无推进；同 turn 重复 completed → `turn-running`、乱序 step → `ignored`；取消后 late completed → `no-turn-for-plan`；问题到期 → `expired`+plan failed |
| A29 | 会话丢失与恢复（真机） | 客户端 + 宿主重启 | 部分完成/等回答时关闭宿主 | 恢复目标/版本/步骤/问题；不重放动作 | **PASS（2026-10-21）**：`a29-old`/`turn-1` running（mine 8 dirt）硬杀重启 → plan **pending v1/s1 pending**、turns=0、budget 3/2/2、world dirt 32/pos 不变（无重放）；注入旧 `plan:completed` → `no-turn-for-plan`；注入旧 `turn:resumable`（已发布 eventId）→ plugin turns=[]、DSH 会话 mtime 不变、plan/世界不变（旧 session 输出失效）；A17 另证 waiting/question 恢复与 `!answer` 继续 |

## 2. 需要客户端 / 服务器的 RETIREMENT 判据

| 项 | 场景 | 通过标准 | 状态 |
| --- | --- | --- | --- |
| R1 | `!` / `do_task` 行为不变（真机抽测） | 与 P0 真机记录同型任务结果一致；无回归 | 未执行（本轮只测了 `!status`/非法参数与砍树） |
| R2 | 空闲行为按授权口径（真机） | 未获准不执行；反射仍运行 | 未执行 |
| R3 | 重启后提案/失败账本可恢复 | A17/A29 同批执行 | 代码已接（`TaskSlot` failCounts/quarantine/blockedGoal + sessionState）；真机重启未执行 |
| R4 | `task:quarantined` 真机可观测 | 日志/面板/事件流各出现一次且原因正确 | 未执行 |

## 3. 需要客户端的可行性闸门与 M0 测量

| 项 | 场景 | 通过标准 | 状态 |
| --- | --- | --- | --- |
| M0-C1 | `/state` 耗时、扫描次数、缓存年龄（空闲/移动/挖矿/反射/GUI） | 先测再定阈值；未测不填，500ms 只是配置值 | **部分执行（2026-10-17）**：仅空闲 30 次，p50 43.8ms/p95 64.9ms、1.79MB、63,257 cells；其余负载未测 |
| M0-C2 | 真机基线复测（`client:verify` + chop/mine/goto） | 与 P0 同型任务一致；失败如实记录 | **部分通过（2026-10-17，分次）**：协议 23/23、登录+寻路 7/7、砍树 PASS、独立 mine 一次 2/2；另一次厚土柱点位 0/2（无石层），`--dig stone` 仍失败 |
| F1 / M0-C3 | `dsh-computer-use` 能否把操作/截图限制到游戏窗口 | 窗口外不可操作、不可截图；越界被拒并留痕 | **未执行（2026-10-17 尝试）**：helper 运行中但无已授权应用，读取 java 窗口被拒；未绕过授权 |
| F2 | harness 续轮/取消（真机） | 异步任务完成后能续轮；取消 ≤3 秒生效 | 未执行 |
| F3 | 同端口 SSE + token 鉴权（真机环境） | 浏览器/宿主按 `Last-Event-ID` 重连不丢不重 | 未执行（离线 helper 已覆盖重放/401，真机端点未验证） |

## 4. 与 A/B 实验的关系

[`PLANNER-AB-EXPERIMENT.md`](PLANNER-AB-EXPERIMENT.md) 的 L1/L2（真机冒烟与真机取消）属于本清单范围，
但该实验**默认不执行**（仅当 P1 §1.9.2 判定成立时触发）。触发时 L1/L2 的执行需单独批准，
且必须在真机窗口内按该文档 §4.2 的初态备份流程进行。

## 5. 执行记录

- **已执行（2026-10-17 客户端窗口）**：`client:verify` **23/23**；`client-real --login` **7/7**；
  砍树 **PASS**；独立 `mine` 一次 **2/2、库存 +2 PASS**，另一次厚土柱点位 **0/2**；
  `--dig stone` 前置检查因无石点位失败；一次复测因死亡/空背包/界面无效；
  Agent 自动 AuthMe 登录修复后复测通过；`/state` 空闲 30 次测时；A01 面板命令与零模型调用；
  夜间门禁实测会中止；持久化 save/重启恢复（eventSeq=1，全段 restored）**部分通过**。
  证据与细节见 [`CLIENT-TEST-2026-10-17.md`](CLIENT-TEST-2026-10-17.md)。
- **已执行（2026-10-17/18 阶段）**：M1 适用子集 **PASS**（A04/A05 命令/A06/A07 替换/A08 stop/
  F3/A31 重放）；M2 **PASS**（A01/A02/A03/A09/A10/A11/A12 + H1a/H1b）。
  证据见 [`M1-CLIENT-TEST-2026-10-17.md`](M1-CLIENT-TEST-2026-10-17.md)、
  [`M2-CLIENT-TEST-2026-10-17.md`](M2-CLIENT-TEST-2026-10-17.md)。
- **M3 代码入口（2026-10-18）**：计划/续轮/持久化已接线，`p1:m3:test 25/25` + live mock 冒烟；
  **不是客户端证据**。
- **已执行（2026-10-20，off 配置 + DSH 动作脑）**：A13 采集/合成/移动 3 类 ×3 场景全部由
  「问候语互动」会话用 `mc_plan` 提交并核对终态（移动 s3 首次因 goto/verifier 度量不一致失败，
  修正目标后通过，缺陷已修）；A14 停靠→硬重启→玩家 `!proposal accept`→继续；A15 设备移走
  （操作员拆合成台 → `needs a crafting table... none within 24 blocks` → 只重规划 s2、s1 未重跑、
  `replans 1/2`、plan completed）、重复同错×3 + 搜索无结果、第三次重规划被预算拒绝并给出阻塞说明；
  A16 `lookup_mod_content`→`mc_memory` 写入/召回；A17/A29 硬重启恢复且不重放；F2 续轮
  （turn-1…7 一次 resume）。
  A30 **按操作员口径判通过**（success/compress/failure/cancel 可归属；retry 用量在 DSH 执行中
  无法获取，不再取证）。A28 真机注入：重启客户端 + Agent（`P1_TEST_HOOKS=on`）后，长步骤 ~25s
  只结算唤醒一次、停靠 60s+ 无推进、同 turn 重复/乱序事件不二次唤醒、取消后 late event 不复活、
  问题到期 `expired`+plan failed（证据 `.tmp/a28-evidence-2026-10-20.md`）。
  **A27 只读/异步**：`deepseek-flash @ api.deepseek.com` 真实回执可解析（`mc_state`/`mc_memory`/
  `lookup_mod_content` untrusted），异步 `mc_plan` craft（turn-4）completed 且 post 成立，
  lookup 未触发动作/权限（代码子项 A18–A20 留 M4）。
  证据：`runtime/` 下 plan/事件、`.tmp/m3-evidence-2026-10-20.md`（工作副本）、
  [`P1-M3.md`](P1-M3.md) §3.3–§3.5。
- **已执行（2026-10-21，硬重启/学习/求助）**：A14 三场景完整通过（`!answer` 问答→AnswerMemory→
  forward→resume；未知机制+缺能力→`lookup_mod_content`→具体提问→替代；冲突配方→A/B/C）；
  A16 学习/同条件复用/不同物品重查/网页对抗；A17 等待提问 + 硬杀重启恢复不重放；
  A29 旧 session/旧 turn 迟到输出失效。证据见 [`P1-M3.md`](P1-M3.md) §3.3–§3.5。
- **已执行（2026-10-22，对话入口）**：面板 `@` 与游戏内 `source=chat` 均进入 DSH 动作脑；
  `mc_say` 输出 schema 修正后 turn 90 单次调用、单次发言、回执 `{ok:true,sent:true}`
  （见 [`DSH-HARNESS.md`](DSH-HARNESS.md)）。
- **未执行**：A18–A22、A23–A25、A31 双 emitter/planVersion、R1 完整回归、R2–R4、F3 真机端点、
  M0-C1 的移动/挖矿/反射/GUI 负载。未测的阈值不得回填。
- **夜间安全**：后续所有客户端窗口执行前先确认时间；夜里先睡觉（`client-real` 自动，
  或面板 `!sleep`），无床则停止测试。
  **已实测（2026-10-17 09:20）**：门禁在 `timeOfDay=12774` 触发，找到床但无法到达，
  按设计中止，未做任何夜间动作；睡觉本身尚待床可达时重试。
