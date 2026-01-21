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
    
    // Cache loss limit settings in memory for fast lookup
    // Key: `${userId}|${accountId}|trade` -> { threshold_amount, isPaperTrading }
    this.lossLimitsCache = new Map();
    
    // Cache of positions that already have alerts (minimal data - just PositionID)
    // Key: `${userId}|${accountId}|${positionId}` -> true
    this.triggeredAlertsCache = new Set();
    
    // Track positions currently being processed to prevent race conditions
    // positionKey -> true (set immediately when processing starts)
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
    
    // Load existing alerts into cache (minimal data)
    await this.loadTriggeredAlertsCache();
    
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
    this.triggeredAlertsCache.clear();
    this.processingAlerts.clear();
    
    logger.info('[PositionLossEngine] Stopped');
  }

  /**
   * Load minimal alert data into cache (just enough to know if alert exists)
   * Only loads PositionID to minimize memory footprint
   */
  async loadTriggeredAlertsCache() {
    try {
      // Get only the minimal data needed: user_id, account_id, PositionID
      const result = await pool.query(`
        SELECT 
          user_id,
          account_id,
          position_snapshot->>'PositionID' as position_id,
          position_snapshot->>'Symbol' as symbol
        FROM loss_limit_alerts
        WHERE alert_type = 'trade'
          AND detected_at > NOW() - INTERVAL '24 hours'
      `);
      
      let loadedCount = 0;
      
      for (const row of result.rows) {
        const userId = String(row.user_id);
        const accountId = row.account_id;
        // Use PositionID if available, otherwise fallback to Symbol-based ID
        const positionId = row.position_id || `${row.symbol}_${accountId}`;
        
        // Store minimal key: userId|accountId|positionId
        const cacheKey = `${userId}|${accountId}|${positionId}`;
        this.triggeredAlertsCache.add(cacheKey);
        loadedCount++;
      }
      
      logger.info(`[PositionLossEngine] ✅ Loaded ${loadedCount} existing alert(s) into cache`);
      
    } catch (error) {
      logger.error('[PositionLossEngine] Failed to load triggered alerts cache:', error.message);
    }
  }

  /**
   * Load loss limits from account_defaults (source of truth for monitoring)
   * Locks are only for preventing setting changes, not for determining if monitoring should happen
   */
  async loadLossLimits() {
    try {
      // Get all users with account_defaults that have position loss monitoring enabled
      const result = await pool.query(`
        SELECT id, account_defaults
        FROM users
        WHERE account_defaults IS NOT NULL
      `);
      
      // Clear existing cache
      this.lossLimitsCache.clear();
      
      // Build cache from account_defaults (monitoring enabled flag)
      for (const row of result.rows) {
        const userId = String(row.id);
        const accountDefaults = row.account_defaults || {};
        
        // Check each account in account_defaults
        for (const [accountId, settings] of Object.entries(accountDefaults)) {
          // Skip if not an account settings object
          if (!settings || typeof settings !== 'object') {
            continue;
          }
          
          // Check if position loss monitoring is enabled
          const maxLossPerPositionEnabled = settings.maxLossPerPositionEnabled || settings.maxLossPerTradeEnabled || false;
          const maxLossPerPosition = parseFloat(settings.maxLossPerPosition || settings.maxLossPerTrade || 0);
          
          // Only cache if enabled and has threshold (same check as frontend)
          if (maxLossPerPositionEnabled && maxLossPerPosition > 0) {
            const isPaperTrading = settings.isPaperTrading === true;
            
            // Cache key format: userId|accountId|trade
            const cacheKey = `${userId}|${accountId}|trade`;
            this.lossLimitsCache.set(cacheKey, {
              threshold_amount: maxLossPerPosition,
              expires_at: null, // No expiration for account_defaults-based monitoring
              isPaperTrading: isPaperTrading,
              isExpired: false
            });
          }
        }
      }
      
      if (process.env.DEBUG_STREAMS === 'true') logger.debug(`[PositionLossEngine] Loaded ${this.lossLimitsCache.size} position loss monitoring settings into cache from account_defaults`);
      
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
   * Load users with position loss monitoring enabled and start/stop streams accordingly
   * Checks account_defaults directly - locks are only for preventing setting changes, not for determining if monitoring should happen
   */
  async loadMonitoredAccounts() {
    try {
      // Get ALL users with account_defaults - check directly for enabled flag
      const usersResult = await pool.query(`
        SELECT id, account_defaults
        FROM users
        WHERE account_defaults IS NOT NULL
      `);
      
      const newMonitoredAccounts = new Map();
      const accountThresholds = new Map(); // Track thresholds per account
      let totalAccountsMonitored = 0;
      
      // Check account_defaults directly for enabled accounts
      for (const userRow of usersResult.rows) {
        const userId = String(userRow.id);
        const accountDefaults = userRow.account_defaults || {};
        
        // Check each account in account_defaults
        for (const [accountId, settings] of Object.entries(accountDefaults)) {
          // Skip if not an account settings object
          if (!settings || typeof settings !== 'object') {
            continue;
          }
          
          // Check if position loss monitoring is enabled in account_defaults (same check as frontend)
          const maxLossPerPositionEnabled = settings.maxLossPerPositionEnabled || settings.maxLossPerTradeEnabled || false;
          const maxLossPerPosition = parseFloat(settings.maxLossPerPosition || settings.maxLossPerTrade || 0);
          
          // Frontend checks: maxLossPerPositionEnabled && maxLossPerPosition > 0
          if (maxLossPerPositionEnabled && maxLossPerPosition > 0) {
            // Get isPaperTrading from account_defaults
            const isPaper = settings.isPaperTrading === true;
            
            const accountKey = `${userId}|${accountId}|${isPaper ? 1 : 0}`;
            if (!newMonitoredAccounts.has(userId)) {
              newMonitoredAccounts.set(userId, new Set());
            }
            newMonitoredAccounts.get(userId).add(accountKey);
            
            // Store threshold from account_defaults
            accountThresholds.set(`${userId}|${accountId}`, maxLossPerPosition);
            totalAccountsMonitored++;
            
            logger.info(`[PositionLossEngine] ✅ Monitoring enabled: User ${userId}, Account ${accountId} (${isPaper ? 'paper' : 'live'}), Threshold: $${maxLossPerPosition.toFixed(2)}`);
          }
        }
      }
      
      // Store thresholds in lossLimitsCache for checkPositionLoss to use
      for (const [key, threshold] of accountThresholds) {
        const [userId, accountId] = key.split('|');
        const cacheKey = `${userId}|${accountId}|trade`;
        
        // Get account_defaults to determine isPaperTrading
        const userRow = usersResult.rows.find(r => String(r.id) === userId);
        const accountDefaults = userRow?.account_defaults || {};
        const settings = accountDefaults[accountId] || {};
        const isPaperTrading = settings.isPaperTrading === true;
        
        // Update cache (no expiration for account_defaults-based monitoring)
        this.lossLimitsCache.set(cacheKey, {
          threshold_amount: threshold,
          expires_at: null,
          isPaperTrading: isPaperTrading,
          isExpired: false
        });
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
    
    // If position is closed (quantity is 0), remove from cache
    if (Math.abs(quantity) === 0) {
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
      
      // Skip if position is in profit (no loss to check)
      if (lossAmount === 0) {
        return;
      }
      
      // Check if loss exceeds threshold
      if (lossAmount < thresholdAmount) {
        return; // Loss is within limit
      }
      
      // Get PositionID for checking existing alerts
      const positionId = positionData.PositionID || `${positionData.Symbol}_${accountId}`;
      const positionKey = `${userId}|${accountId}|${positionId}`;
      
      // Race condition prevention: Check if already processing this position
      if (this.processingAlerts.has(positionKey)) {
        return; // Already processing, skip this check
      }
      
      // Mark as processing immediately to prevent race conditions
      this.processingAlerts.add(positionKey);
      
      try {
        // Check cache first (fast lookup)
        if (this.triggeredAlertsCache.has(positionKey)) {
          logger.debug(`[PositionLossEngine] ⏭️ Skipping position ${symbol} (PositionID: ${positionId}) - alert already exists in cache`);
          return;
        }
        
        // If not in cache, check database
        // Handle both cases: PositionID in snapshot, or fallback to Symbol-based matching
        const existingAlert = await pool.query(`
          SELECT id 
          FROM loss_limit_alerts
          WHERE user_id = $1 
            AND account_id = $2 
            AND alert_type = 'trade'
            AND (
              (position_snapshot->>'PositionID' = $3 AND position_snapshot->>'PositionID' IS NOT NULL)
              OR (position_snapshot->>'PositionID' IS NULL AND position_snapshot->>'Symbol' = $4)
            )
          LIMIT 1
        `, [userId, accountId, positionId, positionData.Symbol]);
        
        // If alert exists in DB, add to cache and skip creating a new one
        if (existingAlert.rows.length > 0) {
          this.triggeredAlertsCache.add(positionKey);
          logger.debug(`[PositionLossEngine] ⏭️ Skipping position ${symbol} (PositionID: ${positionId}) - alert already exists in database`);
          return;
        }
        
        // Log position check with clear formatting
        const quantity = positionData.Quantity || 0;
        const avgPrice = positionData.AveragePrice || 0;
        logger.debug(`[PositionLossEngine] 📊 Symbol: ${symbol}, Position: ${quantity} @ $${parseFloat(avgPrice).toFixed(2)}, Unrealized P&L: $${unrealizedPL.toFixed(2)}, Loss Limit: $${thresholdAmount.toFixed(2)}`);
        
        // Log alert trigger
        logger.info(`[PositionLossEngine] 🚨 ALERT: ${symbol} loss $${lossAmount.toFixed(2)} exceeds threshold $${thresholdAmount.toFixed(2)}`);
        
        // Trigger the alert
        await this.triggerPositionLossAlert(userId, accountId, paperTrading, positionData, thresholdAmount, lossAmount);
      } finally {
        // Always remove from processing set, even if error occurred
        this.processingAlerts.delete(positionKey);
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
    
    try {
      // Validate that we have required position data
      const symbol = positionData.Symbol;
      const quantity = positionData.Quantity;
      const avgPrice = positionData.AveragePrice;
      
      if (!symbol) {
        logger.warn(`[PositionLossEngine] Missing Symbol in positionData for account ${accountId}. PositionData keys: ${Object.keys(positionData).join(', ')}`);
      }
      if (avgPrice === undefined || avgPrice === null || avgPrice === 0) {
        logger.warn(`[PositionLossEngine] Missing or zero AveragePrice in positionData for ${symbol || 'unknown'} (account ${accountId}). AveragePrice: ${avgPrice}`);
      }
      
      // Create position snapshot (only essential fields to minimize memory)
      const positionSnapshot = {
        Symbol: symbol || null,
        Quantity: quantity || 0,
        AveragePrice: avgPrice || 0,
        UnrealizedPL: positionData.UnrealizedProfitLoss || positionData.UnrealizedPL || positionData.UnrealizedPnL || 0,
        PositionID: positionData.PositionID || null
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
      
      // Add to cache so we don't create duplicate alerts
      const positionId = positionData.PositionID || `${positionData.Symbol}_${accountId}`;
      const positionKey = `${userId}|${accountId}|${positionId}`;
      this.triggeredAlertsCache.add(positionKey);
      
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
      cachedAlerts: this.triggeredAlertsCache.size,
      isRunning: this.isRunning
    };
  }
}

// Singleton instance
const positionLossEngine = new PositionLossEngine();

module.exports = positionLossEngine;

