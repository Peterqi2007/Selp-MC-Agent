'use strict';

const { ContractError, deferred, jsonSafe, errorInfo, boundedOperation } = require('./contracts');

function supportedNode(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

/** Deliberately whitelist public projection; never forward SDK state/config/credentials. */
function projectPiEvent(event = {}) {
  switch (event.type) {
    case 'agent_end': return { type: 'driver:run-ended', settled: false };
    case 'agent_settled': return { type: 'driver:settled', settled: true };
    case 'agent_start': return { type: 'driver:started' };
    case 'message_update': {
      const update = event.assistantMessageEvent || {};
      if (update.type !== 'text_delta') return null;
      return jsonSafe({ type: 'model:text', text: update.delta || '' });
    }
    case 'tool_execution_start': case 'tool_execution_end': case 'tool_execution_update':
      return jsonSafe({ type: `driver:${event.type}`, tool: event.toolName || null, callId: event.toolCallId || null });
    case 'auto_compaction_start': case 'auto_compaction_end': case 'auto_retry_start': case 'auto_retry_end':
      return { type: `driver:${event.type}` };
    default: return null;
  }
}

function piTools(tools) {
  return tools.descriptors().map((tool) => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
    async execute(_id, input, signal) {
      const result = await tools.invoke(tool.name, input, { signal });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    }
  }));
}

/**
 * Lazy adapter scaffold, not a verified production SDK integration.
 * Tests inject sessionFactory. Actual SDK use requires Node >=22.19 and sdkOptionsFactory:
 * it must explicitly configure models/credentials, system prompt, resource isolation,
 * selected tools, settings and SessionManager. There is no implicit user-home discovery.
 */
function createPiDriverFactory(options = {}) {
  return async ({ tools, emit }) => {
    const customTools = piTools(tools);
    let result;
    if (options.sessionFactory) {
      result = await options.sessionFactory({ customTools });
    } else {
      if (!supportedNode()) throw new ContractError('pi-node-version', 'The actual Pi SDK requires Node >=22.19.0');
      if (typeof options.sdkOptionsFactory !== 'function') throw new ContractError('pi-configuration-required', 'Explicit isolated SDK configuration is required');
      // TODO: verify this mapping against the pinned SDK before enabling a production backend.
      const sdkOptions = await options.sdkOptionsFactory({ customTools });
      if (!sdkOptions || !Array.isArray(sdkOptions.tools) || sdkOptions.tools.length !== 0 ||
          sdkOptions.customTools !== customTools || !sdkOptions.resourceLoader || !sdkOptions.sessionManager || !sdkOptions.settingsManager) {
        throw new ContractError('pi-isolation-config-required', 'Disable built-in tools and inject explicit resources, settings and session storage');
      }
      const sdk = await import('@earendil-works/pi-coding-agent');
      result = await sdk.createAgentSession(sdkOptions);
    }
    const session = result && (result.session || result);
    let current = null; let disposed = false; let unsubscribe = null; let finalAssistant = null;
    // The recovery handle exists before validation/subscription: partial sessions must
    // never disappear when their initialization throws. It is never projected to JSON.
    const driver = {
      async start(goal) {
        if (disposed || current) throw new ContractError('pi-driver-busy');
        const pending = deferred(); current = pending; finalAssistant = null;
        // prompt resolution alone / agent_end are NOT settled: retries and queued work may follow.
        Promise.resolve().then(() => {
          if (disposed || current !== pending) throw new ContractError('aborted');
          return session.prompt(goal);
        }).catch((error) => {
          if (current === pending) { current = null; pending.reject(error); }
        });
        return pending.promise;
      },
      steer(message) {
        if (disposed || !current) throw new ContractError('pi-driver-idle');
        // Pi steering is after a turn and its tools; emergency stop uses abort + host fences.
        return session.steer(message);
      },
      async abort(reason) {
        if (current) { const pending = current; current = null; pending.reject(new ContractError('aborted', String(reason || 'stopped'))); }
        if (!session || typeof session.abort !== 'function') throw new ContractError('invalid-pi-session-cleanup');
        return session.abort();
      },
      async dispose() {
        disposed = true;
        const errors = [];
        if (typeof unsubscribe === 'function') {
          try { await unsubscribe(); unsubscribe = null; } catch (error) { errors.push(errorInfo(error).message); }
        }
        // A broken unsubscribe must not skip disposal. Both remain retryable.
        try {
          if (!session || typeof session.dispose !== 'function') throw new ContractError('invalid-pi-session-cleanup');
          const result = await session.dispose();
          if (result && result.ok === false) throw new ContractError('pi-dispose-refused', errorInfo(result.error).message);
        } catch (error) { errors.push(errorInfo(error).message); }
        if (errors.length) throw new ContractError('pi-dispose-failed', errors.join('; '));
      }
    };
    try {
      if (!session || ['prompt', 'steer', 'abort', 'subscribe', 'dispose'].some((name) => typeof session[name] !== 'function')) {
        throw new ContractError('invalid-pi-session');
      }
      unsubscribe = session.subscribe((event) => {
        const projected = projectPiEvent(event);
        if (projected) emit(projected);
        if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
          // A later successful retry replaces an earlier failed assistant turn.
          finalAssistant = { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage };
        }
        if (event.type === 'agent_settled' && current) {
          const pending = current; current = null;
          if (event.aborted || finalAssistant && finalAssistant.stopReason === 'aborted') {
            pending.reject(new ContractError('aborted', 'Pi session settled after cancellation'));
          } else if (finalAssistant && finalAssistant.stopReason === 'error') {
            pending.reject(new ContractError('pi-model-error', errorInfo({ message: finalAssistant.errorMessage }, 'Model request failed').message));
          } else pending.resolve({ settled: true, outcome: 'completed' });
        }
      });
      return driver;
    } catch (cause) {
      const timeout = options.initializationCleanupTimeoutMs || 1000;
      const invoke = (name, fn) => {
        let promise; try { promise = Promise.resolve(fn()); } catch (error) { promise = Promise.reject(error); }
        return boundedOperation(name, promise, timeout);
      };
      const aborted = await invoke('pi-init.abort', () => driver.abort('initialization-failed'));
      const disposedResult = await invoke('pi-init.dispose', () => driver.dispose());
      const error = new ContractError('pi-initialization-failed', errorInfo(cause, 'Invalid Pi session').message);
      if (!aborted.ok || !disposedResult.ok) Object.defineProperty(error, 'cleanupDriver', { value: driver });
      throw error;
    }
  };
}

module.exports = { createPiDriverFactory, projectPiEvent, supportedNode };
