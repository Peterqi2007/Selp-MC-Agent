# 感知观察契约（M1 过渡实现）

> 状态：任务/未来动作脑可用的内部缓存契约已实现；**尚未接入语言脑或动作脑**，也未新增
> `mc_perception` 事件类型。反射层（`PerceptionWake` / `ThreatObserver` / 500ms 快照）不改。

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
- 不做模型调用、不新增订阅、不新增 `/state` 字段。

## 后续

M0 字段成本表出来后再决定是否把 `/state` 拆成按字段端点；届时只需替换
`ObservationCache.refresh`，调用契约不变。
