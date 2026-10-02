'use strict';

/**
 * Body factory: pick how the agent is attached to a world.
 *
 *   "mineflayer" - headless vanilla-protocol bot (default; works on vanilla/Paper/
 *                  Spigot/pure-server Fabric servers)
 *   "clientmod"  - a real Forge client + control mod (needed for Forge/NeoForge
 *                  servers that demand the FML handshake)
 *   "mock"       - scripted world for tests and dry runs; no game required
 *
 * Selected by `config/agent.json` -> `body.kind`, or `--body <kind>` on the CLI.
 */

const { Logger } = require('../util/logger');
const { MineflayerBody } = require('./mineflayerBody');
const { MockBody } = require('./mockBody');

const KINDS = ['mineflayer', 'clientmod', 'mock'];

/**
 * @param {object} cfg loaded config
 * @param {object} deps { controller, world, nav, combat, eat, tools, log }
 * @returns {{kind:string, body:object, usable:boolean, reason:string|null}}
 */
function createBody(cfg, deps = {}) {
  const log = deps.log || new Logger('body');
  const kind = (cfg.agent.body && cfg.agent.body.kind) || 'mineflayer';

  if (!KINDS.includes(kind)) {
    log.warn(`unknown body.kind "${kind}" - falling back to mineflayer`);
    return { kind: 'mineflayer', body: new MineflayerBody(cfg, deps), usable: true, reason: `unknown kind "${kind}"` };
  }

  if (kind === 'mineflayer') {
    return { kind, body: new MineflayerBody(cfg, deps), usable: true, reason: null };
  }

  if (kind === 'mock') {
    const { MockBody: Mock } = require('./mockBody');
    // A small but *sufficient* world: enough trees to satisfy the wood goal so the
    // planner can progress into crafting and mining. Too-small worlds stall the plan
    // and make the mock useless for smoke-testing the whole chain.
    const blocks = (cfg.agent.body && cfg.agent.body.mockBlocks) || [
      { name: 'oak_log', position: { x: 3, y: 64, z: 0 } },
      { name: 'oak_log', position: { x: 3, y: 65, z: 0 } },
      { name: 'oak_log', position: { x: 3, y: 66, z: 0 } },
      { name: 'oak_log', position: { x: 5, y: 64, z: 2 } },
      { name: 'oak_log', position: { x: 5, y: 65, z: 2 } },
      { name: 'oak_log', position: { x: 5, y: 66, z: 2 } },
      { name: 'oak_log', position: { x: -4, y: 64, z: 3 } },
      { name: 'oak_log', position: { x: -4, y: 65, z: 3 } },
      { name: 'oak_log', position: { x: -4, y: 66, z: 3 } },
      { name: 'oak_log', position: { x: 8, y: 64, z: -5 } },
      { name: 'stone', position: { x: -3, y: 63, z: 0 } },
      { name: 'stone', position: { x: -3, y: 63, z: 1 } },
      { name: 'stone', position: { x: -2, y: 63, z: 0 } }
    ];
    const body = new Mock(cfg, { log, blocks, inventory: {} });
    return { kind, body, usable: true, reason: 'scripted world - no real gameplay' };
  }

  // clientmod: the control mod is a separate component (see mod-client/). Until it is
  // built and running, say so plainly instead of pretending to be attached.
  let ClientModBody = null;
  let loadError = null;
  try {
    ({ ClientModBody } = require('./clientModBody'));
  } catch (err) {
    loadError = err.message;
  }
  if (!ClientModBody) {
    return {
      kind,
      body: null,
      usable: false,
      reason:
        `body.kind="clientmod" needs mod-client (the Forge control mod) to be built and running` +
        (loadError ? ` [${loadError}]` : '')
    };
  }
  return { kind, body: new ClientModBody(cfg, { log }), usable: true, reason: null };
}

/**
 * Report which bodies are available in this checkout, for `npm run body:info`.
 * @returns {{selected:string, available:Array<{kind:string, available:boolean, note:string}>}}
 */
function describeBodies(cfg) {
  const selected = (cfg.agent.body && cfg.agent.body.kind) || 'mineflayer';
  const available = [
    {
      kind: 'mineflayer',
      available: true,
      note: 'headless vanilla protocol; ~1s startup; many instances per machine'
    },
    {
      kind: 'mock',
      available: true,
      note: 'scripted world for decision-layer tests'
    }
  ];

  let clientModNote = 'not implemented yet - see docs/CLIENT-MOD-RECON.md';
  try {
    require.resolve('./clientModBody');
    clientModNote = 'implemented';
  } catch {
    /* keep the default note */
  }
  available.push({ kind: 'clientmod', available: clientModNote === 'implemented', note: clientModNote });

  return { selected, available };
}

module.exports = { createBody, describeBodies, KINDS };
