/**
 * Memory Store for Rate Limiter
 * 
 * Stores TokenBucket instances for each client (identified by IP, API key, etc.)
 * This is the in-memory version - great for single-server deployments
 * 
 * In production with multiple servers, you'd use Redis instead
 */

const TokenBucket = require('../algorithms/tokenBucket');

class MemoryStore {
  constructor() {
    // Map of identifier -> TokenBucket instance
    // e.g., { '192.168.1.1': TokenBucket, 'api_key_123': TokenBucket }
    this.buckets = new Map();
    
    // Cleanup old buckets periodically to prevent memory leaks
    this.startCleanup();
  }

  /**
   * Get or create a bucket for a client
   * @param {string} identifier - Client identifier (IP, API key, etc.)
   * @param {number} capacity - Bucket capacity
   * @param {number} refillRate - Tokens per second
   * @returns {TokenBucket} - The bucket for this client
   */
  getBucket(identifier, capacity, refillRate) {
    // If bucket exists, return it
    if (this.buckets.has(identifier)) {
      return this.buckets.get(identifier);
    }
    
    // Create new bucket for this client
    const bucket = new TokenBucket(capacity, refillRate);
    this.buckets.set(identifier, bucket);
    
    return bucket;
  }

  /**
   * Check if request is allowed and consume token if it is
   * @param {string} identifier - Client identifier
   * @param {object} options - Rate limit configuration
   * @returns {object} - { allowed: boolean, retryAfter: number, remaining: number }
   */
  checkLimit(identifier, options) {
    const { capacity, refillRate, tokens = 1 } = options;
    
    // Get or create bucket for this client
    const bucket = this.getBucket(identifier, capacity, refillRate);
    
    // Try to consume tokens
    const allowed = bucket.consume(tokens);
    
    // Get current state for response headers
    const state = bucket.getState();
    
    return {
      allowed,
      remaining: Math.floor(state.tokens),
      retryAfter: allowed ? 0 : bucket.getRetryAfter(tokens),
      limit: capacity,
      resetTime: Date.now() + (state.timeUntilRefill || 0)
    };
  }

  /**
   * Reset a specific client's bucket (useful for testing or admin actions)
   * @param {string} identifier - Client identifier
   */
  reset(identifier) {
    this.buckets.delete(identifier);
  }

  /**
   * Reset all buckets (useful for testing)
   */
  resetAll() {
    this.buckets.clear();
  }

  /**
   * Get current stats (useful for monitoring/debugging)
   * @returns {object} - Store statistics
   */
  getStats() {
    return {
      totalClients: this.buckets.size,
      clients: Array.from(this.buckets.keys())
    };
  }

  /**
   * Cleanup inactive buckets to prevent memory leaks
   * Runs every 10 minutes by default
   */
  startCleanup(intervalMs = 10 * 60 * 1000) {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const inactiveThreshold = 60 * 60 * 1000; // 1 hour
      
      for (const [identifier, bucket] of this.buckets.entries()) {
        // If bucket hasn't been accessed in over an hour, remove it
        const timeSinceLastUse = now - bucket.lastRefill;
        if (timeSinceLastUse > inactiveThreshold) {
          this.buckets.delete(identifier);
        }
      }
      
      console.log(`[MemoryStore] Cleanup: ${this.buckets.size} active clients`);
    }, intervalMs);
  }

  /**
   * Stop cleanup interval (useful for testing and graceful shutdown)
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

module.exports = MemoryStore;