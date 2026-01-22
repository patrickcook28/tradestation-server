const express = require('express');
const router = express.Router();
const pool = require('../db');
const moment = require('moment-timezone');
const jwt = require('jsonwebtoken');

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Helper: Check if current time is within any of the trading windows
function isWithinTradingWindow(timeWindows) {
  if (!timeWindows || timeWindows.length === 0) {
    return false;
  }

  const now = moment().tz('America/New_York');
  const currentMinutes = now.hours() * 60 + now.minutes();

  for (const window of timeWindows) {
    const [startHour, startMin] = window.startTime.split(':').map(Number);
    const [endHour, endMin] = window.endTime.split(':').map(Number);
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = endHour * 60 + endMin;

    if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// TRADING HOURS RESTRICTIONS CRUD
// ============================================================================

/**
 * GET /trading_hours_restrictions
 * Get all active trading hours restrictions for the authenticated user
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, account_id, time_windows, enabled_at, expires_at, created_at
       FROM trading_hours_restrictions
       WHERE user_id = $1
       ORDER BY account_id`,
      [req.user.id]
    );
    
    // Add isExpired flag to each restriction
    const now = new Date();
    const restrictions = result.rows.map(restriction => ({
      ...restriction,
      isExpired: new Date(restriction.expires_at) < now
    }));
    
    res.json({ success: true, restrictions });
  } catch (err) {
    console.error('[TradingHoursRestrictions] Error fetching restrictions:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch trading hours restrictions' });
  }
});

/**
 * POST /trading_hours_restrictions
 * Enable trading hours restrictions for an account
 * Body: { accountId, timeWindows: [{startTime, endTime}], expiresAt }
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { accountId, timeWindows, expiresAt } = req.body || {};
    
    // Validation
    if (!accountId || !accountId.trim()) {
      return res.status(400).json({ success: false, error: 'accountId is required' });
    }
    if (!timeWindows || !Array.isArray(timeWindows) || timeWindows.length === 0) {
      return res.status(400).json({ success: false, error: 'timeWindows is required and must be a non-empty array' });
    }
    
    // Validate each time window
    for (const window of timeWindows) {
      if (!window.startTime || !window.endTime) {
        return res.status(400).json({ success: false, error: 'Each time window must have startTime and endTime' });
      }
      // Validate time format (HH:MM)
      const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(window.startTime) || !timeRegex.test(window.endTime)) {
        return res.status(400).json({ success: false, error: 'Time must be in HH:MM format (24-hour)' });
      }
    }
    
    if (!expiresAt) {
      return res.status(400).json({ success: false, error: 'expiresAt is required' });
    }
    
    // Check if there's already an active restriction for this account
    const existing = await pool.query(
      `SELECT id, expires_at FROM trading_hours_restrictions
       WHERE user_id = $1 AND account_id = $2
       LIMIT 1`,
      [req.user.id, accountId]
    );
    
    // If there's an existing restriction that hasn't expired, return error
    if (existing.rows.length > 0) {
      const existingExpiresAt = existing.rows[0].expires_at;
      if (new Date(existingExpiresAt) > new Date()) {
        return res.status(409).json({
          success: false,
          error: 'Trading hours restriction already active for this account',
          existingExpiresAt
        });
      }
      
      // If expired, delete it so we can create a new one
      await pool.query(
        `DELETE FROM trading_hours_restrictions WHERE id = $1`,
        [existing.rows[0].id]
      );
    }
    
    // Create the new restriction
    const result = await pool.query(
      `INSERT INTO trading_hours_restrictions (user_id, account_id, time_windows, expires_at, enabled_at, created_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       RETURNING id, account_id, time_windows, enabled_at, expires_at, created_at`,
      [req.user.id, accountId, JSON.stringify(timeWindows), expiresAt]
    );
    
    const restriction = result.rows[0];
    
    res.json({
      success: true,
      restriction,
      message: 'Trading hours restriction enabled successfully'
    });
  } catch (err) {
    console.error('[TradingHoursRestrictions] Error creating restriction:', err);
    res.status(500).json({ success: false, error: 'Failed to create trading hours restriction' });
  }
});

/**
 * DELETE /trading_hours_restrictions/:id
 * Delete a trading hours restriction (only allowed if expired)
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get the restriction
    const result = await pool.query(
      `SELECT id, expires_at FROM trading_hours_restrictions
       WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Trading hours restriction not found' });
    }
    
    const restriction = result.rows[0];
    
    // Check if restriction has expired
    if (new Date(restriction.expires_at) > new Date()) {
      return res.status(403).json({
        success: false,
        error: 'Cannot delete an active trading hours restriction until it expires',
        expiresAt: restriction.expires_at
      });
    }
    
    // Delete the restriction
    await pool.query(
      `DELETE FROM trading_hours_restrictions WHERE id = $1`,
      [id]
    );
    
    res.status(204).send();
  } catch (err) {
    console.error('[TradingHoursRestrictions] Error deleting restriction:', err);
    res.status(500).json({ success: false, error: 'Failed to delete trading hours restriction' });
  }
});

/**
 * GET /trading_hours_restrictions/status
 * Check if trading is currently allowed based on trading hours restrictions
 * Returns: { canTrade: boolean, restriction: {...} | null, reason: string | null }
 */
router.get('/status', authenticateToken, async (req, res) => {
  try {
    const { accountId } = req.query;
    
    if (!accountId) {
      return res.status(400).json({ success: false, error: 'accountId is required' });
    }
    
    // Get active restriction for this account
    const result = await pool.query(
      `SELECT id, account_id, time_windows, enabled_at, expires_at
       FROM trading_hours_restrictions
       WHERE user_id = $1 AND account_id = $2
       AND expires_at > NOW()
       LIMIT 1`,
      [req.user.id, accountId]
    );
    
    if (result.rows.length === 0) {
      // No active restriction = can trade
      return res.json({
        success: true,
        canTrade: true,
        restriction: null,
        reason: null
      });
    }
    
    const restriction = result.rows[0];
    // time_windows is JSONB, so it's already parsed by pg driver
    const timeWindows = typeof restriction.time_windows === 'string' 
      ? JSON.parse(restriction.time_windows) 
      : restriction.time_windows;
    const withinWindow = isWithinTradingWindow(timeWindows);
    
    res.json({
      success: true,
      canTrade: withinWindow,
      restriction: {
        id: restriction.id,
        accountId: restriction.account_id,
        timeWindows,
        expiresAt: restriction.expires_at
      },
      reason: withinWindow ? null : 'Outside of allowed trading hours'
    });
  } catch (err) {
    console.error('[TradingHoursRestrictions] Error checking status:', err);
    res.status(500).json({ success: false, error: 'Failed to check trading hours restriction status' });
  }
});

module.exports = router;
