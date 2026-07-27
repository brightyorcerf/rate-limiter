'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const MemoryStore = require('../src/storage/memoryStore');

const LIMIT_5 = { scope: 'strict', capacity: 5, refillRate: 5 / 60 };
const LIMIT_100 = { scope: 'relaxed', capacity: 100, refillRate: 2 };

test('scopes isolate limits sharing one store', async () => {
  // Regression: a single key per client meant exhausting a 5/min endpoint also
  // locked out a 120/min endpoint, and the surviving bucket kept whichever
  // capacity was written last.
  const store = new MemoryStore({ autoCleanup: false });

  for (let i = 0; i < 5; i += 1) {
    assert.equal((await store.checkLimit('1.2.3.4', LIMIT_5)).allowed, true);
  }
  const denied = await store.checkLimit('1.2.3.4', LIMIT_5);
  assert.equal(denied.allowed, false);
  assert.equal(denied.limit, 5);

  const other = await store.checkLimit('1.2.3.4', LIMIT_100);
  assert.equal(other.allowed, true, 'the relaxed scope must be untouched');
  assert.equal(other.limit, 100);
  assert.equal(other.remaining, 99);

  await store.close();
});

test('reported limit always matches the bucket actually in force', async () => {
  const store = new MemoryStore({ autoCleanup: false });

  const first = await store.checkLimit('ip', { scope: 'same', capacity: 5, refillRate: 1 });
  assert.equal(first.limit, 5);

  // Same scope, different configuration: the bucket is reconciled rather than
  // silently serving the old capacity behind a new advertised limit.
  const second = await store.checkLimit('ip', { scope: 'same', capacity: 100, refillRate: 2 });
  assert.equal(second.limit, 100);
  assert.equal(store.buckets.get('same|ip').capacity, 100);

  await store.close();
});

test('identifiers are normalised so one client cannot hold two buckets', async () => {
  const store = new MemoryStore({ autoCleanup: false });

  await store.checkLimit('::ffff:127.0.0.1', LIMIT_5);
  const second = await store.checkLimit('127.0.0.1', LIMIT_5);

  assert.equal(store.buckets.size, 1);
  assert.equal(second.remaining, 3, 'both requests hit the same bucket');

  await store.close();
});

test('client count is bounded by maxClients (LRU eviction)', async () => {
  const store = new MemoryStore({ autoCleanup: false, maxClients: 10 });

  for (let i = 0; i < 100; i += 1) {
    await store.checkLimit(`client-${i}`, LIMIT_5);
  }

  assert.equal(store.buckets.size, 10);
  assert.equal(store.metrics.evicted, 90);
  await store.close();
});

test('sweep drops idle buckets and keeps active ones', async () => {
  let now = 1_000_000;
  const store = new MemoryStore({
    autoCleanup: false,
    inactiveAfterMs: 60_000,
    now: () => now
  });

  await store.checkLimit('idle', LIMIT_5);
  now += 120_000;
  await store.checkLimit('active', LIMIT_5);

  assert.equal(store.sweep(), 1);
  assert.deepEqual([...store.buckets.keys()], ['strict|active']);
  await store.close();
});

test('the cleanup timer never keeps the process alive', () => {
  const store = new MemoryStore();
  assert.ok(store.cleanupInterval, 'cleanup runs by default');
  assert.equal(store.cleanupInterval.hasRef(), false, 'timer must be unref()d');
  store.stopCleanup();
  assert.equal(store.cleanupInterval, null);
});

test('stats never expose identifiers unless explicitly asked, and then hashed', async () => {
  const store = new MemoryStore({ autoCleanup: false });
  await store.checkLimit('SECRET_API_KEY', LIMIT_5);

  const stats = await store.getStats();
  assert.equal(stats.totalClients, 1);
  assert.deepEqual(stats.byScope, { strict: 1 });
  assert.equal(JSON.stringify(stats).includes('SECRET_API_KEY'), false);

  const detailed = await store.getStats({ includeIdentifiers: true });
  assert.equal(detailed.sampledClients.length, 1);
  assert.equal(JSON.stringify(detailed).includes('SECRET_API_KEY'), false);
  assert.match(detailed.sampledClients[0].identifierHash, /^[0-9a-f]{16}$/);

  await store.close();
});

test('reset clears one scope or every scope for an identifier', async () => {
  const store = new MemoryStore({ autoCleanup: false });
  await store.checkLimit('ip', LIMIT_5);
  await store.checkLimit('ip', LIMIT_100);

  assert.equal(await store.reset('ip', { scope: 'strict' }), 1);
  assert.equal(store.buckets.size, 1);

  await store.checkLimit('ip', LIMIT_5);
  assert.equal(await store.reset('ip'), 2, 'no scope clears them all');
  assert.equal(store.buckets.size, 0);

  await store.close();
});

test('invalid check options are rejected rather than coerced', async () => {
  const store = new MemoryStore({ autoCleanup: false });

  await assert.rejects(() => store.checkLimit('ip', { scope: 'x', capacity: -1, refillRate: 1 }));
  await assert.rejects(() => store.checkLimit('ip', { scope: 'x', capacity: 5, refillRate: NaN }));
  await assert.rejects(
    () => store.checkLimit('ip', { scope: 'bad scope!', capacity: 5, refillRate: 1 }),
    /scope/
  );

  await store.close();
});
