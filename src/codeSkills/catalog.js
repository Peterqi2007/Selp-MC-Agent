'use strict';

/**
 * Promoted-only catalogue for code skills (P1 M4, A18/A20).
 *
 * The executable skill registry (`src/skills/registry.js`) takes snake_case skills with a
 * `run()` function; generated skills are not loaded here (and must not be until the
 * restricted runner exists). This catalogue is the *retrieval* boundary: it exposes metadata
 * for promoted versions only, so an un-promoted candidate can never be selected by normal
 * planning, help or the LLM tool surface.
 *
 * It deliberately has no `run` function and never imports the entry file.
 */

function descriptor(record, promoted) {
  const manifest = record.manifest;
  return {
    name: manifest.name,
    version: promoted.version,
    title: manifest.title || manifest.name,
    description: manifest.description || '',
    permissions: [...(manifest.permissions || [])],
    source: record.source,
    promotedAt: promoted.at
  };
}

/** All promoted skills, stable by name. */
function listPromoted(store) {
  if (!store) return [];
  return [...store.promoted.keys()]
    .map((name) => {
      const promoted = store.getPromoted(name);
      const record = promoted ? store.getCandidate(name, promoted.version) : null;
      if (!record || record.status !== 'promoted') return null;
      return descriptor(record, promoted);
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Look up exactly one promoted skill; an un-promoted version returns null. */
function findPromoted(store, name, options = {}) {
  if (!store || !name) return null;
  const promoted = store.getPromoted(name);
  if (!promoted) return null;
  if (options.version && options.version !== promoted.version) return null;
  const record = store.getCandidate(name, promoted.version);
  if (!record || record.status !== 'promoted') return null;
  return descriptor(record, promoted);
}

/**
 * A tool-surface descriptor for the language/action brain. Namespaced names are kept as-is;
 * the separator is not rewritten here because the adapter decides how to expose them.
 */
function toToolDescriptor(entry) {
  if (!entry) return null;
  return {
    name: entry.name,
    description: `${entry.description} (code skill v${entry.version})`.trim(),
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string' }
      },
      additionalProperties: false
    },
    metadata: { version: entry.version, permissions: entry.permissions, source: entry.source }
  };
}

module.exports = { listPromoted, findPromoted, toToolDescriptor };
