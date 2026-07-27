'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const RedisStore = require('../src/storage/redisStore');

/**
 * These need a real Redis Cluster and are skipped, not failed, when one isn't
 * reachable:
 *
 *   redis-cli --cluster create \
 *     127.0.0.1:7000 127.0.0.1:7001 127.0.0.1:7002 \
 *     --cluster-replicas 0 --cluster-yes
 *
 *   TEST_REDIS_CLUSTER_NODES=127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002 npm test
 *
 * A 3-master, no-replica cluster is enough to exercise sharding, cross-slot
 * aggregation, and one-shard-down degradation. It does not exercise failover
 * (no replicas to promote), which is a different, narrower claim.
 */
const NODES = (process.env.TEST_REDIS_CLUSTER_NODES ?? '127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((hostPort) => {
    const [host, port] = hostPort.split(':');
    return { host, port: Number(port) };
  });

const KEY_PREFIX = 'ratelimit-cluster-test:';
const silent = { error() {}, warn() {}, log() {}, info() {} };

function probe({ host, port }, timeoutMs = 300) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (r) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

let available = false;

function newStore(options = {}) {
  return new RedisStore({
    rootNodes: NODES.map((n) => ({ host: n.host, port: n.port })),
    keyPrefix: KEY_PREFIX,
    logger: silent,
    ...options
  });
}

test.before(async () => {
  const reachable = await Promise.all(NODES.map((n) => probe(n)));
  available = reachable.every(Boolean);
  if (!available) return;

  const store = newStore();
  await store.connect();
  await store.resetAll();
  await store.close();
});

const LIMIT_3 = { scope: 'cluster-strict', capacity: 3, refillRate: 3 / 60 };

/**
 * Keys that are known (empirically, against this fixed 3-master layout) to
 * land on different masters, so aggregation tests actually exercise more
 * than one node instead of accidentally hashing to the same shard.
 */
const SPREAD_IDENTIFIERS = ['a', 'b', 'c', 'd', 'e', 'f'];

test('connects to a cluster and discovers all masters', async (t) => {
  if (!available) return t.skip(`no reachable Redis Cluster at ${JSON.stringify(NODES)}`);

  const store = newStore();
  t.after(() => store.close());

  await store.connect();
  assert.equal(store.isCluster, true);
  assert.ok(store.client.masters.length >= 3, 'expected at least the 3 masters created for this test');
});

test('checkLimit enforces correctly regardless of which master owns the key', async (t) => {
  if (!available) return t.skip(`no reachable Redis Cluster at ${JSON.stringify(NODES)}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  for (const id of SPREAD_IDENTIFIERS) {
    for (let i = 0; i < 3; i += 1) {
      const r = await store.checkLimit(id, LIMIT_3);
      assert.equal(r.allowed, true, `identifier ${id} request ${i} should be allowed`);
    }
    const denied = await store.checkLimit(id, LIMIT_3);
    assert.equal(denied.allowed, false, `identifier ${id} should be rejected on the 4th request`);
  }
});

test('the script is loaded on every master, not just the first one touched', async (t) => {
  // Regression: node-redis's own scriptLoad() on a cluster client only loads
  // the script onto one node, so EVALSHA fails with NOSCRIPT for keys that
  // hash elsewhere. loadScript() must fan out to every master explicitly.
  if (!available) return t.skip(`no reachable Redis Cluster at ${JSON.stringify(NODES)}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });
  await store.connect();

  const shas = await Promise.all(store.client.masters.map((m) => m.client.scriptExists(store.scriptSha)));
  for (const [exists] of shas) {
    // node-redis returns 1/0 here, not a boolean.
    assert.equal(Boolean(exists), true, 'every master must already have the script loaded');
  }

  // And functionally: every identifier must succeed on the very first call,
  // with no NOSCRIPT round trip needed regardless of which shard it lands on.
  const before = store.metrics.scriptReloads;
  for (const id of SPREAD_IDENTIFIERS) {
    await store.checkLimit(id, { scope: 'preload-check', capacity: 5, refillRate: 1 });
  }
  assert.equal(store.metrics.scriptReloads, before, 'no reload should have been necessary');
});

test('a mid-flight SCRIPT FLUSH on one master recovers via NOSCRIPT reload', async (t) => {
  if (!available) return t.skip(`no reachable Redis Cluster at ${JSON.stringify(NODES)}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });
  await store.connect();

  // Flush every master's script cache, simulating a restart / cache eviction
  // that does not coordinate across the cluster.
  await Promise.all(store.client.masters.map((m) => m.client.scriptFlush()));

  const before = store.metrics.scriptReloads;
  for (const id of SPREAD_IDENTIFIERS) {
    const r = await store.checkLimit(id, { scope: 'flush-recovery', capacity: 5, refillRate: 1 });
    assert.equal(r.allowed, true);
  }
  assert.ok(store.metrics.scriptReloads > before, 'NOSCRIPT should have triggered at least one reload');
});

test('scopes stay isolated across shards, same as single-node', async (t) => {
  if (!available) return t.skip(`no reachable Redis Cluster at ${JSON.stringify(NODES)}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  for (let i = 0; i < 3; i += 1) {
    assert.equal((await store.checkLimit('shared-client', LIMIT_3)).allowed, true);
  }
  assert.equal((await store.checkLimit('shared-client', LIMIT_3)).allowed, false);

  const relaxed = await store.checkLimit('shared-client', {
    scope: 'cluster-relaxed',
    capacity: 100,
    refillRate: 2
  });
  assert.equal(relaxed.allowed, true, 'a different scope must not be blocked by the exhausted one');
});

test('getStats aggregates SCAN across every master (SCAN is per-node)', async (t) => {
  // Regression: SCAN cursors are only meaningful on the node that issued
  // them. Calling SCAN through the cluster client without fanning out to
  // every master silently reports and clears only whichever node the client
  // happened to route the command to.
  if (!available) return t.skip(`no reachable Redis Cluster at ${JSON.stringify(NODES)}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  for (const id of SPREAD_IDENTIFIERS) {
    await store.checkLimit(id, { scope: 'stats-scope', capacity: 5, refillRate: 1 });
  }

  // Confirm the identifiers actually landed on more than one master - if they
  // all landed on one, this test would pass without exercising aggregation.
  const perNodeCounts = await Promise.all(
    store.client.masters.map(async (m) => {
      let cursor = '0';
      let count = 0;
      do {
        const reply = await m.client.scan(cursor, { MATCH: `${KEY_PREFIX}stats-scope|*`, COUNT: 100 });
        cursor = String(reply.cursor);
        count += reply.keys.length;
      } while (cursor !== '0');
      return count;
    })
  );
  assert.ok(
    perNodeCounts.filter((n) => n > 0).length > 1,
    `test identifiers must spread across multiple masters to be a real test of aggregation, saw ${JSON.stringify(perNodeCounts)}`
  );

  const stats = await store.getStats();
  assert.equal(stats.available, true);
  assert.equal(stats.byScope['stats-scope'], SPREAD_IDENTIFIERS.length);
  assert.equal(
    stats.totalClients,
    perNodeCounts.reduce((a, b) => a + b, 0),
    'aggregated total must equal the sum across all masters'
  );
});

test('resetAll deletes cross-slot keys without a CROSSSLOT error', async (t) => {
  // Regression: a single multi-key DEL across keys that do not share a slot
  // fails outright on a real cluster ("CROSSSLOT Keys in request don't hash
  // to the same slot"). Deletion must be per-key (or per-slot), not batched
  // the way the single-node store batches it.
  if (!available) return t.skip(`no reachable Redis Cluster at ${JSON.stringify(NODES)}`);

  const store = newStore();
  t.after(() => store.close());

  for (const id of SPREAD_IDENTIFIERS) {
    await store.checkLimit(id, { scope: 'reset-all-scope', capacity: 5, refillRate: 1 });
  }

  const removed = await store.resetAll();
  assert.equal(removed, SPREAD_IDENTIFIERS.length);

  const stats = await store.getStats();
  assert.equal(stats.totalClients, 0);
});

test('reset without a scope removes an identifier from every shard it touched', async (t) => {
  if (!available) return t.skip(`no reachable Redis Cluster at ${JSON.stringify(NODES)}`);

  const store = newStore();
  t.after(async () => {
    await store.resetAll();
    await store.close();
  });

  await store.checkLimit('multi-scope-client', { scope: 'scope-a', capacity: 5, refillRate: 1 });
  await store.checkLimit('multi-scope-client', { scope: 'scope-b', capacity: 5, refillRate: 1 });

  const removed = await store.reset('multi-scope-client');
  assert.equal(removed, 2);
});

test('one master down degrades only the shards that hash to it, not the whole store', async (t) => {
  // This is the headline behavioural difference from single-node Redis: there,
  // any outage fails every bucket open (or closed). On a cluster with no
  // replicas, killing one master only takes down its ~1/3 of the keyspace;
  // buckets on the other two masters must keep enforcing normally throughout.
  if (!available) return t.skip(`no reachable Redis Cluster at ${JSON.stringify(NODES)}`);
  if (NODES.length < 3) return t.skip('needs at least 3 masters to have an "other shard" to check');

  const store = newStore({ commandTimeoutMs: 300, connectTimeoutMs: 300, reconnectCooldownMs: 100 });
  t.after(async () => {
    await store.resetAll().catch(() => {});
    await store.close();
  });
  await store.connect();

  // Write through the store for a spread of identifiers, kill one master, then
  // classify each identifier as degraded or not by trying it again. Both
  // groups are expected to be non-empty on a healthy 3-master cluster with 24
  // spread identifiers (16384 slots split ~evenly across 3 masters).
  const candidates = Array.from({ length: 24 }, (_, i) => `kill-test-${i}`);
  for (const id of candidates) {
    await store.checkLimit(id, { scope: 'kill-test', capacity: 5, refillRate: 1 });
  }

  store.client.masters[0].client.destroy();

  const results = [];
  for (const id of candidates) {
    const r = await store.checkLimit(id, { scope: 'kill-test', capacity: 5, refillRate: 1 });
    results.push({ id, allowed: r.allowed, degraded: r.degraded });
  }

  const degraded = results.filter((r) => r.degraded);
  const healthy = results.filter((r) => !r.degraded);

  assert.ok(
    degraded.length > 0,
    `expected at least one of ${candidates.length} identifiers to hash to the killed master`
  );
  assert.ok(
    healthy.length > 0,
    'expected at least one identifier to hash to a surviving master and stay enforced normally'
  );
  for (const r of degraded) {
    assert.equal(r.allowed, true, 'default failOpen must still allow degraded requests');
  }
});
