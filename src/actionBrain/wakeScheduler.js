'use strict';

/**
 * 唤醒调度器：把"事件到达"翻译成"这一步/这一轮要不要开"，**接口占位**。
 *
 * 骨架，不是实现。收件箱负责存与合批，本模块负责回答唯一一个问题：
 * 现在能不能开轮？开成什么形态？所有方法抛 `not-implemented`。
 *
 * 边界定义（实现时最容易写错的地方，先在这里钉死）：
 *   一次"步" = 一次模型调用 + 它发出的工具批返回；
 *   - 模型调用进行中到达的事件：只入箱，**不进本次调用**；
 *   - 工具批返回后、下一次模型调用前：把 `delivery: boundary` 的事件压成
 *     一条结构化的 `<events>` 输入；
 *   - `delivery: round` 的事件：无在跑回合则直接开轮；有则在最近边界插队，
 *     principal（活人）优先级最高。
 *
 * 反轮询：完成事件永远主动推送；`task_status` 只用于现场核对，不作为唤醒源。
 *
 * 契约正文：[docs/ACTION-BRAIN-ASYNC-CONTRACT.md](../../docs/ACTION-BRAIN-ASYNC-CONTRACT.md) §6
 */

const { ContractError } = require('./contracts');

/** 唤醒原因。只有 principal 能在 idle 开轮，其余原因最多搭车。 */
const WAKE_REASONS = Object.freeze([
  'principal-speech',
  'task-terminal',
  'task-interrupted',
  'plan-updated',
  'steer',
  'perception',
  'boundary-drain'
]);

/** 不允许在 idle 时自行开轮的原因（世界事实不自定紧急度）。 */
const NON_WAKE_REASONS = Object.freeze(['perception', 'task-progress', 'boundary-drain']);

function notImplemented(feature) {
  throw new ContractError(
    'not-implemented',
    `${feature} 未实现：唤醒调度器只冻结"何时开轮/何处插队"的契约，`
    + '不提供调度、优先级、预算或回合创建行为。'
  );
}

/**
 * @param {{ mailbox:object, runtime:object, now?:() => number, log?:object,
 *           maxWakesPerHour?:number, boundaryDrainSize?:number }} deps
 * @returns {{
 *   onEvent:(event:object) => string,
 *   onBoundary:() => object[],
 *   whyNotWake:() => { ok:boolean, reason:string },
 *   status:() => object,
 *   restore:(state:object) => void,
 *   stop:(reason:string) => void
 * }}
 */
function createWakeScheduler(deps) {
  return {
    onEvent: () => notImplemented('wakeScheduler.onEvent'),
    onBoundary: () => notImplemented('wakeScheduler.onBoundary'),
    whyNotWake: () => notImplemented('wakeScheduler.whyNotWake'),
    status: () => notImplemented('wakeScheduler.status'),
    restore: () => notImplemented('wakeScheduler.restore'),
    stop: () => notImplemented('wakeScheduler.stop')
  };
}

module.exports = { WAKE_REASONS, NON_WAKE_REASONS, createWakeScheduler };
