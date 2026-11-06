# mc_step / mc_plan 失败回执与升级阶梯

> 状态（2026-10-31）：**离线测试全绿；真机失败阶梯与键鼠脚本子集已通过**。
> 动作脑影响面：DSH `mc_step` / `mc_plan`；面板与游戏内 `!` 命令仍是操作员通道，不受闸门限制。
> 本文件是设计与验收簿记；实现位置和测试命令在文末。

## 1. 问题

事故模式不是"没有失败处理"，而是**失败信号太弱、升级规则只在提示词里、求助没有结构化出口**：

1. `place` 的 mod 回执只说明 `useItemOn` 被调用，不说明世界真的变化；
2. `mc_step` 回执只有裸 `ok/reason`，动作脑不知道是"补前置""该搜索"还是"该停"；
3. "同一动作两次失败"只是 goal 文本，Node 没有计数，换坐标即可绕过；
4. `mc_say` 是单向播报，`mc_finish` 不能等待回答；没有"停车问玩家"的工具；
5. 模组机制（双翼机放置）被当成 vanilla 试错，而不是先查资料。

## 2. 复用的既有设施（不新建平行系统）

| 层 | 本次用法 |
| --- | --- |
| `src/core/failure.js` | 扩展 `KNOWLEDGE` / `UNVERIFIED` 两型、失败 class、`envelope()`、`describePolicy()`；`fold()` 保持旧调用方兼容 |
| `src/tasks/task.js` `TaskResult` 六态 | `unknown` 继续表示"效果未确认"；失败结算附信封 |
| `src/planner/verifier.js` | 计划步骤仍负责 pre/postcondition；本次补的是**单动作**世界证据 |
| `PlanRunner` / `PlanService` / `wait_for_player` | `mc_ask_player` 复用既有停车与 `!answer` 恢复链路，不新建问题状态机 |
| `RecoveryLadder` | 技能内部替代路径不变；本次处理的是技能失败到达动作脑之后的升级 |

## 3. 失败信封

失败动作/任务经 `envelope()` 返回：

```json
{
  "ok": false,
  "failure": "unverified",
  "class": "unverified",
  "hint": "...",
  "retryable": false,
  "retryBudget": 2,
  "requires": ["lookup_mod_content"],
  "next": "lookup-then-input-then-ask",
  "signature": "place:immersive_aircraft:biplane",
  "verb": "place",
  "attempt": { "count": 2, "budget": 2 },
  "lookupQuery": "immersive_aircraft biplane 怎么放置 使用",
  "inputHint": "if the command channel keeps failing, do it with the input layer (look/key/hold/tap)",
  "inputExamples": ["look <yaw> <pitch>   (aim at the block/entity first)", "key forward down / key forward up", "hold attack 600", "tap inventory"],
  "askQuestion": "..."
}
```

分类与策略是单一事实来源，`mc_capabilities.failurePolicy` 由同一张表生成：

| class | 典型失败 | 下一步 | 重试 |
| --- | --- | --- | --- |
| `transient` | timeout、卡住、战斗僵持 | 重新观察，退避一次 | 1 |
| `precondition` | 缺物品/工具/路线/空间 | 修前置，不加重试；再失败 → **输入层** | 修复后 1 |
| `knowledge` | 模组机制不明 | `lookup_mod_content` → 一次 informed 重试 → **输入层** → 问玩家 | 有资料后 1 |
| `unverified` | `ok` 但世界无变化 | 同上，且不重复同坐标 | 有资料/回答后 1 |
| `capability` | 没有命令/键位/API | 输入层，否则提议代码生成 | 否 |
| `permission` | 拒绝、领地、操作员屏幕 | 停或问 | 否 |
| `unknown` | 未分类 | 观察或问，不盲试 | 否 |

## 4. 硬闸门

`src/core/failureEscalation.js` 持有内存级签名台账，作用域是一个 goal：

- 签名 = `verb + 规范化目标`；**knowledge/unverified 类按物品**建签名，
  换坐标不会重置计数（正是事故里的绕过方式）；
- 同一签名盲试上限默认 2；达到后：
  - `knowledge`/`unverified` → `lookup-required`；
  - 其他 → `escalation-required`；
- `permission` 一次失败后直接拒绝自动重试；
- 有 lookup/answer 记录后允许**一次有依据的重试**；再失败 → `ask-required`；
- `mc_ask_player` 停车期间，harness 通道的身体动作被 `waiting-for-player-answer` 拒绝；
  白名单：`stop`、`inputs`、`state`、`task`、`keybinds`、`capabilities`；
- lookup 记录 TTL 10 分钟；成功、TTL 过期、新 goal 创建都会清零（自动降级回归）；
- 台账不持久化：重启后的旧失败不应阻止新动作。
- **完全自主模式内没有「问玩家」这一步**：`POST /ask_player` 直接返回
  `409 autonomous-no-approval`（hint：把当前 goal 标 blocked 换下一个任务），
  权限规则里的 `ask` 降级为 `deny`（`permissionGate` 不弹询征）；因此
  `ask-required` 在该模式下等价于**本轮 blocked**，由课程换题，而不是停车等人。
  见 [`FULLY-AUTONOMOUS.md`](FULLY-AUTONOMOUS.md) §4。

闸门只对 `via:'mc_step'` 的 `/command` 调用和 `mc_plan` 每步生效。面板/游戏内 `!` 是操作员，
不受限。

### 4b. 输入层阶梯（2026-11-01 真机补）

操作员报告「失败阶梯无效，agent 未切换键鼠操作」：旧阶梯在 knowledge/unverified 之后直接
`ask-required`，而自主模式里 ask 等于放弃；**命令通道反复失败时从来没有要求改用键鼠**。现在：

- blind 预算用尽且无 lookup 可用（或 lookup 后仍失败）→ `input-required`：
  `requires:['input-layer']`、`next:'input-layer-then-retry-once'`，并带具体例子
  （`look <yaw> <pitch>`、`key forward down/up`、`hold attack 600`、`tap inventory`）；
- 动作脑改用输入层且**成功一次**后，该签名重新允许**一次**命令重试（`inputRetry:true`）；
- 这一次也失败 → `ask-required`（自主模式里即 blocked 换题），不再堆命令。
- 只对确实存在键鼠替代的动作启用（命令动词 + Node 任务名，清单在 `src/core/keyActions.js` 的
  `INPUT_ALTERNATIVE_ACTIONS`：place/use/attack/dig/mine/tunnel/pillar/moveto/goto、deposit/
  withdraw/craft/smelt/collect/farm/chop/mine_ore/go-to…）；纯只读/控制动作（state/status/plan/
  propose/answer/stop…）没有输入层替代，仍走原阶梯。
- **命令通道和 Node 任务通道都走同一档**：Node 任务（deposit/mine/goto/...）不经过 mc_step 闸门，
  它们的唯一回执是 `recordTaskSettle` 的信封；以前那条路完全不看输入层（真机 `deposit` 失败回执
  只说 `lookup_mod_content`）。现在 `_taskEscalation` 与 `gate()` 用同一规则生成 `requires/next`，
  并且第一次失败的信封就带 `inputHint`/`inputExamples`（`envelope()`）。
- **同步回执也分档**（2026-11-01 重测补）：`foldReceipt()` 复用同一 stage 逻辑。informed 重试
  失败的回执直接给 `requires:['input-layer']`；post-input 重试失败的回执直接给
  `requires:['mc_ask_player']`、`next:'input-failed-then-ask'`——否则它会按类别表再回
  `lookup_mod_content`，把动作脑送回一次已经做过的搜索。
- 单元验收在 `p1:failure-escalation:test`（**27/27**）：知识阶梯 `lookup-required → informed →
  input-required → 输入成功 → 一次重试 → ask-required`，外加**任务结算路径**的同一阶梯
  （deposit：首败带 inputHint → 二败 lookup → lookup 后 informed 重试失败 → `input-layer` →
  输入成功 → 再失败 `mc_ask_player`）。

### 4c. 为什么以前没有这一档（2026-11-01 复盘）

不是模型不想换，是**闸门从来没要求它换**，而且两个子系统各自说话：

1. **规则写在了提示层**。2026-10-29 的提交 `9009ce2` 把"同一技能同因失败两次 → 换键鼠"写成
   `taskGoal` 的 STUCK 协议、`channelPolicy.describe().escalation` 和插件描述——全是文字。
2. **代码闸门晚一天才出现，且只覆盖 A32 的 barrier 场景**（`9ff6ece`，2026-10-30）：knowledge/
   unverified → lookup → 一次 informed → ask。`requires` 是模型真正照做的机器字段，它从没出现过
   `input-layer`。
3. **分类表里唯一的 "input-layer" 在 `capability`**，而 `capability` 只由 `unsupported`/
   `tacz_unavailable` 产生——即"身体压根没有这个动词"。`place` 跑完但没效果是 `unverified`，永远
   到不了那一支；`CLASS_POLICY[unverified].next` 写着 `lookup-then-ask-then-input`，
   `requires` 却只有 lookup，**字符串承诺了代码没实现的档**。
4. **两条通道各管一段**：`channelPolicy.resolveChannel()` 只回答"这个动作归哪个渠道"（一次决策），
   `failureEscalation` 负责"失败后下一步"，两者不 import、不共享状态；`channelPolicy` 的
   `INPUT_COMMANDS` 只有五个动词，而提示里的键鼠清单有 `look/menu/click/close`——清单本身也对不上。
5. **任务通道更彻底**：`recordTaskSettle` 直接生成 `envelope()`，根本不经过 `gate()`，所以连
   "第三次盲试被拒"都只对 mc_step 生效；真机里失败的恰好是 `deposit`（Node 任务），回执里从头到尾
   没有键鼠。
6. **没有断言**：`p1:failure-escalation` 只测 lookup/ask 链，`p1:channel` 只测"表里写着规则"，
   没有任何测试要求"第三条回执必须出现 input-layer"。文字与代码因此可以静默漂移。

本次把四处合成一条链：`keyActions.INPUT_VERBS / INPUT_ALTERNATIVE_ACTIONS`（唯一动词表）→
`failure.CLASS_POLICY`（next 字符串与实际一致）→ `failureEscalation.gate()` 与
`_taskEscalation()`（同一阶梯，两条通道）→ `envelope()`（首败就声明 fallback）→ 测试（gate 与
task 两条路径都断言 input-layer）。

## 5. `mc_ask_player`

插件工具 → `POST /ask_player` → `PlanService` 提交单步 `wait_for_player`：

```json
{
  "ok": true,
  "parked": true,
  "planId": "ask-...",
  "question": "我在 (15,65,71) 放 biplane：物品没少、附近没有新实体、方块没变。你看到它了吗？需要 Shift+右键或特定平台吗？",
  "answerHint": "玩家在游戏里输入 !answer <回答>"
}
```

- 问题必须带证据和一个具体问题；
- 回答经 `answerPlanQuestion` 记忆、转发给动作脑、再恢复计划；
- 计划完成/失败/取消/过期时清停车旗；
- `mc_finish` 不是求助工具；机制不明时不得用它结束 goal。

## 6. mod 世界证据（place / useon / use）

薄手原则：

- **Java 只采集**：目标及相邻格方块、手持物品总数、半径 8 格实体快照；
  执行 `useItemOn`/`useItem` 后，在 +2 tick 和 +12 tick 再采集；
  返回 `consumesAction` 和原始 before/after；**不判断成功**。
- **Node 判定**（`src/body/placeEvidence.js`）：

```text
changed blocks (target + face + six neighbours)
  OR consumed item count decreased
  OR a NEW entity whose type matches the item/mod
  OR a menu opened
  => ok

item consumed but none of the above at the settle snapshot
  => consumed-without-visible-effect (unverified)

nothing changed
  => place-unverified (unverified)
```

- 实体必须与物品匹配（modid 前缀或物品 path 出现在 entity type 中），避免路过的猪造成假阳性；
- 物品消耗但无可见效果**不再算成功**：那可能是服务端回滚/取消使用；
- 旧版无 `evidence` 的 mod 回退到原 boolean，并在 receipt 标 `receiptOnly`——兼容但不假装验证过。

`ClientModBody.placeDetailed` / `useOnDetailed` 保留完整 detail；`blocks.js` 的
`place` / `use_on` 技能透传 `failure/code/evidence/lookupQuery`。

## 7. 回执接线

- 同步 `mc_step`（输入层/拒绝/同步技能）：`/command` 返回前统一 `foldReceipt()`；
- 后台任务：`TaskSlot.publish` 在唯一结算出口调用 `recordTaskSettle()`，
  `task:failed` 载荷带信封；`task:done` 成功并清签名；
- `/ui/state` 增加 `failureEscalation` 和 `lastSettled`，`mc_observe` 无需新通道；
- `mc_plan`：每步派发前过 `gateStep()`；`verifyStep`/派发失败写带信封的 step settlement；
  `mc_plan_status` 读取；
- `mc_step` 失败回执会带 `class/requires/attempt/lookupQuery`，动作脑不再需要从自由文本猜。

## 8. 提示词与能力面

以下四处已同步：

1. `src/core/taskGoal.js` 的 `!` 任务 goal；
2. 同文件的 `@` 对话 goal；
3. 插件 `actionGoalObjective` 与 `mc_step` 描述；
4. `src/core/channelPolicy.js` 的 `escalation.rule` / `failurePolicy`。

另加 **实时控制规则**：

> 需要连续 ms 级控制（驾驶/骑乘载具 `mounted:true`、行进中转向、动态瞄准）时，
> 不要用原子 `mc_step` 键鼠；每次调用隔一个会话回合，输入已过期，首败可能不可逆。
> 首次就用已晋升 code-skill；没有则立即提议代码生成（仍需人工批准）。脚本在 Node 内用
> `ctx.state()` + `ctx.key/ctx.hold/ctx.tap` + `ctx.wait(ms)` 跑闭环。

升级粒度是**按动作签名**，不是任务级模式：锄地失败不影响走去下一片田的 `goto`；
成功、TTL、新 goal 都会让同类动作回到命令通道优先。

## 9. 测试

| 套件 | 结果 |
| --- | --- |
| `p1:failure-escalation:test` | **27/27**（信封/签名/闸门/输入层档/lookup/ask/降级/回执/证据/计划/提示词） |
| `client:test` | **83/83**（假 mod 协议含 place/useon 证据三分支） |
| `p1:contract:test` | **241/241**（/command 闸门、/ask_player、lastSettled、plan gate） |
| `p1:m4:test` | **43/43**（生成提示词实时闭环） |
| `p1:m5:test` | **40/40** |
| `p1:channel:test` | **18/18**（failurePolicy + 升级文本） |
| `p1:taskgoal:test` | **14/14**（goal 文本 + 新 goal 清账本） |
| `p1:verify` | **20/20**（`--fast` 19/19） |

### 9.1 真机验证（2026-10-31，客户端 + Node agent）

环境：真实 Forge 客户端 `agent-client`，玩家 `AgentDeepSeek`，坐标 `15.33,65,71.47`；
Node 通过 `/command` 的 `via:"mc_step"` 走真实闸门。

**失败阶梯上升（`place` 无效回执）**：

```text
place minecraft:barrier 1000 100 1000 up  -> ok:false class=unverified attempt=1/2
place minecraft:barrier 1010 100 1000 up  -> ok:false class=unverified attempt=2/2
place minecraft:barrier 1020 100 1000 up  -> ok:false error=lookup-required gated=true
```

- 三条命令的真实 mod 证据都是 `blocksChanged:0, itemCount 0→0, entities 0→0`；
- 第三条没有派发到客户端，证明换坐标不能绕过签名闸门；
- `lookup_mod_content("minecraft barrier block how to place 使用方法")` 返回 3 条真实结果，
  Node 记录为 informed；
- `place minecraft:barrier 1030 ...` 允许一次有依据重试，仍为 `unverified attempt=3`；
- 下一条 `place ... 1040 ...` 返回 `ask-required`，带具体 `askQuestion`；
- `POST /ask_player` 返回 `{parked:true, planId:ask-...}`；等待期间
  `place ... 1050 ...` 返回 `waiting-for-player-answer`；
- `!answer "test-answer: no visible barrier; thanks"` 成功恢复，`/ui/state.failureEscalation`
  清空（`signatures:0, recentFailures:0`）。

**键鼠脚本编写与执行**：

- 真实模型生成 v3 脚本 `agent.inventory_cycle_live3@1.0.0`，manifest 权限
  `read_state/wait/input_tap/input_close`，描述“打开背包→等待→确认 screen→关闭”；
- 代码实际使用 `ctx.tap("inventory")`、`ctx.wait(300)`、`ctx.state()`、`ctx.close()`，
  没有点击槽位、没有移动；
- 第一次生成的同类脚本暴露了真实缺陷：`close` 只关容器菜单，`InventoryScreen` 仍停留；
  同时脚本的 `state()` 读到旧缓存，误判 close 失败。修复：
  - `ClientActions.closeMenu` 对 `AbstractContainerScreen` 调用 `onClose()`，不关闭 pause/chat；
  - v3 `ctx.state()` 默认刷新 live `/state`，`tap/close` 后也刷新快照；
- 修复后 trial **通过**，脚本晋升并 `/code-skills/.../run` 真机执行成功：

```text
screenOpened: InventoryScreen
screenClosed: null
slotsClicked: 0
movementKeysUsed: 0
calls: read_state, tap(inventory), read_state, close, read_state
```

证据：

- trial：`runtime/code-skill-runs/agent.inventory_cycle_live3@1.0.0-run-1793358980418-0x0nwv.json`
- promoted run：`runtime/code-skill-runs/agent.inventory_cycle_live3@1.0.0-run-1793359030214-ksyxw4-run.json`
- 代码：`runtime/code-skills/promoted/agent/inventory_cycle_live3/1.0.0/index.js`

**真机未覆盖**：

- 真实 mod 物品（如 biplane）成功放置后的实体匹配（本次故意用无效果的 barrier 验证失败链）；
- `mc_ask_player` 插件工具本身（本次经 Node `/ask_player`，插件代理未重启加载）；
- 成功结算后同签名清零的独立成功动作（本次由回答/新 goal 路径清空）；
- 载具 ms 级脚本优先（真实载具 trial 未执行）。

按仓库规则，以上未覆盖项不填 PASS；A32 在 P1-CLIENT-TESTS 中登记为真机子集通过。

## 10. 配置与部署

默认值在 `failureEscalation.DEFAULTS`，可通过 `config/agent.json` 的
`failureEscalation` 覆盖（`maxBlindAttempts`、`lookupTtlMs`、`informedAttempts`、
`goalFailureBudget`、`goalFailureWindowMs`）。

部署：

```bash
npm run client:build       # Java 证据采集
npm run client:install     # 覆盖 PCL 版本的 agent-client jar
node scripts/install-dsh-plugin.js --apply
# 重启 DSH，使 mc_ask_player / mc_step 新描述进入工具表
```

## 11. 已知限制

- 台账内存级、按 goal 生命周期；进程重启即清空；
- lookup 的 "informed" 判定按物品 path/modid 包含关系，可能把同 mod 的其他资料算作有效；
- 实体匹配允许同 modid 的新实体，极端情况下可能有假阳性；
- 证据快照有界（半径 8、实体数上限），远处实体或延迟超过 +12 tick 的效果可能误判为 unverified；
- 升级粒度靠签名隔离 + 提示词保证；Node 不阻止合法的输入层移动；
- `mc_ask_player` 的等待完全依赖 `wait_for_player` 计划生命周期（提案过期/计划取消会清旗）。
