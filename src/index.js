'use strict';

/**
 * Library entry point.
 *
 * Requiring this module must never start a server - `package.json:main` used to
 * point at the demo, so `require('rateguard')` opened a listening socket on
 * port 3000. The demos live behind `npm start` / `npm run start:redis`.
 */

const createRateLimiter = require('./middleware/rateLimiter');
const MemoryStore = require('./storage/memoryStore');
const TokenBucket = require('./algorithms/tokenBucket');
const identity = require('./internal/identity');

module.exports = createRateLimiter;
module.exports.createRateLimiter = createRateLimiter;
module.exports.presets = createRateLimiter.presets;
module.exports.getSharedMemoryStore = createRateLimiter.getSharedMemoryStore;
module.exports.closeSharedMemoryStore = createRateLimiter.closeSharedMemoryStore;
module.exports.MemoryStore = MemoryStore;
module.exports.TokenBucket = TokenBucket;
module.exports.normalizeIdentifier = identity.normalizeIdentifier;
module.exports.hashIdentifier = identity.hashIdentifier;

// Lazy: keeps `redis` out of the module graph for in-memory-only users.
Object.defineProperty(module.exports, 'RedisStore', {
  enumerable: true,
  get() {
    return require('./storage/redisStore');
  }
});
