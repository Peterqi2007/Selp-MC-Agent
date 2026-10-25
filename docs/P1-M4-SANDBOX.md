# P1 M4 沙箱与授权规则（2026-10-18 窗口）

> 本文件是本次 M4 接线的**执行前规则**，先于代码落地。操作员授权：
> 真实生成代码可写入候选、可在受限进程中真实试运行；**保留沙箱限制、取消逐动作审批**。
> 权限边界：`read_state / submit_task / chat / wait / search / generate / subprocess`；
> 搜索经 Node 使用 DeepSeek Search；超时、撤销、失败清理、证据保留规则由本文件确定。
> **2026-10-25 需求变更**：操作员要求生成代码直接 `/state` 读世界并移动/挖掘/点击；`body_*` 权限
> 与 host 代理见 §2.1 与 [`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md)；**已实现（离线 35/35），
> A18–A20、A28–A30 真机 PASS（A19 适用子集；残余 PauseScreen/第二玩家仅离线）**。

## 1. 信任边界

| 侧 | 信任 | 职责 |
| --- | --- | --- |
| 父进程（Node agent） | 可信 | 生成/校验/落盘候选；启动子进程；代理全部能力；TaskSlot/权限门；证据与晋升 |
| 子进程（`sandboxWorker.js`） | 不可信 | 只求值候选；无 direct fs/net/child_process；能力全部 RPC 回父进程 |
| 生成代码 | 不可信 | 静态扫描后才能成为候选；只在子进程的 vm context 中运行；父进程**从不** `require`/`import` 它 |

**边界不是“模型自律”**：manifest 权限、静态扫描、Node permission model、worker 的模块/全局封锁、父进程 RPC 白名单、调用预算、硬超时、清理共同生效。

## 2. 允许的能力与硬限制

| 能力 | 实现 | 限制 |
| --- | --- | --- |
| `read_state` | 父进程 `CodeSkillService._readState` | 只返回位置/生命/饥饿/维度/时间/背包计数/最多 8 个敌对生物；不返回方块全图、玩家列表或服务器地址 |
| `submit_task` | `Brain.submitExternalTask` → `buildTask` + `enqueue` | 只允许已知任务类型；仍走 TaskSlot/权限门；返回接收回执，不直接持有 body |
| `chat` | 现有 `ctx.reply(..., {conversation:true})` | ≤100 字符；≥1.2s 间隔；ConversationState 去重/过期/回声守卫 |
| `wait` | worker 本地 `setTimeout` | 单次 ≤30s；总时长仍受父进程 wall clock |
| `search` | `SearchService` → DeepSeek `POST /v1/tools/search` | 查询 ≤128 字符；拒绝坐标/IP/@玩家名；8s 超时；结果标记 `untrusted`；写 `runtime/search-cache.json` |
| `generate` | `CodeSkillGeneration` → 同一 LLM client | 每次 run 最多 1 次；产物仍走 manifest+静态扫描；写 `candidates/`，不自动晋升 |
| `subprocess` | 父进程启动 `node <sandbox>/sub-*.js` | 无 shell；只允许 sandbox 目录内脚本；10s 硬超时；stdout/stderr 各 ≤16KB；`--permission` 只读 sandbox；**`--require subprocessGuard.js`：全拒 require、删 fetch/WebSocket、清 process 逃逸钩子**（Node 24 permission model 不覆盖网络）；不继承密钥环境 |

**全部 run 的硬限制**：默认 30s（上限 60s）；最多 100 次能力调用；结果/日志各 32KB；内存 `--max-old-space-size=128`；sandbox 目录一次性、结束后删除。

### 2.1 直接身体原语（v2，2026-10-25 需求变更；**已实现，离线 35/35，A18–A20 真机 PASS**）

> 现有手写/生成技能只有编排能力，操作员要求生成代码能直接读 `/state` 并移动、挖掘、点击。
> `body_*` 权限**已加入** `manifest.js` 白名单（`apiVersion: 2`），并已在 `CodeSkillService`/worker/
> runner 中实现；离线测试通过（`p1:m4:test 35/35`），真实客户端 A18–A20、A28–A30 已 PASS
> （A19 残余 PauseScreen/第二玩家仅离线）。设计见 [`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md)。

| 能力 | 映射 | 硬限制（已实现） |
| --- | --- | --- |
| `block_at` / `find_blocks`（`read_state` 权限） | `body.blockAt/findBlocks` | 目标必须在已加载快照；`count≤32`、`maxDistance≤32`；不返回整图 |
| `body_move` | `body.moveTo` | 目标距离 ≤64；单次 ≤30s；可被取消，取消后 `body.interrupt` |
| `body_dig` | `body.dig` | 目标在快照内、距离 ≤5；**走 permissionGate `dig`**（allow/deny/ask） |
| `body_place` | `body.place` | 参考方块面合法、物品在背包、距离 ≤5；**走 permissionGate `place`** |
| `body_use` | `body.useOn` | 目标方块已加载、距离 ≤5；**走 permissionGate `useOn`** |
| `body_click` | `body.clickSlot` | 只在**容器界面**；聊天/ESC/设置一律 `operator-screen` 拒绝；槽位按界面校验 |
| `body_look` / `body_look_at` | `body.look/lookAt` | 仅转向，不产生世界效果 |
| `body_attack` | `body.attack` | 只允许敌对生物；玩家/被动生物拒绝；距离 ≤6 |

**执行权与取消**：实时调用时 `CodeSkillTask` 已持有 TaskSlot；HTTP 试运行必须先
`TaskSlot.acquire({kind:'code_skill', holdsBody:true})`，忙则返回 `body-busy`（不并发抢身体），
结束/超时/取消在 finally 释放并 `body.interrupt`。试运行声明的 body 权限会展示在
`/code-skills` 状态里。

**证据**：每次原语调用记录 `{capability, args(坐标/槽位), ok, reason, ms}`；权限门拒绝写
`body.lastRefusal`；全部进入现有 evidence JSON 与预算计数。

## 3. 子进程的隔离参数

```text
node --permission
     --allow-fs-read=<sandboxDir>
     --allow-fs-read=<sandboxWorker.js>
     --max-old-space-size=128
     --no-warnings
     sandboxWorker.js
```

- 无 `--allow-fs-write`：不能写文件；
- 无 `--allow-child-process`：不能直接起进程；
- 无 `--allow-worker` / `--allow-addons` / `--allow-inspector` / `--allow-wasi`；
- worker 读取 entry 后封锁 `module` 加载器与 `process.binding/getBuiltinModule`，并删除全局
  `fetch/WebSocket/EventSource/XMLHttpRequest`；`process.send` 在捕获 IPC sender 后从公开句柄移除，
  防止逃逸代码伪造 `done`；
- 生成代码的 vm context 没有 `require/process/fetch/globalThis` 注入；只有声明的 `ctx` 方法和
  受限 console/timer。

> **诚实边界**：`vm` 不是安全边界；A19 探针（2026-10-25）确认 `console.log.constructor` 等路径可达
> worker 进程，但 `require`/全部内置模块被拒、`process.report/chdir` 被 permission model 拒绝、
> 环境变量已剥离（仅 Windows 用户变量，无密钥）。子进程网络由 `subprocessGuard` 在 JS 层关闭，
> **不是内核防火墙**。因此：只运行本流水线生成的代码、不运行未扫描的外部代码；A19 判为
> “适用子集通过”，残余风险保留。`subprocess` 仍是最高风险能力，只允许 sandbox 目录内 Node 脚本。

## 4. 超时、撤销、失败清理、证据

| 规则 | 实现 |
| --- | --- |
| **超时** | `SandboxRunner` wall clock 到点 `SIGKILL` 子进程；等待 exit 后删除目录；返回 `timeout:true`，候选进入 `quarantined` |
| **撤销** | `CodeSkillService.cancel(name,version)` / `cancelAll()` 触发 `AbortController`；runner 杀子进程、清目录；取消**不**隔离候选（不是失败）；HTTP `POST /code-skills/cancel`；面板紧急停止也调用 `cancelAll()` |
| **失败清理** | 子进程 kill；sandbox 目录删除（重试 5 次）；不留在父进程的 body/timer；失败候选 `recordTrial({ok:false})` → `quarantined`，不可晋升；**宿主硬杀遗留的 `run-*` 目录在下次启动时清扫**（`CodeSkillService` 构造，仅匹配 `run-*`） |
| **证据** | 每次 trial 写 `runtime/code-skill-runs/<name>@<version>-<runId>.json`：manifest、权限、params、能力调用表、日志、stdout/stderr、退出码、超时/取消、耗时、限制、result；保留供审阅，不写密钥 |
| **审批** | 本窗口**没有逐动作审批**；生成/试运行由显式 HTTP/命令入口触发一次，之后全部由上述硬规则约束 |
| **晋升** | 只有 `trialled + tests.ok` 能 `promote`；失败/取消/超时不能晋升；`rollback` 精确回退，`retire` 下线 |

## 5. 真实入口

- HTTP：`GET /code-skills`、`POST /code-skills/generate`（`trial:true` 直接试运行）、
  `POST /code-skills/<name>/<version>/trial`、`.../promote`、`.../retire`、
  `POST /code-skills/<name>/run`（只执行当前 promoted 版本）、`POST /code-skills/rollback`、
  `POST /code-skills/cancel`。
- 服务：`ctx.codeSkills`（`src/codeSkills/service.js`）；`ctx.search` 为 Node 搜索入口。
- 配置：`config/agent.json` 的 `agent.codeSkills`；搜索复用 `config/llm.json` 的
  `baseUrl/apiKey`，端点 `https://api.deepseek.com/v1/tools/search`。

## 6. 验证

- `npm run p1:m4:test`：**35/35**（权限集、状态持久化、生成解析、DeepSeek 请求形状/缓存/隐私过滤、
  真实子进程 read_state/chat/search/wait、能力拒绝、超时、撤销、父进程隔离、subprocess、证据、
  晋升/回退、`isDay` 派生、promote/rollback 单 promoted 记录、启动清扫、vm 逃逸回归、
  subprocess 网络/模块守卫、实时入口任务/命令注册；**v2：bounded read_state、真实 sandbox
  move+dig、越界拒绝、容器/暂停屏点击、body-busy、取消中断+释放、攻击仅敌对、HTTP/slotHeld
  租约**；2026-10-25 实跑）。
- 实时入口（2026-10-25）：`!code-skill list|<name>` 与 `code_skill` 任务类型只派发**当前 promoted**
  版本（`runPromoted`），试运行仍只在 HTTP 入口；`mc_step`/`mc_plan` 可达同一入口，取消经
  AbortController 杀子进程。
- 真机（2026-10-25）：manifest raw `fs`/代码 `require`/未晋升 run 均被拒；有限死循环 4s 硬超时
  `SIGKILL` + `quarantined`；运行中 cancel `SIGKILL` 且不隔离；子进程被杀 → `sandbox-exit`，
  宿主硬杀 → 子进程随 IPC 退出、残留目录由启动清扫移除；覆盖内置与 A20 失败隔离/回退/下线见
  [`M4-CLIENT-TESTS.md`](M4-CLIENT-TESTS.md)。
- v2 真机（2026-10-25）：`agent.grass_dig@1.0.3` 用 `body_move`+`body_dig` 把 dirt 1→2（trial）
  与 2→3（实时）；`agent.table_click@1.0.1` 用 `body_use`+两次 `body_click` 在 `CraftingScreen`
  内把 cobblestone 从槽 10→11（trial）与 11→10（实时 `mc_plan`）；见 M4-CLIENT-TESTS §10。
- 并入 `npm run p1:verify`（9 suites → 10 suites，2026-10-23 加 `p1:language:test`）。
