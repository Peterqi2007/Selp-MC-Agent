'use strict';

/**
 * `npm run client:check` - is a Forge client running with the control mod attached?
 *
 * Use this before switching the agent to `--body clientmod`: it tells you plainly
 * whether the mod's HTTP API is up, and if not, whether that is because the client is
 * not running, the mod is not installed, or the client is simply not in a world yet.
 *
 *   node scripts/client-check.js [--port 8899] [--wait 60]
 */

const { loadConfig } = require('../src/util/config');
const { ClientModBody } = require('../src/body/clientModBody');
const { Logger } = require('../src/util/logger');

const args = process.argv.slice(2);
function valueOf(flag) {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const next = args[i + 1];
  return !next || next.startsWith('--') ? null : next;
}

const cfg = loadConfig();
const port = Number(valueOf('--port')) || (cfg.agent.clientMod && cfg.agent.clientMod.port) || 8899;
const waitSeconds = Number(valueOf('--wait')) || 0;

const out = (s = '') => process.stdout.write(`${s}\n`);

(async () => {
  const body = new ClientModBody(cfg, { port, log: new Logger('client-check') });
  out('minecraft-survival-agent - client body check');
  out(`probing ${body.baseUrl}`);
  out('');

  let health = null;
  try {
    health = await body.health();
  } catch (err) {
    out(`  could not reach the control mod: ${err.message}`);
    out('');
    out('  this usually means one of:');
    out('    1. the Forge client is not running        -> npm run client:launch');
    out('    2. the mod is not installed in the client -> see mod-client/BUILDING.md');
    out('    3. the mod is installed but failed to bind the port (check the client log)');
    out('    4. the mod could not be BUILT yet (this machine cannot reach ForgeGradle maven)');
    out('');
    out(`  expected jar: mod-client/dist/agent-client-1.0.0.jar`);
    out(`  expected in : <gameDir>\\mods\\   (gameDir = versions\\1.20.1-Forge_47.4.10)`);
    process.exitCode = 1;
    return;
  }

  out(`  mod reachable: v${health.version} (inWorld=${health.inWorld})`);

  if (waitSeconds > 0 && !health.inWorld) {
    out(`  waiting up to ${waitSeconds}s for the client to enter a world...`);
    const deadline = Date.now() + waitSeconds * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const state = await body.refresh(true);
        if (state && state.ready) break;
      } catch {
        /* keep waiting */
      }
    }
  }

  const state = await body.refresh(true).catch(() => null);
  if (!state || !state.ready) {
    out('  mod is up but the client is NOT in a world yet (still at the main menu?)');
    out('  the agent needs the client joined to a server before it can act');
    process.exitCode = 2;
    return;
  }

  out('');
  out('  client state');
  out('  ------------');
  out(`    dimension   ${state.dimension}`);
  out(`    position    ${JSON.stringify(state.position)}`);
  out(`    health/food ${state.health} / ${state.food}`);
  out(`    held item   ${state.heldItem}`);
  out(`    blocks seen ${state.blocks && state.blocks.cells ? Object.keys(state.blocks.cells).length : 0} cells`);
  out(`    hostiles    ${(state.hostiles || []).length}`);
  out(`    inventory   ${Object.keys(state.inventory || {}).length} kinds`);
  out('');
  out('  OK - start the agent with:  node src/index.js --body clientmod --profile simpfun');
})().catch((err) => {
  out(`client check crashed: ${err.stack}`);
  process.exitCode = 1;
});
