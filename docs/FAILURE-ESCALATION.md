# mc_step / mc_plan 失败回执与升级阶梯

> 状态（2026-10-31）：**离线实现完成、测试全绿；真机验收未执行**。
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
  "next": "lookup-then-ask-then-input",
  "signature": "place:immersive_aircraft:biplane",
  "verb": "place",
  "attempt": { "count": 2, "budget": 2 },
  "lookupQuery": "immersive_aircraft biplane 怎么放置 使用",
  "askQuestion": "..."
}
```

分类与策略是单一事实来源，`mc_capabilities.failurePolicy` 由同一张表生成：

| class | 典型失败 | 下一步 | 重试 |
| --- | --- | --- | --- |
| `transient` | timeout、卡住、战斗僵持 | 重新观察，退避一次 | 1 |
| `precondition` | 缺物品/工具/路线/空间 | 修前置，不加重试 | 修复后 1 |
| `knowledge` | 模组机制不明 | `lookup_mod_content` → 无答案 `mc_ask_player` | 有资料后 1 |
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

闸门只对 `via:'mc_step'` 的 `/command` 调用和 `mc_plan` 每步生效。面板/游戏内 `!` 是操作员，
不受限。

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
| `p1:failure-escalation:test` | **25/25**（信封/签名/闸门/lookup/ask/降级/回执/证据/计划/提示词） |
| `client:test` | **79/79**（假 mod 协议含 place/useon 证据三分支） |
| `p1:contract:test` | **224/224**（/command 闸门、/ask_player、lastSettled、plan gate） |
| `p1:m4:test` | **38/38**（生成提示词实时闭环） |
| `p1:m5:test` | **35/35** |
| `p1:channel:test` | **18/18**（failurePolicy + 升级文本） |
| `p1:taskgoal:test` | **14/14**（goal 文本 + 新 goal 清账本） |
| `p1:verify` | **19/19 套件** |

未执行/未填：真机 place 证据、升级链路、ask 停车、粒度回归、载具脚本优先。
按仓库规则，代码存在不等于真机通过；A32 在 P1-CLIENT-TESTS 中登记为未执行。

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
