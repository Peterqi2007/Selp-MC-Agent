'use strict';

/**
 * Launch the interactive Minecraft client through PCL2.
 *
 * PCL2 accepts `--launch <versionName>` which boots the selected profile with the
 * account stored in PCL, exactly like pressing the big "启动游戏" button. This module
 * keeps that path in one place so the agent scripts can offer "open the game so a
 * human can watch the bot" as a single command.
 */

const { spawn } = require('child_process');
const path = require('path');
const { detectEnvironment, buildLaunchArgs } = require('./detect');
const { Logger } = require('../util/logger');

/**
 * @param {object} cfg   full config
 * @param {object} [opts] { version?: string, detached?: boolean }
 */
function launchClient(cfg, opts = {}) {
  const log = opts.log || new Logger('pcl');
  const env = detectEnvironment(cfg);
  if (!env.pclExe) {
    throw new Error('PCL2 executable not found. Set pcl.pclExe in config/pcl.json');
  }
  const version = opts.version || env.clientVersion;
  const args = version ? buildLaunchArgs(version) : [];
  log.info(`launching PCL2: "${env.pclExe}" ${args.join(' ')}`);
  log.info(`minecraft dir: ${env.minecraftDir || '(unknown)'}`);

  const proc = spawn(env.pclExe, args, {
    cwd: path.dirname(env.pclExe),
    detached: opts.detached !== false,
    stdio: 'ignore',
    windowsHide: false
  });
  if (opts.detached !== false) proc.unref();
  return { proc, env, version };
}

/** Human-readable environment report used by `npm run pcl:info`. */
function environmentReport(cfg) {
  const env = detectEnvironment(cfg);
  return {
    pcl: {
      executable: env.pclExe,
      directory: env.pclDir,
      candidates: env.pclExecutables,
      activeVersionInIni: env.pclIni.Version || null,
      lastLaunchScript: env.lastLaunchScript
    },
    minecraft: {
      dir: env.minecraftDir,
      versions: env.versions,
      selectedClientVersion: env.clientVersion
    },
    java: env.java,
    serverJava: env.serverJava
  };
}

module.exports = { launchClient, environmentReport };
