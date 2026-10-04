'use strict';

/**
 * Permission rules + the consent desk: who decides whether an action may touch the world.
 *
 * numen's permission layer (docs/permission-layer.md) in the shape this agent can actually
 * enforce today. The lesson from the first live incidents is encoded here: hard-coding
 * "never walk on player-built ground" cost the operator a working farm, and simply turning
 * the guard off costs them the protection. The answer is neither - it is a rule table plus a
 * way to ask.
 *
 *   - **rules**: `deny | allow | ask` for an action (`break`, `place`, `use`) matched against
 *     a block/item name, a `namespace:*` glob, `area:<name>` (needs a Places store) or the
 *     `self:placed` signal (blocks this agent placed itself).
 *   - **consent**: no rule matched `ask`? The action blocks, the agent asks in chat
 *     (`!yes` / `!no` / `!yes always`), and "always" appends an allow rule. A timeout counts
 *     as "no" - the safe answer.
 *
 * Defaults are deliberately permissive (no rules -> allow): the operator's own server should
 * not suddenly start interrogating every dirt block. Protection is opt-in, and `deny` wins
 * over everything.
 */

const fs = require('fs');
const path = require('path');

const EFFECTS = ['deny', 'allow', 'ask'];
const ACTIONS = ['break', 'place', 'use', 'attack', '*'];

function bareName(name) {
  return String(name || '').replace(/^minecraft:/, '');
}

class Permissions {
  /**
   * @param {object} cfg loaded agent config (uses cfg.root)
   * @param {object} [options] { log, file, places }
   */
  constructor(cfg, options = {}) {
    this.log = options.log || { debug() {}, info() {}, warn() {} };
    this.file = options.file || path.resolve(cfg.root, 'runtime/permissions.json');
    this.places = options.places || null;
    this.data = { mode: 'ask', rules: [] };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.data = {
          mode: parsed.mode === 'bypass' || parsed.mode === 'observe' ? parsed.mode : 'ask',
          rules: Array.isArray(parsed.rules) ? parsed.rules.filter((r) => r && EFFECTS.includes(r.effect)) : []
        };
      }
    } catch (err) {
      this.log.warn(`permissions: could not read ${this.file} (${err.message}) - starting empty`);
      this.data = { mode: 'ask', rules: [] };
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      return true;
    } catch (err) {
      this.log.warn(`permissions: could not write ${this.file}: ${err.message}`);
      return false;
    }
  }

  setMode(mode) {
    if (!['ask', 'bypass', 'observe'].includes(mode)) {
      return { ok: false, reason: 'mode must be ask | bypass | observe' };
    }
    this.data.mode = mode;
    this.save();
    return { ok: true, mode };
  }

  list() {
    return this.data.rules.map((rule, index) => ({ index, ...rule }));
  }

  addRule({ effect, action = '*', match = '*' }) {
    if (!EFFECTS.includes(effect)) return { ok: false, reason: `effect must be ${EFFECTS.join(' | ')}` };
    if (!ACTIONS.includes(action)) return { ok: false, reason: `action must be ${ACTIONS.join(' | ')}` };
    const text = String(match || '').trim();
    if (!text) return { ok: false, reason: 'match must not be empty' };
    const rule = { effect, action, match: text };
    this.data.rules.push(rule);
    this.save();
    return { ok: true, index: this.data.rules.length - 1, rule };
  }

  removeRule(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.data.rules.length) {
      return { ok: false, reason: `no rule #${index}` };
    }
    const [rule] = this.data.rules.splice(i, 1);
    this.save();
    return { ok: true, rule };
  }

  /**
   * @param {'break'|'place'|'use'|'attack'} action
   * @param {{name?:string, position?:object, selfPlaced?:boolean}} [target]
   * @returns {{verdict:'allow'|'deny'|'ask', rule:object|null, reason:string}}
   */
  check(action, target = {}) {
    if (this.data.mode === 'bypass') return { verdict: 'allow', rule: null, reason: 'mode=bypass' };
    if (this.data.mode === 'observe') return { verdict: 'deny', rule: null, reason: 'mode=observe' };
    for (const effect of ['deny', 'allow', 'ask']) {
      for (const rule of this.data.rules) {
        if (rule.effect !== effect) continue;
        if (this.matches(rule, action, target)) {
          return { verdict: effect, rule, reason: `${effect} ${rule.action} ${rule.match}` };
        }
      }
    }
    return { verdict: 'allow', rule: null, reason: 'no matching rule' };
  }

  /** Does one rule match this action and target? Pure; exposed for tests. */
  matches(rule, action, target = {}) {
    if (rule.action !== '*' && rule.action !== action) return false;
    const match = String(rule.match || '*');
    if (match === '*' || match === 'any') return true;
    if (match === 'self:placed') return target.selfPlaced === true;
    if (match.startsWith('area:')) {
      const area = match.slice('area:'.length);
      if (!this.places || !target.position) return false;
      return this.places.areaContains(area, target.position);
    }
    const name = String(target.name || '');
    if (!name) return false;
    if (match.endsWith(':*')) {
      const namespace = match.slice(0, -2);
      return name.startsWith(`${namespace}:`);
    }
    return name === match || bareName(name) === bareName(match);
  }

  summary() {
    return { mode: this.data.mode, rules: this.list() };
  }
}

/**
 * ConsentDesk: one pending question per agent, answered from chat or the panel.
 *
 * The caller (the permission gate) awaits the answer, so the action really does wait - the
 * whole point is that nothing irreversible happens before the operator decides. A new
 * question replaces the old one; the old one is refused (the newer decision is about the
 * work that is actually running now). Timeout counts as no.
 */
class ConsentDesk {
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.log = options.log || { info() {}, warn() {} };
    this.speak = options.speak || null;
    this.timeoutMs = options.timeoutMs || 60000;
    this.seq = 0;
    this.pending = null;
    this.history = [];
  }

  /**
   * Ask the operator and block until they answer (or the timeout denies).
   * @returns {Promise<'allow'|'always'|'deny'>}
   */
  ask({ action, target, reason }) {
    return new Promise((resolve) => {
      if (this.pending) {
        this.pending.resolve('deny');
        this.pending = null;
      }
      const id = `c${++this.seq}`;
      const name = (target && target.name) || 'this block';
      const where = target && target.position ? ` @${target.position.x},${target.position.y},${target.position.z}` : '';
      const verb = action === 'break' ? '挖掉' : action === 'place' ? '放置到' : '对';
      const question = `要${verb} ${name}${where} 吗？回 !yes / !no / !yes always`;
      const ticket = { id, action, target: target || {}, question, at: Date.now(), answered: false };
      const timer = setTimeout(() => {
        if (this.pending === ticket) this.pending = null;
        this._finish(ticket, 'deny', 'timeout');
        resolve('deny');
      }, this.timeoutMs);
      ticket.resolve = (answer) => {
        clearTimeout(timer);
        if (this.pending === ticket) this.pending = null;
        this._finish(ticket, answer, 'answered');
        resolve(answer);
      };
      this.pending = ticket;
      this.log.info(`consent ${id}: ${question}${reason ? ` (${reason})` : ''}`);
      if (typeof this.speak === 'function') {
        Promise.resolve(this.speak(question)).catch(() => {});
      }
    });
  }

  /** Answer the pending question. word: yes | no | always. */
  answer(word) {
    if (!this.pending) return { ok: false, reason: 'no pending permission question' };
    const text = String(word || '').trim().toLowerCase();
    let answer = 'deny';
    if (/always|记住|总是/.test(text)) answer = 'always';
    else if (/^(y|yes|好|可以|同意|行)/.test(text)) answer = 'allow';
    const ticket = this.pending;
    ticket.resolve(answer);
    return { ok: true, answer, question: ticket.question };
  }

  /** The pending question and the last few answers, for `/ui/state` and the live test. */
  status() {
    return {
      pending: this.pending
        ? {
            id: this.pending.id,
            action: this.pending.action,
            target: this.pending.target,
            question: this.pending.question,
            ms: Date.now() - this.pending.at
          }
        : null,
      recent: this.history.slice(-5)
    };
  }

  _finish(ticket, answer, how) {
    ticket.answered = how;
    ticket.answer = answer;
    this.history.push({
      id: ticket.id,
      action: ticket.action,
      target: ticket.target,
      answer,
      how,
      at: Date.now()
    });
    if (this.history.length > 20) this.history.shift();
    this.log.info(`consent ${ticket.id} -> ${answer} (${how})`);
  }
}

module.exports = { Permissions, ConsentDesk, EFFECTS, ACTIONS };
