# 采矿掉落物收集方案：常规宏与 LLM 接管共用的拾取闭环

> 日期：2026-10-10。状态：**待实施方案**；以代码提交 `f08c525` 为分析基线，本文件新增不代表代码已修改或测试已通过。
> 配套：[`MINING-LLM-PLAN.md`](MINING-LLM-PLAN.md)。本文是采矿收集目标、入包证据、接近策略和验收的单一来源；
> LLM 接管的触发、调用频率、预算和控制权以配套文档为准。
> 范围：同步修正常规 `mine_ore` 与 LLM 块级采矿；不建设全部采矿的统一行动计划，不重写钓鱼/农作收集逻辑。

## 一、问题与必须兑现的行为

玩家能够够到并挖掉斜上方矿石，不代表人物已经接近到可以拾取其产物。
产物可能停在高台、岩壁凸块或竖井侧面；按矿石位置结束挖掘、按导航 arrived 结束移动，均不能证明入包。

本次交付要求：

1. 每块目标矿在挖掘前建立收集记录；挖掉后优先处理该记录，不能直接换矿并丢失产物目标。
2. 常规宏与 LLM 路径调用相同的产物识别、接近、验证和记账接口，模式只决定谁选择下一步。
3. 向上拾取按安全拾取站位决定升高目标，不能停在“已能挖到”的高度。
4. 以对应产物的本玩家入包证据确认收获；实体消失、移动成功、矿块消失均不是单独充分条件。
5. 不能安全完成或预算耗尽时，报告真实的已挖、已收、未收状态，不冒险追物，不虚报任务完成。

目标是“有条件地完成收集，并保证未收取不会被静默当成成功”。
服务器销毁产物、他人拾取、权限限制、物资不足等情形无法保证必然拿到；必须可诊断、可停止。

## 二、现有代码行为与缺口

| 位置 | 基线行为 | 要修正的问题 |
| --- | --- | --- |
| `src/skills/mining.js → collectDrops` | 默认扫 8 格，最多 4 轮；4 格内多用 raw 直走，移动失败后最多 10 步 `stepToward`；等待约 2.5 秒 | “移动成功但没捡到”不进入升高恢复；无逐格垫柱接近；扫描未按目标产物优先 |
| `collectDrops → gone()` | entityId 不在 nearbyItems 中就加一次 collected | 离开范围、合并、销毁、他人拾取会误报；计的是消失实体次数，不是目标物品数量 |
| `takeOre` | 挖矿后立即 `stats.ores++`，await collectDrops 后无条件返回 dug 成功 | 收集失败被忽略；count 达到后仍可带着高处未收产物结束 |
| `runTunnel` / Mod `Tunnel` | 连续动作自行选待挖格；回执含 dugCells，失败分支目前提前返回 | 目标矿可能作为路障被挖，绕过取矿/收集记录；不能只修 takeOre 而漏掉这条破坏路径 |
| `stepTo/stepVector` | 采用格级相邻容差，服务于挖路到达 | 不能用作实际物品拾取条件；人物在下方也可能满足宽松到达判定 |
| Mod `ClientStateSnapshot.itemDropsJson` | 扫描 16 格内客户端可见存活实体，提供 id/item/count/position/distance | 不报告拾取归属事件；窗口之外或短暂不可见不等于入包 |
| `ClientModBody.snapshot/itemDrops()` | snapshot 的 nearbyItems 使用原字段 item，itemDrops 方法映射为 name | 共享模块必须统一字段，不能因同一物品字段不同而匹配失败 |
| `MockBody._pickUpDrops` | 距离 <=2 就直接加入背包 | 球形宽松模型掩盖竖直距离、遮挡、拾取延迟、容量及服务器确认问题 |
| `src/tasks/harvest.js → collectDrops` | 已用目标物品背包增量计收获 | 可复用思想与产物映射，但其接近策略不能直接解决窄竖井拾取 |

常规宏的最终清扫是尽力而为，不应承担“补救前面所有漏捡”的唯一责任。
目标产物与清障石头必须分开统计和排序，不能捡到一块圆石就把本矿判完成。

## 三、共享数据与完成语义

### 3.1 AcquisitionGoal：挖掘前建立，拾取后结算

建议由 `src/skills/miningAcquisition.js` 管理，ID 由 Node 生成并附属于 taskId。
同一矿块只有一条主记录；重试、宏与模型交接不能另建记录清空基线。

```js
{
  goalId, taskId, worldSessionId, dimension,
  target: { blockId, position },
  phase: 'mine',                       // mine | collect
  status: 'prepared',                  // prepared | pending | verified | blocked | lost | unknown | interrupted
  preparedAt, inventoryBaseline, baselineRevision, baselineSealedAt,
  dropsBefore: [],                     // 已存在的同类掉落实体，避免归因混淆
  tool: { item, harvestLevel, enchantments },
  acceptedProducts: [],                // 规则解析所得，模型不能随意修改
  mined: { confirmed: false, actionId: null, at: null, before: null, after: null },
  trackedDrops: [],                    // entityId 仅为可变线索，不是目标唯一身份
  candidateStands: [], triedStands: [],
  collectedItems: 0,                   // 本目标可验证的目标产物数量
  observedProducedItems: null,         // 无法观测总产量时保持 unknown，不默认等于 1
  pendingDrops: [],                    // 可见剩余堆栈及已知但尚未确认去向的产物
  evidence: [], evidenceLevel: null,   // correlated | event_confirmed | ambiguous
  failure: null, reason: null, lastVerifiedRevision: null
}
```

字段为契约草案，实施时用 Schema 固化。status 表达首次入包里程碑；pendingDrops 独立表达剩余收集工作：

- `prepared`：挖前已记录有效背包与实体基线，尚未确认挖掉。
- `pending`：矿已挖掉，对应产物尚未确认入包；不得重挖目标坐标。
- `verified`：本任务已挖掉该矿且至少 1 个对应产物被验证入包；仍可能有剩余堆栈。
- `blocked/lost/unknown/interrupted`：分别为明确阻塞、证据充分的损失、证据不足、主动中断；保留所有累计证据。
  曾完成里程碑后又有余料损失时，里程碑证据不撤销，剩余产物单独记 disposition。

矿块在发 dig 前已消失，或只有世界方块变化但没有本任务合法 dig 关联，不能生成挖掘确认记录。
并发外部玩家造成归因不明时，应标记 ambiguous；不把本任务请求恰好同时返回当作绝对归因。
选矿时可先创建记录；库存/实体基线必须在真正开始目标 dig 前刷新并封存，避免把接近途中捡到的旧产物
算成本矿。仅当确认还没发出目标 dig 时才允许更新该基线；一旦已发动作或结果不明，不得重建基线掩盖增量。
worldSessionId 必须区分重连/换世界，即使 dimension 和坐标相同也不能混算。

### 3.2 计数与报告

| 字段 | 定义 | 何时增加 |
| --- | --- | --- |
| `minedBlocks` | 已确认挖掉的目标矿块数 | 目标方块挖后复核一次，按 actionId/goalId 去重 |
| `acquiredGoals` | 已达首次入包里程碑的矿块目标数 | 同一目标有挖掘证据，且可归因的目标物品入包 >=1 |
| `collectedItems` | 实际入包的目标产物单位数 | 通过共享证据账确认；钻石等按物品数，不按 entity 数 |
| `incidentalItems` | 清障石头等非目标收获 | 独立记录，可用于库存，不充当采矿成功 |
| `pendingDrops` | 仍可追踪或去向未明的目标产物 | 挖后观察创建，合并/移动/部分拾取时更新 |

保留对外 `mined` 字段作 minedBlocks 的兼容别名，不改变其矿块含义。旧 `collected` 含义不清，
应迁移调用者与面板到明确字段；如保留旧字段，说明版本与新含义，不同时维护两个互相独立的计数器。

`count=2` 仍表示最多挖两块目标矿，而不是必须拿到两件物品。时运可能产出多件，精准采集产出矿石本体。
达到 count 后停止挖新矿，继续处理本任务待收产物；只有显式 count 已满足（未指定时按扫描/预算退出规则）、
已挖目标的采集记录均有合格证据、
没有已知未解决目标掉落物，才报告 `outcome=complete`。拿到不足、损失或无法确认时报告 `partial/blocked`。
“没有已知未解决”仅覆盖可观测产物，不能声称获得了未知 Mod 掉落表的全部潜在产物。

LLM 接管成功只需当前锁定 goal 的首次入包里程碑加安全落地；若一块矿产出多件，剩余产物仍在队列，
交还宏后继续收，不能因里程碑达成清空 pendingDrops。整项任务成功条件强于一次接管成功条件。
已 verified 的同一 goal 不再因余料失败触发“取得首个产物”的恢复会话，否则会立即满足旧里程碑而来回交接。
首版由宏在剩余本地/父预算内处理余料，仍无法解决则报告 partial 并停止；不重置目标预算或已有成功证据。

## 四、产物识别与入包证据

### 4.1 产物规则

新增纯函数 `resolveMiningProducts(blockId, toolState, registry, modKnowledge)`，以已知映射/注册表为准：

- 常见原版矿：钻石矿→钻石、金矿→粗金、铁矿→粗铁；普通/深板岩变体共用真实产物映射。
- 精准采集工具：按实际规则接受矿石本体；时运影响数量，不能硬编码“一个矿只掉一个物品”。
- Mod 矿石：保留 namespace，优先用户/知识库已核验映射及服务器可用资料；不能由模型猜一个名字后视为权威。
- 工具不满足采集条件时，挖前拒绝；不能等方块消失后把没有产物解释为拾取超时。
- 若没有可靠的附魔/产物信息，给出可确认候选并标记不确定；新出现实体和入包事件只能作为补充证据。
  仍无法建立可靠对应关系时以 `product_unknown` 返回，不用“任意库存增加”作为兜底。

`ClientStateSnapshot` / `ClientModBody` 目前已有手持和耐久信息，但若验收需要区分精准采集，
应补可验证的手持附魔或等效产物规则输入。Node 不读取模型对工具的自然语言判断作为真值。

### 4.2 挖前、挖后和拾取时的证据链

1. **挖前**：取得有效新快照，记录目标方块、工具、目标产物库存总量、附近同类掉落物和库存可接收空间。
   基线必须先于 dig，才能覆盖产物生成后立即自动入包、从未出现在扫描中的情况。
2. **挖后**：记录动作 ID，复核目标不再是原矿块；切 phase=collect。
   在有界时间内观察产物生成/落稳；若库存已出现可归因增量，可以直接验证，无需强行找掉落实体。
3. **追踪**：记录物品类型、堆栈数量、位置、出现时间和已知实体 ID；实体 ID 合并/更换不清空目标。
4. **入包**：以对应物品库存增加为必要证据；有本玩家拾取事件时联合事件数量/类型/时间验证。
   一个正增量只能分配给一个目标，不能被多个 pending goal 重复记账。
5. **结算**：记录证据、数量与快照版本；收获事件和目标里程碑分别幂等去重，最终报告使用此账本。

基础实现可以在**无同类旧掉落、无并发同类库存来源的受控条件**下，用挖前/挖后产物增量和局部掉落关联
标记 `evidenceLevel=correlated`。若附近存在同类旧产物、玩家投掷、容器转入、任务同时消费/丢弃同类物品，
不能仅靠净增量自动确认本矿；标记 ambiguous，等待更强证据或停止说明限制。
库存满不等于不能接收：同类堆栈尚有余量时可部分收取，需按实际剩余容量判断。

### 4.3 Mod 拾取事件增强（并发/歧义环境的交付依赖）

为了支持多人环境和实体瞬时拾取，建议在客户端实际收到服务端物品拾取通知的位置采集事件，
具体 Forge/Minecraft 1.20.1 hook 在实现时验证，不臆造现成 API；客户端 hook 不可用时不能伪造事件。

拟新增独立只读增量端点，例如 `GET /pickup-events?after=<seq>`，返回：

```js
{
  sessionId, dimension, oldestSeq, latestSeq, overflow,
  events: [{ seq, tick, collectorEntityId, itemEntityId, item, count, position }]
}
```

- 仅将 collector 是本玩家的事件用于自己的收获；其它玩家拾取可作为损失线索。
- 消失前缓存物品实体类型/数量/位置，尽量避免拾取包到达后无法解析物品；解析失败保留 unknown。
- 事件含 session/dimension/单调 seq；客户端重启、换维度或缓冲溢出明确报告，不能把漏失解释为零拾取。
- 拾取事件说明玩家拾了某实体，**并不必然证明该实体源自本矿**；仍需与产生位置/时间/类型、旧实体基线关联。
  合并后来源无法区分时保持 ambiguous，不夸大为精确来源追踪。
- 事件到达与库存同步可能先后不同；在有界确认窗口内等待两者一致，事件数量为收获上界，不凭事件直接改库存账。
- 协议假 Mod 覆盖顺序、重复、溢出和重启；真实 hook 的触发及数量必须真机验证。

第一阶段可先交付受控场景的 correlated 证据；多人归因支持必须单列验收。
缺少事件能力时应显式降级到受限证据模式，不能静默声称具有 event_confirmed 精度。

## 五、收集状态机与局部接近策略

### 5.1 状态机

```text
PREPARE → DIG_CONFIRMED → OBSERVE_DROP → SELECT_STAND → APPROACH → VERIFY_PICKUP
                                  ↑           ↑                        │
                                  │           └── 未入包、换有效站位 ────┘
                                  └── 产物移动/合并：重新定位

VERIFY_PICKUP → VERIFIED（首次产物入包，继续保留余料）
本地接近无效 → NEEDS_RECOVERY（移交目标与全部证据）
危险/权限/容量/世界失效/预算/停止 → BLOCKED / UNKNOWN / INTERRUPTED
```

移动只改变接近状态，永远不能直接将 goal.status 改为 verified。
每个 await 后检查取消、任务所有权、世界与目标状态，再允许新的副作用。
已经出现有效入包证据时优先结算，不为了寻找已消失实体额外移动或清障。

### 5.2 选择“人物脚位”，而非掉落物坐标

候选脚位由 `src/skills/miningCollection.js` 内的确定性函数生成，首次以产物附近小邻域为范围：
水平半径 2 格、脚位高度参考产物上下 3 格；扫描缺失时只读补全，候选不足再按预算扩大。
这些是候选搜索范围，不是原版拾取半径，不承诺范围内任意点都能收到物品。

每个候选必须核验：

- 地板实体支撑、身体空间与必要跳跃净空；未知/半砖/特殊碰撞方块按已建模能力处理，不能假设完整方块。
- 到达该站位后，人物实际碰撞/拾取范围与掉落位置在几何上可能接触；精确范围以当前版本实现和真机为准，
  不沿用 MockBody “脚坐标两格球体”近似作为成功判据。
- 当前位置到候选站位的局部通行安全；不只检查掉落物正下方，更不能为了高处产物使用危险 raw 直走。
- 路线上无已知岩浆、深坑或当前怪物风险，目标格及所需修改符合权限。
- 站位不会用待挖目标/即将消失的方块当永久支撑，不会将产物包进新放置的方块而破坏可达性。

优先级：可直接安全步行的站位 → 现成较高台阶 → 有限清障阶梯 → 逐格垫柱站位。
比较路径长度、地形修改量、支撑材料消耗和已失败站位；不是简单选离掉落物最近的坐标。
到达容差仅用于导航结束，最终是否入包仍须查库存/事件。

### 5.3 向上拾取的处理

1. 先短暂观察产物是否还在下落；若会落进可拾取区，可以等待，但等待有截止时间。
2. 产物停在斜上平台且有已有台阶时，走到合格高站位，不反复走到平台正下方。
3. 需要少量开路时，复用当前 `stepToward`/受控挖掘，但每步都要核验支撑、净空、实际位置和目标产物的新位置；
   取消旧“只要 moveTo 返回失败才爬高”的条件。
4. 窄竖井无法修阶梯时，复用 P4 的逐格垫柱辅助模块；目标为选定拾取站位，清一跳、垫一格、落稳后再次观察。
   不使用“同列矿下两格”作为拾取终点，矿已挖掉时也不调用 takeOre 重挖空气。
5. 若垫柱会被实体所在格/产物支撑遮挡，选择侧面站位或在明确安全的情况下清掉托住产物的块，让其落到安全区。
   清支撑必须同时检查人物支撑、产物下落路径、液体和权限；不把“挖掉下面一块”设成无条件兜底。
6. 原站位移动成功但物品仍未入包，同样触发下一次站位选择/恢复；不只等待 2.5 秒后当作已完成。

常规模式的本地恢复有上限：默认最多 3 个不同候选站位、最多 6 个地形修改基础动作、最多 2 次单格升柱。
达到上限仍可安全尝试时返回 NEEDS_RECOVERY，由父采矿监控决定是否调用 LLM；更高台阶不是直接判“捡不到”。
模型接管时可在其总预算内继续单格升高，但每次只执行一格并核验。两模式共用同一个实际升柱执行器。

### 5.4 产物追踪、等待与资源

- 正常扫描取 Mod 可见范围内数据，目标产物优先，清障产物次之；没有目标物品时可有界等待生成，不能立即换矿。
- 每次移动、清障、垫柱后更新实体坐标；悬浮实体正在下落时，不长时间追旧坐标。
- 两堆合并导致旧 ID 消失，按类型、数量和邻近位置关联新堆；无背包增量时仍是 pending。
- 部分拾取减少堆栈数量，按实际入包记账并保留余量；不能按“实体仍存在”判断完全没收获。
- 产物离开 16 格扫描范围时记 lastSeen/unknown，不判收获；不能为了刷新实体无预算远行。
- 允许只读等待的生成/确认时间由配置控制；不在每次重定位时重置整段收集 deadline。
- 同类堆栈无余量且没有空槽时返回 `inventory_full`；首版不自动丢弃、存箱或合成腾位置。
- 支撑块不足、镐不合适、未知材质阻挡返回具体原因；不让 LLM 用无限重复绕过物理前提。

## 六、共享接口与两条调用链

### 6.1 接口契约

建议模块如下，均属于 Node，收集模块不 import LLM：

```js
prepareAcquisition(ctx, ore, execution) -> AcquisitionGoal
recordMineResult(goal, receipt, before, after) -> goal
observeAcquisition(ctx, goal, execution) -> {goal, evidence, delta}
selectPickupStands(snapshot, goal, limits) -> candidates
attemptCollection(ctx, goal, {mode, standId, allowTerrainEdits, deadline, signal}) -> CollectionResult
verifyAcquisition(goal, observations) -> {verified, evidenceLevel, collectedItems, pendingDrops}
```

`execution` 必须包含 taskId、所有权/epoch、取消信号、父 deadline 和共享台账；调用方不能通过新建对象重置总预算。
所有接口返回结构化结果并有截止时间，不以空值或裸 true 宣称拾取成功。

```js
{
  goalId,
  outcome: 'verified',                 // verified | pending | needs_recovery | blocked | lost | unknown | interrupted
  collectedDelta: 1, collectedTotal: 1,
  pendingDrops: [], evidenceLevel: 'correlated',
  reason: null, failure: null,
  stand: null, lastDropPositions: [],
  attemptedActions: [], nextCandidateStands: []
}
```

复用 failure 枚举；具体 reason 使用 `pickup_not_confirmed`、`inventory_full`、`pickup_stand_unreachable`、
`drop_out_of_scan`、`product_unknown`、`pickup_evidence_ambiguous`、`pickup_budget_exhausted` 等。
`needs_recovery` 是控制流结果，不是本矿成功；矿块已经消失也不一概归为 target_lost。

将 reason 与 failure 分层：已有本任务挖掘证据而产物未见时是 pickup/drop 问题；
只有原本应存在的未挖目标被外部移除且无法归因时，才使用 target_lost。

### 6.2 常规宏接线

```text
选矿 → prepareAcquisition → 执行取矿 → recordMineResult
   → attemptCollection(mode=macro)
       verified 且无已知余料：本矿完成，选择下一矿
       verified 但有余料：继续当前收集队列
       needs_recovery：交采矿监控/LLM 接管，携带 goal
       blocked/lost/unknown/interrupted：保留部分结果并停止
```

`takeOre` 不再把 await collectDrops 的返回值忽略。拆分“挖掉目标”的结果与“完成本矿采集”的结果，
恢复阶梯不能把 `dug:true` 当成收集已经完成。原最后一次全范围清扫改成处理 pending queue，
不能在超时/死亡/人工停止后启动新的收尾移动。

在 count 上限命中后进入 drain 阶段：不挖新目标，只处理已产生目标产物；始终受父任务 deadline 约束。
若没有足够时间收集，报告 partial，不偷偷延长任务预算。

必须覆盖 `takeOre` 之外的实际破坏入口：

- Node 的清障、阶梯、P4 以及拾取开路遇到本任务矿物集合时不得按普通石头挖。
  锁定目标改走正式取矿入口；其它匹配矿块默认保护，留到当前收集目标完成后重新选矿。
- 常规 tunnel 保留，但需增加**挖前目标保护**：将规范化目标 blockId 集合及锁定矿坐标传到 Mod，
  在 Tunnel 实际选出待挖格、调用破坏动作前检查；命中时停稳并返回结构化 `target_requires_acquisition` 与坐标。
  Node 刷新后执行正式取矿/收集，或重新选择接近路线。不能先挖掉再补一条没有挖前基线的成功记录。
- ClientModBody、协议与 Mock 同步增加该能力；旧 Mod 不支持时，矿石任务改用受控 Node 接近，
  或明确能力不足，不能继续使用无法防止目标矿被顺手挖掉的连续动作。
- 成功与失败回执都先落已挖地形账；发生意外目标破坏时保存证据并报告异常，不能将其计为普通清障
  后继续多挖一块补 count。该目标保护是收集闭环必要依赖，仍不代表 tunnel 全部连续权限问题已解决。

### 6.3 LLM 块级接线

- 从宏接管时直接继承当前 goal；未挖时模型可 mine_block，已挖时只操作接近/收集所需地形与站位。
- `mine_block(goalId)` 只做一次目标挖掘和观测，不暗中运行长拾取恢复；返回 pending 后由下一批决策继续。
- `collect_target(goalId, standId?)` 调 `attemptCollection(mode=recovery)`：
  一次局部移动加有界确认，或只做观察确认；**不自动挖路/垫柱，也不递归发起 LLM**。
  修改地形由模型显式提出 `dig_cells/pillar_up/place_block`，仍执行同样的安全与权限检查。
- 每次模型动作后调用 observeAcquisition；如果动作过程中产物已经入包，立即更新里程碑，
  不必等待模型主动调用 collect_target，更不要求再调用一次模型来确认成功。
- 入包未确认时，将高度差、站位、待收物品、已试策略和失败原因加入下一轮报告。
  拾取失败必须适用同一进展/重复局面检测，不能不断重复 arrived/wait。
- 结束恢复后，宏读同一个 goal 与 pending queue；本模块不拥有 TaskHub，不创建任务、不释放父任务的身体占用。

### 6.4 普通材料与其它技能边界

统一挖矿入口中的矿石均进入新闭环；石头/泥土仍走旧 HarvestTask，保持其物品计数契约。
可提取纯产物映射和库存证据函数供旧任务使用，但不强制全仓库改造。
钓鱼/农作可日后迁移，不在本批新增隐式行为；现有回归必须保持通过。

## 七、参数、预算与日志

建议新增 `config/agent.json → miningCollection`，所有数值均为待实施默认值：

| 参数 | 初值 | 说明 |
| --- | --- | --- |
| `dropSpawnWaitMs` | 2000 | 挖后等待生成/自动入包，截断于父 deadline |
| `pickupConfirmMs` | 2500 | 到站后的有界确认；不是“到点就算收到” |
| `maxGoalCollectionMs` | 45000 | 每个目标本地收集累计墙钟预算，不因换站位重置 |
| `maxLocalStands` / `maxLocalEdits` / `maxLocalPillarSteps` | 3 / 6 / 2 | 宏本地策略上限，到限可移交恢复 |
| `standRadiusXZ` / `standRangeY` | 2 / 3 | 候选站位搜索邻域；不是游戏拾取半径 |
| `unresolvedPolicy` | stop | 首版未收取时停止并报告；不静默换矿 |

宏本地收集预算耗尽时可交给 LLM 使用其独立但受父 deadline 限制的恢复预算；
地形修改和物品收获仍累计，不能以“模式切换”重置已花费总预算或失败签名。
接管预算以配套文档为准，本文不另设第二套模型调用上限。

日志至少包含 taskId/goalId/mode/phase、目标矿与产物、实体合并映射、背包前后值、
候选站位/失败站位、实际清障与升格、evidenceLevel、pendingDrops 和终止原因。
面板显示“挖 2 块，确认收到 1 块目标的产物，另 1 块待收”，不能只显示已挖数量掩盖缺失。
调试日志不记录密码/token；长方块扫描只保存局部必要数据。

## 八、具体文件修改与交付顺序

| 步骤 | 文件 / 交付 | 完成标准 |
| --- | --- | --- |
| C1 证据与数据 | 新增 `src/skills/miningAcquisition.js`；统一 ClientModBody 的 item/name 字段；补工具产物信息；按需新增 Mod 拾取事件端点 | 目标记录、挖前基线、库存/事件幂等、模糊归因、部分收获均有离线用例；受控与多人证据能力标清 |
| C2 常规收集 | 新增 `src/skills/miningCollection.js`；替换 mining.js 内部 collectDrops/takeOre 收尾；接 P4；补连续 tunnel 的目标矿保护及能力检查 | 未入包不换矿，高处拾取有有限恢复；count 达标后正确 drain 或 partial；没有绕过记录的目标破坏 |
| C3 LLM 共用 | miningRecoveryTools 的 collect_target/mine_block 与监控器接入同一 goal | 接管前后基线/计数不重置、无嵌套模型或 TaskHub；首个产物里程碑与任务完成分离 |
| C4 真机与呈现 | client:build/install（若改 Mod）、面板与 README 状态更新、回放夹具 | §九矩阵通过；失败与未覆盖项明确记录 |

关联修改：`src/body/mockBody.js`、`src/body/clientModBody.js`、`ClientStateSnapshot.java`、
`ClientActions.java` / `ControlHttpServer.java`（目标保护协议，以及按需新增事件端点）、`src/skills/mining.js`、测试和配置读取模块。
通用垫柱已在主方案 P4 定义，收集器只增加以 pickup stand 为终点的调用方式，不能复制第二套升柱物理逻辑。
`run-skill.js` 调试直跑也使用同一收集器、deadline 和取消接口；真机一次只允许一个运行进程控制身体。

## 九、验收标准

### 9.1 离线功能矩阵

建议新增 `scripts/mining-collection-test.js` / `npm run mining:collection:test`；名称是待创建项。
补充 `skills-test.js`、`tasks-test.js`、`test-clientmod-protocol.js` 的相关回归，避免只测纯归一函数。

| 编号 | 场景 | 必须满足的断言 |
| --- | --- | --- |
| C01 | 同层产物正常拾取；宏与恢复模式各跑一次 | 同一证据规则得到同样数量、goal 只结算一次；正常宏模型调用数为 0 |
| C02 | 斜上方台阶，moveTo 返回 true，但目标物品背包不变 | 不设 verified；继续选有效高站位或返回 needs_recovery，不能只等待后成功 |
| C03 | 窄竖井产物在高处，需连续至少 3 格升高 | 宏有限恢复后可交恢复模式；每次只升一格，落地刷新；最终实际产物入包，goal/baseline 不变 |
| C04 | 产物立即自动入包，从未在掉落列表出现 | 挖前基线捕捉增量，受控无歧义时验证成功；没有多余移动 |
| C05 | 挖后产物延迟生成、移动中继续下落 | 有界等待和重新定位；不盲追旧坐标，不在生成前报告 lost/complete |
| C06 | 旧实体合并进另一个同类实体，库存不变 | 关联新堆或标 unknown，collectedItems 不增加 |
| C07 | 实体离开扫描范围、被别人拾取、消失原因未知 | 分别报告 unknown/有证据的 lost；均不能记本玩家收获 |
| C08 | 一堆只拾取部分，实体仍存在 | 按入包数量记增量，余料保留；再次刷新不重复计数 |
| C09 | 背包满但同类堆栈有余量；彻底无容量 | 前者可部分拾取，后者 inventory_full；不自动丢物、不反复垫柱 |
| C10 | 挖的是钻石，收到了清障圆石 | incidentalItems 增加，目标收获不增加，不满足恢复结束条件 |
| C11 | 精准采集/时运/已知 Mod 产物/未知产物 | 正确映射与数量；未知映射 product_unknown；模型不能伪造映射绕过 |
| C12 | 同类旧掉落、他人投掷、并发同类库存来源 | 不用一次总库存增加同时确认本矿和旧矿；无法归因时 ambiguous |
| C13 | stop/死亡/超时发生在移动、挖路、垫柱、等待确认中 | 不再发新的副作用动作；保留已挖/已收/未收；不执行最终清扫 |
| C14 | 拾取站位下方悬崖、路径岩浆、怪物、拒绝权限 | 安全/权限拒绝且零越界操作；不交模型绕过硬拒绝 |
| C15 | count=2，第一块已挖但未收 | 不挖第二块；解决第一块后再继续；count 达标但仍有余料时 drain/partial 正确 |
| C16 | 同一请求/回执重复、两个 pending goal、恢复交接 | 单份入包证据只消费一次；goalId/actionId 幂等；不重新记录更高库存基线掩盖丢失 |
| C17 | 模型 clear/move/pillar 过程中意外自动拾取目标 | 共享观察立即结算并允许结束接管，无须额外 collect_target 或模型“确认” |
| C18 | 调用 collect_target 时局部接近仍失败 | 返回 pending/needs_recovery，绝不内部启动模型、十步清障或子 TaskHub |
| C19 | 世界/维度变化、HTTP 返回旧缓存、实体扫描缺格 | 不生成新入包证据；暂停并标状态失效，跨世界库存与实体不能混算 |
| C20 | 同一矿已验证首次入包，但有时运余料未收 | 恢复可交回宏，宏仍保留余料；整任务不因一次里程碑自动 complete；余料失败不再次用已满足的里程碑发起接管 |
| C21 | tunnel/清障将碰到锁定目标或其它匹配矿；count 剩 1 | 破坏前停止并走正式取矿或保护/绕开；有挖前基线，不额外挖矿、不漏计；旧 Mod 缺能力时明确降级 |
| C22 | 选矿后接近途中捡到旧同类物品；挖前刷新后目标立刻入包 | 封存前更新同一 goal 的基线，旧物品不归本矿；目标瞬时入包仍可记录；已发送 dig 后禁止重置基线 |

Mock 夹具必须能表达：受限拾取高度/空间、拾取延迟、服务端拒绝、容量/堆栈、实体合并/销毁/范围丢失。
不要在导航返回 true 时直接删除掉落物；不能仍用“距脚两格就入包”来证明高处拾取通过。

### 9.2 协议与归因验收

| 编号 | 场景 | 通过标准 |
| --- | --- | --- |
| CP1 | snapshot nearbyItems 与 itemDrops 方法返回 | 共享模块看到相同 item/name、count、坐标、dimension；缺字段明确 unknown |
| CP2 | 拾取事件早于/晚于库存更新 | 在确认窗口内一致才结算，不双计；超时保留待确认 |
| CP3 | 重复事件、轮询游标重放、部分拾取 | sessionId+seq 幂等；按实际数量分配证据 |
| CP4 | 客户端重启、换维度、环形缓冲溢出 | 明确标记断点/缺失，不把缺事件当零拾取或成功 |
| CP5 | collector 是他人、item 未解析、实体合并来源不明 | 不产生 event_confirmed 的本矿入包结论 |
| CP6 | 本玩家拾取事件与背包增量均成立且来源可关联 | event_confirmed 可通过；没有事件能力时准确标 correlated 的适用限制 |
| CP7 | 连续 tunnel 的目标保护、旧协议缺能力、途中失败 | 保护依据实际待挖方块，破坏前停止；返回原因和已有 dugCells；Node 不悄悄丢弃保护参数 |

### 9.3 真机验收

实施完成后执行，不在本次写文档时运行。每次记录提交、jar SHA-256、客户端重启状态、工具/附魔、库存基线，
入口、goalId、采矿/拾取日志和前后快照。宏与 LLM 恢复使用等价新地形，不能用前一轮已经清好的路冒充覆盖。

| 场景 | 重复与通过标准 |
| --- | --- |
| 斜上平台掉落 | 至少 3 次独立矿点；掉落初始位置确实高于当前可拾取位置；通过站位变化最终入包，无漏捡后换矿 |
| 窄竖井高处掉落 | 至少 3 次，每次需累计至少 3 格升高；逐格清障/放置/落地证据齐全，成功以产物入包确认 |
| 宏到 LLM 拾取接管 | 至少 2 次，明确记录 mined 时刻早于接管，接管时 phase=collect；无重挖空气，首次产物入包后交还 |
| 移动成功但仍未入包 | 实际复现一次，日志显示 arrived 后仍 pending，随后有效恢复或诚实停止，不报告假成功 |
| 普通矿道回归 | 同层/斜下常规采矿各覆盖；正常收集无需模型；count/台账、火把及工具切换不回归 |
| 不可收情形 | 背包无容量/停止/危险至少各一次；无额外破坏或继续移动，未收信息可见 |
| 拾取归因 | 若宣称支持多人模式，覆盖他人拾取与同类旧掉落；无法明确归因时必须 ambiguous，不能挑成功日志算通过 |

游戏可能无法方便复现某协议时序，必须标“协议模拟通过、真机未覆盖”，不得用模拟替代该项真机结论。
统计每次实际挖矿数、目标入包数、剩余产物、恢复次数/耗时、失败原因；保留全部试验，不删失败轮。

### 9.4 完成门槛与回归命令

- C1/C2 不依赖真实模型，可先交付；C3 依赖主方案的恢复状态机，必须使用同一批 fixture 做双模式对照。
- 跑 `npm run mining:collection:test`（新增后）、`npm run skills:test`、`npm run client:test` 和必要的旧任务回归；
  最后跑 `npm run p0:verify`。后者不包含新增收集套件、skills:test 或 client:test，不能只用“8/8”代替验收。
- 改 Java 时需 build/install 并重启，再记录真实 jar 身份；测试假 Mod 无法证明客户端拾取事件 hook 正确。
- 只完成受控场景库存关联时标明能力边界；事件归因未完成，不得写“多人场景收集完全可靠”。
- 文档、面板与聊天回执一致区分 mined、acquired、pending；不以“任务正常返回”替代入包证据。

## 十、实施决策与后续边界

- 默认未收取策略为停止并报告，操作员可显式重试；将来若增加“允许放弃余料继续”，必须有独立配置与可见记录。
- 首版不自动清背包，不为拾取跨越危险区域，不主动获取支撑材料；这些是额外任务，不能隐含在 collect_target 中。
- 掉落物身份和产量存在不确定性时保守报告；需要更强归因则实施拾取事件增强，不能让 LLM 猜测替代证据。
- 两份文档的依赖顺序：统一入口 A → 逐格垫柱 P4 → C1/C2 → 接管工具 P1 + 护栏 P3 → 状态机 P2 + 共享接线 C3 → C4/联合真机。
  实现可并行开发模块，但上线接管前必须先具备可验证的入包完成条件。

---

## 十一、实机记录（2026-10-10 夜，jar 60936）

共享收集在真机（mc.example.com，角色 `agent`）通过 `npm run mining:live` 验证：

* 连续 5 轮（深板岩钻石 ×2、深板岩铁 ×2、金矿 ×1）完整走通"挖前基线封存 → 挖后入包证据"链路：
  结果均为 `[verified] collected=1 pending=0`，库存增量与目标产物一致（diamond/raw_iron/raw_gold 各 +1）。
* 实机暴露并修复两处：① 收尾清扫（`collectDrops`）可能捡走目标产物而目标记录仍为 pending——
  已加清扫后的证据对账（`reconcilePendingGoals`）；② 站位候选曾无条件排除"矿块原格"——
  挖后那一格是最佳拾取点位，已允许（是否可站仍由可通行性检查决定）。
* tunnel 目标保护已真机命中：以相邻实心方块为 protect 目标发起隧道，控制器在破坏前停手，
  返回精确坐标且 `dugCells=[]`，方块保留（CP7 通过）。
* 真机复现“掉落物被岩石包住、寻路找不到”的原始问题并修复（2026-10-10 深夜）：
  - 宏按 §5.2 的有限清障阶梯主动开路：每步只开脚/头两格并复核，受 `maxLocalEdits` 约束，
    危险与任务矿保护照旧；恢复模式仍不允许隐式挖路。受控夹具（挖 2 深壁龛→丢入圆石→封口）
    实测 `picked up after carving access`，被封的 2 连堆被挖出并拾取。
  - 同时修正入包归因：当目标掉落实体仍在（数量未减）时，正库存增量判为 ambiguous、不计入 target
    （否则路过捡到同类陈年掉落会把仍封在地里的目标误判为已收）。
  - 操作员工具：`npm run mining:live -- --collect-drops [--item <name>]` 可点名清理被封的掉落物。
* 2026-10-12 真机续测（操作员人工构造 (19,-52,206)：掉落物在封顶下的 1 格空腔）：
  - 根因一（Node）：收集器的清障只会同层移动，掉落物低一层时无法进入；已改为**以掉落物所在层为目标**，
    挖开其上方封块后走入/落入；若走位器仍拒绝下坑，则**填坑垫平**（向坑内放置支撑块，产物被顶上来后
    在平层拾取）。恢复模式仍禁止隐式挖路/放置。
  - 根因二（Mod）：`WalkTo` 的“严格格到达”此前忽略 y（容差 2.0），bot 站在坑沿（脚仍在上一层）就被
    判定到达——现已收紧为 strict 模式 0.75，真机确定性验证：严格移动到下一层目标会**实际下坑**，
    并能再跳回上层（jar 60961）。
  - 操作员构造的 raw_iron 掉落已实际入包（`[verified] collectedDelta=1`，实体消失）。
* 未覆盖真机项：多人环境归因（事件增强未实施，当前为 correlated 证据）。
