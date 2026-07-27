'use strict';

const redis = require('redis');
const { assertNumber, withTimeout } = require('../internal/validate');
const { normalizeIdentifier, normalizeScope, hashIdentifier } = require('../internal/identity');

/**
 * Distributed store. Multiple servers share one bucket per (scope, identifier).
 *
 * Implements the same contract as MemoryStore:
 *
 *   checkLimit(identifier, { scope, capacity, refillRate, tokens }) =>
 *     { allowed, limit, remaining, retryAfterMs, resetMs, degraded }
 *
 * Three properties matter here and each one is load-bearing:
 *
 *   Atomic    - the whole read/refill/consume cycle runs inside one Lua script,
 *               so concurrent servers cannot double-spend a token.
 *   One clock - the script reads time from Redis (`TIME`), not from the caller.
 *               Client wall clocks disagree; a bucket shared between servers
 *               with skewed clocks refills at the wrong rate or goes backwards.
 *   Bounded   - a Redis that is down, slow, or unreachable can never hold a
 *               request open. Commands fail fast (offline queue disabled), are
 *               raced against `commandTimeoutMs`, and connect attempts are
 *               rate limited so a dead Redis costs one attempt per cooldown.
 *
 * Redis Cluster (pass `rootNodes` instead of `host`/`port`/`url`) is supported
 * on top of the same three properties, with the differences that come from
 * sharding across masters:
 *
 *   - `checkLimit` still touches exactly one key, so it stays atomic and
 *     "one clock" per bucket - a single bucket always lives on the same
 *     master, which supplies its own `TIME`. Clocks *between* masters can
 *     still disagree; that only matters if you compare timestamps across
 *     buckets, which nothing here does.
 *   - `getStats()`/`resetAll()`/scoped `reset()` fan out to every master and
 *     aggregate (SCAN and multi-key DEL are not cluster-wide operations on
 *     their own), so they cost one round trip per master instead of one.
 *   - Bounded failure is now per-shard: a single master being down degrades
 *     only the buckets whose keys hash to it. The other masters keep
 *     enforcing normally, which is different from the single-node case where
 *     any outage degrades every bucket.
 */

/**
 * KEYS[1] = bucket key
 * ARGV[1] = capacity            ARGV[3] = tokens requested
 * ARGV[2] = refill rate (per s) ARGV[4] = key ttl (seconds)
 *
 * Returns { allowed, remaining, retry_after_ms, reset_ms } where a retry or
 * reset of -1 means "never" (a zero refill rate, or a request larger than the
 * bucket can ever hold).
 */
const LUA_TOKEN_BUCKET = `
  -- TIME is non-deterministic, so ask for effect replication where available.
  if redis.replicate_commands then redis.replicate_commands() end

  local key       = KEYS[1]
  local capacity  = tonumber(ARGV[1])
  local rate      = tonumber(ARGV[2])
  local requested = tonumber(ARGV[3])
  local ttl       = tonumber(ARGV[4])

  local t   = redis.call('TIME')
  local now = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)

  local state       = redis.call('HMGET', key, 'tokens', 'last_refill')
  local tokens      = tonumber(state[1])
  local last_refill = tonumber(state[2])

  if tokens == nil or last_refill == nil then
    tokens = capacity
    last_refill = now
  end

  -- A backwards clock must not mint or destroy tokens.
  local elapsed = now - last_refill
  if elapsed < 0 then elapsed = 0 end
  tokens = math.min(capacity, tokens + (elapsed / 1000) * rate)

  local allowed = 0
  if requested <= capacity and tokens >= requested then
    tokens = tokens - requested
    allowed = 1
  end

  if allowed == 1 then
    redis.call('HSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', key, ttl)
  else
    -- Nothing was consumed. Token count is a pure function of last_refill, so
    -- rewriting identical state would only amplify writes under a flood; the
    -- TTL still has to be refreshed, or a sustained attack would expire its
    -- own bucket and be handed a full one.
    if redis.call('EXISTS', key) == 1 then
      redis.call('EXPIRE', key, ttl)
    end
  end

  local retry_after = 0
  local reset_ms = 0

  if allowed == 0 then
    if requested > capacity or rate <= 0 then
      retry_after = -1
    else
      retry_after = math.ceil(((requested - tokens) / rate) * 1000)
    end
  end

  if tokens < capacity then
    if rate <= 0 then
      reset_ms = -1
    else
      reset_ms = math.ceil(((capacity - tokens) / rate) * 1000)
    end
  end

  return { allowed, math.floor(tokens), retry_after, reset_ms }
`;

class RedisStore {
  /**
   * @param {object} [options]
   * @param {string} [options.url] - redis[s]://... ; takes precedence over host/port
   * @param {string} [options.host='127.0.0.1']
   * @param {number} [options.port=6379]
   * @param {string} [options.username]
   * @param {string} [options.password]
   * @param {number} [options.db=0]
   * @param {object} [options.socket] - merged into the node-redis socket options (TLS, etc.)
   * @param {Array<{url?: string, host?: string, port?: number}>} [options.rootNodes] -
   *   presence switches to Redis Cluster mode (`redis.createCluster`). At least 3 nodes
   *   recommended, so topology discovery survives any single node being down. `host`/`port`/
   *   `url`/`db` above are ignored in this mode; `username`/`password`/`socket` still apply,
   *   to every node.
   * @param {string} [options.keyPrefix='ratelimit:']
   * @param {boolean} [options.failOpen=true] - allow (true) or reject (false) when Redis is unusable
   * @param {number} [options.commandTimeoutMs=250] - per-request budget for the Lua call
   * @param {number} [options.connectTimeoutMs=1000]
   * @param {number} [options.reconnectCooldownMs=1000] - min gap between connect attempts
   * @param {number} [options.ttlPaddingSeconds=60]
   * @param {object} [options.logger=console]
   * @param {number} [options.logIntervalMs=5000] - throttle window for repeated errors
   */
  constructor(options = {}) {
    const isCluster = Array.isArray(options.rootNodes);
    if (options.rootNodes !== undefined && !isCluster) {
      throw new TypeError('rootNodes must be an array when provided');
    }
    if (isCluster && options.rootNodes.length === 0) {
      throw new RangeError('rootNodes must contain at least one node');
    }

    // Defaults first, caller's values second, and no blind spread of the raw
    // options object afterwards: `{ port: undefined }` used to overwrite the
    // resolved default with undefined.
    this.options = {
      url: options.url,
      host: options.host ?? '127.0.0.1',
      port: options.port === undefined ? 6379 : Number(options.port),
      rootNodes: isCluster ? options.rootNodes : null,
      username: options.username,
      password: options.password,
      db: options.db ?? 0,
      socket: options.socket ?? {},
      keyPrefix: options.keyPrefix ?? 'ratelimit:',
      failOpen: options.failOpen !== false,
      commandTimeoutMs: assertNumber(options.commandTimeoutMs ?? 250, 'commandTimeoutMs'),
      connectTimeoutMs: assertNumber(options.connectTimeoutMs ?? 1000, 'connectTimeoutMs'),
      reconnectCooldownMs: assertNumber(
        options.reconnectCooldownMs ?? 1000,
        'reconnectCooldownMs'
      ),
      ttlPaddingSeconds: assertNumber(options.ttlPaddingSeconds ?? 60, 'ttlPaddingSeconds'),
      minTtlSeconds: assertNumber(options.minTtlSeconds ?? 60, 'minTtlSeconds'),
      maxTtlSeconds: assertNumber(options.maxTtlSeconds ?? 24 * 60 * 60, 'maxTtlSeconds'),
      degradedRetryAfterMs: assertNumber(
        options.degradedRetryAfterMs ?? 1000,
        'degradedRetryAfterMs'
      ),
      logger: options.logger ?? console,
      logIntervalMs: assertNumber(options.logIntervalMs ?? 5000, 'logIntervalMs', {
        allowZero: true
      })
    };

    if (!isCluster && (!Number.isFinite(this.options.port) || this.options.port <= 0)) {
      throw new RangeError(`port must be a positive number, received ${options.port}`);
    }

    this.isCluster = isCluster;
    this.client = null;
    this.isReady = false;
    this.closed = false;
    this.connectPromise = null;
    this.nextConnectAttemptAt = 0;
    this.scriptSha = null;
    this.lastLoggedAt = new Map();

    this.metrics = {
      allowed: 0,
      denied: 0,
      degradedAllowed: 0,
      degradedDenied: 0,
      storeErrors: 0,
      connects: 0,
      scriptReloads: 0
    };
  }

  /**
   * @param {string} scope
   * @param {string} identifier
   * @returns {string}
   */
  getKey(scope, identifier) {
    return `${this.options.keyPrefix}${scope}|${identifier}`;
  }

  /**
   * TTL is derived from how long the bucket needs to refill, not fixed at an
   * hour: too short hands a depleted client a full bucket, too long pins dead
   * clients in memory.
   */
  ttlFor(capacity, refillRate) {
    const { ttlPaddingSeconds, minTtlSeconds, maxTtlSeconds } = this.options;
    if (refillRate <= 0) return maxTtlSeconds;

    const secondsToFull = Math.ceil(capacity / refillRate);
    return Math.min(maxTtlSeconds, Math.max(minTtlSeconds, secondsToFull + ttlPaddingSeconds));
  }

  /**
   * Open the connection and load the script. Safe to call repeatedly and
   * concurrently: overlapping callers share one attempt instead of each
   * building a client and leaking the losers.
   */
  async connect() {
    if (this.isReady) return;
    if (this.closed) throw new Error('RedisStore has been closed');
    if (this.connectPromise) return this.connectPromise;

    if (Date.now() < this.nextConnectAttemptAt) {
      throw this.offlineError('connect attempt suppressed by cooldown');
    }

    this.connectPromise = this.openClient()
      .catch((err) => {
        this.nextConnectAttemptAt = Date.now() + this.options.reconnectCooldownMs;
        this.teardownClient();
        throw err;
      })
      .finally(() => {
        this.connectPromise = null;
      });

    return this.connectPromise;
  }

  /** @private */
  async openClient() {
    const { connectTimeoutMs } = this.options;
    const client = this.isCluster ? this.buildClusterClient() : this.buildSingleClient();

    // An unhandled 'error' event on a node-redis client is fatal to the
    // process, so this listener is attached before connecting.
    //
    // For a single node, 'error' means *the* connection is broken, so it is
    // treated as global unreadiness - ensureReady() then fails fast instead of
    // waiting on a socket that is reconnecting. A cluster client re-emits
    // every underlying node's errors on itself, and one dead node in an
    // otherwise healthy cluster must not degrade traffic for the other slots,
    // so cluster errors are counted and logged but do not flip readiness;
    // whichever request actually hits the dead node's slot fails and is
    // caught per-request by checkLimit()'s own try/catch instead.
    client.on('error', (err) => {
      if (!this.isCluster) this.isReady = false;
      this.metrics.storeErrors += 1;
      this.logThrottled('error', `redis-error:${err.code ?? err.name}`, err.message);
    });
    // The cluster client has no 'ready' event (only 'connect'); readiness is
    // instead set once `connect()` resolves below, for both shapes.
    if (!this.isCluster) {
      client.on('ready', () => {
        this.isReady = true;
        this.nextConnectAttemptAt = 0;
        this.logThrottled('info', 'redis-ready', 'connection ready');
      });
      client.on('reconnecting', () => {
        this.isReady = false;
      });
    }
    client.on('end', () => {
      this.isReady = false;
      // Drop the reference unless we closed on purpose, so the next request
      // can build a fresh client instead of talking to a dead one.
      if (!this.closed && this.client === client) {
        this.client = null;
        this.scriptSha = null;
      }
    });

    this.client = client;
    await withTimeout(client.connect(), connectTimeoutMs, 'redis connect');
    this.isReady = true;
    this.metrics.connects += 1;
    if (this.isCluster) this.logThrottled('info', 'redis-ready', 'cluster connection ready');

    await this.loadScript();
  }

  /** @private */
  buildSingleClient() {
    const { url, host, port, username, password, db, socket, connectTimeoutMs } = this.options;

    return redis.createClient({
      ...(url ? { url } : {}),
      socket: {
        ...(url ? {} : { host, port }),
        connectTimeout: connectTimeoutMs,
        // Bounded backoff, and it never gives up: a store that stops retrying
        // silently degrades forever.
        reconnectStrategy: (retries) => Math.min(2000, 50 * 2 ** Math.min(retries, 6)),
        ...socket
      },
      ...(username ? { username } : {}),
      ...(password ? { password } : {}),
      database: db,
      // Fail commands immediately instead of queueing them while the socket is
      // down. The queue is what let a Redis outage hang every request forever.
      disableOfflineQueue: true
    });
  }

  /**
   * Redis Cluster does not accept a `SELECT`ed database (always db 0), and
   * `rootNodes` replaces `host`/`port`/`url` as the discovery mechanism -
   * `defaults` applies auth/socket settings to every node the client opens,
   * including ones discovered later via `MOVED`/topology refresh.
   *
   * @private
   */
  buildClusterClient() {
    const { rootNodes, username, password, socket, connectTimeoutMs } = this.options;

    return redis.createCluster({
      rootNodes: rootNodes.map((node) =>
        node.url ? { url: node.url } : { socket: { host: node.host, port: node.port } }
      ),
      defaults: {
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
        socket: {
          connectTimeout: connectTimeoutMs,
          reconnectStrategy: (retries) => Math.min(2000, 50 * 2 ** Math.min(retries, 6)),
          ...socket
        },
        disableOfflineQueue: true
      }
    });
  }

  /**
   * Load the token-bucket script.
   *
   * On a single node this is one SCRIPT LOAD. On a cluster it must run on
   * every master individually: EVALSHA is routed by key slot to whichever
   * master owns it, and SCRIPT LOAD does not propagate between nodes on its
   * own - loading it against only one node leaves EVALSHA failing with
   * NOSCRIPT for every key that happens to hash to a different master.
   *
   * @private
   */
  async loadScript() {
    try {
      if (this.isCluster) {
        const masters = this.client.masters ?? [];
        const shas = await withTimeout(
          Promise.all(masters.map((node) => node.client.scriptLoad(LUA_TOKEN_BUCKET))),
          this.options.connectTimeoutMs,
          'redis SCRIPT LOAD (cluster)'
        );
        // SHA1 is a pure function of the script's bytes, so every node loads
        // the same value - this is a sanity check, not a merge.
        this.scriptSha = shas[0] ?? null;
      } else {
        this.scriptSha = await withTimeout(
          this.client.scriptLoad(LUA_TOKEN_BUCKET),
          this.options.connectTimeoutMs,
          'redis SCRIPT LOAD'
        );
      }
    } catch (err) {
      // Not fatal: checkLimit falls back to loading it on first use.
      this.scriptSha = null;
      this.logThrottled('warn', 'script-load', `SCRIPT LOAD failed: ${err.message}`);
    }
  }

  /** @private */
  offlineError(reason) {
    const err = new Error(`redis unavailable (${reason})`);
    err.code = 'ERR_REDIS_OFFLINE';
    return err;
  }

  /**
   * Resolve to a usable client or throw quickly.
   *
   * When a client exists but is not ready, node-redis is already reconnecting
   * in the background; waiting on it is exactly the behaviour that turned a
   * Redis blip into hung requests, so this throws instead.
   *
   * @private
   */
  async ensureReady() {
    if (this.isReady && this.client) return this.client;
    if (this.client) throw this.offlineError('connection not ready');

    await this.connect();
    if (!this.isReady || !this.client) throw this.offlineError('connect did not complete');
    return this.client;
  }

  /**
   * EVALSHA, with one reload on NOSCRIPT (Redis restart, SCRIPT FLUSH, or on a
   * cluster: a newly promoted or newly joined master that never received the
   * script). Shipping the full script on every request wastes bandwidth and
   * parse time.
   *
   * @private
   */
  async runScript(key, args) {
    if (!this.scriptSha) await this.loadScript();
    if (!this.scriptSha) this.scriptSha = await this.client.scriptLoad(LUA_TOKEN_BUCKET);

    try {
      return await this.client.evalSha(this.scriptSha, { keys: [key], arguments: args });
    } catch (err) {
      if (!String(err.message ?? '').includes('NOSCRIPT')) throw err;

      this.metrics.scriptReloads += 1;
      // Re-fan-out to every current master, not just a single scriptLoad: the
      // node this key hashes to may not be the node that was missing it.
      await this.loadScript();
      if (!this.scriptSha) this.scriptSha = await this.client.scriptLoad(LUA_TOKEN_BUCKET);
      return this.client.evalSha(this.scriptSha, { keys: [key], arguments: args });
    }
  }

  /**
   * @param {string} identifier
   * @param {{scope: string, capacity: number, refillRate: number, tokens?: number}} options
   * @returns {Promise<object>} see the contract in the class comment
   */
  async checkLimit(identifier, options = {}) {
    const scope = normalizeScope(options.scope ?? 'default');
    const capacity = assertNumber(options.capacity, 'capacity', { allowZero: true });
    const refillRate = assertNumber(options.refillRate, 'refillRate', { allowZero: true });
    const tokens = assertNumber(options.tokens ?? 1, 'tokens');

    const key = this.getKey(scope, normalizeIdentifier(identifier));
    const ttl = this.ttlFor(capacity, refillRate);

    try {
      await this.ensureReady();

      const reply = await withTimeout(
        this.runScript(key, [
          String(capacity),
          String(refillRate),
          String(tokens),
          String(ttl)
        ]),
        this.options.commandTimeoutMs,
        'redis rate-limit script'
      );

      const [allowed, remaining, retryAfterMs, resetMs] = reply.map(Number);
      if (allowed === 1) this.metrics.allowed += 1;
      else this.metrics.denied += 1;

      return {
        allowed: allowed === 1,
        limit: capacity,
        remaining,
        // -1 is the script's sentinel for "never".
        retryAfterMs: retryAfterMs < 0 ? Infinity : retryAfterMs,
        resetMs: resetMs < 0 ? Infinity : resetMs,
        degraded: false
      };
    } catch (err) {
      return this.degrade(err, capacity);
    }
  }

  /**
   * Explicit, documented, metered behaviour when the backend is unusable.
   *
   * `failOpen: true` keeps traffic flowing at the cost of unlimited requests
   * during an outage; `failOpen: false` protects the upstream at the cost of
   * rejecting real users. There is no correct default for every service, so
   * the choice is a constructor option and every occurrence is counted.
   *
   * @private
   */
  degrade(err, capacity) {
    this.metrics.storeErrors += 1;
    this.logThrottled(
      'error',
      `degraded:${err.code ?? 'ERR'}`,
      `rate limit check failed (${err.message}); failing ${this.options.failOpen ? 'open' : 'closed'}`
    );

    if (this.options.failOpen) {
      this.metrics.degradedAllowed += 1;
      return {
        allowed: true,
        limit: capacity,
        remaining: capacity,
        retryAfterMs: 0,
        resetMs: 0,
        degraded: true
      };
    }

    this.metrics.degradedDenied += 1;
    return {
      allowed: false,
      limit: capacity,
      remaining: 0,
      retryAfterMs: this.options.degradedRetryAfterMs,
      resetMs: this.options.degradedRetryAfterMs,
      degraded: true
    };
  }

  /**
   * @param {string} identifier
   * @param {{scope?: string}} [options] - omit to clear the identifier in every scope
   * @returns {Promise<number>} keys removed
   */
  async reset(identifier, options = {}) {
    await this.ensureReady();
    const id = normalizeIdentifier(identifier);

    if (options.scope !== undefined) {
      return this.client.del(this.getKey(normalizeScope(options.scope), id));
    }

    const keys = await this.scanKeys(`${this.options.keyPrefix}*|${id}`);
    return this.deleteKeys(keys);
  }

  /**
   * @returns {Promise<number>} keys removed
   */
  async resetAll() {
    await this.ensureReady();
    const keys = await this.scanKeys(`${this.options.keyPrefix}*`);
    return this.deleteKeys(keys);
  }

  /**
   * DEL a set of keys that may span multiple hash slots.
   *
   * On a single node, one multi-key DEL (batched) is cheapest. On a cluster,
   * a multi-key DEL across slots fails outright with CROSSSLOT, so each key
   * has to go in its own command; those are issued with bounded concurrency
   * rather than one at a time; correct routing to whichever master owns each
   * key is handled by the cluster client itself.
   *
   * @private
   * @param {string[]} keys
   */
  async deleteKeys(keys) {
    if (keys.length === 0) return 0;

    if (!this.isCluster) {
      // One DEL with a million arguments blocks the server just as badly as
      // the KEYS call this replaced, so it goes in batches too.
      let removed = 0;
      for (let i = 0; i < keys.length; i += 500) {
        removed += await this.client.del(keys.slice(i, i + 500));
      }
      return removed;
    }

    const concurrency = 50;
    let removed = 0;
    for (let i = 0; i < keys.length; i += concurrency) {
      const results = await Promise.all(
        keys.slice(i, i + concurrency).map((key) => this.client.del(key))
      );
      removed += results.reduce((sum, n) => sum + n, 0);
    }
    return removed;
  }

  /**
   * Cursor-based key enumeration. KEYS is O(N) and blocks the single-threaded
   * server for the whole scan.
   *
   * On a cluster, SCAN is per-node: a cursor from one master means nothing to
   * another, so the client has no cluster-wide cursor to hand back. Each
   * master's keyspace is scanned independently and the results concatenated.
   *
   * @private
   * @param {string} match
   * @param {number} [limit=100000] - safety bound on how much we will hold
   */
  async scanKeys(match, limit = 100_000) {
    if (this.isCluster) {
      const found = [];
      for (const node of this.client.masters ?? []) {
        found.push(...(await this.scanNode(node.client, match, limit - found.length)));
        if (found.length >= limit) break;
      }
      return found;
    }
    return this.scanNode(this.client, match, limit);
  }

  /** @private */
  async scanNode(nodeClient, match, limit) {
    const found = [];
    // node-redis 5 requires the cursor as a string and throws on a number.
    let cursor = '0';

    do {
      const reply = await nodeClient.scan(cursor, { MATCH: match, COUNT: 500 });
      cursor = String(reply.cursor);
      found.push(...reply.keys);
    } while (cursor !== '0' && found.length < limit);

    return found;
  }

  /**
   * Counts and per-scope cardinality. Identifiers are credentials in the
   * API-key configuration, so they are never returned in the clear.
   *
   * @param {{includeIdentifiers?: boolean, sampleLimit?: number}} [options]
   */
  async getStats(options = {}) {
    const base = {
      backend: 'redis',
      connected: this.isReady,
      metrics: { ...this.metrics }
    };

    try {
      await this.ensureReady();
    } catch (err) {
      return { ...base, available: false, reason: err.code ?? 'ERR', totalClients: null };
    }

    const keys = await this.scanKeys(`${this.options.keyPrefix}*`);
    const byScope = {};
    const sample = [];

    for (const key of keys) {
      const withoutPrefix = key.slice(this.options.keyPrefix.length);
      const separator = withoutPrefix.indexOf('|');
      const scope = separator === -1 ? 'unknown' : withoutPrefix.slice(0, separator);
      byScope[scope] = (byScope[scope] ?? 0) + 1;

      if (options.includeIdentifiers && sample.length < (options.sampleLimit ?? 100)) {
        sample.push({
          scope,
          identifierHash: hashIdentifier(withoutPrefix.slice(separator + 1))
        });
      }
    }

    const stats = { ...base, available: true, totalClients: keys.length, byScope };
    if (options.includeIdentifiers) stats.sampledClients = sample;
    return stats;
  }

  /**
   * Raw bucket state, for debugging.
   *
   * @param {string} identifier
   * @param {{scope: string}} options
   */
  async getBucketState(identifier, options = {}) {
    await this.ensureReady();
    const key = this.getKey(
      normalizeScope(options.scope ?? 'default'),
      normalizeIdentifier(identifier)
    );

    const [state, ttl] = await Promise.all([this.client.hGetAll(key), this.client.ttl(key)]);
    if (!state || state.tokens === undefined) return null;

    return {
      tokens: Number.parseFloat(state.tokens),
      lastRefill: Number.parseInt(state.last_refill, 10),
      ttlSeconds: ttl,
      key
    };
  }

  /**
   * @returns {Promise<{healthy: boolean, latencyMs: number|null, error?: string}>}
   */
  async ping() {
    const startedAt = Date.now();
    try {
      await this.ensureReady();
      await withTimeout(this.client.ping(), this.options.commandTimeoutMs, 'redis PING');
      return { healthy: true, latencyMs: Date.now() - startedAt };
    } catch (err) {
      return { healthy: false, latencyMs: null, error: err.code ?? err.message };
    }
  }

  /** @private */
  teardownClient() {
    const client = this.client;
    this.client = null;
    this.isReady = false;
    this.scriptSha = null;
    if (!client) return;

    try {
      client.destroy();
    } catch {
      // Already gone; nothing useful to do.
    }
  }

  /**
   * Not gated on connection state: a client that never reached 'ready' still
   * holds a socket and a reconnect timer, which used to keep the process alive.
   */
  async close() {
    this.closed = true;
    const client = this.client;
    if (!client) return;

    try {
      await withTimeout(client.quit(), this.options.connectTimeoutMs, 'redis QUIT');
      this.client = null;
      this.isReady = false;
      this.scriptSha = null;
    } catch {
      this.teardownClient();
    }
  }

  /**
   * Collapse repeated messages to one per window. During an outage the naive
   * version emitted one line per request, which amplified the incident.
   *
   * @private
   */
  logThrottled(level, dedupeKey, message) {
    const { logger, logIntervalMs } = this.options;
    const now = Date.now();
    const last = this.lastLoggedAt.get(dedupeKey) ?? 0;
    if (now - last < logIntervalMs) return;

    this.lastLoggedAt.set(dedupeKey, now);
    const write = logger[level] ?? logger.log;
    if (typeof write === 'function') write.call(logger, `[RedisStore] ${message}`);
  }
}

module.exports = RedisStore;
module.exports.LUA_TOKEN_BUCKET = LUA_TOKEN_BUCKET;
