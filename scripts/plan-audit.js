'use strict';

/**
 * `npm run plan:audit` - check the plan's own "P0 做/不做" checklist against the code.
 *
 * `docs/P0-PLAN.md` §11 writes down, item by item, what P0 must and must not contain. That
 * list is the closest thing this project has to an acceptance contract, and it is easy to
 * drift away from it silently: a feature gets added under a different name, or a "done" item
 * quietly loses its wiring during a refactor. This script turns the prose list into
 * assertions over the real modules.
 *
 * It checks *presence and wiring*, not behaviour - behaviour belongs to the suites
 * (`path:test`, `tasks:test`, `llm:dry`, `control:test`, `selftest`).
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const results = [];

/**
 * RETIREMENT S4: stage-aware audit.
 *
 * P1 §3.3 freezes the migration rule: P0 assertions stay unless replaced in the same
 * commit, and the audit must not be deleted or made always-green. `--stage p0` (default)
 * runs the P0 contract exactly as before; `--stage p1` runs it **plus** the P1 additions,
 * so a stage cannot quietly drop the earlier guarantees.
 */
const STAGE = (() => {
  const argv = process.argv.slice(2);
  const index = argv.indexOf('--stage');
  const value = index >= 0 ? argv[index + 1] : 'p0';
  if (value !== 'p0' && value !== 'p1') {
    process.stdout.write(`unknown stage "${value}" (use --stage p0|p1)\n`);
    process.exit(2);
  }
  return value;
})();

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    process.stdout.write(`  PASS  ${name}${detail ? ` - ${detail}` : ''}\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
  }
}

const exists = (relative) => fs.existsSync(path.join(ROOT, relative));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

process.stdout.write(`P0 plan audit (docs/P0-PLAN.md §11 checklist) [stage ${STAGE}]\n\n`);
process.stdout.write('做 (must exist and be wired)\n');

// ---------------------------------------------------------------- deliverable A
check('A: the five pathfinding modules exist', () => {
  const files = [
    'src/pathfinding/vec3util.js',
    'src/pathfinding/clientWorldAdapter.js',
    'src/pathfinding/movementsAdapter.js',
    'src/pathfinding/planner.js',
    'src/pathfinding/walker.js'
  ];
  const missing = files.filter((f) => !exists(f));
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  return 'vec3util + world + movements + planner + walker';
});

check('A: the planner reuses mineflayer-pathfinder\'s A* rather than reimplementing it', () => {
  const planner = read('src/pathfinding/planner.js');
  if (!/require\('mineflayer-pathfinder\/lib\/astar'\)/.test(planner)) throw new Error('A* solver is not the plugin\'s');
  return 'astar.js is reused; only world + movements are ours';
});

check('A: moveTo() is wired to the planner, with the direct walk kept as a fallback', () => {
  const body = read('src/body/clientModBody.js');
  if (!/this\.navigator\.goTo\(/.test(body)) throw new Error('moveTo does not call the navigator');
  if (!/_rawMoveTo/.test(body)) throw new Error('the degradation path is missing');
  return 'navigator for distance, _rawMoveTo for short hops and no-scan';
});

check('A: the failure classification from §3.5 is present', () => {
  const planner = read('src/pathfinding/planner.js');
  for (const status of ['noPath', 'out-of-grid', 'timeout', 'unknown-block', 'body-lost', 'partial']) {
    if (!planner.includes(`'${status}'`)) throw new Error(`missing status ${status}`);
  }
  return 'noPath / out-of-grid / timeout / unknown-block / body-lost / partial';
});

check('A: runtime/path-trace.jsonl is written', () => {
  const cfg = read('src/util/config.js');
  if (!/path-trace\.jsonl/.test(cfg)) throw new Error('no path trace configured');
  if (!/trace: \(record\)/.test(read('src/body/clientModBody.js'))) throw new Error('the body does not emit path traces');
  return 'configured and emitted';
});

// ---------------------------------------------------------------- deliverable B
check('B: the three primitives exist as tasks', () => {
  const files = ['src/tasks/harvest.js', 'src/tasks/chopWood.js', 'src/tasks/mineBlock.js', 'src/tasks/goto.js'];
  const missing = files.filter((f) => !exists(f));
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  const harvest = read('src/tasks/harvest.js');
  for (const step of ['approach(', 'breakBlock(', 'collectDrops(']) {
    if (!harvest.includes(step)) throw new Error(`HarvestTask is missing ${step}`);
  }
  return 'walk (approach) + break (breakBlock) + collect (collectDrops)';
});

check('B: the planner uses the primitive tasks, not the legacy ones', () => {
  const brain = read('src/brain.js');
  const evaluator = read('src/planner/evaluator.js');
  if (/new GatherWoodTask\(|new MineTask\(/.test(brain)) throw new Error('the task factory still builds legacy tasks');
  if (!/new ChopWoodTask\(/.test(brain) || !/new MineBlockTask\(/.test(brain)) throw new Error('the primitive tasks are not built by the factory');
  /**
   * RETIREMENT S1: the rule table moved to evaluator.js and must stay declarative.
   * This replaces the part of the old check that looked for the rule table in brain.js -
   * the behaviour being protected (primitive tasks, no legacy ones) is unchanged.
   */
  if (/new \w+Task\(/.test(evaluator)) throw new Error('the evaluator must return data, not Task instances (S1)');
  if (!/module\.exports = \{ evaluate/.test(evaluator)) throw new Error('the evaluator is not exported');
  return 'factory builds ChopWoodTask / MineBlockTask; evaluator stays declarative';
});

check('B: an inventory-full check exists (fail early, with a reason)', () => {
  const harvest = read('src/tasks/harvest.js');
  if (!/inventory is full/.test(harvest)) throw new Error('no inventory-full guard');
  return 'fails early instead of digging into the void';
});

check('B: unreachable drops are skipped rather than chased', () => {
  const harvest = read('src/tasks/harvest.js');
  if (!/MAX_DROP_Y_DELTA/.test(harvest)) throw new Error('no vertical filter for drops');
  return 'drops more than 2 blocks away vertically are skipped';
});

// ---------------------------------------------------------------- deliverable C
check('C: the LLM module set matches §5.1', () => {
  const files = [
    'src/llm/index.js',
    'src/llm/client.js',
    'src/llm/blackboard.js',
    'src/llm/intent.js',
    'src/llm/fallbackRouter.js',
    'src/llm/tools/registry.js',
    'src/llm/tools/perceptors.js',
    'src/llm/tools/actuators.js',
    'config/llm.json'
  ];
  const missing = files.filter((f) => !exists(f));
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  return 'index/client/blackboard/intent/fallbackRouter/tools/* + config/llm.json';
});

check('C: the planned tools (P0 + Phase-3 do_skill + scan_around), and no say tool', () => {
  const registry = require(path.join(ROOT, 'src/llm/tools/registry'));
  const names = registry.toolNames();
  const expected = ['observe', 'find_blocks', 'scan_around', 'lookup_item', 'do_task', 'do_skill', 'go_to', 'stop'];
  if (names.length !== 8 || !expected.every((n) => names.includes(n))) throw new Error(`got ${names.join(', ')}`);
  if (names.includes('say')) throw new Error('a say tool would reintroduce autonomous speech');
  return names.join(', ');
});

check('C: the intent action enum is the five-value whitelist', () => {
  const intent = require(path.join(ROOT, 'src/llm/intent.js'));
  if (intent.ACTION_TYPES.join(',') !== 'task,go_to,stop,skill') throw new Error(`ACTION_TYPES = ${intent.ACTION_TYPES}`);
  if (intent.TASK_NAMES.join(',') !== 'chop,mine,collect') throw new Error(`TASK_NAMES = ${intent.TASK_NAMES}`);
  return 'task/go_to/stop + chop/mine/collect';
});

check('C: capability self-reflection exists as list_capabilities()', () => {
  const { listCapabilities } = require(path.join(ROOT, 'src/llm/blackboard.js'));
  const caps = listCapabilities({ body: { kind: 'clientmod', supportsCrafting: false }, world: { snapshot: () => null }, brain: { status: () => ({}) } });
  const craft = caps.find((c) => c.name === 'craft');
  if (!craft || craft.available) throw new Error('a body that cannot craft must report craft as unavailable');
  return `${caps.length} capabilities, craft correctly unavailable`;
});

check('C: the fallback router exists and covers both languages', () => {
  const router = require(path.join(ROOT, 'src/llm/fallbackRouter.js'));
  const cn = router.route('砍点树', { speakerPosition: { x: 0, y: 64, z: 0 } });
  const en = router.route('chop some wood', { speakerPosition: { x: 0, y: 64, z: 0 } });
  if (!cn.ok || !en.ok) throw new Error('the fallback router failed a basic request');
  return '中文与英文都能路由';
});

check('C: the LLM trace file is configured', () => {
  const cfg = JSON.parse(read('config/llm.json'));
  if (!cfg.trace || !cfg.trace.file) throw new Error('no trace file configured');
  return cfg.trace.file;
});

// ---------------------------------------------------------------- deliverable D
check('D: the chat listener polls the control mod\'s chat log', () => {
  const listener = read('src/chat/chatListener.js');
  if (!/readChat\(/.test(listener)) throw new Error('the listener does not read chat');
  const body = read('src/body/clientModBody.js');
  if (!/\/chatlog\?n=/.test(body)) throw new Error('the body has no /chatlog call');
  return 'GET /chatlog?n= + a poller';
});

check('D: only the two trigger kinds are accepted, everything else is ignored', () => {
  const listener = read('src/chat/chatListener.js');
  if (!/startsWith\(this\.prefix\)/.test(listener)) throw new Error('no prefix filter');
  if (!/dialogueTrigger/.test(listener)) throw new Error('no dialogue trigger');
  if (!/ignoreOtherChat|stats\.ignored/.test(listener)) throw new Error('other chat is not explicitly ignored');
  return '`!` commands + the persona dialogue trigger; the rest is counted as ignored';
});

check('D: the echo filter exists (the bot cannot answer itself)', () => {
  const listener = read('src/chat/chatListener.js');
  const reply = read('src/chat/reply.js');
  if (!/noteOwnSpeech/.test(listener) || !/fingerprint/.test(reply)) throw new Error('no echo fingerprinting');
  if (!/replace\(\/\^\\s\*\[!\/\]/.test(reply)) throw new Error('sanitize does not strip a leading ! or /');
  return 'own speech is fingerprinted; replies cannot re-trigger';
});

// ---------------------------------------------------------------- deliverable E
check('E: the panel routes exist', () => {
  const server = read('src/web/statusServer.js');
  for (const route of ['/panel', '/ui/state', '/command', '/emergency-stop', '/llm']) {
    if (!server.includes(`'${route}'`)) throw new Error(`missing route ${route}`);
  }
  if (!exists('src/web/panel.js')) throw new Error('the panel HTML module is missing');
  return '/panel /ui/state /command /emergency-stop /llm';
});

check('E: /ui/state is a summary, not the block scan', () => {
  /**
   * Asserted on the real function, not on the source text.
   *
   * A regex over `statusServer.js` cannot tell which object literal a `blocks:` key belongs
   * to - it produced a false positive the first time this audit ran. Feeding `uiState()` a
   * body with a large cell map and inspecting what comes back is the actual question:
   * the panel polls this once a second, so leaking 40817 cells would be megabytes of JSON.
   */
  const { uiState } = require(path.join(ROOT, 'src/web/statusServer.js'));
  const cells = {};
  for (let i = 0; i < 2000; i += 1) cells[`${i},64,0`] = 'minecraft:stone';
  const ctx = {
    cfg: { agent: { bot: { username: 'T' }, pathfinding: {}, llm: { trace: {} } } },
    bodyKind: 'clientmod',
    body: {
      isReady: true,
      kind: 'clientmod',
      snapshot: () => ({ ready: true, position: { x: 0, y: 64, z: 0 }, blocks: { cells } }),
      interrupt() {}
    },
    world: { summary: () => ({ ready: true, health: 20, food: 20, position: { x: 0, y: 64, z: 0 } }) },
    brain: { status: () => ({ running: true, queueLength: 0 }), preempt() {}, queue: [] },
    nav: { stop() {} },
    log: { recent: () => [], warn() {}, info() {}, debug() {} }
  };
  const text = JSON.stringify(uiState(ctx));
  if (text.includes('cells')) throw new Error('/ui/state leaked the block scan');
  if (text.length > 20000) throw new Error(`/ui/state is too large: ${text.length} bytes`);
  return `${text.length} bytes with a 2000-cell world behind it`;
});

check('E: death handling aborts everything and recovery is manual only', () => {
  const watch = read('src/core/deathWatch.js');
  if (!/stopForDeath/.test(watch)) throw new Error('death does not stop the brain');
  /**
   * Recovery must not be automatic, and must not be *configurable* to be automatic either.
   *
   * This check used to require `autoResume` to exist and default to false. The operator's rule
   * is stronger than that: a respawn must never restart work, so the switch is gone. What has to
   * hold now is the absence of the machinery - no stored flag, and no call to resume from the
   * respawn path.
   */
  if (/this\.autoResume/.test(watch)) throw new Error('an auto-resume flag came back');
  /**
   * Scope the check to the `onRespawned` method body.
   *
   * A character window is not good enough: `resume()` sits just below `onRespawned()` and both
   * mention `resumeFromDeath` (as they should - that is the manual path), so "nearby text"
   * matched the human path and reported the automatic one.
   */
  const respawn = watch.slice(watch.indexOf('onRespawned('), watch.indexOf('resume()'));
  if (respawn.includes('resumeFromDeath')) {
    throw new Error('the respawn path calls resumeFromDeath - that is an automatic recovery');
  }
  // The human path must still exist, or a death would be unrecoverable.
  if (!/resume\(\)/.test(watch)) throw new Error('there is no manual resume any more');
  const cfg = JSON.parse(read('config/agent.json'));
  if ('autoResume' in (cfg.death || {})) throw new Error('death.autoResume is back in the config - recovery is manual only');
  return 'stopForDeath + alerts; resume is manual, and there is no flag to make it automatic';
});

check('E: the three-level priority queue exists', () => {
  const brain = read('src/brain.js');
  for (const level of ['urgent', 'directive', 'autonomous']) {
    if (!brain.includes(`'${level}'`)) throw new Error(`missing level ${level}`);
  }
  if (!/same level never preempts same level|LEVELS\.directive/.test(brain)) throw new Error('no same-level rule');
  return 'urgent / directive / autonomous';
});

// ---------------------------------------------------------------- hard constraints
process.stdout.write('\n不可回归的约束\n');

check('the register gate is present at every layer', () => {
  const layers = [
    ['mod-client/src/main/java/dev/agentclient/ControlHttpServer.java', /FORBIDDEN_COMMANDS/],
    ['mod-client/src/main/java/dev/agentclient/ClientActions.java', /FORBIDDEN/],
    ['src/body/clientModBody.js', /isForbidden/],
    ['src/core/authme.js', /refuse/],
    ['scripts/client-real.js', /refusing --register/]
  ];
  for (const [file, pattern] of layers) {
    if (!exists(file)) throw new Error(`${file} missing`);
    if (!pattern.test(read(file))) throw new Error(`${file} lost its register gate`);
  }
  return `${layers.length} layers still refuse /register`;
});

check('the movement model stays conservative (no digging, no lava)', () => {
  const movements = read('src/pathfinding/movementsAdapter.js');
  if (!/allowDig = options\.allowDig === true/.test(movements)) throw new Error('allowDig no longer defaults to false');
  if (!/dangerous/.test(movements)) throw new Error('dangerous blocks are no longer refused');
  const cfg = JSON.parse(read('config/agent.json'));
  if (cfg.pathfinding.allowDig !== false) throw new Error('pathfinding.allowDig must be false in P0');
  return 'allowDig=false, lava/fire/cactus refused';
});

check('the bot speaks unprompted only through the three role-play triggers', () => {
  /**
   * This check used to assert the opposite ("the bot never speaks unprompted", with
   * `chat.replyOnTaskResult` pinned to false). Role play removed that rule on purpose, so the
   * constraint is not gone - it moved:
   *
   *   prompt wording ("You cannot speak unless the player spoke to you")
   *     -> code (LlmCore.speakUp drops any action an unprompted turn proposes)
   *
   * What must still hold is that unprompted speech is *bounded*: only the three triggers, each
   * with a cooldown, and never as a way to start work.
   */
  const sched = read('src/chat/speechScheduler.js');
  for (const trigger of ['hungry', 'lowHealth', 'taskDone']) {
    if (!sched.includes(trigger)) throw new Error(`the ${trigger} trigger is gone`);
  }
  if (!/cooldownMs/.test(sched)) throw new Error('the per-trigger cooldown is gone (a starving bot would repeat forever)');

  const llm = read('src/llm/index.js');
  if (!/async speakUp/.test(llm)) throw new Error('speakUp is gone');
  // The guard that makes "no unprompted behaviour" structural rather than a prompt request.
  if (!/actionDropped/.test(llm)) throw new Error('the unprompted-action drop is gone: proactive speech could dispatch work');

  const cfg = JSON.parse(read('config/agent.json'));
  if (cfg.proactive && cfg.proactive.enabled === false) throw new Error('proactive speech is switched off in config');
  const t = (cfg.proactive && cfg.proactive.triggers) || {};
  for (const name of ['taskDone', 'hungry', 'lowHealth']) {
    if (!t[name] || t[name].enabled === false) throw new Error(`the ${name} trigger is disabled in config`);
  }
  // The old key that used to gate this is gone; a replacement would be a second, silent switch.
  if ('replyOnTaskResult' in (cfg.chat || {})) {
    throw new Error('chat.replyOnTaskResult is superseded by proactive.triggers.taskDone - remove it rather than leaving two switches');
  }
  return 'three triggers with cooldowns; unprompted turns cannot act; no duplicate switch';
});

check('B: the planner has no always-true fallback goal', () => {
  /**
   * The rule table's last entry used to be `dig-dirt` with `when: () => mayDigDirt`, which
   * defaulted to true - so on an idle planner the bot rearranged the ground to look occupied.
   * The operator removed it: idling is the correct behaviour, and on a shared server the
   * hillside is scenery rather than a resource.
   *
   * This is a regression guard, not a description. An always-true rule at the end of the table
   * silently swallows every future "the planner should idle here" case, and re-adding one would
   * look like a helpful improvement.
   */
  const brain = read('src/brain.js');
  /**
   * Strip comments before scanning.
   *
   * The first version of this check matched the very comment that documents the removal - the
   * explanation contains the literal string `when: () => true`. A guard that fires on its own
   * documentation is worse than no guard, so the scan runs over code only.
   */
  const code = brain
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
  if (/when:\s*\(\s*\)\s*=>\s*true/.test(code)) {
    throw new Error('an always-true rule is back in the planner: the agent can never idle');
  }
  if (/name:\s*'dig-dirt'/.test(code)) {
    throw new Error('the dig-dirt fallback is back');
  }
  if (/allowDirtDigging/.test(code)) {
    throw new Error('the allowDirtDigging gate is back in the planner');
  }
  const cfg = JSON.parse(read('config/agent.json'));
  if ('allowDirtDigging' in (cfg.survival || {})) {
    throw new Error('survival.allowDirtDigging is back in the config');
  }
  // Idling must stay a supported, visible state rather than a hang.
  if (!/decision:\s*'idle'/.test(code)) throw new Error('the planner no longer records the idle decision');
  // And an explicit request must still work: an instruction is an instruction.
  if (!/dirt/.test(read('src/chat/commands.js'))) throw new Error('the `!mine dirt` alias is gone');
  return 'no always-true rule; idle is recorded, and !mine dirt still works';
});

check('no Java change is required for P0 (the M3 cancellation holds)', () => {
  // The cancellation only holds while all three primitives are already exposed by the mod.
  // "Not required" is the claim, not "never touched": the mod has since gained honest
  // failure reporting for the walker (it used to hold the jump key at a wall for 60s), but
  // no *new* endpoint was needed for P0 - moveto, dig and itemDrops were all already there.
  const server = read('mod-client/src/main/java/dev/agentclient/ControlHttpServer.java');
  for (const verb of ['moveto', 'dig']) {
    if (!server.includes(`"${verb}"`)) throw new Error(`the mod no longer exposes ${verb}`);
  }
  const snapshot = read('mod-client/src/main/java/dev/agentclient/ClientStateSnapshot.java');
  if (!/itemDrops/.test(snapshot)) throw new Error('the mod no longer reports itemDrops');
  return 'moveto + dig + itemDrops all present: no new mod endpoint was needed';
});

check('the P0 exclusions are still exclusions', () => {
  const brain = read('src/brain.js');
  const evaluator = read('src/planner/evaluator.js');
  const capabilities = read('src/core/capabilities.js');
  // Fishing was cancelled; hunting/light/store are capability-gated per body.
  if (exists('src/tasks/fish.js')) throw new Error('FishingTask should not exist (cancelled in P0)');
  // M1b moved the flags into the one capability table; check the whole planner surface.
  const plannerSource = brain + evaluator + capabilities;
  if (!/supportsHunting/.test(plannerSource)) throw new Error('hunting is not capability-gated');
  if (!/supportsDeposit/.test(plannerSource)) throw new Error('storing is not capability-gated');
  return 'no fishing; hunt/store gated on body capability (capabilities table)';
});

check('every config key the plan adds is actually consumed', () => {
  /**
   * The plan is explicit: "新配置项全部必须真的被消费，否则不写进文档".
   *
   * This is not pedantry - `bot.authme` shipped as a fully documented section that no code
   * read, so the agent quietly ran unauthenticated on a server that refuses everything before
   * login. A dead config key is worse than a missing one: it looks like a working switch.
   *
   * `src/util/config.js` is excluded from the search because that is where the keys are
   * *declared*; a key only counts as consumed if something else reads it.
   */
  const skip = path.join(ROOT, 'src', 'util', 'config.js');
  const chunks = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && full !== skip) chunks.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(path.join(ROOT, 'src'));
  const source = chunks.join('\n');

  const agentCfg = JSON.parse(read('config/agent.json'));
  const llmCfg = JSON.parse(read('config/llm.json'));
  const sections = {
    clientMod: ['host', 'port', 'timeoutMs', 'directRange'],
    pathfinding: ['maxPathLength', 'replanEvery', 'nodeTimeoutMs', 'tickTimeoutMs', 'allowSwim', 'allowDig', 'waypointRange', 'stuckThreshold', 'jumpStreakLimit', 'maxSidesteps', 'trace'],
    chat: ['prefix', 'dialogueTrigger', 'pollIntervalMs', 'ignoreOtherChat', 'replyInGame', 'maxChars', 'minReplyGapMs', 'conversationGuard', 'addressedPrefix', 'gateTimeoutMs', 'languageAgent'],
    proactive: ['enabled', 'intervalMs'],
    death: ['detectIntervalMs', 'alertConsole', 'alertPanel', 'alertStateFile'],
    web: ['bind', 'port', 'eventsToken'],
    state: ['enabled', 'path', 'debounceMs'],
    safety: ['avoidManMade', 'requireNaturalTrees', 'requireLeaves', 'strictMining'],
    survival: ['allowWoodChopping'],
    planner: ['mode', 'proposalCooldownMs', 'proposalTtlMs']
  };

  const dead = [];
  const isConsumed = (key) => new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(source);

  for (const [section, keys] of Object.entries(sections)) {
    const block = agentCfg[section] || {};
    for (const key of keys) {
      if (!(key in block)) continue; // not declared in the file: nothing to consume
      if (!isConsumed(key)) dead.push(`${section}.${key}`);
    }
  }
  for (const key of ['enabled', 'baseUrl', 'apiKey', 'model', 'toolCalling']) {
    if (key in llmCfg && !isConsumed(key)) dead.push(`llm.${key}`);
  }

  if (dead.length) throw new Error(`dead config keys: ${dead.join(', ')}`);
  return `${Object.values(sections).flat().length + 5} declared keys, all read by code`;
});

// ------------------------------------------------- P1 additions (RETIREMENT)
if (STAGE === 'p1') {
  process.stdout.write('\nP1 additions (RETIREMENT S0-S4 + M1 wiring)\n');

  check('P1: the planner mode is config-driven and consumed', () => {
    const cfg = JSON.parse(read('config/agent.json'));
    const planner = cfg.planner || {};
    if (!('mode' in planner)) throw new Error('config/agent.json has no planner.mode');
    if (!['legacy', 'proposals', 'off'].includes(planner.mode)) {
      throw new Error(`planner.mode must be legacy|proposals|off, got ${planner.mode}`);
    }
    const brain = read('src/brain.js');
    if (!/plannerCfg\.mode/.test(brain)) throw new Error('brain does not read planner.mode');
    if (!/PlannerCfg\.proposalCooldownMs|proposalCooldownMs/.test(brain)) throw new Error('cooldown is not consumed');
    return `mode=${planner.mode}`;
  });

  check('P1: the evaluator is the rule table and stays declarative', () => {
    const evaluator = read('src/planner/evaluator.js');
    if (!/module\.exports = \{ evaluate/.test(evaluator)) throw new Error('evaluate() is not exported');
    if (/new \w+Task\(/.test(evaluator)) throw new Error('the evaluator constructs tasks (S1 violation)');
    if (!/requiresBody/.test(evaluator)) throw new Error('the body-capability gate is gone');
    return 'evaluate() returns candidates; body gates present';
  });

  check('P1: TaskSlot is the single body owner', () => {
    const brain = read('src/brain.js');
    const hub = read('src/core/taskHub.js');
    if (!/this\.slot = new TaskSlot/.test(brain)) throw new Error('brain does not create the slot');
    if (!/get activeTask\(\)/.test(brain) || !/return this\.slot\.brainTask/.test(brain)) {
      throw new Error('activeTask is not a slot view');
    }
    if (!/slot\.hubHandle/.test(hub)) throw new Error('hub.current is not a slot view');
    if (/this\.current = handle/.test(hub)) throw new Error('hub still keeps a private owner');
    return 'brain + hub read one owner';
  });

  check('P1: planner tasks and hub jobs share one event exit', () => {
    const slot = read('src/core/taskSlot.js');
    const hub = read('src/core/taskHub.js');
    if (!/publish\(event, payload\)/.test(slot)) throw new Error('slot.publish is missing');
    if (!/slot\.publish\(/.test(hub)) throw new Error('hub does not use slot.publish');
    return 'slot.publish is the only exit';
  });

  check('P1: task events have one hub on the panel port', () => {
    const hub = read('src/core/taskEvents.js');
    const slot = read('src/core/taskSlot.js');
    const brain = read('src/brain.js');
    const server = read('src/web/statusServer.js');
    const stream = read('src/web/eventStream.js');
    if (!/class TaskEvents/.test(hub)) throw new Error('TaskEvents is missing');
    if (!/since\(lastSeq/.test(hub)) throw new Error('TaskEvents.since is missing (SSE replay)');
    if (!/new TaskEvents/.test(brain)) throw new Error('brain does not create the event hub');
    if (!/brain\.events\.publish|events\.publish/.test(slot)) throw new Error('slot does not publish to the hub');
    if (!/Last-Event-ID|last-event-id/.test(stream)) throw new Error('SSE replay ignores Last-Event-ID');
    if (!/streamEvents/.test(server) || !/pathname === '\/events'/.test(server)) {
      throw new Error('the /events route is missing from the panel server');
    }
    return 'TaskEvents + /events replay on the same port';
  });

  check('P1: plans have one writer and stale drafts are refused', () => {
    const store = read('src/core/planStore.js');
    const brain = read('src/brain.js');
    if (!/class PlanStore/.test(store)) throw new Error('PlanStore is missing');
    if (!/baseVersion/.test(store)) throw new Error('PlanStore ignores baseVersion');
    if (!/reason: 'stale'/.test(store)) throw new Error('stale drafts are not refused');
    if (!/new PlanStore/.test(brain)) throw new Error('brain does not create the plan store');
    return 'PlanStore increments version and refuses stale drafts';
  });

  check('P1: capabilities have one table and the evaluator reads it', () => {
    const caps = read('src/core/capabilities.js');
    const evaluator = read('src/planner/evaluator.js');
    if (!/function capabilities\(/.test(caps)) throw new Error('capabilities() is missing');
    if (!/supportsCrafting/.test(caps) || !/supportsHunting/.test(caps)) {
      throw new Error('the capability table does not cover the body flags');
    }
    if (!/capabilities\(ctx\)/.test(evaluator)) throw new Error('the evaluator does not use the table');
    return 'one capability table, used by the evaluator';
  });

  check('P1: task results carry the six-state status', () => {
    const task = read('src/tasks/task.js');
    for (const status of ['succeeded', 'partial', 'blocked', 'failed', 'cancelled', 'unknown']) {
      if (!new RegExp(status).test(task)) throw new Error(`result status "${status}" is missing`);
    }
    if (!/status: resultStatus\(base\)/.test(task)) throw new Error('normalizeResult does not set status');
    return 'succeeded/partial/blocked/failed/cancelled/unknown';
  });

  check('P1: parent plan steps run internally, not through TaskHub', () => {
    const runner = read('src/core/planRunner.js');
    const brain = read('src/brain.js');
    if (!/class PlanRunner/.test(runner)) throw new Error('PlanRunner is missing');
    if (/hub\.submit/.test(runner)) throw new Error('plan steps must not be submitted to TaskHub');
    if (!/applyDraft/.test(runner)) throw new Error('PlanRunner does not write step state back to PlanStore');
    if (!/new PlanRunner/.test(brain)) throw new Error('brain does not create the plan runner');
    return 'steps run through the executor; one plan version writer';
  });

  check('P1: a parked turn resumes once from its own task', () => {
    const turns = read('src/core/turnLifecycle.js');
    const brain = read('src/brain.js');
    if (!/class TurnLifecycle/.test(turns)) throw new Error('TurnLifecycle is missing');
    if (!/task-mismatch/.test(turns)) throw new Error('events are not identity-checked');
    if (!/already-resumable/.test(turns)) throw new Error('duplicate events are not dropped');
    if (!/turn-cancelled/.test(turns)) throw new Error('a cancelled turn can still resume');
    if (!/new TurnLifecycle/.test(brain)) throw new Error('brain does not create the turn lifecycle');
    return 'waiting -> resumable -> resume once; cancelled stays cancelled';
  });

  check('P1: the harness adapter is transport-agnostic and replayable', () => {
    const adapter = read('src/harness/adapter.js');
    const brain = read('src/brain.js');
    if (!/class HarnessAdapter/.test(adapter)) throw new Error('HarnessAdapter is missing');
    if (!/taskToTurn/.test(adapter)) throw new Error('task events are not mapped back to a turn');
    if (!/replay\(/.test(adapter)) throw new Error('the adapter has no offline replay entry');
    if (/require\(['"](http|https|net|ws)['"]\)/.test(adapter)) throw new Error('the adapter must not own a transport');
    if (/fetch\(/.test(adapter)) throw new Error('the adapter must not call the network');
    if (!/new HarnessAdapter/.test(brain)) throw new Error('brain does not create the adapter');
    return 'recorded stream -> turn actions; no transport';
  });

  check('P1: the addressed gate is binary and keeps the raw text', () => {
    const gate = read('src/chat/commandGate.js');
    if (!/VERDICTS = new Set\(\['allow', 'deny'\]\)/.test(gate)) throw new Error('gate verdicts are not allow/deny');
    if (!/dispatch: String\(original\)/.test(gate)) throw new Error('the gate does not dispatch the original text');
    if (!/malformed/.test(gate) || !/timeout/.test(gate)) throw new Error('malformed/timeout are not refused');
    return 'allow -> original text; deny/malformed/timeout -> nothing';
  });

  check('P1: the language tool surface has no execution tools', () => {
    const surface = read('src/llm/toolSurface.js');
    if (!/EXECUTION_TOOLS/.test(surface)) throw new Error('execution tools are not named');
    const mod = require(path.join(ROOT, 'src/llm/toolSurface.js'));
    const leaked = mod.SURFACES.language.filter((name) => mod.EXECUTION_TOOLS.includes(name));
    if (leaked.length) throw new Error(`language surface leaks execution tools: ${leaked.join(', ')}`);
    if (!mod.selectSurface([{ name: 'do_task' }, { name: 'say' }], 'language').every((tool) => tool.name === 'say')) {
      throw new Error('selectSurface does not filter execution tools');
    }
    return 'language: state/retrieval/say; execution stays on the action brain';
  });

  check('P1: perception fields carry freshness and stale detection', () => {
    const freshness = read('src/world/freshness.js');
    if (!/stampSnapshot/.test(freshness) || !/staleFields/.test(freshness)) {
      throw new Error('freshness helpers are missing');
    }
    const mod = require(path.join(ROOT, 'src/world/freshness.js'));
    const snapshot = mod.stampSnapshot({ position: {} }, { now: 10 });
    if (mod.fieldAge(snapshot, 'entities', 20) !== Infinity) throw new Error('missing fields must be Infinity old');
    if (mod.fieldAge(snapshot, 'position', 20) !== 10) throw new Error('stamped fields must report their age');
    return 'per-field observedAt + stale schedule';
  });

  check('P1: session state is written atomically and survives corruption', () => {
    const store = read('src/core/stateStore.js');
    if (!/class StateStore/.test(store)) throw new Error('StateStore is missing');
    if (!/renameSync/.test(store)) throw new Error('writes are not atomic');
    if (!/quarantine/.test(store)) throw new Error('a corrupt file is not quarantined');
    if (!/\.corrupt-/.test(store)) throw new Error('the corrupt copy has no distinguishable name');
    return 'temp+rename; corrupt -> .corrupt-<ts>';
  });

  check('P1: M3 has a live plan entry and a harness resume channel', () => {
    const planService = read('src/core/planService.js');
    const turnService = read('src/harness/turnService.js');
    const status = read('src/web/statusServer.js');
    const brain = read('src/brain.js');
    const plugin = read('dsh-plugin-mc-harness/lib/index.js');
    if (!/class PlanService/.test(planService)) throw new Error('PlanService is missing');
    if (!/submit\(|start\(|cancel\(|resume\(/.test(planService)) throw new Error('plan lifecycle is incomplete');
    if (!/validateReplanDraft/.test(planService)) throw new Error('the live entry bypasses the replan guard');
    if (!/class TurnService/.test(turnService)) throw new Error('TurnService is missing');
    if (!/planEvent|planCall/.test(turnService)) throw new Error('turns cannot wait on a plan');
    if (!/'\/plan'|'\/harness\/turn'|'\/harness\/events'/.test(status)) throw new Error('HTTP entry is missing');
    if (!/new PlanService/.test(brain) || !/new TurnService/.test(brain)) throw new Error('brain does not wire M3 services');
    if (!/mc_plan/.test(plugin)) throw new Error('the DSH plugin cannot submit a plan');
    return 'POST /plan -> PlanService -> PlanRunner; turn resume over /harness/events; mc_plan';
  });

  check('P1: restart restores plans/questions but never replays actions', () => {
    const session = read('src/core/sessionState.js');
    const brain = read('src/brain.js');
    if (!/captureState/.test(session) || !/restoreState/.test(session)) throw new Error('session capture/restore is missing');
    if (!/plans/.test(session) || !/proposals/.test(session) || !/events/.test(session)) {
      throw new Error('not all resumable state is captured');
    }
    if (!/planService/.test(session) || !/planService\.restore/.test(session)) {
      throw new Error('plan budgets/service state are not restored');
    }
    if (/runTask|\.execute\(/.test(session)) throw new Error('restore must not execute or replay anything');
    if (!/captureState\(this\)/.test(brain) || !/restoreState\(this, data\)/.test(brain)) {
      throw new Error('brain does not expose capture/restore');
    }
    if (!/planService\.restoreQuestions/.test(brain)) throw new Error('a restored waiting plan does not re-ask its question');
    if (!/P1_STATE/.test(brain)) throw new Error('offline suites cannot disable live persistence');
    const cfg = JSON.parse(read('config/agent.json'));
    if (!cfg.state || cfg.state.enabled !== true) throw new Error('M3 persistence is not enabled for the test window');
    return 'plans + pending questions + budgets + event seq; no action replay; enabled (P1_STATE=off for suites)';
  });

  check('P1: a plan can wait for the player without executing', () => {
    const runner = read('src/core/planRunner.js');
    if (!/wait_for_player/.test(runner)) throw new Error('wait_for_player steps are not supported');
    if (!/'waiting'/.test(runner)) throw new Error('the plan does not park in waiting');
    if (!/async resume\(/.test(runner)) throw new Error('a parked plan cannot be resumed');
    if (!/nothing-waiting/.test(runner)) throw new Error('resume does not refuse when nothing is waiting');
    return 'question step parks; yes continues, no fails; nothing executes unseen';
  });

  check('P1: a task completion wakes the harness turn exactly once', () => {
    const bridge = read('src/harness/resumeBridge.js');
    const adapter = read('src/harness/adapter.js');
    if (!/class ResumeBridge/.test(bridge)) throw new Error('ResumeBridge is missing');
    if (!/onResumable/.test(adapter)) throw new Error('the adapter never signals a resumable turn');
    if (!/adapter\.resume/.test(bridge)) throw new Error('the bridge does not consume the parked event');
    if (!/pending/.test(bridge)) throw new Error('a failed delivery is not retained for retry');
    if (/require\(['"](http|https|net|ws)['"]\)/.test(bridge)) throw new Error('the bridge must not own a transport');
    return 'adapter -> bridge -> deliver -> resume; retry on failure';
  });

  check('P1: methods are ranked by goal, conditions and outcomes', () => {
    const library = read('src/learning/methodLibrary.js');
    const brain = read('src/brain.js');
    if (!/class MethodLibrary/.test(library)) throw new Error('MethodLibrary is missing');
    if (!/search\(/.test(library) || !/recordOutcome/.test(library)) throw new Error('retrieval/outcome tracking is missing');
    if (!/conditions/.test(library)) throw new Error('methods do not carry conditions');
    if (!/new MethodLibrary/.test(brain)) throw new Error('brain does not create the method library');
    return 'goal + conditions + Laplace success ranking';
  });

  check('P1: answers are remembered with conditions and restored', () => {
    const memory = read('src/learning/answerMemory.js');
    const session = read('src/core/sessionState.js');
    if (!/class AnswerMemory/.test(memory)) throw new Error('AnswerMemory is missing');
    if (!/_conditionsCompatible/.test(memory)) throw new Error('answers ignore their conditions');
    if (!/methods/.test(session) || !/answers/.test(session)) throw new Error('methods/answers are not persisted');
    return 'conditional facts; saved with the session';
  });

  check('P1: planning work is budgeted and a new round keeps the total', () => {
    const budget = read('src/planner/budget.js');
    const brain = read('src/brain.js');
    if (!/class Budget/.test(budget)) throw new Error('Budget is missing');
    if (!/DEFAULT_LIMITS/.test(budget)) throw new Error('budgets have no defaults');
    if (!/total/.test(budget)) throw new Error('cumulative consumption is not kept');
    if (!/new Budget/.test(brain)) throw new Error('brain does not create the budget');
    return 'finite searches/replans/retries; reset keeps totals';
  });

  check('P1: steps are verified and done steps cannot be reopened', () => {
    const verifier = read('src/planner/verifier.js');
    const guard = read('src/planner/draftGuard.js');
    if (!/verifyStep/.test(verifier) || !/postcondition/.test(verifier)) throw new Error('step verification is missing');
    if (!/verifyPlan/.test(verifier)) throw new Error('plan verification is missing');
    if (!/reopens-done-step/.test(guard) || !/drops-done-step/.test(guard)) throw new Error('the replay guard does not protect done steps');
    if (!/budget-exhausted/.test(guard)) throw new Error('replans are not budgeted');
    return 'pre/post verification; done steps frozen; replans budgeted';
  });

  check('P1: code-skill promotion needs a passing trial and can be rolled back', () => {
    const store = read('src/codeSkills/store.js');
    const manifest = read('src/codeSkills/manifest.js');
    if (!/class CodeSkillStore/.test(store)) throw new Error('CodeSkillStore is missing');
    if (!/not-trialled/.test(store) || !/quarantined/.test(store)) throw new Error('promotion does not require a trial');
    if (!/rollback\(/.test(store) || !/previous/.test(store)) throw new Error('rollback is missing');
    if (!/retired/.test(store)) throw new Error('retirement is missing');
    if (!/entry-must-not-escape-directory/.test(manifest)) throw new Error('entry traversal is not rejected');
    return 'generated -> trialled -> promoted; rollback/retire; no execution';
  });

  check('P1: the code-skill runner never executes generated code', () => {
    const runner = read('src/codeSkills/runner.js');
    const code = runner.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (!/class RestrictedRunner/.test(code)) throw new Error('RestrictedRunner is missing');
    if (/require\(['"]child_process['"]\)|require\(['"]vm['"]\)|\bimport\s*\(/.test(code)) {
      throw new Error('the runner executes code');
    }
    if (!/executed: false/.test(code)) throw new Error('the contract does not report that nothing ran');
    if (!/getPromoted/.test(code)) throw new Error('the runner bypasses promotion');
    return 'validated dry-run only; no child_process/vm/import';
  });

  check('P1: only promoted code skills reach retrieval', () => {
    const catalog = read('src/codeSkills/catalog.js');
    if (!/listPromoted/.test(catalog) || !/findPromoted/.test(catalog)) throw new Error('promoted catalogue is missing');
    if (!/status !== 'promoted'/.test(catalog)) throw new Error('the catalogue does not filter by promoted status');
    if (/require\(['"].*entry|import\(/.test(catalog)) throw new Error('the catalogue must not load the entry file');
    return 'promoted-only metadata; no import';
  });

  check('P1: computer use is denied until the window limit is verified', () => {
    const policy = read('src/computer/windowPolicy.js');
    if (!/cu-unproven/.test(policy)) throw new Error('unverified CU is not denied');
    if (!/outside-window/.test(policy) || !/outside-bounds/.test(policy)) throw new Error('the window/bounds checks are missing');
    if (!/verify\(/.test(policy) || !/verified/.test(policy)) throw new Error('there is no explicit verification step');
    return 'default deny; verified window + bounds only';
  });

  check('P1: chat replies are deduped, rate-limited and stale-proof', () => {
    const chat = read('src/chat/conversation.js');
    const brain = read('src/brain.js');
    if (!/class ConversationState/.test(chat)) throw new Error('ConversationState is missing');
    if (!/duplicate-reply/.test(chat) || !/too-soon/.test(chat)) throw new Error('reply dedupe/rate limit is missing');
    if (!/stale-request/.test(chat) || !/self-echo/.test(chat)) throw new Error('stale/self-echo protection is missing');
    if (!/new ConversationState/.test(brain)) throw new Error('brain does not create the conversation state');
    return 'duplicate/stale/self-echo/rate-limit; no name filter';
  });

  check('P1: conversation state is persisted with the session', () => {
    const session = read('src/core/sessionState.js');
    if (!/conversation/.test(session)) throw new Error('conversation is not captured');
    if (!/conversation\.restore|brain\.conversation/.test(session)) throw new Error('conversation is not restored');
    return 'seen lines + last reply + active request survive restart';
  });

  check('P1: LLM replies can opt into the conversation guard', () => {
    const reply = read('src/chat/reply.js');
    const llm = read('src/llm/index.js');
    const cfg = JSON.parse(read('config/agent.json'));
    if (!/options\.conversation/.test(reply)) throw new Error('the reply path has no opt-in guard');
    if (!/conversationGuard/.test(llm)) throw new Error('the LLM does not read conversationGuard');
    if (!cfg.chat || cfg.chat.conversationGuard !== false) throw new Error('the guard must default off');
    return 'opt-in conversation guard; default off';
  });

  check('P1: ordinary chat has a live participate/silence entry', () => {
    const participation = read('src/chat/chatParticipation.js');
    const proposalChat = read('src/chat/proposalChat.js');
    const index = read('src/index.js');
    const cfg = JSON.parse(read('config/agent.json'));
    if (!/class ChatParticipation/.test(participation)) throw new Error('ChatParticipation is missing');
    if (!/rememberIncoming/.test(participation) || !/beginRequest/.test(participation)) {
      throw new Error('participation bypasses the conversation request lifecycle');
    }
    if (!/parseParticipation/.test(participation) || !/respond !== true/.test(participation)) {
      throw new Error('silence/malformed output handling is missing');
    }
    if (!/new ChatParticipation/.test(index) || !/ctx\.chatParticipation\.handle/.test(index)) {
      throw new Error('ordinary chat is not wired to the participation service');
    }
    if (!/class ProposalChat/.test(proposalChat) || !/new ProposalChat/.test(index)) {
      throw new Error('pending proposals have no chat answer path');
    }
    if (!cfg.chat || cfg.chat.participate !== false || cfg.chat.proposalChat !== false) {
      throw new Error('M6 chat wiring must stay opt-in until the client window');
    }
    return 'ordinary chat -> model decision -> ConversationState -> reply(); proposal yes/no';
  });

  check('P1: M7 persists the failure ledger and records per-request usage', () => {
    const slot = read('src/core/taskSlot.js');
    const session = read('src/core/sessionState.js');
    const ledger = read('src/llm/usageLedger.js');
    const client = read('src/llm/client.js');
    const llm = read('src/llm/index.js');
    const index = read('src/index.js');
    if (!/toJSON\(\)/.test(slot) || !/restore\(data\)/.test(slot)) throw new Error('TaskSlot ledger has no persistence');
    if (!/failCounts/.test(slot) || !/quarantine/.test(slot) || !/blockedGoal/.test(slot)) {
      throw new Error('the failure ledger is incomplete');
    }
    if (!/taskSlot/.test(session)) throw new Error('sessionState does not carry the slot ledger');
    if (!/missing-usage/.test(ledger)) throw new Error('missing usage is not distinguished from zero');
    if (!/usageContext/.test(client) || !/usageContext/.test(llm)) throw new Error('model requests are not attributable');
    if (!/new UsageLedger/.test(index) || !/usageLedger/.test(index)) throw new Error('the live process does not create the usage ledger');
    return 'strikes/quarantine/blockedGoal persisted; usage JSONL ok|missing-usage|error';
  });

  check('P1: M4 generation/trial is wired to a real permissioned sandbox', () => {
    const manifest = read('src/codeSkills/manifest.js');
    const runner = read('src/codeSkills/sandboxRunner.js');
    const worker = read('src/codeSkills/sandboxWorker.js');
    const service = read('src/codeSkills/service.js');
    const generation = read('src/codeSkills/generation.js');
    const search = read('src/llm/knowledge/webSearch.js');
    const index = read('src/index.js');
    const server = read('src/web/statusServer.js');
    const cfg = JSON.parse(read('config/agent.json'));
    if (!/search/.test(manifest) || !/generate/.test(manifest) || !/subprocess/.test(manifest)) {
      throw new Error('the authorized M4 permission set is not in the manifest allowlist');
    }
    if (!/--permission/.test(runner) || !/--allow-fs-read/.test(runner) || !/spawn\(/.test(runner)) {
      throw new Error('the sandbox is not a permissioned child process');
    }
    if (!/vm\.createContext/.test(worker) || !/sandbox-denied-module/.test(worker)) {
      throw new Error('the worker does not evaluate code in the guarded vm context');
    }
    if (!/read_state/.test(service) || !/submit_task/.test(service) || !/evidence/.test(service)) {
      throw new Error('the capability broker/evidence is incomplete');
    }
    if (!/v1\/tools\/search/.test(search)) throw new Error('DeepSeek Search is not wired');
    const plugin = read('dsh-plugin-mc-harness/lib/index.js');
    if (!/lookup_mod_content/.test(plugin)) {
      throw new Error('the behavior-brain lookup_mod_content tool is missing');
    }
    if (/ctx\.search\s*=/.test(index)) {
      throw new Error('ctx.search exposes web lookup to the language brain');
    }
    if (!/\/lookup_mod_content/.test(server)) {
      throw new Error('the Node /lookup_mod_content broker endpoint is missing');
    }
    const chatMemory = read('src/memory/chatMemory.js');
    for (const needle of ['saveTurn', 'grep(', 'context(', 'compact(']) {
      if (!new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(chatMemory)) {
        throw new Error(`ChatMemory is missing ${needle}`);
      }
    }
    if (!/mc_memory/.test(plugin) || !/\/memory/.test(server)) {
      throw new Error('task/plan memory tool or Node /memory endpoint is missing');
    }
    if (!/ctx\.chatMemory/.test(index)) throw new Error('chat memory is not attached to the live context');
    if (!/new CodeSkillService/.test(index) || !/ctx\.codeSkills/.test(index)) {
      throw new Error('the live agent does not instantiate the code-skill service');
    }
    if (!/\/code-skills\/generate/.test(server) || !/\/code-skills\/cancel/.test(server)) {
      throw new Error('the code-skill HTTP entry points are missing');
    }
    const codeCfg = (cfg.agent && cfg.agent.codeSkills) || cfg.codeSkills;
    if (!codeCfg || codeCfg.enabled !== true) {
      throw new Error('M4 live wiring must be explicitly enabled in config');
    }
    return 'generate -> candidate -> permissioned child -> evidence -> promote/rollback';
  });

  check('P1: fault drills keep one owner and never replay', () => {
    if (!exists('scripts/p1-fault-test.js')) throw new Error('the fault drill suite is missing');
    const drills = read('scripts/p1-fault-test.js');
    for (const needle of ['timeout', 'preempt', 'takeover', 'restart']) {
      if (!new RegExp(needle).test(drills)) throw new Error(`fault drill "${needle}" is missing`);
    }
    return 'timeout/cancel/throw/preempt/takeover/restart drills';
  });

  check('P1: addressed instructions pass a binary gate before dispatch', () => {
    const gate = read('src/chat/commandGate.js');
    const handler = read('src/chat/addressedHandler.js');
    if (!/class CommandGate/.test(gate)) throw new Error('CommandGate is missing');
    if (!/dispatch: String\(original\)/.test(gate)) throw new Error('the original text is not preserved');
    if (!/judge-error|timeout/.test(gate)) throw new Error('errors/timeouts are not refused');
    if (!/class AddressedHandler/.test(handler)) throw new Error('AddressedHandler is missing');
    if (!/verdict\.dispatch/.test(handler)) throw new Error('the handler does not dispatch the approved text');
    return 'allow -> original; deny/error/timeout -> nothing';
  });

  check('P1: the addressed channel is wired but off by default', () => {
    const listener = read('src/chat/chatListener.js');
    const index = read('src/index.js');
    const cfg = JSON.parse(read('config/agent.json'));
    if (!/addressedPrefix/.test(listener) || !/onAddressed/.test(listener)) throw new Error('the listener has no addressed channel');
    if (!/onAddressed/.test(index) || !/AddressedHandler/.test(index)) throw new Error('the addressed handler is not wired');
    if (!cfg.chat || cfg.chat.addressedPrefix !== null) throw new Error('the addressed channel must default off');
    return 'channel plumbed; judge injected; default off';
  });

  check('P1: the instruction judge is strict and cannot rewrite the text', () => {
    const judge = read('src/llm/judge.js');
    if (!/class InstructionJudge/.test(judge) || !/parseVerdict/.test(judge)) throw new Error('InstructionJudge is missing');
    if (!/malformed-verdict/.test(judge)) throw new Error('malformed verdicts are accepted');
    if (!/return \{ verdict: data\.verdict \}/.test(judge)) throw new Error('the judge returns more than the verdict');
    if (/require\(['"](http|https|net|ws)['"]\)/.test(judge)) throw new Error('the judge owns a transport');
    return 'allow/deny only; rewrite fields dropped; injected completion';
  });

  check('P1: the LLM exposes a dedicated binary judge for the addressed channel', () => {
    const llm = read('src/llm/index.js');
    const index = read('src/index.js');
    if (!/async judgeInstruction/.test(llm)) throw new Error('LlmCore has no judgeInstruction()');
    if (!/maxTokens: 200/.test(llm)) throw new Error('the judge budget is not tiny');
    if (!/judgeInstruction/.test(index)) throw new Error('the addressed channel does not use the LLM judge');
    return 'low-level call, no tools, wired to the gate';
  });

  check('P1: the tool registry can expose two disjoint surfaces', () => {
    const registry = read('src/llm/tools/registry.js');
    if (!/toOpenAiTools\(ctx, brain = null\)/.test(registry)) throw new Error('the registry has no brain filter');
    if (!/SURFACES\[brain\]/.test(registry)) throw new Error('the filter does not read the surface table');
    const { SURFACES, EXECUTION_TOOLS } = require(path.join(ROOT, 'src/llm/toolSurface.js'));
    if (SURFACES.language.some((name) => EXECUTION_TOOLS.includes(name))) {
      throw new Error('the language surface contains an execution tool');
    }
    return 'default all tools; language/action filtered by one table';
  });

  check('P1: the LLM can be constructed for one brain surface', () => {
    const llm = read('src/llm/index.js');
    if (!/this\.brain = options\.brain \|\| null/.test(llm)) throw new Error('LlmCore has no brain option');
    if (!/toOpenAiTools\(this\.ctx, this\.brain\)/.test(llm)) throw new Error('the brain is not passed to the registry');
    return 'brain=null keeps P0 all-tools; language/action are opt-in';
  });

  check('P1: plan questions reuse the proposal desk', () => {
    const bridge = read('src/planner/planQuestions.js');
    const brain = read('src/brain.js');
    if (!/class PlanQuestionBridge/.test(bridge)) throw new Error('PlanQuestionBridge is missing');
    if (!/proposals\.propose/.test(bridge)) throw new Error('plan questions do not use the proposal desk');
    if (!/plan:/.test(bridge) || !/plan_question/.test(bridge)) throw new Error('the proposal is not identifiable');
    if (!/new PlanQuestionBridge/.test(brain)) throw new Error('brain does not create the bridge');
    return 'one question lifecycle: ProposalDesk';
  });

  check('P1: answering a plan question resumes the plan', () => {
    const brain = read('src/brain.js');
    if (!/_answerPlan/.test(brain) || !/planService\.resume/.test(brain)) {
      throw new Error('accept does not resume the plan through PlanService');
    }
    if (!/_answerPlan\(planQuestion\.planId, false/.test(brain)) {
      throw new Error('reject does not fail the waiting step');
    }
    if (!/async runPlan/.test(brain)) throw new Error('brain has no runPlan entry');
    return 'accept -> PlanService.resume(true); reject -> resume(false)';
  });

  check('P1: generated code is statically scanned and never executed', () => {
    const generator = read('src/codeSkills/generator.js');
    const code = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (!/class CodeSkillGenerator/.test(code)) throw new Error('CodeSkillGenerator is missing');
    if (!/scanCode/.test(code) || !/require-not-allowed/.test(code) || !/unbounded-loop-suspected/.test(code)) {
      throw new Error('the static scan is incomplete');
    }
    if (/require\(['"]child_process['"]\)|require\(['"]vm['"]\)|\beval\s*\(|\bnew\s+Function/.test(code)) {
      throw new Error('the generator executes or compiles generated code');
    }
    return 'static scan only: require/import/eval/Function/network/loops';
  });

  check('P1: a generated proposal only becomes a candidate', () => {
    const generator = read('src/codeSkills/generator.js');
    if (!/register\(store, proposal/.test(generator)) throw new Error('there is no registration helper');
    if (!/addCandidate/.test(generator)) throw new Error('registration does not go through the store');
    if (/promote\(/.test(generator)) throw new Error('generation can promote without a trial');
    return 'generator -> candidate; promotion stays a separate gate';
  });

  check('P1: say/silence are language-only tools', () => {
    const registry = require(path.join(ROOT, 'src/llm/tools/registry.js'));
    const names = registry.LANGUAGE_ONLY_TOOLS.map((tool) => tool.name);
    if (!names.includes('say') || !names.includes('silence')) throw new Error('say/silence are missing');
    if (registry.toolNames().includes('say')) throw new Error('say leaked into the P0 tool list');
    if (registry.has('say')) throw new Error('say must not be callable on the default surface');
    if (!registry.has('say', { brain: 'language' })) throw new Error('the language surface cannot call say');
    const language = registry
      .toOpenAiTools(null, 'language')
      .map((tool) => tool.function.name);
    if (!language.includes('say') || !language.includes('silence')) {
      throw new Error('the language surface does not expose say/silence');
    }
    return 'language-only; P0 tool list still 8';
  });

  check('P1: the language agent can only read or speak', () => {
    const agent = read('src/llm/languageAgent.js');
    if (!/class LanguageAgent/.test(agent)) throw new Error('LanguageAgent is missing');
    if (!/SURFACES\.language\.includes/.test(agent)) throw new Error('tool names are not checked against the language surface');
    if (!/not-language-tool/.test(agent)) throw new Error('execution tools are not refused');
    const codeOnly = agent.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (/\b(do_task|do_skill|go_to|stop)\b/.test(codeOnly)) {
      throw new Error('the language agent references an execution tool');
    }
    if (!/registry\.call/.test(agent)) throw new Error('the agent does not use the tool registry');
    return 'language surface only; execution refused before any call';
  });

  check('P1: language dialogue falls back only on an outage', () => {
    const dialogue = read('src/chat/languageDialogue.js');
    if (!/class LanguageDialogue/.test(dialogue)) throw new Error('LanguageDialogue is missing');
    if (!/availabilityFailure = reason === 'model-error' \|\| reason === 'no-model' \|\| reason === 'agent-error'/.test(dialogue)) {
      throw new Error('the fallback condition is not limited to availability failures');
    }
    if (!/!availabilityFailure/.test(dialogue)) throw new Error('non-availability results are not kept out of the fallback path');
    return 'silence/refusal stay; only model-error/no-model/agent-error fall back';
  });

  check('P1: the language dialogue channel is opt-in', () => {
    const index = read('src/index.js');
    const cfg = JSON.parse(read('config/agent.json'));
    if (!cfg.chat || cfg.chat.languageAgent !== false) throw new Error('the language dialogue must default off');
    if (!/chatCfg\.languageAgent/.test(index)) throw new Error('the config switch is not read');
    if (!/new LanguageDialogue/.test(index)) throw new Error('the dialogue wrapper is not wired');
    return 'default off; wired when enabled';
  });

  check('P1: one offline verification command covers the P1 suites', () => {
    if (!exists('scripts/p1-verify.js')) throw new Error('p1-verify is missing');
    const verifier = read('scripts/p1-verify.js');
    for (const needle of ['p0-verify.js', 'planner-retirement-test.js', 'p1-contract-test.js', 'p1-fault-test.js', '--stage', "'p1'"]) {
      if (!verifier.includes(needle)) throw new Error(`p1-verify does not cover ${needle}`);
    }
    const pkg = JSON.parse(read('package.json'));
    if (!pkg.scripts || !pkg.scripts['p1:verify']) throw new Error('package.json has no p1:verify script');
    return 'planner + contract + fault + audit p1 + P0 regression';
  });

  check('P1: an expired plan question stops the plan', () => {
    const brain = read('src/brain.js');
    const proposals = read('src/planner/proposals.js');
    if (!/proposal:expired/.test(brain)) throw new Error('expiry is not observed');
    if (!/planRunner\.resume\(proposal\.planId, false\)/.test(brain)) {
      throw new Error('an expired question does not fail the waiting step');
    }
    if (!/type: candidate\.type/.test(proposals)) throw new Error('proposal events do not carry their type');
    return 'no answer -> step failed, plan stops; never stays parked';
  });

  check('P1: persistence has an operator surface', () => {
    const commands = read('src/chat/commands.js');
    if (!/state: async/.test(commands)) throw new Error('!state is missing');
    if (!/!state status\|save/.test(commands)) throw new Error('!state is not documented in help');
    if (!/state-disabled/.test(commands)) throw new Error('the command can pretend persistence is enabled');
    if (!/saveStateNow/.test(commands)) throw new Error('the command does not trigger a save');
    return '!state status|save; cannot enable persistence';
  });

  check('P1: plan steps verify their postconditions', () => {
    const runner = read('src/core/planRunner.js');
    const brain = read('src/brain.js');
    if (!/typeof this\.verify === 'function'/.test(runner)) throw new Error('the runner never verifies');
    if (!/postcondition:/.test(runner)) throw new Error('a failed postcondition is not reported');
    if (!/finalStatus = 'failed'/.test(runner)) throw new Error('a failed postcondition does not stop the plan');
    if (!/verify: \(step, observation\) => verifyStep/.test(brain)) throw new Error('brain does not inject the verifier');
    return 'task ok + postcondition fail -> step failed, plan stops';
  });

  check('P1: the client body reports per-field freshness', () => {
    const body = read('src/body/clientModBody.js');
    if (!/stampSnapshot/.test(body)) throw new Error('the body never stamps its snapshot');
    if (!/this\._snapshotAt \|\| Date\.now\(\)/.test(body)) throw new Error('the stamp is not tied to the refresh time');
    if (!/OBSERVED_FIELDS/.test(body)) throw new Error('the observed field list is missing');
    return 'observedAt comes from the last refresh, not from the read';
  });

  check('P1: request identity reaches tasks and hub events', () => {
    const brain = read('src/brain.js');
    const hub = read('src/core/taskHub.js');
    if (!/options\.requestId && !task\.requestId/.test(brain)) throw new Error('enqueue ignores requestId');
    if (!/task\.requestId = result\.proposal\.id/.test(brain)) throw new Error('accepted proposals are not a request');
    if (!/requestId: job\.requestId \|\| null/.test(hub)) throw new Error('hub jobs cannot carry a requestId');
    if (!/requestId: handle\.requestId \|\| null/.test(hub)) throw new Error('hub events do not carry the requestId');
    return 'proposal -> task -> hub event provenance';
  });

  check('P1: candidates and promoted skills live in separate directories', () => {
    const directory = read('src/codeSkills/directory.js');
    if (!/candidatesRoot/.test(directory) || !/promotedRoot/.test(directory)) {
      throw new Error('the candidate/promoted split is missing');
    }
    if (!/writeFileAtomic/.test(directory) || !/renameSync/.test(directory)) {
      throw new Error('writes are not atomic');
    }
    if (/require\(['"](child_process|vm)['"]\)/.test(directory)) throw new Error('the directory executes code');
    return 'candidates/ vs promoted/; temp+rename';
  });

  check('P1: promotion has a versioned pointer with rollback and retire', () => {
    const directory = read('src/codeSkills/directory.js');
    if (!/current\.json/.test(directory)) throw new Error('there is no current pointer');
    if (!/previous/.test(directory)) throw new Error('the pointer does not remember the previous version');
    if (!/rollback\(/.test(directory) || !/retire\(/.test(directory)) throw new Error('rollback/retire missing');
    if (!/entry-escapes-directory|entry-must-be-relative/.test(directory)) throw new Error('entry paths are not contained');
    return 'current.json {version, previous}; rollback/retire; containment';
  });

  check('P1: the language agent receives the persona text', () => {
    const index = read('src/index.js');
    const agent = read('src/llm/languageAgent.js');
    if (!/persona\.body/.test(index)) throw new Error('the dialogue channel only passes the persona name');
    if (!/Persona: \$\{persona\}/.test(agent)) throw new Error('the prompt does not carry the persona');
    if (!/must not plan or execute/.test(agent)) throw new Error('the execution boundary is not in the prompt');
    return 'name + style text; boundary still stated';
  });

  check('P1: the refresh plan is pure and budgeted', () => {
    const refresh = read('src/world/refreshPlan.js');
    if (!/planRefresh/.test(refresh) || !/staleFields/.test(refresh)) throw new Error('the refresh plan is missing');
    if (!/maxFields/.test(refresh) || !/criticalStale/.test(refresh)) throw new Error('budgets/critical fields are missing');
    if (/require\(['"](fs|http|https|net|child_process)['"]\)/.test(refresh)) throw new Error('the plan performs I/O');
    return 'staleFields + budget + critical, no I/O';
  });

  check('P1: plan outcomes feed the method library', () => {
    const runner = read('src/core/planRunner.js');
    const brain = read('src/brain.js');
    if (!/step\.methodId/.test(runner)) throw new Error('plan steps cannot name a method');
    if (!/recordMethod/.test(runner)) throw new Error('the runner never records an outcome');
    if (!/recordMethod: \(step, ok\) => this\.methods\.recordOutcome/.test(brain)) {
      throw new Error('brain does not connect the runner to MethodLibrary');
    }
    return 'step.methodId -> success/failure evidence, not self-report';
  });

  check('P1: local knowledge has a read-only retrieval entry', () => {
    const brain = read('src/brain.js');
    const commands = read('src/chat/commands.js');
    if (!/suggestMethod\(goal, context/.test(brain)) throw new Error('suggestMethod is missing');
    if (!/methods\.search/.test(brain) || !/answers\.recall/.test(brain)) {
      throw new Error('retrieval does not read both stores');
    }
    if (!/method: \(args\)/.test(commands) || !/!method <goal>/.test(commands)) throw new Error('!method is missing');
    if (!/suggestMethod\(goal/.test(commands)) throw new Error('!method does not use the retrieval entry');
    return 'method + answer; read-only; command surface';
  });

  check('P1: threats are observed by edges, not on every poll', () => {
    const observer = read('src/world/threatObserver.js');
    if (!/class ThreatObserver/.test(observer)) throw new Error('ThreatObserver is missing');
    if (!/threat:enter/.test(observer) || !/threat:leave/.test(observer)) throw new Error('enter/leave edges are missing');
    if (!/subscribe\(/.test(observer) || !/active\.has\(key\)/.test(observer)) throw new Error('dedupe/unsubscribe is missing');
    if (/runTask|\.submit\(|ctx\.reply/.test(observer)) throw new Error('the observer acts instead of reporting');
    return 'enter/leave once; re-enter after leave; no action';
  });

  check('P1: memory is classified and searchable', () => {
    const store = read('src/memory/store.js');
    const brain = read('src/brain.js');
    if (!/class MemoryStore/.test(store)) throw new Error('MemoryStore is missing');
    for (const category of ['episodic', 'semantic', 'relational']) {
      if (!new RegExp(category).test(store)) throw new Error(`category ${category} is missing`);
    }
    if (!/recall\(/.test(store) || !/tags/.test(store)) throw new Error('retrieval/tags are missing');
    if (!/new MemoryStore/.test(brain)) throw new Error('brain does not create the classified store');
    return 'three categories; lexical+tag recall; bounded';
  });

  check('P1: classified memory is persisted with the session', () => {
    const session = read('src/core/sessionState.js');
    if (!/memoryStore/.test(session)) throw new Error('memoryStore is not captured');
    if (!/memoryStore\.restore|brain\.memoryStore/.test(session)) throw new Error('memoryStore is not restored');
    return 'episodic/semantic/relational survive restart';
  });

  check('P1: classified memory is read without acting', () => {
    const brain = read('src/brain.js');
    const agent = read('src/llm/languageAgent.js');
    const index = read('src/index.js');
    if (!/memoryStore\.recall/.test(brain)) throw new Error('suggestMethod ignores classified memory');
    if (!/memoryFor/.test(agent) || !/Relevant memory/.test(agent)) throw new Error('the language prompt ignores memory');
    if (!/memoryFor:/.test(index)) throw new Error('the dialogue channel does not inject memory');
    return 'retrieval + language context; never executes';
  });

  check('P1: CU policy is enforced before any executor runs', () => {
    const guard = read('src/computer/guard.js');
    if (!/class ComputerUseGuard/.test(guard)) throw new Error('ComputerUseGuard is missing');
    if (!/policy\.check\(action\)/.test(guard)) throw new Error('the guard does not consult the policy first');
    if (!/executed: false/.test(guard) || !/no-executor/.test(guard)) {
      throw new Error('refusals can still report as executed');
    }
    if (!/executed: true/.test(guard)) throw new Error('attempted executor calls are not distinguished');
    return 'policy first; refused actions never reach the executor';
  });

  check('P1: mining only walks to exposed targets and probes below the feet', () => {
    const mine = read('src/tasks/mineBlock.js');
    if (!/hasExposedTarget/.test(mine) || !/isExposed/.test(mine)) throw new Error('buried targets are still treated as walkable');
    if (!/Math\.floor\(here\.y\) - 1/.test(mine)) throw new Error('the shaft still digs the feet cell');
    if (!/digging without walking/.test(mine)) throw new Error('the within-reach fallback is missing');
    return 'exposed-only targets; shaft digs y-1; reachable fallback';
  });

  check('P1: live tests sleep at night or stop', () => {
    const real = read('scripts/client-real.js');
    if (!/ensureDaytime/.test(real)) throw new Error('live tests have no night gate');
    if (!/findBedNear/.test(real)) throw new Error('the night gate never looks for a bed');
    if (!/useOn\(bed\.position/.test(real)) throw new Error('the night gate never uses the bed');
    if (!/stopping instead of playing through the night/.test(real)) throw new Error('no-bed must stop, not continue');
    return 'day check -> bed -> sleep -> re-check; no bed = stop';
  });

  check('P1: day/night trusts the client isDay when present', () => {
    const daytime = read('src/world/daytime.js');
    const farm = read('src/skills/farming.js');
    const live = read('scripts/client-real.js');
    if (!/typeof time\.isDay === 'boolean'/.test(daytime)) throw new Error('isDay is not consulted');
    if (!/typeof time\.isDay === 'boolean'/.test(farm) && !/require\('\.\.\/world\/daytime'\)/.test(farm)) {
      throw new Error('the sleep skill does not use the shared daytime rule');
    }
    if (!/require\('\.\.\/src\/world\/daytime'\)/.test(live)) throw new Error('live tests do not use the shared daytime rule');
    return 'isDay first; timeOfDay fallback; one shared rule';
  });

  check('P1: night bed search is bounded to 60x10x60', () => {
    const beds = read('src/world/beds.js');
    const farm = read('src/skills/farming.js');
    const live = read('scripts/client-real.js');
    if (!/halfX: 30/.test(beds) || !/halfY: 5/.test(beds) || !/halfZ: 30/.test(beds)) {
      throw new Error('the 60x10x60 box is not encoded');
    }
    if (!/findBedNear/.test(farm) || !/findBedNear/.test(live)) throw new Error('callers do not use the bounded search');
    if (!/no bed within 60x10x60/.test(farm) && !/no bed within 60x10x60/.test(live)) {
      throw new Error('the no-bed case is not reported');
    }
    return '+-30 x, +-5 y, +-30 z; nearest inside; stop when none';
  });

  check('P1: proposals are wired with an offline answer surface', () => {
    const brain = read('src/brain.js');
    const commands = read('src/chat/commands.js');
    if (!/new ProposalDesk/.test(brain)) throw new Error('brain does not create the ProposalDesk');
    if (!/proposal: async/.test(commands)) throw new Error('!proposal is missing');
    if (!/acceptProposal/.test(commands)) throw new Error('!proposal does not accept');
    if (!/rejectProposal/.test(commands)) throw new Error('!proposal does not reject');
    return 'ProposalDesk + !proposal accept/reject';
  });
}

// ------------------------------------------------------------------- summary
const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${'='.repeat(64)}\n`);
process.stdout.write(`plan audit: ${results.length - failed.length}/${results.length} checks passed\n`);
if (failed.length) {
  for (const f of failed) process.stdout.write(`  FAILED: ${f.name} - ${f.detail}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`the implementation still matches docs/P0-PLAN.md §11 (stage ${STAGE})\n`);
}
