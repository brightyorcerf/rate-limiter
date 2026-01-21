/**
 * Demo API Server
 * 
 * Shows different rate limiting configurations in action
 * Run: node src/demo/server.js
 * Test: Use browser or curl to hit endpoints
 */

const express = require('express');
const rateLimiter = require('../middleware/rateLimiter');

const app = express();
const PORT = 3000;

// Middleware
app.use(express.json());

// Custom logger to see requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ==========================================
// DEMO ROUTES WITH DIFFERENT RATE LIMITS
// ==========================================

/**
 * Route 1: Global rate limit (60 req/min)
 * Applied to all routes below unless overridden
 */
app.use(rateLimiter({
  requestsPerMinute: 60,
  message: 'Global rate limit exceeded. Slow down!'
}));

/**
 * Route 2: Public endpoint - relaxed limit
 * Good for public APIs with lots of traffic
 */
app.get('/api/public', 
  rateLimiter.presets.relaxed(),
  (req, res) => {
    res.json({
      message: 'Public endpoint - 120 requests/min allowed',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Route 3: Strict endpoint - VERY limited
 * Perfect for expensive operations (DB writes, email sending, etc.)
 */
app.get('/api/expensive',
  rateLimiter({
    requestsPerMinute: 5, // Only 5 per minute!
    capacity: 5,
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
 * Route 4: Custom identifier - rate limit by API key
 * Shows how to rate limit by something other than IP
 */
app.get('/api/with-key',
  rateLimiter({
    requestsPerMinute: 10,
    identifier: (req) => {
      // Use API key from header, fallback to IP
      return req.headers['x-api-key'] || req.ip;
    },
    message: 'API key rate limit exceeded'
  }),
  (req, res) => {
    const apiKey = req.headers['x-api-key'] || 'none';
    res.json({
      message: 'Rate limited by API key',
      apiKey: apiKey,
      note: '10 requests per minute per API key',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Route 5: Custom handler - custom 429 response
 */
app.post('/api/login',
  rateLimiter({
    requestsPerMinute: 3, // Very strict for login attempts
    capacity: 3,
    handler: (req, res) => {
      // Custom response for rate limit
      res.status(429).json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many login attempts. Please wait before trying again.',
        suggestion: 'Consider using a stronger password to avoid lockouts.',
        timestamp: new Date().toISOString()
      });
    }
  }),
  (req, res) => {
    res.json({
      message: 'Login successful',
      note: 'This endpoint allows only 3 attempts per minute'
    });
  }
);

/**
 * Route 6: Whitelisted route - no rate limit for admins
 */
app.get('/api/admin',
  rateLimiter({
    requestsPerMinute: 10,
    skip: (req) => {
      // Skip rate limiting if admin token is present
      return req.headers['x-admin-token'] === 'supersecret';
    }
  }),
  (req, res) => {
    const isAdmin = req.headers['x-admin-token'] === 'supersecret';
    res.json({
      message: 'Admin endpoint',
      note: isAdmin 
        ? 'Admin token detected - no rate limit applied' 
        : 'Regular user - 10 requests per minute',
      timestamp: new Date().toISOString()
    });
  }
);

/**
 * Route 7: Status endpoint - check your rate limit status
 */
app.get('/api/status', (req, res) => {
  res.json({
    message: 'Rate limiter is active',
    yourIP: req.ip,
    endpoints: {
      '/api/public': '120 req/min - Relaxed',
      '/api/expensive': '5 req/min - Strict',
      '/api/with-key': '10 req/min - API key based',
      '/api/login': '3 req/min - Login protection',
      '/api/admin': '10 req/min - Whitelisted for admins',
    },
    tip: 'Check response headers for X-RateLimit-* information'
  });
});

/**
 * Root route - Instructions
 */
app.get('/', (req, res) => {
  res.json({
    message: 'RateGuard Demo API',
    instructions: 'Try hitting these endpoints rapidly to see rate limiting in action!',
    endpoints: [
      'GET /api/status - Check rate limit info',
      'GET /api/public - 120 req/min',
      'GET /api/expensive - 5 req/min (try this one!)',
      'GET /api/with-key - Requires X-Api-Key header',
      'POST /api/login - 3 req/min',
      'GET /api/admin - Use X-Admin-Token: supersecret to bypass'
    ],
    testCommand: 'curl http://localhost:3000/api/expensive -i',
    loopTest: 'for i in {1..10}; do curl http://localhost:3000/api/expensive; echo ""; done'
  });
});

// Error handling
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║      RateGuard Demo Server v1.0        ║
╚════════════════════════════════════════╝

Server running on http://localhost:${PORT}

Try these commands:
  
  1. Check status:
     curl http://localhost:${PORT}/api/status

  2. Test strict rate limit (5 req/min):
     for i in {1..10}; do curl http://localhost:${PORT}/api/expensive; echo ""; sleep 0.5; done

  3. View rate limit headers:
     curl -i http://localhost:${PORT}/api/expensive

  4. Test with API key:
     curl -H "X-Api-Key: mykey123" http://localhost:${PORT}/api/with-key

Press Ctrl+C to stop
  `);
}); 