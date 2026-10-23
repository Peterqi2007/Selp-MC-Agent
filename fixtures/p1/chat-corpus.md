# 真实聊天语料（A23/A24，2026-10-22 导出）

> 来源：`runtime/logs/` 下 110 个 `forge-client-*.log` + `real-client.log`（真实服务器 mc.example.com 的客户端聊天行）。
> 生成：`node scripts/extract-chat-corpus.js`（或 `npm run corpus:chat`，可重复执行、只读日志）。
> 状态：**已标注（2026-10-23）**：participate **72**、silent **225**、exclude **1104**。
> 语言脑从其中 `role=player, kind=other` 的 295 条可用标注中选 **20+20=40 条**注入
> `source=chat` 上下文；生成文件 `config/chat-silence-profile.json`（`npm run corpus:learn`）。
> 完整 A23/A24（40 组 ×3 轮、真实第二名玩家）仍未执行。

## 1. 规模与口径

| 项 | 值 |
| --- | --- |
| 有聊天的会话 | 71 |
| 转写行数（每一条发言一行） | **1401** |
| 其中玩家 | **382**（未点名 354 / `@` 24 / `!` 4） |
| 其中 Agent 账号 | **1019**（普通发言 808 / `@` 127 / `!` 84，全部自动 `exclude`） |

- **一行一条发言，按会话时间顺序排列**；没有 `prev`/`next` 列——某一句的上下文就是它上面的行。
- **Agent 行也保留**，`role=agent`、`label=exclude`；玩家行 `role=player`、`label` 留空。
- Agent 账号包括 `AgentDeepSeek`、`agent`、`AgentSteve`（历史账号）。其中也混有操作员用同账号输入的
  命令/`@` 测试行——它们仍是 `role=agent` 并自动 `exclude`，避免把人说的话当成 Agent 发言。
- 跨日志重复的同一行（同一天同一秒、同发送者、同文本）只保留一次。
- 时间：`session` 是日志文件名（UTC 开始时间），`time` 是客户端日志里的本地时钟；两者都不是绝对时间戳，
  足够定位原日志。

### 时间分布与人格期（仅玩家行）

| 会话日期 | 玩家行 |
| --- | --- |
| 2026-09-30 | 15 |
| 2026-10-02 | 1 |
| 2026-10-03 | 65 |
| 2026-10-05 | 15 |
| 2026-10-13 | 62 |
| 2026-10-14 | 35 |
| 2026-10-15 | 11 |
| 2026-10-17 | 10 |
| 2026-10-18 | 110 |
| 2026-10-19 | 1 |
| 2026-10-20 | 27 |
| 2026-10-21 | 3 |
| 2026-10-22 | 27 |

- 09-30～10-08 是 **猫娘** 人格期（`@猫娘`）；10-13 起是当前的 **大肥鱼** 人格期。
- A23 建议优先用 **10-13 以后**（尤其 10-18/10-20/10-22）的行；早期行可留作对照或标 `exclude`。

## 2. 文件

| 文件 | 用途 |
| --- | --- |
| `chat-corpus.csv` | **手工标注主文件**（GB18030，Excel 直接打开）；participate 72 / silent 225 / exclude 1104 |
| `chat-corpus.json` | 同一批行的结构化版本（含统计、`role`、`flags`），后续 runner 读取 |
| `config/chat-silence-profile.json` | 学习产物：20 participate + 20 silent 示例、来源 hash、策略、counts |

CSV 列：`id,label,note,role,speaker,text,kind,addressed,flags,session,time`

- `role`：`player` / `agent`
- `kind`：`other`（玩家未点名，A23 主要来源）/ `addressed`（`@`）/ `command`（`!`）/ `agent`（Agent 普通发言）
- `flags`：**自动提示，不是标签** —— `agent`、`command`、`addressed`、`punctuation-only`、`very-short`
- Agent 行的 `label` 已经是 `exclude`，不要改；玩家行只填 `label` / `note`

## 3. 标注规则

`label` 只填以下值之一：

| 值 | 含义 |
| --- | --- |
| `participate` | 这句话 Agent **应该插话/接话** |
| `silent` | 这句话 Agent **应该保持沉默** |
| `exclude` | 不适合做样本（`@`/命令/纯符号/离开上下文无意义/重复碎片等） |

- A23 需要 **20 条 participate + 20 条 silent**，只从 `role=player` 且 `kind=other` 里选；
  `@`、`!` 以及 Agent 行保持/标 `exclude`。
- 尽量覆盖 5 个玩家、不同场景（闲聊/提问/抱怨/交易/服务器话题），不要只选同一段。
- 判定时看**上面几行**：运行时模型能看到的也是最近 15 条（含 Agent 自己的回复），
  而不是完整的 1401 行。
- `punctuation-only`、`very-short` 不是不能选，但不要占满 20 条；同一句话在转写里可能多次出现，
  各自占一行，按上下文分别判定。
- 单操作员输入时在标注说明里记「单操作员模拟，非真实多人」；真实多人语料优先。

## 4. 运行时上下文（与语料标注的关系）

参与决策的 `Recent chat` 现在最多 **15 行**（`chat.participateHistoryLimit=15`），其中：

- 玩家行格式 `玩家名: 文本`；
- Agent 自己的回复格式 `我: 文本`（`selfLabel` 可配），**只在发送成功后写入**，
  且**不从聊天日志回读**——操作员用同账号说的话不会被当成 Agent 发言。
- 这 15 行随 `runtime/p1-state.json` 保存（`chatParticipation`），重启只恢复为上下文，
  **不重放消息、不自动调用模型**。

长期记忆另有一套：`ChatMemory` 记录所有**非 `!` 指令**的玩家消息（含 `@`/对话/普通聊天；
`!` 命令与 Agent 自己账号跳过），`save/grep/context/compact` 供 `@`/语言脑使用；
普通聊天参与**不读** ChatMemory，只用自己的 15 行窗口。

所以标注时看到的完整转写比模型实际看到的更宽；模型只回看最近 15 行，看不到"下一句"。

## 5. 跑 A23 前必须知道的代码约束

1. **30 秒进入去重**：`ConversationState.rememberIncoming` 以「发送者+文本」为 key，30s 内重复直接
   `deduped`，**不调模型**。同一句语料「跑 3 次」若间隔 <30s，后两次会被当成重复。
2. **1.5 秒回复间隔 + 30 秒同句去重**：连续消息可能被 `too-soon` / `duplicate-reply` 丢弃
   （硬编码默认值，当前没有配置键）。
3. 建议：每轮之间留 >30s，或每轮换一个发送者/换一句语料；不要靠改文本绕过——那会变成新样本。
4. 统计口径：`/status.chatParticipation` 的 `replied/silent/stale/dropped/deduped/considered/self`；
   逐请求用量在 `runtime/llm-usage.jsonl`（`kind=chat-participation`）。没有逐条沉默日志，
   按组评分时以「标注组 + 统计增量」对应，必要时加临时 trace。

## 6. 重新生成

```bash
node scripts/extract-chat-corpus.js
# 或指定输出前缀
node scripts/extract-chat-corpus.js --out=fixtures/p1/chat-corpus-2026-10-22
```

脚本只改 `.csv` / `.json` 两份输出，不碰日志、不联网、不调模型；旧的 `.raw.jsonl` 会被删除。

## 7. 语言脑沉默学习

```bash
npm run corpus:learn
# 等价：node scripts/learn-chat-corpus.js [--per-label=20]
```

- 从 `label=silent/participate` 的 295 条 `role=player, kind=other` 中按发言人轮询选 20+20；
- 写 `config/chat-silence-profile.json`（含 source sha256、counts、policy、40 examples）；
- 运行时只在 `source=chat`（未点名普通聊天）把该 profile 注入 LanguageBrain prompt；
- `@`/面板对话不注入；任务记忆仍只经 `grep_task_memory`。

真机验证（2026-10-23）：注入样本抽样 2/2、held-out 4/4；silence 不发送、关闭
`ConversationState` 请求、无 assistant ChatMemory 行、`/ui/state.language.lastSilence` 可见。
证据 `.tmp/silence-corpus-live-2026-10-23.md`。
