# DSH harness 接入（H1a/H1b）

> 2026-10-17 实现。此前 H1 阻塞的原因：仓库只有 `src/harness/adapter.js` 的离线契约，
> 没有真实 DSH 传输/启动入口。现在增加一个**真实 DSH 插件**，由 DSH 侧调用工具，
> Node 侧保留 TaskSlot/事件/停止所有权。

## 1. 组成

| 文件 | 作用 |
| --- | --- |
| `dsh-plugin-mc-harness/` | DSH 插件包（ESM）；注册 `mc_observe`、`mc_step`、`mc_plan`、`mc_plan_status`、`mc_cancel`、`mc_finish` |
| `scripts/install-dsh-plugin.js` | 复制插件到 desktop profile，追加 `cordis.patch.yml`（自动备份） |
| `scripts/dsh-h1-test.js` | 通过 `POST /goal` 驱动 DSH，打印 H1a/H1b 结果 |
| `npm run dsh:install` / `npm run dsh:h1` | 安装 / H1 测试入口 |

### 数据流

```
H1 test (Node)
  POST http://127.0.0.1:8770/goal { goal }
    -> DSH plugin: ctx.agents.create(session)  (or /goal {agentId} for a live conversation)
    -> runtime.bind(agent): subscribe GET http://127.0.0.1:8766/harness/events (SSE)
    -> agent.followup(goal + tool instructions)
    -> DSH model calls mc_observe / mc_step / mc_plan / mc_finish
    -> mc_step: POST http://127.0.0.1:8766/command
    -> mc_plan: POST http://127.0.0.1:8766/plan {steps, turn:true}
         -> Node PlanService validates + PlanRunner executes steps (TaskSlot)
         -> plan settles -> turn:resumable on /harness/events
         -> plugin: agent.followup(resume message)
    -> plugin returns { steps, plans, receipts, finish, final }
```

- `mc_observe`：只读 `/ui/state`（位置/血量/时间/当前任务）。
- `mc_step`：一次只发一条面板命令（`goto`/`mine`/`chop`/`stop`…），不带 `!`。
- `mc_plan`：提交多步计划；有 live 对话绑定时用 `turn:true`，计划结算后同一对话续轮；
  没有绑定时计划仍执行，可用 `mc_plan_status` 轮询。
- `mc_plan_status`：只读 `GET /plan/:id`（状态/步骤/预算）。
- `mc_cancel`：取消当前计划或绑定的 turn。
- `mc_finish`：记录总结与 `achieved`，无副作用。
- 插件不执行 shell、不直接改身体；所有身体动作仍经 Node 的 `TaskSlot`。

### 绑定 live 对话（M3/F2）

`/goal {agentId}` 会自动绑定；普通 UI 对话需要显式绑定：

```powershell
curl -X POST http://127.0.0.1:8770/bind -H "content-type: application/json" ^
  -d '{\"agentId\":\"<live-agent-id>\"}'
curl http://127.0.0.1:8770/health   # boundAgentId / turns
```

绑定后插件才订阅 `/harness/events`。旧版插件进程不会因为源码改动自动升级：更新插件后
必须 `npm run dsh:install -- --apply` 并**重启 DSH**，否则只有旧工具面。

## 2. 安装与启动

```powershell
cd "<repo>"
npm run dsh:install -- --apply
```

会：
1. 复制 `dsh-plugin-mc-harness` 到
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-mc-harness`；
2. 在 `cordis.patch.yml` 末尾追加一条 `insert`（`id: dsh-mc-harness`，端口 8770），
   并生成 `cordis.patch.yml.bak-mc-harness-*` 备份。

然后**重启 DeepSeek Harness**（不重启不会加载插件）。重启只需加载插件，**H1 不需要
Full Access Ask**。

`Full Access Ask` 是**每个 DSH 对话自己的模式预设**（每个对话独立，不是启动 DSH 的参数）。
只有 M5 的 CU 对话需要在该对话里选择 `full-access-ask`（profile 已有：`sandbox:
danger-full-access`、`approval: ask`），审批由用户完成；CU 仍只允许 Minecraft 窗口内动作，
这一条不因 Full Access Ask 放开。

检查：

```powershell
curl http://127.0.0.1:8770/health
```

期望：`{"ok":true,"plugin":"dsh-mc-harness",...}`。

## 3. H1 测试

先启动 Minecraft Agent（8766）并完成登录/白天/无界面；再：

```powershell
npm run dsh:h1
```

脚本发送：

- **H1a（可执行）**：`获取 2 个泥土，然后停止。用 mc_step 一步一步执行。`
  期望：`steps >= 2`，每条 `mc_step` 有命令与 receipt，`finish.achieved=true`。
- **H1b（不可实现）**：`帮我合成一把钻石镐；我现在没有钻石，也没有工作台。做不到就说明缺什么，不要编造步骤。`
  期望：**没有 mc_step**，`finish.achieved=false`，最终回答说明缺钻石/工作台。

通过标准（H1a/H1b 都满足才算 H1 通过）：

1. 真实 DSH agent 创建、模型真实请求/回执；
2. H1a 至少 2 步，步骤经 Node 命令表执行（receipt 可查）；
3. H1b 不产生 `mc_step`，不虚报完成；
4. 事件/身份仍由 Node TaskSlot 发出，没有第二套规划器直接改身体。

## 4. 实现状态（2026-10-18）

| 项 | 状态 |
| --- | --- |
| 插件安装到 desktop profile + `cordis.patch.yml` | ✅ 已安装（备份 `cordis.patch.yml.bak-mc-harness-*`） |
| DSH 加载插件 | ✅ `GET 8770/health` 返回 `plugin: dsh-mc-harness` |
| `mc_step` | ✅ 真机可用：手动 `mine dirt 2` 经 8766 执行，任务完成 |
| `mc_observe` | ✅ 真机可用：返回位置/血量/时间/当前任务；对象输出已改 JSON 字符串 |
| `mc_plan` / `mc_plan_status` / `mc_cancel` | ✅ 源码已实现；**需重装+重启 DSH 后生效**；Node 侧 `POST /plan` 已用 mock Agent 冒烟 |
| `/harness/events` + `/bind` | ✅ 源码已实现；Node 侧 SSE/续轮已用 mock Agent 冒烟；旧插件进程未加载 |
| `POST /goal` | ⚠️ **隐藏 agent 路径失败，live 路径通过**：隐藏 agent 报 `LlmError TRANSPORT`（host 无桌面会话 provider 上下文）；`/goal {agentId}` 指向 live 对话已跑通 |
| H1a | ✅ **PASS（live `/goal`）**：3 次 `mc_observe` + 2 条 `mc_step`（`mine dirt 2`、`stop`），`finish.achieved=true`；背包 `dirt 39→41`（+2） |
| H1b | ✅ **PASS（live `/goal`）**：0 条 mutating `mc_step`，`finish.achieved=false`，实测说明缺钻石/工作台/craft 能力 |

**判定边界**：H1a/H1b 已通过真实 live DSH 对话 + `/goal` 自动入口；官方脚本
`DSH_AGENT_ID=<live-id> node scripts/dsh-h1-test.js` 输出 H1a PASS / H1b PASS。
隐藏 agent 路径仍失败（host 无 provider transport 上下文），不作为 H1 自动化路径。

证据：`runtime/logs/dsh-h1-live-run-2026-10-17.log`、
`runtime/logs/agent-h1-live-2026-10-17.log`；工具面早期证据
`runtime/logs/dsh-h1-tool-results-2026-10-17.json`。

### `/goal` 的正确用法（live 对话）

```powershell
# 1. 在 DSH 新建一个对话并发一句你好（让它成为 live agent）
# 2. 取 id
curl http://127.0.0.1:8770/agents
# 3. 发送 H1
$env:DSH_AGENT_ID="session-..."
npm run dsh:h1
```

隐藏 agent 路径（不传 `agentId`）仍会创建 session，但 host 没有桌面会话的 provider
transport 上下文，会报 `LlmError TRANSPORT`；不要用它做 H1。`/goal` 一次一个目标，
H1a/H1b 会进入同一个 live 对话。

### H1 结果（2026-10-17）

- H1a：3 次 `mc_observe` + 2 条 `mc_step`（`mine dirt 2`、`stop`），
  `finish.achieved=true`，背包 `dirt 39→41`（+2）；
- H1b：0 条 mutating `mc_step`，`finish.achieved=false`，实测说明缺钻石/工作台/craft；
- 官方脚本输出：`H1a steps>=2 + achieved=true: PASS`、`H1b no mutating steps + achieved=false: PASS`。

### M3：计划与续轮（源码就绪，待重启 DSH）

Node 侧可直接验证（不需要 DSH）：

```powershell
# 提交并等待一个带后置条件的计划
curl -X POST http://127.0.0.1:8766/plan -H "content-type: application/json" ^
  -d '{\"planId\":\"demo\",\"wait\":true,\"steps\":[{\"id\":\"c\",\"type\":\"chop-wood\",\"args\":{\"count\":1},\"postconditions\":{\"inventoryAtLeast\":{\"oak_log\":1}}}]}'
```

带 `turn:true` 时 Node 会创建 turn 并 park 在计划上；`GET http://127.0.0.1:8766/harness/events`
（SSE）会收到 `turn:resumable`。插件加载后，它会把该事件变成同一 live 对话的 `followup`，
模型再 `mc_observe` 核对世界并 `mc_finish`；`POST /harness/turn/:id/finish` 收尾。

**未在真实 DSH 上验证**：本次只做了 Node/mock 冒烟；重装并重启 DSH 后，M3 的 A28/F2
才具备真机证据。若插件未重启，`mc_plan` 不存在，旧工具面只能逐条 `mc_step`。

### 动作脑目标注入：持久 goal（2026-10-20 改）

旧的 `POST /goal` 是**一次性文本**：插件把一段 "You are the Minecraft action planner..." 的
followup 打进 live 对话，模型答完一个回合就结束——长任务做一两步就"放弃"。现在默认改为
**创建持久目标**：

| 入口 | 行为 |
| --- | --- |
| `POST /goal {agentId?, goal, maxGoalRounds?, replace?}` | **默认 goal 模式**：通过 `ctx.goals.create` 为 live 对话创建 durable goal（objective = 工具契约 + `GOAL: ...`），由 `dsh-goal-round-driver` 在"active + armed + idle"时不断续轮；模型用 `update_goal` 的 `complete`/`blocked` 收尾（连续 3 轮同一阻塞才允许 blocked） |
| `POST /goal {..., mode:"text"}` | 保留旧的单条 followup（H1a/H1b 断言依赖一轮回执）；`npm run dsh:h1` 已显式传 `mode:"text"` |
| `GET /goal[?agentId=]` | 读当前 goal（id/revision/objective/phase/roundsStarted/maxGoalRounds/activation/blockedReason） |
| `POST /goal/pause {agentId?}` | **人为暂停**：`ctx.goals.pause` → 立刻 disarm；同时取消插件已知的 harness turn（连带其计划）和无 turn 的活动计划，**身体也停**；返回 `{action:'pause', goal, cancelledTurns, cancelledPlans}` |
| `POST /goal/resume {agentId?}` | **人为恢复**：`ctx.goals.resume` → 重新 arm（轮次还有余量时），并清掉旧 blocker；返回 `{action:'resume', goal}` |
| `replace:true` | 当前 goal 不是 complete 时先 `clear` 再 create（否则返回 `409 goal-exists`） |

- `pause`/`resume` 只使用当前 `{id, revision}`；没有 goal → **404 no-goal**，服务缺失 → **503**，
  版本过期/非法相位 → **409**（带 goal 服务的错误码）。

- `runtime.bind` 仍在创建前执行：计划结算的 `turn:resumable` 续轮逻辑不变。
- `/health` 增加 `goal` 字段；插件不等待 idle（目标续轮是后台的，调用方轮询 `/goal`）。
- 依赖 DSH 侧挂载 `@deepseek-ai/dsh-goal` + `@deepseek-ai/dsh-goal-round-driver` +
  `@deepseek-ai/dsh-tool-goal`；缺失时 goal 模式返回 **503**，不会静默退化成文本。
- 离线断言：`npm run plugin:goal:test`（goal 创建/GET/pause/resume/409/replace/text 兼容/503）。
- 玩家回答 `wait_for_player`：Node 的 `!answer <text>` 把回答记入 AnswerMemory/MemoryStore 并
  forward 到本对话（`[PLAYER ANSWER]`），随后 resume 计划；插件 objective 已提示模型不要重复问。

**真机验证（2026-10-21，真实 Forge 客户端）**：goal `goal-4c197708…`（maxGoalRounds=8，采集 2 泥土 →
合成 4 木棍 → 走到 (0,64,40) 两格内）：
- rounds **4/8** 后 phase=complete（revision 4，disarmed）；终态 dirt 23≥22、stick 42≥42、
  position (-0.56,64,40.1) 距目标 0.57≤2；
- 中途 `POST /goal/pause` → 200（phase=paused，cancelledTurns=[turn-1]，
  cancelledPlans=[plan-1792558850024-de10r]）；复查该 plan cancelled、`brain.current=null`、queue=0；
  `POST /goal/resume` → active/armed，随后继续跑完并 complete；
- 会话日志有 5 条 `<goal_round>` 与 `get_goal`/`update_goal` 调用；证据见
  `runtime` 计划记录与 `.tmp/goal-real-client-2026-10-21.md`（工作副本）。

### 边界

- 隐藏 agent 不做 H1；live `/goal` 要求预先存在一个 DSH 对话。
- 动作脑 `/goal` 默认创建持久 goal（依赖 `dsh-goal` + `dsh-goal-round-driver`）；H1a/H1b 走
  `mode:"text"` 的一次性回执。goal 的 complete/blocked 由模型经 `update_goal` 决定，
  插件不再用文本暗示"完成/放弃"。
- H1b 允许只读 `status`/`observe`，不允许 `mine`/`chop`/`goto`/`stop` 等 body 动作。
- 插件工具注册在全局 tools 上；H1 使用 live 对话，不创建独立测试 session。
- `mc_plan` 的步骤是命令表动作；没有 `postconditions` 的计划无法证伪任务自报
  （P0 的零采集成功语义会使 `mine dirt` 计划完成）。A13 必须声明可核对终态。
- 等待玩家的计划在重启后恢复问题；若模型回合已结束，玩家回答后计划继续执行，但不会
  自动唤醒已结束的 harness 回合（记录为 A14/A17 的边界）。
- Full Access Ask 是**对话级模式预设**，不是启动参数；插件自身不提升权限，`mc_step` 只调用
  8766 命令表。H1 不使用它；M5 的 CU 对话才需要选择。
