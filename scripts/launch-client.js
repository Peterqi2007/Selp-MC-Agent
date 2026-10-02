'use strict';

/**
 * `npm run pcl:client` - open the Minecraft client through PCL2.
 *
 * Use this to actually watch the agent: start it, let PCL2 boot the configured
 * profile, then join the same server with a *different* username and spectate.
 */

const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { launchClient } = require('../src/pcl/launcher');

const cfg = loadConfig();
const log = new Logger('pcl');
const version = process.argv[2] || null;

try {
  const { env, version: launched } = launchClient(cfg, { version, log });
  log.info('--------------------------------------------------');
  log.info(`PCL2        : ${env.pclExe}`);
  log.info(`Minecraft   : ${env.minecraftDir}`);
  log.info(`Version     : ${launched || '(whatever PCL has selected)'}`);
  log.info(`Server      : ${cfg.agent.bot.host}:${cfg.agent.bot.port}`);
  log.info(`Bot name    : ${cfg.agent.bot.username}  <- do not use the same name`);
  log.info('--------------------------------------------------');
} catch (err) {
  log.error(`failed to launch PCL2: ${err.message}`);
  process.exitCode = 1;
}
