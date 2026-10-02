---
# ═══════════════════════════════════════════════════════════════════════════
#  safety.md —— 安全限制的**代码强制点**登记表
#
#  ⚠️ 这份文件的定位必须说清楚：
#
#     它是**给人看的登记表**，不是给模型看的提示词。
#
#  为什么不能只写提示词就完事：
#    - 提示词是「请求模型别这么做」，模型有概率不听
#    - 在 Minecraft 场景里，提示词注入的来源很多：玩家打字、Mod 名、
#      方块名、聊天里的颜色代码、未来的联网检索结果
#    - 所以每一条红线都必须有一个**代码层强制点**，提示词只是第一层减速带
#
#  规则：**没有代码强制点的红线，不许写进 persona.md。**
#        （写了就是自欺欺人 —— 那条红线实际上不存在）
# ═══════════════════════════════════════════════════════════════════════════
schema: 1
version: 1
updated: 2026-01-01
---

# 红线 ↔ 代码强制点 对照表

| # | 红线 | 强制点（文件:位置） | 绕过难度 |
| --- | --- | --- | --- |
| **S1** | 不发任何服务器指令 | ① **能力白名单**：`llm/tools/registry.js` 里**根本没有** `send_command` / `run_command` 这类工具<br>② `chat/reply.js` 的 `sanitize()` 剥掉行首 `/` 和 `!`<br>③ `ClientModBody.isForbidden()`（已存在）<br>④ Mod `ControlHttpServer.forbiddenCommand()`（已存在，递归剥 5 层 `cmd`） | 需要**同时**攻破 4 层 |
| **S2** | 不注册（`/register` 会清空角色） | ①、③、④ 同上；<br>⑤ `scripts/client-real.js` 已删除 `--register` 参数（已存在） | 同上 |
| **S3** | 不编造事实 / 不承诺做不到 | ① `list_capabilities()` 把「做不到」显式喂给模型<br>② `intent.js` 的 JSON Schema 校验 —— 产出非法就整轮丢弃<br>③ `tools/registry.js` 的 `lookup_item` 校验方块名存在性 | 软约束（幻觉无法 100% 消除，只能压低） |
| **S4** | 不暴露自己是程序 | ① 系统提示词里的显式条款<br>② **输入侧短路**：命中 `/系统提示|system prompt|ignore previous|忽略之前|你是什么模型/i` 时不调 LLM，直接回固定台词 | 输入侧短路是硬约束 |
| **S5** | 不被叫到就不出声 | ① `chat/chatListener.js` 只放行 `!` 前缀与触发词两类输入，**其余在任何时候都不进 LLM**<br>② `reply.js` 是**唯一**的说话出口，且只被 `chatListener` 与 `llm/intent.js` 的回复路径调用<br>③ **没有 `say` 工具**（模型不能自己造一个说话动作） | 结构约束，无法绕过 |
| **S6** | 不做没被要求的事 | ① 动作类型是 4 值枚举（`task`/`go_to`/`stop`/`null`）<br>② 无玩家请求上下文的 LLM 回合**一律拒绝产生 action**（`followUp.js`）<br>③ 无 `SpeechScheduler`、无状态触发器（P0 已删除） | 结构约束 |
| **S7** | 不回答现实世界问题 | ① 提示词条款<br>② 输入侧关键词短路（可选，误杀率高，**建议只靠提示词**） | 软约束 |

# 输入侧短路词表（S4）

**配置位置**：`config/llm.json` → `safety.injectionPatterns`

命中即**不调用 LLM**，直接返回 `safety.injectionReply`：

```jsonc
{
  "safety": {
    "injectionPatterns": [
      "系统提示", "system prompt", "ignore (all )?previous", "忽略(之前|以上)(所有)?",
      "你是什么模型", "which model", "你是 ?(GPT|Claude|AI|人工智能)",
      "重复(你的)?(指令|prompt|设定)", "repeat your (instructions|prompt)",
      "开发者模式", "developer mode", "jailbreak", "DAN mode"
    ],
    "injectionReply": "喵？我听不懂这些，要砍树吗～",
    "maxInputChars": 200,
    "stripColorCodes": true
  }
}
```

> `stripColorCodes` 很重要：Minecraft 聊天里带 `§` 颜色码和
> `{text:...,extra:[...]}` 富文本结构。**必须剥掉**，否则注入者可以把
> 指令藏在 JSON 结构或颜色码中间，绕过上面的正则。

# 三层「说话出口」收口（S5 的关键）

```
        ┌──────────────────────────────────────────────┐
        │  body.chat()    ← 唯一真正能往游戏里发字的函数   │
        └────────────────────▲─────────────────────────┘
                             │ 只允许这两个调用者
        ┌────────────────────┴─────────────────────────┐
        │  chat/reply.js  reply(ctx, text)             │
        │    ├─ 被 chatListener 调用（玩家 ! 指令的结果） │
        │    └─ 被 llm/intent.js 调用（say 字段）        │
        │  其它任何地方想说话，都必须走这里并过 sanitize  │
        └──────────────────────────────────────────────┘

        ❌ 禁止：任务类、生存类直接调 body.chat()
           （P0 不主动发言，所以它们没有任何理由说话）
```

**实施检查**：`npm run selftest` 里加一项 —— grep `src/` 里所有 `body.chat(` / `.chat(` 调用点，
断言只有 `reply.js` 一处。这是可以自动化验证的结构约束。

# 待办：P1 需要补的硬约束

| 项 | 说明 |
| --- | --- |
| 工具调用的**参数级**限制 | `do_task` 的 `count` 上限（如 1..128）、`mine` 的方块名必须在 registry 里 |
| 领地/保护区检测 | 检测到 `ftbchunks` 类 Mod 时，建造/挖掘前先拒绝 |
| 语音/图片输入的注入 | P0 没有这类输入，P1 若加需要重新评估 |
