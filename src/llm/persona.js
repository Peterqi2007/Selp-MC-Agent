'use strict';

/**
 * Persona loader: read the character sheet from `config/persona.md`.
 *
 * Why a file instead of config strings
 * ------------------------------------
 * The persona used to be three fields in `config/llm.json` (`name`, `style`, `honesty`).
 * That is enough to say "be a catgirl" and nothing else: no background, no speech patterns,
 * no worked examples. The examples are the part that actually steers a model - it imitates
 * samples far more than it follows abstract rules - and they do not fit in a JSON string.
 *
 * So the character sheet is a Markdown file with a small YAML frontmatter block:
 *
 *   ---
 *   schema: 1
 *   name: 大肥鱼
 *   trigger: "@大肥鱼"
 *   maxChars: 120
 *   ---
 *   # 你是谁
 *   ...
 *
 * **The body is injected into the system prompt verbatim.** That is deliberate: the operator
 * wrote it as prompt text, and re-interpreting it (parsing sections into fields) would only
 * lose information and couple the loader to the file's headings.
 *
 * The frontmatter carries the few values the *program* needs: the display name, the dialogue
 * trigger, and the character budget for a single spoken line.
 *
 * Failure policy: a missing or malformed file must never stop the agent. The loader falls back
 * to the built-in defaults and says so once, because "the bot loads but has no personality" is
 * a far better outcome than "the bot does not load".
 */

const fs = require('fs');
const path = require('path');

/** Used when config/persona.md is absent, so a fresh checkout still runs. */
const FALLBACK = {
  schema: 1,
  name: 'agent',
  species: null,
  emoji: null,
  trigger: null,
  maxChars: 100,
  locale: 'zh-CN',
  version: 0,
  updated: null
};

/**
 * Parse the frontmatter block.
 *
 * Deliberately a tiny YAML subset (`key: value`, optional single/double quotes, `#` comments)
 * rather than a YAML dependency: the file is written by hand, the shape is fixed, and the
 * project's policy is zero new runtime dependencies for something this small.
 *
 * @param {string} text
 * @returns {{fields: object, body: string, hadFrontmatter: boolean}}
 */
function parseFrontmatter(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const match = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { fields: {}, body: src.trim(), hadFrontmatter: false };

  const fields = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    /**
     * Trailing comment.
     *
     * Only a `#` preceded by whitespace starts a comment. Requiring that whitespace is what
     * keeps `# ← 必须与 llm.json 一致` stripped from a bare value like `@大肥鱼` while leaving
     * a `#` inside quotes alone - and either quote style wins, because `trigger: "@x"  # note`
     * is the shape a human actually writes.
     */
    const quoted = value.match(/^(["'])([\s\S]*?)\1\s*(?:#.*)?$/);
    if (quoted) {
      value = quoted[2];
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (!value) continue;
    if (/^-?\d+$/.test(value)) fields[key] = Number(value);
    else if (value === 'true') fields[key] = true;
    else if (value === 'false') fields[key] = false;
    else fields[key] = value;
  }
  return { fields, body: src.slice(match[0].length).trim(), hadFrontmatter: true };
}

/**
 * Strip the operator-facing maintenance notes from the body.
 *
 * The file documents *how to maintain it* in HTML comments and in a trailing
 * "loader will append..." block. Both are addressed to the human editing the file. Sending
 * them to the model wastes tokens and invites it to comment on its own instructions, so the
 * prompt gets the prose only.
 *
 * @param {string} body
 * @returns {string}
 */
function stripAuthorNotes(body) {
  return String(body || '')
    // HTML comments (the maintenance banners).
    .replace(/<!--[\s\S]*?-->/g, '')
    /**
     * The trailing maintenance block.
     *
     * It is a run of `#`-prefixed lines that starts with the banner `# ── 结尾提醒...` (or an
     * English `# loader appends`). Matching the marker rather than a line number keeps this
     * working when the operator adds more examples above it.
     *
     * The header of this block is itself a `#` heading, so the pattern must tolerate the
     * banner text between the `#` and the marker: `^#\s*[─\s]*结尾提醒`.
     */
    .replace(/\n#\s*[─\-\s]*结尾提醒[\s\S]*$/m, '')
    .replace(/\n#\s*[─\-\s]*loader appends[\s\S]*$/im, '')
    .trim();
}

/**
 * Resolve which persona file to read.
 *
 * Order: explicit option > `llm.persona.file` config > `PERSONA_FILE` env > `config/persona.md`.
 * Relative paths are resolved from the repository root (`cfg.root`) so the agent behaves the
 * same regardless of the working directory it was started from.
 *
 * @param {object} cfg the `llm` config section
 * @param {string} [root] repository root
 * @returns {string}
 */
function resolveFile(cfg = {}, root) {
  const explicit =
    (cfg.persona && cfg.persona.file) || process.env.PERSONA_FILE || path.join('config', 'persona.md');
  const base = root || process.cwd();
  return path.isAbsolute(explicit) ? explicit : path.resolve(base, explicit);
}

/**
 * Load and cache the persona.
 *
 * Cached on (path, mtimeMs, size) so editing the file takes effect without restarting the
 * agent, while a steady state costs one `statSync` per call.
 *
 * @param {object} options { cfg, root, log, file, reload }
 * @returns {{name:string, species:string|null, emoji:string|null, trigger:string|null,
 *            maxChars:number, body:string, source:string, loaded:boolean, error:string|null}}
 */
function loadPersona(options = {}) {
  const cfg = options.cfg || {};
  const file = options.file || resolveFile(cfg, options.root);
  const log = options.log || null;

  if (!options.reload && cache.entry && cache.key === file) {
    let sig = null;
    try {
      const st = fs.statSync(file);
      sig = `${st.mtimeMs}:${st.size}`;
    } catch {
      sig = 'missing';
    }
    if (sig === cache.sig) return cache.entry;
    cache.sig = sig;
  }

  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }

  const entry = { ...FALLBACK, body: '', source: file, loaded: false, error: null };

  if (!stat || !stat.isFile()) {
    entry.error = 'persona file not found';
    if (log) log.warn(`persona: ${file} not found - using the built-in default character`);
    cache.key = file;
    cache.sig = 'missing';
    cache.entry = entry;
    return entry;
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    entry.error = `unreadable: ${err.message}`;
    if (log) log.warn(`persona: cannot read ${file} (${err.message}) - using the default character`);
    cache.key = file;
    cache.sig = 'unreadable';
    cache.entry = entry;
    return entry;
  }

  const { fields, body, hadFrontmatter } = parseFrontmatter(text);
  Object.assign(entry, {
    schema: fields.schema === undefined ? FALLBACK.schema : fields.schema,
    name: fields.name || FALLBACK.name,
    species: fields.species || null,
    emoji: fields.emoji || null,
    trigger: fields.trigger || null,
    maxChars: Number.isFinite(fields.maxChars) ? fields.maxChars : FALLBACK.maxChars,
    locale: fields.locale || FALLBACK.locale,
    version: Number.isFinite(fields.version) ? fields.version : 0,
    updated: fields.updated || null,
    body: stripAuthorNotes(body),
    loaded: true,
    error: hadFrontmatter ? null : 'no frontmatter block'
  });

  if (!hadFrontmatter && log) {
    log.warn(`persona: ${file} has no frontmatter - name/trigger fall back to defaults`);
  }
  if (entry.loaded && log) {
    log.info(`persona loaded: ${entry.name}${entry.species ? ` (${entry.species})` : ''} - ${entry.body.length} chars`);
  }

  cache.key = file;
  cache.sig = stat ? `${stat.mtimeMs}:${stat.size}` : 'unknown';
  cache.entry = entry;
  return entry;
}

/** Cached parse, keyed on (path, mtime, size). */
const cache = { key: null, sig: null, entry: null };

/** Drop the cache. Used by tests and by `--reload`. */
function clearCache() {
  cache.key = null;
  cache.sig = null;
  cache.entry = null;
}

/**
 * The dialogue trigger in effect, resolved in one place.
 *
 * Both the in-game chat listener (`src/index.js`) and the control panel
 * (`src/web/statusServer.js`) need this, and they used to resolve it independently with their
 * own hardcoded trigger fallback. That is exactly the kind of duplication that goes wrong
 * after a character swap: the panel would keep routing a dead trigger while the chat listener
 * used the new one.
 *
 * Order: explicit config (`agent.chat.dialogueTrigger`) > persona frontmatter > legacy default.
 * The config wins so an operator can point the trigger at a nickname without editing the
 * character sheet; the persona file is the fallback so swapping characters does not silently
 * kill the channel.
 *
 * @param {object} ctx agent context (needs cfg.agent.chat and cfg.llm)
 * @param {object} [options] { log }
 * @returns {string|null} null when dialogue is switched off entirely
 */
function resolveTrigger(ctx, options = {}) {
  const agentCfg = (ctx && ctx.cfg && ctx.cfg.agent) || {};
  const chatCfg = agentCfg.chat || {};
  if (chatCfg.dialogueTrigger === false) return null;
  const persona = personaForConfig(ctx, options);
  if (chatCfg.dialogueTrigger) {
    if (options.log && persona.trigger && chatCfg.dialogueTrigger !== persona.trigger) {
      options.log.warn(
        `dialogue trigger mismatch: config says "${chatCfg.dialogueTrigger}" but ${persona.name} ` +
          `answers to "${persona.trigger}" - using the config value`
      );
    }
    return chatCfg.dialogueTrigger;
  }
  return persona.trigger || null;
}

/** Load the persona using the agent's own llm section + root. */
function personaForConfig(ctx, options = {}) {
  const cfg = (ctx && ctx.cfg) || {};
  return loadPersona({ cfg: cfg.llm || {}, root: cfg.root, log: options.log || null });
}

module.exports = {
  loadPersona,
  clearCache,
  resolveFile,
  parseFrontmatter,
  stripAuthorNotes,
  resolveTrigger,
  personaForConfig,
  FALLBACK
};
