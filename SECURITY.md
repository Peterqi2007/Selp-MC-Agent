# 安全策略 / Security

这个仓库是**公开的**：任何一次 `git commit` 都会永久留在历史里（push 之后连 force-push 都删不干净，
fork 会保留副本）。所以凭据只走环境变量或未入库的本地文件。

## 1. 凭据放在哪里

### 方式 A：本机覆盖文件（推荐——一键流程完全不变）

在 `config/` 下放一个 `*.local.json`，形状和被覆盖的文件一样，启动时自动合并上去：

```
config/agent.local.json   ->  覆盖 config/agent.json
config/llm.local.json     ->  覆盖 config/llm.json
config/pcl.local.json     ->  覆盖 config/pcl.json
config/server.local.json  ->  覆盖 config/server.json
```

`.gitignore` 里的 `config/*.local.json` 已经把这类文件全部排除，`git status` 里看不到它们。
本机示例（`config/agent.local.json`）：

```json
{
  "bot": {
    "host": "your-server.example",
    "port": 25565,
    "authme": { "password": "<your-login-password>" }
  }
}
```

这样 `start.ps1` / `npm run agent` 照旧自动登录，一个字母都不用改；入库的
`config/agent.json` 里 `bot.authme.password` 永远是 `null`、host 永远是安全默认值。

### 方式 B：环境变量（CI / 临时切换用）

| 环境变量 | 用途 | 读取位置 |
| --- | --- | --- |
| `LLM_API_KEY` | 大模型 API key（`OPENAI_API_KEY` 是后备名） | `src/llm/index.js` |
| `OPENAI_BASE_URL` | OpenAI 兼容端点，例如 `https://api.deepseek.com` | `src/llm/index.js` |
| `MC_AUTHME_PASSWORD` | 游戏内 AuthMe `/login` 密码 | `src/util/config.js` |
| `MC_HOST` / `MC_PORT` / `MC_ADDRESS` | 服务器地址（覆盖 `config/servers.json` 的档位） | `src/util/config.js` |
| `MC_USERNAME` / `MC_AUTH` / `MC_VERSION` / `MC_PROXY` | 其余联机字段 | `src/util/config.js` |
| `MC_PROFILE` | 选 `config/servers.json` 里的档位（`local` / `example`） | `src/util/config.js` |

优先级：**环境变量 > `*.local.json` > 入库的 `*.json` > 代码默认值**。所以临时跑一次别的服务器，
用 `MC_ADDRESS` 就行，不用改任何文件。

```powershell
$env:LLM_API_KEY        = 'sk-...'
$env:MC_AUTHME_PASSWORD = '...'
$env:MC_ADDRESS         = 'your-server.example:25565'
```

`config/agent.json` 里 `bot.authme.password` 保持 `null`，`config/llm.json` 里 `apiKey` 保持空字符串。
两者都有注释说明为什么——不要让它们变成"临时填一下也没事"的字段。

## 2. 不要提交的东西

- `config/llm.json` 的 `apiKey`、`config/agent.json` 的 `bot.authme.password`
- `config/servers.json` 里真实服务器地址（用 `example` 档位做模板，自己的地址用 `MC_ADDRESS` 传）
- 作者本机的绝对路径（`C:\Users\<name>\...`）——这是 PII，不是配置；需要时用 `%LOCALAPPDATA%` / `process.env` 拼
- `runtime/`（日志与 trace 里有请求头）、`logs/`、`ui.json`、`mod-bridge/verify/cp.txt`

`.gitignore` 已经覆盖 `.env`、`config/*.local.json`、`*.secrets.json` 等常见落点。

## 3. 提交前自查

```powershell
npm run secrets:scan            # 扫工作区（快）
npm run secrets:scan:history    # 扫所有 ref 可达的 blob（慢，发布前必跑）
```

命中即非零退出。规则集故意窄：只认「`sk-` / `ghp_` / `AKIA` / `xox` 形态的 key、私钥块、
被赋了字面值的 password/token/apikey、带账号密码的 URL」；占位符（`null`、`<your-password>`、
`${VAR}`、`test-key` 等）会放过。

建议再开 GitHub 的 **secret scanning + push protection**（仓库 Settings → Code security），
它挡的是 GitHub 认得的那几十种 key，和本地扫描互补。

## 4. 本仓库做过的历史清理（2026-10-26）

首次公开前，仓库前 306 个提交里带着四类数据，全部已用 `git filter-repo` 从**每一个 blob**中替换掉：

| 原值 | 替换为 | 曾出现在 |
| --- | --- | --- |
| DeepSeek API key `sk-…`（已吊销） | 空字符串 | `config/llm.json` |
| AuthMe 登录密码 | `<your-password>` | `config/agent.json` + 7 个脚本/文档 |
| 服务器地址与语音服地址 | `mc.example.com` / `mc.example.com:24454` | 32 个文件 |
| 作者本机路径 | `<repo>` / `C:\Users\<you>` | 10 个文件 |

代价：**所有 commit SHA 都变了**（文档里引用的短 SHA 如 `513bf33` 已失效），`.git` 重新打包。
已吊销的 key / 改过的密码不在本仓库任何地方——但**重写历史不等于撤回**，旧值该轮换还是要轮换。

如果之后再发现疑似泄漏，顺序永远是：**先吊销/改密码，再清理历史**。反了没有意义。

## 5. 报告问题

发现本仓库仍残留凭据、或代码里有安全问题，请开 issue 或私下联系维护者，不要先公开细节。
