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
    // First check if created_at column exists
    const columnCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'created_at'
    `);
    
    const hasCreatedAtColumn = columnCheck.rows.length > 0;
    
    // Build query with conditional created_at selection
    const createdAtSelect = hasCreatedAtColumn 
      ? 'u.created_at'
      : 'NULL::timestamp with time zone as created_at';
    
    const query = `
      SELECT 
        u.id,
        u.id as user_id,
        u.email,
        ${createdAtSelect},
        bt.requested_at,
        bt.notes,
        CASE WHEN ac.user_id IS NOT NULL THEN true ELSE false END as has_tradestation_credentials,
        (SELECT MAX(created_at) 
         FROM analytics_events 
         WHERE user_id = u.id) as last_activity_at
      FROM users u
      LEFT JOIN beta_tracking bt ON bt.user_id = u.id
      LEFT JOIN api_credentials ac ON ac.user_id = u.id
      ORDER BY u.id DESC
    `;
    
    const result = await pool.query(query);

    res.json({ success: true, users: result.rows });
  } catch (error) {
    logger.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

module.exports = router;
