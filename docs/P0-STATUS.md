# P0 实施状态

> ## ⚠️ 历史文档（最后更新 2026-10-02，数字已过时）
>
> **本文是 P0 阶段（重写之前）的实施状态快照。** P0 的交付物 A–E 本身仍然是真实有效的验收记录，
> 但文中的**套件数目、技能数、工具数**都已过时，看到它们时不要以为是当前值：
>
> | 本文写的 | 现在 |
> | --- | --- |
> | `p0:verify` **6/6** 套件 | **8/8** 套件 |
> | `selftest` **153** 项 | **175** 项 |
> | 技能层 **12** 个技能 | **18** 个技能（另有采矿计划器） |
> | LLM **6** 个工具 | **8** 个工具（+ `scan_around`、`do_skill`） |
> | `path:test` **22/22**、`tasks:test` **37/37**、`llm:dry` 路由 30/30 | **33/33**、**52/52**、路由 **67/67** + 工具 39/39 |
> | Mod jar 43896 字节 | **60961** 字节（改 Mod 必须 `client:install` + 重启客户端） |
>
> 文中「真机复测三项修正**未通过**，决定重写」那一段是**当时**的处境；重写已落地（技能层 v1 → 第二批结构
> → 采矿 numen 重构 → 收集/垫柱等），真机验收也已多轮通过。
>
> **当前状态以这些为准**：[`../README.md`](../README.md) §3（进展与当前状态）、
> [`ARCHITECTURE.md`](ARCHITECTURE.md)（代码级架构）、[`REWRITE-PLAN.md`](REWRITE-PLAN.md)（逐批次记录）、
> [`P0-PLAN.md`](P0-PLAN.md)（计划书，其 §11 仍由 `npm run plan:audit` 持续看护）。
>
> **仍然有效且值得保留的**：§五 安全边界（不可回归）、§6.4 AuthMe 自动登录、§6.7 那个真实故障
> （机器人被流浪者射杀）、以及 §四之三「真机运行阶段抓到的缺陷」——这些是踩坑证据，不是状态数字。

对应 `docs/P0-PLAN.md`。本文只记录**可核查的事实**：交付物、验收证据、以及尚未完成的部分。
最后更新：2026-10-02（接手同步：深层钻石矿放宽为铁镐，测试期望已对齐；人工真机复测三项修正**未通过**，
决定参考 mc_aiplayer / mindcraft 重写。第一/二刀已落地：工具策略唯一化（`src/world/toolPolicy.js`）、
树木识别重写（`src/world/safety.js`）、Mod 新增 `useon`/`menu`/`click`/`close` 原语、
技能层 v1（`src/skills/`，12 个技能，`npm run skills:test` 17/17）。完整路线图见 `docs/REWRITE-PLAN.md`）。

### 2026-10-02 Phase 2/3 真机验收（11/11，技能层）

#### 追加：目标服务器（mc.example.com）最终测试（2026-10-02 22:0x，操作员指定）

任务：合成一把锄头 → 水边开垦 6 格耕地 → 种完背包里 6 个小麦种子。结果全部通过（以方块状态/背包核验）：
`wooden_hoe` 合成成功；6 块湿润 `farmland`（同层 4 格内有水）；6 株 `wheat`（age 0）种下，种子 0 剩余。

顺带修掉 3 个只有真机才会暴露的问题：① Mod 的 `select` 只搜快捷栏，主背包里的锄头"装备失败"后
6 次耕地其实在拿种子点草地；② `place/equip` 的物品名没带 `minecraft:` 前缀，与 Mod 的字面比较失败，
放置变成空挥；③ 耕地水化判定必须与香草一致（水源在同层或高一层才有效，水在下方不算），否则岸上的
耕地会退回泥土。技能计数也从"Mod 返回 ok"改成"重读方块/背包确认真的变了"。

##### 跨河移动（同日稍晚）

约 20 格宽的大河实测：**修复前失败** —— 机器人游了 13 格后卡在对岸边缘（氧气 -8，`stuck` → `noPath`）。
根因是 `ClientActions.WalkTo` 只在"落地且贴墙"时按跳跃键，而水里跳跃=上浮/爬岸，浮在水面时
`onGround` 永远为假。已改为水里朝上或贴岸时按住跳跃键（下潜不受影响），重编译重启后复测：
北→南 12.3s、南→北 10.3s，双向通过（氧气最低 201/300）。测试工具 `scripts/move-probe.js`。

##### 攻击怪物（同日夜）

第一轮实测：机器人能接近并挥剑，但**没有一次属于自己的击杀**（操作员当场说明蛆是他自己打的）。修掉
三个真机问题：① Mod 在目标死亡时返回 false（每次击杀都误报"还活着"）；② 250ms 连点导致伤害只有
约 20%（改为攻击条充能后挥剑）；③ 技能从不换武器（曾拿面包打僵尸，现在按 剑→斧 自动装备）。
复测干净击杀：`born_in_chaos_v1:corpse_fly` 13 HP，23m→3m 追击 10 秒，2 秒内血量 13→5.5→死亡，
机器人血量 12.1→14.1 未受伤，`{"ok":true}`。

`npm run personal:test -- --skip-server --no-prepare --allow-modded`（客户端单人世界，操作员手动备料，
**不上真实服务器**）→ **11/11 通过**：craft 2/2、smelt 1/1、farm、sleep（白天自动跳过；夜里单测是真的
`23232 → 次日 30` 睡到天亮）、Phase 3 三项。

三条真机根因（均已修复并有回归）：

1. **Mod `click` 解析**：`numbers(rest,3)` 要求前三个 token 全是数字，`click <槽> <键> <模式>` 一律被判
   `usage` —— 合成/熔炼的点击在真机上从未执行过，而当时宽松的假 Mod 让 42 项离线测试全绿。
   修正 Java 解析并把假 Mod 的解析规则对齐（`client:test` 48/48，新增 5 条契约检查）。
2. **熔炼燃料**：香草炉子菜单 quick-move 先判"可熔炼"再判"可燃烧"，原木/木板/木棍会被优先送去输入槽，
   输入被占用时整个操作失败、燃料槽永远为空。现在优先纯燃料（煤）→ 装入后校验 → 失败改手动放置。
3. **睡觉判定**：Mod 的 `isDay`（`Level.isDay()`）在这套整合包凌晨 2 点仍报白天，会误跳过夜晚测试。
   技能与验收脚本改为按世界时钟判断（`timeOfDay` 12542–23458 为夜）。

### 2026-10-02 第二轮真机反馈修复（面板 / 挖泥土 / 攻击）

真机三连反馈逐条定位并修复；离线新增回归：tasks 46→50、client 协议 32→34。

| 反馈 | 真机根因（实测取证） | 修复 |
| --- | --- | --- |
| 面板能发指令但数据全空 | 浏览器缓存/端口回退不透明；任一步状态构建抛错即 500，面板只剩空白 | `/ui/state` 永不 500（错误也带 `error` 文本返回）；`/panel` 与接口加 `no-store`；端口被占时**明确告知**并显示实际端口；缺字段时面板显示原因而不是空 |
| `!mine dirt` 报「附近没有泥土」但人就在草地上 | 实机探针：24 格内 4248 个泥土/草方块，**却一个都「够不着」**——用户开着 `ContainerScreen`，Minecraft 忽略所有移动键；旧判定把「全够不着」谎报成「附近没有」，还连刷 33 次 | ① `ClientModBody` 补映射 `screenOpen/screen/mouseGrabbed`，移动前检测到界面直接拒走并报 `screen-open`；② `HarvestTask` 区分「没目标」与「够不着」并带上真因+扫描格数；③ 系统级失败立即熔断（33 次刷屏→1 次）；④ 泥土按**家族**匹配（含模组 `*_dirt`/`*_grass_block`）；⑤ `strictMining` 豁免土壤只防石砌建筑 |
| `!attack` 附近有僵尸却被拒 | 旧默认只搜 8 格（僵尸常在 10-20 格）；且所有技能命令**没有任何回复**，拒因不可见 | 搜索半径 8→16、无目标自动升到 24；死亡时说「先复活」、任务停摆时说 `!resume`、开着界面时如实提示；`runSkill` 现在**必回复**成功/失败与原因 |

实机验证（本机 Forge 客户端，`mc.example.com`）：实机挖到 `1 dirt`（另得蒲公英）证明挖掘链路可用；
开着界面时立即报 `could not reach ... (screen-open)` 且只失败 1 次（修复前 33 次）。

### 2026-10-02 面板第二轮修复（截图定位）

操作员截图显示所有字段停在静态占位符（`agent`/`body: ?`/`updated: -`）——说明页面脚本从未成功
渲染过一次，而不是「数据为空」。逐项排查后确认两个真缺陷：

1. **面板的 `@猫娘 …` 根本到不了 LLM**：`POST /command` 把整行丢给确定性命令表，而命令表没有
   `@猫娘` 这个 handler，于是面板里最自然的输入必回 "unknown command @猫娘"。
   → 现在与游戏内完全同路由：`@猫娘` 开头走 `llm.handle`（`source: 'panel'`），其余走命令表，
   并容忍粘贴进来的 `!` 前缀。
2. **面板没有可见的自诊断**：状态构建失败时前端只剩空白；agent 没跑、端口回退、界面开着，
   这些状态都不明显。→ `/ui/state` 改为 `safeUiState()`（永不抛错，错误作为数据返回）、
   所有响应 `no-store`（旧页面不再被缓存复用）、端口回退明确日志并写入状态；面板新增诊断横幅，
   直接显示：未连接原因 / 实际端口 / body 是否就绪 / 游戏界面是否开着。

顺带修掉两个测试基础设施问题：坏 ctx 用例不再另起端口（曾因 keep-alive 挂起整套测试，
孤儿进程又占住端口污染下一次运行）；`control:test` 24 → 27 个场景。

### 2026-10-02 面板第三轮修复（强刷无果 → 服务端快照）

操作员反馈「多次强刷无果、也没有诊断横幅」。实机取证：agent 正常（pid 29132 在跑、8766 监听、
`/ui/state` 返回完整数据、`/panel` 12204 字节且含诊断横幅）——即**服务端一切正常，是浏览器侧
没有执行页面脚本**（横幅本身依赖 JS，不出现即说明脚本没跑）。
→ 面板顶部新增**服务端渲染快照**（写入 HTML，不需要 JavaScript）：时间戳 · 端口 · agent ·
body 状态 · 坐标 · 血量；外加 `<noscript>` 明确提示「浏览器未执行 JavaScript」。
这条快照同时是「你看的是不是这份 agent 的页面」的判据：刷新后时间戳不变即不是。

### 2026-10-02 面板第四轮修复（服务端快照已出现、字段仍空 → 内联脚本被执行环境拦截）

操作员新截图：蓝色服务端快照出现（页面来源已确认、端口/坐标/血量都对），但字段仍是占位符，
**且没有 noscript 提示** —— 说明浏览器认为自己启用了 JS，却没执行那段**内联** `<script>`
（典型的扩展/策略只拦截内联脚本）。
→ 脚本改为**同源外链文件** `/panel/app.js`（拦截器通常放行），并在脚本第一行向 `/panel/ping`
发心跳：浏览器只要真的执行了脚本，agent 日志就会出现 `panel script executed in a browser`；
如果日志里始终没有这一行，就不再需要在服务端找原因。脚本经语法检查且为 ES5 兼容。

### 2026-10-02 面板第五轮修复（Edge 无痕同样空白 → 提供完整无 JS 回退）

Edge 无痕（无扩展）依旧只有服务端快照、字段空白 → 排除扩展，问题在该浏览器的脚本执行环境；
而服务端只能确定"请求到达过"。与其继续猜，面板现在提供**完全不依赖 JavaScript** 的能力：

1. `/panel/state`：服务端渲染的实时状态页（身份/血量/饱食/坐标/大脑/队列/LLM/最近输入/日志），
   用 `<meta http-equiv="refresh" content="2">` 自刷新，由面板内嵌 **iframe** 加载 → 脚本被
   完全禁用也能看到实时状态；
2. 指令框改为**原生表单**（`method=post` 到 `/command`，`priority` 同名提交）：无 JS 时按「发送」
   走普通提交，服务端处理后 303 回面板；有 JS 时由外链脚本拦截提交并走 fetch；
3. 快捷按钮改为 `data-cmd` + 外链脚本绑定（内联 `onclick` 也会被同样的策略拦截），
   `/panel` 仍保留服务端快照与 `<noscript>` 提示。

`control:test` 28 → 30 场景（新增 /panel/state 与表单 POST 303 两条）。

### 2026-10-02 面板第六轮：整页服务器渲染仪表盘 + 访问日志（按「发送/接收/渲染」三段排查）

操作员明确要求按「状态是否发出 → 是否被接收 → 是否被正确渲染」分段查，并指出手动刷新也不更新。
本轮改动：
1. **`/panel` 改为整页服务器渲染仪表盘**：`<meta http-equiv="refresh" content="2">` 由浏览器原生
   每 2 秒整页重载；页面**不含任何 `<script>`、不含 iframe**。状态（身份/血量/坐标/大脑/队列/LLM/
   最近输入/日志）全部由服务器在每次请求时重新渲染 → 「渲染」环节不再依赖任何浏览器执行能力。
2. 指令迁移到 `/panel/cmd`（普通表单，无自动刷新，打字不被打断）；提交后 303 回面板。
   快捷动作改为普通链接 `GET /command?command=…`（同样 303 回面板）。
3. **新增访问日志 `runtime/logs/panel-access.log`**：记录每次 /panel、/panel/state、/ui/state、
   /command 请求的时间、方法、路径与 User-Agent → 直接回答「浏览器到底有没有把请求发到 agent」。

本轮验证：control:test 30 → 31 场景；p0:verify 6/6。

### 2026-10-02 面板问题环节确认（结束）

操作员截图确认新面板已有完整状态。访问日志 `runtime/logs/panel-access.log` 给出链路证据：
浏览器（真实 UA）以 **2 秒间隔持续请求 `/panel`**，每次响应都由服务器现场渲染最新状态。
**结论：问题环节 = 「渲染」——浏览器没有执行任何面板脚本（内联/外链/iframe 皆然），
而「发送」「接收」两层一直正常。** 改成纯服务器渲染 + 原生 meta refresh 后三层全通。
另补：面板发出的指令现在会写入 `ctx.panelCommands` 并出现在「最近识别到的输入」表里。

### 2026-10-02 修正 screen-open 误判（时序缺陷）

操作员澄清：不是"界面开着就不该执行"，而是**在游戏聊天里打完命令、按回车的瞬间**，
agent 拿的是缓存里的旧快照（`ChatScreen` 还标着开着），于是任务刚起步就被判 `screen-open`
放弃。数据没错，判断时机错了。

修复（`src/body/clientModBody.js`）：
1. `moveTo()` 遇到快照说"界面开着"时，先对**实时 /state 轮询最多 900ms** 重新确认
   （`_screenStillOpen()`）；聊天界面在按下回车后就关了，正常流程不会再被误判；
2. 确认确实还开着时，默认**自动发送 `close` 关闭界面**再继续走（`_tryCloseScreen()`，
   等待 /state 报 `screenOpen:false`）；关闭失败才如实报 `screen-open`；
3. 新增配置 `behaviour.autoCloseScreens`（默认 true）：设为 false 恢复旧的"拒绝并提示"。

`client:test` 新增三条：旧快照不阻塞新走位（且不发 close）、真开界面自动关闭后继续走、
关闭该功能后仍如实拒绝。协议测试 34 → 35。

### 2026-10-02 取消聊天框自动关闭（保证可以随时中断）

操作员反馈：自动关界面把**正在打字的聊天框**也关掉了，导致无法中途发 `!stop` 打断任务。

修复：
1. **聊天界面永不自动关闭**（`ClientModBody.moveTo`：`/chat/i` 匹配的一律不 close）；
   改为**等待玩家自己关闭**，默认最多等 20 秒（`behaviour.chatScreenWaitMs`），超时才如实报
   `screen-open`。其它界面（背包/箱子/ESC）仍按 `autoCloseScreens` 自动关闭。
2. **Mod 侧（已重编译安装，44060 字节）**：`WalkTo` 在 `mc.screen != null` 时**冻结卡死计时**
   （`lastProgressAt`/跳跃计数重置，暂停时长不计入 60s 总超时）——你打字期间任务不会因
   "stuck" 而失败，界面一关就继续走。

协议测试 35 → 37（聊天框不自动关闭 + 玩家关闭后恢复行走）；p0:verify 6/6。
注意：Mod 侧改动需要**重启游戏客户端**才生效；Node 侧重启 agent 即生效。

### 2026-10-02 修正「stop 停不下来」（规划器复活任务）

操作员反馈 `!stop` 无法停止任务，要求判定是"任务太多"还是"停止逻辑"问题。
**结论：停止逻辑问题。**
1. `!stop` 只做了「取消当前任务 + 清空队列」，但 `slowLoop` 每 2.5 秒重新 `decide()`，
   于是立刻开始下一个目标 —— 看起来像"停不完"；
2. 更严重：面板急停所设置的 `autoPlanDisabled` **从未被任何代码读取**（只写不读），
   所以连急停也停不住自动规划。

修复：
- `brain.slowLoop()` 在**清空队列之后、规划之前**检查 `autoPlanDisabled` → 停掉自动规划，
  但**明确指令仍可执行**（enqueue → 队列非空 → drain 后继续保持安静）；
- `brain.status()` / `/ui/state` / 面板显示「⏹ 自动规划已停（发 !resume 继续）」；
- `!stop` 设置该标志并回复提示；`!resume` 清除它；`brain.resume()` 同样清除。

`control:test` 31 → 32 场景：`!stop` 后规划器不得再选新目标、明确指令仍被接受、`!resume` 恢复。

### 2026-10-02 准心挖掘 + 自由视角（挖泥土优化）

操作员反馈：挖泥土时"大量跳跃、不会转视角、只会向下挖"，建议加准心方块识别：**准心对着目标
就直接挖**，并给 agent 更自由的视角。

三件套：
1. **Mod 准心射线**：`/state` 新增 `target`（`mc.hitResult`，即游戏自己画方块描边用的同一射线），
   新增 `target` 命令做即时射线（4.5 格 reach）→ 结果 `{name, position, face, distance}`；
2. **Node**：`ClientModBody.targetBlock()`、`look(yaw,pitch)`、`sweepLook({steps,pitch,filter})`
   （像玩家一样每 45° 扭头环视，找匹配的准心目标）；`!look`/`!lookat`/`!target` 三个手动指令；
3. **`MineBlockTask` 准心优先**：任务开始先看准心是否已在目标方块上 → 是就直接挖（零走路、
   零跳跃）；不是则 `sweepLook` 环视一圈再决定；环视后仍没有才回到原来的"扫描 + 寻路"。
   没有准心的身体（mineflayer/mock 无准心）自动跳过这段，行为不变。

测试：tasks 50 → 52（准心在目标上零移动挖到；准心在石头上不误挖）；protocol 37 → 39
（target 透传、sweepLook 扭头找到目标）。Mod jar 45160 字节已安装，**需重启客户端生效**；
Node 部分重启 agent 即生效。

---

## 一、总览

| 交付物 | 内容 | 状态 | 证据 |
| --- | --- | --- | --- |
| **A** 寻路优化 | vec3 垫片 + 世界适配器 + 运动模型 + A\* 规划器 + 航点行走器 + 失败分类（含 `jump-blocked` / 排除走不到的格子 / 横向换方向） | ✅ 完成 | `npm run path:test` 22/22 |
| **B** 三原语任务 | `HarvestTask` + `ChopWoodTask` + `MineBlockTask` + `GoToTask`（含 `collectDrops()`、工具硬度表） | ✅ 完成 | `npm run tasks:test` 37/37 |
| **C** LLM 大脑 | `src/llm/*`（含 `tools/`）+ `config/llm.json`，严格意图 Schema + **6 工具**白名单 + Fallback Router | ✅ 完成 | `npm run llm:dry` 路由 30/30、Schema 16/16、工具 22/22 |
| **D** 双通道输入 | `ChatListener`（`!` 与 `@猫娘` 两条通道）+ `reply.js` + `botFacade` | ✅ 完成 | `npm run control:test` 24/24 |
| **E** 面板与死亡处理 | `/panel` + `/ui/state` + `/command{priority}` + `/emergency-stop` + `DeathWatch` | ✅ 完成 | 同上 |
| ~~**M3** Java 补丁~~ | 仍然取消：P0 的三个原语不需要新增 Mod 端点。后来为「不再对着墙跳 60 秒」改了 `WalkTo` 并重编译安装（`client:build` + `client:install`），但那是行为修正，不是 P0 的前提 | — | 见 §四之四 ②、§6.5.1 |

**一条命令验证全部（离线，不需要游戏、不需要控制 Mod、不需要 API key）：**

```
npm run p0:verify
```

当前结果：**6/6 套件通过**（约 20 秒）。`npm run selftest` 从 80 项扩充到 **153 项**（计划要求 ≥30 项新增）。

其中 `npm run plan:audit` 是最后补上的一道闸门：它把**计划书 §11 的「做 / 不做」清单逐条变成断言**，
直接对着代码检查（`src/pathfinding/` 五个文件在不在、`moveTo` 是否真的接了规划器、
6 个工具是否恰好 6 个且没有 `say`、`/register` 的 5 层闸门是否还在、`allowDig` 是否仍为 false …），
外加一条**「配置项必须真的被消费」**的检查——计划 §7 明确要求这一点，而这正是 `bot.authme`
当初踩过的坑：一段看起来权威的配置，没有任何代码读它。

> 这条检查当场抓出 7 个死配置键：`pathfinding.{allowDig,waypointRange,stuckThreshold}`、
> `death.{alertConsole,alertPanel,alertStateFile}`、`safety.requireNaturalTrees`、
> `chat.replyOnTaskResult`。它们已经在 `config/agent.json` 里写着、在文档里描述着，
> 但**没有任何代码读**——也就是说改它们不会有任何效果。现在全部接上了线（含
> `replyOnTaskResult` 打开后只汇报**玩家发起**的任务，规划器自己的工作仍然不吭声）。
>
> 本轮新增的三个键也一并纳入了这道闸门（`safety.requireLeaves`、
> `pathfinding.jumpStreakLimit`、`pathfinding.maxSidesteps`），所以它现在覆盖 **41 个配置键**。

---

## 二、交付物 A：寻路

新增 `src/pathfinding/`：

| 文件 | 作用 |
| --- | --- |
| `vec3util.js` | A\* 需要的 `hash`/`cost` 垫片。**必须是普通对象**：`vec3` 是工厂函数且不提供 `hash`，继承 `Vec3` 会让 `data.hash` 变成 `undefined`，A\* 随即以 `nodes=1` 返回 `noPath` |
| `clientWorldAdapter.js` | 把 Mod 的 `blocks.cells` 扁平表包装成世界视图；**网格外一律返回 `null`（未知），绝不假装是空气** |
| `movementsAdapter.js` | 运动模型。保守设计：不挖穿、不搭桥、不跑酷、不进岩浆、不进未知格 |
| `planner.js` | 复用 `mineflayer-pathfinder` 的 A\* 求解器，只替换世界与运动模型（其 `compute()` 只通过 `getNeighbors` 接触世界） |
| `walker.js` | 航点合并（长直路 40 格 = 1 次 `moveto`）+ 卡死检测 |
| `navigator.js` | 迭代重规划，处理 ±24 格感知半径：走一段 → 重新规划 → 再走 |

> **与计划书的一处有意偏差**：§2 架构图写的是「`GoalNear`（复用）」，实现里用的是自己写的
> `WeightedGoalNear`。原因是插件的 `GoalNear.heuristic()` 用**不加权**的三维距离，而本项目的
> 移动代价是加权的（爬升 1.5、游泳 2.5）——直接复用会让启发函数**高估**代价，
> A\* 于是返回次优路径（表现出来就是「绕远路」）。A\* 求解器本身仍然完全复用。

**接线（这是这一步真正的价值）**：`ClientModBody.moveTo()` 现在会先规划——近距离（<3 格）或 `{raw:true}` 直连客户端，其余走 A\* + 航点。失败原因写入 `body.lastMove`，并落盘 `runtime/path-trace.jsonl`。

`npm run path:test` 的 14 个场景（计划 §3.6 的 7 个 + 7 个补充）：空地直行、绕墙、绕水（开/关游泳）、4 级台阶、密闭石室 `noPath`、网格外 `out-of-grid`、卡死检测、航点合并、导航器迭代、**岩浆永不进入**、以及 vec3 垫片与方块分类。

**接线阶段抓到的三个真实缺陷**（都不是靠读代码发现的，而是靠「让测试真的去跑」）：

1. **`ClientModBody.snapshot()` 从来没有暴露 `blocks`。** `ClientWorldAdapter.cells()` 读的是 `snapshot().blocks.cells`，于是**整个 A\* 层在真机上从未生效**：每次规划都返回 `unknown-block`，`moveTo` 静默退化成客户端的直线行走器。表现出来只是「偶尔走不进树」，看起来像运气问题。→ 现在 `snapshot()` 暴露该引用，并且协议测试里加了一条回归检查。
2. **规划不可用时 `moveTo` 直接拒绝移动**，而旧行为是让客户端自己走。→ 现在只在 `unknown-block`（即完全没有方块扫描）时降级为直线 `moveto`；其它失败原因一律照实报出，绝不粉饰。
3. **`Task.execute()` 的超时定时器从不清理**，每个任务都会留下一个长达 3 分钟的挂起定时器，让 CLI 结束后无法退出（离线测试因此「挂住」过一次）。→ 现在 `finally` 里清理。

---

## 三、交付物 B：三原语

`HarvestTask` 是「找 → 走近 → 破坏 → 收集 → 循环」的骨架，全部走 Body 契约。四条从踩坑中来的规则：

1. **按掉落物计数，不按挥动次数。** `collected` 是**背包增量**。空手挖石头会破坏方块且**不掉落任何东西**，按方块计数会报告成功而背包是空的。
2. **零收获算成功。** 少树地图上失败会让规划器无限重排同一个目标；有进展但不够才算失败。
3. **背包满则提前失败并说明原因**，而不是「挖了掉、掉了挖」直到超时。
4. **够不着的目标记入 `failedTargets`** 并试下一个，而不是原地循环。

顺带把「方块 → 掉落物」做成共享表（`src/world/items.js: blockDrop`），并让 `MockBody` 使用它——否则离线测试会在「挖石头得到石头」的假世界里通过，再到真机上失败。

`MineBlockTask` 对镐的要求是**硬前置**：P0 不做合成，所以没有镐就明确失败并说明，而不是空手把石头挖掉却一无所得。

---

## 四、交付物 C / D / E

**C 意图层**：`action.type ∈ {task, go_to, stop, null}`、`task ∈ {chop, mine, collect}`。**枚举就是能力边界**——没有「执行服务器指令」这个类型，所以提示词注入无处可去。`llm:dry` 里有一条注入用例（`{"type":"command","command":"/op me"}`）验证它被拒绝。

**C 工具层**（`src/llm/tools/`）：计划 §5.3 指定的 **6 个工具**，一个不多一个不少：

| 工具 | 类型 | 作用 |
| --- | --- | --- |
| `observe()` | 只读 | 坐标/维度/血量/饥饿/时间/手持/背包/掉落物/16 格内主要方块/在线玩家/当前任务 |
| `find_blocks(names, maxDistance)` | 只读 | 最近的目标方块坐标，并区分「这里没有」与「你没问过」 |
| `lookup_item(name)` | 只读 | 查 `minecraft-data`；Mod 名字**明确回答「我不认识」** |
| `do_task(task, args)` | **有副作用** | `chop` / `mine` / `collect` |
| `go_to(x, y, z)` | **有副作用** | 寻路走过去 |
| `stop()` | **有副作用** | 立刻停手 |

**刻意没有 `say` 工具**——说话只能是意图里的 `say` 字段，也就是「对玩家的回复」，
所以「自主发言」在能力上就不存在，而不是靠提示词叮嘱。

三点设计细节：
- **注册表是唯一入口**：名字白名单 + 参数 Schema 校验，未声明的参数直接拒绝（`{x,y,z,command:"/kill"}` 会被拒），
  actuator 自己的拒绝（`count` 超限、`mine` 缺 block）也如实上报为**失败**，不会被包装成「成功」。
- **有界工具回合**：`limits.maxToolCallsPerTurn`（默认 4）+ 最多一次追问，
  模型可以「先 observe 再决定」；卡在工具循环里也会回落正则路由，不会转圈。
- **`toolCalling` 默认关**：原生工具调用需要 provider 支持；关闭时提示词里**不列工具**
  （否则模型会吐一个工具调用形状的 JSON，白白掉进正则兜底）。开启后 `GET /llm` 与面板会显示工具清单。

**Fallback Router 是可靠性的来源**：没有 key、超时、返回非法 JSON 三种情况全部降级到正则路由。30 条中英混合语料 **30/30 正确**（计划要求 ≥26）。

**D 双通道**：`!` 走确定性命令表；`@猫娘` 走 LLM。两条通道各自独立去重，互不干扰。输出是**纯反应式**的：玩家不说，Bot 不说（`replyOnTaskResult: false`）。

**回声过滤是必需的**：`ChatLog` 只有渲染文本、没有发送者字段，而 Bot 与玩家同名——所以 `reply.js` 的 `sanitize()` 会剥掉回复开头的 `!` 和 `/`，否则 `!help` 的回复会被自己的输入管道当成新指令，形成自激循环。

**E 面板**：单文件内嵌 HTML，零依赖、零 CDN。`/ui/state` 是**摘要**——刻意不含 40817 格的方块扫描（全量 `/status` 仍保留给工具）。急停分四级并**诚实汇报每一级的结果**。

**死亡处理**：Mod 一直在上报 `player.isDeadOrDying()`，但 `ClientModBody.snapshot()` 把它丢掉了，所以死亡一直是静默的。现在补上 `dead` 字段 + `DeathWatch` 轮询 → 中止一切任务、`brain.stopped`（比 `paused` 更强：只有显式 resume 能解除）、并在**游戏界面外**三处告警（控制台 / 面板红条 / 状态文件）。**不自动恢复**是刻意的——用户要的就是「中止一切任务」。

> 本轮修掉的接线缺陷：LLM 派发的任务被标成 `source: 'chat'`，导致计划 §5.6 的「任务结束后回报」永远不会触发；以及 `brain.runTask` 结束后不排空队列，使一条指令要等到下一个规划周期才能执行。

### 四之三、真机运行阶段抓到的缺陷（都已修复并有回归用例）

真机跑起来之后暴露的问题，全部是**离线测试看不见、只有连上真实客户端才会出现**的那一类：

| 缺陷 | 后果 | 修复 |
| --- | --- | --- |
| `ClientModBody.snapshot()` 从不暴露 `blocks` | **整个 A\* 层在真机上从未生效**，每次都静默退化成客户端直线行走 | 暴露该字段 + 协议测试加回归检查 |
| **监听器拿「整行」去匹配 `!` 前缀** | 真实服务器把玩家消息渲染成 `<AgentSteve> !chop 8`，于是 `!` 指令与 `@猫娘` 自然语言**在真机上从未生效**（离线测试喂的是裸 `!chop 8`，所以全绿） | `messageContent()` 先剥掉颜色码、时间戳、`<名字>`/`[称号]`/`名字:` 等前缀再匹配 |
| **回声过滤也拿整行做指纹** | 自己说的话带前缀回来时匹配不上 → 守卫在真机上等于失效（若回复以 `@猫娘` 开头就会自问自答） | 指纹改为对「内容」计算 |
| **按内容指纹去重** | 同一条指令发第二次**永远失效**（第一份还在 50 行窗口里，指纹相同就被当成重放） | 改成比较前后两次批次求重叠，只处理新增行；同一条指令连发两次都能执行 |
| 缓冲被 `/chatlog/clear` 清空后 | 与清空前相同的行会被当成重放丢掉 | 识别「批次变小 = 被清空」，整批视为新行 |
| `interrupt()` → 导航器 → 行走器 → `interrupt()` **互相递归** | 任何一次急停/死亡/卡死都会 `RangeError: Maximum call stack size exceeded` 崩掉 Agent | 行走器改调终端的 `stopContinuous()` |
| `maybeRetry` 会重试**被取消**的任务 | 点了停止，1.5 秒后同一个任务又自己跑起来 | 取消原因不重试 |
| 回复防抖会吞掉**玩家在等的回答** | LLM 回复/任务完成回报紧跟在 ack 后面，被静默丢弃 | 防抖只作用于 ack（`ack: true`） |
| `bot.authme` 是**死配置**（没人读） | Agent 未登录就开始干活，所有动作被服务器静默忽略 | 新增 `src/core/authme.js`：先探测再登录、遇限流就等、**永不注册** |
| 规则表不检查身体能力 | clientmod 上反复重试 craft/hunt/store（必然失败），后面的目标永远轮不到 | 新增 `supportsCrafting` / `supportsDeposit` / `supportsHunting` 能力位并按位跳过 |
| `HarvestTask` 视野内没目标就放弃 | 站在沙滩上报告「没有泥土」，旁边就是土坡 | 加巡逻：朝新方向走几段再找，且一次失败不放弃 |
| `MockBody` 的掉落物**悬空不动** | 砍 5 格高的树干，上面 2 个掉落物永远捡不到，测试因此假失败 | 掉落物落到下方第一个实心方块上 |
| `looksLikeTree` 用 `blockAt`（偏移语义）读方块 | 永远返回 null → 所有树被判定「根部在扫描外」 | 统一走 `blockAtAbsolute`（`src/world/safety.js: blockReader`） |
| `looksLikeTree` 不认「已被挖掉一截的树」 | 自己刚开的树，剩下的树干反而砍不了 | 允许根部为空气/树叶（正在采集/树干外露） |
| Mod **不上报「界面开着」** | Minecraft 在任何界面打开时忽略移动输入 → 人类玩家只要开着背包，机器人就一步不动，而所有状态检查都显示健康、无从诊断 | `/state` 新增 `screenOpen` / `screen` / `mouseGrabbed` / `windowFocused`；`npm run doctor` 据此直接给结论 |
| Mod 绑定端口失败却打印 `agent-client ready` | **撒谎的日志**：明明没有控制 API 却说 ready 并打印 URL，排查时被误导 | 绑定失败改印明确的 `agent-client is NOT usable ...` 并给出原因 |
| `live-probe` 的通道 A 断言太弱 | 只要「曾经有过回复」就算通过，于是在通道 A 完全失效时**假通过 16/16** | 断言改为「必须出现新的指令记录 + 新的回复」 |


### 四之四、本轮三项行为修正（砍树识别 / 跳跃换方向 / 挖矿选镐）

操作员提出的三条，逐条落地。每条都有离线回归用例（`npm run tasks:test` / `npm run path:test`）。

**① 砍树：必须有树冠（树干 + 树叶才算树）**

`looksLikeTree()` 原本只有「结构」判据（根部是自然地面、至少两格高、周围没有人造方块）。
一根立在草地上的原木柱四条全过 —— 也就是说它会去吃别人的柱子。新增第 5 条判据
`findCanopy()`（`src/world/safety.js`）：先爬到树干顶端，再在半径 2、上方 4 格的盒子里找树冠。

- 树冠 = `*_leaves` / `*_wart_block` / `*_foliage` —— 下界菌没有树叶，靠 `nether_wart_block` 通过，否则整个下界都砍不了。
- 拒绝理由分两种：「树干上没有树叶，看起来是搭的不是长的」与「树干顶周围在扫描范围外，无法确认」——
  「不是树」和「看不见」要给出不同答案。
- 开关：`config/agent.json` → `safety.requireLeaves`（默认 `true`）。关掉就退回旧行为（只对自建服务器建议这么做）。
- 谁被拒、为什么被拒，都记在 `task.refusedTargets` 里，面板/日志可见。

**② 寻路：连续跳跃多次后必须换方向，不能一直跳**

真实原因在客户端：`ClientActions.WalkTo` 是「按住前进 + 一撞墙就按跳」。面对 2 格高的墙、栅栏、
或者头顶有方块挡住的台阶，它就会**原地跳满 60 秒**。而 A\* 的方块图来自快照，快照说这条路能走，
于是重规划每次都得**同一条路、同一个跳**——重规划根本不是策略。

四处改动，从下到上：

| 层 | 改动 |
| --- | --- |
| 移动模型 `movementsAdapter` | 每条边打标 `move`（`walk`/`step-up`/`drop`/`jump`/`swim`/`climb`），并支持「本趟行程内禁止的格子」`avoid` |
| 规划器 `planner` | `normalisePath()` 保留 `move` 标签（这是「这是跳还是走」唯一的证据） |
| 行走器 `walker` | 连续 `jumpStreakLimit`(默认 2) 次跳跃/上台阶失败 → 返回 **`jump-blocked`**（而不是继续跳）；跳跃成功则清零 |
| 导航器 `navigator` | ① 把「走不到的格子」在本趟行程内从图里删掉 → 重规划才真的是**另一条路**；② 再叠加一次**横向**试探（垂直于目标方向，最多 `maxSidesteps`=2 次）；③ 两条都不行就诚实失败 |
| 控制 Mod `WalkTo` | 连续 4 次起跳都没靠近、且 1.2 秒无进展 → 立刻结束并上报 `jump-blocked`（不再空跳 60 秒） |

还有一处**根因**：运动模型原来只问「下面那格是不是实心」，于是把**栅栏、圆石墙、玻璃板、
铁栏杆、关着的门**都当成了可以踩上去的台阶（它们实心，而上方那格是空气）。
`describeBlock()` 现在多一个 `standable` 字段，`hasFloorAt()` 要求 `solid && standable` ——
半砖和楼梯仍然可以站，栅栏一律不行。代价只是绕路，收益是**再也不会规划出一条只能靠跳的移动**。

顺带修掉两个测试中暴露的旧缺陷：

- 行走器对**失败的短跳**会误报 `arrived`：1 格间隙的跳跃腿失败后，机器人离目标正好 2 格，
  落在「宽松到达容差（+1）」里。现在宽松容差只对**成功**的最后一段生效。
- `mergeWaypoints()` 会把同方向的跳跃**并进直走腿**里 —— 客户端于是试图「走过」那个坑，
  而标签也丢了。现在跳跃/上台阶永远是独立的一段。

**③ 挖矿：先按采集等级选镐，再按硬度匹配操作员给的对照表**

`src/world/items.js` 新增一张**唯一的、可编辑的**硬度表 `BLOCK_TIER_REQUIREMENT`：

| 最低工具 | 方块 |
| --- | --- |
| 钻石镐 | 下界合金残骸、黑曜石 |
| 铁镐 | **钻石矿（表层与深层）**、红石、青金石、金矿、绿宝石（含深层）、下界金矿 |
| 石镐 | 铁矿、铜矿（含深层） |
| 木镐 | 石头、圆石、深板岩、煤矿、下界石英 |
| 空手 | 其余一切（泥土、沙子、砂砾、木头、模组方块…） |

选镐顺序：**采集等级最高者优先，同级再按速度**（金 > 下界合金 > 钻石 > 铁 > 石 > 木）。
`MineBlockTask.run()` 在**走路之前**就判定「这把镐根本挖不动」，直接给出
`pickaxe too weak for diamond_ore (have stone stone_pickaxe, need iron)`；
一条任务里混着「挖得动的石头」和「挖不动的钻石矿」时，挖得动的照挖，挖不动的记进 `skippedForTool`。

⚠️ **两点需要知道：**

1. **两种钻石矿都按铁镐（原版行为）。** 操作员分两次放宽：10-01 表层（23:09 那次手改），
   10-02 深层（13:00 手改）。测试把这条规则逐行**钉住**（`selftest` 与 `tasks:test` 各自断言），
   改 `BLOCK_TIER_REQUIREMENT` 里的行必须同步改这两处测试的期望值，否则套件会立刻报警。
2. **金镐是「木级」工具**。旧的 `TOOL_TIERS.indexOf('golden')` 让金镐看起来能挖钻石矿（在进阶顺序里金在铁之上），
   但金镐的真实采集等级是 **0（等同木）**：它挖铁/金/红石/钻石**一个都不掉**，只是在挖得动的方块上快得多。
   现在统一走 `harvestLevel(tier)`（`wooden:0, golden:0, stone:1, iron:2, diamond:3, netherite:3`）。

---

## 四之二、验证矩阵（当前实测结果）

| 套件 | 命令 | 结果 | 需要什么 |
| --- | --- | --- | --- |
| 寻路 | `npm run path:test` | **22/22** | 无 |
| 三原语 | `npm run tasks:test` | **37/37** | 无 |
| 意图层 + 工具层 | `npm run llm:dry` | **路由 30/30、Schema 16/16、sanitize 5/5、工具 22/22** | 无 |
| 双通道/面板/死亡 | `npm run control:test` | **24/24** | 无 |
| 控制 Mod 协议 | `npm run client:test` | **26/26** | 无（假 Mod 服务器） |
| 全量自检 | `npm run selftest` | **153/153** | 无 |
| 计划符合性（§11 逐条 + 配置消费） | `npm run plan:audit` | **28/28（41 个配置键全部被读取）** | 无 |
| P0 汇总 | `npm run p0:verify` | **6/6 套件通过（约 20 秒）** | 无 |
| 真机接入 | `npm run client:verify` | **23/23** | Forge 客户端 |
| 真机登录 + 寻路 + 三原语 | `node scripts/client-real.js --login <pw> --primitives --dig dirt:4` | **11/11** | Forge 客户端 |
| 真机面板 + 双通道 + 急停 | `node scripts/live-probe.js` | **15/15**（通道 A 断言已收紧为「必须看到新指令 + 新回复」） | Forge 客户端 + Agent 运行中 |
| 一键全链路自检 | `npm run doctor` | 五环逐项判定 + 真走两格验证输入 | Forge 客户端 |
| 真机自然语言（真实模型） | 聊天框 `@猫娘 你好呀，你现在能看到什么？` | 回复 `你好喵！我在18,64,59，满血饱食，背包空空喵`（873 tokens，内容与真实状态一致） | deepseek-flash + API key |
| 挂机 10 分钟零主动发言 | `P0_SOAK_MS=600000 npm run control:test` | **0 replies over 600s idle** | 无 |

> 计划 §1 的 D③ 要求「挂机 10 分钟，除被叫到外零输出」。这不是靠「大概不会说话」推断的：
> 那条检查真的空转了 **600 秒**（`P0_SOAK_MS` 可调，默认 1.2 秒以保持套件快速），
> 期间 Agent 的自主循环照常运行，聊天输出计数为 **0**。

**无客户端时的行为也已验证**：`node src/index.js --body clientmod --connect-wait-ms 3000` 会在 3.9 秒内
打印「怎么修」的三行提示并干净退出（退出码 0），不会挂住、不会抛栈。
面板在 attach 之前就已启动，所以端口冲突能被立刻发现并自动退到 `port+1`。

---

## 五、安全边界（不可回归）

| 约束 | 实现位置 |
| --- | --- |
| **绝不在 `mc.example.com` 发 `/register`**（会重置角色，经验与物品消失） | `ControlHttpServer.forbiddenCommand()`、`ClientActions.forbiddenVerb()`、`ClientModBody.isForbidden()`、`AuthMeLogin`（结论为「未注册」时**拒绝**而不是注册）、`client-real.js` 无 `--register`（传了直接 exit 2） |
| 运动模型不挖穿障碍 | `pathfinding.allowDig: false` |
| 不进入岩浆 / 火焰 / 仙人掌 / 未知格 | `movementsAdapter.js`（有专门测试） |
| 不挖未知 Mod 方块 | `MineBlockTask.canHarvest()` → `mods.isMineable()`（有专门测试） |
| 模型不能执行服务器指令 | 意图枚举 + `intent.js` 校验 |
| 无提示词注入出口 | 没有 `say` 工具；`say` 只能是对玩家的回复 |
| 任务只能由玩家发起 | 没有「玩家请求」上下文的 LLM 回合不允许产生动作；每个请求最多 2 轮 |
| 每个任务只能从一个实现执行 | LLM 与 `!` 共用同一张命令表 |

### 5.1 空手/主世界安全：远离人造方块（**可一键关闭**）

`src/world/safety.js` 是唯一的一份「什么算人造」的判断，三个消费者共用：寻路（路线不穿过建筑）、
采集（砍树只砍真的树，不砍原木墙）、以及真机脚本（拒绝人造目的地）。

```jsonc
// config/agent.json
"safety": { "avoidManMade": true }   // ← 改成 false 即完全关闭
```

> **这是测试环境的要求，不是生产环境的硬要求。** 默认开启是因为它足够便宜（纯本地判断，无额外请求），
> 并且在公共服务器上能避免「走过去」变成「踩过别人的农田」。如果发现它挡住了正常作业
> （例如把玩家种在基地旁的树判成建筑），把上面那一行改成 `false` 即可，其它逻辑不受影响。

实测：在真实服务器上它正确拒绝了别人的**小麦农场**（`space=minecraft:farmland / floor=minecraft:dirt`），
以及用原木搭的墙（`refused 6 built log(s), nothing broken`）。


---

## 六、真机验收（已完成）

在真实服务器 `mc.example.com:25565`（Forge 1.20.1 + 150 个 Mod 的整合包）上跑通，
客户端为真实 Forge 客户端 + 控制 Mod，**没有改任何 Java 代码**。

### 6.1 接入与登录

| 检查 | 结果 |
| --- | --- |
| 控制 Mod 在线 | `{"ok":true,"mod":"agent-client","inWorld":true}` |
| 进入世界 | `minecraft:overworld`，方块扫描 **40817 格** |
| 可见的模组命名空间 | `create, born_in_chaos_v1, culturaldelights, amendments, biomeswevegone, touhou_little_maid` |
| **`/login <your-password>`** | ✅ `§aВход успешен!` / `§aДобро пожаловать!` |
| 活体客户端协议自检 | `npm run client:verify` → **23/23** |

### 6.2 三原语（`node scripts/client-real.js --login <pw> --walk 5 --primitives --dig dirt:4`）

```
PASS  LOGGED IN to the server - server confirmed              (§aВход успешен! / §aДобро пожаловать!)
PASS  primitive 1 walk: GoToTask walked to the target - arrived at 90,67,33 (moved 3.79 blocks in 1499ms)
PASS  dig dirt: blocks broke and the drop entered the inventory - collected 4/4 dirt/grass_block (inventory +4)
[note] target tree: minecraft:oak_log at (88,67,29), 3.53 blocks away
PASS  primitive 2+3 chop: the log really entered the inventory - collected 1/1 logs (inventory +1 log(s))
PASS  mine: refuses cleanly without a pickaxe - need a pickaxe to mine stone/cobblestone
real-server test: 11/11 checks passed
```

三项原语一次跑通：**走过去 → 破坏 → 掉落物真的进背包**（泥土 +4、原木 +1）。
石头需要镐；没有镐时**明确报「需要一把镐」**，而不是空手把方块挖掉却一无所得。

`--dig dirt:4` 是**追加**检查，不是替换：一次调用同时覆盖「能不能砍树」和「能不能挖普通地面」。

**寻路证据**：`iterations: 2` 是「走一段 → 重新规划 → 再走」在真机上的表现——
目标在 24 格扫描半径之外时，导航器先朝目标走一段再重新规划。


### 6.3 自主运行（真机，`npm run agent:client`）

机器人自己决定干什么。规则表现在会先问**「这个身体能不能做这件事」**，再做：

| 能力 | clientmod | 说明 |
| --- | --- | --- |
| chop / mine / collect / go_to | ✅ | P0 的三原语 |
| craft | ❌ | 控制 Mod 没有合成界面 → 规划器**跳过**该目标，而不是每 2.5 秒重试一次 |
| store（容器） | ❌ | Mod 无容器 API → 同样跳过 |
| hunt | ❌ | Mod 看不到被动生物 → 跳过（旧 HuntTask 曾因此抛异常刷屏） |

这套「先问能力」的做法是**计划 §5.4 的规则表版本**：LLM 那边靠能力清单（`list_capabilities()`）避免
承诺做不到的事，规划器这边靠 `supportsCrafting` / `supportsDeposit` / `supportsHunting` 避免
把每个规划周期都浪费在必然失败的目标上——修之前，clientmod 上的规则表会不断重试 craft，
排在它后面的目标**永远轮不到**。

```jsonc
// config/agent.json
"survival": {
  "allowWoodChopping": false,   // 规划器不再自己找树砍；显式 !chop 仍然有效
  "allowDirtDigging": true      // 挖泥土：不需要工具，永远是可行的「有事可做」目标
}
```

没有工具、没有木头时，规划器的兜底目标是**挖泥土**——这正是「不需要任何工具就能做的采集」。
`HarvestTask` 在视野内找不到目标时会**朝新方向走几段再找**（扫描半径只有 24 格，
「这里没有」几乎从来不等于「哪里都没有」）。


```
INFO  (agent) body: clientmod
INFO  (body)  agent-client mod found (vdev) at http://127.0.0.1:8899
INFO  (body)  attached: minecraft:overworld at (-17,67,53) hp=20 food=20
INFO  (chat)  chat listener online (prefix "!", every 700ms)
INFO  (agent) authentication: no evidence of being logged out (no prompt or refusal seen)
INFO  (brain) brain online
INFO  (agent) in-game chat: "!<command>" for actions, "@猫娘" to talk
INFO  (agent) control panel: http://127.0.0.1:8766/panel
```

面板实测（`node scripts/live-probe.js`，16/16 通过）：

```
PASS  GET /panel serves the page - 10646 bytes
PASS  body is attached through the control mod - {"name":"AgentSteve","bodyKind":"clientmod","bodyReady":true}
PASS  block scan is NOT shipped to the panel - 1249 bytes
PASS  death was detected by the agent - {"dead":true,"deaths":1,"lastDeath":{...}}
PASS  all tasks were aborted (brain stopped) - stopped=true reason=death
PASS  the panel ships a death banner for this state
PASS  emergency stop answered under 3s - 4ms
PASS  every stage reported success - {"brain":{...},"navigator":{...},"client":{...}}
PASS  the agent can still be commanded after a stop
```

**真实聊天记录里的回声**（通道 C 的输出真的到达了服务器）：

```
<AgentSteve> 暂停了喵
```

### 6.4 AuthMe 自动登录（`src/core/authme.js`）

`bot.authme` 这一段配置**原本是一段死配置**——存在、但没有任何代码读它，所以接上真机后 Agent 是
「未登录」状态：能连上、能感知，然后所有动作被服务器静默忽略。现在它是真的被消费了：

- 开局先判断是否需要登录：**只有看到证据**（AuthMe 提示，或命令被「未登录」拒绝）才发 `/login`，
  否则保持沉默——盲目重发会触发服务器的频率限制（`Слишком много попыток входа`），
  而限流看起来和密码错误一模一样。
- 证据是通过 `cmd list` 探测得到的：登录状态下它正常返回，未登录时服务器会回
  `Команды недоступны до входа`。**匹配前会先剥掉 `§` 颜色码**，否则
  `Сначала §e/login` 里的 `/login` 前面隔着颜色码，正则匹配不到（这个 bug 是离线用例抓出来的）。
- 死亡重生后会再判断一次（多数 AuthMe 服务器会掉会话）。
- 结论是「账号未注册」时**拒绝注册**并明确报告；`registerOnMissing` 永远是 false。


### 6.5 真机未执行的项（原因 + 替代验证）

| 项 | 为什么 | 替代验证 |
| --- | --- | --- |
| 「背包满」提前失败 | 需要先在真机把 36 格装满（属于破坏性操作） | `tasks:test` 用 36 种物品构造满背包，验证**提前失败且不挖任何方块** |
| 「够不着的掉落物」跳过 | 需要人为制造悬崖掉落 | `tasks:test` 把掉落物放在 y-5，验证**不追、不跳崖** |
| 大模型真实回合 | 需要 `LLM_API_KEY`（当前无 key） | `llm:dry` 用假 transport 跑完整链路；无 key 时正则兜底已验证 |

#### 6.5.1 §四之四 三项修正的真机验证（**已人工复测：未通过**）

**2026-10-02：用户在新 jar（41627 字节，已安装）上人工复测，结论为未通过。**
具体现象当时未记录进会话，后续计划不在此处补测，而是**直接参考 mc_aiplayer / mindcraft 重写**
（本轮不重写）。下面这张表保留为复现矩阵，重写前如需对照可逐条复跑：

| 项 | 真机上怎么确认 | 预期 |
| --- | --- | --- |
| 树冠判据 | 站在一棵真树前发 `!chop 4`；再站在一根玩家搭的原木柱前发一次 | 真树照砍；原木柱被拒，日志出现 `the trunk has no leaves` |
| 挖矿选镐 | 背包同时放 木镐+石镐+铁镐，`!mine stone 3`；再用木镐试 `!mine iron_ore 1` | 石头用**铁镐**（最高等级）；铁矿给出 `pickaxe too weak ... need stone`，且**不发生走动** |
| 连续跳跃换方向 | 找一段栅栏/2 格墙，`!goto` 到墙后；或直接看日志里有没有 `jumpsBlocked` | 不再原地跳满 60 秒：Mod 上报 `jump-blocked`，Agent 记录 `route is jump-blocked - trying a different direction`，随后要么绕过去要么明确失败 |
| 栅栏不可踩 | `/state` 观察是否还会把栅栏顶当成台阶 | 规划里不再出现落在栅栏上方的节点（离线用例 11 已锁；真机只需确认没有新的 `jump-blocked` 刷屏） |

> 客户端上一次真机验收（§六 6.1–6.3）跑的是**改动前**的 jar。本次重编译的 jar 已安装
> （`agent-client-1.0.0.jar`，41627 字节），**需要重启客户端才会生效**。

### 6.6 运维要点

#### 6.6.1 一键启动（推荐）

右键 `start.ps1` → **使用 PowerShell 运行**（或在 PowerShell 里 `.\start.ps1`，
等价于 `npm run play`）。两条指令就存在这个文件里，看得见、改得动：

```powershell
# 指令 1：启动客户端并进入服务器
& node scripts\launch-forge-client.js --server mc.example.com:25565

# 指令 2：启动 Agent（等到 inWorld 之后）
& node src\index.js --body clientmod --profile simpfun
```

两条命令之间那点"胶水"是必要的，不是装饰：

1. 先查 8899 端口 —— 已经有客户端在跑就**跳过启动**（同时开两个客户端会互抢端口，
   后启动的那个会完全失去 API 却看起来一切正常）；
2. 等控制 Mod 上线，再等 `/health` 报 `inWorld: true` —— **不是**端口一通就跑指令 2。
   Mod 在**进入世界之前**就已经在应答了，这时起 Agent 会看到"扫描还没加载"，
   然后是一连串看起来像 bug 的失败；
3. 打印角色位置/血量/饱食，并检测「开着界面」「鼠标没被捕获」这两种会让移动输入被静默忽略的状态；
4. 检查 `runtime/agent.lock` —— 已经有一个 Agent 在跑就不重复启动（同名账号会被服务器互踢下线）。

失败时它去读客户端自己的日志，给出原因和处理办法，而不是只报一个超时：

| 日志里出现 | 它给出的结论 |
| --- | --- |
| `port 8899 is already owned by another Minecraft instance` | 已经有一个客户端在跑，关掉它或加 `-NoClient` |
| `UnsupportedClassVersionError` | Java 版本不对（1.20.1 Forge 要 Java 17–21），设 `MC_JAVA=` |
| `A fatal error has been detected` | Java 崩溃（多半内存），给启动脚本加 `--memory 6144` |
| `Could not find or load main class` | 整合包没装全，让 PCL2 补一次 libraries |
| `multiplayer.disconnect` / `Failed to connect` | 客户端是好的，只是没连上服务器 |

```powershell
.\start.ps1                        # 客户端 + Agent（客户端已在跑则自动跳过）
.\start.ps1 -NoClient              # 客户端已经开着了，只起 Agent
.\start.ps1 -NoAgent               # 只把客户端送进世界，自己再手动起 Agent
.\start.ps1 -Server host:port      # 换服务器
.\start.ps1 -Profile local         # 换 config/servers.json 里的档位
.\start.ps1 -Goal "gather 32 wood" -Day
.\start.ps1 -Wait 420              # 多等一会儿（默认等 300 秒）
.\start.ps1 -AgentArg --force      # 额外参数原样传给 Agent
.\start.ps1 -Help

.\stop.ps1                         # 停 Agent（先走面板急停，再兜底 kill）
.\stop.ps1 -Client                 # 连游戏客户端一起关
```

若提示「在此系统上禁止运行脚本」，用这一行绕过（不必改全局执行策略）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

> **写 .ps1 的两个坑**（都由 `npm run selftest` 兜住，改动后会自动报警）：
> 1. **必须有 UTF-8 BOM**。Windows PowerShell 5.1 对没有 BOM 的 `.ps1` 按 ANSI 解析，
>    文件里所有中文会变成乱码 —— 而且 `chcp`/`$OutputEncoding` 都救不了，因为问题出在**读文件**这一步。
> 2. **必须用 CRLF**。
>
> 另：`start-agent.bat` 是**旧路线**（`npm start` = 本地专用服务器 + mineflayer），
> 与现在的「真 Forge 客户端 + 控制 Mod」不是一回事，用不到可以删。

#### 6.6.2 手动分步（排查时用）

```powershell
# 1. 启动 Forge 客户端（图形界面，会自动进入服务器）
npm run client:launch -- --server mc.example.com:25565

# 2. 在游戏里输入 /login <your-password>   ← 认证只有这一种方式（Agent 自己也会尝试，见 §6.4）
#    （服务器有 AuthMe 频率限制：重复尝试会返回「Слишком много попыток входа」，
#      这时等 60 秒，或用 --no-login 跳过脚本里的登录步骤）

# 3. 真机验收
node scripts/client-real.js --no-login --walk 6 --primitives

# 4. 正式运行 Agent（面板 http://127.0.0.1:8766/panel）
npm run agent:client
```

**面板地址**：`http://127.0.0.1:8766/panel`

在游戏聊天框里输入 `!chop 8` 或 `@猫娘 砍点树`，面板的「最近识别到的输入 → 路由结果」会显示它到底被理解成了什么。
### 6.7 一个真实故障：机器人被流浪者射杀

第一次真机自主运行时，Agent 刚砍了 2 根木头就被**流浪者（Stray）射杀**（聊天记录：
`AgentSteve被流浪者射杀` / `AgentSteve被僵尸杀死了`）。这不是代码缺陷，但值得记录，因为它验证了 §4.4：

```
WARN  (brain) brain STOPPED after death - no tasks will run until an explicit resume
ERROR (death) BOT 已死亡 @ -18,64,37 — 所有任务已中止 (deaths this run: 1)
ERROR (death)   面板: http://127.0.0.1:8766/panel  （顶部红色横幅 + 恢复按钮）
ERROR (death)   注意: 若游戏窗口停在死亡画面，需要手动点「重生」（P0 没有自动重生能力）
```

**运维提醒**：P0 不含战斗深度（没有武器/护甲，`equipArmor()` 在客户端模式下返回 false），
在怪物出没的地方长时间挂机会死。死亡的代价是**掉落全部背包**（原版行为）。
建议：给它一把剑和护甲，或在白天/已照明的区域作业。



---

## 七、未纳入 P0（明确不做）

合成 / 建造 / 容器存取 / 熔炼 / 交易 / 附魔 / 下界 / 末地 / 多 Bot / **钓鱼（已取消）** / 打猎 / 照明 /
网络搜索 / 长时间聊天服务 / 自主发言。

对应地，能力自省表（`src/llm/blackboard.js: capabilities()`）会把这些如实标成 `available: false`，
所以模型收到「帮我做个石镐」时会回答做不到合成，而不是承诺后失败。

**P1 遗留（非 P0 阻塞项）**：Mod 侧 `attack` 参数个数、`place` 的 `nth` 偏移；
`gen-srg-names.js` 的 TSRG 解析（文件内已标注 NOT WORKING YET）；`GET /chatlog?since=<seq>`
（彻底解决「50 行窗口内完全相同的两条消息只触发一次」）。
