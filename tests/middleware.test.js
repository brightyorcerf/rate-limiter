'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const rateLimiter = require('../src/middleware/rateLimiter');
const MemoryStore = require('../src/storage/memoryStore');
const RedisStore = require('../src/storage/redisStore');

/**
 * Boot an app on an ephemeral port and return a fetch helper bound to it.
 * 127.0.0.1 explicitly: `localhost` may resolve to ::1 first.
 */
async function serve(build) {
  const app = express();
  build(app);

  // Errors must reach an error handler as a 500, never hang the socket.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error', code: err.code ?? null });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    // Connection: close keeps undici from holding idle sockets open after the
    // assertions finish, which otherwise adds seconds to every test file.
    get: (path, init = {}) =>
      fetch(`${base}${path}`, {
        ...init,
        headers: { connection: 'close', ...init.headers }
      }),
    async close() {
      // fetch() keeps sockets alive, and server.close() waits for them, so the
      // sockets have to be cut explicitly or the test run never finishes.
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

test('emits a coherent header set on allow and on deny', async (t) => {
  const store = new MemoryStore({ autoCleanup: false });
  const app = await serve((a) => {
    a.get('/', rateLimiter({ requestsPerMinute: 2, capacity: 2, scope: 'hdr', store }), (req, res) =>
      res.json({ ok: true })
    );
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  const first = await app.get('/');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('ratelimit-limit'), '2');
  assert.equal(first.headers.get('ratelimit-remaining'), '1');
  assert.equal(first.headers.get('x-ratelimit-limit'), '2');
  assert.equal(first.headers.get('retry-after'), null, 'no Retry-After while allowed');

  // Reset is time until the bucket is back at capacity, and the legacy header
  // carries the same instant as an ISO timestamp.
  const resetSeconds = Number(first.headers.get('ratelimit-reset'));
  assert.ok(resetSeconds > 0 && resetSeconds <= 60, `unexpected reset ${resetSeconds}`);
  const resetAt = new Date(first.headers.get('x-ratelimit-reset')).getTime();
  assert.ok(Math.abs(resetAt - (Date.now() + resetSeconds * 1000)) < 2000);

  await app.get('/');
  const denied = await app.get('/');
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get('ratelimit-remaining'), '0');

  const retryAfter = Number(denied.headers.get('retry-after'));
  assert.ok(retryAfter >= 1, 'Retry-After must never be 0 or negative');

  const body = await denied.json();
  assert.equal(body.error, 'Too Many Requests');
  assert.equal(body.retryAfter, retryAfter);
  assert.equal(body.limit, 2);
});

test('requestsPerMinute: 0 denies everything without an impossible Retry-After', async (t) => {
  // Previously 0 was swallowed by `||` and became 60, and a zero refill rate
  // produced Retry-After: Infinity -> RangeError on every request.
  const store = new MemoryStore({ autoCleanup: false });
  const app = await serve((a) => {
    a.get('/', rateLimiter({ requestsPerMinute: 0, scope: 'closed', store }), (req, res) =>
      res.json({ ok: true })
    );
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  const res = await app.get('/');
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), null, 'a limit that never refills has no retry time');
  assert.equal(res.headers.get('x-ratelimit-reset'), null, 'non-finite reset must not be sent');
  assert.equal((await res.json()).retryAfter, null);
});

test('limiters with different limits do not share a bucket', async (t) => {
  const store = new MemoryStore({ autoCleanup: false });
  const app = await serve((a) => {
    a.get('/strict', rateLimiter({ requestsPerMinute: 5, capacity: 5, store }), (req, res) =>
      res.json({ ok: true })
    );
    a.get('/relaxed', rateLimiter({ requestsPerMinute: 120, capacity: 100, store }), (req, res) =>
      res.json({ ok: true })
    );
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await app.get('/strict')).status, 200);
  }
  assert.equal((await app.get('/strict')).status, 429);
  assert.equal((await app.get('/relaxed')).status, 200, 'exhausting one route must not close another');
});

test('an aggregate limiter mounted before the routes actually applies', async (t) => {
  const store = new MemoryStore({ autoCleanup: false });
  const app = await serve((a) => {
    a.use(rateLimiter({ requestsPerMinute: 3, capacity: 3, scope: 'agg', store }));
    a.get('/x', (req, res) => res.json({ ok: true }));
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  for (let i = 0; i < 3; i += 1) assert.equal((await app.get('/x')).status, 200);
  assert.equal((await app.get('/x')).status, 429);
});

test('a fabricated API key falls back to the IP bucket instead of minting quota', async (t) => {
  const store = new MemoryStore({ autoCleanup: false });
  const known = new Set(['good-key']);
  const app = await serve((a) => {
    a.get(
      '/',
      rateLimiter({
        requestsPerMinute: 3,
        capacity: 3,
        scope: 'keys',
        store,
        identifier: (req) => {
          const presented = req.headers['x-api-key'];
          return known.has(presented) ? `key:${presented}` : req.ip;
        }
      }),
      (req, res) => res.json({ ok: true })
    );
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    statuses.push((await app.get('/', { headers: { 'x-api-key': `rotated-${i}` } })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429], 'rotation must not bypass the limit');

  assert.equal(
    (await app.get('/', { headers: { 'x-api-key': 'good-key' } })).status,
    200,
    'a recognised key gets its own bucket'
  );
});

test('a throwing identifier or skip callback becomes a 500, never a hung request', async (t) => {
  const store = new MemoryStore({ autoCleanup: false });
  const app = await serve((a) => {
    a.get(
      '/identifier',
      rateLimiter({
        store,
        scope: 'throws',
        identifier: () => {
          throw new Error('boom');
        }
      }),
      (req, res) => res.json({ ok: true })
    );
    a.get(
      '/skip',
      rateLimiter({
        store,
        scope: 'throws',
        skip: () => {
          throw new Error('boom');
        }
      }),
      (req, res) => res.json({ ok: true })
    );
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  assert.equal((await app.get('/identifier')).status, 500);
  assert.equal((await app.get('/skip')).status, 500);
});

test('a store failure surfaces as a 500 rather than an unhandled rejection', async (t) => {
  const brokenStore = {
    async checkLimit() {
      throw new Error('store exploded');
    },
    async reset() {}
  };
  const app = await serve((a) => {
    a.get('/', rateLimiter({ store: brokenStore, scope: 'broken' }), (req, res) =>
      res.json({ ok: true })
    );
  });
  t.after(() => app.close());

  assert.equal((await app.get('/')).status, 500);
});

test('an identifier of null lets the request through and is counted', async (t) => {
  const store = new MemoryStore({ autoCleanup: false });
  const limiter = rateLimiter({
    requestsPerMinute: 1,
    capacity: 1,
    scope: 'none',
    store,
    identifier: () => null,
    logger: { warn() {} }
  });
  const app = await serve((a) => {
    a.get('/', limiter, (req, res) => res.json({ ok: true }));
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  assert.equal((await app.get('/')).status, 200);
  assert.equal((await app.get('/')).status, 200);
  assert.equal(limiter.metrics.unidentified, 2);
});

test('a custom handler owns the rejection response', async (t) => {
  const store = new MemoryStore({ autoCleanup: false });
  const app = await serve((a) => {
    a.get(
      '/',
      rateLimiter({
        requestsPerMinute: 1,
        capacity: 1,
        scope: 'custom',
        store,
        handler: (req, res) => res.status(418).json({ error: 'CUSTOM' })
      }),
      (req, res) => res.json({ ok: true })
    );
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  assert.equal((await app.get('/')).status, 200);
  const denied = await app.get('/');
  assert.equal(denied.status, 418);
  assert.equal((await denied.json()).error, 'CUSTOM');
  assert.equal(denied.headers.get('ratelimit-remaining'), '0', 'headers still applied');
});

test('configuration errors are thrown at wire-up, not on the first request', () => {
  assert.throws(() => rateLimiter({ requestsPerMinute: -1 }), RangeError);
  assert.throws(() => rateLimiter({ requestsPerMinute: NaN }), TypeError);
  assert.throws(() => rateLimiter({ requestsPerMinute: 10, cost: 20 }), /cost/);
  assert.throws(() => rateLimiter({ scope: 'not a scope' }), RangeError);
  assert.throws(() => rateLimiter({ identifier: 'nope' }), TypeError);
  assert.throws(() => rateLimiter({ store: {} }), /checkLimit/);
});

test('limiters share one default store, so N limiters cost one cleanup timer', async (t) => {
  t.after(() => rateLimiter.closeSharedMemoryStore());

  const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const limiters = [];
  for (let i = 0; i < 5; i += 1) limiters.push(rateLimiter({ requestsPerMinute: 10 + i }));
  const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

  assert.equal(after - before, 0, 'the shared store timer is unref()d and reused');
  assert.equal(new Set(limiters.map((l) => l.store)).size, 1);
  assert.equal(new Set(limiters.map((l) => l.scope)).size, 5, 'distinct limits, distinct scopes');
});

test('an unreachable Redis fails fast instead of hanging the request', async (t) => {
  // The whole point of the degraded path: a dead backend must not hold sockets
  // open. Port 1 is closed, so this exercises connect failure, not a timeout.
  const store = new RedisStore({
    port: 1,
    connectTimeoutMs: 200,
    commandTimeoutMs: 200,
    reconnectCooldownMs: 50,
    logger: { error() {}, warn() {}, log() {} }
  });
  const app = await serve((a) => {
    a.get('/', rateLimiter({ requestsPerMinute: 5, scope: 'down', store }), (req, res) =>
      res.json({ ok: true })
    );
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  const startedAt = Date.now();
  const res = await app.get('/');
  const elapsed = Date.now() - startedAt;

  assert.equal(res.status, 200, 'failOpen defaults to allowing traffic');
  assert.ok(elapsed < 3000, `request took ${elapsed}ms; it must be bounded`);
  assert.equal(store.metrics.degradedAllowed, 1);
});

test('failOpen: false rejects with a finite Retry-After while Redis is down', async (t) => {
  const store = new RedisStore({
    port: 1,
    failOpen: false,
    connectTimeoutMs: 200,
    commandTimeoutMs: 200,
    reconnectCooldownMs: 50,
    logger: { error() {}, warn() {}, log() {} }
  });
  const app = await serve((a) => {
    a.get('/', rateLimiter({ requestsPerMinute: 5, scope: 'down-closed', store }), (req, res) =>
      res.json({ ok: true })
    );
  });
  t.after(async () => {
    await app.close();
    await store.close();
  });

  const res = await app.get('/');
  assert.equal(res.status, 429);
  assert.equal(Number(res.headers.get('retry-after')), 1);
  assert.equal(store.metrics.degradedDenied, 1);
});
