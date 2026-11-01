'use strict';

/**
 * 事件收件箱：三态路由的**接口占位**。
 *
 * 骨架，不是实现。它只声明"事件进来之后由谁、按什么时机消费"的契约，
 * 所有方法都抛 `not-implemented`。
 *
 * 为什么需要它（有证据，不是理论）：当前聊天、感知边沿、任务终态、截图 steer
 * 各自触发回合；长任务又把回合占住（A28 实测 15.57s 单次结算）。收件箱把
 * "事件产生"与"回合消费"解耦，并且只有**一个**消费节奏：
 *
 *   mid-turn        回合进行中（模型调用/工具批未结束）→ 只入箱，绝不打断；
 *   background      回合结束但后台有任务在跑            → 允许开新轮；
 *   idle            完全空闲                            → 躺着等下个轮子搭车。
 *
 * 两条硬约束：
 *   1) 只有"活人说话"（principal）能在空闲时开轮；世界/身体事件恒不紧急。
 *   2) 同一条线（taskId / planId / thread）串行，按 seq 合并成一批投递。
 *
 * 契约正文：[docs/ACTION-BRAIN-ASYNC-CONTRACT.md](../../docs/ACTION-BRAIN-ASYNC-CONTRACT.md) §6
 */

const { ContractError } = require('./contracts');

/** 收件箱观察到的三种消费时机。 */
const CONSUME_MODES = Object.freeze(['mid-turn', 'background', 'idle']);

/** `offer()` 的结果码：重复必须被识别并丢弃，不能重复投递。 */
const OFFER_RESULTS = Object.freeze(['accepted', 'duplicate', 'rejected', 'over-budget']);

function notImplemented(feature) {
  throw new ContractError(
    'not-implemented',
    `${feature} 未实现：收件箱只冻结路由契约（docs/ACTION-BRAIN-ASYNC-CONTRACT.md §6），`
    + '不提供去重、合批、优先级或唤醒行为。'
  );
}

/**
 * 创建收件箱。实现者必须满足：
 *   - `offer` 按 `eventId` 幂等；重复返回 `duplicate`，不得二次入箱；
 *   - `takeBatch` 是**唯一**的边界投递出口，返回按 seq 排序、按线合并的一批；
 *   - 任何方法都不得阻塞调用方，也不得自行开轮（开轮是 wakeScheduler 的事）；
 *   - `snapshot`/`restore` 只做 JSON-safe 投影；恢复后未投递事件不得被当成新副作用。
 *
 * @param {{ capacity?:number, now?:() => number, log?:object }} [options]
 * @returns {{
 *   offer:(event:object) => string,
 *   takeBatch:(input?:{ limit?:number, mode?:string }) => object[],
 *   peek:() => object[],
 *   pending:() => number,
 *   acknowledge:(eventId:string) => boolean,
 *   snapshot:() => object,
 *   restore:(state:object) => void
 * }}
 */
function createEventMailbox(options) {
  return {
    offer: () => notImplemented('mailbox.offer'),
    takeBatch: () => notImplemented('mailbox.takeBatch'),
    peek: () => notImplemented('mailbox.peek'),
    pending: () => notImplemented('mailbox.pending'),
    acknowledge: () => notImplemented('mailbox.acknowledge'),
    snapshot: () => notImplemented('mailbox.snapshot'),
    restore: () => notImplemented('mailbox.restore')
  };
}

module.exports = { CONSUME_MODES, OFFER_RESULTS, createEventMailbox };
