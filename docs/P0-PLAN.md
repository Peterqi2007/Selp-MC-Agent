# P0 实施计划书：寻路优化 + 大模型大脑 + 双通道控制

> **P0 范围**（用户指定）：
> 1. **寻路优化** —— 让 Bot 能可靠地从 A 走到 B
> 2. **接入大模型大脑** —— LLM 作为一级决策核心
> 3. **游戏内对话 + 外部界面控制** —— 两个输入通道 + 输出
> 4. **只做三个动作原语** —— **行走、破坏、收集掉落物**
>
> **明确不做**：长期对话服务、联网搜索、复杂任务（合成链/建造/容器/熔炼/交易/附魔/下界末地）、多 Bot 协作、**钓鱼（已取消）**、打猎、点灯
>
> **修订记录（本次）**：用户拍板 **取消钓鱼任务**，Bot 只需「行走 / 破坏 / 收集掉落物」。
> 直接后果：**M3 的 Java 补丁整块取消**（原计划的 `entities[]` + 鱼漂 + `deltaMovement` 不再需要）——
> 因为 `ClientStateSnapshot.itemDropsJson()`（`ClientStateSnapshot.java:189-208`）**已经存在**且 Node 侧**已经接好**
> （`clientModBody.js:269`）。经核实：**这三项能力全部不需要修改 Java**。详见 §十三。
>
> **硬前提**：Bot **只能**通过 PCL 客户端 + `mod-client` 控制 Mod 运行在 Forge 服务器上。mineflayer 不参与本计划。
>
> 依据：[`CAPABILITY-AUDIT.md`](CAPABILITY-AUDIT.md)（能力核实）、[`ARCHITECTURE.md`](ARCHITECTURE.md)（架构）、[`CONTROL-PANEL-IMPLEMENTATION.md`](CONTROL-PANEL-IMPLEMENTATION.md)（控制面板）

---

## 一、范围与验收总览

| # | 交付物 | 关键验收指标 |
| --- | --- | --- |
| **A** | 寻路系统：Node 侧 A\* + 航点行走器 | 在 5 个障碍场景中 **≥90% 到达**；不修 Java 即可用 |
| **B** | 资源采集：`ChopWoodTask` / `MineBlockTask` / `GoToTask`（行走→破坏→收集 三原语组合） | 每个任务在真实服务器上各成功 1 次；超时/失败有明确原因；**掉落物真的进入背包** |
| **C** | LLM 大脑：意图路由 | 30 条中文语料 **≥26 条**路由正确；无 key 时优雅降级 |
| **D** | 游戏内对话输入输出（**纯反应式**） | ①`!chop 8` 与 `@猫娘 砍点树` 都能执行并回一句；②**其它发言一律不回应**（10 条干扰消息零回复）；③**无任何主动发言**（挂机 10 分钟，除被叫到外零输出） |
| **E** | 外部控制面板 + 死亡中止 | 浏览器看到实时状态、能下指令、急停 3 秒内生效；**死亡后面板红色横幅 + 控制台告警 + 所有任务中止**，且重生后**不自动恢复** |

---

## 二、目标架构（P0 版）

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Minecraft 客户端进程（PCL 启动）                                             │
│  mod-client (agent-client) @ 127.0.0.1:8899                                 │
│    ├ ControlHttpServer   /state /command /progress /chatlog                  │
│    ├ ClientActions       chat login cmd look lookat moveto dig place         │
│    │                     use select drop attack stop resync                  │
│    ├ ChatLog             别人/自己说的话（50 条环形）                          │
│    └ ClientStateSnapshot blocks.cells（49×49×17 = 40817 格）+ itemDrops + 背包     │
│                                                                             │
│  ★ P0 的 Java 改动：无。三项能力（行走进/破坏 dig/收集 itemDrops）全部已实现      │
└────────────────────────────────────────────────────────────────────────────┘
                                   ▲ HTTP
                                   │
┌──────────────────────────────────┴─────────────────────────────────────────┐
│ Node 进程（src/index.js --body clientmod）                                   │
│                                                                             │
│  ┌── 输入通道 A：游戏内聊天框 ──────────────┐  ┌── 输入通道 B：外部面板 ────┐ │
│  │ ChatListener                             │  │ statusServer @ 8766        │ │
│  │  轮询 GET /chatlog?n=25（700ms）          │  │  GET  /panel               │ │
│  │  回声过滤（丢弃自己说过的话）              │  │  GET  /ui/state            │ │
│  │  ┌ 仅两类输入命中 ────────────────┐        │  │  POST /command {priority}  │ │
│  │  │ ① "!xxx"     确定性指令          │        │  │                            │ │
│  │  │ ② "@猫娘 xxx" 自然语言 → LLM     │        │  │  死亡红色横幅 + 恢复按钮    │ │
│  │  └ 其它发言一律忽略 ──────────────┘        │  └──────────┬────────────────┘ │
│  └───────────────┬──────────────────────────┘             │                  │
│                  └──────────────┬───────────────────────────┘                  │
│                                 ▼                                            │
│  ┌── LLM 大脑（src/llm/）─────────────────────────────────────────────────┐  │
│  │  LlmCore                                                                 │  │
│  │   • Blackboard：状态摘要 + 能力清单 + 最近对话（拼 prompt）                 │  │
│  │   • IntentRouter：文本 → 严格 JSON → 校验 → 动作                          │  │
│  │   • FallbackRouter：无 key/超时时用正则兜底（保证永远能用）                 │  │
│  │   • ★ 无 say 工具、无自主发言、无 SpeechScheduler（P0 纯反应式）           │  │
│  └───────────────┬──────────────────────────────────────────────────────────┘  │
│                  ▼                                                            │
│  ┌── Brain（扩展：事件总线 + 三级优先级 + 死亡中止）──────────────────────┐  │
│  │  enqueue(task, {level, source})    URGENT / DIRECTIVE / AUTONOMOUS      │  │
│  │  emit('task:done'|'task:failed')   ← LLM 靠它做后续动作                  │  │
│  │  ★ DeathWatch 轮询 snapshot().dead → preempt + paused（不自动恢复）      │  │
│  └───────────────┬──────────────────────────────────────────────────────────┘  │
│                  ▼                                                            │
│  ┌── 任务层（P0 三原语：行走 / 破坏 / 收集）─────────────────────────────┐  │
│  │  HarvestTask（抽象：找→走近→破坏→验证→收集掉落物→循环）                   │  │
│  │    ├ ChopWoodTask    isTarget = isLog()                                 │  │
│  │    └ MineBlockTask   isTarget = 方块名匹配                               │  │
│  │  GoToTask          寻路到坐标（纯行走）                                    │  │
│  └───────────────┬──────────────────────────────────────────────────────────┘  │
│                  ▼                                                            │
│  ┌── ★ 寻路系统（P0 的核心新增）──────────────────────────────────────────┐  │
│  │  ClientWorldAdapter   把 blocks.cells 适配成 pathfinder 要的形状          │  │
│  │  MovementsAdapter     getNeighbors()：简化版方块运动模型（含 Vec3 hash）   │  │
│  │  PathPlanner          AStar（复用）+ GoalNear（复用）+ 迭代式再规划        │  │
│  │  WaypointWalker       航点 → moveto 指令，带卡死检测与失败分类            │  │
│  └───────────────┬──────────────────────────────────────────────────────────┘  │
│                  ▼                                                            │
│  ┌── 躯体 ─────────────────────────────────────────────────────────────────┐  │
│  │  ClientModBody（扩展：moveTo 换成寻路版、readChat()、snapshot 补字段）     │  │
│  │  botFacade（新增：补 ctx.bot 的读状态 + 说话，故意不补写动作）              │  │
│  └──────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 三条不可动摇的设计约束

| 约束 | 理由 |
| --- | --- |
| **所有世界动作经 `Body`，绝不绕过** | 保住 `--body mock` 的离线测试能力。寻路是 P0 最复杂的部件，而它**可以在 MockBody 上测**（喂一个手写的 `blocks.cells` 就够了） |
| **LLM 产出严格 JSON，动作类型是枚举** | LLM 会生成任意字符串。枚举是能力白名单的第一层；没有「发服务器指令」这个动作类型，注入就无从下手 |
| **Bot 只在被叫到时候说话** | 输入只认 `!指令` 和 `@猫娘 自然语言`；**不理会其它发言、不主动发言**。这一条同时消掉了「刷屏」和「LLM 自发行为」两类风险 |
| **死亡即中止，且不自动恢复** | 中止是确定性的，恢复是玩家的决定。自动恢复会让"中止"失去意义 |

---

## 三、交付物 A：寻路优化（最优先，其它全依赖它）

### 3.1 现状与问题

`ClientActions.WalkTo`（`ClientActions.java:375-421`）是**直线贪心 + 撞墙跳一格**：

```java
double dx = target.x - player.getX();
double dz = target.z - player.getZ();          // 只算水平距离
if (horizontal <= range) { arrived = true; }   // 到达判定忽略 Y
lookAtOnClient(target.x, player.getY() + 1.0, target.z);
setKeyInClient("forward", true);               // 一直按住前进
if (player.horizontalCollision && player.onGround()) setKeyInClient("jump", true);
```

**它不能**：绕墙、绕水、绕栅栏、上下台阶/沟壑、在卡住时换路。
**它的后果**：任何「走过去」类任务在非开阔地形都失败，而砍树/挖矿必须走过去。

### 3.2 关键发现：A\* 求解器与 mineflayer 解耦，可以复用

我核实了 `node_modules/mineflayer-pathfinder/lib/astar.js`：

```js
class AStar {
  constructor (start, movements, goal, timeout, tickTimeout = 40, searchRadius = -1) {
    this.movements = movements   // ← 只需要一个「提供 getNeighbors 的对象」
    this.goal = goal             // ← 只需要 { heuristic(node), isEnd(node) }
    ...
  }
  compute () {
    const neighbors = this.movements.getNeighbors(node.data);   // ★ 唯一的世界访问点
    ...
  }
}
module.exports = AStar
```

⇒ **整个 A\* 只通过 `movements.getNeighbors()` 接触世界。** 而 `Movements.getNeighbors()` 内部只调 `this.getBlock(pos, dx, dy, dz)` → `this.bot.blockAt(...)`（`movements.js:218-219`）。

⇒ **只要提供一个符合 `bot.blockAt` 形状的适配器，就能在 Node 侧对 `blocks.cells` 跑 A\***，不需要 mineflayer 实例，也不需要改 Java。

同时复用 `lib/goals.js` 的 `GoalNear` / `GoalBlock` / `GoalXZ`（它们的 `heuristic`/`isEnd` 是纯函数，`goals.js:5-130`）。

### 3.3 为什么不用「Minecraft 内建寻路」

| 方案 | 评价 |
| --- | --- |
| Java 侧驱动 Minecraft 自己的 `PathNavigation` | ❌ 对 `LocalPlayer` 强行注入 pathfinding 需要 Mixin/AT，且 1.20.1 的 `PathNavigation` 需要 `Mob` 宿主。风险高、调试难 |
| **Node 侧 A\* + `moveto` 航点** | ✅ 复用已验证的算法；**能在 MockBody 上离线测**；失败分类在 JS 里好做；改一行就跑，不用重编 Mod |
| Mod 侧手写 A\* | ❌ 重复造轮子且无法离线测 |

### 3.4 组件设计

#### (1) `src/pathfinding/vec3util.js` — 兼容垫片（约 30 行）

**这是最容易踩的坑**：A\* 和 `Movements` 用的是 `vec3` 包的对象，`PathNode.set()` 用 `data.hash` 做去重键。必须提供 hash 兼容。

```js
const Vec3 = require('vec3');
function v3(x, y, z) { return new Vec3(x, y, z); }
// vec3 的 hash 是 `x:y:z` 字符串（整数化后），与 AStar 的 openDataMap 键一致
```

#### (2) `src/pathfinding/clientWorldAdapter.js` — 世界适配器（约 90 行）

把 `ClientModBody` 的 `blocks.cells` 包装成 `Movements` 期望的形状。

```js
class ClientWorldAdapter {
  constructor(body) { this.body = body; }

  /** @returns {{name:string, solid:boolean, liquid:boolean, ...}|null} */
  blockAt(pos) {
    const snap = this.body.snapshot();
    if (!snap) return null;
    const cells = snap.blocks?.cells;
    if (!cells) return null;
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
    const name = cells[key];
    if (name === undefined) return null;      // ★ 网格外 = null（诚实地说"不知道"）
    return describeBlock(name);                // 映射成 solid/liquid/climbable/...
  }
  inGrid(p) { /* 网格边界检查，用于判断"未知"vs"空气" */ }
}

/**
 * 方块名 → 运动相关属性。
 * P0 的规则刻意简单，集中在两处可测的纯函数里，而不是把 minecraft-data 全表搬进来。
 */
function describeBlock(name) {
  const bare = name.replace(/^[a-z_]+:/, '');
  return {
    name,
    solid: !PASSABLE.has(bare),           // 复用 src/world/items.js 的 PASSABLE
    liquid: /water|lava/.test(bare),
    climbable: /ladder|vine|scaffolding/.test(bare),
    // ...
  };
}
```

#### (3) `src/pathfinding/movementsAdapter.js` — 运动模型（约 140 行）

实现 `Movements` 的**最小子集**：`getBlock(pos, dx, dy, dz)` + `getNeighbors(node)`。

邻居生成规则（P0，刻意保守）：

| 动作 | 条件 | cost |
| --- | --- | --- |
| 水平走 1 格 | 目标格与头顶可通行 + 下方是实心**且站得上去** | 1.0 |
| 上台阶 1 格 | 上方两格可通行 + 台阶顶是实心**且站得上去** | 1.5 |
| 下落 1-3 格 | 下方连续可通行 + 落地格是实心**且站得上去** | `1 + drop*0.5` |
| 跳过 1 格缺口 | 起跳/落点可站立 | 2.0 |
| 游泳（可选，默认开） | 目标格是 liquid | 2.5 |
| **禁止** | 走进岩浆；走进「网格外」（未知）；走进本趟行程已确认走不到的格子 | — |

**「实心」≠「站得上去」**（这一条是被真机故障逼出来的）。栅栏、圆石墙、玻璃板、铁栏杆、
关着的门/栅栏门都是实心的，而它们**上方那格是空气** —— 只问「下面是实心吗」的运动模型
会得出「可以踩上栅栏顶」的结论。客户端于是走过去撞上栅栏、按住前进并不断起跳，
**原地跳满 60 秒**。所以 `describeBlock()` 多一个 `standable` 字段（栅栏/墙/板/栏杆/门/
地毯/按钮/告示牌… 均为 `false`；半砖、楼梯仍为 `true`），`hasFloorAt()` 同时要求
`solid && standable`。判错的代价只是绕路，判对的收益是「不会规划出一个只能靠跳的移动」。

每条边还会被打上 `move` 标签（`walk` / `step-up` / `drop` / `jump` / `swim` / `climb`），
它是「这一段是走还是跳」唯一的证据，`normalisePath()` 会保留它，行走器据此区分
「路被挡住（重规划可能有救）」和「这个跳根本跳不过去（得换方向）」。

**明确不做**（P0）：挖穿障碍（`canDig`）、搭脚手架、复杂跑酷、跳跃 2 格高。

> **保守的价值**：宁可报 `noPath` 也不要规划出一条 Bot 执行不了的路径。失败可诊断，错误路径会浪费几分钟。

#### (4) `src/pathfinding/planner.js` — 规划器（约 160 行）

```js
class PathPlanner {
  constructor(body, options = {}) {
    this.body = body;
    this.world = new ClientWorldAdapter(body);
    this.movements = new MovementsAdapter(this.world, options);
    this.maxPathLength = options.maxPathLength || 200;
    this.replanEvery = options.replanEvery || 20;   // 每走 20 格重新规划（应对 24 格扫描半径）
  }

  /**
   * 规划到目标附近的路径。
   * @returns {Promise<{status:'success'|'partial'|'noPath'|'timeout'|'unknown',
   *                    path:Array<{x,y,z}>, reason:string}>}
   */
  async plan(target, options = {}) { /* new AStar(...).compute() → 归一化结果 */ }
}
```

**迭代式再规划**（对应 24 格扫描半径这个硬限制）：
`blocks.cells` 只有 ±24 格。走长距离时不能一次规划到底。

```
while (未到达 && 步数 < 上限) {
  const res = await plan(finalTarget);
  if (res.status === 'noPath') → 失败，返回原因
  const nextWaypoint = res.path[Math.min(replanEvery, res.path.length-1)];
  await walkTo(nextWaypoint);
  if (卡住) → 计数，超阈值则失败
}
```

#### (5) `src/pathfinding/walker.js` — 航点行走器（约 130 行）

把航点转成 `moveto` 指令，并做卡死检测。

```js
class WaypointWalker {
  /**
   * 依次走到每个航点。
   * @returns {Promise<{ok:boolean, arrived:number, reason:string}>}
   *   reason: 'arrived' | 'timeout' | 'blocked' | 'no-progress' | 'body-lost'
   */
  async walk(waypoints, options = {}) { ... }
}
```

**关键点**：
- 每个航点发一次 `moveto x y z <range>`（`range` 用 1.0 而非 1.5，减少"路过就算到"的误判）
- 轮询 `/progress`：`arrived=true` → 下一个；`failed=true` → **重新规划**（不是直接失败）
- **卡死检测**：连续 2 个航点位置变化 < 0.5 格 → 判定卡住 → 发 `stop` → 重新规划 → 若再次卡住 → 失败
- 航点合并：相邻同向的水平航点合成一次 `moveto`（长直路 40 格 = 1 次请求而不是 40 次）

#### (6) `ClientModBody.moveTo()` 改造

```js
async moveTo(position, options = {}) {
  // 近距离（< 3 格）走原本的直线 moveto，省掉规划开销
  if (distance(this.snapshot()?.position, position) < 3) {
    return this._rawMoveTo(position, options);
  }
  // 远距离走寻路
  const result = await this.planner.goTo(position, options);
  if (!result.ok) this.log.debug(`pathfinding failed: ${result.reason}`);
  return result.ok;
}
```

保留 `_rawMoveTo()` 作为降级路径（寻路不可用时）。

### 3.5 失败分类（这是「优化」的核心价值）

| 原因 | 触发条件 | Bot 该怎么办 |
| --- | --- | --- |
| `arrived` | 到达 | 继续任务 |
| `noPath` | A\* 返回 noPath | **换一个目标**（这棵树够不着，找下一棵） |
| `out-of-grid` | 目标在 ±24 格之外 | 先朝目标方向走一段再规划 |
| `timeout` | 单航点超时 | 重试一次，再失败则换目标 |
| `blocked` | 卡死 2 次 | 发 `stop`，把走不到的格子从本趟行程的图里删掉，横向换方向，再不行就换目标 |
| `jump-blocked` | 连续 2 次跳跃/上台阶都没进展 | **不要再跳**：把该格标记为走不到 → 重规划出另一条路 → 仍然不行就横向挪一步 |
| `unknown-block` | 路径上有网格外的格子 | 降级为「朝目标方向直线走」 |
| `body-lost` | `body.isReady === false` | 任务失败并退出 |

**⇒ 有了分类，「砍树」就能做到：这棵树到不了 → 自动找下一棵，而不是原地循环。**

#### 3.5.1 为什么需要 `jump-blocked`（真机故障）

客户端的 `WalkTo` 实现是「按住前进 + 一撞墙就按跳」。面对 2 格高的墙、栅栏、或者头顶被
方块挡住的台阶，它就会**原地跳**，直到 60 秒超时才罢休 —— 而 A\* 的方块图来自快照，
快照说这条路能走，于是**每一次重规划都得出同一条路、同一个跳**。重规划根本不是策略。

修法分两层，都在「让下一次尝试真的不一样」：

1. **把走不到的格子从本趟行程的图里删掉**（`MovementsAdapter.avoid`）。
   这是关键的一步：快照没变，A\* 没有理由给出不同答案；只有把那个格子拿掉，
   重规划才会得出**另一条**路。导航器每趟行程清空一次，并且一旦「排除后无路可走」
   就先放弃排除再问一次（避免自己把自己堵死）。
2. **横向挪一步**（`PathNavigator.sidestep`，最多 `maxSidesteps`=2 次）。
   垂直于目标方向的一小段路，改变的是 A\* 的起点，而不是它的规则。
   候选格一律走运动模型自己的判据（网格内、不在人造方块上、可站立、下方站得上去），
   所以「换方向」不可能把机器人带进岩浆或者别人家里。

同时客户端也修了：`WalkTo` 连续 4 次起跳都没靠近、且 1.2 秒无进展 → 立刻结束并上报
`jump-blocked`，不再空跳 60 秒。

### 3.6 验收（**可离线完成**）

新增 `scripts/path-test.js`：构造手写的 `blocks.cells` 地图，塞进 MockBody，跑 `PathPlanner`。

| 场景 | 地图 | 期望 |
| --- | --- | --- |
| 1 空地直行 | 全平地 | success，路径 ≈ 直线长度 |
| 2 绕墙 | 中间一堵 5 格宽的墙 | success，路径绕行 |
| 3 绕水 | 一片 5×5 水 | success（若开游泳）或 noPath（若关） |
| 4 台阶 | 3 级 1 格台阶 | success |
| 5 死胡同 | U 形墙包住目标 | **noPath**（明确失败，不挂起） |
| 6 网格外 | 目标在 ±30 格 | 返回 `out-of-grid`，触发再规划 |
| 7 卡住 | mock 的 moveto 故意不动 | 检测到卡死并 `blocked` |
| 8 移动标签 | 一台阶/一深坑/一水面/一下落 | 每条邻居都带正确的 `move` 标签 |
| 9 连跳失败 | 跳不过去的缺口 | 第二次失败报 **`jump-blocked`**，不是继续跳 |
| 10a 换方向（学习） | 快照说能跳、客户端跳不过去的坑 | 该格被排除 → 重规划绕行 → **抵达** |
| 10b 换方向（横挪） | 空地 / 垂直方向全是木板 | 横挪格合法；人造地板上的格子一律不选 |
| 10c 无路可走 | 每个方向都过不去 | **明确失败**、迭代与横挪次数有上界、不挂起 |
| 11 栅栏不是台阶 | 一整排栅栏 | **noPath**，且「踩上栅栏」根本不作为一个候选移动存在 |

**通过标准：全部可达场景 success；不可达/被挡场景明确失败（`noPath` / `blocked` /
`jump-blocked`）且不挂起；任何场景都不允许出现「规划出一条只能靠跳的移动」。**

---

## 四、交付物 D + E：双通道控制

### 4.1 通道 A：游戏内聊天框（**这是最小成本的通道**）

#### 4.1.1 为什么可行

| 环节 | 状态 |
| --- | --- |
| 你在客户端聊天框打字 | ✅ 就是聊天消息 |
| Mod 捕获 | ✅ `ChatLog.onChat` 挂 `ClientChatReceivedEvent`（`ChatLog.java:35`） |
| HTTP 暴露 | ✅ `GET /chatlog?n=`（最多 50 条） |
| Node 能读 | ❌ **`ClientModBody` 里搜 `chatlog` 零命中** → 需新增 `readChat()` |
| `!` 指令层 | ❌ `ChatController` 挂 `bot.on('chat')`（`commands.js:76`），clientmod 下永不触发 → 需改挂载点 |

⇒ 通道通的，接线缺约 60 行。

#### 4.1.2 设计：**不需要识别发送者**

因为只有一个玩家（你），且你和 Bot 共用账号。所以：

```
你在聊天框打:  !chop 32
  → ChatLog: "!chop 32"
  → Node 轮询 → 前缀匹配 "!" → 剥掉 → enqueue(task, {level: DIRECTIVE, source: 'chat'})
  → ✅ 不需要 @、不需要发送者识别、不需要权限白名单
```

**触发词建议用 `!`**（已有 `behaviour.chatPrefix` 配置），而不是 `@猫娘`：
- `!` 只可能是你打的（Bot 自己不会以 `!` 开头说话）
- 避免了「@ + bot 名字」与自己回声混淆的麻烦

（自然语言「@猫娘 去砍点树」走 LLM 通道，与 `!` 前缀通道**并存**：`!` 是确定性快路径，`@` 走 LLM。）

#### 4.1.3 回声过滤（**必须有，否则 Bot 会自己跟自己说话**）

`ChatLog` 记的是 `event.getMessage().getString()` —— **纯渲染文本，没有发送者字段**（`ChatLog.java:38,43`）。你和 Bot 同名，所以无法靠文本区分。

解法：Node 侧维护「自己说过什么」的环形缓冲（最近 10 条），在 ChatLog 里看到匹配的就丢弃。

```js
// src/chat/chatListener.js
class ChatListener {
  constructor(body, ctx, options = {}) {
    this.said = [];                    // 回声指纹
    this.seen = new Set();             // 已处理行的指纹，防同一行重复触发
    this.intervalMs = options.intervalMs || 700;
    this.cursor = 0;                   // P0 用「最后 N 行 + 指纹去重」代替 since= 序号
  }

  /** 由 Bot 发言路径调用，登记回声 */
  noteOwnSpeech(text) {
    this.said.push(fingerprint(text));
    if (this.said.length > 10) this.said.shift();
  }

  start() { this.timer = setInterval(() => this.poll().catch(() => {}), this.intervalMs); }

  async poll() {
    const res = await this.body.readChat(25);       // GET /chatlog?n=25
    for (const line of res.lines || []) {
      const fp = fingerprint(line);
      if (this.seen.has(fp)) continue;
      this.seen.add(fp);
      if (this.said.includes(fp)) continue;         // ★ 回声，丢弃
      if (!line.startsWith(this.prefix)) continue;  // 非指令
      await this.ctx.chat.handle(line.slice(this.prefix.length), 'chat');
    }
    if (this.seen.size > 400) this.seen.clear();
  }
}
```

**已知缺陷（P0 接受，P1 修）**：用「指纹去重」代替真正的序号，会导致**完全相同的两条消息在 50 行窗口内只触发一次**。对 `!chop 32` 连发两次这种场景是可接受的；P1 给 Mod 加 `GET /chatlog?since=<seq>` 彻底解决（约 10 行 Java）。

### 4.2 通道 B：外部控制面板

#### 4.2.1 形态（单文件内嵌 HTML，零依赖）

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 🐱 AgentSteve   大脑:▶ 登录:✅ 已登录 hp 18/20 🍗12 📍-28,68,32 手持:镐    │ ← 1s 轮询
├──────────────────────────────────────────────────────────────────────────┤
│ 当前: chop 32 (12/32)   [指令]          队列: 1                           │
│ 【可选】最近识别到的输入：                                                │
│   @猫娘 砍点树        → 已路由到 chop{32}                                 │
│   !status            → 已执行（hp 18/20 food 12）                        │
├──────────────────────────────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────────────────────────────┐  │
│ │ ▸ 输入指令（回车发送，↑↓ 历史，Tab 补全）                             │  │
│ └────────────────────────────────────────────────────────────────────┘  │
│ 优先级: (•) 指令   ( ) 紧急                                            │
├──────────────────────────────────────────────────────────────────────────┤
│ [⏹ 急停] [📊 状态] [🎒 背包] [🧭 位置] [🪓 砍树] [⛏ 挖矿] [🚶 走过来]      │
├──────────────────────────────────────────────────────────────────────────┤
│ 日志                                                                     │
│  12:31:02 ▸ chop 32      [指令] ⚡抢占 gather-wood → 已入队                │
│  12:31:31   砍到 oak_log ×12 (12/32) → 走过去捡起 → 背包 12/32            │
└──────────────────────────────────────────────────────────────────────────┘

死亡时的额外渲染（顶部插入，覆盖状态条）：

┌──────────────────────────────────────────────────────────────────────────┐
│ 🪦 BOT 已死亡 @ -28,64,32  ·  12:41:07  ·  所有任务已中止                  │
│    请检查游戏窗口是否需要手动点「重生」      [ 🔄 恢复运行 ]                │
└──────────────────────────────────────────────────────────────────────────┘
```

> **面板的一个额外职责**：因为 Bot 不主动说话，面板就成了**唯一能看见「它听懂了吗」的地方**。
> 所以面板要显示「最近识别到的输入 → 路由结果」，让你确认 `@猫娘 砍点树` 到底被理解成了什么。

#### 4.2.2 后端路由（加在 `src/web/statusServer.js`）

| 路由 | 作用 | 约 |
| --- | --- | --- |
| `GET /panel` | 返回内嵌单文件 HTML | 120 行 |
| `GET /ui/state` | 精简状态（**不返回 40817 格**，只给摘要 + 当前任务 + 队列） | 30 行 |
| `POST /command`（改） | 接受 `priority`（`urgent`/`directive`，默认 `directive`）；响应加 `{accepted, level, preempted, queuedBehind}` | 15 行 |

**急停的四级降级**（保证 3 秒内一定生效）：

```
1. brain.preempt() + queue.length = 0        （Node 侧，<10ms）
2. body.interrupt() → 发 stop 给 8899        （清客户端连续动作）
3. body.stopContinuous() 失败则 HTTP 超时     （2s）
4. 面板显示「急停已发送」+ 实际结果           （诚实反馈）
```

### 4.3 通道 C：输出（**纯反应式，P0 不主动说话**）

用户明确：**P0 不需要自主发言**（哪怕快死了也不管 —— 死亡由系统提示 + 界面外告警处理）。
所以输出只有一个场景：**玩家问了，才回**。

| 输入 | 是否回应 |
| --- | --- |
| `!` 指令 | ✅ 回一句结果（可选，见下） |
| `@猫娘 <自然语言>` | ✅ 回一句 |
| 玩家其它发言 | ❌ **完全不理会** |
| 任务完成 / 失败 | ❌ 不说话，只写面板和日志 |
| 饥饿 / 低血 / 受困 / 天黑 | ❌ **完全不说话** |
| 死亡 | ❌ 不说话（见 §4.4） |

**⇒ 这一条砍掉的东西比看上去多：**
- 不需要 `SpeechScheduler`（那 8 个状态触发器全部删除）
- 不需要状态嗅探 → 发言的链路
- 不需要 `Throttler` 的「主动发言」分支（只需防抖）
- 不需要保护「喊救命」不被任务阻塞的复杂度
- **LLM 不需要 `say` 工具** —— 它只能说「回复玩家」这一件事，不能自发说话

**实现（约 40 行）**：

```js
// src/chat/reply.js
async function reply(ctx, text, options = {}) {
  if (!text) return;
  const policy = ctx.cfg.agent.chat;
  if (policy.replyInGame === false) return;          // 可关
  const clean = sanitize(text);                      // 去换行、截断到 maxChars
  if (!clean) return;
  ctx.chatListener.noteOwnSpeech(clean);             // ★ 登记回声，防空转
  await ctx.body.chat(clean);                        // → 8899 "chat <文本>"
}

/** 去掉会让 ChatLog 回显混淆或触发指令的东西 */
function sanitize(text) {
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/^\s*[!/]/, '')       // 绝不以 / 或 ! 开头（否则像指令 / 会自我触发）
    .trim()
    .slice(0, 100);
}
```

**回复策略（`config.agent.json` 可调）**：

| 配置 | 默认 | 含义 |
| --- | --- | --- |
| `chat.replyInGame` | `true` | 是否在游戏里回话（关掉就只写面板） |
| `chat.replyOnTaskResult` | `false` | 任务结束后是否再报一句（**默认关**，符合"不主动说话"） |
| `chat.maxChars` | `100` | 单句上限 |

**⚠️ `sanitize()` 里那条 `replace(/^\s*[!/]/, '')` 是必须的**：
`ChatLog` 没有发送者字段，如果 Bot 的回话以 `!` 或 `/` 开头，它会被自己的输入管道**当成一条新指令**，形成自激循环。

#### 4.3.1 附带修复：`ctx.bot` 为 null 导致的静默失败

`ChatController` 里**不只有说话**，还有读状态（`commands.js:105-123`）：

```js
status: () => { const s = ctx.world.summary(); ... }                       // ✅ 不碰 bot
inv:    () => { const items = inventorySummary(ctx.bot); ... }            // ❌ ctx.bot 是 null
where:  () => { const s = ctx.world.summary(); ... }                      // ✅
```

而 `say()` 用的是 `ctx.bot.chat()`（`commands.js:95`），异常被 `catch{}` **吞掉**（`commands.js:96-98`）。
clientmod 下 `ctx.bot` 是 `null`（`botCreated` 事件永不触发），所以 **`!status` 连回复都发不出来**。

解法：`src/body/botFacade.js`（约 50 行），补上「读状态 + 说话」，**故意不补写动作**：

```js
function createBotFacade(body, cfg, hooks = {}) {
  return {
    username: cfg.agent.bot.username,
    inventory: {
      items: () => Object.entries(body.snapshot()?.inventory || {})
                        .map(([name, count]) => ({ name, count, type: name }))
    },
    entity: { position: () => body.snapshot()?.position },
    chat: (m) => { hooks.noteOwnSpeech?.(m); return body.chat(m); },   // ★ 登记回声
    // 不提供 dig / place / equip / attack —— 让误用立刻炸出来而不是静默失败
  };
}
```

**⇒ 你的打字和 Bot 的回话都在同一个聊天栏里，形成闭环。**

### 4.4 死亡处理（**新增，P0 必做**）

用户要求：**死亡后在游戏界面外提示，并自动中止一切任务。**

#### 4.4.1 现状核实：字段有，接线没有

| 环节 | 状态 |
| --- | --- |
| Mod 侧是否上报死亡 | ✅ **已有** —— `ClientStateSnapshot.java:79` `out.put("dead", Json.bool(player.isDeadOrDying()))` |
| Node 侧是否解析 | ❌ **没有** —— `ClientModBody.snapshot()`（`clientModBody.js:188-210`）**没有把 `state.dead` 放进快照** |
| 是否有死亡事件 | ❌ 现有的 `controller.on('death')` / `on('respawn')`（`bot.js:118,124`）都是 **mineflayer 事件**，clientmod 下永不触发。`src/index.js:316,322` 的处理器也就永远不会跑 |

⇒ 接线量很小：**把 `dead` 加进 `snapshot()`，再加一个轮询检测**。

#### 4.4.2 实现（约 70 行）

```js
// src/core/deathWatch.js
/**
 * 死亡监视：轮询 body.snapshot().dead，检测到死亡就
 *   1) 中止一切任务  2) 置 brain 为 stopped 直到玩家手动恢复  3) 在"游戏界面外"告警
 *
 * 为什么用轮询而不是事件：clientmod 是纯 poll 的 Body（契约里没有事件通道），
 * /state 已经在 400ms TTL 上被反复读取，搭车检测几乎零成本。
 */
class DeathWatch {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.intervalMs = options.intervalMs || 500;
    this.dead = false;
  }

  start() {
    this.timer = setInterval(() => this.tick(), this.intervalMs);
  }

  tick() {
    const snap = this.ctx.body.snapshot();
    if (!snap || snap.ready !== true) return;          // 客户端掉线 ≠ 死亡
    const nowDead = snap.dead === true;

    if (nowDead && !this.dead) this.onDeath(snap);
    else if (!nowDead && this.dead) this.onRespawned();
  }

  onDeath(snap) {
    this.dead = true;
    const { brain, log, memory } = this.ctx;

    // ① 中止一切任务（URGENT 语义：cancel 当前 + 清空队列）
    brain.preempt();
    brain.queue.length = 0;
    brain.paused = true;                                // ★ 连自主规划一起停

    // ② 让客户端也停手（松键、停挖）—— 否则可能还在按住前进键
    this.ctx.body.interrupt('death').catch(() => {});

    // ③ 游戏界面外告警
    memory.recordDeath('clientmod');                    // 落 runtime/agent-state.json
    memory.data.runtime.death = { at: new Date().toISOString(), position: snap.position };
    memory.save();
    log.error('──────────────────────────────────────────────');
    log.error(`BOT 已死亡 @ ${fmt(snap.position)} —— 所有任务已中止`);
    log.error('  面板: http://127.0.0.1:8766/panel  （顶部红色横幅）');
    log.error('  恢复: 在面板点「恢复」或 POST /command {"command":"resume"}');
    log.error('  注意: 若游戏窗口停在死亡画面，需要手动点「重生」');
    log.error('──────────────────────────────────────────────');
  }

  onRespawned() {
    this.dead = false;
    this.ctx.log.warn('Bot 已重生，任务仍处于中止状态 —— 需要手动 resume');
    // ★ 刻意不自动 resume：用户要的是"中止一切任务"，自动恢复会违背这个意图
  }
}
```

#### 4.4.3 「游戏界面外提示」的三个落点

| 落点 | 实现 | 用户能看到吗 |
| --- | --- | --- |
| **① 控制面板红色横幅** | `GET /ui/state` 增加 `dead: true` + 死亡坐标时间；面板顶部渲染红色横幅 + 「恢复」按钮 | ✅ 浏览器 |
| **② Node 控制台大号错误日志** | `log.error` 三行带分隔线（见上） | ✅ 你启动 Agent 的那个终端 |
| **③ 状态文件** | `runtime/agent-state.json` 的 `runtime.death` + `deaths` 计数 | ✅ 任何外部工具/脚本可读 |

**⚠️ 不能靠游戏内聊天来提示死亡**：Bot 死了，而且死亡瞬间客户端可能没在听 —— 更重要的是，
在一个共享账号的死亡画面上，你自己的聊天记录也会被搅乱。**所以告警刻意只走界面外三条路。**

#### 4.4.4 一个必须知道的运维风险

Bot 死亡后**能否自动重生**取决于客户端：

```
玩家死亡 → 原版客户端弹「你死了！」死亡画面
              ↓
     默认需要玩家点「重生」按钮
              ↓
     AgentClientMod 目前**没有**任何触发重生的能力
     （没有 Screen 注入、没有 ClientboundPlayerCommand 相关代码）
```

**⇒ 如果客户端停在死亡画面不自动重生，Bot 会一直保持死亡状态。**

- 有些整合包/Mod 会自动重生（`autoRespawn` 类 Mod），那时不需要处理
- **P0 的对策**：死亡告警里明确写「请检查游戏窗口是否需要手动点重生」。这是诚实的做法
- **P1 的正解**：给 Mod 加一个 `respawn` verb。一行 `mc.player.respawn()`（或 `mc.getConnection().sendCommand(...)` 不适用，因为重生是包不是指令）。**这需要改 Java，所以不在 P0**

---

## 五、交付物 C：LLM 大脑

### 5.1 目录结构（P0 精简版）

```
src/llm/
├─ index.js          LlmCore：装配、开关、事件订阅
├─ client.js         provider 无关的 OpenAI-compatible 客户端（零依赖 fetch）
├─ blackboard.js     拼 prompt：人格 + 能力清单 + 状态摘要 + 最近 6 条对话
├─ intent.js         严格 JSON Schema + 校验 + 归一化
├─ fallbackRouter.js 无 key / 超时时的正则兜底（★ 保证永远能用）
├─ reply.js          唯一的说话出口（含 sanitize 防自激）
├─ trace.js          轨迹落盘 runtime/llm-trace.jsonl
└─ tools/
   ├─ registry.js    工具注册 + JSON Schema + 白名单门禁
   ├─ perceptors.js  observe / find_blocks / lookup_item
   └─ actuators.js   do_task / go_to / say / stop     ← 唯一有副作用的入口
config/llm.json
```

### 5.2 意图 Schema（严格，四选一）

```jsonc
// A 说话 + 派任务
{ "say": "好嘞，我去砍 32 根木头喵",
  "action": { "type": "task", "task": "chop", "args": { "count": 32 } } }

// B 只说话
{ "say": "我在挖矿呢，还有 3 个就够", "action": null }

// C 移动
{ "say": "我这就过去", "action": { "type": "go_to", "x": 120, "y": 64, "z": -300 } }

// D 拒绝 / 追问
{ "say": "那个方块我不认识喵，是哪个模组的？", "action": null }
```

**`action.type` 是固定 4 值枚举**：`task` / `go_to` / `stop` / `null`。
**`action.task` 是固定 3 值枚举**：`chop` / `mine` / `collect`（P0 只有这三个）。

> **枚举 = 能力白名单的第一层。** 没有「发服务器指令」这个类型，therefore 提示词注入无法让 Bot 发指令。

### 5.3 工具清单（P0 只有 6 个）

| 工具 | 类型 | 作用 |
| --- | --- | --- |
| `observe()` | 只读 | **核心工具**。返回状态摘要：坐标/维度/血量/饥饿/时间/手持/背包/`itemDrops`/16 格内主要方块/在线玩家 |
| `find_blocks(names[], maxDistance)` | 只读 | 返回最近的目标方块坐标（不含动作） |
| `lookup_item(name)` | 只读 | 查物品/方块是否存在于 `minecraft-data` registry；不存在则明确说"不认识" |
| `do_task(task, args)` | **有副作用** | `chop{count}` / `mine{block,count}` / `collect{}` |
| `go_to(x, y, z)` | **有副作用** | 走到坐标（地标查询 P1 再加） |
| `stop()` | **有副作用** | 立刻停手（等价于 URGENT `preempt`） |

**★ 刻意没有 `say(text)` 工具** —— 因为 P0 不允许自主发言。
LLM 的说话只有一个出口：意图 JSON 里的 `say` 字段，**且只在「玩家叫了它」这一轮里有效**。
这样"说话"永远是对玩家的回复，不可能变成自发行为。

**P0 不做的工具**：`say` / `craft` / `build` / `store` / `hunt` / `light` / `fish`（已取消）/ `web_search`（明确排除）。

### 5.4 `list_capabilities()` —— 能力自省（**很重要**）

LLM 需要知道**当前 body 下什么做不到**，否则会反复承诺无法完成的事。

```
go_to  ✅ 可用（寻路，±24 格网格内可规划，超范围会迭代再规划）
chop   ✅ 可用（原木 → 走 → 挖 → 捡）
mine   ✅ 可用（需要镐；无镐则明确失败，P0 不做合成）
collect ✅ 可用（走过去捡附近的掉落物）
stop   ✅ 可用
craft  ❌ 客户端模式下不支持（supportsCrafting = false）
store  ❌ 不支持（Mod 无容器 API）
hunt   ❌ 不支持（看不到被动生物）
light  ❌ 不支持（无光照字段）
fish   ❌ 已从 P0 范围移除
say    ❌ 只能作为对玩家的回复，不能主动说话
```

⇒ LLM 收到「帮我做个石镐」时，应该回答「我做不到合成喵，但我可以去挖石头」，而不是承诺然后失败。

### 5.5 Fallback Router（**没有它整个系统就不算可靠**）

| 情况 | 行为 |
| --- | --- |
| 没有 API key | `LlmCore.enabled = false`；**正则路由接管** |
| 请求超时（8s） | 用正则路由处理这条消息 |
| 返回非法 JSON | 丢弃，用正则路由；记 trace |
| 日 token 超限 | 关闭 LLM 并公告一次；正则路由继续 |

正则路由复用**已有的 `ChatController.onGoal()`**（中英双语正则，已实现），
把动作域收敛到 `go_to` / `chop` / `mine` / `collect` / `stop` 五个。

**⇒ 保证：无论 LLM 是否可用、是否超时，`!chop 32` 和「@猫娘 砍点树」都能工作。**

### 5.6 事件驱动的后续动作（替代"等待"这种不可靠模式）

```js
// Brain 在任务结束时发事件
this.emit('task:done',   { name, reason, result });
this.emit('task:failed', { name, reason });

// LlmCore 订阅：只有「LLM 派发的任务」完成时才唤醒它做后续
brain.on('task:done', (info) => {
  if (info.source !== 'llm') return;      // 规则表自己的任务不打扰 LLM
  this.wake({ trigger: 'task-done', info });
});
```

**为什么需要它**：砍 32 根木头可能 3-5 分钟。LLM 不该阻塞等待，也不该轮询。
「去砍点树，然后回来告诉我」这种请求需要 LLM 在任务结束后**再说一句话**。

**⭐ 但它有一个硬边界（本次修订新增）**：
唤醒后的 LLM 回合**只能追加"继续完成同一个玩家请求"的动作或回复，不能发起新意图**。
判定规则：

```
原始请求: "@猫娘 去砍点树，砍完告诉我"
  ↓ LLM 回合 1 → chop{32}
  ↓ 任务完成（3 分钟后）
  ↓ LLM 回合 2（被事件唤醒）→ say "砍完啦，32 根云杉原木喵"   ✅ 允许（是同一个请求的收尾）
  ↓ 若回合 2 产出新任务（如 chop{32} 再来一轮）→ ❌ 拒绝，除非玩家在原始请求里说了"直到…"
```

**P0 限制**：每个原始请求最多 **2 轮** LLM（1 轮决策 + 1 轮收尾）。
没有"玩家请求"上下文的 LLM 回合**一律不允许产生动作** —— 这是"不自主行动"的机制保证。

### 5.7 三层优先级（`Brain.enqueue`，约 80 行）

| 级别 | 来源 | 语义 |
| --- | --- | --- |
| `URGENT` (0) | 面板急停、`!stop`/`!pause` | 取消当前任务 + 清空队列 |
| `DIRECTIVE` (1) | 面板/聊天指令、LLM 派发 | **抢占 `AUTONOMOUS`，但不抢占其他指令** |
| `AUTONOMOUS` (2) | 规则表、LLM 自主规划 | 排队 |

**关键规则：同级别不互相抢占**（连发两条指令 → 排队，不互相取消）。详见 `CONTROL-PANEL-IMPLEMENTATION.md` §3。

---

## 六、交付物 B：三原语与任务

### 6.1 `HarvestTask` 抽象基类（约 130 行）—— 消除砍树/挖矿的重复

现在 `GatherWoodTask` 已经是纯 Body 实现（是参考实现），`MineTask` 也是。抽出一个共同基类：

```js
/**
 * 「找 → 走近 → 采集 → 验证 → 循环」的通用骨架。
 * 子类只需提供 isTarget(name) 和可选的 canHarvest(block)。
 */
class HarvestTask extends Task {
  constructor(ctx, options) {
    super(ctx, { timeoutMs: options.timeoutMs || 180000 });
    this.target = options.count || 8;
    this.searchRadius = options.searchRadius || 48;
    this.collected = 0;
    this.failedTargets = [];      // 够不着的目标，避免反复尝试
  }

  // 子类必须实现
  isTarget(name) { throw new Error('not implemented'); }
  canHarvest(block) { return true; }

  /** @returns {number} 已获得数量（用于 progress 与零进展检测） */
  progress() { return this.collected; }

  async run() {
    // 1. 感知延迟容忍：找不到目标先等 3s（刚连接时视野不全）
    // 2. 主循环（guard 上限）:
    //      findTargets() → 按距离排序，跳过 failedTargets
    //      body.moveTo(target, {range:1})  ← ★ 走新的寻路
    //        ├─ noPath/blocked → 加入 failedTargets，试下一个
    //        └─ arrived → body.dig() → 验证掉落 → collected++
    //      collectDrops()
    //      checkpoint()
    // 3. 判定：
    //      达标 → succeed
    //      零收获 → succeed('附近没有可采集的目标')   ← 避免规划器无限重排
    //      有收获但不够 → fail（交给 quarantine）
  }
}
```

**继承 `GatherWoodTask` 的既有优点**（这些是踩坑换来的，必须保留）：
- 找不到目标先 `sleep(3000)` 等世界数据
- 连续 3 次走不到 → 放弃这片区域
- **零收获返回成功**（否则规划器在少树地图上无限重排）
- `chopTree()` 沿树干连挖（最多 12 节）
- `collectDrops()` 走过去捡掉落物

### 6.2 `ChopWoodTask`（约 40 行）

```js
class ChopWoodTask extends HarvestTask {
  isTarget(name) { return isLog(name); }        // 复用 src/world/items.js
  // 树干处理：挖到之后检查正上方是否还是原木
}
```

### 6.3 `MineBlockTask`（约 60 行）

```js
class MineBlockTask extends HarvestTask {
  constructor(ctx, options) {
    this.blockNames = [].concat(options.block);   // 支持 ['iron_ore','deepslate_iron_ore']
  }
  isTarget(name) { return this.blockNames.some((n) => bare(n) === bare(name)); }

  canHarvest(block) {
    // 复用 world.canMine() + mods.isMineable()（未知 Mod 方块的安全门）
  }

  run() {
    // 前置：需要镐。没有 → 明确失败「需要一把镐」
    //       （P0 不做合成，所以是 fail，不是自动补）
    // 无目标时：挖一条 4 格竖直探井（复用 MineTask 的 probeShaft 思路）
  }
}
```

**P0 的诚实边界**：没有镐就明确失败并告知，而不是尝试自动合成（合成不在 P0 范围）。

### 6.4 三原语组合模型（P0 的全部能力）

用户拍板：**取消钓鱼**，Bot 只需要 **行走 / 破坏 / 收集掉落物**。这三件事恰好构成一个完整的「资源采集」闭环：

```
        ┌─────────────┐
        │  ① 行走      │  body.moveTo()  → 寻路系统（交付物 A）
        │  walk        │
        └──────┬──────┘
               ▼
        ┌─────────────┐
        │  ② 破坏      │  body.dig()     → 8899 "dig x y z"
        │  break       │  已实测可用（要求距离 ≤4.5）
        └──────┬──────┘
               ▼
        ┌─────────────┐
        │  ③ 收集      │  body.itemDrops() + moveTo() 走过去
        │  collect     │  拾取由客户端自动完成（原版行为）
        └─────────────┘
               │
               └──→ 循环到目标数量
```

**三项能力的实现状态（全部已存在，无需改 Java）**：

| 原语 | 底层 verb / 字段 | 状态 |
| --- | --- | --- |
| ① 行走 | 8899 `moveto x y z range`（连续动作，轮询 `/progress`） | ✅ 已实现。P0 的工作是**给它加上 A\* 规划**（§三） |
| ② 破坏 | 8899 `dig x y z`（连续动作，每 tick 重新 lookAt） | ✅ 已实现，已实测（`client-verify.json` 记录 spruce_leaves → air）。限制：**距离必须 ≤4.5，否则直接返回 false** |
| ③ 收集 | `/state` 的 **`itemDrops`** 数组 | ✅ **已完整实现**，`ClientStateSnapshot.java:189-208` 返回 `{id, item, count, position, distance}`（半径 16 格）；Node 侧 `clientModBody.js:269 itemDrops()` 已接好 |

⇒ **这是取消钓鱼最大的收益：M3 的 Java 补丁整块消失。**

#### 6.4.1 `collectDrops()` 的通用实现（约 60 行，放 `HarvestTask` 里）

```js
/**
 * 走过去把附近的掉落物捡起来。
 * 拾取本身是原版客户端的自动行为（玩家碰撞箱碰到 ItemEntity 就捡），
 * 所以我们只需要"走过去"——不需要任何 pickup 指令。
 */
async collectDrops(options = {}) {
  const radius = options.radius ?? 6;
  const attempts = options.attempts ?? 5;
  let before = this.progress();

  for (let i = 0; i < attempts; i++) {
    const drops = this.ctx.world.nearbyItemEntities(radius);   // 走 BodyWorldView
    if (!drops.length) break;

    // 挑最近的、且不是"捡不到的"（Y 差太大说明掉在够不着的地方）
    const here = this.position;
    const target = drops
      .filter((d) => Math.abs(d.position.y - here.y) <= 2)
      .sort((a, b) => a.distance - b.distance)[0];

    if (!target) {
      this.log.debug('掉落物都在够不着的高度，跳过');
      break;
    }

    // ★ 走新的寻路（不是直线）
    const reached = await this.body
      .moveTo(target.position, { range: 1, timeoutMs: 8000 })
      .catch(() => false);
    if (!reached) this.log.debug(`捡不到 ${target.name} @ ${fmt(target.position)}`);

    await sleep(200);   // 给客户端一 tick 完成拾取
  }
  return this.progress() - before;
}
```

**三个必须处理的现实情况**：

| 情况 | 处理 |
| --- | --- |
| 掉落物掉进水里/沟里 | `moveTo` 返回 `noPath` → 记 debug 跳过，**不阻塞主循环** |
| 掉落物 Y 差 >2 格（掉下悬崖） | 直接跳过（`Math.abs(y - here.y) <= 2` 过滤），否则 Bot 会为了捡一块圆石跳崖 |
| 背包满了 → 掉落物捡不起来 | 检查 `snapshot().emptySlots === 0` → **任务提前失败并说明**（这是「破坏静默失效」的根源：背包满了挖了也白挖） |

### 6.5 `GoToTask`（约 50 行）

```js
class GoToTask extends Task {
  // 支持 {x,y,z} 或地标名 'home'（读 memory.landmark('shelter')）
  // 内部就用 body.moveTo()（已经接了寻路）
  // 失败时把寻路的原因原样报出来（noPath/blocked/out-of-grid）
}
```

### 6.6 任务验收（真实服务器上各 1 次）

| 任务 | 验收 |
| --- | --- |
| **行走** | `!goto <远处坐标>` → 真的走过去，遇障碍会绕 |
| **破坏** | `!mine stone 8`（有镐）→ 8 个圆石；无镐时**明确报「需要一把镐」** |
| **收集** | `!chop 8` → 8 根原木**真的进入背包**（不是只挖掉方块）。日志显示「挖到 X → 走过去捡起 → 背包 Y/8」 |
| **三原语串起来** | 砍一棵 3 格高的树：走过去 → 连挖 3 节 → 走过去捡 3 个掉落物 → 背包 +3 |
| **背包满** | 造一个满背包场景 → 任务**提前失败并说明原因**，而不是无限挖了掉、掉了挖 |
| **够不着的掉落物** | 掉落物在悬崖下 → 记 debug 跳过，**不阻塞主循环、不尝试跳崖** |
| **失败可诊断** | 目标在水对面且无路 → 报 `noPath`，并尝试下一个目标，不挂起 |

---

## 七、配置文件

### 7.1 `config/agent.json`（新增字段）

```jsonc
{
  "body": { "kind": "clientmod" },              // ★ 改成 clientmod
  "clientMod": { "host": "127.0.0.1", "port": 8899, "timeoutMs": 5000 },

  "pathfinding": {
    "maxPathLength": 200,
    "replanEvery": 20,                          // 每走 N 格重规划（扫描半径 24）
    "nodeTimeoutMs": 3000,                      // 单次 A* 计算上限
    "allowSwim": true,
    "allowDig": false,                          // P0 不挖穿障碍
    "waypointRange": 1.0,
    "stuckThreshold": 2                         // 连续几个航点无进展算卡住
  },

  "chat": {
    "prefix": "!",                              // 确定性指令前缀（只认这个）
    "dialogueTrigger": "@猫娘",                  // 自然语言触发词（只认这个）
    "pollIntervalMs": 700,                      // /chatlog 轮询间隔
    "ignoreOtherChat": true,                    // ★ 其它发言一律忽略（P0 固定 true）
    "replyInGame": true,                        // 回话到游戏聊天栏
    "replyOnTaskResult": false,                 // ★ 任务结束后不再补一句（P0 默认关）
    "maxChars": 100,                            // 单句上限
    "minReplyGapMs": 1200                       // 防抖：两次回复最短间隔（防连发刷屏）
  },

  "death": {
    "detectIntervalMs": 500,                    // 轮询 snapshot().dead 的间隔
    "autoResume": false,                        // ★ P0 固定 false：中止后必须手动恢复
    "alertConsole": true,
    "alertPanel": true,
    "alertStateFile": true
  },

  "web": { "bind": "127.0.0.1", "port": null }  // null = bridgePort+1 = 8766
}
```

> **注意 `chat` 段里没有 `maxChatPerMinute` 这类"主动发言限流"** ——
> 因为 P0 不主动发言，限流只需要一个 `minReplyGapMs` 防抖即可。
> 这与眼下 `config/agent.json` 里那三个**死配置**（`publicServerMode` / `respondToChat` / `maxChatPerMinute`，代码里从没被读过）
> 形成对比：新配置项全部**必须真的被消费**，否则不写进文档。

### 7.2 `config/llm.json`（新增，缺失则整个 LLM 层关闭）

```jsonc
{
  "enabled": true,
  "provider": "openai-compatible",
  "baseUrl": null,                    // 优先读 OPENAI_BASE_URL 环境变量
  "apiKey": null,                     // 优先读 LLM_API_KEY / OPENAI_API_KEY
  "model": "deepseek-chat",
  "timeouts": { "intentMs": 8000, "followUpMs": 8000 },
  "limits": {
    "maxTurnsPerRequest": 3,
    "maxToolCallsPerTurn": 4,
    "dailyTokenBudget": 300000,
    "concurrentTurns": 1
  },
  "persona": {
    "name": "小咪",
    "style": "猫娘，每句不超过 40 字，说话带'喵'",
    "honesty": "只说自己观察到的；不认识的方块要承认；不承诺做不到的事"
  },
  "history": { "perPlayer": 8, "global": 30 },
  "trace": { "enabled": true, "file": "runtime/llm-trace.jsonl" }
}
```

**降级矩阵**：

| 缺失 | 后果 |
| --- | --- |
| `llm.json` 不存在 / `enabled:false` | 无自然语言；`!` 指令正常；`@猫娘` 走正则路由 |
| 无 apiKey | 同上，启动时 warn 一次 |
| 请求失败/超时 | 单次降级到正则路由，记 trace |
| 日 token 超限 | 关闭 LLM，公告一次 |

---

## 八、可观测性

| 产出 | 位置 | 内容 |
| --- | --- | --- |
| **LLM 轨迹** | `runtime/llm-trace.jsonl` | 每回合：时间、触发源、prompt 摘要、工具调用、token、耗时、最终动作、是否被守卫拦下 |
| **寻路轨迹** | `runtime/path-trace.jsonl` | 每次 moveTo：起终点、A\* 结果、status、航点数、失败原因 |
| **`GET /ui/state`** | 面板 | 精简状态 |
| **`GET /llm`** | 状态服务器 | provider/model、今日 token、最近 10 回合、限流状态 |
| **`npm run path:test`** | 新脚本 | 离线跑 7 个寻路场景 |
| **`npm run llm:dry`** | 新脚本 | MockBody + 假消息跑一轮意图路由，打印 prompt 与产出（**不连游戏，秒级迭代**） |
| **`npm run selftest`** | 扩充 | 新增 ≥30 项（意图 Schema、工具白名单、寻路场景、任务构造、限流、回声过滤） |

---

## 九、里程碑与工作量

| 里程碑 | 内容 | 约 | 依赖 | 可离线验证 |
| --- | --- | --- | --- | --- |
| **M0** 接线 | `index.js` clientmod 分支 + `botFacade` + AuthMe 自动登录 | 100 行 | — | 部分 |
| **M1** 寻路 | vec3 垫片 + 世界适配器 + 运动模型 + A\* 规划器 + 航点行走器 + 失败分类 | **520 行** | M0 | ✅ **全部** |
| **M2** 三原语任务 | `HarvestTask` 基类（含 `collectDrops()`）+ `ChopWoodTask` + `MineBlockTask` + `GoToTask` | **280 行** | M1 | ✅ MockBody |
| ~~**M3**~~ | ~~Java 补丁~~ **已取消**（三项能力全部已实现，无需改 Java） | ~~40 行~~ **0** | — | — |
| **M4** 输入通道 | `ChatListener`（轮询 + 回声过滤 + 两类输入过滤）+ `reply.js` + `botFacade` + `DeathWatch` | 280 行 | M0 | ✅ 单测 |
| **M5** LLM | `LlmCore` + client + blackboard + intent + fallbackRouter + tools | **600 行** | M4 | ✅ `llm:dry` |
| **M6** 面板 | `/panel` + `/ui/state` + `POST /command{priority}` + 优先级排队 | 330 行 | M4 | 部分 |
| **M7** 加固 | 限流/成本熔断/trace/文档/selftest 扩充 | 200 行 | 全部 | ✅ |
| | **合计** | **≈ 2230 行 JS + 0 行 Java** | | |

> **取消钓鱼带来的缩减**：`FishTask` 150 行 + M3 Java 补丁 40 行 = **净减约 190 行**，
> 并且**彻底移除了唯一需要重新构建 Mod 的环节** —— 全 P0 不再需要 `npm run client:build`。

### 建议执行顺序（按依赖与风险）

```
M0 接线        ← 不做这个后面全部无效
 ↓
M1 寻路        ← P0 的技术核心，且能全部离线验证 → 先拿到确定性
 ↓
M2 三原语任务   ← 行走 + 破坏 + 收集，全部建在 M1 上
 ↓
M4 输入通道     ← 你终于能在游戏里下指令（此时已经能砍树/挖矿了）
 ↓
M5 LLM         ← 自然语言
 ↓
M6 面板        ← 监视与急停
 ↓
M7 加固
```

**两个天然的检查点**：

- **M1 之后**：跑通 `npm run path:test` 的 7 个场景，寻路闭环，**不需要碰 Minecraft**。
- **M4 之后**：`!chop 8` 在真实服务器上能跑通 —— **这是第一个端到端可用的里程碑**，而且此时还没有引入任何 LLM，风险最低。

---

## 十、风险清单

| # | 风险 | 影响 | 缓解 |
| --- | --- | --- | --- |
| **R1** | **24 格扫描半径**限制单次规划长度 | 长距离寻路需要多次规划，可能震荡 | 迭代式再规划 + `replanEvery` + 观测轨迹里的「规划次数」指标 |
| **R2** | `WalkTo` 到达判定**忽略 Y** | 目标在头顶/脚下时误判「到了」 | 航点用 1.0 的 range；寻路器保证航点 Y 正确 |
| **R3** | 世界模型是**快照**，走的过程中会变 | 路径可能撞上刚加载的方块 | 卡死检测触发再规划；`replanEvery` 天然限制陈旧程度 |
| **R4** | **`dig` 要求距离 ≤4.5**（`ClientActions` 里硬编码） | 站得稍远就挖不到 | `HarvestTask` 用 `moveTo(target, {range:1})` 保证贴近；挖失败时重试一次「再靠近」 |
| **R5** | **掉落物捡不到**（掉水里/悬崖下/被方块挡住） | 挖了但背包不增加 —— 看起来像"白挖" | `collectDrops()` 的 Y 差 ≤2 过滤 + `noPath` 记 debug 跳过；**任务成功判定用背包增量而不是挖掉几个方块** |
| **R6** | **背包满**导致掉落物消失 | 挖了完全白挖 | 任务开始前检查 `emptySlots === 0` → 提前失败并说明 |
| **R7** | `ChatLog` **无发送者字段** + 同名 | 无法区分你和 Bot 的话 | 回声指纹过滤（§4.1.3）；触发词用 `!` 而非 `@自己名字` |
| **R8** | `ChatLog` 只有 **50 条** + 无序号 | 高频时漏行、重复消息只触发一次 | 700ms 轮询 + 指纹去重；P1 加 `?since=<seq>` |
| **R9** | **Node 进程挂了 = 失去一切** | 无法控制 | 面板显示 health；保留 8899 手工逃生；P1 加看门狗 |
| **R10** | LLM **幻觉方块名** | 任务失败、浪费 token | `lookup_item()` 先校验；失败进 quarantine |
| **R11** | **提示词注入**（玩家或 Mod 名里藏指令） | Bot 被操纵 | 动作类型是枚举；**没有发服务器指令的工具**；输出过 Schema |
| **R12** | LLM **响应慢**（1-5s） | 游戏内体验差 | 反射层不进 LLM；`!` 前缀走确定性快路径；对话路径与任务路径解耦 |
| **R13** | 成本失控 | 账单 | 日 token 熔断 + 同时 1 回合 + `maxTurnsPerRequest=3` |
| **R14** | `NoPath` 频繁导致任务空转 | 看着在跑其实没进展 | 失败分类 + `failedTargets` 黑名单 + Brain 的零进展检测（已存在） |
| **R15** | **Bot 死后不自动重生**（客户端停在死亡画面） | 状态下是"已死亡"，Bot 一直躺着 | 死亡告警里明确写「请检查游戏窗口是否需要手动点重生」；P1 给 Mod 加 `respawn` verb（需改 Java） |
| **R16** | **死亡误判**（`/state` 短暂拿不到 → 以为死了） | 无谓中止任务 | `tick()` 里 `if (!snap \|\| snap.ready !== true) return;` —— **客户端掉线不当作死亡**；只在 `snap.ready === true && snap.dead === true` 时成立 |
| **R17** | **回话自激循环**（Bot 的话被自己当成新指令） | 无限循环说话 | `reply.js` 的 `sanitize()` 强制剥掉开头的 `!` / `/`；`ChatLog` 回声指纹双保险 |
| **R18** | **`@猫娘` 触发词撞名** | 误触发或漏触发 | 触发词可配置；不要用 `@AgentSteve`（与 Bot 自身回声同名）。判定用「行首出现触发词」，而不是包含匹配 |

---

## 十一、明确的 P0 边界（写下来防止范围蔓延）

### 做
- ✅ Node 侧 A\* 寻路 + 航点行走 + 失败分类
- ✅ **三个动作原语：行走 / 破坏 / 收集掉落物**
- ✅ 两个采集任务 `ChopWoodTask` / `MineBlockTask`（+ `GoToTask` 作为基础设施）
- ✅ 游戏内聊天框输入 —— **只认两类**：`!` 确定性指令 + `@猫娘` 自然语言；**其它发言一律忽略**
- ✅ 输出 —— **纯反应式**：只在被叫到时回一句；**无自主发言、无状态触发器**
- ✅ **死亡处理** —— 检测死亡 → 中止一切任务（含暂停自主规划）→ 界面外三处告警 → **不自动恢复**
- ✅ 外部面板（状态 + 指令 + 急停 + 死亡横幅）
- ✅ LLM 意图路由 + 猫娘人格 + 有边界的任务收尾回复
- ✅ 三级优先级
- ✅ 无 LLM 时的正则降级（保证永远可用）
- ✅ 6 个工具（observe / find_blocks / lookup_item / do_task / go_to / stop）—— **刻意无 `say`**

### 不做（P1+）
- ❌ **自主发言 / 状态触发的主动聊天**（本次明确排除）—— 包括"快死了也不喊"
- ❌ 对玩家其它发言的回应（只有 `!` 和 `@猫娘` 两类会触发）
- ❌ **钓鱼（本次取消）** —— 需要鱼漂实体数据，而砍掉它正好让 M3 Java 补丁整块消失
- ❌ 死亡自动重生（需要改 Mod 加 `respawn` verb）
- ❌ 合成链、熔炼、建造、容器存取、打猎、点灯（各需要额外能力）
- ❌ 联网搜索、Mod 知识 Web 检索
- ❌ 长期对话记忆 / 对话服务
- ❌ 复杂任务分解（多步骤计划、蓝图解释器）
- ❌ 多 Bot、领地系统、交易、附魔、下界/末地
- ❌ 技能库（SKILL.md）、插件市场的完整形态
- ❌ 自动合成工具（没镐就明确失败并告知）

---

## 十二、需要你确认的两件事

| # | 问题 | 影响 |
| --- | --- | --- |
| ~~Q1~~ | ~~M3 的 Java 补丁你能重编吗？~~ **已作废** —— 取消钓鱼后 P0 不再需要任何 Java 改动 | — |
| **Q1** | **LLM provider 与 key** —— 环境里有 `OPENAI_BASE_URL` 但没有 key | 决定 M5 用什么模型；建议先用最便宜的模型把链路跑通。**没有 key 也能做 M0-M4**（正则路由兜底） |
| **Q2** | **触发词** —— 我建议 `!` 给确定性指令、`@猫娘` 给自然语言 | 名字可换；不建议用 `@AgentSteve`（会与回声混淆） |

---

## 附：关键接口速查（实施时对照）

| 新增/修改 | 文件 | 依赖的现有接口 |
| --- | --- | --- |
| 新建 | `src/pathfinding/{vec3util,clientWorldAdapter,movementsAdapter,planner,walker}.js` | `mineflayer-pathfinder/lib/{astar,goals}.js`、`vec3`、`src/world/items.js` |
| 新建 | `src/tasks/{harvest,chopWood,mineBlock,goTo}.js` | `Task` 基类、`Body` 契约 |
| 新建 | `src/body/botFacade.js` | `Body` 契约 |
| 新建 | `src/chat/chatListener.js` | `ClientModBody.readChat()` |
| 新建 | `src/llm/*`（8 个文件） | `body.snapshot()`、`brain.enqueue`、`mods.*`、`ctx.*` |
| 新建 | `scripts/{path-test,llm-dry}.js`、`config/llm.json` | — |
| **改** | `src/index.js` | 加 clientmod 分支（约 40 行） |
| **改** | `src/body/clientModBody.js` | 加 `readChat()`；`moveTo` 接寻路；`equip` 走已有的 `select` verb |
| **改** | `src/brain.js` | 加 `enqueue(task,{level,source})` + 事件发射 |
| **改** | `src/web/statusServer.js` | 加 `/panel`、`/ui/state`、`priority` |
| **改** | `src/chat/commands.js` | 挂载点从 `bot.on('chat')` 换成 `ChatListener`；`stop`/`pause` 标 `URGENT` |
| **改** | `src/util/config.js` | 加载 `config/llm.json` |
| **改** | `scripts/selftest.js` | 新增 ≥30 项 |
| ~~改（Java）~~ | ~~`mod-client/.../ClientStateSnapshot.java`~~ | **不再需要**（`itemDrops` 已存在且已接好） |
| ~~改（Java）~~ | ~~`mod-client/.../ControlHttpServer.java`~~ | **不再需要**（P0 不用 `attack`/`place`） |

---

## 十三、取消钓鱼后的核实结论（本次修订的依据）

用户拍板取消钓鱼、只保留「行走 / 破坏 / 收集掉落物」后，我逐项核实了这三项能力的实现状态：

| 能力 | 关键证据 | 结论 |
| --- | --- | --- |
| **行走** | 8899 `moveto` verb（`ControlHttpServer.java:421-426`）+ `WalkTo` 连续动作（`ClientActions.java:375-421`）；Node 侧 `ClientModBody.moveTo()`（`clientModBody.js:286-296`）已接好 | ✅ 已实现，**P0 的工作是给它加 A\* 规划** |
| **破坏** | 8899 `dig` verb（`ControlHttpServer.java:427-431`）+ `DigBlock` 连续动作（每 tick 重新 `lookAt`，30s 超时）；已实测：`spruce_leaves → air`（`client-verify.json`） | ✅ 已实现。唯一限制：**发起前要求距离 ≤4.5**，所以要先贴近 |
| **收集** | `ClientStateSnapshot.itemDropsJson()`（`ClientStateSnapshot.java:189-208`）返回 `{id, item, count, position, distance}`，半径 16 格；Node 侧 `ClientModBody.itemDrops()`（`clientModBody.js:269-275`）**已解析** | ✅ **已完整实现，无需任何 Java 改动** |

**外加一条**：拾取动作本身不需要指令 —— 原版客户端在玩家碰撞箱碰到 `ItemEntity` 时自动拾取。所以「收集」= **走到掉落物坐标**，而这正好复用交付物 A 的寻路。

⇒ **净结果**：M3 的 Java 补丁整块取消，P0 全流程**不需要运行 `npm run client:build`**，也不需要重启客户端来换 Mod。
那两处 Java bug（`attack` 参数个数、`place` 的 `nth` off-by-one）保留为「P1 顺手修」，**P0 不依赖它们**。
