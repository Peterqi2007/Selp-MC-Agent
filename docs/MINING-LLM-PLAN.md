# 挖矿机制优化方案：块级控制 + LLM 升级决策

> 日期：2026-10-10　状态：**方案（待排期实施）**。底座（`pillar` 原语、`pillar-up` 阶梯、四修复）
> 已落地并离线验证；真机证据与遗留问题见 §一。
> 关联：[`REWRITE-PLAN.md`](REWRITE-PLAN.md)（§十一 采矿重构 / §十二 走挖一体与防坠落）、
> [`ARCHITECTURE.md`](ARCHITECTURE.md)（Body 契约 / 技能层 / LLM 层）。

---

## 一、起因与真机证据（2026-10-10）

操作员在 `mc.example.com` 实测「挖钻石」，出现两类现象：**垫柱（pillar）只起 1 格左右**、
以及**脚本在复杂矿道里重复无效动作**。

| 证据 | 内容 |
| --- | --- |
| 尝试 1（异列：脚在 `(9,-59)`，矿在 `(5,-55)`） | `pillar steps=0/3 → 1/3`，重试 `0/2` 后 `place-failed`；期间 `dig refused at 9,-55 / 9,-54` |
| 尝试 2（同列：走到矿正下方 `(5,-59)`） | `pillar-up: rising 2 block(s)` 成功（脚 -59 → -57），随后 **`mined deepslate_diamond_ore @5,-55,171`、再挖 `5,-55,170`** |
| 反复动作 | 挖乱的竖井里出现 walkTo 原地 `stuck` 循环、direct 阶梯 `(5,-58)↔(6,-57)` 振荡、`unsafe tunnel waypoint … drop below` 把整个任务判 `danger` 停止 |

结论：**「不会在脚下放方块向上」已修复且真机生效**；剩下两个问题：

1. 升柱高度不可靠（只起 1~2 格）；
2. 宏技能在复杂地形会重复无效动作，而没有任何"停下来换策略"的机制。

---

## 二、现状控制流（基线）

`mine_ore`（`src/skills/mining.js`）对每个矿的执行阶梯（`rungs`：`src/skills/mining.js:1059-1195`）：

```
tunnel → clear-retry → direct → pillar-up → flank
```

- `tunnel`：把 `quoteApproach`（`src/skills/miningPlan.js`）产出的台阶计划整段交给客户端
  `ClientActions.Tunnel`（`mod-client/.../ClientActions.java:985`）边走边挖。
- `pillar-up`（`src/skills/mining.js:1120`）：矿高于脚 ≥2/3 格时启用——Node 预清跳跃通道 →
  `body.pillar()`（`src/body/clientModBody.js:859`）→ 重试 `direct`。
- 底层 `ClientActions.Pillar`（`ClientActions.java:1307`）：每 hop = 起跳 → 腾空时对脚下地板顶面
  放置 → 落到新块上。
- 导航层已有共享到达判定 `withinGoalRange`（`src/pathfinding/planner.js:52`）与停滞护栏
  `stalled`（`src/pathfinding/navigator.js:224`）。
- LLM 工具面目前只有宏：`do_task` / `do_skill`（`src/llm/tools/registry.js:97/137`），没有块级工具。

---

## 三、根因分析

### 3.1 一次性预清 vs 4.5 格挖掘距离

`ClientActions.dig`（`ClientActions.java:341-360`）的拒绝条件只有两个：

- 目标已是空气 → 直接成功（`already gone`）；
- **目标中心距玩家 > 4.5 格 → 拒绝**（日志里的 `dig refused` 即此，不是空气也不是权限）。

`pillar-up` 的预清循环一次性把 `脚上方 2 .. need+2` 的格子全挖掉，但：

- 脚在 `-59` 时，`-55` 的中心距 ≈ 4.51（dy=4.5 加水平偏移）→ 刚超限被拒；
- `-54`（dy=5.5）更不可能。

高处顶盖清不掉 → 后续 hop 的跳跃被顶住。尝试 1 的两次 `dig refused` 正是 `-55/-54`。

### 3.2 放置窗口被顶盖压缩到边缘

放置的物理条件：腾空时**脚底必须高于待填格顶面 ≥1.0 格**（否则方块与玩家自身碰撞，服务端拒绝）。

- 普通跳跃顶点 ≈ +1.25 格 → 天然窗口 ≈ 0.25 格；
- 若 `脚+3` 格处有实心（例：`-55` 的 deepslate 未清），头顶被卡在 -55 → 脚最高只到 **-56.8**，
  而放置需要 ≥ **-57.0** → 窗口只剩 **0.2 格（约 4 tick）**。

hop1 的头顶（`-57/-56`）预清成功 → 稳定成功；hop2 卡在 0.2 窗口 → 时序稍差即 `place-failed`
（连续 3 跳都失败）。尝试 2 在同样 0.2 窗口下却成功——说明**这是边缘可靠性问题，不是逻辑不允许**，
这正是"只搭高一格"观感的来源。

### 3.3 清障与升格没有交替递进

正确的人类做法：清掉够得到的 → 垫一格 → 再清更高的 → 再垫。
当前实现是"一次清到底（受 4.5 限制做不到）→ 连垫多格"，于是柱子在 1~2 格处停死。

### 3.4 宏技能的重复无效动作

`mine_ore` 把"先挖哪格、站哪、垫几格、从哪侧接近"全部写死在 JS 阶梯里。在被反复挖乱的竖井里：

- direct 阶梯要求"挖出新脚位后能跳上新块"，但乱空间里下方是空的（没有可站的台阶）→
  walkTo 报 `arrived` 却停在原地（宽容差）→ 反复 `stuck`；
- tunnel 的危险预检按"waypoint 下方悬空 >2 格"判定危险，对**上升**路线也生效 →
  整任务 `danger` 停止（2026-10-10 已用"上升豁免 + hazard 交给 pillar"缓解，但整类问题仍存在）；
- 失败的宏没有"停下来问大脑"的机制，只能在有限阶梯里穷举/重复。

---

## 四、优化目标与原则

1. **挖掘控制细化到块级**：一个工具能"挖一格 / 挖一批格 / 垫 n 格 / 走一条隧道"，全部有精确回执。
2. **给 LLM 决策空间**：复杂情况下由模型选择"先挖哪格、垫多高、从哪侧接近"，而不是 JS 穷举。
3. **快路径不变**：开阔地形仍走 `mine_ore` 确定性宏（零 LLM 成本、可离线测试）。
4. **安全边界不变**：所有块级工具仍过权限闸门（dig/place/useOn）、预算与危险检查；
   LLM 只能选工具与参数（无服务器指令、无 `say`、无自由代码）。

---

## 五、方案

### 5.1 块级工具集（新增，长动作进 TaskHub）

| 工具 | 语义 | 回执 | 约束 |
| --- | --- | --- | --- |
| `mine_block(x,y,z)` | 挖指定单块：核验可见/距离 → 必要时走到可达位 → 挖 → 复核 → 拾取 | `{ok, reason, failure, cell, block, dug}` | 单目标预算；不可达返回结构化原因 |
| `dig_cells([{x,y,z}…])` | 按序挖 1~N 格（清顶盖 / 短通道 / 除卡点） | 每格结果列表 + 失败格 | 每格过 gate / 危险 / 预算 |
| `pillar_up(n)` | 跳放升柱（已有底层，工具化） | `{ok, steps, reason}` | 失败返回实际升起格数 |
| `tunnel_to([waypoints])` | 已有 tunnel 原语工具化（含计划与台账） | `{ok, cells, stoppedAt}` | 预算内，断点报告 |
| `place_block(item, ref, face)` | 已有 place 技能（垫脚 / 搭桥） | `{ok}` | place gate |

实现路径：`src/llm/tools/registry.js` 注册；执行复用 `src/llm/tools/actuators.js:114 doSkill`
与现有 skills / Body；Schema 严格校验，未知参数拒绝。

### 5.2 停滞升级机制（核心）

宏技能增加"停滞判定 → 冻结 → 上报 → LLM 微操 → 回归"：

- **触发（任一）**：同一 `failure+cell` 连续 ≥2 次；位置位移 <0.1 格的循环 ≥3 次；预算过半仍无进展；
  阶梯全失败但目标仍可见。
- **冻结**：停止重试（杜绝重复无效动作），保留现场。
- **局面报告**（交给 LLM）：目标与当前位置、最近 K 次动作与失败回执（failure/cell/block）、
  `spatialGrid` 扫描图、可达方块、库存（镐/脚手架/火把）、已垫高度与已挖格。
- **LLM 微操**：1~3 步块级动作，例：`dig_cells 顶盖两格 → pillar_up 2 → mine_block 目标`。
- **预算**：每任务微操回合上限（建议 3）与 token 上限；超限回落为"跳过该矿 + 记录原因"。
- **回归**：微操后重新报价/继续宏；新的失败重新计数（防同一局面无限升级）。

### 5.3 防循环护栏

- **动作签名**：`tool + 归一化参数` 的哈希在滑动窗口重复 >N → 拒绝并强制升级 / 放弃。
- **重试自变**：宏每次重试必须改变至少一个自变量（目标格 / 方向 / 高度 / 工具），否则不再重试。
- **既有护栏复用**：`recoveryLadder` 的失败分级、`navigator` 的 `stalled`
  （`src/pathfinding/navigator.js:224`）、防坠落 / 危险检查保持生效。

### 5.4 迭代式清障垫柱（确定性增强，立即可落）

把"一次预清到底"改成循环：

```
while 还需要继续升:
  清掉 脚上方 2..min(4, 4.5 格可达范围) 内的实心格   # 只清够得到的
  pillar 1 格                                        # 垫一格（放置窗口立即变大）
  以新的位置重新计算可达范围（+1）
```

该循环单独实施即可把"只搭 1 格"变成"能垫多高就垫多高"，不依赖 LLM；
LLM 升级路径是它的超集（模型可决定何时停、换侧、放弃）。

### 5.5 两条路径的关系

```
常规地形 / 简单矿道 ──► mine_ore 确定性宏（tunnel / clear-retry / direct / pillar-up / flank）
                                │ 停滞判定（§5.2）
                                ▼
复杂环境（乱矿井 / 多盖层 / 视线遮挡 / 振荡循环）
        ──► 冻结 + 局面报告 ──► LLM 块级微操（§5.1）──► 回归宏继续 / 换目标（预算内）
```

---

## 六、实施步骤与验收

| 步骤 | 交付 | 离线验收 |
| --- | --- | --- |
| P1 | 注册 `mine_block / dig_cells / pillar_up / tunnel_to`（复用 skills / Body；长动作进 TaskHub） | `llm:dry` 工具 Schema / 枚举断言；`skills:test` 单工具用例 |
| P2 | 停滞升级器（判定 + 局面报告 + 微操回路） | mock 场景："1 宽竖井 + 顶盖 + 目标矿"宏失败 → 升级 → `dig_cells + pillar_up + mine_block` 成功；重复动作被拒 |
| P3 | 防循环护栏（签名窗口 + 重试自变） | 单测：同一动作重复超限被拒；重试必须变参 |
| P4 | 迭代式清障垫柱（§5.4） | mock：模拟 4.5 距离限制下连续垫 3+ 格；协议假 Mod 验证 |

真机验收清单（**待操作员排期，本轮不测**）：

- 竖井连续垫 3+ 格取矿；
- 复杂矿道取矿（本例的乱竖井）；
- 每次失败都有结构化回执，且不重复同一无效动作；
- LLM 微操回合 / 预算符合上限。

---

## 七、安全与边界（不可回归）

- `/register` 四道闸门、dig/place/useOn 权限闸门、`ask` 征询不变；
- 无"发服务器指令 / 自由代码 / 自主行动"工具；LLM 只能命名工具与参数；
- 危险（岩浆 / 深洞 / 怪物）、防坠落探底、预算与台账继续在 Body / 技能层强制，微操不能绕过；
- 单实例锁、死亡不自动恢复、停牌表不变。

---

## 八、风险与取舍

| 风险 | 缓解 |
| --- | --- |
| 升级路径 token 成本 / 延迟上升 | 仅停滞时调用；回合与 token 双上限；常路零成本 |
| LLM 微操选错格 | 工具级危险 / 权限 / 预算兜底；失败回执强制换策略 |
| 宏与微操双实现漂移 | 微操只调既有块级原语，不新增执行路径 |
| 复杂局面报告过长 | `spatialGrid` 压缩成字符图；只带最近 K 条动作 |

---

## 九、开放问题（需要操作员决策）

1. 微操回合上限（建议 3）与 token 预算数值；
2. 升级失败后的默认动作：跳过该矿继续，还是暂停任务等人工确认；
3. `dig_cells` 单次上限（建议 ≤8）与可挖方块白名单（是否允许挖玩家方块——默认仍 deny/ask）；
4. §5.4 的迭代清障是否同时用于 `recovery.climbOut`（mineflayer 旧路径与 clientmod 路径统一）。

---

## 附：相关文件索引（2026-10-10 基线）

| 关注点 | 文件 |
| --- | --- |
| 采矿宏与阶梯 | `src/skills/mining.js`（rungs:1059、预检:993、pillar-up:1120） |
| 报价 / 几何 / 台账 | `src/skills/miningPlan.js` |
| 客户端隧道 / 垫柱控制器 | `mod-client/src/main/java/dev/agentclient/ClientActions.java`（Tunnel:985、Pillar:1307、dig 距离:352） |
| Mod 动作协议 | `mod-client/src/main/java/dev/agentclient/ControlHttpServer.java`（pillar:462） |
| Node 躯体 | `src/body/clientModBody.js`（tunnel:817、pillar:859） |
| 导航到达 / 停滞 | `src/pathfinding/planner.js:52`、`src/pathfinding/navigator.js:224` |
| 失败阶梯 | `src/core/recoveryLadder.js` |
| 任务槽 | `src/core/taskHub.js` |
| LLM 工具 | `src/llm/tools/registry.js`（do_task:97、do_skill:137）、`src/llm/tools/actuators.js:114` |
| 感知网格 | `src/world/spatialGrid.js` |
| 权限闸门 | `src/core/permissionGate.js` |
| 离线测试 | `scripts/skills-test.js`、`scripts/llm-dry.js`、`scripts/selftest.js` |

> 本批已落地的底座（供 P1-P4 复用）：`Pillar` Mod 控制器 + `ClientModBody.pillar` + `mine_ore` 的
> `pillar-up` 阶梯（含 hazard 交接、上升豁免、到达判定统一、`stalled` 护栏）。这些改动尚未提交 git。
