'use strict';

/**
 * M4 v3 contracts (2026-10-29): four-tuple manifests, the Voyager-style repair loop with
 * verbatim error feedback, versioned evolution, and similarity retrieval.
 *
 *   node scripts/p1-m4-evolve-test.js
 *
 * No model, no live client, no real sandbox: the generation backend and sandbox are fakes,
 * while the store/directory/service are the real objects, so the state machine (versions,
 * lineage, quarantine, promotion) is exercised for real.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validateManifest } = require('../src/codeSkills/manifest');
const { CodeSkillService } = require('../src/codeSkills/service');
const { SkillIndex, LocalEmbedder, buildSkillQuery, tokenize } = require('../src/codeSkills/retrieval');
const { resolveChannel } = require('../src/core/channelPolicy');

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const results = [];

function check(name, fn) {
  try {
    const outcome = fn();
    if (outcome && typeof outcome.then === 'function') {
      return outcome.then(
        () => {
          results.push({ name, ok: true });
          process.stdout.write(`  PASS  ${name}\n`);
        },
        (err) => {
          results.push({ name, ok: false, detail: err.message });
          process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
        }
      );
    }
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    process.stdout.write(`  FAIL  ${name} - ${err.message}\n`);
  }
  return Promise.resolve();
}

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function v3Manifest(name, extra = {}) {
  return {
    name,
    version: '1.0.0',
    apiVersion: 3,
    entry: 'index.js',
    title: name,
    description: '用 tap 键打开玩家背包，读取菜单后关闭；用于验证 GUI 键鼠链路。',
    preconditions: {},
    verification: { inventoryAtLeast: { 'minecraft:dirt': 0 } },
    permissions: ['read_state', 'input_tap', 'input_menu', 'input_close', 'wait'],
    ...extra
  };
}

/** Observation the verifier sees (flat, block scan under `cells` like the real mod). */
function makeContext(options = {}) {
  const calls = [];
  const snapshot = () => ({
    ready: true,
    position: options.position || { x: 0, y: 64, z: 0 },
    dimension: 'minecraft:overworld',
    inventory: options.inventory || {},
    target: options.target || null,
    screen: options.screen || null,
    screenOpen: Boolean(options.screen),
    blocks: { cells: options.blocks || {} },
    hostiles: [],
    time: { timeOfDay: 1000 }
  });
  const slot = {
    current: null,
    acquire(owner) {
      if (this.current) return { ok: false, current: this.current };
      this.current = owner;
      return { ok: true, owner };
    },
    release() {
      this.current = null;
    }
  };
  const body = {
    snapshot,
    menu: async () => ({ open: true, size: 46, slots: [] }),
    clickSlot: async (slotNumber) => {
      calls.push({ m: 'clickSlot', slot: slotNumber });
      return true;
    },
    tap: async (action) => {
      calls.push({ m: 'tap', action });
      return { ok: true, action };
    },
    key: async (action, down) => {
      calls.push({ m: 'key', action, down });
      return { ok: true, blockedByScreen: false };
    },
    closeMenu: async () => {
      calls.push({ m: 'close' });
      return true;
    },
    equip: async (item) => {
      calls.push({ m: 'equip', item });
      return true;
    },
    useOn: async (position) => {
      calls.push({ m: 'useOn', position });
      return true;
    },
    look: async (yaw, pitch) => {
      calls.push({ m: 'look', yaw, pitch });
      return true;
    },
    lookAt: async (position) => {
      calls.push({ m: 'lookAt', position });
      return true;
    },
    targetBlock: async () => ({ name: 'minecraft:grass_block' }),
    inputState: async () => ({ held: [], count: 0 }),
    interrupt() {}
  };
  const ctx = {
    body,
    slot,
    world: { snapshot },
    reply: async () => true
  };
  return { ctx, body, slot, calls, snapshot };
}

/** Deterministic sandbox: the run result is derived from the generated code text. */
function makeSandbox() {
  const runs = [];
  return {
    runs,
    async run(request) {
      runs.push({ name: request.name, version: request.version, code: request.code });
      const code = String(request.code || '');
      if (code.includes('nope')) {
        return {
          ok: false,
          executed: true,
          runId: `run-${runs.length}`,
          reason: 'ReferenceError: nope is not defined',
          stack: 'ReferenceError: nope is not defined\n    at run (index.js:3:5)\n    at async main (index.js:9:1)',
          calls: [{ capability: 'key', ok: false, error: 'permission-not-allowed:input_key', argsBytes: 12 }],
          logs: [{ stream: 'stderr', text: 'stderr: ReferenceError: nope is not defined\n' }]
        };
      }
      if (code.includes('refused')) {
        return { ok: false, executed: true, runId: `run-${runs.length}`, reason: 'skill-failed', result: { ok: false, reason: 'refused' }, calls: [], logs: [] };
      }
      if (code.includes('tap-inventory')) {
        return { ok: true, executed: true, runId: `run-${runs.length}`, reason: 'completed', result: { ok: true, steps: ['tap', 'menu', 'close'] }, calls: [], logs: [] };
      }
      return { ok: true, executed: true, runId: `run-${runs.length}`, reason: 'completed', result: { ok: true }, calls: [], logs: [] };
    }
  };
}

function makeService(temps, options = {}) {
  const { ctx, calls } = makeContext(options.context || {});
  const sandbox = options.sandbox || makeSandbox();
  const service = new CodeSkillService({
    root: path.join(temps.skills, `svc-${Math.random().toString(36).slice(2, 8)}`),
    sandboxRoot: path.join(temps.sandbox, 'runs'),
    evidenceDir: path.join(temps.evidence, 'evidence'),
    ctx,
    sandbox,
    retrieval: { k: 3, minScore: 0.18, embedding: { provider: 'local', dim: 512 } },
    log: silent
  });
  return { service, sandbox, ctx, calls };
}

function fakeGeneration(script) {
  const calls = [];
  return {
    calls,
    async generate({ prompt, manifest, requestId, feedback }) {
      calls.push({ prompt, manifest, requestId, feedback });
      const next = script(calls.length, feedback);
      return next;
    }
  };
}

(async () => {
  process.stdout.write('P1 M4 v3 (repair loop + versions + retrieval)\n\n');

  process.stdout.write('1. four-tuple manifest\n');
  await check('v3 requires description, preconditions and non-empty verification', () => {
    const ok = validateManifest(v3Manifest('agent.tap'));
    assert(ok.ok, JSON.stringify(ok.errors));
    const noDescription = validateManifest({ ...v3Manifest('agent.tap'), description: undefined });
    assert(noDescription.errors.includes('description-required'));
    const shortDescription = validateManifest({ ...v3Manifest('agent.tap'), description: '太短' });
    assert(shortDescription.errors.some((error) => error.startsWith('description-too-short')));
    const noPre = validateManifest({ ...v3Manifest('agent.tap'), preconditions: undefined });
    assert(noPre.errors.includes('preconditions-required'));
    const emptyVerification = validateManifest({ ...v3Manifest('agent.tap'), verification: {} });
    assert(emptyVerification.errors.includes('verification-must-not-be-empty'));
    const badCondition = validateManifest({ ...v3Manifest('agent.tap'), verification: { flyTo: { y: 200 } } });
    assert(badCondition.errors.some((error) => error.startsWith('verification-unsupported-condition')));
    const badShape = validateManifest({ ...v3Manifest('agent.tap'), verification: { positionNear: { position: { x: 1 } } } });
    assert(badShape.errors.some((error) => error.startsWith('verification-invalid')));
  });

  await check('v3 rejects body primitives; v2 still accepts them (legacy runtime)', () => {
    const v3Body = validateManifest({ ...v3Manifest('agent.tap'), permissions: ['read_state', 'body_dig'] });
    assert(v3Body.errors.includes('permission-requires-api:body_dig'));
    const v2 = validateManifest({
      name: 'agent.old',
      version: '1.0.0',
      apiVersion: 2,
      entry: 'index.js',
      permissions: ['read_state', 'body_move', 'body_dig']
    });
    assert(v2.ok, JSON.stringify(v2.errors));
  });

  process.stdout.write('\n2. repair loop: verbatim feedback, <=4 rounds, new version per round\n');
  await check('a failing trial feeds its stack/calls/stderr back and the next version repairs', async () => {
    const temps = { skills: tempRoot('m4v3-skills-'), sandbox: tempRoot('m4v3-sandbox-'), evidence: tempRoot('m4v3-evidence-') };
    const { service, sandbox } = makeService(temps);
    const generation = fakeGeneration((round) => {
      if (round === 1) {
        return { ok: true, manifest: v3Manifest('agent.tap'), code: 'module.exports = { async run() { return nope; } };' };
      }
      if (round === 2) {
        return { ok: true, manifest: v3Manifest('agent.tap'), code: 'module.exports = { async run() { return { ok: false, reason: "refused" }; } };' };
      }
      return { ok: true, manifest: v3Manifest('agent.tap'), code: 'module.exports = { async run() { return { ok: true, steps: ["tap-inventory"] }; } };' };
    });
    service.generation = generation;
    const result = await service.generateAndTrial({ prompt: '开关背包', maxRounds: 4, params: {} });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.rounds, 3, `expected success on round 3, got ${result.rounds}`);
    assert.strictEqual(generation.calls.length, 3);

    // Round 2 must contain the verbatim first failure.
    const round2 = generation.calls[1].feedback;
    assert(round2, 'round 2 feedback missing');
    assert.match(round2.stack, /ReferenceError: nope is not defined/);
    assert.match(round2.reason, /ReferenceError: nope/);
    assert.strictEqual(round2.failedCalls[0].error, 'permission-not-allowed:input_key');
    assert.match(round2.stderr || '', /stderr: ReferenceError/);
    assert.match(round2.code || '', /return nope/);

    // Round 3's feedback comes from a *skill-level* refusal: the sandbox "completed" but the
    // skill returned {ok:false,reason:"refused"}. The reason must be the skill's, not
    // "completed", otherwise the repair prompt has nothing to act on.
    const round3 = generation.calls[2].feedback;
    assert.strictEqual(round3.reason, 'refused', JSON.stringify(round3.reason));
    assert.strictEqual(round3.result && round3.result.reason, 'refused');

    // Version chain: 1.0.0 -> 1.0.1 -> 1.0.2, each kept, lineage recorded.
    const versions = service.store.listVersions('agent.tap').map((entry) => entry.version);
    assert.deepStrictEqual(versions.sort(), ['1.0.0', '1.0.1', '1.0.2']);
    const chain = service.history('agent.tap');
    assert.strictEqual(chain.versions.find((entry) => entry.version === '1.0.2').lineage.parent, '1.0.1');
    assert.strictEqual(chain.versions.find((entry) => entry.version === '1.0.1').lineage.parent, '1.0.0');
    assert.strictEqual(chain.versions.find((entry) => entry.version === '1.0.0').status, 'quarantined');
    assert.strictEqual(chain.versions.find((entry) => entry.version === '1.0.2').status, 'trialled');
    assert(sandbox.runs.length >= 3, 'each attempt really ran');
    fs.rmSync(temps.skills, { recursive: true, force: true });
  });

  await check('the loop stops at 4 rounds and reports every attempt', async () => {
    const temps = { skills: tempRoot('m4v3-cap-skills-'), sandbox: tempRoot('m4v3-cap-sandbox-'), evidence: tempRoot('m4v3-cap-evidence-') };
    const { service } = makeService(temps);
    service.generation = fakeGeneration(() => ({
      ok: true,
      manifest: v3Manifest('agent.cap'),
      code: 'module.exports = { async run() { return nope; } };'
    }));
    const result = await service.generateAndTrial({ prompt: '永远失败', maxRounds: 4 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'max-rounds');
    assert.strictEqual(result.rounds, 4);
    assert.strictEqual(result.attempts.length, 4);
    assert.deepStrictEqual(result.attempts.map((entry) => entry.version), ['1.0.0', '1.0.1', '1.0.2', '1.0.3']);
    fs.rmSync(temps.skills, { recursive: true, force: true });
  });

  await check('a passing trial with failing verification is a failed round', async () => {
    const temps = { skills: tempRoot('m4v3-ver-skills-'), sandbox: tempRoot('m4v3-ver-sandbox-'), evidence: tempRoot('m4v3-ver-evidence-') };
    const { service } = makeService(temps, { context: { inventory: {} } });
    const missing = { inventoryAtLeast: { 'minecraft:diamond': 1 } };
    service.generation = fakeGeneration((round) => ({
      ok: true,
      manifest: v3Manifest('agent.ver', { verification: missing }),
      code: round === 1
        ? 'module.exports = { async run() { return { ok: true }; } };'
        : 'module.exports = { async run() { return { ok: true, steps: ["tap-inventory"] }; } };'
    }));
    const first = await service.generateAndTrial({ prompt: '校验失败', maxRounds: 2 });
    assert.strictEqual(first.ok, false, JSON.stringify(first));
    assert.strictEqual(first.attempts[0].stage, 'verification');
    const record = service.get('agent.ver', '1.0.0');
    assert.strictEqual(record.status, 'quarantined');
    assert(record.verification && record.verification.ok === false);
    fs.rmSync(temps.skills, { recursive: true, force: true });
  });

  await check('preconditions refuse the trial before any sandbox process starts', async () => {
    const temps = { skills: tempRoot('m4v3-pre-skills-'), sandbox: tempRoot('m4v3-pre-sandbox-'), evidence: tempRoot('m4v3-pre-evidence-') };
    const { service, sandbox } = makeService(temps, { context: { position: { x: 100, y: 64, z: 100 } } });
    service.generation = fakeGeneration(() => ({
      ok: true,
      manifest: v3Manifest('agent.pre', {
        preconditions: { positionNear: { position: { x: 0, y: 64, z: 0 }, range: 3 } }
      }),
      code: 'module.exports = { async run() { return { ok: true }; } };'
    }));
    const result = await service.generateAndTrial({ prompt: '前置不满足', maxRounds: 1 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.attempts[0].stage, 'trial');
    assert.match(result.attempts[0].reason, /precondition/);
    assert.strictEqual(sandbox.runs.length, 0, 'no sandbox run for a failed precondition');
    fs.rmSync(temps.skills, { recursive: true, force: true });
  });

  process.stdout.write('\n3. versioned evolution\n');
  await check('nextVersion never reuses a version and promotion keeps the old files', async () => {
    const temps = { skills: tempRoot('m4v3-evo-skills-'), sandbox: tempRoot('m4v3-evo-sandbox-'), evidence: tempRoot('m4v3-evo-evidence-') };
    const { service } = makeService(temps);
    service.generation = fakeGeneration(() => ({
      ok: true,
      manifest: v3Manifest('agent.evo'),
      code: 'module.exports = { async run() { return { ok: true, steps: ["tap-inventory"] }; } };'
    }));
    const first = await service.generateAndTrial({ prompt: '第一版', maxRounds: 1 });
    assert.strictEqual(first.ok, true, JSON.stringify(first));
    assert.strictEqual(service.promote(first.name, first.version).ok, true);

    const evolved = await service.generateCandidate({ prompt: '第二版', evolveFrom: { name: first.name, version: first.version } });
    assert.strictEqual(evolved.ok, true, JSON.stringify(evolved));
    assert.notStrictEqual(evolved.version, first.version);
    assert.strictEqual(evolved.lineage.parent, first.version);
    // Older version directory still exists.
    const root = service.root;
    assert(fs.existsSync(path.join(root, 'promoted', 'agent', 'evo', first.version, 'index.js')));
    assert(fs.existsSync(path.join(root, 'candidates', 'agent', 'evo', evolved.version, 'index.js')));
    const history = service.history('agent.evo');
    assert.strictEqual(history.promoted, first.version);
    assert.deepStrictEqual(history.versions.map((entry) => entry.version).sort(), [first.version, evolved.version].sort());
    fs.rmSync(temps.skills, { recursive: true, force: true });
  });

  await check('v3 capabilities: state() is a read-only alias, input methods map to input_*', () => {
    const { methodsForPermissions } = require('../src/codeSkills/capabilities');
    const readOnly = methodsForPermissions(['read_state']);
    assert.strictEqual(readOnly.state, 'read_state');
    assert.strictEqual(readOnly.read_state, 'read_state');
    const input = methodsForPermissions(['input_tap', 'input_click', 'input_use_on', 'input_key']);
    assert.strictEqual(input.tap, 'input_tap');
    assert.strictEqual(input.click, 'input_click');
    assert.strictEqual(input.use_on, 'input_use_on');
    assert.strictEqual(input.key, 'input_key');
  });

  await check('a slot click without our container screen is refused (live 2026-10-29)', async () => {
    const temps = { skills: tempRoot('m4v3-click-skills-'), sandbox: tempRoot('m4v3-click-sandbox-'), evidence: tempRoot('m4v3-click-evidence-') };
    const closed = makeService(temps);
    const refused = await closed.service._host().click({ slot: 10 });
    assert.strictEqual(refused.ok, false, JSON.stringify(refused));
    assert.strictEqual(refused.reason, 'no-screen');
    assert.strictEqual(closed.calls.length, 0, 'no click reaches the body');

    const temps2 = { skills: tempRoot('m4v3-click2-skills-'), sandbox: tempRoot('m4v3-click2-sandbox-'), evidence: tempRoot('m4v3-click2-evidence-') };
    const opened = makeService(temps2, { context: { screen: 'ChestScreen' } });
    const clicked = await opened.service._host().click({ slot: 0 });
    assert.strictEqual(clicked.ok, true, JSON.stringify(clicked));
    assert(opened.calls.some((call) => call.m === 'clickSlot' && call.slot === 0));
    fs.rmSync(temps.skills, { recursive: true, force: true });
    fs.rmSync(temps2.skills, { recursive: true, force: true });
  });

  process.stdout.write('\n4. similarity retrieval (description-as-key)\n');
  await check('cosine ranking finds the right skill for differently-worded requests', async () => {
    const index = new SkillIndex({ embedder: new LocalEmbedder({ dim: 512 }), k: 3, minScore: 0.12 });
    const entries = [
      {
        name: 'agent.inventory_toggle',
        version: '1.0.0',
        manifest: {
          name: 'agent.inventory_toggle',
          description: '用 tap 键打开玩家背包，读取菜单后关闭；验证 GUI 键鼠链路，不改动物品。',
          permissions: ['input_tap', 'input_menu', 'input_close']
        }
      },
      {
        name: 'agent.dig_grass',
        version: '1.0.0',
        manifest: {
          name: 'agent.dig_grass',
          description: '用十字准星对准脚下的草方块并按住攻击键挖掉它，然后把掉落物捡起来。',
          permissions: ['input_look', 'input_hold']
        }
      },
      {
        name: 'agent.chest_store',
        version: '1.0.0',
        manifest: {
          name: 'agent.chest_store',
          description: '在箱子界面里把指定物品从背包移动到箱子，支持按数量存放。',
          permissions: ['input_menu', 'input_click', 'input_close']
        }
      }
    ];
    await index.build(entries);
    const inv = await index.search('把背包打开看看菜单');
    assert.strictEqual(inv.hits[0] && inv.hits[0].name, 'agent.inventory_toggle', JSON.stringify(inv.hits));
    const dig = await index.search('把前面的草方块挖掉');
    assert.strictEqual(dig.hits[0] && dig.hits[0].name, 'agent.dig_grass', JSON.stringify(dig.hits));
    const chest = await index.search('把这个物品放进箱子');
    assert.strictEqual(chest.hits[0] && chest.hits[0].name, 'agent.chest_store', JSON.stringify(chest.hits));
    // Scores are cosine values in (0,1], not word-overlap counts.
    for (const hit of inv.hits) assert(hit.score > 0 && hit.score <= 1, JSON.stringify(hit));
  });

  await check('the query is context + what the last round was missing (Voyager 245-249)', () => {
    const ctx = {
      events: {
        since: () => [
          { type: 'task:done', reason: 'ok' },
          { type: 'task:failed', reason: 'could not craft beacon: missing glass x5, nether_star x1' }
        ]
      },
      brain: { currentTask: { name: 'craft', description: '合成信标' } },
      languageBrain: { history: [{ from: 'Owner', text: '先帮我找玻璃' }, { self: true, text: '我去看看' }] },
      chat: { history: [{ command: 'mine', args: ['sand', '8'] }] }
    };
    const query = buildSkillQuery(ctx, 'craft beacon');
    assert.match(query, /craft beacon/);
    assert.match(query, /missing glass x5/);
    assert.match(query, /先帮我找玻璃/);
    assert.match(query, /mine/);
    assert.match(query, /合成信标/);
  });

  await check('channelPolicy picks a skill by similarity, not by name equality', () => {
    const ctx = {
      chat: { handlers: { mine: () => {}, chop: () => {} } },
      codeSkills: {
        status: () => ({ promoted: [{ name: 'agent.inventory_toggle', version: '1.0.0', description: '打开背包' }] }),
        skillQuery: (action) => action,
        retrieveSync: () => ({ ok: true, hits: [{ name: 'agent.inventory_toggle', version: '1.0.0', score: 0.42, description: '打开背包' }] })
      }
    };
    const bySimilarity = resolveChannel(ctx, '把背包开一下');
    assert.strictEqual(bySimilarity.channel, 'code-skill');
    assert.match(bySimilarity.reason, /0\.42/);
    assert.strictEqual(bySimilarity.next, 'code-skill agent.inventory_toggle');
    const byName = resolveChannel(ctx, 'agent.inventory_toggle');
    assert.strictEqual(byName.match.score, 1, 'exact name still wins with score 1');
  });

  await check('tokenizer keeps CJK bigrams so word order still matters', () => {
    const tokens = tokenize('打开背包');
    assert(tokens.includes('打开'));
    assert(tokens.includes('开背'));
    assert(tokens.includes('背包'));
  });

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
