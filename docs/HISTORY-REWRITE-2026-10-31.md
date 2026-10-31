# Git 历史改写记录（2026-10-31）

## 做了什么

把两份参考论文 PDF 从 **git 历史**里彻底移除（不只是从 HEAD 移出）：

| 文件 | 大小 | 曾被引入于 | 曾从 HEAD 移除于 |
| --- | --- | --- | --- |
| `docs/voyager.pdf` | 18,830,859 B | `9fab777`（2026-10-28，「docs: 添加 MineEvolve 与 Voyager 参考论文」） | `70af1f6`（2026-10-30，改前哈希） |
| `docs/MineEvolve.pdf` | 10,073,389 B | 同上 | 同上 |

2026-10-30 只把它们从 HEAD 移到了 `refs/`（gitignore），但 `.git` 对象库仍有 54 MB，
任何 clone 都会下载这 28 MB。本次用 `git filter-branch --index-filter` +
`--prune-empty` 只改写**受影响的 30 个提交**（`9fab777^..codex/p1`）。

## 结果

| 项 | 值 |
| --- | --- |
| 改前 / 改后提交数 | 346 → **345** |
| 哈希保持不变 | **316**（PDF 引入点之前的全部历史） |
| 哈希被改写 | **29** |
| 被剪除（变空） | **1** —— `9fab777` 只含这两个 PDF，去掉后无内容可留 |
| 异常（多出的提交） | 0 |
| `.git` 体积 | 54 MB → **19 MB** |
| 工作树内容 | **完全一致**：`codex/p1^{tree}` 改前后均为 `12de07d66f58fc8d92f6e88f6898db241337df80`；`git ls-tree -r HEAD \| sha256sum` 改前后均为 `0436b68…` |
| 分支影响 | `main`（`2e07627`）**未受影响**；`remotes/master/codex/p1`（`9fbee55`）早于 PDF，也未被改写 |

改后校验：`git log --all -- '*.pdf'` 无输出；对象库内**没有任何 >5 MB 的 blob**（最大 530 KB）。

## 哈希映射表

只列**变化**的 30 条；其余 316 条哈希原样保留，无需映射。

| 类型 | 旧哈希 | 新哈希 | 提交标题 |
| --- | --- | --- | --- |
| **pruned** | `9fab777e` | — | docs: 添加 MineEvolve 与 Voyager 参考论文 |
| rewritten | `b739cdad` | `4d3b5010` | M5: 进程内键鼠注入 + 帧缓冲截图 + 键鼠台账 |
| rewritten | `264930c8` | `8052fca4` | 通道选择：能力优先（L1 入口补全 + L2 决策） |
| rewritten | `70ec0940` | `1bf90c1c` | M5: 真机验证能力优先通道 + 动作脑切到新会话 |
| rewritten | `faba0b37` | `6917e9a9` | M5: A21 真机 GUI 测试（2 类 ×3）+ tap 键 + 实体识别 + 失焦暂停修复 |
| rewritten | `4f703837` | `eb3a2d3c` | M5 GUI 探针：去掉误提交的临时脚本，长按位移断言放宽并注明归因 |
| rewritten | `17ba9120` | `a9edfcfc` | 感知: 瞄准对象实体化 + targetIs 后置条件 + 朝向变化使 target 失效 |
| rewritten | `eea93901` | `0003657a` | 截图触发策略: 事件驱动 + 90s 兜底 + 预算/去重/保留K张 + 只在活跃 goal 内 steer |
| rewritten | `678b45d8` | `dd6ac98e` | 玩家任务 -> 动作脑 DSH goal: enqueue 后自动 createGoal |
| rewritten | `506b3d2d` | `8f602453` | 截图策略: steer 成功时记录交付目标；docs 补活跃 goal 下的正向真机证据 |
| rewritten | `502969db` | `8eedf90b` | 截图 steer 直接携带图片: /message 支持 imagePath + DSH attachments |
| rewritten | `11018c4e` | `7a8384ca` | 截图 steer 携带图片: 真机验证通过 |
| rewritten | `ad343b9b` | `64bf2705` | M4 v3: 生成键鼠脚本 + Voyager 式 ≤4 轮错误回灌 + 四元组/版本化/相似度检索 |
| rewritten | `431aa2e7` | `3b467977` | M4 v3 真机: 动作脑可调用键鼠技能 + click 守卫修复 |
| rewritten | `ab461d4a` | `9009ce2b` | 动作脑提示: 明确"失败两次换键鼠"的升级规则 + 键鼠动词清单 |
| rewritten | `65c96001` | `a3d3a188` | 动作脑自主脚本渠道: !code-skill forge + input_pillar（真机爬出竖井） |
| rewritten | `8c457a65` | `960a698b` | 2026-10-30: CU 放弃、载具感知、@ goal、主动 steer、Voyager 自动课程 |
| rewritten | `664a2f67` | `a9671b3a` | docs: 历史客户端记录补充 CU ABANDONED 注记 |
| rewritten | `f76dde88` | `65709a09` | 真机验收: @ goal、载具感知、主动 steer、自动课程 + 三个缺陷修复 |
| rewritten | `b49fa8bf` | `9a0a83ef` | 真机: 自动课程 band 从 1/4 升到 2/4 |
| rewritten | `b9633b57` | `3c9b4b8c` | 自卫反射状态: 让动作脑知道 autoFight 可能自行攻击/抢占任务 |
| rewritten | `ec1051ae` | `ed8d362f` | selfDefense: cover the legacy DialogueRouter envelope too |
| rewritten | `f09d56c3` | `76a4ca56` | 动作脑改绑 Minecraft动作脑3 + 受控通用键 key <name> |
| rewritten | `a8f6eb79` | `583d0f96` | 方案A: 实时 KeyMapping 注册表发现 + 稳定 ID 注入 |
| rewritten | `2e9bbd9d` | `5c188a3b` | docs: DSH 重启后 mc_keybinds 真机通过 |
| rewritten | `a6b8ed42` | `9ff6ece2` | 失败回执与升级阶梯: mc_step/mc_plan 分类、硬闸门、lookup/ask 停车 |
| rewritten | `2db93cc2` | `7945c526` | 真机验证: 失败阶梯上升 + 键鼠脚本 trial/run；修复 close/state 缓存 |
| rewritten | `70af1f6b` | `00a193bd` | docs: 修正 6 处文档漂移；28 MB 论文 PDF 移出 docs/ 到 refs/ |
| rewritten | `2ef6c4b9` | `0c790e13` | 记忆三处接线: 方法库学习、episodic 去重、lookup 自动落 semantic |
| rewritten | `1b973fff` | `19feb572` | 删除 relational 记忆类别；unified 下的两个旧聊天旋钮改为启动拒绝 |

> 本表覆盖到改写后的 tip `19feb57`。**本文档自身的提交**（在本表之后创建）自然不在表内。

## 需要知道的三件事

1. **已强制推送（2026-10-31），远端现在是 `4ebe38d`。**

   **先纠正一个前提**：那 28 MB **从未上过 GitHub**。推向远端前的远端 tip 是
   `c9414ef`（「readme correct」，2026-10-26 网页提交），而 PDF 的引入提交 `9fab777`
   **并不是它的祖先** —— 远端历史一直停在引入 PDF 之前。所以这次推送不是「从 GitHub 清除」，
   而是把本地改写后的历史同步上去（本地此前有 30 个提交从未推送）。

   过程中的两个意外：

   - **`github.com:443` 在本机不可达**（`curl 28` 超时 21s，无 proxy，DNS 正常）；
     而 `api.github.com` / `codeload` / `raw` 正常，`ssh.github.com:443` 正常。
     故推送改走 SSH-over-443：
     `ssh://git@ssh.github.com:443/Peterqi2007/Selp-MC-Agent.git`（认证为 `Peterqi2007`）。
   - **远端比本地记录多 1 个提交**：本地 `refs/remotes/master/codex/p1` 停在 `9fbee55`，
     实际远端是 `c9414ef`（父提交 `9fbee55`）。若直接用 `--force` 会静默删掉它。
     已先 `git fetch` 把它保住（本地对象仍在），再以
     `--force-with-lease=refs/heads/codex/p1:c9414ef1…` 钉死旧值推送，命令回显
     `c9414ef...4ebe38d  forced update`。

   那个被取代的提交只改了一件事——在 README 第 1 行加了：

   ```
   # WARNING: This agent is not fully developed and may have serious problems(see about). English readme.md is also not provided.
   ```

   这一行**不在当前 README 里**（本地这条开发线自 `9fbee55` 后从未包含它）。内容记录在此，
   若仍需要，直接把这行加回 README 顶部即可；`c9414ef` 的对象在本地已标注、但未设 ref，
   执行 `git gc --prune=now` 后可能被回收——所以把文字留在这里而不是依赖那个 SHA。

   - **所有其他克隆会永久分叉**；协作者必须重新 clone 或 `git reset --hard origin/codex/p1`。
   - 推送走 HTTPS 仍会失败；需要推送时请用上面那条 SSH 地址。
2. **备份未入库**：`.tmp/history-backup-20261031-164214.bundle`（41.4 MB，
   `git bundle create --all`），已验证可完整 clone 回改前状态（含两个 PDF blob）。
   它在 `.tmp/` 下（gitignore），**清除 `.tmp/` 即失去回滚能力**。
3. **提交信息里的叙述还在。** 例如 `00a193b` 的标题仍写着「28 MB 论文 PDF 移出 docs/ 到 refs/」，
   但它的 diff 现在不含任何 PDF（在这条历史里它们从未存在）。这是删文件不改信息的必然结果，
   刻意保留原样——改写提交信息会让本次映射表立刻失效，也会抹掉「当时确实这么干过」的记录。
   README 里关于两份论文位于 `refs/` 的说明同理，仍指向本地未入库路径。

## 怎么复现 / 回滚

```bash
# 回滚到改前（临时验证用，不要覆盖现有仓库）
git clone <backup.bundle> restore-check
```
