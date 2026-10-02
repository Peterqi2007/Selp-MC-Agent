# 架构说明：核心模块与数据流

> 本文是对 `<repo>` 的**代码级架构分析**，目的是回答三个问题：
> **它是怎么分层的？每个模块负责什么？一个决策从产生到生效，数据在哪些模块之间流动？**
>
> 结论先行的版本见 [`../README.md`](../README.md)；联机限制见 [`EXTERNAL-SERVERS.md`](EXTERNAL-SERVERS.md)；
> 躯体抽象的设计动机见 [`BODY-ABSTRACTION.md`](BODY-ABSTRACTION.md)。

---

## 一、一句话定位

一个**本机运行**的《我的世界》生存 Agent：Node.js 进程承载「大脑」（双循环决策 + 任务队列），
通过**可替换的躯体（Body）**把决策翻译成游戏动作，并配有 PCL2 启动器集成、本地专用服务器编排、
服务端桥接 Mod、客户端控制 Mod 四条外围链路。

它不是一个「LLM 调工具」的 Agent，而是一个**规则驱动 + 反应式反射**的传统行为树/优先级调度系统：
决策逻辑是代码里写死的优先级表（`src/brain.js` 的 `decide()`），
"智能"体现在**失败隔离、卡死自救、Mod 内容保守推断**这些工程细节上。

---

## 二、分层架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L0  外部世界                                                              │
│   原版/Paper/Fabric 服务器        Forge/NeoForge 服务器      PCL2 客户端   │
└───────────┬──────────────────────────────┬───────────────────────────────┘
            │ 原版协议(minecraft-protocol)  │ HTTP(127.0.0.1:8899)
┌───────────▼──────────────┐   ┌───────────▼───────────────────────────────┐
│ L1  躯体层 src/body/      │   │  mod-client/  (Forge 客户端控制 Mod)       │
│   Body 抽象契约           │   │  ControlHttpServer + ClientActions        │
│   ├ MineflayerBody        │   └───────────────────────────────────────────┘
│   ├ MockBody              │
│   └ ClientModBody         │
└───────────┬──────────────┘
            │ snapshot() / moveTo() / dig() / craft() ...
┌───────────▼──────────────────────────────────────────────────────────────┐
│ L2  决策层（与躯体无关，100% 可复用）                                      │
│   src/brain.js     双循环：快反射(600ms) + 慢规划(2.5s) + 优先级规则表      │
│   src/tasks/       8 个任务：砍树/挖矿/合成/狩猎/庇护所/点灯/存放           │
│   src/survival/    AutoEat / Combat / ToolManager                        │
│   src/world/       生存知识表 + 只读世界模型 + 快照库存门面                  │
│   src/mods/        Mod 知识：加载器检测 / 签名分类 / 保守安全门              │
└───────────┬──────────────────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────────────────────┐
│ L3  支撑设施                                                              │
│   src/core/    BotController / Navigator / recovery / memory /           │
│                preflight / network / plugins / lockfile                  │
│   src/util/    config / logger                                           │
│   src/chat/    游戏内 !指令 + 自然语言目标路由                             │
│   src/web/     零依赖状态/控制 HTTP API                                    │
└───────────┬──────────────────────────────────────────────────────────────┘
            │
┌───────────▼──────────────────────────────────────────────────────────────┐
│ L4  运行环境编排                                                          │
│   scripts/run-all.js       服务器 + Agent + 可选 PCL2 三合一启动           │
│   src/server/              serverManager(原版) / forgeServer(Forge)       │
│   src/pcl/                 detect(PCL.ini/PCL config.json/LatestLaunch)   │
│   mod-bridge/              Fabric 服务端桥接 Mod（权威状态 + 白名单指令）   │
└──────────────────────────────────────────────────────────────────────────┘
```

**关键设计约束**：L2 不允许出现任何 mineflayer / Minecraft 类名。
`src/body/body.js` 的注释明确写了这条规则 —— 它是整个抽象层成立的前提。
唯一被容忍的例外是 `Task#bot` 这个访问器（用于 registry 查询）和 `ShelterTask`/`HuntTask`/`LightTask`/`DepositTask`
这几个尚未完全 Body 化的旧任务（见 §九「技术债」）。

---

## 三、核心模块详解

### 3.1 决策层：`src/brain.js`（489 行）—— 项目的心脏

`Brain` 持有两个 `setInterval` 循环和一条**有序规则表**。

#### 快循环 `fastLoop()` — 600ms，纯反射

执行顺序（每步都可能 `return` 提前结束）：

| 顺序 | 判断 | 动作 |
| --- | --- | --- |
| 0 | `paused` 或 `!attached` | 直接返回 |
| 0 | `bodyKind === 'mock'` | 直接返回（脚本世界无物理、无怪） |
| 1 | `safeMode` 开启 | 白天+无敌对 → 退出安全模式；否则每 60s 调 `hideUnderground()` 挖竖井自封 |
| 2 | `needsRescue(world)` 或 `nav.stuckCount >= 3` | 每 30s 最多一次 `escapeToGround()` 物理脱困 |
| 3 | `world.isInDanger()` | `combat.retreat(12)` + 强制进食 |
| 4 | 总是 | `eat.tick()` 自动吃 |
| 5 | 敌对生物 ≤5 格 或 血量 <12 | `combat.defend()`（**先 `preempt()` 取消当前任务**） |
| 6 | 总是 | `tools.equipArmor()` 自动穿甲 |

设计要点：
- **反射优先于规划**：`preempt()` 会 `cancel()` 当前任务并清空队列，但第 2 步的救援刻意加了 `!this.activeTask` 守卫，
  因为救援会取消正在进行的导航，否则会陷入「救援→规划→重试→救援」死循环（注释里明确记录了这一点）。

#### 慢循环 `slowLoop()` — 默认 2500ms（`behaviour.idleThinkIntervalMs`）

```
paused / safeMode / 已有 activeTask  → 返回（串行闸门）
queue 非空                            → drainQueue()
snapshot() 不存在或 !ready            → 返回（先能感知，再规划）
task = decide()                       → null 则记 idleTicks，每 20 次告警一次
runTask(task)
```

#### 规则表 `decide()` — 20 条规则，先命中者胜

感知**全部来自 `body.snapshot()`**，不碰 `bot`：

```js
const snap = world.snapshot(true);
const inventory = new SnapshotInventory(snap.inventory, { emptySlots: snap.emptySlots });
const view = { inventory, health, food, registry };
```

规则用 **thunk（惰性求值）** 写：`{ name, when: () => bool, make: () => Task }`，
`when` 抛异常会被 catch 并跳过该规则（规则级故障隔离）。

优先级表（与 README §3 一致，代码位置 `src/brain.js:252-297`）：

| 优先级 | 规则 | 条件摘要 | 目标任务 |
| --- | --- | --- | --- |
| 5 | deposit | `emptySlots <= 2` | `DepositTask` |
| 10 | hunt | 无食物 且（饥饿 <17 或 血量 <12） | `HuntTask{3}` |
| 20 | gather-wood | 木头 < 4 | `GatherWoodTask{8}` |
| 25 | craft | 无工作台 | `crafting_table` |
| 27 | craft | 无镐 且 木板<3 且 有原木 | `{木头}_planks x4` |
| 27 | gather-wood | 无镐 且 木板<3 | `GatherWoodTask{8}` |
| 28 | craft | 无镐 且 木板≥3 且 木棍<2 | `stick x4` |
| 30 | craft | 无镐 | `wooden_pickaxe` |
| 35 | shelter | 夜晚 + 无庇护所地标 + 建材≥16 | `ShelterTask` |
| 40 | mine | 镐等级<stone 或 无剑，且圆石<3 | `MineTask{stone,cobblestone,8}` |
| 41 | craft | 需要但木棍<2 | `stick x4` |
| 42 | craft | 镐等级<stone | `stone_pickaxe` |
| 43 | craft | 无剑 | `stone_sword` |
| 45 | light | 无火把 且 有煤/木炭 | `LightTask{4}` |
| 47 | mine | 无熔炉 且 圆石<8 | `MineTask{8}` |
| 48 | craft | 无熔炉 | `furnace` |
| 50 | hunt | 食物 < 3 | `HuntTask{3}` |
| 55 | craft | 有铁料且铁锭<3 | `iron_pickaxe` |
| 56 | mine | 镐≥stone 且 铁锭<3 | `MineTask{iron_ore,3,240s}` |
| 60 | gather-wood | 木头 < 16 | `GatherWoodTask{16}` |
| 62 | light | 有煤/木炭 | `LightTask{6}` |
| 70 | mine | **恒真（兜底）** | `MineTask{stone,16}` |

`plankName(view)` 从**手上真实持有的原木**推导木板种类（`spruce_log → spruce_planks`），
再查 registry 确认存在 —— 这是修掉「14 个云杉原木却报 no recipe for wooden_pickaxe」那个坑的核心。

#### 三道防死循环机制（这是 Brain 最有价值的部分）

1. **串行执行闸门 `activeTask`**
   `runTask()` 发现已有 `activeTask` 就把新任务压入 queue 并返回。
   没有它，慢循环 / 重试定时器 / 反射层会同时驱动 pathfinder，互相 `stop()`，
   日志里瞬间刷满几百条同一坐标的 `goto failed`。

2. **重试 + 隔离（quarantine）**
   失败 → `maybeRetry()`；超过 `maxRetries`（默认 2）→ 记 `failCounts`，
   隔离窗口 `min(120s, 20s × strikes)`。隔离期间 `decide()` 跳过同名规则。

3. **零进展检测 `_noteProgress()`**
   任务「成功」但 `progress()` 值不变 → 累计 `_stalls`；
   连续 2 次无进展 → 停 30 秒。
   注释里的真实案例：地图上只有两棵树时 `gather-wood` 会正确地报「附近没树了」（成功），
   但木头数永远达不到目标，规则表就会每 2.5s 静默地选同一个目标 —— 无限循环。

另外 `noteDeath()` 维护 `recentDeaths`（4 分钟窗口），**≥2 次死亡 → SAFE MODE**。

---

### 3.2 任务层：`src/tasks/`

#### `Task` 基类（`task.js`）的契约

| 成员 | 语义 |
| --- | --- |
| `execute()` | **唯一入口**。`Promise.race([run(), timeout])`，保证永不挂死；catch 一切异常；返回归一化 `{ok, reason}` |
| `run()` | 子类实现，返回 `{ok,reason}` / string / bool / undefined 都行（`normalizeResult` 归一化） |
| `state` | `pending → running → done/failed/cancelled` |
| `cancel()` | 置 `cancelled = true` 并调 `ctx.nav.interrupt()` |
| `progress()` | 单调递增的进度指标，供 Brain 的零进展检测使用 |
| `checkpoint()` | 写入 `memory.recordTask()` 持久化 |
| `timeoutMs` | 硬超时，默认 60s（各任务自己覆盖：砍树 180s、挖矿 180s、狩猎 150s、庇护所 120s） |
| `maxRetries` | 默认 2 |

**Body 感知辅助成员**（任务不碰 mineflayer 的关键）：
`this.body`、`this.world_state`（= `body.snapshot()`）、`this.inventory`（`SnapshotInventory` 门面）、
`this.position`、`this.countItem()`、`this.countWhere()`、`this.countLogs()`。

> 命名坑（文档里记了两次）：计数方法叫 `countItem()` 而不是 `count()`，因为 `this.count` 是「要合成几个」的数字，
> 实例属性会**静默遮蔽同名原型方法**。同样地 `Body` 的吃东西方法叫 `consume()` 而不是 `eat()`，
> 因为 `MineflayerBody` 把 AutoEat 系统存在了 `this.eat` 上。

#### 七个任务

| 任务 | 核心流程 | 关键修补与实测细节 |
| --- | --- | --- |
| **GatherWoodTask** (`gatherWood.js`) | 找最近原木（半径 48）→ `moveTo(range:1, 20s)` → `chopTree()` 沿树干向上连挖最多 12 节 → `collectDrops(4)` 捡掉落 → 循环（guard 40 次） | ①进入时若「看不到树」先 `sleep(3000)` 等世界数据（刚连接时感知不完整）②**连续 3 次走不到树 → 放弃这片林子**（`failedWalks >= 3`）③找不到树时随机漫游 ±20 格、12s ④**零收获时返回「成功」**（`no trees available nearby`），否则规划器会在少树地图上永远重排同一目标 ⑤`dominantWood()` 是木材变体匹配的入口 |
| **MineTask** (`mine.js`) | 前置门禁（无镐直接失败）→ `equipBest('pickaxe')` → `checkTier()`（仅黑曜石/远古残骸要求钻石级）→ `findNearbyBlockNames(names, 32, 12)` → 逐个 `canMine` + `moveTo` + `dig` → 循环（guard `wanted*6+20`） | ①找不到目标时 `probeShaft()` 挖 **4 步**竖直探井（挖头+脚两块，跳过 air/bedrock/water/lava）②一轮一块没挖到就 `sleep(300)` + 随机漂移 ±8 格，避免反复扫同一处 ③区域耗尽且已挖到一些 → 报「成功」 |
| **CraftTask** (`craft.js`) | `tryCraft()` → 失败则 `prepareIngredients()` 补前置 → **重试一次** → 按**库存增量**（不是 body 返回码）判定成败 | **前置补齐**：`NEEDS_PLANKS`（11 项：crafting_table/chest/stick/fence/door/boat/bowl/barrel/bookshelf…）和 `NEEDS_STICKS` 正则（`_pickaxe$|_axe$|_shovel$|_sword$|_hoe$|torch$|bow$|arrow$|fishing_rod$|ladder$|_sign$`）；`craftIntermediates('planks')` 会**为手上每一种原木各合成对应木板**（配方要求同种木材）；`depth < 3` 递归保护 |
| **HuntTask** (`hunt.js`) | 扫描 40 格内 `FOOD_ANIMALS`（cow/pig/chicken/sheep/rabbit/salmon/cod/tropical_fish，支持 `_<name>` 后缀变体）→ `combat.attack(15s)` → `collectNearbyDrops` → 循环（guard 60） | **只打被动生物**，绝不主动招惹敌对怪；找不到动物就随机游走 ±30 格；成败判定 = `attack()` 返回 true **或食物数量增加**；⚠️**直接读 `ctx.bot.entities`**（未 Body 化） |
| **ShelterTask** (`shelter.js`) | 选建材（`BUILD_MATERIALS` 18 种，取数量最多者，<12 个直接失败）→ 平整 3×3 → 两层墙（南侧 `{x:0,z:1}` 留门，已有方块跳过）→ 封顶 → 内部插火把（非致命） | 判定标准 `countPlaced() >= 8`；⚠️`countPlaced()` 统计区域内**任意** `BUILD_MATERIALS` 方块（含地形原有泥土/石头）→ **可能「假成功」**，靠 Brain 的零进展检测部分兜住；⚠️**未 Body 化** |
| **LightTask** (`light.js`) | `ensureTorches()`（无火把 → 煤/木炭 + 木棍合成，需要时先原木→木板→木棍；`want = min(4×coal, 16)`）→ 在 8 个候选格插火把 | **只在光照 ≤ `torchLightLevel`(4) 时插**，否则直接结束；插失败随机挪 ±3 格（火把容易被台阶/植物挡住）；⚠️**未 Body 化** |
| **DepositTask** (`deposit.js`) | 找 32 格内容器 → 没有就合成（8 木板）并放置箱子（放置后**回读校验** `/chest\|barrel/`）→ `gotoTouchable` → `openContainer` → 逐个 `deposit` → `finally` 里 `container.close()` | 保留清单 `DEFAULT_KEEP`(16 项：工作台/熔炉/火把/煤/木棍/熟食/苹果/水桶/盾) + `isTool()` 正则命中的工具护甲不存；**背包满会静默破坏挖矿**（掉落物捡不起来），所以这是刚需；⚠️**未 Body 化**；`countItem(bot,'chest_planks')` 是不存在的物品名（恒 0，短路到 `countPlanks()`），属笔误 |

---

### 3.3 生存层：`src/survival/`

| 模块 | 职责与关键逻辑 |
| --- | --- |
| **AutoEat** (`autoEat.js`) | `tick(force=false)` 返回「是否真的吃了」：`eating` 重入锁 → 检查 `autoEat` 开关 → `needsFood()`（`food <= eatFoodThreshold`，默认 16）→ `chooseFood()` 按 `FOOD_PRIORITY` 25 项排序（`score = 25 - index`，其次按数量）。**饿到 ≤6 才允许吃生肉**（`RAW_FOODS` 8 项），否则过滤生食；但**只有生肉时无论饿不饿都会吃**（`pool` 为空的兜底）。`force=true` 一次性绕过三个门禁（`autoEat` 开关 / 饥饿阈值 / 已饱食 20），用于 `!eat`、Brain 的危险反射、`MineflayerBody.consume()`。无食物时告警做 **20s 限流**（快循环 600ms 一次会刷屏） |
| **Combat** (`combat.js`) | `strength()` 启发式 = 武器等级/6 × 0.7 + 护甲件数/4 × 0.3（clamp 到 [0,1]）。`shouldFlee()` 四条依次：①`NEVER_FIGHT`（**苦力怕/监守者/凋灵/末影龙/远古守卫者**）**永远跑** ②血量 ≤ `fleeHealthThreshold`(6) ③`DANGEROUS` **21 种**怪 且 strength<0.5 ④10 格内 ≥3 敌 且 strength<0.4。`attack()` 循环：先 `shouldFlee` → 距离>4 就 `goto(range:2, 6s)`，**goto 失败且已过半程就放弃**（防「路径不可达的无限决斗」）→ `lookAt` + `attack` + **35% 概率跳劈** + 每轮 400ms。`flee()` 在 12 个方向 × 半径 12 格里挑「离威胁最远」的点。⚠️400ms 挥击低于 1.9+ 攻击冷却（≈625ms），DPS 有折损 |
| **ToolManager** (`toolManager.js`) | `equipForBlock()` 优先交给 `mineflayer-tool` 插件，失败则按方块名分类（`_log\|_stem\|_planks\|_wood → 斧`，`dirt/sand/gravel/clay/soul_soil/_concrete_powder → 锹`，**其余一律镐**），回退链 `bestTool(kind) → bestTool('pickaxe') → bestTool('axe')`。`equipArmor()` 优先 `armorManager.equipAll()`，降级到手工按 `head/torso/legs/feet` 槽位选 `armorRank` 最高者。`dropJunk()` 丢砂砾/燧石/安山岩等最多 8 堆（保留工具、护甲、火把、工作台、熔炉、木板、原木）。⚠️`armorRank` 用 `TOOL_TIERS` 索引 ⇒ **`golden`(3) > `iron`(2)，会优先穿金甲**；`leather`(-1) < `chainmail`(0) |

---

### 3.4 世界模型层：`src/world/`

| 模块 | 说明 |
| --- | --- |
| **`items.js`** | 生存知识表（纯数据 + 纯函数）：`FOOD_PRIORITY`(25)、`RAW_FOODS`(8)、`FUELS`(24)、`LOG_BLOCKS`(11)、`TOOL_TIERS`(`wooden→stone→iron→golden→diamond→netherite`，索引即 rank)、`TOOL_KINDS`(5)、`PICKAXE_REQUIRED`(46 个方块名)、`PASSABLE`(65)。`isLog()` 除了查表还兜底 `/_log$/`、`/_stem$/` 正则（Mod 木头也能识别）。`bestTool(bot, kind)` **接受任何有 `.inventory.items()` 的对象** —— 真实 bot 或 `SnapshotInventory`，这是任务层能跨 Body 复用的关键之一。`foodScore(name) = 25 - index`，**表外食物返回 -1**（这就是 Mod 食物永远排最后的原因） |
| **`worldView.js`** | mineflayer 专用只读视图。`blockAt(x,y,z)` 是**相对偏移**（历史包袱），`blockAtAbsolute(position)` 才是绝对坐标；`canMine()` 会先问 `mods.isMineable()`；`hostiles()` / `nearbyItemEntities()` / `nearestContainer()` / `lightLevel()` / `isInDanger()` |
| **`bodyWorldView.js`** | **同一个 API 的 Body 后端版本**。`snapshot()` 带 `_last` 缓存（一个 tick 内重复读很便宜）；`matchNames()` 在**谓词两侧都剥命名空间**（修掉「传 `stone`，body 报 `minecraft:stone`，匹配不上 → 附近没有石头」）；`summary()` 与 `WorldView` 同形状，所以日志和 HTTP API 无需改动 |
| **`snapshotInventory.js`** | 把 `{name: count}` 快照伪装成 mineflayer inventory 接口（`items()` / `emptySlotCount()` / `count()` / `find()` / `filter()` / `has()`），名字统一剥命名空间。让 `countItem` / `countMatching` / `bestTool` 和整张规则表原样工作 |

---

### 3.5 躯体层：`src/body/`

#### 契约（`body.js`，264 行）

五条设计原则，每条对应一次真实踩坑：

| 约定 | 原因 |
| --- | --- |
| 每个方法 `async` 且**必须 settle** | 躯体自己负责超时，绝不能把大脑挂死 |
| 不支持的能力抛 `BodyUnavailableError` | 决策层据此**降级**而不是崩溃 |
| `snapshot()` **不阻塞**，返回最近缓存 | 真客户端只能在 tick 里更新状态 |
| 接口里**不出现任何 mineflayer / Minecraft 类名** | 否则抽象层白做 |
| `interrupt()` 同步且可重复调用 | 反射层要能随时打断 |

**感知**：`snapshot()` → `StateSnapshot`（含 `ready/position/dimension/health/food/onGround/time/weather/inventory/emptySlots/heldItem/standingOn/lightLevel/hostiles/nearbyItems/players`）、`blockAt`、`findBlocks`、`findBlocksMatching`、`hostiles`、`itemDrops`

**动作**：`connect`/`disconnect`/`isReady`、`moveTo`、`dig`、`place`、`equip`、`eat`、`attack`、`chat`、`lookAt`、`interrupt`

**可选能力**：`craft()` + `supportsCrafting`、`canMine()`、`depositInto()`

#### 三个实现

| 实现 | 文件 | 特点 |
| --- | --- | --- |
| **MineflayerBody** | `mineflayerBody.js` (483 行) | **刻意做成「包装」而不是「重写」**：包住现有 `BotController`/`Navigator`/`WorldView`/`Combat`/`AutoEat`/`ToolManager`，所以调好的行为（pathfinder latch 恢复、空路径检测、物理脱困、任务串行化）一行不动。暴露收窄的逃生口 `body.raw`。`craft()` 里的配方选择顺序是「背包 2×2 → 附近可达工作台 → 手上工作台」，并在产出为 0 时重放工作台重试一次 |
| **MockBody** | `mockBody.js` (415 行) | 脚本化假世界：平坦地面 + 可配方块表 + 无限移动 + 瞬间挖掘 + `DEFAULT_RECIPES` 11 条配方表。带 `history[]` 动作日志和 `stats{}` 计数器供断言。**这是抽象层的回报**：让「决策逻辑」在没有服务器的情况下秒级迭代 |
| **ClientModBody** | `clientModBody.js` (531 行) | 通过 HTTP `127.0.0.1:8899` 驱动**真实 Forge 客户端**。`snapshot()` 返回 400ms TTL 的缓存；`moveTo`/`dig` 是**连续动作**（客户端 tick 驱动），所以 `command()` 之后轮询 `/progress` 直到 `busy === false`；`awaitAction()` 超时会主动发 `stop` |

`ClientModBody` 的两个安全细节：
- `isForbidden()` 静态方法：`/register` / `reg` 在 **Node 侧**也被拦（`/register` 会**重置角色数据**，清空经验和背包）。
- `chat()` 的路由规则：以 `/` 开头的字符串**本身就是指令**，走 `cmd <原样>`；否则走 `chat <文本>`。
  现场实测发现 `ClientPacketListener.sendCommand()` **不会**自动补前导斜杠，所以必须剥掉，否则 `'/login pw'` 会变成 `'//login pw'`。

#### 工厂 `factory.js`

`createBody(cfg, deps)` 读 `cfg.agent.body.kind`（或 `--body` / `MC_BODY`）：
- `mineflayer` → 直接可用
- `mock` → 用 `cfg.agent.body.mockBlocks` 或默认的「4 棵树 + 3 块石头」世界构造；`reason: 'scripted world - no real gameplay'`
- `clientmod` → `require('./clientModBody')` 失败则 `usable: false` + 明确原因（**不假装连上了**）
- 未知 kind → 告警并回退 mineflayer

---

### 3.6 核心支撑：`src/core/`

| 模块 | 职责与要点 |
| --- | --- |
| **`bot.js` BotController** | 持有 mineflayer 实例与连接生命周期。监听 `spawn/death/respawn/health/kicked/error/end/message` 并转成自己的 EventEmitter 事件。**插件通道嗅探**：在 `bot._client` 的 `packet` 事件里抓 `custom_payload` 的 channel（`fml:*`/`forge:*`/`fabric:*`）和 `server_data` 的 brand —— 这是识别加载器**唯一可靠**的信号（Forge 服在无内容 Mod 时版本串仍写 `1.20.1`）。`rearmPathfinder()` 解决 pathfinder 闭包 latch 问题。`guarded(promise, timeout, label)` 给任意操作加超时。`snapshot()` 输出状态供状态 API 使用 |
| **`movement.js` Navigator** | `refreshMovements()`：`canDig` 默认关、`allowParkour` 默认关、`maxDropDown: 4`、`dontMineUnderFallingBlock: true`、脚手架方块白名单。`goto()` 处理三种经典失败：①已满足的 goal 直接返回（避免 A* 空路径 reject）②`armed` 标志确保首次 goto 前 re-arm ③**goto 成功后对比出发坐标，移动 <1 格判定失败**并 `stuckCount++`。`_warnOnce()` 对同坐标/同错误做 5 秒抑制并统计压掉条数。另有 `digBlock()`（选最佳工具 + 等 `blockUpdate` 确认方块真的消失）、`collectNearbyDrops()`、`placeBlockAgainst()`、`equipBest()` |
| **`recovery.js`** | `needsRescue(view)` **刻意保守**（误判比漏判贵）：站在树叶上 / 卡在实心方块里 / 悬空且下方 3 格无立足点 / 头顶实心且四面被封 / 头部被堵。`escapeToGround()` 四级降级：向下寻路 → 四方向手动走各 2.5s → 垂直下挖最多 6 格 → `climbOut()` 挖天花板 + 跳放垫脚石柱。`hideUnderground(depth=3)` 挖竖井 + 封顶（SAFE MODE 用） |
| **`memory.js`** | 跨会话持久化到 `runtime/agent-state.json`：`sessions`、`deaths`、`taskHistory`(上限 400)、`stats{}`、`landmarks{}`、`blacklist[]`。`bump()` / `recordTask()` / `rememberLandmark()` 都会立即落盘。损坏的 JSON 永不阻塞启动 |
| **`preflight.js`** | **手写的 Server List Ping**（自己实现 VarInt 编解码 + handshake 包），不占登录名额、不触发风控。返回 `{connect, reason, advice[], details}`；从 MOTD + 版本串里嗅探 `NeoForge/Forge/Fabric/Paper`；人满 → `connect: false`；协议号不匹配 → 给建议 |
| **`network.js`** | `parseProxy()` 支持 `socks5/socks5h/socks4/socks4a/http/https`，裸 `host:port` 默认按 socks5。`createProxyAgent()` 返回 minecraft-protocol 期望的 **agent 函数**（返回 socket）。HTTP 代理走自己实现的 `CONNECT` 隧道（读 `\r\n\r\n` + 校验 200），不引入额外依赖。`buildAuthOptions()` 区分 `offline` 与 `microsoft`（设备码登录，`onMsaCode` 回调打印提示，token 缓存在 `runtime/auth-cache`） |
| **`plugins.js`** | 5 个**全部可选**的 mineflayer 插件：pathfinder / collectblock / tool / armor-manager / hawkeye。缺包只告警并降级，不崩 |
| **`lockfile.js`** | 单实例锁 `runtime/agent.lock`（写 PID + username + host + 启动时间）。`isAlive(pid)` 用 `process.kill(pid, 0)`，把 `EPERM` 也算存活。同名账号双开会触发服务端 `duplicate_login` 踢人循环，这个锁就是为了根治它 |

---

### 3.7 Mod 知识层：`src/mods/knowledge.js`（419 行）

三层策略，应对「mineflayer 的 registry 只认识原版内容」这个硬事实
（1.20.1：1255 物品 / 1003 方块，Mod 内容的硬度、掉落、配方**无法向服务端查询**）：

1. **DETECT** `scan(bot)` → `detectLoader()`
   判定顺序：plugin channel 含 `neoforge` → `neoforge`；含 `fml:`/`forge:handshake`/`forge:registry` 或版本串/brand 含 forge → `forge`；含 `fabric` → `fabric`；命名空间里有 `forge` → `forge`；有非原版命名空间但认不出 → `modded (loader unknown)`；否则 `vanilla`。
   同时统计 `namespaces`、`unknownItems`，并把结果写进 `config/mod-knowledge.json` 的 `servers{}`（**越玩越准**）。

2. **CLASSIFY** `classify(name)` — 40+ 条有序正则签名（**首条命中者胜**）：
   - 物品：`_ingot`/`_nugget`/`_dust`/`_plate`/`_gear`/`_gem`/`_raw_`/`_pickaxe`/`_helmet`/`_seed`/`_berries`/`_(soup|stew|pie|…)$`/`^(roast|baked|fried|…)_`/`_bottle`/`_upgrade`/`_key`/`_(workbench|table|kiln|…)$` …
   - 方块：`_ore`(需镐) / `_raw_block` / `_(log|wood|stem|hyphae)$`(斧) / `_planks$`(斧) / `_leaves$` / `_crop|_plant|_vine` / `_machine|_generator|_furnace` / `_cable|_pipe|_conduit` / `_tank|_barrel|_chest` / `_bricks?` / `_door|_fence|_wall` / `_(lamp|lantern|light|torch)$`
   - 另有 `KNOWN_NAMESPACES` 表 28 个常见 Mod（Create/AE2/Farmer's Delight/TACZ/Ice and Fire/FTB Chunks/KubeJS…），带名称与风险提示。

3. **SAFE** 保守兜底 —— `isMineable(name)` 是**安全门**：
   - 原版方块：查 registry，`diggable === false` 直接拒
   - 未知 Mod 方块：只有两种情况才允许 —— ①配置显式开启 `survival.mineUnknownModBlocks` ②签名命中 `MODDED_MINEABLE_CATEGORIES`（ore/wood/building/machine/…）
   - 理由：把「不可破坏的科技方块」当石头挖会让机器人卡在无意义的挖掘循环里

`guidance()` 输出可操作建议：检测到 TACZ/Ice and Fire → 「跑而不是打」；检测到 FTB Chunks → 「不要挖别人的领地」。

---

### 3.8 交互层：`src/chat/` 与 `src/web/`

**`chat/commands.js` ChatController** —— 同一张指令表服务两个传输层：
- `attach()` 监听 `bot.on('chat')`，**过滤掉自己发的消息**（`username === bot.username`），只认 `cfg.behaviour.chatPrefix`（默认 `!`）
- 19 个指令：`help/status/where/inv/stop/pause/resume/eat/defend/mine/chop/hunt/craft/shelter/light/store/goal/goto/follow/home`
- 任务型指令统一走 `ctx.brain.push(task)`（天然获得「入队 → 串行 → 重试/隔离」全套策略）；即时动作（eat/defend/goto/home/follow）**不进队列**，其中 `goto`/`home` 用 `pause()` / `resume()` 把导航包住，避免 planner 同时抢 pathfinder
- `expandBlockNames()` 别名表：`stone → [stone, cobblestone, deepslate]`、`iron → [iron_ore, deepslate_iron_ore]`、`wood → 6 种原木` …
- `onGoal(text)` 自然语言路由（**中英双语正则**，取文本里**第一个**数字做 count，优先级即书写顺序）：
  `/wood|log|tree|木头|原木|砍/` → `/iron|铁/` → `/stone|cobble|石头|圆石|挖矿/` → `/food|hunt|meat|食物|打猎/` → `/shelter|house|庇护|房子|基地/` → `/light|torch|火把|照明/` → `/store|chest|存|箱子/` → `/craft|合成/`（把动词与数字剥掉、空格转下划线得到物品名）
- `startFollowLoop()` 每 1.5s 检查目标玩家，距离 >4 就 `goto(range:3, 8s, canDig:true, freshMovements:true)`
- ⚠️**没有玩家白名单、没有权限校验、没有速率限制** —— `behaviour.publicServerMode` / `respondToChat` / `maxChatPerMinute` 三个配置项**全项目无消费者**（只有定义与 profile 合并），公共服务器上任何玩家打 `!goal` 都会生效

**`web/statusServer.js`** —— **零依赖** `http.createServer`，只绑 `127.0.0.1`：

| 方法 | 路由 | 返回 |
| --- | --- | --- |
| GET | `/health` | `{ok, alive, state}` |
| GET | `/status` | `{bot, world, brain, inventory, plugins, mods, target, updatedAt}` |
| GET | `/mods` | `{detected, report, guidance, learned:{items,blocks,servers} 计数}` |
| GET | `/inventory` | 物品汇总 |
| GET | `/logs?n=50` | `{lines}`（来自 Logger 的 500 行环形缓冲） |
| POST | `/command` | body `{"command":"..."}` → 复用 `ctx.chat.handle()`，返回 `{ok, command}` |

端口来自 `cfg.server.bridgePort + 1`（默认 8766）；`EADDRINUSE` 时**自动退到 port+1**（不致命，但**没有重试计数**，若 N+1 也被占用会反复进入该分支）。
`readBody` 有 1MB 上限保护（超限直接 `req.destroy()`），JSON 解析失败静默返回 `{}`（于是走 400 分支）。
⚠️`/logs` 取的是**根 logger（`Logger('agent')`）自己的 500 行环形缓冲**；`Logger.child()` 全项目从未被调用，
所以 `new Logger('brain')` / `'eat'` / `'fight'` / `task:*` 这些模块级 logger 的行**不会**出现在 `/logs` 里
（它们只进 `runtime/logs/agent.log` 之外的 stdout）。

---

### 3.9 运行环境层

#### `src/pcl/detect.js` + `launcher.js` —— PCL2 集成（真实生效，非占位）

PCL2 是 GUI 程序，但它把自己的状态摊在磁盘上，可以完全外部化控制：
- `PCL.ini` / `Setup.ini` → 解析出当前选中的版本
- `%APPDATA%\PCL\config.json` → PCL 自己的 Java 注册表
- `LatestLaunch.bat` → **PCL 上次启动用的真实命令行**（可还原完整参数模板）
- `<minecraftDir>` → 版本目录、mods 目录

`launchClient(cfg)` 用 `--launch <版本名>` 启动，等价于人点「启动游戏」。

#### `src/server/serverManager.js` —— 原版专用服务器

- `resolveServerArtifact(mcVersion)`：拉 `launchermeta.mojang.com/.../version_manifest_v2.json`（fallback 到 `piston-meta`）→ 找版本 → 下载 `server.jar`，**带 SHA1 校验**
- `writeEula()` 自动写 `eula=true`；`writeServerProperties()` 写端口/难度/种子/游戏模式/`online-mode`/视距/`allow-cheats` 等
- `spawnServerProcess()` 从 stdout 用正则 `Done \([\d.]+s\)! For help, type "help"` 判定就绪，`You need to agree to the EULA|Failed to start` 判定失败
- `startServer()` 返回 `{ready: Promise, stop(), logFile}`；`withTimeout()` / `waitForPort()` 是通用等待原语

#### `src/server/forgeServer.js` —— Forge 专用服务器

Forge 是 installer 驱动的，vanilla 那套「下载单 jar」不适用：
- 从 `maven.minecraftforge.net/net/minecraftforge/forge` 下载 installer，**SHA1 由官方 `.sha1` sidecar 校验**
- `runInstaller()` 跑 `--installServer`，超时 20 分钟（`FORGE_INSTALL_TIMEOUT_MS` 可覆盖）
- 已知坑：installer 偶尔要求 `server_mappings.txt` → 代码检测到 `MAPPINGS_ISSUE_RE` 会**从 Mojang manifest 取官方 mojmaps 重试一次**（`fetchServerMappings()`，重试 3 次，因为 Mojang CDN 偶尔拒连）
- `detectForgeServer()` 幂等探测；`startForgeServer()` 走 Forge 生成的 `@argfile`（`user_jvm_arg_lines` 单独读）无头启动

#### `scripts/run-all.js` —— 一键编排

```
1. loadConfig() → 若 --loader 则 normalizeLoader()
2. detectEnvironment(cfg) → 取 PCL 的 Java；没有就报错退出
3. step 1/3  prepareServer() / prepareForgeServer()
4. step 2/3  startServer() / startForgeServer()
             → withTimeout(server.ready, Forge 600s / 原版 180s)
5. step 3/3  spawn(node src/index.js --force [--day] [--goal ...], stdio:'inherit')
6. （可选 --with-client）延迟 4s 后 launchClient() 打开 PCL2
7. SIGINT/SIGTERM → kill 所有子进程 + server.stop()
```

`--no-server` 时改为只 `waitForPort()` 探测已存在的服务器。

#### `mod-bridge/` —— Fabric 服务端桥接 Mod（可选）

装在**服务器**上，提供服务器权威状态与白名单 OP 能力：

| 类 | 职责 |
| --- | --- |
| `AgentBridgeMod` | Mod 入口。`onInitialize()` 顺序：`ModConfig.load()` → `PlayerTracker` → `ChatCommandBridge` → `BridgeHttpServer` → 注册事件 `SERVER_STARTED → httpServer.start(server)`、`SERVER_STOPPING → httpServer.stop(); chatBridge.shutdown()`。`environment: "server"`（只加载于专用服务器）；Loom 1.11.8 / Yarn 1.20.1+build.10 / Loader 0.15.11 / Fabric API 0.92.12 |
| `BridgeHttpServer` | `com.sun.net.httpserver`，`127.0.0.1:8765`（`config.server.bridgePort`）。端点 `GET /health`、`GET /state`、`GET /players`、`POST /command`（+ 兜底 `/` → 404）。**线程模型**：请求跑在 `agent-bridge-http` 守护线程池（2 线程），一切需要世界/实体数据的处理器都通过 `submitToServer()` 把任务交给 `MinecraftServer#execute` 并**带 5s 超时等待**结果 —— 世界 API 只在服务器线程触碰。**故障隔离**：端口被占用只告警不致命（`continuing WITHOUT the HTTP bridge, the server is unaffected`）。请求体上限 8KB（超限 413）。`/state` 额外返回 `tps`（**轮询间隔的产物，不是服务器内部 TPS**）+ `bridge{running,bindAddress,port,allowCommands,chatRelayed,chatRelayFailures}`。响应统一 `application/json; charset=utf-8` + `Cache-Control: no-store` |
| `AgentCommandRunner` | **严格白名单**：只有 `time / weather / give / tp / gamemode / say` 六个**命令根**可变。长度上限 256；逐字符拒绝 `\n`/`\r`/`\0`/`§`（防通过换行夹带第二条命令）；`rejectionReason()` 在到达命令调度器之前就拦下 —— `op`/`stop`/`execute`/`ban`/datapack 命令一律不可达。**权限模型**：没有玩家级校验，靠四层约束（仅回环绑定 + 可选 `authToken` + `allowCommands` + 根白名单）。⚠️**执行权限随 bot 是否在线变化**：bot 在线用 bot 自己的 op 等级，离线则回落到控制台（等级 4）。白名单是「能力白名单」而非内容过滤 —— `give` 可发任意物品、`tp` 可传任意目标 |
| `PlayerTracker` | Fabric 的 `ServerPlayConnectionEvents.JOIN/DISCONNECT` 驱动在线状态；`TrackedPlayer` 记录 uuid/name/首次见面/最后见面/会话数/位置/维度；`buildState(MinecraftServer)` 产出服务器权威快照：`tick / serverPort / minecraftVersion / maxPlayers / difficulty / dayTime / isDay / raining / thundering / players[] / trackedPlayers[]`，每个玩家含 `health/maxHealth/absorption/food/saturation/xpLevel/gamemode/onGround/pingMs/inventory/heldItem`。⚠️**`trackedPlayers[].position` 只在加入/离开时采样**（是「最后一次已知位置」），实时位置只在 `players[]` 里；`inventorySummary` 用 `TreeMap` 聚合 36 主槽 + 护甲 + 副手 |
| `ChatCommandBridge` | 游戏内 `!!agent <文本>` → 转发到 Node Agent 的 `POST http://127.0.0.1:8766/command`。前缀匹配 `regionMatches(true, ...)` 即**大小写不敏感**；回显只发给发送者；聊天回调在服务器线程，所以只做模式匹配然后交给 2 线程守护池 `agent-bridge-chat`。请求体严格为 `{"command":"<text>"}`（**这是与 Node 侧的契约**），连接超时 2s / 请求超时 5s，**不重试、不排队、不落盘** |
| `CollectingCommandOutput` | 收集命令输出回传给 HTTP 响应，`shouldBroadcastConsoleToOps()` 返回 **false** ⇒ 输出只回给调用方，不再广播给 op |
| `Json` / `ModConfig` | 手写 JSON 读写（不给服务端加依赖，`LinkedHashMap` 保证键序稳定）；配置在 `<configDir>/agent-bridge.json`，`load()` 会**无条件 `save()` 重写**保证磁盘上永远出现全部键，端口越界回落 8765 |

Agent 侧消费者是 `scripts/bridge-client.js`：`getHealth/getState/getPlayers/sendCommand`，
**没装 Mod 时优雅降级**（识别 `ECONNREFUSED/ENOTFOUND`，输出 `bridge-unreachable` 说明并以**退出码 0** 结束）。
它还能把 Mod 报告的「服务器眼中的 bot」和 Agent 自己的 `/status` 做**对拍**（`AGENT_STATUS_URL = http://127.0.0.1:8766/status`）。

> **⚠️ 当前 checkout 的实况（需知悉）**：桥接 Mod **并未安装** —— `runtime/server/mods/` 是空目录，
> `runtime/server/config/` 下没有 `agent-bridge.json`，而磁盘上的服务器实际是 **Forge** 安装
> （`libraries/`、`forge/`、`run.bat`、`server_mappings.txt`、`agent-forge.json` 齐全），
> 但 `config/server.json` 里仍写着 `"loader": "vanilla"`。同时：
> - `config/server.json` 的 `installBridgeMod: true` 与 `cfg.paths.modBridge` 都是**死配置**（全仓无消费方），
>   没有任何代码把 `mod-bridge/dist/agent-bridge-1.0.0.jar` 拷进 `mods\`；
> - Mod 是 **Fabric-only**，而当前服务器是 Forge ⇒ 要真正启用桥接**必须另建一个 Fabric 服务器**；
> - `src/` 下**没有任何文件 require** `bridge-client.js`（只有 `src/index.js` 用 `bridgePort + 1` 推导自己的状态端口），
>   所以这条通道目前是「人工/脚本可选增强」，**尚未接入 Agent 决策回路**，Mod 缺失对 bot 行为零影响。

因此上表的端点归属要分清：`mod-bridge` 提供 8765（**服务器权威状态**），`mod-client` 提供 8899（**客户端控制**），
Agent 自己提供 8766（**自身状态 + 指令入口**）。三者的关系是：

```
游戏内玩家 ──"!!agent status"──► mod-bridge:8765 ChatCommandBridge
                                        │ POST {"command":"status"}
                                        ▼
                                 Agent statusServer:8766 /command
                                        │ ctx.chat.handle()
                                        ▼
                                  Brain / 任务队列
```

#### `mod-client/` —— Forge 客户端控制 Mod

| 类 | 职责 |
| --- | --- |
| `AgentClientMod` | Forge Mod 入口，初始化 HTTP 服务 |
| `ControlHttpServer` | **JDK 自带** `com.sun.net.httpserver`，绑 `127.0.0.1:8899`，2 线程守护池，**延迟 2s** 由 `agent-client-boot` 线程启动。端点 `GET /health`（**唯一不鉴权**）、`GET /state`、`GET /progress`、`GET /diag/slash`、`POST /command`、`GET /chatlog?n=`、`GET /chatlog/clear`；鉴权：`authToken` 为空则全放行，否则要 `X-Agent-Token` 头或 `?token=`。**为什么不用 WebSocket**：1.20.1 Forge 的 classpath 带 Netty 4.1.82 但**不带 `netty-codec-http`**，`WebSocketServerHandshaker` 根本不存在；而 Agent 本来就是轮询 `/state`，请求/响应更贴合用法。端口被占只 warn 不致命（游戏不受影响） |
| `ClientActions` | 全部动作实现 + 线程契约 + 两个状态机：`WalkTo`（每 tick 水平距离判定、`>60s` 超时、`lookAt` + 按住前进 + 撞墙跳一格）与 `DigBlock`（每 tick 重新 `lookAt`，否则服务端拒绝挖掘进度；首 tick `startDestroyBlock`、之后 `continueDestroyBlock` + swing，30s 超时；**发起前要求距离 ≤4.5**）。按键走真实输入管线（`mc.options.keyUp.setDown(...)`），**不伪造移动包**；唯一手搓包是 `resyncPosition` 的 `ServerboundMovePlayerPacket.PosRot` |
| `ClientStateSnapshot` | 在**客户端线程**构建快照：位置/朝向/血量/饥饿/饱和度/air/onGround/维度/经验/游戏模式/`heldItem`（空手是字符串 `"null"`）/`standingOn`；`time{timeOfDay = getDayTime()%24000, day, isDay}`；`weather`；`inventory{注册表id: 总数}` + `emptySlots`；**`blocks.cells`**：`dx,dz ∈ [-24,24]`、`dy ∈ [-8,8]`，先 `hasChunkAt` 再取状态，**空气也上报**（寻路需要），理论 **49×49×17 = 40817 格**；`hostiles`（**`instanceof Monster`**，≤24 格）；`itemDrops`（`ItemEntity` ≤16）；`players`（排除自己）。命名来自 `BuiltInRegistries.*.getKey()` ⇒ **Mod 方块带真实注册表 id** |
| `ClientModConfig` | 读 `config/agent-client.json`（Gson 是 Forge 自带）：`bindAddress/port/enabled/authToken/allowCommands/verbose`，首运行写默认 |
| `ChatLog` | 监听 `ClientChatReceivedEvent`，**50 条**环形缓冲，`synchronized` —— 供 `/chatlog` 诊断（不要用它做决策，会被诊断输出刷屏） |
| `Json` | 手写 JSON 读写，**零第三方依赖**（刻意如此：在装了 151 个 Mod 的整合包里引入 Gson 以外的库容易撞类） |

**线程规则**（这是 mod-client 最关键的设计，四条规则逐条落进了实现）：

| 线程 | 职责 | 禁止 |
| --- | --- | --- |
| `agent-client-http`（2 daemon，JDK HttpServer） | 只做 I/O + 解析 + 排队 | **绝不触碰** `mc.player` / `mc.level` / `gameMode` |
| 客户端主线程 | 一切游戏读写；`ClientStateSnapshot.build()` 必须在这里 | — |
| `TickEvent.ClientTickEvent`（Phase.END，20Hz） | 只推进 `Continuous` 动作状态机（`WalkTo`/`DigBlock`） | — |
| `agent-client-boot` | 延迟 2s 启动 HTTP 服务 | — |

跨线程桥：`ClientActions.onClient()`（同线程则直接执行，否则 `mc.execute` + `CompletableFuture.get`，默认 15s）、`ControlHttpServer.onClientThread()`（5s 预算，超时回 `{"ready":false,"reason":"client thread busy"}`）。
另有一条 `EVENT_BUS` 注册 + `onClientTick` 只跑 `Phase.END`。

**动作 verb 全集**（`ControlHttpServer.execute()`，先剥前导斜杠再切 verb）：
`chat` / `login`（受 `allowCommands`）/ `register`（死分支，恒 refused）/ `cmd|command`（逃生通道，受 `allowCommands`）/ `say` / `look` / `lookat` / `moveto|goto` / `dig|mine` / `place` / `use|useitem` / `select` / `drop` / `attack` / `stop` / `resync`

**双重安全门**（因为早期版本真的发过一次 `/register`，把角色数据清空了）：
1. `ControlHttpServer.forbiddenCommand()` —— 在**任何 dispatch 之前**拒绝，且**递归剥掉最多 5 层 `cmd`/`command` 前缀和前导斜杠**（第一版只 gate 顶层 verb，`cmd /register x` 直接绕过去了，服务端确认收到了命令）
2. `ClientActions.forbiddenVerb()` —— 在命令即将到达网络的那一点独立拒绝，即使 HTTP 层被绕过也覆盖所有调用方
3. `ClientModBody.isForbidden()/safeCommand()` —— Node 侧第三道

实测已封堵的 6 条路径：`register`、`/register`、`cmd register`、`cmd /register`、`command reg`、`cmd cmd /register`。

**SRG 名称映射**：Minecraft 的命名有三层 —— `official`（开发时可读）/ `obf`（混淆）/ `SRG`（Forge 在生产运行时的稳定名，形如 `m_91087_`）。
Mod 因此**用 official 映射编写并编译**（`mappings_channel=official`），再由 ForgeGradle 的 `reobfJar` 任务重映射成 SRG 后才打包。
**不使用反射、不使用 Mixin、不写 SRG 常量**（代码里零 `Class.forName`/`MethodHandle`/`m_\d+_`）——
发布未重映射的字节码会在运行时抛 `NoSuchMethodError`，这正是 `build.gradle` 里 `copyJar` 必须 `dependsOn reobfJar` 的原因
（曾经接在 `jar` 上，是一个已修复的实战坑；实测 `build/libs`、`build/reobfJar/output.jar`、`dist` 三个 jar 的 SHA-256 完全相同，含 111 处 `m_xxxxx_` 引用）。
`scripts/gen-srg-names.js` 是「按名匹配绕过 ForgeGradle」的**失败尝试的化石**（文件头标注 NOT WORKING YET：继承成员缺失、obf 名跨类重复），保留仅作调查记录。

---

## 四、端到端数据流

### 4.1 启动与装配流程（`src/index.js`）

```
parseArgs()                         --goal/--body/--server/--profile/--auth/--proxy/--day/--diagnose/--force
   ↓
loadConfig({profile})               合并 DEFAULTS + config/*.json + profile + 环境变量
   ↓  applyAddress() / cfg.agent.body.kind / bot.auth / bot.proxy
new Logger('agent', {file: runtime/logs/agent.log})
   ↓
preflight(cfg)                      仅当 body.kind === 'mineflayer'（mock 探测没有意义）
   ↓  probe.connect === false → exitCode = 3，拒绝连接
acquireLock(cfg)                    runtime/agent.lock，被占用 → exitCode = 2
   ↓
构造 ctx：
   BotController(cfg)                 + ctx.mods = new ModKnowledge(cfg)
   WorldView(controller, {mods})
   Navigator(controller)
   Memory(cfg)
   AutoEat(controller) / Combat(controller, nav) / ToolManager(controller)
   ctx.target = describeTarget(cfg)
   ↓
createBody(cfg, deps)               --body / MC_BODY / config.agent.body.kind
   ↓  usable === false → exitCode = 4
   ↓  kind !== 'mineflayer' → ctx.world = new BodyWorldView(body, cfg)
ctx.craft/mine/chop/hunt/shelter = (opts) => new XxxTask(ctx, opts).execute()
   ↓
new Brain(ctx) ; ctx.brain = brain
controller.on('botCreated', bot => ctx.bot = bot)      ← ctx.bot 始终指向最新实例
new ChatController(ctx, {prefix})
   ↓
mock 路径：await body.connect() → brain.start() → return
   ↓
controller.on('spawn')  → nav.refreshMovements({canDig:true}) → tools.equipArmor()
                        → mods.scan(bot) → 打印加载器 + guidance
                        → needsRescue(world) ? escapeToGround() : -
                        → rearmPathfinder() ; nav.armed = true
                        → --day ? chat('/time set day') : -
                        → --diagnose ? runDiagnostics() + shutdown : brain.start()
                        → --goal ? applyGoal() : -
controller.on('death')  → memory.recordDeath() + brain.noteDeath() + brain.preempt()
controller.on('respawn')→ nav.refreshMovements()
   ↓
startStatusServer(ctx, {port: bridgePort+1})
SIGINT/SIGTERM → shutdown()
controller.connect() ; chat.attach()
setInterval(5000) → memory.data.runtime = {...controller.snapshot(), world.summary(), brain:{...}} ; memory.save()
```

`--diagnose` 模式（`runDiagnostics`）值得单独一提：它做**感知层体检** —— 打印位置/维度/地面高度、
血量/饥饿/空槽、时间/光照、25×25×9 范围内的方块普查（按数量排序取前 8）、
`world.findNearestLog(48)` 与原生 `bot.findBlock` 的**结果对拍**、
插件可用性、敌对生物数，然后走一次 `gotoBlock + digBlock` 并跑一个 `GatherWoodTask{count:2}`，
用于回答「它为什么不干活」。

### 4.2 决策 → 执行主链路（最核心的一张图）

```
   ┌───────────────────────── 每 600ms ─────────────────────────┐
   │ fastLoop()                                                  │
   │   safeMode? → hideUnderground()                             │
   │   受困?     → escapeToGround()                              │
   │   危险?     → combat.retreat() + eat.tick(true)             │
   │   常规      → eat.tick() → combat.defend() → equipArmor()   │
   │              （defend 前调用 brain.preempt() 取消当前任务）  │
   └──────────────────────────┬──────────────────────────────────┘
                              │ 竞争
   ┌──────────────────────────▼──────────────────────────────────┐
   │ 每 2500ms  slowLoop() → decide() → 命中第一条规则 → Task     │
   └──────────────────────────┬──────────────────────────────────┘
                              ▼
                     brain.runTask(task)
                  ┌───────────────────────┐
                  │ activeTask 已存在?     │──是──→ queue.push() （串行闸门）
                  └───────────┬───────────┘
                              │ 否
                              ▼
                  task.execute()  ── Promise.race(run(), timeoutMs)
                              │
                              ▼
          ┌───────────────────┴───────────────────┐
          │ 任务通过 this.body / this.world 行动    │
          └───────────────────┬───────────────────┘
                              ▼
        ┌─────────────────────┴─────────────────────┐
        │                Body 实现                   │
        ├───────────────┬───────────────┬───────────┤
        ▼               ▼               ▼
   MineflayerBody    MockBody      ClientModBody
   BotController     Map 内存世界    HTTP POST /command
   Navigator.goto    (立即生效)      → ControlHttpServer
   bot.dig/place/...                 → onClientThread(ClientActions)
   → minecraft-protocol              → Minecraft 客户端 tick 执行
     原版协议封包                    ← GET /progress 轮询收敛
        └───────────────┴───────────────┴───────────┘
                              │ 结果 {ok, reason}
                              ▼
                    runTask 收尾
        ok  → memory.bump('task:X:ok')  + _noteProgress(task)
              shelter 成功 → memory.rememberLandmark('shelter', pos)
        fail→ memory.bump('task:X:fail') + maybeRetry()
              超过 maxRetries → quarantine(min(120s, 20s×strikes)) + drainQueue()
                              │
                              ▼
                    finally: currentTask / activeTask = null
```

### 4.3 感知数据流

```
mineflayer bot               MockBody.world Map        ClientModBody._snapshot
   │                              │                          ▲
   │ MineflayerBody.snapshot()    │ snapshot()               │ GET /state (400ms TTL)
   ▼                              ▼                          │
        { ready, position, health, food, time, weather,       │
          inventory:{name:count}, emptySlots, heldItem,       │
          standingOn, lightLevel, hostiles[], nearbyItems[] } │
   │                              │                          │
   └──────────┬───────────────────┴──────────────────────────┘
              ▼
   ┌──────────────────────┐        ┌────────────────────────────┐
   │ WorldView (mineflayer)│  或   │ BodyWorldView (非 mineflayer)│
   │ bot.blockAt/findBlock │       │ body.blockAt/findBlocksMatching│
   └──────────┬───────────┘        └────────────┬───────────────┘
              └──────────────┬──────────────────┘
                             ▼
                    world.snapshot(true)
                             ▼
              SnapshotInventory（伪装 mineflayer inventory）
                             ▼
      view = { inventory, health, food, registry }
                             ▼
        countItem / countMatching / bestTool / isLog / isFood
                             ▼
                      brain.decide() 的 20 条规则
```

**命名空间归一化**贯穿这条链路：Body 报 `minecraft:stone`，知识表用 `stone`，
所以 `BodyWorldView.matchNames()` 在谓词**两侧都剥命名空间**，`SnapshotInventory` 在构造时剥一次。
这个坑的症状极具误导性 —— 传 `'stone'` 匹配不上 `'minecraft:stone'`，日志显示「附近没有石头」。

### 4.4 Mod 服数据流（两条互斥路径）

**路径 A：mineflayer 连 Mod 服（原版兼容的 Mod 服）**

```
controller.connect() → mineflayer → 服务端
controller._installLifecycle() 抓 custom_payload channel → pluginChannels Set
   ↓ spawn
mods.scan(bot) → detectLoader() → 'forge'/'neoforge'/'fabric'/...
   ↓
guidance() 输出风险提示 → 日志 + HTTP /mods + /status.mods
   ↓
规划时 WorldView.canMine() → mods.isMineable() → 未知 Mod 方块默认不挖
   ↓
rememberServer() → config/mod-knowledge.json 的 servers{}（持久化）
```

**路径 B：ClientModBody 连 Forge 服（客户端必需 Mod 的服）**

```
run-all.js / launch-forge-client.js 用 PCL2 启动真实 Forge 客户端
   ↓ 客户端加载 mod-client（agent-client-1.0.0.jar）
AgentClientMod 启动 ControlHttpServer → 127.0.0.1:8899
   ↓
ClientModBody.connect() 轮询 /health（最多 120s）→ /state.ready
   ↓
AuthMe 登录：body.chat('/login <pw>') → cmd login <pw> → ClientActions.command()
             （Node 侧与 Mod 侧双重拒绝 /register）
   ↓
ClientModBody.snapshot() ← /state（blocks.cells = 40817 格真实注册表 id，含 Mod 方块）
   ↓
Minecraft 内部动作：body.moveTo/dig → POST /command → onClientThread() 投到客户端线程
   ↓
ClientModBody.awaitAction() 轮询 GET /progress 直到 busy === false → refresh(true)
```

**关键差异**：路径 B 拿到的 `blocks.cells` 是**客户端世界模型里的真实注册表 id**（Create、Farmer's Delight、
Biomes We've Gone 等 Mod 方块全部可见），所以 `src/mods/knowledge.js` 的签名猜测从「唯一手段」降级为「兜底手段」。

### 4.5 反馈与持久化流

```
任务成功/失败 ──→ Memory.bump('task:X:ok'|'task:X:fail')  ─┐
任务 checkpoint ─→ Memory.recordTask()                     │
死亡           ──→ Memory.recordDeath() + Brain.noteDeath()│
建庇护所        ──→ Memory.rememberLandmark('shelter', pos) │
                                                           ▼
                                        runtime/agent-state.json
                                        （+ config/mod-knowledge.json）
                                                           │
   setInterval(5s) ──→ data.runtime = { controller.snapshot(), world.summary(), brain{current,lastDecision} }
                                                           ▼
                        ┌──────────────────────────────────┴────────────┐
                        ▼                                               ▼
              GET /status（外部 GUI/脚本轮询）              Logger 环形缓冲 → GET /logs?n=
```

`runtime/agent-state.json` 是**可观测性主界面**：32 次会话、30 次死亡、284 次 `gather-wood:fail`
这类统计都在里面（当前仓库里那份文件的 runtime 段显示 `state: "idle"`、`alive: false`，
说明是上一次运行留下的快照）。

---

## 五、控制流：五条并发流的时序

Agent 内部实际上有**五条并发流**，理解它们如何互不干扰是理解这个项目的关键：

```
时间轴 ──────────────────────────────────────────────────────────►

流 A  快反射 (600ms)     │eat│  │defend!│      │eat│   │rescue!│
                          │    │  │preempt │      │   │preempt │
                          ▼    ▼  ▼        ▼      ▼   ▼        ▼
流 B  慢规划 (2500ms)  plan→runTask───────►done  plan→runTask────────►
                          │        ▲              │
                          │        │ activeTask   │
流 C  任务内部循环      moveTo→dig→moveTo→collect→checkpoint
                          │
流 D  重试定时器 (1.5s)              （仅在失败后触发，仍受 activeTask 闸门约束）
流 E  状态落盘 (5s)    snapshot→save   snapshot→save   snapshot→save
```

**互斥规则**：
- A 与 B 通过 `preempt()` + `activeTask` 协调：A 抢占会取消 B 的任务并清空队列
- B 内部通过 `activeTask` 严格串行，多余任务进 `queue`
- C 是 B 的栈内执行，天然串行
- D 复用 B 的闸门（`runTask` 会检查 `activeTask`）
- E 只读，无锁

**唯一的例外**是 `ShelterTask` / `HuntTask` / `LightTask` / `DepositTask` —— 它们仍直接使用 `ctx.bot`
和 `ctx.nav`，所以在非 mineflayer 躯体下会失效；`Brain` 自身也还有几处 mineflayer 残留（见 §六 B 与 §十一 技术债）。

---

## 六、clientmod 路径的接线缺口（必读）

`ClientModBody` 与 `mod-client` 本身是**经过真机验证的**（`runtime/client-verify.json`：24/24 检查通过、
`blockCells: 40817`、走路与挖掘实测生效、`/diag/slash` 实测确认 `sendCommand` 不补前导斜杠）。
但把这条链路接到 `src/index.js` 的**主循环**上还有一段没接完：

| # | 缺口 | 证据 |
| --- | --- | --- |
| **A** | **`src/index.js` 没有 clientmod 分支** ⇒ `--body clientmod` 下**大脑永远不启动** | `ctx.body.connect()` 只在 `bodySelection.kind === 'mock'` 那条路径被调用（`index.js:250-262`）；`brain.start()` 只在 mineflayer 的 `controller.on('spawn')` 回调里（`index.js:264-314`）；而 `controller.connect()` 在 `index.js:337` 被**无条件**调用 ⇒ clientmod 下既没有 `spawn` 事件、也没有人调 `body.connect()`。`npm run agent:client` 目前不是可用的端到端链路 |
| **B** | **`Brain` 仍有 mineflayer 耦合**，在 clientmod 下会抛异常 | `brain.js:163` `eat.tick()`（`AutoEat` 内部走 `bot.consume()`）、`brain.js:175` `tools.equipArmor()`（`ToolManager` 绑 `bot`）、`brain.js:168` `this.bot.health`、`brain.js:338` shelter 成功后 `this.bot.entity.position`。`this.bot` 在 clientmod 下是 `null` ⇒ TypeError，而异常被两个循环的 `.catch()` 吞成 debug 日志（`brain.js:88-89`）⇒ **表现为「什么都没发生」** |
| **C** | **感知不会自动刷新** | `BodyWorldView.snapshot()` 只读缓存（`bodyWorldView.js:44-48`），而 `body.refresh()` 的调用点只有 `ClientModBody` 自己动作之后与 `scripts/` 里 —— 注释声称「循环每 tick 调 refresh()」，实际主循环里没有 |
| **D** | `factory` 的 `usable === false` **只有一个触发条件** | `require('./clientModBody')` 抛错（`factory.js:65-81`）。工厂**不探测** 8899 端口 ⇒ Mod 没装 / 客户端没开时 `usable` 仍是 `true`，失败被推迟到 `connect()`（默认等 **120s** 后抛 `BodyUnavailableError`） |
| **E** | 协议层 off-by-one（静态推断，**未真机复测**） | ① `attack` 事实上打不通：Java 侧 `numbers(rest, 3)` 要求 ≥3 个 token，而 Node 只发 `attack <id> <timeoutMs>`（2 个）⇒ 恒 usage 错误；`MockBody.attack` 一律返回 `ok:true`，所以协议测试抓不到 ② `place` 的 `nth(rest,4)`/`nth(rest,5)` 错位 ⇒ face 拿到物品名、item 恒空 ③ `moveto x y z`（3 token）会 `ArrayIndexOutOfBounds` ④ `awaitAction` 在「当时没有连续动作」时 `done` 为 `undefined` ⇒ **返回 true（假成功）** |
| **F** | 契约命名与实现不一致 | `body.js:186` 声明的是 `eat()`，而**三个实现都叫 `consume()`**（实例属性 `this.eat` 遮蔽原型方法的老坑）；契约里**没有事件通道**，纯 poll —— 这正是 mineflayer 的 `spawn/death/chat` 事件留在 `BotController` 里、导致 clientmod 难以复用主启动流程的根因 |
| **G** | 能力缺口 | `equipArmor()` 恒 `false`；`supportsCrafting` 恒 `false`（**与 `body.js:216-231` 的注释矛盾** —— 注释说 clientmod 知道所有配方）；无容器 / `depositInto`；`lightLevel` Java 侧根本不发 ⇒ Node 侧**硬编码 15**；`hostiles` 只认 `Instanceof Monster` ⇒ **无被动生物，`HuntTask` 在 clientmod 下没有目标** |
| **H** | 移动是**直线贪心**，没有寻路 | Java 侧 `WalkTo` 每 tick 算水平距离，`lookAt` + 按住前进 + 撞墙跳一格；不绕墙/水/栅栏/两格台阶，**无岩浆保护**，且到达判定**忽略 Y**。仅适用于开阔地形 |
| **I** | 单实例成本与无人值守风险 | 需图形会话、一账号一实例、30-60s（最坏 90s）就绪、RSS 峰值 ≈5.8GB；**`servers.dat` 会导致断线后自动重连旧服务器**（侦察时实测自己连上了 `mc.example.com:25565`）⇒ 无人值守前必须清理该文件 |

**值得记下的方法论**：`docs/CLIENT-MOD-RECON.md` 在上线前把「`sendCommand` 要不要前导斜杠」明确标为**未核实**，
随后把 `/diag/slash` 端点做进 Mod 去实测，结果**推翻了侦察阶段的假设**（`sendCommand` 不补斜杠）。
这是这个项目里「不确定的东西先做成可测量」的典型样本。
（⚠️`/diag/slash` 的 `note` 文案仍写着相反的旧假设，与它自己的 `verdict()` 矛盾。）

---

## 七、三个 Body 的对比矩阵
| 维度 | MineflayerBody | MockBody | ClientModBody |
| --- | --- | --- | --- |
| 连接目标 | 127.0.0.1 或远程服务器（原版协议） | 无（进程内 Map） | 已运行的真实 Forge 客户端 |
| 启动耗时 | ~1s | 0 | 30-60s（要等客户端进世界） |
| 并发实例 | 一台机器多个 | 无限 | 一账号一实例（需图形会话） |
| 支持的服务器 | 原版 / Paper / Spigot / Purpur / 纯服务端 Fabric | — | **Forge / NeoForge（含客户端必需 Mod）** |
| 感知来源 | `bot.blockAt/findBlock/entities` | `Map` | `/state` 的 `blocks.cells`（40817 格） |
| 方块知识 | minecraft-data（仅原版 1255/1003） | 无 | **客户端真实注册表，含全部 Mod 内容** |
| 移动 | mineflayer-pathfinder A* | 瞬移 | 客户端自己的移动（连续动作，需轮询） |
| 挖掘 | `bot.dig()`（有工具选择 + blockUpdate 确认） | 瞬间 | 客户端挖掘（连续动作，需轮询） |
| 合成 | ✅ prismarine-recipe（含木材变体修补） | ✅ 11 条内置配方 | ❌ `supportsCrafting = false`（Mod 未暴露合成界面） |
| 护甲 | ✅ armor-manager + 手工降级 | ❌ | ❌ 返回 false |
| 指令/聊天 | `bot.chat()` | 记录到 `stats.chats` | `POST /command` → `cmd`/`chat` 分流 |
| 测试用途 | 生产 | selftest 8 项 + `agent:mock` | `client:verify` 24 项 |

**抽象层的实际回报证据**（`npm run agent:mock`，无 mineflayer、无服务器）：

```
INFO (body) body: mock (scripted world - no real gameplay)
INFO (brain) plan -> gather-wood: gather 8 logs
INFO (task:gather-wood) chopped 3 logs      x4
INFO (brain) done gather-wood: collected 10 logs (4 trees)
INFO (brain) plan -> craft: craft 1x crafting_table
INFO (task:craft) retrying crafting_table after preparing prerequisites
INFO (brain) done craft: crafted 1x crafting_table
INFO (brain) plan -> craft: craft 4x stick
INFO (brain) done craft: crafted 16x stick
INFO (brain) plan -> craft: craft 1x wooden_pickaxe
INFO (brain) done craft: crafted 1x wooden_pickaxe
INFO (brain) plan -> mine: mine 8x stone,cobblestone
INFO (brain) done mine: mined 3 (area exhausted)
```

砍树 → 补前置材料 → 工作台 → 木棍 → 木镐 → 挖石头，**全链路在假世界里跑通**。

---

## 八、启动方式的决策树

```
npm start                          → run-all.js: 开服务器 + Agent
├─ --loader forge                  → forgeServer.js: 装/启 Forge 1.20.1-47.4.10
├─ --no-server                     → 只探测端口，连已有服务器
├─ --with-client                   → 4s 后用 PCL2 打开客户端
├─ --day                           → Agent 侧 chat('/time set day')
└─ --goal "gather 32 wood"         → Agent 侧 applyGoal()

npm run agent                      → 只跑 Agent（连 config 里配的服务器）
├─ --profile simpfun               → config/servers.json 命名 profile
├─ --server host:port              → 直接指定地址
├─ --auth microsoft                → 设备码正版登录
├─ --proxy socks5://...            → 代理
├─ --body mock|clientmod|mineflayer→ 选躯体（或 MC_BODY 环境变量）
├─ --diagnose                      → 感知层体检 + 单任务带仪表盘
└─ --once                          → 60s 后自动退出（冒烟测试）

npm run agent:client               → --body clientmod --profile simpfun（真 Forge 客户端）
npm run agent:mock                 → --body mock --no-status（纯决策层）
```

---

## 九、自检与验证体系

`npm run selftest` 是**离线**的 56 项检查，分 8 节（`scripts/selftest.js`）：

| 节 | 内容 |
| --- | --- |
| 1. module graph | 25 个模块能否 `require` |
| 2. mineflayer stack | 10 个包能否 resolve + 版本 |
| 3. PCL2 / Java | PCL2 可执行文件、`.minecraft`、服务器 Java、server jar 探测 |
| 4. survival knowledge | 原木识别、食物排序偏向熟食、木板替换、需镐表、燃料表 |
| 5. task construction | 7 个任务类能否构造 + 超时是否生效 |
| 6. goal router + config | 方块别名展开、配置默认值与路径 |
| 7. external multiplayer | 地址解析（host:port / 裸 host / IPv6）、profile 解析、未知 profile 报错、代理 URL 解析与拒绝、offline vs microsoft 认证、**Mod 签名分类**、**安全门（未知方块不挖）**、知识落盘、WorldView 里的 Mod 方块检测 |
| 8. body abstraction | 未实现方法抛 `BodyUnavailableError`、两个 Body 都满足 18 方法契约、mock 世界端到端（挖树+捡掉落 / 昼夜与敌对 / 合成消耗材料且失败要响 / 吃东西恢复饥饿）、**决策层能被非 mineflayer 躯体驱动** |

其他验证脚本：`probe`（四个原语单测）、`inspect`（进游戏采样周围方块）、
`inspect:server`（Ping + 加载器分析 + 登录可行性判定）、`mods:report`（签名分类 + 安全门）、
`verify:modded`（起真实 Forge 服务端验证加载器检测，记录 6/6 通过）、
`forge:test`（手动验证 Forge 安装+启动）、`client:check` / `client:verify` / `client:test` / `client:real`。

**已固化的现场证据**（`runtime/` 下）：

| 文件 | 内容 |
| --- | --- |
| `client-verify.json` | 客户端 Mod 端到端验证：`status: VERIFIED`。152 个 Mod 加载、`blockCells: 40817`、`moveTo` 位置真的变了、`dig` 树叶变空气、24/24 检查通过。含 7 条现场发现并修复的 bug |
| `real-server-login.json` | 真实服务器 `mc.example.com:25565` 登录成功（AuthMe `/login` 回「欢迎 感谢！」）、`/register` 六条路径全部封堵、非破坏性寻路 7/7 通过。含一条硬规则：**永远不要发 `/register`** |
| `agent-state.json` | 32 次会话、30 次死亡、任务统计（`gather-wood:fail` 284 次 → 正是 `_noteProgress` 和 quarantine 机制要解决的问题） |

---

## 十、已知不一致与安全边界（代码/实物取证）

这些是**通读代码与磁盘实物后确认的、与文档或直觉不符的事实**，改动前必须知道。

### 安全边界

| 项 | 事实 | 影响 |
| --- | --- | --- |
| 游戏内指令**无权限控制** | `ChatController` 不校验玩家身份、不限流；`behaviour.publicServerMode` / `respondToChat` / `maxChatPerMinute` 三个配置项**全项目无消费者** | 公共服务器上任何玩家打 `!goal` / `!stop` 都会生效。README §8 说的「公屏低姿态」目前只是纸面配置 |
| 状态/控制 API 仅回环 | `127.0.0.1:8766`（Agent）、`127.0.0.1:8765`（bridge）、`127.0.0.1:8899`（client mod），三者都只绑定回环 | 本机其他进程可无认证调用 `POST /command`（无 token 机制） |
| bridge 指令白名单是**能力**白名单 | `give` 可发任意物品、`tp` 可传任意目标、`say` 可发任意文本 | 白名单防的是「命令根」级提权（`op`/`stop`/`execute`/`ban` 不可达），不防内容 |
| bridge 执行权限**随 bot 在线状态漂移** | bot 在线 → 用 bot 自己的 op 等级；bot 离线 → 回落控制台（等级 4） | bot 掉线时桥接指令权限实际**变高** |
| `/register` 是**数据毁灭**命令 | 在目标服务器上会让已存在角色重置（清空经验与背包） | 三道独立防线：Node `ClientModBody.isForbidden()`、Mod `ControlHttpServer.forbiddenCommand()`（递归剥 5 层 `cmd`/`command` 前缀）、`ClientActions.forbiddenVerb()`。实测 6 条路径全部封堵 |

### 文档/配置与实现不一致

| 位置 | 不一致 |
| --- | --- |
| `docs/BODY-ABSTRACTION.md` | 仍把 ClientModBody 标为「⏳ 待建」、§七 落地顺序 4-7 步未打勾；实际上 `src/body/clientModBody.js`(531 行) 已存在，且 `runtime/client-verify.json` 记录了端到端验证通过。**但注意**：验证通过的是 Mod 与 Body 本身，接到 `src/index.js` 主循环的那一段仍未完成 —— 见 §六 |
| `config/server.json` | 写 `"loader": "vanilla"`，但磁盘上的 `runtime/server/` 是 **Forge** 安装（`libraries/` + `forge/` + `run.bat` + `server_mappings.txt` + `agent-forge.json` 齐全） |
| `config/server.json:20` `installBridgeMod: true` | **死配置**，无消费方 |
| `src/util/config.js:176` `cfg.paths.modBridge` | **死配置**，无消费方；没有任何代码把 `mod-bridge/dist/agent-bridge-1.0.0.jar` 装进 `mods/` |
| `src/chat/commands.js` 文件头注释 | 写的是 `!chest`，实现是 `!store`（`!chest` 会回 unknown command）；`HELP` 表故意省略 `eat`/`defend` |
| `mod-bridge/README.md` 的 503 描述 | 实际**不可达**：HTTP 服务只在 `SERVER_STARTED` 才启动，服务器就绪前客户端拿到的是 `ECONNREFUSED`。同理「端口被占」在客户端与「没装 Mod」**完全同形**（都是 `bridge-unreachable`） |
| `docs/EXTERNAL-SERVERS.md` 的 `!!agent mine some iron` 示例 | 前缀剥离后转发原文，`mine some iron` 会把 `some` 当方块名 → 正确写法是 `!!agent mine iron 3` 或 `!!agent goal mine some iron` |
| `runtime/server/agent-forge.json` | 记录 `port: 25570`，而 `agent-server.json` 记 `25565`（历史上用过 `--port 25570`；`config/mod-knowledge.json` 里那条 `127.0.0.1:25570` 就是这么来的） |

### 代码级瑕疵

| # | 位置 | 问题 |
| --- | --- | --- |
| 1 | `tasks/task.js:107-110` | `Promise.race` 超时**不打断**底层 `run()`；真正取消靠任务循环自查 `this.cancelled`，而 **`craft.js` 与 `shelter.js` 没有任何 `cancelled` 检查**，只能等超时 |
| 2 | `tasks/craft.js` 构造器 | 从不读 `requireTable`，而 `brain.js:262/263/265/277`、`light.js:91-99`、`deposit.js:89-96` 都在传它 → **死参数**；是否用工作台完全由 `body.craft()` 的三段式决定 |
| 3 | `body/mineflayerBody.js:298` | `require('../tasks/craft')` 的 `CraftTask` 是**未使用的死引用**（只用到了 `world/items`），却保留了 body↔task 的循环依赖边 |
| 4 | `tasks/deposit.js:87` | `countItem(bot,'chest_planks')` 是不存在的物品名（恒 0，短路到 `countPlanks()`）—— 功能正常但属笔误 |
| 5 | `tasks/shelter.js:112-122` | `countPlaced()` 统计区域内**任意** `BUILD_MATERIALS` 方块（含地形原有泥土/石头）⇒ 可能「假成功」，靠 Brain 的零进展检测部分兜住 |
| 6 | `survival/toolManager.js:136-141` | `armorRank` 复用 `TOOL_TIERS` 索引 ⇒ `golden`(3) > `iron`(2)，会**优先穿金甲**；`leather`(-1) < `chainmail`(0) |
| 7 | `survival/combat.js:117-119` | 每轮挥击 ≈400ms，低于 1.9+ 攻击冷却（≈625ms），DPS 有折损 |
| 8 | `world/items.js:93-96` | `foodScore` 对表外食物返回 -1（Mod 食物即使 `registry.foodPoints` 很高也排最后）；`HuntTask` 的 `countMatching(bot, isFood)` 不传 registry ⇒ 连 `foodPoints` 分支都用不上 |
| 9 | `web/statusServer.js:82-89` | EADDRINUSE 回退到 `port+1` **无计数上限**，若 N+1 也占用会反复进入该分支 |
| 10 | `web/statusServer.js:60-63` + `util/logger.js:38-43` | `/logs` 只有**根 logger** 的 500 行环形缓冲；`Logger.child()` 全项目从未调用 ⇒ `new Logger('brain'/'eat'/'fight'/'task:*')` 的行不进 `/logs` |
| 11 | `scripts/run-all.js:155` | 硬编码 `runtime/agent-state.json`，不读 `cfg.agent.logging.stateFile` |
| 12 | `core/preflight.js:53/127` | 协议号硬编码 **763**（1.20.1），未取 `cfg.agent.bot.version`；改版本后建议文案会误导 |
| 13 | `core/serverManager.js:285` / `forgeServer.js:430` | `maxHeapMb` 是**可用但未文档化**的键（默认 2048 / Forge 4096），未出现在 `DEFAULTS` 与 `config/server.json` 中 |
| 14 | `scripts/bridge-client.js:191-194` | `findBotPlayer` 找不到 bot 时回落 `players[0]` ⇒ bot 离线而别的玩家在线时展示会误导 |

---

## 十一、设计取舍与技术债

### 已知的设计取舍

| 取舍 | 理由 |
| --- | --- |
| **规则表优先于 LLM/搜索** | 可预测、可测试、零延迟、零成本。代价是不擅长长距离探索和创造性任务 |
| **反射层可以抢占一切** | 生存优先。代价是长任务（挖矿/砍树）会被频繁打断 |
| **「零收获 = 成功」** | 避免规划器在资源匮乏的地图上无限重排同一目标。代价是统计上「成功」不代表目标达成 |
| **未知 Mod 方块默认不挖** | 卡在不可破坏方块上是更糟的失败模式。代价是在 Mod 服上会显得畏手畏脚 |
| **任务超时用 `Promise.race` 而非真取消** | JS 无法真正中断异步栈，超时后底层操作仍在跑 —— 靠 `Task.cancelled` 标志和 `nav.interrupt()` 协同收敛 |
| **HTTP 轮询而非 WebSocket（client mod）** | Forge 1.20.1 的 Netty classpath 里没有 `netty-codec-http`，WebSocket 握手类不存在 |
| **Fabric 而非 Forge 做服务端桥接** | Forge 整合包带 150+ 个客户端 Mod，拿来开专用服务器又重又容易崩 |

### 技术债（代码里可核实的）

1. **4 个任务尚未完全 Body 化**：`ShelterTask`、`HuntTask`、`LightTask`、`DepositTask`
   直接使用 `ctx.bot` / `ctx.nav` / `placeBlockAgainst` / `bot.openContainer`，
   所以在 `MockBody` / `ClientModBody` 下无法工作。
   `GatherWoodTask` / `MineTask` / `CraftTask` 已经是纯 Body 实现（`GatherWoodTask` 的注释自称是
   「Body 契约的参考实现」）。

2. **文档落后于代码**：`docs/BODY-ABSTRACTION.md` 仍把 ClientModBody 标为「⏳ 待建」，
   但 `src/body/clientModBody.js`（531 行）已存在且已被 `runtime/client-verify.json` 验证通过。
   该文档 §七 的落地顺序 4-6 步实际都已完成，**但第 7 步「端到端」没有** —— 详见 §六。

3. **`ShelterTask.material()` 的重复计算**：它同时用 `ctx.bot.inventory.items()` 和新加的
   `this.inventory`（快照门面），是迁移中途的状态。

4. **`decide()` 规则表里的 shelter 条件用了 `countMatching(bot, ...)`**（`src/brain.js:273`）
   而不是 `countMatching(view, ...)` —— 这是规则表里唯一一处漏网的 mineflayer 直接依赖，
   在非 mineflayer 躯体下会抛异常（被 `try/catch` 吞掉，规则被静默跳过）。

5. **`MineTask.blockNames` 与 `this.wanted`**：构造函数里保留 `this.count` 作为数字（数量），
   这正是计数方法必须叫 `countItem()` 的历史原因 —— 命名债已经扩散到多个文件。

---

## 十二、模块依赖速查表

```
src/index.js
 ├─ util/config, util/logger
 ├─ core/bot ──────────── mineflayer, core/plugins, core/network
 ├─ core/preflight ────── net (手写 SLP)
 ├─ core/lockfile
 ├─ core/movement ─────── world/items, util/logger
 ├─ core/recovery ─────── core/movement, world/items
 ├─ core/memory
 ├─ world/worldView ───── world/items, mods/knowledge
 ├─ world/bodyWorldView ─ world/items            ← 非 mineflayer 时替换 worldView
 ├─ world/snapshotInventory
 ├─ world/items          ← 零依赖（纯表 + 纯函数）
 ├─ survival/{autoEat,combat,toolManager} ── world/items, core/movement
 ├─ mods/knowledge ────── fs（持久化 config/mod-knowledge.json）
 ├─ body/factory ──────── body/{mineflayerBody,mockBody,clientModBody}
 │                         └─ 全部实现 body/body.js 契约
 ├─ brain ─────────────── tasks/*, world/items, world/snapshotInventory,
 │                        core/movement(sleep), core/recovery
 ├─ tasks/* ───────────── tasks/task（基类）→ ctx.body / ctx.world
 ├─ chat/commands ─────── tasks/*, world/items
 └─ web/statusServer ──── http, world/items, util/logger
```

**无环依赖**，且 `world/items.js` 是唯一零依赖的叶子 —— 所以它被所有层引用而不会引入耦合。

---

## 十三、要改代码时看哪里

| 想做的事 | 改哪里 |
| --- | --- |
| 增加一条生存目标（例如「造床」） | `src/tasks/` 加任务类 → `src/brain.js` 的 `rules` 数组插入一条（注意优先级序号） |
| 让某个任务在新躯体下也能跑 | 把 `ctx.bot` / `ctx.nav` 换成 `this.body` / `this.world`，参考 `GatherWoodTask` |
| 调整吃什么 | `src/world/items.js` 的 `FOOD_PRIORITY` / `RAW_FOODS`；阈值在 `config/agent.json` 的 `behaviour.eatFoodThreshold` |
| 让 Agent 在某个 Mod 服上不那么保守 | `config/agent.json` 的 `survival.mineUnknownModBlocks`，或在 `config/mod-knowledge.json` 里手工补 `blocks{}` |
| 加游戏内指令 | `src/chat/commands.js` 的 `buildHandlers()` + `HELP`（HTTP 会自动同步） |
| 加状态 API 路由 | `src/web/statusServer.js` 的 `createServer` 回调 |
| 加一个躯体 | 实现 `src/body/body.js` 契约 → 在 `src/body/factory.js` 注册 kind |
| 调寻路行为 | `src/core/movement.js` 的 `refreshMovements()`（canDig / parkour / maxDropDown / 脚手架） |
| 修「机器人卡住不动」 | 先看 `src/core/recovery.js` 的 `needsRescue()` 判定，再看 `Brain` 的救援触发条件（30s 限流 + `!activeTask` 守卫） |
| 修「某个目标反复失败」 | `src/brain.js` 的 `maybeRetry()` / `isQuarantined()` / `_noteProgress()` 三处窗口参数 |

---

## 十四、一句话总结每个模块的「不可替代性」

| 模块 | 没有它会怎样 |
| --- | --- |
| `brain.js` 的**规则表** | 机器人不会自己找活干 |
| `brain.js` 的**串行闸门 + quarantine + 零进展检测** | 机器人会陷入静默死循环（这是 mineflayer Agent 最常见的翻车方式） |
| `body/` 抽象 | 项目被焊死在 mineflayer 上，永远进不了 Forge 服 |
| `core/recovery.js` | 出生在树冠上就当场报废 |
| `core/bot.rearmPathfinder()` | 第一条 `goto()` 就报 `Path was stopped`，完全走不动 |
| `movement.goto()` 的**空路径检测** | 机器人会「导航成功」但一步没走，表现为原地发呆 |
| `core/lockfile.js` | 双开 → `duplicate_login` 踢人风暴 |
| `mods/knowledge.js` | 在 Mod 服上会卡在挖不动的方块上 |
| `ClientModBody` + `mod-client` | 客户端必需 Mod 的 Forge 服完全无解 |
| `MockBody` | 调试决策逻辑必须开服务器，迭代从秒级退化到分钟级 |
| `core/preflight.js` | 对着连不上的服务器无限重连刷屏 |
| `memory.js` / `agent-state.json` | 没有跨会话记忆，也没有可观测界面 |
