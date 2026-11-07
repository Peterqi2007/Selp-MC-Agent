# 基于 Pi SDK 的自研动作脑实施计划

文档日期：2026-11-01（2026-11-06 修订：进程接缝、跨世界记忆分区、分发边界）\
代码基线：codex/p1，b0200a6（骨架随 2026-11-06 修订扩展）\
状态：设计与开发骨架；不是已接通 Pi、已完成产品化或已通过真机验收的声明。

配套文件：

- [迁移接口清单](ACTION-BRAIN-MIGRATION-INTERFACES.md)
- [验收矩阵](ACTION-BRAIN-ACCEPTANCE.md)
- [运行时骨架](../src/actionBrain/README.md)

## 1. 决策与目标

采用 Pi coding-agent SDK 作为首选的嵌入式模型运行基座。项目自行拥有任务与回合调度、产品 UI、子代理、插件权限、游戏执行与恢复。保留现有经过回归的游戏执行内核，不把它替换成模型直接操纵身体的新实现。

目标是把“客户安装 mod、Node 项目、DSH 和插件并手工组接”收敛为“安装本产品，选择游戏实例并完成首次配置”。客户端 mod 仍是当前身体控制方案的组成部分；产品需要接管它的安装、校验和版本配对，而不是承诺 SDK 能消除 mod。

迁移必须同时获得以下结果：

1. 产品独立启动和交付，不需要 DSH、Pi CLI、客户 npm 安装或手动绑定 agentId。
2. 模型运行在可控的本地宿主中，能够流式观测、干预和取消。
3. 快循环继续由本地确定性代码驱动；慢循环负责规划、解释和学习。模型延迟不阻塞停手、自卫和控制器。
4. 任何模型、工具、子代理或插件都不能绕过统一执行资格、权限与身体仲裁。
5. 重启、断线、死亡和取消后的迟到输出不能重新发起旧动作。

Pi 为首选不等于跳过验证。B0/B1 必须锁定包和类型接口、测量供应商兼容性并验证 Windows 分发。只有明确的阻断证据才触发基座重选；首轮不同时组装多个 agent 框架。

### 1.1 项目定位：本计划整体是项目 **P2**

| 口径 | 含义 |
| --- | --- |
| 仓库既有阶段 | **P0 已收官；P1（规划器重构 M0–M7）进行中** |
| **本计划 = 项目 P2** | 「自研 Agent 落地」：用应用自有的 Pi 运行时替换 DSH 动作脑，并接管回合、任务、异步受理、暂停/停止、预算与恢复 |
| 本计划的内部阶段 B0–B5（B = Brain） | **是项目 P2 的子阶段**，不是项目级 P0/P1 的同名阶段；两者的通过记录不得互相转填 |

项目 P2 的出口不是"代码文件已创建"，而是：工具面等价（15 工具）、异步受理可用（回执/事件/收件箱）、回合与任务双门成立、暂停/强制停止/思考预算可证伪、真机闭环通过、DSH 从发行必需项移除。详见 §14 与[验收矩阵](ACTION-BRAIN-ACCEPTANCE.md)。

## 2. 需求与范围

| 编号 | 必须交付的需求 | 完成的可见证据 |
| --- | --- | --- |
| R01 | 独立应用与受控 runtime | 新机器按安装说明启动，无 DSH/Pi CLI/npm 依赖 |
| R02 | 玩家请求保留原文、来源和授权边界 | 同一 requestId 可追踪语言入口、动作回合和最终结果 |
| R03 | 多模型/provider 配置与流式会话 | 文本、工具、图像、usage、错误、取消均有兼容测试 |
| R04 | 复用阅读、搜索、编辑和压缩设施 | 工具受角色/目录限制；压缩前后任务约束可验证 |
| R05 | 统一游戏工具与执行仲裁 | 所有游戏写工具经 ToolBroker 和现有执行服务 |
| R06 | 可控停止、暂停、继续与接管 | 先使旧执行资格失效，再停身体及模型；有确认状态 |
| R07 | 自管有界子代理 | 并发、预算、父子取消、结果汇合、独立上下文可观测 |
| R08 | 产品级可视化 | 任务树、工具状态、计划/步骤、截图与错误可关联交互 |
| R09 | 外部扩展能力接口 | manifest、授权、撤权、超时、隔离、版本与审计 |
| R10 | 明确的恢复语义 | 重新读取世界并核对中断动作，默认不重放副作用 |
| R11 | 凭据与数据边界 | key 不进事件/日志；模型上下文不成为执行账本 |
| R12 | 可回滚迁移 | DSH 旧路径在灰度期可选，但任一时刻只有一个动作脑 |

### 2.1 首个可用版本

首个版本覆盖单用户、单 Minecraft 实例、单身体、一个主动作代理和有界辅助子代理，可连接兼容的多人服务器。复用现有 clientmod/Mineflayer 身体适配、技能、计划、提案与课程账本。支持用户提供模型凭据和明确选择 provider/model。

产品**不充当启动器**：游戏进程由用户用自选启动器（PCL2、官方或其它）拉起，产品只负责发现控制端点、配对与接入（§12）；产品对 PCL2 无运行依赖，PCL2 布局只是实例目录的一种来源。跨存档/服务器的任务执行记忆按 `worldKey` 分区（§6.3），首版必须携带该分区 schema。

外部插件接口从第一版预留，可信内置能力可以先接入。第三方可执行插件必须等权限与 OS 隔离通过 B3 验收后开放；不能因 manifest 校验已存在就宣称第三方代码已经安全运行。

### 2.2 非目标

- 不训练基座模型，不重新实现 Pi 的通用会话与压缩引擎。
- 不重写身体协议、寻路、技能或 PlanRunner。
- 不把任意 bash、文件写入和进程启动开放给常规游戏动作代理。
- 不把大模型放入毫秒级驾驶、动态瞄准或紧急反射循环。
- 不为迁移强行把整个 CommonJS 仓库转换为 ESM。
- 不保证取消能撤销已经完成的挖掘、放置、物品转移等外部效果。
- 不展示或依赖模型隐藏思维链；展示可观测消息、工具、状态、证据和简短决策说明。

## 3. 能力所有权

| 能力 | Pi 提供的基础设施 | 本项目的权威与责任 |
| --- | --- | --- |
| 模型与工具循环 | AgentSession、provider、流式生命周期 | 角色配置、调用预算、供应商兼容与调度 |
| 读写与搜索 | 可选择的 coding 工具与自定义工具 | 目录范围、角色权限、隔离和变更审查 |
| 上下文 | SessionManager、持久会话、compaction | 当前世界快照、目标、权限、执行账本与恢复事实 |
| 停止 | abort 与 idle；steer 队列 | 执行资格失效、任务取消、输入释放及确认 |
| 并发 | 多会话及工具调用能力 | 身体单 owner、子代理队列、预算和取消树 |
| 扩展 | 自定义工具和可信 extensions | 客户插件进程、权限、安装和审计 |
| 事件 | session.subscribe 等 | 稳定产品事件、UI 投影、脱敏和回放 |
| 游戏执行 | 无 | PlanService、PlanRunner、TaskSlot、TaskHub、技能、body |

目标、计划和世界状态的事实不能只存在模型 transcript 或 compaction 摘要里。Pi session 是会话历史权威，现有计划/任务账本是执行事实权威；两者通过稳定 ID 关联。

## 4. 新架构

~~~mermaid
flowchart TD
  U[玩家 / 产品 UI / 现有聊天入口] --> A[ActionBrainRuntime 稳定门面]
  A --> C[上下文构建与目标 / 回合协调]
  C --> P[PiSessionDriver / AgentSession]
  P --> T[ToolBroker 权限 / 预算 / epoch]
  T --> G[GameControlPort]
  G --> E[PlanService / PlanRunner / TaskHub]
  E --> S[TaskSlot 唯一身体 owner]
  S --> B[现有技能 / 控制器 / body / mod]
  P --> Q[SubagentScheduler]
  Q --> K[独立 Pi 子会话 / 隔离工作区]
  K --> T
  X[外部插件进程] --> H[PluginHost / 能力授权]
  H --> T
  R[反射 / 死亡 / 急停] --> F[执行资格栅栏与停止协调]
  F --> G
  F --> P
  F --> Q
  C --> J[结构化事件与证据投影]
  P --> J
  E --> J
  H --> J
  J --> U
~~~

### 4.1 分层职责

1. **产品层**：配置、模型选择、任务面板、权限、截图、停止/接管、诊断与安装升级。
2. **动作脑域层**：玩家请求、目标、回合、上下文与恢复协调；对上不暴露 DSH agentId/goal revision/HTTP 路由。
3. **模型适配层**：Pi API、事件、工具 schema、SessionManager、provider。Pi 变更主要限制在这一层。
4. **工具与能力层**：统一 ToolBroker，校验调用者、角色、授权、预算、epoch、worldSessionId 和工具参数。
5. **执行层**：继续复用现有 PlanService/PlanRunner/TaskSlot/TaskHub/技能及 body；它是身体动作权威。

ExecutionFence/epoch 是“请求是否仍有资格”的栅栏，不是第二个身体锁。身体互斥继续由 TaskSlot 负责；一个工具通过 epoch 校验并不表示它可以绕开 TaskSlot。

GameControlPort 接缝包含 observe、execute、cancel、releaseInputs 和 waitForIdle。最后一个方法必须确认相关计划/任务及输入已结算；模型 agent_settled 或动作 accepted 回执不能代替游戏空闲确认。生产 adapter 需把现有异步 task/plan 回执连接到匹配的终端事件与验证证据。

进程接缝 `discover`/`attach`/`onGameLost` 是**原子三件套**（部分注入即构造失败）：游戏进程由用户拉起，产品只发现候选控制端点、attach 读取世界身份并监视丢失；`game:lost` 走与人工急停相同的停止链。`attach` 在活动 run 期间被拒绝——换世界必须先 stop，不得静默重绑（§6.3）。

### 4.2 快慢双循环

**快循环**保留本地观察、危险识别、移动控制和反射；不等待模型 token。危险、死亡、连接变化或人工停止立即使旧资格失效，并取消或抢占身体任务。控制器的连续控制仍运行在本地闭环，不拆成模型逐次发按键。

**慢循环**由玩家请求、任务结算、受阻、世界关键变化和子代理结果触发，负责规划、工具选择、任务解释和知识更新。普通观察做去重、合并和限流；危险事件不进入普通消息排队。

优先级固定为：人工急停/死亡/失联保护 → 本地紧急反射 → 已授权玩家任务 → 自主课程与提案 → 后台研究。主模型只能提出动作和计划，不能降低前面层级的优先级。

同一事件记录事件接收、调度、模型请求、首 token、首工具、首游戏动作和结算时间。只有分段对照数据证明收益后，才能宣称 Pi 路径比 DSH 更快。

## 5. Pi 接入约束

前序 DeepSeek Search/Fetch 核验得到的官方源码声明：包名为 @earendil-works/pi-coding-agent，coding-agent 是 ESM，要求 Node ≥22.19.0。该信息来自当日官方仓库正文，不等同于独立确认 npm 稳定版。B0 必须固定 npm 版本、锁文件、来源提交及必要运行资产。

当前项目仍为 CommonJS/Node ≥18。骨架通过动态 import 或 sessionFactory 注入隔离 SDK，旧离线测试不要求安装 Pi。正式启用时产品要捆绑兼容 Node runtime；不能仅修改 engines 就算完成运行时升级。

PiAdapter 必须遵守：

- 显式创建 session、provider、工具列表和资源目录；不隐式加载客户目录里的任意 extension。
- 常规动作代理只开放游戏工具和受限只读知识工具；编码子代理才可选择 read/edit/write 等，bash 还须额外授权和隔离。
- 通过 SessionManager 管理持久历史和压缩。不得直接给 agent.state.messages 赋值冒充持久上下文替换。
- 区分 message、tool、agent_end、重试、压缩和 agent_settled。agent_end 不是最终空闲；最终结算以 agent_settled 及本项目执行服务状态共同判断。
- abort 用于取消当前操作并等待 idle；steer 只做步骤边界纠正，不能作急停、自卫或同步按键控制。
- 默认并行工具只允许用于安全只读工具；游戏写工具始终经统一执行通道。Pi sequential 设置不能替代跨会话的身体仲裁。
- SDK 事件转换为产品事件；不把第三方 SDK 的原始对象和内部状态直接暴露为永久 UI API。
- SDK 缺失、版本/API 不符、provider 不支持所需工具/图像/取消时显式报错，不静默退回旧动作脑或无权限工具。

主模型、快速辅助模型可以使用不同 provider/model，但第一轮先用相同模型进行 DSH 对照，再单独评价模型变化。不要把“模型更快”错误归因于框架。

## 6. 稳定门面与状态机

生产业务逐步依赖 ActionBrainRuntime，而不是 HarnessBridge：

~~~text
start(request)          -> requestId / runId / accepted
steer(runId, message)   -> queued / rejected / stale
stop(reason, scope)     -> stopping + 各执行面确认结果
status()               -> JSON-safe 状态，不含 session 对象或凭据
subscribe(listener)    -> unsubscribe
~~~

恢复/继续在产品命令层执行：先 reconciliation，再以新 generation 开始或继续回合；不要复活旧 lease。前述签名是产品契约方向，骨架中的具体参数以模块说明为准，生产接入时应通过契约测试冻结 v1。

骨架目前的 start(goal, { capabilities }) 返回完整运行的 completion Promise，runId 和运行事件可立即从状态/订阅观察。生产请求接入还需新增原文/来源/幂等身份与接受回执的适配；HTTP/UI 不应等待完整运行结束后才回应“已接受”。

回合状态至少区分 idle、running、waiting_tool、waiting_user、compacting、stopping、stopped、settled、failed、interrupted。SDK 的空闲、计划结束和身体停手是不同事实；UI 不得仅收到 agent_end 就显示“全部完成”。

关联身份至少包含：requestId、runId、sessionId、parentRunId、toolCallId、planId、stepId、taskId、attemptId、epoch、worldSessionId、worldKey。沿用现有执行 ID，不用模型生成的文字代替身份。

产品事件包应包含 schemaVersion、seq、eventId、type、at、关联 ID、status、reason、evidenceRefs 和安全 payload。具体事件族：

- request/run：accepted、started、queued、settled、failed、interrupted。
- model：message_delta、message_end、retry、compaction_started/completed。
- tool：requested、denied、started、progress、finished、discarded_stale。
- subagent：queued、started、progress、completed、cancelled、budget_exceeded。
- execution：计划/步骤/身体 owner、控制器状态、停手请求与确认。
- plugin：授权/撤权、启动、调用、崩溃、隔离故障。

复用 TaskEvents/SSE 的顺序与回放机制，另加持久事件/证据层。内存 ring 的重连回放不等于崩溃恢复；流式 token 也不需要逐 token 写入永久任务账本。

### 6.1 异步受理与事件唤醒

回合不能被身体绑住。现有痛点是 A28 实测的长步 **15.57s 单次结算**、`!fish` 设计上最长 15 分钟：
若动手工具同步返回，模型整轮只能等结果，期间既不能说话也不能改链。目标语义：

| 不变量 | 说明 |
| --- | --- |
| 受理 ≠ 完成 | 动手工具立即返回 `accepted` 回执（含 `taskId`），**永远不能结算成成功**；只有终结事件能写账本 |
| 终结只认一次 | 同一 `taskId` 只接受第一个终态；重复/迟到按 `eventId` 幂等丢弃 |
| 只读同步 / 动手异步 / 停止同步 | `stop` 永不排在任务后面；只读工具不占任务号 |
| 事件驱动、禁止轮询 | 完成必须作为事件推送；`task_status` 只用于现场核对 |
| 身体唯一 | 派发即抢 `TaskSlot`；抢不到是拒绝式受理（带当前任务号），不排队、不替换 |

任务的终结态比现状多四个语义：`dropped`（无活可干）、`cancelled`（合法叫停）、`timeout`（可续一次）、
`interrupted`（重启/断连，不重放）。**`dropped` 与 `cancelled` 不计入失败阶梯与课程难度带**，
这是对"`blockedReason` 无法区分太难与抖动"这条已知局限的正面回答。

唤醒按三态收件箱路由：回合进行中只入箱（工具批边界一次倒空）、回合结束且后台在跑则允许开新轮、
完全空闲时只有活人说话与显式 steer 能开轮，世界/身体事件恒不紧急。合批按 `taskId/planId/thread`
串行，禁止逐条 progress 注入上下文。

本机制**不新增执行器**：真正的执行仍是 `ActionBrainRuntime` 经 `gameControlPort` 走
现有 PlanService/TaskHub/TaskSlot；异步层只负责请求受理、账本、事件与唤醒。
完整契约见 [异步受理与事件唤醒契约](ACTION-BRAIN-ASYNC-CONTRACT.md)；
骨架（未实现）为 `src/actionBrain/asyncContract.js`、`eventMailbox.js`、`wakeScheduler.js`。

### 6.2 回合门与任务门（两个不同的终态）

本轮审计发现的第一处硬冲突：骨架原先在模型 settle 后强制 `waitForIdle`，不 idle 即判 `game-not-idle` 并触发急停——而"回合结束、任务仍在跑"正是异步受理的正常形态，等于任务被自己的运行时杀掉。

| 门 | 判据 | 谁来判 | 谁可以读 |
| --- | --- | --- | --- |
| 回合门 | driver `agent_settled` + 清理确认 | runtime | 只用于开下一轮 |
| 任务门 | `task.finished`（结构化终态） | 宿主任务账本 → 事件 | **UI / 课程 / 失败阶梯只读这一门** |

- `start(goal, {taskMode:'sync'|'async'})`：`sync` 保留旧的 idle 门（兼容既有调用）；`async` 只要求模型 settle，任务在跑属正常态，返回 `{settledScope:'turn', tasksOpen:n}` 并发 `turn:settled`。
- `async` 必须注入 `gamePort.tasks` + `gamePort.onTaskEvent`，缺一**关闭式失败**（`async-port-required`），不允许"回执照发、账本不存在"。
- `run:settled` 只表示"这一轮模型结束了"；任何"已完成"的结论只能来自任务终态事件。
- 关联身份（`epoch` / `worldSessionId` / `worldKey`）进入端口调用与事件；跨世界、跨分区与旧 epoch 的事件被拒收。

### 6.3 跨存档/服务器记忆分区（worldKey）

`worldSessionId` 是**运行时栅栏**（每次连接/重连变化，拒收旧连接回执）；`worldKey` 是**持久分区键**（同一存档/服务器跨会话稳定）。两者必须同时存在、不得互替——运行时栅栏挡不住"昨天在另一个世界学到的难度带"混进今天的账本。

| 项 | 规则 |
| --- | --- |
| 定义 | 单机=存档身份（世界目录/level 标识）；联机=服务器地址+世界身份。由宿主在 `attach` 时从游戏侧读取并上报，产品不自造、不用模型文字代替 |
| 分区对象 | 课程账本（completed/failed/难度带）、MemoryStore（episodic/semantic）、MethodLibrary、ChatMemory、Pi SessionManager 会话目录、异步受理的 accepted/终态账本 |
| 必备字段 | 异步回执与终态事件必备 `worldKey`（`asyncContract` SCHEMA_VERSION 2）；缺失时落 `default` 分区（`DEFAULT_WORLD_KEY`）并显式告警，**绝不静默并入其它分区** |
| 拒收 | 跨 `worldKey` 的事件在收件箱 `ingest` 与任务事件转发处拒收（`cross-world`），与会话栅栏 `stale-world` 是两种可判别错误 |
| 换世界 | `attach` 拒绝在活动 run 中途切换；先 `stop` 再 attach，新 `worldKey` 生效后读新分区 |
| 迁移 | 现有全局账本一次性迁入 `default` 分区（历史数据无法归因到世界）；分区目录结构纳入 B5-09 的 schema 升级/回滚 |

验收：B2-30（[验收矩阵](ACTION-BRAIN-ACCEPTANCE.md) §4.4）——同一安装先后接入两个世界，分区互不可见、难度带/方法成功率不串、`default` 分区有显式告警。

## 7. 工具边界和重新对接原则

完整清单见 [迁移接口清单](ACTION-BRAIN-MIGRATION-INTERFACES.md)。首轮保留原 mc_* 名称、参数和结果语义，先替换宿主，再逐步去除历史包袱，避免同时修改提示词、工具协议和身体执行。

| 工具类 | 示例 | 默认规则 |
| --- | --- | --- |
| 观察/能力 | mc_observe、mc_state、mc_perception、mc_capabilities、mc_keybinds | 可并行；快照带时间、世界会话和来源；keybinds 仅查询稳定键位 ID |
| 知识/记忆 | lookup_mod_content、mc_memory | 读写区分权限；不把凭据送入模型 |
| 提案/交互 | mc_propose、mc_ask_player、mc_say | 沿用语言/审批边界，不自行伪造玩家授权 |
| 计划 | mc_plan、mc_plan_status、mc_cancel | submit/start/resume/cancel 经 PlanService；保留版本检查 |
| 原子动作 | mc_step（含使用稳定 keybind ID 的执行） | 必须经现有控制服务、TaskSlot、失败阶梯和后置验证 |
| 回合结算 | mc_finish | 只结算域状态，不直接给模型标记已完成的游戏效果 |

优先复用 src/llm/tools/registry.js 的 schema 校验及 src/llm/toolSurface.js 的语言/执行隔离。ToolBroker 是共用权限和路由层，不能形成第二套语义相近但不一致的工具实现。

骨架当前采用 game:observe、game:control、files:read、files:write、network:read、compute、subagent:spawn 这一最小能力词表；本文的知识、记忆、发言与资源范围是产品需求分类，尚非已冻结的 capability 常量。B0 要据 15 个工具拆分并冻结精确能力及 scope，不能用只读能力放行写记忆、发言或执行。

每个有副作用的工具在排队前、真正执行前和接收异步结果时都核对资格。关闭 lease 后，迟到结果可以进入诊断证据，但不得进入当前回合决策、触发下一步或重新取得身体。

## 8. 自管子代理

SubagentScheduler 负责调度而不是由 Pi 隐式派生。每个子任务包含 taskId、parentRunId、目标、输入证据引用、角色、能力集合、截止时间、最大并发/调用/输出预算和独立 sessionId。

建议首批角色：

| 角色 | 任务 | 权限 |
| --- | --- | --- |
| observer/researcher | 状态解释、模组知识检索、方案比较 | 只读世界与受限知识 |
| planner/reviewer | 提交候选计划、校验前后置条件 | 只读，返回建议，不启动身体 |
| skill-coder | 候选技能代码与离线测试 | 隔离工作目录；产物送现有 CodeSkills/forge 流程 |

子代理默认没有 game:control、玩家发言、批准任务、插件安装或凭据访问能力。子代理输出是建议，不是可执行指令；主代理核对当前世界与父 lease 后，才通过同一 ToolBroker 请求执行。后续若允许委派动作，仍走同一个身体通道且必须重新设计授权契约，不能直接继承父权限。

并发上限、provider 并发、任务截止时间、单任务调用数和全局预算都应配置且可观测。队列满时返回明确状态；父取消/死亡/接管立即取消子树。对不合作 worker 保留结果栅栏和进程终止手段，不能仅依赖 AbortSignal。

“快速子代理”需要用首 token、完成耗时和主上下文节省量证明。小模型、短提示词和受限工具是可选优化，不写成未经测试的性能结论。

## 9. 插件权限与隔离

区分三种对象：现有 Mineflayer 插件、可信内置 Pi extension、客户第三方产品插件。src/core/plugins.js 不能被直接当作客户扩展平台；Pi extension 同进程执行也不是权限沙箱。

产品插件 manifest 至少包含 id、version、hostApiVersion、transport、entry、integrity、声明工具、所需 capabilities 及资源范围。先以骨架的 game:observe、files:read/write、network:read 等词表对接，再在 B0 冻结知识、记忆、发言等细分权限和路径/网络范围。game:control 默认为拒绝，授权必须绑定用户/实例/插件版本/范围。

PluginHost 持有注册、授权和撤权账本，插件只通过受控 RPC 取得 host 能力，不接收 body 对象、主代理 session、环境变量全集或模型 key。注册工具名称不能覆盖内置工具；每次调用检查当前 grant，撤权使未完成调用和旧 token 失效。

第三方代码使用独立进程，并配合实际可验证的 OS 文件/网络/进程限制。单独使用 child_process、worker 或 Windows Job Object 只解决生命周期/资源的部分问题，不能冒充完整权限隔离。若 B3 尚未选定并验证隔离机制，交付版只允许可信内置能力与受限的外部服务连接。

插件安装还需版本锁定、完整性校验、权限变化提示、启动超时、资源上限、崩溃禁用和审计。是否支持 MCP 是协议适配选择；MCP 本身不替项目解决安装、授权和隔离。

## 10. 停止、恢复与一致性

### 10.1 停止顺序

停止入口包括 !stop、面板急停、自主模式关闭、死亡、失联保护和人工接管。统一流程：

1. 同步递增 epoch，冻结新执行与排队请求；此步骤在任何远端 await 之前完成。
2. 立即请求释放按键/鼠标/控制器输入，并取消或中止当前 PlanService/TaskHub/任务队列。跨模块清理允许并行，但不等待 SDK 停止后才停身体。
3. 取消子代理子树、插件在途调用和模型 run；调用 Pi abort 并等待可确认 idle。
4. 汇总身体停手、计划结算、子任务取消、SDK idle 的确认。每个失败都保留错误；UI 显示“停止中/停手未确认”，不虚报完成。
5. 停止未确认时保持执行禁用。超时走控制通道降级和重新连接/接管流程，不能自动恢复模型动作。

正常结束也要求执行服务结算后再关闭 lease。模型总结不能覆盖任务失败、部分完成或未知结果。

### 10.2 继续与恢复

- 暂停不意味着保存一个可复活的身体 lease。继续前读取新快照、检查 body ready/世界身份和执行服务，发放新 generation。
- 进程重启把活跃 run 标记 interrupted。恢复 Pi transcript 不自动继续工具，也不自动重跑 PlanRunner 的未完成动作。
- 动作中断时先核对 inventory/位置/方块/计划证据，分清已生效、未生效和未知。未知副作用必须重新观察或询问，不能用通用重试掩盖。
- 断线重连和世界/身体切换更新 worldSessionId。旧连接的请求/回执即便 epoch 数字碰巧相同也不得被接纳。世界切换（换存档/换服）同时更新 `worldKey` 并切换记忆分区（§6.3）；换世界先 `stop` 再 `attach`，不得在活动 run 中途重绑。
- 死亡与遗体回收继续由现有 AutonomousMode/身体恢复机制协调，先取消旧目标并确认 alive/ready，再给动作脑新的上下文；不得再建另一条同时驱动身体的死亡恢复循环。
- 保留现有 plan baseVersion、任务 attemptId、终端去重、失败阶梯与 CodeSkills 证据/晋升机制。

### 10.3 暂停、强制停止与思考预算

本轮审计确认：只有 start/stop 时，操作员想"暂停一下"只能 stop（销毁会话与任务上下文）；而 stop 一旦确认失败就永久拒绝新 run；模型也没有任何思考时限。

| 能力 | 语义（B2 骨架已提供接口） |
| --- | --- |
| `pause(reason)` | 冻结**新**派发，不打断在跑回合、不销毁会话；`start` 期间返回 `paused` |
| `resume()` | 解除冻结；恢复仍需重新感知（不复活旧 lease） |
| `stop(reason, {force:true})` | 确认失败时记 `force-stopped`：主 driver 清理未确认（unsafeDrivers）仍硬阻；未确认的子代理保留跟踪、由下一次 stop 重试，**不再永久锁死启动** |
| `start(..., {deadlineMs})` / `budget` | 到点发 `run:deadline` 并走正常 stop（`think-timeout`），身体/输入/子代理同样释放 |
| `initTimeoutMs` | driver/session 创建超时：工厂挂住不再造成"起不来也停不掉" |
| `usageReport()` | turns / toolCalls / wallMs，供预算与面板取数 |

`stop` 仍然先失效执行资格再停身体；`force` 只影响"能否开新一轮"，**不允许**把未确认的停止显示成已停稳。

## 11. 可视化和交互

首轮沿用现有 statusServer、TaskEvents、eventStream 与 panel 的服务能力，新增动作脑面板及稳定 API，不急于引入第二套常驻服务。

必须能看到：

- 当前用户目标、授权范围、主/子任务树、队列和占用的身体 owner。
- 模型可见文本与输出、工具参数摘要、进度、结果、耗时、token/费用（provider 可提供时）。
- 计划、步骤、前后置验证、失败原因、截图及证据，点击可关联同一次尝试。
- compaction/重试/等待玩家/权限拒绝/停止确认等状态，避免“界面静止但后台继续”。
- 暂停、急停、继续、补充指令、回答问题和人工接管；UI 操作共享相同域接口。

安全显示与调试深度可切换；凭据、敏感路径/内容及插件秘密不直接进入普通 UI 事件。需要显示的是可观测工作过程，不要求展示模型隐藏推理。

产品 API 建议使用 /action-brain/status、/action-brain/requests、/action-brain/stop、/action-brain/events 等版本化接口。具体路径在 B4 冻结，旧 /harness/* 仅作迁移兼容。启用本地写 API 前检查 origin/鉴权和监听地址，不能把有身体权限的服务默认公开到网络。

## 12. 产品分发

目标发行物包含受控 Node runtime、应用与 UI、锁定依赖、Pi 所需资产、默认配置、许可证清单、诊断工具和 mod 版本清单。不能未经验证地承诺单文件可执行文件；目录式安装包也可以满足无需人工组接的交付要求。

**游戏实例与进程边界（2026-11-06 修订）**：产品对 PCL2 **无运行依赖**——PCL2 布局只是实例目录的一种来源，普通 `.minecraft` 布局（版本 JSON + mods 目录）同等支持。产品**不充当启动器、不拉起也不监管游戏进程生命周期**：游戏由用户用自选启动器启动，启动期问题（Java 缺失、版本下载、账号登录）归用户侧启动器。产品职责收敛为三件事：

1. `discover`——探测候选控制端点（控制 Mod 的本地 HTTP 等）；"等不到端点"时给出可操作诊断（指导用户检查游戏是否已启动并进入世界），不自动拉起进程；
2. `attach`——绑定一个实例，读取世界身份（`worldKey`/`worldSessionId`）并做健康检查；多实例并存时由用户显式选择，身体只绑一个；
3. `onGameLost`——端点丢失/进程退出走与人工急停相同的停止链（先失效资格，再停身体与模型）。

首次启动流程：选择游戏实例目录（PCL2 或普通 `.minecraft` 布局）→ 检测版本和 mod → 提示并执行产品内的安装/配对（人类确认）→ 设置 provider/key → **用户自行启动游戏** → 产品 discover/attach 并完成健康检查 → 示例只读任务 → 可选择开启行动。保留 mod 安装所需的人类确认，但由产品完成路径与版本管理。

用户数据和 session 放入稳定应用数据目录，并按 `worldKey` 分区（§6.3）；不依赖源码 cwd。凭据走系统安全存储或受控注入，不打包在配置/日志/前端。升级先备份并迁移状态，失败可回退程序和兼容数据；提供脱敏诊断导出。

安装包必须在无 Node/npm/DSH/Pi CLI 的干净 Windows 环境验证，覆盖空格/中文路径、离线启动诊断、杀毒误报反馈、mod 不匹配、占用端口和断网；**无 PCL2 的机器**（普通 `.minecraft` 实例 + 用户自启动游戏）是 B5 必测变体（B5-12）。最终 SDK 及传递依赖做许可证和运行资产清单。

### 12.1 推迟项登记（2026-11-06）

以下需求**承认存在、明确推迟**，不计入本轮验收矩阵；触发条件满足前不得宣称已支持：

| 推迟项 | 内容 | 建议落点 | 触发条件 |
| --- | --- | --- | --- |
| release 管线工具链 | CI/打包工具链、签名、更新通道、制品分发 | B4 并行准备原型，B5 只做验收（判据已在 B5-04…B5-11） | B2 通过且打包原型在干净机可运行 |
| AuthMe 产品化向导 | per-server 凭据录入 UI、"不配置=跳过"的产品语义 | B4 | 产品 UI 首版交付时一并做；现有四重 never-register 闸门与 local overlay/环境变量机制保留为底座 |
| 产品级模组知识库 | modpack/版本配对元数据、离线知识包、知识随发行物分发 | B3 之后 | 首版沿用 `lookup_mod_content` + semantic 自动落库；插件/子代理知识面稳定后再做 |
| 插件市场与接入 UX | 第三方插件发现、安装、市场分发渠道 | B3 之后 | B3 权限与 OS 隔离门槛通过前，第三方可执行插件保持关闭 |

## 13. 配置与灰度

新增动作脑域配置，不继续扩充 chat.harnessUrl/harnessAgentId：

~~~json
{
  "actionBrain": {
    "enabled": false,
    "engine": "pi",
    "providerProfile": "user-selected",
    "sessionDirectory": "application-data/action-brain/sessions",
    "taskMode": "async",
    "initTimeoutMs": 5000,
    "thinking": { "deadlineMs": 120000, "maxOutputTokens": null },
    "turnBudget": { "maxToolCalls": 40 },
    "subagents": { "maxConcurrent": 2, "deadlineMs": 600000 },
    "plugins": { "externalExecutablePlugins": false }
  }
}
~~~

`taskMode` 缺省为 `sync`（兼容旧路径）；切 `async` 前必须已注入 `gamePort.tasks` 与 `gamePort.onTaskEvent`。`thinking.deadlineMs` 是**思考时限**（到点自动 stop），`maxOutputTokens` 由 provider 能力决定，未知即显式 null 而不是假装有上限。`subagents.deadlineMs` 属于 B3 预算项，骨架尚未执行。

这是目标配置示例，不是已生效配置。现有 config loader 和 schema 要在 B0/B1 迁移，缺少 provider 配置时显式报告不可用。灰度期保留 dsh、pi、planner 的明确选择，启动时验证只有一个动作脑获得执行资格；禁止故障后静默切换。

## 14. 分阶段工作包

这里的 B0–B5（B = Brain）专指动作脑迁移的子阶段，与仓库项目 P0/P1/P2 在字面上完全分开；既有通过记录不能自动转填为本轮阶段通过。

| 阶段 | 主要工作 | 出口与依赖 |
| --- | --- | --- |
| B0 基线与契约 | 锁 Pi/Node 版本，最小嵌入；建立 DSH 对照；冻结 ID、事件、工具/取消契约；确认分发资产 | 不碰生产默认；SDK 可在 Windows 运行，旧测试不退化 |
| B1 模型与上下文 | 真实 PiAdapter/provider、流式与图像、受限文件工具、SessionManager、compaction、凭据 | 供应商/压缩测试通过；无模型 key 泄漏；依赖 B0 |
| B2 游戏闭环 | ToolBroker 到现有 registry/PlanService/TaskSlot；统一停止；迁移 goal、截图和自主提案；**异步受理与事件唤醒（回执/收件箱/边界投递）**；**回合门/任务门拆分、pause/force-stop、思考 deadline、工厂超时**；**进程接缝（discover/attach/onGameLost，用户拉起游戏后的发现与接入）与 worldKey 记忆分区 schema（§6.3）**；恢复 reconciliation | 停止/迟到/单 owner/死亡断线测试及真机闭环；**回执 <200ms、终态只投递一次、忙时拒绝式受理、`dropped` 不计失败**；**异步回合不因任务在跑而失败**；**进程接缝原子校验、`game:lost` 走停止链、跨世界事件拒收、账本/记忆/会话目录按 worldKey 分区且 default 显式**；依赖 B1 |
| B3 子代理与插件 | 多 session 调度、预算、取消树、候选技能隔离；PluginHost/grants/进程与 OS 隔离 | 角色越权和故障注入通过；第三方插件不满足门槛则保持关闭；依赖 B1/B2 |
| B4 UI 与交互 | 稳定事件投影、任务树、工具/截图证据、权限与停止接管、重连回放 | 用户能直接发现受阻原因并控制任务；可与 B3 并行 |
| B5 性能与发行 | 相同模型基线对照、长时回归、干净机安装、mod 配对、升级回滚、许可证清单；**无 PCL2 干净机 + 用户自启动游戏（B5-12）** | 正式切默认到 Pi；DSH 从发行必需项移除 |

每阶段以验收证据而非“代码文件已创建”结算。未完成 B2 不开放动作灰度；未完成 B3 不开放第三方可执行插件；未完成 B5 不声称可交付产品。

人员建议分成运行时/工具、游戏控制恢复、UI/交付三个职责面。小团队可以一人多职，但 SDK/权限与游戏停手变更应交叉复核。B0 结束后按真实兼容障碍与回归成本再估人日，不把当前未验证的集成难度变成固定上线日期。

### 14.1 第一批开发任务

1. 在隔离安装目录锁定 Pi 和 Node，跑通注入式 sessionFactory 到真实 SDK 的最小主回合。
2. 从 DSH 插件抽取现有工具 schema 和结果格式，挂到共用 registry 与 ToolBroker；先只读，再受控 mc_plan/mc_step。
3. 把 stop、epoch、worldSessionId 和结果去重写成故障测试，再接入生产 command/panel/death 路径。
4. 迁移 HarnessBridge 使用者到门面：玩家转发 → 目标 → 提案 → 截图 → 自主恢复；每步保留旧回归对照。
5. 接通 session 事件与当前 TaskEvents 的 UI 投影，再加入子代理/插件，不让可视化拖到最后补救。

## 15. 验收与交付判断

详细条件在 [验收矩阵](ACTION-BRAIN-ACCEPTANCE.md)。硬性不变量为：单身体 owner、无权限不执行、停手先失效资格、旧 generation 不复活、模型结束不冒充动作完成、**受理回执不冒充任务完成**、**终态事件只发生一次**、恢复不重放、插件不继承宿主权限。

性能用同模型、同 provider、同游戏场景和同工具对照，记录 p50/p95 分段数据。框架开销、模型网络耗时和游戏执行耗时分别统计。没有数据就不能用“进程内”推导“更快”，也不能只比较首 token 而忽略首动作与停止耗时。

发行放行需同时满足：离线契约测试、相关现有回归、真实 Pi/provider 测试、游戏真机故障回归、UI 人工验收、干净 Windows 安装及升级回滚。文档中的 TODO 和验收“未执行”项应在交付清单明确展示。

## 16. 本次代码骨架的边界

src/actionBrain 提供可注入的运行时门面、Pi 驱动接缝、执行栅栏、工具/插件能力校验、子代理调度与恢复契约、进程接缝（discover/attach/onGameLost）与世界分区栅栏（worldKey），并用 fake session/worker/game port 做离线测试。它独立于现有 src/index.js 默认动作脑路径。

本次不会自动安装 Pi、写入模型 key、调用收费模型、启动游戏、改变正在运行的身体、开放外部插件或把 Pi 设为生产默认。后续实现者应通过 README 中的端口接入，而不是绕过门面直接持有 body/Pi session。

骨架通过只表示这些契约可运行和测试；真实 Pi 类型/API、产品 UI、插件 OS 隔离、Windows 打包及真机恢复仍是以上阶段的实施工作。

### 16.1 本次验证记录

验证日期：2026-11-01；本机 Node v24.19.0。

- npm run action-brain:contract:test：40/40，通过 fake/offline 契约断言；交叉复测覆盖六类已发现的初始化、撤权、停止与结算缺陷。
- npm run p1:verify -- --fast：19/19 既有离线套件通过。
- 新增 9 个模块与 1 个测试脚本：共 10 个 JavaScript 文件语法检查通过。
- 新文档相互链接、package 测试入口及 git diff --check 通过。

异步受理追加（同日）：新增契约文档 [ACTION-BRAIN-ASYNC-CONTRACT.md](ACTION-BRAIN-ASYNC-CONTRACT.md) 与三个骨架模块
（`asyncContract.js`、`eventMailbox.js`、`wakeScheduler.js`，**全部占位，抛 not-implemented**）；
`npm run action-brain:contract:test` 40→**46/46**（新增 6 项断言：契约数据冻结、命令分类、事件投递时机全覆盖、
构造器拒绝假装成功、收件箱/唤醒调度器为未实现桩）；`npm run p1:verify -- --fast` 仍 19/19。
这 6 项只证明"契约存在且不会假装可用"，不关闭 §4.2 的任何行为验收项。

**B2 框架修订（同日，审计驱动）**：按本轮审计结论只改 `src/actionBrain` 门面与文档——回合门/任务门拆分（`taskMode: 'async'|'sync'`）、driver 工厂初始化超时、`pause`/`resume`、`stop({force:true})` 降级、`deadlineMs` 思考时限、`boundary()`/`ingest()` 收件箱接缝、`gamePort.onTaskEvent` 任务事件转发、`usageReport()`、`ask()` 与 `resumeRequest()`。**生产入口 `src/index.js` 未改**，`p1:verify -- --fast` 仍 19/19。
`action-brain:contract:test` 46→**57/57**（新增 11 项：异步回合不因任务在跑失败、缺端口关闭式失败、工厂挂起超时、强制停止解锁、暂停/恢复、思考 deadline、边界与入站幂等/世界栅栏、任务事件转发、ask 关闭式失败、用量计数、resumeRequest 注记）。

以上各条均**不关闭** B2-21…B2-27 的真实行为/真机验收。

**2026-11-06 修订（分发边界 + 进程接缝 + 跨世界分区）**：按用户裁决修订计划并同步骨架——
①游戏进程改由**用户拉起**，产品对 PCL2 无运行依赖（实例目录泛化，普通 `.minecraft` 布局同等支持），
GameControlPort 新增 `discover`/`attach`/`onGameLost` **原子三件套**（部分注入即构造失败；缺接缝时
discover/attach 关闭式失败 `process-port-required`；活动 run 中 attach 被拒；`game:lost` 走正常停止链）；
②新增 `worldKey` 持久分区键（§6.3）：回执/终态事件必备字段（`asyncContract` SCHEMA_VERSION 1→2、
`DEFAULT_WORLD_KEY='default'`），`ingest` 与任务事件转发新增 `cross-world` 拒收（区别于 `stale-world`），
课程账本/记忆/方法库/聊天记忆/会话目录按 worldKey 分区，`default` 分区显式告警；
③release 管线、AuthMe 产品向导、产品级知识库、插件市场登记为推迟项（§12.1）。
`action-brain:contract:test` 57→**63/63**（新增 6 项：进程接缝原子性、discover/attach 关闭式失败与
活动 run 拒绝、attach 采纳世界身份、game-lost 停止链、跨世界双栅栏拒收、回执/终态契约冻结 worldKey）；
`npm run p1:verify -- --fast` 仍 19/19；生产入口 `src/index.js` 未改。
新增验收项 **B2-28…B2-30、B5-12**（[验收矩阵](ACTION-BRAIN-ACCEPTANCE.md) §4.4/§7.2，矩阵 79→83 项）
仍为 NOT_RUN，以上离线结果不关闭它们。

以上结果不转填为配套 83 项阶段验收完成。真实 Pi/provider、Minecraft、产品 UI、第三方插件 OS 隔离、性能和 Windows 安装包均未在本次验证。

## 17. 风险与回退

| 风险 | 处理与放行条件 |
| --- | --- |
| Pi 包名/API/资产变化 | 固定版本与来源；类型适配集中；升级跑契约/provider/打包回归 |
| provider 工具/图像/取消差异 | 按能力矩阵测试并禁用不支持功能，不默默丢图或忽略取消 |
| 停止只取消模型，身体仍动 | 单停止协调器；分面确认；故障后保持写禁用 |
| SDK/子代理默认并发写身体 | 所有写工具经同一 broker 和执行内核，测试竞争和迟到结果 |
| 压缩丢目标或恢复错误 | 目标/权限/账本独立持久；重建上下文注入当前权威事实 |
| 第三方插件越权 | grants + RPC + OS 隔离；未通过则关闭第三方代码执行 |
| 产品安装仍需手工拼装 | 以干净机首次体验为 B5 必过项，不以开发机成功代替 |
| 一次性迁移范围过大 | 依次只读→玩家任务→自主模式；保留显式回滚开关和旧测试 |

回退切换也必须先停止并核对身体，失效当前 epoch，关 Pi/子任务和写通道，再启动旧路径；不能两个动作脑“热备同时发命令”。会话记录可保留，未完成动作不自动跨引擎续跑。

## 18. 官方依据与证据范围

本设计复用了 2026-11-01 通过用户指定 DeepSeek Search/Fetch 取得的官方正文。原始缓存与核验报告位于 runtime/framework-research-20261101；该运行目录不应被当作发布时一定存在的文档依赖。

- Pi 仓库、子代理与权限边界：https://github.com/earendil-works/pi
- SDK：https://github.com/earendil-works/pi/blob/HEAD/packages/coding-agent/docs/sdk.md
- Extensions：https://github.com/earendil-works/pi/blob/HEAD/packages/coding-agent/docs/extensions.md
- Compaction：https://github.com/earendil-works/pi/blob/HEAD/packages/coding-agent/docs/compaction.md
- package 声明：https://github.com/earendil-works/pi/blob/HEAD/packages/coding-agent/package.json
- Provider 基础：https://github.com/earendil-works/pi/blob/HEAD/packages/ai/README.md
- 根 MIT 许可证：https://github.com/earendil-works/pi/blob/HEAD/LICENSE

这些资料支持能力与边界判断，不证明本项目已通过 SDK 集成、性能、分发或真机验收。
