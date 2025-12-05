const express = require('express');
const router = express.Router();
const pool = require('../db');
const moment = require('moment-timezone');
const jwt = require('jsonwebtoken');

// Auth middleware (same pattern as watchlists.js)
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

// Lazy-load Pusher only when needed
let pusher = null;
const getPusher = () => {
  if (!pusher) {
    try {
      const Pusher = require('pusher');
      pusher = new Pusher({
        appId: process.env.PUSHER_APP_ID,
        key: process.env.PUSHER_KEY,
        secret: process.env.PUSHER_SECRET,
        cluster: process.env.PUSHER_CLUSTER,
        useTLS: true
      });
    } catch (e) {
      console.warn('[LossLimits] Pusher not available:', e.message);
    }
  }
  return pusher;
};

// Helper: Calculate next 4 PM EST (default session end)
function getNextSessionEnd() {
  const now = moment().tz('America/New_York');
  let nextEnd = now.clone().hour(16).minute(0).second(0).millisecond(0);
  
  // If it's already past 4 PM EST today, get tomorrow's 4 PM EST
  if (now.isAfter(nextEnd)) {
    nextEnd = nextEnd.add(1, 'day');
  }
  
  return nextEnd.toISOString();
}

// ============================================================================
// LOSS LIMIT LOCKS (Settings)
// ============================================================================

/**
 * GET /loss_limits
 * Get all active locks for the authenticated user
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, account_id, limit_type, threshold_amount, enabled_at, expires_at, created_at
       FROM loss_limit_locks
       WHERE user_id = $1
       ORDER BY account_id, limit_type`,
      [req.user.id]
    );
    
    // Add isExpired flag to each lock
    const now = new Date();
    const locks = result.rows.map(lock => ({
      ...lock,
      isExpired: new Date(lock.expires_at) < now
    }));
    
    res.json({ success: true, locks });
  } catch (err) {
    console.error('[LossLimits] Error fetching locks:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch loss limits' });
  }
});

/**
 * POST /loss_limits
 * Enable a loss limit for an account
 * Body: { accountId, limitType, thresholdAmount, expiresAt? }
 */
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { accountId, limitType, thresholdAmount, expiresAt } = req.body || {};
    
    // Validation
    if (!accountId || !accountId.trim()) {
      return res.status(400).json({ success: false, error: 'accountId is required' });
    }
    if (!limitType || !['daily', 'trade'].includes(limitType)) {
      return res.status(400).json({ success: false, error: 'limitType must be "daily" or "trade"' });
    }
    if (!thresholdAmount || isNaN(parseFloat(thresholdAmount)) || parseFloat(thresholdAmount) <= 0) {
      return res.status(400).json({ success: false, error: 'thresholdAmount must be a positive number' });
    }
    
    // Use provided expiresAt or default to next 4 PM EST
    const finalExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : getNextSessionEnd();
    
    // Validate expiresAt is in the future
    if (new Date(finalExpiresAt) <= new Date()) {
      return res.status(400).json({ success: false, error: 'expiresAt must be in the future' });
    }
    
    // Check if there's an existing non-expired lock
    const existingResult = await pool.query(
      `SELECT id, expires_at FROM loss_limit_locks 
       WHERE user_id = $1 AND account_id = $2 AND limit_type = $3`,
      [req.user.id, accountId.trim(), limitType]
    );
    
    if (existingResult.rows.length > 0) {
      const existing = existingResult.rows[0];
      if (new Date(existing.expires_at) > new Date()) {
        return res.status(409).json({ 
          success: false, 
          error: 'A lock already exists for this account and limit type. Wait until it expires to set a new one.',
          existingExpiresAt: existing.expires_at
        });
      }
      // Existing lock is expired, delete it
      await pool.query('DELETE FROM loss_limit_locks WHERE id = $1', [existing.id]);
    }
    
    // Insert new lock
    const insertResult = await pool.query(
      `INSERT INTO loss_limit_locks (user_id, account_id, limit_type, threshold_amount, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, account_id, limit_type, threshold_amount, enabled_at, expires_at, created_at`,
      [req.user.id, accountId.trim(), limitType, parseFloat(thresholdAmount), finalExpiresAt]
    );
    
    res.status(201).json({ success: true, lock: insertResult.rows[0] });
  } catch (err) {
    console.error('[LossLimits] Error creating lock:', err);
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'Lock already exists for this account and limit type' });
    }
    res.status(500).json({ success: false, error: 'Failed to create loss limit' });
  }
});

/**
 * DELETE /loss_limits/admin/locks/:id
 * Admin-only: Force delete a loss limit lock (for testing)
 * NOTE: This must be defined BEFORE the generic /:id route
 */
router.delete('/admin/locks/:id', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin/superuser
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [req.user.id]);
    if (!userResult.rows[0]?.superuser) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const lockId = req.params.id;
    
    // Get the lock info before deleting (for logging)
    const lockResult = await pool.query(
      'SELECT * FROM loss_limit_locks WHERE id = $1',
      [lockId]
    );
    
    if (lockResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lock not found' });
    }

    const lock = lockResult.rows[0];
    
    // Delete the lock
    await pool.query('DELETE FROM loss_limit_locks WHERE id = $1', [lockId]);
    
    console.log(`[LossLimits] Admin deleted lock ${lockId} for user ${lock.user_id}, account ${lock.account_id}, type ${lock.limit_type}`);
    
    res.json({ 
      success: true, 
      message: 'Lock deleted successfully',
      deletedLock: {
        id: lock.id,
        userId: lock.user_id,
        accountId: lock.account_id,
        limitType: lock.limit_type
      }
    });
  } catch (err) {
    console.error('[LossLimits] Error deleting admin lock:', err);
    res.status(500).json({ success: false, error: 'Failed to delete lock' });
  }
});

/**
 * DELETE /loss_limits/admin/alerts/:id
 * Admin-only: Force delete a loss limit alert (for testing)
 * NOTE: This must be defined BEFORE the generic /:id route
 */
router.delete('/admin/alerts/:id', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin/superuser
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [req.user.id]);
    if (!userResult.rows[0]?.superuser) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const alertId = req.params.id;
    
    // Get the alert info before deleting (for logging)
    const alertResult = await pool.query(
      'SELECT * FROM loss_limit_alerts WHERE id = $1',
      [alertId]
    );
    
    if (alertResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }

    const alert = alertResult.rows[0];
    
    // Delete the alert
    await pool.query('DELETE FROM loss_limit_alerts WHERE id = $1', [alertId]);
    
    console.log(`[LossLimits] Admin deleted alert ${alertId} for user ${alert.user_id}, account ${alert.account_id}, type ${alert.alert_type}`);
    
    res.json({ 
      success: true, 
      message: 'Alert deleted successfully',
      deletedAlert: {
        id: alert.id,
        userId: alert.user_id,
        accountId: alert.account_id,
        alertType: alert.alert_type
      }
    });
  } catch (err) {
    console.error('[LossLimits] Error deleting admin alert:', err);
    res.status(500).json({ success: false, error: 'Failed to delete alert' });
  }
});

/**
 * DELETE /loss_limits/:id
 * Disable a loss limit (only allowed if expired)
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Find the lock
    const result = await pool.query(
      'SELECT id, expires_at FROM loss_limit_locks WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Lock not found' });
    }
    
    const lock = result.rows[0];
    
    // Check if expired
    if (new Date(lock.expires_at) > new Date()) {
      return res.status(403).json({ 
        success: false, 
        error: 'Cannot disable lock until it expires',
        expiresAt: lock.expires_at
      });
    }
    
    // Delete the lock
    await pool.query('DELETE FROM loss_limit_locks WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    
    res.status(204).send();
  } catch (err) {
    console.error('[LossLimits] Error deleting lock:', err);
    res.status(500).json({ success: false, error: 'Failed to delete loss limit' });
  }
});

/**
 * GET /loss_limits/lockout_status
 * Check if any accounts are currently locked out from trading
 */
router.get('/lockout_status', authenticateToken, async (req, res) => {
  try {
    // Find daily alerts where lockout hasn't expired yet
    const result = await pool.query(
      `SELECT id, account_id, threshold_amount, loss_amount, lockout_expires_at, detected_at
       FROM loss_limit_alerts
       WHERE user_id = $1 
         AND alert_type = 'daily'
         AND lockout_expires_at > NOW()
       ORDER BY detected_at DESC`,
      [req.user.id]
    );
    
    const lockedOutAccounts = result.rows.map(row => ({
      alertId: row.id,
      accountId: row.account_id,
      alertType: 'daily',
      thresholdAmount: parseFloat(row.threshold_amount),
      lossAmount: parseFloat(row.loss_amount),
      lockoutExpiresAt: row.lockout_expires_at,
      detectedAt: row.detected_at
    }));
    
    res.json({ 
      success: true, 
      lockedOutAccounts,
      isLockedOut: lockedOutAccounts.length > 0
    });
  } catch (err) {
    console.error('[LossLimits] Error checking lockout status:', err);
    res.status(500).json({ success: false, error: 'Failed to check lockout status' });
  }
});

// ============================================================================
// LOSS LIMIT ALERTS (Breach Events)
// ============================================================================

/**
 * GET /loss_limits/alerts/pending
 * Get unacknowledged alerts for the authenticated user
 */
router.get('/alerts/pending', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, account_id, alert_type, threshold_amount, loss_amount, position_snapshot,
              detected_at, lockout_expires_at, created_at
       FROM loss_limit_alerts
       WHERE user_id = $1 AND acknowledged_at IS NULL
       ORDER BY detected_at DESC`,
      [req.user.id]
    );
    
    const pendingAlerts = result.rows.map(row => ({
      id: row.id,
      accountId: row.account_id,
      alertType: row.alert_type,
      thresholdAmount: parseFloat(row.threshold_amount),
      lossAmount: parseFloat(row.loss_amount),
      positionSnapshot: row.position_snapshot,
      detectedAt: row.detected_at,
      lockoutExpiresAt: row.lockout_expires_at
    }));
    
    res.json({ success: true, pendingAlerts });
  } catch (err) {
    console.error('[LossLimits] Error fetching pending alerts:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch pending alerts' });
  }
});

/**
 * PATCH /loss_limits/alerts/:id/acknowledge
 * Mark an alert as acknowledged with user action
 * Body: { userAction: 'dismissed' | 'closed_position' | 'closed_all_positions' }
 */
router.patch('/alerts/:id/acknowledge', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { userAction } = req.body || {};
    
    const validActions = ['dismissed', 'closed_position', 'closed_all_positions'];
    if (!userAction || !validActions.includes(userAction)) {
      return res.status(400).json({ 
        success: false, 
        error: `userAction must be one of: ${validActions.join(', ')}` 
      });
    }
    
    // Find and verify ownership
    const findResult = await pool.query(
      'SELECT id, acknowledged_at FROM loss_limit_alerts WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );
    
    if (findResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Alert not found' });
    }
    
    if (findResult.rows[0].acknowledged_at) {
      return res.status(400).json({ success: false, error: 'Alert already acknowledged' });
    }
    
    // Update the alert
    const updateResult = await pool.query(
      `UPDATE loss_limit_alerts 
       SET acknowledged_at = NOW(), user_action = $1
       WHERE id = $2 AND user_id = $3
       RETURNING id, acknowledged_at, user_action`,
      [userAction, id, req.user.id]
    );
    
    res.json({ 
      success: true, 
      acknowledgedAt: updateResult.rows[0].acknowledged_at,
      userAction: updateResult.rows[0].user_action
    });
  } catch (err) {
    console.error('[LossLimits] Error acknowledging alert:', err);
    res.status(500).json({ success: false, error: 'Failed to acknowledge alert' });
  }
});

/**
 * POST /loss_limits/alerts/test
 * DEV ONLY - Create a test alert for UI testing
 * Body: { alertType, accountId, thresholdAmount, lossAmount, positionSnapshot? }
 */
router.post('/alerts/test', authenticateToken, async (req, res) => {
  try {
    // Only allow in development or for specific test accounts
    // In production, you might want to restrict this further
    const { alertType, accountId, thresholdAmount, lossAmount, positionSnapshot } = req.body || {};
    
    // Validation
    if (!alertType || !['daily', 'trade'].includes(alertType)) {
      return res.status(400).json({ success: false, error: 'alertType must be "daily" or "trade"' });
    }
    if (!accountId || !accountId.trim()) {
      return res.status(400).json({ success: false, error: 'accountId is required' });
    }
    if (!thresholdAmount || isNaN(parseFloat(thresholdAmount))) {
      return res.status(400).json({ success: false, error: 'thresholdAmount is required' });
    }
    if (!lossAmount || isNaN(parseFloat(lossAmount))) {
      return res.status(400).json({ success: false, error: 'lossAmount is required' });
    }
    
    // For trade alerts, position snapshot is expected
    if (alertType === 'trade' && !positionSnapshot) {
      console.warn('[LossLimits] Trade alert created without position snapshot');
    }
    
    // Calculate lockout expiry for daily alerts
    const lockoutExpiresAt = alertType === 'daily' ? getNextSessionEnd() : null;
    
    // Insert the alert
    const insertResult = await pool.query(
      `INSERT INTO loss_limit_alerts 
       (user_id, account_id, alert_type, threshold_amount, loss_amount, position_snapshot, lockout_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, account_id, alert_type, threshold_amount, loss_amount, position_snapshot, 
                 detected_at, lockout_expires_at, created_at`,
      [
        req.user.id, 
        accountId.trim(), 
        alertType, 
        parseFloat(thresholdAmount), 
        parseFloat(lossAmount),
        positionSnapshot ? JSON.stringify(positionSnapshot) : null,
        lockoutExpiresAt
      ]
    );
    
    const alert = insertResult.rows[0];
    
    // Send Pusher notification
    const pusherClient = getPusher();
    if (pusherClient) {
      try {
        await pusherClient.trigger(`private-user-${req.user.id}`, 'loss_alert', {
          alertId: alert.id,
          alertType: alert.alert_type,
          accountId: alert.account_id,
          thresholdAmount: parseFloat(alert.threshold_amount),
          lossAmount: parseFloat(alert.loss_amount),
          lockoutExpiresAt: alert.lockout_expires_at,
          positionSnapshot: alert.position_snapshot
        });
        console.log(`[LossLimits] Sent test alert via Pusher to user ${req.user.id}`);
      } catch (pusherErr) {
        console.error('[LossLimits] Failed to send Pusher notification:', pusherErr);
      }
    }
    
    res.status(201).json({ 
      success: true, 
      alert: {
        id: alert.id,
        accountId: alert.account_id,
        alertType: alert.alert_type,
        thresholdAmount: parseFloat(alert.threshold_amount),
        lossAmount: parseFloat(alert.loss_amount),
        positionSnapshot: alert.position_snapshot,
        detectedAt: alert.detected_at,
        lockoutExpiresAt: alert.lockout_expires_at
      },
      message: 'Test alert created and Pusher event sent'
    });
  } catch (err) {
    console.error('[LossLimits] Error creating test alert:', err);
    res.status(500).json({ success: false, error: 'Failed to create test alert' });
  }
});

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

/**
 * GET /loss_limits/admin/alerts
 * Admin-only: Get all loss limit alerts with pagination
 */
router.get('/admin/alerts', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin/superuser
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [req.user.id]);
    if (!userResult.rows[0]?.superuser) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    const alertType = req.query.alert_type; // 'daily' or 'trade'
    const acknowledged = req.query.acknowledged; // 'true', 'false', or undefined for all

    let whereClause = '';
    const params = [];
    let paramCount = 0;

    if (alertType) {
      paramCount++;
      whereClause += ` WHERE alert_type = $${paramCount}`;
      params.push(alertType);
    }

    if (acknowledged !== undefined) {
      const isAcknowledged = acknowledged === 'true';
      if (whereClause) {
        whereClause += isAcknowledged ? ' AND acknowledged_at IS NOT NULL' : ' AND acknowledged_at IS NULL';
      } else {
        whereClause = isAcknowledged ? ' WHERE acknowledged_at IS NOT NULL' : ' WHERE acknowledged_at IS NULL';
      }
    }

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM loss_limit_alerts${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].total);

    // Get alerts with user info
    paramCount = params.length;
    const result = await pool.query(
      `SELECT 
        a.id, a.user_id, a.account_id, a.alert_type, a.threshold_amount, a.loss_amount,
        a.position_snapshot, a.detected_at, a.lockout_expires_at, a.acknowledged_at, a.user_action,
        u.email
       FROM loss_limit_alerts a
       LEFT JOIN users u ON a.user_id = u.id
       ${whereClause}
       ORDER BY a.detected_at DESC
       LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`,
      [...params, limit, offset]
    );

    res.json({
      success: true,
      alerts: result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        userEmail: row.email,
        accountId: row.account_id,
        alertType: row.alert_type,
        thresholdAmount: parseFloat(row.threshold_amount),
        lossAmount: parseFloat(row.loss_amount),
        positionSnapshot: row.position_snapshot,
        detectedAt: row.detected_at,
        lockoutExpiresAt: row.lockout_expires_at,
        acknowledgedAt: row.acknowledged_at,
        userAction: row.user_action
      })),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total
      }
    });
  } catch (err) {
    console.error('[LossLimits] Error fetching admin alerts:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch alerts' });
  }
});

/**
 * GET /loss_limits/admin/locks
 * Admin-only: Get all active loss limit locks
 */
router.get('/admin/locks', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin/superuser
    const userResult = await pool.query('SELECT superuser FROM users WHERE id = $1', [req.user.id]);
    if (!userResult.rows[0]?.superuser) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }

    const result = await pool.query(
      `SELECT 
        l.id, l.user_id, l.account_id, l.limit_type, l.threshold_amount, l.enabled_at, l.expires_at,
        u.email
       FROM loss_limit_locks l
       LEFT JOIN users u ON l.user_id = u.id
       ORDER BY l.enabled_at DESC`
    );

    const now = new Date();
    res.json({
      success: true,
      locks: result.rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        userEmail: row.email,
        accountId: row.account_id,
        limitType: row.limit_type,
        thresholdAmount: parseFloat(row.threshold_amount),
        enabledAt: row.enabled_at,
        expiresAt: row.expires_at,
        isExpired: new Date(row.expires_at) < now,
        isActive: new Date(row.expires_at) >= now
      }))
    });
  } catch (err) {
    console.error('[LossLimits] Error fetching admin locks:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch locks' });
  }
});

module.exports = router;

