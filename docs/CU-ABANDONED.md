# CU 路径已放弃（ABANDONED，2026-10-29）

> 状态：**已放弃（abandoned）**。本文是「为什么放弃 CU、哪些东西还留着、哪些不能再当交付项」的唯一口径。
> 历史实验记录不删不改写，保留在 [`P1-M5.md`](P1-M5.md) §1/§5 与
> [`CLIENT-TEST-2026-10-17.md`](CLIENT-TEST-2026-10-17.md)。

## 1. 结论

P1 的 GUI/键鼠能力**不再走 OS 级 `computer_use`（dsh-computer-use 插件）**，改走
**Minecraft 进程内输入层**：控制 Mod 在游戏进程内合成按键/视角/容器槽位点击并做帧缓冲截图，
经既有 HTTP 通道交给 Node；Node 仍持有唯一身体执行权、键鼠台账与结果验证。

M5 的闸门因此由 **F1**（CU 能否限窗）换成 **F1'**：

| 闸门 | 断言 | 证据方式 |
| --- | --- | --- |
| **F1'a 结构性不可出界** | 输入/截图只走游戏内 API 与本进程帧缓冲；仓库内不出现 `SendInput`/`keybd_event`/`mouse_event`/`BitBlt`/`PrintWindow` | 契约测试字符串断言 + 代码评审 |
| **F1'b 键鼠台账** | 任意时刻按下集合可枚举；暂停/死亡/断连/急停/取消/任务结束/进程退出全部强制释放；单次长按有上限 | `InputLedger` 契约测试 + 真机故障注入 |

**F1' 不通过则实现不得合并，没有「标 N/A 放弃」的出口。**

## 2. 为什么放弃（两项都不可控）

| 阻断点 | 事实 | 我们能改吗 |
| --- | --- | --- |
| WGC 取不到 OpenGL 窗口帧 | 全屏 429×270 / 窗口化 696×417，两轮均 `截图未产出` + `Declared image type does not match its bytes` | 否（helper 侧，日志不可得） |
| 策略接不进真机 | `WindowPolicy`/`ComputerUseGuard` 在 `src/` 内只被自己引用；打包插件 `resources/app.asar` 只读 | 否 |
| 真机只读口径分裂 | 已授权应用为空时 `computer_use_state` 仍被放行（P1-M5 §5.5） | 否 |

继续投入只会重复得到同一个失败，因此 2026-10-29 由操作员口径改为进程内输入层。

## 3. 还留着什么（只作历史证据，不是交付路径）

| 资产 | 位置 | 处置 |
| --- | --- | --- |
| 窗口策略/Guard/前置门/rect 来源 | `src/computer/{windowPolicy,guard,preflight,windowRect}.js` | **保留**，文件头标 `ABANDONED`；只在「将来做游戏外桌面自动化（启动器/登录/其他程序）」时重新评估，前提仍是 F1 |
| CU 契约测试 | `scripts/p1-contract-test.js` 第 38/42 组、`scripts/plan-audit.js` CU 检查 | **保留**，作为历史契约看门；不代表当前交付路径 |
| CU 真机记录 | `docs/P1-M5.md` §1/§5、`docs/CLIENT-TEST-2026-10-17.md` | **保留原文**，不得删除或改写 |
| DSH CU 对话级 Full Access Ask 预设 | `docs/DSH-HARNESS.md` | **不再使用**；M5 的限窗由 F1'a 结构性保证 |

## 4. 现在 M5 看什么（以 P1-M5 为准）

- 输入层实现与真机证据：[`P1-M5.md`](P1-M5.md) §8；
- A21 GUI 真机证据：[`P1-M5.md`](P1-M5.md) §8.5；
- 面朝方向/目标感知：[`P1-M5.md`](P1-M5.md) §10；
- 截图策略与 steer：[`P1-M5.md`](P1-M5.md) §11；
- 客户端项状态：[`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md) 的 A21/A22/F1' 行；
- 阶段判定：[`P1-CLIENT-VERIFICATION.md`](P1-CLIENT-VERIFICATION.md) §7。

**当前判定：M5 未通过。** 输入/截图/GUI 链路已实现并真机验证；A21 部分通过（探针直连 mod、未走
agent 技能层），A22、M5.3、F1'b 的暂停/死亡/断连/退出注入未执行。
