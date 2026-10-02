'use strict';

/**
 * `npm run server:setup` - download and configure the headless Minecraft server.
 *
 * Usage:
 *   node scripts/setup-server.js                    # loader from config/server.json
 *   node scripts/setup-server.js 1.20.1             # vanilla, explicit minecraft version
 *   node scripts/setup-server.js --loader forge     # install the Forge dedicated server
 *   node scripts/setup-server.js --loader forge --java "C:\path\to\java.exe"
 */

const { loadConfig, normalizeLoader } = require('../src/util/config');
const { Logger } = require('../src/util/logger');
const { detectEnvironment } = require('../src/pcl/detect');
const { prepareServer } = require('../src/server/serverManager');
const { prepareForgeServer, parseForgeVersion } = require('../src/server/forgeServer');

function parse(argv) {
  const args = { loader: null, java: null, version: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--loader') args.loader = argv[++i];
    else if (a === '--java') args.java = argv[++i];
    else if (!a.startsWith('--')) args.version = a;
  }
  return args;
}

(async () => {
  const args = parse(process.argv.slice(2));
  const cfg = loadConfig();
  const log = new Logger('setup', { level: cfg.agent.logging.level, file: null });
  try {
    if (args.loader) cfg.server.loader = normalizeLoader(args.loader);
    const target = args.version || cfg.server.mcVersion;
    cfg.server.mcVersion = target;

    const env = detectEnvironment(cfg);
    const java = args.java || env.serverJava;

    if (cfg.server.loader === 'forge') {
      const v = parseForgeVersion(cfg.server.forgeVersion, cfg.server.mcVersion);
      if (!java) throw new Error('no java runtime found - pass --java or set pcl.javaCandidates in config/pcl.json');
      cfg.server.mcVersion = v.mcVersion;
      const prepared = await prepareForgeServer(cfg, { java, log });
      log.info(`java for server: ${java}`);
      log.info('--------------------------------------------------');
      log.info(`loader    : forge ${v.full}`);
      log.info(`server dir: ${prepared.serverDir}`);
      log.info(`args file : ${prepared.argsFile}`);
      log.info(`installer : ${prepared.installer}`);
      log.info(`mappings  : ${prepared.mappings || '(not needed/fetched)'}`);
      log.info(`port      : ${cfg.server.port}  online-mode=${cfg.server.onlineMode}`);
      log.info('next      : node scripts/run-all.js --loader forge');
      log.info('--------------------------------------------------');
      return;
    }

    const { serverDir, jar, artifact } = await prepareServer(cfg, log);
    log.info(`java for server: ${env.serverJava || '(none detected)'}`);
    log.info('--------------------------------------------------');
    log.info(`loader    : vanilla`);
    log.info(`version   : ${artifact.mcVersion}`);
    log.info(`server dir: ${serverDir}`);
    log.info(`server jar: ${jar}`);
    log.info(`port      : ${cfg.server.port}  online-mode=${cfg.server.onlineMode}`);
    log.info('next      : npm run agent      (starts server + bot)');
    log.info('            npm run pcl:client (opens PCL2 so you can join and watch)');
    log.info('--------------------------------------------------');
  } catch (err) {
    log.error(`setup failed: ${err.message}`);
    process.exitCode = 1;
  }
})();
