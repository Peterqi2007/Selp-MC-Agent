# 战斗 v3 方案与验收清单：真撤退 / 远程主动进攻 / 反卡死 / TACZ 枪械

> 状态：**已实现并全量离线验证（2026-10-13）**；Mod 已重编译**并已安装**
> （`mod-client/dist/agent-client-1.0.0.jar` 75000 字节，2026-10-13 17:37 构建，与 PCL 版本目录在装的 jar
> 字节一致，已在 10-13 17:38 / 22:03 两个真机会话中加载）。**枪械开火、PvP 与遮挡行为已真机验证**（见 §四开头）；
> 撤退 / 冲锋 / 反卡死三项仍待操作员按 §四 逐条确认。
> 关联提交：`16687a0`（战斗 v3）、`3ba591a`（枪械真机开火 + fireError 诊断）、`1998777`（战斗租约 + `not_a_gun` 自恢复）。

## 一、四条线

1. **真撤退**（阈值 `fleeHealthThreshold`，默认 8）：危险分支按最近威胁（≤7 格）发起
   `retreat`——S 键后撤、每 tick 面向敌人；**优先用枪射击**（近距序选有子弹的枪并装备），
   无枪则近战回身打。每 3s 续期一次，危险解除由主循环 `stop()` 取消并释放按键。
2. **远程主动进攻**：迎战条件 = 目标 ≤5 格 **或** `hp < engageHealthThreshold(默认 16)`
   **或** 本 tick 掉血且 24 格内有目标（被远程打即冲锋）。距离 >4.5 先试 `shoot`，
   失败码 `{tacz_unavailable,no_gun,not_a_gun,no_ammo,blocked}` 立即回退近战 `attack`。
3. **反卡死**：近战目标 ≤5 格且双方 **30s 无接触**（期间 bot 未掉任何血，跨技能调用累计）
   → 终止并 `ignore(id)` 180s；目标贴到 ≤3 格自动解除忽略。掉血重置 30s 计时。
4. **TACZ 枪械**：瞄准→开火→换弹全走 `IGunOperator` 反射（无编译期依赖）：
   - 有效射程：狙击 32 格，其余 16 格；超出先 `moveTo` 逼近到“射程−2”。
   - **开镜完成后才开火**（`getSynAimingProgress ≥ 0.95`；2.5s 未就绪视为无开镜枪放行），
     一轮开火结束 `aim(false)` 收镜。
   - 后坐力补偿 = 开火期间每 tick 持续面向目标。
   - **一轮 ≤6 发**；每轮后决策：超距→靠近；≤3 格→后撤（fire 模式）；手持狙击且 <8 格→换
     突击步枪/冲锋枪/机枪/手枪（近距序）；其余→重新瞄准并等待 500ms 再开火。
   - 弹匣（NBT `GunCurrentAmmoCount`/`DummyAmmo`）打空自动 `reload()`；4s 仍空→`no_ammo`，
     切背包里还有子弹的其它枪（近距序），全无则诚实失败。
   - **LOS 完全遮挡不开火**：眼位→头/躯干/脚三点 raycast 全被方块挡住则停火；连续 1.5s 全遮
     →`blocked`；Skill 侧做 1 次侧翼尝试。
   - 近距武器优先级（全局唯一序）：**突击步枪 > 冲锋枪 > 机枪 > 手枪**；距离 >16 时狙击第一候选。
   - **PvP**：目标支持玩家但**仅显式指定**（`player`/`id`）；反射自动永远只打怪物；拒绝自己
     用户名与不在线玩家。**反射永远按默认优先级选枪，不接受玩家指定**；`weapon` 参数仅作用于
     手动 `!shoot`/LLM 调用（指定枪打空后由换枪规则接管；狙击贴身换枪后解除指定）。

## 二、接口

- Mod verb：`shoot <entityId> [ms≤8000] [maxShots≤6]`、`retreat <entityId> [ms≤3000] [fire]`；
  `/state` 新增 `guns:[{item,gunId,type,magazine,dummy,bullets}]`，`players` 项含 `id`；
  连续动作替换/停止/异常时统一释放按键与开镜状态（`releaseAllKeys`）。
- Node：`ClientModBody.shoot/retreatFrom/stop`；`snapshot().players` 为对象数组；
  `src/world/combatState.js`（忽略名单 + 无接触计时）；`skills/combat.js` 的 `shoot` 技能
  （参数 `type/player/id/weapon/maxDistance/timeoutMs`）；`!shoot [type|player <name>] [weapon]`。
- 配置：`fleeHealthThreshold 8`、新增 `engageHealthThreshold 16`；其余为代码常量（6 发/轮、
  轮间 500ms、射程 16/32、逼近余量 2、kite 阈值 3、忽略 180s、反卡死 30s、遮挡 1.5s、侧翼 1 次）。
- 失败码表（`src/core/failure.js`）新增：`stalled/blocked/no_ammo/no_gun/not_a_gun/
  tacz_unavailable/ignored/out_of_range/shoot_failed`（否则 `fold()` 会把它们重分类，反射回退集失效）。

## 三、离线验证（已通过）

- Mod：`gradlew build --offline` 编译通过（产物 75000 字节；已 `client:install` 并重启客户端）。
- `skills:test 57/57`（战斗 v3 落地时为 56/56；`1998777` 增加战斗租约防反射双发与 `not_a_gun` 自恢复两条用例）：选枪优先级/射程、`weapon` 指定与未知拒绝、6 发封顶+500ms 轮间、超距逼近、
  ≤3 格 kite、狙击<8 换枪、弹尽换枪/全无 `no_ammo`、遮挡侧翼一次、PvP 显式/自拒绝/离线拒绝、
  反卡死（30s 无掉血→abort+ignore、掉血重置、忽略跳过、≤3 解除）。
- `control:test 37/37`：hp≤8+近敌→选枪+`retreatFrom(fire:true)`；危险解除→`stop()`；
  hp<16 与“本 tick 掉血”→`shoot{id}`；忽略名单跳过/≤3 覆盖；战斗任务存在→反射不双发；
  枪械失败→近战回退。
- 其余：`client:test 73/73`、`selftest 176/176`、`tasks:test 52/52`、`mining:collection:test 24/24`、
  `mining:entry:test 23/23`、`mining:recovery:test 18/18`（计数实测于 2026-10-14）。

## 四、真机验收清单（10-13 夜部分覆盖，其余待操作员确认）

**已由 2026-10-13 夜真机覆盖**（mc.example.com，角色 `AgentDeepSeek`，jar 75000；证据
`runtime/logs/agent-2026-10-13_17-39-27.log` 与 `runtime/logs/forge-client-2026-10-13_09-38-07.log`）：

- 第 1 项（部分）：`!shoot` 对掠夺者 4 轮共 16 发击杀——**开镜后开火、每轮 ≤6 发**符合设计；三点 LOS 全遮挡时
  诚实 `blocked`（零发射）并各执行 1 次侧翼，两轮侧翼尝试后仍被掩体挡住，按设计诚实失败而非空放。
  **未逐项记录**：低于射程时的逼近、近身 kite。
- 第 5 项：PvP 显式指定命中——对玩家 `Logos_Fyan` 2 轮 4 发击倒；且自然语言“攻击 Logos_Fyan”被拒绝
  （“我只打僵尸骷髅那些怪物”），确认不会自动打玩家。
- 附带观察：同期出现 2 次死亡与 `danger detected, retreating`，死亡后按设计停牌等待显式恢复；
  这不构成第 2 项（低血撤退 + 用枪反击 + 脱险释放按键）的通过证据。

**仍未确认**：第 2 项（低血 ≤8 被追：S 键后撤 + 面敌 + 用枪反击、脱险后不滑步）、
第 3 项（墙后 3–4 格僵尸 30s 无接触后放弃并在 180s 内不再选它）、第 4 项（12–15 格外被射击当 tick 冲锋）、
第 1 项的逼近/kite 细节。第 6 项为已知边界，无需验收。

1. 安装 Mod + 重启客户端后：`!shoot` 打一只远程怪（弩手/骷髅）——观察：开镜后开火、≤6 发一轮、
   低于射程靠近、近身 kite、遮挡不射击并侧翼。
2. 低血（≤8）被怪追：观察 S 键后撤 + 面敌 + 用枪反击；脱险后按键释放（不滑步）。
3. 反卡死：构造一个够不着的僵尸（墙后 3-4 格），连续攻击 ~30s 应放弃并在 180s 内不再选它。
4. 远程挑衅：让掠夺者在 12-15 格外射击，掉血当 tick 应主动冲锋（或先枪后刀）。
5. PvP（可选）：`!shoot player <name>` 命中指定玩家；确认不会自动打玩家。
6. 已知边界：撤退无悬崖保护；流弹误伤不处理；弹尽换枪按全局近距序与“同型不重复排除”的既有规则。
