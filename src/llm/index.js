'use strict';

/**
 * LlmCore: the decision core of P0 (P0-PLAN §5).
 *
 * Flow, in one paragraph: a player says something. `ChatListener` (the `!` channel) or the
 * dialogue trigger hands the text here. The text is turned into a validated
 * intent either by the model or, if the model is missing/slow/wrong, by the deterministic
 * fallback router. The intent is then executed against the *same* command table the `!`
 * channel uses, so there is exactly one implementation of every action.
 *
 * Four guards do the real work, and each exists because of a specific failure:
 *
 *   1. **The enum is the capability boundary.** The model can only name `chop`, `mine`,
 *      `collect`, `go_to` or `stop`. A chat message saying "run /op me" has nowhere to go.
 *   2. **Two turns per player request, hard cap.** Turn 1 decides; turn 2 (woken by the
 *      task-finished event) reports. A third turn is refused, and a wake-up with no
 *      originating request cannot act at all - that is what makes "no unprompted
 *      behaviour" structural rather than a matter of prompt wording.
 *   3. **A daily token budget and one concurrent turn.** A runaway loop costs money and
 *      holds the chat channel; both are cheap to prevent and expensive to discover.
 *   4. **Every turn is traced.** `runtime/llm-trace.jsonl` records the prompt digest, the
 *      routing decision, the tokens and whether a guard intervened (§8).
 */

const { LlmClient } = require('./client');
const { systemPrompt, buildMessages, capabilities, personaFor } = require('./blackboard');
const { parseIntent, describeIntent } = require('./intent');
const fallbackRouter = require('./fallbackRouter');
const toolRegistry = require('./tools/registry');
const { tracer } = require('../util/trace');
const { Logger } = require('../util/logger');

class LlmCore {
  /**
   * @param {object} ctx agent context
   * @param {object} cfg the `llm` config section (see config/llm.json)
   * @param {object} [options] { log, client }
   */
  constructor(ctx, cfg = {}, options = {}) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.log = options.log || new Logger('llm');
    this.enabled = false;
    this.disabledReason = null;
    this.trace = tracer((cfg.trace && cfg.trace.file) || 'runtime/llm-trace.jsonl', { component: 'llm' });

    this.client =
      options.client ||
      new LlmClient({
        baseUrl: cfg.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
        apiKey: cfg.apiKey || process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
        model: cfg.model || 'deepseek-chat',
        timeoutMs: (cfg.timeouts && cfg.timeouts.intentMs) || 8000,
        log: this.log
      });

    /** Player requests currently in flight, keyed by a short id. */
    this.requests = new Map();
    /** Recent turns for the panel (`GET /llm`). */
    this.turns = [];
    this.tokensToday = 0;
    this.tokenDay = dayKey();
    this.turnsInFlight = 0;
    this.budgetAnnounced = false;
    this.requestSeq = 0;
    /**
     * Whether the model may call tools.
     *
     * Off by default: the plain intent-JSON exchange is the verified path, and native tool
     * calling is a provider feature that varies in quality. Turning it on lets the model look
     * around (`observe`, `find_blocks`, `lookup_item`) before deciding, which is what the
     * plan's §5.3 tool list is for; the four-value intent enum still constrains the outcome
     * either way.
     */
    this.toolsEnabled = cfg.tools !== false && cfg.toolCalling === true;

    if (cfg.enabled === false) {
      this.disabledReason = 'disabled in config';
    } else if (!this.client.configured) {
      this.disabledReason = this.client.apiKey ? 'no fetch available' : 'no api key';
    } else {
      this.enabled = true;
    }

    if (!this.enabled) {
      this.log.warn(`LLM layer is OFF (${this.disabledReason}) - the fallback router will handle every message`);
    } else {
      this.log.info(`LLM layer online: ${this.client.model} @ ${this.client.baseUrl}`);
    }
  }

  /** Capability list is shared with the prompt, so the panel can show the same truth. */
  capabilities() {
    return capabilities(this.ctx);
  }

  get budgetExceeded() {
    const budget = (this.cfg.limits && this.cfg.limits.dailyTokenBudget) || 0;
    this.resetBudgetIfNewDay();
    return budget > 0 && this.tokensToday >= budget;
  }

  resetBudgetIfNewDay() {
    const today = dayKey();
    if (today !== this.tokenDay) {
      this.tokenDay = today;
      this.tokensToday = 0;
      this.budgetAnnounced = false;
    }
  }

  /**
   * Subscribe to task events so a long job can be reported when it finishes (§5.6).
   *
   * Two different reactions, and the distinction is the core of the role-play design:
   *
   *  - A task the LLM itself dispatched wakes turn 2 of *that player request* (report back).
   *  - Any other player-facing task (from `!chop 8`, or the panel) is announced proactively:
   *    the player asked for the work, so hearing "done" is expected rather than noise.
   *    The planner's own work (`source: 'autonomous'`) is ignored - nobody asked for it.
   */
  attachTo(brain) {
    this.brain = brain;
    if (!brain || typeof brain.on !== 'function') return;
    brain.on('task:done', (info) => {
      if (!this.onTaskFinished(info, true)) this.announceFinished(info, true);
    });
    brain.on('task:failed', (info) => {
      if (!this.onTaskFinished(info, false)) this.announceFinished(info, false);
    });
  }

  /**
   * @returns {boolean} true when the event was consumed as a follow-up to an LLM request
   */
  onTaskFinished(info, ok) {
    if (!info || info.source !== 'llm') return false;
    const request = [...this.requests.values()].find((r) => r.turns >= 1 && !r.closed);
    if (!request) {
      this.trace({ kind: 'wake-refused', reason: 'no originating player request', task: info.name });
      return false;
    }
    if (request.turns >= (this.cfg.limits && this.cfg.limits.maxTurnsPerRequest ? this.cfg.limits.maxTurnsPerRequest : 2)) {
      this.trace({ kind: 'wake-refused', reason: 'turn budget for this request is spent', task: info.name });
      this.closeRequest(request.id, 'turn-budget');
      return false;
    }
    request.turns += 1;
    this.followUp(request, info, ok).catch((err) => this.log.debug(`follow-up failed: ${err.message}`));
    return true;
  }

  /**
   * "Finished the job" line for work that came from a player channel but not from an LLM turn.
   *
   * Replaces the plain template the index used to send (`chop 搞定: ...`), which read like a
   * log line rather than a character speaking and contradicted the persona file's whole point.
   * Now the model writes the sentence in character, and the template survives only as the
   * fallback for when the model is unavailable.
   */
  announceFinished(info, ok) {
    if (!info || info.source === 'autonomous') return null;
    const proactive = (this.ctx.cfg.agent && this.ctx.cfg.agent.proactive) || {};
    const trigger = (proactive.triggers && proactive.triggers.taskDone) || {};
    if (proactive.enabled === false || trigger.enabled === false) return null;
    // A failure announcement is opt-out, because a silent failure looks like a stuck bot.
    if (!ok && trigger.alsoOnFailure === false) return null;

    const detail = `${info.description || info.name}${info.reason ?` - ${String(info.reason).slice(0, 60)}` : ''}`;
    // Returns the promise so the caller (and the tests) can await the utterance. It is
    // deliberately not awaited inside `attachTo` - a chat line must never block the brain's
    // event handler, which the task queue owns.
    return this.speakUp('taskDone', { detail, taskOk: ok, taskName: info.name }).catch((err) => {
      this.log.debug(`task announcement failed: ${err.message}`);
      return null;
    });
  }

  /**
   * Handle one player message.
   *
   * @param {string} text the message with any trigger prefix already stripped
   * @param {object} [options] { source, speaker, speakerPosition }
   * @returns {Promise<object>} the routing record, also used by the panel and the trace
   */
  async handle(text, options = {}) {
    const source = options.source || 'chat';
    const started = Date.now();
    const id = `req-${++this.requestSeq}`;
    const request = { id, text, source, at: new Date().toISOString(), turns: 0, closed: false, results: [] };
    this.requests.set(id, request);
    if (this.requests.size > 20) this.requests.delete(this.requests.keys().next().value);

    const record = { kind: 'input', id, source, text, at: request.at };

    // ---- decide -----------------------------------------------------------
    let decision = null;
    let via = 'fallback';
    let fallbackReason = null;

    if (this.enabled && !this.budgetExceeded) {
      const result = await this.askModel({ text, speaker: options.speaker, history: this.historyFor(options.speaker) });
      if (result.ok) {
        decision = result.intent;
        via = 'llm';
        request.turns += 1;
        record.tokens = result.tokens;
        record.ms = result.ms;
        if (result.toolCalls && result.toolCalls.length) record.toolCalls = result.toolCalls;
      } else {
        fallbackReason = result.reason;
        this.log.warn(`LLM turn failed (${result.reason}) - using the fallback router`);
      }
    } else if (this.budgetExceeded && !this.budgetAnnounced) {
      this.budgetAnnounced = true;
      this.log.warn('daily token budget reached - the fallback router takes over for the rest of the day');
    }

    if (!decision) {
      const routed = fallbackRouter.route(text, { speakerPosition: options.speakerPosition });
      if (routed.ok) {
        decision = routed.intent;
        via = 'fallback';
      } else {
        record.kind = 'understood-nothing';
        record.reason = routed.reason;
        record.fallbackReason = fallbackReason;
        record.ms = Date.now() - started;
        this.remember(record);
        this.trace(record);
        // The honest answer beats a guess: an invented task would run for minutes in the
        // wrong direction before anyone noticed.
        await this.say('这句我没听懂，试试「砍点树」或「!chop 8」？');
        this.closeRequest(id, 'not-understood');
        return record;
      }
    }

    record.via = via;
    record.fallbackReason = fallbackReason;
    record.intent = decision;
    record.action = describeIntent(decision);

    // ---- speak ------------------------------------------------------------
    if (decision.say) await this.say(decision.say, { why: `reply (${via})` });

    // ---- act --------------------------------------------------------------
    if (decision.action) {
      try {
        record.executed = await this.execute(decision.action, { id, source, speaker: options.speaker });
      } catch (err) {
        record.executed = { ok: false, reason: err.message };
        this.log.warn(`intent execution failed: ${err.message}`);
      }
    }

    record.ms = Date.now() - started;
    this.remember(record);
    this.trace(record);

    /**
     * A request that dispatched no work has nothing to wake up for. A task keeps it open
     * (the existing design), and now so does an asynchronous skill accepted into the task
     * slot: its `task_finished` event is what opens turn 2 and lets the model report back.
     */
    const pending = !!(
      record.executed &&
      record.executed.accepted &&
      (decision.action.type === 'task' || record.executed.async === true)
    );
    if (!decision.action || !pending) {
      this.closeRequest(id, 'no-follow-up-needed');
    }
    return record;
  }

  /**
   * One model turn.
   *
   * Never throws: every failure comes back as `{ok:false, reason}` so the caller falls
   * back to the router instead of leaving the player with silence.
   */
  async askModel({ text, speaker, history, followUp }) {
    if (this.turnsInFlight >= ((this.cfg.limits && this.cfg.limits.concurrentTurns) || 1)) {
      return { ok: false, reason: 'another turn is already running' };
    }
    this.turnsInFlight += 1;
    const started = Date.now();
    try {
      const timeoutMs = followUp
        ? (this.cfg.timeouts && this.cfg.timeouts.followUpMs) || 8000
        : (this.cfg.timeouts && this.cfg.timeouts.intentMs) || 8000;
      const baseMessages = buildMessages({ text, speaker, history, followUp });
      const system = systemPrompt(this.ctx, this.cfg);

      /**
       * One model call, with a retry that only thinking-mode providers need.
       *
       * `deepseek-flash` reasons inside the completion budget. Observed live: after a
       * two-tool round the follow-up spent the whole 400-token budget on reasoning and
       * returned `content: ""` with `finish_reason: "length"` - which the parser then
       * reported as "empty response". One retry with a doubled budget is cheaper than
       * failing a round that almost worked; the budget itself is now 1200 so the common
       * case never needs the retry. Tokens from both attempts are returned for accounting.
       */
      const callModel = async (messages, tools) => {
        const attempt = (maxTokens) =>
          this.client.complete({
            system,
            messages,
            timeoutMs,
            maxTokens,
            /**
             * Tools are offered only when the provider can act on them.
             *
             * A provider that ignores `tools` still answers with plain JSON, so offering them
             * is safe; what is *not* safe is assuming a tool call happened when it did not,
             * which is why the loop below re-asks for the intent either way.
             */
            tools
          });
        let res = await attempt(1200);
        let tokens = (res.ok && res.usage && res.usage.total_tokens) || 0;
        if (res.ok && !(res.toolCalls || []).length && !String(res.text || '').trim() && res.finishReason === 'length') {
          this.trace({ kind: 'model-retry', reason: 'empty answer with finish_reason=length', from: 1200, to: 2400 });
          const retry = await attempt(2400);
          tokens += (retry.ok && retry.usage && retry.usage.total_tokens) || 0;
          res = retry;
        }
        return { res, tokens };
      };

      const first = await callModel(
        baseMessages,
        this.toolsEnabled ? toolRegistry.toOpenAiTools(this.ctx) : undefined
      );
      const res = first.res;
      const ms = Date.now() - started;

      if (!res.ok) {
        this.trace({ kind: 'model-error', reason: res.reason, status: res.status || null, ms, promptChars: text ? text.length : 0 });
        return { ok: false, reason: res.reason, ms };
      }

      this.tokensToday += first.tokens;
      const tokens = first.tokens;

      /**
       * Bounded tool round (P0-PLAN §5.3).
       *
       * The model may look around before deciding - `observe` then `do_task`, say - which is
       * what keeps its answer grounded in the real world instead of the one it imagined. The
       * loop is capped by `limits.maxToolCallsPerTurn` (default 4) and by a single follow-up
       * request, so a model that keeps calling tools cannot spin: it gets one chance to use
       * what it learned, and then the intent is whatever it produces.
       */
      if (res.toolCalls && res.toolCalls.length) {
        const used = await this.runToolCalls(res.toolCalls, {
          id: null,
          source: 'llm',
          speaker,
          /**
           * Carry the thinking-mode reasoning back with the tool results. DeepSeek's
           * `deepseek-flash` rejects the follow-up (or answers empty) when the assistant's
           * `reasoning_content` is missing; other providers never set the field.
           */
          reasoning: res.reasoning || null
        });
        const secondAttempt = await callModel([...baseMessages, ...used.messages], undefined);
        const second = secondAttempt.res;
        this.tokensToday += secondAttempt.tokens;
        if (!second.ok) {
          this.trace({ kind: 'model-error', reason: second.reason, afterTools: true, ms: Date.now() - started });
          return {
            ok: false,
            reason: `${second.reason} (after ${used.calls.length} tool call(s))`,
            ms: Date.now() - started,
            toolCalls: used.calls
          };
        }
        const parsedAfter = parseIntent(second.text);
        if (!parsedAfter.ok) {
          this.trace({ kind: 'model-invalid', reason: parsedAfter.reason, afterTools: true, raw: String(second.text).slice(0, 300) });
          return {
            ok: false,
            reason: `invalid intent: ${parsedAfter.reason}`,
            ms: Date.now() - started,
            toolCalls: used.calls
          };
        }
        this.trace({ kind: 'tool-round', calls: used.calls, ms: Date.now() - started });
        return {
          ok: true,
          intent: parsedAfter.intent,
          ms: Date.now() - started,
          tokens: tokens + secondAttempt.tokens,
          toolCalls: used.calls
        };
      }

      const parsed = parseIntent(res.text);
      if (!parsed.ok) {
        this.trace({ kind: 'model-invalid', reason: parsed.reason, raw: String(res.text).slice(0, 300), ms });
        return { ok: false, reason: `invalid intent: ${parsed.reason}`, ms, tokens };
      }
      return { ok: true, intent: parsed.intent, ms, tokens };
    } finally {
      this.turnsInFlight -= 1;
    }
  }

  /**
   * Execute the model's tool calls through the registry.
   *
   * The registry is the only way in, so the whitelist and the argument validation cannot be
   * skipped here. Results are converted to `tool` messages in the provider's format, and the
   * call log is returned for the trace and the panel.
   *
   * @param {Array<{id:string,name:string,arguments:any}>} calls
   * @param {object} context { id, source, speaker, reasoning }
   */
  async runToolCalls(calls, context = {}) {
    const limit = (this.cfg.limits && this.cfg.limits.maxToolCallsPerTurn) || 4;
    const selected = calls.slice(0, limit);
    const messages = [];
    const log = [];

    /**
     * One assistant message carrying every tool call, then one tool result per call - the
     * OpenAI/DeepSeek protocol shape. (`reasoning_content` must ride on this same message
     * for thinking-mode providers; see LlmClient.complete.)
     */
    const assistantMessage = {
      role: 'assistant',
      content: null,
      tool_calls: selected.map((call) => ({
        id: call.id || call.name,
        type: 'function',
        function: {
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {})
        }
      }))
    };
    if (context.reasoning) assistantMessage.reasoning_content = context.reasoning;
    messages.push(assistantMessage);

    for (const call of selected) {
      const result = await toolRegistry.call(this.ctx, call.name, call.arguments, {
        source: 'llm',
        speaker: context.speaker
      });
      log.push({
        name: call.name,
        /**
         * The arguments the model passed. Without this the panel/log shows that a tool ran
         * but not how (e.g. which radius scan_around used), and a wrong answer cannot be told
         * apart from a wrong map.
         */
        args:
          typeof call.arguments === 'string'
            ? call.arguments.slice(0, 200)
            : JSON.stringify(call.arguments || {}).slice(0, 200),
        ok: result.ok,
        error: result.error || null,
        failure: result.failure || null,
        hint: result.hint || null,
        kind: result.kind || null
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id || call.name,
        content: JSON.stringify(
          result.ok
            ? result.result
            : { error: result.error, failure: result.failure || null, hint: result.hint || null }
        ).slice(0, 4000)
      });
    }

    if (calls.length > limit) {
      log.push({ name: '(truncated)', ok: false, error: `${calls.length} calls, only ${limit} allowed per turn` });
      // A plain note, not an orphan tool message: the provider requires every tool_call to
      // have a matching result, and the dropped calls were never declared to the model.
      messages.push({
        role: 'user',
        content: JSON.stringify({
          error: `only ${limit} tool calls per turn are allowed`,
          failure: 'bad_argument',
          hint: 'ask again with fewer tool calls'
        })
      });
    }
    return { calls: log, messages };
  }

  /** Turn 2: report a finished task. Cannot start new work (see guard 2). */
  async followUp(request, info, ok) {
    const result = await this.askModel({
      text: request.text,
      speaker: 'player',
      followUp: { name: info.name, reason: info.reason, ok }
    });
    const record = {
      kind: 'follow-up',
      id: request.id,
      task: info.name,
      taskOk: ok,
      via: result.ok ? 'llm' : 'fallback',
      at: new Date().toISOString()
    };
    if (result.ok) {
      record.action = describeIntent(result.intent);
      // Guard 2 in code: a follow-up may only SPEAK. Any action it proposes is dropped
      // and traced, because the player did not ask for more work.
      if (result.intent.action) {
        record.actionDropped = describeIntent(result.intent);
        this.trace({ kind: 'follow-up-action-refused', reason: 'follow-ups may only speak', action: record.actionDropped });
      }
      if (result.intent.say) await this.say(result.intent.say, { why: 'task follow-up' });
    } else {
      // Fallback for the report: a plain, factual sentence beats silence.
      await this.say(await this.fallbackLine({ kind: 'taskDone', detail: info.name, taskOk: ok }), { why: 'task follow-up (template)' });
    }
    this.remember(record);
    this.trace(record);
    this.closeRequest(request.id, 'reported');
  }

  /**
   * Speak without being spoken to - the role-play path.
   *
   * This is the one place the model produces speech with **no player turn behind it**, so it
   * is also the most dangerous: a model given freedom here can invent a request, promise work,
   * or narrate a world it has not observed. Three things keep it contained:
   *
   *  1. **Speech only, enforced in code.** Whatever the model returns, only `intent.say` is
   *     used; any `action` is dropped and traced. "The bot decided to go mining on its own" is
   *     therefore not a prompt-wording risk, it is impossible.
   *  2. **The prompt says so too** (`proactiveNote`), because a model that is told the rules
   *     wastes fewer turns trying to break them.
   *  3. **A deterministic fallback sentence**, so a missing key, a timeout or a malformed
   *     answer still produces a line. A hungry bot that says nothing is worse than one that
   *     says something plain - the whole point of the trigger is to be noticed.
   *
   * @param {'taskDone'|'hungry'|'lowHealth'|'respawn'} kind
   * @param {object} [data] { detail, taskOk, taskName }
   * @returns {Promise<{ok:boolean, via:string, said:string|null, reason?:string}>}
   */
  async speakUp(kind, data = {}) {
    const event = { kind, detail: data.detail || '', taskOk: data.taskOk, taskName: data.taskName || null };
    const record = { kind: 'proactive', trigger: kind, at: new Date().toISOString(), detail: event.detail || null };

    if (!this.enabled || this.budgetExceeded) {
      const line = await this.fallbackLine(event);
      record.via = 'template';
      record.reason = this.enabled ? 'token budget' : this.disabledReason;
      record.said = line;
      record.spoken = await this.say(line, { why: `proactive:${kind}`, force: true });
      this.remember(record);
      this.trace(record);
      return { ok: true, via: 'template', said: line, spoken: record.spoken };
    }

    let said = null;
    let via = 'template';
    let reason = null;

    if (this.turnsInFlight < ((this.cfg.limits && this.cfg.limits.concurrentTurns) || 1)) {
      this.turnsInFlight += 1;
      const started = Date.now();
      try {
        const system = systemPrompt(this.ctx, this.cfg);
        // No, or stale, player history: an unprompted line should be about *now*, and feeding
        // old player messages would invite the model to answer a conversation that has ended.
        const res = await this.client.complete({
          system,
          messages: buildMessages({ proactive: event }),
          timeoutMs: (this.cfg.timeouts && this.cfg.timeouts.proactiveMs) || 6000,
          maxTokens: 120
        });
        this.tokensToday += (res.ok && res.usage && res.usage.total_tokens) || 0;
        record.tokens = (res.ok && res.usage && res.usage.total_tokens) || 0;
        record.ms = Date.now() - started;

        if (res.ok) {
          const parsed = parseIntent(res.text);
          if (parsed.ok && parsed.intent.say) {
            said = parsed.intent.say;
            via = 'llm';
            if (parsed.intent.action) {
              record.actionDropped = describeIntent(parsed.intent);
              this.trace({ kind: 'proactive-action-refused', reason: 'unprompted turns may only speak', action: record.actionDropped });
            }
          } else {
            reason = parsed.ok ? 'model said nothing' : `invalid intent: ${parsed.reason}`;
            this.trace({ kind: 'model-invalid', proactive: kind, reason, raw: String(res.text).slice(0, 200) });
          }
        } else {
          reason = res.reason;
          this.trace({ kind: 'model-error', proactive: kind, reason, ms: record.ms });
        }
      } catch (err) {
        reason = err.message;
      } finally {
        this.turnsInFlight -= 1;
      }
    } else {
      reason = 'another turn is already running';
    }

    if (!said) {
      said = await this.fallbackLine(event);
      via = 'template';
    }
    record.via = via;
    record.reason = reason;
    record.said = said;
    const spoke = await this.say(said, { why: `proactive:${kind}`, force: true });
    record.spoken = spoke;
    this.remember(record);
    this.trace(record);
    this.log.info(`proactive[${kind}] (${via}): ${said}`);
    return { ok: true, via, said, reason };
  }

  /**
   * The sentence used when the model cannot speak (no key, timeout, bad JSON, budget spent).
   *
   * Deliberately *not* a generic "something happened" line: the trigger exists to be noticed,
   * so the fallback has to carry the one fact that matters. It reads off the live state rather
   * than the persona, because it must work with no model and no persona file at all.
   */
  async fallbackLine(event) {
    const persona = personaFor(this.ctx, this.cfg);
    const name = persona.name || '我';
    const snap = this.ctx.body && this.ctx.body.snapshot ? this.ctx.body.snapshot() : null;
    const at = snap && snap.position ? `${Math.round(snap.position.x)},${Math.round(snap.position.y)},${Math.round(snap.position.z)}` : '未知位置';
    const limit = (this.ctx.cfg.agent && this.ctx.cfg.agent.chat && this.ctx.cfg.agent.chat.maxChars) || 100;
    const cut = (s) => (s.length > limit ? `${s.slice(0, Math.max(1, limit - 1))}…` : s);

    switch (event.kind) {
      case 'hungry':
        return cut(`${name}肚子饿了，身上一点吃的都没有，谁能给我点食物？`);
      case 'lowHealth':
        return cut(`${name}快撑不住了，血量只剩 ${snap && snap.health !== undefined ? snap.health : '?'}，我在 ${at}，救命！`);
      case 'respawn':
        return cut(`${name}刚刚死掉了，现在在 ${at} 复活了。`);
      case 'taskDone':
      default:
        return cut(
          event.taskOk === false
            ? `${name}没做成：${event.detail || '任务失败'}`
            : `${name}搞定了：${event.detail || '任务完成'}`
        );
    }
  }

  /**
   * Run a validated action through the same handlers the `!` channel uses.
   *
   * Sharing the table is the point: `chop` has one implementation, so a bug fixed for
   * chat is fixed for the LLM, and there is no second path that skips the guards.
   */
  async execute(action, context = {}) {
    const chat = this.ctx.chat;
    if (!chat) return { ok: false, reason: 'no command table available' };

    const level = this.cfg.actionLevel || 'directive';
    /**
     * Skill intents run through the skill registry directly.
     *
     * That registry is exactly what the `!` commands call, so this is still one
     * implementation per capability - it just takes structured parameters instead of a
     * command line, which is what lets `do_skill` and the intent enum share one schema.
     */
    if (action.type === 'skill') {
      this.trace({
        kind: 'dispatch',
        id: context.id || null,
        line: `skill ${action.skill}`,
        level,
        via: 'llm',
        channel: context.source || 'llm'
      });
      /**
       * One implementation for both tool and intent paths: `actuators.doSkill` owns the
       * validation gate, the background-task slot and the failure receipt.
       */
      const actuators = require('./tools/actuators');
      const result = await actuators.doSkill(
        this.ctx,
        { name: action.skill, params: action.args || {} },
        { source: context.source || 'llm', speaker: context.speaker }
      );
      return {
        ok: result.ok !== false,
        line: `skill ${action.skill}`,
        accepted: result.ok !== false,
        async: result.async === true,
        taskId: result.taskId || null,
        detail: result,
        reason: result.reason || result.error || null
      };
    }

    let line;
    if (action.type === 'stop') line = 'stop';
    else if (action.type === 'go_to') line = `goto ${action.x} ${action.y} ${action.z}`;
    else if (action.task === 'chop') line = `chop ${action.args.count || 8}`;
    else if (action.task === 'collect') line = `collect ${action.args.count || 1}`;
    else if (action.task === 'mine') {
      const names = (Array.isArray(action.args.block) ? action.args.block : [action.args.block])
        .map((n) => String(n || '').replace(/^minecraft:/, '').trim())
        .filter(Boolean);
      /**
       * One dispatcher decides the executor (plan §5.6.2).
       *
       * The old code re-implemented the ore/material split right here with `_ore$`; that
       * duplicate drifted from the command path (mixed lists silently kept only ores) and
       * is deleted. Ores submit `mine_ore` through the TaskHub; materials build the same
       * command line the `!` channel uses.
       */
      const { dispatchMining } = require('../core/miningDispatch');
      const dispatched = await dispatchMining(
        this.ctx,
        { blocks: names, count: action.args.count },
        { source: context.source || 'llm', speaker: context.speaker, defaultCount: 8 }
      );
      if (!dispatched.ok) {
        return { ok: false, reason: dispatched.reason || dispatched.error || 'mining request refused' };
      }
      if (dispatched.kind === 'ore') {
        this.trace({
          kind: 'dispatch',
          id: context.id || null,
          line: 'skill mine_ore (dispatched from task mine)',
          level,
          via: 'llm',
          channel: context.source || 'llm'
        });
        return {
          ok: dispatched.ok !== false,
          line: 'skill mine_ore',
          accepted: dispatched.accepted !== false,
          async: dispatched.async === true,
          taskId: dispatched.taskId || null,
          detail: dispatched,
          reason: dispatched.reason || dispatched.error || null
        };
      }
      line = `mine ${dispatched.blocks.join(',')} ${dispatched.count}`;
    } else {
      return { ok: false, reason: `no handler for task "${action.task}"` };
    }

    /**
     * `source: 'llm'` is load-bearing, not a label.
     *
     * The command table tags every task it creates with where the instruction came from,
     * and the follow-up path (plan 5.6) only wakes the LLM for tasks *it* dispatched.
     * Passing the source through here is what makes "chop some wood and tell me when you're
     * done" possible at all - without it the task looks like it came from chat and the
     * model is never asked to report back.
     */
    // `channel` is where the words arrived from (chat/panel); `via` is who decided. Keeping
    // them separate matters when reading the trace: "llm decided, chat was the channel" and
    // "the fallback router decided" look identical if both are recorded as one field.
    this.trace({ kind: 'dispatch', id: context.id || null, line, level, via: 'llm', channel: context.source || 'llm' });
    const result = await chat.handle(line, context.speaker || 'llm', { source: 'llm' });
    return { ok: true, line, accepted: result && result.result ? result.result.accepted !== false : true, detail: result };
  }

  /** Speak, via the single output path. */
  async say(text, options = {}) {
    if (!this.ctx.reply) return false;
    return this.ctx.reply(text, options);
  }

  /** Short chat memory per speaker, for prompt context. */
  historyFor(speaker) {
    const limit = (this.cfg.history && this.cfg.history.perPlayer) || 6;
    const entries = (this.ctx.chatListener && this.ctx.chatListener.recent) || [];
    return entries
      .slice(-limit)
      .map((entry) => entry.line)
      .filter((line) => line && !line.startsWith('@'));
  }

  remember(record) {
    this.turns.push(record);
    if (this.turns.length > 30) this.turns.shift();
  }

  closeRequest(id, reason) {
    const request = this.requests.get(id);
    if (!request) return;
    request.closed = true;
    request.closedReason = reason;
    // Keep it briefly so a very fast task event can still find it, then forget it.
    setTimeout(() => this.requests.delete(id), 5000);
  }

  /** Status for `GET /llm` and the control panel. */
  status() {
    this.resetBudgetIfNewDay();
    return {
      enabled: this.enabled,
      disabledReason: this.disabledReason,
      provider: this.cfg.provider || 'openai-compatible',
      model: this.client.model,
      baseUrl: this.client.baseUrl,
      tokensToday: this.tokensToday,
      dailyTokenBudget: (this.cfg.limits && this.cfg.limits.dailyTokenBudget) || null,
      budgetExceeded: this.budgetExceeded,
      turnsInFlight: this.turnsInFlight,
      openRequests: [...this.requests.values()].filter((r) => !r.closed).map((r) => ({ id: r.id, text: r.text, turns: r.turns })),
      recentTurns: this.turns.slice(-10),
      capabilities: this.capabilities(),
      /**
       * The tool inventory, so the panel can show what the model is actually allowed to do.
       * A model that can call `do_task` is a very different thing from one that can only talk,
       * and that difference should be visible without reading the config.
       */
      tools: {
        enabled: this.toolsEnabled,
        maxPerTurn: (this.cfg.limits && this.cfg.limits.maxToolCallsPerTurn) || 4,
        names: toolRegistry.toolNames(),
        readOnly: toolRegistry.readOnlyTools().map((t) => t.name)
      }
    };
  }

  stop() {
    this.requests.clear();
  }
}

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

module.exports = { LlmCore, dayKey };
