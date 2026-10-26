'use strict';

/**
 * `node scripts/test-forge.js` - real end-to-end check of the Forge path.
 *
 * It installs (if needed) the Forge 1.20.1 server described by config/server.json and
 * actually boots it until the log prints `Done (…)! For help, type "help"`, then stops it.
 *
 * Safety rails, because a vanilla server is usually already running from the same
 * runtime/server directory:
 *   - it never uses the configured port unless you pass --port; default is 25570
 *   - it uses a throwaway level name (`forge-test-world`) so the live world is untouched
 *   - it backs up server.properties and restores it on exit
 *   - it re-checks that the original port (25565) is still serving afterwards
 *
 * Usage:
 *   node scripts/test-forge.js                      # install + boot + stop
 *   node scripts/test-forge.js --port 25571         # another port
 *   node scripts/test-forge.js --install-only       # just prepare/verify the install
 *   node scripts/test-forge.js --skip-install       # boot what is already installed
 *   node scripts/test-forge.js --java "C:\path\java.exe"
 *   node scripts/test-forge.js --timeout 900        # ready timeout in seconds
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { waitForPort, withTimeout, READY_RE } = require('../src/server/serverManager');
const { prepareForgeServer, startForgeServer, detectForgeServer, parseForgeVersion } = require('../src/server/forgeServer');

/**
 * Java 21 (the runtime the launcher ships) - Forge 47.x is unhappy on Java 25. Built from
 * %LOCALAPPDATA% rather than a hardcoded C:\Users\<name>\... path so no personal directory
 * ends up in git; pass --java to override.
 */
const PREFERRED_JAVA = process.env.LOCALAPPDATA
  ? path.join(
      process.env.LOCALAPPDATA,
      'Packages',
      'Microsoft.4297127D64EC6_8wekyb3d8bbwe',
      'LocalCache',
      'Local',
      'runtime',
      'java-runtime-delta',
      'windows-x64',
      'java-runtime-delta',
      'bin',
      'java.exe'
    )
  : null;

function parse(argv) {
  const args = {
    port: 25570,
    level: 'forge-test-world',
    java: null,
    installOnly: false,
    skipInstall: false,
    timeout: 900,
    keepWorld: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--level') args.level = argv[++i];
    else if (a === '--java') args.java = argv[++i];
    else if (a === '--install-only') args.installOnly = true;
    else if (a === '--skip-install') args.skipInstall = true;
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--keep-world') args.keepWorld = true;
  }
  return args;
}

function pickJava(explicit) {
  if (explicit) return explicit;
  if (PREFERRED_JAVA && fs.existsSync(PREFERRED_JAVA)) return PREFERRED_JAVA;
  const { detectEnvironment } = require('../src/pcl/detect');
  const env = detectEnvironment(loadConfig());
  if (!env.serverJava) throw new Error('no java runtime found - pass --java <path>');
  return env.serverJava;
}

function javaMajor(java) {
  const { spawnSync } = require('child_process');
  const res = spawnSync(java, ['-version'], { encoding: 'utf8' });
  const text = `${res.stdout || ''}${res.stderr || ''}`;
  const m = text.match(/version "([^"]+)"/);
  if (!m) return null;
  const parts = m[1].split('.');
  return parts[0] === '1' ? Number(parts[1]) : Number(parts[0]);
}

function readLogLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

async function main() {
  const args = parse(process.argv.slice(2));
  const cfg = loadConfig();
  const log = new Logger('test-forge', { level: 'info', file: null });
  const java = pickJava(args.java);
  const major = javaMajor(java);

  cfg.server.loader = 'forge';
  cfg.server.port = args.port;
  cfg.server.levelName = args.level;
  cfg.agent.bot.port = args.port;

  const version = parseForgeVersion(cfg.server.forgeVersion, cfg.server.mcVersion);
  const propsFile = path.join(cfg.paths.server, 'server.properties');
  const propsBackup = fs.existsSync(propsFile) ? fs.readFileSync(propsFile) : null;
  const vanillaAliveBefore = await waitForPort('127.0.0.1', 25565, 3000).catch(() => false);

  log.info('==========================================================');
  log.info(`forge e2e test: forge ${version.full}, mc ${version.mcVersion}`);
  log.info(`java   : ${java} (major ${major})`);
  log.info(`port   : ${args.port}   level: ${args.level}`);
  log.info(`server : ${cfg.paths.server}`);
  log.info(`vanilla server on 25565 before test: ${vanillaAliveBefore ? 'yes' : 'no'}`);
  log.info('==========================================================');

  let server = null;
  let readyLine = null;
  let exitCode = 0;

  try {
    // ---------------------------------------------------------------- install
    log.info('--- step 1: prepare / verify the forge install ---');
    let prepared;
    if (args.skipInstall) {
      const state = detectForgeServer(cfg, {});
      if (!state.installed) throw new Error(`no forge install found in ${cfg.paths.server}`);
      prepared = { serverDir: cfg.paths.server, argsFile: state.argsFile, installer: state.paths.installer, version: state.version, mappings: null, installed: false, reason: state.reason };
      log.info(`using existing install (${state.reason})`);
    } else {
      prepared = await prepareForgeServer(cfg, { java, log });
    }
    const argsFilePath = prepared.argsFile;
    if (!argsFilePath || !fs.existsSync(argsFilePath)) throw new Error(`forge @argfile missing: ${argsFilePath}`);
    log.info(`OK forge ${version.full} installed -> ${argsFilePath}`);
    log.info(`   win_args.txt: ${fs.existsSync(path.join(cfg.paths.server, 'libraries/net/minecraftforge/forge', version.full, 'win_args.txt'))}`);
    log.info(`   run.bat     : ${fs.existsSync(path.join(cfg.paths.server, 'run.bat'))}`);
    log.info(`   installer   : ${prepared.installer} (${(fs.statSync(prepared.installer).size / 1048576).toFixed(1)} MiB)`);
    log.info(`   mappings    : ${prepared.mappings || '(none)'}`);

    if (args.installOnly) {
      log.info('--install-only: not starting the server');
      return;
    }

    // ------------------------------------------------------------------ boot
    log.info('--- step 2: boot the forge server ---');
    server = startForgeServer(cfg, { java, log });
    log.info(`launch args: ${server.args.join(' ')}`);
    log.info(`server log : ${server.logFile}`);

    await withTimeout(server.ready, args.timeout * 1000, `forge server not ready within ${args.timeout}s`);
    readyLine = readLogLines(server.logFile).find((l) => READY_RE.test(l)) || null;
    log.info(`OK forge server reached ready: ${readyLine ? readyLine.trim() : '(line not found in log)'}`);

    const open = await waitForPort('127.0.0.1', args.port, 30000).then(() => true).catch(() => false);
    log.info(`port ${args.port} accepting connections: ${open ? 'yes' : 'NO'}`);
    if (!open) throw new Error(`forge server reported ready but port ${args.port} is closed`);

    server.command('list');
    await new Promise((r) => setTimeout(r, 2000));
  } catch (err) {
    exitCode = 1;
    log.error(`TEST FAILED: ${err.message}`);
    const file = server && server.logFile;
    if (file) {
      const lines = readLogLines(file).filter(Boolean);
      log.error('--- last 25 server log lines ---');
      for (const line of lines.slice(-25)) log.error(line);
    }
  } finally {
    if (server) {
      log.info('--- step 3: stopping the test server ---');
      await server.stop(90000);
      await new Promise((r) => setTimeout(r, 1000));
      log.info(`forge server exited (code ${server.proc.exitCode})`);
      const stopping = readLogLines(server.logFile).filter((l) => /Stopping server|Saving worlds|ThreadedAnvilChunkStorage/.test(l)).slice(-2);
      for (const line of stopping) log.info(`stop proof: ${line.trim()}`);
    }
    if (propsBackup) {
      fs.writeFileSync(propsFile, propsBackup);
      log.info('restored the original server.properties (vanilla settings)');
    }
    if (!args.keepWorld) {
      const world = path.join(cfg.paths.server, args.level);
      if (fs.existsSync(world)) {
        fs.rmSync(world, { recursive: true, force: true });
        log.info(`removed the throwaway test world ${world}`);
      }
    }
    const vanillaAliveAfter = await waitForPort('127.0.0.1', 25565, 3000).catch(() => false);
    log.info(`vanilla server on 25565 after test: ${vanillaAliveAfter ? 'yes (untouched)' : 'NO'}`);
    log.info('==========================================================');
    log.info(exitCode === 0 ? 'FORGE TEST PASSED' : 'FORGE TEST FAILED');
    log.info(`ready line: ${readyLine ? readyLine.trim() : '(none)'}`);
    log.info(`server log: ${server ? server.logFile : '(none)'}`);
    log.info('==========================================================');
    process.exitCode = exitCode;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fatal:', err.stack || err.message);
  process.exit(1);
});
