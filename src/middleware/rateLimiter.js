'use strict';

const MemoryStore = require('../storage/memoryStore');
const { assertNumber, assertFunction, assertStore } = require('../internal/validate');
const { normalizeIdentifier, normalizeScope, scopeFor } = require('../internal/identity');

/**
 * Express rate limiting middleware.
 *
 *   const rateLimiter = require('./middleware/rateLimiter');
 *   app.use(rateLimiter({ requestsPerMinute: 60 }));
 *   app.post('/api/expensive', rateLimiter({ requestsPerMinute: 5, scope: 'expensive' }), handler);
 *
 * Ordering matters: middleware only protects what is registered after it.
 * A limiter mounted below the routes runs on 404s and nothing else.
 *
 * Composition matters too: a request passing through two limiters spends a
 * token in each, so the effective limit is the strictest one on the path.
 */

// One shared store for every limiter that does not bring its own. Buckets are
// namespaced by scope, so sharing is safe - and it means N limiters cost one
// cleanup timer instead of N.
let sharedMemoryStore = null;

function getSharedMemoryStore() {
  if (!sharedMemoryStore) sharedMemoryStore = new MemoryStore();
  return sharedMemoryStore;
}

/**
 * Release the shared store (tests, graceful shutdown).
 * @returns {Promise<void>}
 */
async function closeSharedMemoryStore() {
  if (!sharedMemoryStore) return;
  const store = sharedMemoryStore;
  sharedMemoryStore = null;
  await store.close();
}

function defaultIdentifier(req) {
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/**
 * Warn once if we are deriving identity from a socket address while an
 * `X-Forwarded-For` header is present and `trust proxy` is unset: every client
 * behind that proxy is sharing one bucket, so one busy tenant locks out the
 * rest. The inverse (trusting the header blindly) is a bypass, so the fix is a
 * deliberate `app.set('trust proxy', <hops>)`, not a default.
 */
function warnAboutProxy(req, logger, state) {
  if (state.warnedAboutProxy) return;
  if (!req.headers?.['x-forwarded-for']) return;

  const trustProxy = typeof req.app?.get === 'function' ? req.app.get('trust proxy') : undefined;
  if (trustProxy) return;

  state.warnedAboutProxy = true;
  logger.warn?.(
    '[RateLimiter] X-Forwarded-For is present but "trust proxy" is not set: req.ip is the ' +
      'proxy address, so all clients behind it share one bucket. Set app.set("trust proxy", <hops>) ' +
      'and make sure the proxy overwrites the header, or supply a custom identifier.'
  );
}

function applyHeaders(res, result) {
  if (res.headersSent) return;

  const remaining = Math.max(0, result.remaining);

  // IETF draft names.
  res.setHeader('RateLimit-Limit', result.limit);
  res.setHeader('RateLimit-Remaining', remaining);

  // Legacy names, kept for existing clients.
  res.setHeader('X-RateLimit-Limit', result.limit);
  res.setHeader('X-RateLimit-Remaining', remaining);

  // `resetMs` is time until the bucket is back at capacity. Two cases must not
  // produce a reset header: a non-finite value (`new Date(Infinity)
  // .toISOString()` throws), and a rejection that waiting cannot resolve -
  // advertising "resets now" for a limiter that never refills is a lie.
  const unsatisfiable = !result.allowed && !Number.isFinite(result.retryAfterMs);
  if (!unsatisfiable && Number.isFinite(result.resetMs)) {
    res.setHeader('RateLimit-Reset', Math.ceil(result.resetMs / 1000));
    res.setHeader('X-RateLimit-Reset', new Date(Date.now() + result.resetMs).toISOString());
  }

  if (!result.allowed && Number.isFinite(result.retryAfterMs)) {
    // Never 0: a client honouring `Retry-After: 0` retries in a hot loop.
    res.setHeader('Retry-After', Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
  }
}

/**
 * @param {object} [options]
 * @param {number} [options.requestsPerMinute=60] - sustained rate; 0 denies everything
 * @param {number} [options.capacity=requestsPerMinute] - burst size
 * @param {number} [options.cost=1] - tokens spent per request
 * @param {string} [options.scope] - bucket namespace; defaults to a hash of the limits
 * @param {object} [options.store] - MemoryStore (default, shared) or RedisStore
 * @param {(req) => string|null} [options.identifier] - defaults to req.ip
 * @param {(req) => boolean} [options.skip]
 * @param {(req, res, next) => void} [options.handler] - custom rejection
 * @param {boolean} [options.headers=true]
 * @param {string} [options.message]
 * @param {number} [options.statusCode=429]
 * @param {object} [options.logger=console]
 * @returns {Function} Express middleware, with .scope/.store/.metrics/.close()
 */
function createRateLimiter(options = {}) {
  const requestsPerMinute = assertNumber(options.requestsPerMinute ?? 60, 'requestsPerMinute', {
    allowZero: true
  });
  const capacity = assertNumber(options.capacity ?? requestsPerMinute, 'capacity', {
    allowZero: true
  });
  const cost = assertNumber(options.cost ?? 1, 'cost');

  if (capacity > 0 && cost > capacity) {
    throw new RangeError(
      `cost (${cost}) exceeds capacity (${capacity}): every request would be rejected forever`
    );
  }

  const refillRate = requestsPerMinute / 60;
  const usingDefaultIdentifier = options.identifier === undefined;

  const config = {
    requestsPerMinute,
    capacity,
    cost,
    refillRate,
    scope: normalizeScope(options.scope ?? scopeFor({ capacity, refillRate, cost })),
    store: options.store ? assertStore(options.store, 'store') : getSharedMemoryStore(),
    identifier: assertFunction(options.identifier ?? defaultIdentifier, 'identifier'),
    skip: assertFunction(options.skip ?? (() => false), 'skip'),
    handler: options.handler ? assertFunction(options.handler, 'handler') : null,
    headers: options.headers !== false,
    message: options.message ?? 'Too many requests, please try again later.',
    statusCode: assertNumber(options.statusCode ?? 429, 'statusCode', { integer: true }),
    logger: options.logger ?? console
  };

  const metrics = { allowed: 0, denied: 0, skipped: 0, unidentified: 0, errors: 0, degraded: 0 };
  const state = { warnedAboutProxy: false, warnedAboutIdentifier: false };

  async function rateLimiterMiddleware(req, res, next) {
    // Nothing below may throw synchronously into Express: user-supplied
    // callbacks, header serialisation and the store are all inside the try, and
    // every failure is handed to the error handler instead of rejecting.
    try {
      if (config.skip(req)) {
        metrics.skipped += 1;
        return next();
      }

      const rawIdentifier = config.identifier(req);
      if (rawIdentifier === null || rawIdentifier === undefined || rawIdentifier === '') {
        metrics.unidentified += 1;
        if (!state.warnedAboutIdentifier) {
          state.warnedAboutIdentifier = true;
          config.logger.warn?.(
            '[RateLimiter] identifier() returned no value; requests are passing unlimited'
          );
        }
        return next();
      }

      if (usingDefaultIdentifier) warnAboutProxy(req, config.logger, state);

      const result = await config.store.checkLimit(normalizeIdentifier(rawIdentifier), {
        scope: config.scope,
        capacity: config.capacity,
        refillRate: config.refillRate,
        tokens: config.cost
      });

      if (result.degraded) metrics.degraded += 1;
      if (config.headers) applyHeaders(res, result);

      if (result.allowed) {
        metrics.allowed += 1;
        return next();
      }

      metrics.denied += 1;
      if (config.handler) return config.handler(req, res, next);

      const retryAfterSeconds = Number.isFinite(result.retryAfterMs)
        ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
        : null;

      return res.status(config.statusCode).json({
        error: 'Too Many Requests',
        message: config.message,
        // null means "not from waiting" - the limit never refills, or the
        // request costs more than the bucket can ever hold.
        retryAfter: retryAfterSeconds,
        limit: result.limit,
        remaining: Math.max(0, result.remaining)
      });
    } catch (err) {
      metrics.errors += 1;
      return next(err);
    }
  }

  rateLimiterMiddleware.config = config;
  rateLimiterMiddleware.scope = config.scope;
  rateLimiterMiddleware.store = config.store;
  rateLimiterMiddleware.metrics = metrics;
  /** Only closes the store if this limiter owns it. */
  rateLimiterMiddleware.close = async () => {
    if (config.store !== sharedMemoryStore) await config.store.close?.();
  };

  return rateLimiterMiddleware;
}

/**
 * Named configurations. `scope` is set explicitly so a preset keeps its own
 * bucket even if another limiter happens to share its numbers.
 */
const presets = {
  strict: (options = {}) =>
    createRateLimiter({ requestsPerMinute: 10, scope: 'preset-strict', ...options }),

  moderate: (options = {}) =>
    createRateLimiter({ requestsPerMinute: 60, scope: 'preset-moderate', ...options }),

  relaxed: (options = {}) =>
    createRateLimiter({ requestsPerMinute: 120, scope: 'preset-relaxed', ...options }),

  // 1000/min sustained, but no more than 200 back-to-back.
  api: (options = {}) =>
    createRateLimiter({
      requestsPerMinute: 1000,
      capacity: 200,
      scope: 'preset-api',
      ...options
    })
};

module.exports = createRateLimiter;
module.exports.presets = presets;
module.exports.getSharedMemoryStore = getSharedMemoryStore;
module.exports.closeSharedMemoryStore = closeSharedMemoryStore;
