# Minecraft Survival Agent (mineflayer + PCL2)

一个用 **[mineflayer](https://github.com/PrismarineJS/mineflayer)** 驱动的《我的世界》**生存 Agent**：
它会自己砍树、合成工具、挖矿、打猎、造庇护所、点灯、整理箱子，并配合 **PCL2（Plain Craft Launcher 2）** 使用
你本机已有的正版客户端来旁观它游玩。

**Agent 部署在你本机，可以加入外部联机服务器**（支持正版登录与 SOCKS5/HTTP 代理），
并且具备 **Mod 知识**：能自动识别服务端加载器（Forge / NeoForge / Fabric / 原版）、
按命名签名推断 Mod 物品用途，并对未知内容采取保守策略。
⚠️ 但有一个硬限制：**带"客户端必需 Mod"的 Forge 服 mineflayer 连不上** —— 先看
[`docs/EXTERNAL-SERVERS.md`](docs/EXTERNAL-SERVERS.md)。

参考了这些开源项目的设计思路：

| 项目 | 借鉴点 |
| --- | --- |
| [PrismarineJS/mineflayer](https://github.com/prismarinejs/mineflayer) | 机器人本体、插件体系（pathfinder / tool / collectblock / armor-manager） |
| [PrismarineJS/mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) | A* 寻路；本项目额外修补了它最坑的几个失败模式 |
| [PrismarineJS/node-minecraft-protocol-forge](https://github.com/PrismarineJS/node-minecraft-protocol-forge) | 调研 FML 握手；**结论：只支持 1.12 老握手，1.13+ 的 FML2 无实现**（见 §4 坑 11） |
| [Syrthax/Embark-Ai](https://github.com/Syrthax/Embark-Ai) | 「反应层 + 规划层」双循环结构、按优先级排序的生存目标表 |
| [JesseRWeigel/minecraft-agent-swarm](https://github.com/JesseRWeigel/minecraft-agent-swarm) | 砍树/合成/挖矿的技能拆分与任务队列 |
| [HarjjotSinghh/minecraft-mcp](https://github.com/HarjjotSinghh/minecraft-mcp) | 用外部控制接口（HTTP）驱动游戏内 Agent 的思路 |

---

## 0. 文档导航

| 文档 | 内容 |
| --- | --- |
| 本文件 | 架构、PCL2 集成、快速开始、踩坑记录、Mod 知识概览 |
| [`docs/EXTERNAL-SERVERS.md`](docs/EXTERNAL-SERVERS.md) | **联机游玩**：外部服务器配置、正版登录、代理、Forge 硬限制与四种可行方案 |
| [`mod-bridge/README.md`](mod-bridge/README.md) | Fabric 桥接 Mod 的构建与安装 |

### 联机 + Mod 知识（摘要）

```powershell
npm run inspect:server                                # 先确认目标服务器能不能连（只 Ping，不登录）
node src/index.js --profile simpfun                   # config/servers.json 里的命名 profile
node src/index.js --server mc.example.com:25565 --auth offline
node src/index.js --proxy socks5://127.0.0.1:1080     # 国内连外服
```

环境变量：`MC_ADDRESS` / `MC_AUTH` / `MC_PROXY` / `MC_USERNAME` / `MC_PROFILE`。
Agent 会在连接前**自动 preflight**（可达性、协议号、人数），不可用时直接拒绝并说明原因。

Mod 知识（`src/mods/knowledge.js`）分三层：**插件通道检测加载器** → **命名签名分类** →
**未知内容保守兜底（默认不挖）**。

```powershell
npm run mods:report          # 离线：签名分类 + 安全门
npm run mods:live            # 真实连一次服务器并扫描注册表
npm run verify:modded        # 起真实 Forge 服务端验证加载器检测（6/6 通过）
```

---

## 1. 它是怎么和 PCL2 配合的

先说清楚一件事，避免误解：

* **PCL2 是「客户端」启动器**，它能把游戏窗口拉起来，但**不能开专用服务器**（dedicated server）。
  也就是说：想让 Agent 无人值守地进一个「世界」，必须有一个真正在跑的服务器进程。
* 所以本项目采用的分工是：

```
        ┌──────────────────────────── <repo> ───────────────────────────┐
        │                                                                            │
        │  scripts/run-all.js  (npm start)                                           │
        │      │                                                                     │
        │      ├─ 1. 用 Mojang 官方 artifact 准备 server-1.20.1.jar  (eula/属性自动写) │
        │      ├─ 2. 用 PCL 同一个 Java 运行时无头启动服务器 (runtime/server/)          │
        │      ├─ 3. 启动 mineflayer Agent 连入 127.0.0.1:25565                       │
        │      └─ 4. (可选 --with-client) 调用 PCL2 打开客户端，你进去旁观              │
        │                                                                            │
        └────────────────────────────────────────────────────────────────────────────┘
                    ▲                                            ▲
                    │ 无头服务器 (Java)                            │ PCL2 客户端
                    │                                            │ E:\PCL\PCL\Plain Craft Launcher 2.exe
                    └────────────── 同一个世界 / 同一份 .minecraft ┘
```

* **PCL2 负责**：你本机的客户端、正版账号、版本管理、Mod 加载（Forge/Fabric）——即「人看的画面」。
* **本项目负责**：无人值守的服务器 + Agent 大脑（Node.js + mineflayer）。
* 两者连接的是**同一个服务器地址**，所以你可以随时用 PCL2 进游戏，和 Agent 一起玩。

`src/pcl/` 里的集成是真实生效的，不是占位：

* `detect.js` 自动定位 `Plain Craft Launcher 2.exe`、`.minecraft` 目录、`PCL.ini` 里当前选中的版本、
  PCL 自己的 Java 注册表（`%APPDATA%\PCL\config.json`），并解析 `LatestLaunch.bat` 还原 PCL 上次启动用的**真实命令行**。
* `launcher.js` 用 `--launch <版本名>` 启动 PCL2，等价于你手点「启动游戏」。
* 命令行自查：`npm run pcl:info`

---

## 2. 快速开始

### 环境要求

* Windows（脚本按 Windows 写的，核心逻辑跨平台）
* Node.js ≥ 18（本机已验证 v24）
* Java 17+（1.20.1 服务器需要；本项目会自动从 PCL 的 Java 列表里挑）

### 三条命令

```powershell
cd "<repo>"
npm install            # 首次：装 mineflayer 全家桶
npm run server:setup   # 首次：下载并配置 1.20.1 服务器（约 46 MiB）
npm start              # 启动服务器 + Agent
```

想边看边玩就加一个参数：

```powershell
npm start -- --with-client          # 顺便用 PCL2 打开客户端，进 127.0.0.1 旁观
npm start -- --day                  # 把时间设成白天再开始（需要 Agent 是 OP，见 §6）
npm start -- --goal "gather 32 wood"  # 给一个明确目标
```

也可以直接双击 `start-agent.bat`（首次会自动装依赖、下服务器）。

### 端口与进程

| 东西 | 地址 |
| --- | --- |
| Minecraft 服务器 | `127.0.0.1:25565`（离线模式，方便本地测试） |
| Agent 状态 API | `http://127.0.0.1:8766/status`、`/health`、`/inventory`、`/logs`、`POST /command` |

```powershell
Invoke-RestMethod http://127.0.0.1:8766/status | ConvertTo-Json -Depth 5
```

---

## 3. Agent 是怎么做决策的

`src/brain.js` 里是两个循环：

**快循环（600ms，反射）**
1. 掉进岩浆/着火/血量过低 → 撤退并进食
2. 饥饿 → 自动吃（优先熟食、金胡萝卜）
3. 敌对生物贴脸 → 换上最好的武器打，打不过就跑（苦力怕/监守者永远跑）
4. 自动穿装备、自动换工具
5. 卡在树冠上/坑里（A* 解不出来）→ 物理脱困

**慢循环（2.5s，规划）**
按「生存进度」优先级依次判断，第一条满足的规则胜出：

| 优先级 | 条件 | 目标 |
| --- | --- | --- |
| 5 | 背包快满 | 存箱子 |
| 10 | 没食物且饿 | 打猎 |
| 20 | 木头 < 4 | 砍树 |
| 25 | 没有工作台 | 合成工作台 |
| 27–30 | 没有镐 | 木板 → 木棍 → 木镐 |
| 35 | 天黑了且没庇护所 | 盖 3×3 小屋 |
| 40–43 | 工具等级低 | 挖石头 → 石镐/石剑 |
| 45 | 没火把但有煤 | 插火把 |
| 47–48 | 没熔炉 | 挖石头 → 合成熔炉 |
| 50 | 食物 < 3 | 打猎 |
| 55–56 | 没铁 | 挖铁矿 → 铁镐 |
| 60–70 | 日常 | 继续囤木头/照亮/挖石头 |

每个目标都实现成一个「任务」（`src/tasks/`），任务有**硬超时、可取消、可重试、失败隔离（quarantine）**，
所以某个目标在当前地形永远做不成时，规划器不会死循环——它会把这个目标冷藏 60 秒，去做别的。

---

## 4. 踩过的坑（这部分是这个项目真正的价值）

做 mineflayer Agent，90% 的时间会花在这几个「看起来像玄学」的问题上。已经全部修好并写在代码注释里：

1. **`pathfinder` 的 `stopPathing` 是闭包变量，新连接默认是「已停止」**
   症状：第一条 `goto()` 就报 `Path was stopped before it could be completed`，完全走不动。
   原因：这个标志位起始为 `true`，只有 `physicsTick` 里「路径为空」分支会清掉它，外部无法直接改。
   解法：`BotController.rearmPathfinder()` —— `stop()` → 设一个**已经满足**的 goal → 等一个 physics tick → 清空 goal。
   并且 `Navigator.goto()` 在遇到这个错误时会**自动 re-arm 并重试一次**。

2. **`goto()` 会「成功」返回但一步都没走**
   症状：`status=partial`、`path.length=0`，Promise resolve，机器人在原地发呆。
   解法：`Navigator.goto()` 前后对比坐标，没动就判定失败，并计入 `stuckCount`。

3. **出生点在树冠上，A* 直接爆炸**
   症状：`visitedNodes` 上万、`path` 为空。树叶在物理模型里是可站立的方块，规划器想不明白怎么下来。
   解法：`src/core/recovery.js` —— 严格判定「是否真的被困」（站在树叶上 / 卡在方块里 / 悬空），
   然后依次尝试：向下寻路 → 四个方向手动走 → 垂直往下挖。判定刻意保守，**误判比漏判贵**。

4. **多个任务并发抢 pathfinder**
   症状：日志里瞬间刷满几百条同一个坐标的 `goto failed`。
   原因：慢循环、重试定时器、反射层可能同时调用 `runTask()`，互相 `stop()`。
   解法：`Brain` 加串行执行闸门（`activeTask`），并且 `currentTask` 只在「确实是自己」时才清空。

5. **两个 Agent 进程用同一个用户名 → `duplicate_login` 掉线循环**
   解法：`src/core/lockfile.js` 单实例锁（`runtime/agent.lock`，带 PID 存活检测）。

6. **合成链缺前置材料**
   症状：想合成工作台/木镐，但背包里只有原木，`recipesFor` 找不到配方就直接失败。
   解法：`CraftTask` 会自动补前置（原木 → 木板 → 木棍），并按需**放置工作台**；深度上限防止递归失控。

7. **重复日志淹没一切**
   解法：`Navigator._warnOnce()` 对同一坐标/同一错误做 5 秒抑制，并统计被压掉多少条。

8. **合成「没有配方」其实是木材种类不匹配**
   症状：背包里有 14 个云杉原木，却报 `no recipe for wooden_pickaxe`。
   原因：`Recipe.find()` 会把**所有**木材变体都列出来（而且 oak 排第一），但 `bot.recipesFor()`
   只匹配你**手上真的有的**那种木板。所以「有原木、没木板」看起来就像「没有配方」。
   解法：`CraftTask.requiredIngredients()` 拿到全部变体 → 按「和现有原木匹配的木板」排序 →
   先 `ensureReserve()` 把多余原木变成木板 → 再重试；失败信息里会打出**具体缺什么**。

9. **`craft()` 静默什么都不产出**
   3×3 配方在没有打开工作台窗口时会「成功返回但产出 0 个」。
   解法：产出为 0 时重新放置工作台并重试一次，并把持有的物品、工作台坐标、是否需要工作台全打进日志。

10. **僵尸夜杀循环**
   没武器时夜晚连死 26 次（`agent-state.json` 里有记录）。
   解法：血量低且没食物时提高打猎优先级；`--day` 可以在开局把时间设为白天（需要 Agent 是 OP）；
   现在还有 **SAFE MODE**（4 分钟内死 2 次 → 停止一切目标、挖竖井把自己封在地下、等天亮）。

11. **`duplicate_login` 重连风暴**
   症状：服务端日志每 2 秒一条 `You logged in from another location`，一直不停。
   原因：旧 socket 还没释放就重连，加上可能有第二个同名进程。
   解法：`disconnect()` 先摘掉自己的监听器再退出（避免误触发重连）；
   被踢 `duplicate_login` 时退避 15s → 30s → … 最多 120s；单实例锁 `runtime/agent.lock`。

12. **Forge 服会拒绝原版协议客户端（无法绕过）**
   症状：登录瞬间被踢 `This server has mods that require Forge to be installed on the client`，
   然后无限重连。
   原因：Forge 1.13+ 用 **FML2 握手**，服务端要求客户端回传注册表数据；
   mineflayer 只会原版协议。社区的 `node-minecraft-protocol-forge` 只实现了 1.12 的 `FML|HS` 老握手。
   解法（**不能绕过，只能选方案**）：
   * 检测：`npm run inspect:server` 提前判定，Agent 也会 preflight；
   * 被踢时**停止重连**并打印解释，不再刷屏；
   * 用 `--loader forge` 自己开 Forge 服（只装服务端 Mod），Agent 就能连；
   * 详见 [`docs/EXTERNAL-SERVERS.md`](docs/EXTERNAL-SERVERS.md)。

13. **加载器识别不能只看版本字符串**
   Forge 服在"无内容 Mod"时版本串仍是 `1.20.1`，`serverBrand` 也拿不到。
   真正靠谱的信号是**插件通道**（`fml:*` / `forge:*` / `fabric:*`），
   在 `bot._client` 的 `packet` 事件里抓 `custom_payload` 即可 —— 实测能正确识别为 `forge`。

---

## 5. 目录结构

```
<repo>\
├─ start-agent.bat            # 一键启动（自动装依赖/下服务器）
├─ config\
│  ├─ agent.json              # 机器人用户名、地址、行为开关
│  ├─ server.json             # 服务器端口、难度、种子、bridge 端口
│  └─ pcl.json                # PCL2 路径 / .minecraft 路径 / Java 候选
├─ src\
│  ├─ index.js                # 入口：装配所有模块、生命周期、诊断模式
│  ├─ brain.js                # 双循环规划器（快反射 + 慢规划）
│  ├─ core\
│  │  ├─ bot.js               # mineflayer 封装 + pathfinder 重新武装
│  │  ├─ movement.js          # 寻路、挖掘、拾取、放置（含空路径/闭包 latch 修补）
│  │  ├─ recovery.js          # 卡死检测与物理脱困
│  │  ├─ memory.js            # 跨会话记忆（地标、统计、任务历史）
│  │  ├─ lockfile.js          # 单实例锁
│  │  └─ plugins.js           # 可选插件加载（缺了也能跑）
│  ├─ world\
│  │  ├─ items.js             # 生存知识表（食物/燃料/工具等级/需镐方块）
│  │  └─ worldView.js         # 只读世界模型（时间/敌对/掉落物/亮度）
│  ├─ survival\               # 自动吃、战斗、装备管理
│  ├─ tasks\                  # 砍树/挖矿/合成/庇护所/打猎/点灯/存箱
│  ├─ chat\commands.js        # 游戏内 `!` 指令 + 自然语言目标路由
│  ├─ web\statusServer.js     # 零依赖状态/控制 HTTP API
│  ├─ pcl\                    # PCL2 检测与启动
│  └─ server\serverManager.js # 服务器下载/启动/优雅停止
├─ scripts\                   # 运维脚本（见下）
├─ mod-bridge\                # Fabric 桥接 Mod（可选，见 §7）
└─ runtime\                   # 运行时产物：服务器、日志、agent-state.json
```

### 脚本一览

| 命令 | 作用 |
| --- | --- |
| `npm start` | 服务器 + Agent 一起跑 |
| `npm start -- --loader forge` | 用 **Forge 1.20.1-47.4.10** 专用服务器（已实测可启动） |
| `npm run agent` | 只跑 Agent（连已有服务器） |
| `npm run server:setup` | 只下载/配置服务器（`--loader forge` 则安装 Forge） |
| `npm run pcl:info` | 打印 PCL2 / Java / 版本探测结果 |
| `npm run pcl:client` | 用 PCL2 打开客户端 |
| `npm run selftest` | **离线**自检 153 项（模块图、插件版本、寻路、三原语、意图 Schema、工具白名单、回声过滤、死亡处理） |
| `npm run p0:verify` | **P0 全量验收（离线，约 20 秒）**：一次跑完下面 6 个套件 |
| `npm run path:test` | 寻路离线测试：空地/绕墙/水/台阶/死胡同/网格外/卡死 等 14 个场景 |
| `npm run tasks:test` | 三原语离线测试（MockBody）：砍树、挖矿、捡掉落物、背包满、够不着、人造方块 24 个场景 |
| `npm run llm:dry` | **不连游戏、不连网络**跑一遍意图路由与工具层：30 条语料 + 16 项 Schema + 22 项工具检查 |
| `npm run control:test` | 双通道 + 面板 + 死亡处理端到端（21 个场景） |
| `npm run plan:audit` | 把计划书 §11 的「做/不做」清单逐条对着代码验证（27 项，防止实现悄悄漂移） |
| `npm run client:test` | 控制 Mod 协议 26 项（假 Mod 服务器，不需要游戏） |
| `npm run inspect` | 进游戏采样周围方块/实体，排查「它为什么不干活」 |
| `npm run diagnose` | 单任务带完整仪表盘的诊断跑 |
| `npm run probe` | 单独测试 移动/挖掘/拾取/合成 四个原语 |
| `npm run bridge` / `bridge:state` | 查询 mod-bridge（未装 Mod 时优雅提示，退出码 0） |
| `npm run forge:test` | 手动验证 Forge 服务器安装+启动（用完即停，端口可指定） |
| `npm run inspect:server` | **连外部服务器前必备**：Ping + 加载器分析 + 登录可行性判定 |
| `npm run mods:report` | Mod 知识报告（签名分类、安全门、已学内容）；`--live` 可真实连服扫描 |
| `npm run agent:client` | 接真实 Forge 客户端跑（`panel: http://127.0.0.1:8766/panel`） |
| `node scripts/client-real.js --login <pw>` | 真机非破坏性自检（登录 + 寻路，不挖不建） |
| `node scripts/client-real.js --login <pw> --primitives` | **真机三原语验收**（会砍 1 个自然原木，见 `--chop-count`） |

P0 的完整实施状态与验收证据见 [`docs/P0-STATUS.md`](docs/P0-STATUS.md)，计划书见
[`docs/P0-PLAN.md`](docs/P0-PLAN.md)。

### 切换服务器（本地 / 外部联机）

```powershell
node src/index.js --profile simpfun          # 用 config/servers.json 里的命名 profile
node src/index.js --server mc.example.com:25565 --auth offline
node src/index.js --proxy socks5://127.0.0.1:1080
```

也可以走环境变量：`MC_ADDRESS` / `MC_AUTH` / `MC_PROXY` / `MC_USERNAME` / `MC_PROFILE`。
详细说明与 **Forge 服的硬限制**见 [`docs/EXTERNAL-SERVERS.md`](docs/EXTERNAL-SERVERS.md)。

---

## 6. 在游戏里指挥它（P0 的两条通道）

**通道 A：`!` 前缀 —— 确定性快路径。** Agent 轮询控制 Mod 的聊天缓冲（`GET /chatlog`），
只认 `!` 开头的行，其余一律忽略：

```
!help                 指令列表
!status               血量/饥饿/坐标/当前目标
!chop 8               砍 8 根原木（走过去 → 连挖树干 → 走过去捡掉落物）
!mine stone 8         挖 8 个石头（没镐会明确报「需要一把镐」，P0 不合成）
!goto 120 64 -300     用 A* 寻路走过去；走不过去会报原因（noPath / blocked / out-of-grid）
!collect              捡起附近的掉落物
!goal 砍32个木头       自然语言目标（中英双语正则）
!hunt 3 / !craft ... / !shelter / !light 6 / !store
!follow <玩家名> / !home / !stop / !pause / !resume / !inv / !where
```

**通道 B：`@猫娘 <自然语言>` —— 走大模型。** 例：`@猫娘 去砍点树`、`@猫娘 帮我挖点铁`。

```
你在聊天框打:  @猫娘 砍点树
  → Node 轮询到 → 剥掉触发词 → LLM 回合（或正则兜底）
  → 意图 JSON（严格枚举）→ 派发到与 `!` 相同的命令表 → 任务入队
  → Bot 回一句（纯反应式：你不问，它不说）
```

> 没有 API key / 请求超时 / 返回非法 JSON 时，**正则兜底路由器接管**，所以这两条通道
> 无论大模型是否可用都能工作。意图枚举里没有「执行服务器指令」这个类型，所以提示词注入无处可去。

**大模型的 6 个工具**（`src/llm/tools/`，计划 §5.3）：`observe` / `find_blocks` / `lookup_item`
（只读）与 `do_task` / `go_to` / `stop`（有副作用）。**刻意没有 `say` 工具**——
说话只能是「对玩家的回复」，所以自主发言在能力上就不存在。
把 `config/llm.json` 的 `toolCalling` 设为 `true`（需要 provider 支持原生工具调用）后，
模型可以先 `observe` 看清周围再决定，而不是凭空描述。

**两个你会想改的行为开关**（都在 `config/agent.json`）：

```jsonc
"survival": { "allowWoodChopping": false },  // 规划器不自己找树砍；显式 !chop 仍然有效
"safety":   { "avoidManMade": true }         // 不踩/不拆玩家造的东西；改 false 即完全关闭
```

**控制面板（唯一的「它听懂了吗」观察点）**：`http://127.0.0.1:8766/panel`

面板显示实时状态、当前任务与队列、**最近识别到的输入 → 路由结果**、以及死亡时的红色横幅
（含「恢复运行」按钮）。急停按钮走四级降级，并**诚实汇报每一级的实际结果**。

HTTP 也能下同样的指令（`priority` 可设为 `urgent` 抢占）：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8766/command `
  -ContentType 'application/json' -Body '{"command":"chop 8","priority":"directive"}'

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8766/emergency-stop   # 急停
Invoke-RestMethod -Uri http://127.0.0.1:8766/ui/state                      # 面板用的精简状态
Invoke-RestMethod -Uri http://127.0.0.1:8766/llm                           # 模型 / token / 最近回合
```

**死亡处理**：死亡会中止一切任务（`brain.stopped`，只有显式 resume 能解除）、在**游戏界面外**
三处告警（控制台红字 / 面板红条 / `runtime/agent-state.json`），并且**不会自动恢复**。
注意 P0 没有自动重生能力：如果客户端停在死亡画面，需要你手动点「重生」。

`config/server.json` 里 `allowCheats: true` 时控制台可用的 OP 指令：

```
op AgentSteve
time set day
gamerule doDaylightCycle false
```

---

## 7. mod-bridge（可选的服务端桥接 Mod）

`mod-bridge/` 是一个 **Fabric 1.20.1** Mod，装在**服务器**上后提供：

* `GET /health`、`GET /state`、`GET /players` —— 服务器权威状态（在线玩家、血量、饥饿、背包、时间、天气）
* `POST /command` —— 白名单化的服务端指令（`time`、`weather`、`give`、`tp`、`gamemode`、`say`），
  让 Agent 不用人工在控制台打字就能用 OP 能力
* 游戏内 `!!agent <文本>` → 转发给 Node Agent 的 `/command`

为什么用 Fabric 而不是 Forge：你现有的整合包是 Forge 1.20.1 且带了 150+ 个 Mod，
那些是**客户端** Mod（Create、Alex's Mobs、TACZ…），拿它们开专用服务器既重又容易崩。
Fabric 开发工具链更轻、服务端更稳，作为「Agent 的验证环境」更合适。
Mod 本身是**可选**的：不装它，Agent 也能完整工作（只是没有服务器权威状态）。

构建与安装见 `mod-bridge/README.md`。

---

## 8. 已知限制

* **联机（外部服务器）请先看 [`docs/EXTERNAL-SERVERS.md`](docs/EXTERNAL-SERVERS.md)**
  最重要的结论：**带客户端必需 Mod 的 Forge/NeoForge 服，mineflayer 进不去**
  （需要 FML2 客户端握手，原版协议做不到，社区库只支持 1.12 老握手）。
  原版 / Paper / Spigot / 纯服务端 Fabric 服都能正常连。
  先用 `npm run inspect:server` 确认目标服务器能不能连，再决定方案。
* **离线模式**：默认 `onlineMode: false`，方便本地跑。要接正版服务器就把 `config/server.json` 改成 `true`
  并把 `config/agent.json` 的 `bot.auth` 设为 `microsoft`（设备码登录，token 缓存在 `runtime/auth-cache`）。
* **代理**：`bot.proxy` 支持 `socks5://` / `socks4://` / `http://`，国内连外服常用。
* **Mod 知识是"签名推断"**：mineflayer 的注册表只有原版内容（1.20.1：1255 物品/1003 方块），
  没有标签数据可查，所以 Mod 内容靠命名签名分类，并且**未知方块默认不挖**（防止卡死在挖不动的方块上）。
  详见 `src/mods/knowledge.js` 与 `npm run mods:report`。
* **不吃原版以外的东西**：整合包里自定义的食物/工具需要 `config/mod-knowledge.json` 手工补，或依赖签名命中。
* **不擅长长距离探索**：没有做区块级地图记忆，走远了会重新探索。
* **交易、附魔、下界、末地**都还没实现——目前覆盖的是「第一天到铁器时代」的完整生存链路。
* **PCL2 是 GUI 程序**：本项目通过 `--launch <版本>` 调用它，不会去点它的界面。
  真正的无人值守服务器由本项目自己无头启动（见 §1）。

---

## 9. 自检

```powershell
npm run selftest
```

覆盖：25 个模块能否 require、10 个 mineflayer 包版本、`minecraft-data` 是否认识 1.20.1、
PCL2/Java/服务器 jar 探测、生存知识表（食物排序、木板替换、需镐方块）、7 个任务类能否构造、
任务超时是否生效、目标路由与配置。

一次真实的运行日志（节选）：

```
INFO (bot)  spawned at (-55.3, 83.0, 13.1) in overworld
INFO (brain) plan -> gather-wood: gather 8 logs
INFO (task:gather-wood) chopped 12 logs
INFO (brain) done gather-wood: collected 8 logs (1 trees)
INFO (brain) plan -> craft: craft 1x crafting_table
INFO (brain) done craft: crafted 1x crafting_table
INFO (brain) done craft: crafted 4x spruce_planks
INFO (brain) done craft: crafted 4x stick
```
