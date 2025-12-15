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
 * - Dynamically starts/stops streams when max position loss is enabled/disabled
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
    
    // Track which users have max position loss enabled
    // userId -> Set of accountKeys that need monitoring
    this.monitoredAccounts = new Map();
    
    // Cache loss limit locks in memory for fast lookup
    // Key: `${userId}|${accountId}|${limitType}` -> { threshold_amount, expires_at, account_defaults }
    this.lossLimitsCache = new Map();
    
    // Track positions that have already triggered alerts (by PositionID)
    // Once a position triggers an alert, we stop checking it entirely
    // Key: `${userId}|${accountId}|${isPaper}|${positionId}` -> alertId
    // Cleaned up when position closes (quantity = 0)
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
    
    logger.info('[PositionLossEngine] Starting position loss monitor...');
    this.isRunning = true;
    
    // Get background stream manager
    this.backgroundStreamManager = require('../utils/backgroundStreamManager');
    
    // Subscribe to position stream data from BackgroundStreamManager
    this.backgroundStreamManager.on('data', (event) => this.handleStreamData(event));
    
    // Load existing unacknowledged alerts from database to prevent duplicates on restart
    await this.loadTriggeredAlertsFromDatabase();
    
    // Load loss limits into cache
    await this.loadLossLimits();
    
    // Load users with max position loss enabled and start their streams
    await this.loadMonitoredAccounts();
    
    logger.info(`[PositionLossEngine] ✅ Started successfully. Monitoring ${this.monitoredAccounts.size} user(s) with ${this.lossLimitsCache.size} active loss limit(s)`);
    
    // Periodically reload loss limits and monitored accounts (every 60 seconds)
    this.reloadInterval = setInterval(async () => {
      await this.loadLossLimits();
      await this.loadMonitoredAccounts();
      
      // Monitor memory usage of triggeredAlerts Map
      const alertCount = this.triggeredAlerts.size;
      const estimatedMemoryKB = Math.round((alertCount * 60) / 1024); // ~60 bytes per entry
      if (process.env.DEBUG_STREAMS === 'true' || alertCount > 1000) {
        logger.info(`[PositionLossEngine] 📊 Memory: ${alertCount} tracked alerts (~${estimatedMemoryKB} KB)`);
      }
    }, 60000);
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
   * Load loss limits from loss_limit_locks table (single source of truth)
   * Monitors ALL locks (expired or not) - expiration only prevents user from changing settings
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
        WHERE l.limit_type = 'trade'
      `);
      
      // Clear existing cache
      this.lossLimitsCache.clear();
      
      // Build cache from ALL locks (expired or not - monitoring continues until explicitly disabled)
      for (const row of result.rows) {
        const userId = String(row.user_id);
        const accountId = row.account_id;
        const threshold = parseFloat(row.threshold_amount);
        const accountDefaults = row.account_defaults || {};
        
        // Get isPaperTrading from account_defaults
        const isPaperTrading = accountDefaults[accountId]?.isPaperTrading;
        
        // Cache key format: userId|accountId|trade
        const cacheKey = `${userId}|${accountId}|trade`;
        this.lossLimitsCache.set(cacheKey, {
          threshold_amount: threshold,
          expires_at: new Date(row.expires_at),
          isPaperTrading: isPaperTrading,
          isExpired: new Date(row.expires_at) <= new Date()
        });
      }
      
      if (process.env.DEBUG_STREAMS === 'true') logger.debug(`[PositionLossEngine] Loaded ${this.lossLimitsCache.size} position loss locks into cache (includes expired)`);
      
    } catch (error) {
      logger.error('[PositionLossEngine] Failed to load loss limits:', error.message);
    }
  }

  /**
   * Load existing alert Position IDs from database into triggeredAlerts Map
   * 
   * Purpose: Once a position has triggered an alert, we stop checking it entirely.
   * This prevents duplicate alerts after server restart and improves performance.
   * 
   * Loads alerts from last 24 hours (both acknowledged and unacknowledged):
   * - We don't re-check positions that already triggered alerts
   * - When position closes, we clean it from the Map
   * - New positions (new PositionID) will be checked normally
   */
  async loadTriggeredAlertsFromDatabase() {
    try {
      logger.info('[PositionLossEngine] Loading existing alerts from database...');
      
      // Get all recent trade/position alerts (last 24 hours)
      // We use 24 hours to avoid loading ancient alerts while still covering typical trading sessions
      const result = await pool.query(`
        SELECT 
          id,
          user_id,
          account_id,
          position_snapshot,
          acknowledged_at
        FROM loss_limit_alerts
        WHERE alert_type = 'trade'
          AND detected_at > NOW() - INTERVAL '24 hours'
        ORDER BY detected_at DESC
      `);
      
      let loadedCount = 0;
      let acknowledgedCount = 0;
      
      for (const row of result.rows) {
        const userId = String(row.user_id);
        const accountId = row.account_id;
        const positionSnapshot = row.position_snapshot || {};
        const positionId = positionSnapshot.PositionID || `${positionSnapshot.Symbol}_${accountId}`;
        
        // Determine if paper trading from account ID (SIM prefix = paper)
        const isPaper = accountId.startsWith('SIM');
        
        // Build the same alertKey format used in checkPositionLoss
        const alertKey = `${userId}|${accountId}|${isPaper ? 1 : 0}|${positionId}`;
        
        // Store in triggeredAlerts Map
        this.triggeredAlerts.set(alertKey, row.id);
        loadedCount++;
        
        if (row.acknowledged_at) {
          acknowledgedCount++;
        }
        
        // Log each loaded alert for debugging
        if (process.env.DEBUG_STREAMS === 'true') {
          logger.debug(`[PositionLossEngine] Loaded alert ${row.id} for position ${positionSnapshot.Symbol} (PositionID: ${positionId}, alertKey: ${alertKey}${row.acknowledged_at ? ', acknowledged' : ''})`);
        }
      }
      
      logger.info(`[PositionLossEngine] ✅ Loaded ${loadedCount} existing alert(s) into memory (${acknowledgedCount} acknowledged, ${loadedCount - acknowledgedCount} pending)`);
      
    } catch (error) {
      logger.error('[PositionLossEngine] Failed to load triggered alerts from database:', error.message);
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
   * Load users with position loss locks and start/stop streams accordingly
   * Monitors ALL locks (expired or not) - expiration only affects ability to change settings
   */
  async loadMonitoredAccounts() {
    try {
      // Get ALL position loss locks (expired or not) - monitoring continues until explicitly disabled
      const result = await pool.query(`
        SELECT 
          l.user_id,
          l.account_id,
          l.threshold_amount,
          l.expires_at,
          u.account_defaults
        FROM loss_limit_locks l
        JOIN users u ON l.user_id = u.id
        WHERE l.limit_type = 'trade'
      `);
      
      const now = new Date();
      const activeCount = result.rows.filter(r => new Date(r.expires_at) > now).length;
      const expiredCount = result.rows.filter(r => new Date(r.expires_at) <= now).length;
      
      logger.info(`[PositionLossEngine] Found ${result.rows.length} position loss lock(s): ${activeCount} active, ${expiredCount} expired`);
      
      const newMonitoredAccounts = new Map();
      let totalAccountsMonitored = 0;
      
      // Process ALL locks (monitoring continues even after expiration)
      for (const row of result.rows) {
        const userId = String(row.user_id);
        const accountId = row.account_id;
        const threshold = parseFloat(row.threshold_amount);
        const accountDefaults = row.account_defaults || {};
        const isExpired = new Date(row.expires_at) <= now;
        
        // Get isPaperTrading from account_defaults (stored with risk settings)
        const isPaper = accountDefaults[accountId]?.isPaperTrading === true;
        
        const accountKey = `${userId}|${accountId}|${isPaper ? 1 : 0}`;
        if (!newMonitoredAccounts.has(userId)) {
          newMonitoredAccounts.set(userId, new Set());
        }
        newMonitoredAccounts.get(userId).add(accountKey);
        totalAccountsMonitored++;
        
        const status = isExpired ? '(expired, can disable)' : '(locked)';
        logger.info(`[PositionLossEngine] ✅ Monitoring enabled: User ${userId}, Account ${accountId} (${isPaper ? 'paper' : 'live'}), Threshold: $${threshold.toFixed(2)} ${status}`);
      }
      
      logger.info(`[PositionLossEngine] Total accounts with position loss monitoring: ${totalAccountsMonitored}`);
      
      
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
          // Stop individual position streams for accounts no longer monitored
          for (const key of toStop) {
            const [, accountId, paperTrading] = key.split('|');
            const streamKey = `${userId}|positions|${accountId}|${paperTrading}`;
            
            await this.backgroundStreamManager.stopStreamByKey(streamKey);
            logger.info(`[PositionLossEngine] Stopped stream for account ${accountId} (${paperTrading === '1' ? 'paper' : 'live'})`);
          }
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
      
      if (process.env.DEBUG_STREAMS === 'true') logger.debug(`[PositionLossEngine] Monitoring ${this.monitoredAccounts.size} users with max position loss enabled`);
      
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
    
    if (process.env.DEBUG_STREAMS === 'true' && event.data?.Symbol) {
      logger.debug(`[PositionLossEngine] 📥 Received position data: ${event.data.Symbol}, User: ${event.userId}, Account: ${accountId}`);
    }
    
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
    
    // Check if this position exceeds max position loss
    // Use .catch() to handle errors since we're not awaiting (to avoid blocking the stream)
    this.checkPositionLoss(userId, accountId, paperTrading, positionData).catch(err => {
      logger.error(`[PositionLossEngine] Unhandled error in checkPositionLoss for ${positionData.Symbol}:`, err.message);
      logger.error(`[PositionLossEngine] Error stack:`, err.stack);
    });
  }

  /**
   * Check if a position exceeds max position loss limit
   * Uses cached loss limit data for fast lookup (no database query)
   */
  async checkPositionLoss(userId, accountId, paperTrading, positionData) {
    try {
      const symbol = positionData.Symbol;
      
      // Get the position loss lock from cache (fast lookup, no database query)
      const cacheKey = `${userId}|${accountId}|trade`;
      const lock = this.lossLimitsCache.get(cacheKey);
      
      if (!lock) {
        return; // No position loss lock for this account (monitoring not enabled)
      }
      
      // NOTE: We do NOT skip expired locks - monitoring continues until user explicitly disables
      // Expiration only prevents user from changing settings, not monitoring
      
      // Verify isPaperTrading matches (if we have that info)
      if (lock.isPaperTrading !== undefined && lock.isPaperTrading !== paperTrading) {
        return; // Paper/live mismatch
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
      
      // If we've already triggered an alert for this specific position, skip all further checks
      // The PositionID is unique - once alerted, user has made their decision (dismiss or close)
      if (this.triggeredAlerts.has(alertKey)) {
        logger.debug(`[PositionLossEngine] ⏭️ Skipping position ${symbol} (PositionID: ${positionId}) - alert already triggered`);
        return; // Already handled this position
      }
      
      // Skip if position is in profit (no loss to check)
      if (lossAmount === 0) {
        return;
      }
      
      // Log position check with clear formatting (similar to AlertEngine)
      const quantity = positionData.Quantity || 0;
      const avgPrice = positionData.AveragePrice || 0;
      logger.debug(`[PositionLossEngine] 📊 Symbol: ${symbol}, Position: ${quantity} @ $${parseFloat(avgPrice).toFixed(2)}, Unrealized P&L: $${unrealizedPL.toFixed(2)}, Loss Limit: $${thresholdAmount.toFixed(2)}`);
      
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

