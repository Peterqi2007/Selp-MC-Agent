# M1 客户端测试记录（2026-10-17 首轮）

> 阶段：M1（身份/能力/结果/执行权/停止）
> 判定口径：只看工作流是否正确，不要求任务成功；环境不足不判失败。
> 结果：**未通过（发现 2 个真实 FAIL，已修复，待复验）**。
> 原始证据：`runtime/logs/m1-client-run-2026-10-17.json`、`.console.log`、
> `runtime/logs/agent-m1-2026-10-17.log`。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 客户端 | Forge 1.20.1-47.4.10，`agent-client dev`，Java 21.0.7 |
| 服务器 | `mc.example.com:25565`，账号 `AgentDeepSeek`，AuthMe 已登录 |
| Agent | `planner.mode=off`，`state.enabled=false`，模型在线（本轮未调用） |
| 时间/位置 | 白天（`timeOfDay≈8400–10376`），(62,61,32)，无界面 |
| 夜间 | 测试后临近夜晚；附近 60×10×60 内无床，按规则**停止**，未夜间继续 |
| 配置恢复 | 测试后 `planner.mode=legacy`、`state.enabled=false`；Agent/客户端已停止 |

## 2. 执行结果

### M1.1 / A04、M1.4 / A07：请求身份与替换

操作：发送 `goto 70 61 32`，200ms 后发送 `goto 80 61 40`；读取 SSE 事件与
`/ui/state`。

观察（事件 seq 1–7）：

```
1 task:failed go-to go-to#0 noPath 70,61,32
2 task:failed go-to go-to#0 noPath 80,61,40
3 task:failed go-to go-to#1 noPath 70,61,32
4 task:failed go-to go-to#1 noPath 80,61,40
5 task:failed go-to go-to#2 noPath 70,61,32
6 task:quarantined go-to go-to#2 strikes
7 task:failed go-to go-to#2 noPath 80,61,40
```

- **FAIL（身份）**：两个不同的 `go-to` 任务共用 `taskId="go-to"` 与
  `attemptId="go-to#0"`，事件不可区分；这正是 A04 要防的“推进错误请求”。
- **FAIL（终态重复）**：重试的每次尝试都发布 `task:failed`，同一逻辑任务出现多次终态播报；
  A04 要求“终态最多一次播报”。
- 观察到的 19ms 空闲与单 `current` 不能证明 A07 全部通过；A07 的多步计划/父计划子步骤
  本轮未构造。
- **修复已落**：`TaskSlot` 为每个 task 分配唯一 `taskId`，`attemptId` 使用
  `taskId#retry`；失败事件带 `retrying/terminal`，只有最终尝试 `terminal:true`。
  P0 `control:test` 仍能在首次失败时收到事件；回归 `p1:contract 153/153` 覆盖同名任务与
  终态标记。

### M1.5 / A08：停止

操作：在 `goto 200 64 200` 后 400ms 发 `stop`。

- `runningBeforeStop=false`：任务在 stop 前已 `out-of-grid` 失败；**停止测试无效**
  （stop 10ms、无位移，但不能证明“运行中 ≤3s 停止”）。
- 结论：**INVALID，不是 PASS**；需要选一个真正运行的长时间任务重测（例如 `mine dirt` 或
  可达路径的长 `goto`）。

### M1.3 / A06：进度与完成（**真实 FAIL**）

操作：`mine diamond_ore 1`（附近没有钻石矿）。

- 回执 `taskId=t1`；随后事件 `task:done`，reason:
  `mined 0 diamond_ore/deepslate_diamond_ore (dug 0 blocks, ... collected 0 drop(s))`。
- **FAIL**：零产出仍报 `task:done`，属于 A06 明确禁止的“虚报完成”。
- **修复已落**：`src/skills/mining.js` 改为 `ok = !planExceeded && stats.ores > 0`；
  回归 `mining-collection-test 25/25` 新增“零矿不得成功”。

### M1.2 / A05：能力统一（部分）

操作：`craft diamond_pickaxe 1`（材料不足）。

- 回执：`ok:false, reason:"missing diamond x3"`，任务未启动、无动作。
- **PASS（命令路径）**：缺料与不支持的区分在命令入口成立。
- **未覆盖**：自然语言/规划入口是否共用同一能力来源；A05 不能整体通过。

### M1.6 / A31、M1.7 / F3：SSE 与身份

- SSE `/events` 连接成功，收到 11 条事件，seq 单调；`taskId/attemptId` 字段存在但如上冲突。
- 以 `lastEventId=11` 重连，1.2s 内无事件（没有重复），但未验证“从更早 ID 重放”的完整性。
- **未测**：token 鉴权（`web.eventsToken` 为空）、`planVersion` 旧草案拒绝、双 emitter 去重。
- 结论：**PARTIAL**，不能算 A31/F3 通过。

## 3. 修复与离线证据

| 修复 | 文件 | 离线验证 |
| --- | --- | --- |
| 同名任务唯一 `taskId`/`attemptId` | `src/core/taskSlot.js` | `p1:contract:test 153/153`（同名任务） |
| 重试终态标记（兼容 P0 首次失败事件） | `src/core/taskSlot.js` | `p1:contract:test 153/153`（terminal 标记）；`control:test 37/37` |
| 零矿不得 `ok` | `src/skills/mining.js` | `mining-collection-test 25/25`（新增 C04b） |
| 完整门禁 | — | `npm run p1:verify` 结果见下 |

**当前 M1 判定：未通过（核心可测子集复验通过，仍有未覆盖子项）。** A06 的修复已在真机
确认：零矿变 `task:failed`；A04 的同名任务 ID/终态标记已确认；A08 运行中停止 816ms；
F3 token/重放通过。剩余覆盖见 §4。

## 4. 复验（2026-10-17 11:29，day 749 / timeOfDay 575）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| A06 零矿 | **PASS（修复后）**：`mine diamond_ore` 无目标 → `task:failed`（`terminal:true`），不再 `task:done` | `m1-client-retest-2026-10-17.json` |
| A04 身份/终态 | **PASS（可测子集）**：两个 go-to 为 `task-1`/`task-2`；attempt `#0/#1/#2` 各自唯一；仅最终尝试 `terminal:true`，重试为 `retrying:true, terminal:false` | 同上 |
| A08 停止 | **PASS（停止子集）**：`mine dirt 64` 运行中发 stop，**816ms** 后 `current=null`，任务 `cancelled`；未验按键释放/死亡/断线 | 同上 + `agent-m1-retest-2026-10-17.log` |
| F3 token | **PASS**：无 token `401`；`?token=m1-test-token` `200` | `m1-sse-token-2026-10-17.log` |
| A31 重放 | **PASS（重放子集）**：`lastEventId=0` 收到 seq 1–10；`lastEventId=5` 只收到 6–10 | `m1-sse-replay-2026-10-17.json` |
| A05 命令 | 已过（missing diamond 拒绝）；NL/规划入口未测 | 首轮记录 |
| A07 计划互斥 | 只验证了替换/排队；父计划/子步骤未测 | 首轮记录 |

**仍未覆盖（不能据此宣布 M1 全通过）**：
- A04 的重复/乱序/取消后回调/迟到模型输出注入；
- A05 的自然语言与规划入口；
- A07 的父计划/子步骤替换与停止超时；
- A08 的死亡/断线/人工接管与按键释放；
- A31 的双 emitter、`planVersion` 旧草案拒绝。

## 5. 下一轮 M1 复验清单

1. 白天、存活、无界面；有可达床或在白天窗口内完成。
2. A04：两个同名任务 → `taskId/attemptId` 不同；`terminal:true` 每任务一次；
   重试只带 `retrying:true`。**已通过可测子集**。
3. A06：`mine diamond_ore` 无目标 → `task:failed`/partial，不是 `task:done`。**已通过**。
4. A08：运行中停止 ≤3s、按键释放、无迟到动作；死亡/断线/接管另测。**停止子集已通过**。
5. A31/F3：带 `Last-Event-ID` 重放（已过）、token 401/200（已过）；`planVersion` 旧草案拒绝
   与双 emitter 需宿主接口。
6. 记录：每次测试前确认 `screenOpen=false`、白天/床、背包/工具；入夜停止。
