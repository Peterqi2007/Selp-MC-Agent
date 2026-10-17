'use strict';

/**
 * InstructionJudge - the model side of the binary gate (P1 M2, A02).
 *
 * The model is asked one question and allowed one answer shape:
 *
 *     {"verdict":"allow"}   or   {"verdict":"deny"}
 *
 * Everything else is malformed and refuses the instruction. In particular a verdict that
 * also contains `text`/`instruction`/`rewrite` is **not** used to replace the original: only
 * `verdict` is returned, so the dispatch path can only ever use the player's raw text.
 *
 * The `complete` function is injected. It receives `{ system, user }` and returns either a
 * string or an already-parsed object; this module never touches a socket or the body.
 */

function buildPrompt(text) {
  return {
    system:
      'You are a strict gate for a Minecraft agent. Decide whether the player instruction is a ' +
      'valid action request for the agent. Do not answer the request, do not rewrite it, do not ' +
      'explain. Reply with exactly one JSON object: {"verdict":"allow"} or {"verdict":"deny"}.',
    user: `Instruction: ${JSON.stringify(String(text))}`
  };
}

function parseVerdict(raw) {
  let data = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    try {
      data = JSON.parse(trimmed);
    } catch {
      if (/^(allow|deny)$/i.test(trimmed)) return { verdict: trimmed.toLowerCase() };
      throw new Error('malformed-verdict');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('malformed-verdict');
  if (data.verdict !== 'allow' && data.verdict !== 'deny') throw new Error('malformed-verdict');
  return { verdict: data.verdict };
}

class InstructionJudge {
  constructor(options = {}) {
    this.complete = options.complete || null;
    this.timeoutMs = options.timeoutMs || 2000;
  }

  /** @returns {Promise<{verdict:'allow'|'deny'}>} */
  async judge(text) {
    if (!text || !String(text).trim()) throw new Error('empty-instruction');
    if (typeof this.complete !== 'function') throw new Error('no-complete');

    const prompt = buildPrompt(text);
    let timer = null;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('judge-timeout')), this.timeoutMs);
    });
    try {
      const raw = await Promise.race([Promise.resolve().then(() => this.complete(prompt)), timeout]);
      return parseVerdict(raw);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

module.exports = { InstructionJudge, parseVerdict, buildPrompt };
