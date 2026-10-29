'use strict';

/**
 * `node scripts/m5-channel-live-probe.js --agent <sessionId>` - real action-brain check of
 * the capability-first channel policy (L1 discovery + L2 decision).
 *
 * It drives the DSH action-brain conversation through the plugin's own `/goal` entry
 * (mode:text), which is the same path a real goal takes, and records what the brain did:
 *
 *   T1  mc_capabilities exists and is actually called (order comes from the tool, not from
 *       reading source or calling the HTTP endpoint by hand)
 *   T2  an action with a registered skill resolves to the `command` channel (chop -> chop 2)
 *   T3  an action only the input layer can do resolves to `input` (screenshot -> shot)
 *   T4  an uncovered action resolves to `code-generation` as a PROPOSAL, never automatic
 *
 * Writes runtime/evidence/m5-channel-live-<stamp>.json. No Minecraft action is executed by
 * any of the four goals: they are decision-only prompts.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const PLUGIN_PORT = 8770;
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function argValue(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}
const AGENT = argValue('--agent');
const outDir = path.resolve(argValue('--out') || path.join('runtime', 'evidence'));

function request(method, urlPath, body, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PLUGIN_PORT,
        path: urlPath,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
        timeout
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) });
          } catch (err) {
            reject(new Error(`non-JSON from plugin: ${text.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('goal timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const results = [];

async function goal(goalText) {
  const started = Date.now();
  const res = await request('POST', '/goal', { agentId: AGENT, mode: 'text', goal: goalText });
  const json = res.json || {};
  return {
    goal: goalText,
    ms: Date.now() - started,
    steps: (json.steps || []).map((step) => step.command),
    finish: json.finish || null,
    final: json.final || '',
    errors: json.agentErrors || []
  };
}

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}\n`);
}

async function main() {
  if (!AGENT) {
    process.stderr.write('usage: node scripts/m5-channel-live-probe.js --agent <sessionId>\n');
    process.exitCode = 2;
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const evidence = {
    startedAt: new Date().toISOString(),
    agentId: AGENT,
    checks: results,
    runs: {}
  };
  process.stdout.write(`M5 channel live probe (action brain ${AGENT})\n\n`);

  // T1: the tool exists and is used
  process.stdout.write('T1. mc_capabilities exists and is called\n');
  const t1 = await goal('只做一件事：调用 mc_capabilities 工具，把返回 JSON 的 order 字段原样复述。不要执行任何 Minecraft 动作；不要用读源码或 curl 代替工具调用。完成后调用 mc_finish，achieved=true。');
  evidence.runs.T1 = t1;
  const t1Text = `${(t1.finish && t1.finish.summary) || ''} ${t1.final}`;
  check('the tool is called (order reported from the tool)', /code-skill.*command.*input.*code-generation/s.test(t1Text), t1.finish && t1.finish.achieved);
  check('no Minecraft action was executed', t1.steps.length === 0, JSON.stringify(t1.steps));

  // T2: registered skill -> command channel
  process.stdout.write('\nT2. an action with a skill resolves to `command`\n');
  const t2 = await goal('先调用 mc_capabilities。然后回答：如果我要砍 2 个原木，按能力优先应使用哪个通道、具体命令是什么？只回答，不执行任何 Minecraft 动作。完成后 mc_finish，achieved=true。');
  evidence.runs.T2 = t2;
  const t2Text = `${(t2.finish && t2.finish.summary) || ''} ${t2.final}`;
  check('chop resolves to the command channel', /command/i.test(t2Text) && !/input 通道/.test(t2Text), 'command');
  check('the concrete command is chop 2', /chop\s*2/.test(t2Text), 'chop 2');

  // T3: only the input layer can do it -> input channel
  process.stdout.write('\nT3. an action only the input layer covers resolves to `input`\n');
  const t3 = await goal('先调用 mc_capabilities。然后回答：如果我要截一张当前画面给模型看，按能力优先应使用哪个通道、具体命令是什么？只回答，不执行任何 Minecraft 动作。完成后 mc_finish，achieved=true。');
  evidence.runs.T3 = t3;
  const t3Text = `${(t3.finish && t3.finish.summary) || ''} ${t3.final}`;
  check('screenshot resolves to the input channel', /input/i.test(t3Text), 'input');
  check('the concrete command is shot', /shot/.test(t3Text), 'shot');

  // T4: nothing covers it -> generation proposal only
  process.stdout.write('\nT4. an uncovered action resolves to a generation PROPOSAL\n');
  const t4 = await goal('先调用 mc_capabilities。然后回答：如果我要做一个命令表里没有、也不是按某个键能做到的动作（例如"把箱子里物品自动分类排序"），按能力优先应走哪个通道？只回答，不执行任何动作。完成后 mc_finish，achieved=true。');
  evidence.runs.T4 = t4;
  const t4Text = `${(t4.finish && t4.finish.summary) || ''} ${t4.final}`;
  check('it resolves to code-generation', /code-generation/i.test(t4Text), 'code-generation');
  check('generation is describe as a proposal with a human prompt', /提议|propos/i.test(t4Text) && /人工|human|operator/i.test(t4Text), 'proposal + human');

  evidence.finishedAt = new Date().toISOString();
  const file = path.join(outDir, `m5-channel-live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
  process.stdout.write(`\nevidence: ${path.relative(ROOT, file)}\n`);

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
