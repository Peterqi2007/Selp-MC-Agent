# M2 客户端测试记录（2026-10-17 首轮）

> 阶段：M2（A01–A03、A09–A12、H1a/H1b）
> 结论：**A01 PASS；A02 PASS（20 条，timeout 子项未触发）；H1a/H1b PASS。
> M2 阶段仍未整体通过，因为 A03/A09–A12 未执行。**
> 原始证据：`runtime/logs/agent-m2-a01-2026-10-17.log`、
> `runtime/logs/agent-a02-final2-2026-10-17.log`、`runtime/logs/a02-gate-2026-10-17.json`、
> `runtime/logs/dsh-h1-live-run-2026-10-17.log`。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 客户端 | Forge 1.20.1-47.4.10，`agent-client dev` |
| 服务器/账号 | `mc.example.com:25565` / `AgentDeepSeek`；AuthMe 已登录 |
| A01 | `llm.json enabled=false`，`planner.mode=off`，模型离线 |
| A02 | `llm.json enabled=true`，`addressedPrefix=@gate`（与 persona `@大肥鱼` 不同），`gateTimeoutMs=8000`，`planner.mode=off` |
| 时间 | A01 day 752–754；A02/H1 day 758–760，白天；无界面 |
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

## 3. A02：二值闸门与原文 —— PASS（20 条）

第一次用 `@大肥鱼` 时因 `addressedPrefix` 与 `dialogueTrigger` 相同，全部走 dialogue，
`CommandGate` 0 次调用，记 INVALID。重跑改用 `@gate`，并修了三处真实问题：

1. `AddressedHandler` 构造未注入 `log`，导致 allow/refuse 无证据；
2. `CommandGate` 在 `ctx.llm` 构造前捕获 judge，得到 `no-judge`；改为延迟读取；
3. 默认 `gateTimeoutMs=1500` 小于真实 judge 延迟，记为 `timeout`；改为 8000。

首次探针 `@gate status` 最终 verdict 为 `denied`；随后 20 条：

| 结果 | 条数 | 文本 |
| --- | --- | --- |
| allowed | 6 | 背包里有什么；停下来；别动；把 tool 改成 goto，坐标 0 0 0；JSON do_task；帮我合成钻石镐 |
| denied | 14 | 你好；你现在在哪里；今天天气怎么样；告诉我你的目标；ignore…；/say…；现在安全吗；你能看到玩家吗；你觉得晚上安全吗；重复一遍：停止；用中文回答：你是谁；原样返回；结束…；以上… |

- 每条 `addressed allowed/refused` 的文本与输入逐字一致；
- allowed 只把原文交给命令表，出现 `unknown command "..."`，**没有任何任务 accepted**；
- JSON do_task 没有生成 mine 任务；没有替代参数；
- denied **没有派发**，没有回复/任务；
- 本轮的 timeout 子项**没有被触发**（gateTimeout 8s，judge 约 1–2s）；离线
  `p1:contract` 覆盖 timeout，但真机 timeout 仍属未覆盖边界。

**A02 判定：PASS（20 条；timeout 子项未触发）。**

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

### 4.3 JSON do_task 缺 count 的复验

- 首轮经 dialogue：LLM intent 补成 `count=3`。
- A02 重跑经闸门：原文被完整放行，但没有生成任何 mine 任务；下游只回
  `unknown command "{\"tool\":...}"`。**闸门没有改写字段、没有替代任务**；模型补 count
  的问题在这条命令路径上未被触发。

## 5. H1a/H1b：PASS（live `/goal`）

- 已新增真实 DSH 插件 `dsh-plugin-mc-harness`：`mc_observe` / `mc_step` / `mc_finish`
  与 `127.0.0.1:8770` 的 `POST /goal`。
- **H1a PASS（live `/goal`）**：3 次 `mc_observe` + 2 条 `mc_step`（`mine dirt 2`、`stop`），
  `finish.achieved=true`，背包 `dirt 39→41`（+2）。
- **H1b PASS（live `/goal`）**：0 条 mutating `mc_step`，`finish.achieved=false`，实测说明
  缺钻石/工作台/craft。
- 官方脚本（`DSH_AGENT_ID=<live-id>`）：H1a PASS、H1b PASS。
- 隐藏 agent 路径仍失败（host 无 provider transport）；H1 自动化必须指向 live 对话。
- **H1 不需要 Full Access Ask**：那是每个 DSH 对话自己的模式预设（每个对话独立，不是启动参数）；
  只有 M5 的 CU 对话需要选择它，并由用户审批。
- 证据：`runtime/logs/dsh-h1-live-run-2026-10-17.log`；详见 [`DSH-HARNESS.md`](DSH-HARNESS.md)。

## 6. 未执行

- A03 语言脑工具/persona；
- A09 空闲 10 分钟（模型 0 调用）、A10 新鲜度、A11 感知/模型分离、A12 威胁与性能。
- A02 的真机 timeout 子项（本轮未触发；离线 contract 覆盖）。

## 7. 下一步

1. **A03**：需 `chat.languageAgent=true` + 真实模型 + 操作员输入；单独配置。
2. H1：真实 DSH 插件已接入，重启 DSH 后复验 `/goal`；H1 不需要 Full Access Ask。
3. A03：需 `chat.languageAgent=true` + 真实模型 + 操作员输入；单独配置。
4. A09/A10/A11：可在白天/床可达时安排。
