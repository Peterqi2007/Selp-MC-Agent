'use strict';

/**
 * PCL2 (Plain Craft Launcher 2) integration.
 *
 * PCL2 is a GUI launcher, but it is fully scriptable from the outside:
 *   - it keeps its working state in `<minecraftDir>/PCL.ini` and `<pclDir>/Setup.ini`
 *   - it exports the exact java command line of the last launch to `LatestLaunch.bat`
 *   - it can be started with `--launch <versionName>` to boot a profile directly
 *
 * This module detects that installation and turns it into data the agent can use:
 * java binaries, available versions, mod dirs and the launch command template.
 */

const fs = require('fs');
const path = require('path');

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function parseIni(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^([^:=\s][^:=]*):(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function readIni(file) {
  try {
    return parseIni(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** Walk up from a starting directory looking for something that looks like a PCL install. */
function findPclExecutables(seeds) {
  const found = [];
  const seen = new Set();
  const candidates = [];

  for (const seed of seeds) {
    if (!exists(seed)) continue;
    let dir = path.resolve(seed);
    // A directory seed may itself be the PCL folder.
    for (let depth = 0; depth < 4 && dir && !seen.has(dir); depth += 1) {
      seen.add(dir);
      candidates.push(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const dir of candidates) {
    for (const name of listFilesSafe(dir)) {
      if (/^PCL.*\.exe$/i.test(name) || /Plain Craft Launcher.*\.exe$/i.test(name)) {
        found.push(path.join(dir, name));
      }
    }
  }
  return [...new Set(found)];
}

function listFilesSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function javaVersionOf(javaExe) {
  const { spawnSync } = require('child_process');
  try {
    const res = spawnSync(javaExe, ['-version'], { encoding: 'utf8', timeout: 15000 });
    const text = `${res.stdout || ''}${res.stderr || ''}`;
    const m = text.match(/version "([^"]+)"/);
    const major = m ? Number(String(m[1]).split('.')[0].replace(/^1$/, (x) => x)) : null;
    const parts = m ? String(m[1]).split('.') : [];
    const normalizedMajor = m ? (parts[0] === '1' ? Number(parts[1]) : Number(parts[0])) : null;
    return { raw: m ? m[1] : null, major: normalizedMajor, ok: !!m };
  } catch {
    return { raw: null, major: null, ok: false };
  }
}

/**
 * Detect the local PCL2 + Minecraft installation.
 * @param {object} cfg  loaded config (config/pcl.json section is cfg.pcl)
 */
function detectEnvironment(cfg = {}) {
  const pclCfg = cfg.pcl || {};
  const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default';

  const minecraftDirCandidates = [
    pclCfg.minecraftDir,
    path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), '.minecraft'),
    path.join(home, '.minecraft'),
    path.join(home, 'Desktop', '.minecraft'),
    'C:\\Users\\inohg\\AppData\\Roaming\\.minecraft'
  ].filter(Boolean);

  const minecraftDir = minecraftDirCandidates.find((p) => exists(path.join(p, 'versions'))) || null;

  const pclSeeds = [
    pclCfg.pclExe,
    'E:\\PCL\\PCL',
    'D:\\PCL',
    path.join(process.env.APPDATA || '', 'PCL'),
    path.join(process.env.APPDATA || '', 'PCL2')
  ].filter(Boolean);

  const pclExecutables = [];
  if (pclCfg.pclExe && exists(pclCfg.pclExe)) pclExecutables.push(pclCfg.pclExe);
  for (const f of findPclExecutables(pclSeeds)) if (!pclExecutables.includes(f)) pclExecutables.push(f);

  const pclExe = pclExecutables[0] || null;
  const pclDir = pclExe ? path.dirname(pclExe) : null;

  // PCL.ini lives inside the selected .minecraft folder and records the active version.
  const pclIni = minecraftDir ? readIni(path.join(minecraftDir, 'PCL.ini')) : {};
  const setupIni = pclDir ? readIni(path.join(pclDir, 'Setup.ini')) : {};

  const versions = minecraftDir ? listDirs(path.join(minecraftDir, 'versions')) : [];

  // Java: PCL's own java registry (config.json) plus the well-known runtime folders.
  const javaCandidates = [];
  const pclConfigPath = path.join(process.env.APPDATA || '', 'PCL', 'config.json');
  if (exists(pclConfigPath)) {
    try {
      const jc = JSON.parse(fs.readFileSync(pclConfigPath, 'utf8'));
      for (const entry of jc.JavaList || []) {
        if (entry && entry.Folder) javaCandidates.push(path.join(entry.Folder, 'java.exe'));
      }
    } catch {
      /* ignore malformed registry */
    }
  }
  for (const c of pclCfg.javaCandidates || []) javaCandidates.push(c);
  if (minecraftDir) {
    javaCandidates.push(path.join(minecraftDir, 'runtime', 'java-runtime-delta', 'bin', 'java.exe'));
    javaCandidates.push(path.join(minecraftDir, 'runtime', 'java-runtime-gamma', 'bin', 'java.exe'));
  }
  javaCandidates.push(
    'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jdk-17\\bin\\java.exe'
  );

  const javas = [];
  for (const candidate of [...new Set(javaCandidates)]) {
    if (!exists(candidate)) continue;
    const v = javaVersionOf(candidate);
    javas.push({ path: candidate, version: v.raw, major: v.major, ok: v.ok });
  }
  javas.sort((a, b) => (b.major || 0) - (a.major || 0));

  // Pick a java that can actually boot a 1.20.1 server: 17-21 is the safe band.
  const serverJava =
    javas.find((j) => j.major === 17) ||
    javas.find((j) => j.major === 21) ||
    javas.find((j) => j.major === 20) ||
    javas.find((j) => j.major === 18) ||
    javas.find((j) => j.major === 19) ||
    javas.find((j) => j.major >= 22) ||
    javas[0] ||
    null;

  const clientVersion = pclCfg.clientVersion || pclIni.Version || versions.find((v) => /forge/i.test(v)) || null;

  return {
    pclExe,
    pclDir,
    pclExecutables,
    minecraftDir,
    versions,
    pclIni,
    setupIni,
    lastLaunchScript: pclDir ? firstExisting([path.join(pclDir, 'LatestLaunch.bat')]) : null,
    java: javas,
    serverJava: serverJava ? serverJava.path : null,
    clientVersion
  };
}

function firstExisting(paths) {
  return paths.find((p) => exists(p)) || null;
}

/** Build the argv PCL2 needs to launch a profile without any GUI interaction. */
function buildLaunchArgs(version) {
  return ['--launch', version];
}

/** Read the real java command line PCL used last time (very handy for building a matching server cmd). */
function readLastLaunchCommand(env) {
  const file = env && env.lastLaunchScript;
  if (!file) return null;
  try {
    const text = fs.readFileSync(file, 'latin1');
    const line = text
      .split(/\r?\n/)
      .find((l) => /java\.exe/i.test(l) && /-cp\s/i.test(l));
    if (!line) return null;
    const workdirMatch = text.match(/cd \/D\s+"([^"]+)"/i);
    const memMatch = line.match(/-Xmx(\d+)([mMgG])/);
    return {
      commandLine: line.replace(/^\s*"?/, '').trim(),
      workdir: workdirMatch ? workdirMatch[1] : null,
      maxHeapMb: memMatch ? Number(memMatch[1]) * (/g/i.test(memMatch[2]) ? 1024 : 1) : null
    };
  } catch {
    return null;
  }
}

module.exports = { detectEnvironment, buildLaunchArgs, readLastLaunchCommand, parseIni, readIni, exists };
