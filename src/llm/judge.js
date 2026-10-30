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

function buildPrompt(text, persona = '') {
  const personaText = String(persona || '').slice(0, 6000);
  return {
    system: [
      'You are the persona-bottom-line approval gate for a Minecraft agent.',
      "Allow a player instruction unless it violates the persona's non-negotiable red lines; " +
        'if it does, deny it.',
      'Do NOT deny merely because the task is impossible, unclear, unsupported, technically ' +
        'invalid, or because tools may be missing. Those still go to the action brain.',
      'Do not answer the request, do not rewrite it, do not explain.',
      'Reply with exactly one JSON object: {"verdict":"allow"} or {"verdict":"deny"}.',
      personaText ? `Persona and non-negotiable red lines:\n${personaText}` : ''
    ]
      .filter(Boolean)
      .join('\n'),
    user: `Instruction: ${JSON.stringify(String(text))}`
  };
}

/**
 * Pull the verdict out of a model answer.
 *
 * DeepSeek sometimes wraps the one JSON object in prose or a markdown fence, and a small
 * token cap could truncate the object after `"verdict"`. The gate stays binary: only
 * `allow`/`deny` is accepted, extra fields are ignored, and unparseable prose remains
 * `malformed-verdict` (fail closed). The live 2026-10-30 failure was exactly this: a 200-token
 * answer hit the 200-token cap and was rejected even though the verdict was present.
 */
function verdictOf(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data.verdict === 'allow' || data.verdict === 'deny' ? data.verdict : null;
}

function parseVerdict(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const verdict = verdictOf(raw);
    if (verdict) return { verdict };
    throw new Error('malformed-verdict');
  }
  if (typeof raw !== 'string') throw new Error('malformed-verdict');
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('malformed-verdict');
  if (/^(allow|deny)$/i.test(trimmed)) return { verdict: trimmed.toLowerCase() };

  /** 1. the whole answer, or a fenced block, is the JSON object. */
  const candidates = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());

  /** 2. every balanced `{...}` span (top level first) as a JSON candidate. */
  for (let start = trimmed.indexOf('{'); start >= 0; start = trimmed.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const ch = trimmed[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          candidates.push(trimmed.slice(start, i + 1));
          break;
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate);
      const verdict = verdictOf(data);
      if (verdict) return { verdict };
    } catch {
      /* try the next candidate */
    }
  }

  /**
   * 3. Truncated output: the verdict field is present but the object never closed. Only that
   * exact field is recovered; free prose still fails closed.
   */
  const field = /"verdict"\s*:\s*"(allow|deny)"/i.exec(trimmed);
  if (field) return { verdict: field[1].toLowerCase() };

  throw new Error('malformed-verdict');
}

class InstructionJudge {
  constructor(options = {}) {
    this.complete = options.complete || null;
    this.timeoutMs = options.timeoutMs || 2000;
    this.persona = options.persona || '';
  }

  /** @returns {Promise<{verdict:'allow'|'deny'}>} */
  async judge(text) {
    if (!text || !String(text).trim()) throw new Error('empty-instruction');
    if (typeof this.complete !== 'function') throw new Error('no-complete');

    const prompt = buildPrompt(text, this.persona);
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
