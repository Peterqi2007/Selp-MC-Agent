'use strict';

/**
 * `npm run llm:dry` - iterate on the LLM layer with no game and no network.
 *
 * Two things are checked here, and the distinction is the point:
 *
 *   1. **Intent routing accuracy** over a fixed set of 30 real utterances (Chinese, with a
 *      few English ones), through the deterministic fallback router. The plan's bar is
 *      ">=26 of 30 correct", and this is the number that matters in practice, because the
 *      fallback is what runs when the key is missing, the network is slow, or the model
 *      returns nonsense.
 *   2. **Schema discipline** - that the validator accepts well-formed intents (including
 *      fenced and prose-wrapped JSON, which models emit constantly) and rejects everything
 *      outside the enum, including a prompt-injection attempt that tries to smuggle in a
 *      server command.
 *
 * It also prints the assembled prompt, so tuning the persona or the capability table is a
 * one-second loop instead of a five-minute round trip through Minecraft.
 *
 * The capability table is printed for a *client-mod* body, not for the mock: that is what
 * the model sees in production, and it is the table that has to say "no" to crafting.
 */

const { loadConfig } = require('../src/util/config');
const { MockBody } = require('../src/body/mockBody');
const { BodyWorldView } = require('../src/world/bodyWorldView');
const { LlmCore } = require('../src/llm');
const { parseIntent, describeIntent } = require('../src/llm/intent');
const { systemPrompt, capabilityTable } = require('../src/llm/blackboard');
const fallbackRouter = require('../src/llm/fallbackRouter');
const { sanitize } = require('../src/chat/reply');

const log = { debug() {}, info() {}, warn() {}, error() {} };

/** Default count the router applies when the utterance names no number. */
const DEFAULT_COUNT = 8;

/**
 * The routing corpus.
 *
 * `expect` describes the action the agent should take; `null` means "correctly understood
 * as not-a-task" (the agent answers with a question rather than inventing work).
 */
const UTTERANCES = [
  // ---- chop -------------------------------------------------------------
  { text: '砍点树', expect: { type: 'task', task: 'chop' } },
  { text: '帮我砍树', expect: { type: 'task', task: 'chop' } },
  { text: '去砍 32 根木头', expect: { type: 'task', task: 'chop', count: 32 } },
  { text: '砍8个原木', expect: { type: 'task', task: 'chop', count: 8 } },
  { text: '弄点木头来', expect: { type: 'task', task: 'chop' } },
  { text: '伐木', expect: { type: 'task', task: 'chop' } },
  { text: 'chop some wood', expect: { type: 'task', task: 'chop' } },
  { text: '我想要点木头', expect: { type: 'task', task: 'chop' } },
  // ---- mine -------------------------------------------------------------
  { text: '挖点石头', expect: { type: 'task', task: 'mine', block: 'stone' } },
  { text: '帮我挖 16 个圆石', expect: { type: 'task', task: 'mine', block: 'cobblestone', count: 16 } },
  { text: '去挖铁矿', expect: { type: 'task', task: 'mine', block: 'iron_ore' } },
  { text: '挖3个钻石', expect: { type: 'task', task: 'mine', block: 'diamond_ore', count: 3 } },
  { text: '采点煤', expect: { type: 'task', task: 'mine', block: 'coal_ore' } },
  { text: 'mine some stone', expect: { type: 'task', task: 'mine', block: 'stone' } },
  { text: '挖沙子', expect: { type: 'task', task: 'mine', block: 'sand' } },
  { text: '我需要金矿', expect: { type: 'task', task: 'mine', block: 'gold_ore' } },
  // ---- collect ----------------------------------------------------------
  { text: '捡一下掉落物', expect: { type: 'task', task: 'collect' } },
  { text: '把地上的东西捡起来', expect: { type: 'task', task: 'collect' } },
  { text: 'collect the drops', expect: { type: 'task', task: 'collect' } },
  { text: '拾取物品', expect: { type: 'task', task: 'collect' } },
  // ---- go_to ------------------------------------------------------------
  { text: '过来', expect: { type: 'go_to' } },
  { text: '过来吧', expect: { type: 'go_to' } },
  { text: 'come here', expect: { type: 'go_to' } },
  { text: '走到我这边', expect: { type: 'go_to' } },
  // ---- stop -------------------------------------------------------------
  { text: '停下', expect: { type: 'stop' } },
  { text: '别砍了', expect: { type: 'stop' } },
  { text: 'stop', expect: { type: 'stop' } },
  { text: '取消', expect: { type: 'stop' } },
  // ---- correctly NOT routed to an action --------------------------------
  { text: '今天天气怎么样', expect: null },
  { text: '现在几点了', expect: null }
];

/**
 * Does the produced action satisfy the expectation?
 *
 * The count rule is the interesting one. An utterance that names no number must not end up
 * with an invented one - "砍点树" turning into "chop 47" would be the router making up
 * facts. The documented default (8) is allowed, because defaulting is not inventing.
 */
function matches(action, expect) {
  if (!expect) return action === null;
  if (!action) return false;
  if (action.type !== expect.type) return false;
  if (expect.type !== 'task') return true;
  if (action.task !== expect.task) return false;

  const count = action.args ? action.args.count : undefined;
  if (expect.count !== undefined) {
    if (count !== expect.count) return false;
  } else if (count !== undefined && count !== DEFAULT_COUNT) {
    return false; // a number nobody asked for
  }

  if (expect.block !== undefined) {
    const blocks = action.args.block || [];
    if (!blocks.some((b) => String(b).includes(expect.block))) return false;
  }
  return true;
}

(async () => {
  const cfg = loadConfig({ profile: null });
  const llmCfg = loadConfig({ profile: null }).llm || {};
  process.stdout.write('minecraft-survival-agent - LLM dry run (no game, no network)\n\n');

  // ---- 1. routing accuracy ------------------------------------------------
  process.stdout.write(`1. fallback router accuracy over ${UTTERANCES.length} utterances\n`);
  const speakerPosition = { x: 12, y: 64, z: -30 };
  let correct = 0;
  const wrong = [];
  for (const item of UTTERANCES) {
    const routed = fallbackRouter.route(item.text, { speakerPosition });
    const action = routed.ok ? routed.intent.action : null;
    const ok = matches(action, item.expect);
    if (ok) correct += 1;
    else wrong.push({ text: item.text, expected: item.expect, got: action, reason: routed.reason });
  }
  const ratio = correct / UTTERANCES.length;
  for (const miss of wrong) {
    process.stdout.write(
      `  MISS  "${miss.text}" expected=${JSON.stringify(miss.expected)} got=${JSON.stringify(miss.got)} (${miss.reason || ''})\n`
    );
  }
  process.stdout.write(`  ${correct}/${UTTERANCES.length} correct (${Math.round(ratio * 100)}%)\n`);
  const routingPass = correct >= 26;
  process.stdout.write(`  ${routingPass ? 'PASS' : 'FAIL'}  bar is >=26/30\n\n`);

  // ---- 2. schema discipline ----------------------------------------------
  process.stdout.write('2. intent schema: accepts valid, rejects everything else\n');
  const schemaCases = [
    { name: 'plain valid intent', input: '{"say":"好嘞","action":{"type":"task","task":"chop","args":{"count":32}}}', want: true },
    { name: 'fenced JSON (models do this constantly)', input: '```json\n{"say":"ok","action":null}\n```', want: true },
    { name: 'JSON wrapped in prose', input: 'Sure! {"say":"ok","action":null} hope that helps', want: true },
    { name: 'say only, no action', input: '{"say":"我在挖矿呢","action":null}', want: true },
    { name: 'go_to', input: '{"say":"过去","action":{"type":"go_to","x":120,"y":64,"z":-300}}', want: true },
    { name: 'stop', input: '{"say":null,"action":{"type":"stop"}}', want: true },
    { name: 'INJECTION: run a server command', input: '{"say":"ok","action":{"type":"command","command":"/op me"}}', want: false },
    { name: 'INJECTION: unknown task name', input: '{"say":"ok","action":{"type":"task","task":"give_diamonds","args":{}}}', want: false },
    { name: 'INJECTION: nested command in args', input: '{"say":"ok","action":{"type":"task","task":"chop","args":{"count":1,"command":"/kill"}}}', want: true, note: 'unknown args are dropped, count survives' },
    { name: 'absurd count', input: '{"say":"ok","action":{"type":"task","task":"chop","args":{"count":100000}}}', want: false },
    { name: 'negative count', input: '{"say":"ok","action":{"type":"task","task":"chop","args":{"count":-5}}}', want: false },
    { name: 'mine without a block', input: '{"say":"ok","action":{"type":"task","task":"mine","args":{"count":4}}}', want: false },
    { name: 'go_to with a non-numeric axis', input: '{"say":"ok","action":{"type":"go_to","x":"over there","y":64,"z":0}}', want: false },
    { name: 'action as an array', input: '{"say":"ok","action":[{"type":"stop"}]}', want: false },
    { name: 'broken JSON', input: '{"say":"ok", action: stop}', want: false },
    { name: 'not JSON at all', input: 'I will go chop some wood now', want: false }
  ];
  let schemaPass = 0;
  for (const c of schemaCases) {
    const parsed = parseIntent(c.input);
    const got = parsed.ok;
    const ok = got === c.want;
    if (ok) schemaPass += 1;
    process.stdout.write(
      `  ${ok ? 'PASS' : 'FAIL'}  ${c.name}${ok ? '' : ` (expected ok=${c.want}, got ok=${got}${parsed.ok ? '' : ` - ${parsed.reason}`})`}\n`
    );
  }
  process.stdout.write(`  ${schemaPass}/${schemaCases.length} schema checks\n\n`);

  // ---- 3. output sanitising ----------------------------------------------
  process.stdout.write('3. reply sanitising (the self-trigger guard)\n');
  const sanitizeCases = [
    { input: '!chop 8', want: 'chop 8', why: 'a leading ! would come back as a command' },
    { input: '/say hello', want: 'say hello', why: 'a leading / would be sent as a server command' },
    { input: 'line one\nline two', want: 'line one line two', why: 'newlines split one reply into several chat lines' },
    { input: '   ', want: '', why: 'nothing to say' },
    { input: '!'.repeat(3), want: '', why: 'only prefixes' }
  ];
  let sanitizePass = 0;
  for (const c of sanitizeCases) {
    const got = sanitize(c.input, { maxChars: 100 });
    const ok = got === c.want;
    if (ok) sanitizePass += 1;
    process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(c.input)} -> ${JSON.stringify(got)}${ok ? '' : ` (expected ${JSON.stringify(c.want)})`}\n`);
  }
  process.stdout.write(`  ${sanitizePass}/${sanitizeCases.length} sanitise checks\n\n`);

  // ---- 4. the tool layer --------------------------------------------------
  process.stdout.write('4. tool registry: the whitelist gate (plan §5.3)\n');
  const toolRegistry = require('../src/llm/tools/registry');

  /** Counted checks for the tool sections, so the summary is arithmetic-free. */
  let toolPass = 0;
  let toolTotal = 0;
  function tcheck(name, ok, detail) {
    toolTotal += 1;
    if (ok) toolPass += 1;
    process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`);
  }

  const EXPECTED_TOOLS = ['observe', 'find_blocks', 'lookup_item', 'do_task', 'go_to', 'stop'];
  const names = toolRegistry.toolNames();
  tcheck('exactly the 6 planned tools exist', names.length === 6 && EXPECTED_TOOLS.every((n) => names.includes(n)), names.join(', '));
  tcheck(
    'there is deliberately NO say tool (speech is a reply field, not a capability)',
    !names.includes('say') && !names.includes('chat'),
    `names: ${names.join(', ')}`
  );
  tcheck(
    'the tools P0 excluded do not exist',
    !['craft', 'build', 'store', 'hunt', 'light', 'fish', 'web_search', 'command'].some((n) => names.includes(n)),
    'no craft/build/store/hunt/light/fish/web_search/command'
  );
  tcheck(
    'read-only tools are separated from the ones that change the world',
    toolRegistry.readOnlyTools().length === 3 && toolRegistry.readOnlyTools().every((t) => t.kind === 'read'),
    `${toolRegistry.readOnlyTools().map((t) => t.name).join(', ')} are read-only`
  );

  const toolCases = [
    { name: 'unknown tool is refused', tool: 'run_command', args: { cmd: '/op me' }, wantOk: false },
    { name: 'a missing required argument is refused', tool: 'find_blocks', args: {}, wantOk: false },
    { name: 'an out-of-enum task is refused', tool: 'do_task', args: { task: 'craft' }, wantOk: false },
    { name: 'an absurd count is refused', tool: 'do_task', args: { task: 'chop', args: { count: 100000 } }, wantOk: false },
    { name: 'unknown extra arguments are refused', tool: 'go_to', args: { x: 1, y: 2, z: 3, command: '/kill' }, wantOk: false },
    { name: 'a non-numeric coordinate is refused', tool: 'go_to', args: { x: 'over there', y: 2, z: 3 }, wantOk: false },
    { name: 'mine without a block is refused', tool: 'do_task', args: { task: 'mine' }, wantOk: false }
  ];
  // A context with no body: every call below must be refused *before* it reaches the world.
  const bareCtx = { cfg: { agent: { bot: { version: '1.20.1' } } }, log: { debug() {} }, body: null, world: null };
  for (const c of toolCases) {
    const res = await toolRegistry.call(bareCtx, c.tool, c.args);
    tcheck(c.name, res.ok === c.wantOk, res.ok ? undefined : res.error);
  }
  process.stdout.write('\n');

  // ---- 5. the perceptors against a real (mock) world ----------------------
  process.stdout.write('5. perceptors answer questions about the world\n');
  const mockBody = new MockBody(cfg, {
    blocks: [
      { name: 'oak_log', position: { x: 4, y: 64, z: 0 } },
      { name: 'stone', position: { x: 5, y: 64, z: 0 } },
      { name: 'stone', position: { x: 6, y: 64, z: 0 } }
    ],
    inventory: { oak_log: 3, stone_pickaxe: 1 },
    entities: [{ name: 'zombie', position: { x: 8, y: 64, z: 0 }, kind: 'hostile' }]
  });
  await mockBody.connect();
  const toolCtx = {
    cfg,
    log,
    body: mockBody,
    world: new BodyWorldView(mockBody, cfg, { log }),
    brain: { status: () => ({ current: null }) },
    mods: null,
    memory: { landmark: () => null }
  };

  const observed = await toolRegistry.call(toolCtx, 'observe', {});
  tcheck(
    'observe() returns the state the plan lists',
    observed.ok &&
      !!observed.result.position &&
      observed.result.inventory.length >= 2 &&
      observed.result.inventory.some((i) => i.name === 'stone_pickaxe') &&
      // `heldItem` is null until something is equipped - the mock starts empty-handed, and
      // reporting a held item it does not have would be exactly the kind of invention the
      // observe tool exists to prevent.
      observed.result.heldItem === null &&
      Array.isArray(observed.result.nearbyBlocks) &&
      observed.result.currentTask === null,
    `${observed.result.inventory.length} item kinds, ${observed.result.nearbyBlocks.length} block types, held=${observed.result.heldItem}`
  );

  const foundStone = await toolRegistry.call(toolCtx, 'find_blocks', { names: ['stone'], maxDistance: 24 });
  tcheck(
    'find_blocks() returns coordinates and reports what it did not find',
    foundStone.ok && foundStone.result.blocks.length === 2 && foundStone.result.notFound.length === 0,
    `${foundStone.result.blocks.length} stone, notFound=[${foundStone.result.notFound.join(',')}]`
  );
  const foundDiamond = await toolRegistry.call(toolCtx, 'find_blocks', { names: ['diamond_ore'] });
  tcheck(
    'find_blocks() distinguishes "none here" from "did not ask"',
    foundDiamond.ok && foundDiamond.result.blocks.length === 0 && foundDiamond.result.notFound.includes('diamond_ore'),
    `notFound=[${foundDiamond.result.notFound.join(',')}]`
  );

  const known = await toolRegistry.call(toolCtx, 'lookup_item', { name: 'oak_log' });
  const modded = await toolRegistry.call(toolCtx, 'lookup_item', { name: 'create:cogwheel' });
  const nonsense = await toolRegistry.call(toolCtx, 'lookup_item', { name: 'not_a_real_block' });
  tcheck('lookup_item() recognises a vanilla item', known.ok && known.result.known === true, `${known.result.name} -> ${known.result.kind}`);
  tcheck(
    'lookup_item() says it does not know a modded name instead of guessing',
    modded.ok && modded.result.known === false && /mod namespace/.test(modded.result.note || ''),
    modded.result.note
  );
  tcheck('lookup_item() rejects nonsense', nonsense.ok && nonsense.result.known === false, nonsense.result.note);

  // ---- 6. a bounded tool round, end to end --------------------------------
  process.stdout.write('\n6. a model that looks before it decides (bounded tool round)\n');
  const toolScript = [
    { ok: true, text: '', toolCalls: [{ id: 'call_1', name: 'observe', arguments: '{}' }], usage: { total_tokens: 12 } },
    {
      ok: true,
      text: '{"say":"看到 3 根木头喵","action":{"type":"task","task":"chop","args":{"count":3}}}',
      usage: { total_tokens: 21 }
    }
  ];
  const fakeTransport = (script) => ({
    configured: true,
    model: 'fake-model',
    baseUrl: 'http://fake',
    stats: { calls: 0, failures: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, lastError: null },
    async complete() {
      this.stats.calls += 1;
      return script.length > 1 ? script.shift() : script[0];
    },
    describe() {
      return { model: this.model, configured: true };
    }
  });

  const dispatched = [];
  const roundCtx = {
    ...toolCtx,
    chat: {
      handle: async (line, who, opts) => {
        dispatched.push({ line, who, source: opts && opts.source });
        return { ok: true, command: line.split(' ')[0], result: { accepted: true } };
      }
    },
    reply: async () => true
  };

  const toolClient = fakeTransport(toolScript);
  const core = new LlmCore(roundCtx, { ...llmCfg, enabled: true, toolCalling: true }, { log, client: toolClient });
  const roundRecord = await core.handle('砍点树', { source: 'chat', speaker: '玩家' });

  tcheck(
    'the model was allowed to call a tool before deciding',
    !!roundRecord.toolCalls && roundRecord.toolCalls.length === 1 && roundRecord.toolCalls[0].name === 'observe' && roundRecord.toolCalls[0].ok,
    JSON.stringify(roundRecord.toolCalls)
  );
  tcheck('the tool result led to a normal intent', roundRecord.via === 'llm' && roundRecord.action === 'chop count=3', `via=${roundRecord.via}, action=${roundRecord.action}`);
  tcheck(
    'the decision still went through the shared command table, tagged as llm work',
    dispatched.length === 1 && dispatched[0].line === 'chop 3' && dispatched[0].source === 'llm',
    JSON.stringify(dispatched)
  );
  tcheck('two model calls were made (tool round + decision)', toolClient.stats.calls === 2, `${toolClient.stats.calls} calls`);

  const loopingClient = fakeTransport([]);
  loopingClient.complete = async function complete() {
    this.stats.calls += 1;
    return { ok: true, text: '', toolCalls: [{ id: `call_${this.stats.calls}`, name: 'observe', arguments: '{}' }], usage: { total_tokens: 5 } };
  };
  const loopCore = new LlmCore(roundCtx, { ...llmCfg, enabled: true, toolCalling: true }, { log, client: loopingClient });
  const loopRecord = await loopCore.handle('挖点石头', { source: 'chat', speaker: '玩家' });
  tcheck(
    'a model stuck in a tool loop still gets an answer (the round is bounded)',
    loopRecord.via === 'fallback' && !!loopRecord.action && /mine/.test(loopRecord.action),
    `via=${loopRecord.via}, action=${loopRecord.action}, calls=${loopingClient.stats.calls}`
  );

  // ---- 7. the assembled prompt -------------------------------------------
  const body = new MockBody(cfg, { blocks: [{ name: 'oak_log', position: { x: 4, y: 64, z: 0 } }] });
  await body.connect();
  /**
   * Present the body as the client-mod one. The mock can craft, and crafting is exactly
   * the capability that must read "no" in production (P0 does not craft); printing the
   * mock's table here would hide the most consequential line in the prompt.
   */
  body.kind = 'clientmod';
  Object.defineProperty(body, 'supportsCrafting', { value: false, configurable: true });

  const ctx = {
    cfg,
    log,
    body,
    world: new BodyWorldView(body, cfg, { log }),
    brain: { status: () => ({ current: null }) },
    reply: async () => true
  };
  const promptCore = new LlmCore(ctx, { ...llmCfg, enabled: false }, { log });
  process.stdout.write('\n7. capabilities advertised to the model (as a client-mod body)\n');
  process.stdout.write(`${capabilityTable(ctx)}\n\n`);

  process.stdout.write('8. assembled system prompt\n');
  process.stdout.write(`${'-'.repeat(64)}\n${systemPrompt(ctx, llmCfg)}\n${'-'.repeat(64)}\n\n`);

  process.stdout.write('9. LLM status with no key configured\n');
  const status = promptCore.status();
  process.stdout.write(`  enabled=${status.enabled} reason=${status.disabledReason} model=${status.model}\n`);
  process.stdout.write(`  fallback still handles every message: ${!status.enabled ? 'yes' : 'n/a'}\n\n`);

  const failed =
    !routingPass || schemaPass !== schemaCases.length || sanitizePass !== sanitizeCases.length || toolPass !== toolTotal;
  process.stdout.write(`${'='.repeat(64)}\n`);
  process.stdout.write(
    `llm dry run: routing ${correct}/${UTTERANCES.length}, schema ${schemaPass}/${schemaCases.length}, ` +
      `sanitise ${sanitizePass}/${sanitizeCases.length}, tools ${toolPass}/${toolTotal}\n`
  );
  if (failed) {
    process.stdout.write('FAILED\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('OK - the tool whitelist holds and the fallback router is accurate\n');
  }
})().catch((err) => {
  process.stdout.write(`llm dry run crashed: ${err.stack}\n`);
  process.exitCode = 1;
});
