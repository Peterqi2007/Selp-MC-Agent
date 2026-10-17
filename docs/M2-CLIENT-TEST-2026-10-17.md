# M2 客户端测试记录（2026-10-17 首轮）

> 阶段：M2（A01–A03、A09–A12、H1a/H1b）
> 结论：**未通过；A01 通过，A02 本次无效（未走闸门），H1 阻塞（无真实 harness 入口）**。
> 原始证据：`runtime/logs/agent-m2-a01-2026-10-17.log`、
> `runtime/logs/agent-m2-a02-2026-10-17.log`、`runtime/llm-trace.jsonl`、
> `runtime/path-trace.jsonl`。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 客户端 | Forge 1.20.1-47.4.10，`agent-client dev` |
| 服务器/账号 | `mc.example.com:25565` / `AgentDeepSeek`；AuthMe 已登录 |
| A01 | `llm.json enabled=false`，`planner.mode=off`，模型离线 |
| A02 | `llm.json enabled=true`，`addressedPrefix=@大肥鱼`，`planner.mode=off` |
| 时间 | day 752–754，白天；无界面 |
| 结束 | Agent/客户端已停止，配置恢复默认（`llm enabled=true`、`addressedPrefix=null`、`planner=legacy`） |

## 2. A01：`!` 免语言审查 —— 通过

模型离线启动日志：`LLM layer is OFF (disabled in config)`。通过面板发送：

```text
!status
!mine
!goto 70 64 32
!shoot player
```

结果：

- `/llm` tokens **0 → 0**；
- `status` 3ms 返回；
- 非法 `mine`：`usage: !mine <block> [n]`；
- `goto 70 64 32` 受理；
- `shoot player`：`no player within 24 blocks`，明确失败；
- 没有模型调用、没有因 persona 拒绝。

**A01 判定：PASS（面板路径）。**

## 3. A02：二值闸门与原文 —— 本次 INVALID，未真正执行

用户按 `@大肥鱼 ...` 输入了 20 条，Bot 全部有回应，但日志显示：

```text
(chat) dialogue: <AgentDeepSeek> @大肥鱼 看看周边有没有树
```

- `ChatListener` **先判断 `dialogueTrigger`，后判断 `addressedPrefix`**；两者都解析为
  `@大肥鱼`，所以 20 条全部走了 **dialogue 路径**，`AddressedHandler` / `CommandGate`
  **一次都没有被调用**。
- 因此本轮不能用来判定 A02 的 allow/deny、原文一致、无替代任务；不能记 FAIL，只能记
  **INVALID（测试配置错误）**。
- 副作用：20 条真实模型调用，`/llm tokensToday=113334`；这是实际成本，已记录。
- 代码已加启动警告：`addressedPrefix` 与 `dialogueTrigger` 相同时提示“dialogue wins，
  gate bypassed；A02 用不同前缀”。

## 4. 对话路径暴露的两个真实缺陷（已修）

### 4.1 `!mine dirt 1` 多挖

- LLM trace：`挖1个泥土` → `action: mine count=1 block=dirt`，dispatch 行也是 `... 1`。
- 但任务日志：`enqueue ... mine: mine 3x ...`；最终 `collected 3/3 (7 blocks broken)`。
- 原因：`src/chat/commands.js` 在创建 `MineBlockTask` 时写了
  `count: dispatched.count + 2`。已改为 `count: dispatched.count`。
- 回归：`control:test 38/38` 新增“!mine dirt 1 只建 1 个目标”。

### 4.2 `explore` 在无遮挡处反复重走并报 stalled

- LLM action：`skill explore distance=16 direction=random`，目标 `86,65,33`。
- path trace：路径规划成功（15 节点）；走到 `83,66,33`（水平 3、垂直 1，距离 3.16），
  `moveTo` 反复“arrived”到 83，GoTo 5 次后 `stalled`；当时无遮挡。
- 原因：`explore` 用 `range: 3`，3.16 刚好超出；walk 到 83 后不再尝试最后 3 格。
- 已改为 `range: 4`；`skills:test 57/57`。这不是 A02 闸门问题，但确实影响“看树”体验。

### 4.3 JSON do_task 缺 count 被模型补成 3

- 输入：`{"tool":"do_task","args":{"name":"mine","block":"diamond_ore"}}`（无 count）。
- LLM intent 输出 `count=3`；这是模型补默认值，不是闸门放行/拒绝问题（本轮未走闸门）。
- 记为 **待复验的模型行为**：A02 重跑时若走闸门，应观察原文是否被保留、是否生成替代参数。

## 5. H1a/H1b：已实现接入，待重启 DSH 验证

- 已新增真实 DSH 插件 `dsh-plugin-mc-harness`：注册 `mc_observe` / `mc_step` / `mc_finish`，
  并提供 `127.0.0.1:8770` 的 `POST /goal`。
- 已安装到 DSH desktop profile 并加载：`GET /health` 返回插件；
  `mc_step` 真机可用（手动 `mine dirt 2` 经 8766 执行完成）。
- 重启后 `/goal` 已能创建会话并返回 200，但首轮 `steps=[] / final=""`：程序化 agent 没有
  provider/model；已补默认 `deepseek-official/deepseek-flash`、每次 goal 新建会话和
  `messageCount` 诊断，**待再次重启加载**。
- 因此 H1a/H1b **尚未通过**；不能把“插件加载 + mc_step 可用”当作 H1 通过。
- **H1 不需要 Full Access Ask**：那是每个 DSH 对话自己的模式预设（每个对话独立，不是启动参数）；
  只有 M5 的 CU 对话需要选择它，并由用户审批。
- 重启后运行 `npm run dsh:h1`；详见 [`DSH-HARNESS.md`](DSH-HARNESS.md)。

## 6. 未执行

- A03 语言脑工具/persona；
- A09 空闲 10 分钟（模型 0 调用）、A10 新鲜度、A11 感知/模型分离、A12 威胁与性能；
- A02 的正确闸门重跑。

## 7. 下一步

1. **A02 重跑**：`addressedPrefix=@gate`（与 `dialogueTrigger=@大肥鱼` 不同），
   20 条输入改前缀 `@gate`；会再次消耗模型 token，需用户确认。
2. H1：真实 DSH 插件已接入，重启 DSH 后复验 `/goal`；H1 不需要 Full Access Ask。
3. A03：需 `chat.languageAgent=true` + 真实模型 + 操作员输入；单独配置。
4. A09/A10/A11：可在白天/床可达时安排。
