'use strict';

/**
 * Server-sent events for task lifecycle facts (P1 §1.4.4, A31).
 *
 * One helper so the transport rules live in one place:
 *   - `Last-Event-ID` (or `?lastEventId=`) replays the ring buffer, so a reconnect does not
 *     lose or duplicate completions;
 *   - `?token=` or `Authorization: Bearer` is required when a token is configured; an empty
 *     token means "localhost only", which is how the panel already runs;
 *   - a heartbeat comment keeps proxies and the browser from closing an idle stream;
 *   - closing the request/res cleans up the subscription and the timer.
 *
 * The function returns `true` when it took over the response. On a refusal it writes a small
 * JSON error and returns `false`, so the caller must not write anything else.
 */

function suppliedToken(req, url) {
  const fromQuery = url.searchParams.get('token');
  if (fromQuery) return fromQuery;
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : '';
}

function streamEvents(req, res, options = {}) {
  const { events, token = '', heartbeatMs = 15000 } = options;
  const url = new URL(req.url, 'http://localhost');

  if (token && suppliedToken(req, url) !== token) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return false;
  }
  if (!events || typeof events.since !== 'function' || typeof events.subscribe !== 'function') {
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'event hub unavailable' }));
    return false;
  }

  const lastEventId = Number(req.headers['last-event-id'] || url.searchParams.get('lastEventId') || 0) || 0;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(': connected\n\n');

  const write = (event) => {
    try {
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } catch {
      /* the socket went away; cleanup runs from the close handlers */
    }
  };
  for (const event of events.since(lastEventId)) write(event);
  const unsubscribe = events.subscribe(write);
  const timer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignored, same as above */
    }
  }, heartbeatMs);
  if (typeof timer.unref === 'function') timer.unref();

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribe();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  return true;
}

module.exports = { streamEvents };
