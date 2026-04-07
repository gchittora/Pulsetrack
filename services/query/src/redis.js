const Redis = require('ioredis');

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = process.env.REDIS_PORT || 6379;

const redis = new Redis({
  host: redisHost,
  port: redisPort,
  retryStrategy(times) {
    if (times > 10) return null; // Stop retrying after 10 tries for API handlers
    return Math.min(times * 100, 2000);
  }
});

redis.on('connect', () => {
  console.log(`[Query] ✅ Connected to Redis at ${redisHost}:${redisPort}`);
});

redis.on('error', (err) => {
  console.error(`[Query] ❌ Redis connection error: ${err.message}`);
});

async function closeRedis() {
  await redis.quit();
  console.log('[Query] Redis connection gracefully closed.');
}

module.exports = { redis, closeRedis };
