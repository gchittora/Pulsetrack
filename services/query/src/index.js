const express = require('express');
const { connectMongo, closeMongo } = require('./db');
const { closeRedis } = require('./redis');
const { authenticateToken } = require('./middleware/auth');
const analyticsRoutes = require('./routes/analytics');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(express.json());

// Protect ALL analytics routes with the JWT middleware instantly!
app.use('/analytics', authenticateToken, analyticsRoutes);

// Simple healthcheck endpoint for Docker Compose
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'query' });
});

async function startServer() {
  console.log('Starting PulseTrack Query Service...');

  // Connect to Database
  await connectMongo();

  const server = app.listen(PORT, () => {
    console.log(`[Query] 🚀 Service is listening on port ${PORT}`);
  });

  // Graceful Shutdown
  const shutdown = async () => {
    console.log('\n[Query] Graceful shutdown initiated...');
    server.close(async () => {
      console.log('[Query] Express HTTP server gracefully closed.');
      await closeMongo();
      await closeRedis();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer();
