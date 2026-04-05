const Redis = require('ioredis');

// ──────────────────────────────────────────────
// REDIS CLIENT
// 
// WHY ioredis?
// - First-class Redis Streams support (XADD, XREAD, XREADGROUP)
// - Auto-reconnection if Redis restarts
// - Built-in Pub/Sub support (we'll use in Phase 3)
// - Battle-tested in production (used by Alibaba at scale)
// 
// WHY a single client (not a pool)?
// Unlike PostgreSQL, Redis is single-threaded and handles
// multiplexing internally. One TCP connection can handle
// thousands of concurrent commands via pipelining.
// A pool of Redis connections would actually be SLOWER
// because of connection overhead with no parallelism gain.
// ──────────────────────────────────────────────
let redis = null;

function createRedisClient() {
  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,

    // Retry strategy: if Redis is temporarily down, keep trying
    // WHY? In Docker, Redis might take a few seconds to start.
    // Without retry, the ingestion service would crash immediately
    // on startup and keep restart-looping.
    retryStrategy(times) {
      if (times > 10) {
        console.error('Redis connection failed after 10 retries. Giving up.');
        return null; // stop retrying
      }
      const delay = Math.min(times * 200, 2000); // 200ms, 400ms, 600ms... max 2s
      console.log(`Redis retry #${times} in ${delay}ms...`);
      return delay;
    },

    // Connection timeout
    connectTimeout: 10000, // 10 seconds max to establish connection

    // Max retries per request (not per connection)
    maxRetriesPerRequest: 3,
  });
}

// ──────────────────────────────────────────────
// CONNECT / DISCONNECT
// 
// We export functions (not the client directly) so that:
// 1. index.js can await the connection before starting the server
// 2. Graceful shutdown can cleanly close the connection
// 3. Tests can mock the Redis client
// ──────────────────────────────────────────────
async function connectRedis() {
  redis = createRedisClient();

  return new Promise((resolve, reject) => {
    redis.on('connect', () => resolve());
    redis.on('error', (err) => {
      // Only reject if we haven't connected yet
      // After connection, errors are logged but don't crash
      if (!redis.status || redis.status === 'connecting') {
        reject(err);
      } else {
        console.error('Redis error:', err.message);
      }
    });
  });
}

async function disconnectRedis() {
  if (redis) {
    await redis.quit(); // quit = send QUIT command then close (graceful)
    // redis.disconnect() would close immediately (not graceful)
  }
}

module.exports = { 
  get redis() { return redis; }, // getter so it's always the current instance
  connectRedis, 
  disconnectRedis 
};
