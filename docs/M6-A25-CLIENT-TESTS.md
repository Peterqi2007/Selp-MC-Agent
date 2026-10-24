# M6-A25 客户端测试证据（2026-10-24）

环境：真实 Forge 客户端 `mc.example.com:25565`，Node agent `clientmod`，
`language.brain=unified`，`planner.mode=off`；
动作脑会话标题 **「Minecraft动作脑1」**，session
`session-8d816775-c46e-4ed7-9b08-115622a84616`，plugin `boundAgentId` 指向该会话。

## 四条路径

| 路径 | 提案 | 结果 |
| --- | --- | --- |
| accept | **p14** `sleep-until-dawn`（真实 action-brain `mc_propose`） | 语言脑提问后由玩家 `!proposal accept`；coordinator 注入 execution goal `goal-bf540...`，动作脑执行 sleep；因床被阻挡失败，但**接受后才执行** |
| reject | **p15** `a25-reject-test`（测试钩子植入 autonomous） | `!proposal reject` → `rejected`；无 execution goal；cooldown `a25-reject-test` until `1792849549209`（约 3 分钟） |
| 不答 | **p16** `a25-noanswer-test`（测试钩子植入 autonomous） | 未回答，`sweep` 后 `expired`；无 execution goal/任务；不视为同意 |
| 另派 | **p17** `a25-other-test`（测试钩子植入 autonomous） | 玩家发 `!light 1` 明确任务 → proposal `superseded`（note `directive task`），改派任务进入命令表；任务本身因火把条件失败，但**提案未被接受、未自动执行** |

## 未接受不执行

- p15 reject 后 `proposalAutonomy.executionGoalId=null`，`brain.current=null`；
- p16 expire 后同样无 execution goal；
- p17 被 explicit directive 取代，提案本身没有注入执行目标；
- p14 在 accept 之前只是 `awaiting`，language brain 只提问，没有前进/动作。

## 拒绝后 3 分钟不重复

同一 target `a25-reject-test` 在冷却期内再次植入：

```
409 { ok:false, reason:"cooldown", target:"a25-reject-test", retryAt:1792849549209 }
```

## 语言脑入口

p15/p16/p17 都由 `ProposalDesk` 发出 `proposal:new`，统一语言脑用
`why=language-roleplay` 提问，例如：

```
主人，要我做 A25 拒绝路径测试吗？回 !proposal accept 或 !proposal reject
```

## 说明与局限

- p14 是真实 action-brain 自主提案（`mc_propose`），accept 由玩家完成；
- p15/p16/p17 为测试钩子 `/test/proposal-plant` 植入的 autonomous 提案，
  因为动作脑会话被操作员手动关闭后只成功生成了 p14；
  但 proposal lifecycle、语言脑提问、command 路径和 execution 阻断都是真实的；
- `!light 1` 作为“另派”任务实际进入命令表，行为失败（火把条件）不影响
  “提案被 explicit task 取代”的判定；
- 测试钩子只在 `P1_TEST_HOOKS=on` 时存在，测试后已关闭。
