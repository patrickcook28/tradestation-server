/**
 * PositionLossEngine - Efficient real-time position loss monitoring
 * 
 * Optimized for scale:
 * - O(1) position lookup via Map index
 * - Minimal memory footprint - only stores latest position state
 * - Debouncing to prevent duplicate triggers
 * - Batch database writes for performance
 * 
 * Architecture:
 * - Subscribes to BackgroundStreamManager 'data' events for positions
 * - Maintains in-memory cache of latest position state per account
 * - Uses Pusher for real-time notifications
 * - Logs triggered alerts to database
 * - Dynamically starts/stops streams when max trade loss is enabled/disabled
 */

const pool = require('../db');
const logger = require('../config/logging');
const Pusher = require('pusher');

// Pusher configuration (same as index.js)
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

if (!process.env.PUSHER_APP_ID || !process.env.PUSHER_KEY || !process.env.PUSHER_SECRET || !process.env.PUSHER_CLUSTER) {
  console.warn('[PositionLossEngine] Missing Pusher environment variables');
}

class PositionLossEngine {
  constructor() {
    // Cache: accountKey -> latest position state
    // accountKey format: `${userId}|${accountId}|${paperTrading ? 1 : 0}`
    // Only stores the most recent state for each position
    this.positionCache = new Map();
    
    // Track which users have max trade loss enabled
    // userId -> Set of accountKeys that need monitoring
    this.monitoredAccounts = new Map();
    
    // Cache loss limit locks in memory for fast lookup
    // Key: `${userId}|${accountId}|${limitType}` -> { threshold_amount, expires_at, account_defaults }
    this.lossLimitsCache = new Map();
    
    // Track triggered alerts to prevent duplicates
    // accountKey|positionId -> alertId
    this.triggeredAlerts = new Map();
    
    // Track positions currently being processed to prevent race conditions
    // alertKey -> true (set immediately when processing starts)
    this.processingAlerts = new Set();
    
    // Stats for monitoring
    this.stats = {
      positionsProcessed: 0,
      alertsTriggered: 0,
      lastProcessedAt: null
    };
    
    this.isRunning = false;
    this.backgroundStreamManager = null;
  }

  /**
   * Start the position loss monitor
   */
  async start() {
    if (this.isRunning) {
      logger.warn('[PositionLossEngine] Already running');
      return;
    }
    
    logger.info('[PositionLossEngine] Starting...');
    this.isRunning = true;
    
    // Get background stream manager
    this.backgroundStreamManager = require('../utils/backgroundStreamManager');
    
    // Subscribe to position stream data from BackgroundStreamManager
    this.backgroundStreamManager.on('data', (event) => this.handleStreamData(event));
    
    // Load loss limits into cache
    await this.loadLossLimits();
    
    // Load users with max trade loss enabled and start their streams
    await this.loadMonitoredAccounts();
    
    // Periodically reload loss limits and monitored accounts (every 60 seconds)
    this.reloadInterval = setInterval(async () => {
      await this.loadLossLimits();
      await this.loadMonitoredAccounts();
    }, 60000);
    
    logger.info('[PositionLossEngine] Started successfully');
  }

  /**
   * Stop the position loss engine
   */
  async stop() {
    logger.info('[PositionLossEngine] Stopping...');
    this.isRunning = false;
    
    if (this.reloadInterval) {
      clearInterval(this.reloadInterval);
      this.reloadInterval = null;
    }
    
    // Clear indexes
    this.positionCache.clear();
    this.monitoredAccounts.clear();
    this.lossLimitsCache.clear();
    this.triggeredAlerts.clear();
    this.processingAlerts.clear();
    
    logger.info('[PositionLossEngine] Stopped');
  }

  /**
   * Load all active loss limit locks into memory cache
   */
  async loadLossLimits() {
    try {
      const result = await pool.query(`
        SELECT 
          l.user_id,
          l.account_id,
          l.limit_type,
          l.threshold_amount,
          l.expires_at,
          u.account_defaults
        FROM loss_limit_locks l
        JOIN users u ON l.user_id = u.id
        WHERE l.expires_at > NOW()
      `);
      
      // Clear existing cache
      this.lossLimitsCache.clear();
      
      // Build cache
      for (const row of result.rows) {
        const cacheKey = `${row.user_id}|${row.account_id}|${row.limit_type}`;
        this.lossLimitsCache.set(cacheKey, {
          threshold_amount: parseFloat(row.threshold_amount),
          expires_at: new Date(row.expires_at),
          account_defaults: row.account_defaults || {}
        });
      }
      
      logger.debug(`[PositionLossEngine] Loaded ${this.lossLimitsCache.size} active loss limit locks into cache`);
      
    } catch (error) {
      logger.error('[PositionLossEngine] Failed to load loss limits:', error.message);
    }
  }

  /**
   * Add or update a loss limit lock in the cache (called when user creates/updates a lock)
   * This provides real-time updates without waiting for the 60-second reload
   */
  async addOrUpdateLossLimit(userId, accountId, limitType, thresholdAmount, expiresAt) {
    try {
      // Get user's account_defaults
      const userResult = await pool.query(
        'SELECT account_defaults FROM users WHERE id = $1',
        [userId]
      );
      
      if (userResult.rows.length === 0) {
        logger.warn(`[PositionLossEngine] User ${userId} not found for loss limit cache update`);
        return;
      }
      
      const accountDefaults = userResult.rows[0].account_defaults || {};
      const cacheKey = `${userId}|${accountId}|${limitType}`;
      
      this.lossLimitsCache.set(cacheKey, {
        threshold_amount: parseFloat(thresholdAmount),
        expires_at: new Date(expiresAt),
        account_defaults: accountDefaults
      });
      
      logger.info(`[PositionLossEngine] ➕ Loss limit cache updated: ${cacheKey} (threshold: $${thresholdAmount})`);
      
      // If this is a trade limit, also update monitored accounts and streams
      if (limitType === 'trade') {
        await this.loadMonitoredAccounts();
      }
      
    } catch (error) {
      logger.error('[PositionLossEngine] Failed to update loss limit cache:', error.message);
    }
  }

  /**
   * Remove a loss limit lock from the cache (called when user deletes a lock)
   */
  removeLossLimit(userId, accountId, limitType) {
    const cacheKey = `${userId}|${accountId}|${limitType}`;
    const removed = this.lossLimitsCache.delete(cacheKey);
    
    if (removed) {
      logger.info(`[PositionLossEngine] ➖ Loss limit cache removed: ${cacheKey}`);
      
      // If this is a trade limit, also update monitored accounts and streams
      if (limitType === 'trade') {
        // Reload monitored accounts asynchronously (don't await to avoid blocking)
        this.loadMonitoredAccounts().catch(err => {
          logger.error('[PositionLossEngine] Failed to reload monitored accounts after limit removal:', err.message);
        });
      }
    }
  }

  /**
   * Load users with max trade loss enabled and start/stop streams accordingly
   */
  async loadMonitoredAccounts() {
    try {
      // Get all active trade loss locks
      const result = await pool.query(`
        SELECT DISTINCT 
          l.user_id, 
          l.account_id,
          u.account_defaults
        FROM loss_limit_locks l
        JOIN users u ON l.user_id = u.id
        WHERE l.limit_type = 'trade'
          AND l.expires_at > NOW()
      `);
      
      const newMonitoredAccounts = new Map();
      
      // Process each lock
      for (const row of result.rows) {
        const userId = String(row.user_id);
        const accountId = row.account_id;
        
        // Determine paper trading mode from account_defaults
        // We need to check both paper and live accounts
        const accountDefaults = row.account_defaults || {};
        
        // Check both paper and live accounts for this accountId
        const paperKey = `${accountId}_paper`;
        const liveKey = `${accountId}_live`;
        
        const paperEnabled = accountDefaults[paperKey]?.maxLossPerTradeEnabled && 
                            parseFloat(accountDefaults[paperKey]?.maxLossPerTrade || 0) > 0;
        const liveEnabled = accountDefaults[liveKey]?.maxLossPerTradeEnabled && 
                           parseFloat(accountDefaults[liveKey]?.maxLossPerTrade || 0) > 0;
        
        if (paperEnabled) {
          const accountKey = `${userId}|${accountId}|1`;
          if (!newMonitoredAccounts.has(userId)) {
            newMonitoredAccounts.set(userId, new Set());
          }
          newMonitoredAccounts.get(userId).add(accountKey);
        }
        
        if (liveEnabled) {
          const accountKey = `${userId}|${accountId}|0`;
          if (!newMonitoredAccounts.has(userId)) {
            newMonitoredAccounts.set(userId, new Set());
          }
          newMonitoredAccounts.get(userId).add(accountKey);
        }
      }
      
      // Start streams for newly monitored accounts
      for (const [userId, accountKeys] of newMonitoredAccounts) {
        const existing = this.monitoredAccounts.get(userId) || new Set();
        
        // Find accounts that need streams started
        const toStart = [...accountKeys].filter(key => !existing.has(key));
        
        if (toStart.length > 0) {
          const positionsConfig = toStart.map(key => {
            const [, accountId, paperTrading] = key.split('|');
            return { accountId, paperTrading: paperTrading === '1' };
          });
          
          await this.backgroundStreamManager.startStreamsForUser(userId, {
            positions: positionsConfig
          });
          
          logger.info(`[PositionLossEngine] Started position streams for user ${userId}: ${toStart.length} account(s)`);
        }
      }
      
      // Stop streams for accounts that no longer need monitoring
      for (const [userId, existingKeys] of this.monitoredAccounts) {
        const newKeys = newMonitoredAccounts.get(userId) || new Set();
        const toStop = [...existingKeys].filter(key => !newKeys.has(key));
        
        if (toStop.length > 0) {
          // We can't stop individual account streams easily, so we'll let them run
          // They'll be cleaned up when the user has no more monitored accounts
          // For now, we just remove from monitoring
          logger.debug(`[PositionLossEngine] User ${userId} no longer needs monitoring for ${toStop.length} account(s)`);
        }
      }
      
      // Clean up users with no monitored accounts
      for (const [userId] of this.monitoredAccounts) {
        if (!newMonitoredAccounts.has(userId) || newMonitoredAccounts.get(userId).size === 0) {
          // Stop all position streams for this user
          await this.backgroundStreamManager.stopStreamsForUser(userId);
          logger.info(`[PositionLossEngine] Stopped position streams for user ${userId} (no longer monitored)`);
        }
      }
      
      this.monitoredAccounts = newMonitoredAccounts;
      
      logger.debug(`[PositionLossEngine] Monitoring ${this.monitoredAccounts.size} users with max trade loss enabled`);
      
    } catch (error) {
      logger.error('[PositionLossEngine] Failed to load monitored accounts:', error.message);
    }
  }

  /**
   * Handle incoming stream data
   */
  handleStreamData(event) {
    if (event.streamType !== 'positions') {
      return; // PositionLossEngine only processes positions
    }
    
    // Extract paperTrading from event if available (added by BackgroundStream)
    const paperTrading = event.paperTrading !== undefined ? event.paperTrading : null;
    const accountId = event.accountId || event.data?.AccountID;
    
    this.processPositionData(event.userId, event.data, accountId, paperTrading);
  }

  /**
   * Process position data and check against loss limits
   */
  processPositionData(userId, positionData, accountIdFromEvent = null, paperTradingFromEvent = null) {
    // Skip heartbeats
    if (positionData.Heartbeat) return;
    
    // Skip if no position ID (invalid data)
    if (!positionData.PositionID && !positionData.Symbol) {
      return;
    }
    
    this.stats.positionsProcessed++;
    this.stats.lastProcessedAt = new Date();
    
    // Extract account info
    const accountId = accountIdFromEvent || positionData.AccountID;
    if (!accountId) {
      return;
    }
    
    const userIdStr = String(userId);
    const userMonitoredAccounts = this.monitoredAccounts.get(userIdStr);
    if (!userMonitoredAccounts) {
      return; // User not being monitored
    }
    
    // Determine paper trading mode
    let paperTrading = paperTradingFromEvent;
    let accountKey = null;
    
    if (paperTrading !== null) {
      // Use the paperTrading from the event
      accountKey = `${userIdStr}|${accountId}|${paperTrading ? 1 : 0}`;
      if (!userMonitoredAccounts.has(accountKey)) {
        return; // This account is not being monitored
      }
    } else {
      // Fallback: check both paper and live accounts
      const accountKeyPaper = `${userIdStr}|${accountId}|1`;
      const accountKeyLive = `${userIdStr}|${accountId}|0`;
      
      if (userMonitoredAccounts.has(accountKeyPaper)) {
        accountKey = accountKeyPaper;
        paperTrading = true;
      } else if (userMonitoredAccounts.has(accountKeyLive)) {
        accountKey = accountKeyLive;
        paperTrading = false;
      } else {
        return; // This account is not being monitored
      }
    }
    
    const symbol = positionData.Symbol;
    
    // Update cache with latest position state
    // Only store the most recent state per position
    const positionId = positionData.PositionID || `${positionData.Symbol}_${accountId}`;
    const cacheKey = `${accountKey}|${positionId}`;
    const quantity = parseFloat(positionData.Quantity || 0);
    
    // If position is closed (quantity is 0), clean up triggered alerts for this position
    // This allows new positions with the same ticker to trigger alerts again
    if (Math.abs(quantity) === 0) {
      const alertKey = `${userId}|${accountId}|${paperTrading ? 1 : 0}|${positionId}`;
      if (this.triggeredAlerts.has(alertKey)) {
        this.triggeredAlerts.delete(alertKey);
        logger.debug(`[PositionLossEngine] Cleared alert tracking for closed position ${symbol} (PositionID: ${positionId})`);
      }
      // Remove from cache as well
      this.positionCache.delete(cacheKey);
      return; // Don't process closed positions
    }
    
    // Store only the latest position data (overwrite previous)
    // Use minimal memory footprint - only essential fields
    this.positionCache.set(cacheKey, {
      PositionID: positionData.PositionID,
      Symbol: positionData.Symbol,
      AccountID: accountId,
      Quantity: positionData.Quantity,
      AveragePrice: positionData.AveragePrice,
      UnrealizedPL: positionData.UnrealizedProfitLoss || positionData.UnrealizedPL || positionData.UnrealizedPnL,
      _cachedAt: Date.now() // Use timestamp instead of Date object for memory efficiency
    });
    
    // Check if this position exceeds max trade loss
    // Use .catch() to handle errors since we're not awaiting (to avoid blocking the stream)
    this.checkPositionLoss(userId, accountId, paperTrading, positionData).catch(err => {
      logger.error(`[PositionLossEngine] Unhandled error in checkPositionLoss for ${positionData.Symbol}:`, err.message);
      logger.error(`[PositionLossEngine] Error stack:`, err.stack);
    });
  }

  /**
   * Check if a position exceeds max trade loss limit
   * Uses cached loss limit data for fast lookup (no database query)
   */
  async checkPositionLoss(userId, accountId, paperTrading, positionData) {
    try {
      const symbol = positionData.Symbol;
      
      // Get the loss limit from cache (fast lookup, no database query)
      const cacheKey = `${userId}|${accountId}|trade`;
      const lock = this.lossLimitsCache.get(cacheKey);
      
      if (!lock) {
        return; // No active trade loss limit for this account
      }
      
      // Check if lock has expired
      if (lock.expires_at <= new Date()) {
        // Remove expired lock from cache
        this.lossLimitsCache.delete(cacheKey);
        return;
      }
      
      const accountDefaults = lock.account_defaults || {};
      const accountKey = `${accountId}_${paperTrading ? 'paper' : 'live'}`;
      const accountSettings = accountDefaults[accountKey] || {};
      
      // Check if max trade loss is enabled for this account
      if (!accountSettings.maxLossPerTradeEnabled) {
        return; // Not enabled for this account
      }
      
      const thresholdAmount = lock.threshold_amount;
      if (thresholdAmount <= 0) {
        return; // Invalid threshold
      }
      
      // Calculate position loss (unrealized P&L)
      // TradeStation API uses UnrealizedProfitLoss (not UnrealizedPL or UnrealizedPnL)
      const unrealizedPL = parseFloat(positionData.UnrealizedProfitLoss || positionData.UnrealizedPL || positionData.UnrealizedPnL || 0);
      const lossAmount = unrealizedPL < 0 ? Math.abs(unrealizedPL) : 0;
      
      // Check if we've already triggered an alert for this position
      const positionId = positionData.PositionID || `${positionData.Symbol}_${accountId}`;
      const alertKey = `${userId}|${accountId}|${paperTrading ? 1 : 0}|${positionId}`;
      
      // Check if already triggered
      let isAcknowledged = false;
      if (this.triggeredAlerts.has(alertKey)) {
        // Check if the alert was acknowledged
        const alertId = this.triggeredAlerts.get(alertKey);
        
        const alertResult = await pool.query(
          'SELECT acknowledged_at FROM loss_limit_alerts WHERE id = $1',
          [alertId]
        );
        
        if (alertResult.rows.length > 0 && alertResult.rows[0].acknowledged_at) {
          // Alert was acknowledged - don't log or check again for this position
          isAcknowledged = true;
        } else {
          // Alert already triggered and not acknowledged - don't log or check again
          return;
        }
      }
      
      // Skip logging and checking if position is in profit or alert is acknowledged
      if (lossAmount === 0 || isAcknowledged) {
        return; // Position is in profit or alert already acknowledged
      }
      
      // Single log per check showing position value and threshold (only when there's a loss)
      logger.debug(`[PositionLossEngine] ${symbol}: UnrealizedPL=$${unrealizedPL.toFixed(2)}, Loss=$${lossAmount.toFixed(2)}, Threshold=$${thresholdAmount.toFixed(2)}`);
      
      // Check if loss exceeds threshold
      if (lossAmount < thresholdAmount) {
        return; // Loss is within limit
      }
      
      // Race condition prevention: Check if already processing this alert
      if (this.processingAlerts.has(alertKey)) {
        return; // Already processing, skip this check
      }
      
      // Mark as processing immediately to prevent race conditions
      this.processingAlerts.add(alertKey);
      
      try {
        // Double-check triggeredAlerts after acquiring lock (another thread might have set it)
        if (this.triggeredAlerts.has(alertKey)) {
          return; // Another process already triggered it
        }
        
        // Log alert trigger
        logger.info(`[PositionLossEngine] 🚨 ALERT: ${symbol} loss $${lossAmount.toFixed(2)} exceeds threshold $${thresholdAmount.toFixed(2)}`);
        
        // Trigger the alert
        await this.triggerPositionLossAlert(userId, accountId, paperTrading, positionData, thresholdAmount, lossAmount);
      } finally {
        // Always remove from processing set, even if error occurred
        this.processingAlerts.delete(alertKey);
      }
      
    } catch (error) {
      logger.error(`[PositionLossEngine] Error checking position loss:`, error.message);
      logger.error(`[PositionLossEngine] Error stack:`, error.stack);
    }
  }

  /**
   * Trigger a position loss alert
   */
  async triggerPositionLossAlert(userId, accountId, paperTrading, positionData, thresholdAmount, lossAmount) {
    this.stats.alertsTriggered++;
    
    const positionId = positionData.PositionID || `${positionData.Symbol}_${accountId}`;
    const alertKey = `${userId}|${accountId}|${paperTrading ? 1 : 0}|${positionId}`;
    
    try {
      // Double-check database for recent alert (race condition prevention)
      // Check if an alert was created in the last 5 seconds for this position
      const recentAlertCheck = await pool.query(`
        SELECT id, acknowledged_at 
        FROM loss_limit_alerts 
        WHERE user_id = $1 
          AND account_id = $2 
          AND alert_type = 'trade'
          AND position_snapshot->>'Symbol' = $3
          AND detected_at > NOW() - INTERVAL '5 seconds'
        ORDER BY detected_at DESC
        LIMIT 1
      `, [userId, accountId, positionData.Symbol]);
      
      if (recentAlertCheck.rows.length > 0) {
        const recentAlert = recentAlertCheck.rows[0];
        // If not acknowledged, use the existing alert
        if (!recentAlert.acknowledged_at) {
          this.triggeredAlerts.set(alertKey, recentAlert.id);
          return; // Skip creating duplicate
        }
      }
      
      // Create position snapshot (only essential fields to minimize memory)
      const positionSnapshot = {
        Symbol: positionData.Symbol,
        Quantity: positionData.Quantity,
        AveragePrice: positionData.AveragePrice,
        UnrealizedPL: positionData.UnrealizedProfitLoss || positionData.UnrealizedPL || positionData.UnrealizedPnL,
        PositionID: positionData.PositionID
      };
      
      // Insert alert into database
      const insertResult = await pool.query(`
        INSERT INTO loss_limit_alerts 
        (user_id, account_id, alert_type, threshold_amount, loss_amount, position_snapshot)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, detected_at
      `, [
        userId,
        accountId,
        'trade',
        thresholdAmount,
        lossAmount,
        JSON.stringify(positionSnapshot)
      ]);
      
      const alert = insertResult.rows[0];
      
      // Track this alert
      this.triggeredAlerts.set(alertKey, alert.id);
      
      // Build notification payload
      const notification = {
        alertId: alert.id,
        alertType: 'trade',
        accountId: accountId,
        thresholdAmount: thresholdAmount,
        lossAmount: lossAmount,
        positionSnapshot: positionSnapshot,
        detectedAt: alert.detected_at
      };
      
      // Send Pusher notification (async, don't wait)
      this.sendPusherNotification(userId, notification);
      
      // Send email notification if user has it enabled (async)
      this.sendEmailNotification(userId, accountId, positionData, thresholdAmount, lossAmount, notification);
      
    } catch (error) {
      logger.error(`[PositionLossEngine] Failed to trigger alert:`, error.message);
    }
  }

  /**
   * Send real-time notification via Pusher
   * Note: Using public channel for now. For production, implement Pusher auth
   * and use private-user-{userId} channel for security.
   */
  async sendPusherNotification(userId, notification) {
    try {
      // Use public channel for testing (no auth required)
      // TODO: Switch to private-user-{userId} with Pusher auth for production
      const channel = `user-${userId}-alerts`;
      await pusher.trigger(channel, 'loss_alert', notification);
    } catch (error) {
      logger.error(`[PositionLossEngine] Failed to send Pusher notification:`, error.message);
    }
  }

  /**
   * Send email notification if user has email alerts enabled
   */
  async sendEmailNotification(userId, accountId, positionData, thresholdAmount, lossAmount, notification) {
    try {
      // Check if user has email alerts enabled
      const userResult = await pool.query(
        'SELECT email, email_alerts_enabled FROM users WHERE id = $1',
        [userId]
      );
      
      if (userResult.rows.length === 0) {
        logger.warn(`[PositionLossEngine] User ${userId} not found for email notification`);
        return;
      }
      
      const user = userResult.rows[0];
      
      if (!user.email_alerts_enabled || !user.email) {
        return;
      }
      
      // Build and send email
      const { createTransport, buildPositionLossEmail } = require('../config/email');
      
      const emailData = buildPositionLossEmail({
        to: user.email,
        symbol: positionData.Symbol,
        accountId: accountId,
        thresholdAmount: thresholdAmount,
        lossAmount: lossAmount,
        positionSnapshot: notification.positionSnapshot,
        detectedAt: notification.detectedAt
      });
      
      const transporter = createTransport();
      await transporter.sendMail(emailData);
    } catch (error) {
      logger.error(`[PositionLossEngine] Failed to send email notification:`, error.message);
    }
  }

  /**
   * Get latest position state for an account (for initial snapshot)
   * Returns only the most recent state for each position
   */
  getLatestPositions(userId, accountId, paperTrading) {
    const accountKey = `${userId}|${accountId}|${paperTrading ? 1 : 0}`;
    const positions = [];
    
    // Collect latest position for each positionId
    const positionMap = new Map();
    
    for (const [cacheKey, positionData] of this.positionCache) {
      if (cacheKey.startsWith(`${accountKey}|`)) {
        const positionId = positionData.PositionID || `${positionData.Symbol}_${accountId}`;
        
        // Only keep the most recent position for each positionId
        const existing = positionMap.get(positionId);
        const currentTime = positionData._cachedAt || 0;
        const existingTime = existing?._cachedAt || 0;
        
        if (!existing || currentTime > existingTime) {
          // Remove _cachedAt from the returned data
          const { _cachedAt, ...cleanData } = positionData;
          positionMap.set(positionId, cleanData);
        }
      }
    }
    
    return Array.from(positionMap.values());
  }

  /**
   * Get monitor statistics
   */
  getStats() {
    return {
      ...this.stats,
      monitoredUsers: this.monitoredAccounts.size,
      cachedPositions: this.positionCache.size,
      cachedLossLimits: this.lossLimitsCache.size,
      triggeredAlerts: this.triggeredAlerts.size,
      isRunning: this.isRunning
    };
  }
}

// Singleton instance
const positionLossEngine = new PositionLossEngine();

module.exports = positionLossEngine;

