# 联机游玩：把 Agent 部署在本地，加入外部服务器

本项目的 Agent 本体**完全跑在你本机**（Node.js + mineflayer），它只是一个"客户端"，
可以连到任何你连得上的服务器。这一节说明外部联机的配置，以及一个**必须提前知道**的硬限制。

---

## 1. 一句话结论（先看这个）

| 服务器类型 | mineflayer Agent 能否加入 | 原因 |
| --- | --- | --- |
| 原版服务器 / Paper / Spigot / Purpur | ✅ 可以 | 协议就是原版协议 |
| Fabric 服务器（只有服务端 Mod） | ✅ 通常可以 | Fabric 不强制客户端握手 |
| **Forge / NeoForge（有客户端必需 Mod）** | ❌ **不行** | 需要 FML 客户端握手，见 §4 |
| 你的 `mc.example.com:25565` | ❌ **不行** | 实测：`This server has mods that require Forge to be installed on the client` |

先用一条命令确认目标服务器到底能不能连（**不会登录、不会占用名额、不会触发风控**）：

```powershell
npm run inspect:server                       # 检查 config 里配置的服务器
npm run inspect:server -- --host mc.example.com --port 25565
```

它会做三件事：Server List Ping（MOTD/人数/协议号）、加载器特征分析（Forge/Fabric 提示、
Forge 的 Mod 列表）、以及一次可选的登录尝试，最后给出 `verdict`。

---

## 2. 改配置指向外部服务器

三种方式，任选其一。

### 方式 A：命名 profile（推荐，可切换多台服务器）

`config/servers.json`：

```json
{
  "profiles": {
    "local":   { "host": "127.0.0.1",        "port": 25565, "auth": "offline", "publicServerMode": false },
    "example": { "host": "mc.example.com",  "port": 25565, "auth": "offline", "publicServerMode": true }
  }
}
```

```powershell
node src/index.js --profile example
# 或
$env:MC_PROFILE='example'; npm run agent
```

### 方式 B：命令行直接指定

```powershell
node src/index.js --server mc.example.com:25565 --auth offline --username MyBot
node src/index.js --server 1.2.3.4:25565 --proxy socks5://127.0.0.1:1080
```

### 方式 C：环境变量

```powershell
$env:MC_ADDRESS='mc.example.com:25565'
$env:MC_AUTH='offline'      # 或 microsoft
$env:MC_PROXY='socks5://127.0.0.1:1080'
$env:MC_USERNAME='MyBot'
npm run agent
```

---

## 3. 正版服（online-mode=true）与代理

### 正版验证

公共服务器几乎都是 `online-mode=true`，离线用户名会被拒绝
（`Failed to verify username` / `Invalid session`）。这时必须用真实账号：

```json
{
  "bot": {
    "auth": "microsoft",
    "username": "you@example.com",
    "profilesFolder": "runtime/auth-cache"
  }
}
```

首次运行会在控制台打印一次设备码登录提示：

```
Microsoft login required:
  1. open https://www.microsoft.com/link
  2. enter code: XXXXXXXX
  3. the token is cached in runtime/auth-cache for next time
```

登录一次后 token 会缓存（`runtime/auth-cache`），后续启动不用再登。
API 接口（[`minecraft-protocol`](https://github.com/PrismarineJS/node-minecraft-protocol)）走的是
标准的 Microsoft OAuth 设备码流程。

### 代理

国内直连部分外服不稳，配置代理只需一行：

```json
{ "bot": { "proxy": "socks5://user:pass@127.0.0.1:1080" } }
```

支持 `socks5://`、`socks4://`、`http://`（HTTP CONNECT 隧道），也支持省略协议的
`host:port`（默认按 socks5 处理）。实现见 `src/core/network.js`。

---

## 4. ⚠️ Forge 硬限制（重要）

### 现象

你的服务器登录时直接被踢：

```
This server has mods that require Forge to be installed on the client.
Contact your server admin for more details.
```

### 原因

Forge 在 1.13 之后换了一套 **FML2 握手**协议：
服务端在登录阶段通过 `fml:handshake` 频道下发 Mod 列表，然后要求客户端
**回传注册表数据（RegistryData：方块、物品、实体、生物群系……）**。
只有当服务端所有"客户端必需"的 Mod 都能匹配上，才允许进入游戏。

* mineflayer 说的是**原版协议**，不会这套握手。
* 因此只要服务端有**任何一个标记为客户端必需的 Mod**，原版客户端（包括 mineflayer）就进不去。
* 这是**设计如此**，不是 bug，也不是配置能绕过的：Forge 无法把"带客户端 Mod 的服"降级成原版服。

### 社区现状

PrismarineJS 官方有一个 [`node-minecraft-protocol-forge`](https://github.com/PrismarineJS/node-minecraft-protocol-forge)，
但它只实现 **1.12 及更早的 `FML|HS` 老握手**，最后更新是 2022 年，
**不支持 1.13+ 的 FML2**。所以对 1.20.1 的 Forge 服无效。

### 可行的四条路

| 方案 | 做法 | 适用场景 |
| --- | --- | --- |
| **A. 换原版/Paper 服** | 让服主提供原版兼容入口，或自己开一个原版服 | 最省事，Agent 完整能力 |
| **B. 自己开服** | `npm start`（原版）或 `npm start -- --loader forge`（Forge 1.20.1-47.4.10，已实测可启动） | 想玩 Mod 又想让 Agent 玩 → **用 Forge 服务端 + 自己在 PCL 里装同一套 Mod** |
| **C. 人机混合** | 你用 PCL2 进服（Forge 客户端），Agent 留在本地服务器 | 你想和 Agent 一起玩但服务器是 Forge |
| **D. 半自动** | Agent 在你本地跑，通过 `mod-bridge` Mod 和你 PCL 里的客户端同服 | 需要 Fabric 服务端 |

**方案 B 的推荐姿势**（本项目已支持）：

```powershell
# 1. 用 Forge 开专用服务器（会自动下载安装 Forge 1.20.1-47.4.10）
node scripts/setup-server.js --loader forge

# 2. 启动服务器 + Agent
npm start -- --loader forge

# 3. 你在 PCL2 里装同一套 Mod，连 127.0.0.1 进去和 Agent 一起玩
npm run pcl:client
```

这样 Agent 跑的是**原版协议**（Forge 服务端对同版本原版客户端是宽容的，
只要服务端不强制客户端 Mod），你能用 Mod，Agent 也能干活。

> 注意：如果给这个 Forge 服务端装上"客户端必需"的 Mod，Agent 同样会被踢。
> 让 Agent 所在服务器的 `mods/` 只放**服务端 Mod**。

---

## 5. Agent 在外部服务器上的行为调整

公共服务器不是你家后院，`publicServerMode` 会调整行为（也可在 profile 里设）：

```json
{
  "behaviour": {
    "publicServerMode": true,
    "respondToChat": false,
    "autoFight": false,
    "maxChatPerMinute": 3
  }
}
```

* `respondToChat: false` —— 不在公屏回话，避免刷屏
* `autoFight: false` —— 不主动惹事，只逃跑
* 死亡保护见下节

### 死亡循环自动保护（safe mode）

记录显示，纯 vanilla 环境下 Agent 曾在夜里被僵尸连续击杀 26 次。现在加了保护：

* **4 分钟内死亡 ≥ 2 次** → 进入 **SAFE MODE**
* SAFE MODE 下：清空所有目标、**挖一个 1×3 竖井把自己封在地下**、不主动战斗
* 等到天亮且周围无敌对生物才退出

相关配置在 `config/agent.json` 的 `behaviour.fleeHealthThreshold`。

### 单实例锁

同名账号同时登录会被踢 `duplicate_login`，并触发 2 秒一次的重连风暴。
现在：

* `runtime/agent.lock` 保证本机只有一个 Agent 用这个用户名
* 真被踢 `duplicate_login` 时，退避 15s → 30s → …最多 120s
* 被 Forge 拒绝时**直接停止重连**并打印原因

---

## 6. Mod 知识（Agent 怎么理解 Mod 服）

即使连上了原版兼容的 Mod 服，Agent 也面临一个问题：
**mineflayer 的注册表只认识原版内容**（1.20.1：1255 物品 / 1003 方块）。
Mod 的方块和物品它从没见过，而且**没有办法向服务端查询它们的属性**。
代码见 `src/mods/knowledge.js`，三层策略：

### 1) 检测（DETECT）

从方块/物品命名空间、实体名、服务端 brand 判断加载器：

```
server type: forge (37 mod namespaces)
mods: Forge server with 37 mod namespace(s): vanilla knowledge still covers common blocks.
```

内置 30+ 常见 Mod 命名空间表（Create、AE2、Farmer's Delight、TACZ、Alex's Mobs、
Mekanism、FTB Chunks……），能给出中文/英文名与风险提示。

### 2) 学习（LEARN）+ 签名分类（CLASSIFY）

没有标签数据可用，所以按**命名签名**推断用途：

| 签名 | 判定 | 例子 |
| --- | --- | --- |
| `*_ore` | 矿石，可挖 | `thermal:tin_ore` |
| `*_ingot` / `*_dust` / `*_plate` | 材料 | `create:brass_ingot` |
| `roast_*` / `*_soup` / `cooked_*` | 食物 | `farmersdelight:roast_chicken` |
| `*_pickaxe` / `*_sword` | 工具 | `twilightforest:steeleaf_pickaxe` |
| `*_cogwheel` / `*_machine` | 机械部件 | `create:cogwheel` |

然后：**只有签名命中"普通方块"才允许挖**。否则拒绝——
因为把"不可破坏的科技方块"当成石头挖，会让机器人卡在无意义的挖掘循环里。

`config/mod-knowledge.json` 会持久化学到的东西，越玩越准。

### 3) 守住底线（SAFE）

* 未知方块默认**不挖**（可用 `survival.mineUnknownModBlocks: true` 强制开启）
* 未知食物不当作食物
* 检测到 `tacz/iceandfire` 之类战斗 Mod → 建议"跑而不是打"
* 检测到 `ftbchunks` 之类领地 Mod → 不去挖别人的地

查看当前认知：

```powershell
npm run mods:report            # 离线：签名分类 + 安全门 + 目标信息
npm run mods:report -- --live  # 额外真实连一次服务器并扫描注册表
npm run bridge                 # 若装了 mod-bridge，取服务端权威状态
```

HTTP 也能查（Agent 运行时）：`GET http://127.0.0.1:8766/mods`

---

## 7. 常见问题

**Q: 为什么不能用 `minecraft-protocol-forge`？**
A: 它只实现 1.12 及更早的 `FML|HS` 握手，1.13+ 的 FML2 没有实现，最后更新 2022 年。

**Q: 我可以直接在本机开 VPN/代理让 mineflayer 连 Forge 服吗？**
A: 不行。这不是网络问题，是**协议层握手**问题，代理改变不了。

**Q: 服务器显示 `1/20` 人，我的 Agent 进去会占名额吗？**
A: 会。`npm run inspect:server` 只做 Ping，不占名额；`npm run agent` 才真正登录。

**Q: 会被服务器判定为作弊/封号吗？**
A: 取决于服务器规则。建议：开 `publicServerMode`、关掉自动聊天、不要用 Agent 刷资源。
项目本身不做任何绕过反作弊的事（不注入、不改包、不伪装客户端指纹）。

**Q: 服务器版本不是 1.20.1 怎么办？**
A: 改 `bot.version`。`npm run inspect:server` 会打出协议号；
mineflayer 支持的版本见 `minecraft-data`。
