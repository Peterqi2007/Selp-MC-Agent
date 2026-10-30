'use strict';

/**
 * `npm run p1:channel:test` - offline contracts for the L1/L2 channel work (2026-10-29).
 *
 * L1 (discovery): the action brain must be able to *learn* which channels exist instead of
 *     reading a hand-written command list in the plugin prompt. That is `mc_capabilities`
 *     -> `GET /capabilities` -> `src/core/channelPolicy.js`.
 * L2 (policy): the decision is capability-first - promoted code skill, then registered
 *     command/skill, then the raw input layer, and only then a *proposal* to generate code.
 *     Generation itself stays operator-only; nothing in this repo may generate on its own.
 *
 * No client, no network, no model calls.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  CHANNELS,
  INPUT_COMMANDS,
  describe,
  resolveChannel
} = require('../src/core/channelPolicy');

const silent = { info() {}, warn() {}, debug() {}, error() {} };
const ROOT = path.join(__dirname, '..');
const results = [];

function check(name, fn) {
  try {
    const outcome = fn();
    if (outcome && typeof outcome.then === 'function') {
      return outcome.then(
        () => results.push({ name, ok: true }),
        (err) => results.push({ name, ok: false, error: err })
      );
    }
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err });
  }
  return Promise.resolve();
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function makeCtx(overrides = {}) {
  const handlers = {
    chop: () => {},
    mine: () => {},
    goto: () => {},
    key: () => {},
    hold: () => {},
    shot: () => {},
    inputs: () => {},
    capabilities: () => {}
  };
  return {
    chat: { handlers },
    body: { menu: () => {}, clickSlot: () => {} },
    ...overrides
  };
}

async function main() {
  // ------------------------------------------------------------- L2 policy
  process.stdout.write('\n1. capability-first ordering\n');

  await check('the channel order is fixed and capability-first', () => {
    assert.deepStrictEqual(CHANNELS.map((channel) => channel.id),
      ['code-skill', 'command', 'input', 'code-generation']);
    assert.deepStrictEqual(CHANNELS.map((channel) => channel.order), [1, 2, 3, 4]);
  });

  await check('a registered command/skill wins over the input layer', () => {
    const ctx = makeCtx();
    const resolved = resolveChannel(ctx, 'chop');
    assert.strictEqual(resolved.channel, 'command');
    assert.strictEqual(resolved.covered, true);
  });

  await check('a promoted code skill wins over the command table', () => {
    const ctx = makeCtx({
      codeSkills: {
        status: () => ({ promoted: [{ name: 'chop', version: '1.2.0' }] })
      }
    });
    const resolved = resolveChannel(ctx, 'chop');
    assert.strictEqual(resolved.channel, 'code-skill');
    assert.strictEqual(resolved.order, 1);
    assert.match(resolved.next, /code-skill chop/);
  });

  await check('raw input is its own channel and never a substitute for a skill', () => {
    const ctx = makeCtx();
    for (const verb of INPUT_COMMANDS) {
      const resolved = resolveChannel(ctx, verb);
      assert.strictEqual(resolved.channel, 'input', `${verb} should resolve to input`);
      assert.strictEqual(resolved.order, 3);
    }
  });

  await check('an uncovered action resolves to a generation PROPOSAL, not an action', () => {
    const ctx = makeCtx();
    const resolved = resolveChannel(ctx, 'open_mod_gui');
    assert.strictEqual(resolved.channel, 'code-generation');
    assert.strictEqual(resolved.covered, false);
    assert.match(resolved.next, /propose/i);
  });

  await check('an empty action explains where to look', () => {
    const resolved = resolveChannel(makeCtx(), '');
    assert.strictEqual(resolved.covered, false);
    assert.strictEqual(resolved.next, 'mc_capabilities');
  });

  // --------------------------------------------------------- L1 discovery
  process.stdout.write('\n2. the discovery surface lists live channels, not a frozen list\n');

  await check('describe() exposes the policy, channels, commands and code skills', () => {
    const table = describe(makeCtx());
    assert.strictEqual(table.ok, true);
    assert.strictEqual(table.policy, 'capability-first');
    assert.deepStrictEqual(table.order, ['code-skill', 'command', 'input', 'code-generation']);
    assert.strictEqual(table.channels.length, 4);
    assert(table.channels.every((channel) => channel.when && channel.example !== undefined));
    assert.deepStrictEqual(table.inputCommands, ['key', 'hold', 'tap', 'shot', 'inputs']);
    assert(table.keyActions.held.includes('forward'));
    assert(table.keyActions.edge.includes('inventory'));
    assert(table.keyActions.edge.includes('hotbar1'));
    assert.match(table.keyActions.modKeyIds, /mc_keybinds/);
    assert.match(table.keyActions.modKeyIds, /immersive_aircraft:dismount/);
    assert.match(table.keyActions.modKeyBindings, /raw key/i);
    assert.match(table.escalation.rule, /mc_keybinds/);
    assert(table.skills.includes('chop'));
    assert(!table.skills.includes('key'), 'input verbs must not be listed as skills');
    assert.match(table.codeSkills.generation, /operator-only/i);
    assert.match(table.codeSkills.generation, /never automatic/i);
  });

  await check('describe() reads the live command table, so new verbs need no prompt edit', () => {
    const before = describe(makeCtx());
    const ctx = makeCtx();
    ctx.chat.handlers.brand_new_verb = () => {};
    const after = describe(ctx);
    assert(!before.skills.includes('brand_new_verb'));
    assert(after.skills.includes('brand_new_verb'), 'a new command must appear automatically');
  });

  await check('!capabilities answers through the command table', async () => {
    const { ChatController } = require('../src/chat/commands');
    const ctx = {
      reply: async () => true,
      body: {},
      log: silent,
      brain: { inputLedger: { status: () => ({ held: [], count: 0 }) } }
    };
    const chat = new ChatController(ctx, { prefix: '!' });
    const result = await chat.handle('capabilities');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.result.policy, 'capability-first');
    assert(result.result.skills.includes('chop'));
  });

  await check('GET /capabilities is wired to the same table', () => {
    const server = read('src/web/statusServer.js');
    assert.match(server, /url\.pathname === '\/capabilities'/);
    assert.match(server, /describeChannels\(ctx\)/);
    assert.match(server, /require\('\.\.\/core\/channelPolicy'\)/);
  });

  // --------------------------------------------------- action brain side
  process.stdout.write('\n3. the action brain can see the channels (L1)\n');

  await check('the plugin exposes mc_capabilities and registers it', () => {
    const plugin = read('dsh-plugin-mc-harness/lib/index.js');
    assert.match(plugin, /name: 'mc_capabilities'/);
    assert.match(plugin, /controlUrl\}\/capabilities/);
    assert.match(plugin, /return \[observe, perception, state, capabilities, keybinds, propose/);
  });

  await check('mc_step advertises the input layer and code-skill, and points at mc_capabilities', () => {
    const plugin = read('dsh-plugin-mc-harness/lib/index.js');
    const start = plugin.indexOf("name: 'mc_step'");
    const block = plugin.slice(start, start + 2500);
    assert.match(block, /mc_capabilities/);
    assert.match(block, /key forward down/);
    assert.match(block, /hold attack/);
    assert.match(block, /shot 768/);
    assert.match(block, /code-skill/);
    assert.match(block, /Capability-first/);
  });

  await check('the goal objective states the capability-first order', () => {
    const plugin = read('dsh-plugin-mc-harness/lib/index.js');
    const start = plugin.indexOf('const actionGoalObjective');
    const block = plugin.slice(start, start + 1600);
    assert.match(block, /mc_capabilities/);
    assert.match(block, /capability-first/i);
    assert.match(block, /raw input layer/i);
  });

  await check('the one-shot planner prompt no longer freezes the command list', () => {
    const plugin = read('dsh-plugin-mc-harness/lib/index.js');
    assert(!plugin.includes('goto <x> <y> <z>, mine <block> <n>, chop <n>, fish [n], withdraw <item> <n>, follow <player> [seconds], stop, status.'),
      'the old hardcoded eight-command list is still present');
    const start = plugin.indexOf('Commands are the local agent command table');
    const block = plugin.slice(start, start + 900);
    assert.match(block, /mc_capabilities/);
    assert.match(block, /capability-first/i);
  });

  await check('proposals stay command-table tasks; raw input is not a proposal type', () => {
    const plugin = read('dsh-plugin-mc-harness/lib/index.js');
    const start = plugin.indexOf('const proposalPrepObjective');
    const block = plugin.slice(start, start + 2600);
    assert.match(block, /Raw input \(key\/hold\) and code-skill are execution/);
  });

  // ------------------------------------------------- never generate alone
  await check('the capability table teaches channel escalation after repeated failure', () => {
    const { describe } = require('../src/core/channelPolicy');
    const table = describe({ chat: { handlers: {} }, codeSkills: { status: () => ({ promoted: [] }) } });
    assert(table.escalation, 'escalation block missing');
    assert.match(table.escalation.rule, /classified/);
    assert.match(table.escalation.rule, /third blind same-signature/);
    assert.match(table.escalation.rule, /lookup_mod_content/);
    assert.match(table.escalation.rule, /mc_ask_player/);
    assert.match(table.escalation.rule, /input layer/);
    assert(table.escalation.inputVerbs.includes('key'));
    assert(table.escalation.inputExamples.includes('hold attack 600'));
    assert(table.escalation.inputExamples.includes('tap inventory'));
  });

  process.stdout.write('\n4. code generation stays operator-only\n');

  await check('generation is only reachable from the operator HTTP endpoint', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(path.join(ROOT, 'src'));
    const callers = files.filter((file) => {
      if (file.includes(path.join('src', 'codeSkills'))) return false;
      const code = fs.readFileSync(file, 'utf8');
      return /generateAndTrial\(|generateCandidate\(/.test(code);
    }).map((file) => path.relative(ROOT, file));
    assert.deepStrictEqual(callers, [path.join('src', 'web', 'statusServer.js')].map((p) => p),
      `unexpected generation callers: ${callers.join(', ')}`);
  });

  await check('the policy module itself never generates or executes anything', () => {
    const code = read('src/core/channelPolicy.js');
    assert.doesNotMatch(code, /require\(['"]\.\.\/codeSkills/);
    assert.doesNotMatch(code, /child_process|exec\(/);
    assert.match(code, /code-generation/);
  });

  const failed = results.filter((entry) => !entry.ok);
  for (const entry of failed) {
    process.stdout.write(`  FAIL ${entry.name}\n    ${entry.error && entry.error.message}\n`);
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
