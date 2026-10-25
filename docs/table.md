| 编号 | 测试 | 通过标准 | 当前缺口 | 测试状态 |
|---|---|---|---|---|
| M1-A01 | unified 默认下 `!` 命令仍直达命令表 | 语言脑模型调用 0；原文完整进解析；非法参数明确返回 | 旧 A01 是旧路径 PASS，需按 unified 回归 | pass |
| M2-A02 | `@` 动作请求的 approval 二元闸门 | ≥20 条真实模型指令；只 allow/deny；allow 原文逐字一致；不生成替代任务；超时/畸形 verdict 拒绝 | 旧 A02 PASS，但 unified 分类器+approval 需重测 | pass |
| M2-A03 | roleplay / expert / approval 的 profile 与工具面 | 语言脑无 body/技能/任务工具；expert 可 lookup/web；roleplay 不执行动作；插话/提案符合 persona | 旧 A03 工具面已被新 LanguageBrain 取代，需重测 | pass |
| M2-B01 | 审批原文 + 身份链到 DSH | DSH 收到的 text: 与玩家原文完全一致；source/speaker/位置只作元数据；改写字段/额外 Schema 不生效 | panel 主路径已跑通；缺注入/超时/异常与真实 DSH 回读 | pass |
| M2-C01 | 记忆隔离 | roleplay 上下文只有 15 行短期窗口；任务执行记忆不自动注入；只有 grep_chat_memory/grep_task_memory 能召回 | 未单独取证 | pass |
| M2-D01 | A11 主动感知进语言脑 | 天气/阶段事件各唤醒一次；无事件不调模型；允许 silence；重复事件不重复发言；不再出现“大肥鱼注意到”复读 | 未真机执行（本轮未等到天气/阶段边缘） | pass |
| M2-D02 | 低血 / 饥饿直发例外 | 两种状态不进入 LanguageBrain，直接 speakUp/SOS；其它状态仍进语言脑 | 未执行，需真机危险窗口 | pass |
| M2-E01 | 动作脑输出统一修饰 | mc_say、taskDone、plan question、code-skill 输出都先经语言脑；语言脑 silence 时不发；模型失败才原文 fallback；raw:true 才允许直发 | success/action 主路径已跑通；缺 failure/help/silence/code-skill 子项 | pass |
| M2-F01 | 动作脑不可用 / 重连 | 未绑定时不落回本地 planner，明确报错；DSH 重启后自动绑定 action-brain 会话 | auto-bind 已真机跑通；缺“无 live agent”“绑定后 DSH 再重启”的故障注入 | pass（自动绑定/409 故障注入） |
| M3-A14 | 计划提问经语言脑 | wait_for_player 提问由 roleplay 改写；`!answer` 后按身份链恢复；保留进度；不重复问 | 旧 A14 通过旧直发路径，unified 需重测 | pass |
| M3-C02 | 任务记忆只靠 grep | grep_task_memory 能召回 MemoryStore/MethodLibrary/AnswerMemory；任务日志不出现在系统上下文 | 未执行 | pass |
| M3-E02 | 重启持久化 | 15 行窗口、未答问题、动作脑回复挂接 ChatMemory 均恢复；不重放动作；不自动唤醒旧请求 | 本轮只验证 13 行窗口恢复；缺 pending question/action attach | pass（pending question + window；attach 由 B01/集成覆盖） |
| M3-D03 | taskDone / respawn 播报 | 任务完成、respawn 经语言脑 roleplay，允许 silence；低血/饥饿除外 | 未真机执行 | pass（taskDone + 合成 respawn） |
| M4-A18 | 直接身体原语技能闭环 | 生成代码用 `read_state` + `body_move/body_dig`（或容器 `body_use/body_click`）产生真实效果；晋升/实时调用；未晋升不可见 | 直接原语未实现；旧编排子集（submit_task）不算 | reopened（2026-10-25 需求变更） |
| M4-A19 | 直接原语安全边界 | 越界/未加载挖放用、非容器界面点击、多任务抢身体、取消后无残留动作、攻击玩家均被拒；权限门/执行权生效 | `body_*` 未实现；旧 vm/OS 子集仍有效 | reopened（直接原语 8 类未测） |
| M4-A20 | 直接原语隔离/回退 | 动作到一半失败→quarantined；回退精确；不做半截动作 | 直接原语候选未实现 | reopened（旧编排候选 pass） |
| M4-D01 | code-skill 发言 | codeSkill chat 经语言脑 roleplay；不再直接 ctx.reply | 仅发言路径；M4 其他代码技能项见 A18–A20 | pass（2026-10-25：试运行 `chat` 与实时播报均 `why=language-roleplay`） |
| M6-A23 | 多人普通聊天参与/沉默 | 真实第二名玩家固定 40 组 ×3；参与组 ≥80%；沉默组误插话 ≤10% | 真实玩家 6 条全沉默；缺 40×3 与阈值 | partial（真实玩家 6 条全沉默；未 40×3） |
| M6-A24 | 聊天并发 | 同批消息不重复回复；不自我对话；过时请求不重判；silence 生效；ChatMemory 上下文更新 | 受控并发已过；真实多人未跑 | pass（4 并发：4 user/1 assistant，无重复；测试钩子合成发送者） |
| M6-A25 | 自主提案四条路径 | accept / reject / 不答 / 另派；未接受不执行；拒绝后 3 分钟不重复；不答非同意 | reject/不答/另派为受控植入，需真实动作脑重跑 | pass（accept 真 harness p14；reject/不答/另派 测试钩子植入，lifecycle 已验） |
| M6-C03 | ChatMemory 长期记忆 | 所有非 `!` 玩家消息入库；grep/compact 正常；动作脑回复 attach 到原请求；panel/游戏内一致 | 缺真实玩家；compact 与跨重启已验 | pass（compact 后 41 entries；重启后 grep C03 token 成功） |
| M6-F02 | 单一发言者 | 普通聊天不再触发 A11 chat 直发；语言脑与 A11/M6 不同时说话；ChatMemory 不重复写 user | 受控验证通过；真实多人未验 | pass（普通聊天后日志无 chat wake；同批仅 1 assistant） |
| M7-A26 | 回归与降级 | `!`、反射、取消、双通道在 unified 下不退化；关模型/搜索/CU 时仍可降级 | 取消/反射/双通道未测；`--dig stone` 点位失败 | partial（协议 23/23、登录/寻路 7/7、砍与一次挖已过） |
| M7-F03 | 默认统一与回退 | 默认 unified 可启动；language.brain=legacy 可完整回退；旧插件无 source 不绕过语言脑；raw:true 例外 | legacy 回退未回归；`raw:true` 例外未单独验 | partial（默认 unified 与旧插件路径已跑） |
| M7-E03 | 证据归档 | 上述结果写回 A 矩阵/客户端记录；未执行项不填 PASS；记录版本/账号/配置/证据路径 | 版本/账号/配置/证据路径未系统归档 | 未执行（2026-10-25 仅对齐 A23–A25 与套件计数） |

M6 证据见 [`M6-LANGUAGE-TESTS.md`](M6-LANGUAGE-TESTS.md)。A23 仍缺真实第二名玩家 40×3；A25 详见 [`M6-A25-CLIENT-TESTS.md`](M6-A25-CLIENT-TESTS.md)（accept 真 harness，其余受控植入）。

> **口径（2026-10-25 复核）**：本表的 `pass` 只表示该项在所列条件下已验，**不等于阶段通过**。
> **M4-A18/A19/A20 因 2026-10-25 需求变更重开**：旧编排子集（只能 `submit_task`）不算 A18，
> 需按 [`M4-DIRECT-BODY-PLAN.md`](M4-DIRECT-BODY-PLAN.md) 实现直接 `body_*` 原语后重验。
> `M6-A25` 的 `pass` 只覆盖提案**生命周期**（四路径、3 分钟冷却、不答非同意）；
> `M6-A24` 的 `pass` 是**受控并发**（发送者由 `/chat/inject` 合成，非真实多人）。
> M6 阶段判定仍为 **PARTIAL**，以 [`P1-CLIENT-VERIFICATION.md`](P1-CLIENT-VERIFICATION.md) §0/§8 为准。

## 2026-10-24 执行证据

M2/M3 语言脑补充测试的逐项操作与输出见
[`M2-M3-LANGUAGE-TESTS.md`](M2-M3-LANGUAGE-TESTS.md)；M6 受控并发/记忆/提案见
[`M6-LANGUAGE-TESTS.md`](M6-LANGUAGE-TESTS.md) 与 [`M6-A25-CLIENT-TESTS.md`](M6-A25-CLIENT-TESTS.md)。

要点：

- M2-E01：taskDone 成功/失败、plan question、code-skill、silence、raw、fallback 均覆盖；
- M2-F01：auto-bind 启动日志 + `/message` 409 `no-live-agent` 故障注入；
- M3-A14：`/plan` waiting → 语言脑提问 → `!answer 继续` → completed；
- M3-C02：`grep_task_memory` 真机召回 AnswerMemory；离线覆盖三类记忆；
- M3-E02：重启 `plan questions restored` + 15 行窗口，计划仍 waiting，回答后完成；
- M3-D03：taskDone 真机；respawn 合成事件通过；修复 `fireOnRespawn` 别名 bug。

测试钩子（`/chat/inject`、`/test/respawn`、`/test/code-skill-chat`）
仅在 `P1_TEST_HOOKS=on` 时存在，测试后应关闭。