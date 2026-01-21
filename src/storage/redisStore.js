/**
 * Redis Store for Rate Limiter
 * 
 * Distributed rate limiting using Redis
 * Multiple servers can share the same rate limit state
 * 
 * Benefits over in-memory:
 * - Works across multiple servers
 * - Persists through server restarts
 * - Centralized monitoring
 */

const redis = require('redis');

class RedisStore {
  /**
   * @param {object} options - Redis configuration
   */
  constructor(options = {}) {
    this.options = {
      host: options.host || 'localhost',
      port: options.port || 6379,
      password: options.password || undefined,
      db: options.db || 0,
      keyPrefix: options.keyPrefix || 'ratelimit:',
      ...options
    };

    this.client = null;
    this.isConnected = false;
  }

  /**
   * Connect to Redis
   */
  async connect() {
    if (this.isConnected) {
      return;
    }

    try {
      this.client = redis.createClient({
        socket: {
          host: this.options.host,
          port: this.options.port
        },
        password: this.options.password,
        database: this.options.db
      });

      // Error handling
      this.client.on('error', (err) => {
        console.error('[RedisStore] Redis error:', err);
      });

      this.client.on('connect', () => {
        console.log('[RedisStore] Connected to Redis');
      });

      this.client.on('ready', () => {
        console.log('[RedisStore] Redis is ready');
        this.isConnected = true;
      });

      await this.client.connect();
    } catch (error) {
      console.error('[RedisStore] Failed to connect:', error);
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect() {
    if (this.client && this.isConnected) {
      await this.client.quit();
      this.isConnected = false;
    }
  }

  /**
   * Generate Redis key for a client
   */
  getKey(identifier) {
    return `${this.options.keyPrefix}${identifier}`;
  }

  /**
   * Check rate limit using token bucket algorithm in Redis
   * Uses Lua script for atomic operations
   * 
   * @param {string} identifier - Client identifier
   * @param {object} options - Rate limit configuration
   * @returns {object} - { allowed, remaining, retryAfter, limit, resetTime }
   */
  async checkLimit(identifier, options) {
    if (!this.isConnected) {
      await this.connect();
    }

    const { capacity, refillRate, tokens = 1 } = options;
    const key = this.getKey(identifier);
    const now = Date.now();

    /**
     * Lua script for atomic token bucket operations
     * This ensures thread-safety across multiple servers
     * 
     * KEYS[1] = Redis key
     * ARGV[1] = capacity (max tokens)
     * ARGV[2] = refill rate (tokens per second)
     * ARGV[3] = tokens to consume
     * ARGV[4] = current timestamp
     */
    const luaScript = `
      local key = KEYS[1]
      local capacity = tonumber(ARGV[1])
      local refill_rate = tonumber(ARGV[2])
      local tokens_requested = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])
      
      -- Get current bucket state
      local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
      local tokens = tonumber(bucket[1])
      local last_refill = tonumber(bucket[2])
      
      -- Initialize if bucket doesn't exist
      if not tokens then
        tokens = capacity
        last_refill = now
      end
      
      -- Calculate tokens to add based on time passed
      local time_passed = (now - last_refill) / 1000
      local tokens_to_add = time_passed * refill_rate
      tokens = math.min(capacity, tokens + tokens_to_add)
      
      -- Try to consume tokens
      local allowed = 0
      if tokens >= tokens_requested then
        tokens = tokens - tokens_requested
        allowed = 1
      end
      
      -- Save updated state
      redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
      redis.call('EXPIRE', key, 3600) -- Expire after 1 hour of inactivity
      
      -- Calculate retry time
      local retry_after = 0
      if allowed == 0 then
        local tokens_needed = tokens_requested - tokens
        retry_after = math.ceil((tokens_needed / refill_rate) * 1000)
      end
      
      return {allowed, math.floor(tokens), retry_after}
    `;

    try {
      // Execute Lua script atomically
      const result = await this.client.eval(luaScript, {
        keys: [key],
        arguments: [
          capacity.toString(),
          refillRate.toString(),
          tokens.toString(),
          now.toString()
        ]
      });

      const [allowed, remaining, retryAfter] = result;

      return {
        allowed: allowed === 1,
        remaining: remaining,
        retryAfter: retryAfter,
        limit: capacity,
        resetTime: now + retryAfter
      };
    } catch (error) {
      console.error('[RedisStore] Error checking limit:', error);
      
      // Fail open - allow request if Redis is down
      // You might want to fail closed in production
      return {
        allowed: true,
        remaining: capacity,
        retryAfter: 0,
        limit: capacity,
        resetTime: now
      };
    }
  }

  /**
   * Reset rate limit for a specific client
   */
  async reset(identifier) {
    if (!this.isConnected) {
      await this.connect();
    }

    const key = this.getKey(identifier);
    await this.client.del(key);
  }

  /**
   * Reset all rate limits (careful!)
   */
  async resetAll() {
    if (!this.isConnected) {
      await this.connect();
    }

    const pattern = `${this.options.keyPrefix}*`;
    const keys = await this.client.keys(pattern);
    
    if (keys.length > 0) {
      await this.client.del(keys);
    }
    
    return keys.length;
  }

  /**
   * Get statistics about current rate limits
   */
  async getStats() {
    if (!this.isConnected) {
      await this.connect();
    }

    const pattern = `${this.options.keyPrefix}*`;
    const keys = await this.client.keys(pattern);
    
    return {
      totalClients: keys.length,
      clients: keys.map(k => k.replace(this.options.keyPrefix, ''))
    };
  }

  /**
   * Get bucket state for a specific client (for debugging)
   */
  async getBucketState(identifier) {
    if (!this.isConnected) {
      await this.connect();
    }

    const key = this.getKey(identifier);
    const bucket = await this.client.hGetAll(key);
    
    if (!bucket || !bucket.tokens) {
      return null;
    }

    return {
      tokens: parseFloat(bucket.tokens),
      lastRefill: parseInt(bucket.last_refill),
      key: key
    };
  }
}

module.exports = RedisStore;