# M6 语言脑测试证据（2026-10-24）

环境：Forge 1.20.1 真实客户端，`mc.example.com:25565`，Node agent `clientmod`，
默认 `language.brain=unified`，40 条沉默语料 profile 已加载。
受控普通聊天使用 `P1_TEST_HOOKS=on` 的 `POST /chat/inject`（合成发送者）。

## M6-A24 聊天并发

同一批并发发送 4 条普通聊天（发送者 `A24-*`）：

```
wow / 有吃的吗 / 这个 / 你们需要什么
```

结果：

- 4 条 user 全部写入 ChatMemory；
- 仅 1 条 assistant 回复：「我吗？我想要点吃的，米饭最好啦～」；
- 无重复回复、无自我对话；
- 其余为 silence/排队/过时；
- ChatMemory 更新正常。

判定：**PASS（受控并发；发送者为测试钩子合成，不是第二名真实玩家）**。

## M6-C03 ChatMemory 长期记忆

- 注入 `C03-TOKEN-20261024 这是聊天记忆测试`，ChatMemory 记录
  `speaker=C03Tester`；
- `POST /test/chat-compact`：entries 从 **180 → 41**，生成早期摘要，
  `C03-TOKEN` 保留在最近条目；
- 重启 Node agent 后通过面板让语言脑
  `grep_chat_memory` 搜索 token，回复「只翻到自己那条测试记录呢，
  C03Tester 说这是聊天记忆测试」，`language.tools.grep_chat_memory=1`；
- 所有非 `!` 玩家消息沿用全局记录器；panel/游戏内路径一致。
- 动作脑回复 attach 到原请求由 M2-B01 集成断言覆盖；本轮没有 action-brain
  在线回复可再跑一次。

判定：**PASS（compact + 跨重启 grep；action attach 由 B01/集成覆盖）**。

## M6-F02 单一发言者

- 普通聊天/`/chat/inject` 后 agent log **没有新增** `perception wake: chat`；
- 4 条并发普通聊天只有 1 条 assistant，未出现 A11 chat 直发叠加；
- ChatMemory 4 个 user / 1 个 assistant，无重复 user。
- 代码路径：`onOther` 在 unified 下直接进 LanguageBrain，不调用
  `perceptionWake.noteChat`。

判定：**PASS（受控；真实多人 A23 仍未完成）**。

## M6-A23 多人参与/沉默

已有证据（前一轮真实客户端）：

- 真实玩家 `Eggxxh`/`Stark_the_wolf`/`Logos_Fyan` 6 条未点名聊天全部沉默，
  `handled=7/silent=7/said=0`（6 真实 + 1 注入）；
- 受控 40 条语料 profile 的注入样本抽样 2/2、held-out 4/4。

但表格要求的 **40 组 ×3、参与 ≥80%、误插话 ≤10%** 未执行。

判定：**PARTIAL**，不能标记 A23 pass。

## M6-A25 自主提案

本文件 11:16 记录时 DSH 插件 `boundAgentId=null`/无 action-brain 会话，无法让 harness
调用 `mc_propose` 生成自主提案；现有 proposal 记录多为 plan_question，不是 A25 要求的
自主提案四路径，当时未执行。

**同日晚间已补跑四路径**（[`M6-A25-CLIENT-TESTS.md`](M6-A25-CLIENT-TESTS.md)）：
accept p14 为真实 action-brain `mc_propose`（`Minecraft动作脑1`）；reject/不答/另派
p15–p17 由 `/test/proposal-plant` 植入。

判定：**PARTIAL**——提案生命周期、语言脑提问、冷却/过期/取代与执行阻断为真，
真实动作脑逐条自主提案仅 1/4；不能标记 A25 pass。

## 钩子状态

`/chat/inject`、`/test/chat-compact`、`/test/respawn`、`/test/code-skill-chat`
只在 `P1_TEST_HOOKS=on` 时存在。测试结束后已重启生产 agent 关闭钩子。
