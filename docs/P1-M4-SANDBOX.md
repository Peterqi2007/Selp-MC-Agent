# P1 M4 沙箱与授权规则（2026-10-18 窗口）

> 本文件是本次 M4 接线的**执行前规则**，先于代码落地。操作员授权：
> 真实生成代码可写入候选、可在受限进程中真实试运行；**保留沙箱限制、取消逐动作审批**。
> 权限边界：`read_state / submit_task / chat / wait / search / generate / subprocess`；
> 搜索经 Node 使用 DeepSeek Search；超时、撤销、失败清理、证据保留规则由本文件确定。

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
| `subprocess` | 父进程启动 `node <sandbox>/sub-*.js` | 无 shell；只允许 sandbox 目录内脚本；10s 硬超时；stdout/stderr 各 ≤16KB；同样 `--permission` 只读 sandbox；不继承密钥环境 |

**全部 run 的硬限制**：默认 30s（上限 60s）；最多 100 次能力调用；结果/日志各 32KB；内存 `--max-old-space-size=128`；sandbox 目录一次性、结束后删除。

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

> **诚实边界**：`vm` 不是安全边界；本实现用“静态扫描 + 子进程 permission model + worker 模块/全局
> 封锁 + 父进程 RPC 白名单”做纵深，但 Node permission model 不提供 OS 级网络隔离，vm 逃逸仍可能
> 拿到 `process`。因此：只运行本流水线生成的代码、不运行未扫描的外部代码；A19 的“阻止未授权宿主
> 访问”在真机验收前仍保留残余风险说明。`subprocess` 是最高风险能力，默认只允许 Node 脚本且只在
> sandbox 目录内。

## 4. 超时、撤销、失败清理、证据

| 规则 | 实现 |
| --- | --- |
| **超时** | `SandboxRunner` wall clock 到点 `SIGKILL` 子进程；等待 exit 后删除目录；返回 `timeout:true`，候选进入 `quarantined` |
| **撤销** | `CodeSkillService.cancel(name,version)` / `cancelAll()` 触发 `AbortController`；runner 杀子进程、清目录；取消**不**隔离候选（不是失败）；HTTP `POST /code-skills/cancel`；面板紧急停止也调用 `cancelAll()` |
| **失败清理** | 子进程 kill；sandbox 目录删除（重试 5 次）；不留在父进程的 body/timer；失败候选 `recordTrial({ok:false})` → `quarantined`，不可晋升 |
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

- `npm run p1:m4:test`：**15/15**（权限集、状态持久化、生成解析、DeepSeek 请求形状/缓存/隐私过滤、
  真实子进程 read_state/chat/search/wait、能力拒绝、超时、撤销、父进程隔离、subprocess、证据、
  晋升/回退；2026-10-22 实跑）。
- 并入 `npm run p1:verify`（8 suites → 9 suites）。
