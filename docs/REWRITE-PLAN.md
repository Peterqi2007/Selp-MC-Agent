# 参考重写计划（mc_aiplayer / mindcraft）

对应操作员 2026-10-02 的指令：「参考 mc_aiplayer / mindcraft 重写，实现玩家绝大部分操作」。
参考仓库留在 `refs/mc_aiplayer`、`refs/mindcraft`（gitignore，不进入本项目历史）。

---

## 一、从两个参考项目各取什么

| 来源 | 取它的什么 | 不取什么 |
| --- | --- | --- |
| **mc_aiplayer**（Fabric 服务端 Mod，63 个 LLM 工具 + 34 个确定性 Task） | 「LLM 选意图 → 确定性技能执行」的分层；工具即能力边界、参数严格校验；能力自省（strict/operator 门控）；Goal→Task 的规划思路 | 服务端假玩家实现（我们进不了别人的服，只能客户端）；它那套 33 万行的 Java Task 状态机 |
| **mindcraft**（mineflayer，85KB skills.js + 任务框架） | 技能目录的覆盖范围（移动/采集/合成/熔炼/容器/种田/战斗/交易/睡觉/钓鱼）；技能文档先给模型看、再执行的思路；构造/烹饪等 JSON profile 驱动的任务模板 | mineflayer 本体（连不上带客户端 Mod 的 Forge 服）；自由代码生成（`!newAction`）——与我们的严格 Schema 安全线冲突 |

## 二、架构决定：Mod 是薄手，Node 是大脑

```
玩家/LLM  →  src/skills/*（确定性技能层，可离线测试）
                ↓ 只调用 Body 契约
            src/body/clientModBody.js（协议 + 轮询）
                ↓ HTTP 127.0.0.1:8899
            mod-client（薄手：移动/挖/放/右键/读菜单/点槽位/攻击/切手持/丢弃）
```

**为什么**：Mod 里的逻辑无法离线测试、每次改动都要重启客户端；Node 里的逻辑可以用 MockBody
和协议假服务器在毫秒级验证。所以 Java 只提供「人的手能做到的最小原子动作」，一切决策、配方、
库存编排都在 Node。这也是上一轮真机事故的教训——把策略写进两个地方，它们必然漂移。

### Mod 现有原语（`ControlHttpServer.execute`）

| 类别 | 原语 |
| --- | --- |
| 移动 | `moveto/goto`、`look`、`lookat`、`stop`、`resync` |
| 世界 | `dig/mine`、`place`、`useon`（右键方块面，1.20 新增） |
| 物品 | `select`（切手持）、`use`（吃/用）、`drop [1]` |
| 菜单 | `menu`（转储当前菜单槽位，1.20 新增）、`click <slot> [button] [mode]`（1.20 新增）、`close`（1.20 新增） |
| 战斗 | `attack <entityId> [timeoutMs]` |
| 感知 | `GET /state`（40817 格方块、实体、背包、界面状态）、`GET /chatlog`、`GET /progress` |

## 三、本轮已完成（第一刀 + 第二刀）

1. **工具策略唯一化**（`src/world/toolPolicy.js`）：镐的等级门槛只作用于需要镐的方块；
   锹/斧/剪刀一律只是偏好；泥土类**永不**被工具卡住。修掉真机「没镐子挖不了泥土」。
2. **树木识别重写**（`src/world/safety.js`）：26 连通原木簇 + 底座/人造方块/树冠三规则，
   支持金合欢斜干、2x2 深色橡木、高树冠、被砍一半的悬浮树干、模组树名；一片孤叶骗不过。
3. **Mod 三个新原语**：`useon` / `menu` / `click`（+`close`），编译并安装到 PCL 客户端
   （agent-client 43896 字节）。
4. **技能层 v1**（`src/skills/`，12 个技能，全部可离线测试）：

| 技能 | 状态 | 说明 |
| --- | --- | --- |
| `equip` / `eat` / `drop` / `armor` | ✅ | 手持、吃最优食物、丢指定数量、快速穿戴护甲 |
| `place` / `use_on` | ✅ | 放方块；右键方块面（锄地、播种、水桶、按钮、开容器） |
| `attack` / `defend` | ✅ | 打最近敌对目标；自卫循环 |
| `explore` / `come` | ✅ | 换方向探索（解决「扫描内没树」）；走到玩家身边 |
| `withdraw` / `deposit` | 🅱 beta | 走菜单点击路径开箱存取；离线协议已测，**待真机验证** |

5. **验证**：`skills:test` 17/17（新增）、`client:test` 32/32（26→32）、`p0:verify` 6/6、
   `selftest` 155/155。

## 四、路线图（按对「像玩家一样玩」的价值排序）

### Phase 2：合成 / 熔炼 / 种田（下一轮）

| 操作 | 依赖的 Mod 原语 | 备注 |
| --- | --- | --- |
| `craft`：任意原版配方 | `menu`/`click`（已有）+ 配方计划器 | 2x2 用物品栏菜单（containerId 0，格 1-4）；3x3 先 `use_on` 工作台（格 1-9，结果 0）。配方源：`minecraft-data`/`prismarine-recipe` + 内置必需配方兜底 |
| `smelt`：熔炉烧炼 | 同上（炉：输入 0 / 燃料 1 / 产出 2） | 需要放置/打开熔炉、投料、等待、取出 |
| `farm`：锄地→播种→收获 | `use_on` + `select` | 作物成熟判定走方块扫描 |
| `sleep`：床过夜 | `use_on` 床 | 需要夜晚判定（/state 已有 time） |

### Phase 3：LLM 接线（同一批）

- 意图枚举从 `{chop,mine,collect}` 扩展到技能目录；新增 `do_skill(name, params)` 工具，
  参数 Schema 由 `skills/registry.js` 的声明自动生成（不再手写第二份）。
- 能力表（`blackboard.js`）改为读技能注册表 →「模型看到的」永远等于「真的能做的」。
- 回退路由器补中文语料：饿了→eat、被围→defend、把东西收起来→deposit、过夜→sleep、
  跟我来→come。
- `llm:dry` 语料扩到覆盖每个技能至少 2 条中文 + 1 条注入用例。

### Phase 4：自主生存（参考 mc_aiplayer 的 Goal 层）

- 生存守护：低血吃、夜间睡觉/插火把、敌对靠近自卫、死亡后回尸体捡装备。
- 目标规划器：`achieve(石镐)` 这类目标拆成 采集→合成→装备 的确定性链（mc_aiplayer 的
  `achieve_goal` / `achieve_armor` 思路），而不是让模型自己分步。
- 记忆：基地/箱子位置（`memory.landmark` 已有雏形）、采矿断点续挖。

### Phase 5：其余操作

`fish`（钓鱼竿 + 浮标检测）、`trade`（村民菜单）、`breed`（喂食）、`store`/`stockpile`
（按基地集中管理）、`hunt`（被动生物实体扫描——Mod 目前只上报 hostile 实体，需要扩展）。

## 五、安全边界（延续 P0，不可回归）

- `/register` 永远禁止；运动模型不挖穿、不进岩浆；不挖未知 Mod 方块（`mods.isMineable`）。
- 技能参数走注册表 Schema；没有 `say` 工具，说话只能是对玩家的回复。
- 人造方块保护（`safety.avoidManMade`）+ 树冠判据继续生效；这两条是上一轮真机事故换来的。

## 六、真机验证清单（交给操作员）

新 jar 已安装（43896 字节），重启客户端后：

1. `!mine dirt 4` —— 不再要求镐子，挖到 4 个泥土；
2. 站在真树前 `!chop 4`、站在原木柱前 `!chop 4` —— 前者成功、后者被拒（`no leaves`）；
3. `!eat`（背包放牛排）—— 食物值上升；
4. `!attack`（附近有僵尸）—— 击杀；
5. 放一个箱子并往里放点东西 → `!withdraw <item>` / `!deposit` —— 存取成功（beta 项，重点看）；
6. `!explore 16` —— 走出一段并刷新视野。

---

## 七、Phase 2 / Phase 3 进度（2026-10-02 续）

> 操作员要求：完成 Phase 2 + Phase 3；**功能测试只在客户端 + 个人服务器上做，
> 不在真实服务器（mc.example.com）上测试**。

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| Phase 2 `craft` | ✅ 完成（真机 2/2 通过） | `src/skills/recipes.js`（prismarine-recipe + minecraft-data，含递归子配方：原木→木板→木棍→镐）+ `src/skills/crafting.js`（2x2 物品栏网格 / 3x3 工作台菜单点击、光标管理、shift-click 产出）；协议假 Mod 新增合成模拟；`client:test` 48/48（含"原木→木板→工作台→木镐"全链路）。**真机曾全挂**：Mod 的 `click` 解析用 `numbers(rest,3)` 要求三个 token 全是数字，`click <槽> <键> <模式>` 被判 `usage` —— 所有带模式的点击从未执行过；假 Mod 当时过于宽松，42 项离线全绿却掩盖了真机失效。现已修正 Java 解析、把假 Mod 解析规则对齐并加 5 条契约检查 |
| Phase 2 `smelt` | ✅ 完成（真机 1/1 通过） | `src/skills/smelting.js`：开炉（use_on）→ 投料/燃料 → 轮询产出 → 取货。**真机失败根因不是点击丢失**：香草炉子菜单的 quick-move 先判"能不能熔炼"再判"能不能当燃料"，原木/木板/木棍本身可熔炼（→木炭），会被优先送往输入槽，输入槽被生铁占住时整个操作失败、燃料槽永远为空。现在：优先选纯燃料（煤等）→ 装入后校验燃料槽真的收到 → 未收到则改用手动放置（拿起→右键燃料槽→余料放回）；另新增原木→木炭映射 |
| Phase 2 `farm` | ✅ 完成 | Mod `/state` 新增 `crops`（方块状态 `age`/`maxAge`，12 格）；`src/skills/farming.js`：收成熟作物 → 锄地 → 播种；`skills:test` 覆盖（收 1 / 锄 1 / 种 1）；`!farm` 已接 |
| Phase 2 `sleep` | ✅ 完成（真机实测睡到天亮） | `src/skills/farming.js` 内 `sleep`：夜里走到床边 use_on 并轮询到天亮。真机实测：世界时间 `23232` → 次日 `30`，`{"ok":true,"slept":true}`。**注意**：Mod 的 `time.isDay`（`Level.isDay()`）在这套整合包里凌晨 2 点仍报 `true`，技能与验收脚本改为按世界时钟判断（`timeOfDay` 12542–23458 为夜）；失败时读取 `/chatlog` 把游戏原话（如"只能在夜间睡觉"）作为原因返回 |
| Phase 3 LLM 接线 | ✅ 完成 | ① 意图枚举新增 `skill`（`intent.js`，名称/参数由技能注册表校验）；② 新增 `do_skill(name, params)` 工具（`tools/registry.js` + `actuators.doSkill`），并在 `toOpenAiTools(ctx)` 里**按注册表自动生成**可用技能枚举；③ `blackboard.js` 的能力表和系统提示词改由 `skills.describe(ctx)` 生成（延迟项 fish/trade/breed/hunt/light/store/build 如实标 no）；④ `fallbackRouter.js` 中文语料覆盖 eat/sleep/farm/craft/smelt/defend/attack/deposit/withdraw/explore；⑤ `llm:dry`：**路由 53/53**（每技能 ≥2 条中文 + 3 条注入用例）、schema 16/16、工具 25/25 |

### 八、功能测试：客户端 + 个人服务器（不碰真实服务器）

按操作员要求，Phase 2/3 的功能测试只在**本机个人服务器**上做。路径已验证：

```powershell
# 1. 只启动本地个人服务器（vanilla 1.20.1，不起 mineflayer agent）
node scripts/run-all.js --no-agent
#   -> "Done (3.383s)!" 并监听 127.0.0.1:25565（已实测）

# 2. 让 Forge 客户端进入个人服务器（PCL 客户端 + 最新控制 Mod）
npm run client:launch -- --server 127.0.0.1:25565

# 3. Agent 用 clientmod 身体 + local 档位连同一个服务器
npm run agent:client -- --profile local     # 或：node src/index.js --body clientmod --profile local
```

进入世界后逐项测试（面板 http://127.0.0.1:8766/panel 可看路由结果）：

| 指令 | 预期 |
| --- | --- |
| `!craft wooden_pickaxe` | 背包有 ≥2 原木时：自动做木板/木棍/工作台？——先 `!craft crafting_table` 并 `!place` 放下，再合成镐 |
| `!smelt raw_iron 1` | 附近有熔炉、背包有生铁+煤：产出铁锭 |
| `!farm 6` | 有锄+种子：收成熟作物、锄地、播种 |
| `!sleep` | 夜里、12 格内有床：睡到天亮 |
| `@猫娘 饿了` / `把东西存起来` / `帮我把生铁烧了` | 走中文回退或 LLM，动作落在对应技能上 |

### 八之二、真机验收结果（2026-10-02，修复后）

```powershell
# 客户端已在单人世界（AgentSteve），操作员手动备料；不上任何真实服务器
npm run personal:test -- --skip-server --no-prepare --allow-modded
# => personal functional test: 11/11 passed
```

11 项全过，其中之前失败的 3 项：

| 项 | 结果 |
| --- | --- |
| `craft: crafting table from planks (2x2 grid)` | ✅ `crafted 1x crafting_table (1 intermediate craft(s))` |
| `craft: wooden pickaxe via the placed table (sub-crafts)` | ✅ `crafted 1x wooden_pickaxe` |
| `smelt: raw iron becomes an iron ingot` | ✅ `smelted 1x iron_ingot` |

`sleep` 这条在白天会自动跳过（记为通过）；睡觉本体已用 `node scripts/sleep-probe.js` 单测过：
夜里上床后世界时间 `23232 → 30`，`slept: true`。

**这一轮真机失败教给我们的规律（已固化）**：离线假 Mod 必须和 Java 端**同一套解析规则**，
否则"点击被拒绝"这种协议层问题会在离线全绿的情况下隐藏（假 Mod 原来对 `click` 不管参数都回 ok）。
现在假 Mod 复刻了 Java 的 token 规则，`client:test` 48/48，其中 5 条专门锁
`click <槽> <模式>`（无按键）、非数字槽位拒绝、`look` 两参数、`attack` 两参数。

真机调试工具（可直接复用）：

| 工具 | 用途 |
| --- | --- |
| `node scripts/menu-probe.js [click <槽> <键> <模式> \| useon x y z face \| grid2x2 <源槽> <格槽>]` | 逐步驱动菜单点击，每步打印菜单/光标/结果槽 |
| `node scripts/smelt-probe.js raw_iron 1` | 带日志代理地跑一遍 `smelt` 技能，逐步打印 useOn/menu/click 与前后菜单 |
| `node scripts/sleep-probe.js 90` | 跑一遍 `sleep` 技能并打印世界时钟与游戏聊天原话 |
| `node scripts/launch-forge-client.js --offline --singleplayer "<世界文件夹>"` | 重启客户端后**自动重进单人世界**（`--quickPlaySingleplayer`），不需要人手点主菜单 |

> 重编译 Mod 后必须重启客户端才会生效：`npm run client:build` → `npm run client:install` → 重启。
> 本轮重启用的就是 `--singleplayer "新的世界1"`，关客户端走的是 `CloseMainWindow()`（优雅退出，世界会存档）。

### 八之三、真机最终测试：目标服务器（mc.example.com，操作员指定）

操作员 22:01 进入 mc.example.com:25565 后指定任务：**合成一把锄头 → 在水边开垦 6 格耕地 → 种完背包里
的小麦种子**（6 个）。执行方式：`scripts/run-skill.js` 逐个技能驱动同一个客户端。

结果（全部以服务器/区块状态核验，不只看技能自报）：

| 步骤 | 结果 |
| --- | --- |
| 合成锄头 | ✅ `wooden_hoe`（背包里的原木→木板子合成；先在原地合成工作台放到 `18,64,65`，再走过去合成） |
| 开垦 6 格耕地 | ✅ 6 块 `farmland` 在水边（`18,62,68 / 19,62,67 / 19,62,68 / 19,62,69 / 20,62,67 / 20,62,69`），同一层 4 格内有水源 → 湿润 |
| 种完小麦种子 | ✅ 6 株 `minecraft:wheat`（age 0）在耕地上方，背包 `wheat_seeds` = 0 |

这一轮暴露并修复的真机缺陷（都在 `clientModBody.js` / `farming.js` / `crafting.js`）：

1. **`select` 只搜索快捷栏**：物品放在主背包时 `equip` 静默失败 → "耕地 6 次"其实是拿着种子点草地。
   现在 `equip` 会先用真实菜单点击把物品搬进空的快捷栏格再选中。
2. **物品名必须带命名空间**：`place ... crafting_table` 与 `nameOf(stack).equals(...)` 比较失败 → 放置
   变成对着方块挥空手。`place`/`equip` 现在统一补 `minecraft:` 前缀。
3. **水化判定要和香草一致**：`FarmBlock` 只认同层或高一层的 4 格内水源；水在耕地下方一格不算 —— 之前在
   岸上（y63）耕的地是干的，没种东西就退回泥土，看起来像"计数虚报"。现在优先湿润地块，并把"刚耕的地"
   排在播种列表最前。
4. **技能计数必须以世界状态为准**：Mod 的 `ok` 只表示"交互指令被接受"。现在锄地后重读方块（确认变成
   `farmland`）、播种后重读背包（确认种子真的少了一颗）。
5. **走到工作台**：craft 找不到 6 格内的工作台时，会搜索 24 格并走过去（9 格外的那个工作台不再直接放弃）。
6. `farm` 新增 `plots`（精确格数）、`till` / `plant`（分步执行）参数；`MockBody` 现在真的模拟锄地/播种，
   离线用例无法再用"返回 ok"糊弄过去。

### 八之四、跨河移动（2026-10-02，mc.example.com 实测）

操作员把角色带到一条约 20 格宽的大河（x -58..-10、z 168..216）后要求测试横渡。测试工具：
`node scripts/move-probe.js <x> <y> <z> [range] [timeoutSeconds] [--raw]`（每秒采样位置/氧气/是否在
水中，输出完整轨迹）。

**修复前**（`ClientActions.WalkTo`）：机器人下水并游了 13 格，但在对岸边缘卡住 17 秒（氧气掉到 -8），
6 秒无进展被判 `stuck`，A* 绕路 4 次后 `noPath` 放弃。根因：走路器只在
`horizontalCollision && onGround` 时才按跳跃键，而在水里"跳跃"就是**上浮/爬上岸**的键 —— 浮在水面的
机器人永远不满足 `onGround`，所以爬不上 1 格高的河岸。

**修复**（`mod-client`）：水里朝上（`dy > -0.1`）或贴着河岸（`horizontalCollision`）时按住跳跃键
（下潜的路径点仍允许下沉），且这种"游泳上浮"不计入"连续跳跃卡墙"的放弃计数。重编译 jar → 重启客户端 →
`/login` 自动重连后复测：

| 路线 | 结果 |
| --- | --- |
| 短距离（水沟 7 格，爬岸） | ✅ 3.1s 上岸 |
| 北岸 → 南岸（约 20 格） | ✅ 12.3s，沿河床下潜最深 y59，氧气最低 201/300 |
| 南岸 → 北岸（约 20 格） | ✅ 10.3s，贴水面游（y61.5–63），氧气最低 284/300 |

> 说明：Mod 改动必须重编译 + 重启客户端才生效（本轮重启后角色回到落水点，`login <your-password>` 自动登录成功）。
> 目前路线由 A* 决定：有时沿河床下潜、有时贴水面；两种都能过，但深水长距离仍有溺水风险，
> 后续可让规划器对水面路径加权。

### 八之五、攻击怪物（2026-10-02 夜，mc.example.com 实测）

操作员把角色带到刷怪区后测试战斗。第一轮暴露了三个真机问题（操作员当场指出：**那两只蛆是他自己补掉的，
不是机器人杀的**——所以第一轮的"击杀"全部不可信）：

1. **Mod 返回语义错**：`ClientActions.attack` 在目标死亡时返回 `false`（循环条件只判断 `isAlive()`），
   于是每次击杀都被技能层报成"还活着"。现在目标在战斗中死亡 = 胜利，只有从未有效的 id 才返回 false。
2. **挥剑不按冷却**：旧循环每 250ms 点一次；香草按攻击条结算伤害，连点只有约 20% 伤害。现在
   `getAttackStrengthScale(0.5) >= 0.92` 才挥剑（充能一击），追击间隔 100ms。
3. **技能不换武器**：机器人曾拿着面包打僵尸。技能层现在按 剑→斧 的材质顺序自动装备最好的武器。

另外两处：Mod 追击时遇到 1 格台阶/目标在正上方会按跳跃键；技能层新增 `vertical`（默认 ±4 格）只打
同一层的目标——17 格外的洞穴亡灵不再被直线追击（那等于往悬崖里走）。

**复测（干净击杀）**：

| 项 | 结果 |
| --- | --- |
| 目标 | `born_in_chaos_v1:corpse_fly`，起始 13 HP |
| 追击 | 23m → 3m，约 10 秒（自动从面包换成石剑） |
| 战斗 | 3m 内两秒内 13 → 5.5 → 死亡消失；机器人血量 12.1 → 14.1（未受伤） |
| 结果 | `{"ok":true,"detail":"killed corpse_fly …"}`，Mod 端确认目标死亡 |

> 仍有的限制：追击是"直线前进"而不是寻路，开阔地可用；遇到墙/沟/悬崖仍会失败或冒险，后续可接
> `PathNavigator` 做追击。

### 八之六、寻矿挖掘（2026-10-03，操作员改规格）

操作员把挖矿需求从"鱼骨"改成**"锁定最近矿物 → 挖穿前进 → 采集"**，并给出硬性约束：

* 搜索范围：x/z 相对距离 ≤ 30 格、垂直 |dy| ≤ 5 格（可穿墙）；
* 上下移动走倾斜矿道（向下挖三格：新脚位 + 脚位 + 头位；向上挖新脚位/新头位，保留一格台阶跳上去）；
* 脚下方块亮度 ≤ 2 时插火把；火把耗尽且亮度 ≤ 2 → **暂停任务**；
* 挖到大型矿洞、悬崖边缘或岩浆池 → **停下**（真机事故：机器人掉下悬崖被 Swarmer 打死）。

实现（`src/skills/mining.js` 的 `mine_ore`，取代 `branch_mine`）+ Mod 支持（扫描半径 24→30、
新增 `lightLevel`/`blockLight` 上报）。真机实测后又按操作员反馈修了四处：

1. **掉落物不捡**：矿石挖掉后掉落留在原地就跑去下一处。现在每挖一块矿、每 4 步隧道、以及任务结束前
   都会 `collectDrops()`——走到掉落物旁并**确认它从掉落列表里消失**才算捡到；掉落物悬在洞口上方时
   直接放弃（不为了一个掉落物坠崖）。
2. **矿堆只挖一半**：矿在正上方/正下方时原逻辑去挖竖直井，机器人爬不上去 → 失败 → 该矿被拉黑。
   现在垂直矿改为**斜向阶梯步**；并在 4 格触及范围内**直接挖掉**（矿堆相邻的矿石通常就在手边），
   这才把整堆矿收干净。
3. **火把**：插火把的候选点从"身后/脚下/身前三点"改成 **7×7×4 邻域里所有地面可放的空格**（斜坡上
   原来的三点全是空气，实测亮度 0 却插不下去）；插完立即**切回镐子**。
4. **危险区回避**：每次迈步前检查目标格——±1 水平 / ±3 垂直内有岩浆、或目标格下方坠落深度 > 2 格，
   立即停止任务（`stopped: 'danger'` + 原因）；矿洞开阔度 ≥ 45% 判定为大型矿洞同样停止。
