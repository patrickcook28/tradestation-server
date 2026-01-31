const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('./auth');
const { requireSuperuser } = require('../middleware/superuserCheck');
const logger = require('../config/logging');

/**
 * Get all users (admin only) - for Users table in admin area
 */
router.get('/users', authenticateToken, requireSuperuser, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.id as user_id,
        u.email,
        u.beta_user,
        u.early_access,
        u.early_access_started_at,
        u.referral_code as user_referral_code,
        bt.started_at,
        bt.requested_at,
        bt.notes,
        (SELECT MAX(created_at) 
         FROM analytics_events 
         WHERE user_id = u.id) as last_activity_at
      FROM users u
      LEFT JOIN beta_tracking bt ON bt.user_id = u.id
      ORDER BY u.id DESC
    `);

    res.json({ success: true, users: result.rows });
  } catch (error) {
    logger.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

module.exports = router;
