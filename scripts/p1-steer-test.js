'use strict';

/**
 * Proactive steer contract (2026-10-29).
 *
 * The screenshot policy used to deliver frames with `agent.followup()`, which queues the
 * message until the CURRENT action-brain turn finishes. A failure screenshot is only useful
 * inside the turn that failed, so `/message` must support DSH's `agent.steer()` (the
 * next-step inbox) and the bridge must ask for it.
 *
 * This suite starts the real plugin's HTTP endpoint against a fake live agent and asserts the
 * delivery method - no DSH, no Minecraft, no model:
 *
 *   - mode:"steer"  -> agent.steer()  (delivered into the running turn)
 *   - no mode       -> agent.followup() (old behaviour, next turn)
 *   - steer on a runtime without steer() -> honest fallback + delivery:"followup"
 *   - the Node bridge sends mode:"steer" when the screenshot policy asks for it
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PLUGIN = path.join(ROOT, 'dsh-plugin-mc-harness', 'lib', 'index.js');
const PORT = 18771 + Math.floor(Math.random() * 200);

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    process.stdout.write(`  PASS  ${name}\n`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    process.stdout.write(`  FAIL  ${name}\n    ${err && err.message}\n`);
  }
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const req = http.request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') });
          } catch (err) {
            reject(new Error(`bad JSON: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw || '{}') });
          } catch (err) {
            reject(new Error(`bad JSON: ${raw.slice(0, 200)}`));
          }
        });
      })
      .on('error', reject);
  });
}

async function waitForServer() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await get(`http://127.0.0.1:${PORT}/health`);
      if (res.status === 200 && res.body.ok) return res.body;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('plugin server did not start');
}

async function main() {
  process.stdout.write('Proactive steer (plugin /message + bridge contract)\n\n');

  const delivered = [];
  const plain = {
    id: 'agent-plain',
    status: 'idle',
    async followup(message) {
      delivered.push({ agent: 'agent-plain', via: 'followup', message });
    },
    async steer(message) {
      delivered.push({ agent: 'agent-plain', via: 'steer', message });
    }
  };
  const noSteer = {
    id: 'agent-old',
    status: 'idle',
    async followup(message) {
      delivered.push({ agent: 'agent-old', via: 'followup', message });
    }
  };
  const agents = {
    get: (id) => (id === 'agent-old' ? noSteer : id === 'agent-plain' ? plain : null),
    list: () => [plain, noSteer]
  };
  let cleanup = null;
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (name) => (name === 'agents' ? agents : null),
    inject() {},
    effect(fn) {
      cleanup = fn();
    }
  };

  const mod = await import(pathToFileURL(PLUGIN).href);
  const apply = (mod.default && mod.default.apply) || mod.apply;
  assert.strictEqual(typeof apply, 'function', 'the plugin does not export apply()');
  apply(ctx, { port: PORT, controlUrl: 'http://127.0.0.1:9' });

  try {
    const health = await waitForServer();
    check('the plugin exposes /message and /health', () => {
      assert.strictEqual(health.plugin, 'dsh-mc-harness');
    });

    const bind = await post(`http://127.0.0.1:${PORT}/bind`, { agentId: 'agent-plain' });
    check('a live agent can be bound for delivery', () => {
      assert.strictEqual(bind.status, 200);
      assert.strictEqual(bind.body.agentId, 'agent-plain');
    });

    const steer = await post(`http://127.0.0.1:${PORT}/message`, { text: '[screenshot] failed step', mode: 'steer' });
    check('mode:"steer" uses agent.steer (the running turn sees it)', () => {
      assert.strictEqual(steer.status, 200);
      assert.strictEqual(steer.body.delivery, 'steer');
      const last = delivered[delivered.length - 1];
      assert.strictEqual(last.via, 'steer');
      assert.strictEqual(last.message.role, 'user');
      assert.match(last.message.content[0].text, /failed step/);
    });

    const follow = await post(`http://127.0.0.1:${PORT}/message`, { text: 'ordinary followup' });
    check('no mode keeps the old followup delivery', () => {
      assert.strictEqual(follow.status, 200);
      assert.strictEqual(follow.body.delivery, 'followup');
      assert.strictEqual(delivered[delivered.length - 1].via, 'followup');
    });

    const oldBind = await post(`http://127.0.0.1:${PORT}/bind`, { agentId: 'agent-old' });
    assert.strictEqual(oldBind.status, 200);
    const fallback = await post(`http://127.0.0.1:${PORT}/message`, { text: 'steer me', mode: 'steer' });
    check('a runtime without steer() falls back honestly (delivery says followup)', () => {
      assert.strictEqual(fallback.status, 200);
      assert.strictEqual(fallback.body.requestedMode, 'steer');
      assert.strictEqual(fallback.body.delivery, 'followup');
      assert.strictEqual(delivered[delivered.length - 1].via, 'followup');
    });

    // ---- Node bridge + policy side -------------------------------------
    const bridgeSource = fs.readFileSync(path.join(ROOT, 'src', 'chat', 'harnessBridge.js'), 'utf8');
    check('the bridge sends mode on /message and reports what happened', () => {
      assert.match(bridgeSource, /mode: meta\.mode === 'steer' \? 'steer' : 'followup'/);
      assert.match(bridgeSource, /delivery: payload\.delivery/);
    });
    const policySource = fs.readFileSync(path.join(ROOT, 'src', 'perception', 'screenshotPolicy.js'), 'utf8');
    check('the screenshot policy asks for steer delivery', () => {
      assert.match(policySource, /imagePath: record\.path,\s*\n\s*mode: 'steer'/);
    });
    const shotTest = fs.readFileSync(path.join(ROOT, 'scripts', 'p1-shot-policy-test.js'), 'utf8');
    check('the shot suite asserts the steer mode', () => {
      assert.match(shotTest, /meta\.mode === 'steer'|mode === 'steer'|'steer'/);
    });
  } finally {
    if (typeof cleanup === 'function') {
      try {
        await cleanup();
      } catch {
        /* already closed */
      }
    }
  }

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    process.stdout.write('FAILED\n');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
