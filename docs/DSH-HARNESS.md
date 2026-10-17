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
| `POST /goal` | ⚠️ 隐藏 agent 路径失败：source 修正后 `messageCount=3`，但 provider 报 `LlmError TRANSPORT`；同一 profile 的 live 会话正常。已支持 `/goal {agentId}` 指向 live 对话 |
| H1a | ✅ **工具面通过**：`mc_observe` → `mine dirt 2` → `stop` → `mc_finish(achieved=true)`；任务日志 `collected 4/2` |
| H1b | ✅ **工具面通过**：无 `mc_step`，`mc_finish(achieved=false)`，说明缺钻石/工作台；`/health steps=2` 未增加 |

**判定边界**：H1a/H1b 的**真实 DSH 工具面**已经通过；`/goal` 的新建隐藏 agent 因 host 无
provider transport 上下文而失败，现在改用 `agentId` 指向 live 对话。live `/goal` 尚未验证，
不能把 H1 标为“自动化完整通过”。

证据：`runtime/logs/dsh-h1-tool-results-2026-10-17.json`、`runtime/logs/agent-h1-tools-2026-10-17.log`。
`/goal` 的空会话证据：`~/.dsh/sessions/_no-cwd/mc-harness-*/session.v4.jsonl.zstd` 仅含 header。

### 待修：/goal 的 followup 未提交

- `/goal` 创建出的 agent 能返回 handle，但 `followup()` 后 session 仍只有 header；
  `whenIdle()` 立即返回。
- 已尝试：`ctx.get('agents')`、显式 `deepseek-official/deepseek-flash`、每次新建会话、
  `await followup`、`messageCount` 诊断；仍未解决。
- 结论：host 里程序化新建的 agent 没有当前桌面会话的 provider transport 上下文；
  这不是 driver 契约问题。正确做法是用 `agentId` 指向一个已存在的 live 对话。
- 复验：重启后开第二个 DSH 对话（保持 idle），用 `DSH_AGENT_ID=<id> npm run dsh:h1`。

### 重启后复验

```powershell
# 1. 重启 DeepSeek Harness（H1 无需 Full Access Ask；模式预设是对话级）
# 2. 启动 Minecraft client + Node agent
npm run dsh:h1
```

期望：

- `GET 8770/health` OK；
- H1a `steps >= 2`，`finish.achieved=true`；
- H1b `steps = 0`，`finish.achieved=false`，最终文本说明缺钻石/工作台。



- 插件默认创建**独立 DSH agent session**，不驱动桌面 UI；`/goal` 一次一个。
- 模型与 provider 使用 DSH profile 默认（`deepseek-official/deepseek-flash`）；
  如要覆盖，在插件 config 加 `agentOptions`。
- 插件工具注册在全局 tools 上；H1 测试只使用独立 session。若后续要限制到单 agent，
  改用 `agent.ctx.tools` 的 scoped registration（需要 DSH agent setup 回调）。
- 本文件记录的是**实现与安装**；DSH 重启后的真实 H1a/H1b 结果尚未执行，
  不能把接入本身当作 H1 通过。
- Full Access Ask 是**对话级模式预设**，不是启动参数；插件自身不提升权限，`mc_step` 只调用
  8766 命令表。H1 不使用它；M5 的 CU 对话才需要选择。
