# 异步受理与事件唤醒契约（动作脑）

> **状态：契约草案 + 代码骨架占位（2026-11-01）。** 本文定义"工具受理即回执、完成走事件"的
> 目标语义；`src/actionBrain` 新增 `asyncContract.js` / `eventMailbox.js` / `wakeScheduler.js`
> 三个骨架文件，**只有常量与占位方法**（全部抛 `not-implemented`），生产路径不引用它们。
> 本文与骨架都不声称能力已可用；验收项见 [ACTION-BRAIN-ACCEPTANCE.md](ACTION-BRAIN-ACCEPTANCE.md) §4.2。
>
> 关联文档：[实施计划](SELF-HOSTED-ACTION-BRAIN-PLAN.md) §6.1/§14、
> [接口迁移清单](ACTION-BRAIN-MIGRATION-INTERFACES.md) §4.2/§6.5、
> [骨架说明](../src/actionBrain/README.md)。

## 1. 要解决的问题（只列有证据的）

| 现象 | 证据 | 代价 |
| --- | --- | --- |
| 长任务把整轮模型调用占住 | A28 实测单步结算 **15.57s** | 期间不能说话、不能观察、不能改链 |
| 同一条技能两个入口两种时序 | `!mine` 走 TaskHub 异步；`mc_step mine` 同步 | 大脑侧拿不到已有的异步能力 |
| 长跑任务可能极长 | `!fish` 设计上最长 **15 分钟** | 若走工具通道，一轮模型调用会卡 15 分钟 |
| 失败语义混在一起 | 文档已记：`blockedReason` 无法区分"太难"与"抖动"，一律计入难度带 | 难度带被抖动带偏 |
| 重复派发 | 真机日志：`deposit` 反复派发；`no progress (1) for 2 runs` | 浪费轮次，可能误杀在跑的活 |
| 事件各自开轮 | 感知边沿 / 聊天 / 截图 steer 各自触发 | 事件风暴烧 token |
| 崩溃丢任务 | A29 只保证计划不重放 | 重启后不知道"在跑什么" |

## 2. 五条不变量（本契约的全部承诺）

1. **受理即回执，回执不等于成功。** `accepted` 永远不能结算成 succeeded；只有终结事件能写账本。
2. **终结只认一次。** 同一 `taskId` 只接受第一个终态；重复/迟到按 `eventId` 幂等丢弃。
3. **只读同步、动手异步、停止同步。** `stop` 永不排在任务后面。
4. **事件驱动，禁止模型轮询。** 完成必须推送；`task_status` 只用于现场核对，不作唤醒源。
5. **身体唯一。** 派发即抢 `TaskSlot` 租约；抢不到是**拒绝式受理**（带任务号），不排队、不替换。

## 3. 状态机

```text
accepted ──► running ──┬──► succeeded        （后置证据成立）
                       ├──► failed           （class/requires 进失败阶梯）
                       ├──► dropped          （无活可干：不计失败、不动难度带）
                       ├──► timeout          （带 progress，允许续做一次）
                       ├──► cancelled        （人/权限/owner-stop）
                       └──► interrupted      （进程重启/断连，恢复前先核对现场）
running ⇄ waiting_player   （mc_ask_player 停车；回答后允许一次 informed 重试）
```

规则：

- **一次尝试一个 `attemptId`**，`taskId` 不变；重派不新建任务、不重复计失败。
- **`dropped` 与 `cancelled` 不进失败阶梯、不进课程难度带**——这是本契约对既有已知局限的正面回答。
- **`interrupted` 不是失败**，也不代表可以自动续跑；恢复前必须重新观察。
- 同一 `taskId` 的 `accepted/progress` 可以多次，终态只能一次。

## 4. 工具回执契约

### 4.1 同步 / 异步划分

| 类别 | 命令 | 返回 |
| --- | --- | --- |
| 只读同步 | `observe` `perception` `state` `plan_status` `capabilities` `keybinds` | 立即结果，不占任务号 |
| 动手异步 | `step` `plan` 及其命令动词（mine/chop/craft/smelt/farm/fish/deposit/withdraw/collect/attack/equip/eat/place/use_on/follow/…）、`code_skill` | **受理回执**，完成走事件 |
| 停止同步 | `stop` `cancel` | 幂等，立即返回；**永不排队** |

动词表的唯一事实源是 `src/core/keyActions.js`；`asyncContract.js` 里的分类表只是契约骨架，
实现时必须从动词表派生，不得维护第三份名单。

### 4.2 受理回执（立即返回）

```jsonc
{
  "schemaVersion": 1, "ok": true, "async": true,
  "taskId": "t-9f3a", "verb": "mine", "state": "accepted",
  "acceptedAt": 1730570000123, "attempt": 1,
  "runId": "run-17", "epoch": 42, "worldSessionId": "w-3",
  "deadlineMs": 480000, "estimateMs": 300000,
  "body": { "slot": "leased", "preempted": null },
  "hint": "work is running; completion arrives as an event - do NOT re-issue this call"
}
```

必备字段见 `RECEIPT_FIELDS`。`taskId` 是后续取消、查询、事件关联的唯一身份。

### 4.3 拒绝式受理（忙）

```jsonc
{
  "schemaVersion": 1, "ok": false, "async": true,
  "reason": "body-busy", "class": "precondition",
  "currentTask": { "taskId": "t-8a11", "verb": "chop", "state": "running", "progress": "3/10" },
  "requires": ["task_stop", "wait-for-task.finished"]
}
```

拒绝必须**报任务号**，让模型能选择"等"或"停"；不得静默替换、不得排队到不可预期的时间点。

### 4.4 版本化

字符串→对象的结果格式切换必须带 `schemaVersion` 并单独测试：副作用已执行但模型因格式不符重试，
是历史上真实发生过的一类缺陷（`mc_say` 已有该修复注释）。

## 5. 事件族

| 事件 | 产生方 | 何时 | 投递时机 | 能否开轮 |
| --- | --- | --- | --- | --- |
| `task.accepted` | 派发层 | 受理成功 | ride | 否（回执已在工具结果里） |
| `task.progress` | 执行层 | ≥5s 心跳或阶段变化 | boundary | 否 |
| `task.waiting_player` | 执行层 | 进入停车 | round | 是（需要人/需要决策） |
| `task.finished` | 执行层 | 终态（五选一） | round | **是** |
| `task.interrupted` | 启动层 | 重启/断连 | round | 是（带恢复注记） |
| `plan.updated` | PlanService | 计划版本/状态变化 | boundary | 否 |
| `chat.incoming` | 聊天层 | 玩家说话（principal） | round | **是（空闲也开）** |
| `perception.edge` | 感知层 | 威胁/昼夜/聊天边沿 | ride | 否（搭车） |
| `steer.requested` | 外部 | 截图/显式 steer | round | 是 |
| `policy.denied` | 权限层 | 拒绝执行 | boundary | 否 |

公共字段：`schemaVersion, eventId, seq, type, at, runId, requestId, taskId, attemptId, epoch,
worldSessionId, status, reason, evidenceRefs, payload`。

投递语义：**至少一次 + `eventId` 幂等**。宁可重复投递也不能丢终态；订阅者按 `eventId` 去重。
内存 ring 是有限重放缓存，不是永久事件账本（沿用 [接口清单 §6.4](ACTION-BRAIN-MIGRATION-INTERFACES.md) 的结论）。

## 6. 收件箱与唤醒路由

### 6.1 三态消费

| 事件到达时 loop 状态 | 处理 |
| --- | --- |
| 回合进行中（模型调用/工具批未结束） | 只入箱，**绝不打断**；在工具批结算的边界一次倒空 |
| 回合结束、后台有任务在跑 | 允许开新轮（任务期的消息是军情） |
| 完全空闲 | 入箱；只有 principal 与显式 steer 能开轮，其余搭车 |

### 6.2 边界定义

一次"步" = 一次模型调用 + 它发出的工具批返回。

- 模型调用**进行中**到达的事件不进本次调用；
- 工具批返回后、下一次模型调用前，把 `delivery: boundary` 的事件压成**一条结构化 `<events>` 输入**；
- `delivery: round` 的事件若无在跑回合则直接开轮，否则在最近边界插队（principal 最高）。

### 6.3 合批与串行

同一 `taskId` / `planId` / thread 的事件按 `seq` 排序后合并为一批；不同线可合并。
禁止把同一任务的 progress 逐条注入上下文。

### 6.4 反轮询

`task_status` 是拉取语义，只用于现场核对；完成与失败**必须**由事件送达。
`whyNotWake()` 必须能回答"刚才那条事件为什么没开轮"（面板与调试使用）。

## 7. 租约、心跳、超时与预算

| 项 | 规则 |
| --- | --- |
| 租约 | **派发时**获取 `TaskSlot`，不是运行时才抢；抢不到即拒绝式受理 |
| 只读与停止 | 永不排队（`PARKED_WHITELIST` 思路），保证操作员始终能停 |
| 心跳 | `task.progress` ≥5s 或阶段变化；不逐 tick 上报 |
| deadline | 按动词给出（挖矿可到 8 分钟）；超时发 `timeout` 且 `resumable: true` |
| 续做 | `timeout` 后允许同一调用续做**一次**，避免无限重试 |
| 后台总预算 | 每个终态前有墙钟上限（如 30 分钟），到点发 `timeout` 并释放槽——漏槽的唯一兜底 |
| 非身体活 | 检索/记忆/代码技能生成不占身体槽，但同样发事件 |

## 8. 持久化与恢复

- **先落盘再执行**：`accepted` 记录（`taskId/verb/args/signature/runId/epoch/slot`）先写账本，再派发。
- **重启**：`accepted/running` 一律转 `task.interrupted`，**不重放副作用**。
- **恢复注记**：给模型一条结构化笔记（"t-9f3a mine iron_ore 20 在 03:21 拿到 12 个后中断；先读 /state 对账，再决定续做还是重派"）。
- 与 B2-10/B2-11 的"未知结果先对账"一致；不声称 exactly-once。

## 9. 与既有机制的咬合

| 机制 | 规则 |
| --- | --- |
| 失败阶梯 | 只消费 `failed` / `timeout`，一任务一次；`dropped` / `cancelled` 不计；签名账本增加 **in-flight 查重** 防重复派发 |
| 权限闸门 | 在**受理时**判（副作用前），拒绝回 `permission` 且不占槽 |
| `mc_ask_player` | 停车不清空在跑任务；回答后只允许一次 informed 重试；停车期间仍拒新身体写 |
| 完全自主模式 | `noteExecution` 改用结构化终态；`dropped` 不触发"受阻即暂停" |
| 聊天 | 任务在跑时聊天照常；`@` 请求在忙时给忙句 + 任务号 |
| 截图 steer | `delivery: round` 但**不授予任务**（关联只加上下文，不路由） |
| owner-stop | 先取消在跑任务（发 `cancelled`）再上锁，保证模型历史里有终结态 |
| TaskEvents / 面板 | 事件族与投影单一来源；面板不再轮询任务状态 |

## 10. 非目标

- 不做多具身体的并行；并发只允许出现在**非身体**工作（检索、记忆、代码技能生成）。
- 不做多租户策略、Mandate、Admission 表等授权机器（那是多身份多渠道场景）。
- 不做云端 Router/Worker 拓扑；本项目的计算与状态都在本地。
- 不新增第二套执行器：真正的执行仍是 `ActionBrainRuntime` + 现有 PlanService/TaskHub/TaskSlot。
- 不做 token 硬上限；预算以墙钟与轮次计。

## 11. 验收映射

| 验收项 | 内容 |
| --- | --- |
| B2-15 | 受理回执 < 200ms；`accepted` 不得结算成功 |
| B2-16 | 边界投递：模型调用中到达的终态不进本次调用 |
| B2-17 | 幂等：同一 `eventId` 投两次只消费一次 |
| B2-18 | 拒绝式受理：忙时第二派发被拒并带任务号，不覆盖旧任务 |
| B2-19 | 崩溃恢复：accept 后硬杀 → `interrupted` + 注记，副作用零重放 |
| B2-20 | `dropped` 不污染失败阶梯与难度带 |

离线骨架断言（`npm run action-brain:contract:test`）只证明"契约数据与占位方法存在且拒绝假装成功"，
**不证明上述任何一项行为已实现**。

## 12. 骨架文件与未实现清单

| 文件 | 已提供 | 未实现 |
| --- | --- | --- |
| `src/actionBrain/asyncContract.js` | 状态/事件/投递/命令分类常量；`isTerminalState`；`classifyCommand` | 回执与事件构造器、校验器（抛 `not-implemented`） |
| `src/actionBrain/eventMailbox.js` | `CONSUME_MODES` / `OFFER_RESULTS`；接口形状 | 入箱、去重、合批、优先级、快照恢复（全部抛） |
| `src/actionBrain/wakeScheduler.js` | `WAKE_REASONS` / `NON_WAKE_REASONS`；接口形状 | 开轮判定、边界排空、预算、状态（全部抛） |

本轮审计追加（同日）：`src/actionBrain/runtime.js` 已提供 `taskMode:'async'|'sync'`（回合门/任务门拆分）、`deadlineMs`/`initTimeoutMs`、`pause`/`resume`、`stop({force:true})`、`boundary()`、`ingest()`、`ask()`、`resumeRequest()`、`usageReport()` 与 `gamePort.onTaskEvent` 转发。它们仍是**门面与状态机**：不派发任务、不写任务账本、不实现收件箱；行为验收见 [ACCEPTANCE §4.3](ACTION-BRAIN-ACCEPTANCE.md)（B2-21…B2-27）。
