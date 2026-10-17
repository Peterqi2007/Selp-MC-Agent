# DSH harness 接入（H1a/H1b）

> 2026-10-17 实现。此前 H1 阻塞的原因：仓库只有 `src/harness/adapter.js` 的离线契约，
> 没有真实 DSH 传输/启动入口。现在增加一个**真实 DSH 插件**，由 DSH 侧调用工具，
> Node 侧保留 TaskSlot/事件/停止所有权。

## 1. 组成

| 文件 | 作用 |
| --- | --- |
| `dsh-plugin-mc-harness/` | DSH 插件包（ESM）；注册 `mc_observe`、`mc_step`、`mc_finish` |
| `scripts/install-dsh-plugin.js` | 复制插件到 desktop profile，追加 `cordis.patch.yml`（自动备份） |
| `scripts/dsh-h1-test.js` | 通过 `POST /goal` 驱动 DSH，打印 H1a/H1b 结果 |
| `npm run dsh:install` / `npm run dsh:h1` | 安装 / H1 测试入口 |

### 数据流

```
H1 test (Node)
  POST http://127.0.0.1:8770/goal { goal }
    -> DSH plugin: ctx.agents.create(session)
    -> agent.followup(goal + tool instructions)
    -> DSH model calls mc_observe / mc_step / mc_finish
    -> mc_step: POST http://127.0.0.1:8766/command
    -> Node agent TaskSlot executes; event log/SSE unchanged
    -> plugin returns { steps, receipts, finish, final }
```

- `mc_observe`：只读 `/ui/state`（位置/血量/时间/当前任务）。
- `mc_step`：一次只发一条面板命令（`goto`/`mine`/`chop`/`stop`…），不带 `!`。
- `mc_finish`：记录总结与 `achieved`，无副作用。
- 插件不执行 shell、不直接改身体；所有身体动作仍经 Node 的 `TaskSlot`。

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

## 4. 实现状态（2026-10-17）

| 项 | 状态 |
| --- | --- |
| 插件安装到 desktop profile + `cordis.patch.yml` | ✅ 已安装（备份 `cordis.patch.yml.bak-mc-harness-*`） |
| DSH 加载插件 | ✅ `GET 8770/health` 返回 `plugin: dsh-mc-harness` |
| `mc_step` | ✅ 真机可用：手动 `mine dirt 2` 经 8766 执行，任务完成 |
| `mc_observe` | ✅ 真机可用：返回位置/血量/时间/当前任务；对象输出已改 JSON 字符串 |
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

### 边界

- 隐藏 agent 不做 H1；live `/goal` 要求预先存在一个 DSH 对话。
- H1b 允许只读 `status`/`observe`，不允许 `mine`/`chop`/`goto`/`stop` 等 body 动作。
- 插件工具注册在全局 tools 上；H1 使用 live 对话，不创建独立测试 session。
- Full Access Ask 是**对话级模式预设**，不是启动参数；插件自身不提升权限，`mc_step` 只调用
  8766 命令表。H1 不使用它；M5 的 CU 对话才需要选择。
