'use strict';

/**
 * `node scripts/launch-forge-client.js` - launch the REAL Forge 1.20.1 client headlessly
 * (no PCL2 GUI, no clicks) and redirect its stdio to runtime/logs/.
 *
 * WHY THIS EXISTS
 * ---------------
 * The old strategy talked to servers over the vanilla protocol (mineflayer). Forge servers
 * reject that with "This server has mods that require Forge to be installed on the client".
 * The replacement strategy is to run a real, modded Forge client and drive it from inside via
 * a client-side control mod. This script is the "get the process up" half of that.
 *
 * HOW THE COMMAND LINE IS BUILT
 * -----------------------------
 * The version JSON that PCL2/Forge left on disk
 *   <minecraftDir>\versions\<version>\<version>.json
 * is a complete, self-contained (no `inheritsFrom`) 1.20.1-Forge profile. We read it and:
 *   1. resolve every `libraries[]` entry, honouring `rules` (os name/arch) exactly like the
 *      official launcher, and check each artifact actually exists on disk;
 *   2. join the survivors into `-cp ${classpath}` and `${library_directory}` placeholders;
 *   3. expand the `arguments.jvm` and `arguments.game` lists (which contain conditional
 *      `{rules, value}` blocks - e.g. `--quickPlayMultiplayer`) and substitute every
 *      `${placeholder}` with a real value;
 *   4. spawn it detached with stdio appended to a log file.
 *
 * The Forge installer's `win_args.txt` under runtime\server\... is the SERVER argfile (it pulls
 * in the dedicated-server classes and has no auth/gameDir arguments) and is deliberately NOT
 * used here.
 *
 * FLAGS
 * -----
 *   --offline                 offline (cracked) session, default username agent
 *   --username <name>         player name (implies offline when --online is absent)
 *   --server <host[:port]>    auto-join via --quickPlayMultiplayer host:port
 *   --singleplayer <world>    boot straight into a single-player world folder
 *                             (--quickPlaySingleplayer; used to restart the test client
 *                             without a human clicking through the main menu)
 *   --memory <MB>             -Xmx in MB (also sizes -Xms)
 *   --dry-run                 print the full command line and exit without launching
 *   --javaw                   use javaw.exe instead of java.exe (no console window)
 *   --wait-for-menu <sec>     tail the game log until the main menu / atlas is ready
 *   --log <file>              override the captured stdout/stderr log path
 *   --extra-arg <arg>         repeatable, appended verbatim to the JVM args
 *   --version <versionFolder> override the client version folder
 *   --help
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// config + environment detection (reuse the project helpers, do not re-invent)
// ---------------------------------------------------------------------------

const { loadConfig } = require('../src/util/config');
const detect = require('../src/pcl/detect');
const { spawnSync } = require('child_process');

const DEFAULT_VERSION = '1.20.1-Forge_47.4.10';
const DEFAULT_OFFLINE_USERNAME = 'agent';

// The java-runtime-delta shipped with the Microsoft Store Minecraft launcher: Java 21, which is
// the right JVM for 1.20.1 Forge. Java 25 (C:\Users\<you>\.jdks\openjdk-25.0.1) will NOT boot it.
const KNOWN_JAVA_DIRS = [
  'C:\\Users\\<you>\\AppData\\Local\\Packages\\Microsoft.4297127D64EC6_8wekyb3d8bbwe\\LocalCache\\Local\\runtime\\java-runtime-delta\\windows-x64\\java-runtime-delta',
  'C:\\Users\\<you>\\AppData\\Roaming\\.minecraft\\runtime\\java-runtime-delta',
  'C:\\Program Files\\Java\\jdk-17',
  'C:\\Program Files\\Eclipse Adoptium\\jdk-17'
];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg, code = 1) {
  process.stderr.write(`\n[launch-forge-client] ERROR: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    offline: false,
    online: false,
    username: null,
    server: null,
    singleplayer: null,
    memory: null,
    dryRun: false,
    javaw: false,
    waitForMenuSec: 0,
    logFile: null,
    extraArgs: [],
    version: null,
    width: 854,
    height: 480
  };

  const need = (i, name) => {
    if (i + 1 >= argv.length) fail(`${name} needs a value`);
    return argv[i + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--offline': opts.offline = true; break;
      case '--online': opts.online = true; break;
      case '--username': opts.username = need(i, a); i += 1; opts.offline = true; break;
      case '--server': opts.server = need(i, a); i += 1; break;
      case '--singleplayer': opts.singleplayer = need(i, a); i += 1; break;
      case '--memory': opts.memory = Number(need(i, a)); i += 1; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--javaw': opts.javaw = true; break;
      case '--wait-for-menu': opts.waitForMenuSec = Number(need(i, a)); i += 1; break;
      case '--log': opts.logFile = need(i, a); i += 1; break;
      case '--extra-arg': opts.extraArgs.push(need(i, a)); i += 1; break;
      case '--version': opts.version = need(i, a); i += 1; break;
      case '--width': opts.width = Number(need(i, a)); i += 1; break;
      case '--height': opts.height = Number(need(i, a)); i += 1; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (String(a).startsWith('--')) fail(`unknown flag ${a} (try --help)`);
        break;
    }
  }

  if (opts.memory != null && (!Number.isFinite(opts.memory) || opts.memory < 512)) {
    fail(`--memory must be a number >= 512 (got ${opts.memory})`);
  }
  return opts;
}

function printHelp() {
  log(fs.readFileSync(__filename, 'utf8').split('FLAGS')[1].split('*/')[0].trim());
}

function quoteForDisplay(arg) {
  if (arg === '') return '""';
  return /[\s"&^|<>()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function formatCommandLine(javaExe, args, maxLen = 0) {
  const parts = [quoteForDisplay(javaExe), ...args.map(quoteForDisplay)];
  if (maxLen > 0 && parts.join(' ').length > maxLen) {
    return parts.join(' \\\n  ');
  }
  return parts.join(' ');
}

function isWindowsPathLike(value) {
  return typeof value === 'string' && (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/'));
}

/** Normalize to the backslash form the official launcher uses for -D properties and -cp. */
function winPath(p) {
  return process.platform === 'win32' ? path.win32.normalize(p) : p;
}

// ---------------------------------------------------------------------------
// rule evaluation (mirrors net.minecraft.launcher / Mojang's version.json spec)
// ---------------------------------------------------------------------------

function osName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

function osArch() {
  switch (process.arch) {
    case 'x64': return 'x86_64';
    case 'ia32': return 'x86';
    case 'arm64': return 'arm64';
    default: return process.arch;
  }
}

/** true when a rule set allows this platform/feature combination. */
function rulesAllow(rules, features) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== osName()) matches = false;
      if (rule.os.arch && rule.os.arch !== osArch()) matches = false;
      if (rule.os.version && !new RegExp(rule.os.version).test(os.release())) matches = false;
    }
    if (rule.features) {
      for (const [key, want] of Object.entries(rule.features)) {
        if (!!features[key] !== !!want) matches = false;
      }
    }
    if (!matches) continue;
    allowed = rule.action === 'allow';
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// library resolution
// ---------------------------------------------------------------------------

/** maven "group:artifact:version[:classifier][@ext]" -> repository relative path */
function mavenToPath(name) {
  let ext = 'jar';
  let base = name;
  const at = name.indexOf('@');
  if (at >= 0) {
    ext = name.slice(at + 1);
    base = name.slice(0, at);
  }
  const parts = base.split(':');
  const [group, artifact, version] = parts;
  const classifier = parts[3] ? `-${parts[3]}` : '';
  const file = `${artifact}-${version}${classifier}.${ext}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

/**
 * Resolve libraries[] to on-disk jars.
 * Returns { jars, skipped, missing } where skipped are rule-excluded (linux/osx natives etc.)
 * and missing are Windows artifacts that should exist but do not.
 */
function resolveLibraries(versionJson, minecraftDir, features) {
  const jars = [];
  const skipped = [];
  const missing = [];
  const seen = new Set();

  for (const lib of versionJson.libraries || []) {
    if (!rulesAllow(lib.rules, features)) {
      skipped.push({ name: lib.name, reason: 'rules' });
      continue;
    }
    let rel = null;
    if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) {
      rel = lib.downloads.artifact.path;
    } else if (lib.name) {
      rel = mavenToPath(lib.name);
    }
    if (!rel) {
      skipped.push({ name: lib.name || '(unnamed)', reason: 'no artifact path' });
      continue;
    }
    // Forge's own jars live in libraries/ too (forge-1.20.1-47.4.10-client.jar etc).
    const abs = path.join(minecraftDir, 'libraries', rel);
    if (!fs.existsSync(abs)) {
      missing.push({ name: lib.name, path: rel });
      continue;
    }
    // Deduplicate identical placements only; Forge legitimately ships two `fusion` mods.
    if (seen.has(abs)) continue;
    seen.add(abs);
    jars.push(abs);
  }
  return { jars, skipped, missing };
}

// ---------------------------------------------------------------------------
// argument template expansion
// ---------------------------------------------------------------------------

/**
 * Flatten `arguments.jvm` / `arguments.game` into a plain string[].
 * Entries are either a string or { rules, value: string|string[] }.
 */
function flattenArguments(list, features) {
  const out = [];
  for (const entry of list || []) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object' && 'value' in entry) {
      if (!rulesAllow(entry.rules, features)) continue;
      const value = entry.value;
      if (Array.isArray(value)) out.push(...value.map(String));
      else out.push(String(value));
    }
  }
  return out;
}

/** Replace ${placeholder} tokens; unknown placeholders are reported, never emitted raw. */
function substitute(arg, vars) {
  return String(arg).replace(/\$\{([^}]+)\}/g, (whole, key) => {
    const value = vars[key];
    if (value === undefined || value === null) return whole; // caller detects leftovers
    return String(value);
  });
}

/**
 * The version JSON emits `--clientId ${clientid}` and `--xuid ${auth_xuid}`, which expand to
 * empty strings in an offline session. Emitting `--clientId --xuid --userType legacy` would let
 * jopt-simple bind `--xuid` as the *value* of `--clientId`, so both the flag and its empty value
 * are dropped here. Everything else is substituted normally.
 */
function expandArgumentList(list, vars) {
  const out = [];
  for (const raw of list) {
    const value = substitute(raw, vars);
    const isPlaceholderOnly = /^\$\{[^}]+\}$/.test(String(raw));
    if (value === '' && isPlaceholderOnly) {
      const prev = out[out.length - 1];
      if (typeof prev === 'string' && /^--/.test(prev)) out.pop();
      continue;
    }
    out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

/** Offline UUID: UUID v3 of "OfflinePlayer:<name>" - the same value vanilla servers compute. */
function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // IETF variant
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidToMojangId(uuid) {
  return String(uuid).replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// java selection
// ---------------------------------------------------------------------------

function pickJava(cfg, env, opts) {
  const candidates = [];
  const push = (p, why, versionInfo) => {
    if (!p) return;
    const resolved = path.resolve(String(p).trim());
    const existing = candidates.find((c) => c.path.toLowerCase() === resolved.toLowerCase());
    if (existing) return;
    candidates.push({ path: resolved, why, version: versionInfo || null });
  };

  push(process.env.MC_JAVA, 'env MC_JAVA');
  // src/pcl/detect already ran `java -version` for every candidate it found - reuse that.
  for (const j of env.java || []) {
    const p = opts.javaw ? j.path.replace(/java\.exe$/i, 'javaw.exe') : j.path;
    push(p, 'detected by src/pcl/detect', { raw: j.version, major: j.major, ok: j.ok });
  }
  for (const dir of (cfg.pcl && cfg.pcl.javaCandidates) || []) {
    push(path.join(dir, opts.javaw ? 'javaw.exe' : 'java.exe'), 'config/pcl.json');
  }
  for (const dir of KNOWN_JAVA_DIRS) {
    push(path.join(dir, opts.javaw ? 'javaw.exe' : 'java.exe'), 'known runtime location');
  }

  const usable = candidates.filter((c) => fs.existsSync(c.path));
  if (!usable.length) return null;

  // `javaVersionOf` is module-private in src/pcl/detect; ask java itself when we have to.
  // Candidates that detection already probed arrive pre-sorted by major (descending), which is
  // why config/pcl.json's Java 25 entry would otherwise win - the 17..21 band filter below is
  // what actually keeps 1.20.1 Forge bootable.
  const withVersion = usable.map((c) => (c.version && c.version.ok ? { ...c, ...c.version } : { ...c, ...javaVersionOf(c.path) }));

  // 1.20.1 Forge needs Java 17-21. Java 22+ fails with UnsupportedClassVersionError / mixin
  // bootstrap errors, so prefer the 17..21 band hardest, then fall back to whatever exists and
  // let java report its own error.
  const inBand = (c) => c.major >= 17 && c.major <= 21;
  const band = withVersion.filter(inBand);
  if (process.env.MC_LAUNCH_DEBUG) {
    for (const c of withVersion) log(`[debug] java candidate ${c.path} major=${c.major} raw=${c.raw} why=${c.why} inBand=${inBand(c)}`);
  }
  const chosen = band[0] || withVersion[0];
  return { ...chosen, all: withVersion };
}

/** `java -version` probe. Mirrors src/pcl/detect.js javaVersionOf (not exported there). */
function javaVersionOf(javaExe) {
  try {
    const res = spawnSync(javaExe, ['-version'], { encoding: 'utf8', timeout: 20000 });
    const text = `${res.stdout || ''}${res.stderr || ''}`;
    const m = text.match(/version "([^"]+)"/);
    if (!m) return { raw: null, major: null, ok: false };
    const parts = String(m[1]).split('.');
    const major = parts[0] === '1' ? Number(parts[1]) : Number(parts[0]);
    return { raw: m[1], major, ok: true };
  } catch {
    return { raw: null, major: null, ok: false };
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { printHelp(); return; }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    fail(`loadConfig() failed: ${err.message}`);
  }

  const pclCfg = cfg.pcl || {};
  const version = opts.version || pclCfg.clientVersion || DEFAULT_VERSION;

  // -- environment detection -------------------------------------------------
  let env = {};
  try {
    env = detect.detectEnvironment(cfg) || {};
  } catch (err) {
    log(`[warn] detectEnvironment() failed (${err.message}); falling back to config values`);
  }

  const minecraftDir = pclCfg.minecraftDir || env.minecraftDir;
  if (!minecraftDir) {
    fail('cannot determine the Minecraft directory (config/pcl.json "minecraftDir" is empty and detection found no versions/ folder)');
  }
  if (!fs.existsSync(minecraftDir)) fail(`Minecraft directory does not exist: ${minecraftDir}`);

  const versionDir = path.join(minecraftDir, 'versions', version);
  const versionJsonPath = path.join(versionDir, `${version}.json`);
  if (!fs.existsSync(versionJsonPath)) {
    fail(`version JSON not found: ${versionJsonPath}\n        available: ${(env.versions || []).join(', ') || '(none detected)'}`);
  }

  let versionJson;
  try {
    versionJson = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
  } catch (err) {
    fail(`cannot parse ${versionJsonPath}: ${err.message}`);
  }
  if (versionJson.inheritsFrom) {
    log(`[warn] version JSON inherits from "${versionJson.inheritsFrom}"; inheritance is not resolved by this script`);
  }

  // -- java -----------------------------------------------------------------
  const java = pickJava(cfg, env, opts);
  if (!java) {
    fail('no usable java.exe/javaw.exe found. Set MC_JAVA=<path> or add one to config/pcl.json "javaCandidates".');
  }
  const usesJavaw = /javaw\.exe$/i.test(java.path);
  const gameDir = versionDir; // PCL2 uses per-version isolation for this profile ("版本隔离")
  const nativesDir = fs.existsSync(path.join(versionDir, `${version}-natives`))
    ? path.join(versionDir, `${version}-natives`)
    : path.join(minecraftDir, 'versions', version, 'natives');
  const assetsDir = path.join(minecraftDir, 'assets');
  const libraryDir = path.join(minecraftDir, 'libraries');

  if (!fs.existsSync(nativesDir)) {
    fail(`natives directory not found: ${nativesDir} (the profile is not fully installed)`);
  }

  const username = opts.username || DEFAULT_OFFLINE_USERNAME;
  const uuid = offlineUuid(username);

  // -- features: which conditional argument blocks get enabled --------------
  const features = {
    is_demo_user: false,
    has_custom_resolution: true,
    has_quick_plays_support: !!(opts.server || opts.singleplayer),
    is_quick_play_multiplayer: !!opts.server,
    is_quick_play_singleplayer: !!opts.singleplayer,
    is_quick_play_realms: false
  };
  let quickPlayTarget = null;
  if (opts.server) {
    const raw = String(opts.server).trim();
    const m = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (m) quickPlayTarget = m[2] ? `${m[1]}:${m[2]}` : m[1];
    else quickPlayTarget = /:\d+$/.test(raw) ? raw : `${raw}:25565`;
  }

  // -- libraries ------------------------------------------------------------
  const { jars, skipped, missing } = resolveLibraries(versionJson, minecraftDir, features);
  if (missing.length) {
    log('[launch-forge-client] missing library artifacts for this platform:');
    for (const m of missing) log(`   - ${m.name}  ->  ${m.path}`);
    fail(`${missing.length} required library jar(s) are absent; this profile is incompletely installed (let PCL2 repair it first)`);
  }
  if (!jars.length) fail('resolved an empty classpath from the version JSON');

  const versionJar = path.join(versionDir, `${version}.jar`);
  if (!fs.existsSync(versionJar)) {
    fail(`client jar missing: ${versionJar}`);
  }
  const classpathEntries = [...jars, versionJar];

  const vars = {
    natives_directory: winPath(nativesDir),
    launcher_name: 'minecraft-agent',
    launcher_version: '1.0',
    classpath: classpathEntries.map(winPath).join(';'),
    classpath_separator: ';',
    library_directory: winPath(libraryDir),
    version_name: version,
    game_directory: winPath(gameDir),
    assets_root: winPath(assetsDir),
    assets_index_name: versionJson.assetIndex ? versionJson.assetIndex.id : versionJson.assets,
    auth_player_name: username,
    auth_uuid: uuidToMojangId(uuid),
    auth_access_token: '0',
    auth_xuid: '',
    clientid: '',
    user_type: 'legacy',
    version_type: 'PCL',
    resolution_width: String(opts.width),
    resolution_height: String(opts.height),
    quickPlayPath: '',
    quickPlaySingleplayer: opts.singleplayer ? String(opts.singleplayer) : '',
    quickPlayMultiplayer: quickPlayTarget || '',
    quickPlayRealms: ''
  };

  // -- jvm args -------------------------------------------------------------
  const memory = opts.memory || 4096;
  const rawJvm = flattenArguments(versionJson.arguments && versionJson.arguments.jvm, features);
  const jvmArgs = [
    '-Dstderr.encoding=UTF-8',
    '-Dstdout.encoding=UTF-8',
    '-Dfile.encoding=UTF-8',
    `-Xmx${memory}M`,
    `-Xms${Math.max(1024, Math.round(memory / 2))}M`,
    '-XX:+UseG1GC',
    '-XX:-OmitStackTraceInFastThrow',
    '-Dfml.ignoreInvalidMinecraftCertificates=True',
    '-Dfml.ignorePatchDiscrepancies=True',
    '-Dlog4j2.formatMsgNoLookups=true',
    ...opts.extraArgs
  ];
  for (const a of rawJvm) {
    let expanded = substitute(a, vars);
    // Drop the macOS-only launcher switch if the rules ever let it through.
    if (expanded === '-XstartOnFirstThread') continue;
    // Only path-valued arguments get separator normalisation: `${library_directory}/cpw/mods/...`
    // in the module path becomes `C:\...\libraries/cpw/...`. Java tolerates the mixed form but
    // native separators read better in logs. Arguments that mix a drive letter with a *module*
    // name (`--add-opens java.base/java.util.jar=...`) contain no drive letter, so they are safe.
    if (process.platform === 'win32' && /[a-zA-Z]:[\\/]/.test(expanded)) {
      expanded = expanded.replace(/\//g, '\\');
    }
    jvmArgs.push(expanded);
  }

  // -- game args ------------------------------------------------------------
  // `${quickPlayMultiplayer}` and friends collapse to "" when there is no server to join; those
  // entries are dropped entirely rather than passed as empty arguments.
  const rawGame = flattenArguments(versionJson.arguments && versionJson.arguments.game, features);
  const gameArgs = expandArgumentList(rawGame, vars).filter((a) => a !== '');

  // -- assemble -------------------------------------------------------------
  let mainClass = versionJson.mainClass;
  const args = [...jvmArgs, mainClass, ...gameArgs];
  const leftovers = args.filter((a) => /\$\{[^}]+\}/.test(a));
  if (leftovers.length) fail(`unsubstituted placeholders remain: ${leftovers.join(' | ')}`);

  // -- log path -------------------------------------------------------------
  const logsDir = cfg.paths && cfg.paths.logs ? cfg.paths.logs : path.join(__dirname, '..', 'runtime', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const logFile = opts.logFile ? path.resolve(opts.logFile) : path.join(logsDir, `forge-client-${stamp}.log`);
  const metaFile = logFile.replace(/\.log$/i, '') + '.json';

  const summary = [
    '===================== launch-forge-client =====================',
    `java        : ${java.path}  (${java.raw || 'version unknown'}, why: ${java.why})`,
    `minecraft   : ${minecraftDir}`,
    `version     : ${version}`,
    `mainClass   : ${mainClass}`,
    `gameDir     : ${gameDir}`,
    `natives     : ${nativesDir}`,
    `username    : ${username}${opts.offline ? ' (offline)' : ''}`,
    `uuid        : ${uuid}`,
    `memory      : -Xmx${memory}M -Xms${Math.max(1024, Math.round(memory / 2))}M`,
    `libraries   : ${jars.length} jars on classpath (+ version jar)`,
    `rule-skipped: ${skipped.length} libs (other OS natives)`,
    `quickPlay   : ${quickPlayTarget || (opts.singleplayer ? `singleplayer:${opts.singleplayer}` : '(none)')}`,
    `log         : ${logFile}`,
    `game log    : ${path.join(gameDir, 'logs', 'latest.log')}`,
    `summary json: ${metaFile}`,
    '==============================================================='
  ].join('\n');

  if (opts.dryRun) {
    log(summary);
    log('');
    log('--- COMMAND LINE (copy/paste into a shell, backslashes are literal) ---');
    log(formatCommandLine(java.path, args));
    log('');
    log(`--- argv length: ${args.length} args, ${args.join(' ').length} chars ---`);
    return;
  }

  // -- launch ---------------------------------------------------------------
  const fd = fs.openSync(logFile, 'a');
  const header = `\n\n########## launched ${new Date().toISOString()} by scripts/launch-forge-client.js ##########\n`
    + `${summary}\n`
    + `CMD: ${formatCommandLine(java.path, args)}\n`
    + '########## client stdout/stderr follows ##########\n';
  fs.writeSync(fd, header);

  let child;
  try {
    child = spawn(java.path, args, {
      cwd: gameDir,
      detached: true,        // survive this script exiting
      windowsHide: true,
      stdio: ['ignore', fd, fd]
    });
  } catch (err) {
    fs.closeSync(fd);
    fail(`spawn failed: ${err.message}`);
  }

  child.on('error', (err) => {
    process.stderr.write(`[launch-forge-client] spawn error: ${err.message}\n`);
  });

  const meta = {
    startedAt: new Date().toISOString(),
    pid: child.pid,
    java: java.path,
    javaVersion: java.raw,
    minecraftDir,
    version,
    gameDir,
    username,
    uuid,
    offline: !!opts.offline,
    memoryMb: memory,
    quickPlay: quickPlayTarget,
    quickPlaySingleplayer: opts.singleplayer || null,
    logFile,
    gameLog: path.join(gameDir, 'logs', 'latest.log'),
    classpathJars: jars.length,
    argv: args
  };
  try {
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  } catch (err) {
    log(`[warn] could not write ${metaFile}: ${err.message}`);
  }
  fs.closeSync(fd);

  log(summary);
  log('');
  log(`[launch-forge-client] spawned pid ${child.pid} (detached).`);
  log(`[launch-forge-client] kill it with:  Stop-Process -Id ${child.pid} -Force`);
  log(`[launch-forge-client] tail the log with:  Get-Content -Wait "${logFile}"`);

  if (opts.waitForMenuSec > 0) {
    waitForMenu(child, opts.waitForMenuSec, path.join(gameDir, 'logs', 'latest.log'), logFile);
  } else {
    child.unref();
  }
}

// ---------------------------------------------------------------------------
// optional watchdog: wait until the client is actually usable
// ---------------------------------------------------------------------------

const MENU_MARKERS = [
  /Created: \d+x\d+x\d+ minecraft:textures\/atlas\/blocks\.png-atlas/,
  /Sound engine started/,
  /Reloading ResourceManager: vanilla/
];
const FATAL_MARKERS = [
  /A fatal error has been detected by the Java Runtime Environment/,
  /Failed to start game/,
  /Exception in thread "main"/,
  /Could not find or load main class/,
  /has been detected by the Java Runtime/,
  /LWJGL Version: .*failed/
];

function waitForMenu(child, seconds, gameLog, captureLog) {
  const deadline = Date.now() + seconds * 1000;
  const seen = new Set();
  let tail = '';
  let finished = false;

  const readAll = (file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  };

  const finish = (verdict, detail) => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    log('');
    log(`[launch-forge-client] ${verdict}: ${detail}`);
    if (captureLog) log(`[launch-forge-client] captured stdout: ${captureLog}`);
    log(`[launch-forge-client] game log: ${gameLog}`);
    // Detach without killing: an unattended run must be able to keep the client alive.
    try { child.unref(); } catch { /* already gone */ }
  };

  const timer = setInterval(() => {
    const text = readAll(gameLog) || readAll(captureLog);
    tail = text.slice(-2000);
    for (const re of MENU_MARKERS) {
      const m = text.match(re);
      if (m) seen.add(m[0]);
    }
    for (const re of FATAL_MARKERS) {
      const m = text.match(re);
      if (m) return finish('FAILED - fatal marker in log', m[0]);
    }
    if (seen.size >= 2) {
      return finish('OK - client reached the main menu', [...seen].join(' ; '));
    }
    if (Date.now() > deadline) {
      return finish(`TIMEOUT after ${seconds}s - no main-menu marker`, 'last log lines:\n' + tail);
    }
  }, 2000);
  timer.unref?.();
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs, rulesAllow, mavenToPath, resolveLibraries, flattenArguments, substitute, offlineUuid };
