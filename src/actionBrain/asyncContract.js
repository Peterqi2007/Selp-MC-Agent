'use strict';

/**
 * 异步受理契约：常量、回执/事件形状与占位校验器。
 *
 * **骨架，不是实现。** 本文件只冻结"异步受理"这件事的词表与数据形状：
 * 任务状态、终态集合、事件族、投递时机、哪些命令同步哪些异步。
 * 任何真正的派发、抢租约、去重、落盘、唤醒都不在这里，也没有被实现——
 * 下面所有 `build*` / `validate*` / `classify*` 都抛 `not-implemented`。
 *
 * 契约正文：[docs/ACTION-BRAIN-ASYNC-CONTRACT.md](../../docs/ACTION-BRAIN-ASYNC-CONTRACT.md)
 * 验收项：docs/ACTION-BRAIN-ACCEPTANCE.md §4.2（P2-15 … P2-20）
 *
 * 设计要点（写在这里是为了让实现者不必翻文档也能读懂边界）：
 *   - `accepted` 只表示"工作已受理"，**永远不能结算成成功**；
 *   - 终态只认一次：先到的 `task.finished` 赢，重复/迟到按 `eventId` 幂等丢弃；
 *   - 只读同步、动手异步、停止同步（`stop` 永远不能被排在任务后面）；
 *   - 模型不得轮询：完成必须作为事件推送，`task_status` 只用于现场核对。
 */

const { ContractError } = require('./contracts');

/** 回执/事件 schema 版本。形状变更必须同步本版本号与契约文档。 */
const SCHEMA_VERSION = 1;

/** 任务生命周期：accepted → running（可来回 waiting_player）→ 一个终态。 */
const TASK_STATES = Object.freeze([
  'accepted',
  'running',
  'waiting_player',
  'succeeded',
  'failed',
  'dropped',
  'timeout',
  'cancelled',
  'interrupted'
]);

/**
 * 终态集合。`dropped` 是"无活可干"，`cancelled` 是"被合法叫停"，
 * 两者都**不得**计入失败阶梯或课程难度带；`timeout` 允许一次续做。
 */
const TERMINAL_STATES = Object.freeze([
  'succeeded',
  'failed',
  'dropped',
  'timeout',
  'cancelled',
  'interrupted'
]);

/** 产品事件族。`delivery` 决定它能否开新轮（见 DELIVERY_TIMING）。 */
const EVENT_TYPES = Object.freeze([
  'task.accepted',
  'task.progress',
  'task.waiting_player',
  'task.finished',
  'task.interrupted',
  'plan.updated',
  'chat.incoming',
  'perception.edge',
  'steer.requested',
  'policy.denied'
]);

/**
 * 投递时机（三态收件箱）。
 *   boundary - 只在"工具批结算"边界倒空，绝不打断在跑的模型调用；
 *   round    - 允许开新一轮（只有活人说话与外部显式 steer 属于这类）；
 *   ride     - 空闲时躺着搭车，不单独开轮。
 */
const DELIVERY_TIMING = Object.freeze({
  'task.accepted': 'ride',
  'task.progress': 'boundary',
  'task.waiting_player': 'round',
  'task.finished': 'round',
  'task.interrupted': 'round',
  'plan.updated': 'boundary',
  'chat.incoming': 'round',
  'perception.edge': 'ride',
  'steer.requested': 'round',
  'policy.denied': 'boundary'
});

/**
 * 只读命令：同步返回，不占任务号、不等事件。
 * 与 migration 文档的工具清单保持一致（T01/T02/T03/T10/T14/T15）。
 */
const SYNC_COMMANDS = Object.freeze(['observe', 'perception', 'state', 'plan_status', 'capabilities', 'keybinds']);

/**
 * 动手命令：必须异步受理。名单来自现有命令表与 15 工具清单，
 * 落地时以 `src/core/keyActions.js` 的动词表为唯一来源，不在这里复制第三份。
 */
const ASYNC_COMMANDS = Object.freeze([
  'step', 'plan', 'goto', 'mine', 'mine-ore', 'chop', 'craft', 'smelt', 'farm', 'fish',
  'deposit', 'withdraw', 'collect', 'attack', 'defend', 'equip', 'eat', 'drop', 'place',
  'use_on', 'follow', 'come', 'sleep', 'shoot', 'code_skill', 'resume'
]);

/** 停止类命令：同步、幂等，任何情况下都不能排在任务后面。 */
const STOP_COMMANDS = Object.freeze(['stop', 'cancel']);

/** 异步回执的必备字段（实现必须全部提供，缺一即契约失败）。 */
const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion', 'ok', 'async', 'taskId', 'verb', 'state', 'acceptedAt', 'attempt'
]);

/** 终结事件的必备字段。`evidence` 与 `failure` 至少有一个可判定。 */
const TERMINAL_EVENT_FIELDS = Object.freeze([
  'schemaVersion', 'eventId', 'seq', 'type', 'at', 'taskId', 'state', 'runId', 'epoch'
]);

function notImplemented(feature) {
  throw new ContractError(
    'not-implemented',
    `${feature} 未实现：本模块只冻结异步受理契约（见 docs/ACTION-BRAIN-ASYNC-CONTRACT.md），`
    + '不提供派发、租约、去重、落盘或唤醒行为。'
  );
}

/** 契约级判定：某个状态是否终态。不是调度逻辑。 */
function isTerminalState(state) {
  return TERMINAL_STATES.includes(String(state));
}

/** 契约级判定：某条命令应走同步还是异步通道。分类表见上，落地时以动词表为准。 */
function classifyCommand(command) {
  const name = String(command || '').trim().split(/\s+/)[0];
  if (STOP_COMMANDS.includes(name)) return 'stop';
  if (SYNC_COMMANDS.includes(name)) return 'sync';
  if (ASYNC_COMMANDS.includes(name)) return 'async';
  return 'unknown';
}

/**
 * 构造"已受理"回执。
 * @param {{ taskId:string, verb:string, args?:object, runId?:string, attempt?:number,
 *           acceptedAt?:number, deadlineMs?:number, estimateMs?:number, slot?:string }} input
 * @returns {object} 符合 RECEIPT_FIELDS 的 JSON-safe 对象（实现后）
 */
function buildAcceptedReceipt(input) {
  return notImplemented('buildAcceptedReceipt');
}

/**
 * 构造终结事件。实现必须保证：同一 taskId 只产生一个终态，且先落盘后投递。
 * @param {{ taskId:string, state:string, runId:string, epoch:number, seq:number,
 *           eventId?:string, at?:number, summary?:string, progress?:object,
 *           evidence?:object, failure?:object, durationMs?:number }} input
 * @returns {object} 符合 TERMINAL_EVENT_FIELDS 的 JSON-safe 对象（实现后）
 */
function buildTerminalEvent(input) {
  return notImplemented('buildTerminalEvent');
}

/** 校验回执/事件形状与终态语义（例如 accepted 不得当成功）。返回错误列表，空表示通过。 */
function validateReceipt(receipt) {
  return notImplemented('validateReceipt');
}

module.exports = {
  SCHEMA_VERSION,
  TASK_STATES,
  TERMINAL_STATES,
  EVENT_TYPES,
  DELIVERY_TIMING,
  SYNC_COMMANDS,
  ASYNC_COMMANDS,
  STOP_COMMANDS,
  RECEIPT_FIELDS,
  TERMINAL_EVENT_FIELDS,
  isTerminalState,
  classifyCommand,
  buildAcceptedReceipt,
  buildTerminalEvent,
  validateReceipt
};
