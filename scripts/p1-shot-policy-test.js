'use strict';

/**
 * Offline contract for the screenshot policy (docs/P1-M5.md §11).
 *
 * No client, no model, no real filesystem: the policy is driven with a fake body, a fake
 * event hub, an in-memory fs and an injectable clock, so every budget/dedupe/trigger rule is
 * asserted deterministically.
 *
 *   node scripts/p1-shot-policy-test.js
 */

const assert = require('assert');
const path = require('path');
const zlib = require('zlib');
const { ScreenshotPolicy, dhash } = require('../src/perception/screenshotPolicy');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    process.stdout.write(`  FAIL  ${name}\n    ${err && err.message}\n`);
  }
}

/** Minimal 8-bit RGB PNG encoder (used so dhash has a real file to read). */
function encodePng(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const base = y * (width * 3 + 1) + 1 + x * 3;
      raw[base] = r;
      raw[base + 1] = g;
      raw[base + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function memoryFs() {
  const files = new Map();
  return {
    files,
    async writeFile(file, data) {
      files.set(file, { data: Buffer.from(data), mtimeMs: Date.now() });
    },
    async readFile(file) {
      const entry = files.get(file);
      if (!entry) throw new Error(`ENOENT ${file}`);
      return entry.data;
    },
    async readdir(dir) {
      return [...files.keys()].filter((file) => file.startsWith(dir)).map((file) => path.basename(file));
    },
    async stat(file) {
      const entry = files.get(file);
      if (!entry) throw new Error(`ENOENT ${file}`);
      return { mtimeMs: entry.mtimeMs };
    },
    async rm(file) {
      files.delete(file);
    }
  };
}

function makeHarness(options = {}) {
  const dir = path.resolve('runtime', 'screenshots-test');
  const fsImpl = options.fsImpl || memoryFs();
  const messages = [];
  const shots = [];
  let now = 1_000_000;
  let frames = 0;
  const bridge = {
    agentId: 'agent-test',
    async boundAgentId() {
      return 'agent-test';
    },
    async goalOf() {
      if (options.goalState === 'active') return { id: 'goal-live-1', phase: 'active', roundsStarted: 1, maxGoalRounds: 3 };
      if (options.goalState === 'complete') return { id: 'goal-old-1', phase: 'complete', roundsStarted: 3, maxGoalRounds: 3 };
      if (options.goalState === 'no-query') return undefined;
      return null;
    },
    async forward(text, meta) {
      messages.push({ text, meta });
      return { ok: true };
    }
  };
  if (options.goalState === 'no-query') delete bridge.goalOf;
  const events = {
    subscriber: null,
    subscribe(fn) {
      this.subscriber = fn;
      return () => {
        this.subscriber = null;
      };
    },
    publish(event) {
      if (this.subscriber) this.subscriber(event);
    }
  };
  const body = {
    kind: 'fake',
    snapshot: () => options.snapshot || { dimension: 'minecraft:overworld', blocks: {} },
    async screenshot(request) {
      frames += 1;
      // Flip the gradient direction every frame: adding a constant would not change dHash.
      // A 4-state pattern so up to four consecutive frames hash differently (dedupe must be
      // able to reject a *repeat*, not every frame).
      const phase = frames % 4;
      const png = options.png
        ? options.png()
        : encodePng(8, 8, (x, y) => {
          const tone = ((x + y + phase) % 4) * 60;
          return [tone, (tone + 40) % 256, 40];
        });
      const file = path.join(dir, `shot-${String(frames).padStart(3, '0')}.png`);
      await fsImpl.writeFile(file, png);
      shots.push({ file, request });
      return { ok: true, path: file, width: 8, height: 8, bytes: png.length };
    }
  };
  const brain = {
    ctx: {
      planService: { busy: Boolean(options.planBusy) },
      hub: { busy: false }
    },
    queue: []
  };
  const cfg = {
    enabled: true,
    maxEdge: 768,
    maxPerTask: 3,
    minIntervalMs: 15_000,
    fallbackMs: 90_000,
    keepFiles: 20,
    dedupeDistance: 5,
    steer: true,
    repeatedFailureCount: 3,
    ...(options.cfg || {})
  };
  const policy = new ScreenshotPolicy({
    body,
    bridge,
    events,
    brain,
    cfg,
    dir,
    now: () => now,
    fsImpl,
    log: { info() {}, warn() {}, debug() {} }
  });
  policy.start();
  return {
    policy,
    events,
    messages,
    shots,
    fsImpl,
    dir,
    advance(ms) {
      now += ms;
    },
    get now() {
      return now;
    }
  };
}

async function main() {
  process.stdout.write('Screenshot policy (offline)\n\n');

  await check('the event hub is subscribed and unknown events are ignored', async () => {
    const h = makeHarness();
    h.events.publish({ type: 'chat', text: 'hi' });
    h.events.publish({ type: 'something:else' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(h.shots.length, 0);
    h.policy.stop();
  });

  await check('plan:partial captures one frame, writes a sidecar and steers an ACTIVE goal', async () => {
    const h = makeHarness({ goalState: 'active' });
    h.events.publish({ type: 'plan:partial', planId: 'p1', reason: 'step-incomplete' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(h.shots.length, 1, 'expected one capture');
    const record = h.policy.latest();
    assert.strictEqual(record.reason, 'plan-partial');
    assert.strictEqual(record.taskKey, 'p1');
    const sidecar = h.fsImpl.files.get(record.path.replace(/\.png$/, '.json'));
    assert(sidecar, 'sidecar json missing');
    assert.strictEqual(JSON.parse(sidecar.data.toString()).reason, 'plan-partial');
    assert.strictEqual(h.messages.length, 1, 'expected one steer message');
    const text = h.messages[0].text;
    assert.match(text, /\[截图\/plan-partial\]/);
    assert.match(text, /runtime\/screenshots-test\/shot-001\.png/);
    assert.match(text, /当前 goal: goal-live-1/);
    assert.match(text, /结构化状态优先/);
    assert.match(text, /不能把失败升级为成功/);
    h.policy.stop();
  });

  await check('a second event inside the minimum interval is skipped', async () => {
    const h = makeHarness();
    h.events.publish({ type: 'task:failed', taskId: 't1' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.advance(5_000);
    h.events.publish({ type: 'task:failed', taskId: 't2' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(h.shots.length, 1, 'min interval must throttle');
    h.policy.stop();
  });

  await check('the per-task cap stops the fourth frame', async () => {
    const h = makeHarness({ cfg: { minIntervalMs: 0 } });
    for (let i = 0; i < 4; i += 1) {
      h.advance(1_000);
      h.events.publish({ type: 'task:failed', taskId: 'same-task' });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const status = h.policy.status();
    assert.strictEqual(status.shots, 3, `expected 3 recorded frames, got ${status.shots}`);
    assert.strictEqual(status.perTask['same-task'], 3);
    h.policy.stop();
  });

  await check('a near-identical frame is deduped and its file removed', async () => {
    const still = () => encodePng(8, 8, (x, y) => [x * 30, y * 30, 40]);
    const h = makeHarness({ cfg: { minIntervalMs: 0 }, png: still });
    // `pre-task` (not a failure reason) is the trigger that participates in dedupe; failures
    // deliberately bypass it so the moment is kept.
    h.events.publish({ type: 'plan:started', planId: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    h.advance(1_000);
    h.events.publish({ type: 'plan:started', planId: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(h.shots.length, 2, 'body was asked twice');
    assert.strictEqual(h.policy.status().shots, 1, 'the duplicate must not be recorded');
    const frames = [...h.fsImpl.files.keys()].filter((file) => file.endsWith('.png'));
    assert.deepStrictEqual(frames, [h.shots[0].file], 'duplicate file must be deleted');
    h.policy.stop();
  });

  await check('a visibly different frame is kept', async () => {
    let invert = false;
    const h = makeHarness({
      cfg: { minIntervalMs: 0 },
      png: () => encodePng(8, 8, (x, y) => (invert ? [255 - x * 20, 255 - y * 20, 255] : [x * 30, y * 30, 40]))
    });
    h.events.publish({ type: 'task:failed', taskId: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    invert = true;
    h.advance(1_000);
    h.events.publish({ type: 'task:failed', taskId: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(h.policy.status().shots, 2, 'different frames must both be kept');
    h.policy.stop();
  });

  await check('three identical step failures escalate to repeated-failure', async () => {
    const h = makeHarness({ cfg: { minIntervalMs: 0, maxPerTask: 10 } });
    const reasons = [];
    for (let i = 0; i < 3; i += 1) {
      const result = h.policy.onEvent({ type: 'plan:step', status: 'failed', reason: 'no-path', planId: 'p' });
      // eslint-disable-next-line no-await-in-loop
      const settled = await result;
      reasons.push(settled && settled.reason);
      h.advance(500);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.deepStrictEqual(reasons, ['step-failed', 'step-failed', 'repeated-failure']);
    h.policy.stop();
  });

  await check('plan:started and proposal:accepted capture a pre-task frame', async () => {
    const h = makeHarness({ cfg: { minIntervalMs: 0 } });
    await h.policy.onEvent({ type: 'plan:started', planId: 'p2' });
    h.advance(1_000);
    h.policy.failures.clear();
    await h.policy.onEvent({ type: 'proposal:accepted', taskId: 'x' });
    assert.strictEqual(h.policy.status().shots, 2);
    assert.strictEqual(h.policy.status().lastShot.reason, 'pre-task');
    h.policy.stop();
  });

  await check('fallback fires only while a task is active and only after 90 s', async () => {
    const idle = makeHarness();
    idle.advance(120_000);
    await idle.policy.tick();
    assert.strictEqual(idle.shots.length, 0, 'idle brain must not be screenshotted');
    idle.policy.stop();

    const busy = makeHarness({ planBusy: true, cfg: { minIntervalMs: 0 }, goalState: 'active' });
    await busy.policy.tick();
    assert.strictEqual(busy.shots.length, 1, 'first tick after start may capture');
    await busy.policy.tick();
    assert.strictEqual(busy.shots.length, 1, 'inside the fallback window nothing is captured');
    busy.advance(91_000);
    await busy.policy.tick();
    assert.strictEqual(busy.shots.length, 2);
    assert.strictEqual(busy.policy.status().lastShot.reason, 'fallback');
    busy.policy.stop();
  });

  await check('a first-seen mod block and a dimension change each capture once', async () => {
    let snapshot = { dimension: 'minecraft:overworld', blocks: { cells: { '0,64,0': 'mymod:stool' } } };
    const h = makeHarness({ snapshot: null, cfg: { minIntervalMs: 0 } });
    h.policy.body.snapshot = () => snapshot;
    h.policy.lastScanAt = 0;
    await h.policy.scanNovelty('task');
    assert.strictEqual(h.policy.status().lastShot.reason, 'mod-block-first-seen');
    h.advance(16_000);
    await h.policy.scanNovelty('task');
    assert.strictEqual(h.policy.status().shots, 1, 'the same mod block must not re-trigger');
    h.advance(16_000);
    snapshot = { dimension: 'minecraft:the_nether', blocks: { cells: {} } };
    await h.policy.scanNovelty('task');
    assert.strictEqual(h.policy.status().lastShot.reason, 'dimension-change');
    h.policy.stop();
  });

  await check('the folder keeps only the newest K frames', async () => {
    const h = makeHarness({ cfg: { minIntervalMs: 0, keepFiles: 2, maxPerTask: 10 } });
    let shade = 0;
    for (let i = 0; i < 4; i += 1) {
      shade += 60;
      h.policy.body.screenshot = async (request) => {
        // A different frame each time, otherwise dedupe legitimately drops it.
        const png = encodePng(8, 8, (x, y) => [(x * 20 + shade) % 256, (y * 20 + shade) % 256, 40]);
        const file = path.join(h.dir, `shot-prune-${i}.png`);
        await h.fsImpl.writeFile(file, png);
        return { ok: true, path: file, width: 8, height: 8, bytes: png.length };
      };
      h.advance(1_000);
      // eslint-disable-next-line no-await-in-loop
      await h.policy.capture('manual', { taskKey: `t${i}` });
    }
    const frames = [...h.fsImpl.files.keys()].filter((file) => file.endsWith('.png'));
    assert.strictEqual(frames.length, 2, `expected 2 kept frames, got ${frames.length}`);
    h.policy.stop();
  });

  await check('a failure right after the pre-task frame is kept, a second one is throttled', async () => {
    const h = makeHarness({ cfg: { minIntervalMs: 15_000 } });
    await h.policy.onEvent({ type: 'plan:started', planId: 'p9' });
    h.advance(30);
    const failure = await h.policy.onEvent({ type: 'plan:failed', planId: 'p9', reason: 'craft-missing' });
    assert.strictEqual(failure && failure.ok, true, 'the failure must override the pre-task frame');
    h.advance(30);
    const second = await h.policy.onEvent({ type: 'plan:failed', planId: 'p9', reason: 'again' });
    assert.strictEqual(second && second.skipped, 'min-interval', 'failure after failure stays throttled');
    h.policy.stop();
  });

  await check('a failure waits for an in-flight pre-task frame instead of being dropped', async () => {
    const h = makeHarness({ goalState: 'active', cfg: { minIntervalMs: 15_000 } });
    // Slow the frame down so the failure lands while the pre-task capture is still running.
    const original = h.policy.body.screenshot;
    h.policy.body.screenshot = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return original(request);
    };
    const pre = h.policy.onEvent({ type: 'plan:started', planId: 'p-wait' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const failed = h.policy.onEvent({ type: 'task:failed', taskId: 'p-wait', planId: 'p-wait', reason: 'instant' });
    await Promise.all([pre, failed]);
    const reasons = h.policy.status();
    assert.strictEqual(reasons.shots, 2, `both frames must be kept, got ${reasons.shots}`);
    assert.strictEqual(reasons.lastShot.reason, 'task-failed');
    h.policy.stop();
  });

  await check('no steer without an active goal: the frame is kept, nothing is sent', async () => {
    const none = makeHarness({ goalState: 'none' });
    none.events.publish({ type: 'task:failed', taskId: 't9' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(none.shots.length, 1, 'the frame must still be captured');
    assert.strictEqual(none.messages.length, 0, 'no goal means no steer');
    none.policy.stop();

    const done = makeHarness({ goalState: 'complete' });
    done.events.publish({ type: 'task:failed', taskId: 't10' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(done.messages.length, 0, 'a completed goal must not be steered');
    done.policy.stop();

    const noQuery = makeHarness({ goalState: 'no-query' });
    noQuery.events.publish({ type: 'task:failed', taskId: 't11' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(noQuery.shots.length, 1);
    assert.strictEqual(noQuery.messages.length, 0, 'an old bridge without goalOf must not guess');
    noQuery.policy.stop();
  });

  await check('steer is skipped when disabled, capture still works', async () => {
    const h = makeHarness({ cfg: { steer: false } });
    h.events.publish({ type: 'plan:failed', planId: 'p3' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.strictEqual(h.shots.length, 1);
    assert.strictEqual(h.messages.length, 0);
    h.policy.stop();
  });

  await check('dhash separates a horizontal gradient from its inverse', () => {
    const a = dhash(encodePng(8, 8, (x) => [x * 30, x * 30, x * 30]));
    const b = dhash(encodePng(8, 8, (x) => [255 - x * 30, 255 - x * 30, 255 - x * 30]));
    assert.notStrictEqual(a.hash, b.hash);
    assert.strictEqual(a.width, 8);
  });

  // -------------------------------------------------------------- wiring
  await check('index wires the policy and observe exposes it as aux', () => {
    const fsSync = require('fs');
    const index = fsSync.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    assert.match(index, /new ScreenshotPolicy\(/);
    assert.match(index, /screenshotPolicy\.start\(\)/);
    const server = fsSync.readFileSync(path.join(__dirname, '..', 'src', 'web', 'statusServer.js'), 'utf8');
    assert.match(server, /result\.aux = \{/);
    assert.match(server, /不能升级成功/);
    const config = JSON.parse(fsSync.readFileSync(path.join(__dirname, '..', 'config', 'agent.json'), 'utf8'));
    assert.strictEqual(config.screenshot.enabled, true);
    assert.strictEqual(config.screenshot.fallbackMs, 90000);
  });

  const failed = results.filter((entry) => !entry.ok);
  if (failed.length) {
    process.stdout.write(`\n${failed.length} failed of ${results.length}\n`);
    for (const entry of failed) process.stdout.write(`  ${entry.name}: ${entry.error && entry.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`\n${results.length}/${results.length} passed\n`);
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
