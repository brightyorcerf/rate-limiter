
![image.jpg](image.jpg)
Production-grade distributed API rate limiter.

---       
## Tech Stack  

### Node.js + Express
Rate limiting is I/O bound, not CPU bound. Node's event loop handles concurrent requests beautifully, and Express middleware makes integration simple. Rust or Go would have been an overkill.

### Redis
- Atomic operations via Lua scripts (no race conditions)
- Sub-millisecond latency (your API stays fast)
- Built-in TTL (auto-cleanup, no memory leaks)

Tried PostgreSQL first, the latency was noticeable even at moderate load.  

---

## How It Works  

### The Token Bucket Flow
```
1. Request hits middleware
2. Get client ID  
3. Fetch bucket from Redis (or create new)
4. Calculate tokens added since last request
5. Try to consume 1 token
6. If success → allow request (200)
   If fail → reject with retry time (429)
```

### The Redis Lua Script  
Here's where it gets interesting. We can't just do:
```javascript
tokens = redis.get('tokens')
if (tokens > 0) redis.set('tokens', tokens - 1)
```

Between `get` and `set`, another server might have consumed those same tokens (Race condition)

We use Lua scripts to execute atomically in Redis:
```lua
-- get current state
local tokens = redis.call('HGET', key, 'tokens')
-- calculate refill
tokens = tokens + (time_passed * refill_rate)
-- try to consume
if tokens >= 1 then
  tokens = tokens - 1
  return {1, tokens}  -- success
end
return {0, tokens}  -- fail
```

### Architecture
```
┌─────────────┐      ┌─────────────┐      ┌─────────────┐
│  Server 1   │      │  Server 2   │      │  Server 3   │
│   :3000     │      │   :3001     │      │   :3002     │
└──────┬──────┘      └──────┬──────┘      └──────┬──────┘
       │                    │                    │
       └────────────────────┼────────────────────┘
                            │
                     ┌──────▼──────┐
                     │             │
                     │    Redis    │
                     │             │ 
                     └─────────────┘
```

Rate limits are truly distributed as all servers share the same Redis instance.

---

### The Performance Surprise 

```
Without rate limiting: ~2.3ms average latency
With MemoryStore:      ~2.4ms average latency  (+0.1ms)
With RedisStore:       ~2.7ms average latency  (+0.4ms)
``` 

---

## Installation

### Quick Start (In-Memory)
```bash
# clone and install
git clone https://github.com/yourusername/rateguard.git
cd rateguard
npm install

# run demo server
npm start

# test it
for i in {1..10}; do curl http://localhost:3000/api/expensive; done
```

### Production (Redis)
```bash
# install Redis
brew install redis  # Mac
# or
sudo apt-get install redis-server  # Linux

# start Redis
redis-server

# run Redis-backed server
node src/demo/server-redis.js

# test distributed limiting
PORT=3001 node src/demo/server-redis.js  # Start second server
curl http://localhost:3000/api/expensive  # Hit server 1
curl http://localhost:3001/api/expensive  # Hit server 2 (shares limit!)
```

---

## Usage

### Basic Express Integration
```javascript
const rateLimiter = require('./middleware/rateLimiter');

// Global rate limit (60 req/min)
app.use(rateLimiter({ requestsPerMinute: 60 }));

// Strict endpoint (5 req/min)
app.post('/api/expensive', 
  rateLimiter({ requestsPerMinute: 5 }),
  handler
);
```

### With Redis (Multi-Server)
```javascript
const RedisStore = require('./storage/redisStore');

const redisStore = new RedisStore({
  host: 'localhost',
  port: 6379
});

app.use(rateLimiter({
  requestsPerMinute: 100,
  store: redisStore  // Distributed!
}));
```

### Custom Identifiers (API Keys)
```javascript
app.use(rateLimiter({
  requestsPerMinute: 10,
  identifier: (req) => req.headers['x-api-key'] || req.ip
}));
```

---

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `requestsPerMinute` | number | 60 | Rate limit (tokens/min) |
| `capacity` | number | `requestsPerMinute` | Max burst size |
| `store` | object | `MemoryStore` | Storage backend (use `RedisStore` for production) |
| `identifier` | function | `(req) => req.ip` | How to identify clients |
| `skip` | function | `() => false` | Skip rate limiting conditionally |
| `message` | string | "Too many requests..." | Custom error message |

---

## Testing

### run algorithm tests
```bash
node tests/tokenBucket.test.js
```

### load testing
```bash
# install Apache Bench
brew install httpd  # Mac

# test single server
ab -n 1000 -c 10 http://localhost:3000/api/expensive

# test distributed (run 2 servers first)
ab -n 500 -c 10 http://localhost:3000/api/expensive &
ab -n 500 -c 10 http://localhost:3001/api/expensive &
```

---

## admin endpoints (redis only)

```bash
# view statistics
curl http://localhost:3000/api/admin/stats

# check specific client's bucket
curl http://localhost:3000/api/admin/bucket/192.168.1.1

# reset client's rate limit
curl -X POST http://localhost:3000/api/admin/reset/192.168.1.1
```
--- 

## This project taught me:

- Redis Lua scripts are criminally underused
- Simple algorithms beat complex ones  
- Good developer experience matters (easy config, clear errors)

If you're interviewing for backend roles, build this. Then talk about:
- Distributed systems (multi-server coordination)
- Race conditions (and how Lua scripts prevent them)
- Performance tradeoffs (Redis vs Postgres vs in-memory)
- Production concerns (cleanup, monitoring, graceful degradation)