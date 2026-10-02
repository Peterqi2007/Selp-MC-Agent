# 躯体抽象层（Body）：为什么要把"决策"和"躯体"分开

## 一、问题背景

最初的 agent 和 mineflayer 是**焊死**的：`tasks/` 里直接调 `bot.dig()`、`nav.goto()`、
`bot.inventory`。这在只有一种玩法时没问题，直到我们遇到这个事实：

> **Forge 1.20.1 服务器会拒绝原版协议客户端**（`This server has mods that require Forge
> to be installed on the client`），而 mineflayer 只会原版协议。

于是我们需要第二种"怎么玩"的方式：**跑一个真实的 Forge 客户端，从内部用控制 Mod 驱动它**。

这就产生了一个架构要求：**"做什么"（决策）不应该依赖"用什么在玩"（躯体）。**

## 二、分层

```
┌──────────────────────────────────────────────────────────────┐
│ 决策层（与躯体完全无关，100% 可复用）                          │
│   src/brain.js        优先级目标表                            │
│   src/tasks/          任务定义（砍树/挖矿/合成/庇护所…）        │
│   src/survival/       自动吃 / 战斗 / 装备                     │
│   src/world/          生存知识表（食物/燃料/工具等级）          │
│   src/mods/           Mod 知识（签名推断）                     │
└───────────────────────────┬──────────────────────────────────┘
                            │  Body 接口（src/body/body.js）
                            │   snapshot() / moveTo() / dig() / place() / chat() ...
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐  ┌───────────────┐  ┌──────────────────────┐
│MineflayerBody │  │  MockBody     │  │ ClientModBody（待建） │
│ 无头、原版协议 │  │ 脚本化假世界   │  │ 真 Forge 客户端+控制Mod│
│ 原版/Paper/Fabric│ │ 单元测试用    │  │ Forge/NeoForge 服 ✅  │
└───────────────┘  └───────────────┘  └──────────────────────┘
```

## 三、接口契约（`src/body/body.js`）

设计原则，每条都对应一次真实的踩坑：

| 约定 | 原因 |
| --- | --- |
| 每个方法都是 `async` 且**必须 settle** | 躯体自己负责超时，绝不能把大脑挂死 |
| 无法支持的能力抛 `BodyUnavailableError` | 决策层据此**降级**而不是崩溃 |
| `snapshot()` **不阻塞**，返回最近一次缓存 | 真客户端只能在 tick 里更新状态 |
| 接口里**不出现任何 mineflayer / Minecraft 类名** | 否则抽象层白做 |
| `interrupt()` 同步且可重复调用 | 反射层要能随时打断 |

### 感知

```js
snapshot()                        // 一个扁平的、可序列化的状态对象
blockAt(position)                 // → {name, position} | null
findBlocks(names, opts)            // 精确名字
findBlocksMatching(fn, opts)       // 谓词匹配（"任意原木"就是这么表达的）
hostiles(maxDistance)              // 敌对实体，按距离排序
itemDrops(maxDistance)             // 掉落物
```

### 动作

```js
moveTo(position, opts)             // → boolean（是否到达）
dig(block, opts)                   // → boolean（方块是否消失）
place(itemName, refBlock, face)    // → boolean
equip(itemName) / equipBest(kind) / equipForBlock(block) / equipArmor()
consume(itemName?)                 // 吃东西（注意不叫 eat，见下）
attack(entity, opts)               // → boolean
chat(message)                      // `/login xxx` 也走这里
lookAt(position)
interrupt(reason)
```

## 四、三个实现

### `MineflayerBody`（已有，默认）

**刻意做成"包装"而不是"重写"** —— 它包住现有的 `BotController` / `Navigator` /
`WorldView` / `Combat` / `AutoEat` / `ToolManager`，所以之前辛苦调好的行为
（pathfinder latch 恢复、空路径检测、物理脱困、任务串行化）**一点都不动**。

它还暴露一个刻意收窄的逃生口 `body.raw`（=BotController），给确实需要 mineflayer 的地方用。

> **踩坑记录**：AutoEat 系统存在 `this.eat` 上，而实例属性会**遮蔽**原型方法 ——
> 所以躯体的吃东西方法必须叫 `consume()` 而不是 `eat()`。
> 症状是 `typeof body.eat === 'undefined'`，但 `MineflayerBody.prototype.eat` 明明是函数。
> 这个坑很隐蔽，写在这里免得再踩。

### `MockBody`（新，测试用）

**这是抽象层的回报。** 它提供一个粗糙但够用的假世界：
平面 + 可配置方块列表 + 无限移动 + 瞬间挖掘 + 可配置配方表。

粗糙是刻意的 —— 我们测的是**决策逻辑**，不是物理。

它让一批以前"没有服务器就测不了"的问题变成可测：

* `tasks/` 真的只依赖契约吗？还是偷偷用了 mineflayer 特性？
* 只有 2 棵树的世界里，"木头→木板→木棍→木镐"这条链能收敛吗？
* 背包满了会怎样？所有敌对生物贴脸会怎样？

```powershell
npm run body:test        # 用 MockBody 跑决策层
```

### `ClientModBody`（待建）

真 Forge 客户端 + 控制 Mod 的躯体。前提是 `mod-client/` 那套东西先建起来。
在它存在之前，`body.kind="clientmod"` 会**明确报错并拒绝启动**，而不是假装连上了。

## 五、怎么切换

```powershell
node src/index.js --body mineflayer    # 无头（默认）
node src/index.js --body mock          # 脚本化世界
node src/index.js --body clientmod     # 真 Forge 客户端（待建）
$env:MC_BODY='clientmod'; npm run agent
```

或者改 `config/agent.json`：

```json
{ "body": { "kind": "mineflayer" } }
```

查当前可用的躯体：

```powershell
npm run body:info
```

## 六、验证

```powershell
npm run selftest
```

第 8 节专门测这个抽象层（8 项）：

```
PASS  Body contract: unimplemented methods raise BodyUnavailableError
PASS  MineflayerBody satisfies the contract surface - 18 methods, reports unready correctly
PASS  MockBody satisfies the same contract surface - 18 methods
PASS  MockBody: connect -> perceive -> dig -> pick up - dug a tree and collected the drop
PASS  MockBody: night/hostiles are reported like a real world - isDay=false and the zombie is visible
PASS  MockBody: crafting consumes ingredients and fails loudly
PASS  MockBody: eating restores food - food 8 -> 14
PASS  decision layer can be driven by a non-mineflayer body - tasks drive a mock body with no mineflayer
```

最后一项是关键：**它证明决策层真的能和 mineflayer 解耦。**

### 更有说服力的一次实跑

`npm run agent:mock` —— **完全没有 mineflayer、完全没有服务器**，决策层跑出完整生存链：

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

砍树 → 补前置材料 → 合成工作台 → 木棍 → 木镐 → 挖石头，**全链路在假世界里跑通**。
这意味着以后调试决策逻辑不再需要开服务器，迭代速度从"分钟级"回到"秒级"。

## 六、这轮踩到的三个新坑（都记在这里）

| 坑 | 症状 | 修法 |
| --- | --- | --- |
| `blockAt` 是**相对偏移**，任务以为是绝对坐标 | 树明明在，任务说"没树" | 新增语义明确的 `blockAtAbsolute(position)`，两种视图都提供，`blockAt` 保留为相对偏移 |
| **裸名 vs 带命名空间名** | 传 `'stone'`，body 报 `minecraft:stone`，匹配不上 → "附近没有石头" | `matchNames()` 统一在**两侧**都剥命名空间；`WorldView` 与 `BodyWorldView` 都用 |
| **`count` 属性遮蔽 `count()` 方法** | `this.count is not a function`，每次合成必炸 | 计数方法统一命名 `countItem()`（`this.count` 是"要合成几个"） |

第三个坑和之前 `MineflayerBody.eat` 被 `this.eat` 遮蔽是**同一类错误**：
JavaScript 里实例属性会静默吃掉同名原型方法。这个项目里已经踩了两次，命名上要格外小心。

## 七、下一步

抽象层已经就位，所以第二步（Forge 客户端控制 Mod）的工作量变成
**"再实现一个 Body"**，而不是重写项目。

落地顺序：

1. ✅ 抽 `Body` 接口
2. ✅ `MineflayerBody` 实现（行为不变）+ selftest 保证不回归
3. ✅ `MockBody` 实现 + 证明决策层解耦
4. ⏳ `scripts/launch-forge-client.js` + 客户端运行侦察（`docs/CLIENT-MOD-RECON.md`）
5. ⏳ `mod-client/`：Forge 1.20.1 客户端控制 Mod（WebSocket + 状态读取 + 动作执行）
6. ⏳ `ClientModBody`：Node 侧 RPC 实现
7. ⏳ 端到端：PCL 启动客户端 → 自动 `/login` → agent 接管
