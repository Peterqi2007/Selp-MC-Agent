'use strict';

/**
 * `npm run start:all` - the one-command entry point.
 *
 *  1. makes sure the dedicated server is downloaded/configured
 *  2. starts it and waits until it reports "Done"
 *  3. starts the mineflayer survival agent against it
 *  4. optionally opens PCL2 so a human can join the same world and watch
 *  5. pipes both console streams into one timestamped log and shuts everything
 *     down cleanly on Ctrl-C
 *
 * Usage:
 *   node scripts/run-all.js                 # server + agent
 *   node scripts/run-all.js --with-client   # also launch PCL2
 *   node scripts/run-all.js --day --goal "gather 32 wood"
 *   node scripts/run-all.js --no-server     # connect to an already running server
 *   node scripts/run-all.js --loader forge  # boot the Forge 1.20.1 dedicated server instead
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { loadConfig, normalizeLoader } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { detectEnvironment } = require('../src/pcl/detect');
const { prepareServer, startServer, waitForPort, withTimeout } = require('../src/server/serverManager');
const { prepareForgeServer, startForgeServer, parseForgeVersion } = require('../src/server/forgeServer');
const { launchClient } = require('../src/pcl/launcher');

function parse(argv) {
  const args = { withClient: false, noServer: false, noAgent: false, day: false, goal: null, java: null, port: null, loader: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--with-client') args.withClient = true;
    else if (a === '--no-server') args.noServer = true;
    else if (a === '--no-agent') args.noAgent = true;
    else if (a === '--day') args.day = true;
    else if (a === '--goal') args.goal = argv[++i];
    else if (a === '--java') args.java = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--loader') args.loader = argv[++i];
  }
  return args;
}

/** Human readable loader label used in the step logs. */
function loaderLabel(cfg) {
  if (cfg.server.loader === 'forge') {
    const v = parseForgeVersion(cfg.server.forgeVersion, cfg.server.mcVersion);
    return `Forge ${v.full}`;
  }
  return `vanilla ${cfg.server.mcVersion}`;
}

async function main() {
  const args = parse(process.argv.slice(2));
  const cfg = loadConfig();
  if (args.loader) {
    try {
      cfg.server.loader = normalizeLoader(args.loader);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`fatal: ${err.message}`);
      process.exit(1);
    }
  }
  if (args.port) {
    cfg.server.port = args.port;
    cfg.agent.bot.port = args.port;
  }
  const log = new Logger('run', { level: cfg.agent.logging.level, file: path.join(cfg.paths.logs, 'orchestrator.log') });

  const children = [];
  let server = null;

  const shutdown = async (why) => {
    log.warn(`shutting down (${why})`);
    for (const child of children) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    if (server) await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const env = detectEnvironment(cfg);
  const java = args.java || env.serverJava;
  if (!java) {
    log.error('no java runtime found - install a JDK 17+ or set pcl.javaCandidates in config/pcl.json');
    process.exit(1);
  }

  if (!args.noServer) {
    const loader = loaderLabel(cfg);
    log.info(`server loader: ${loader} (${args.loader ? '--loader' : 'config/server.json'})`);
    log.info(`step 1/3: preparing the dedicated server (${loader})`);
    let prepared;
    try {
      prepared = cfg.server.loader === 'forge' ? await prepareForgeServer(cfg, { java, log }) : await prepareServer(cfg, log);
    } catch (err) {
      log.error(`server preparation failed: ${err.message}`);
      await shutdown('server preparation failure');
      return;
    }
    log.info(`step 2/3: starting the server (${loader})`);
    server =
      cfg.server.loader === 'forge' ? startForgeServer(cfg, { java, log }) : startServer(cfg, { java, log, jar: prepared.jar });
    // Forge has to bootstrap its module layer + mod list, so give it a longer window.
    const readyTimeoutMs = cfg.server.loader === 'forge' ? 600000 : 180000;
    try {
      await withTimeout(server.ready, readyTimeoutMs, `server did not become ready in ${readyTimeoutMs / 1000}s`);
    } catch (err) {
      log.error(`server failed to start: ${err.message}`);
      await shutdown('server start failure');
      return;
    }
    log.info(`server ready on port ${cfg.server.port} (${loader}, log: ${server.logFile})`);
  } else {
    log.info('skipping server start (--no-server)');
    await waitForPort(cfg.agent.bot.host, cfg.agent.bot.port, 5000).catch(() => {
      log.warn(`nothing listening on ${cfg.agent.bot.host}:${cfg.agent.bot.port} yet - the agent will keep retrying`);
    });
  }

  if (args.noAgent) {
    /**
     * Server-only mode for the personal-server workflow.
     *
     * Phase 2/3 functional tests run the REAL client (control mod + clientmod body) against
     * this local vanilla server; a mineflayer bot would be a second agent in the same world,
     * so tests want the server without it. The process stays up until Ctrl+C.
     */
    log.info(`server only - no agent started. Point the Forge client at 127.0.0.1:${cfg.server.port} and run the agent with "--body clientmod --profile local".`);
    log.info('Ctrl+C stops the server.');
    return;
  }
  log.info('step 3/3: starting the mineflayer agent');
  const agentArgs = [path.join(cfg.root, 'src', 'index.js'), '--force'];
  if (args.day) agentArgs.push('--day');
  if (args.goal) agentArgs.push('--goal', args.goal);
  const agent = spawn(process.execPath, agentArgs, { cwd: cfg.root, stdio: 'inherit', env: process.env });
  children.push(agent);
  agent.on('exit', (code) => {
    log.warn(`agent exited with code ${code}`);
    if (!args.noServer) shutdown('agent exit');
  });

  if (args.withClient) {
    // Give the bot a moment to join first, then open PCL2 so you can watch it play.
    setTimeout(() => {
      try {
        launchClient(cfg, { log });
        log.info('PCL2 launched - join the server at 127.0.0.1 to watch (username must differ from the bot)');
      } catch (err) {
        log.warn(`could not launch PCL2: ${err.message}`);
      }
    }, 4000);
  } else {
    log.info('tip: pass --with-client to open PCL2 and watch the agent in-game');
  }

  const stateHint = path.join(cfg.paths.runtime, 'agent-state.json');
  if (fs.existsSync(stateHint)) log.info(`agent state file: ${stateHint}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
