'use strict';

/**
 * The two tool surfaces (P1 M2, A03).
 *
 * The language brain is allowed to *talk about* the world: read a state summary, retrieve
 * memories, search, and say something (or stay silent). It must NOT be able to submit tasks,
 * run skills, move the body or stop work - those stay on the action brain.
 *
 * The actual registry split happens in M3 when the two brains get separate agents. Until
 * then this module is the contract: given a registry, `selectSurface()` produces the tool
 * list for one brain, and `verifySeparation()` fails if an execution tool leaks into the
 * language surface. The names match the current registry where they exist; `say`/`silence`
 * are the two P1 additions.
 */

const SURFACES = {
  language: ['observe', 'find_blocks', 'lookup_item', 'scan_around', 'web_search', 'approve', 'say', 'silence'],
  action: ['do_task', 'do_skill', 'go_to', 'stop']
};

/** Tools that change the world or the plan; they may never be on the language surface. */
const EXECUTION_TOOLS = ['do_task', 'do_skill', 'go_to', 'stop'];

function toolName(tool) {
  if (!tool) return null;
  return tool.name || (tool.function && tool.function.name) || null;
}

/**
 * @param {Array<object>} tools a registry (OpenAI tool objects or `{name}` stubs)
 * @param {'language'|'action'} brain
 */
function selectSurface(tools = [], brain) {
  const allowed = SURFACES[brain];
  if (!allowed) throw new Error(`unknown brain surface: ${brain}`);
  const names = new Set(allowed);
  return tools.filter((tool) => names.has(toolName(tool)));
}

/** @returns {{ok:boolean, violations:string[]}} */
function verifySeparation(tools = []) {
  const selected = new Set(selectSurface(tools, 'language').map(toolName));
  const violations = EXECUTION_TOOLS.filter(
    (name) => SURFACES.language.includes(name) || selected.has(name)
  );
  return { ok: violations.length === 0, violations };
}

module.exports = { SURFACES, EXECUTION_TOOLS, selectSurface, verifySeparation, toolName };
