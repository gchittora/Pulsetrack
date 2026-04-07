require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { connectMongo } = require('./db');
const { redis } = require('./redis');
const Redis = require('ioredis');
const { authenticateToken } = require('./middleware/auth');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());

// Protect ALL analytics routes with JWT middleware
app.use('/', authenticateToken, analyticsRoutes);

// Simple healthcheck
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'query' });
});

// ------------------------------------------------------------------
// Real-time stats endpoint — reads from Redis aggregation counters
// O(1) lookup instead of MongoDB aggregation pipeline.
// These counters are maintained by the worker's aggregator.
// ------------------------------------------------------------------
app.get('/stats/realtime', authenticateToken, async (req, res) => {
  try {
    const projectId = req.query.project_id || '1';
    const today = new Date().toISOString().split('T')[0];

    const pipeline = redis.pipeline();
    pipeline.get(`stats:${projectId}:total`);
    pipeline.pfcount(`stats:${projectId}:users`);
    pipeline.get(`stats:${projectId}:daily:${today}`);
    pipeline.get(`stats:${projectId}:event:page_view`);
    pipeline.get(`stats:${projectId}:event:signup`);
    pipeline.get(`stats:${projectId}:event:purchase`);
    pipeline.get(`stats:${projectId}:event:button_click`);

    const results = await pipeline.exec();

    res.json({
      project_id: projectId,
      total_events: parseInt(results[0][1]) || 0,
      unique_users: parseInt(results[1][1]) || 0,
      events_today: parseInt(results[2][1]) || 0,
      by_type: {
        page_view: parseInt(results[3][1]) || 0,
        signup: parseInt(results[4][1]) || 0,
        purchase: parseInt(results[5][1]) || 0,
        button_click: parseInt(results[6][1]) || 0,
      },
      timestamp: new Date().toISOString(),
      _source: 'REDIS_COUNTERS'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// WebSocket Server (Socket.io)
//
// WHY WebSocket instead of polling?
//   Polling: client asks "any updates?" every N seconds — wasteful
//   WebSocket: server pushes updates the instant they happen — real-time
//
// The dashboard connects once and receives:
//   - 'alert' events from the Alert Worker via Redis Pub/Sub
//   - 'stats' events every 2 seconds with fresh counter data
// ------------------------------------------------------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// Redis Pub/Sub subscriber (separate connection — Redis requires it)
const subscriber = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379
});

subscriber.subscribe('alerts:spike', (err) => {
  if (err) console.error('[Query] Failed to subscribe to alerts:', err.message);
  else console.log('[Query] Subscribed to alerts:spike channel');
});

// Bridge: Redis Pub/Sub → WebSocket
subscriber.on('message', (channel, message) => {
  if (channel === 'alerts:spike') {
    console.log('[Query] Alert received, broadcasting to dashboard');
    io.emit('alert', JSON.parse(message));
  }
});

// Push real-time stats to all connected clients every 2 seconds
setInterval(async () => {
  if (io.engine.clientsCount === 0) return; // No clients, skip

  try {
    const projectId = '1';
    const today = new Date().toISOString().split('T')[0];

    const pipeline = redis.pipeline();
    pipeline.get(`stats:${projectId}:total`);
    pipeline.pfcount(`stats:${projectId}:users`);
    pipeline.get(`stats:${projectId}:daily:${today}`);

    const results = await pipeline.exec();

    io.emit('stats', {
      total_events: parseInt(results[0][1]) || 0,
      unique_users: parseInt(results[1][1]) || 0,
      events_today: parseInt(results[2][1]) || 0,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    // Silently fail — stats push is best-effort
  }
}, 2000);

io.on('connection', (socket) => {
  console.log(`[Query] Dashboard connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[Query] Dashboard disconnected: ${socket.id}`);
  });
});

async function start() {
  await connectMongo();

  server.listen(PORT, () => {
    console.log(`[Query] Service is listening on port ${PORT}`);
    console.log(`[Query] WebSocket server ready for dashboard connections`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Query] Shutting down...');
    subscriber.disconnect();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch(err => {
  console.error('[Query] Fatal error:', err);
  process.exit(1);
});
