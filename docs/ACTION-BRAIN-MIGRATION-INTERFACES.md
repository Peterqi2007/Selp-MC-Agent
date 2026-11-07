# DSH → Pi 自研动作脑：接口迁移清单

更新：2026-11-01。代码审计基线：Git HEAD b0200a6。总阶段采用配套主计划的 B0–B5（B = Brain）；本文 I01–I09 仅表示接口迁移子步骤，不是另一套总阶段。

本文服务于以 Pi coding-agent SDK 为首选基座的动作脑重构。它列出当前真实接线、保留契约、需要新建的边界、替换顺序和逐项验收。它是开发清单，不代表 Pi SDK 已接通、DSH 已退役或已完成真机验证。源码行号是该基线的定位辅助，实施时以路径和符号为准。

## 1. 迁移总原则与稳定门面

迁移对象是 DSH 提供的 Agent 生命周期、会话绑定、模型回合、消息投递和插件工具适配。保留现有 Node 游戏执行内核：PlanService、PlanRunner、TaskSlot、确定性任务/技能、InputLedger、身体协议、观察缓存、失败升级、声明式验证器和死亡恢复。Pi 不得成为第二个身体所有者。

新应用门面名为 **ActionBrainRuntime**，稳定方法只约定以下五个；具体字段由框架契约统一定义，不让调用方依赖 Pi 或 DSH 对象。

| 方法 | 应用语义 | 迁移约束与完成判据 |
| --- | --- | --- |
| start | 接收一项获准的玩家任务、监督任务、提案准备或自主执行目标；返回接受/拒绝与本地 runId | 请求保留 requestId、source、speaker、原文、目标类型和已有 taskId/planId；同一请求幂等。接受不等于完成。已有 Node 任务必须标为监督，不能再执行一遍 |
| steer | 为指定运行追加普通纠正、任务/计划结算、玩家回答或截图证据 | 使用本地 runId、eventId、epoch/版本、worldSessionId、时间及关联 ID；可接受、合并、排队或丢弃并给出原因。steer 不是急停，也不能承诺抢断在途模型请求或工具 |
| stop | 停止指定运行或全部运行，并联动执行内核停手 | 同步使执行权失效，立即请求取消身体任务及释放输入，同时取消模型/子代理/工具；不得等待模型 idle 后才停身体。结果分别报告各阶段，不能仅报告“已发出取消请求” |
| status() | 返回应用视角的运行状态和可观察摘要 | 返回本地运行、目标、关联 task/plan、阻塞原因、队列、错误和恢复状态；不要求外部 DSH agentId/goal phase，也不暴露供应商会话对象 |
| subscribe(listener) | 订阅规范化运行事件；返回取消订阅函数 | 供 UI、审计与调度器使用；事件有顺序与关联 ID，订阅者错误不得破坏执行。Pi 事件需先归一化，不能成为各业务模块的直接依赖 |

首版可保留薄兼容适配器承接旧 HarnessBridge 调用，但新业务只能依赖上述门面。不得把 /goal、boundAgentId、DSH agent/session ID、goal revision 或 goal phase 命名成新内核 API。

### 1.1 必须保持的不变量

1. **一个身体只有一个执行所有者。** 所有身体写入经 ToolBroker → 现有命令/任务/计划 → TaskSlot；只读工具、研究和代码生成可以并行，身体工具不能跟随 SDK 默认并发直接写入身体。
2. **取消优先于迟到结果。** 模型输出、工具回调、子代理结果和重连事件必须带运行身份；stop 后旧 epoch 的写调用拒绝，不能复活任务。
3. **回执不是世界事实。** 工具的 accepted、HTTP 202、task 完成和 goal 完成都不能替代声明式后置条件及结构化状态证据。
4. **玩家批准与提案准备分离。** proposal 模式只有读取与 mc_propose；现有全自主模式的自动批准也必须经过自身策略和记录，不由模型提示词代替授权。
5. **语言脑不获得身体执行权。** 继续通过原文审批/转发入口触达动作脑，动作结果经现有语言输出路径表达。
6. **恢复先重新感知。** Pi 会话恢复不能自动重放已发出的移动、放置、消费物品或输入命令；不确定外部效果标为未知，读世界并核对后再决策。
7. **第三方插件没有隐式宿主权限。** 插件与子代理只能通过 ToolBroker 获得被授予的能力；Pi extension 本身不能被当作产品级权限隔离。

## 2. 保留、适配、新建与退役范围

| 分类 | 模块/能力 | 处置 |
| --- | --- | --- |
| 保留 | src/core/planService.js、planRunner.js、planStore.js；src/planner/verifier.js、draftGuard.js、budget.js | 保留计划校验、版本控制、预算、部分完成、提问、持久化与执行语义；新增调用适配，不另造计划执行器 |
| 保留 | src/core/taskSlot.js、taskHub.js；src/tasks/*、src/skills/* | 保留单一身体所有权、任务队列、技能与失败隔离；所有新增工具仍走此链 |
| 保留 | src/core/inputLedger.js；src/body/*、src/pathfinding/*、mod-client、mod-bridge | 保留输入账本、身体协议、导航和已有控制模组；本次动作脑迁移不重写 Minecraft mod 或底层协议 |
| 保留 | src/core/taskEvents.js、turnLifecycle.js | 保留事件身份/顺序/重放和等待-恢复-取消状态不变量；补运行关联身份与持久化接线 |
| 保留后适配 | src/harness/adapter.js、turnService.js、resumeBridge.js | 这些类本身不调用模型，可以暂留兼容；移除 DSH 运输依赖后复用核心语义，不因目录名带 harness 就全部重写 |
| 保留后改接 | DialogueRouter、统一/旧语言脑、TaskGoalInjection、ScreenshotPolicy、AutonomousProposalCoordinator、AutonomousMode | 从 HarnessBridge 改为 ActionBrainRuntime；保留来源、防双执行、限额、批准、失败和恢复策略 |
| 必须新建 | Pi SDK adapter、运行监督器、ToolBroker、共享 mc_* 工具注册表、子代理调度器 | 统一会话/模型事件、权限、预算、取消树、结果封装和工具执行身份 |
| 必须新建 | 产品运行事件规范、运行/执行权账本、恢复协调器、产品插件宿主 | 将 SDK 会话状态与游戏工作流分开；插件声明/授权/生命周期/隔离归产品所有 |
| 必须新建 | 产品活动 UI 与交互接口、打包启动/诊断流程 | 展示任务树、工具输入/输出、计划证据、地图/截图、停止和接管状态；不能把终端输出当成完整 UI |
| 最终退役 | DSH agent 发现/绑定、DSH /goal* 生命周期、默认 8770 的插件服务、DSH profile 安装要求 | 在 Pi 路线全部通过并保留可回滚版本后退役，不能在兼容尚未完成时提前删除 |

## 3. 业务模块与方法接线清单

下表的“新增”表示计划中的目标接线，并非当前已实现。

| ID | 当前接线与源码符号 | 迁移工作 | 保留/新增边界 | 验收 |
| --- | --- | --- | --- | --- |
| M01 | src/index.js:342，actionBrainMode 只识别 harness / planner-first，其他值回退 planner | 显式支持 Pi 模式，创建一个 ActionBrainRuntime 并放入 ctx；不再以 HarnessBridge 是否存在判断动作脑可用 | 新 runtime 工厂；现有 body/brain 初始化保留 | Pi 配置不会静默回落本地 planner；依赖缺失可诊断失败；只创建一个 runtime |
| M02 | src/index.js:360，new HarnessBridge、ctx.harnessBridge、bind/autoBind | 用本地 runtime 生命周期替换 URL、外部会话绑定与健康查询；兼容模式可独立保留旧 bridge | 退役 DSH 发现；新增 runtime.status | 不启动 DSH 时 Pi 模式可初始化；启动日志展示 provider/model/runtime，而非要求绑定 DSH 对话 |
| M03 | src/index.js，ctx.forwardToActionBrain | 保留唯一转发入口；保留原文、source/speaker/位置/自卫姿态；将原文作为数据字段交给 start 或 steer，格式化提示由 adapter 负责 | 保留调用者接口，内部改接 | 原文逐字保留；一个批准只产生一个本地请求；不存在“先投消息、再另建执行目标”造成双派发 |
| M04 | src/chat/dialogueRouter.js，route、_forward、_maybeGoal、buildRequestEnvelope | 保留 planner 回滚和无静默 fallback；_forward 改 runtime；移除 bind 重试、agentId 和 DSH 专用不可用文案 | router 是路由器，不执行任务 | Pi 不可用时明确反馈；不会转成本地动作；@ 路由和语言审批路由关联同一 requestId |
| M05 | src/llm/languageBrain.js，_approval、forwardToActionBrain、renderActionOutput、expressProposal | 审批通过后把原文交给统一入口；动作报告仍由 renderActionOutput 决定语言表达；提案继续经 expressProposal | 语言脑权限不扩张 | roleplay/expert/approval 工具面中无身体工具；拒绝请求不启动动作脑；沉默/失败 fallback 的现有语义保留 |
| M06 | src/llm/languageAgent.js，respond 的 approve 分支；src/llm/tools/registry.js、toolSurface.js | 旧 language 路线仍使用 ctx.forwardToActionBrain；共享工具注册表不能把 mc_* 执行工具混入旧语言工具面 | 复用现有 schema 校验/工具分面思想，不把两张注册表误认为同一协议 | 旧/统一语言模式各做一次审批契约测试；非法执行工具在 dispatch 前拒绝 |
| M07 | src/core/taskGoal.js，activeGoal、maybeCreate、maybeCreateDialogue、status | 去除 boundAgentId/goalOf/createGoal；显式区分“Node 已执行的监督目标”和“自然语言待执行目标”；dedupeMs 与 onNewGoal 失败账本边界保留 | 目标编排新建，确定性执行保留 | !chop 等只入队一次；动作脑不重放已下发任务；新目标可监督失败并关联原 taskId；重复窗口与预算有效 |
| M08 | src/planner/autonomousProposals.js，blockedReason、startPrep、accept、abortGoals、completePrep、_agentId | 用 runtime.status 判断可用/忙/停止；start({purpose:proposal}) 替代 DSH prep goal；接受提案才 start 执行目标；stop 替代 pause/complete | ProposalDesk、Curriculum、冷却、TTL 和批准账本保留 | prep 无身体写权限；超时/拒绝不执行；接受后一个执行目标；DSH paused 残留不再阻塞下一轮 |
| M09 | src/core/autonomousMode.js，start、pause、off、tick、onDeath、onRespawned、_deathSequence | 去掉 start 中对 ctx.harnessBridge 的硬要求；将 pause/off/接管联动到 runtime.stop；恢复由本地工作流状态控制 | 自主模式策略和死亡序列保留；模型启停改接 | !stop 暂停自主模式；!resume 不擅自重启全自主；!autonomous on 显式接管；死亡/重生后无旧回合抢身体 |
| M10 | src/perception/screenshotPolicy.js，activeGoal、capture、steer、status | activeGoal 改读 runtime.status；steer 发送结构化附件引用/图像内容和关联 runId，不依赖 DSH imagePath 变换；保留捕获预算、去重、旁注与清理 | 图像适配新增；截图策略保留 | 无活动目标不投递；同一张图不重复唤醒；支持的视觉模型收到图像内容；不支持时明确降级，不能假称已看图 |
| M11 | src/harness/actionBrainStop.js，stopActionBrain、clearActionBrainGoal、hasStopLock、allowedWhileStopped | 对外 wrapper 可保留，但改为调用 runtime.stop；owner-stop 硬锁继续在 Node 工具入口生效；移除 DSH pause→complete 和 leftover-goal 清理 | stop 业务语义保留，DSH 顺序退役 | 在途推理、工具、子代理和计划均被取消；旧输出无法调用身体；停止各阶段失败可见；幂等停止 |
| M12 | src/chat/commands.js，stop / pause / resume / autonomous、命令执行时 fromActionBrain 检查 | !stop、面板急停与 runtime.stop 共享停止协调；恢复需显式解除本地锁并重新确认可执行目标，不能简单重放模型消息 | 命令白名单和权限规则保留 | stop 后只读/stop 等许可命令仍可用；迟到 mc_step 拒绝；普通 resume 与全自主恢复语义不混淆 |
| M13 | src/brain.js，HarnessAdapter/TurnService 构造、PlanService 挂载、任务结算与持久化 | 把 runtime 与 ToolBroker 接到已有 plan/task/turn 事件；保留 waiter 先注册再执行的顺序；不再要求插件 SSE 才能唤醒 | adapter 可暂留兼容；新内部事件消费者 | 立即失败/完成的任务也能唤醒一次；多个相同名字任务以 taskId/attemptId 区分；重复事件无双结算 |
| M14 | src/web/statusServer.js，/say、/command、/plan、/harness/*、/ui/state、/status、/events | 控制/状态 API 保留；新增产品 runtime 状态和事件适配；旧 /harness/* 先兼容后废弃，不再作为进程内必经路线 | 共享服务，不新增竞争端口 | 产品 UI 可关联 runtime/plan/task；UI 断连不影响任务；危险测试 hook 仍默认关闭 |
| M15 | src/core/failureEscalation.js、src/world/toolPolicy.js、src/core/channelPolicy.js、src/codeSkills/service.js | ToolBroker 调用这些现有策略，传递 source/run/tool/signature；新插件/子代理不能绕过失败升级、输入/代码技能规则 | 核心策略复用；身份/权限接线新增 | 同签名盲试仍被阻断；knowledge/unverified 按查证/提问链处理；代码生成不能绕过晋升/批准运行 |
| M16 | src/pcl/*（start.ps1 读 PCL 版本 JSON 拉起客户端）、实例/mod 配对逻辑 | 产品**不拉起游戏进程**：实例目录泛化为"版本 JSON + mods 目录"（PCL2 布局只是来源之一，无 PCL 运行依赖）；游戏由用户自选启动器启动，产品只 discover/attach/onGameLost（GameControlPort 进程接缝，原子三件套，部分注入即构造失败）；配对/安装保留人类确认 | 启动职责交还用户；配对与版本管理归产品 | 无 PCL2 干净机 + 用户自启动游戏完成配对→attach→任务→stop（B5-12）；部分进程接缝构造期失败、缺接缝关闭式失败（B2-28） |
| M17 | src/planner/curriculum.js、src/memory/store.js、src/memory/chatMemory.js、src/learning/methodLibrary.js、Pi SessionManager 会话目录、异步受理账本 | 全部持久层按 `worldKey` 分区（主计划 §6.3）：回执/终态事件带 worldKey（SCHEMA_VERSION 2）；跨 worldKey 事件 `cross-world` 拒收；缺失落 `default` 分区并显式告警；既有全局账本一次性迁入 default | 分区键进 schema，执行语义不变 | 同一安装接入两个世界，账本/难度带/方法/知识/聊天/会话目录互不可见（B2-30） |

## 4. 全部工具迁移清单（14 个 mc_* + lookup_mod_content）

当前工具定义集中在 dsh-plugin-mc-harness/lib/index.js:130–950。首阶段保留这些名称、参数和结果含义，抽成项目拥有的共享注册表，再由 Pi adapter 转为 SDK custom tools。不要把 src/llm/tools/registry.js 的旧 observe/do_task 工具误当作已有 mc_* 注册表。

兼容层可以暂时维持 DSH 的 JSON 字符串结果；新内部 ToolBroker 应使用结构化结果，再由各 adapter 格式化。字符串→对象的切换必须版本化并测试，防止副作用已执行但模型因结果格式不符重试（mc_say 已有该类历史修复注释）。

| ID / 工具 | 当前输入与后端 | 能力/必须保留的约束 | Pi 迁移与验收 |
| --- | --- | --- | --- |
| T01 mc_observe | {full?:boolean}；普通 GET /ui/state；full=true 时 POST /observe，fields=FULL_OBSERVATION_FIELDS、purpose=decision | 只读；短状态包含 position/health/food/time/current/queue/selfDefense；完整观察用于一次决策而非轮询 | 共享观察 handler；短/全两种响应兼容；含观察时间/真实自卫姿态；无身体写入 |
| T02 mc_perception | {type?:all/threat/weather/phase/chat, since?:integer, limit?:integer}；GET /perception | 只读、边沿事件、分页；不是每 tick 全量 push | 保留 seq 游标和过滤；重复唤醒可合并；旧游标范围外可提示缺口 |
| T03 mc_state | 必填 fields:string[]；可选 area、maxAgeMs、purpose:survival/task/decision/answer/explore；POST /observe | 只读；字段 observedAt/age/revision/stale；结构化状态优先，aux.screenshot 仅辅助 | 保留 freshness 和区域语义；不能由截图把失败条件改为成功；字段不支持时不捏造 |
| T04 mc_propose | 必填 type；可选 name、args、reason、autonomous；POST /propose | 改提案账本、不执行身体；prep 中必须 autonomous=true；ProposalDesk/Curriculum 校验仍有权拒绝 | 单独 permission scope；接受回执只表示已提案；拒绝/过期/未批准不会 start 执行 |
| T05 mc_memory | action:grep/save（默认 grep）；query/text/tags/category:episodic/semantic/relational/limit；GET/POST /memory | grep 源限定 task-event/plan-event/action-brain；save 必须 text；长期记忆不是 Pi transcript 替代品 | grep 为读、save 为写，分别授权；保存 source/conditions/关联 ID；不自动把全部记忆塞入上下文 |
| T06 mc_step | 必填 command:string（无前导 !）；POST /command，via=mc_step；当前返回 {accepted,command,receipt} | 一次一个命令；插件 prepActive 时直接拒绝整个 mc_step 调用；沿用命令表、stop lock、失败升级、输入账本和能力优先 | Broker → 现有命令分发；body scope、取消 signal、owner/epoch 检查；accepted 不能标记目标成功；任何第三方调用无旁路 |
| T07 mc_ask_player | 必填 question；可选 reason；POST /ask_player | 带证据的单一问题；停车等待；等待时身体写受阻；全自主模式明确拒绝求批准 | 绑定 pending question/run；回答以事件恢复；无回答不等于同意；不能用 finish 绕过待答或审批 |
| T08 lookup_mod_content | 必填 query:string；可选 count:integer（工具说明为 1–10，默认 5）；POST /lookup_mod_content | 只读网络知识；限动作脑；输入避免坐标/玩家/服务器敏感数据；返回不可信资料，不可改变权限或直接变成行动 | 网络能力单独授权；保留来源 URL、untrusted 和查询记录；查证调用不能顺带执行身体工具 |
| T09 mc_plan | 必填 goal:string、steps:array；可选 planId:string、baseVersion:number；step 仅 id 是 schema required，另有 type/args/question、pre/postconditions、wait、methodId、replan status=pending/done；POST /plan | PlanService 继续验证 step 类型等业务要求；不重复 mc_step；新计划/重规划版本校验；声明式条件；部分完成只补未完成数量；prep 禁止提交 | 直接调用 PlanService 或其兼容 HTTP adapter；先登记等待再 start；快速结算不丢唤醒；旧 baseVersion 拒绝；已有 done 步不重跑 |
| T10 mc_plan_status | 必填 planId；GET /plan/<id> | 只读，返回 state/steps/budget/version/结果与剩余数量 | 读不获取身体权；错误 planId 明确返回；UI 和模型读同一权威状态 |
| T11 mc_cancel | 可选 planId、reason；有 planId 则 POST /plan/<id>/cancel，否则取消当前 turn | 当前依赖插件 currentTurnId；取消计划与取消 runtime 不同，需明确范围 | 改用本地运行关联；指定计划只取消该计划；无 planId 取消拥有它的运行；不能把“发出请求”当“身体已停” |
| T12 mc_finish | 必填 summary；可选 achieved:boolean；当前仅插件运行记录 | 无身体副作用；模型自述不是验证结论；不能解除 stop/待答/权限 | 写应用结算候选及证据引用；监督器根据任务/计划证据完成目标；achieved=true 无证据不升级成功 |
| T13 mc_say | 必填 text；POST /say，source=action-brain；当前输出 JSON 字符串 | prep 不得说；无命令执行；统一语言脑 renderActionOutput；去重/限长/限频；不通过说话索取权限 | 复用语言报告入口；保留 requestId/消息身份；重试不重复发言；动作脑输出与玩家聊天源区分 |
| T14 mc_capabilities | 无参数；GET /capabilities | 只读；live channel order、命令和已晋升 code skill；能力优先，不写死旧命令列表 | 共享实时注册表；工具/插件装卸后 revision 更新；不可用能力明确显示，不伪装为已实现 |
| T15 mc_keybinds | query、mod、onlyMod、limit；GET /keybinds | 只读实时 KeyMapping；使用稳定 namespaced id；原始 R/键码不得当能力接口；每次获取当前绑定 | 保留 live 查询；重绑后 stable id 仍可用；未注册映射明确限制；插件无法绕过 raw-key 拒绝 |

参数核验说明：上述 15 个名称及 required 字段直接对照 toolDefinitions 的当前定义。mc_perception.limit、mc_memory.limit、lookup_mod_content.count、mc_keybinds.limit 的范围出现在工具 description 中，插件 JSON Schema 没有写 minimum/maximum；迁移时必须分别保留说明、校验下层实际边界，不能把说明误记为 schema 已强制。mc_keybinds 是纯读取工具；按其稳定 ID 发起 tap/hold/key 的执行仍属于 mc_step/命令通道。

### 4.1 Broker 的最低执行责任（新建）

- 工具注册条目至少有名称、版本、JSON schema、read/write 类别、所需能力、允许的运行模式、执行者与结果 schema；来源区分 builtin/plugin/subagent。
- 每次调用带 requestId/runId/toolCallId、父子任务身份、授权主体、signal、执行权版本与 worldSessionId。schema、权限、运行状态、预算检查必须先于副作用；新世界/新身体连接不能仅靠 epoch 数值区分。
- 停止、只读、提案账本写入、记忆写入、游戏身体写入、工作区写入、进程执行、网络访问分别授权；不能用一个通用 write 权限全部开放。
- 游戏写操作沿用 TaskSlot/PlanService；首版子代理不授予身体写权限，只返回建议给主代理，也不能取得独立身体句柄。文件编辑/代码生成先在其受限工作区完成，代码技能晋升与运行仍走现有规则。
- 事件至少报告调用开始、进度、结束、拒绝、取消和耗时；结果保留原始 receipt/failure class/requires/remaining，不用统一“ok”吞掉失败细节。
- 工具重试只允许在明确幂等或已核对世界效果后进行；网络取消不表示远端副作用未发生。工具执行结果缓存/去重键应覆盖运行身份，不能仅以工具名和参数猜测。

### 4.2 异步受理与事件唤醒（新建）

契约正文：[ACTION-BRAIN-ASYNC-CONTRACT.md](ACTION-BRAIN-ASYNC-CONTRACT.md)。骨架：`src/actionBrain/asyncContract.js`、`eventMailbox.js`、`wakeScheduler.js`（占位，未接入）。

- 动手工具（T06 mc_step、T09 mc_plan、code_skill）返回**受理回执**而不是等待完成：`{schemaVersion, ok, async:true, taskId, verb, state:'accepted', acceptedAt, attempt, runId, epoch, worldSessionId, worldKey, deadlineMs, hint}`。回执**永远不能**被模型当作成功；只有终结事件能写账本。
- 只读工具（T01/T02/T03/T10/T14/T15）保持同步；`stop`/`cancel` 同步且幂等，任何情况下不排在任务后面。
- 忙时**拒绝式受理**：`{ok:false, reason:'body-busy', class:'precondition', currentTask:{taskId,verb,state,progress}, requires:['task_stop','wait-for-task.finished']}`。不排队、不静默替换——替换会误杀干了一半的活。
- 工具层唯一责任：分类（以 `src/core/keyActions.js` 动词表为唯一来源）→ 抢 `TaskSlot` 租约 → 立即返回回执 → 任务终结时通过 `gameControlPort` 侧发事件。**不新增执行器**：仍走现有 TaskSlot/PlanService。
- 终态扩展为 `succeeded / failed / dropped / timeout / cancelled / interrupted`。`dropped`（无活可干）与 `cancelled`（合法叫停）**不进失败阶梯、不动课程难度带**；`timeout` 允许同一调用续做一次。
- 结果格式从 DSH 字符串切到结构化对象必须带 `schemaVersion` 并单独测试（§4 开头的兼容要求同样适用于回执）。

### 4.3 任务事件端口与双门（本轮审计追加）

- **端口**：宿主除 `observe/execute/waitForIdle/cancel/releaseInputs` 外，异步模式还必须提供 `tasks()` 与 `onTaskEvent(cb)`；缺一即 `async-port-required` 关闭式失败（不允许"回执照发、账本不存在"）。
- **单一事实源**：`onTaskEvent` 推送的 `task.finished` 是任务终态的唯一来源；runtime 只做身份盖章（`epoch/worldSessionId`）与转发，不建第二本账。
- **双门**：`start(goal, {taskMode:'async'})` 的回合门只要求模型 settle；`waitForIdle` 只在 `sync` 模式或任务结算路径使用。UI/课程/失败阶梯只读任务终态。
- **关联**：端口上下文统一带 `{runId, epoch, worldSessionId}`；跨世界事件拒收（`stale-world`）。
- **不存在的能力**：`execute` 的 `accepted:true` 仍然不是完成证据；回执必须由 TaskSlot/PlanService 的任务号背书。

## 5. HTTP 与 SSE 兼容清单

当前业务 API 位于 src/web/statusServer.js，共享单一控制服务器。迁移初期可让共享工具 handler 保留 HTTP adapter，以便面板、现有脚本和测试继续使用；Pi 进程内调用不应为绕一圈 HTTP 而复制业务逻辑。

端口核验：DSH 插件的 DEFAULT_PORT=8770、DEFAULT_CONTROL=http://127.0.0.1:8766，且 apply 允许 config.port/controlUrl 覆盖（dsh-plugin-mc-harness/lib/index.js）。Node 控制面的 statusServerPort 优先采用 --status-port，再采用 agent.web.port，未设时为 server.bridgePort+1，bridgePort 缺省 8765 因而通常为 8766（src/index.js:53）。身体 clientMod.port 默认 8899（src/util/config.js:124），不是动作脑插件端口。实际部署以有效配置和启动返回的监听地址为准；不得把这些默认值写死成 Pi 的新端口要求。

| 接口 | 当前用途/源码锚点 | 目标处置 | 验收 |
| --- | --- | --- | --- |
| GET /health、/status、/ui/state、/panel/state | 健康、完整诊断、轻量 UI 状态；/ui/state 不能替换为含巨大 block map 的 /status | 保留；新增规范化动作脑摘要，模型 transcript/凭据不能混入公共 snapshot | 大状态不使 UI 卡顿；runtime 不可用可诊断；状态不包含 API key |
| GET /events/recent、/events | TaskEvents 历史与 SSE；:135、:157；src/web/eventStream.js | 保留任务事实流；新 runtime.subscribe 经产品事件适配汇合，但区分 event domain | Last-Event-ID/游标重连无双结算；断连不影响生产；ring 缺口不冒充完整历史 |
| GET /perception、/capabilities、/keybinds；POST /observe | 观察/能力入口；:167–266 | 保留语义；抽 handler 供 broker 和 HTTP 共用 | 输出与当前工具契约一致，权限与 freshness 生效 |
| GET/POST /memory；POST /lookup_mod_content | 任务记忆与动作知识查询；:334、:383 | 保留；分别接记忆/网络授权及事件 | 来源/不可信标志/失败原因不丢失；lookup 不执行动作 |
| POST /ask_player、/propose | 待答/提案；:480、:559 | 保留；补 run/question/proposal 关联身份 | 答案仅恢复对应运行；提案不被自动执行 |
| GET/POST /plan；GET /plan/<id>；POST /plan/<id>/start、resume、cancel | PlanService 接受、读取、生命周期；:599、:706 | 保留为计划权威边界；仅路由和调用身份适配 | 202 为接受非完成；版本冲突/部分完成/后置条件/取消语义不变 |
| GET/POST /command | 现有命令表和工具入口；:1370 | 保留兼容；新内部调用不得绕过其已有策略，宜抽统一 command service | source、优先级、stop lock、失败 envelope 与重复命令策略一致 |
| POST /say | 动作结果表达；:1297 | 保留并复用 LanguageBrain.renderActionOutput；产品 UI 事件另走事件流 | body.raw 仍是明确的 operator/test 特例，插件不能借 raw 绕语言策略 |
| POST /emergency-stop | 当前 emergencyStop(ctx)；:1554 | 接入统一停止协调器，保留不依赖模型的直接控制入口 | 模型/SDK/网络卡住时仍能停；报告输入释放和各取消结果 |
| GET /screenshots、POST /screenshots/capture、GET /task-goals、/autonomous、/curriculum | 诊断/面板；:244–320 | 保留有用数据；task-goals 逐步映射本地 runtime 目标，明确兼容字段 | UI 不显示已退役的 DSH agent 状态；截图缓存策略不变 |
| GET /code-skills*、POST 生成/取消/回滚/试验/晋升/运行 | 现有代码技能服务；:982–1106 | 保留；新子代理/插件作为受限调用者接入，不能新造自动晋升通道 | 未批准或未晋升代码不能运行；取消和回滚可观察 |
| GET /harness/events、/harness/turns；POST /harness/turn；GET /harness/turn/<id>；POST wait/finish/cancel | DSH 插件与 TurnService 的运输层；:772–833 | 内部 waiter 先改直连；HTTP 暂保留兼容，最终标记 deprecated 或移除；不成为新 runtime 的公共命名 | 内部 Pi 不靠 SSE 回环才能恢复；现有客户端升级期行为可测；删除前已无默认调用者 |
| GET/POST /harness/inject；/chat/inject；/test/* | 故障注入/离线测试；:844、:1122 等 | 保留受限测试能力并扩充 runtime 假事件；不得随生产默认启用 | web.testHooks=false 且 P1_TEST_HOOKS 未开时不可访问；插件不能启用 hook |

### 5.1 DSH 插件端服务：最终退役

下列路由由 dsh-plugin-mc-harness/lib/index.js 的插件服务实现（默认 8770，可配置），并非游戏内核 API：/message、/bind、/agents、/health、/goal、/goal/pause、/goal/resume、/goal/complete。HarnessBridge 的 forward/health/boundAgentId/createGoal/completeGoal/pauseGoal/resumeGoal/listAgents/goalOf/autoBind/bind 都属于该兼容层。

迁移动作：/message 的 followup/steer 转为 runtime start/steer 的明确语义；/goal* 的目标状态转为本地运行/目标账本；/agents、/bind、autoBind 取消；/health 改查产品自己的 runtime.status 和 provider 诊断。旧 Goal 对象的 phase/revision/roundsStarted/maxGoalRounds 只能留在兼容适配器中。

验收：关闭 DSH、删除本机 DSH profile 插件后，Pi 路线的聊天任务、提案、计划唤醒、截图、停止和恢复仍可运行；旧 DSH 配置不得导致隐式联网或静默绑定其他对话。

## 6. 必须保留的执行与事件契约

### 6.1 PlanService / PlanRunner / PlanStore

源码：src/core/planService.js。当前 public 方法：submit(draft, options)、start(planId, options)、resume(planId, answer, options)、cancel(planId, reason)、cancelAll(reason)、waitFor(planId, timeoutMs)、get、list、status、onEvent、toJSON、restore、restoreQuestions。

- submit 是校验/接受入口；保持已存在计划的 baseVersion 校验及重规划限制，不用模型生成的新对象覆盖已完成步骤。
- 执行仍由 PlanRunner 经现有 Brain/TaskSlot 发任务；保持前置/后置条件、wait_for_player、methodId、Budget、partial 和 remaining 等语义。
- onEvent 是新 runtime 的权威事实源。等待关联必须在 PlanService.start 之前登记，防止立即结算的计划先完成而丢唤醒。
- cancelAll 是异步协作取消；stop 应等待可观察的身体释放或报告超时，不把调用函数返回当成所有设备已停。
- toJSON/restore/restoreQuestions 的接线继续纳入应用持久化；恢复后待答/部分计划先核对世界，不重放已完成外部效果。

验收：新旧入口对同一 mock plan 的 receipts、version、steps、budget、events、partial/remaining 等价；含立即失败、后置条件失败、旧版本重规划、玩家等待、取消中途和重启恢复。

### 6.2 TaskSlot / TaskHub / 身体输入

源码：src/core/taskSlot.js。保留 acquire(owner)、release(owner)、waitForRelease(kind, timeoutMs)、clearQueue、runTask(task)、publish、toJSON/restore；保留 busy/brainTask/hubHandle 和共享 queue 的权威性。

- TaskSlot 是身体所有权事实源；新增 runtime 的 busy 不能代替 TaskSlot.busy。
- 新工具/子代理提交的任务沿用 buildTask/enqueue 或现有技能调度；不得直接调用 body/输入协议而形成第二执行器。
- 协作取消后必须等旧 owner 确认释放，再允许新 owner 获取身体；不能用固定 sleep 认为已经停。
- src/core/inputLedger.js 的 releaseAll(reason) 是停止/死亡/断连的输入释放接点；保留失败逐项记录。Node 账本清空不证明客户端按键已释放，必要时核对身体侧 input.held/心跳状态。
- 保留任务隔离/重试的已有规则，尤其 deliberate cancellation 不得被 B2 retry 或恢复任务再次拉起。

验收：并行模型工具/子代理不能同时获得 body；停止一个保持按键的动作后输入账本和客户端 held 都清零或显式报告释放失败；新运行不会越过未释放 owner。

### 6.3 TurnLifecycle / HarnessAdapter / TurnService / ResumeBridge

源码：src/core/turnLifecycle.js，src/harness/adapter.js、turnService.js、resumeBridge.js。

- 保留 running → waiting → resumable → running → done，以及任意活动状态 → cancelled 的规则；同一会话最多一个 active turn。
- TurnLifecycle 的 begin/wait/ingest/resume/finish/cancel、匹配 taskId、取消后拒绝、事件只消费一次保持不变。
- HarnessAdapter 的 start/toolCall/planCall/planEvent/onTaskEvent/resume/cancel/finish/ingest/replay 可继续作为通用适配；plan:<planId> 是内部等待身份，不是 Pi 会话 ID。
- TurnService 的 begin/waitTask/trackPlan/onPlanEvent/cancel/cancelAll/finish 继续负责本地关联；plan:waiting/completed/partial/failed/rejected 可唤醒，plan:cancelled 取消 turn。
- ResumeBridge 的一次性投递与重试不能因改成进程内订阅就删掉；错误/重复/乱序测试仍使用同一真实路径。
- Pi SDK 层“模型回合结束/会话空闲”与本地“计划正在执行/等待回答”是不同维度。adapter 必须按锁定 SDK 版本的最终 settled 语义对齐，不能在中间 assistant/agent_end 事件就允许第二个运行抢占。

验收：错误 taskId 不唤醒；重复终结事件只消费一次；先取消后到达的完成/模型输出不复活；投递重试不双 resume；重连先恢复账本再消费新事件。

### 6.4 TaskEvents 与新产品事件

源码：src/core/taskEvents.js，方法 publish/since/subscribe/status/toJSON/restore。

- 保留单调 seq、eventId 去重、bounded replay、存储后通知订阅者和订阅者异常隔离。
- ring 是有限重放缓存；代码已有 toJSON/restore，但跨进程/重启是否可靠取决于应用是否正确持久化。不得把内存事件环当无损永久事件数据库。
- 新 runtime 事件统一携带 eventId、seq/游标、at、runId、requestId、parentRunId、toolCallId、epoch、worldSessionId 和适用的 planId/stepId/taskId/attemptId；事件域标出 runtime/task/plan/plugin 等来源。
- Pi 原始事件放在 adapter 私有层，公开流只发布稳定事件，如运行开始/空闲/等待/完成/取消、工具进度、子代理状态、压缩开始/结束、恢复决策和权限拒绝。
- UI 展示模型可见输出、计划、工具参数/结果、证据、状态和人工交互，不要求或伪造模型内部思维链。

验收：产品 UI 与任务账本能用 ID 串成同一时间线；事件重连不重复动作或发言；压缩后仍保留目标、权限、停止锁、未完成量和证据引用。

### 6.5 任务账本、收件箱与回合唤醒

新增的三个契约点（骨架见 `src/actionBrain/eventMailbox.js`、`wakeScheduler.js`；正文见 [ASYNC-CONTRACT §6](ACTION-BRAIN-ASYNC-CONTRACT.md)）：

- **TaskEvents 扩事件族**：`task.accepted / task.progress / task.waiting_player / task.finished / task.interrupted / plan.updated / chat.incoming / perception.edge / steer.requested / policy.denied`。沿用单调 seq、`eventId` 去重与 bounded replay；新增字段 `schemaVersion/taskId/attemptId/epoch/worldSessionId/worldKey`。
- **收件箱（三态路由）**：回合进行中只入箱、工具批边界倒空；回合结束且后台在跑允许开轮；完全空闲时**只有活人说话与显式 steer 能开轮**。同 `taskId/planId/thread` 按 seq 合并，禁止逐条 progress 注入。
- **回合映射**：`TurnLifecycle`/`TurnService` 的等待身份继续用 `plan:<planId>`/`taskId`；一个终态事件只唤醒一次；`cancelled` 之后到达的 `finished` 一律作失效审计，不推进状态。
- **持久化**：`accepted` 先落盘再执行；重启把 `accepted/running` 转为 `interrupted` 并附恢复注记，**不重放** dig/place/click。
- **反轮询**：完成必须推送，`task_status` 只作现场核对；`whyNotWake()` 说明"为什么刚才没开轮"。

验收：回执 <200ms 且不结算成功；模型调用中到达的终态不进本次输入；同一 `eventId` 只消费一次；忙时拒绝带任务号且不覆盖旧任务；硬杀后 `interrupted` 零重放；`dropped` 不改失败阶梯与难度带（对应验收 B2-15…B2-20）。

### 6.6 边界、入站与生命周期门面（本轮审计追加）

- `runtime.boundary()`：宿主在工具批返回后调用，是事件注入模型的**唯一合法时机**；`turn:boundary` 是收件箱/唤醒调度器的输入。
- `runtime.ingest(event)`：外部事件入站，按 `eventId` 幂等、按 `worldSessionId` 拒收（`stale-world`）并按 `worldKey` 拒收跨世界事件（`cross-world`，2026-11-06 增补）；**不路由**（路由在收件箱）。
- `runtime.discoverGames()/attachGame(candidate)`（2026-11-06 增补）：进程接缝门面——游戏由用户拉起，产品只发现/接入；缺进程接缝关闭式失败（`process-port-required`）；活动 run 中 attach 被拒（换世界先 stop）；attach 采纳宿主从游戏侧读取的 `{worldKey, worldSessionId}`，不自造；`onGameLost` → `game:lost` + 正常停止链。
- `pause(reason)/resume()`：冻结新派发，不销毁会话；暂停期间 `start` 抛 `paused`；恢复必须重新感知。
- `stop(reason, {force:true})`：确认失败时记 `force-stopped`；`unsafeDrivers` 仍硬阻，未确认子代理保留跟踪——**不允许永久锁死启动**，也不允许把未确认停止显示为已停稳。
- `start(..., {deadlineMs|budget, initTimeoutMs})`：思考时限到点 `run:deadline` + 正常 stop；工厂初始化超时不再造成"起不来也停不掉"。
- `ask(question)` / `resumeRequest()` / `usageReport()`：分别对应待答停车、恢复注记与用量取数。

验收：对应 B2-21…B2-27（异步回合不被任务判失败、工厂超时、强制停止解锁、暂停/恢复、思考 deadline、边界与入站幂等、端口关闭式失败）。

## 7. 配置、脚本与部署清理清单

当前配置由 src/util/config.js 的 DEFAULTS、loadConfig、deepMerge 组合 config/*.json、*.local.json 和 profile；不要只改 config/agent.json 而留下默认值和 overlay 不一致。

| ID | 当前项 | 迁移计划 | 验收 |
| --- | --- | --- | --- |
| C01 | config/agent.json 的 chat.actionBrain=harness、harnessUrl、harnessAgentId；src/index.js 的解析 | 增加显式 Pi provider/runtime 配置；旧字段仅在兼容模式读取并告警，最终废弃 | 旧字段不会影响 Pi 模式；未知模式启动报错/明确降级，不静默 planner |
| C02 | config/agent.local.json、profile overlay 中可能固定的 DSH 会话 ID | 提供配置迁移检测；不自动把外部会话 ID 当本地 runId | 不读取/打印敏感值；检测到旧字段有可操作提示；干净用户无需编辑会话 ID |
| C03 | taskGoal.purpose/maxGoalRounds/dedupeMs；截图、autonomousProposals 等注释写死 DSH goal | 迁移为本地目标类型与运行预算；保留有用配额，清除 DSH phase/round 假设；同步默认值/注释/校验 | 所有配置有消费者；预算不因换名失效；值与实际行为相符 |
| C04 | package.json CommonJS、Node >=18；无 Pi 依赖 | Pi adapter 隔离 ESM 边界；锁定精确包版本和兼容 Node；产品捆绑所需 runtime 与资源，不要求全仓库先迁 ESM | 安装、动态 import/worker、流式、取消和资产加载在打包产物中通过；不能仅 node_modules 开发目录可用 |
| C05 | scripts/install-dsh-plugin.js；npm dsh:install | 默认启动/安装不再复制到 ~/.dsh/profiles/desktop/node_modules 或修改 patch.yml；旧脚本留在兼容工具或归档 | 新产品安装无需 DSH profile、插件目录和手工重启 DSH |
| C06 | dsh-plugin-mc-harness/package.json/lib/index.js | 先抽工具定义/业务 handler；旧插件变薄兼容 adapter；最后从默认发行物移除 | 新发行物不依赖 8770；旧 DSH adapter 的保留/删除在发布说明可追踪 |
| C07 | scripts/dsh-h1-test.js、DSH_AGENT_ID；plugin-receipt-test.mjs、plugin-goal-test.mjs | 前者保留为 legacy integration；工具回执/目标语义断言迁移到共享 registry/runtime 测试；不能随插件删除而丢失回归覆盖 | 无 DSH 的新测试覆盖相同 bug；兼容测试有明确分组，不成为新产品必需前置 |
| C08 | scripts/m5-channel-live-probe.js 依赖 /goal；m5-agent-probe.js 走 /command | channel probe 改对新 runtime；保留 command/body probe 作为独立下层测试 | 能分别诊断模型、broker、Node 命令、mod/身体，不把全部失败归到模型 |
| C09 | start.ps1、stop.ps1、start-agent.bat、scripts/run-all.js | 单入口只管打包 runtime/产品 UI 与游戏**接入**（discover/attach）；**不拉起游戏进程**（用户自选启动器启动，产品对 PCL2 无运行依赖）；start.ps1 的客户端拉起链保留为开发工具；统一停止进程；当前脚本没有自动解决外部 DSH 安装，不能宣称只删一个脚本就已产品化 | 无 PCL2 干净机 + 用户自启动游戏完成闭环（B5-12）；新用户从安装包完成启动、接入、停止、重启；无源码组接步骤；日志包含明确版本和诊断 |
| C10 | web.eventsToken、web.testHooks、P1_TEST_HOOKS | 保留本地 API 鉴权/测试隔离；产品 UI/插件不共享万能凭据；测试 hook 默认关闭 | 生产默认禁用注入；第三方工具不能取得控制 API 的全权限 token |
| C11 | README.md、docs/DSH-HARNESS.md、旧验收说明中的 DSH 安装/绑定步骤 | 主入口文档改为产品安装和 Pi 配置；旧记录保留为历史并标出适用版本，不能重写已发生的验收事实 | 按新文档在干净 Windows 环境安装可复现；历史 PASS 不被标成 Pi PASS |

## 8. 停止、暂停与恢复的重新对接

当前 !stop 的 Node 接线见 src/chat/commands.js:195 起；它同时 preempt、owner-stop hold、hub cancel、PlanService.cancelAll、TurnService.cancelAll、nav.stop、body.interrupt，并调用 DSH 停止适配。新 runtime 只能整合这条路径，不能用 SDK.abort 替换其他阶段。

建议 stop 协调顺序：

1. 在任何远端 await 前原子地标记运行 stopping，提升/作废执行权 epoch，检查 worldSessionId，并设置 Node stop lock，阻止新增身体写入。
2. 立即请求 InputLedger.releaseAll、中断导航/身体，取消关联计划、turn、TaskHub 工作及任务队列；不等待 SDK 停止后才停身体。
3. 同时取消 Pi 当前操作与待发队列，向所有子代理、插件在途调用和 broker 调用传播 AbortSignal，禁止它们提交新任务；SDK abort/idle 确认可与身体清理并行。
4. 等待 TaskSlot owner 释放、核对身体连接/输入状态，并汇总模型 idle/子树取消结果；发生超时或释放失败时公开报告，保持写入锁。
5. 按实际结果结算 cancelled/paused/interrupted 或停止未确认状态（以最终契约为准），写入状态与证据；UI 展示各阶段事实，不虚报已停稳。

普通纠正用 steer；危险急停走本地 stop，完全不等待模型。若首版门面只提供 stop，暂停可用停止执行加保留本地目标 checkpoint 表达；恢复通过 start(resume request) 重新感知和决策，不需要为了模拟 DSH /goal/resume 增添一个会假装继续旧工具的 API。

恢复必须明确区分：供应商连接重试、Pi transcript 恢复、应用目标恢复、计划恢复、身体重连、死亡恢复和玩家显式继续。每一种都记录原 runId/新的执行权版本；不可安全确认的外部动作不自动重试。

验收至少覆盖：模型卡住急停、SDK abort 超时、子代理晚到结果、工具副作用已发生但响应丢失、保持按键时停止、游戏断连、进程强杀重启、死亡/重生、待答恢复、部分计划重规划、UI 重连和操作员人工接管。任何旧事件都不得绕过停止锁。

## 9. 回归与新增验收矩阵

以下是计划执行的验证，本文不声称已运行。现有脚本的 DSH 字符串/源文件断言需逐项迁移，不能通过删除断言让测试“变绿”。

| 验收 ID | 对应总阶段 | 覆盖接口 | 验证方法与通过标准 |
| --- | --- | --- | --- |
| A01 工具兼容 | B0 契约 / B2 游戏闭环 | T01–T15、Broker | 15 个工具参数/结果/拒绝样例契约测试；同一输入走共享 handler 与兼容 HTTP adapter 得到语义一致结果；非法 schema/权限在副作用前拒绝 |
| A02 不双执行 | B2 游戏闭环 | M03/M04/M07、mc_step/mc_plan | !任务、@任务、语言审批、提案接受各一条；每项只产生一个执行来源和一个目标关联；监督已有 task 不重做 |
| A03 提案隔离 | B2 游戏闭环 | M08、T04、T06/T09/T13 | proposal 模式只能读与提案；试图 step/plan/say 均拒绝；拒绝/超时不执行；全自主自动批准走本地策略账本 |
| A04 身体唯一性 | B2 游戏闭环 / B3 子代理插件 | TaskSlot、T06/T09、子代理 | 同时提交多个身体工具；最多一个 owner；旧 owner 未释放不启动新 owner；首版子代理身体写请求拒绝；取消重试不复活 |
| A05 计划语义 | B2 游戏闭环 | PlanService、TurnService | 版本冲突、postcondition 失败、partial/remaining、wait_for_player、即时终结、cancel、replan done 步；事实与当前内核一致 |
| A06 一次性恢复 | B0 契约 / B2 游戏闭环 | TurnLifecycle、TaskEvents、SSE | 重复/乱序/错 task/重连/投递异常；只匹配一次 wake 和一次 consume；cancelled 后晚到事件全部拒绝 |
| A07 急停闭环 | B2 游戏闭环 | M09/M11/M12、InputLedger | 卡住模型/长工具/持有按键时停止；先失效执行权并立即停身体，不等待模型；无后续身体动作；UI 不把“取消请求已发送”显示为“已停稳” |
| A08 上下文与长期恢复 | B1 模型上下文 / B2 游戏闭环 | Pi adapter、本地账本、PlanStore | 长任务触发压缩后目标/权限/未完成量/待答/证据引用不丢；杀进程再启先观察，已发生动作不被盲重放 |
| A09 语言与来源 | B2 游戏闭环 | M04–M06、T13 | 原文、speaker/source、请求 ID 可追踪；语言脑无执行工具；结果不增加事实、不重复发言；不可用有明确反馈 |
| A10 观察与图像 | B1 模型上下文 / B2 游戏闭环 | T01–T03/T15、M10 | freshness、范围过滤、截图预算/去重/关联、图像不支持降级；结构化失败不能被图像自述覆盖 |
| A11 插件/子代理边界 | B3 子代理插件 | Broker、插件宿主、调度器 | 首版子代理不能写世界；无 workspace/network/process scope 不能越权；父取消传播；插件不能取得原始身体对象/宿主凭据 |
| A12 可观察产品 | B4 UI 交互 | runtime.subscribe、UI | 任务树、工具开始/进度/结果、关联计划/截图、压缩和恢复原因可查看；停止/接管交互有效；UI 断连可恢复 |
| A13 交付 | B5 性能发行 | C01–C11 | 干净 Windows 用户无 DSH、无仓库 node_modules 的安装/启动/连接/停止/重启/升级；不手工组接代码与插件；所需游戏 mod 由产品明确管理 |
| A14 延迟 | B5 性能发行 | start/steer/stop、快循环 | 先测当前 DSH 基线，再固定硬件/模型/网络采样端到端分位数；分别计排队、模型首 token、首工具、执行确认和停止释放。目标值由主计划确定，不能把“Pi 是嵌入式”直接当实测加速 |
| A15 异步受理与唤醒 | B0 契约 / B2 游戏闭环 | T06/T09、TaskEvents、TurnService、收件箱 | 动手工具返回 <200ms 回执且不结算成功；模型调用中到达的终态不进本次输入、只在边界出现；同一 `eventId` 只消费一次；忙时拒绝式受理带任务号且不覆盖旧任务；硬杀后 `interrupted` 零重放；`dropped` 不改失败阶梯与课程难度带 |
| A16 双门与生命周期 | B2 游戏闭环 | runtime、gameControlPort、TaskSlot | 异步回合不因任务在跑而失败；工厂挂起有超时且不留 `run-active`；未确认停止不显示为已停稳且强制后可开新 generation；暂停只冻结新派发；思考 deadline 到点正常停手；任务终态只有一个来源（`onTaskEvent`） |

建议保留并分阶段运行的现有测试：p1:contract:test、p1:fault:test、p1:m3:test、p1:language:test、p1:autonomous:test、p1:proposal-autonomy:test、p1:taskgoal:test、p1:shot:test、p1:steer:test、p1:channel:test、p1:failure-escalation:test、p1:curriculum:test、tasks:test、skills:test、control:test、plan:audit、plugin:receipt:test、plugin:goal:test。与旧插件源码文本绑定的用例要重写为新契约行为测试，旧路线专属验证另行分组。

## 10. 接口迁移子步骤与总阶段对应

总计划和详细验收统一使用 B0 基线/契约、B1 模型上下文、B2 游戏控制恢复、B3 子代理插件、B4 UI、B5 性能发行。下面 I01–I09 是接口实施次序，不另立同名阶段；B4 UI 可以在稳定事件契约具备后与 B3 并行，但必须独立验收。

| 接口子步骤 | 对应总阶段 | 实施范围 | 子步骤退出门槛 |
| --- | --- | --- | --- |
| I01 冻结契约/基线 | B0 基线与契约 | 记录 b0200a6 行为、工具 schemas/receipts、测试与延迟样本；确定支持的模型/视觉/平台及锁定 Pi 版本 | 旧测试结果和当前已知问题有记录；不能用旧真机 PASS 替代新路线验证 |
| I02 运行门面/假实现 | B0 基线与契约 | 建 ActionBrainRuntime、规范化事件、ToolBroker、fake driver、运行身份/取消树；仅测试和示例使用 | A01/A04/A06/A07 的离线基础通过；未接 Pi 和未接游戏写入口的状态明确标注 |
| I03 Pi 模型与上下文接入 | B0 最小嵌入 → B1 模型上下文 | SDK adapter、模型配置、流式、settled/abort、会话/压缩、图像、ESM/Node/资源打包 | 本地样例能输出、调用无副作用工具、取消、恢复会话；已核验选定版本行为与打包方式 |
| I04 共享工具与内核直连 | B2 游戏控制恢复 | 从插件抽 T01–T15；Broker 对接 PlanService/命令/观察/记忆/语言；保留旧 HTTP adapter | 工具兼容、计划回归、stop lock 与单身体所有权通过；不启自主写入 |
| I05 单任务主链 | B2 游戏控制恢复 | M01–M07、M10–M14；玩家明确任务 → Pi → 现有执行 → 证据 → 语言报告 | @、审批、!监督、截图、待答、失败/部分结果、停止/继续端到端通过；无双执行 |
| I06 自主与恢复 | B2 游戏控制恢复 | M08/M09、运行账本、死亡/重启/断连恢复 | 提案隔离、全自主、迟到事件、重启和世界效果不确定场景通过；未完成量和停止锁保留 |
| I07 子代理/插件 | B3 子代理插件 | 调度、权限隔离、插件生命周期、生成技能接线 | A11 通过；首版子代理无身体写权限；外部插件不能获得默认宿主全权限；不满足隔离门槛则保持第三方代码关闭 |
| I08 产品事件/UI | B4 UI 交互 | runtime 事件投影、任务树、工具/计划/截图证据、权限和停止接管、重连 | A12 通过；用户能看到真实阻塞和停止确认；新 UI 不直持 Pi session/body |
| I09 交付与退役 | B5 性能发行 | 相同模型性能对照、Windows 安装包、诊断/升级、配置迁移、旧 DSH 路线退役 | A13/A14 及目标真机回归通过；无 DSH 可交付；旧 adapter/脚本/字段的删除有迁移与回滚说明 |

## 11. 开发完成前的核对表

- [ ] 对照本表关闭 M01–M15、T01–T15、C01–C11，并在 PR/验收记录中写实际实现文件与测试证据。
- [ ] 所有业务调用只依赖 ActionBrainRuntime；Pi session、SDK event、DSH agent/goal 对象不泄漏到执行内核。
- [ ] 所有身体工具、子代理和插件都经过 ToolBroker 与 TaskSlot/PlanService，未出现第二执行器或直接 body 句柄。
- [ ] 急停、断连、死亡、进程退出都调用实际输入释放；stop 结果区分已请求、已结算、已释放和未确认。
- [ ] Pi 会话历史、长期记忆、目标/计划账本、事件游标分清职责，恢复不能靠重新提交整段旧提示词。
- [ ] 产品 UI 展示可验证工作过程和真实故障；不能用模型自述的 achieved 替代世界证据。
- [ ] 配置默认值、local/profile overlay、脚本、发行物和用户文档同步；客户不需要 DSH profile 或手动绑定会话。
- [ ] 记录本轮未实现项与未真机验证项；只在相应测试完成后增加 Pi 路线 PASS 标记。

仍需主计划确定的产品决策：首批支持的 Minecraft/loader/操作系统范围、允许的插件执行隔离级别、模型与网关兼容矩阵、可恢复目标范围、存储格式/保留期、最终延迟阈值及安装包更新策略。它们不能通过选择 Pi SDK 自动获得答案。
