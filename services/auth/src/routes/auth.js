const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');

const router = express.Router();

// ──────────────────────────────────────────────
// JWT SECRET
// In production, this would be in an environment variable 
// or a secrets manager (AWS Secrets Manager, etc).
// NEVER hardcode secrets in production code.
// For our learning project, this is fine.
// ──────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'pulsetrack-super-secret-key';

// ──────────────────────────────────────────────
// MIDDLEWARE: authenticateToken
// 
// This runs BEFORE protected routes.
// It checks if the request has a valid JWT token.
// If yes → puts user info in req.user and continues.
// If no → returns 401 Unauthorized.
// 
// WHY JWT? 
// JWT (JSON Web Token) is stateless authentication.
// The token itself contains the user's info (id, email).
// We don't need to query the database on every request 
// to check "is this user logged in?" — we just verify 
// the token's signature. This is faster and scales better.
// 
// SYSTEM DESIGN CONNECTION:
// Stateless auth = easier horizontal scaling.
// If you stored sessions in server memory, user must 
// always hit the SAME server. With JWT, any server works.
// ──────────────────────────────────────────────
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  // Token comes as: "Bearer eyJhbGciOi..."
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email }
    next(); // continue to the actual route
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// ══════════════════════════════════════════════
// ROUTE 1: POST /api/auth/register
// 
// Creates a new user account.
// Hashes the password with bcrypt before storing.
// 
// WHY bcrypt?
// If someone steals your database, they get password_hash.
// bcrypt is intentionally SLOW to hash — making it 
// extremely hard to brute-force backwards from hash to password.
// NEVER store plain text passwords.
// ══════════════════════════════════════════════
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Hash password (10 salt rounds — good balance of security vs speed)
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert into database
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [email, passwordHash]
    );

    // $1, $2 are parameterized queries — they prevent SQL injection.
    // NEVER do: `INSERT INTO users VALUES ('${email}', '${password}')` 
    // An attacker could set email to: '; DROP TABLE users; --

    res.status(201).json({
      message: 'User registered successfully',
      user: result.rows[0],
    });
  } catch (error) {
    // PostgreSQL error code 23505 = unique_violation (duplicate email)
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error('Register error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════
// ROUTE 2: POST /api/auth/login
// 
// Verifies email + password, returns a JWT token.
// The client stores this token and sends it with 
// every future request in the Authorization header.
// ══════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user by email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Compare provided password with stored hash
    const isValid = await bcrypt.compare(password, user.password_hash);

    if (!isValid) {
      // Same error message whether email or password is wrong
      // WHY? So attackers can't figure out which emails exist
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Generate JWT token — expires in 24 hours
    const token = jwt.sign(
      { id: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: { id: user.id, email: user.email },
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════
// ROUTE 3: POST /api/auth/projects
// 
// Creates a new project (= one website to track).
// PROTECTED — requires JWT token.
// ══════════════════════════════════════════════
router.post('/projects', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Project name is required' });
    }

    const result = await pool.query(
      'INSERT INTO projects (name, user_id) VALUES ($1, $2) RETURNING id, name, user_id, created_at',
      [name, req.user.id]  // req.user.id comes from the JWT (set by authenticateToken)
    );

    res.status(201).json({
      message: 'Project created',
      project: result.rows[0],
    });
  } catch (error) {
    console.error('Create project error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════
// ROUTE 4: GET /api/auth/projects
// 
// Lists all projects belonging to the logged-in user.
// PROTECTED — requires JWT token.
// ══════════════════════════════════════════════
router.get('/projects', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, created_at FROM projects WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );

    res.json({ projects: result.rows });
  } catch (error) {
    console.error('List projects error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════════
// ROUTE 5: POST /api/auth/projects/:id/keys
// 
// Generates a new API key for a project.
// The key format is: pk_<uuid> (pk = PulseTrack Key)
// 
// WHY uuid? UUIDs are universally unique — virtually 
// impossible to guess or collide, even across billions of keys.
// This is important because API keys are essentially passwords.
// 
// PROTECTED — requires JWT token + must own the project.
// ══════════════════════════════════════════════
router.post('/projects/:id/keys', authenticateToken, async (req, res) => {
  try {
    const projectId = parseInt(req.params.id);

    // Verify the project exists AND belongs to this user
    // WHY check ownership? Without this, any logged-in user 
    // could generate keys for someone else's project!
    const project = await pool.query(
      'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
      [projectId, req.user.id]
    );

    if (project.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Generate a unique API key
    const apiKey = `pk_${uuidv4().replace(/-/g, '')}`;

    const result = await pool.query(
      'INSERT INTO api_keys (key, project_id) VALUES ($1, $2) RETURNING id, key, project_id, is_active, created_at',
      [apiKey, projectId]
    );

    res.status(201).json({
      message: 'API key generated',
      apiKey: result.rows[0],
    });
  } catch (error) {
    console.error('Generate API key error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
