# 客户端窗口实测记录（2026-10-17）

> 用户批准客户端测试后的第一次真机窗口。**没有修改服务器端配置**；所有结果按实际输出记录，
> 包括失败项。原始日志在 `runtime/logs/`（gitignored）。
> **2026-10-30 后注：本文 §7 的 F1 / Computer Use 路径已放弃（ABANDONED）**，只作历史证据保留；
> M5 改用进程内输入层（[`CU-ABANDONED.md`](CU-ABANDONED.md)、[`P1-M5.md`](P1-M5.md) §7）。
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
| 采集原语（`--primitives --dig dirt:4,stone:4`） | **首次 9/10**：砍树 PASS；`--dig stone` 前置检查在无石点位 FAIL；**独立 `mine` 任务 2/2 PASS（库存 +2）** | `runtime/logs/client-real-primitives-2026-10-17.log`、`client-real-mine-check-2026-10-17.log` |
| 独立 `mine` 任务 | **PASS**：`collected 2/2 stone/cobblestone`，库存 +2 | `client-real-mine-check-2026-10-17.log` |
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

### 4.4 自然地表与独立 mine（09:24–09:28）

- 09:24 在自然草地（68,63,61）复测：`probe shaft` 挖掉脚下方块（`grass_block`），下一格就是
  `air`，没有石层；`--dig stone` 仍失败。说明该点位的石头在别处，且“先挖石再逛”顺序不利。
- 09:28 单独跑采集原语（`--chop-count 0`）末尾的 `MineBlockTask`：
  `mine: picked up 1 (1/2)`、`picked up 1 (2/2)`，**`collected 2/2 stone/cobblestone`，库存 +2**。
- 该检查原先只断言“任务跑过”；已改为断言**库存实际增加**，这次通过。
- 结论：**石头采集（带镐）真机通过**；`--dig stone` 的前置检查在无石点位失败是测试顺序/选址问题，
  不是采集能力缺失。后续可把 `--dig` 放到 roam/chop 之后，或先把角色带到裸露石层再跑。

**当前结论：砍树（首次 2 原木）与石头（2/2，库存 +2）均已在真机通过；`--dig stone` 这一条
前置检查仍会因点位/顺序失败，需要在脚本里调整顺序或明确选址。**

### 4.5 调整顺序后的复测（09:31，土壤柱）

- 已把 `--dig` 放到 roam/chop 之后；本次点位 (62,65,32) 下方是 **grass → dirt ×3**，
  `probeShaft` 挖到 y=61 仍未见到石头，`--dig stone` 与末尾 `mine` 都是 32 noPath、库存 +0；
  同一次 chop 也失败（附近没有可达自然树）。
- 这证明采集结果**强依赖站位下方的地质**：一次 2/2 不能当作稳定通过，厚土柱/建筑屋顶点位
  都会失败。`--dig` 顺序调整是必要的但不足以消除选址问题。
- M0-C2 仍只能算**部分通过**：需要固定一个“有裸露石层”的测试点，或在任务里支持更深/阶梯式
  下挖（后者会改变 P0 行为，需单独评估）。

### 4.3 干净背包复测（09:17，仍无效）

- 背包恢复（2 把 `iron_pickaxe`）、无界面、白天；`--dig stone:2` 仍报 32 noPath。
- 日志显示 `probe shaft` 已触发，但玩家站在**建筑屋顶**（y≈71），下方是空气/房间，
  `probeShaft` 没有可挖的自然石层；目标仍是远处埋藏石头，`moveTo` 到不了。
- 这不是对修复的否证，而是**测试地点不对**：需要在自然地表/裸露石层附近复测。
- 同日夜晚门禁测试还发现当前位置到床不可达（见 §6），因此下一步应先移动到自然区域。

## 5. 性能（仅空闲）

`/state` 30 次采样（间隔 200ms，静止，无界面，鼠标已捕获）：

| 指标 | 值 |
| --- | --- |
| p50 / p95 / max | 43.8 / 64.9 / 81.5 ms |
| 响应体 | 1,792,352 bytes |
| 方块扫描 | 63,257 cells |
| 玩家数 | 0（服务器当时无其他玩家） |

移动/挖矿/反射/GUI 四种负载**未测**；因此不能据此回填 P1 §1.5 的周期阈值。

## 6. 夜间安全（2026-10-17 新增）

- 规则：**夜里必须睡觉**；睡觉不是验收项，只是避免在黑暗中继续测试。
- `scripts/client-real.js` 在“谨慎寻路”和“P0 采集原语”前调用 `ensureDaytime()`：
  1. 读快照时间（`timeOfDay`/`isDay`），白天直接继续；
  2. 夜里在 **60×10×60**（水平 ±30、垂直 ±5）内找 `*_bed`，选最近的，走过去并 `useOn`；
  3. 最多等 120 秒到天亮；
  4. **没有床 / 走不到 / 等不到天亮 → 中止测试**，不会“摸黑继续”。
- 运行 Agent 时同样适用：夜里用面板 `!sleep`（或游戏内 `!sleep`），确认天亮再继续；
  无人值守的 Agent 运行窗口应保持 `planner.mode` 为受控值，避免夜间自行跑远。
- 该门禁不改变验收结论；它只保证测试安全。
- **实测（2026-10-17 09:20）**：`timeOfDay=12774` 时运行 `client-real --no-login --walk 3`，
  门禁触发：找到 `minecraft:white_bed` at (89,70,63)，`moveTo` 无法到达（当前位置 67,63,61），
  随即**中止测试**并报 `no usable bed - aborted`，没有执行任何夜间寻路/挖掘。
  手动带到床边也失败；没有 `/spawn` 可用。
- **09:24 修正**：快照 `timeOfDay=13233` 时 `isDay=true`（服务器时区偏移），旧门禁把白天
  误判为夜晚。已抽出 `src/world/daytime.js`：**优先信 `isDay`**，缺失时才回退 `timeOfDay`；
  睡眠技能与测试脚本共用。修复后 09:24 的白天测试正常进行。
- 结论：**安全门禁生效（夜里会停），但真正的夜间睡眠尚未成功**；需要床可达时重试。

## 7. F1 / Computer Use
- `computer_use_status`：helper 运行中、WGC 截图可用、桌面会话正常；
  **已授权应用：无**。
- 尝试读取 Minecraft（java）窗口：`未授权 Computer Use 使用「java」（java.exe）`。
- 没有用其他方式（PowerShell/SendKeys）绕过授权；**本轮没有执行任何 GUI 自动化**。
- F1 仍未验证；CU 部分继续保持默认拒绝（`cu-unproven`）。

## 8. 持久化重启（A17/A29 部分，2026-10-17 09:34）

- 临时配置：`state.enabled=true`、`state.path=runtime/p1-state-client.json`、`planner.mode=off`；
  测试后已恢复默认（`enabled=false`、`runtime/p1-state.json`、`planner.mode=legacy`）。
- 第一次启动 Agent 后：`state status` 显示 enabled；执行 `goto 63 61 32` 产生
  `task:done` 事件；`state save` 写出文件。
- 文件内容（`runtime/p1-state-client.json`）：`events.seq=1`，含一条 `task:done`
  （`go-to`、requestId=null、eventId/seq/at 齐全）；`plans/proposals/methods/answers/
  conversation/memoryStore` 均为空结构。
- 停止 Agent 并重启：日志 `state restored: {"plans":true,...,"memoryStore":true}`；
  `state status` 显示 **eventSeq=1**，File 指向同一路径。
- 重启后日志没有自动任务/移动；未观察到“自动恢复动作”。
- **未覆盖**：有内容的对话/待答计划问题/方法/回答/分类记忆、未完成计划的恢复，以及
  “不重放动作”的强验证。A17/A29 只能记为**部分通过**。

## 9. 结论与下一步

**已验证**：模组协议、AuthMe 登录（含 Agent 自动登录修复）、谨慎寻路、砍树采集、
**石头采集（独立 mine 2/2，库存 +2）**、`!` 面板命令与零模型调用、`/state` 空闲成本。

**未通过/未验证**：`--dig stone` 前置检查的点位/顺序、夜间睡眠（床不可达）、
移动/挖矿/反射/GUI 下的 `/state`、F1 CU 限窗、A02 之后的模型/多人/重启项。

下一步建议：
1. **干净环境复验挖石**：确认存活、无界面、背包有镐；用 `--dig stone:2` 单独跑，
   抓 `probe shaft`/`picked up`/`path-trace` 三类证据，再判定修复是否生效。
2. F1：在 DSH 里显式授权 Minecraft/java 窗口后再测；未授权前不做 GUI 自动化。
3. 继续 A17/A29（持久化重启）与 A02（真实模型闸门）需要模型端点与操作员在场。
