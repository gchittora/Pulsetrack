const Redis = require('ioredis');

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT || 6379;

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  // Required by some worker configurations that block indefinitely on streams
  maxRetriesPerRequest: null, 
  retryStrategy(times) {
    console.warn(`[Worker] Retrying Redis connection: attempt ${times}`);
    // Reconnect after
    return Math.min(times * 100, 3000);
  }
});

redis.on('connect', () => {
  console.log(`[Worker] ✅ Connected to Redis at ${redisHost}:${redisPort}`);
});

redis.on('error', (err) => {
  console.error(`[Worker] ❌ Redis connection error: ${err.message}`);
});

async function closeRedis() {
  await redis.quit();
  console.log('[Worker] Redis connection gracefully closed.');
}

module.exports = { redis, closeRedis };
