'use strict';

/**
 * `npm run p1:m5:test` - offline contracts for the M5 input layer (2026-10-29 decision).
 *
 * The M5 base changed from OS-level computer use to an in-process input layer inside the
 * Minecraft client mod. These contracts are the offline half of F1' (see docs/P1-M5.md §7):
 *
 *   F1'a  structural containment - input/screenshot never touch an OS-level API, so they
 *         physically cannot reach a window that is not Minecraft;
 *   F1'b  input ledger - every press is recorded, and every stop path releases it.
 *
 * No client, no network, no model calls. Real-client assertions (A21/A22) stay on the
 * operator checklist; this file only proves the parts that can be proven offline.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { InputLedger, normaliseAction, MAX_HOLD_MS } = require('../src/core/inputLedger');
const { Holds } = require('../src/core/holds');
const { ClientModBody } = require('../src/body/clientModBody');
const { ChatController } = require('../src/chat/commands');

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

function listJava() {
  const dir = path.join(ROOT, 'mod-client/src/main/java/dev/agentclient');
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.java'))
    .map((name) => ({ name, code: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

/**
 * A fake write channel that records every press/release in order.
 * Failures are injected by pushing a rejected promise for a given action.
 */
function fakeChannel(options = {}) {
  const calls = [];
  const failOn = options.failOn || new Map();
  const write = async (action, down) => {
    calls.push({ action, down });
    const failure = failOn.get(`${action}:${down ? 'down' : 'up'}`);
    if (failure) throw new Error(failure);
    return { ok: true, action, down };
  };
  const writeHold = async (action, ms) => {
    calls.push({ action, down: true, ms, hold: true });
    return { ok: true, action, ms };
  };
  return { calls, write, writeHold };
}

function pngBase64() {
  // 1x1 transparent PNG.
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
}

async function main() {
  // ---------------------------------------------------------------- F1'a
  process.stdout.write('\n1. F1a: no OS-level input or screen capture\n');

  await check('the mod and the Node brain contain no OS input/capture API', () => {
    const forbidden = /SendInput|keybd_event|mouse_event|BitBlt|PrintWindow|CopyFromScreen/;
    const offenders = [];
    for (const file of listJava()) {
      if (forbidden.test(file.code)) offenders.push(`mod-client/${file.name}`);
    }
    const srcDir = path.join(ROOT, 'src');
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const code = fs.readFileSync(full, 'utf8');
          if (forbidden.test(code)) offenders.push(path.relative(ROOT, full));
        }
      }
    };
    walk(srcDir);
    assert.deepStrictEqual(offenders, [], `OS-level APIs found in: ${offenders.join(', ')}`);
  });

  await check('the mod captures through the game render target, not an OS grab', () => {
    const actions = read('mod-client/src/main/java/dev/agentclient/ClientActions.java');
    assert.match(actions, /Screenshot\.takeScreenshot\(/, 'expected Screenshot.takeScreenshot');
    assert.doesNotMatch(actions, /Robot|GraphicsDevice|Toolkit/, 'no AWT screen capture');
  });

  await check('keys go through the game\'s own KeyMapping state', () => {
    const actions = read('mod-client/src/main/java/dev/agentclient/ClientActions.java');
    for (const key of ['keyUp', 'keyAttack', 'keyUse', 'keyShift']) {
      assert.match(actions, new RegExp(`options\\.${key}\\.setDown`), `missing ${key}`);
    }
  });

  // ------------------------------------------------------------- F1'b (mod)
  process.stdout.write('\n2. F1b: the mod bounds every hold itself\n');

  await check('the mod has a hard hold cap and an expiry pass on the client tick', () => {
    const actions = read('mod-client/src/main/java/dev/agentclient/ClientActions.java');
    assert.match(actions, /MAX_HOLD_MS\s*=\s*(\d[\d_]*)/, 'no MAX_HOLD_MS');
    const cap = Number(/MAX_HOLD_MS\s*=\s*([\d_]+)/.exec(actions)[1].replace(/_/g, ''));
    assert(cap > 0 && cap <= 60_000, `cap out of range: ${cap}`);
    assert.match(actions, /private void expireHolds\(\)/, 'no expireHolds');
    assert.match(actions, /expireHolds\(\);/, 'expireHolds is never called');
    assert.match(actions, /clientTick\s*\+=\s*1/, 'no client tick counter');
  });

  await check('every stop path clears the mod ledger (releaseAllKeys)', () => {
    const actions = read('mod-client/src/main/java/dev/agentclient/ClientActions.java');
    const release = /private void releaseAllKeys\(\)\s*\{([\s\S]*?)\n    \}/.exec(actions);
    assert(release, 'releaseAllKeys not found');
    assert.match(release[1], /heldUntilTick\.clear\(\)/, 'releaseAllKeys does not clear heldUntilTick');
  });

  await check('/state reports the tick clock and the ledger', () => {
    const snapshot = read('mod-client/src/main/java/dev/agentclient/ClientStateSnapshot.java');
    assert.match(snapshot, /out\.put\("gameTime", Json\.num\(level\.getGameTime\(\)\)\)/);
    assert.match(snapshot, /out\.put\("input",/);
  });

  await check('the HTTP layer exposes key/hold/shot/inputs', () => {
    const server = read('mod-client/src/main/java/dev/agentclient/ControlHttpServer.java');
    for (const verb of ['"key"', '"hold"', '"shot"', '"inputs"']) {
      assert(server.includes(`case ${verb}`), `missing verb ${verb}`);
    }
    assert.match(server, /actions\.keyJson\(/, 'key verb does not call keyJson');
    assert.match(server, /actions\.screenshotJson\(/, 'shot verb does not call screenshotJson');
  });

  await check('login/register never echo the credential back', () => {
    const server = read('mod-client/src/main/java/dev/agentclient/ControlHttpServer.java');
    assert.match(server, /private static String redactCommand\(String command\)/, 'no redactCommand');
    assert.match(server, /Json\.str\(redactCommand\(normalised\)\)/,
      'the echoed command does not go through redactCommand');
  });

  // ------------------------------------------------------------ input ledger
  process.stdout.write('\n3. input ledger: record, release, never leak\n');

  await check('a press is recorded and a release clears it', async () => {
    const channel = fakeChannel();
    const ledger = new InputLedger({ log: silent, write: channel.write });
    await ledger.press('forward');
    assert.deepStrictEqual(ledger.list().map((entry) => entry.action), ['forward']);
    assert.strictEqual(ledger.isClear(), false);
    await ledger.release('forward');
    assert.strictEqual(ledger.isClear(), true);
    assert.deepStrictEqual(channel.calls, [
      { action: 'forward', down: true },
      { action: 'forward', down: false }
    ]);
  });

  await check('the ledger refuses a fifth concurrent key instead of piling up', async () => {
    const channel = fakeChannel();
    const ledger = new InputLedger({ log: silent, write: channel.write, maxHeld: 4 });
    for (const key of ['forward', 'left', 'jump', 'sprint']) await ledger.press(key);
    await assert.rejects(() => ledger.press('use'), /ledger full/);
    assert.strictEqual(ledger.list().length, 4);
  });

  await check('releaseAll releases every key and records why', async () => {
    const channel = fakeChannel();
    const ledger = new InputLedger({ log: silent, write: channel.write });
    await ledger.press('forward');
    await ledger.press('attack');
    const result = await ledger.releaseAll('dead');
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.released.sort(), ['attack', 'forward']);
    assert.strictEqual(ledger.isClear(), true);
    assert.strictEqual(ledger.status().lastReleases.slice(-1)[0].reason, 'dead');
    assert(channel.calls.filter((call) => call.down === false).length >= 2);
  });

  await check('releaseAll survives a failing channel and still clears the table', async () => {
    const failOn = new Map([['attack:up', 'client gone']]);
    const channel = fakeChannel({ failOn });
    const ledger = new InputLedger({ log: silent, write: channel.write });
    await ledger.press('attack');
    const result = await ledger.releaseAll('stop');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.failures[0].action, 'attack');
    assert.strictEqual(ledger.isClear(), true, 'a failed release must not keep the key recorded forever');
  });

  await check('a hold is recorded with a deadline and the cap is enforced', async () => {
    const channel = fakeChannel();
    const ledger = new InputLedger({ log: silent, write: channel.write, writeHold: channel.writeHold });
    const result = await ledger.hold('attack', 99_999);
    assert.strictEqual(result.ms, MAX_HOLD_MS);
    assert.strictEqual(channel.calls[0].hold, true);
    assert.strictEqual(ledger.list()[0].action, 'attack');
  });

  await check('an expired hold is dropped without waiting for a reply', async () => {
    const channel = fakeChannel();
    let now = 1_000;
    const ledger = new InputLedger({ log: silent, write: channel.write, now: () => now });
    await ledger.press('forward');
    now += MAX_HOLD_MS + 1;
    const dropped = ledger.expire();
    assert.deepStrictEqual(dropped, ['forward']);
    assert.strictEqual(ledger.isClear(), true);
  });

  await check('sync drops keys the mod already released', async () => {
    const channel = fakeChannel();
    const ledger = new InputLedger({ log: silent, write: channel.write });
    await ledger.press('forward');
    await ledger.press('attack');
    ledger.sync([{ action: 'attack', untilTick: 10 }]);
    assert.deepStrictEqual(ledger.list().map((entry) => entry.action), ['attack']);
  });

  await check('key aliases map to the real keybind, junk is rejected', () => {
    assert.strictEqual(normaliseAction('mine'), 'attack');
    assert.strictEqual(normaliseAction('crouch'), 'sneak');
    assert.strictEqual(normaliseAction('forward'), 'forward');
    assert.strictEqual(normaliseAction('nope'), null);
  });

  // ------------------------------------------------------ holds -> ledger
  process.stdout.write('\n4. every hold reason releases the keys\n');

  await check('a new hold fires the release hook once, a refresh does not', () => {
    const reasons = [];
    const holds = new Holds({ onHold: (reason) => reasons.push(reason) });
    holds.hold('owner-stop', '!stop');
    holds.hold('owner-stop', 'again');
    holds.hold('dead');
    assert.deepStrictEqual(reasons, ['owner-stop', 'dead']);
  });

  await check('the Brain wires holds to the input ledger (source contract)', () => {
    const brain = read('src/brain.js');
    assert.match(brain, /new Holds\(\{\s*onHold:\s*\(reason\)\s*=>\s*this\.releaseInput\(reason\)\s*\}\)/);
    assert.match(brain, /this\.inputLedger = new InputLedger\(/);
    assert.match(brain, /releaseInput\(reason = 'stop'\)/);
  });

  // --------------------------------------------------------------- body
  process.stdout.write('\n5. body protocol: the exact commands the mod receives\n');

  await check('key/hold/inputs send the documented command strings', async () => {
    const body = new ClientModBody({ agent: { clientMod: {} } }, { log: silent });
    const sent = [];
    body.command = async (line) => {
      sent.push(line);
      if (line === 'inputs') return { ok: true, tick: 7, held: [{ action: 'forward', untilTick: 30 }] };
      return { ok: true };
    };
    await body.key('forward', true);
    await body.key('attack', false);
    await body.hold('use', 1200);
    await body.inputState();
    assert.deepStrictEqual(sent, ['key forward down', 'key attack up', 'hold use 1200', 'inputs']);
  });

  await check('screenshot writes a real PNG and reports its size', async () => {
    const body = new ClientModBody({ agent: { clientMod: {} } }, { log: silent });
    body.command = async (line) => {
      assert.strictEqual(line, 'shot 512');
      return {
        ok: true,
        width: 1,
        height: 1,
        sourceWidth: 1280,
        sourceHeight: 720,
        bytes: 68,
        tick: 11,
        pngBase64: pngBase64()
      };
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm5-shot-'));
    const shot = await body.screenshot({ maxEdge: 512, dir, name: 'one.png' });
    assert.strictEqual(shot.ok, true);
    const bytes = fs.readFileSync(path.join(dir, 'one.png'));
    assert.deepStrictEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'not a PNG header');
    assert.strictEqual(shot.width, 1);
    assert.strictEqual(shot.sourceWidth, 1280);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('a failed capture is reported, not written', async () => {
    const body = new ClientModBody({ agent: { clientMod: {} } }, { log: silent });
    body.command = async () => ({ ok: false, error: 'no-frame' });
    const shot = await body.screenshot({ maxEdge: 256 });
    assert.strictEqual(shot.ok, false);
    assert.match(shot.error, /no-frame/);
  });

  // ------------------------------------------------------------ commands
  process.stdout.write('\n6. chat/task commands reach the input layer\n');

  const makeController = (overrides = {}) => {
    const ctx = {
      reply: async () => true,
      body: {
        key: async (action, down) => ({ ok: true, action, down }),
        hold: async (action, ms) => ({ ok: true, action, ms }),
        inputState: async () => ({ ok: true, tick: 3, held: [] }),
        screenshot: async () => ({ ok: true, path: 'runtime/screenshots/x.png', width: 640, height: 360 }),
        ...(overrides.body || {})
      },
      log: silent,
      ...(overrides.ctx || {})
    };
    const ledger = new InputLedger({
      log: silent,
      write: (action, down) => ctx.body.key(action, down),
      writeHold: (action, ms) => ctx.body.hold(action, ms)
    });
    ctx.brain = { inputLedger: ledger, ...(overrides.brain || {}) };
    const chat = new ChatController(ctx, { prefix: '!' });
    return { chat, ctx, ledger };
  };

  await check('!key down/up drives the ledger and rejects junk', async () => {
    const { chat, ledger } = makeController();
    const pressed = await chat.handle('key forward down');
    assert.strictEqual(pressed.ok, true);
    assert.deepStrictEqual(ledger.list().map((entry) => entry.action), ['forward']);
    await chat.handle('key forward up');
    assert.strictEqual(ledger.isClear(), true);
    await assert.rejects(() => chat.handle('key forward sideways'), /usage/);
  });

  await check('!hold is bounded and lands in the ledger', async () => {
    const { chat, ledger } = makeController();
    await chat.handle('hold attack 3000');
    assert.strictEqual(ledger.list()[0].action, 'attack');
    assert.strictEqual(ledger.list()[0].reason, 'hold');
  });

  await check('!inputs reconciles with the mod ledger', async () => {
    const { chat, ledger } = makeController({
      body: { inputState: async () => ({ ok: true, tick: 9, held: [] }) }
    });
    await ledger.press('jump');
    const result = await chat.handle('inputs');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(ledger.isClear(), true, 'a key the mod no longer reports must be dropped');
  });

  await check('!shot saves through the body', async () => {
    const { chat } = makeController();
    const result = await chat.handle('shot 640');
    assert.strictEqual(result.ok, true);
    assert.match(result.result.path, /x\.png$/);
  });

  await check('!shot on a body without capture fails loudly', async () => {
    const { chat } = makeController({ body: { screenshot: undefined } });
    await assert.rejects(() => chat.handle('shot'), /cannot take screenshots/);
  });

  // -------------------------------------------------------------- summary
  const failed = results.filter((entry) => !entry.ok);
  for (const entry of results) {
    if (!entry.ok) {
      process.stdout.write(`  FAIL ${entry.name}\n    ${entry.error && entry.error.message}\n`);
    }
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
  return failed.length === 0;
}

main().then((ok) => {
  if (!ok) process.exitCode = 1;
}).catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
