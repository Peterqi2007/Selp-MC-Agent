# 真实聊天语料（A23/A24 备选，2026-10-22 导出）

> 来源：`runtime/logs/forge-client-*.log` 与 `runtime/logs/real-client.log`（真实服务器 mc.example.com 的客户端聊天行）。
> 生成：`node scripts/extract-chat-corpus.js`（可重复执行，只读日志）。
> 状态：**未标注**。`label`/`note` 留空，由操作员手工填写；本文件不预设答案。

## 1. 规模与口径

| 项 | 值 |
| --- | --- |
| 扫描日志 | 110 个 `forge-client-*.log` + `real-client.log`（共 111） |
| 有聊天的会话 | 71 |
| 非 Agent 聊天行（原始） | **382** |
| 去重后（同发送者+同文本） | **348** |
| 按玩家 | Eggxxh 88、Logos_Fyan 131、acdcdcggb_fish 37、Floating_Star 98、Stark_the_wolf 28 |
| 按类型 | other（未点名）**321**、addressed（`@`）24、command（`!`）3 |

- **排除 Agent 自己的账号**：`AgentDeepSeek`、`agent`、`AgentSteve`（历史账号）。它们仍出现在
  `prev`/`next` 里并带 `[agent]` 前缀，便于判断上一句/下一句是谁说的。
- **时间**：`first_session` 是日志文件名（UTC 开始时间），`first_time` 是客户端日志里的本地时钟；
  两者都不是绝对时间戳，足够定位原日志。
- **去重**：同发送者+同文本合并为一行，`count` 是出现次数，`first_session/first_time` 是首次出现；
  `chat-corpus.raw.jsonl` 保留全部 382 次出现（每次带自己的上下文），上下文不同时可改用 raw 行标注。
- **不硬编码名字**：语料保留发送者名，只用于人工判断；A23 的验收要求仍然是不按名字关键词过滤。

### 时间分布与人格期

| 会话日期（日志名） | 进入行 |
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

- 09-30～10-08 的会话是 **猫娘** 人格期（`@猫娘`）；10-13 起是当前的 **大肥鱼** 人格期。
- A23 建议优先用 **10-13 以后**（尤其 10-18/10-20/10-22）的行，与当前 persona/工具面一致；
  早期行可留作对照或标 `exclude`。
- 10-18 当天的 110 行集中在少数会话里，对话上下文较长，适合选 interact/silent 样本。

## 2. 文件

| 文件 | 用途 |
| --- | --- |
| `chat-corpus.csv` | **手工标注主文件**（UTF-8 BOM，Excel 直接打开）；`label`、`note` 两列留空 |
| `chat-corpus.json` | 同一批行的结构化版本（含 `sessions`/`last`/`flags`），后续 runner 读取 |
| `chat-corpus.raw.jsonl` | 382 条原始出现，每行 `{session,clock,speaker,text,prev,next}`，按上下文标注时用 |

CSV 列：`id,label,note,speaker,text,kind,addressed,flags,count,first_session,first_time,prev,next`

- `kind`：`other`（未点名，A23 主要来源）/ `addressed`（以 `@` 开头）/ `command`（以 `!` 开头）
- `flags`：**自动提示，不是标签** —— `punctuation-only`、`very-short`（≤2 字）、`repeated`（count>1）、`addressed`、`command`
- `prev`/`next`：同一会话里紧邻的聊天行；`[agent]` 表示这句是 Agent 说的

## 3. 标注规则（建议）

`label` 只填以下值之一：

| 值 | 含义 |
| --- | --- |
| `participate` | 这句话 Agent **应该插话/接话** |
| `silent` | 这句话 Agent **应该保持沉默** |
| `exclude` | 不适合做样本（`@`/命令/纯符号/离开上下文就无意义/重复碎片等） |

- A23 需要 **20 条 participate + 20 条 silent**，优先从 `kind=other` 里选；`@` 和 `!` 建议 `exclude`。
- 尽量覆盖 5 个玩家、不同场景（闲聊/提问/抱怨/交易/服务器话题），不要只选同一段。
- `punctuation-only`、`very-short` 不是不能选，但不要占满 20 条；`repeated` 行代表同一句话出现过多次，
  标一次即可（若要按上下文区分，用 `chat-corpus.raw.jsonl`）。
- 单操作员输入时在标注说明里记「单操作员模拟，非真实多人」；真实多人语料优先。

## 4. 跑 A23 前必须知道的代码约束

1. **30 秒进入去重**：`ConversationState.rememberIncoming` 以「发送者+文本」为 key，30s 内重复直接
   `deduped`，**不调模型**。同一句语料「跑 3 次」若间隔 <30s，后两次会被当成重复。
2. **1.5 秒回复间隔 + 30 秒同句去重**：连续消息可能被 `too-soon` / `duplicate-reply` 丢弃
   （这两个是硬编码默认值，当前没有配置键）。
3. 建议：每轮之间留 >30s，或每轮换一个发送者/换一句语料；不要靠改文本绕过——那会变成新样本。
4. 统计口径：`/status.chatParticipation` 的 `replied/silent/stale/dropped/deduped/considered`；
   逐请求用量在 `runtime/llm-usage.jsonl`（`kind=chat-participation`）。没有逐条沉默日志，
   所以按组评分时以「标注组 + 统计增量」对应，必要时加临时 trace。

## 5. 重新生成

```bash
node scripts/extract-chat-corpus.js
# 或指定输出前缀
node scripts/extract-chat-corpus.js --out fixtures/p1/chat-corpus-2026-10-22
```

脚本只改这三份输出，不碰日志、不联网、不调模型。
