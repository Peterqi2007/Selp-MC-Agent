'use strict';

module.exports = {
  ...require('./runtime'),
  ...require('./leaseGate'),
  ...require('./toolBroker'),
  ...require('./subagentScheduler'),
  ...require('./pluginRegistry'),
  ...require('./gameControlPort'),
  ...require('./piDriver'),
  // 异步受理与事件唤醒：只有契约常量与占位方法（全部抛 not-implemented），
  // 生产路径不引用；正文见 docs/ACTION-BRAIN-ASYNC-CONTRACT.md。
  ...require('./asyncContract'),
  ...require('./eventMailbox'),
  ...require('./wakeScheduler'),
  ...require('./contracts')
};
