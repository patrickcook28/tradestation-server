const pool = require('../db');
const logger = require('../config/logging');

/**
 * Middleware to require superuser permissions for protected routes
 * Must be used after authenticateToken middleware
 */
const requireSuperuser = async (req, res, next) => {
  try {
    // Ensure user is authenticated (should be set by authenticateToken middleware)
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if user is superuser
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [req.user.id]);
    
    if (userResult.rows.length === 0) {
      logger.auth(req.method, req.path, 'User Not Found', req.user.id);
      return res.status(404).json({ error: 'User not found' });
    }

    if (!userResult.rows[0]?.superuser) {
      logger.auth(req.method, req.path, 'Superuser Access Denied', req.user.id);
      return res.status(403).json({ error: 'Admin access required' });
    }

    logger.auth(req.method, req.path, 'Superuser Access Granted', req.user.id);
    next();
  } catch (error) {
    logger.error('Error in superuser check middleware:', error);
    return res.status(500).json({ error: 'Failed to verify superuser status' });
  }
};

module.exports = {
  requireSuperuser
};
