'use strict';

/**
 * AnswerMemory - player answers remembered with their conditions (P1 M3: 回答关联/条件记忆).
 *
 * "Where is the iron?" answered "north cave" is only useful under the conditions the answer
 * was given in. Facts therefore carry a `conditions` object (dimension, biome, area, ...),
 * and `recall()` refuses facts whose conditions contradict the current context. Conditions
 * the caller did not observe are neutral - the fact may still be recalled, but a *mismatch*
 * is never treated as a match.
 *
 * Pure and local: no model, no network. The question/answer text is stored verbatim.
 */

class AnswerMemory {
  constructor(options = {}) {
    this.limit = options.limit || 200;
    this.now = options.now || (() => Date.now());
    this.facts = [];
    this.seq = 0;
  }

  remember(input = {}) {
    if (!input.question || input.answer === undefined || input.answer === null) {
      throw new Error('AnswerMemory.remember needs question and answer');
    }
    const fact = {
      id: input.id || `f${++this.seq}`,
      question: String(input.question),
      answer: String(input.answer),
      conditions: { ...(input.conditions || {}) },
      source: input.source || 'player',
      at: input.at || new Date(this.now()).toISOString()
    };
    this.facts.push(fact);
    while (this.facts.length > this.limit) this.facts.shift();
    return { ...fact, conditions: { ...fact.conditions } };
  }

  /**
   * @param {string} question
   * @param {object} [context]
   * @returns {{fact:object, score:number}|null} best matching fact
   */
  recall(question, context = {}) {
    const query = String(question || '').trim().toLowerCase();
    if (!query) return null;
    let best = null;
    for (const fact of this.facts) {
      if (!this._conditionsCompatible(fact.conditions, context)) continue;
      let score = this._questionScore(fact.question.toLowerCase(), query);
      if (score <= 0) continue;
      for (const [key, value] of Object.entries(fact.conditions || {})) {
        if (context[key] !== undefined && String(context[key]) === String(value)) score += 1;
      }
      if (!best || score > best.score) best = { fact: { ...fact, conditions: { ...fact.conditions } }, score };
    }
    return best;
  }

  status() {
    return { facts: this.facts.length, last: this.facts[this.facts.length - 1] || null };
  }

  toJSON() {
    return { seq: this.seq, facts: this.facts };
  }

  restore(data) {
    if (!data || !Array.isArray(data.facts)) return false;
    this.seq = Number(data.seq) || 0;
    this.facts = data.facts
      .filter((fact) => fact && fact.id && fact.question && fact.answer !== undefined)
      .map((fact) => ({ ...fact, conditions: { ...(fact.conditions || {}) } }));
    return true;
  }

  _conditionsCompatible(conditions, context) {
    for (const [key, value] of Object.entries(conditions || {})) {
      if (context[key] === undefined || context[key] === null) continue;
      if (String(context[key]) !== String(value)) return false;
    }
    return true;
  }

  _questionScore(known, query) {
    if (known === query) return 8;
    if (known.includes(query) || query.includes(known)) return 5;
    /**
     * Generic words ("where is the ...") must not make two different questions match:
     * "where is the iron?" and "what time is it?" share only "is". Compare meaningful
     * tokens instead.
     */
    const stop = new Set([
      'a', 'an', 'the', 'is', 'are', 'was', 'were', 'what', 'where', 'when', 'who', 'why',
      'how', 'do', 'does', 'did', 'i', 'you', 'we', 'me', 'my', 'your', 'it', 'this', 'that',
      'to', 'of', 'in', 'on', 'at', 'and', 'or', 'for', 'can', 'could', 'should', 'would'
    ]);
    const tokens = (text) => text.split(/\s+/).filter((token) => token && !stop.has(token));
    const wanted = new Set(tokens(query));
    if (!wanted.size) return 0;
    const overlap = tokens(known).filter((token) => wanted.has(token)).length;
    return overlap ? overlap * 1.5 : 0;
  }
}

module.exports = { AnswerMemory };
