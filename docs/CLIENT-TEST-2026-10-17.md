# 客户端窗口实测记录（2026-10-17）

> 用户批准客户端测试后的第一次真机窗口。**没有修改服务器端配置**；所有结果按实际输出记录，
> 包括失败项。原始日志在 `runtime/logs/`（gitignored）。
> 本记录只覆盖本次实际执行的项；其余仍为「未执行」，见
> [`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md)。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 时间 | 2026-10-17 08:48–09:02（本地） |
| 客户端 | Forge 1.20.1-47.4.10，Java 21.0.7（Zulu? 运行时目录），Mod `agent-client dev` |
| 服务器 | `mc.example.com:25565`（AuthMe） |
| 账号 | `AgentDeepSeek`（离线认证；年龄/库存未记录） |
| 客户端日志 | `runtime/logs/forge-client-2026-10-17_08-48-51.log`（首次）/ `..._08-57-54.log`（复测） |
| Node | v24.19.0 |

## 2. 结果总览

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 模组协议（`client:verify`） | **23/23 PASS** | `runtime/logs/client-verify-2026-10-17.log` |
| 登录 + 谨慎寻路（`client-real --login`） | **7/7 PASS**；服务器确认 `Вход успешен` | `runtime/logs/client-real-login-2026-10-17.log` |
| 采集原语（`--primitives --dig dirt:4,stone:4`） | **9/10**：砍树 PASS，**挖石 FAIL** | `runtime/logs/client-real-primitives-2026-10-17.log` |
| `/state` 空闲耗时 | p50 **43.8ms**、p95 **64.9ms**、max 81.5ms（30 次） | `runtime/logs/state-idle-2026-10-17.json` |
| Agent 自动 AuthMe 登录（修复后） | **PASS**：`logging in (startup, attempt 1)` → `logged in` → 服务器 `Вход успешен` | `runtime/logs/agent-authme-final-2026-10-17.log` |
| A01 面板 `!` 命令（`status`） | PASS：3ms 返回；`/llm` tokens **0 → 0**；非法 `mine` 返回 usage | 本记录（未单独落盘） |
| F1 CU 限窗 | **未执行**：Computer Use 已启用但无已授权应用，读取 Java 窗口被拒 | 本记录 |

## 3. 登录 / AuthMe

- 新会话进入服务器后，聊天出现 AuthMe 俄文提示与
  `§cКоманды недоступны до входа! Сначала §e/login§c или §e/register§c.`
- 第一次启动 Agent（09:00:48）**没有登录**，日志为
  `authentication: no evidence of being logged out (no prompt or refusal seen) - assuming the session is already valid`。
  原因：启动探针在 `ChatListener` 首轮播种之前发出，服务器拒绝被首轮基线吞掉。
- 修复（提交见 git log）：探针先等首轮播种（`probeDelayMs` 1800ms），再发 `cmd list`；
  并以 250ms 轮询等待证据（`probeWaitMs` 4000ms），不再固定睡 1200ms。
- 复测（09:01:56）：`logging in (startup, attempt 1) as configured` → `logged in` →
  聊天 `§aВход успешен!` / `§aДобро пожаловать!`。**未发送 `/register`。**
- 离线回归新增一条同类延迟拒绝用例：`authme: a late refusal still triggers a login`。

## 4. 采集原语

```
PASS  primitive 1 walk：moveTo 完成，位置实际变化
PASS  primitive 2+3 chop：破坏 2 个原木，库存 +2
FAIL  dig stone：32 个 stone/cobblestone 目标全部 noPath，库存 +0
```

- 砍树目标为自然橡树，脚本拒绝人造目标/农田，行为符合安全策略。
- 挖石失败日志：`mine: 32 targets in a row were unreachable`、
  `could not reach or break any of 32 stone/cobblestone target(s) (noPath)`；
  `runtime/path-trace.jsonl` 当时累计 8291 条。
- 这是**真实的 P0 真机验收失败**，不是“未测”。可能原因（未证实）：目标位于建筑/平台下方、
  当前站位无法到达、或路径规划在该地形上失效；需要下一次窗口用更明确的矿点/站位复现并抓取
  `path-trace` 中对应的 noPath 记录。未做代码修改。

## 5. 性能（仅空闲）

`/state` 30 次采样（间隔 200ms，静止，无界面，鼠标已捕获）：

| 指标 | 值 |
| --- | --- |
| p50 / p95 / max | 43.8 / 64.9 / 81.5 ms |
| 响应体 | 1,792,352 bytes |
| 方块扫描 | 63,257 cells |
| 玩家数 | 0（服务器当时无其他玩家） |

移动/挖矿/反射/GUI 四种负载**未测**；因此不能据此回填 P1 §1.5 的周期阈值。

## 6. F1 / Computer Use

- `computer_use_status`：helper 运行中、WGC 截图可用、桌面会话正常；
  **已授权应用：无**。
- 尝试读取 Minecraft（java）窗口：`未授权 Computer Use 使用「java」（java.exe）`。
- 没有用其他方式（PowerShell/SendKeys）绕过授权；**本轮没有执行任何 GUI 自动化**。
- F1 仍未验证；CU 部分继续保持默认拒绝（`cu-unproven`）。

## 7. 结论与下一步

**已验证**：模组协议、AuthMe 登录（含 Agent 自动登录修复）、谨慎寻路、砍树采集、
`!` 面板命令与零模型调用、`/state` 空闲成本。

**未通过/未验证**：挖石路径（真实失败）、移动/挖矿/反射/GUI 下的 `/state`、F1 CU 限窗、
A02 之后的模型/多人/重启项。

下一步建议：
1. 复现挖石失败：指定一个地表裸露矿点或下挖入口，记录起始坐标与 `path-trace` 的 noPath 原因。
2. F1：在 DSH 里显式授权 Minecraft/java 窗口后再测；未授权前不做 GUI 自动化。
3. 继续 A17/A29（持久化重启）与 A02（真实模型闸门）需要模型端点与操作员在场。
