/goal 按照以下建议重构语言脑，实现接入统一化。建议的目标形态
代码块


玩家输入（! 除外）
```
   → LanguageBrain（唯一入口）
       ├─ profile=roleplay   （闲聊/普通聊天/主动感知事件）→ say | silence
       ├─ profile=expert     （Minecraft 知识/检索/搜索）  → say | silence
       └─ profile=approval   （动作请求）→ approve | reject（只放行原文）
   → 动作脑（DSH harness，原文 + 身份链）
```

动作脑输出：
失败/求助/成功/状态信息->送给语言脑修饰->发送给玩家。动作脑不直接给玩家发送消息。

记忆统一：
长期记忆入库，短期从内存获取。agent启动时先把最近15条（如果有）送到内存。允许agent(语言脑) grep长期记忆内容。

任务执行记忆不送语言脑上下文，只靠agent(语言脑) grep。

根据状态主动发言：生命值低和饥饿时不走语言脑直接发言（相当于求救，不需要思考）。其它状态送language brain.

profile 只是同一 LlmClient 的两套 prompt/工具集，不需要两个 provider；
工具统一为 {say, silence, approve, lookup/web_search, grep_chat_memory, grep_task_memory}，没有 body/技能/任务工具；
记忆统一：ChatMemory 负责聊天 save/grep/context/compact；MemoryStore/MethodLibrary/AnswerMemory 作为任务日志记忆注入（按图的 partial 规则，不做 compact）；
! 仍直接进命令表（P1 的硬规则）；
A11 的主动事件不再直接 speakUp，而是作为 roleplay profile 的一个输入，允许 silence；这样也顺带解决"大肥鱼注意到"复读。
分阶段落地（建议）
| 阶段	| 做什么 | 风险控制 |
|--|---------|----------|
|1. 门面	| 新增 src/llm/languageBrain.js，只做路由和统一 schema；内部暂时调用现有 ChatParticipation/LanguageAgent/judge | 默认 language.brain=legacy，行为不变 |
|2. 入口	| 玩家回答先进门面；动作请求 approve 后把原文交给 DSH；! 不变 | 保留 DialogueRouter 作为 fallback；A02/A03 回归 |
|3. 记忆	| 门面读 ChatMemory.context；写路径用现有全局记录器；任务日志注入 | 先只读，后替换 15 行窗口 |
|4. 退旧	| LlmCore 只保留 P0 回退/命令，不再承担语言脑；停用 A11 chat→speakUp；LanguageAgent 作为 roleplay 实现或删除	| A11/A14/A17/A25 真机 + 全套件 |



主要风险
行为与验收变化：@ 现在直接进 DSH，加语言脑会多一次模型调用（延迟/token），A02/A03/A14/A25 都要重测。
审批语义：图要求"语言脑不能改写原文"，现在 approve 只在休眠路径；接到主路要确认 DSH 收到的是原文+身份链，而不是语言脑的复述。
A11 重定向：主动发言改为门面的 roleplay 输入后，需要重新定义"无事件不调模型/一次唤醒一次回复"的口径，避免又出现每条聊天都插话。
记忆双写：ChatMemory 与 15 行窗口不能同时作为"当前上下文"，要明确哪个是短期、哪个是长期。
LlmCore 不能直接删：任务播报、judge、mining recovery、P0 命令仍依赖它；应"降级为 legacy/回退"，而不是一次性移除。

## 实现状态（2026-10-23）

已落地（默认 `agent.language.brain=legacy`，行为不变；`unified` 进入单一 owner）：

| 能力 | 位置 / 说明 |
| --- | --- |
| 唯一语言脑门面 | `src/llm/languageBrain.js`：`roleplay` / `expert` / `approval` 三 profile，统一输出 `say / silence / lookup_item / web_search / grep_chat_memory / grep_task_memory`；没有任何 body/技能/任务工具 |
| 入口 | `unified` 下 `@`、addressed、面板对话、普通聊天、A11 感知、respawn、taskDone、计划提问、code-skill 发言、`mc_say` 动作脑输出全部进 `ctx.languageBrain`；`!` 仍直接进命令表 |
| 审批 | `approval` 用同一 `approvalGate`，放行时把**原文**放进 `[MINECRAFT PLAYER REQUEST]` 信封（source/speaker/位置）交给动作脑，不改写 |
| 记忆 | 短期窗口 15 行随 `p1-state.json` 的 `languageBrain` 字段保存/恢复；长期 ChatMemory 由既有全局记录器写入，语言脑只用 `grep_chat_memory` 召回；任务记忆只在 `grep_task_memory` 时读取，不注入上下文 |
| 主动发言 | hungry / lowHealth 仍由 `SpeechScheduler` 直接 `speakUp`；A11、respawn、taskDone 进语言脑 roleplay，允许 `silence` |
| 动作脑输出 | DSH `mc_say` 带 `source=action-brain` → Node `/say` → `LanguageBrain.renderActionOutput` 修饰后再 `reply()`；计划提问与 code-skill 同样先经 roleplay（提问失败才原文兜底） |
| 开关 | `config/agent.json` → `agent.language.brain`（`legacy`/`unified`），或 `MC_LANGUAGE_BRAIN=unified`；`maxTokens/historyLimit/maxToolRounds/timeoutMs` 同段 |
| 测试 | `npm run p1:language:test` **20/20**；`npm run p1:verify -- --fast` **9/9** 套件 |

仍待完成（下一阶段）：

1. `legacy` 仍是默认；需要一次客户端窗口验证 unified 的 `@` 经审批后到达 DSH、动作脑 `mc_say` 经语言脑修饰、A11 允许沉默、低血/饥饿直发。
2. `ChatParticipation` / `LanguageAgent` / `LlmCore` 的旧代码尚未删除；它们保留为回退（阶段 4 才退役）。
3. 插件 `mc_say` 已改为带 `source=action-brain`，但 desktop profile 需 `npm run dsh:install -- --apply` + 重启 DSH 才生效。
4. 动作脑输出在语言脑失败时的兜底策略（静默 vs 原文直发）尚未最终决定；当前 `/say` 返回 `sent:false`，不二次直发。
5. 真机 A03/A11/A14/A17/A25/A23–A24 需按新入口重测；离线契约不替代真机证据。