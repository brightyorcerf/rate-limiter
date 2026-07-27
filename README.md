# API Rate Limiter

Distributed rate limiting for Express, using a token bucket over Redis or memory.

---

## Tech Stack

### Node.js + Express
Rate limiting is I/O bound, not CPU bound. Node's event loop handles concurrent requests well, and Express middleware makes integration a one-liner. Rust or Go would have been overkill.

### Redis
- Atomic read-refill-consume via a Lua script (no double spending across servers)
- Sub-millisecond operations, so the added latency stays small (measure it yourself: `npm run bench`)
- TTLs derived from each bucket's refill time, so idle clients expire on their own

Tried PostgreSQL first; the latency was noticeable even at moderate load.

---

## How It Works

### The token bucket

Every client holds a bucket of tokens. Tokens accrue continuously at `requestsPerMinute / 60` per second and are capped at `capacity`, which is what makes bursts possible. A request costs one token; no token, no request.

```
1. Request hits the middleware
2. Resolve the client identifier (IP, API key, ...)
3. Read the bucket for (scope, identifier)
4. Add the tokens accrued since the last read
5. Try to spend one
6. Success -> next()      Failure -> 429 with Retry-After
```

Nothing runs on a timer: the bucket is a token count plus the timestamp it was last touched, so its current state is always derivable on read.

### Why the Lua script

This is the naive version, and it is wrong:

```javascript
tokens = redis.get('tokens')
if (tokens > 0) redis.set('tokens', tokens - 1)
```

Between the `get` and the `set`, another server reads the same count and spends the same token. Both requests are allowed; the limit is not.

The whole cycle therefore runs inside one Lua script, which Redis executes atomically:

```lua
local t   = redis.call('TIME')                 -- one clock for every server
local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

local state  = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(state[1]) or capacity

local elapsed = now - (tonumber(state[2]) or now)
if elapsed < 0 then elapsed = 0 end            -- a backwards clock mints nothing
tokens = math.min(capacity, tokens + (elapsed / 1000) * rate)

if requested <= capacity and tokens >= requested then
  redis.call('HSET', key, 'tokens', tokens - requested, 'last_refill', now)
  return { 1, ... }                            -- allowed
end
return { 0, ... }                              -- rejected
```

Two details matter as much as the atomicity:

- **Time comes from Redis, not from the caller.** Passing the application server's `Date.now()` into the script means a fleet with skewed clocks writes timestamps from the future, and every other node then computes negative elapsed time and *removes* tokens.
- **A rejected request writes no state.** The token count is a pure function of `last_refill`, so there is nothing to update; only the TTL is refreshed. Under a flood, rejections cost one write instead of two.

The script is registered once with `SCRIPT LOAD` and invoked by SHA (`EVALSHA`), with an automatic reload if Redis restarts and forgets it.

### Buckets are namespaced by scope

A client is not one bucket, it is one bucket *per limiter*:

```
ratelimit:<scope>|<identifier>
```

Without the scope, every limiter sharing a store shares a bucket, and then a 5 req/min endpoint and a 120 req/min endpoint fight over the same token count: exhausting the strict one locks you out of the relaxed one, and whichever request arrived last decides the capacity. `scope` defaults to a hash of the limiter's own limits, which is stable across processes (so distributed limiting still works) and distinct per configuration.

### Architecture

```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  Server 1   │      │  Server 2   │      │  Server 3   │
│   :3000     │      │   :3001     │      │   :3002     │
└──────┬──────┘      └──────┬──────┘      └──────┬──────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                     ┌──────▼──────┐
                     │             │
                     │    Redis    │
                     │             │
                     └─────────────┘
```

Every server pointed at the same Redis shares one bucket per (scope, identifier), and Redis supplies the clock, so limits hold across the fleet rather than per process.

### Redis Cluster

Pass `rootNodes` instead of `host`/`port`/`url` and `RedisStore` switches to `redis.createCluster`:

```javascript
const store = new RedisStore({
  rootNodes: [
    { url: 'redis://10.0.0.1:6379' },
    { url: 'redis://10.0.0.2:6379' },
    { url: 'redis://10.0.0.3:6379' }
  ]
});
```

`checkLimit` itself is slot-safe for free: every call touches exactly one key, so the cluster client routes it to the right shard with no extra work. Everything else on a cluster touches every shard and had to be built explicitly, because none of it is a native cluster-wide operation:

- **Script loading** fans out `SCRIPT LOAD` to every master individually. A cluster client only loads the script onto the node it happens to route to; the others would answer `EVALSHA` with `NOSCRIPT` the first time they saw a key. A `NOSCRIPT` response triggers a reload on just that node.
- **`getStats()` and `resetAll()`** scan every master separately and merge the results. `SCAN`'s cursor is only meaningful to the node that issued it - there is no such thing as a cluster-wide scan.
- **Multi-key `DEL`** (clearing every scope for one identifier) is done key-by-key with bounded concurrency instead of one batched command, because the keys can land on different masters and a cross-shard `DEL` fails outright with `CROSSSLOT`.
- **A single master going down degrades only the slots it owns.** Cluster errors are counted and logged but never flip the store's overall readiness the way a single-node disconnect does - the other two-thirds of your keyspace keeps enforcing normally.

Covered by `tests/redisCluster.test.js` (9 tests) against a live 3-node cluster; see [Testing](#testing) for how to point the suite at one.

---

## When Redis is unavailable

A rate limiter sits in front of every request, so its failure mode is the service's failure mode. This one is explicit:

- Commands are **not** queued while the socket is down, so they fail immediately instead of piling up.
- Every check is raced against `commandTimeoutMs` (default 250ms).
- Connection attempts are rate limited to one per `reconnectCooldownMs`, so a dead Redis costs one attempt per second rather than one per request.
- `failOpen` decides what happens next: `true` (default) allows the request, `false` rejects it with `Retry-After: 1`. Both paths are counted in `store.metrics` (`degradedAllowed` / `degradedDenied`), and repeated errors are logged once per window instead of once per request.
- `/health` reports 503 while Redis is unreachable, so a load balancer can route around the instance.

Measured on this repo with Redis killed mid-traffic: requests complete in 1-2ms on the degraded path, and enforcement resumes on its own once Redis returns.

---

## Measured cost

```
$ BENCH_REQUESTS=3000 npm run bench        # node v22.18.0, macOS, local Redis

configuration       rps       p50 ms    p95 ms    p99 ms    added p50
no rate limiting    1487      0.50      0.84      2.04      +0.00 ms
MemoryStore         1596      0.53      0.89      2.46      +0.02 ms
RedisStore          1039      0.89      1.39      3.25      +0.38 ms
```

Reproduce with `npm run bench`; the harness is [tests/bench.js](tests/bench.js). Read these as a delta, not a service level: it is loopback traffic, the handler does no work, and the load generator shares the event loop with the server (which is why concurrency defaults to 1 - it is the only setting where the numbers isolate per-request cost). On a real handler the limiter's share is proportionally much smaller.

---

## Installation

### Quick start (in-memory)

```bash
git clone <your-fork-url> rateguard
cd rateguard
npm install

npm start

# 5 allowed, then 429
for i in $(seq 1 7); do curl -s -o /dev/null -w '%{http_code} ' http://127.0.0.1:3000/api/expensive; done
```

### Production (Redis)

```bash
brew install redis          # macOS
# sudo apt-get install redis-server   # Debian/Ubuntu

redis-server &

ADMIN_TOKEN=$(openssl rand -hex 24) npm run start:redis

# second instance, same Redis, shared limits
PORT=3001 SERVER_ID=server2 npm run start:redis

curl http://127.0.0.1:3000/api/expensive
curl http://127.0.0.1:3001/api/expensive   # spends from the same bucket
```

Requires Node 18.17 or newer.

---

## Usage

### Basic Express integration

```javascript
const rateLimiter = require('rateguard');

// Aggregate net. Mounted before the routes, or it only ever runs on 404s.
app.use(rateLimiter({ requestsPerMinute: 300, scope: 'global' }));

// Per-route limit. A request passing through both limiters spends a token in
// each, so keep the aggregate looser than anything it sits above.
app.post('/api/expensive', rateLimiter({ requestsPerMinute: 5, scope: 'expensive' }), handler);
```

Limiters that do not bring their own store share one in-memory store, so ten limiters cost one cleanup timer rather than ten.

### With Redis (multi-server)

```javascript
const { createRateLimiter, RedisStore } = require('rateguard');

const store = new RedisStore({
  url: process.env.REDIS_URL,       // or host/port/password
  failOpen: true,                   // allow traffic if Redis is down
  commandTimeoutMs: 250
});
await store.connect();              // optional; the first request connects too

app.use(createRateLimiter({ requestsPerMinute: 100, scope: 'global', store }));

// on SIGTERM
await store.close();
```

### Custom identifiers (API keys)

```javascript
const known = new Set(await loadApiKeys());

app.use(rateLimiter({
  requestsPerMinute: 10,
  scope: 'api-key',
  // Validate before trusting: an unvalidated header means a client can mint a
  // fresh bucket per request just by changing it.
  identifier: (req) => {
    const key = req.headers['x-api-key'];
    return known.has(key) ? `key:${key}` : req.ip;
  }
}));
```

### Behind a proxy or load balancer

`req.ip` is the socket address unless Express is told otherwise, so behind a proxy every client collapses into the proxy's bucket:

```javascript
app.set('trust proxy', 1);   // number of proxies you actually control
```

Only do this if the proxy **overwrites** `X-Forwarded-For` rather than appending to a client-supplied value — otherwise the header becomes a free bypass. The middleware logs a warning once if it sees `X-Forwarded-For` while `trust proxy` is unset.

---

## Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `requestsPerMinute` | number | `60` | Sustained rate. `0` rejects everything. |
| `capacity` | number | `requestsPerMinute` | Burst size (max tokens held). |
| `cost` | number | `1` | Tokens spent per request. Must not exceed `capacity`. |
| `scope` | string | hash of the limits | Bucket namespace. Set it explicitly for readable Redis keys. |
| `store` | object | shared `MemoryStore` | `MemoryStore` or `RedisStore`. |
| `identifier` | function | `(req) => req.ip` | Client identity. Return a falsy value to skip. |
| `skip` | function | `() => false` | Bypass condition. |
| `handler` | function | `null` | Custom rejection response. |
| `headers` | boolean | `true` | Emit the `RateLimit-*` / `X-RateLimit-*` headers. |
| `message` | string | `"Too many requests..."` | Message in the default 429 body. |
| `statusCode` | number | `429` | Rejection status. |
| `logger` | object | `console` | Anything with `warn`/`error`/`log`. |

Invalid configuration throws at wire-up rather than misbehaving per request: `NaN`, negative values, a `cost` above `capacity`, a malformed `scope`, or a store missing `checkLimit` are all rejected immediately.

### RedisStore options

| Option | Default | Description |
|--------|---------|-------------|
| `url` / `host` / `port` | `127.0.0.1:6379` | `url` wins when both are given. Ignored in cluster mode. |
| `rootNodes` | unset | Array of `{ url }` or `{ host, port }`. Presence switches to Redis Cluster mode (`redis.createCluster`); see [Redis Cluster](#redis-cluster). |
| `username` / `password` / `db` | - | Passed through to node-redis. `db` is not supported in cluster mode (Redis Cluster is always db 0). |
| `socket` | `{}` | Merged into the socket options (TLS, etc.). |
| `keyPrefix` | `ratelimit:` | Key namespace. |
| `failOpen` | `true` | Allow (`true`) or reject (`false`) when Redis is unusable. |
| `commandTimeoutMs` | `250` | Per-request budget for the Lua call. |
| `connectTimeoutMs` | `1000` | Connect / `SCRIPT LOAD` budget. |
| `reconnectCooldownMs` | `1000` | Minimum gap between connect attempts. |
| `minTtlSeconds` / `maxTtlSeconds` / `ttlPaddingSeconds` | `60` / `86400` / `60` | Bounds for the derived key TTL. |
| `degradedRetryAfterMs` | `1000` | `Retry-After` used when failing closed. |
| `logIntervalMs` | `5000` | Error-log throttle window. |

### MemoryStore options

| Option | Default | Description |
|--------|---------|-------------|
| `maxClients` | `100000` | Hard bound on tracked clients (LRU eviction beyond it). |
| `cleanupIntervalMs` | `600000` | Sweep period. The timer is `unref()`d. |
| `inactiveAfterMs` | `3600000` | Idle age at which a bucket is dropped. |
| `autoCleanup` | `true` | Set `false` to sweep manually. |

---

## Response headers

| Header | Meaning |
|--------|---------|
| `RateLimit-Limit` / `X-RateLimit-Limit` | Bucket capacity in force |
| `RateLimit-Remaining` / `X-RateLimit-Remaining` | Whole tokens left |
| `RateLimit-Reset` | Seconds until the bucket is back at capacity |
| `X-RateLimit-Reset` | The same instant as an ISO-8601 timestamp |
| `Retry-After` | Seconds until the next token, on rejection only. Never `0`, and omitted entirely when waiting cannot help (a limiter that never refills). |

Both storage backends produce identical values for the same state.

---

## Admin endpoints (Redis demo)

They only exist when `ADMIN_TOKEN` is set (16+ characters), and they require a bearer token compared in constant time. `reset` clears a client's limit and `stats` enumerates buckets, so leaving either open defeats the limiter.

```bash
export ADMIN_TOKEN=$(openssl rand -hex 24)

# counts and per-scope cardinality; identifiers are never returned in the clear
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3000/api/admin/stats

# hashed identifiers, if you need to correlate without exposing API keys
curl -H "Authorization: Bearer $ADMIN_TOKEN" 'http://127.0.0.1:3000/api/admin/stats?identifiers=hashed'

# clear one scope, or every scope for that client
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  'http://127.0.0.1:3000/api/admin/reset/1.2.3.4?scope=expensive'

curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  'http://127.0.0.1:3000/api/admin/bucket/1.2.3.4?scope=expensive'
```

`GET /health` needs no token and reports Redis reachability, latency, and the `failOpen` setting.

---

## Testing

```bash
npm test                                                                          # unit + integration
TEST_REDIS_URL=redis://127.0.0.1:6379 npm test                                    # + the Redis suite
TEST_REDIS_CLUSTER_NODES=127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002 npm test    # + the cluster suite
npm run bench                                                                      # latency harness
```

54 tests over the bucket arithmetic, both storage backends, and the middleware. The Redis- and cluster-backed tests skip themselves when their target isn't reachable rather than failing. Covered explicitly, because each one was once broken:

- exhausting a strict endpoint must not affect a relaxed one
- rotating an unrecognised API key must not mint quota
- `requestsPerMinute: 0` must reject without advertising an impossible retry
- a throwing `identifier`/`skip`/store must become a 500, never a hung request
- an unreachable Redis must answer in bounded time, both fail-open and fail-closed
- waiting exactly `Retry-After` must be enough to succeed
- a clock moving backwards must neither mint nor destroy tokens
- stats must never return identifiers in the clear
- on a cluster, a downed master must only degrade the slots it owns
- on a cluster, `EVALSHA` must not `NOSCRIPT` on a master the client didn't happen to route to first

[tests/tests.txt](tests/tests.txt) is the manual curl runbook, including the multi-server checks.

---

## Environment variables (demos)

| Variable | Default | Applies to |
|----------|---------|-----------|
| `PORT` | `3000` | both |
| `ADMIN_TOKEN` | unset | both - admin routes and the bypass are disabled without it |
| `API_KEYS` | `demo-key-1,demo-key-2` | both - comma-separated allowlist |
| `LOG_CLIENT_IPS` | unset | both - log raw IPs instead of hashes |
| `REDIS_URL` / `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | `127.0.0.1:6379` | Redis demo |
| `FAIL_OPEN` | `1` | Redis demo - `0` rejects while Redis is down |
| `REQUIRE_REDIS` | unset | Redis demo - `1` refuses to start without Redis |
| `SERVER_ID` | `primary` | Redis demo - identifies the instance in responses |

Both demos drain on `SIGTERM` and `SIGINT`: the listener stops, in-flight requests get 10 seconds, then Redis is closed and the process exits 0.

---

## What this project taught me

- Atomicity is the easy part. The hard parts are the key design around the script, whose clock the arithmetic trusts, and what happens when the dependency is gone.
- A limiter's error path is a security control: fail-open during an outage means no limits at all, so it has to be a deliberate, visible choice.
- Any identity a client can choose is not an identity. Validate it, or bound the damage.
- Admin endpoints on a rate limiter are the rate limiter. Unauthenticated `reset` is a bypass, and unauthenticated `stats` leaks whatever you used as an identifier.

Points to talk about:
- Distributed systems (multi-server coordination, one clock, atomic scripts)
- Race conditions and how the Lua script prevents them
- Performance trade-offs (Redis vs Postgres vs in-memory)
- Production concerns (bounded failure, TTL derivation, graceful shutdown, metrics, monitoring)

---

## License

MIT - see [LICENSE](LICENSE).
