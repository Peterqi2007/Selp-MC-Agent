# mod-client 构建与安装

## 一、这个 Mod 是什么

`agent-client` 是一个 **Forge 1.20.1 客户端 Mod**。它跑在你 PCL 启动的那个真实客户端**内部**，
开一个只监听 `127.0.0.1` 的 HTTP 接口，让 Node agent 可以：

* **感知**：读结构化游戏状态（坐标、血量、背包、**附近方块图**、实体、时间）—— 不看截图、不用视觉模型，
  直接读游戏自己的对象。实测一次上报 **40817 个方块格子**，Mod 方块带真实注册表 id。
* **操作**：走游戏自己的 `MultiPlayerGameMode`（挖掘 / 放置 / 攻击 / 使用），不是伪造键鼠包。
* **讲话**：发聊天与**指令**，这正是 AuthMe `/login <your-password>` 的通道。

为什么必须这样做：Forge 1.20.1 服务器在登录阶段要 FML2 握手，mineflayer 只会原版协议，
所以只能"真的当一个 Forge 客户端"。

## 二、状态：已构建、已安装、已实测通过

| 部分 | 状态 |
| --- | --- |
| Java 源码（8 个文件） | OK |
| **编译出可加载的 jar** | **BUILD SUCCESSFUL**（含 `reobfJar` 重混淆） |
| 装进客户端并成功加载 | OK：152 个 Mod，无警告 |
| Node 侧 `src/body/clientModBody.js` | OK |
| **真机端到端验证** | **24/24**（含走路；挖掘单独验证通过） |
| 连真服 + AuthMe 登录 | **未做**（唯一剩下的） |

## 三、构建（可离线完成）

```powershell
cd "<repo>\mod-client"
.\gradlew.bat build              # 或 npm run client:build（内部带 --offline）
# 产物：mod-client\dist\agent-client-1.0.0.jar
cd .. ; npm run client:install   # 自动复制到客户端的版本隔离 mods 目录
```

### 依赖从哪来（国内镜像，无需 VPN）

上游仓库（`maven.minecraftforge.net`、`api.foojay.io`、`github.com/adoptium`）在本网络下**不可靠**。
已在 `build.gradle` / `settings.gradle` / `gradle-wrapper.properties` 里配置：

| 用途 | 镜像 | 实测 |
| --- | --- | --- |
| **Forge + Mojang 全家桶** | BMCLAPI `https://bmclapi2.bangbang93.com/maven/` | 可用，它同时镜像 Forge Maven **和** Mojang libraries |
| Maven 中央 | 阿里云 `https://maven.aliyun.com/repository/public` | 可用 |
| Gradle 本体 | 腾讯 `https://mirrors.cloud.tencent.com/gradle/` | 可用 |
| JDK | Adoptium API（已下好 Temurin 17） | 可用 |

> **踩坑记录**：阿里云**不**镜像 `net.minecraftforge`（404）；Lss233 镜像有 SSL 证书链问题（本机不可用）；
> 清华 Adoptium 镜像根路径 403。**BMCLAPI 是唯一同时覆盖 Forge 与 Mojang 的可用镜像。**

### JDK

Forge 1.20.1 要 Java 17。本机原本只有 21 和 25，已从 Adoptium 下载 **Temurin 17.0.20.1+1**
（182 MB，**SHA-256 已校验** `e53a79c3...`）解压到 `~/.gradle/jdks/temurin-17`，Gradle 自动发现。
`settings.gradle` 保留 foojay resolver 作为他机兜底。

## 四、会让 Mod 在运行时崩掉的坑（已修）

**`copyJar` 必须复制 `reobfJar` 的产物，不能复制 `jar` 的产物。**

Forge 生产运行时是 **SRG 命名**（`Minecraft.m_91087_()`，不是 `getInstance()`），
ForgeGradle 通过 `reobfJar` 产出重混淆后的 jar（落在 `build/reobfJar/output.jar`）。

早期版本把 `copyJar` 接到 `jar` 上，而它会在 `reobfJar` **之前**执行 ——
结果打出来的包**构建成功、装进游戏必然 `NoSuchMethodError`**。

反汇编对比确认：

| | SRG 引用 | 官方名引用 |
| --- | --- | --- |
| 修复前 `build/libs` | 0 | 有（`Minecraft.getInstance`） |
| 修复后 `dist/` | **79** | **0** |

## 五、安装位置（容易搞错）

客户端是**版本隔离**的，Mod 要放进**版本目录**，不是 `.minecraft\mods`：

```
C:\Users\<you>\AppData\Roaming\.minecraft\versions\1.20.1-Forge_47.4.10\mods\
  agent-client-1.0.0.jar
```

`npm run client:install` 自动处理（并删旧副本，避免加载到过期构建）。

## 六、接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活 + 版本 |
| GET | `/state` | 完整快照（含 `blocks.cells` 方块图） |
| GET | `/progress` | 连续动作进度（走路/挖掘是 tick 驱动的） |
| GET | `/chatlog?n=20` | 最近收到的聊天/指令反馈 |
| GET | `/chatlog/clear` | 清空聊天缓冲（测试用） |
| GET | `/diag/slash` | **实测** `sendCommand` 是否需要前导斜杠 |
| POST | `/command` | `{"command":"..."}` |

动作：`chat` `login` `register` `cmd` `say` `look` `lookat` `moveto` `dig` `place`
`use` `select` `drop` `attack` `stop` `resync`

## 七、关键实测结论：`sendCommand()` 不加斜杠

这是整个 AuthMe 方案的前提，**已用真机实测确认**：

```
普通形式   cmd=agentclientdiagprobe  -> 服务端回显 "agentclientdiagprobe"    （无斜杠）
带斜杠形式 cmd=/agentclientdiagprobe -> 服务端回显 "/agentclientdiagprobe"   （斜杠被原样发出）
```

**结论**：`ClientPacketListener.sendCommand()` **不会**自己补前导斜杠。

因此传 `/login pw` 时那个斜杠会被当字面字符发出去，命令无法识别。
Mod 与 agent 都**必须先剥掉前导斜杠**。`ClientActions.command()` 已这么做，
`ClientModBody.chat()` 保证 `/login pw` 与 `login pw` 两种写法都走同一条正确路径。

> **修正说明**：step-0 侦察报告**假设**了相反的行为。这次真机实测纠正了它 ——
> 这也正是当初把这个诊断端点做进 Mod 的原因。

## 八、另一个坑：`say` 需要 OP

真机测试时 `/say` 报"未知或不完整的命令"，一度看起来像命令通道坏了。实际是
**`say` 需要 OP**，未 OP 客户端会收到这条有误导性的报错。

验证命令通道请用 `me` / `help` / `list`（任何玩家都能用）：

```
help  -> 完整帮助文本
list  -> 当前共有1名玩家在线（最大玩家数为8）：AgentSteve
me    -> * AgentSteve waves
```

## 九、怎么跑

```powershell
npm run server:setup                # 本地测试服（首次）
# 启动本地服，或直接用真服
npm run client:launch               # 启动客户端，60-90 秒到世界
npm run client:check                # 确认控制接口起来
npm run client:verify               # 只读验证（24 项）
npm run client:verify -- --active   # 加上走路
npm run agent:client                # 用客户端躯体跑 agent（连 simpfun）
```

## 十、真机验证记录

证据文件：`runtime/client-verify.json`

```
1. attach
  PASS  attached to the live client - http://127.0.0.1:8899
2. perception
  PASS  block map (the vision replacement) is populated - 40817 cells
  PASS  blockAt() under the player returns a real block - minecraft:podzol
  PASS  blockAt() outside the scan returns null (no guessing)
3. actions
  PASS  chat log captured server feedback
  PASS  the command actually reached the server (its effect came back)
  PASS  vanilla commands reach the server and are answered - help:ok list:ok me:ok
4. command normalisation
  PASS  normalised form does NOT send a literal slash
  PASS  raw form DOES send a literal slash (proving the normalisation matters)
  PASS  both slash forms were dispatched identically
5. active test
  PASS  moveTo() walked to the target
live client verification: 24/24 checks passed
```

单独验证挖掘（`spruce_leaves` @ (-70,97,9)）：

```
block before dig: minecraft:spruce_leaves
dig() returned: true
block after dig : minecraft:air
```

## 十一、还没做的（唯一剩下的）

**真服登录未测。** 本地测试服没有 AuthMe，所以：

* 命令通道、斜杠处理、走路、挖掘 —— 全部已实测
* **AuthMe 密码流程本身未验证**

下一步：把客户端指向 `mc.example.com:25565`，进服后 AuthMe 会要求登录，然后

```powershell
curl.exe -X POST http://127.0.0.1:8899/command -H "content-type: application/json" -d "{\"command\":\"login <your-password>\"}"
curl.exe "http://127.0.0.1:8899/chatlog?n=10"
```

## 十二、🔴 硬性规则：绝对不要用 `/register`

**在这台服务器上 `/register` 会重置角色 —— 经验和物品全部消失。**

这不是"不推荐"，是**必须禁止**。项目里加了两道独立的闸门，都放在"危险就发不出去"的位置：

| 闸门 | 位置 | 作用 |
| --- | --- | --- |
| `ControlHttpServer.forbiddenCommand()` | HTTP 请求入口，**任何分发之前** | 递归剥掉最多 5 层 `cmd`/`command` 前缀和前导斜杠后再判定 |
| `ClientActions.forbiddenVerb()` | 命令真正发往网络的那一点 | 即使 HTTP 层被绕过也拦住 |
| `ClientModBody.isForbidden()` | Node 侧 | 第三道，防止 agent 代码误调 |
| `client-real.js --register` | 已**删除**该参数 | 传入直接 exit 2 |

### 为什么需要两道

第一版只拦了顶层动词，结果通用逃生通道直接绕过去了：

```
cmd /register <your-password>   ->  {"ok":true}        ← 漏了
服务器确认收到        ->  "Ты уже зарегистрирован!"
```

修正后实测（六条路径全部拦死，服务器侧完全没收到）：

```
register <your-password>      -> BLOCKED
/register <your-password>     -> BLOCKED
cmd register <your-password>  -> BLOCKED
cmd /register <your-password> -> BLOCKED
command reg x        -> BLOCKED
cmd cmd /register x  -> BLOCKED
```

拦完之后聊天栏里**只有 AuthMe 的登录提示**，没有任何命令被发出。

### 正确做法

```powershell
node scripts/client-real.js --login <your-password>      # 唯一正确的认证方式
```

实测服务端回复：`§aВход успешен!` / `§aДобро пожаловать!`（登录成功／欢迎）

### 如果账号确实没注册

**不要自己注册。** 让服主处理，或者换一个已注册的用户名。`client-real.js` 检测到"未注册"时会明确提示这一点，并且**不会**替你注册。
