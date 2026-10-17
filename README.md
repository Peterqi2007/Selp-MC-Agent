# Minecraft Survival Agent（真实 Forge 客户端 + 控制 Mod + Node 大脑）

一个让**真实《我的世界》1.20.1 Forge 客户端**自己玩生存的 Agent：砍树、合成、熔炼、挖矿、种田、
钓鱼、战斗、睡觉、存取箱子，全部发生在普通游戏会话里（不发假包、不改服务端）。在游戏里用
`!` 指令或 `@大肥鱼 <自然语言>` 指挥它决策与动手。

**架构一句话：Mod 是薄手，Node 是大脑。**

```
玩家 / LLM  →  src/skills/*（确定性技能层，全部可离线测试）
                 ↓ 只调用 Body 契约
              src/body/clientModBody.js（协议 + 轮询）
                 ↓ HTTP 127.0.0.1:8899
              mod-client（Forge 客户端侧薄手：移动/挖/放/右键/菜单/攻击/手持）
                 ↓ 真实游戏会话
              Minecraft 服务器（含 mc.example.com 这类需要客户端 Mod 的 Forge 服）
```

* **Mod**（`mod-client/`，Forge 1.20.1）：只提供"人的手能做到的最小原子动作"，通过
  `127.0.0.1:8899` 暴露 `GET /state|/chatlog|/progress|/health` 与 `POST /command`；
  决策、配方、库存编排一律不在 Java 里。
* **Node**（本仓库）：技能库、任务槽、失败阶梯、权限与征询、LLM 工具层、记忆、控制面板
  （`http://127.0.0.1:8766/panel`）。
* **PCL2**：负责版本 / 账号 / Mod 管理；启动脚本直接读 PCL 留下的版本 JSON 无头拉起客户端，
  也支持 `--server` 直连服务器、`--singleplayer` 直进存档。

> **与 mineflayer 的关系（历史说明）**：mineflayer 走原版协议，进不了要求 FML2 客户端握手的
> Forge/NeoForge"客户端必需 Mod"服。主线躯体因此改为"真实客户端 + 控制 Mod"。
> `body.kind=mineflayer` 仍然保留，适合原版 / Paper / Spigot / 纯服务端 Fabric 服与本地快速测试，
> 但已不是主线；mineflayer 时代的坑位（pathfinder 闭包 latch、树冠 A*、并发抢 pathfinder 等）
> 保留在 git 历史与 [`docs/EXTERNAL-SERVERS.md`](docs/EXTERNAL-SERVERS.md)。

参考过的开源项目：

| 项目 | 借鉴点 |
| --- | --- |
| [Dwinovo/minecraft-numen](https://github.com/Dwinovo/minecraft-numen) | 「先看 → 规划 → 执行」分层；挖矿报价（DigQuote）与编辑台账；恢复阶梯；"计划即承诺、执行交实际账" |
| [zoyluoblue/mc_aiplayer](https://github.com/zoyluoblue/mc_aiplayer) | LLM 选意图 → 确定性技能执行；工具即能力边界；能力自省 |
| [mindcraft-bots/mindcraft](https://github.com/mindcraft-bots/mindcraft) | 技能目录覆盖范围（采集/合成/种田/战斗/钓鱼）；技能文档先给模型看再执行 |
| [PrismarineJS/mineflayer](https://github.com/prismarinejs/mineflayer) | 早期躯体与 pathfinder 生态（现已退居备选） |
| [HarjjotSinghh/minecraft-mcp](https://github.com/HarjjotSinghh/minecraft-mcp) | 用外部 HTTP 控制口驱动游戏内 Agent 的思路 |

---

## 0. 文档导航

| 文档 | 内容 |
| --- | --- |
| 本文件 | 现状、架构、快速开始、指令、进展、脚本、限制 |
| 本文件 §3 | **想知道「现在到哪一步了」先读它**：批次表 + 当前状态 + 最新真机记录 |
| [`docs/P1-PLANNER-PLAN.md`](docs/P1-PLANNER-PLAN.md) | **下一阶段方案**：规划器重构（语言/动作脑区解耦、分级自主感知、自主解题、自主学习、聊天扩展）；§1.9 单列 coding harness 与自研动作脑的比较与接入边界。要求在**独立分支**实施；2026-10-17 裁决见 §1.1.1 |
| [`docs/P1-M0.md`](docs/P1-M0.md) | **P1 M0 记录**：基线（提交/指纹/套件）、问题复核、P0→P1 审计迁移清单、评测集 v1、测量模板与版本登记。离线项已完成，**客户端三项未执行** |
| [`docs/P1-M1.md`](docs/P1-M1.md) | **P1 M1 记录（离线第一批）**：`TaskEvents` 汇聚/重放、身份字段、`PlanStore` 单一写者、同端口 SSE、`p1:contract:test` 10/10。Capability/Progress/Result/父子步骤未完成 |
| [`docs/PLANNER-RETIREMENT.md`](docs/PLANNER-RETIREMENT.md) | **自主规划器退役**：`slowLoop` 拆为 GoalEvaluator + 提案 + TaskSlot。**S0–S4 已全部离线交付**（`planner:test` 31/31、`plan:audit --stage p1` 36/36），真机判据仍登记在客户端清单 |
| [`docs/P1-CLIENT-TESTS.md`](docs/P1-CLIENT-TESTS.md) | **客户端/真机测试清单**：P1 与退役判据里所有需要真实客户端/服务器的项，**当前全部未执行**（本分支只跑离线套件） |
| [`docs/PLANNER-AB-EXPERIMENT.md`](docs/PLANNER-AB-EXPERIMENT.md) | **选型 A/B 实验设计**（**条件触发**：仅当 P1 §1.9.2 降级判定成立才执行）：24 次计分运行的场景与门槛；成本审计按时间 / token / 模块复用三项（§6–§7），§10 是决策闸门，**不做经济性评估**（§8.4） |
| [`docs/HARNESS-INTERFACES.md`](docs/HARNESS-INTERFACES.md) | **两侧接口事实**：Codex（`base_instructions` 可整段替换 / `tool_mode` / hooks / MCP）与 DSH（0.2.0-rc.2、cordis 插件契约、system-prompt 装配、preset）的一手机器取证，含待验证项 |
| [`docs/PLANNER-REFACTOR.md`](docs/PLANNER-REFACTOR.md) | **规划器（自主决策）专项**：已核实问题 P1–P10、重构债 Q1–Q7，以及与 `!` 命令 / LLM `do_task`/`do_skill` 回路的边界 |
| [`docs/MINING-LLM-PLAN.md`](docs/MINING-LLM-PLAN.md) | 挖矿方案与**一手真机记录**（附二 10-10 夜 / 附三 10-12 / 附四 10-13 / 附五 10-14）——采矿相关的最新依据 |
| [`docs/MINING-COLLECTION-PLAN.md`](docs/MINING-COLLECTION-PLAN.md) | 掉落物收集方案与实机记录（§十一，10-10～10-12） |
| [`docs/COMBAT-PLAN.md`](docs/COMBAT-PLAN.md) | 战斗 v3 方案、离线计数与**真机验收清单**（10-13 夜部分已覆盖） |
| [`docs/REWRITE-PLAN.md`](docs/REWRITE-PLAN.md) | 重写计划与逐批次进展（含每次真机 / 离线验证记录）——**记录到 2026-10-08**，其后进展看上面三份 |
| [`docs/P0-PLAN.md`](docs/P0-PLAN.md) / [`docs/P0-STATUS.md`](docs/P0-STATUS.md) | **P0 已收官（2026-10-16）→ 两份都转为历史文档**：P0 计划书与验收档案，只作验收证据与踩坑记录保留。其中**仍活着**的只有 P0-PLAN §11 的「做/不做」边界——作为防回归契约由 `npm run plan:audit` 持续看门 |
| [`docs/CAPABILITY-AUDIT.md`](docs/CAPABILITY-AUDIT.md) | **历史文档**：重写前的静态能力核实（「Bot 不能自主工作」等结论均已作废，见文首对照表） |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 模块分层、Body 契约、安全模型与设计不变量（2026-10-07 版；§九 列与技术债，数字按版本日期读） |
| [`docs/EXTERNAL-SERVERS.md`](docs/EXTERNAL-SERVERS.md) | 联机玩法：外部服务器配置、Forge 限制、历史方案对比 |
| [`mod-client/BUILDING.md`](mod-client/BUILDING.md) | 控制 Mod 的构建与安装 |
| [`mod-bridge/README.md`](mod-bridge/README.md) | 可选的 Fabric 服务端桥（服务器权威状态） |

---

## 1. 快速开始

环境：Windows、Node.js ≥ 18、Java 17–21（1.20.1 Forge 必需；脚本会自动从 PCL 的 Java 列表里挑）。

首次准备：

```powershell
cd "<repo>"
npm install
npm run client:build     # 编译控制 Mod（离线 Gradle）
npm run client:install   # 装进 PCL 版本隔离的 mods 目录
```

日常（联机主线：客户端 + Agent 一键起）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
# 或 npm run play
```

`start.ps1` 依次完成：拉起 Forge 客户端 → 等控制 Mod 上线（8899）→ 等进入世界 → 启动 Node Agent
（含 AuthMe `login`，**永远不发 `/register`**）→ 打印面板地址。
停止：`.\stop.ps1`（只停 Agent）或 `.\stop.ps1 -Client`（连客户端一起停）。

分步（调试用）：

```powershell
npm run client:launch -- --server mc.example.com:25565   # 只拉客户端并直连服务器
npm run client:check                                      # 8899 是否在线、是否已在世界里
npm run agent:client                                      # 只起 Agent（接正在跑的客户端）
```

本地无头服务器（可选，离线 / 个人测试用）：`npm run server:setup` 准备 1.20.1 服务器，
`node scripts/run-all.js --no-agent` 只起服务器，然后把 Forge 客户端指向 `127.0.0.1:25565`。
旧的一键 `npm start`（服务器 + mineflayer 时代流程）仍保留，但当前配置默认躯体是 `clientmod`、
bot 指向外部服务器，沿用前请先检查 `config/agent.json`。

| 端口 | 用途 |
| --- | --- |
| `127.0.0.1:8899` | 控制 Mod HTTP（`/health` `/state` `/progress` `/chatlog`、`POST /command`） |
| `127.0.0.1:8766` | Node 控制面板与 API（`/panel`、`/ui/state`、`POST /command`、`POST /emergency-stop`） |
| `127.0.0.1:25565` | 可选的本地无头服务器（旧路径） |

---

## 2. 现在能做什么

技能目录（`src/skills/`，19 个，全部可用 MockBody / 协议假 Mod 离线测试）：

| 分类 | 技能 |
| --- | --- |
| 物品 | `equip` `eat` `drop` `armor` |
| 方块与交互 | `place` `use_on` `withdraw` `deposit` |
| 战斗 | `attack` `defend` `shoot`（TACZ 枪械） |
| 移动 | `explore` `come` |
| 生产 | `craft` `smelt` `farm` `sleep` |
| 采集 | `mine_ore`（统一入口 + 报价选矿 + 走挖一体 tunnel + 逐格垫柱 + 共享收集/入包证据） `fish` |

LLM 层（`src/llm/`，生产配置已开启 `toolCalling`）：8 个工具 —— 只读
`observe` `find_blocks` `lookup_item` `scan_around`，有副作用 `do_task` `do_skill` `go_to` `stop`；
**没有 `say` 工具**，说话只能是对玩家的回复，所以"执行服务器指令"在能力上就不存在。

结构层（参考 numen）：任务槽 `TaskHub`（受理即回执、后台执行、新任务可顶替）、失败阶梯
`RecoveryLadder`（每级只接住自己声明的失败类型）、名词 `area`/`route`、权限规则
`deny/allow/ask` + 动手前征询（`!yes`/`!no`）。

---

## 3. 项目进展（批次表截至 2026-10-16；套件计数实测于 2026-10-16）

> **P0 已验收收官（2026-10-16）**：离线 `npm run p0:verify` **8/8 套件通过**、P0 计划书 §11 的
> 「做/不做」清单 `npm run plan:audit` **29/29 全过**；真机自 2026-10-08 首轮起多轮通过。
> **`docs/P0-PLAN.md` 与 `docs/P0-STATUS.md` 因此转为历史文档**（只作验收证据与踩坑记录保留；
> 其中仍活着的只有 §11 那条防回归边界）。下一阶段是 **P1 规划器重构**，方案见
> [`docs/P1-PLANNER-PLAN.md`](docs/P1-PLANNER-PLAN.md)（其"P0 寻路仍待优化"一句已被下方 10-15 的寻路六修
> 追平，且该方案要求在**独立分支**上实施；配套 [`docs/PLANNER-AB-EXPERIMENT.md`](docs/PLANNER-AB-EXPERIMENT.md)
> 与 [`docs/HARNESS-INTERFACES.md`](docs/HARNESS-INTERFACES.md)，均已入库）。

| 日期 | 批次 | 内容 | 验证 |
| --- | --- | --- | --- |
| 10-02 | P0 重写 | 技能层 v1、`!`/LLM 双通道、控制面板、死亡处理 | ✅ 真机 |
| 10-02/03 | Phase 2/3 | craft / smelt / farm / sleep / fish、LLM 工具接线 | ✅ 真机（含跨河、钓鱼夜间睡觉闭环） |
| 10-04 | 第一批执行优化 | 失败语义与统一回执、停牌表、空间感知网格、能力表单源 | ✅ 真机 |
| 10-04 | 第二批结构升级 | 任务槽、恢复阶梯、area/route、权限规则与征询 | ✅ 真机（复测修掉两处） |
| 10-05 | 采矿按 numen 重构 | 报价选目标（挖×4 + 步数 + 矿脉加成）、DigLedger 台账、落沙/贴水准入 | ✅ 真机（2026-10-08，见 REWRITE-PLAN §12.6） |
| 10-05 | 走挖一体 `tunnel` | Mod 连续控制器：中心转向、边走边挖、下坡不跳、结构化失败；Node 清障重试 | ✅ 真机（2026-10-08：金矿 26+15 块、tunnel 全程 `jumps=0`；当轮修掉换镐/卡跳/爬升三处缺陷） |
| 10-05 | 防坠落补丁 | Mod tick 探底（落差 >2 或先见液体 → `ledge`）+ Node waypoint 预检 + 洞窟后检 | ✅ 真机（2026-10-08：3 格深坑前 `ledge` 停住，1–2 格台阶零误报） |
| 10-10 | 挖矿四修复 + 垫柱底座 | 矿石走 `mine_ore`（别名/深板岩/负坐标/到达判定/stalled）；Mod `Pillar` 跳放 | ✅ 真机（垫柱 2 格、钻石两连挖；当时遗留"只起 1~2 格"，已由同批 P4 逐格垫柱解决） |
| 10-10 | A 统一挖矿入口 | `miningRequest`/`miningDispatch`：六入口共用归一与分流；修 `!goal` 线上 bug；`MineOreTask` 适配器 | ✅ 离线（`mining:entry:test` 20/20） |
| 10-10 | P4 逐格清障垫柱 | `pillarUp` 执行器（只清 y+2/y+3→垫一格→核验落地）；取消信号；4.5 格 dig 距离闸；权限闸门管单格垫柱；Mod 回执 start/end/placedCells | ✅ 离线（B1–B10、`client:test` 66/66、`selftest` 173/173）；Mod 重编译（60340 字节）；**真机已通过**（10-10 夜垫柱 1–2 跳、`start/end/placedCells` 回执齐全，见下行） |
| 10-10 | C1/C2 共享收集 | `AcquisitionGoal` 挖前基线/入包证据（实体消失≠入包）；候选站位+有界接近；count 达标 drain/partial；tunnel 目标保护 | ✅ 离线（`mining:collection:test` 15/15）；**真机已通过**（10-10 夜起连续多轮 `[verified] collected=1 pending=0`；10-12 三组操作员构造夹具均 `verified`） |
| 10-10 | P1–P3 LLM 异常接管 | `miningProgress` 触发阈值；`miningRecoveryTools` 六工具；`miningRecovery` 状态机（短批次/预算/重复护栏/以入包证据结束）；外部取消 | ✅ 离线（`mining:recovery:test` 18/18）；**默认关闭**；真机 L01 已通过（0 次模型调用）；**L02 已于 10-10 夜真机尝试 3 次、全部失败**（真实模型，tokens 5354/0/7252；超时与空回执两类当夜由 `40b153c` 修复，**修后未复测**） |
| 10-12 | 收集走位三修 | 严格进入改“精确格中心”（`moveto` 支持小数坐标）；plan 回退严格化（修 0.8 假到达）；预算耗尽允许“零开挖压向掉落物” | ✅ 真机（对角密闭红石 ×2 / ×1 两轮 `verified`；`mining:collection:test` 24/24） |
| 10-13 | 贴脸僵尸不可见修复 + 反射层复活 + 战斗三修 | ① clientmod 快照只在动作里刷新——空闲时世界视图整体冻结（面板位置曾停在 58 格之外）；`ClientModBody` 后台 500ms 轮询（`statePollMs` 可配）+ 反射每 tick 兜底刷新。② `needsRescue` 对无 mineflayer 的视图每 tick 抛 TypeError（debug 级被吞）——反射链（吃/自卫/穿甲）从未执行；循环异常改限频 WARN。③ 非 mineflayer 躯体的反射改走技能层（eat/attack/armor），servo 空转不再挡路。④ 真机续测：护甲技能把穿戴槽（5-8 同为 player 槽）当“背包护甲”快速移动——每 30s 把整套甲穿/脱切换；改为只动背包格、只升级不降级、每格至多一次。⑤ 攻击技能信任 `equip()` 返回值——竞态下剑在背包却拿铲子开打；改为装备后读回持物核验、失败重试一次、仍失败则限频告警。⑥ 进食会把食物留在手上——战斗中自动进食把手从剑切成面包，15s 挥砍循环全程拿面包打僵尸（真机：连续三次满超时）；改为 eat 技能吃完恢复原持物 + 反射进食在有敌对目标时让位 | ✅ 离线（当时 `skills:test` 44/44、`control:test` 36/36、`client:test` 67/67、`selftest` 175/175、其余 6 套件全绿）；**真机已验证**（同日真机续测修掉护甲误脱、持物核验、进食抢手三处，见提交 `144a783`、`211b4cd`） |
| 10-13 | 战斗 v3：撤退/冲锋/反卡死/TACZ | 真撤退（≤8 血，S 键后撤+面敌+优先用枪）；被远程打即冲锋（掉血/ <16 血/近身触发）；≤5 格 30s 无接触→终止并忽视 180s；TACZ 枪械（狙击 32/其余 16 射程、开镜后开火、≤6 发/轮、每轮后靠近/后撤/换枪/重新瞄准+500ms、弹尽换有弹枪、三点 LOS 全遮不开火+侧翼、近距序 rifle>smg>mg>pistol、反射按默认序、PvP 仅显式）；失败码表扩容；详见 `docs/COMBAT-PLAN.md` | ✅ 离线（`skills:test` 56/56 起、`control:test` 37/37、`client:test` 73/73、Mod 编译通过）；**真机已验证开火与 PvP**（10-13 17:46 起 4 轮 16 发击杀掠夺者、PvP 2 轮 4 发击倒玩家、全遮挡诚实 `blocked` 并触发侧翼（两次均被掩体挡住）、拒绝自主打玩家；见提交 `3ba591a`）。现计数 `skills:test` 57/57（+战斗租约防反射双发、`not_a_gun` 自恢复，提交 `1998777`） |

| 10-14 | 中文矿名 + 规划器立账 | 中文矿名与深板岩变体（别名表补中文、路由改**最长别名匹配**，10 矿种 × 6 入口矩阵进 A11）；规划器停牌键改用任务名（木头路径恢复停牌 + A10 三条）；**规划器专项立账** `docs/PLANNER-REFACTOR.md` | ✅ 离线（`mining:entry:test` 20→25/25）；**真机确认**：采集到深板岩青金石（操作员口述） |
| 10-15 | A\* 寻路六修 | 真机故障"卡在 75,63,65、随机游走、困在岸上"连修六刀：跨网格目标改**子目标接力**（删除 `toward()` 盲走，水域代价 2.5→2.0）→ 子目标落脚高度改**整列搜索**（"已经到达"不再触发 ±5 回退）→ 水格可作过渡航点 + 运动模型补**踩水横渡** → 含水台阶/半砖按陆地（剥状态后缀、**优先走桥而不是游泳**）→ **脚位格修正**（站在农田/半砖/土径上时 `feetCell()` 取脚下方块**之上**，修"一步都规划不出来/9ms 判 stalled"） | ✅ 离线（`path:test` 31→**35/35**，11f–11l 全是这轮故障的回归）；真机待复测 |
| 10-15 | LLM 完工播报去重 | 同一件事被播报两次（模型措辞 + 632ms 后模板兜底，格式还不一样）：`config` 为 `taskDone` 声明的 `cooldownMs: 30000` **从未被消费**——现在 `announceFinished` 按「任务名\|描述\|成功与否」记时间戳并压制窗口内重复（不同完工、成功后再失败照常播）；模板去掉 `(moved N blocks in M ms)` 遥测 | ✅ 离线（`llm:dry` 工具 39→**43/43** 四条断言；真机故障见 §6 第 15 条） |
| 10-16 | **P0 收官** | 8/8 套件、`plan:audit` 29/29 复核通过；P0 计划书与验收档案**转为历史文档**；REFS 新增 Voyager 参考项目并明确 `refs/` 忽略范围 | ✅ 离线（`p0:verify` 8/8，2026-10-16 实跑） |

当前状态（套件计数实测于 2026-10-16；真机记录截至 2026-10-13 夜 / 10-14 人工）：

* **P0 已收官**：`p0:verify 8/8`（`path:test` · `tasks:test` · `llm:dry` · `control:test` · `verify:roleplay` ·
  `clientmod:test` · `selftest` · `plan:audit`），P0 两份文档已转历史。
* 离线全绿（2026-10-16 实跑）：`selftest 176/176`、`skills:test 57/57`、`client:test 73/73`、`control:test 37/37`、
  `mining:entry:test 25/25`、`mining:collection:test 24/24`、`mining:recovery:test 18/18`、`tasks:test 52/52`、
  `path:test 35/35`、`clientmod:test 11/11`、`verify:roleplay 34/34`、`llm:dry` 路由 67/67 + 工具 43/43（明细见 §8）。
* 控制 Mod：`mod-client/dist/agent-client-1.0.0.jar` **75000 字节**（2026-10-13 17:37 构建，含 WalkTo 严格到达
  y 容差、战斗 v3 与 TACZ 枪械）；已 `client:install`，与 PCL 版本目录在装的 jar 字节完全一致，并已在 10-13
  17:38 与 22:03 两个真机会话中实际加载。改 Mod 后必须重装（`npm run client:install`）并重启客户端。
* **规划器（自主决策）专项**：`slowLoop → decide() → runTask` 这条回路的问题与 **`!` 命令回路**、
  **LLM `do_task`/`do_skill` 回路**分开记账——已核实 10 条（含 `shelter` 规则静默死规则、`light` 无能力闸门、
  矿石路径零进展判定失效）与重构债 7 条见 [`docs/PLANNER-REFACTOR.md`](docs/PLANNER-REFACTOR.md)。
  要点：零进展停牌（B1）/失败罢工（B2）的**记账**发生在 `runTask`，因此**规划器任务与命令表任务共用**
  （`!` 材料类、LLM `do_task` 材料类都会写）；而 `quarantine` 的**拦截**只发生在 `decide()/pickRule()`，
  即**只影响自主选目标**。TaskHub 派发的作业（矿石、长技能）既不记账也不被拦。
* **真机验收（2026-10-10 夜，mc.example.com，角色 `agent`，jar 60936）**：
  `npm run mining:live` 驱动完成 8 轮采矿 + 垫柱探针 + 命令入口 + 中途 stop——**连续 6 轮完整成功**
  （深板岩钻石 ×2、深板岩铁 ×2、金矿 ×2〔含长隧道与命令入口各一〕；均为 `[verified] collected=1 pending=0`，
  垫柱 1–2 跳且 `start/end/placedCells` 回执齐全）；首轮暴露并当场修复两处
  （收尾清扫后的入包对账、挖后矿格作为拾取站位）；1 轮在竖井 3 格落差前按 `danger` 诚实停止。
  命令入口（面板同源）回执与 `acquisition 1/1 verified` 结算落地；中途 stop 后 Mod 空闲、无后续动作；
  tunnel 目标保护真机命中（被保护方块保留、`dugCells=0`）。
  针对“掉落物被岩石包住拿不到”的真机问题：收集器新增有限清障开路（受控夹具实测挖开壁面并拾取），
  并修正“目标仍在地上时路过捡到同类掉落会误判已收”的归因；`npm run mining:live -- --collect-drops`
  可点名清理被封掉落。
  10-12 续测：清障支持“掉落物低一层”（挖开上方封块走下/落入，或填坑垫平后平层拾取）；
  Mod `WalkTo` 严格到达收紧 y 容差（此前站在坑沿会误报到达）——真机确定性验证下坑/回爬均正常（jar 60961）。
  10-12 深夜：对角密闭口袋真机复现“贴角楔死 + plan 假到达”并修复（严格进入改精确格中心、plan 回退严格化、
  预算耗尽允许“零开挖压向掉落物”）——两轮真机均 `verified`（红石 ×2 与 ×1 入包；证据
  `runtime/mining-live/2026-10-12T15-02-06-788Z-live-diag-redstone-6.json`、
  `runtime/mining-live/2026-10-12T15-03-32-249Z-live-diag-redstone-7.json`）。
  10-13：“贴脸僵尸无法识别”根因修复——clientmod 快照只在动作代码里 `refresh()`，空闲时世界视图
  整体冻结（反射循环、LLM `observe`、面板全部读旧数据；面板里 agent 的位置停在 58 格之外）；
  `ClientModBody` 现后台 500ms 轮询 `/state`（`statePollMs` 可配、0 可关），反射循环每 tick 再兜底
  刷新一次。同日真机续测又挖出第二层根因：`needsRescue` 对无 mineflayer `bot` 的 world view
  每 tick 抛 TypeError（setInterval 的 debug 级 catch 静默吞掉）——反射链（自动吃/危险撤退/自卫/
  穿甲）从未执行过；已修（无 bot 视图返回 false）+ 循环异常改限频 WARN。并且非 mineflayer 躯体的
  反射改走技能层（`eat`/`attack`/`armor` 技能，与 `!` 命令/LLM 同一条路径），Combat/AutoEat/
  ToolManager 的 servo 空转不再挡路。当日已按“改 Node 需重启 Agent”重启复测，护甲/持物/进食三处修正在
  10-13 真机确认（提交 `144a783`、`211b4cd`）。
  振荡早退护栏真机生效（A/B 往返 20+ 步 → 3 步内交垫柱）。证据：`runtime/mining-live/*.json`。
  遗留真机项：同型地形 3 次重复、“吃饭 → tunnel”序列（待自然饥饿）、LLM 接管 L 系列 L02+
  （L01 已通过；**L02 已在 10-10 夜真机尝试 3 次、全部失败，其中超时与空回执两类当夜由 `40b153c` 修复，
  修后未复测**；`miningRecovery.enabled` 仍为 false，验收后显式开启）。tunnel 目标保护与采集中途 stop
  已在 10-10 夜真机命中，不再列为遗留。
* **真机验收（2026-10-13 夜，mc.example.com，角色 `AgentDeepSeek`，jar 75000）**：
  ① 17:38–17:58 战斗会话：`shoot` 4 轮共 16 发击杀掠夺者、PvP 对 `Logos_Fyan` 2 轮 4 发击倒、
  全遮挡时诚实 `blocked`（零发射）并各触发一次侧翼（两次仍被掩体挡住，按设计失败而非空放）、
  自然语言请求“攻击玩家”被拒绝（“我只打僵尸骷髅那些怪物”）；
  同段另有 2 次死亡与 `danger detected, retreating`，死亡后按设计停牌、需显式恢复。
  ② 22:03–22:59 采矿会话（账号改名 `AgentDeepSeek` 后首次真机登录成功）：多轮挖矿任务，其中一轮
  `deepslate_gold_ore x20` 完整成功（自报 53 块粗金入包）；另有多轮**按设计诚实停在“产物未入包”**——
  每次先落 `pickup_stalled` 触发记录，因 `miningRecovery.enabled=false` 不调用模型（原因含“掉落物低一层”
  “走位器未进入已开挖格”），随后聊天如实汇报 partial（如“才挖到 2 块…还有 6 块没挖到”）；任务整体另有
  一轮 `x16` 只挖到 3 块的部分完成记录。证据：`runtime/logs/agent-2026-10-13_*.log`、
  `runtime/logs/forge-client-2026-10-13_*.log`。
* **真机验收（2026-10-14，人工）**：操作员实测 **采集到深板岩青金石**（`deepslate_lapis_ore`）——
  中文矿名 → 深板岩变体的修复（提交 `3d7a637`）通过了最直接的判定用例：修复前 `挖点青金石` 会因
  兜底路由的 `/金/` 命中而**去挖金矿**，中文名送进 LLM 工具参数时还会被降级成材料任务。
  本次为操作员口述确认（未落 JSON 证据文件；轮次/入口/数量未记录），细节见
  [`docs/MINING-LLM-PLAN.md`](docs/MINING-LLM-PLAN.md) 附五。
* 历史真机记录（10-08）：斜下连续 20+ 格、`tunnel` 全程 `jumpsBlocked=0`、防坠落 3 格深坑前停住、
  1–2 格台阶零误报、台账 extra 0（[`docs/REWRITE-PLAN.md`](docs/REWRITE-PLAN.md) §12.6）。
* 后续候选：断开/离开世界检测（客户端回主菜单后大脑仍会按旧快照规划）、自主采矿目标的退避加宽、
  通用 `WalkTo` 的落差保护。

---

## 4. 在游戏里指挥它

**通道 A：`!` 前缀 —— 确定性快路径**（Agent 轮询控制 Mod 的聊天缓冲，只认 `!` 开头的行）：

```
!status / !inv / !where / !help
!chop 8 / !mine stone 8 / !collect / !goto 120 64 -300
!craft <item> [n] / !smelt <item> [n] / !farm [r] / !sleep
!eat [food] / !equip <item> / !armor / !drop <item> [n]
!place <item> <x> <y> <z> / !use <x> <y> <z> / !attack / !defend
!explore [距离] [方向] / !come <玩家> / !withdraw / !deposit
!task status / !task stop          # 后台任务槽
!area … / !route …                 # 命名区域 / 路线（route plan 只算不走）
!rule … / !yes [always] / !no      # 权限规则与征询应答
!stop / !pause / !resume           # 停牌表
```

**通道 B：`@大肥鱼 <自然语言>` —— 走大模型**。例：`@大肥鱼 去砍点树`、`@大肥鱼 帮我挖点铁`。
触发词来自 `config/persona.md` 的 frontmatter（当前 `@大肥鱼`），`config/agent.json` 的
`chat.dialogueTrigger` 可覆盖（默认 `null` = 跟随人设文件）。没有 API key / 请求超时 / 返回非法 JSON 时，
正则兜底路由器接管，所以两条通道始终可用。

**控制面板（唯一的"它听懂了吗"观察点）**：`http://127.0.0.1:8766/panel` —— 实时状态、当前任务与队列、
最近识别到的输入 → 路由结果、停牌原因、死亡红条与恢复按钮；急停会诚实汇报每一级降级的实际结果。

HTTP 也能下同样的指令：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8766/command `
  -ContentType 'application/json' -Body '{"command":"chop 8"}'
Invoke-RestMethod -Uri http://127.0.0.1:8766/ui/state
```

行为约定：`!stop` 进入 owner-stop 停牌（自动规划暂停，显式任务仍可跑），`!resume` 清除；
死亡会中止一切任务且**不自动恢复**；权限 `ask` 会在动手前在游戏里发问，超时算拒绝。

---

## 5. 控制 Mod：构建与安装

| 命令 | 作用 |
| --- | --- |
| `npm run client:build` | 编译 `mod-client`（Gradle 离线构建） |
| `npm run client:install` | 复制 `dist/agent-client-1.0.0.jar` 到 `versions/1.20.1-Forge_47.4.10/mods/`（先删旧版） |
| `npm run client:check` | 探测 8899：Mod 在不在、是否已进入世界 |
| `npm run client:verify` | 真机协议验收（需要客户端在跑） |

原语清单（`ControlHttpServer.execute`，25 个 verb）：`chat/login/say`、`cmd/command`、`look/lookat/resync/stop`、
`moveto/goto`、`dig/mine`、`tunnel`、`pillar/pillarup/tower`、`place/useon/interact`、`menu/slots/click/close`、
`use/useitem/select/drop`、`attack`、`shoot`、`retreat`、`target`；
感知 `GET /state /progress /chatlog /health`。`/register` 在四道闸门上被永久拒绝（会重置角色数据）。

---

## 6. 踩坑记录（精简版）

1. **带客户端 Mod 的 Forge 服进不去**：mineflayer 只有原版协议，FML2 没有实现 → 主线换成真实客户端 +
   控制 Mod；被踢时不再无限重连刷屏。
2. **客户端忽略输入**：窗口失焦或任意 GUI 打开时，移动键完全不生效 —— `/state` 暴露
   `screenOpen/mouseGrabbed`，排查"它不动"先看这两项。
3. **动作 verdict 丢失**：`/progress` 曾在动作结束瞬间清空，Node 把"没走到"当成功（A* 的跳跃/横移
   判定因此失效）；现在最终 verdict 保留到下一个动作开始。
4. **走挖反复跳跃**：朝整数角点走会蹭台阶边缘，下坡按跳会变成"跳跳乐" —— tunnel 控制器改为朝方块
   中心转向、按碰撞箱判断、下坡永不按跳。
5. **合成链缺前置**：`Recipe.find` 的木材变体会骗过 `recipesFor` —— 现在自动补 原木→木板→木棍，
   失败信息里会说明具体缺什么。
6. **同名重复登录风暴**：`duplicate_login` 退避 15s → 120s + 单实例锁 `runtime/agent.lock`。
7. **死亡不自动恢复**：死亡中止一切任务并三处告警（控制台 / 面板 / 状态文件）；复活后也要显式 `!resume`。
8. **防呆与权限**：`/register` 永久禁止（会重置角色数据）；`ask` 规则动手前征询、`!yes` 在任务内对同种
   方块持续有效；`deny` 优先。
9. **防坠落**：落差 >2 格或先见液体 → Node waypoint 预检 + Mod tick 级探底拒绝（`ledge`）；
   隧道跑完复查洞窟（openness ≥ 45% 即停），正常 1–2 格台阶不受影响。
10. **中文矿名没有别名（2026-10-14 修复 + 真机确认）**：别名表只有英文，于是"金矿"这类中文词到不了深板岩变体——
   归一化把中文名按普通名字分类成 **material**（`mine_ore only takes ores`），LLM 工具参数（`block:["金矿"]`）
   与 `do_skill` 边界同样降级；兜底路由又是手写的 4 矿 if 链，铜/红石/绿宝石/石英/残骸掉进"挖石头"，
   而 `/金/` 会命中**青金石**→挖成金。现在中文词条与英文词条同表（含"X矿/矿石"后缀与"深板岩X"前缀），
   路由按**最长别名**匹配；10 个矿种 × 6 个入口的矩阵进了 `mining:entry:test` A11。
   真机确认（同日人工）：**采集到深板岩青金石**。
11. **24 格外的目标是"盲走"（2026-10-14 修复）**：`out-of-grid` 时旧代码用 `planner.toward()` 朝目标直线迈
   一步——y 直接取目标高度、不看地形也不看水。渡河时就是这样走进河里的：**桥明明在扫描范围内，A\* 却
   从没被问过**。现在改为"子目标接力"（见 §9 第一条）：直线方向上距目标最近且 ≤23 格的干格 →
   A\* 规划 → 走到再重规划；不通则在 ±5 格内换点；全不通就诚实报错、站在原地。
   `toward()` 已删除，回归在 `path:test` 第 11 组（旧代码跑这组只有 21/28，失败面正是新用例）。
12. **子目标搜索的垂直窗口太窄 → 真机"随机游走"（2026-10-15 修复）**：子目标只在"直线插值高度 ±1"
   这几档里找落脚点。跨越高度差（陡坎/河谷/山脊）时整段射线都判"不可用"，搜索便一路滑回 bot 自己脚下，
   交出一个 2–6 格外的子目标；而目标判定带 `range` 容差，这种子目标会被判成"已经到达"，于是 ±5 回退
   接着挑出刚好超出容差的**横向**格子——表现出来就是 1 格一跳、来回蹭的随机游走。现在改为**整列搜索**
   （−8..+8，按"离直线高度最近"排序），并且"已经到达"不再触发 ±5 回退（计入停顿、三次后诚实报错）。
   回归：`path:test` 11f（陡坎仍给出 23 格外的子目标、40 格行程 ≤8 条腿）与 11g（无跳可跳时报错且
   0 条腿、原地不动）；这两条拿去跑旧代码分别报 "subgoal got 6.0 blocks" 与 "got 2 legs"。
13. **含水台阶/半砖被当成水（2026-10-15 操作员指出并修复）**：桥面常是**含水（waterlogged）的木/石台阶
   或半砖**——方块里有水，但人站在上面**并不入水**。模型本来靠"Mod 只报基名"侥幸把它当陆地，但有两处
   缺口：①带状态后缀的名字（`oak_fence[waterlogged=true]`）会让形状判断失效（栅栏被判成可站）；
   ②射线外的桥不会被选中——子目标只沿直线找，找到水就去游泳，**从自己的桥旁边游过河**。现在：
   台阶/半砖（含 `[waterlogged=true]`、`type=top/double`）一律 `solid + standable + 永不算液体`，
   并且**向上走时按完整方块处理**（从水里踩上桥面就是一次 `step-up`）；名字先剥掉 `[...]` 状态再分类；
   当真需要踩水横渡时，导航器会先在 ±5 格内找**能走过去的干格**（桥面就是干格），找不到才下水。
   回归：`path:test` 11i（偏离直线的半砖桥 → 全程走桥、0 踩水）、11j（分类 + 水中 step-up 上桥面）。
14. **站在农田/半砖上时"脚位格"算错 → 一步都规划不出来（2026-10-15 真机）**：`floor(y)` 在**部分高度**
   的方块上返回的是**脚下那块方块本身**——农田 15/16 高（脚位 62.94）、下置半砖顶面在 y+0.5
   （脚位 62.5），于是模型认为"bot 正站在实心方块内部"，A\* 从这一格出发**没有任何合法邻居**。表现：
   子目标一路滑回 bot 自己脚下、planner 回 `already within range`、**9 毫秒判 stalled**（真机
   (75,63,65)），客户端侧则表现为"被卡住"。现在新增 `PathPlanner.feetCell()`：当 `floor(y)` 那格是
   "可站立的实心方块"且脚下确实高于该格底面时，脚位取**它上面那一格**；跳跃中的 bot（那格是空气）
   不会被误抬。`_plan` 起点、`pickSubgoal`/`subgoalCandidates` 的基准高度、`hopTo` 的"是否已在原地"、
   `sidestep` 的起点全部改用它；子目标还加了"**不能是自己所在那一格**"的判据（`Math.round` 会把
   75.8 的一步舍回 75）。回归：`path:test` 11k（农田起点的脚位与规划）、11l（半砖桥面上沿桥规划）；
   把 `feetCell` 退回 `floor` 会立刻复现 "got y=62"。
15. **同一件事被播报两次，而且两种格式（2026-10-15 真机）**：玩家连说两次"到(31,63,59)"，两趟 `goto`
   任务各自完工 → 先播模型措辞的 `大肥鱼搞定了：walk to 31,63,59 - arrived at … (moved 29.89 blocks in
   5968ms)`，**632 毫秒后**又播模板兜底的同一件事（第二趟赶不上模型：`another turn is already running`）
   —— 同一次行动的"重复 + 格式不同"就是这么来的（偶发，取决于两个相同请求是否时间重叠）。根因：
   `config` 里为 `taskDone` 声明的 `cooldownMs: 30000` **从来没被消费**（只有 `speechScheduler` 用它自己
   那几个**状态**触发器）。现在 `announceFinished` 按 `任务名|描述|成功与否` 记时间戳，在声明的冷却窗口内
   **重复的同一件事不再播**（不同的完工、以及成功后再失败都照常播，不会被误吞）；模板文案同时去掉
   `(moved N blocks in M ms)` 遥测、理由与描述重复时不再复述。回归：`llm:dry` 四条断言
   （重复合并 / 去掉遥测 / 不同完工仍播 / 失败不被吞）。

---

## 7. 目录结构

```
<repo>\
├─ start.ps1 / stop.ps1        # 一键：客户端 + Agent；分级停止
├─ config\                     # agent / servers / pcl / llm / persona / safety
├─ src\
│  ├─ index.js                 # 装配与生命周期
│  ├─ brain.js                 # 快反射（600ms）+ 慢规划 双循环
│  ├─ skills\                  # 19 个确定性技能 + miningPlan（报价/几何/台账）
│  ├─ body\                    # Body 契约与实现：clientmod / mineflayer / mock
│  ├─ core\                    # taskHub / recoveryLadder / permissions / places / holds / failure
│  ├─ llm\                     # LLM 回合与 8 个工具（tools\）
│  ├─ chat\commands.js         # `!` 指令 + 自然语言路由
│  ├─ pathfinding\             # A*（planner/walker/navigator）+ 客户端世界适配
│  ├─ world\ survival\ tasks\  # 世界模型 / 反射 / 早期任务层（兼容保留）
│  └─ pcl\ server\ web\        # PCL 集成 / 本地无头服务器 / 面板 API
├─ mod-client\                 # Forge 1.20.1 客户端控制 Mod（薄手）
├─ mod-bridge\                 # 可选的 Fabric 服务端桥（服务器权威状态）
├─ docs\                       # 计划、进展、验收、坑
├─ scripts\                    # 运维与离线测试脚本
└─ runtime\                    # 日志、状态、锁、旧服务器
```

---

## 8. 脚本一览

| 命令 | 作用 | 现状 |
| --- | --- | --- |
| `npm run play` / `.\start.ps1` | 客户端 + Agent 一键启动 | 主线 |
| `.\stop.ps1 [-Client]` | 停 Agent / 连客户端一起停 | 主线 |
| `npm run agent:client` | 只起 Agent（接已运行的客户端） | 主线 |
| `npm run client:launch` | 无头拉起 Forge 客户端（`--server` / `--singleplayer` / `--username`） | 主线 |
| `npm run client:check` | 检查 Mod 与"是否在世界里" | 主线 |
| `npm run client:build` / `client:install` | 构建 / 安装控制 Mod | 主线 |
| `npm run client:test` | 假 Mod 协议测试（含 pillar 回执/隧道保护/空闲刷新/shoot/retreat） | 73/73 |
| `npm run clientmod:test` | clientmod 躯体角色扮演路径 | 11/11 |
| `npm run skills:test` | 技能库（含采矿/垫柱/护甲/武器/进食/枪械选枪与反卡死、战斗租约） | 57/57 |
| `npm run mining:entry:test` | 统一挖矿入口 A 系列（含 A10 规划器停牌键、A11 全矿种深板岩矩阵） | 25/25 |
| `npm run mining:collection:test` | 掉落物收集 C 系列 | 24/24 |
| `npm run mining:recovery:test` | LLM 异常接管 R 系列（脚本化模型） | 18/18 |
| `npm run selftest` | 全量离线自检 | 176/176 |
| `npm run p0:verify` | P0 全量验收（一次跑 8 个套件） | 8/8 |
| `npm run path:test` | 寻路场景（含跨网格子目标接力、河流与桥、陡坎不乱走、游泳过湖） | 31/31 |
| `npm run tasks:test` | 三原语（走 / 挖 / 捡） | 52/52 |
| `npm run llm:dry` | 意图路由 / Schema / 工具白名单 / 完工播报去重 | 路由 67/67 · 工具 43/43 |
| `npm run control:test` | 双通道 + 面板 + 死亡处理 + 反射路由 + 战斗反射 | 37/37 |
| `npm run plan:audit` | 计划书 §11 符合性 | 29/29 |
| `npm run inspect:server` / `mods:report` | 连服前体检 / Mod 知识报告 | 辅助 |
| `npm run body:info` | 查看可用 body 与当前选择 | 辅助 |
| `npm start` / `npm run server:setup` | 本地无头服务器 + 旧流程（`--no-agent` 只起服） | 历史 / 兼容 |
| `node scripts/client-real.js --login <pw> [--primitives]` | 真机非破坏自检 / 三原语验收 | 需客户端 |

P0 已于 2026-10-16 收官（`p0:verify` 8/8、`plan:audit` 29/29）；[`docs/P0-STATUS.md`](docs/P0-STATUS.md) 与
[`docs/P0-PLAN.md`](docs/P0-PLAN.md) 都是**历史文档 / 验收档案**（文首有过期对照表与收官依据）。
逐批次进展见 [`docs/REWRITE-PLAN.md`](docs/REWRITE-PLAN.md)（记录到 2026-10-08）。更新的一手记录在
[`docs/MINING-LLM-PLAN.md`](docs/MINING-LLM-PLAN.md)（附二/附三）、
[`docs/MINING-COLLECTION-PLAN.md`](docs/MINING-COLLECTION-PLAN.md)（§十一）与
[`docs/COMBAT-PLAN.md`](docs/COMBAT-PLAN.md)；**下一阶段方案**见
[`docs/P1-PLANNER-PLAN.md`](docs/P1-PLANNER-PLAN.md)（选型实验与接口事实见
[`docs/PLANNER-AB-EXPERIMENT.md`](docs/PLANNER-AB-EXPERIMENT.md)、
[`docs/HARNESS-INTERFACES.md`](docs/HARNESS-INTERFACES.md)）。

---

## 9. 已知限制

* **服务器兼容**：需要客户端 Mod 的 Forge/NeoForge 服必须走"真实客户端 + Mod"路径（已支持）；
  mineflayer 备选躯体只适用于原版 / Paper / Spigot / 纯服务端 Fabric。各服的登录与反作弊规则自行确认。
* **采矿批次已真机验证**（2026-10-08 首轮，10-10～10-12 续测，见 REWRITE-PLAN §12.6 与 MINING-LLM-PLAN 附二/附三）：
  numen 采矿重构、tunnel、防坠落补丁、逐格垫柱、共享收集（入包证据）与有限清障全部通过；
  遗留“吃饭 → tunnel”序列待自然饥饿时补测（逻辑已有离线用例覆盖）。
* **AuthMe**：只 `/login`，永不 `/register`（在 simpfun 类服务器上 `/register` 会重置角色数据）。
* **规划器是下一阶段重构对象，问题单独立账**：自主规划（`slowLoop → decide() → runTask`）的问题与
  `!` 命令、LLM 工具分开记录，但**退避机制是共用的**——B1/B2 的记账在 `runTask` 内，凡是经
  `brain.enqueue` 的任务都会写（规划器任务、`!` 材料类、LLM `do_task` 材料类）；`quarantine` 的拦截
  只在 `decide()/pickRule()`，即只影响自主选目标；TaskHub 派发的作业（矿石、长技能）两者都不适用。
  已知问题（`shelter` 规则永不触发、`light` 无能力闸门、矿石路径在规划器层无刹车、停牌粒度/无目标记忆等）
  汇总在 [`docs/PLANNER-REFACTOR.md`](docs/PLANNER-REFACTOR.md)——**改 bug 或重构前先分清回路**，不要把
  规划器的问题当成技能层 bug 去修，也不要在改退避机制时忘了它会波及 `!`/`do_task`。
* **LLM 挖矿接管默认关闭**（`miningRecovery.enabled=false`）：异常仍会被记录，确定性宏耗尽后诚实失败/报告 partial；
  真机 L 系列验收通过后再显式开启（L01 已于 10-12 通过、0 次模型调用；L02 已于 10-10 夜真机尝试 3 次、
  全部失败——超时与空回执两类当夜已修（`40b153c`），仍在等合法的可恢复停滞夹具做修后复测，
  且不得为测试移除安全措施）。开启后接管与聊天共用模型并发/token 账本，且不解除危险/权限/死亡停牌。
* **寻路感知半径 24 格，超出部分靠"子目标接力"**（2026-10-14 重做，10-15 修陡坎乱走/游泳过湖）：Mod 只
  发送玩家周围 ±24 水平 / +8−8 垂直的方块快照，格在网格外是"未知"而不是空气。跨网格的目标现在
  **不再盲走**：导航器沿"bot→目标"直线选一个距目标最近、仍在网格内、可落脚的格子作为子目标
  （**干格优先**：脚位格与头位格都要能通过——甘蔗/高草/海带不阻挡；整条射线全是水时退回**可踩水的
  水面格**作过渡航点，因为游泳已实现、客户端行为正确，拒绝水格只会把 bot 困在岸上），用 A\* 规划过去
  再接力重规划；子目标规划不通就在其 ±5 格内挑候选重试（候选必须是真的"一跳"，不能落在容差之内）；
  全部失败则**诚实报 `out-of-grid` 且不移动**。子目标的落脚高度取**整列可见范围**（−8..+8，按离直线
  高度最近排序），因为跨陡坎时"直线那一层"往往是空气或岩石——只在那一层找会把子目标滑到脚下，变成
  1 格一跳的随机游走（10-15 真机故障，见 §6 第 12 条）。水域移动代价是平地的 **2 倍**
  （`COST.SWIM=2.0`）——足以让 A\* 在桥顺路时走桥，但不会为了让路走桥而绕出巨大弯；运动模型允许
  **踩水横渡**（`canSwimAt`：不要求下方有地板，深海也能过；岩浆/其下有岩浆一律拒绝）。**台阶与半砖一律
  算陆地**（含 `[waterlogged=true]` 的含水方块——方块里有水，但站在上面不入水），且**向上走时按完整
  方块处理**（从水里踩上桥面就是一次 `step-up`）；当真要下水时，导航器先在 ±5 格内找**能走过去的干格**
  （桥面就是干格），找不到才游泳（见 §6 第 13 条）。**脚位格按"实际站着的方块"修正**：站在农田/土径/
  半砖/台阶上时，`floor(y)` 那格是脚下的方块，脚位取它上面一格（否则模型以为 bot 在实心方块里，
  A\* 一步都出不去——真机表现为 9ms 判 stalled、客户端报卡住，见 §6 第 14 条）。回归：
  `npm run path:test` 第 11 组与 3b（35/35）。
* **尚未实现**：交易、附魔、下界/末地、区块级地图记忆（长距离探索会重新找路）。
* **操作注意**：客户端窗口未聚焦或开着 GUI 时游戏忽略输入；控制 Mod 改动必须重启客户端才生效
  （Node 改动只需重启 Agent）。
* **Mod 知识**：客户端扫描到的是真实注册表；未知方块默认不挖，避免卡在挖不动的方块上。

---

## 10. 自检

```powershell
npm run p0:verify      # 离线全量（约 1 分钟，8 个套件）
npm run selftest       # 176/176：模块图 / 插件 / 寻路 / 三原语 / 意图 Schema / 工具白名单 / 死亡处理
npm run mining:entry:test      # 25/25：统一挖矿入口（含全矿种深板岩矩阵）
npm run mining:collection:test # 24/24：共享收集
npm run mining:recovery:test   # 18/18：LLM 接管（脚本化模型）
```

最近一次真机启动日志（节选）：

```
INFO (agent) body: clientmod
INFO (body) agent-client mod found (vdev) at http://127.0.0.1:8899
INFO (body) attached: minecraft:overworld at (8,66,54) hp=20 food=20
INFO (authme) logged in
INFO (brain) brain online
```
