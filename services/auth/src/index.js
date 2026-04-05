const express = require('express');
const { pool, initializeDatabase } = require('./db');
const authRoutes = require('./routes/auth');

const app = express();

// Parse JSON request bodies
app.use(express.json());

// ──────────────────────────────────────────────
// HEALTH CHECK
// Now also checks if PostgreSQL is reachable.
// A proper health check doesn't just say "I'm alive" —
// it verifies its dependencies are alive too.
// ──────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'auth', db: 'connected' });
  } catch (error) {
    res.status(500).json({ status: 'error', service: 'auth', db: 'disconnected' });
  }
});

// ──────────────────────────────────────────────
// ROUTES
// All auth routes are prefixed with /api/auth
// This keeps our URL structure clean and makes it easy 
// for Nginx to route: /api/auth/* → Auth Service
// ──────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ──────────────────────────────────────────────
// START SERVER
// First initialize the database (create tables),
// THEN start listening for requests.
// WHY this order? If DB init fails, we don't want to 
// accept requests that will all fail anyway.
// ──────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Auth service running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start auth service:', error.message);
    process.exit(1);
  }
}

start();