'use strict';

/**
 * Throwaway probe: can the input layer open the player-inventory GUI at all?
 *
 * `key inventory` sets the KeyMapping's down flag, but vanilla opens the inventory from a
 * *click* (consumeClick), not from the down state - so this tells us whether the toggle key
 * path works or whether the mod needs an explicit "open inventory" primitive.
 */

const http = require('http');

function request(method, port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
        timeout: 20000
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`non-JSON: ${text.slice(0, 160)}`));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cmd = (line) => request('POST', 8899, '/command', { command: line });
const state = () => request('GET', 8899, '/state');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let snap = await state();
  console.log('start screen:', snap.screen);

  console.log('key inventory down ->', (await cmd('key inventory down')).ok);
  await sleep(250);
  console.log('key inventory up   ->', (await cmd('key inventory up')).ok);
  await sleep(700);
  snap = await state();
  console.log('after key press screen:', snap.screen);

  if (!snap.screen || snap.screen === 'null') {
    console.log('hold inventory 250 ->', JSON.stringify(await cmd('hold inventory 250')));
    await sleep(1000);
    snap = await state();
    console.log('after hold screen:', snap.screen);
  }

  if (snap.screen && snap.screen !== 'null') {
    console.log('menu open:', JSON.stringify(await cmd('menu')).slice(0, 200));
    console.log('close ->', (await cmd('close')).ok);
    await sleep(400);
    snap = await state();
    console.log('after close screen:', snap.screen);
  }
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
