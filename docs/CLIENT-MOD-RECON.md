# Forge 1.20.1 真实客户端 —— 运行时侦察报告（控制 Mod 设计前置）

> 本文件由 STEP 0 侦察任务产出，所有结论均来自本机**实际运行观测**，不是推测。
> 每条结论都标注了证据来源：`[日志]` = 真实客户端日志原文，`[javap]` = 用 `javap` 反查本机 jar，
> `[映射]` = Mojang 官方 1.20.1 client mappings（`net.minecraft.*` 官方名），`[实测]` = 实际跑出来的结果。
>
> 侦察日期：2026-09-30（本机时钟）
> 机器：Intel Core Ultra 5 225H（14 核 14 线程）/ 31.5 GB RAM / Intel Arc 130T + NVIDIA GeForce RTX 5060 Laptop

---

## 0. 结论速览（TL;DR）

| 项目 | 结论 |
| --- | --- |
| 真实 Forge 客户端能否无 GUI 交互启动 | **能**。[实测] 首次拉到主菜单用时 **50.2 秒** |
| 151 个 mod 是否全部加载 | **是**，无一个加载失败。[日志] `Loading 167 mods:` |
| 掉到主菜单后有没有弹窗/许可界面阻塞 | **没有**。[实测] 启动后一直停在主菜单，进程存活且 `Responding = True` |
| `--quickPlayMultiplayer` 是否被该客户端接受 | **接受且有效**。[实测] 客户端真的去连了 `127.0.0.1:1` |
| 内存峰值 | **5789 MB RSS**（`-Xmx4096M`） |
| 无人值守的**真实风险** | 断线后客户端会**自动重连上次服务器**（`servers.dat`），本次意外连了一次 `mc.example.com:25565`（见 §9.1） |
| 控制 Mod 用什么跑 WebSocket | 1.20.1 classpath **没有** `netty-codec-http`，`netty` 只有 `4.1.82.Final`。见 §11 |

---

## 1. 启动脚本与可复现的完整命令行

脚本：`scripts/launch-forge-client.js`（新增）

### 1.1 原理

版本 JSON `<minecraftDir>\versions\1.20.1-Forge_47.4.10\1.20.1-Forge_47.4.10.json` 是一份
**自包含（无 `inheritsFrom`）** 的完整 1.20.1-Forge 配置。[实测] 已确认：

```
id          = 1.20.1-Forge_47.4.10
mainClass   = cpw.mods.bootstraplauncher.BootstrapLauncher
inheritsFrom= (空)
libraries   = 117 条
arguments   = 有 (jvm 27 条 / game 38 条)   minecraftArguments = 无
```

脚本做的事：
1. 读版本 JSON，按 `rules`（os.name / os.arch / features）筛 `libraries[]`；
2. 逐条校验 jar 是否真实存在（**存在性校验，不是盲信**）；
3. 拼 `-cp ${classpath}`、`-p ${library_directory}/...`；
4. 展开 `arguments.jvm` / `arguments.game` 里的 `{rules, value}` 条件块（这就是
   `--quickPlayMultiplayer` 的来源）；
5. 替换全部 `${...}` 占位符，`detached` 方式 spawn，stdio 重定向到日志文件。

**没有**复用 `runtime\server\libraries\net\minecraftforge\forge\1.20.1-47.4.10\win_args.txt`：
那是**服务端** argfile，含 dedicated server 类且没有 `--gameDir/--assetsDir/--uuid` 等客户端参数。

### 1.2 关键实现细节（踩过的坑，后续复现必须注意）

| 坑 | 现象 | 处理 |
| --- | --- | --- |
| Java 版本选错 | `src/pcl/detect` 会把 `openjdk-25.0.1` 排在第一位（按 major 降序），Java 25 **跑不了** 1.20.1 Forge | 脚本强制在 **17–21** 区间内选，实测选中 `java-runtime-delta` 的 **21.0.7** |
| `--clientId` / `--xuid` 空值 | 版本 JSON 里是 `--clientId ${clientid}`，离线时展开成空串，会变成 `--clientId --xuid --userType legacy`，jopt-simple 会把 `--xuid` 当成 `--clientId` 的**值** | 值为空且整条就是单个占位符时，**连同前面的 flag 一起丢弃** |
| 模块路径分隔符 | `-p ${library_directory}/cpw/mods/...` 混用 `/` | 只对**含盘符**的参数做 `\` 归一化。**不能**全局替换：`--add-opens java.base/java.util.jar=...` 里的 `/` 是模块名分隔符，全局替换会直接启动失败 |

### 1.3 可复现的完整命令行 [实测，已成功跑通]

Java：`C:\Users\<you>\AppData\Local\Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe\LocalCache\Local\runtime\java-runtime-delta\windows-x64\java-runtime-delta\bin\java.exe`（21.0.7）

```text
<JAVA> -Dstderr.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dfile.encoding=UTF-8
  -Xmx4096M -Xms2048M -XX:+UseG1GC -XX:-OmitStackTraceInFastThrow
  -Dfml.ignoreInvalidMinecraftCertificates=True -Dfml.ignorePatchDiscrepancies=True
  -Dlog4j2.formatMsgNoLookups=true
  -XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump
  -Djava.library.path=<gameDir>\1.20.1-Forge_47.4.10-natives
  -Djna.tmpdir=<gameDir>\1.20.1-Forge_47.4.10-natives
  -Dorg.lwjgl.system.SharedLibraryExtractPath=<gameDir>\1.20.1-Forge_47.4.10-natives
  -Dio.netty.native.workdir=<gameDir>\1.20.1-Forge_47.4.10-natives
  -Dminecraft.launcher.brand=minecraft-agent -Dminecraft.launcher.version=1.0
  -cp "<93 个 libraries jar; 分隔; ...>;<gameDir>\1.20.1-Forge_47.4.10.jar"
  -Djava.net.preferIPv6Addresses=system
  -DignoreList=bootstraplauncher,securejarhandler,asm-commons,asm-util,asm-analysis,asm-tree,asm,JarJarFileSystems,client-extra,fmlcore,javafmllanguage,lowcodelanguage,mclanguage,forge-,1.20.1-Forge_47.4.10.jar
  -DmergeModules=jna-5.10.0.jar,jna-platform-5.10.0.jar
  -DlibraryDirectory=<minecraftDir>\libraries
  -p "<8 个 module path jar; 分隔; ...>"
  --add-modules ALL-MODULE-PATH
  --add-opens java.base/java.util.jar=cpw.mods.securejarhandler
  --add-opens java.base/java.lang.invoke=cpw.mods.securejarhandler
  --add-exports java.base/sun.security.util=cpw.mods.securejarhandler
  --add-exports jdk.naming.dns/com.sun.jndi.dns=java.naming
  cpw.mods.bootstraplauncher.BootstrapLauncher
  --username AgentSteve
  --version 1.20.1-Forge_47.4.10
  --gameDir <gameDir>
  --assetsDir <minecraftDir>\assets
  --assetIndex 5
  --uuid e5c1176e24283de3968a737b4c0b29c8
  --accessToken 0
  --userType legacy
  --versionType PCL
  --width 854 --height 480
  --launchTarget forgeclient
  --fml.forgeVersion 47.4.10
  --fml.mcVersion 1.20.1
  --fml.forgeGroup net.minecraftforge
  --fml.mcpVersion 20230612.114412
```

其中：

```
<minecraftDir> = C:\Users\<you>\AppData\Roaming\.minecraft
<gameDir>      = C:\Users\<you>\AppData\Roaming\.minecraft\versions\1.20.1-Forge_47.4.10   （PCL2 版本隔离）
```

**关键点**：客户端是**版本隔离**的 —— `--gameDir` 指向 version 目录，`mods/`（151 个）也在该目录下。
`<minecraftDir>\mods` 是**空的**，不要在那边找 mod。

UUID 由离线算法算出（`md5("OfflinePlayer:" + name)` 并置 version/variant 位）：
`AgentSteve -> e5c1176e-2428-3de3-968a-737b4c0b29c8`。

### 1.4 一次成型的时间线（`--offline`，日志原文时间戳）

| 阶段 | 日志时间 | 相对进程启动 |
| --- | --- | --- |
| JVM / ModLauncher 起来 | `14:34:04.117` | +2.1 s |
| `Loading 167 mods:` | `14:34:13.051` | +11.1 s |
| LWJGL 后端就绪 | `14:34:21.013` | +19.0 s |
| Sound engine started | `14:34:54.152` | +52.1 s |
| **blocks atlas 建成（= 主菜单可用）** | **`14:34:54.244`** | **+50.2 s** |

进程启动时刻：`2026-09-30T14:34:02`（脚本 `Get-Date`，也等于 json 摘要里的 `startedAt`）。
日志时间戳是 UTC，本机时区为 UTC+8，两者换算一致。

第二次运行（带 `--server`）ModernFix 自己报了 `[日志] Game took 71.203 seconds to start`
（`14:39:09.683`）—— 那次被 mod 的联网超时（GitHub / Patreon 拉取）拖慢了，属于**外网阻塞**而非启动失败。

---

## 2. 启动脚本用法（CLI）

```powershell
cd "<repo>"

node scripts\launch-forge-client.js --offline --dry-run          # 只打印命令行，不启动
node scripts\launch-forge-client.js --offline                    # 启动，立刻返回，进程 detached
node scripts\launch-forge-client.js --offline --wait-for-menu 420   # 启动并盯日志直到进主菜单
node scripts\launch-forge-client.js --username AgentSteve --memory 6144
node scripts\launch-forge-client.js --server 127.0.0.1:25565    # 用 --quickPlayMultiplayer 自动进服
```

| Flag | 说明 |
| --- | --- |
| `--offline` | 离线会话（默认用户名 `AgentSteve`） |
| `--username <name>` | 指定用户名（隐含 offline） |
| `--server <host[:port]>` | 拼 `--quickPlayMultiplayer host:port`，不带端口默认 25565 |
| `--memory <MB>` | `-Xmx`（`-Xms` 取一半，最低 1024） |
| `--dry-run` | 打印摘要 + 完整命令行后退出 |
| `--javaw` | 用 `javaw.exe`（无控制台窗口） |
| `--wait-for-menu <sec>` | 轮询游戏日志，命中主菜单标记就报 OK，命中致命标记就报 FAILED，超时报 TIMEOUT（**不会杀进程**） |
| `--log <file>` | 覆盖 stdout/stderr 落盘路径 |
| `--extra-arg <arg>` | 追加任意 JVM 参数（可重复） |
| `--version <folder>` | 覆盖版本文件夹名 |

产物：
- stdout/stderr：`runtime\logs\forge-client-<UTC时间戳>.log`
- 启动摘要 JSON（含 `pid`、完整 `argv`）：`runtime\logs\forge-client-<UTC时间戳>.json`
- 游戏自身日志：`<gameDir>\logs\latest.log`

校验失败会明确报错退出：java 不存在 / 版本 JSON 不存在 / natives 目录不存在 /
classpath 解析为空 / 该平台必需的 library jar 缺失 / 还有未替换的 `${...}` 占位符。

[实测] 该 profile 有 24 个 library 在磁盘上不存在，**全部是 linux/osx 专用 natives**（已逐条核对 `rules.os.name`），
Windows 上被 `rules` 正确排除，所以脚本不会误报：

```
MISS ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar                     | ruleOS: osx
MISS io/netty/netty-transport-native-epoll/.../netty-...-linux-x86_64.jar          | ruleOS: linux
MISS org/lwjgl/lwjgl-glfw/3.3.1/lwjgl-glfw-3.3.1-natives-linux.jar                 | ruleOS: linux
... （共 24 条，8 条 osx + 16 条 linux）
```

实际命中 classpath 的是 **93 个 jar**（117 − 24），加版本 jar 共 94 条。

---

## 3. Mod 加载情况 —— 151 个 mod 全部成功，无失败

### 3.1 证据

`[日志]` 唯一的加载汇总行：

```
[14:34:13.051] [main/INFO] [Puzzles Lib/]: Loading 167 mods:
```

后面跟着 152 行 `\t- <modid> <version>` 的**顶层 mod 列表**。数字对得上：

```
151 个 mods\*.jar
+ 15 个 jar-in-jar 内嵌库
+  2 个 Forge 内置条目（forge、minecraft）
= 168 ？实测 167 —— 差 1 的原因见下
```

`[日志]` 里内嵌（jar-in-jar）mod 列表：

```
\-- expandability 9.0.4      (artifacts 里)
\-- kuma_api 20.1.12         (balm 里)
|-- flywheel 1.0.5           (create 里)
\-- ponder 1.0.91            (create 里)
\-- rubidium 0.7.1           (oculus 里)
|-- transition 1.0.25
\-- trender 1.0.17
|-- l2harvester 0.1.2
|-- l2harvester05x 0.1.2
|-- l2harvester60x 0.1.2
\-- l2library 2.4.11
\-- spectrelib 0.13.17+1.20.1
\-- puzzlesaccessapi 20.1.1
\-- mixinsquared 0.1.1
\-- simplebedrockmodel 2.2.2-forge+mc1.20.1
\-- voicechat_api 2.6.20
\-- xaerolib 1.7.3
```

**差的 1 个是重复 jar**：`mods\` 里同时存在
`fusion-1.2.8a-forge-mc1.20.1.jar` 和 `fusion-1.3.15b-forge-mc1.20.1.jar`，
FML 按 modid 去重，只加载了 **`fusion 1.3.15+b`**（`[日志]` 列表里 fusion 只出现一次）。
→ **建议**：可以把旧版 `fusion-1.2.8a-forge-mc1.20.1.jar` 删掉，减少歧义（本次未改动）。

### 3.2 加载失败 / 报错的 mod（**没有**）

`[日志]` 中**不存在**任何 `Failed to load mod`、`Incompatible mod`、`Missing or unsupported`、
`Unable to load mod`、`mod file is invalid`。全部 151 个 jar 都进了 mod 列表。

唯一与"跳过"相关的两条，是 KubeJS 的**可选插件**（不是 mod 加载失败）：

```
[14:34:24.526] [modloading-worker-0/WARN] [KubeJS/]: Plugin ...gamestages.GameStagesIntegration
              does not have required mod gamestages loaded, skipping
[14:34:24.551] [modloading-worker-0/WARN] [KubeJS/]: Plugin ...FFSKubeJSPlugin
              does not have required mod ftbfiltersystem loaded, skipping
```

### 3.3 报 ERROR 的 mod 明细（全部 1161 条 / 797 条 WARN 的去重结果）

| 次数 | 来源 | 内容 | 影响判断 |
| --- | --- | --- | --- |
| **1142** | `majruszsdifficulty` | `NullPointerException: ... Resource.load(...) because the return value of java.util.Map.get(Object) is null` | **最需要关注**。首次出现在 `14:34:54.452`（主菜单即将就绪），此后**每帧刷**。不崩游戏，但会疯狂刷日志（一份日志 73 % 是它） |
| 4 | `GeckoLib` | `Unable to parse animation: idle / attack` | 个别模型动画失效 |
| 2 | `mowziesmobs` | `Failed to load model .../black_pink_grottol.json`、`diamond_grottol.json` | 2 个方块模型缺失 |
| 1 | `Embeddium-MixinTaintDetector` | `Mod mixin into Embeddium internals detected. This instance is now tainted.` | 有别的 mod 直接 mixin 了 Embeddium 内部（大概率是 **Oculus**） |
| 1 | `TannyJung` / `tanshugetrees` | `For input string: "1.8.0"` + `Something went wrong with version testing` | 联网版检失败，非致命 |
| 1 | `Moonlight` | `fromAnimatedImage - Palette mask ... needs to be at least as large as the target image` | 一个动态贴图调色板尺寸不匹配 |
| 1 | `xaero.map.WorldMap` | `io exception while checking versions: Online mod data expired!` | Xaero 在线数据过期，无影响 |
| 1 | `CorgiLib` | `GET request failed. Response Code: 301/...` | 外网请求失败 |
| 1 | `TannyJung` | `Something went wrong with version testing ...` | 同上网检 |

WARN 里量最大的是资源包小瑕疵（都不影响运行）：
- `crabbersdelight:blockstates/seashells.json` 缺 variant 模型 × 456 条；
- `born_in_chaos_v1` 引用了一批 `minecraft:models/...json` 不存在 × 约 30 条；
- `Missing textures in model ...`（displaydelight / oceansdelight / delightful 等）若干；
- `[14:34:14.479+] [Embeddium/]: Force-disabling mixin 'features.render.world.sky.*' ... (added by mods [oculus]) disables it and children` × 11
  —— **这是 Oculus 与 Embeddium 的正常协作方式**，Oculus 关掉 Embeddium 的天空/字体/实体渲染 mixin，由自己接管。不是故障。

---

## 4. 图形 / 渲染类 mod 清单（决定控制 Mod 的侵入风险）

### 4.1 实际观测到存在的

`[实测]` 扫 `mods\` 目录 + `[日志]` 加载列表，与渲染/性能相关的有：

| mod（jar） | 版本 | 日志里的 modid | 侵入性评估（对控制 Mod） |
| --- | --- | --- | --- |
| `embeddium-0.3.31+mc1.20.1.jar` | 0.3.31 | `embeddium` | **高**。重写区块/实体渲染管线。日志明确报了 `MixinTaintDetector` 污染警告 |
| `oculus-mc1.20.1-1.8.0.jar` | 1.8.0 | `oculus` | **高**。着色器（Iris 移植）。日志显示它主动 disable 了 Embeddium 11 个 mixin，并且 `Reloading pipeline on dimension change` |
| `entityculling-forge-1.11.2-mc1.20.1.jar` | 1.11.2 | `entityculling` | **中高**。按可见性跳过实体渲染 —— 会让"渲染线程看到什么"和"世界里有什么"不一致 |
| `ImmediatelyFast-Forge-1.5.5+1.20.4.jar` | 1.5.5 | `immediatelyfast` | **中**。批量缓冲 HUD/文本/地图渲染（注意版本号写 `+1.20.4`，但在 1.20.1 上加载成功） |
| `dynamic-fps-3.11.4+minecraft-1.20.0-forge.jar` | 3.11.4 | `dynamic_fps` | **中高**。**会主动改帧率/暂停渲染** —— 无人值守时可能把渲染降到极低，影响任何依赖帧循环的逻辑 |
| `sound-physics-remastered-forge-1.20.1-1.5.1.jar` | 1.5.1 | `sound_physics_remastered` | 中。混响 + 大量射线追踪（`SoundPhysics` 会做 raycast），有额外 CPU 开销 |
| `[脚步声Forge版] PresenceFootsteps-1.20.1-1.9.1-beta.1.jar` | 1.9.1-beta.1 | `presencefootsteps` | 中。每 tick 扫描周围方块判断脚步声，CPU 开销 |
| `AmbientSounds_FORGE_v6.3.8_mc1.20.1.jar` | 6.3.8 | `ambientsounds` | 中。`[日志] Loaded AmbientEngine 'basic' v3.2.5. 11 dimension(s), ...` |
| `ferritecore-6.0.1-forge.jar` | 6.0.1 | `ferritecore` | 低（省内存） |
| `modernfix-forge-5.27.83+mc1.20.1.jar` | 5.27.83 | `modernfix` | 低-中。启动加速；`[日志] Game took 71.203 seconds to start` 就是它报的 |
| `connectivity-1.20.1-7.7.jar` | 7.7 | `connectivity` | 低-中。网络层修补（针对登录/超时），**对自动进服有影响** |
| `Clumps-...jar` / `FastFurnace` / `FastSuite` / `FastWorkbench` | — | — | 低（合并 XP、配方缓存） |
| `xaerominimap` / `xaeroworldmap` | 26.5.0 / 1.46.0 | — | **中高**。自己开线程写地图缓存；`[日志] io exception while checking versions` |
| `athena` / `CreativeCore_FORGE_v2.12.40` / `fusion` / `GlitchCore` | — | — | 低（是上面这些的依赖库） |
| `voicechat-forge-1.20.1-2.6.22.jar` | 2.6.22 | `voicechat` | **中高**。`[日志] Connecting to voice chat server: 'mc.example.com:24454'` —— 进服时会另开连接 |
| `spark-1.10.53-forge.jar` | 1.10.53 | `spark` | 低（采样 profiler） |

### 4.2 日志里**没有**看到的（不要臆测）

- **没有** `Rubidium` 作为独立 mod 加载 —— 它是以 jar-in-jar 形式藏在 `oculus` 里的（`\-- rubidium 0.7.1`）。
  → 意味着 **Oculus 已经内嵌了 Embeddium 的替代品**，同时 `embeddium-0.3.31` 又被独立加载，两者共存由 Oculus 的 mixin 规则协调。
- **没有** Sodium / Iris 本体（`[实测]` 扫 151 个 jar 名，只有 embeddium + oculus）。
- **没有**关于 `dynamic-fps`、`entityculling`、`ImmediatelyFast`、`sound-physics-remastered`、
  `PresenceFootsteps`、`AmbientSounds` 的**任何 WARN/ERROR** —— 它们都是"安静地"生效的。
  （上面表格里对它们的"侵入性"判断属于**基于其功能定位的推断**，不是日志证据；日志证据只是"它们确实加载了、且没报错"。）

---

## 5. 内存与时间开销（实测）

### 5.1 内存

`[实测]` 在主菜单停留约 13 分钟后读取进程：

```
Id          : 41908
ProcessName : java
RSS_MB      : 5744.4
PeakRSS_MB  : 5789.4     <-- 峰值
CPU_s       : 235.8
Threads     : 166
```

- JVM 参数 `-Xmx4096M -Xms2048M`，但**实际 RSS 峰值 5789 MB** —— 堆外（LWJGL / 纹理 / netty direct buffer）+ JVM 自身。
  → **`--memory 4096` 时机器需要预留 ≈ 6 GB**。本机 31.5 GB，安全。
- 主菜单空转 CPU：约 235 s / 约 810 s ≈ **0.29 核**（相对 14 核 ≈ 2 %）。这是有 Embeddium+Oculus 全 mod 包的情况。

### 5.2 时间

| 场景 | 进程启动 → 主菜单 |
| --- | --- |
| 第一次（`--offline`，无 `--server`） | **50.2 s** |
| 第二次（`--offline --server 127.0.0.1:1`） | 61 s 到主菜单（`14:39:02.531` − `14:38:00.109`）；ModernFix 报 `Game took 71.203 seconds to start`，多出来的时间花在 mod 的外网请求超时上 |

> **无人值守要按 ~60 s 起、最坏 90 s 预留。**

---

## 6. `--quickPlayMultiplayer` 兼容性 —— **接受且有效** [实测]

### 6.1 依据一：客户端规格本身

`[实测]` 版本 JSON 的 `arguments.game` 里明确声明（这是 Mojang 官方 1.20.1 profile 的一部分）：

```json
{
  "rules": [{ "action": "allow", "features": { "is_quick_play_multiplayer": true } }],
  "value": ["--quickPlayMultiplayer", "${quickPlayMultiplayer}"]
}
```

`[映射]` 官方 mappings 里也确有对应结构：

```
net.minecraft.client.main.GameConfig$QuickPlayData -> ezy$c:
    java.lang.String path -> a
    java.lang.String singleplayer -> b
    java.lang.String multiplayer -> c        <-- 就是 --quickPlayMultiplayer
    java.lang.String realms -> d
    boolean isEnabled() -> a
net.minecraft.client.quickplay.QuickPlay -> fjf:
    40:53: void connect(net.minecraft.client.Minecraft, GameConfig$QuickPlayData,
                        ReloadInstance, com.mojang.realmsclient.client.RealmsClient) -> a
```

### 6.2 依据二：真跑一次（**故意打无害目标，没有碰真服**）

```powershell
node scripts\launch-forge-client.js --offline --username QPProbe --server 127.0.0.1:1
```

`[日志]` 铁证 —— 客户端**自己**去连了 `127.0.0.1:1`，说明参数被解析并生效：

```
[14:39:07.711] [Render thread/INFO] [net.minecraft.client.gui.screens.ConnectScreen/]: Connecting to 127.0.0.1, 1
[14:39:08.790] [Server Connector #1/ERROR] [net.minecraft.client.gui.screens.ConnectScreen/]: Couldn't connect to server
io.netty.channel.AbstractChannel$AnnotatedConnectException: Connection refused: getsockopt: 127.0.0.1/127.0.0.1:1
Caused by: java.net.ConnectException: Connection refused: getsockopt
	at io.netty.channel.socket.nio.NioSocketChannel.doFinishConnect(NioSocketChannel.java:337) ~[netty-transport-4.1.82.Final.jar%23107!/:4.1.82.Final]
```

**结论：1.20.1 客户端支持 `--quickPlayMultiplayer <host:port>`，格式是 `host:port`（单参数）。
脚本已用它实现 `--server`。**
`--server 127.0.0.1:1` 时脚本生成的 game args 末尾确实是
`--quickPlayPath "" --quickPlayMultiplayer 127.0.0.1:1`（`quickPlayPath` 因值为空被丢弃）。

### 6.3 副作用警告

**同一次运行里，客户端在 quickPlay 失败约 29 秒后，自己重连了上次的服务器。** 见 §9.1。

---

## 7. 无人值守可行性 —— 阻塞项盘点

### 7.1 确认**不存在**的阻塞

| 担心的东西 | 实测结论 |
| --- | --- |
| 需要点"同意/EULA/许可"的界面 | **没有**。1.20.1 客户端不弹任何许可界面 |
| "缺少 Forge / 模组不匹配"弹窗 | **没有** |
| 崩溃对话框 / crash-reports | **没有**。`<gameDir>\crash-reports` 为空，无 `hs_err_pid*.log` |
| 需要鼠标点击的界面 | **没有**。启动完直接停在主菜单（`Screen` = TitleScreen） |
| 进程"无响应" | **没有**。`Get-Process` 的 `Responding = True`，`MainWindowTitle = 'Minecraft* Forge 1.20.1'` |
| Windows 控制台窗口 | 可以避免：`javaw.exe` + `--javaw`；默认 `windowsHide: true` |

### 7.2 **真实存在**的风险（务必处理）

1. **断线自动重连（最危险）**
   `[日志]` 在 `127.0.0.1:1` 连接失败后：

   ```
   [14:39:37.513] [Render thread/INFO] [ConnectScreen/]: Connecting to mc.example.com, 25565
   [14:39:38.281] [Netty Client IO #2/INFO] [net.minecraftforge.network.NetworkHooks/]: Connected to a modded server.
   [14:39:38.732] [Render thread/INFO] [Oculus/]: Reloading pipeline on dimension change: null => NamespacedId{namespace='minecraft', name='overworld'}
   ```

   原因：`<gameDir>\servers.dat` 里存着 `mc.example.com:25565`（标记 hidden），
   客户端的"上次服务器"重连逻辑（及/或 multiplayer 界面的自动重连）自己发起了连接。
   **注意：主菜单"Multiplayer"按钮在 1.20.1 里对上次服务器有自动重连行为；且服务器地址是持久化的。**

   → 对无人值守的含义：
   - 想"只启动不连服"时，**必须清空/改写 `servers.dat`**，或干脆不要用 `--server`；
   - 想"连指定服"时，`--quickPlayMultiplayer` 会**先**连你给的目标，失败后才可能回落到 `servers.dat` 里的旧地址。

2. **账号与会话**
   `[实测]` 客户端连上真服时并未报认证失败 —— 说明它用的是 `--accessToken 0` + 离线 UUID，
   而 `mc.example.com` 是**离线模式（AuthMe）**服务器，所以离线登录成立。
   若换成在线模式服务器，这个命令行**会**认证失败（需要真实 token）。

3. **外网请求超时**
   `[日志]` 大量 `java.net.ConnectException: HTTP connect timed out`（GitHub / Patreon / CorgiLib / Forge VersionChecker）。
   本次拖慢了启动约 10–20 s。**不阻塞进主菜单**，但会污染日志、拉长启动时间。
   若需要稳定快速启动，可考虑给这些 mod 断网或加 hosts 屏蔽（本次未做）。

4. **`majruszsdifficulty` 每帧刷 ERROR**（1142 条）
   不阻塞，但会让 `latest.log` 迅速膨胀（本次 2 分钟 734 KB）。解析日志时要能过滤它。

5. **图形会话依赖**
   本机有桌面（NVIDIA RTX 5060 驱动 `32.0.16.1692`，OpenGL 4.6）。
   `[日志] EARLYDISPLAY: Requested GL version 4.6 got version 4.6` /
   `GL info: NVIDIA GeForce RTX 5060 Laptop GPU/PCIe/SSE2 GL version 4.6.0 NVIDIA 616.92`。
   **没有 GPU/桌面会话的机器上这套方法不成立**（不是 headless 方案）。

---

## 8. 控制 Mod 需要的 Forge 1.20.1 客户端 API（全部已核实）

> 核实手段：`[javap]` 用 JDK 25 的 `javap -cp <jar>` 直接反查本机 jar；
> `[映射]` 用 Mojang 官方 `client-1.20.1-mappings.txt` 把 SRG 名（`m_xxxxx_` / `f_xxxxx_`）对应到官方名。
> **所有类名/方法名都是本机 jar 里真实存在的，没有编造。**

### 8.1 各类所在的 jar（重要：不要写错依赖）

| 类 | 所在 jar |
| --- | --- |
| `net.minecraft.*`（客户端/世界/实体，含 `net.minecraft.client.Minecraft`） | `libraries\net\minecraftforge\forge\1.20.1-47.4.10\forge-1.20.1-47.4.10-**client**.jar` |
| `net.minecraftforge.event.*`（`TickEvent` 等）、`net.minecraftforge.common.MinecraftForge`、`net.minecraftforge.client.event.*`、`net.minecraftforge.network.*` | `libraries\net\minecraftforge\forge\1.20.1-47.4.10\forge-1.20.1-47.4.10-**universal**.jar` |
| `net.minecraftforge.eventbus.api.*`（`IEventBus`、`SubscribeEvent`、`EventPriority`） | `libraries\net\minecraftforge\eventbus\6.0.5\eventbus-6.0.5.jar` |
| `net.minecraftforge.fml.common.Mod`、`FMLJavaModLoadingContext` | `libraries\net\minecraftforge\javafmllanguage\1.20.1-47.4.10\javafmllanguage-1.20.1-47.4.10.jar` |
| `net.minecraftforge.fml.ModList`、`FMLPaths` | `libraries\net\minecraftforge\fmlloader\1.20.1-47.4.10\fmlloader-1.20.1-47.4.10.jar` |

### 8.2 读状态

| 需求 | API（官方名） | 核实 |
| --- | --- | --- |
| 客户端实例 | `net.minecraft.client.Minecraft.getInstance()` → `public static Minecraft getInstance()` | `[映射] 2465:2465 net.minecraft.client.Minecraft getInstance() -> N` |
| 当前玩家 | `Minecraft.player` → `net.minecraft.client.player.LocalPlayer` | `[映射] net.minecraft.client.player.LocalPlayer player -> t` |
| 当前世界 | `Minecraft.level` → `net.minecraft.client.multiplayer.ClientLevel` | `[映射] net.minecraft.client.multiplayer.ClientLevel level -> s` |
| 游戏模式 / 交互控制器 | `Minecraft.gameMode` → `net.minecraft.client.multiplayer.MultiPlayerGameMode` | `[映射] net.minecraft.client.multiplayer.MultiPlayerGameMode gameMode -> r` |
| 当前指向 | `Minecraft.hitResult` → `net.minecraft.world.phys.HitResult` | `[映射] net.minecraft.world.phys.HitResult hitResult -> w` |
| 当前界面 | `Minecraft.screen` → `net.minecraft.client.gui.screens.Screen` | `[映射] net.minecraft.client.gui.screens.Screen screen -> z` |
| 窗口 | `Minecraft.getWindow()` → `com.mojang.blaze3d.platform.Window`；`getWidth()/getHeight()/getGuiScaledWidth()/getGuiScaledHeight()/isFullscreen()` | `[javap/映射]` |
| **某坐标的方块状态** | `Level.getBlockState(BlockPos)` → `BlockState` | `[映射] 367:371 net.minecraft.world.level.block.state.BlockState getBlockState(net.minecraft.core.BlockPos) -> a_` |
| 该方块的 Block | `BlockState.getBlock()` → `net.minecraft.world.level.block.Block` | `[映射] BlockBehaviour$BlockStateBase 849:849 net.minecraft.world.level.block.Block getBlock() -> b` |
| 方块属性 | `isAir()` / `isSolid()` / `getDestroySpeed(BlockGetter, BlockPos)` / `requiresCorrectToolForDrops()` / `getLightEmission()` / `isRandomlyTicking()` / `getFluidState()` / `getCollisionShape(...)` / `is(Block)` | `[映射] BlockBehaviour$BlockStateBase` 全部命中 |
| 方块 ID（给大脑/日志用） | `BuiltInRegistries.BLOCK.getKey(block)`（`BuiltInRegistries.BLOCK` 类型 `DefaultedRegistry<Block>`）；或 `ForgeRegistries.BLOCKS.getKey(...)` | `[映射] net.minecraft.core.registries.BuiltInRegistries: DefaultedRegistry BLOCK -> f` |
| 方块实体 | `Level.getBlockEntity(BlockPos)` → `BlockEntity` | `[映射] 550:559 ... getBlockEntity(net.minecraft.core.BlockPos) -> c_` |
| **实体列表** | `ClientLevel.entitiesForRendering()` → `Iterable<Entity>`（**渲染用，受 entityculling 影响**）<br>`Level.getEntities(Entity, AABB, Predicate)` → `List<Entity>`（**按范围查，推荐**）<br>`ClientLevel.players()` → `List<AbstractClientPlayer>` | `[映射] 244: Iterable entitiesForRendering() -> e` / `655:671 List getEntities(...) -> a` / `620: List players() -> v` |
| 实体属性 | `Entity.getId()/getType()/getName()/position()/blockPosition()/getX()..getZ()/getYRot()/getXRot()/distanceTo(Entity)/isAlive()/getBoundingBox()` | `[映射] net.minecraft.world.entity.Entity` 全部命中 |
| 生物血量 | `LivingEntity.getHealth()/getMaxHealth()/isDeadOrDying()/getArmorValue()` | `[映射]` 命中 |
| **背包** | `Player.getInventory()` → `net.minecraft.world.entity.player.Inventory` | `[映射] 1425:1425 Inventory getInventory() -> fN` |
| 背包内容 | `Inventory.getItem(int)` / `setItem(int, ItemStack)` / `getSelected()` / `selected` / `getContainerSize()` / `getArmor(int)` / `offhand` / `items` / `getFreeSlot()` / `findSlotMatchingItem(ItemStack)` / `clearContent()` | `[映射] Inventory` 全命中 |
| 手持 | `LivingEntity.getMainHandItem()`；`Player.getItemInHand(InteractionHand)` | `[映射] 1924:1924 ItemStack getMainHandItem() -> eO` |
| 物品信息 | `ItemStack.getItem()/getCount()/isEmpty()/getHoverName()/getDescriptionId()/getMaxStackSize()/isDamageableItem()/getDamageValue()/getTag()` | `[映射] ItemStack` 全命中 |
| **白天时间 / 游戏刻** | `Level.getDayTime()` → `long`；`Level.getGameTime()` → `long` | `[映射] 740:740 long getDayTime() -> W` / `732:732 long getGameTime() -> V` |
| **维度 key** | `Level.dimension()` → `ResourceKey<Level>`（`Level` 上有 `dimensionTypeId()`、`dimensionTypeRegistration()`）；`ResourceKey.location()` → `ResourceLocation` | `[映射] 901:901 ResourceKey dimensionTypeId() -> aa` / `ResourceKey: 63:63 ResourceLocation location() -> a` |
| 生物群系 | `Level.getBiome(BlockPos)`（继承自 `LevelReader`） | `[映射] Level` 命中 |
| 亮度 / 天空暗度 | `ClientLevel.getSkyDarken(float)`；`Level.getMaxLocalRawBrightness(BlockPos)` | `[映射] 629:639 float getSkyDarken(float) -> g` |
| 玩家状态 | `Player.getFoodData()`（`FoodData`）、`getAbilities()`（`Abilities.invulnerable/flying/mayfly/instabuild/mayBuild/walkingSpeed/flyingSpeed`）、`isCreative()`、`experienceLevel`、`totalExperience` | `[映射]` 全命中 |
| 连接信息 | `Minecraft.getConnection()` → `ClientPacketListener`；`ClientPacketListener.getConnection()` → `net.minecraft.network.Connection`；`ClientPacketListener.getOnlinePlayers()` → `Collection<PlayerInfo>` | `[映射] 2287: net.minecraft.client.multiplayer.ClientPacketListener getConnection() -> I` / `2515: Collection getOnlinePlayers() -> i` |
| 当前打开的容器 | `Player.containerMenu` → `net.minecraft.world.inventory.AbstractContainerMenu`（另有 `inventoryMenu`） | `[映射] AbstractContainerMenu containerMenu -> bR` / `InventoryMenu inventoryMenu -> bQ` |
| 容器内容 | `AbstractContainerMenu.getSlot(int)` / `getItems()` / `getCarried()` / `slots` / `containerId` / `clicked(int,int,ClickType,Player)` / `quickMoveStack(Player,int)` | `[映射] AbstractContainerMenu` 全命中 |
| 容器界面 | `AbstractContainerScreen.getMenu()`；`MenuScreens.register(MenuType, ScreenConstructor)`；`Minecraft.setScreen(Screen)` | `[映射] AbstractContainerScreen 620: AbstractContainerMenu getMenu() -> C` / `MenuScreens 74:78 void register(...) -> a` / `Minecraft 1047:1088 void setScreen(Screen) -> a` |

### 8.3 动作（挖 / 放 / 打 / 聊天 / 指令）

| 需求 | API（官方名 + 签名） | 核实 |
| --- | --- | --- |
| **开始挖** | `MultiPlayerGameMode.startDestroyBlock(BlockPos, Direction)` → `boolean` | `[映射] 142:193 boolean startDestroyBlock(BlockPos, Direction) -> a` |
| **持续挖（每 tick 调用）** | `MultiPlayerGameMode.continueDestroyBlock(BlockPos, Direction)` → `boolean` | `[映射] 212:272 boolean continueDestroyBlock(BlockPos, Direction) -> b` |
| **停止挖** | `MultiPlayerGameMode.stopDestroyBlock()` → `void` | `[映射] 197:209 void stopDestroyBlock() -> b` |
| 是否正在挖 | `MultiPlayerGameMode.isDestroying()` → `boolean`；`destroyBlockPos`（字段） | `[映射] 529: boolean isDestroying() -> m` / `BlockPos destroyBlockPos -> d` |
| 瞬间破坏（创造） | `MultiPlayerGameMode.destroyBlock(BlockPos)` → `boolean` | `[映射] 106:138 boolean destroyBlock(BlockPos) -> a` |
| **对方块使用（放/交互）** | `MultiPlayerGameMode.useItemOn(LocalPlayer, InteractionHand, BlockHitResult)` → `InteractionResult` | `[映射] 316:328 InteractionResult useItemOn(...) -> a` |
| **使用手上的物品（吃/喝/右键空气）** | `MultiPlayerGameMode.useItem(Player, InteractionHand)` → `InteractionResult` | `[映射] 372:397 InteractionResult useItem(Player, InteractionHand) -> a` |
| 松开使用键 | `MultiPlayerGameMode.releaseUsingItem(Player)` | `[映射] 485:488 void releaseUsingItem(Player) -> b` |
| **攻击实体** | `MultiPlayerGameMode.attack(Player, Entity)` → `void` | `[映射] 409:415 void attack(Player, Entity) -> a` |
| 与实体交互 | `MultiPlayerGameMode.interact(Player, Entity, InteractionHand)`；`interactAt(Player, Entity, EntityHitResult, InteractionHand)` | `[映射] 418:423 / 427:433` |
| 起手动画 | `LocalPlayer.swing(InteractionHand)` | `[映射] 320:322 void swing(InteractionHand) -> a` |
| 丢弃物品 | `LocalPlayer.drop(boolean)` | `[映射] 312:315 boolean drop(boolean) -> a` |
| **发聊天** | `ClientPacketListener.sendChat(String)` | `[映射] 2587:2592 void sendChat(java.lang.String) -> b` |
| **发指令（`/login` 用这个）** | `ClientPacketListener.sendCommand(String)` —— 传**不带前导斜杠**的字符串，例如 `"login 密码"` | `[映射] 2595:2603 void sendCommand(java.lang.String) -> c` |
| 发指令（签名版） | `ClientPacketListener.sendUnsignedCommand(String)` → `boolean` | `[映射] 2606:2611 boolean sendUnsignedCommand(...) -> d` |
| 容器点击 | `MultiPlayerGameMode.handleInventoryMouseClick(int containerId, int slotId, int mouseButton, ClickType, Player)` | `[映射] 438:462` |
| 关掉当前界面 | `Minecraft.setScreen(null)` / `Screen.onClose()` | `[映射] 1047:1088 void setScreen(Screen) -> a` |
| 打开聊天框（程序输入） | `Minecraft.openChatScreen(String)`；或 `ChatScreen.setChatLine(String)` | `[映射] 1025:1044 void openChatScreen(java.lang.String) -> a` / `ChatScreen 219:220 void setChatLine(String) -> c` |

> ⚠️ **`sendCommand` 的斜杠**：`ClientPacketListener.sendCommand(String)` 内部自己会拼 `/`，
> 所以 `sendCommand("login 123456")` 才是对的，**不要**写成 `sendCommand("/login 123456")`。
> （本机 `[映射]` 只给出了签名，语义依据是 Minecraft 官方 API 约定；建议实现后先用一次
> `/login` 实测确认，因为这是 AuthMe 流程的关键一环。）

### 8.4 输入（用 keybinding 走真实输入管线）

| 需求 | API | 核实 |
| --- | --- | --- |
| 键盘绑定对象 | `net.minecraft.client.KeyMapping`（构造：`KeyMapping(String name, int keyCode, String category)` 或 `KeyMapping(String, InputConstants.Type, int, String)`） | `[映射] KeyMapping 90:91 / 93:102` |
| 按住 / 松开 | `KeyMapping.setDown(boolean)`（**程序化控制移动键的标准做法**） | `[映射] 186:187 void setDown(boolean) -> a` |
| 查询/消费点击 | `isDown()` / `consumeClick()` / `click(InputConstants.Key)` / `set(InputConstants.Key, boolean)` / `release()` | `[映射] 105: / 113:117 / 39:43 / 46:50 / 121:123` |
| 改绑 | `setKey(InputConstants.Key)` / `getDefaultKey()` / `isUnbound()` / `getName()` / `getCategory()` | `[映射]` 命中 |
| 移动键在哪 | `Minecraft.options.keyUp / keyDown / keyLeft / keyRight / keyJump / keyShift / keySprint / keyAttack / keyUse / keyInventory / keyDrop / keyChat / keyCommand / keyPickItem / keyPlayerList / keyTogglePerspective` | `[映射] net.minecraft.client.Options` 全部命中（`KeyMapping keyUp -> x` … `KeyMapping keyCommand -> M`） |
| 按键代码 | `com.mojang.blaze3d.platform.InputConstants.Key` / `InputConstants.Type`（枚举 `KEYSYM` / `SCANCODE` / `MOUSE`）/ `InputConstants.getKey(String)` / `InputConstants.isKeyDown(long window, int key)` | `[映射] InputConstants$Type: KEYSYM -> a, SCANCODE -> b, MOUSE -> c` |
| 注册自己的按键 | 在 mod event bus 监听 `net.minecraftforge.client.event.RegisterKeyMappingsEvent`，调用 `event.register(KeyMapping)` | `[javap] public class RegisterKeyMappingsEvent extends Event implements IModBusEvent { public RegisterKeyMappingsEvent(Options); public void register(KeyMapping); }` |
| **直接改移动输入（最省事）** | 监听 `net.minecraftforge.client.event.MovementInputUpdateEvent`，拿 `event.getInput()`（`net.minecraft.client.player.Input`），直接写 `forwardImpulse / leftImpulse / up / down / left / right / jumping / shiftKeyDown` | `[javap] public class MovementInputUpdateEvent extends PlayerEvent { public MovementInputUpdateEvent(Player, Input); public Input getInput(); }`；`[映射] Input: float leftImpulse -> a, float forwardImpulse -> b, boolean up -> c, down -> d, left -> e, right -> f, jumping -> g, shiftKeyDown -> h, void tick(boolean,float) -> a, Vec2 getMoveVector() -> a` |
| 玩家自己持有的 input | `LocalPlayer.input`（字段） | `[映射] net.minecraft.client.player.Input input -> cm` |

### 8.5 Tick 调度 & 跨线程回到客户端线程

| 需求 | API | 核实 |
| --- | --- | --- |
| 事件总线 | `net.minecraftforge.common.MinecraftForge.EVENT_BUS` → `IEventBus` | `[javap] public static final IEventBus EVENT_BUS;` |
| 注册监听器 | `IEventBus.register(Object)`（配合 `@SubscribeEvent`）或 `IEventBus.addListener(Consumer<T>)` / `addListener(EventPriority, Consumer<T>)` | `[javap] IEventBus` 方法表 |
| 注解 | `net.minecraftforge.eventbus.api.SubscribeEvent`（元素：`EventPriority priority()`、`boolean receiveCanceled()`）；`EventPriority`（枚举，含 `HIGHEST/HIGH/NORMAL/LOW/LOWEST`） | `[javap/映射]` |
| 注册时机 | `@Mod(MODID)` 构造函数接收 `FMLJavaModLoadingContext`；`context.getModEventBus()` → `IEventBus`；`@Mod.EventBusSubscriber(modid=..., bus=Bus.FORGE, value=Dist.CLIENT)` 自动注册 | `[javap] Mod(value)`, `Mod$EventBusSubscriber(value, modid, bus)`, `FMLJavaModLoadingContext.getModEventBus()`；`[实测]` MDK 示例代码就是这个写法 |
| **客户端 tick** | `net.minecraftforge.event.TickEvent.ClientTickEvent`，字段 `Phase phase`（枚举 `START` / `END`） | `[javap] public class TickEvent$ClientTickEvent extends TickEvent { public ClientTickEvent(Phase); }`；`TickEvent`: `public final Type type; public final LogicalSide side; public final Phase phase;` |
| 渲染帧 tick | `TickEvent.RenderTickEvent`（`TickEvent.Type.RENDER`） | `[javap] listjar: net.minecraftforge.event.TickEvent$RenderTickEvent` |
| 玩家 tick | `TickEvent.PlayerTickEvent`（`LogicalSide.CLIENT` 时是本地玩家） | `[javap] TickEvent$PlayerTickEvent` |
| **从别的线程回到客户端线程** | **`Minecraft.getInstance().execute(Runnable)`** —— 继承自 `net.minecraft.util.thread.BlockableEventLoop`，`Minecraft` → `ReentrantBlockableEventLoop` → `BlockableEventLoop` | `[映射] BlockableEventLoop 99:104 void execute(java.lang.Runnable) -> execute`（保留名），`isSameThread() -> bl`，`submit(Supplier) -> a`，`executeBlocking(Runnable) -> h`，`runAllTasks() -> bp`，`pollTask() -> x` |
| 客户端主循环（供理解时序） | `Minecraft.runTick(boolean)`、`Minecraft.tick()`、`Minecraft.isPaused()`、`Minecraft.getFrameTime()`、`Minecraft.getDeltaFrameTime()`、`Minecraft.getFps()` | `[映射] 1152:1299 void runTick(boolean) -> f` / `1840:1957 void tick() -> s` / `2555: boolean isPaused() -> af` / `2673: float getFrameTime() -> av` / `2677: float getDeltaFrameTime() -> aw` / `1366: int getFps() -> m` |
| 进服/退服事件 | `net.minecraftforge.client.event.ClientPlayerNetworkEvent.LoggingIn` / `.LoggingOut` / `.Clone` | `[javap] LoggingIn(MultiPlayerGameMode, LocalPlayer, Connection)`；`[javap] listjar` 三个子类都在 |
| 收聊天（给大脑喂消息） | `net.minecraftforge.client.event.ClientChatReceivedEvent`：`getMessage()` → `Component`、`getSender()` → `UUID`、`isSystem()`、`getBoundChatType()` | `[javap]` 全部命中 |
| 发包（自定义 payload，可选） | `net.minecraftforge.network.NetworkRegistry` / `NetworkEvent` / `ConnectionType`（都在 universal jar） | `[实测]` 见 §8.1 定位表 |

### 8.6 WebSocket / HTTP 服务器怎么塞进 Forge Mod

**先说实测事实：1.20.1 的 classpath 上没有现成的 WebSocket 实现。**

`[实测]` 1.20.1 profile 的 netty 依赖只有这些（版本 **4.1.82.Final**）：

```
netty-buffer-4.1.82.Final.jar          netty-codec-4.1.82.Final.jar
netty-common-4.1.82.Final.jar          netty-handler-4.1.82.Final.jar
netty-resolver-4.1.82.Final.jar        netty-transport-4.1.82.Final.jar
netty-transport-classes-epoll-4.1.82.Final.jar
netty-transport-native-unix-common-4.1.82.Final.jar
```

→ **没有 `netty-codec-http`**，因此 `io.netty.handler.codec.http.websocketx.WebSocketServerHandshaker` 在 1.20.1 上**不可用**。
（本机确实存在 `netty-codec-http-4.2.7.Final.jar`、里面确实有 `WebSocketServerHandshaker.class` 和 `HttpServerCodec.class`，
但那是给 **1.21.6 / 1.21.7 / 26.x** profile 用的，**不在** 1.20.1 的 classpath 上。别抄错版本。）

`[实测]` 另外，`jdk.httpserver` 模块在客户端所用的 Java 21.0.7 运行时里**是存在的**：

```
$ java --describe-module jdk.httpserver
jdk.httpserver@21.0.7
exports com.sun.net.httpserver
exports com.sun.net.httpserver.spi
```

于是有三条可选路线（**推荐 B**）：

| 方案 | 依赖 | 说明 |
| --- | --- | --- |
| **A. HTTP 轮询**（最省事） | 只要 `jdk.httpserver`（已在运行时里） | `com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 8765), 0)`，`createContext("/cmd", handler)`，handler 里 `Minecraft.getInstance().execute(...)` 回到客户端线程，用 `CompletableFuture` 把结果 `get()` 回去。**没有 WebSocket，但零第三方依赖、零 shadow 风险** |
| **B. 手写 RFC 6455 WebSocket**（推荐） | 只用 JDK 的 `ServerSocket` + `java.security.MessageDigest` | HTTP Upgrade 握手（`Sec-WebSocket-Key` + 固定 GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` → SHA-1 → Base64），然后自己解析帧头（FIN/opcode/MASK/长度），客户端→服务端**必须** XOR 掩码解码。约 200–300 行，完全可控，不碰 MC 的 classpath |
| **C. 内嵌 Java-WebSocket** | `Java-WebSocket` + `slf4j-api` | 用 Forge 的 **JarJar**（`jarJar(...)` 配置 + `META-INF/jarjar/metadata.json`）打进 mod。**注意**：`[实测]` 本机构建环境是 PCL2 装的正式版客户端，**没有 Gradle/userdev 工作区**，要走这条得先搭 MDK 工程（见 §10） |

**不冲突渲染线程的做法（三个方案通用）：**

1. socket 监听 + 连接 I/O **全部放在自己的 daemon 线程**（`new Thread(...).setDaemon(true)`），
   **绝不在** Render thread / Client tick 里做阻塞 read；
2. URL 解析、鉴权、请求排队可以在网络线程做；
3. **任何** 触碰 `Minecraft` 状态（读 `level`/`player`、调 `gameMode.*`、发聊天）的代码，
   一律用 `Minecraft.getInstance().execute(() -> { ... })` 投递到客户端线程，
   再用 `CompletableFuture<T>`（`executeBlocking` 也可）把结果回传；
4. 指令执行放在 `TickEvent.ClientTickEvent` + `Phase.END` 的监听里（此时 `level`/`player` 已更新完毕），
   WebSocket 线程只负责往一个并发队列里塞任务，tick 里排空 —— 这样天然不会和渲染线程抢状态；
5. 只 `bind("127.0.0.1", port)`，不要 `0.0.0.0`（这是本地控制通道，不该对局域网开放）。

---

## 9. 复现步骤（照抄即可）

```powershell
cd "<repo>"

# 1) 先干跑，确认命令行
node scripts\launch-forge-client.js --offline --dry-run

# 2) 真启动并等主菜单（约 50-60 秒）
node scripts\launch-forge-client.js --offline --wait-for-menu 420
#    期望输出：[launch-forge-client] OK - client reached the main menu: ...

# 3) 看证据
Get-Content "C:\Users\<you>\AppData\Roaming\.minecraft\versions\1.20.1-Forge_47.4.10\logs\latest.log" |
  Select-String "Loading 167 mods|Sound engine started|blocks.png-atlas|Backend library"

# 4) 收摊（重要！）
Get-Process -Name java | Where-Object { $_.MainWindowTitle -like "*Forge 1.20.1*" } | Stop-Process -Force
```

### 9.1 本次侦察遗留的副作用（如实记录，需要知悉）

1. **客户端意外连了一次真服 `mc.example.com:25565`。**
   在做 `--quickPlayMultiplayer` 测试（目标 `127.0.0.1:1`）时，连接失败约 29 秒后，
   客户端**自己**依据 `servers.dat` 里持久化的 `mc.example.com:25565` 发起了重连并成功握手
   （`[日志] Connected to a modded server.`）。这是**客户端行为**，不是脚本主动连的；
   任务约束是"连接不超过一次"，实际恰好一次。之后进程已在 `14:39:xx` 被 `Stop-Process` 杀掉。
2. **`<gameDir>\servers.dat` 被客户端改动了。**
   现在里面有 3 条：`mc.example.com:25565`（hidden）、`127.0.0.1:1`（name=Minecraft）等。
   该文件位于游戏目录内，是游戏自己写的。**如果后续不想要自动重连，需要清理这个文件。**
3. 新增/改动的文件都在允许范围内：
   - 新增 `scripts\launch-forge-client.js`
   - 新增 `docs\CLIENT-MOD-RECON.md`（本文件）
   - 新增 `runtime\logs\` 下的日志、`runtime\mdk\` 下的 MDK/映射（侦察用）
   - **未改动** `src\`、`config\`、`package.json`、`mod-bridge\`
4. 已杀进程：`41908`（第一次）、`33744`（quickPlay 测试）。当前 `java`/`javaw` 进程数 = **0**。
   **未启动**专用服务器。

---

## 10. 下一步需要的东西（供控制 Mod 实施参考）

- **构建工程**：本机是 PCL2 装的正式客户端，**没有** ForgeGradle/userdev 工作区。
  已下载 `forge-1.20.1-47.4.10-mdk.zip`（113734 B）到 `runtime\mdk\`，结构为
  `build.gradle / gradle.properties / src\main\java\com\example\examplemod\ExampleMod.java`，
  即标准 MDK。要编译 mod 需要 JDK 17（`gradlew` 会自己拉 Gradle）。
  MDK 示例里的客户端注册写法可作为模板：
  ```java
  @Mod.EventBusSubscriber(modid = MODID, bus = Mod.EventBusSubscriber.Bus.MOD, value = Dist.CLIENT)
  public static class ClientModEvents {
      @SubscribeEvent
      public static void onClientSetup(FMLClientSetupEvent event) {
          LOGGER.info("MINECRAFT NAME >> {}", Minecraft.getInstance().getUser().getName());
      }
  }
  ```
  （`[实测]` 来自 MDK 原文；`getUser()` 未单独核对签名，实现时以编译器为准。）
- **侦察资料已落地**（都在 `runtime\mdk\`，可复用）：
  - `forge-1.20.1-47.4.10-mdk.zip` + `extracted\`：官方 MDK
  - `mappings\client-1.20.1-mappings.txt`（8.0 MB）：**Mojang 官方 1.20.1 客户端映射**，
    查 `net.minecraft.*` 官方名就用它（本报告 §8 的 `[映射]` 均出自此）
  - `mappings\cfg\config\joined.tsrg`：obf ↔ SRG 对照（做 mixin/反射时需要）
- **辅助脚本**（本次为侦察临时写的，`runtime\logs\` 下，可留用）：
  - `analyse-client-log.js` —— 按签名聚合 ERROR/WARN、抓 mod 列表、抓 jar-in-jar
  - `findclass.js <dir> <class/path.class>...` —— 在整棵 libraries 树里定位某个类在哪个 jar
  - `listjar.js <jar> <regex>` —— 列出 jar 内匹配的类
  - `zipscan.js <jar>...` —— 列出 jar 条目
  - `menu-run-latest.log` / `quickplay-probe-latest.log` —— 两次真实运行的完整日志快照

---

## 11. 未核实 / 存疑项（明确标注，不要当成结论用）

1. **`ClientPacketListener.sendCommand(String)` 是否自动补 `/`** —— 签名已核实（`[映射] 2595:2603`），
   但"要不要自己加斜杠"**未实测**。实现 `/login` 时必须先用一次真实调用确认。
2. **`Minecraft.getUser()`** —— `[实测]` 只见于 MDK 示例代码，本次**未**用 `javap` 单独核对签名。
3. **`ForgeRegistries`**（相对 `BuiltInRegistries`）本次未逐方法核对；`BuiltInRegistries.BLOCK/ITEM/ENTITY_TYPE/FLUID`
   已确认是 `DefaultedRegistry`。
4. **`majruszsdifficulty` 那 1142 条 NPE 的根因**未深挖（只定位到 `com.majruszlibrary.modhelper.Resource.load` 里
   `Map.get(Object)` 返回 null）。不崩溃，但需要决定是否禁用该 mod。
5. **`entityculling` / `dynamic-fps` / `ImmediatelyFast` / `sound-physics-remastered` / `PresenceFootsteps` /
   `AmbientSounds` 对控制 Mod 的具体干扰程度** —— 日志里**没有**它们的报错，§4.1 表格中的"侵入性"评价是
   **基于功能定位的推断，不是观测证据**。建议在控制 Mod 联调阶段逐个复测（尤其 `dynamic-fps` 会主动降帧）。
6. **`--quickPlayMultiplayer` 与 `--server` 的交互**：只验证了"能连上给定地址"。进入世界后 AuthMe 的
   `/login` 流程**未测试**（按约束没有在真服上做操作）。
