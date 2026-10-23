# 最近服务器对话语料（2026-10-23，待标注）

来源：`runtime/logs/` 下 2026-10-23 的两份真实客户端日志：

- `forge-client-2026-10-23_12-31-38.log`
- `forge-client-2026-10-23_14-36-40.log`

生成命令：

```bash
node scripts/extract-chat-corpus.js \
  --since=2026-10-23 \
  --out=fixtures/p1/chat-corpus-2026-10-23
```

## 文件

| 文件 | 用途 |
| --- | --- |
| `chat-corpus-2026-10-23.csv` | **待标注主文件**（UTF-8 BOM，Excel 可直接打开） |
| `chat-corpus-2026-10-23.json` | 同批结构化版本（统计、role、kind、flags） |
| `chat-corpus-2026-10-23.md` | 本说明 |

## 规模

| 项 | 值 |
| --- | --- |
| 会话 | 2 |
| 转写行数 | **207** |
| 玩家行 | **77**（未点名 other 77，@ 0，! 0） |
| Agent 行 | **130**（agent 106、addressed 18、command 6，均自动 `exclude`） |
| 玩家 | `Eggxxh` 40、`Logos_Fyan` 35、`Stark_the_wolf` 2（行数含 agent 行） |

## 标注规则

`label` 只填：

| 值 | 含义 |
| --- | --- |
| `participate` | Agent 应该插话/接话 |
| `silent` | Agent 应该保持沉默 |
| `exclude` | 不适合做样本（@/命令/纯符号/离开上下文无意义/重复碎片） |

- 只给 `role=player` 且 `kind=other` 的行填 `participate` / `silent`；
- Agent 行保持 `exclude`，不要改；
- 看**上面几行**的上下文：运行时模型只看到最近 15 行；
- 本轮真实对话里有玩家直接喊「大肥鱼」「是吧大肥鱼」「大肥鱼」等，按是否真正在叫 Agent 判定；
- `@`/`!` 已自动识别，不用标。

## 与旧语料的关系

- 旧主文件：`fixtures/p1/chat-corpus.csv`（1401 行，已标注 72 participate / 225 silent）；
- 本文件只含 **2026-10-23 最近两份日志**，用于补充/重新标注，不覆盖旧文件；
- 标注后可再次运行 `npm run corpus:learn`，把新样本纳入
  `config/chat-silence-profile.json`。
