require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');
const { connectMongo } = require('./db');
const { startWorker } = require('./worker');
const reportRoutes = require('./routes');
const { ensureBucket } = require('./storage');

const app = express();
const PORT = process.env.PORT || 3004;
const JWT_SECRET = process.env.JWT_SECRET || 'pulsetrack-dev-secret-change-in-production';

app.use(express.json());

// JWT auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ error: 'Invalid token' });
  }
}

// Mount routes
app.use('/', authenticateToken, reportRoutes);

// Health check (NOT protected by JWT)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'report' });
});

async function start() {
  await connectMongo();

  // Retry MinIO connection until ready
  const maxRetries = 5;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      await ensureBucket();
      break;
    } catch (err) {
      console.log(`[Report] MinIO not ready (attempt ${i}/${maxRetries}): ${err.message}`);
      if (i === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  await startWorker();

  app.listen(PORT, () => {
    console.log(`[Report] API listening on port ${PORT}`);
  });
}

start().catch(err => {
  console.error('[Report] Fatal error:', err);
  process.exit(1);
});
