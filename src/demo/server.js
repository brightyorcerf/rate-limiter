'use strict';

/**
 * Demo API server, in-memory backend.
 *
 *   npm start
 *   PORT=4000 npm start
 *
 * Single process only. Two instances have two independent sets of buckets -
 * use server-redis.js for anything with more than one server.
 */

const express = require('express');
const rateLimiter = require('../middleware/rateLimiter');
const {
  createAdminAuth,
  createRequestLogger,
  installShutdownHandlers,
  secretsMatch
} = require('./shared');
const { normalizeIdentifier } = require('../internal/identity');

const PORT = Number(process.env.PORT ?? 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const app = express();

// If this demo ever runs behind a proxy, this is the line to change - and the
// proxy must overwrite X-Forwarded-For rather than append to a client value.
// app.set('trust proxy', 1);

app.use(createRequestLogger({ logClientIps: process.env.LOG_CLIENT_IPS === '1' }));

/**
 * Aggregate safety net, mounted before every route so it actually applies.
 *
 * It is deliberately looser than the per-route limits: a request that passes
 * through two limiters spends a token in each, so the effective limit is the
 * stricter of the two. A 60/min net would silently cap the 120/min endpoint.
 */
app.use(
  rateLimiter({
    requestsPerMinute: 300,
    scope: 'global',
    message: 'Global rate limit exceeded. Slow down!'
  })
);

// Body parsing sits after the limiter: parsing bodies for requests we are about
// to reject is work an attacker gets for free.
app.use(express.json({ limit: '100kb' }));

/**
 * Relaxed public endpoint: 120 req/min.
 */
app.get('/api/public', rateLimiter.presets.relaxed(), (req, res) => {
  res.json({
    message: 'Public endpoint - 120 requests/min allowed',
    timestamp: new Date().toISOString()
  });
});

/**
 * Strict endpoint for expensive work: 5 req/min, no burst above 5.
 */
app.get(
  '/api/expensive',
  rateLimiter({
    requestsPerMinute: 5,
    capacity: 5,
    scope: 'expensive',
    message: 'This endpoint is expensive. You can only call it 5 times per minute.'
  }),
  (req, res) => {
    res.json({
      message: 'Expensive operation completed',
      note: 'This endpoint allows only 5 requests per minute',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Rate limiting by API key.
 *
 * The header is client-controlled, so a fabricated key is a fresh bucket. In a
 * real service the key must be validated against a registry before it is used
 * as an identity; here we fall back to the IP for unknown keys so rotation
 * cannot mint unlimited allowances.
 */
const KNOWN_API_KEYS = new Set(
  (process.env.API_KEYS ?? 'demo-key-1,demo-key-2').split(',').filter(Boolean)
);

app.get(
  '/api/with-key',
  rateLimiter({
    requestsPerMinute: 10,
    scope: 'api-key',
    identifier: (req) => {
      const presented = req.headers['x-api-key'];
      if (typeof presented === 'string' && KNOWN_API_KEYS.has(presented)) {
        return `key:${presented}`;
      }
      return req.ip;
    },
    message: 'API key rate limit exceeded'
  }),
  (req, res) => {
    const presented = req.headers['x-api-key'];
    const recognised = typeof presented === 'string' && KNOWN_API_KEYS.has(presented);
    res.json({
      message: 'Rate limited by API key',
      recognisedKey: recognised,
      note: recognised
        ? '10 requests per minute for this key'
        : 'Unrecognised key - limited by IP instead',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Custom rejection payload: 3 login attempts per minute.
 */
app.post(
  '/api/login',
  rateLimiter({
    requestsPerMinute: 3,
    capacity: 3,
    scope: 'login',
    handler: (req, res) => {
      res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many login attempts. Please wait before trying again.',
        timestamp: new Date().toISOString()
      });
    }
  }),
  (req, res) => {
    res.json({
      message: 'Login endpoint reached (this demo does not authenticate)',
      note: 'This endpoint allows only 3 attempts per minute'
    });
  }
);

/**
 * Conditional bypass.
 *
 * The bypass exists only when ADMIN_TOKEN is set in the environment; the old
 * hard-coded token was a documented rate limit bypass committed to the repo.
 */
app.get(
  '/api/admin',
  rateLimiter({
    requestsPerMinute: 10,
    scope: 'admin',
    skip: (req) => {
      const presented = req.headers['x-admin-token'];
      return Boolean(ADMIN_TOKEN) && typeof presented === 'string' && secretsMatch(presented, ADMIN_TOKEN);
    }
  }),
  (req, res) => {
    res.json({
      message: 'Admin endpoint',
      note: ADMIN_TOKEN
        ? 'Send X-Admin-Token to bypass the limit'
        : 'ADMIN_TOKEN is not configured, so no bypass is available',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Aggregate counters. Never returns identifiers.
 */
const adminAuth = createAdminAuth(ADMIN_TOKEN);
if (adminAuth) {
  app.get('/api/admin/stats', adminAuth, async (req, res, next) => {
    try {
      res.json(await rateLimiter.getSharedMemoryStore().getStats());
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/admin/reset/:identifier', adminAuth, async (req, res, next) => {
    try {
      const removed = await rateLimiter
        .getSharedMemoryStore()
        .reset(req.params.identifier, req.query.scope ? { scope: req.query.scope } : {});
      res.json({ removed, timestamp: new Date().toISOString() });
    } catch (err) {
      next(err);
    }
  });
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', backend: 'memory', uptimeSeconds: Math.floor(process.uptime()) });
});

app.get('/api/status', (req, res) => {
  res.json({
    message: 'Rate limiter is active',
    backend: 'memory',
    // The normalised form, which is what the bucket is actually keyed by.
    yourIdentity: normalizeIdentifier(req.ip ?? 'unknown'),
    endpoints: {
      '/api/public': '120 req/min',
      '/api/expensive': '5 req/min',
      '/api/with-key': '10 req/min per recognised API key, else per IP',
      '/api/login': '3 req/min',
      '/api/admin': `10 req/min${ADMIN_TOKEN ? ', bypassable with X-Admin-Token' : ''}`,
      '(all routes)': '300 req/min aggregate'
    },
    adminEndpointsEnabled: Boolean(adminAuth),
    tip: 'Check the RateLimit-* response headers'
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'RateGuard demo (in-memory)',
    endpoints: [
      'GET /health',
      'GET /api/status',
      'GET /api/public - 120 req/min',
      'GET /api/expensive - 5 req/min',
      'GET /api/with-key - X-Api-Key based',
      'POST /api/login - 3 req/min',
      'GET /api/admin - 10 req/min'
    ],
    testCommand: 'curl -i http://localhost:' + PORT + '/api/expensive'
  });
});

// Express 5 forwards rejected async handlers here; the middleware also routes
// its own failures through next(err) rather than rejecting.
app.use((err, req, res, next) => {
  console.error('[Server] unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

function start() {
  const server = app.listen(PORT, () => {
    console.log(`[Server] RateGuard demo (in-memory) listening on http://localhost:${PORT}`);
    if (!ADMIN_TOKEN) {
      console.log('[Server] ADMIN_TOKEN not set: admin endpoints and the bypass are disabled');
    }
  });

  installShutdownHandlers(server, {
    onShutdown: () => rateLimiter.closeSharedMemoryStore()
  });

  return server;
}

if (require.main === module) start();

module.exports = { app, start };
