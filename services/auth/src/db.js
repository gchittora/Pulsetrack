const { Pool } = require('pg');

// ──────────────────────────────────────────────
// CONNECTION POOL
// 
// WHY a Pool instead of a single Client?
// 
// A single Client = one connection to PostgreSQL.
// If 100 requests come in at the same time, they all wait 
// in line for that one connection. Slow!
// 
// A Pool = multiple connections (default 10).
// 100 requests come in → 10 are processed in parallel,
// the rest wait briefly. Much faster under load.
// 
// SYSTEM DESIGN CONNECTION:
// This is a micro version of "horizontal scaling" — instead 
// of scaling servers, we're scaling database connections 
// within one server. Same principle: more workers = more throughput.
// ──────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     process.env.PG_PORT     || 5433,
  user:     process.env.PG_USER     || 'pulse_admin',
  password: process.env.PG_PASSWORD || 'pulse_secret',
  database: process.env.PG_DATABASE || 'pulsetrack',

  // Pool settings
  max: 10,                // max 10 connections in the pool
  idleTimeoutMillis: 30000,  // close idle connections after 30 seconds
});

// ──────────────────────────────────────────────
// INITIALIZE DATABASE TABLES
// 
// This function creates our 3 tables if they don't exist.
// "IF NOT EXISTS" means it's safe to call this multiple times —
// it won't crash if the tables already exist.
// 
// WHY these exact tables?
// See comments inside each CREATE TABLE.
// ──────────────────────────────────────────────
async function initializeDatabase() {
  const client = await pool.connect();
  
  try {
    await client.query(`
      -- ==========================================
      -- USERS TABLE
      -- 
      -- Stores website owners who sign up for PulseTrack.
      -- email has UNIQUE constraint — no duplicate accounts.
      -- We store password_hash, NEVER the plain password.
      -- (bcrypt handles hashing — we'll use it in the routes)
      -- ==========================================
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMP DEFAULT NOW()
      );

      -- ==========================================
      -- PROJECTS TABLE
      -- 
      -- Each project = one website being tracked.
      -- user_id is a FOREIGN KEY → links to who owns it.
      -- 
      -- ON DELETE CASCADE means: if you delete a user,
      -- all their projects are automatically deleted too.
      -- This maintains data integrity (no orphan projects).
      -- 
      -- SYSTEM DESIGN CONNECTION:
      -- Foreign keys are a SQL superpower. In NoSQL (MongoDB),
      -- there's no built-in way to enforce "this project MUST 
      -- belong to a real user." You'd have to code that yourself.
      -- This is why we chose PostgreSQL for auth data.
      -- ==========================================
      CREATE TABLE IF NOT EXISTS projects (
        id          SERIAL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at  TIMESTAMP DEFAULT NOW()
      );

      -- ==========================================
      -- API_KEYS TABLE
      -- 
      -- Each API key belongs to a project.
      -- Website owners paste this key into their website's 
      -- tracking snippet. When events come in, we validate 
      -- the key to know which project the events belong to.
      -- 
      -- WHY is_active? So owners can REVOKE old keys without 
      -- deleting them. Create a new key, revoke the old one.
      -- Zero downtime key rotation.
      -- 
      -- WHY separate from projects table?
      -- One project can have multiple keys (current + old ones).
      -- If keys were a column in projects, you'd only have one.
      -- ==========================================
      CREATE TABLE IF NOT EXISTS api_keys (
        id          SERIAL PRIMARY KEY,
        key         VARCHAR(255) UNIQUE NOT NULL,
        project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        is_active   BOOLEAN DEFAULT true,
        created_at  TIMESTAMP DEFAULT NOW()
      );

      -- ==========================================
      -- INDEXES
      -- 
      -- WHY? Without indexes, finding a user by email means 
      -- scanning EVERY row in the users table — O(N).
      -- With an index, PostgreSQL uses a B-tree → O(log N).
      -- 
      -- We already get an index on 'email' from UNIQUE constraint.
      -- But we add explicit indexes on foreign keys because 
      -- PostgreSQL doesn't auto-index foreign keys (unlike MySQL).
      -- 
      -- These indexes matter when you have millions of rows.
      -- "Find all projects for user_id=42" goes from scanning 
      -- every project to jumping directly to user 42's projects.
      -- ==========================================
      CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_project_id ON api_keys(project_id);
      CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
    `);

    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error.message);
    throw error;
  } finally {
    // ALWAYS release the client back to the pool.
    // If you forget this, you "leak" connections — eventually 
    // the pool runs out and your app hangs. Classic bug.
    client.release();
  }
}

module.exports = { pool, initializeDatabase };
