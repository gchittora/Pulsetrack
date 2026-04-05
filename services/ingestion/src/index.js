const express = require('express');
const { connectRedis, disconnectRedis } = require('./redis');
const { pool } = require('./db');
const ingestRoutes = require('./routes/ingest');

const app = express();

// ──────────────────────────────────────────────
// Parse JSON request bodies
// 
// WHY a size limit?
// Without a limit, an attacker could send a 1GB JSON body
// and crash our server (out of memory). 
// 100kb is generous for a single event batch.
// A typical event is ~500 bytes, so 100kb allows ~200 events per request.
// ──────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));

// ──────────────────────────────────────────────
// HEALTH CHECK
// Checks both Redis AND PostgreSQL connectivity.
// 
// WHY check dependencies?
// A health check that only says "I'm alive" is useless.
// If Redis is down, we can't push to Streams.
// If PostgreSQL is down, we can't validate API keys.
// The load balancer (Nginx) needs to know THIS instance is
// fully functional, not just that the process is running.
// ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { redis } = require('./redis');
    await redis.ping();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'ingestion', redis: 'connected', db: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', service: 'ingestion', error: error.message });
  }
});

// ──────────────────────────────────────────────
// ROUTES
// All ingestion routes are prefixed with /api/events
// Nginx routes: /api/events/* → this service
// ──────────────────────────────────────────────
app.use('/api/events', ingestRoutes);

// ──────────────────────────────────────────────
// START SERVER
// 
// Connect to Redis FIRST, then start listening.
// WHY? If Redis is unreachable, there's no point accepting
// events — we'd have nowhere to put them.
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3002;

async function start() {
  try {
    await connectRedis();
    console.log('Connected to Redis');

    // Quick DB check (pool connects lazily, but let's verify early)
    await pool.query('SELECT 1');
    console.log('Connected to PostgreSQL');

    app.listen(PORT, () => {
      console.log(`Ingestion service running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start ingestion service:', error.message);
    process.exit(1);
  }
}

// ──────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// 
// When Docker stops this container (SIGTERM), we:
// 1. Stop accepting new requests
// 2. Close Redis connection cleanly
// 3. Close PostgreSQL pool cleanly
// 
// WHY? Without this, in-flight requests might fail,
// and connections to Redis/PostgreSQL are left dangling.
// In production with thousands of events/sec, ungraceful
// shutdown = lost events.
// ──────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await disconnectRedis();
  await pool.end();
  process.exit(0);
});

start();
