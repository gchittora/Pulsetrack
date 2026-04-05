const { Pool } = require('pg');

// ──────────────────────────────────────────────
// PostgreSQL CONNECTION POOL
// 
// The ingestion service needs PostgreSQL for ONE thing only:
// validating API keys. When a website sends an event with
// API key "pk_abc123", we need to check:
// 1. Does this key exist in the api_keys table?
// 2. Is it active (is_active = true)?
// 3. Which project_id does it belong to?
// 
// WHY not just use Redis for key validation?
// We WILL cache validated keys in Redis (see routes/ingest.js).
// But the source of truth must be PostgreSQL — if someone
// revokes a key, the revocation must take effect promptly.
// Redis cache has a short TTL so revoked keys stop working
// within minutes.
// 
// WHY a smaller pool (5) than the auth service (10)?
// The ingestion service only does simple SELECT queries on
// api_keys. It doesn't do complex transactions or writes.
// 5 connections is plenty for key lookups, and we want to
// leave PostgreSQL connections available for the auth service
// which does heavier work (INSERT, UPDATE).
// ──────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     process.env.PG_PORT     || 5433,
  user:     process.env.PG_USER     || 'pulse_admin',
  password: process.env.PG_PASSWORD || 'pulse_secret',
  database: process.env.PG_DATABASE || 'pulsetrack',

  max: 5,                    // smaller pool — only doing key lookups
  idleTimeoutMillis: 30000,
});

module.exports = { pool };
