'use strict';

/**
 * Demo API server, Redis backend.
 *
 *   redis-server &
 *   npm run start:redis
 *   PORT=3001 npm run start:redis      # second instance, same limits
 *
 * Every instance pointed at the same Redis shares one bucket per
 * (scope, identifier), so limits hold across the fleet.
 *
 * Environment:
 *   PORT, REDIS_URL | REDIS_HOST + REDIS_PORT, REDIS_PASSWORD
 *   ADMIN_TOKEN     - required to expose the admin endpoints (>= 16 chars)
 *   FAIL_OPEN=0     - reject instead of allowing when Redis is unusable
 *   REQUIRE_REDIS=1 - refuse to start unless Redis is reachable
 *   LOG_CLIENT_IPS=1
 */

const express = require('express');
const rateLimiter = require('../middleware/rateLimiter');
const RedisStore = require('../storage/redisStore');
const { createAdminAuth, createRequestLogger, installShutdownHandlers } = require('./shared');
const { normalizeIdentifier } = require('../internal/identity');

const PORT = Number(process.env.PORT ?? 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const redisStore = new RedisStore({
  url: process.env.REDIS_URL,
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'ratelimit:',
  // Explicit, not incidental: allow traffic through during a Redis outage
  // (default) or protect the upstream and reject it (FAIL_OPEN=0).
  failOpen: process.env.FAIL_OPEN !== '0'
});

const app = express();

// app.set('trust proxy', 1);   // required if this sits behind a proxy or LB

app.use(createRequestLogger({ logClientIps: process.env.LOG_CLIENT_IPS === '1' }));

/**
 * Aggregate net, mounted before the routes. Registered below them it would only
 * ever run on 404s - which is exactly what it used to do.
 */
app.use(
  rateLimiter({
    requestsPerMinute: 300,
    scope: 'global',
    store: redisStore,
    message: 'Global rate limit exceeded (backed by Redis)'
  })
);

app.use(express.json({ limit: '100kb' }));

/**
 * Strict shared endpoint: 5 req/min across every server.
 */
app.get(
  '/api/expensive',
  rateLimiter({
    requestsPerMinute: 5,
    capacity: 5,
    scope: 'expensive',
    store: redisStore,
    message: 'This endpoint is expensive. Rate limited across all servers via Redis.'
  }),
  (req, res) => {
    res.json({
      message: 'Expensive operation completed',
      note: 'Rate limit shared across all servers via Redis',
      server: process.env.SERVER_ID ?? 'primary',
      timestamp: new Date().toISOString()
    });
  }
);

const KNOWN_API_KEYS = new Set(
  (process.env.API_KEYS ?? 'demo-key-1,demo-key-2').split(',').filter(Boolean)
);

/**
 * API-key limiting. Unrecognised keys fall back to the IP bucket, so key
 * rotation cannot mint unlimited allowances.
 */
app.get(
  '/api/with-key',
  rateLimiter({
    requestsPerMinute: 10,
    scope: 'api-key',
    store: redisStore,
    identifier: (req) => {
      const presented = req.headers['x-api-key'];
      if (typeof presented === 'string' && KNOWN_API_KEYS.has(presented)) {
        return `key:${presented}`;
      }
      return req.ip;
    }
  }),
  (req, res) => {
    const presented = req.headers['x-api-key'];
    res.json({
      message: 'Rate limited by API key (Redis)',
      recognisedKey: typeof presented === 'string' && KNOWN_API_KEYS.has(presented),
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * High-traffic endpoint: 120 req/min sustained, 100 burst.
 */
app.get(
  '/api/public',
  rateLimiter({
    requestsPerMinute: 120,
    capacity: 100,
    scope: 'public',
    store: redisStore
  }),
  (req, res) => {
    res.json({
      message: 'Public endpoint with high limits',
      rateLimit: '120 req/min, burst 100',
      backend: 'redis',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Admin surface.
 *
 * Mounted only when ADMIN_TOKEN is configured. `reset` clears a client's limit
 * and `stats` enumerates buckets, so unauthenticated access to either defeats
 * the limiter - stats also used to return raw identifiers, which are API keys
 * in the configuration above.
 */
const adminAuth = createAdminAuth(ADMIN_TOKEN);
if (adminAuth) {
  app.get('/api/admin/stats', adminAuth, async (req, res, next) => {
    try {
      res.json({
        ...(await redisStore.getStats({
          includeIdentifiers: req.query.identifiers === 'hashed'
        })),
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/reset/:identifier', adminAuth, async (req, res, next) => {
    try {
      const removed = await redisStore.reset(
        req.params.identifier,
        req.query.scope ? { scope: req.query.scope } : {}
      );
      res.json({ removed, scope: req.query.scope ?? 'all', timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/admin/bucket/:identifier', adminAuth, async (req, res, next) => {
    try {
      const state = await redisStore.getBucketState(req.params.identifier, {
        scope: req.query.scope ?? 'expensive'
      });
      res.json({ state, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Readiness that actually checks the dependency, so a load balancer can route
 * around an instance whose Redis is unreachable.
 */
app.get('/health', async (req, res) => {
  const redis = await redisStore.ping();
  res.status(redis.healthy ? 200 : 503).json({
    status: redis.healthy ? 'ok' : 'degraded',
    backend: 'redis',
    redis,
    failOpen: redisStore.options.failOpen,
    uptimeSeconds: Math.floor(process.uptime())
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    message: 'Redis-backed rate limiter is active',
    backend: 'redis',
    server: process.env.SERVER_ID ?? 'primary',
    // The normalised form, which is what the bucket is actually keyed by.
    yourIdentity: normalizeIdentifier(req.ip ?? 'unknown'),
    endpoints: {
      '/api/public': '120 req/min, burst 100',
      '/api/expensive': '5 req/min, shared across servers',
      '/api/with-key': '10 req/min per recognised API key',
      '(all routes)': '300 req/min aggregate'
    },
    adminEndpointsEnabled: Boolean(adminAuth),
    guarantees: [
      'One bucket per (scope, identifier), shared by every server',
      'Refill and consume are atomic (single Lua script)',
      'Time comes from Redis, so server clock skew cannot shift limits',
      'A Redis outage cannot hang a request; behaviour is set by failOpen'
    ]
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'RateGuard demo (Redis)',
    endpoints: [
      'GET /health',
      'GET /api/status',
      'GET /api/expensive - 5 req/min (shared)',
      'GET /api/public - 120 req/min',
      'GET /api/with-key - X-Api-Key based'
    ],
    testCommand: `curl -i http://localhost:${PORT}/api/expensive`
  });
});

app.use((err, req, res, next) => {
  console.error('[Server] unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  try {
    await redisStore.connect();
    console.log('[Server] Redis connected');
  } catch (err) {
    if (process.env.REQUIRE_REDIS === '1') {
      console.error('[Server] Redis unreachable and REQUIRE_REDIS=1:', err.message);
      await redisStore.close();
      process.exit(1);
    }
    console.warn(
      `[Server] starting without Redis (${err.message}); requests will be ` +
        `${redisStore.options.failOpen ? 'allowed' : 'rejected'} until it recovers`
    );
  }

  const server = app.listen(PORT, () => {
    console.log(`[Server] RateGuard demo (Redis) listening on http://localhost:${PORT}`);
    if (!ADMIN_TOKEN) {
      console.log('[Server] ADMIN_TOKEN not set: admin endpoints are disabled');
    }
  });

  installShutdownHandlers(server, {
    onShutdown: async () => {
      await redisStore.close();
      await rateLimiter.closeSharedMemoryStore();
    }
  });

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[Server] failed to start:', err);
    process.exit(1);
  });
}

module.exports = { app, start, redisStore };
