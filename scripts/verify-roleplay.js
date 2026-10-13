'use strict';
/**
 * End-to-end audit of the role-play deliverable, with no game and no network.
 *
 * Three claims are checked against the live prompt and library code rather than against a mock
 * of them:
 *
 *   1. the account is named `agent`
 *   2. the character comes from config/persona.md, and nothing in the source names one
 *   3. role play works: reactive dialogue, plus speech the bot starts on its own when work
 *      finishes, when it is hungry with no food, and when it is badly hurt
 *
 * The last group is the one that matters most, because "the bot acted on its own initiative" is
 * the failure a role-play feature invites. The check that a model-proposed action is dropped
 * (`the proposed action is dropped`) is what keeps that from being a matter of prompt wording.
 *
 * Run with: node scripts/verify-roleplay.js   (or: npm run verify:roleplay)
 */
const fs = require('fs');
const { LlmCore } = require('../src/llm');
const { systemPrompt } = require('../src/llm/blackboard');
const { loadPersona, resolveTrigger } = require('../src/llm/persona');
const { SpeechScheduler } = require('../src/chat/speechScheduler');
const { reply } = require('../src/chat/reply');
const { loadConfig } = require('../src/util/config');

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

/** A context wired the way index.js wires it, minus the sockets. */
function makeCtx(cfg, overrides = {}) {
  const snap = {
    ready: true,
    body: 'mock',
    position: { x: 10, y: 64, z: -5 },
    dimension: 'minecraft:overworld',
    health: 20,
    food: 20,
    inventory: {},
    emptySlots: 36,
    time: { isDay: true, timeOfDay: 1000, day: 1 },
    hostiles: [],
    nearbyItems: [],
    ...overrides.snapshot
  };
  const body = {
    kind: 'mock',
    isReady: true,
    snapshot: () => (overrides.snapshot === null ? null : snap),
    chat: async () => true,
    interrupt: async () => true
  };
  const ctx = {
    cfg,
    body,
    bodyKind: 'mock',
    world: { snapshot: () => (overrides.snapshot === null ? null : snap), summary: () => ({ ready: true }) },
    brain: { status: () => ({ current: null }) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    ...overrides
  };
  delete ctx.snapshot;
  ctx.reply = (text, options) => reply(ctx, text, options);
  return ctx;
}

async function main() {
  const cfg = loadConfig({ profile: null });
  // Keep the audit offline: the template path is what runs without a key.
  cfg.llm = { ...cfg.llm, enabled: false };

  console.log('1. account name');
  /**
   * The audit checks that the three places naming the account *agree* - not that they say a
   * particular word.
   *
   * The account is renamed from time to time (the skin on a third-party skin site is keyed to
   * the in-game name, so renaming is how a character gets a new skin), so pinning the literal
   * here meant the audit had to be edited on every rename, and its four checks would have
   * passed happily while the files disagreed with each other. Deriving the name from the
   * loaded config and asserting the files carry *that* name is what the audit was always for.
   */
  const account = cfg.agent.bot.username;
  check('an account name is configured', typeof account === 'string' && account.length > 0, JSON.stringify(account));
  check(
    'config/agent.json carries the configured account name',
    fs.readFileSync('config/agent.json', 'utf8').includes(`"username": "${account}"`)
  );
  check(
    'config/servers.json carries the configured account name',
    fs.readFileSync('config/servers.json', 'utf8').includes(`"username": "${account}"`)
  );
  {
    const launcher = fs.readFileSync('scripts/launch-forge-client.js', 'utf8');
    check(
      'the offline launcher defaults to the same account name',
      launcher.includes(`DEFAULT_OFFLINE_USERNAME = '${account}'`)
    );
  }

  console.log('\n2. the character comes from the persona file');
  const persona = loadPersona({ root: process.cwd() });
  check('config/persona.md loads', persona.loaded, persona.error || '');
  check('the character is 大肥鱼', persona.name === '大肥鱼', persona.name);
  check('the trigger comes from the frontmatter', persona.trigger === '@大肥鱼', persona.trigger);
  {
    const ctx = makeCtx(cfg);
    check('resolveTrigger reads the persona file when config is null', resolveTrigger(ctx) === '@大肥鱼', resolveTrigger(ctx));
    const prompt = systemPrompt(ctx, cfg.llm);
    check('the prompt carries the character body', prompt.includes('大肥鱼') && prompt.includes('鲸鱼娘'));
    check('the prompt does not carry the maintainer notes', !/结尾提醒|加载器追加/.test(prompt));
    check('the say limit in the prompt follows the persona', /under \d+ characters/.test(prompt));
    check('the capability table says say is available', /YES\s+say/.test(prompt));
    check('the no-unprompted-speech rule is gone', !/cannot speak unless the player spoke to you/i.test(prompt));
  }

  console.log('\n3a. reactive dialogue');
  {
    const ctx = makeCtx(cfg);
    const core = new LlmCore(ctx, cfg.llm, { client: null });
    core.enabled = false; // fallback router path: deterministic, no network
    const record = await core.handle('砍点树', { source: 'chat', speaker: '主人' });
    /**
     * Field names matter here: `record.intent` is the validated intent object,
     * `record.action` is its human-readable description (`describeIntent`), and `record.executed`
     * is the dispatch result. The first version of this audit read `record.action.task`, which
     * is a string, and reported the description as though it were a failure detail.
     */
    const intent = record.intent && record.intent.action;
    check('a player request is routed', !!intent, JSON.stringify(record.action));
    check('the router produced a chop task', !!intent && intent.type === 'task' && intent.task === 'chop', JSON.stringify(intent));
    check('the task carries a count', !!(intent && intent.args && intent.args.count > 0), JSON.stringify(intent && intent.args));
    const spoken = (ctx.replies || []).map((r) => r.text);
    check('the bot answered in chat', spoken.length >= 1, spoken.join(' | '));
    check('the answer carries no character mannerism', !spoken.some((t) => /喵/.test(t)), spoken.join(' | '));
  }

  console.log('\n3b. proactive speech: finished work');
  {
    const ctx = makeCtx(cfg);
    const core = new LlmCore(ctx, cfg.llm, { client: null });
    core.enabled = false;
    await core.announceFinished({ name: 'chop', description: '砍 20 根木头', reason: 'collected 20 logs', source: 'chat' }, true);
    const spoken = (ctx.replies || []).map((r) => r.text);
    check('a finished job is announced', spoken.length === 1, spoken.join(' | '));
    check('the announcement names the work', /砍 20 根木头/.test(spoken[0] || ''), spoken[0]);
    check('the announcement cannot re-enter as a command', !!spoken[0] && !/^[!/]/.test(spoken[0]));
    await core.announceFinished({ name: 'dirt', description: '挖点土', reason: 'ok', source: 'autonomous' }, true);
    check('planner-owned work stays silent', (ctx.replies || []).length === 1);
  }

  console.log('\n3c. proactive speech: hunger and danger');
  {
    const hungry = makeCtx(cfg, { snapshot: { food: 4, inventory: {} } });
    hungry.llm = { speakUp: async (kind) => { hungry.spoke = kind; return { ok: true, said: 'x' }; } };
    await new SpeechScheduler(hungry, {}).tick();
    check('hunger with no food triggers speech', hungry.spoke === 'hungry', String(hungry.spoke));

    const fed = makeCtx(cfg, { snapshot: { food: 4, inventory: { 'minecraft:cooked_beef': 3 } } });
    let fedSpoke = null;
    fed.llm = { speakUp: async (kind) => { fedSpoke = kind; return { ok: true }; } };
    await new SpeechScheduler(fed, {}).tick();
    check('carrying food suppresses the hunger line', fedSpoke === null, String(fedSpoke));

    const hurt = makeCtx(cfg, { snapshot: { health: 4, food: 4 } });
    let hurtKind = null;
    hurt.llm = { speakUp: async (kind) => { hurtKind = kind; return { ok: true }; } };
    await new SpeechScheduler(hurt, {}).tick();
    check('low health triggers speech', hurtKind === 'lowHealth', String(hurtKind));

    const repeat = makeCtx(cfg, { snapshot: { health: 4 } });
    let count = 0;
    repeat.llm = { speakUp: async () => { count += 1; return { ok: true }; } };
    const sch = new SpeechScheduler(repeat, {});
    await sch.tick();
    await sch.tick();
    await sch.tick();
    check('a persistent state speaks once per cooldown', count === 1, `${count} utterance(s) over 3 ticks`);

    const offline = makeCtx(cfg, { snapshot: null });
    let offlineSpoke = null;
    offline.llm = { speakUp: async (k) => { offlineSpoke = k; return { ok: true }; } };
    await new SpeechScheduler(offline, {}).tick();
    check('a detached client is not treated as dying', offlineSpoke === null, String(offlineSpoke));

    const dead = makeCtx(cfg, { snapshot: { dead: true, health: 0 } });
    let deadSpoke = null;
    dead.llm = { speakUp: async (k) => { deadSpoke = k; return { ok: true }; } };
    await new SpeechScheduler(dead, {}).tick();
    check('a dead bot does not use the low-health trigger', deadSpoke === null, String(deadSpoke));
  }

  console.log('\n3d. the speech-only guard (role play must never act on its own)');
  {
    const ctx = makeCtx(cfg);
    const core = new LlmCore(ctx, cfg.llm, { client: null });
    core.client = {
      configured: true,
      apiKey: 'test',
      model: 'test',
      baseUrl: 'test',
      complete: async () => ({
        ok: true,
        text: '{"say":"好饿啊…有人在吗","action":{"type":"task","task":"chop","args":{"count":8}}}',
        usage: { total_tokens: 5 }
      })
    };
    core.enabled = true;
    const res = await core.speakUp('hungry');
    check('the spoken part is used', res.said === '好饿啊…有人在吗', res.said);
    const last = core.turns[core.turns.length - 1];
    check('the proposed action is dropped', !!last.actionDropped, JSON.stringify(last.actionDropped));
    check('nothing was dispatched', (ctx.replies || []).length === 1);
  }

  console.log('\n3e. the trigger the agent actually listens for');
  {
    const ctx = makeCtx(cfg);
    check('the in-game trigger is @大肥鱼', resolveTrigger(ctx) === '@大肥鱼', resolveTrigger(ctx));
    const explicit = makeCtx({ ...cfg, agent: { ...cfg.agent, chat: { ...cfg.agent.chat, dialogueTrigger: '@X' } } });
    check('an explicit config trigger still wins', resolveTrigger(explicit) === '@X', resolveTrigger(explicit));
    const off = makeCtx({ ...cfg, agent: { ...cfg.agent, chat: { ...cfg.agent.chat, dialogueTrigger: false } } });
    check('dialogue can be switched off', resolveTrigger(off) === null, String(resolveTrigger(off)));
  }

  console.log(`\n${pass}/${pass + fail} checks passed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('audit crashed:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
