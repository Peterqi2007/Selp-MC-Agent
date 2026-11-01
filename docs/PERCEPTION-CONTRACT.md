# 感知观察契约（M1 过渡实现）

> 状态（2026-11-01 复核）：缓存契约本身未变，**已接入动作脑**——`mc_state(fields)` /
> `mc_observe` / `POST /observe` 走同一 `ObservationCache`（A09/A10 真机 PASS，2026-10-17）；
> 边沿事件由 `PerceptionWake`/`ThreatObserver` 产出，动作脑用 `mc_perception` 显式拉取
> （`p1:contract` §35b/§35c）。**语言脑**虽也持有只读 `observe` 工具，但它读的是
> `ctx.world.snapshot()`（`src/llm/tools/perceptors.js`），**不经过**本缓存。
> 反射层（`PerceptionWake` / `ThreatObserver` / 500ms 快照）保持原样。
>
> 2026-10-29/30 追加三个族：`mount`/`vehicle`（载具 `inventory`/`integrity`）、
> `selfDefense`（反射姿态，本地推导、不发请求）、`keybinds`（每次实时读 mod 键位表，不进 body 快照）。

代码：`src/world/observation.js`

## 接口

```js
const cache = new ObservationCache({ body });
const result = await cache.observe({
  fields: ['position', 'health'],       // 或 'self' / 'survival' / 'threat' / ...
  area: { x: 0, y: 64, z: 0, radius: 16 }, // 只过滤带 position 的字段
  maxAgeMs: 500,
  purpose: 'task'                       // survival/reflex/task/decision/answer/explore
});
```

每个字段返回：

```js
{
  value, known, stale, valid, unavailable,
  observedAt, ageMs, revision, dimension, area, source
}
```

整体返回 `ok`、`fields`、`staleFields`、`unknownFields`、`unavailableFields`、
`lastSuccessAt`、`lastError`、`refresh`。刷新失败时旧值仍标 `known`，但 `stale:true`、
`valid:false`，不会伪装成当前事实。

## 字段族

| 族 | 字段 |
| --- | --- |
| `survival` | health, food, dead, onGround, standingOn |
| `threat` | hostiles |
| `self` | position, dimension, yaw, pitch, time, weather |
| `inventory` | inventory, emptySlots, heldItem, heldDurability |
| `taskEntities` | players, nearbyItems, target |
| `workspace` | target, standingOn, blocks, crops, fishing |
| `terrain` | blocks, lightLevel, blockLight |
| `mount`（别名 `vehicle`） | riding, mounted, standingOnEntity；`riding.inventory`/`integrity`（原版容器 / Forge `IItemHandler` / 模组健康比例） |
| `selfDefense` | enabled, engageRadiusXZ/Y/YFlying, engageHealthThreshold（由 `behaviour.autoFight` 本地推导，不发请求；飞行敌意生物用更宽的垂直窗，被击中当 tick 无视窗口） |
| `keybinds` | id / name / category / mod / kind / key / bound / usage / revision（每次实时 GET `/keybinds`，不缓存、不写 body 快照） |

`oxygen / burning / effects / armor / biome / surface / water / containers / beds / doors /
workstations / modDevices / farmland` 当前 body 不暴露，返回 `unavailable`，不编造。

## 采集规则

- 默认只采必要自身状态：position/health/food/dimension/time/weather。
- 按字段 TTL 刷新；同字段未过期不发请求。
- 实际刷新默认走 `body.refreshStrict(true)`：一次完整 `/state` HTTP 请求，返回
  `{ok,cached,state,error}`；失败不会被当成成功快照。没有 `refreshStrict` 的旧 body
  才回退到 `body.refresh(true)`（它保留旧行为，会返回最后快照，无法区分失败）。
- 一次 refresh 只给本次请求的字段打时间戳；其他缓存字段保留旧 `observedAt`。
- 同字段并发请求合并为一个 single-flight refresh。
- 维度变化、死亡、断线清空缓存。
- `area` 对 `hostiles/players/nearbyItems/blocks` 等带位置的值做范围过滤；时间/背包等
  无位置字段原样返回。
- 不建立动物/怪物/掉落物的 500ms–3s 常驻扫描；`hostiles` 仍由已有反射最小观测提供。
- 不做模型调用、不新增订阅。
- 「不新增 `/state` 字段」是 M1 当时的约束；后续里程碑按需加了字段（2026-10-29 输入层的
  `input`/`gameTime`、2026-10-30 载具的 `mounted`/`riding`/`integrity`），见
  [`P1-M5.md`](P1-M5.md) §8 与 [`P1-WORK-2026-10-30.md`](P1-WORK-2026-10-30.md) §2。

## 后续

M0 字段成本表出来后再决定是否把 `/state` 拆成按字段端点；届时只需替换
`ObservationCache.refresh`，调用契约不变。
