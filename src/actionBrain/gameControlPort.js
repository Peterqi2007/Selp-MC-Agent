'use strict';

const { ContractError } = require('./contracts');

/**
 * Host integration seam. The host MUST dispatch through the existing TaskSlot/PlanService.
 * This module never imports a body, acquires a lock, or starts a production service.
 * TODO: production adapter must join existing cancel/preempt and InputLedger release paths.
 */
function createGameControlPort(adapter) {
  if (!adapter) {
    const missing = () => { throw new ContractError('game-port-unconfigured', 'Inject the existing TaskSlot/PlanService adapter'); };
    return Object.freeze({ observe: missing, execute: missing, waitForIdle: missing, cancel: missing, releaseInputs: missing });
  }
  if (adapter.ownership !== 'existing-task-slot-plan-service' ||
      ['observe', 'execute', 'waitForIdle', 'cancel', 'releaseInputs'].some((name) => typeof adapter[name] !== 'function')) {
    throw new ContractError('invalid-game-port', 'Game control requires existing TaskSlot/PlanService ownership');
  }
  const required = ['observe', 'execute', 'waitForIdle', 'cancel', 'releaseInputs'];
  /**
   * Optional seams the async (P2) contract needs. They stay optional so the synchronous
   * fixture and existing callers keep working; a host that wants async acceptance must
   * provide BOTH `tasks` and `onTaskEvent`, otherwise `start({taskMode:'async'})` fails
   * closed instead of pretending a receipt is backed by a real task ledger.
   */
  const optional = ['tasks', 'onTaskEvent', 'ask'].filter((name) => typeof adapter[name] === 'function');
  return Object.freeze(Object.fromEntries([...required, ...optional]
    .map((name) => [name, (...args) => adapter[name](...args)])));
}

function installGameTools(broker, port) {
  broker.register({ name: 'mc_observe', capability: 'game:observe', description: 'Read the current game state',
    validate: (input) => !!input && typeof input === 'object' && !Array.isArray(input),
    execute: (input, context) => port.observe(input, context) });
  broker.register({ name: 'mc_step', capability: 'game:control', description: 'Dispatch through existing TaskSlot/PlanService',
    validate: (input) => !!input && typeof input === 'object' && !Array.isArray(input),
    execute: (input, context) => port.execute(input, context) });
}

module.exports = { createGameControlPort, installGameTools };
