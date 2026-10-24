# M2/M3 语言脑补充测试证据（2026-10-24）

环境：真实 Forge 客户端 + `mc.example.com:25565`，Node agent `clientmod`，
默认 `language.brain=unified`，DSH action-brain auto-bound。
测试期间启用 `P1_TEST_HOOKS=on`（仅用于 `/chat/inject`、`/test/respawn`、
`/test/code-skill-chat`）。

## M2-E01 动作脑输出统一修饰

| 子项 | 操作 | 结果 |
| --- | --- | --- |
| taskDone 成功 | `!mine dirt 1` | 「主人，一块土挖好啦，还要接着挖吗？」`why=language-roleplay` |
| taskDone 失败 | `!mine diamond_ore 1` | 「主人，钻石矿一块都没挖到呢，呜呜」`why=language-roleplay`；hub 失败记录 |
| plan question（help） | `/plan` 提交 wait_for_player | 「主人，A14 测试要你用 !answer 回一下才继续哟」`why=language-roleplay` |
| silence | `/chat/inject` silent 样本 | `silent=true`，无回复，ChatMemory 不写 assistant |
| code-skill | `POST /test/code-skill-chat` | `via=language-brain`，回复「主人，代码技能测试我准备好啦~」 |
| raw 直发 | `POST /say {raw:true}` | `why=action-brain-say`，显式逃生口 |
| fallback / 静默 | `p1:language:test` 的 `/say` 集成测试 | 语言脑失败原文 fallback；silence 不发 |

## M2-F01 动作脑不可用 / 重连

- 启动日志：`action brain auto-bound: session-7a9...`；启动前 `/health.boundAgentId=null`。
- `HarnessBridge` 故障注入：`/message` 返回 409 `no-live-agent` → `{ok:false,reason:'no-live-agent'}`，
  不落回本地 planner；`autoBind` 通过 `/agents` + `/goal` 找到 action-brain 并 `/bind`。
- 早期 A02 真机在绑定前也实际得到 `no-live-agent`，未生成本地任务。

## M3-A14 计划提问经语言脑

1. `/plan` 提交 `s1 wait_for_player` + `s2 goto`，计划进入 `waiting`；
2. 语言脑以 roleplay 提问：「主人，A14 测试要你用 !answer 回一下才继续哟」
   （`source=plan-question`，`why=language-roleplay`）；
3. `!answer 继续` → AnswerMemory/MemoryStore 写入 → 转发
   `[PLAYER ANSWER]` 到动作脑 → 计划 `completed`，s1/s2 均 done，未重复问。

## M3-C02 任务记忆只靠 grep

- 现场 `/chat/inject` 后查询：`grep_task_memory` 召回 AnswerMemory
  「A14 ... 回答：继续」，`language.tools.grep_task_memory=1`。
- `p1:language:test` 的 grep_task_memory 用例同时断言 MemoryStore / MethodLibrary /
  AnswerMemory 三类结果只在工具结果中出现，不进入系统 prompt。

## M3-E02 重启持久化

重启前提交等待计划并收到语言脑提问；重启 Node agent 日志：

```
plan questions restored: [{"planId":"plan-1792810590839-2","stepId":"s1","asked":false,"reason":"pending"}]
language brain window restored: 15 lines
```

重启后：

- plan 仍 `waiting`，`waitingStepId=s1`，question 原文保留，位置未变；
- `brain.current=null`，没有重放动作/自动唤醒旧请求；
- 面板 `!answer 继续` 后 plan `completed`。

## M3-D03 taskDone / respawn

- taskDone：`!mine dirt 1` 成功播报、`!mine diamond_ore 1` 失败播报，均
  `why=language-roleplay`。
- respawn：`POST /test/respawn`（测试钩子，合成事件）→
  「呜呜主人我刚刚死掉了，还好又复活啦，东西还在吗」，`source=state/kind=proactive`；
  `SpeechScheduler.ready('respawn')` 的 `fireOnRespawn` 别名 bug 已修复。
  真实死亡未执行（避免丢失背包）。

## 局限

- `/chat/inject`、`/test/respawn`、`/test/code-skill-chat` 是测试钩子，已在测试后关闭；
- respawn 为合成事件，不是真实死亡；
- DSH 重启后的 auto-bind 以“启动时 boundAgentId=null → auto-bound”覆盖，
  没有再次重启 DSH 桌面进程；
- A23/A24 完整多人矩阵仍不在本轮范围。
