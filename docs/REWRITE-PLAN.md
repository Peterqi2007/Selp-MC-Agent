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
| Phase 2 `craft` | ✅ 完成 | `src/skills/recipes.js`（prismarine-recipe + minecraft-data，含递归子配方：原木→木板→木棍→镐）+ `src/skills/crafting.js`（2x2 物品栏网格 / 3x3 工作台菜单点击、光标管理、shift-click 产出）；协议假 Mod 新增合成模拟；`client:test` 42/42（含"原木→木板→工作台→木镐"全链路）；`!craft` 已接到技能 |
| Phase 2 `smelt` | ⏳ 进行中 | 依赖：炉菜单 0=输入 / 1=燃料 / 2=产出 + 菜单轮询；计划走 shift-click 投料/取货 |
| Phase 2 `farm` | ⏳ 待做 | 需要 Mod 上报作物 `age`（当前方块扫描只有方块 id）；计划在 `/state` 增加 `crops` |
| Phase 2 `sleep` | ⏳ 待做 | `use_on` 床 + `/state.time.isDay` 轮询 |
| Phase 3 LLM 接线 | ⏳ 待做 | 意图枚举扩展、`do_skill` 工具、能力表改读注册表、中文回退语料、`llm:dry` 覆盖 |
