'use strict';

/**
 * Automatic curriculum (Voyager-style) for the action brain's autonomous proposals.
 *
 * Voyager's curriculum agent is given the player's state, the **completed tasks** and the
 * **failed tasks**, and is asked for the next single task; the next task should not be too
 * hard, should be novel, and should only repeat when a prerequisite needs more resources
 * (`refs/Voyager/voyager/prompts/curriculum.txt`, `voyager/agents/curriculum.py`).
 *
 * Our action brain is the model that proposes, so this module does not call a model. It:
 *
 *   1. keeps the completed/failed ledger across restarts (`runtime/curriculum.json`);
 *   2. derives a **difficulty band** from the number of completed tasks, so proposals get
 *      harder as the agent proves it can finish things;
 *   3. emits the exact context block the prep goal appends (state + history + rules);
 *   4. validates the model's proposal against the band. A below-band proposal is refused
 *      with a machine-readable reason so the model can retry; after `maxRejections` the
 *      module lets it through (a curriculum that deadlocks is worse than a slightly easy
 *      task) and says so.
 *
 * Difficulty is intentionally heuristic: the proposal vocabulary is the command table, not
 * free-form text, so a table is honest and testable. Unknown types get the base score.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.resolve('runtime', 'curriculum.json');

/** Base difficulty by command-table type (1 easy .. 5 hard). */
const TYPE_TIERS = Object.freeze({
  // tier 1: gathering / small movement
  chop: 1,
  'chop-wood': 1,
  collect: 1,
  farm: 1,
  fish: 1,
  explore: 1,
  goto: 1,
  follow: 1,
  eat: 1,
  sleep: 1,
  equip: 1,
  armor: 1,
  drop: 1,
  place: 1,
  use: 1,
  use_on: 1,
  // tier 2: production / logistics
  mine: 1,
  craft: 2,
  smelt: 2,
  withdraw: 2,
  deposit: 2,
  hunt: 2,
  attack: 2,
  defend: 2,
  light: 2,
  // tier 3: combat / rarer resources / structures
  shoot: 3,
  shelter: 3,
  'mine-ore': 2
});

/** Material tiers for args.block/args.item/args.name. */
const MATERIAL_TIERS = Object.freeze({
  dirt: 1,
  grass: 1,
  sand: 1,
  gravel: 1,
  stone: 1,
  cobblestone: 1,
  coal: 1,
  'coal_ore': 1,
  'deepslate_coal_ore': 1,
  iron: 2,
  'iron_ore': 2,
  'deepslate_iron_ore': 2,
  copper: 2,
  'copper_ore': 2,
  'deepslate_copper_ore': 2,
  redstone: 2,
  'redstone_ore': 2,
  'deepslate_redstone_ore': 2,
  lapis: 2,
  'lapis_ore': 2,
  'deepslate_lapis_ore': 2,
  quartz: 2,
  gold: 3,
  'gold_ore': 3,
  'deepslate_gold_ore': 3,
  diamond: 4,
  'diamond_ore': 4,
  'deepslate_diamond_ore': 4,
  emerald: 4,
  'emerald_ore': 4,
  'deepslate_emerald_ore': 4,
  ancient_debris: 5,
  netherite: 5
});

const DEFAULTS = Object.freeze({
  enabled: true,
  file: DEFAULT_FILE,
  /** Completed tasks needed for the next band. */
  bandStep: 2,
  maxLevel: 4,
  /** Below-band proposals refused before the module lets one through. */
  maxRejections: 2,
  /** How many history entries the prompt/state keeps. */
  historyLimit: 12
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class Curriculum {
  /**
   * @param {object} [deps] { cfg, now, log, fsImpl }
   */
  constructor(deps = {}) {
    this.cfg = { ...DEFAULTS, ...(deps.cfg || {}) };
    this.now = deps.now || (() => Date.now());
    this.log = deps.log || { info() {}, warn() {}, debug() {} };
    this.fs = deps.fsImpl || fs;
    this.enabled = this.cfg.enabled !== false;
    this.file =
      deps.file !== undefined
        ? deps.file
          ? String(deps.file)
          : null
        : this.cfg.file
          ? String(this.cfg.file)
          : null;
    this.completed = [];
    this.failed = [];
    this.rejections = 0;
    this.lastValidation = null;
    this._load();
  }

  // ------------------------------------------------------------- persistence

  _load() {
    if (!this.file) return;
    try {
      const raw = this.fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.completed)) this.completed = data.completed.slice(-this.cfg.historyLimit * 4);
      if (Array.isArray(data.failed)) this.failed = data.failed.slice(-this.cfg.historyLimit * 4);
      /**
       * Heal a ledger written before `_cleanUp` existed: a file may already hold duplicate
       * completed entries, or the same task in both lists. Repair on load and deliberately
       * do NOT write back here - loading must stay read-only (a boot with a bad file should
       * not rewrite it before anyone looks).
       */
      this._cleanUp();
    } catch {
      /* no file (first run) or unreadable: start clean, never fail startup */
    }
  }

  _save() {
    if (!this.file) return;
    try {
      const dir = path.dirname(this.file);
      this.fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      this.fs.writeFileSync(
        tmp,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date(this.now()).toISOString(),
            completed: this.completed,
            failed: this.failed
          },
          null,
          2
        )
      );
      this.fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.warn(`curriculum save failed: ${err.message}`);
    }
  }

  // --------------------------------------------------------------- difficulty

  /** Difficulty 1..5 for one proposal (command-table type + args). */
  difficultyOf(candidate = {}) {
    const type = String(candidate.type || candidate.commandType || '').trim().toLowerCase();
    let score = TYPE_TIERS[type] || 1;
    const args = candidate.args && typeof candidate.args === 'object' ? candidate.args : {};
    const material = String(args.block || args.item || '')
      .toLowerCase()
      .replace(/^minecraft:/, '')
      .replace(/^deepslate_/, 'deepslate_');
    if (material) {
      const tier = MATERIAL_TIERS[material] || MATERIAL_TIERS[material.replace(/s$/, '')];
      if (tier) score = Math.max(score, tier);
    }
    const count = Number(args.count);
    if (Number.isFinite(count) && count >= 16) score += 1;
    if (Number.isFinite(count) && count >= 64) score += 1;
    // `mine-ore` carries the material; without one it is stone-tier work.
    if (type === 'mine-ore' && !material) score = Math.max(score, 2);
    return clamp(score, 1, 5);
  }

  /** Band the next proposal should reach: grows every `bandStep` completed tasks. */
  level() {
    const done = this.completed.length;
    return clamp(1 + Math.floor(done / Math.max(1, this.cfg.bandStep)), 1, this.cfg.maxLevel);
  }

  get requiredDifficulty() {
    return this.level();
  }

  // ---------------------------------------------------------------- history

  /**
   * Voyager's `clean_up_tasks` (refs/Voyager/voyager/agents/curriculum.py:340): keep the
   * ledger honest after every update.
   *
   *   - `completed` is de-duplicated, first occurrence wins and order is preserved;
   *   - every `completed` name is dropped from `failed` (all occurrences) - a task that
   *     eventually succeeded is no longer "too hard", and leaving it there makes
   *     `describe()` tell the model two contradictory things in the same block.
   *
   * `failed` is deliberately NOT de-duplicated: Voyager keeps repeated failures ("record
   * repeated failed tasks"), and so do we - a task that failed three times is different
   * evidence from one that failed once.
   *
   * Identity is the trimmed `name`, the same field `describe()` prints. A name is the
   * model's own wording, not an identifier we own, so it is compared exactly rather than
   * case-folded (two differently-cased names really are two different proposals).
   */
  _cleanUp() {
    const seen = new Set();
    const completed = [];
    for (const entry of this.completed) {
      const key = String((entry && entry.name) || '').trim();
      if (!key) {
        completed.push(entry);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      completed.push(entry);
    }
    this.completed = completed;
    if (seen.size) {
      this.failed = this.failed.filter((entry) => !seen.has(String((entry && entry.name) || '').trim()));
    }
  }

  recordCompleted(entry = {}) {
    const name = String(entry.name || entry.type || 'task').trim();
    if (!name) return null;
    const record = {
      name,
      type: String(entry.type || name).trim(),
      difficulty: Number(entry.difficulty) || this.difficultyOf(entry),
      source: entry.source || 'autonomous',
      at: new Date(this.now()).toISOString()
    };
    this.completed.push(record);
    this._cleanUp();
    if (this.completed.length > this.cfg.historyLimit * 4) this.completed.shift();
    this.rejections = 0;
    this._save();
    this.log.info(`curriculum: completed ${record.name} (difficulty ${record.difficulty}, level -> ${this.level()})`);
    return record;
  }

  recordFailed(entry = {}) {
    const name = String(entry.name || entry.type || 'task').trim();
    if (!name) return null;
    const record = {
      name,
      type: String(entry.type || name).trim(),
      difficulty: Number(entry.difficulty) || this.difficultyOf(entry),
      reason: String(entry.reason || '').slice(0, 200),
      source: entry.source || 'autonomous',
      at: new Date(this.now()).toISOString()
    };
    this.failed.push(record);
    /**
     * Same cleanup as a completion: a task already in `completed` cannot re-enter `failed`
     * (Voyager behaves the same way - the push is followed by clean_up_tasks).
     */
    this._cleanUp();
    if (this.failed.length > this.cfg.historyLimit * 4) this.failed.shift();
    this._save();
    this.log.info(`curriculum: failed ${record.name}${record.reason ? ` (${record.reason})` : ''}`);
    return record;
  }

  // -------------------------------------------------------------- validation

  /**
   * Validate a proposal against the band. The caller decides what to do with a refusal;
   * the rejection counter is capped so the round cannot deadlock.
   *
   * @returns {{ok:boolean, reason?:string, required:number, actual:number, level:number, attempts:number}}
   */
  validate(candidate = {}) {
    const actual = typeof candidate.difficulty === 'number' ? candidate.difficulty : this.difficultyOf(candidate);
    const required = this.requiredDifficulty;
    const level = this.level();
    if (!this.enabled) {
      return { ok: true, reason: 'curriculum-disabled', required, actual, level, attempts: 0 };
    }
    if (actual >= required) {
      this.rejections = 0;
      this.lastValidation = { ok: true, required, actual, level, attempts: 0 };
      return { ok: true, required, actual, level, attempts: 0 };
    }
    this.rejections += 1;
    const overBudget = this.rejections > this.cfg.maxRejections;
    const result = {
      ok: overBudget,
      reason: overBudget ? 'curriculum-relaxed' : 'difficulty-below-curriculum',
      required,
      actual,
      level,
      attempts: this.rejections
    };
    this.lastValidation = result;
    this.log.info(
      `curriculum: ${candidate.type || 'proposal'} difficulty ${actual} < band ${required}`
        + (overBudget ? ' -> relaxed after the retry budget' : ' -> refused, model may retry')
    );
    return result;
  }

  /** Reset the below-band counter (new proposal round). */
  resetRejections() {
    this.rejections = 0;
  }

  // ----------------------------------------------------------------- context

  /** The text block the proposal-prep goal appends (Voyager curriculum prompt shape). */
  describe() {
    const completed = this.completed.slice(-this.cfg.historyLimit);
    const failed = this.failed.slice(-Math.max(2, Math.floor(this.cfg.historyLimit / 2)));
    const level = this.level();
    const last = completed[completed.length - 1];
    const completedText = completed.length
      ? completed.map((entry) => `${entry.name} (d${entry.difficulty})`).join(', ')
      : 'None';
    const failedText = failed.length
      ? failed.map((entry) => `${entry.name}${entry.reason ? ` — ${entry.reason}` : ''}`).join(', ')
      : 'None';
    const focus = this.focusSuggestions();
    return [
      'AUTOMATIC CURRICULUM (Voyager-style; this is context, not a new task):',
      `- Completed tasks so far (${completed.length}): ${completedText}`,
      `- Failed tasks that were too hard: ${failedText}`,
      `- Current difficulty band: level ${level}/${this.cfg.maxLevel}. The next proposal must have ` +
        `difficulty >= ${level} (1 gatherable … 5 rare/dangerous).`,
      last ? `- Last completed: ${last.name} (difficulty ${last.difficulty}); prefer one step harder when the world allows it.` : null,
      `- Focus candidates for this band: ${focus.join(', ')}.`,
      'Rules (from Voyager curriculum):',
      '1) One concrete command-table action; no multi-step essay, no raw input and no code skill.',
      '2) Not too hard: do not propose something whose prerequisites are missing right now.',
      '3) Novel and useful: do not repeat the last completed task unless a prerequisite needs more of it.',
      '4) Do not build or dig shelter just because it is night; keep exploring/upgrading.',
      '5) If nothing is worth doing, complete the goal instead of inventing work.'
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** A few candidate verbs for the current band (guidance, not a whitelist). */
  focusSuggestions() {
    const level = this.level();
    const table = {
      1: ['chop', 'mine stone/coal', 'farm', 'fish', 'explore', 'collect'],
      2: ['craft', 'smelt', 'mine iron/copper', 'withdraw/deposit', 'hunt animals'],
      3: ['mine gold/redstone/lapis', 'attack/defend', 'shoot', 'craft better tools', 'light'],
      4: ['mine diamond/emerald', 'long multi-resource tasks', 'build a small base'],
      5: ['ancient debris', 'nether/rare-material goals (only when reachable)']
    };
    return table[clamp(level, 1, 5)] || table[1];
  }

  /** Panel/HTTP snapshot. */
  status() {
    return {
      enabled: this.enabled,
      level: this.level(),
      requiredDifficulty: this.requiredDifficulty,
      completed: this.completed.length,
      failed: this.failed.length,
      lastCompleted: this.completed.length ? this.completed[this.completed.length - 1] : null,
      lastFailed: this.failed.length ? this.failed[this.failed.length - 1] : null,
      rejections: this.rejections,
      lastValidation: this.lastValidation
    };
  }
}

module.exports = { Curriculum, DEFAULTS, TYPE_TIERS, MATERIAL_TIERS };
