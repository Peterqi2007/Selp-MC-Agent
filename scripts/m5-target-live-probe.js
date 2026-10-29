'use strict';

/**
 * `node scripts/m5-target-live-probe.js` - real-client check of the facing layer.
 *
 * Three things this proves on a live client:
 *   1. `target` reports a BLOCK when aiming at one (type/name/position/face/distance);
 *   2. `target` reports an ENTITY when aiming at a mob/entity (type/name/entityType/health),
 *      which used to come back as `null` because only BlockHitResult was handled;
 *   3. the `target` verb and `/state.target` agree, because they share one implementation.
 *
 * The entity half is skipped (not failed) when no entity is within reach - the lobby may be
 * empty at that moment.
 */

const http = require('http');

const PORT = 8899;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
        timeout: 20000
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cmd = (line) => request('POST', '/command', { command: line }).then((text) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    return { raw: text };
  }
});
const state = () => request('GET', '/state').then((text) => JSON.parse(text));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}\n`);
}

function targetOf(snap) {
  const target = snap && snap.target;
  return target && typeof target === 'object' ? target : null;
}

(async () => {
  process.stdout.write('M5 facing probe (mod :8899)\n\n');

  let snap = null;
  for (let i = 0; i < 60; i += 1) {
    snap = await state().catch(() => null);
    if (snap && snap.ready) break;
    await sleep(2000);
  }
  if (!snap || !snap.ready) {
    check('the client is in a world', false, snap && snap.reason);
    process.exitCode = 1;
    return;
  }
  check('the client is in a world', true, snap.dimension);

  // ---- 1. block target ---------------------------------------------------
  const feet = snap.blockPosition || { x: Math.round(snap.position.x), y: Math.round(snap.position.y), z: Math.round(snap.position.z) };
  await cmd(`lookat ${feet.x + 0.5} ${feet.y - 2} ${feet.z + 0.5}`);
  await sleep(600);
  snap = await state();
  const blockTarget = targetOf(snap);
  check('aiming at the ground reports a block target', Boolean(blockTarget) && blockTarget.type === 'block', blockTarget);
  if (blockTarget) {
    check('the block target carries name/position/face/distance',
      typeof blockTarget.name === 'string' && blockTarget.name.length > 0
        && blockTarget.position && ['x', 'y', 'z'].every((axis) => Number.isFinite(blockTarget.position[axis]))
        && typeof blockTarget.face === 'string'
        && Number.isFinite(blockTarget.distance),
      blockTarget);
  }

  // The verb and the snapshot must agree.
  const verb = await cmd('target');
  check('the target verb agrees with /state.target',
    Boolean(verb && verb.target) && Boolean(blockTarget) && verb.target.name === blockTarget.name
      && Math.abs((verb.target.position.x || 0) - blockTarget.position.x) < 0.01,
    verb && verb.target);

  // Looking up may hit a ceiling (this lobby has a glass roof), so the assertion is "the old
  // aim must not survive", not "there is no target".
  await cmd('look 0 -90');
  await sleep(500);
  snap = await state();
  const sky = targetOf(snap);
  check('turning the camera does not reuse the previous target',
    sky === null || !blockTarget
      || sky.name !== blockTarget.name
      || sky.position.x !== blockTarget.position.x
      || sky.position.y !== blockTarget.position.y
      || sky.position.z !== blockTarget.position.z,
    { before: blockTarget && { name: blockTarget.name, position: blockTarget.position }, after: sky && { name: sky.name, position: sky.position } });

  // ---- 2. entity target --------------------------------------------------
  let candidates = [];
  for (let attempt = 0; attempt < 8 && candidates.length === 0; attempt += 1) {
    const scan = await state();
    candidates = (scan.entities || [])
      .filter((entity) => entity && entity.position && Number.isFinite(entity.distance))
      .sort((a, b) => a.distance - b.distance);
    if (candidates.length === 0) {
      // The lobby's mod entities (chairs / maids) wander; give them a moment and look around.
      await cmd('moveto 26.5 63 82.5 4');
      await sleep(5000);
    }
  }
  const near = candidates[0];
  if (!near) {
    process.stdout.write('  SKIP  no entity in the loaded area to aim at\n');
  } else {
    // Walk within pick range (4.5 blocks), then aim at its centre.
    process.stdout.write(`  target entity: ${near.name} at ${near.distance.toFixed(1)}m\n`);
    await cmd(`moveto ${near.position.x} ${near.position.y} ${near.position.z} 2.5`);
    await sleep(6000);
    const after = await state();
    const still = (after.entities || []).find((entity) => entity.id === near.id);
    if (!still) {
      process.stdout.write('  SKIP  the entity moved away before we could aim\n');
    } else if (still.distance > 4.2) {
      process.stdout.write(`  SKIP  could not get within reach (still ${still.distance.toFixed(1)}m)\n`);
    } else {
      await cmd(`lookat ${still.position.x} ${still.position.y + 0.5} ${still.position.z}`);
      await sleep(700);
      const aimed = targetOf(await state());
      const ok = Boolean(aimed) && aimed.type === 'entity';
      check('aiming at an entity reports an entity target', ok, aimed || { wanted: still.name });
      if (ok) {
        check('the entity target carries name/entityType/distance',
          typeof aimed.name === 'string' && aimed.name.length > 0
            && typeof aimed.entityType === 'string'
            && Number.isFinite(aimed.distance),
          { name: aimed.name, entityType: aimed.entityType, distance: aimed.distance, health: aimed.health });
        // Two entities can share a position (the maid sits ON the chair), so the ray may hit
        // the one we did not name. What matters is that it hit a real entity we can see.
        const finalSnap = await state();
        const known = (finalSnap.entities || []).find((entity) => entity.name === aimed.name && entity.distance <= 5);
        check('the aimed entity is one of the entities within reach', Boolean(known),
          { aimed: aimed.name, wanted: still.name, candidates: (finalSnap.entities || []).map((entity) => `${entity.name}@${entity.distance}`) });
      }
    }
  }

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) process.exitCode = 1;
})().catch((err) => {
  process.stderr.write(`${err.stack || err}\n`);
  process.exitCode = 1;
});
