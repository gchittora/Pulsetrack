const express = require('express');
const { redis } = require('../redis');
const { pool } = require('../db');

const router = express.Router();

// ──────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────
const STREAM_NAME = 'events:raw';           // Redis Stream where all events land
const RATE_LIMIT_WINDOW = 1;                // 1 second window
const RATE_LIMIT_MAX = 1000;                // max 1000 events per second per API key
const API_KEY_CACHE_TTL = 300;              // cache validated keys for 5 minutes (seconds)

// ──────────────────────────────────────────────
// HELPER: Validate API Key
// 
// This implements the CACHE-ASIDE pattern:
// 1. Check Redis cache first (fast: ~0.5ms)
// 2. If cache miss → check PostgreSQL (slower: ~5ms)
// 3. If found in PostgreSQL → cache it in Redis for next time
// 
// WHY cache?
// At 5000 events/sec, that's 5000 PostgreSQL queries/sec
// JUST for key validation. With caching, it's ~1 query every
// 5 minutes per key. 5000x reduction in database load.
// 
// WHY 5 minute TTL?
// If someone revokes an API key, we want it to stop working
// within 5 minutes. Shorter TTL = faster revocation but more
// DB queries. 5 minutes is a good balance.
// ──────────────────────────────────────────────
async function validateApiKey(apiKey) {
  const { redis } = require('../redis');
  const cacheKey = `apikey:${apiKey}`;

  // Step 1: Check Redis cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached); // { project_id, is_active }
  }

  // Step 2: Cache miss — query PostgreSQL
  const result = await pool.query(
    'SELECT project_id, is_active FROM api_keys WHERE key = $1',
    [apiKey]
  );

  if (result.rows.length === 0) {
    return null; // key doesn't exist
  }

  const keyData = result.rows[0];

  // Step 3: Cache the result in Redis (even inactive keys — so we don't
  // keep hitting PostgreSQL for invalid keys)
  await redis.set(cacheKey, JSON.stringify(keyData), 'EX', API_KEY_CACHE_TTL);

  return keyData;
}

// ──────────────────────────────────────────────
// HELPER: Rate Limiter (Sliding Window Counter)
// 
// HOW IT WORKS:
// We use Redis's INCR + EXPIRE as a simple rate limiter.
// Key format: "ratelimit:{apiKey}:{currentSecond}"
// 
// Example at time 1711900000:
//   INCR ratelimit:pk_abc:1711900000  → returns count
//   EXPIRE ratelimit:pk_abc:1711900000 2  → auto-delete after 2 seconds
// 
// If count > 1000 → reject with 429 Too Many Requests
// 
// WHY this approach (and not Nginx rate limiting)?
// - Nginx rate limits by IP address
// - We need to rate limit by API KEY
// - Two customers sharing the same office IP shouldn't
//   interfere with each other's rate limits
// - This also means each customer gets their fair share,
//   regardless of how many servers they're behind
// 
// WHY Redis (not in-memory)?
// With 3 ingestion instances, an in-memory counter would
// only count events hitting THAT instance. Instance #1 might
// see 300, #2 sees 400, #3 sees 300 = 1000 total, but each
// instance thinks it's under the limit. Redis is shared across
// all instances → accurate global count.
// ──────────────────────────────────────────────
async function checkRateLimit(apiKey) {
  const { redis } = require('../redis');
  const now = Math.floor(Date.now() / 1000); // current second
  const rateLimitKey = `ratelimit:${apiKey}:${now}`;

  // INCR atomically increments and returns the new value.
  // If the key doesn't exist, Redis creates it with value 1.
  const count = await redis.incr(rateLimitKey);

  // Set expiry only on first increment (when count is 1)
  // WHY 2 seconds? 1 second for the current window + 1 second buffer
  // to ensure the key is cleaned up even with clock skew.
  if (count === 1) {
    await redis.expire(rateLimitKey, 2);
  }

  return {
    allowed: count <= RATE_LIMIT_MAX,
    current: count,
    limit: RATE_LIMIT_MAX,
  };
}

// ══════════════════════════════════════════════
// ROUTE: POST /api/events/ingest
// 
// This is THE endpoint. Every tracked website sends events here.
// 
// Request format:
// POST /api/events/ingest
// Headers: { "X-API-Key": "pk_abc123", "Content-Type": "application/json" }
// Body: {
//   "event": "page_view",
//   "properties": { "url": "/pricing", "referrer": "google.com" },
//   "timestamp": 1711900000000,   (optional — we add server time if missing)
//   "user_id": "user_abc"         (optional — anonymous if missing)
// }
// 
// Response: 202 Accepted (NOT 200 OK)
// WHY 202? The event is accepted for processing but not yet stored
// in MongoDB. It's in Redis Streams, waiting for workers to process.
// 202 = "I got it, I'll deal with it later" — the honest status code.
// ══════════════════════════════════════════════
router.post('/ingest', async (req, res) => {
  try {
    // ── Step 1: Extract API key from header ──
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
      return res.status(401).json({
        error: 'Missing Authentication',
        message: 'The X-API-Key header is required. Please include your project API key in the request headers.'
      });
    }

    // ── Step 2: Validate API key ──
    const keyData = await validateApiKey(apiKey);

    if (!keyData) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    if (!keyData.is_active) {
      return res.status(403).json({ error: 'API key has been revoked' });
    }

    // ── Step 3: Rate limit check ──
    const rateLimit = await checkRateLimit(apiKey);

    if (!rateLimit.allowed) {
      // 429 = Too Many Requests. Include rate limit info in response
      // so the client SDK knows when to back off.
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit: rateLimit.limit,
        current: rateLimit.current,
        retryAfter: 1, // seconds
      });
    }

    // ── Step 4: Validate event data ──
    const { event, properties, timestamp, user_id } = req.body;

    if (!event) {
      return res.status(400).json({
        error: 'Missing Event Payload',
        message: 'The "event" field is required in the JSON body to specify the type of action (e.g., "page_view", "click").'
      });
    }

    // ── Step 5: Build the event object ──
    // We add server-side metadata that the client can't fake:
    // - server_timestamp: when WE received it (client timestamps can be wrong)
    // - project_id: derived from the API key (client never sends this)
    const eventData = {
      event,
      properties: properties || {},
      user_id: user_id || 'anonymous',
      timestamp: timestamp || Date.now(),
      server_timestamp: Date.now(),
      project_id: keyData.project_id,
    };

    // ── Step 6: Push to Redis Streams ──
    // XADD = "add an entry to a stream"
    // '*' = let Redis generate a unique ID (timestamp-based)
    // 'data' = the field name, JSON.stringify = the value
    //
    // WHY JSON.stringify?
    // Redis Streams store field-value pairs (like a hash).
    // We could store each field separately:
    //   XADD events:raw * event page_view project_id 5 user_id abc
    // But JSON is easier to parse on the worker side, and we
    // don't need to query individual fields in the stream.
    const { redis: redisClient } = require('../redis');
    const streamId = await redisClient.xadd(
      STREAM_NAME,
      '*',                          // auto-generate ID
      'data', JSON.stringify(eventData)  // field: "data", value: JSON string
    );

    // ── Step 7: Respond immediately ──
    // The event is now safely in Redis Streams.
    // Workers will pick it up asynchronously.
    res.status(202).json({
      accepted: true,
      streamId,
    });

  } catch (error) {
    console.error('Ingest error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
