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
    chat: ['prefix', 'dialogueTrigger', 'pollIntervalMs', 'ignoreOtherChat', 'replyInGame', 'maxChars', 'minReplyGapMs'],
    proactive: ['enabled', 'intervalMs'],
    death: ['detectIntervalMs', 'alertConsole', 'alertPanel', 'alertStateFile'],
    web: ['bind', 'port', 'eventsToken'],
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
