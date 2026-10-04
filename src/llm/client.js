'use strict';

/**
 * The LLM client: provider-agnostic, OpenAI-compatible chat completions over plain
 * `fetch` (P0-PLAN §5.1). No SDK, no dependency, no streaming.
 *
 * Kept deliberately thin. Everything interesting - what to ask, what the answer means,
 * what to do when it is wrong - lives in `blackboard.js`, `intent.js` and `index.js`. A
 * client that also made policy decisions would be impossible to test without a network.
 *
 * The one behaviour worth noting is that this client **never throws for an expected
 * failure**. A timeout, a 429 and a malformed body all come back as `{ok:false, reason}`
 * so the caller's degradation path (fall back to the regex router) is a simple branch
 * rather than a try/catch maze. Only programmer error propagates.
 */

const DEFAULT_SYSTEM_PREFACE = 'You output a single JSON object and nothing else.';

class LlmClient {
  /**
   * @param {object} options { baseUrl, apiKey, model, timeoutMs, log, fetchImpl }
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.apiKey = options.apiKey || '';
    this.model = options.model || 'gpt-4o-mini';
    this.timeoutMs = options.timeoutMs || 8000;
    this.log = options.log || { debug() {}, warn() {}, info() {} };
    /** Injectable for tests: `llm:dry` runs the whole brain with no network at all. */
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.stats = { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, lastError: null };
  }

  get configured() {
    return !!(this.apiKey && this.baseUrl && this.fetchImpl);
  }

  /**
   * One completion.
   *
   * @param {object} request { system, messages, temperature, maxTokens, timeoutMs, json }
   * @returns {Promise<{ok:true, text:string, usage:object} | {ok:false, reason:string, status?:number}>}
   */
  async complete(request = {}) {
    if (!this.fetchImpl) return { ok: false, reason: 'fetch is not available in this runtime' };
    if (!this.apiKey) return { ok: false, reason: 'no api key configured' };

    const messages = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    for (const message of request.messages || []) messages.push(message);

    const body = {
      model: this.model,
      messages,
      temperature: request.temperature === undefined ? 0.2 : request.temperature,
      max_tokens: request.maxTokens || 500
    };
    /**
     * Native tool calling, when the caller offers tools.
     *
     * `response_format: json_object` and `tools` are mutually exclusive on several providers
     * (the model must be free to emit a tool call instead of an object), so asking for both
     * would break one of the two paths. The intent-JSON path stays the default; tools are an
     * opt-in for the round where the model is allowed to look around first.
     */
    if (Array.isArray(request.tools) && request.tools.length) {
      body.tools = request.tools;
      if (request.toolChoice) body.tool_choice = request.toolChoice;
    } else if (request.json !== false) {
      body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs || this.timeoutMs);
    this.stats.calls += 1;

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        // Read the body for the provider's message; it is almost always the real cause
        // (bad model name, quota, key scope) and is invisible in the status code alone.
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {
          /* ignore */
        }
        this.stats.failures += 1;
        this.stats.lastError = `HTTP ${res.status} ${detail}`;
        return { ok: false, reason: `HTTP ${res.status}`, status: res.status, detail };
      }

      const payload = await res.json();
      const usage = payload.usage || {};
      this.stats.promptTokens += usage.prompt_tokens || 0;
      this.stats.completionTokens += usage.completion_tokens || 0;
      this.stats.totalTokens += usage.total_tokens || 0;

      const choice = (payload.choices || [])[0];
      const message = (choice && choice.message) || null;
      const text = message ? message.content : null;
      const toolCalls = (message && message.tool_calls) || [];

      /**
       * A tool call is a valid answer even with no text.
       *
       * Providers return `content: null` plus `tool_calls` when the model decides to look
       * something up first, so treating "no content" as a failure would turn every tool round
       * into a fallback-to-regex round.
       */
      if (toolCalls.length) {
        return {
          ok: true,
          text: typeof text === 'string' ? text : '',
          /**
           * Thinking-mode providers (observed with DeepSeek's `deepseek-flash`) require the
           * assistant message's `reasoning_content` to be replayed together with the tool
           * results; dropping it makes the follow-up request answer `HTTP 400
           * (reasoning_content ... must be passed back)` or return an empty completion.
           * Optional on purpose: providers that never send the field never see it either.
           */
          reasoning:
            typeof message.reasoning_content === 'string' && message.reasoning_content
              ? message.reasoning_content
              : null,
          toolCalls: toolCalls.map((call) => ({
            id: call.id,
            name: call.function ? call.function.name : call.name,
            arguments: call.function ? call.function.arguments : call.arguments
          })),
          finishReason: choice ? choice.finish_reason : null,
          usage,
          model: payload.model || this.model
        };
      }

      if (typeof text !== 'string') {
        this.stats.failures += 1;
        this.stats.lastError = 'response contained no message content';
        return {
          ok: false,
          reason: 'no message content in the response',
          finishReason: choice ? choice.finish_reason : null
        };
      }
      return {
        ok: true,
        text,
        toolCalls: [],
        finishReason: choice ? choice.finish_reason : null,
        usage,
        model: payload.model || this.model
      };
    } catch (err) {
      this.stats.failures += 1;
      const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
      const reason = aborted ? `timeout after ${request.timeoutMs || this.timeoutMs}ms` : err.message;
      this.stats.lastError = reason;
      return { ok: false, reason };
    } finally {
      clearTimeout(timer);
    }
  }

  describe() {
    return {
      baseUrl: this.baseUrl,
      model: this.model,
      configured: this.configured,
      ...this.stats,
      apiKey: this.apiKey ? `${this.apiKey.slice(0, 4)}...` : null
    };
  }
}

module.exports = { LlmClient, DEFAULT_SYSTEM_PREFACE };
