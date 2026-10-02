'use strict';
// Throwaway mock of the agent-bridge HTTP API used to exercise scripts/bridge-client.js
// success paths offline. Not part of the project.
const http = require('http');

const state = {
  ok: true, mod: 'agent-bridge', version: '1.0.0', tick: 48213, tps: 19.8, serverPort: 25565,
  minecraftVersion: '1.20.1', hardcore: false, maxPlayers: 8, playerCount: 1, difficulty: 'normal',
  dayTime: 5321, worldTime: 5321, isDay: true, raining: false, thundering: false, rainGradient: 0,
  overworldDimension: 'minecraft:overworld', onlinePlayerNames: ['AgentSteve'],
  players: [{
    name: 'AgentSteve', uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', dimension: 'minecraft:overworld',
    position: { x: 12.5, y: 64, z: -30.25 }, blockPosition: { x: 12, y: 64, z: -31 },
    health: 20, maxHealth: 20, absorption: 0, food: 17, saturation: 5, xpLevel: 3,
    gamemode: 'survival', onGround: true, pingMs: 4,
    inventory: { 'minecraft:cobblestone': 43, 'minecraft:oak_log': 12 }, heldItem: 'minecraft:stone_pickaxe',
    offhandItem: '', tracked: true, trackedFirstSeenMs: 1735000000000,
  }],
  trackedPlayers: [],
  bridge: { running: true, bindAddress: '127.0.0.1', port: 8765, allowCommands: true, chatRelayed: 3, chatRelayFailures: 0 },
};

const server = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, mod: 'agent-bridge', version: '1.0.0' });
  if (req.method === 'GET' && req.url === '/state') return send(200, state);
  if (req.method === 'GET' && req.url === '/players') {
    return send(200, { ok: true, count: 1, players: state.players.map(({ name, uuid, dimension, position, blockPosition, health, maxHealth, food, gamemode, pingMs }) => ({ name, uuid, dimension, position, blockPosition, health, maxHealth, food, gamemode, pingMs })) });
  }
  if (req.method === 'POST' && req.url === '/command') {
    let b = ''; req.on('data', (c) => { b += c; });
    return req.on('end', () => {
      let cmd = ''; try { cmd = JSON.parse(b).command; } catch {}
      if (cmd === 'stop') return send(400, { ok: false, error: "command 'stop' is not whitelisted (allowed roots: say, tp, time, give, gamemode, weather)", whitelist: ['time', 'weather', 'give', 'tp', 'gamemode', 'say'] });
      return send(200, { ok: true, command: cmd, executedAs: 'AgentSteve', result: 1, output: 'Set the time to 1000' });
    });
  }
  return send(404, { ok: false, error: 'not found', endpoints: ['GET /health', 'GET /state', 'GET /players', 'POST /command'] });
});

server.listen(8765, '127.0.0.1', () => process.stdout.write('mock bridge listening on http://127.0.0.1:8765\n'));
