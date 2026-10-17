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
| 采集原语（`--primitives --dig dirt:4,stone:4`） | **首次 9/10**：砍树 PASS，**挖石 FAIL**；复测被**死亡/空背包/界面打开**打断，结论待复验 | `runtime/logs/client-real-primitives-2026-10-17.log`、`client-real-stone-retest-2026-10-17.log`、`client-real-dirt-stone-retest-2026-10-17.log` |
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

## 4. 采集原语（含一次无效复测）

### 4.1 首次运行（08:56）

```
PASS  primitive 1 walk：moveTo 完成，位置实际变化
PASS  primitive 2+3 chop：破坏 2 个原木，库存 +2
FAIL  dig stone：32 个 stone/cobblestone 目标全部 noPath，库存 +0
```

- 砍树目标为自然橡树，脚本拒绝人造目标/农田，行为符合安全策略。
- 挖石失败日志：`mine: 32 targets in a row were unreachable`、
  `could not reach or break any of 32 stone/cobblestone target(s) (noPath)`。
- 离线复查发现两个真实缺陷：
  1. `probeShaft()` 读的是**脚所在格**（空气），从不挖脚下方块，所以“探井”从未开始；
  2. 埋藏石头被当成可走目标，`moveTo(range:1)` 永远到不了，形成 32 次 noPath。
- 同时发现测试计数错误：石头掉落 `cobblestone`，脚本只数 `stone`，即使挖到也会显示 +0。
- 已修：`probeShaft` 挖 `y-1`；只有**暴露面**算可走目标；暴露目标在 4 格内允许“不走路直接挖”；
  `--dig stone` 按 `stone + cobblestone` 计数。离线 `tasks-test 52/52`、`selftest 177/177`。

### 4.2 复测（09:07–09:10，**结果无效**）

- 客户端重新进入后登录成功；`--dig dirt:2,stone:2` 的 **dirt 通过**（2/2，库存 +2）。
- 随后 `dig stone` 仍然 32 noPath；复查 `/state` 发现：**玩家已死亡、界面打开、背包清空**
  （之前挖到的 dirt/cobble 全没了，砍树计数出现 `+-24`）。
- 因此这次 noPath 不能归因于路径器：死亡界面会吞掉所有移动键，且没有镐时石头任务本来就会拒绝。
- 已在 `client-real.js` 增加前检：`screenOpen` 时**在改变世界前中止**，并明确写“结果无效”，
  不再把环境问题报成路径失败。
- 复测需要：存活、无界面、背包里有镐、位置附近有可暴露的石头。

**当前结论：挖石仍未被真机证明通过；首次失败可能是路径器/目标选择，也可能是死亡界面，
两者都已有针对性修复，等待一次干净环境的复验。**

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

**未通过/未验证**：挖石（首次 FAIL，复测无效）、移动/挖矿/反射/GUI 下的 `/state`、
F1 CU 限窗、A02 之后的模型/多人/重启项。

下一步建议：
1. **干净环境复验挖石**：确认存活、无界面、背包有镐；用 `--dig stone:2` 单独跑，
   抓 `probe shaft`/`picked up`/`path-trace` 三类证据，再判定修复是否生效。
2. F1：在 DSH 里显式授权 Minecraft/java 窗口后再测；未授权前不做 GUI 自动化。
3. 继续 A17/A29（持久化重启）与 A02（真实模型闸门）需要模型端点与操作员在场。
