/**
 * dsh-mc-harness - a real DSH plugin for H1a/H1b.
 *
 * It registers three model-facing tools on the DSH side:
 *
 *   mc_observe  -> GET  http://127.0.0.1:8766/ui/state (read-only)
 *   mc_step     -> POST http://127.0.0.1:8766/command   (one action at a time)
 *   mc_finish   -> record the final explanation, no side effect
 *
 * and a local control endpoint (default 127.0.0.1:8770):
 *
 *   POST /goal  { goal }  -> creates a DSH agent session, sends the goal, waits idle,
 *                            returns { steps, final, sessionId }
 *   GET  /health
 *
 * The plugin never edits the Minecraft body itself: mc_step goes through the same panel
 * command endpoint the operator uses, so Node keeps TaskSlot/event/stop ownership.
 */

import http from 'node:http';

export const name = 'dsh-mc-harness';

const DEFAULT_CONTROL = 'http://127.0.0.1:8766';
const DEFAULT_PORT = 8770;

function jsonReply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

function lastAssistantText(session) {
  try {
    const messages = session.deriveMessages();
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message && message.role === 'assistant') {
        const text = textOfContent(message.content);
        if (text) return text;
      }
    }
  } catch {
    /* no session projection available */
  }
  return '';
}

function toolDefinitions({ controlUrl, record, log }) {
  const observe = {
    name: 'mc_observe',
    description:
      'Read the live Minecraft agent state (position, health, time, current task). ' +
      'Call this before planning and after a failed step.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute() {
      const res = await fetch(`${controlUrl}/ui/state`);
      if (!res.ok) throw new Error(`mc_observe HTTP ${res.status}`);
      const state = await res.json();
      const out = {
        position: state.world && state.world.position,
        health: state.world && state.world.health,
        food: state.world && state.world.food,
        time: state.world && state.world.time,
        current: state.brain && state.brain.current,
        queue: state.brain && state.brain.queueLength
      };
      record.observations.push(out);
      /**
       * Return a JSON string, not a raw object. Live 2026-10-17 the object form was rejected
       * by the DSH output validator with "value is not lossless JSON" (undefined optional
       * fields are the likely culprit); a string is lossless and the renderer prints it.
       */
      return JSON.stringify(out);
    }
  };

  const step = {
    name: 'mc_step',
    description:
      'Execute ONE Minecraft action through the local agent, e.g. "goto 70 64 32", ' +
      '"mine dirt 2", "chop 2", "stop". Never send multiple actions in one call.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'One panel/chat command without a leading !' }
      },
      required: ['command'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    async execute(args) {
      const command = String(args && args.command ? args.command : '').trim();
      if (!command) throw new Error('mc_step needs a command');
      record.steps.push({ command, at: new Date().toISOString() });
      const res = await fetch(`${controlUrl}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command })
      });
      const receipt = await res.json();
      record.receipts.push({ command, receipt });
      return { accepted: receipt.ok === true, command, receipt };
    }
  };

  const finish = {
    name: 'mc_finish',
    description:
      'Record the final result. Use only after the steps are done, or when the goal is ' +
      'impossible and you must explain why. This tool has no side effect.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What was done, or why it cannot be done' },
        achieved: { type: 'boolean', description: 'true only if the goal was actually achieved' }
      },
      required: ['summary'],
      additionalProperties: false
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }]
    },
    async execute(args) {
      record.finish = {
        summary: String(args.summary || ''),
        achieved: args.achieved === true,
        at: new Date().toISOString()
      };
      log(`mc_finish: ${record.finish.summary}`);
      return record.finish;
    }
  };

  return [observe, step, finish];
}

export function apply(ctx, config = {}) {
  const log = (message) => {
    try {
      (ctx.logger?.info || ctx.log?.info || console.log)(`dsh-mc-harness: ${message}`);
    } catch {
      console.log(`dsh-mc-harness: ${message}`);
    }
  };
  const port = Number(config.port) || DEFAULT_PORT;
  const controlUrl = String(config.controlUrl || DEFAULT_CONTROL);
  const record = { observations: [], steps: [], receipts: [], finish: null };
  let handle = null;
  let busy = false;

  const ensureAgent = async () => {
    if (handle) return handle;
    /**
     * Cordis only exposes an injected service through the inject scope. `/goal` runs from
     * the HTTP handler, outside that scope, so read the registry with ctx.get() instead of
     * the ctx.agents property (live H1 2026-10-17: "cannot get property agents without inject").
     */
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null;
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('dsh-mc-harness needs the agents service (dsh-agent + dsh-agent-loop)');
    }
    const sessionId = `mc-harness-${Date.now()}`;
    handle = await agents.create({
      sessionId,
      agentOptions: config.agentOptions || {}
    });
    log(`agent ${sessionId} created`);
    return handle;
  };

  ctx.inject(['tools', 'agents'], (toolsCtx) => {
    for (const definition of toolDefinitions({ controlUrl, record, log })) {
      toolsCtx.tools.register(definition);
    }
    log('registered mc_observe / mc_step / mc_finish');
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return jsonReply(res, 200, { ok: true, plugin: name, port, controlUrl, busy, steps: record.steps.length });
    }
    if (req.method === 'POST' && url.pathname === '/goal') {
      if (busy) return jsonReply(res, 409, { ok: false, error: 'busy' });
      let body = '';
      for await (const chunk of req) body += chunk;
      let goal = '';
      try {
        goal = String(JSON.parse(body || '{}').goal || '').trim();
      } catch {
        return jsonReply(res, 400, { ok: false, error: 'invalid JSON' });
      }
      if (!goal) return jsonReply(res, 400, { ok: false, error: 'goal is required' });
      busy = true;
      record.observations.length = 0;
      record.steps.length = 0;
      record.receipts.length = 0;
      record.finish = null;
      try {
        const agent = await ensureAgent();
        const prompt = [
          'You are the Minecraft action planner running inside a real DeepSeek Harness.',
          'Decompose the goal into small, executable steps and execute them with mc_step,',
          'one command per call. Use mc_observe before the first step or after a failure.',
          'Commands are the local agent command table, without the leading "!":',
          'goto <x> <y> <z>, mine <block> <n>, chop <n>, stop, status.',
          'If the goal cannot be achieved with the current world/inventory, do NOT invent',
          'steps and do NOT claim success: explain exactly what is missing and call mc_finish',
          'with achieved=false. When done, call mc_finish.',
          '',
          `GOAL: ${goal}`
        ].join('\n');
        agent.agent.followup({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: name }
        });
        await agent.agent.whenIdle();
        const final = lastAssistantText(agent.agent.session);
        return jsonReply(res, 200, {
          ok: true,
          goal,
          sessionId: agent.agent.id || null,
          steps: record.steps,
          receipts: record.receipts,
          observations: record.observations,
          finish: record.finish,
          final
        });
      } catch (error) {
        return jsonReply(res, 500, { ok: false, error: error.message });
      } finally {
        busy = false;
      }
    }
    return jsonReply(res, 404, { ok: false, error: 'not found' });
  });

  server.on('error', (error) => log(`server error: ${error.message}`));
  server.listen(port, '127.0.0.1', () => log(`control endpoint http://127.0.0.1:${port}`));
  ctx.effect(() => () => {
    try {
      server.close();
    } catch {
      /* already closed */
    }
    if (handle && typeof handle.dispose === 'function') handle.dispose().catch(() => {});
  }, 'dsh-mc-harness: control endpoint');
}

export default { name, apply };
