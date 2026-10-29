# coding harness 接口事实（Codex / DeepSeek Harness）

> 为 `P1-PLANNER-PLAN.md` §一第 1 项（"是否用 deepseek harness / codex 做自我规划器"）提供**可核验的接口事实**。
> 本文只记录取证到的东西，不下方案结论；每条都标了证据出处与强度。
>
> 取证时间：2026-10-16。**未修改任何 Codex 或 DSH 配置**（只读）。
>
> 起因：会话里出现过两个待验证说法——
> ① "coding harness 不能注入系统提示词"；② "'DeepSeek harness' 需要先明确具体实现"。
> 下面第 1.1 / 2.2 节分别给出结论。

---

## 证据清单（先看这个，再挑着读）

| 编号 | 证据 | 位置 | 强度 |
| --- | --- | --- | --- |
| E1 | DSH 运行时版本与包清单：**0.2.0-rc.2**，289 个 `@deepseek-ai/*` 包，sharedPackages/pnpm **11.7.0** | `resources/app.asar` → `dsh/desktop-runtime.json` | 一手（随包数据） |
| E2 | DSH 的**插件契约与 agent preset 全文**：`persona` / `system-prompt` / `agent-instructions` / `preset-standard\|ptc\|minimal\|cordis` / `tool-subagent-codex` | `%USERPROFILE%\.dsh\profiles\desktop\cordis.yml` | 一手（本机实际加载） |
| E3 | DSH 的**系统提示词装配契约**（order 表、`{{变量}}`、`complete:true`、`includeHarnessIdentity`） | 包内文档 `@deepseek-ai/dsh-system-prompt/README.md` | 一手（随包文档） |
| E4 | **Codex hooks 兼容桥**：`dsh-hooks-codex` 支持 Codex `hooks.json` 的 5 个事件点 | 包内文档 `@deepseek-ai/dsh-hooks-codex/README.md` | 一手（随包文档） |
| E5 | 本机 Codex 配置：`model_provider` / `wire_api` / `notify` CU 钩子 / MCP / `[plugins]` / `[windows] sandbox` | `%USERPROFILE%\.codex\config.toml` | 一手（本机） |
| E6 | **Codex 的 `base_instructions` 可整段替换**（自写 `models.json` 条目内嵌模板） | `%USERPROFILE%\.codex\models.json` | 一手（本机） |
| E7 | DeepSeek 端点**自定义工具白名单实测矩阵**（A–N 探针） | [`codex-deepseek-工具面调查与切换手册.md`](file:///E:/deepseek%20harness/codex-deepseek-工具面调查与切换手册.md) §4 | 一手（实测探针，附请求形状） |
| E8 | DeepSeek 官方安装脚本把 `tool_mode` 写死 `null` 并维护"必须删除的冲突键"清单 | `E:\deepseek harness\codex-deepseek-setup-en.ps1`（手册 §5 引用行号） | 一手（厂商脚本） |
| E9 | 本会话实际发出的**工具面与 system 节点**（27 个工具，system 节点 1486 tokens） | `%USERPROFILE%\.dsh\storages\session_projcache\sessions\*.json` | 一手（本机运行记录） |
| E10 | P1 相关开源项目的工具面与硬约束（34 工具 / ≤11 秒 / ≤18000 字符 / 自主层唤醒矩阵） | `refs/` 未 clone，见会话记录与各项目 README | 二手（对方 README 自述） |

复现命令（本仓库内，产物落 `.tmp/dsh-facts/`）：

```powershell
node .tmp\extract-dsh-facts.mjs       # asar 文件清单 + 会话文件清单 + zstd 解压
node .tmp\extract-dsh-packages.mjs    # 289 个包清点 + provider 候选
node .tmp\extract-dsh-contracts.mjs   # 随包文档提取（system-prompt / persona / subagent ...）
node .tmp\extract-dsh-providers.mjs   # provider 注册名 + 本会话 system 节点统计
```

---

## 一、Codex 侧接口

### 1.1 先回答待验证说法①："不能注入系统提示词"

**结论：不准确。准确的说法是"能替换整个基础指令块，但换不掉 Codex 这个 agent 框架"。**

证据 E6：`%USERPROFILE%\.codex\models.json` 的每个模型条目都带一整段 `base_instructions`——
即**官方 Codex 系统提示词全文**（"You are Codex, an agent based on GPT-5. ..."），
以及 `instructions_variables`、`supports_search_tool`、`supports_reasoning_summaries` 等一等字段。

| 能做到 | 依据 | 做不到 |
| --- | --- | --- |
| 用自写 `models.json` 条目内嵌自己的 `base_instructions`，把"基于 GPT-5 的 Codex 提示词"整段换成别的（DeepSeek 官方脚本就这么干：内嵌 17,730 字模板） | E6、E8 | 改掉 agent 的**框架身份**：工具信封、`commentary`/`final` 双通道输出约定、`apply_patch` 编辑约束、compaction 行为、审批与沙箱语义 |
| 用 `hooks.json` 在 5 个事件点注入上下文 / 拦截工具与提示 / 强制继续（DSH 侧有桥，Codex 原生也有） | E4 | 让 Codex 变成"我的语言脑区"：它仍按自己的 agent 契约工作（例如它坚持 `apply_patch` 改文件） |
| 通过 `[mcp_servers]` 挂 MCP，把外部工具塞进它的工具面 | E5 | 控制"哪些工具可见"的**具体清单**——那由模型条目的 `tool_mode` 决定（见 1.2） |

**对 P1 的含义**：拿 Codex 当"自我规划器"时，你控制的是**喂给它的任务包 + 它的模型条目**，
控不了它的推理框架；P1 §一要求的"人格底线判断与执行分离"必须在**你这一侧**（任务包与结果校验）实现。

### 1.2 工具面由 `tool_mode` 决定，而 DeepSeek 端点把 code mode 堵死了

证据 E7/E8（探针矩阵 + 厂商脚本）：

| 模式 | `tool_mode` | 工具调用形态 | DeepSeek 端点可用性 |
| --- | --- | --- | --- |
| code mode（内置 `gpt-6-*` / `gpt-5.6-*` 条目） | `code_mode_only` | `custom_tool_call`: `exec` / `js` / `sleep`（同一套工具换信封） | ❌ 注入 `exec` 即 **400**：`Unsupported custom tool: 'exec'. Only 'apply_patch' is supported.` |
| 传统 function tool（DeepSeek 自写目录） | `null` | `function_call`: `exec_command` / `apply_patch` / `write_stdin` | ✅ |

三条决定性探针（F/G/H）：**空定义、空 lark grammar、`format:{type:"text"}` 全部仍 400** ⇒
拒绝发生在**按名字白名单**阶段，不存在"用空语法禁用工具"的绕过方案。

### 1.3 配置面（`~/.codex/config.toml`，本机实测）

| 键 | 本机当前值 | 说明 |
| --- | --- | --- |
| `model_provider` / `model` | `lmu_ai` / `gpt-5.5` | 当前处于中转站模式；`gpt-5.5` 是内置条目里**唯一** `tool_mode=null` 的 |
| `[model_providers.*]` | `base_url` + `wire_api="responses"` + `requires_openai_auth` | 换供应商即换工具面与 CU 可用性 |
| `model_reasoning_effort` | `high` | 端点接受 `low/high/max`；官方脚本拒绝 `xhigh` |
| `notify` | 指向 `codex-computer-use.exe` | 计算机使用钩子（`turn-ended`） |
| `[mcp_servers.node_repl]` | `node_repl.exe` + 15 个环境变量 | 浏览器 / CU 的服务通道 |
| `[plugins.*]` | 10 个（含 `computer-use` / `browser` / 办公四件套） | 插件市场来自两个本地 marketplace |
| `[windows] sandbox` | `elevated` | Windows 侧沙箱模式 |

**已核实的机制（手册 §9.5）**：`[mcp_servers.cua_repl]` 由 **app 按 provider 动态改写**——
lmu_ai 下是真定义（82 工具），deepseek 下被写成占位符（41 工具）。
所以"手工把真定义写回 config.toml"会在下次 provider 感知的改写中被覆盖，**这不是配置层能解决的问题**。

---

## 二、DeepSeek Harness（DSH）侧接口

### 2.1 它是什么（回答待验证说法②）

**DSH 是一个 Cordis 插件运行时 + agent loop 的 coding harness。**
本机桌面端内置运行时 **0.2.0-rc.2**（E1），随包 **289 个 `@deepseek-ai/*` 包**；
profile 由 `cordis.yml` 声明要加载哪些插件，`cordis.patch.yml` 是用户覆盖层（E2）。

```
DSH (Electron 桌面端 / dsh CLI)
└─ profile: web | desktop | headless | diag | cucheck      ← 每个 profile 一套插件与凭据
   ├─ cordis.yml            加载清单（profile 生成，声明每个插件的 id/name/config/disabled/inject）
   ├─ cordis.patch.yml      用户覆盖层（按 id 覆盖 config / 增删插件，`!!js` 表达式可用）
   └─ package.json          dsh.profile.bundles = ["@deepseek-ai/dsh-base", ..., "dsh-ops", ...]
```

### 2.2 系统提示词：**插件可以完全接管**

证据 E3（`dsh-system-prompt` 随包文档）。order 表：

| order | 内容 | 归属 |
| --- | --- | --- |
| −1000 | 固定开场白 `You are an AI agent powered by DeepSeek Harness.` | 一等公民；`includeHarnessIdentity:false` 可去掉（**仅在"兼容部署要独占整个提示词"时**） |
| 0 | `personaPrefix`（部署人设前缀） | 配置 / 插件 |
| 中段 | 一等公民指引（含**自动生成的 tools SDK 文档**）、`dsh-skill` 的 skills 目录 | 一等公民 + 插件 |
| 10000 | harness 源码位置 | 一等公民 |
| 10100 | Web surface | 一等公民 |
| 10200 | `personaSuffix` | 配置 / 插件 |
| 任意有限 order | `ctx.systemPrompt.section({ name, order, text, interpolate, complete })` | **任意插件** |

三条对 P1 直接有用的机制：

1. **`complete: true` 的 section 会成为"唯一且完整"的系统提示词**（多个 complete 会让装配失败）；
2. 文本支持 `{{model}}` / `{{cwd}}` 等变量插值，`interpolate:false` 可保留字面量（生成工具文档时需要）；
3. **本机现有 profile 已经在用这条**：`cordis.patch.yml` 把
   `personaPrefix` 设成 `You are a coding agent powered by the {{model}} model.`、`personaSuffix` 设成
   `Your working directory is {{cwd}}.`——系统提示词是**配置项**，不是写死的常量。

**业界口径差异（值得写进 P1 结论）**：Codex 里改系统提示词 = **替换整个 base_instructions 文本块**（E6）；
DSH 里 = **按 order 组合 section，或用一个 `complete:true` section 独占**（E3）。
两者都"能改"，但 DSH 是**结构化装配**（插件可各自贡献一段、可插值、可作用域覆盖），Codex 是**单块替换**。

> ⚠️ 文档同时写明一条限制：**"deployment-authored prompt text is config/composition only——
> 没有面向最终用户的提示词编辑 API"**。即：改提示词要走 profile 插件/配置，不是运行时 API。

### 2.3 agent preset：能力面是"预设 × 插件组合"（本机 4 个 preset）

证据 E2：

| preset | 定位 | 工具面差异（相对 standard） |
| --- | --- | --- |
| `standard`（默认） | 通用编码 agent | bash/pwsh · fs · fs_search · jobs · skill · todo · goal · plan-mode · subagent(+fork) · workflow · ralph(关) · web · present · 委派组 |
| `ptc` | Programmatic Tool Calling | 同 standard，但加 `dsh-agent-tool-presentation`（`mode: ptc`） |
| `minimal` | 纯 shell / 无工具治理 | **只有持久 shell**（`persistent-bash` / `persistent-pwsh`，超时 300s），`includeRuntimeContext:false`，`complete:true` 独占提示词 |
| `cordis` | 插件开发 | 多 `tool-cordis`（宿主/自省）、内置 `skills/` 目录、其余同 standard |

**给 MC agent 用的现成接法**：`whale_craft` 那类插件就是**自带一个 preset**（README 里叫"MC 模式 / MC+ 模式"），
用 preset 把"游戏工具 + 收窄的文件边界"打包，而不是去改 standard。

### 2.4 关键插件契约（挑 P1 用得上的）

| 包 | 作用 | 对 P1 的价值 |
| --- | --- | --- |
| `dsh-persona` | `prefix` / `suffix` / `complete` / `includeRuntimeContext` | 语言脑区人设 |
| `dsh-agent-instructions` | 注入 `AGENTS.md`（`maxBytes: 65536`） | **工作区级指令注入**——注意 `whale_craft` 刻意把行事准则取名 `RULES.md` 以避开它 |
| `dsh-skill` + `dsh-skill-filesystem` | skills 目录、`SKILL.md`、`customSkillDirs` | 自主学习产出的"技能"可落成 SKILL.md |
| `dsh-mcp-client` / `dsh-mcp-resources` | MCP 客户端 + resources | **把外部 MC 身体（MCP server）接进 harness 的正门** |
| `dsh-hooks-codex` | 跑 Codex `hooks.json` 的 5 个事件点（SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop） | 提示与工具的**门禁与上下文注入**，且可复用现有 Codex 配置 |
| `dsh-hooks-claude-code` | 同上，Claude Code 方言 | 同上 |
| `dsh-tool-subagent` | 把某个 provider 暴露成一个静态工具行（`toolName` / `backgroundMode` / `maxDepth`） | 规划器可作为 `subagent` 被调用 |
| `dsh-subagent-spawn-in-process` / `-fork-in-process` | 仅有的**随包 provider**：`spawn` / `fork` | 见 2.5 |
| `dsh-tool-call-timeout-policy` · `dsh-spill-policy`（`maxInlineTokens:12500`）· `dsh-compaction-tool-result-pruner`（8192/4096/1024） | 超时、溢出落盘、结果裁剪 | 与"34 工具 / ≤18000 字符描述预算"是同一类工程约束 |

### 2.5 待验证点：`provider: "codex"` 与 `provider: "claude-code"`

`cordis.yml` 的 preset 里确实写了两行（默认 `disabled`）：

```yaml
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed
- id: tool-subagent-claude-code
  config: { provider: claude-code, toolName: subagent_claude_code, ... }
```

**但随包的 provider 实现只有 in-process 两种**（E2/E1 清点：`dsh-subagent-spawn-in-process`、
`dsh-subagent-fork-in-process`、`dsh-subagent-in-process-driver`；`dsh-subagent` 的 provider 注册器是开放的）。

⇒ **结论：这是 DSH 为"外部 coding agent 当子代理"预留的接口，但 provider 实现不在这个包里**，
本机 `disabled: true`，且本机 `.dsh` 下没有任何地方启用它。
**要用必须先确认 provider 从哪来（云端？企业包？还是需要自己实现 `registerProvider`）——这是待验证项。**

### 2.6 2026-10-17 裁决（P1 采用，只列与本文接口判断直接相关的）

| 事项 | 裁决 | 对本文的影响 |
| --- | --- | --- |
| 接入路线 | **先接 DSH**，Codex 备选；只有 P1 §1.9.2 判定成立才做 A/B | 本文的"两侧对照"降为参考，不再驱动路线选择 |
| 模型 | 两个接入模型均为 **deepseek-flash（DeepSeek V4.1 Flash）** | 端点/模型兼容的验证按此固定 |
| 用量 | **不做代码级 token 限制**；监控动作脑用量、停机后复盘 | §7 不得写成"每请求上限"，A30 已改写 |
| CU | **复用现有 `dsh-computer-use` 插件**、限游戏窗口；做不到则放弃 CU（历史，2026-10-29 已被取代：改进程内输入层） | 新增可行性闸门 F1（§五 #8） |
| 动作脑工具面 | 关 bash/pwsh；fs 只读工作区 + 写 `agent-data/`；web 只经 Node 检索代理；游戏动作全来自 Node | `standard` preset 不能直接用，需单开 preset |

> 2026-10-29：CU 路径已放弃（ABANDONED），M5 改用进程内输入层（[`P1-M5.md`](P1-M5.md) §7）。
> 上表 CU 行与 §2.7 第 3 条保留为 2026-10-17 的裁决与未证实项记录，不再是 M5 的交付路径。

### 2.7 尚未证明、但裁决已默认成立的三件事

1. **`agent/turn-stopping` + `steer()` 对第三方插件开放**——随包文档里它是第一方 hook 桥的用法；
   第三方插件能否拿到同一扩展点，**未验证**（§五 #6）。
2. **per-turn usage 可取**——DSH 有 token-meter 插件，但"每个模型请求的 usage 是否可归到我们的 turn"未验证（§五 #7）。
3. **`dsh-computer-use` 能否把操作/截图限制到游戏窗口**——它的既有能力是桌面级；限窗是否可配置未验证（§五 #8）。

> 这三条任一为否，就落进 P1 §1.9.2 的降级判定（#1 判"接口不稳定"，#2 判"预算边界不满足"），
> 而不是靠"约定"绕过去。

---

## 三、把两侧放在一张表里（P1 决策要用的那几行）

| 维度 | Codex | DeepSeek Harness |
| --- | --- | --- |
| 形态 | 桌面端 + `codex.exe` core（本机 core `0.162.0-alpha.17.2`） | Cordis 插件运行时 + agent loop（本机 `0.2.0-rc.2`，289 包） |
| 扩展方式 | `config.toml` / `models.json` / `hooks.json` / `[mcp_servers]` / `[plugins]`（市场） | profile `cordis.yml` + `cordis.patch.yml` + npm 插件（`dsh.bundle.patch`） |
| 系统提示词 | 单块 `base_instructions`（自写目录条目可整段替换） | 分 section 装配（order −1000…10200 + 任意插件 section；`complete:true` 可独占） |
| 工具面 | 由模型条目 `tool_mode` 决定工具**信封**；MCP 可加工具 | 由 preset 的插件组合决定；插件注册工具；MCP 客户端可加工具 |
| 门禁/钩子 | `hooks.json` 10 个事件（DSH 桥支持其中 5 个） | 原生扩展点：`agent/pre-step`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping` |
| 子代理 | 自身是 Codex；DSH 侧有 `subagent_codex` 通道（**未发货**） | `spawn`（新上下文）/ `fork`（继承上下文）/ workflow / ralph(≤64 轮) |
| 与 MC agent 对接的现成路径 | MCP 客户端（`mcp-mc-agent` 那类 server） | 装 `whale_craft` 类插件（自带 preset + 工具面 + 唤醒）；或自写插件持 `ctx.tools` |
| 主要未知 | Codex 能否作为**被调用方**稳定跑在无人值守的循环里（本机无此用法证据） | `codex`/`claude-code` provider 的实现来源；`steer`/唤醒在无人值守下的实际语义 |

---

## 四、这份文档修正了什么

1. **"不能注入系统提示词" → 修正为**：Codex 可整段替换 `base_instructions`（本机已有 17,730 字内嵌模板的实例），
   DSH 可按 section 装配甚至用一个 `complete:true` section 独占。
   **真正做不到的是"换掉 harness 的 agent 框架契约"**（工具信封、双通道输出、`apply_patch` 约束、compaction）。
2. **"DeepSeek harness 需要先明确具体实现" → 已明确**：Cordis 插件运行时，插件清单见 `cordis.yml`，
   系统提示词与工具面都是**配置驱动**的，profile 层可用 `cordis.patch.yml` 覆盖（本机已在用）。
3. **新增一个此前没进 P1 视野的选项**：DSH **原生带 subagent 通道**（`spawn`/`fork` 已发货，
   `codex`/`claude-code` 预留未发货）。如果 P1 要走"coding harness 当规划器"，
   这里存在"作为 DSH 子代理"与"独立进程 + MCP"两种落法，而**前者的 provider 来源尚未确认**。

## 五、下一步（验证成本从低到高）

| # | 验证项 | 做法 | 成本 |
| --- | --- | --- | --- |
| 1 | DSH 插件持有工具面到底怎么写 | 读 `@deepseek-ai/dsh-tools` 随包文档 + `dsh-plugin-manager` | 低（纯读） |
| 2 | `codex` provider 是否可启用 | 在**独立 profile**里把 `tool-subagent-codex` 的 `disabled` 改 false，看启动报错是否点名缺 provider | 低（不动主 profile） |
| 3 | MC 工具面接进 DSH 的实感 | 装 `whale_craft`（它自带 preset），跑一句 "obtain an iron pickaxe" | 中（要重启 DSH + 一个 MC 账号） |
| 4 | 无人值守下的唤醒语义 | 用 `dsh-agent-instructions` + `hooks` 组合做一次"事件推模型"的端到端 | 中 |
| 5 | Codex 当被调用方 | 用 `codex exec` 非交互模式跑"给状态 → 出计划"的最小子集 | 中（官方文档此前取不到，需以实测为准） |
| 6 | `agent/turn-stopping` + `steer()` 对第三方插件是否开放 | 写一个最小插件挂监听并在异步任务完成时 `steer()`，观察是否续轮 | 低-中（决定 Q0 的接口稳定性判定） |
| 7 | per-turn usage 是否可归到我们的 turn | 在插件侧读 usage，与供应商侧计量对账 | 中（决定 Q0 的预算边界判定） |
| 8 | `dsh-computer-use` 能否限游戏窗口 | 独立 profile 里验证操作/截图范围，F1 闸门 | 中（不通过则放弃 CU；历史，2026-10-29 已被取代：F1 作废、改 F1'） |

> 2026-10-29：CU 路径已放弃（ABANDONED），M5 改用进程内输入层（[`P1-M5.md`](P1-M5.md) §7）。
> 故上表 #8 不再是 M5 的前置项（F1 已作废，改 F1'），保留为"将来做游戏外桌面自动化"时的验证项。

---

## 附：本文档未做的事

- **未修改**任何 `~/.codex/*` 与 `~/.dsh/profiles/*` 配置（取证全为只读）。
- 未逐包通读 289 个 `@deepseek-ai` 包，只读了与"提示词 / 工具 / 子代理 / 钩子 / MCP"直接相关的 11 份随包文档。
- 未验证 `codex` / `claude-code` provider 的可用性（见 §2.5、§五 #2）。
- 未验证第三方插件对 `agent/turn-stopping` / `steer()` 的可用性、per-turn usage 可归属性、`dsh-computer-use` 的限窗能力（见 §2.7、§五 #6–#8）。
- 开源 MC agent 项目的工具面数字（34 工具 / ≤11 秒 / ≤18000 字符）来自对方 README 自述（E10），未 clone 复核。
