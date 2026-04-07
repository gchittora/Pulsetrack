const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_dev_only';

// Middleware to protect dashboard analytics endpoints
function authenticateToken(req, res, next) {
  // We expect to receive the JWT in the Authorization header (e.g. "Bearer eyJhb...")
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Access token is missing.'
    });
  }

  // The Query service shares the exact same JWT_SECRET as the Auth service,
  // so it can cryptographically verify tokens completely independently!
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Access token is invalid or has expired.'
      });
    }

    // Attach the verified user details (like user_id) to the request
    req.user = user;
    next();
  });
}

module.exports = { authenticateToken };
