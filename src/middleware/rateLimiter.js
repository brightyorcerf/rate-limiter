/**
 * Rate Limiter Express Middleware
 * 
 * Usage:
 *   const rateLimiter = require('./middleware/rateLimiter');
 *   app.use(rateLimiter({ requestsPerMinute: 10 }));
 * 
 * Or per-route:
 *   app.get('/api/expensive', rateLimiter({ requestsPerMinute: 5 }), handler);
 */

const MemoryStore = require('../storage/memoryStore');

/**
 * Create rate limiter middleware
 * @param {object} options - Configuration options
 * @returns {function} - Express middleware function
 */
function createRateLimiter(options = {}) {
  // Default configuration
  const config = {
    // Rate limit: 60 requests per minute by default
    requestsPerMinute: options.requestsPerMinute || 60,
    
    // Allow burst traffic (capacity = requests per minute)
    capacity: options.capacity || options.requestsPerMinute || 60,
    
    // Custom identifier function (default: use IP address)
    identifier: options.identifier || ((req) => req.ip || req.connection.remoteAddress),
    
    // Custom storage (default: in-memory)
    store: options.store || new MemoryStore(),
    
    // Skip rate limiting for certain requests
    skip: options.skip || (() => false),
    
    // Custom handler when rate limit exceeded
    handler: options.handler || null,
    
    // Include rate limit headers in response
    headers: options.headers !== false, // Default true
    
    // Message when rate limited
    message: options.message || 'Too many requests, please try again later.'
  };

  // Calculate refill rate (tokens per second)
  const refillRate = config.requestsPerMinute / 60;

  /**
   * The actual middleware function
   */
  return async function rateLimiterMiddleware(req, res, next) {
    // Check if we should skip this request
    if (config.skip(req)) {
      return next();
    }

    // Get client identifier (IP address, API key, etc.)
    const clientId = config.identifier(req);

    if (!clientId) {
      console.warn('[RateLimiter] No identifier found for request');
      return next();
    }

    // Check rate limit
    const result = config.store.checkLimit(clientId, {
      capacity: config.capacity,
      refillRate: refillRate,
      tokens: 1
    });

    // Add rate limit headers (standard headers that clients can use)
    if (config.headers) {
      res.setHeader('X-RateLimit-Limit', result.limit);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', new Date(result.resetTime).toISOString());
      
      if (!result.allowed) {
        // Tell client when to retry (in seconds)
        res.setHeader('Retry-After', Math.ceil(result.retryAfter / 1000));
      }
    }

    // If allowed, continue to next middleware
    if (result.allowed) {
      return next();
    }

    // Rate limit exceeded - handle rejection
    if (config.handler) {
      // Use custom handler if provided
      return config.handler(req, res, next);
    }

    // Default: return 429 Too Many Requests
    return res.status(429).json({
      error: 'Too Many Requests',
      message: config.message,
      retryAfter: Math.ceil(result.retryAfter / 1000), // Seconds
      limit: result.limit,
      remaining: 0
    });
  };
}

/**
 * Preset configurations for common use cases
 */
const presets = {
  // Strict: 10 requests per minute
  strict: (options = {}) => createRateLimiter({
    requestsPerMinute: 10,
    ...options
  }),

  // Moderate: 60 requests per minute (default)
  moderate: (options = {}) => createRateLimiter({
    requestsPerMinute: 60,
    ...options
  }),

  // Relaxed: 120 requests per minute
  relaxed: (options = {}) => createRateLimiter({
    requestsPerMinute: 120,
    ...options
  }),

  // API: 1000 requests per minute with burst
  api: (options = {}) => createRateLimiter({
    requestsPerMinute: 1000,
    capacity: 100, // Allow bursts
    ...options
  })
};

module.exports = createRateLimiter;
module.exports.presets = presets;