'use strict';

const TokenBucket = require('../algorithms/tokenBucket');
const { assertNumber, assertFunction } = require('../internal/validate');
const { normalizeIdentifier, normalizeScope, hashIdentifier } = require('../internal/identity');

/**
 * In-process store. Correct for a single server; use RedisStore for more.
 *
 * Implements the store contract shared with RedisStore:
 *
 *   checkLimit(identifier, { scope, capacity, refillRate, tokens }) =>
 *     { allowed, limit, remaining, retryAfterMs, resetMs, degraded }
 *
 *   retryAfterMs: 0 when allowed, Infinity when unsatisfiable
 *   resetMs:      ms until the bucket is back at capacity (0 when full)
 *
 * Buckets are keyed by `scope|identifier`: two limiters with different limits
 * must never share a bucket, or the stricter limit is silently widened.
 */
class MemoryStore {
  /**
   * @param {object} [options]
   * @param {number} [options.maxClients=100000] - hard bound on tracked clients (LRU eviction)
   * @param {number} [options.cleanupIntervalMs=600000] - sweep period
   * @param {number} [options.inactiveAfterMs=3600000] - idle age at which a bucket is dropped
   * @param {boolean} [options.autoCleanup=true]
   * @param {() => number} [options.now] - injectable clock, for tests
   */
  constructor(options = {}) {
    this.maxClients = assertNumber(options.maxClients ?? 100_000, 'maxClients', { integer: true });
    this.cleanupIntervalMs = assertNumber(
      options.cleanupIntervalMs ?? 10 * 60 * 1000,
      'cleanupIntervalMs'
    );
    this.inactiveAfterMs = assertNumber(
      options.inactiveAfterMs ?? 60 * 60 * 1000,
      'inactiveAfterMs'
    );
    this.now = options.now ? assertFunction(options.now, 'options.now') : Date.now;

    /** @type {Map<string, TokenBucket>} insertion order doubles as LRU order */
    this.buckets = new Map();
    this.cleanupInterval = null;
    this.metrics = { allowed: 0, denied: 0, evicted: 0, swept: 0 };

    if (options.autoCleanup !== false) this.startCleanup();
  }

  /**
   * @param {string} scope
   * @param {string} identifier
   * @returns {string} `scope` is validated to exclude `|`, so the first
   *   separator is unambiguous even when the identifier contains one.
   */
  getKey(scope, identifier) {
    return `${scope}|${identifier}`;
  }

  /**
   * Fetch or create a bucket, reconciling configuration drift.
   *
   * A bucket created under one configuration must not keep serving another:
   * that is how `X-RateLimit-Limit` ends up advertising 100 for a bucket that
   * physically holds 5.
   */
  getBucket(key, capacity, refillRate) {
    const existing = this.buckets.get(key);
    if (existing) {
      // Touch for LRU ordering.
      this.buckets.delete(key);
      this.buckets.set(key, existing);
      existing.reconfigure(capacity, refillRate);
      return existing;
    }

    const bucket = new TokenBucket(capacity, refillRate, { now: this.now });
    this.buckets.set(key, bucket);
    this.evictIfNeeded();
    return bucket;
  }

  /**
   * Drop least-recently-used buckets past the bound.
   *
   * Without this, an attacker rotating an attacker-controlled identifier (an
   * API key header, an IPv6 address from a /64) grows the map without limit.
   * Evicting a bucket only ever grants its owner a fresh allowance, so the
   * bound trades a little enforcement fidelity for a hard memory ceiling.
   */
  evictIfNeeded() {
    while (this.buckets.size > this.maxClients) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) break;
      this.buckets.delete(oldest.value);
      this.metrics.evicted += 1;
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
    const bucket = this.getBucket(key, capacity, refillRate);

    const allowed = bucket.consume(tokens);
    if (allowed) this.metrics.allowed += 1;
    else this.metrics.denied += 1;

    return {
      allowed,
      limit: bucket.capacity,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: allowed ? 0 : bucket.getRetryAfter(tokens),
      resetMs: bucket.getResetMs(),
      degraded: false
    };
  }

  /**
   * @param {string} identifier
   * @param {{scope?: string}} [options] - omit to clear the identifier in every scope
   * @returns {Promise<number>} buckets removed
   */
  async reset(identifier, options = {}) {
    const id = normalizeIdentifier(identifier);

    if (options.scope !== undefined) {
      return this.buckets.delete(this.getKey(normalizeScope(options.scope), id)) ? 1 : 0;
    }

    let removed = 0;
    const suffix = `|${id}`;
    for (const key of this.buckets.keys()) {
      if (key.endsWith(suffix)) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * @returns {Promise<number>} buckets removed
   */
  async resetAll() {
    const removed = this.buckets.size;
    this.buckets.clear();
    return removed;
  }

  /**
   * Counts and per-scope cardinality only.
   *
   * Identifiers are credentials in the API-key configuration the README
   * documents, so they are never returned by default; when explicitly
   * requested they are hashed.
   *
   * @param {{includeIdentifiers?: boolean, sampleLimit?: number}} [options]
   */
  async getStats(options = {}) {
    const byScope = {};
    const sample = [];

    for (const key of this.buckets.keys()) {
      const scope = key.slice(0, key.indexOf('|'));
      byScope[scope] = (byScope[scope] ?? 0) + 1;
      if (options.includeIdentifiers && sample.length < (options.sampleLimit ?? 100)) {
        sample.push({ scope, identifierHash: hashIdentifier(key.slice(key.indexOf('|') + 1)) });
      }
    }

    const stats = {
      backend: 'memory',
      totalClients: this.buckets.size,
      maxClients: this.maxClients,
      byScope,
      metrics: { ...this.metrics }
    };
    if (options.includeIdentifiers) stats.sampledClients = sample;
    return stats;
  }

  /**
   * Drop buckets idle longer than `inactiveAfterMs`.
   *
   * The timer is unref'd: a rate limiter must never be the reason a process
   * refuses to exit (six middleware instances used to mean six live timers).
   */
  startCleanup(intervalMs = this.cleanupIntervalMs) {
    if (this.cleanupInterval) return this.cleanupInterval;

    this.cleanupInterval = setInterval(() => this.sweep(), intervalMs);
    if (typeof this.cleanupInterval.unref === 'function') this.cleanupInterval.unref();
    return this.cleanupInterval;
  }

  /**
   * @returns {number} buckets removed
   */
  sweep() {
    const now = this.now();
    let removed = 0;

    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > this.inactiveAfterMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    this.metrics.swept += removed;
    return removed;
  }

  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Symmetry with RedisStore.close(), so callers can shut down either backend
   * without knowing which one they hold.
   */
  async close() {
    this.stopCleanup();
    this.buckets.clear();
  }
}

module.exports = MemoryStore;
