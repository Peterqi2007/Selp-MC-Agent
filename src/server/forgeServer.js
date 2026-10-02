'use strict';

/**
 * Forge 1.20.1 dedicated-server bootstrap.
 *
 * The vanilla path (`serverManager.js`) downloads a single self-contained jar. Forge
 * does not ship a ready-to-run server jar: the official installer downloads the
 * vanilla server, patches it with the Forge patches and emits a whole module-path
 * launch setup (`libraries/`, `run.bat` / `run.sh`, `user_jvm_args.txt` and the
 * `win_args.txt` / `unix_args.txt` @argfiles). This module drives that installer and
 * then starts the result through the very same @argfile mechanism the official
 * `run.bat` uses, so we never hardcode the module path.
 *
 * Everything is installed under `cfg.paths.server` (runtime/server) next to the
 * vanilla jar; the installer itself is cached in `runtime/server/forge/`.
 *
 * Reuses `download` / `sha1File` / `writeEula` / `writeServerProperties` /
 * `spawnServerProcess` from serverManager.js - no duplicated plumbing.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Logger } = require('../util/logger');
const {
  fetchJson,
  download,
  sha1File,
  writeEula,
  writeServerProperties,
  spawnServerProcess,
  memoryArgs,
  READY_RE,
  MANIFEST_URL,
  VERSION_MANIFEST_FALLBACK
} = require('./serverManager');

const FORGE_MAVEN_BASE = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
const DEFAULT_FORGE_VERSION = '1.20.1-47.4.10';
/** Compiling + patching can take a long time on a cold cache - never use a short timeout here. */
const INSTALL_TIMEOUT_MS = Number(process.env.FORGE_INSTALL_TIMEOUT_MS) || 20 * 60 * 1000;
/** Subdirectory that holds the cached installer jar. */
const INSTALLER_DIRNAME = 'forge';
/** The Forge installer looks for the official Mojang mappings under this name. */
const MAPPINGS_FILENAME = 'server_mappings.txt';
/** Installer output that means "I need server_mappings.txt from Mojang". */
const MAPPINGS_ISSUE_RE = /server_mappings|missing (required )?mappings|could not find .*mappings|mappings\.txt/i;
/** Forge-specific fatal lines (vanilla's own fail lines still apply). */
const FORGE_FAIL_RE = /You need to agree to the EULA|Failed to start the minecraft server|Exception in thread "main"/i;

/**
 * Accepts `1.20.1-47.4.10`, `47.4.10` (mcVersion is then taken from the config) and
 * returns the canonical coordinates used by every path/URL.
 */
function parseForgeVersion(forgeVersion, mcVersion = '1.20.1') {
  const raw = String(forgeVersion || DEFAULT_FORGE_VERSION).trim();
  if (!raw) throw new Error('empty forge version');
  const full = /^\d+\.\d+(\.\d+)?-/.test(raw) ? raw : `${mcVersion}-${raw}`;
  const dash = full.indexOf('-');
  const mc = full.slice(0, dash);
  const forge = full.slice(dash + 1);
  if (!/^\d+(\.\d+)+$/.test(forge)) {
    throw new Error(`cannot parse forge version "${raw}" (expected e.g. "1.20.1-47.4.10" or "47.4.10")`);
  }
  return { full, mcVersion: mc, forgeVersion: forge };
}

function installerUrl(v) {
  return `${FORGE_MAVEN_BASE}/${v.full}/forge-${v.full}-installer.jar`;
}

/** The `-universal.jar` is published next to the installer; handy for manual repairs. */
function universalUrl(v) {
  return `${FORGE_MAVEN_BASE}/${v.full}/forge-${v.full}-universal.jar`;
}

/** All the paths a Forge install produces, derived from the server dir. */
function forgePaths(serverDir, v) {
  const versionDir = path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge', v.full);
  return {
    installerDir: path.join(serverDir, INSTALLER_DIRNAME),
    installer: path.join(serverDir, INSTALLER_DIRNAME, `forge-${v.full}-installer.jar`),
    versionDir,
    winArgs: path.join(versionDir, 'win_args.txt'),
    unixArgs: path.join(versionDir, 'unix_args.txt'),
    serverJar: path.join(versionDir, `forge-${v.full}-server.jar`),
    runBat: path.join(serverDir, 'run.bat'),
    runSh: path.join(serverDir, 'run.sh'),
    userJvmArgs: path.join(serverDir, 'user_jvm_args.txt'),
    mappings: path.join(serverDir, MAPPINGS_FILENAME)
  };
}

/** The @argfile for this platform (win_args.txt on Windows, unix_args.txt elsewhere). */
function argsFileFor(serverDir, v, platform = process.platform) {
  const p = forgePaths(serverDir, v);
  const preferred = platform === 'win32' ? p.winArgs : p.unixArgs;
  return fs.existsSync(preferred) ? preferred : null;
}

/** `true` once Forge has patched the vanilla server (…/libraries/net/minecraft/server/<ver>/…-srg.jar). */
function hasPatchedServerLibraries(serverDir) {
  const dir = path.join(serverDir, 'libraries', 'net', 'minecraft', 'server');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!entry.isDirectory()) return false;
    try {
      return fs
        .readdirSync(path.join(dir, entry.name))
        .some((f) => /-srg\.jar$|-extra\.jar$/i.test(f));
    } catch {
      return false;
    }
  });
}

/**
 * Idempotency probe: is a complete Forge server already sitting in the server dir?
 * @returns {{installed:boolean, reason:string|null, version:object, argsFile:string|null, paths:object}}
 */
function detectForgeServer(cfg, options = {}) {
  const serverDir = cfg.paths.server;
  const version = parseForgeVersion(options.forgeVersion || cfg.server.forgeVersion, cfg.server.mcVersion);
  const p = forgePaths(serverDir, version);
  const argsFile = argsFileFor(serverDir, version);

  let installed = false;
  let reason = null;
  if (argsFile) {
    installed = true;
    reason = `@argfile ${path.basename(argsFile)}`;
  } else if ((fs.existsSync(p.runBat) || fs.existsSync(p.runSh)) && hasPatchedServerLibraries(serverDir)) {
    installed = true;
    reason = 'run script + patched server libraries';
  } else if (hasPatchedServerLibraries(serverDir) && fs.existsSync(p.serverJar)) {
    installed = true;
    reason = 'patched server libraries + forge server jar';
  }
  return { installed, reason, version, argsFile, paths: p };
}

/** Read `<url>.sha1` (plain 40 hex chars for MinecraftForge maven) so `download()` can verify. */
async function fetchSidecarSha1(url, log) {
  try {
    const res = await fetch(`${url}.sha1`, { redirect: 'follow' });
    if (!res.ok) {
      log.warn(`no .sha1 sidecar for ${path.basename(url)} (HTTP ${res.status}) - downloading unverified`);
      return null;
    }
    const text = (await res.text()).trim();
    const m = text.match(/\b[0-9a-f]{40}\b/i);
    if (!m) {
      log.warn(`unexpected .sha1 body for ${path.basename(url)}: ${JSON.stringify(text.slice(0, 80))}`);
      return null;
    }
    return m[0].toLowerCase();
  } catch (err) {
    log.warn(`could not fetch ${url}.sha1 (${err.message}) - downloading unverified`);
    return null;
  }
}

/**
 * Fetch the official Mojang server mappings for a version from the version manifest.
 * The Forge installer normally downloads its own mojmaps, but when it refuses to start
 * (`server_mappings.txt` missing) this is the file it wants in the install dir.
 * Mojang's CDN is occasionally slow to accept connections, so retry a few times.
 */
async function fetchServerMappings(mcVersion, dest, log = new Logger('forge'), force = false, attempts = 3) {
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log.info(`server mappings already present: ${dest}`);
    return { file: dest, cached: true };
  }
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      let manifest;
      try {
        manifest = await fetchJson(MANIFEST_URL);
      } catch (err) {
        log.warn(`primary manifest failed (${err.message}), trying fallback`);
        manifest = await fetchJson(VERSION_MANIFEST_FALLBACK);
      }
      const entry = (manifest.versions || []).find((v) => v.id === mcVersion);
      if (!entry) throw new Error(`Minecraft version ${mcVersion} not found in Mojang manifest`);
      const detail = await fetchJson(entry.url);
      const sm = detail.downloads && detail.downloads.server_mappings;
      if (!sm) throw new Error(`Mojang publishes no server_mappings for ${mcVersion}`);
      await download(sm.url, dest, sm.sha1, log);
      log.info(`server mappings -> ${dest}`);
      return { file: dest, url: sm.url, sha1: sm.sha1, size: sm.size, cached: false };
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        log.warn(`server mappings fetch attempt ${attempt}/${attempts} failed (${err.message}) - retrying`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  throw lastErr;
}

/** Run the Forge installer, streaming its output into the project log. */
function runInstaller(java, installer, serverDir, log, timeoutMs = INSTALL_TIMEOUT_MS) {
  const args = ['-jar', installer, '--installServer', serverDir];
  log.info(`running forge installer: ${java} -jar ${path.basename(installer)} --installServer "${serverDir}"`);
  log.info(`installer cwd: ${serverDir} (timeout ${Math.round(timeoutMs / 1000)}s)`);
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(java, args, { cwd: serverDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, output: `spawn failed: ${err.message}`, timedOut: false });
    }
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn(`forge installer exceeded ${Math.round(timeoutMs / 1000)}s - killing it`);
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    const handle = (chunk) => {
      const text = chunk.toString();
      output += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) log.info(`[forge] ${line}`);
    };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);
    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}\nspawn error: ${err.message}`, timedOut });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** Pull the interesting tail out of the installer output for an error message. */
function installerTail(output, lines = 12) {
  return String(output || '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-lines)
    .join(' | ');
}

/**
 * Download the installer (sha1-verified against the official `.sha1` sidecar) and run it.
 * Retries once with the Mojang `server_mappings.txt` in place if the installer asks for it.
 */
async function installForgeServer(cfg, options = {}, log = new Logger('forge')) {
  const serverDir = cfg.paths.server;
  const java = options.java;
  if (!java) throw new Error('prepareForgeServer requires a java executable (options.java)');
  const version = parseForgeVersion(options.forgeVersion || cfg.server.forgeVersion, cfg.server.mcVersion);
  const p = forgePaths(serverDir, version);

  fs.mkdirSync(p.installerDir, { recursive: true });

  const url = installerUrl(version);
  log.info(`forge ${version.full} installer: ${url}`);
  const sha1 = await fetchSidecarSha1(url, log);
  if (sha1) log.info(`expected installer sha1: ${sha1}`);
  await download(url, p.installer, sha1, log);
  const gotSha1 = sha1File(p.installer);
  if (sha1 && gotSha1 !== sha1) {
    throw new Error(`forge installer sha1 mismatch: expected ${sha1}, got ${gotSha1}`);
  }
  log.info(`installer verified: ${path.basename(p.installer)} sha1=${gotSha1} (${(fs.statSync(p.installer).size / 1048576).toFixed(1)} MiB)`);

  let result = await runInstaller(java, p.installer, serverDir, log, options.installTimeoutMs || INSTALL_TIMEOUT_MS);

  let argsFile = argsFileFor(serverDir, version);
  // Only chase server_mappings.txt when the install did not produce a launchable server
  // (Forge 47.x normally downloads Mojang's mojmaps itself) or when explicitly asked.
  const mappingsWanted =
    options.fetchMappings === 'always' ||
    (options.fetchMappings !== 'never' && !argsFile && (!result.timedOut || MAPPINGS_ISSUE_RE.test(result.output)));

  if (mappingsWanted) {
    try {
      await fetchServerMappings(version.mcVersion, p.mappings, log, options.fetchMappings === 'always');
    } catch (err) {
      log.warn(`could not fetch server mappings: ${err.message}`);
    }
    argsFile = argsFileFor(serverDir, version);
    if (!argsFile) {
      log.warn('retrying the forge installer with server_mappings.txt in place');
      result = await runInstaller(java, p.installer, serverDir, log, options.installTimeoutMs || INSTALL_TIMEOUT_MS);
      argsFile = argsFileFor(serverDir, version);
    }
  }

  if (!argsFile) {
    const detail = result.timedOut ? 'installer timed out' : `installer exit code ${result.code}`;
    throw new Error(
      `forge ${version.full} install failed (${detail}); last output: ${installerTail(result.output)}`
    );
  }
  log.info(`forge ${version.full} installed: ${argsFile}`);
  return { version, paths: p, argsFile, installerOutput: result.output };
}

/**
 * Make sure a runnable Forge server exists under cfg.paths.server:
 * installer cached + sha1-verified, patched server generated, eula/properties written.
 * Idempotent - an existing install is detected and left alone.
 *
 * @param {object} cfg loaded config
 * @param {{java?:string, forgeVersion?:string, force?:boolean, fetchMappings?:string,
 *          installTimeoutMs?:number, log?:object}} options
 * @returns {Promise<{serverDir:string, argsFile:string, installer:string, version:object,
 *                    mappings:string, installed:boolean, reason:string|null}>}
 */
async function prepareForgeServer(cfg, options = {}, log = options.log || new Logger('forge')) {
  const serverDir = cfg.paths.server;
  fs.mkdirSync(serverDir, { recursive: true });
  const state = detectForgeServer(cfg, options);
  const { version, paths: p } = state;

  let installed = false;
  let reason = null;

  if (state.installed && !options.force) {
    installed = true;
    reason = state.reason;
    log.info(`forge ${version.full} already installed (${state.reason}) - skipping installer`);
  } else {
    const res = await installForgeServer(cfg, options, log);
    installed = true;
    reason = 'installer run';
    log.info(`forge server ready in ${serverDir}`);
    // Keep the paths/argsFile we just proved exist.
    state.argsFile = res.argsFile;
  }

  writeEula(serverDir);
  writeServerProperties(serverDir, cfg.server);

  // Touch nothing else: Forge reads server.properties/eula.txt from the install dir,
  // exactly like the vanilla server, so both loaders can share runtime/server.
  fs.writeFileSync(
    path.join(serverDir, 'agent-forge.json'),
    JSON.stringify(
      {
        loader: 'forge',
        forgeVersion: version.full,
        mcVersion: version.mcVersion,
        installer: p.installer,
        installerUrl: installerUrl(version),
        universalUrl: universalUrl(version),
        argsFile: state.argsFile,
        mappings: fs.existsSync(p.mappings) ? p.mappings : null,
        port: cfg.server.port,
        preparedAt: new Date().toISOString()
      },
      null,
      2
    )
  );

  return {
    serverDir,
    argsFile: state.argsFile,
    installer: p.installer,
    mappings: fs.existsSync(p.mappings) ? p.mappings : null,
    version,
    installed,
    reason
  };
}

/** Non-comment lines of user_jvm_args.txt, if the file exists (mirrors run.bat). */
function userJvmArgLines(file, log) {
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (lines.length) log.info(`user_jvm_args.txt: ${lines.join(' ')}`);
    return lines;
  } catch {
    return [];
  }
}

/**
 * Start the Forge dedicated server headlessly through its generated @argfile.
 * Returns the same shape as `startServer()` in serverManager.js.
 *
 * @returns {{proc: import('child_process').ChildProcess, ready: Promise<void>, logFile: string,
 *            command: (cmd:string)=>boolean, stop: (timeoutMs?:number)=>Promise<void>, args: string[], argsFile: string}}
 */
function startForgeServer(cfg, options = {}) {
  const log = options.log || new Logger('forge');
  const serverDir = cfg.paths.server;
  const java = options.java;
  if (!java) throw new Error('startForgeServer requires a java executable (options.java)');

  const version = parseForgeVersion(options.forgeVersion || cfg.server.forgeVersion, cfg.server.mcVersion);
  const p = forgePaths(serverDir, version);
  const argsFile = argsFileFor(serverDir, version, options.platform);
  if (!argsFile) {
    throw new Error(
      `forge ${version.full} is not installed in ${serverDir} ` +
        `(missing ${path.relative(serverDir, p.winArgs)} / ${path.basename(p.unixArgs)}) - run: npm run server:setup -- --loader forge`
    );
  }
  if (!fs.existsSync(p.serverJar)) {
    log.warn(`forge server jar not found at ${p.serverJar} - continuing, the @argfile decides the module path`);
  }

  // The official run.bat is: java @user_jvm_args.txt @libraries/.../win_args.txt nogui
  // We pass the memory args explicitly instead of relying on user_jvm_args.txt, and use a
  // path relative to the server dir so spaces in the project path never matter.
  const heap = options.maxHeapMb || cfg.server.maxHeapMb || 4096;
  const relArgsFile = path.relative(serverDir, argsFile).split(path.sep).join('/');
  const args = [
    ...memoryArgs(heap),
    `@${relArgsFile}`,
    ...userJvmArgLines(p.userJvmArgs, log),
    ...(options.extraArgs || []),
    'nogui'
  ];

  log.info(`forge ${version.full}: ${argsFile}`);
  const preview = fs.readFileSync(argsFile, 'utf8').split(/\r?\n/).filter(Boolean).slice(0, 3);
  for (const line of preview) log.debug(`[args] ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);

  fs.mkdirSync(cfg.paths.logs, { recursive: true });
  const logFile = path.join(cfg.paths.logs, `forge-server-${Date.now()}.log`);
  const handle = spawnServerProcess({
    java,
    args,
    cwd: serverDir,
    logFile,
    log,
    readyRe: READY_RE,
    failRe: FORGE_FAIL_RE
  });
  return { ...handle, args, argsFile };
}

module.exports = {
  prepareForgeServer,
  startForgeServer,
  installForgeServer,
  detectForgeServer,
  fetchServerMappings,
  parseForgeVersion,
  forgePaths,
  argsFileFor,
  hasPatchedServerLibraries,
  installerUrl,
  universalUrl,
  FORGE_MAVEN_BASE,
  DEFAULT_FORGE_VERSION,
  INSTALL_TIMEOUT_MS,
  MAPPINGS_FILENAME
};
