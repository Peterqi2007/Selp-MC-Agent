# 自研动作脑：独立运行时骨架

这是应用拥有生命周期的动作脑框架原型，**尚未接入生产入口，也不是已可交付的动作脑产品**。现有 DSH、身体服务、状态服务与 TaskSlot/PlanService 的启动方式均未在本模块中改变。导入本目录不会启动游戏、SDK、网络或后台服务，也不需要安装 Pi。

## 离线验证

在项目根目录执行：

```powershell
npm run action-brain:contract:test
```

当前有 63 项假 session / 假 adapter 契约测试。它们验证取消边界、晚到结果、子代理容量、初始化/清理失败门禁、插件撤权与结算语义，异步受理契约骨架，**B2 生命周期门面**（回合门/任务门、工厂初始化超时、暂停/恢复、强制停止解锁、思考 deadline、边界/入站幂等、任务事件转发、ask 关闭式失败、用量计数），以及 **进程接缝与世界分区**（discover/attach/onGameLost 原子三件套、缺接缝关闭式失败、活动 run 拒绝 attach、attach 采纳世界身份、game-lost 走停止链、cross-world 双栅栏拒收、回执/终态契约冻结 worldKey）；**不证明真实 Pi SDK、真实模型、Minecraft 延迟或游戏任务完成率**。框架是 Node 18 可加载的 CommonJS；真实 Pi 路径使用延迟 ESM import，并要求 Node >= 22.19.0。

## 模块边界

| 文件 | 职责 |
| --- | --- |
| `runtime.js` | start / steer / stop / status / subscribe；回合门与任务门；暂停/强制停止；思考预算；恢复门禁 |
| `leaseGate.js` | 当前 run/epoch 的授权凭证；同步撤销旧调用，不获得身体锁 |
| `gameControlPort.js` | 仅委托给现有 TaskSlot/PlanService 的注入接口；进程接缝 discover/attach/onGameLost **原子三件套**（游戏由用户拉起，产品只发现/接入/监视丢失；部分注入即构造失败） |
| `toolBroker.js` | 能力检查、显式参数校验、合并取消信号、丢弃旧结果 |
| `subagentScheduler.js` | 有界队列、独立 worker、默认只读、取消和清理确认 |
| `pluginRegistry.js` | manifest、显式授权、同步撤权通知；不是插件安全沙箱 |
| `piDriver.js` | 可注入假 session 的 Pi adapter；真实 SDK 配置仍待接线 |
| `contracts.js` | JSON 输入校验、事件脱敏、取消等待、有界停止确认 |
| `asyncContract.js` | **契约数据**：任务状态/终态/事件族/投递时机/同步异步分类；构造与校验为占位 |
| `eventMailbox.js` | **收件箱接口占位**：三态消费、幂等入箱、边界合批；全部未实现 |
| `wakeScheduler.js` | **唤醒调度占位**：何时开轮、何处插队、principal 优先级；全部未实现 |
| `index.js` | CommonJS 导出 |

## 主接口

```js
const { ActionBrainRuntime } = require('./src/actionBrain');

// driverFactory、workerFactory、gamePort 都由宿主注入。
const runtime = new ActionBrainRuntime({
  driverFactory,
  workerFactory,
  gamePort,
  stopTimeoutMs: 1000,
  maxConcurrent: 2,
  maxQueued: 8
});
const unsubscribe = runtime.subscribe(event => render(event));
const completion = runtime.start('观察附近环境', { capabilities: ['game:observe'] });
// 运行中可以软转向：await runtime.steer('先关注附近危险');
// 急停必须调用：await runtime.stop('operator-stop');
const result = await completion;
unsubscribe();
```

示例中的宿主 adapter / render 是接口占位，不是现成生产实现。可运行的完整假实现见 `scripts/action-brain-contract-test.js`。

- `start(goal, { capabilities = [] })`：默认无工具授权；只允许一个主 run。成功必须同时满足 driver 的最终成功结算、游戏端确认 idle、子代理清理及 driver.dispose 成功。
- `steer(message)`：软转向；实际调度语义由 driver 决定。Pi 的 steer 不是立即抢占，急停走 stop。排队微任务在 dispatch 前复核 lease 和 driver 身份。
- `stop(reason)`：先同步使 epoch/lease 失效，再调用 game.cancel、releaseInputs 和子代理取消，最后发 SDK abort。同步重入共享同一个停止 promise。每项停止/清理确认有界，失败或超时返回 ok:false 并阻止新 run；成功重试才解除门禁。
- `status()` / `subscribe(listener)`：提供 JSON-safe、有限投影与基础脱敏的状态/事件。包含 seq，但目前没有持久事件账本、回放或 UI。不要向模型或插件泄露宿主配置与密钥；基础脱敏不是完整 DLP。
- `checkpoint()` / `restore(checkpoint)`：仅状态快照。restore 一律标为 interrupted，不重放旧工具、模型调用、计划或子代理，也不代表安全自动续跑。

主 driver 契约为 `{ start(goal), steer(message), abort(reason), dispose() }`。start 成功返回 `{ settled: true, outcome: 'completed' }`；失败应抛错或显式返回失败结局。abort / dispose 必须可以安全重试，且成功返回必须代表真正完成对应清理，而非仅发出请求。工厂在返回前抛错时有责任清理内部已创建资源；Pi adapter 为部分初始化失败保留了可供 runtime 重试的内部清理句柄。

## 游戏控制端口

宿主提供：

```js
{
  ownership: 'existing-task-slot-plan-service',
  observe(input, context),
  execute(input, context),
  waitForIdle({ runId, lease, signal }),
  cancel({ runId, reason }),
  releaseInputs({ runId, reason })
}
```

`ownership` 是宿主遵守现有所有权的声明，不是自动验证。宿主必须把 execute/cancel/releaseInputs 接到现有 TaskSlot/PlanService 与输入释放链，本模块不直接调用身体、不增加第二把身体锁。默认未注入时拒绝执行。

waitForIdle 只有在现有任务/计划的**终态证据**确认完成后才能返回 `{ ok: true, idle: true }`。HTTP 成功、accepted:true 或单独的模型 idle 都不是任务完成。cancel/releaseInputs 的拒绝应抛错或返回 `{ ok: false, error: { code, message } }`，不能假报成功。

**进程接缝（2026-11-06）**：游戏进程由**用户**拉起，产品不启动也不监管它。可选的进程三件套 `discover(input)` / `attach(candidate)` / `onGameLost(cb)` **要么全有、要么全无**——只注入 discover（或漏掉 onGameLost）在构造期就抛 `invalid-game-port`，不假装"能发现但丢了不知道"。`attach` 返回 `{ ok, worldKey, worldSessionId }`：世界身份从游戏侧读取，runtime **采纳而不自造**；活动 run 期间 attach 被拒（换世界先 `stop`）。`onGameLost` 触发 `game:lost` 事件并走**与人工急停相同的停止链**（先失效资格，再停身体与模型）。

**世界分区（worldKey）**：`worldSessionId` 是运行时栅栏（每次连接变化），`worldKey` 是持久分区键（同一存档/服务器跨会话稳定），后者决定课程账本/记忆/方法库/聊天记忆/会话目录落在哪个分区（主计划 §6.3）。回执与终态事件必备 `worldKey`（SCHEMA_VERSION 2）；缺失落 `DEFAULT_WORLD_KEY='default'` 并显式告警，绝不静默并入其它分区；跨世界事件在 `ingest` 与任务事件转发处被 `cross-world` 拒收（区别于会话栅栏 `stale-world`）。

当前只注册 `mc_observe` 与 `mc_step` 两个通用桥接工具，参数仅要求 JSON 对象。**完整 15 工具 adapter、每项生产 schema、plan/task 结果与取消细节尚未接入**。

## 工具、插件与子代理

ToolBroker 的宿主注册方式：

```js
runtime.broker.register({
  name: 'project.read', capability: 'files:read',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  validate: input => typeof input.path === 'string',
  execute: (input, { signal, lease, actor }) => hostReadWithinWorkspace(input.path, signal)
});
```

validate 是必填的执行时校验，不能只依赖展示给模型的 schema。输入限制为有界 JSON 值；结果和事件只做有界 JSON 投影。工具实现必须遵守 signal，并自行落实文件路径、网络域名等资源权限。取消等待、epoch 丢弃结果并不能撤销忽略 signal 的外部写入。

插件 manifest 为 `{ id, version: '1.0.0', apiVersion: 1, capabilities, tools: [{ name, capability }] }`。先 `runtime.plugins.register(manifest)`，再由宿主显式 `authorize(id, grants)`；模型没有授权工具。默认无授权，grants 必须是 manifest 能力子集。任何授权修订都会同步 abort 已在执行的该插件工具；dispatch 与结果回收也会复核 revision，撤权后重新授权不会复活旧结果。**这只是受信代码的能力协议，不是模块加载、签名验证、进程或 OS 隔离**。

有限能力集合：game:observe、game:control、files:read、files:write、network:read、compute、subagent:spawn。声明能力不等于工具已经实现。

宿主可调用 `runtime.children.spawn({ parentLease, task, capabilities })`，返回 `{ id, done, cancel }`。workerFactory 接收 `{ id, signal, tools }`，每次必须创建独立 worker `{ run(task, { signal, tools }), abort(reason), dispose?() }`。默认并发 2、排队 8、授权 files:read / game:observe；任何子代理都禁止 game:control。子代理不是共享主会话，也未接入 Pi 内建功能或模型可调用的 spawn 工具。

子任务 done 结果与实际清理确认是不同的：取消可立即向调用者返回 cancelled，但忽略取消的 factory / run 仍占容量并使 stop 失败。dispose 失败也保留槽位和重试门禁。abort 必须让实际 run 结束；dispose 若存在必须确认资源释放。新返回但接口不完整的 worker 也需要清理；已被其他任务使用的 worker 被拒绝时不会被误杀。这里尚无进程隔离、deadline 或预算管理。

## Pi 接入范围

`createPiDriverFactory({ sessionFactory })` 支持测试注入。真实路径要求显式 `sdkOptionsFactory({ customTools })`，并至少验证 tools:[]、同一 customTools 数组、resourceLoader / sessionManager / settingsManager，避免隐式继承用户目录工具和资源。SDK 包与模型配置**未在本次框架中安装或锁定**，也没有可直接使用的认证配置。

adapter 投影文本 delta、工具生命周期及压缩/重试阶段；agent_end 不视为最终 idle，只等待 agent_settled。settled 时取消标记与最后一条 assistant 的 error / aborted 结局会失败，后续成功重试可覆盖中间错误；游戏完成仍需 waitForIdle。该行为目前只用假 session 验证，真实 SDK 版本/API/错误事件顺序需后续验证。

默认不启用 Pi 内建 coding tools；文件阅读/编辑/执行工具、coding role、上下文压缩策略及持久会话配置尚未接入。Pi steer 的软调度不能替代宿主急停与 epoch fence。

## 异步受理与事件唤醒（骨架，未实现）

动手工具不再等待完成：受理即回执（`accepted` + `taskId`），完成走事件；收件箱按三态路由把事件交给回合。完整语义见 [docs/ACTION-BRAIN-ASYNC-CONTRACT.md](../../docs/ACTION-BRAIN-ASYNC-CONTRACT.md)，验收项见 `docs/ACTION-BRAIN-ACCEPTANCE.md` §4.2（B2-15…B2-20）。

```js
const {
  TASK_STATES, TERMINAL_STATES, EVENT_TYPES, DELIVERY_TIMING,
  classifyCommand, isTerminalState,
  buildAcceptedReceipt, buildTerminalEvent, validateReceipt,
  createEventMailbox, CONSUME_MODES,
  createWakeScheduler, WAKE_REASONS, NON_WAKE_REASONS
} = require('./src/actionBrain');

classifyCommand('mine iron_ore 20');  // 'async'  —— 契约数据，已冻结
isTerminalState('dropped');           // true     —— dropped 不计失败
buildAcceptedReceipt({ taskId: 't-1', verb: 'mine' });
// -> 抛 ContractError('not-implemented')：本文件不派发、不抢租约、不落盘
createEventMailbox().offer({ eventId: 'e-1' });
// -> 抛 ContractError('not-implemented')：里程碑实现前不会有"看似能跑"的收件箱
```

约束（实现者必须遵守，测试已断言其中可断言的部分）：

- `accepted` 永不结算成功；同一 `taskId` 只接受第一个终态，重复/迟到按 `eventId` 丢弃。
- 只读同步、动手异步、`stop` 同步；`stop` 永不排在任务后面。
- 空闲时只有活人说话与显式 steer 能开轮；世界/身体事件只搭车。
- 派发即抢 `TaskSlot`，抢不到是拒绝式受理（带 `currentTask.taskId`），不排队、不替换。
- 事件至少一次 + `eventId` 幂等；内存 ring 不是永久账本。

这三个文件只是**类型与接口的落点**：没有派发、租约、合批、优先级、持久化或唤醒逻辑，`src/index.js` 也没有引用它们。

## B2 生命周期门面（审计修订：接口可用，行为待真机）

```js
start(goal, { capabilities, taskMode, deadlineMs, budget, worldSessionId })

// 任务在跑不是回合失败：
start('mine iron', { taskMode: 'async' });   // 需要 gamePort.tasks + gamePort.onTaskEvent
                                              // -> { ok, settledScope:'turn', tasksOpen:n }
start('think',   { deadlineMs: 120000 });    // 到点 run:deadline -> 正常 stop('think-timeout')

pause('operator typing');  // 冻结新派发，不销毁会话 / 不打断在跑回合
resume();                  // 解除；恢复必须重新感知
stop('operator-stop', { force: true });      // 确认失败时记 force-stopped（不显示为已停稳）
boundary({ batch: 1 });                      // 工具批返回 -> turn:boundary（收件箱唯一合法时机）
ingest({ type: 'task.finished', eventId });  // 幂等 + worldSessionId/worldKey 双栅栏，不路由
ask('挖这里吗？');                            // 无 gamePort.ask 抛 ask-unavailable
usageReport();                               // { turns, toolCalls, wallMs }

// 进程接缝（游戏由用户拉起；缺接缝关闭式失败 process-port-required）：
discoverGames();                 // 探测候选控制端点，不启动进程
attachGame({ endpoint });        // 仅空闲时可用；采纳 {worldKey, worldSessionId}，发 game:attached
// onGameLost（宿主注入） -> game:lost + 正常停止链（game-lost）
```

约束：`start({taskMode:'async'})` 缺 `tasks`/`onTaskEvent` 时**关闭式失败**；driver 工厂受 `initTimeoutMs` 约束；`force` 只放开"能否开新一轮"，主 driver 清理未确认（`unsafeDrivers`）仍是硬阻。这些是门面与状态机，**生产入口未引用本目录**。

## 后续接线 TODO

1. 固定真实 SDK 版本，验证 Node/runtime、模型认证与 provider；实现隔离的资源、settings、会话存储及最终结局映射。
2. 对接现有完整 15 工具、TaskSlot/PlanService 的终态等待、取消/抢占、InputLedger 释放及严格生产 schema。
3. 接入受限文件 read/edit/patch/执行工具、coding role 和独立快速子代理工厂；配置并验证压缩/记忆与 token 计量。
4. 加入持久事件/执行账本、worldSessionId 与 `worldKey` 分区目录（主计划 §6.3：课程账本/记忆/方法库/聊天/会话目录按世界分区，default 兜底显式）、预算/timeout/deadline、幂等键，以及跨进程故障恢复；恢复前重新观察世界。**其中异步受理部分按 `asyncContract`/`eventMailbox`/`wakeScheduler` 落：回执构造与校验、收件箱入箱/去重/合批/快照恢复、边界排空与开轮判定、in-flight 签名查重。**
5. 实现可交互 UI、工具/任务/计划证据可视化、用户打断与调试；定义脱敏和客户日志策略。
6. 实现外部插件的受控加载、进程/OS 权限隔离与分发/更新；定义单一交付包和模型配置体验。
7. 测量真实首工具延迟、急停确认、快慢循环行为和游戏完成率，再决定生产后端切换。

这些 TODO 是产品化边界，不属于本次离线框架已完成能力。
