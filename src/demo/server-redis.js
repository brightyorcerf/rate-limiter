/**
 * Demo API Server with Redis
 * 
 * This version uses Redis for distributed rate limiting
 * Perfect for production with multiple servers
 * 
 * Prerequisites:
 *   1. Install Redis: brew install redis (Mac) or apt-get install redis (Linux)
 *   2. Start Redis: redis-server
 *   3. Run this: node src/demo/server-redis.js
 */

const express = require('express');
const rateLimiter = require('../middleware/rateLimiter');
const RedisStore = require('../storage/redisStore');

const app = express();
const PORT = process.env.PORT || 3000;

// Create Redis store instance
const redisStore = new RedisStore({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  keyPrefix: 'ratelimit:',
});

// Middleware
app.use(express.json());

// Logger
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// ==========================================
// REDIS-BACKED RATE LIMITED ROUTES
// ==========================================

/**
 * Route 1: Global rate limit with Redis
 */

/**
 * Route 2: Strict endpoint with Redis
 * Multiple servers will share this limit!
 */
app.get('/api/expensive',
  rateLimiter({
    requestsPerMinute: 5,
    capacity: 5,
    store: redisStore,
    message: 'This endpoint is expensive. Rate limited across all servers via Redis.'
  }),
  (req, res) => {
    res.json({
      message: 'Expensive operation completed',
      note: 'Rate limit shared across all servers via Redis',
      server: process.env.SERVER_ID || 'primary',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Route 3: API with custom key
 */
app.get('/api/with-key',
  rateLimiter({
    requestsPerMinute: 10,
    store: redisStore,
    identifier: (req) => {
      return req.headers['x-api-key'] || req.ip;
    }
  }),
  (req, res) => {
    const apiKey = req.headers['x-api-key'] || 'none';
    res.json({
      message: 'Rate limited by API key (Redis)',
      apiKey: apiKey,
      note: 'Limit shared across servers',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Route 4: High-traffic endpoint
 */
app.get('/api/public',
  rateLimiter({
    requestsPerMinute: 120,
    capacity: 100,
    store: redisStore
  }),
  (req, res) => {
    res.json({
      message: 'Public endpoint with high limits',
      rateLimit: '120 req/min',
      backend: 'Redis',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Route 5: Admin endpoint to view Redis stats
 */
app.get('/api/admin/stats', async (req, res) => {
  try {
    const stats = await redisStore.getStats();
    res.json({
      message: 'Rate limiter statistics',
      backend: 'Redis',
      ...stats,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get stats',
      message: error.message
    });
  }
});

/**
 * Route 6: Admin endpoint to reset a specific client
 */
app.post('/api/admin/reset/:identifier', async (req, res) => {
  const { identifier } = req.params;
  
  try {
    await redisStore.reset(identifier);
    res.json({
      message: 'Rate limit reset successfully',
      identifier,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to reset',
      message: error.message
    });
  }
});

/**
 * Route 7: Check bucket state for debugging
 */
app.get('/api/admin/bucket/:identifier', async (req, res) => {
  const { identifier } = req.params;
  
  try {
    const state = await redisStore.getBucketState(identifier);
    res.json({
      identifier,
      state: state || 'No bucket found',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get bucket state',
      message: error.message
    });
  }
});

/**
 * Status endpoint
 */
app.get('/api/status', (req, res) => {
  res.json({
    message: 'Redis-backed rate limiter is active',
    backend: 'Redis',
    yourIP: req.ip,
    endpoints: {
      '/api/public': '120 req/min',
      '/api/expensive': '5 req/min - Shared across servers',
      '/api/with-key': '10 req/min - API key based',
      '/api/admin/stats': 'View rate limit stats',
      '/api/admin/reset/:id': 'Reset rate limit for client',
      '/api/admin/bucket/:id': 'View bucket state'
    },
    advantages: [
      'Distributed rate limiting across multiple servers',
      'Persists through server restarts',
      'Centralized monitoring and control',
      'Atomic operations via Lua scripts'
    ]
  });
});

/**
 * Root route
 */
app.get('/', (req, res) => {
  res.json({
    message: 'RateGuard with Redis',
    backend: 'Redis-backed distributed rate limiting',
    instructions: 'Rate limits are shared across all servers!',
    endpoints: [
      'GET /api/status - Check system info',
      'GET /api/expensive - 5 req/min (strict)',
      'GET /api/public - 120 req/min (relaxed)',
      'GET /api/with-key - API key based',
      'GET /api/admin/stats - View statistics',
      'POST /api/admin/reset/:id - Reset client limit'
    ],
    testCommands: {
      single: 'curl http://localhost:3000/api/expensive',
      loop: 'for i in {1..10}; do curl http://localhost:3000/api/expensive; echo ""; done',
      stats: 'curl http://localhost:3000/api/admin/stats',
      reset: 'curl -X POST http://localhost:3000/api/admin/reset/YOUR_IP'
    }
  });
});

app.use(rateLimiter({
  requestsPerMinute: 60,
  store: redisStore, // <-- Redis store!
  message: 'Global rate limit exceeded (backed by Redis)'
}));

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down gracefully...');
  await redisStore.disconnect();
  process.exit(0);
});

// Start server
async function start() {
  try {
    // Connect to Redis first
    console.log('[Server] Connecting to Redis...');
    await redisStore.connect();
    console.log('[Server] Redis connected successfully!');

    // Start Express server
    app.listen(PORT, () => {
      console.log(`
╔════════════════════════════════════════╗
║   RateGuard with Redis v1.0            ║
║   Distributed Rate Limiting            ║
╚════════════════════════════════════════╝

✓ Redis connected
✓ Server running on http://localhost:${PORT}

This version uses Redis for distributed rate limiting!
Run multiple instances and they'll share rate limits.

Test commands:
  
  1. Hit strict endpoint 10 times:
     for i in {1..10}; do curl http://localhost:${PORT}/api/expensive; echo ""; done

  2. Check Redis statistics:
     curl http://localhost:${PORT}/api/admin/stats

  3. View your bucket state:
     curl http://localhost:${PORT}/api/admin/bucket/$(curl -s ifconfig.me)

  4. Reset your rate limit:
     curl -X POST http://localhost:${PORT}/api/admin/reset/$(curl -s ifconfig.me)

  5. Run multiple servers (same Redis):
     PORT=3001 SERVER_ID=server2 node src/demo/server-redis.js

Press Ctrl+C to stop
      `);
    });
  } catch (error) {
    console.error('[Server] Failed to start:', error);
    console.error('\nMake sure Redis is running:');
    console.error('  Mac: brew install redis && redis-server');
    console.error('  Linux: sudo apt-get install redis && redis-server');
    process.exit(1);
  }
}

start();