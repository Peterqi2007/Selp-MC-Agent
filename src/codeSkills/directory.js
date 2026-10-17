'use strict';

/**
 * CodeSkillDirectory - the on-disk half of the candidate/promoted split (P1 M4, A18/A20).
 *
 * Layout (all under one root):
 *
 *   candidates/<namespace>/<skill>/<version>/manifest.json + <entry>
 *   promoted/<namespace>/<skill>/<version>/manifest.json + <entry>
 *   promoted/<namespace>/<skill>/current.json     { version, previous, at }
 *
 * Rules:
 *   - a candidate is only ever written after `validateManifest()` accepts it, and the entry
 *     path must stay inside its own version directory (no `..`, no absolute path);
 *   - promotion **copies** the files, then atomically replaces `current.json`
 *     (temp + rename); a crash leaves either the old pointer or the new one;
 *   - rollback reads `previous` from the pointer and restores it;
 *   - retirement removes the promoted copy and clears the pointer when it is current;
 *   - nothing here imports, requires or executes the entry file.
 */

const fs = require('fs');
const path = require('path');
const { validateManifest } = require('./manifest');

function splitName(name) {
  const text = String(name || '');
  const dot = text.indexOf('.');
  if (dot <= 0 || dot === text.length - 1) return null;
  return { namespace: text.slice(0, dot), skill: text.slice(dot + 1) };
}

function writeFileAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, file);
}

class CodeSkillDirectory {
  constructor(options = {}) {
    if (!options.root) throw new Error('CodeSkillDirectory needs a root');
    this.root = path.resolve(options.root);
    this.candidatesRoot = path.join(this.root, 'candidates');
    this.promotedRoot = path.join(this.root, 'promoted');
    this.now = options.now || (() => Date.now());
  }

  candidateDir(name, version) {
    const parts = splitName(name);
    if (!parts) throw new Error(`invalid skill name: ${name}`);
    return path.join(this.candidatesRoot, parts.namespace, parts.skill, version);
  }

  promotedDir(name, version) {
    const parts = splitName(name);
    if (!parts) throw new Error(`invalid skill name: ${name}`);
    return path.join(this.promotedRoot, parts.namespace, parts.skill, version);
  }

  pointerFile(name) {
    const parts = splitName(name);
    if (!parts) throw new Error(`invalid skill name: ${name}`);
    return path.join(this.promotedRoot, parts.namespace, parts.skill, 'current.json');
  }

  /** Validate, then write manifest + entry atomically. Returns the directory. */
  writeCandidate(manifest, code) {
    const validation = validateManifest(manifest);
    if (!validation.ok) return { ok: false, reason: 'invalid-manifest', errors: validation.errors };
    if (typeof code !== 'string' || !code.trim()) return { ok: false, reason: 'empty-code' };
    if (!path.isAbsolute(manifest.entry)) {
      const dir = this.candidateDir(manifest.name, manifest.version);
      const entry = path.resolve(dir, manifest.entry);
      if (!entry.startsWith(`${dir}${path.sep}`)) return { ok: false, reason: 'entry-escapes-directory' };
      writeFileAtomic(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      writeFileAtomic(entry, code);
      return { ok: true, dir };
    }
    return { ok: false, reason: 'entry-must-be-relative' };
  }

  readCandidate(name, version) {
    try {
      const dir = this.candidateDir(name, version);
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      const code = fs.readFileSync(path.join(dir, manifest.entry), 'utf8');
      return { manifest, code, dir };
    } catch {
      return null;
    }
  }

  /** Copy the candidate into `promoted/` and atomically point `current.json` at it. */
  promote(name, version) {
    const candidate = this.readCandidate(name, version);
    if (!candidate) return { ok: false, reason: 'candidate-missing' };
    const dir = this.promotedDir(name, version);
    writeFileAtomic(path.join(dir, 'manifest.json'), `${JSON.stringify(candidate.manifest, null, 2)}\n`);
    writeFileAtomic(path.join(dir, candidate.manifest.entry), candidate.code);

    const pointer = this.current(name);
    const next = {
      version,
      previous: pointer ? pointer.version : null,
      at: new Date(this.now()).toISOString()
    };
    writeFileAtomic(this.pointerFile(name), `${JSON.stringify(next, null, 2)}\n`);
    return { ok: true, version, previous: next.previous, dir };
  }

  current(name) {
    try {
      return JSON.parse(fs.readFileSync(this.pointerFile(name), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Restore `previous`; with no previous, clear the pointer. */
  rollback(name) {
    const pointer = this.current(name);
    if (!pointer) return { ok: false, reason: 'not-promoted' };
    if (!pointer.previous) {
      fs.rmSync(this.pointerFile(name), { force: true });
      return { ok: true, version: null, rolledBackFrom: pointer.version };
    }
    const next = { version: pointer.previous, previous: null, at: new Date(this.now()).toISOString() };
    writeFileAtomic(this.pointerFile(name), `${JSON.stringify(next, null, 2)}\n`);
    return { ok: true, version: next.version, rolledBackFrom: pointer.version };
  }

  /** Remove a promoted version and clear the pointer if it was current. */
  retire(name, version) {
    const pointer = this.current(name);
    if (pointer && pointer.version === version) {
      fs.rmSync(this.pointerFile(name), { force: true });
    }
    fs.rmSync(this.promotedDir(name, version), { recursive: true, force: true });
    return { ok: true };
  }

  list() {
    const out = { candidates: [], promoted: [] };
    const walk = (root, bucket) => {
      if (!fs.existsSync(root)) return;
      for (const namespace of fs.readdirSync(root)) {
        const nsDir = path.join(root, namespace);
        if (!fs.statSync(nsDir).isDirectory()) continue;
        for (const skill of fs.readdirSync(nsDir)) {
          const skillDir = path.join(nsDir, skill);
          if (!fs.statSync(skillDir).isDirectory()) continue;
          for (const version of fs.readdirSync(skillDir)) {
            if (version === 'current.json') continue;
            if (fs.statSync(path.join(skillDir, version)).isDirectory()) {
              out[bucket].push(`${namespace}.${skill}@${version}`);
            }
          }
        }
      }
    };
    walk(this.candidatesRoot, 'candidates');
    walk(this.promotedRoot, 'promoted');
    return out;
  }
}

module.exports = { CodeSkillDirectory, splitName };
