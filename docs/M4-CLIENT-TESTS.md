# M4 代码技能客户端测试证据（2026-10-25）

> **2026-10-25 需求变更（重要）**：本文件 §1–§7 记录的 PASS 只覆盖**编排子集**——生成代码只能
> `read_state / submit_task / chat / wait / search / generate / subprocess`，动作全部由命令表任务执行。
> 操作员随后要求生成代码能**直接读 `/state` 并移动、挖掘、点击**，因此本文件的 A18 按新需求
> **不成立**，A19/A20/A28–A30 需按直接原语重验，M4 重开。v2 已**离线实现**（§9，`p1:m4:test 34/34`），
> 但**真实客户端未验**。方案见 [`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md)。

环境：真实 Forge 1.20.1 客户端 + `agent-client` mod，`mc.example.com:25565`，Node agent
`clientmod`；DSH 动作脑会话 **「Minecraft动作脑1」**
`session-8d816775-c46e-4ed7-9b08-115622a84616`（`/health.boundAgentId` 实读）；
`planner.mode=off`，`language.brain=unified`，生成模型 `deepseek-flash @ api.deepseek.com`。
窗口：本地 10:30–11:00，游戏内先夜（`!sleep` 因床不可达失败）→ 天亮后开始动作类测试。

## 1. 本次接线（实时入口）

| 入口 | 证据 |
| --- | --- |
| `!code-skill list` | 命令回执列出 promoted：`agent.status_report@1.0.0` |
| `!code-skill <name> [json]` | 后台 `CodeSkillTask`（`code_skill`）→ `runPromoted`；未知/未晋升立即报错 |
| `code_skill` 任务类型 | `TASK_BUILDERS` 注册；`mc_plan` 单步计划实跑（见 A18） |
| 动作脑 `mc_step` | 动作脑两次 `mc_step` 调用 `code-skill agent.status_report`（插件 `steps=2`） |
| 取消 | `POST /code-skills/cancel` → `AbortController` → 子进程 `SIGKILL`，候选不隔离 |
| 离线 | `p1:m4:test 34/34`（含任务派发/未晋升拒绝/取消/`isDay`/promote-rollback 状态机） |

## 2. A18 真实目标闭环（2 类，生成 → 试运行 → 效果 → 晋升 → 实时调用）

### 目标 A：`agent.status_report`（读状态 + 中文播报；现有技能不覆盖的组合报告）

- 生成：真实模型，manifest `permissions=["read_state","chat"]`，2706 B；
  候选目录 `runtime/code-skills/candidates/agent/status_report/1.0.0/`。
- 试运行 1.0.0（`runtime/code-skill-runs/agent.status_report@1.0.0-run-1792895933854-s9w6xw.json`）：
  2 次能力调用 `read_state` + `chat` 均 ok；状态值 20/20、坐标、`hostiles=0` 与 `/state` 一致；
  **但报告写成“夜晚”**——见 §5 缺陷 1（`isDay` 字段缺失，已修）。
- 修复后生成 1.1.0（2523 B），试运行
  `agent.status_report@1.1.0-run-1792896185519-ofnoeg.json`：
  `{"health":20,"food":20,"position":{...},"dimension":"主世界","isDay":true,...}`
  报告「生命20 饥饿20 位置(15.4,64,60.8) 主世界 白天 敌对0」。
- 晋升：1.0.0 → 1.1.0（`previous:"1.0.0"`）；回退演练后当前 1.0.0（见 A20）。
- 实时调用（动作脑）：`mc_step` → `code-skill agent.status_report`；Node 日志
  `enqueue(directive,chat): code_skill ...`、`done code_skill ... succeeded`，语言脑播报
  「白天现身啦…」「日头亮堂堂的…」。证据 `runtime/logs/start-agent3/5-20261025.log`。
- 计划调用（动作脑）：`mc_plan` 提交 `plan-1792896332472-ievp8`，goal「M4 code_skill plan smoke」，
  单步 `{"type":"code_skill","args":{"name":"agent.status_report"}}`，postcondition
  `inventoryAtLeast {"minecraft:dirt":3}`；计划 **completed**、步骤 done，动作脑回执
  `{"ok":true,"planId":"plan-1792896332472-ievp8",...}`（插件 `plans=1`）。

### 目标 B：`agent.dirt_topup`（条件补土：读状态 → submit_task → 复核真实增量）

- 生成：真实模型，permissions `["read_state","submit_task","chat","wait"]`，6259 B。
- 试运行（`agent.dirt_topup@1.0.0-run-1792895947600-grfkgf.json`）：
  `before=0, after=1, delta=1`；4 次能力调用；世界侧 `/state` dirt **0 → 1**；
  任务事件 `mine: mine 1x dirt`、`picked up 1 (1/1)`，source=`code-skill`。
- 晋升 1.0.0；实时调用（面板命令 `code-skill agent.dirt_topup {"target":3}`）：
  技能提交 mine 后 **任务排在 code_skill 之后**（同一 body slot），6s 内看不到增量，如实返回
  `pending:true` 并播报「补土的活儿排上队了，不过土还没见多呢」；code_skill 结束后排队的
  mine 执行，dirt **2 → 3**（`dequeued mine` / `picked up 1 (1/1)`）。再次调用同参数：
  `before=3` 直接跳过，播报「土够啦」。
- 边界：这是**实时编排的两阶段语义**（见 §5 缺陷 5）；单次试运行（HTTP）可同步看到增量。

## 3. A19 未授权宿主访问（实测子集）

| 尝试 | 结果 |
| --- | --- |
| manifest 申请 raw `fs` 权限 | `{"ok":false,"reason":"invalid-manifest","errors":["permission-not-allowed:fs"]}`（未落候选） |
| 生成代码含 `require('fs')` | `{"ok":false,"reason":"unsafe-code","errors":[{"reason":"require-not-allowed","line":1}]}`（未落候选） |
| 运行未晋升/已隔离版本 | `POST /code-skills/agent.boom/run` → `{"ok":false,"reason":"not-promoted"}` |
| **vm 逃逸**（真实 `SandboxRunner` + 构造探针） | `console.log.constructor` / `module.constructor.constructor` / `ctx.read_state.constructor` 都能拿到 **worker 子进程**的 `globalThis.process`（vm 不是边界，已记录的残余）；但随后：`require === undefined`；**所有** `getBuiltinModule(name)`（fs/child_process/module/vm/net/repl/crypto）→ `sandbox-denied-module`；`process.report.writeReport()` 与 `process.chdir()` → `Access to this API has been restricted`；`env` 仅 Windows 用户变量（无 API key/密钥） |
| **OS 隔离**（子进程同款 `--permission` 参数） | 读 `C:/Windows/win.ini`、写文件、`child_process` → `ERR_ACCESS_DENIED`；env 已剥离；**网络曾可达**（`fetch` 返回 401）→ 已加 `subprocessGuard.js` 预载：所有 `require` 拒绝、`fetch/WebSocket` 删除、`process` 逃逸钩子清空；复测 `fetch/net/fs/child` 全部 DENIED |
| **覆盖内置** | manifest 名 `mine` → `invalid-manifest: name-must-be-namespace.skill`（未落候选）；`!mine dirt 1` 仍是内置任务（dirt 3→5，日志 `task:mine`）；`!code-skill mine` → `unknown promoted code skill` |
| 死循环（有限长循环 `for i<1e9`） | 4000ms 硬超时：`timeout:true`、`SIGKILL`、候选 `quarantined`、promote 被拒 `not-trialled` |
| 运行中撤销 | `POST /code-skills/cancel` → `cancelled:true`、`SIGKILL`、候选保持 `candidate`（不隔离） |
| **失联（子进程被杀）** | 运行中 kill sandboxWorker → `sandbox-exit: code=4294967295`、候选 `quarantined`、sandbox 目录清理为 0 |
| **失联（宿主硬杀）** | 运行中 `taskkill /F` 杀 Node agent → 子进程随 IPC 断开退出（无孤儿循环）；trial HTTP 连接失败；`run-*` 目录遗留 |
| **拒绝清理** | 超时/取消均为 SIGKILL + 目录删除；宿主硬杀遗留的 `run-*` 目录由**启动清扫**移除（本次启动日志 `removed 4 stale sandbox dir(s)`，含 3 个 10-18 遗留） |

加固（本轮新增，均在 `p1:m4:test 34/34`）：

1. **模块访问从 denylist 改为全拒**：escape 后也无法加载任何 builtin（原先 repl/crypto/perf_hooks 可达）。
2. **`subprocessGuard.js` 预载**：子进程无网络/模块/逃逸钩子（Node 24 的 permission model 不覆盖网络）。
3. **启动清扫 `run-*` 沙箱目录**：宿主硬杀后的残留不会永久堆积。

残余风险（A19 判定的边界）：vm 不是内核级边界，逃逸可读 worker 进程元数据与 Windows 用户环境变量
（无密钥）；隔离是「Node permission model + JS 层守卫」，不是容器/OS 防火墙；未做内核级网络隔离。


## 4. A20 坏技能隔离、回退与下线

- 失败注入：生成 `agent.boom`（`throw new Error('intentional M4 failure')`），试运行
  `ok:false`、`status:quarantined`（证据 `agent.boom@1.0.0-run-1792896394077-zloiwu.json`）；
  promote → `not-trialled`；run → `not-promoted`。
- 回退：`POST /code-skills/rollback {"name":"agent.status_report"}`
  → `store/directory` 均 `{version:"1.0.0", rolledBackFrom:"1.1.0"}`，promoted 只剩 1.0.0；
  回退后实时调用仍成功（`done code_skill ... succeeded`）。
- 下线：`POST /code-skills/agent.dirt_topup/1.0.0/retire` → promoted 列表移除；
  `!code-skill agent.dirt_topup` → `unknown promoted code skill`；目录与指针同步清理。

## 5. 本轮发现并修复的缺陷

1. **`read_state.isDay` 恒为空**：`clientModBody.snapshot()` 没有 `isDay`，`service._readState`
   读 `snap.isDay` 得 `undefined`，技能只能报“夜晚”（天亮时语言脑播报「天黑啦」）。
   修复：body 用共享 `isDaytime(time)` 派生 `isDay`；service 再用同一规则兜底；
   `p1:m4:test` 新增 timeOfDay 权威/isDay 回退断言。
2. **`CodeSkillTask.progress()` 恒为 1**：连续两次运行触发 B1「made no progress (1) for 2 runs -
   parking it briefly」。修复：不覆写 `progress()`（null = 不可比进度）+ 断言。
3. **promote/rollback 后多个版本同时 `promoted`**：回退后 1.1.0 仍标 promoted，且被回退的版本
   无法再次晋升。修复：promote 时把被取代版本降回 `trialled`；rollback 时把被回退版本降回
   `trialled`、目标版本置 `promoted`（同一 name 只有一个 promoted 记录）+ 断言。
4. **思考模型生成被截断**：`deepseek-flash` 的 reasoning 计入 completion；
   `generateMaxTokens=2600`（后 6000）时两次都在上限处截断 → `malformed-envelope`。
   配置改为 `generateMaxTokens=16000`、`generationTimeoutMs=180000` 后生成成功
   （1.0.0 用 5148 tok/24.6s；dirt 用 11897 tok/49.8s）。**运行期改动，重启 Agent 生效。**
5. **实时编排的两阶段语义**：`code_skill` 任务持 body slot，技能内 `submit_task` 只能排队到
   自身之后；因此“提交任务后立即复核”的技能在实时调用时返回 `pending`，任务在技能结束后执行
   （试运行的 HTTP 路径没有这个限制）。技能需按两阶段编写，或仅在试运行里做同步编排验证。
   后续可评估“编排型技能不占 body slot”的设计，本轮如实记录。
6. **vm 逃逸可达 worker 进程**（A19 探针）：`console.log.constructor` 等三条路径都能拿到
   worker 子进程的 `process`；`require` 与模块加载是当时唯一的第二层。修复：`Module._load`
   与 `process.getBuiltinModule` 改为**全拒**（原先 denylist 还放行 repl/crypto/perf_hooks）；
   新增回归断言「逃逸可到 process，但任何模块都加载不了」。
7. **subprocess 子进程有网络出口**（A19 探针：`fetch` 返回 HTTP 401）：Node 24 的 permission
   model 不覆盖网络。修复：新增 `subprocessGuard.js` 预载（全拒 require、删 fetch/WebSocket、
   清 process 逃逸钩子），子进程参数加 `--require <guard>` 与读权限；复测 fetch/net/fs/child 全拒。
8. **宿主硬杀后沙箱目录残留**：`run-*` 目录只能由父进程清理；硬杀留下 4 个（含 3 个 10-18 遗留）。
   修复：`CodeSkillService` 启动时清扫 `run-*` 目录（不动其他目录），本次启动日志
   `removed 4 stale sandbox dir(s)`；子进程本身随 IPC 断开退出，无孤儿循环。

## 6. A27 代码子项（真实模型回执）

- 9 次真实 `code-generation` 调用（`runtime/llm-usage.jsonl`），其中 2 次因 token 截断失败
  （3286/6686 tok），修复预算后 7 次成功；总 37,816 tok。成功样本：
  status 1.0.0（5148 tok/24.6s）、dirt（11897 tok/49.8s）、status 1.1.0（4873 tok/20.5s）、
  boom（302）、slow_loop（948）、rawperm（252，被 manifest 拒）、require（263，被静态扫描拒）。
- 解析/校验/沙箱/证据/晋升全链路与 provider/model 记录一致；错误路径均给出结构化 reason。

## 7. A28–A30 编码回合（2026-10-25，真实客户端 + 动作脑「Minecraft动作脑1」）

新增技能 `agent.slow_wait`（`wait 15000ms`，651 B）作为“长编码步骤”探针：真实生成、试运行
（15101ms）后晋升。

| 项 | 场景 | 结果 |
| --- | --- | --- |
| A28 | 长步骤 | 动作脑 `mc_plan` 提交 `code_skill agent.slow_wait`，计划 `plan-1792903645487-t146k`：s1 运行 **15.1s**，只产生 **1 次** `done code_skill`，计划 completed（version 2、step done、postcondition `positionNear` 成立）；动作脑 turn **1→0**（单次续轮），无重复结算 |
| A28 | 取消/迟到输出 | 直接 `/plan` 提交 slow_wait，3s 后 `POST /plan/<id>/cancel` → 计划 `cancelled` v2、step `cancelled`，1 次 `failed code_skill: code skill cancelled`；再等 14s（越过 15s wait）**没有**迟到的 `done code_skill` |
| A29 | 宿主硬杀/恢复 | slow_wait 计划运行中 `taskkill /F` 杀 Node agent；沙箱子进程随 IPC 退出；重启后 `state restored` 全 true、**启动清扫移除 1 个残留 sandbox 目录**；计划恢复为 **pending v1 / s1 pending / runId=null**，无重放、无新 `code_skill` 事件；动作脑 turn 为空 |
| A30 | 用量归属 | 本回合仅 1 条 `code-generation` 记录（`code-generation-1792903594211`，1064 tok，2.6s）；3 次沙箱运行（trial/长计划/取消）**没有**产生 LLM 用量（slow_wait 只 `wait`、长计划为 HTTP 直提），编码回合的模型用量可归到生成请求而非沙箱执行 |

边界：重复/乱序/迟到事件注入未在编码回合重跑（需要 `P1_TEST_HOOKS`），但编码步骤与普通任务共用
同一 TaskSlot / PlanRunner / TurnService，M3 的 A28 真机注入证据仍适用；本回合新增的是
“长编码步骤单次结算、取消后无迟到输出、硬杀恢复不重放、用量可归属”。

## 8. 判定（历史：编排子集；2026-10-25 需求变更后重开）

| 项 | 判定 | 依据 |
| --- | --- | --- |
| A18 | **不成立（编排子集）** | 旧 `status_report`/`dirt_topup` 只做 read_state→submit_task→chat；**没有直接 move/dig/click**。v2 直接原语已离线实现（§9），**真机 A18 未验** |
| A19 | **历史子集；直接原语 8 类未测** | vm/OS/覆盖内置/死循环/失联/清理仍有效；越界挖放用、非容器点击、多任务抢身体、取消后残留等只有离线用例（§9），**真机未验** |
| A20 | **部分** | 旧编排候选的 quarantine/rollback/retire 有效；直接原语候选“动作到一半失败”未测 |
| A27 代码子项 | **PASS（生成管线部分）** | 真实模型回执、解析、沙箱、证据、token 账本；v2 提示词已改，v2 真实生成未验 |
| A28（编码回合） | **需重跑** | 旧 slow_wait 长步骤证据只证明编排长步骤 |
| A29（编码回合） | **需重跑** | 旧硬杀恢复只覆盖编排计划 |
| A30（编码回合） | **需重跑** | 旧用量归属仍成立，但需覆盖直接原语长任务 |
| M4-D01 | **PASS** | code-skill 的 `chat` 经语言脑 roleplay 输出（试运行与实时播报均为语言脑措辞） |
| M4 阶段 | **未通过（重开；v2 离线已实现）** | 旧编排子集一度判 PASS；v2 原语/租约/校验已离线 34/34，真实客户端 A18/A19/A20/A28–A30 未验 |

## 9. v2 直接身体原语离线实现（2026-10-25；**未跑真实客户端**）

按 [`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md) 落地，操作员本轮明确“只做离线测试”：

| 项 | 结果 |
| --- | --- |
| 契约 | `apiVersion: 2` + 7 个 `body_*` 权限；v1 声明 body 权限被拒；`capabilities.js` 统一“ctx 方法→权限”（`block_at/find_blocks` 归 `read_state`） |
| 读状态 | `read_state({blocks:{radiusXZ,radiusY,limit}, includePlayers, includeCrops, includeItems, includeMenu})`；blocks 为 palette+相对 cells、服务端限长（>24KB 自动截断），不返回整张 63k 映射 |
| 原语 | `body_move/body_dig/body_place/body_use/body_click/body_look/body_look_at/body_attack`；距离/屏幕/目标校验，超时与 abort 都调用 `body.interrupt()` |
| 执行权 | 试运行与 HTTP `/run` 先 `TaskSlot.acquire({holdsBody:true})`，忙返回 `body-busy`；`CodeSkillTask` 传 `slotHeld:true`；finally 释放 |
| 安全 | `body_click` 只在容器屏（`PauseScreen` → `operator-screen`）；`body_attack` 只接受快照里的敌对生物；静态扫描/vm 模块全拒不变 |
| 离线证据 | `p1:m4:test` **34/34**（真实 sandbox 执行 move+dig、越界拒绝、容器/暂停屏点击、body-busy、取消中断+释放、攻击仅敌对、HTTP/slotHeld 租约）；`p1:contract:test 206/206`；`p1:verify 11/11` |
| 未验 | 真实 `permissionGate` ask/`!yes`、真实导航/挖掘/点击物理终态、`body.interrupt` 对真实按键释放；需真机 A18/A19/A20/A28–A30 |

证据路径：`scripts/p1-m4-test.js` §5（v2 用例）、`src/codeSkills/{capabilities,manifest,service,sandboxWorker,sandboxRunner}.js`、
`src/tasks/codeSkill.js`、`src/codeSkills/generation.js`（v2 提示词）。

证据路径：`runtime/code-skills/`（candidates/promoted/current 指针）、
`runtime/code-skill-runs/`（每次试运行/实时运行 JSON）、`runtime/llm-usage.jsonl`（code-generation）、
`runtime/logs/start-agent3/4/5/6/7-20261025.log`（M4 主窗口）、
`runtime/logs/start-m4rem-20261025.log`（A28）、`runtime/logs/start-a29-20261025.log`（A29）、
`/plan` 记录 `plan-1792896332472-ievp8`、`plan-1792903645487-t146k`、`plan-1792903706375-1`、
`plan-1792903734718-2`。测试辅助脚本只在 `.tmp/`（未入库）：`m4-post.js`、`m4g-*.json`。
