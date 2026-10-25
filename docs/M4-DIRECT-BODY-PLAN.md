# M4 直接身体原语代码技能方案（2026-10-25 需求变更）

> **背景**：2026-10-25 操作员明确要求：生成代码技能必须能读 `/state` 世界状态并**直接移动、挖掘、
> 点击**；只调用 `submit_task` 的“编排型”技能不足以支撑完全自主学习。此前 M4 的 A18–A20 真机
> 只证明了编排子集（读状态、提交任务、说话、等待），因此 M4 的 PASS **不能按新需求保留**，
> 阶段按“需求变更”重开，旧证据保留为历史子集。
>
> 本文定义新的能力面、边界与验收；实施顺序见 §8。落地后需要重跑 A18、A19、A20、A28–A30
> 的编码回合，再重新判定 M4。

## 1. 目标：代码技能能直接驱动身体

生成技能在受限沙箱里运行，但通过新增的 **body 原语**直接请求真实的客户端操作：

```js
// 目标形态（示意）
module.exports = {
  async run(ctx, params) {
    const st = await ctx.read_state({ blocks: { radiusXZ: 8, radiusY: 3 } });
    const dirt = await ctx.find_blocks({ names: ['minecraft:dirt'], maxDistance: 6, count: 4 });
    if (!dirt.length) return { ok: false, reason: 'no-dirt' };

    const target = dirt[0];
    const walked = await ctx.body_move({ x: target.position.x, y: target.position.y + 1, z: target.position.z, range: 2, timeoutMs: 20000 });
    if (!walked.ok) return { ok: false, reason: 'no-path', detail: walked };

    const dug = await ctx.body_dig({ x: target.position.x, y: target.position.y, z: target.position.z });
    if (!dug.ok) return { ok: false, reason: 'dig-failed', detail: dug };

    const after = await ctx.read_state({ includeInventory: true });
    return { ok: true, dirt: after.inventory.dirt || 0 };
  }
};
```

“直接”指不经过 `submit_task` 的任务队列，但**仍然**经过父进程的单执行权、权限门、取消与证据链。

## 2. 能力面（manifest `apiVersion: 2`）

| 权限 | ctx 方法 | 语义 | 映射到 Body |
| --- | --- | --- | --- |
| `read_state` | `read_state(opts)` | 世界/自身状态；可按需带 `inventory/players/crops/items/screen/time/weather`，以及**有界**的 `blocks` 窗口 | `body.snapshot()` + `body.blockAt/findBlocks` |
| `read_state` | `block_at({x,y,z})` | 单方块读取（未加载/越界返回 null） | `body.blockAt` |
| `read_state` | `find_blocks({names, maxDistance, count})` | 最近匹配方块（名称精确/谓词），上限 `count≤32`、`maxDistance≤32` | `body.findBlocks(Matching)` |
| `body_move` | `body_move({x,y,z,range?,timeoutMs?})` | 寻路走到坐标；默认 range 1、timeout ≤30s；过程中可被取消 | `body.moveTo` + `body.interrupt` |
| `body_dig` | `body_dig({x,y,z,face?})` | 挖一个**已加载且可达**的方块；目标必须在快照里，距离 ≤ 5（先走近再挖由技能自己决定） | `body.dig`（**权限门** `dig`） |
| `body_place` | `body_place({item,x,y,z,face})` | 对参考方块面放置背包物品；距离 ≤5，物品需在背包 | `body.place`（**权限门** `place`） |
| `body_use` | `body_use({x,y,z,face?,item?})` | 右键方块（箱子/熔炉/工作台/耕地/门等） | `body.useOn`（**权限门** `useOn`） |
| `body_click` | `body_click({slot,button?})` | 在**已打开的容器界面**点击槽位；只允许容器（箱子/熔炉/工作台等），**绝不点击聊天/ESC/设置**；槽位范围由界面决定 | `body.clickSlot` |
| `body_look` | `body_look({yaw,pitch})` / `body_look_at({x,y,z})` | 转向；用于对齐方块/实体，不产生世界效果 | `body.look/lookAt` |
| `body_attack` | `body_attack({entityId?,name?,timeoutMs?})` | 只攻击**敌对生物**；玩家/被动生物拒绝；距离 ≤6 | `body.attack` |
| 既有 | `submit_task` | 提交命令表任务；仍可用作“先做一步现有技能” | `Brain.submitExternalTask` |
| 既有 | `chat` / `wait` / `search` / `generate` / `subprocess` | 不变 | — |

**不再提供**：原始按键、任意鼠标坐标、任意 `executeStep` 字符串、任意方块名伪造、服务器地址/玩家列表直读。
点击/挖掘/放置必须给坐标或槽位，不接受“按键序列”。

## 3. 读世界状态：/state 的边界

`read_state` 返回的是客户端 `/state` 的**受控投影**，不是原始 JSON：

- 基础字段：position/health/food/dimension/time 与 `isDay`（共享 `isDaytime` 规则）、screen/mouse、
  背包计数、敌对生物（≤8）、掉落物、作物、玩家名（只读，不含皮肤/UUID 等多余数据）。
- `blocks`：默认不返回；显式请求时只返回**以玩家为中心的有界窗口**（默认 `radiusXZ=8`、
  `radiusY=4`，`limit≤2000` 格），编码为 `{palette:[...], cells:[[dx,dy,dz,i],...]}`；
  超过 32KB 结果上限时截断并在 `truncated:true` 中说明。**不返回** 49×49×17 的整张扫描。
- 目标查询优先 `block_at` / `find_blocks`，避免整图传输。
- 所有读取带 `observedAt/freshness`；技能必须处理 `ready:false`/`stale`，禁止拿旧坐标直接挖/点。

## 4. 执行权、权限门与并发

| 规则 | 实现要求 |
| --- | --- |
| **唯一身体执行权** | 实时调用：`CodeSkillTask` 已持有 `TaskSlot`，body 原语直接执行；**试运行（HTTP）**：`CodeSkillService` 必须在启动沙箱前 `TaskSlot.acquire({kind:'code_skill', holdsBody:true})`，失败返回 `body-busy`（不排队、不偷偷并发），结束时释放 |
| **权限门** | `dig/place/useOn` 继续走 `permissionGate`：规则 allow/deny/ask，ask 会 `!yes`/`!no`；`source='code-skill'`，任务级 allowance 与普通任务一致；拒绝必须回到技能为 `ok:false` |
| **取消/超时** | abort → `SandboxRunner` SIGKILL → 父进程 `body.interrupt('code-skill cancelled')` → 释放 slot；**撤销后不得有迟到动作**；移动/挖掘/点击的返回值要与真实终态一致 |
| **预算** | 现有 100 次能力调用/32KB/30s（≤60s）不变；新增单原语超时（move ≤30s、dig ≤15s、click ≤5s）与总时长；超出返回失败而非重试 |
| **坐标/范围** | 移动目标距离 ≤64；挖/放/用距离 ≤5 且目标必须在本轮快照中出现；点击必须在已打开的容器界面；攻击只接受敌对生物 |
| **屏幕** | `body_click` 只在 `screenOpen` 且屏幕属于容器时可用；`PauseScreen/ChatScreen/Options` 等一律拒绝并返回 `operator-screen` |
| **失联/清理** | 与现有一致：父进程死→子进程随 IPC 退出；残留 `run-*` 启动清扫；试运行 slot 在 finally 释放 |

## 5. 安全边界（A19 必须重做）

新增原语把“真实效果”从命令表扩展到任意坐标/槽位，A19 的恶意/故障候选至少覆盖：

1. 挖越界/未加载方块、挖保护方块（`permissionGate` deny/ask）；
2. 放/用越界、无物品、错误面；
3. 在聊天/ESC/设置界面点击（必须 `operator-screen`）；
4. 另一个任务运行时启动试运行（必须 `body-busy`，不得抢身体）；
5. 移动/挖掘中取消、超时、宿主硬杀（按键/鼠标/导航必须停止，无残留动作）；
6. 超长移动/大量 `find_blocks`/大 block 窗口（预算与结果上限）；
7. 攻击玩家/被动生物（拒绝）；攻击敌对生物（允许）；
8. 静态扫描仍拒绝 `require/fs/net/process/eval`；vm 逃逸后模块全拒（已加固）。

残余风险不变：vm 不是内核边界、无内核级网络隔离；直接身体原语让“生成代码的破坏半径”变大，
所以权限门、唯一执行权和证据链必须一起通过，不能只验收功能。

## 6. 验收变更（A18–A20 / A28–A30）

| 项 | 新验收（2026-10-25 起） |
| --- | --- |
| **A18** | 至少 2 类目标由**直接原语**完成并有真实效果：(a) 移动→挖掘→背包变化（不调用 `submit_task`）；(b) 移动→打开容器→点击槽位→界面/库存变化。编排子集不再算 A18 |
| **A19** | 覆盖 §5 的 8 类；重点是权限门/屏幕/执行权/取消后的真实无残留 |
| **A20** | 仍为隔离/回退/下线；候选可以是直接原语技能，失败注入需覆盖“动作到一半失败” |
| **A27 代码** | 真实模型生成 v2 manifest + 原语代码，解析/沙箱/回执可归属 |
| **A28–A30（编码回合）** | 用**直接原语**长任务重跑：长移动/长挖掘单次结算、取消后无迟到动作、硬杀恢复不重放、用量可归属 |

## 7. 迁移与兼容

- `apiVersion: 2` 是新契约；v1（编排）技能保留为历史，不参与 M4 重新验收；`agent.status_report`
  等可继续作为编排示例，但不能作为 A18 证据。
- 生成提示词/manifest 白名单加入 `body_*` 权限；静态扫描保持。
- `/code-skills` 的 candidates 已展示 manifest 的 permissions；每次原语调用的参数/结果/拒绝原因
  在 evidence 的 `calls` 与 `body.lastRefusal` 中可查（不单独做“最近原语”面板字段）。
- 文档：本文件为方案；[`P1-M4.md`](P1-M4.md) 记录状态；[`P1-M4-SANDBOX.md`](P1-M4-SANDBOX.md)
  更新权限表；[`P1-CLIENT-TESTS.md`](P1-CLIENT-TESTS.md)/[`P1-CLIENT-VERIFICATION.md`](P1-CLIENT-VERIFICATION.md)
  重新验收。

## 8. 实施顺序

1. **契约**：`manifest.js` 增加 `body_*` 权限与 `apiVersion=2`；离线契约测试（权限白名单/未知能力拒绝）。
2. **host**：`CodeSkillService` 增加 body 原语代理、slot acquire/release、`body.interrupt`、参数校验
   （范围/屏幕/方块存在/敌对目标）。
3. **worker**：只向 vm 注入声明过的 `body_*` 方法；静态扫描与 vm 隔离不变。
4. **测试**：离线假 Body（记录调用、模拟拒绝/超时/取消）+ `p1:m4`；真机 A18 两目标（移动挖掘、容器点击）、
   A19 八类、A28–A30 长任务重跑。
5. **文档/判定**：回填 M4；只有新证据齐全才重新标 PASS。

## 9. 实施状态（2026-10-25，离线 v2 已落地）

按本方案已完成代码与**离线测试**（明确**未跑真实客户端**）：

- **契约**：`manifest.js` 支持 `apiVersion: 2` 与 7 个 `body_*` 权限；`apiVersion: 1` 声明
  body 权限会得到 `permission-requires-api-2:*`；未知权限仍拒绝。`capabilities.js` 是
  worker/runner/service 共用的“ctx 方法 → 权限”表（`block_at/find_blocks` 归 `read_state`）。
- **host**：`CodeSkillService` 新增 `block_at/find_blocks/body_move/body_dig/body_place/body_use/
  body_click/body_look/body_look_at/body_attack`；`read_state` 支持有界 `blocks`（palette+cells，
  ≤24000 字节自动截断）、`players/crops/items/includeMenu`；每个原语有距离/目标/屏幕校验与超时，
  取消/超时会调用 `body.interrupt()`。
- **执行权**：试运行与 HTTP `/run` 在执行 body 权限技能前 `TaskSlot.acquire({holdsBody:true})`，
  忙则返回 `body-busy`（不排队、不并发）；`CodeSkillTask` 传 `slotHeld:true`，避免重复获取；
  结束/取消/超时在 finally 释放。
- **worker/runner**：只向 vm 注入声明过的 ctx 方法；runner 按能力表校验权限；worker 新增的
  `capabilities.js` 已加入 `--allow-fs-read`（仍无写/子进程/网络）。
- **生成提示词**：`apiVersion: 2`，列出 `read_state` 有界 blocks 与 7 个 body 原语及“必须检查
  `{ok,reason}`”的约定；静态扫描（require/fs/net/eval/无限循环）不变。
- **测试**：`p1:m4:test` **34/34**（新增 v2 manifest、bounded read_state、真实 sandbox
  move+dig、越界拒绝、容器/暂停屏点击、body-busy、取消中断+释放、攻击仅敌对、HTTP/slotHeld
  租约、body_use 先装备再刷新屏幕后点击）；`p1:contract:test 206/206`；`p1:verify` **11/11**
  （`--fast` 10/10）。
- **未执行（需真实客户端）**：A18 两类直接目标、A19 八类安全用例、A20 半途失败、A28–A30
  直接原语长任务。按操作员口径本轮**不做真实客户端测试**；M4 仍为“未通过（重开）”，
  旧编排证据仅历史。
- **离线未覆盖**：真实 `permissionGate` 的 `ask/!yes` 交互、真实导航/挖掘/点击的物理终态、
  `body.interrupt` 对真实客户端按键释放的效果；这些必须在真机 A18/A19 里验。
