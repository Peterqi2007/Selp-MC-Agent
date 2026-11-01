'use strict';

const { ContractError, jsonSafe, errorInfo, withAbort, isJsonValue, mergedSignal } = require('./contracts');
const { capabilityList, CAPABILITIES } = require('./pluginRegistry');

/** One capability check for all adapters. Tool implementations must honor cancellation. */
class ToolBroker {
  constructor({ gate, plugins = null, emit = () => {} } = {}) {
    if (!gate) throw new ContractError('lease-gate-required');
    this.gate = gate; this.plugins = plugins; this.emit = emit; this.tools = new Map();
  }

  register(tool) {
    if (!tool || !/^[a-z][a-z0-9_.-]{0,95}$/.test(tool.name || '') ||
        !CAPABILITIES.has(tool.capability) || typeof tool.execute !== 'function' || typeof tool.validate !== 'function') throw new ContractError('invalid-tool');
    if (this.tools.has(tool.name)) throw new ContractError('tool-exists');
    if (tool.pluginId && !this.plugins) throw new ContractError('plugin-registry-required');
    this.tools.set(tool.name, Object.freeze({ ...tool }));
  }

  descriptors() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name, description: tool.description || tool.name, capability: tool.capability,
      parameters: jsonSafe(tool.parameters || { type: 'object', properties: {}, additionalProperties: true })
    }));
  }

  /** Binding is created by the host, never from model arguments. Grants are immutable. */
  bind({ lease, capabilities = [], actor = 'main' } = {}) {
    const scope = Object.freeze({ lease, actor, capabilities: Object.freeze(capabilityList(capabilities)) });
    return Object.freeze({
      descriptors: () => this.descriptors().filter((tool) => {
        const implementation = this.tools.get(tool.name);
        return scope.capabilities.includes(tool.capability) &&
          !(scope.actor === 'subagent' && tool.capability === 'game:control') &&
          (!implementation.pluginId || this.plugins.allows(implementation.pluginId, tool.name, tool.capability));
      }),
      invoke: (name, input, options = {}) => this.invoke(name, input, scope, options)
    });
  }

  async invoke(name, input, scope = {}, options = {}) {
    const fail = (code, message = code) => ({ ok: false, error: { code, message } });
    const tool = this.tools.get(name);
    const lease = scope.lease;
    if (!this.gate.isCurrent(lease)) return fail('stale-lease');
    if (!tool) return fail('unknown-tool');
    if (!Array.isArray(scope.capabilities) || !scope.capabilities.includes(tool.capability)) return fail('capability-denied');
    if (scope.actor === 'subagent' && tool.capability === 'game:control') return fail('subagent-game-control-denied');
    if (tool.pluginId && !this.plugins.allows(tool.pluginId, name, tool.capability)) return fail('plugin-not-authorized');
    if (options.signal && options.signal.aborted) return fail('aborted');
    const grantRevision = tool.pluginId ? this.plugins.revision(tool.pluginId) : null;
    const authorized = () => !tool.pluginId || (this.plugins.revision(tool.pluginId) === grantRevision && this.plugins.allows(tool.pluginId, name, tool.capability));
    const linked = mergedSignal([lease.signal, options.signal]);
    const unsubscribe = tool.pluginId
      ? this.plugins.onAuthorizationChange(tool.pluginId, () => linked.abort('plugin-authorization-changed')) : () => {};
    try {
      // Reject non-JSON values instead of handing live objects/functions to tools.
      const value = input === undefined ? {} : input;
      if (!isJsonValue(value)) return fail('invalid-tool-input');
      const encoded = JSON.stringify(value);
      if (!encoded || encoded.length > 65536) return fail('invalid-tool-input');
      const args = JSON.parse(encoded);
      if (tool.validate(args) !== true) return fail('invalid-tool-input');
      this._emit({ type: 'tool:start', runId: lease.runId, epoch: lease.epoch, tool: name, actor: scope.actor });
      const invocation = Promise.resolve().then(() => {
        // A stop can land between admission and this microtask. Check again at dispatch.
        if (!this.gate.isCurrent(lease)) throw new ContractError('stale-lease');
        if (!authorized()) throw new ContractError('plugin-authorization-changed');
        if (linked.signal.aborted) throw new ContractError('aborted');
        return tool.execute(args, { signal: linked.signal, lease, actor: scope.actor });
      });
      const result = await withAbort(invocation, [linked.signal]);
      if (!this.gate.isCurrent(lease)) {
        this._emit({ type: 'tool:discarded', runId: lease.runId, epoch: lease.epoch, tool: name });
        return fail('stale-result');
      }
      if (!authorized()) {
        this._emit({ type: 'tool:discarded', runId: lease.runId, epoch: lease.epoch, tool: name, reason: 'plugin-authorization-changed' });
        return fail('plugin-authorization-changed');
      }
      const safe = jsonSafe(result);
      this._emit({ type: 'tool:end', runId: lease.runId, epoch: lease.epoch, tool: name, result: safe });
      return { ok: true, result: safe };
    } catch (error) {
      if (!this.gate.isCurrent(lease)) {
        this._emit({ type: 'tool:discarded', runId: lease.runId, epoch: lease.epoch, tool: name });
        return fail('stale-result');
      }
      if (!authorized()) return fail('plugin-authorization-changed');
      const safe = errorInfo(error, 'tool-failed');
      this._emit({ type: 'tool:error', runId: lease.runId, epoch: lease.epoch, tool: name, error: safe });
      return { ok: false, error: safe };
    } finally { unsubscribe(); linked.cleanup(); }
  }

  _emit(event) { this.emit(jsonSafe(event)); }
}

module.exports = { ToolBroker };
