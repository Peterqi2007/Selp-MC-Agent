'use strict';

const { ContractError } = require('./contracts');

const CAPABILITIES = new Set(['game:observe', 'game:control', 'files:read', 'files:write', 'network:read', 'compute', 'subagent:spawn']);
const NAME = /^[a-z][a-z0-9_.-]{0,95}$/;

function capabilityList(values) {
  if (!Array.isArray(values) || values.some((value) => !CAPABILITIES.has(value))) throw new ContractError('unknown-capability');
  return [...new Set(values)];
}

/** Manifest/grants only, NOT a loader, signature verifier, process or OS sandbox. */
class PluginRegistry {
  constructor() { this.plugins = new Map(); }

  register(manifest) {
    if (!manifest || manifest.apiVersion !== 1 || !NAME.test(manifest.id || '') ||
        !/^\d+\.\d+\.\d+$/.test(manifest.version || '') || !Array.isArray(manifest.tools)) {
      throw new ContractError('invalid-plugin-manifest');
    }
    if (this.plugins.has(manifest.id)) throw new ContractError('plugin-exists');
    const capabilities = capabilityList(manifest.capabilities);
    const names = new Set();
    const tools = manifest.tools.map((tool) => {
      if (!tool || !NAME.test(tool.name || '') || names.has(tool.name) || !capabilities.includes(tool.capability)) {
        throw new ContractError('invalid-plugin-tool');
      }
      names.add(tool.name);
      return Object.freeze({ name: tool.name, capability: tool.capability });
    });
    this.plugins.set(manifest.id, { id: manifest.id, version: manifest.version, capabilities, tools, grants: new Set(), revision: 0, listeners: new Set() });
    return this.status(manifest.id);
  }

  /** Explicit HOST authorization. No model tool exposes this method. Default is no grants. */
  authorize(id, values) {
    const plugin = this.plugins.get(id);
    const grants = capabilityList(values);
    if (!plugin || grants.some((value) => !plugin.capabilities.includes(value))) throw new ContractError('plugin-grant-refused');
    plugin.grants = new Set(grants);
    ++plugin.revision;
    // Synchronous revocation reaches cooperative in-flight tools before authorize returns.
    for (const listener of [...plugin.listeners]) { try { listener(plugin.revision); } catch (_) { /* Notify every invocation. */ } }
    return this.status(id);
  }

  onAuthorizationChange(id, listener) {
    const plugin = this.plugins.get(id);
    if (!plugin || typeof listener !== 'function') throw new ContractError('invalid-plugin-subscription');
    plugin.listeners.add(listener);
    return () => plugin.listeners.delete(listener);
  }

  allows(id, name, capability) {
    const plugin = this.plugins.get(id);
    return !!(plugin && plugin.grants.has(capability) && plugin.tools.some((tool) => tool.name === name && tool.capability === capability));
  }

  revision(id) { const plugin = this.plugins.get(id); return plugin ? plugin.revision : null; }

  status(id) {
    const plugin = this.plugins.get(id);
    return plugin ? { id: plugin.id, version: plugin.version, capabilities: plugin.capabilities.slice(), grants: [...plugin.grants] } : null;
  }
}

module.exports = { PluginRegistry, CAPABILITIES, capabilityList };
