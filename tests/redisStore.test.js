'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const RedisStore = require('../src/storage/redisStore');

/**
 * These tests need a real Redis. They are skipped (not failed) when none is
 * reachable, so `npm test` stays useful on a laptop without one:
 *
 *   redis-server --port 6379 &
 *   TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
 */
const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
const KEY_PREFIX = 'ratelimit-test:';

function parseTarget(url) {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

function probe({ host, port }, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

let available = false;
const silent = { error() {}, warn() {}, log() {}, info() {} };

function newStore(options = {}) {
  return new RedisStore({
    url: TEST_REDIS_URL,
    keyPrefix: KEY_PREFIX,
    logger: silent,
    ...options
  });
}

test.before(async () => {
  available = await probe(parseTarget(TEST_REDIS_URL));
  if (!available) return;

  const store = newStore();
  await store.connect();
  await store.resetAll();
  await store.close();
});

const LIMIT_3 = { scope: 'redis-strict', capacity: 3, refillRate: 3 / 60 };

test('two independent store instances share one bucket', async (t) => {
  if (!available) return t.skip(`no Redis at ${TEST_REDIS_URL}`);

  const serverA = newStore();
  const serverB = newStore();
  t.after(async () => {
    await serverA.resetAll();
    await serverA.close();
    await serverB.close();
  });

  assert.equal((await serverA.checkLimit('shared-client', LIMIT_3)).allowed, true);
  assert.equal((await serverB.checkLimit('shared-client', LIMIT_3)).allowed, true);
  assert.equal((await serverA.checkLimit('shared-client', LIMIT_3)).allowed, true);

  const denied = await serverB.checkLimit('shared-client', LIMIT_3);
  assert.equal(denied.allowed, false, 'the fourth request must be rejected by either server');
  assert.equal(denied.remaining, 0);
  assert.ok(denied.retryAfterMs > 0 && Number.isFinite(denied.retryAfterMs));
});

test('scopes keep endpoints independent', async (t) => {
  if (!available) return t.skip(`no Redis at ${TEST_REDIS_URL}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await store.checkLimit('ip-1', LIMIT_3)).allowed, true);
  }
  assert.equal((await store.checkLimit('ip-1', LIMIT_3)).allowed, false);

  const relaxed = await store.checkLimit('ip-1', {
    scope: 'redis-relaxed',
    capacity: 100,
    refillRate: 2
  });
  assert.equal(relaxed.allowed, true);
  assert.equal(relaxed.limit, 100);
  assert.equal(relaxed.remaining, 99);
});

test('key TTL is derived from the refill horizon, not fixed', async (t) => {
  if (!available) return t.skip(`no Redis at ${TEST_REDIS_URL}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  // 10 tokens at 1/s: full refill takes 10s, plus the 60s padding.
  await store.checkLimit('ttl-client', { scope: 'ttl', capacity: 10, refillRate: 1 });
  const state = await store.getBucketState('ttl-client', { scope: 'ttl' });

  assert.ok(state, 'bucket should exist');
  assert.ok(state.ttlSeconds > 0 && state.ttlSeconds <= 70, `ttl was ${state.ttlSeconds}`);
  assert.equal(store.ttlFor(10, 1), 70);
  assert.equal(store.ttlFor(1000, 0.1), 10_060);
});

test('a rejected request does not rewrite bucket state but keeps the key alive', async (t) => {
  if (!available) return t.skip(`no Redis at ${TEST_REDIS_URL}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  const limit = { scope: 'no-write', capacity: 1, refillRate: 1 / 3600 };
  assert.equal((await store.checkLimit('client', limit)).allowed, true);

  const afterConsume = await store.getBucketState('client', { scope: 'no-write' });
  assert.equal((await store.checkLimit('client', limit)).allowed, false);
  const afterDeny = await store.getBucketState('client', { scope: 'no-write' });

  assert.equal(afterDeny.lastRefill, afterConsume.lastRefill, 'denied requests write no state');
  assert.ok(afterDeny.ttlSeconds > 0, 'but the TTL is still refreshed');
});

test('the script survives SCRIPT FLUSH via a NOSCRIPT reload', async (t) => {
  if (!available) return t.skip(`no Redis at ${TEST_REDIS_URL}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  await store.checkLimit('flush-client', LIMIT_3);
  await store.client.scriptFlush();

  const after = await store.checkLimit('flush-client', LIMIT_3);
  assert.equal(after.allowed, true);
  assert.ok(store.metrics.scriptReloads >= 1, 'reloaded the script instead of failing');
});

test('tokens refill using the Redis clock', async (t) => {
  if (!available) return t.skip(`no Redis at ${TEST_REDIS_URL}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  // 20 tokens/s: 250ms of real time must return roughly 5 tokens.
  const limit = { scope: 'refill', capacity: 10, refillRate: 20 };
  for (let i = 0; i < 10; i += 1) await store.checkLimit('refill-client', limit);
  assert.equal((await store.checkLimit('refill-client', limit)).allowed, false);

  await new Promise((resolve) => setTimeout(resolve, 250));

  const resumed = await store.checkLimit('refill-client', limit);
  assert.equal(resumed.allowed, true);
  assert.ok(resumed.remaining >= 2, `expected several tokens back, saw ${resumed.remaining}`);
});

test('stats use SCAN, count by scope, and never leak identifiers', async (t) => {
  if (!available) return t.skip(`no Redis at ${TEST_REDIS_URL}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  await store.checkLimit('SECRET_API_KEY', LIMIT_3);
  await store.checkLimit('1.2.3.4', { scope: 'other', capacity: 5, refillRate: 1 });

  const stats = await store.getStats();
  assert.equal(stats.available, true);
  assert.equal(stats.totalClients, 2);
  assert.deepEqual(stats.byScope, { 'redis-strict': 1, other: 1 });
  assert.equal(JSON.stringify(stats).includes('SECRET_API_KEY'), false);

  const detailed = await store.getStats({ includeIdentifiers: true });
  assert.equal(JSON.stringify(detailed).includes('SECRET_API_KEY'), false);
  assert.equal(detailed.sampledClients.length, 2);
});

test('reset clears one scope or all of them', async (t) => {
  if (!available) return t.skip(`no Redis at ${TEST_REDIS_URL}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  await store.checkLimit('reset-me', LIMIT_3);
  await store.checkLimit('reset-me', { scope: 'other', capacity: 5, refillRate: 1 });

  assert.equal(await store.reset('reset-me', { scope: 'redis-strict' }), 1);
  assert.equal(await store.reset('reset-me'), 1, 'the remaining scope is cleared without one');
});

test('ping reports health, and close is safe when never connected', async (t) => {
  if (!available) return t.skip(`no Redis at ${TEST_REDIS_URL}`);

  const store = newStore();
  const health = await store.ping();
  assert.equal(health.healthy, true);
  assert.ok(health.latencyMs >= 0);
  await store.close();

  const neverConnected = new RedisStore({ port: 1, logger: silent });
  await neverConnected.close();
});

test('an unreachable Redis reports unhealthy without throwing', async () => {
  const store = new RedisStore({
    port: 1,
    connectTimeoutMs: 200,
    reconnectCooldownMs: 50,
    logger: silent
  });

  const health = await store.ping();
  assert.equal(health.healthy, false);
  assert.ok(health.error);

  const stats = await store.getStats();
  assert.equal(stats.available, false);
  assert.equal(stats.totalClients, null);

  await store.close();
});

test('rejects a port that cannot be a port', () => {
  assert.throws(() => new RedisStore({ port: 'not-a-port' }), RangeError);
  assert.throws(() => new RedisStore({ commandTimeoutMs: -5 }), RangeError);
  // `{ port: undefined }` must fall back to the default rather than be spread over it.
  assert.equal(new RedisStore({ port: undefined }).options.port, 6379);
});
