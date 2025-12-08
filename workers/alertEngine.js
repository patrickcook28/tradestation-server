/**
 * AlertEngine - Efficient real-time alert processing
 * 
 * Optimized for scale:
 * - O(1) symbol lookup via Map index
 * - O(k) alert checking where k = alerts per symbol (typically 1-5)
 * - Debouncing to prevent duplicate triggers
 * - Batch database writes for performance
 * 
 * Architecture:
 * - Subscribes to BackgroundStreamManager 'data' events
 * - Maintains in-memory index of alerts by symbol
 * - Uses Pusher for real-time notifications
 * - Logs triggered alerts to database
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
  console.warn('[AlertEngine] Missing Pusher environment variables (PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER)');
}

class AlertEngine {
  constructor() {
    // Primary index: symbol -> alerts[]
    // This allows O(1) lookup when a quote comes in
    this.alertsBySymbol = new Map();
    
    // Secondary index: alertId -> alert (for quick updates/deletes)
    this.alertsById = new Map();
    
    // User index: userId -> alertIds[] (for user-specific operations)
    this.alertsByUser = new Map();
    
    
    // Batch write queue for database operations
    this.pendingLogWrites = [];
    this.batchWriteTimer = null;
    this.batchWriteIntervalMs = 1000; // Flush every 1 second
    
    // Stats for monitoring
    this.stats = {
      quotesProcessed: 0,
      alertsChecked: 0,
      alertsTriggered: 0,
      lastProcessedAt: null
    };
    
    this.isRunning = false;
  }

  /**
   * Start the alert engine
   */
  async start() {
    if (this.isRunning) {
      logger.warn('[AlertEngine] Already running');
      return;
    }
    
    logger.info('[AlertEngine] Starting...');
    this.isRunning = true;
    
    // Load all active alerts into memory
    await this.loadAlerts();
    
    // Subscribe to quote stream data from BackgroundStreamManager
    const backgroundStreamManager = require('../utils/backgroundStreamManager');
    backgroundStreamManager.on('data', (event) => this.handleStreamData(event));
    
    // Start batch write timer
    this.startBatchWriteTimer();
    
    // Periodically reload alerts to pick up changes (every 60 seconds)
    this.reloadInterval = setInterval(() => this.loadAlerts(), 60000);
    
    logger.info('[AlertEngine] Started successfully');
  }

  /**
   * Stop the alert engine
   */
  async stop() {
    logger.info('[AlertEngine] Stopping...');
    this.isRunning = false;
    
    if (this.reloadInterval) {
      clearInterval(this.reloadInterval);
      this.reloadInterval = null;
    }
    
    if (this.batchWriteTimer) {
      clearInterval(this.batchWriteTimer);
      this.batchWriteTimer = null;
    }
    
    // Flush any pending writes
    await this.flushPendingWrites();
    
    // Clear indexes
    this.alertsBySymbol.clear();
    this.alertsById.clear();
    this.alertsByUser.clear();
    
    logger.info('[AlertEngine] Stopped');
  }

  /**
   * Load all active alerts from database into memory indexes
   */
  async loadAlerts() {
    try {
      const result = await pool.query(`
        SELECT * FROM trade_alerts 
        WHERE is_active = true
      `);
      
      const alerts = result.rows;
      
      // Clear existing indexes
      this.alertsBySymbol.clear();
      this.alertsById.clear();
      this.alertsByUser.clear();
      
      // Build indexes
      for (const alert of alerts) {
        this.indexAlert(alert);
      }
      
      logger.info(`[AlertEngine] Loaded ${alerts.length} active alerts for ${this.alertsBySymbol.size} symbols`);
      
    } catch (error) {
      logger.error('[AlertEngine] Failed to load alerts:', error.message);
    }
  }

  /**
   * Add alert to all indexes
   */
  indexAlert(alert) {
    const symbol = alert.ticker.toUpperCase();
    
    // Primary index: by symbol
    if (!this.alertsBySymbol.has(symbol)) {
      this.alertsBySymbol.set(symbol, []);
    }
    this.alertsBySymbol.get(symbol).push(alert);
    
    // Secondary index: by ID
    this.alertsById.set(alert.id, alert);
    
    // User index
    if (!this.alertsByUser.has(alert.user_id)) {
      this.alertsByUser.set(alert.user_id, new Set());
    }
    this.alertsByUser.get(alert.user_id).add(alert.id);
  }

  /**
   * Handle incoming stream data
   */
  handleStreamData(event) {
    if (event.streamType !== 'quotes') {
      return; // AlertEngine only processes quotes
    }
    
    this.processQuoteData(event.userId, event.data);
  }

  /**
   * Process quote data and check alerts
   * This is the hot path - must be efficient!
   */
  processQuoteData(userId, quoteData) {
    // Skip heartbeats
    if (quoteData.Heartbeat) return;
    
    // Extract symbol and price
    const symbol = (quoteData.Symbol || '').toUpperCase();
    const lastPrice = parseFloat(quoteData.Last || quoteData.LastPrice || quoteData.Close || 0);
    
    if (!symbol || !lastPrice) return;
    
    this.stats.quotesProcessed++;
    this.stats.lastProcessedAt = new Date();
    
    // O(1) lookup: Get alerts for this symbol
    const symbolAlerts = this.alertsBySymbol.get(symbol);
    if (!symbolAlerts || symbolAlerts.length === 0) {
      return; // No alerts for this symbol
    }
    
    // O(k) check: Only check alerts for this specific symbol
    for (const alert of symbolAlerts) {
      this.stats.alertsChecked++;
      this.checkAlert(alert, lastPrice, quoteData);
    }
  }

  /**
   * Check a single alert against current price
   */
  checkAlert(alert, currentPrice, quoteData) {
    const shouldTrigger = this.evaluateAlertCondition(alert, currentPrice);
    
    if (!shouldTrigger) {
      return;
    }
    
    logger.info(`[AlertEngine] ✅ Alert ${alert.id} TRIGGERED: ${alert.ticker} ${alert.alert_type} ${alert.price_level}, current: $${currentPrice}`);
    
    // Trigger the alert (this will deactivate it and remove from index)
    this.triggerAlert(alert, currentPrice, quoteData);
  }

  /**
   * Evaluate if alert condition is met
   */
  evaluateAlertCondition(alert, currentPrice) {
    const priceLevel = parseFloat(alert.price_level);
    
    switch (alert.alert_type) {
      case 'above':
        return currentPrice >= priceLevel;
      case 'below':
        return currentPrice <= priceLevel;
      case 'cross_above':
        // Would need previous price tracking for cross detection
        return currentPrice >= priceLevel;
      case 'cross_below':
        return currentPrice <= priceLevel;
      default:
        return false;
    }
  }

  /**
   * Trigger an alert - send notification, log, and deactivate
   */
  async triggerAlert(alert, triggerPrice, quoteData) {
    this.stats.alertsTriggered++;
    
    const direction = alert.alert_type === 'above' || alert.alert_type === 'cross_above' 
      ? 'crossed above' 
      : 'crossed below';
    
    const triggeredAt = new Date().toISOString();
    
    logger.info(`[AlertEngine] 🚨 ALERT TRIGGERED: ${alert.ticker} ${triggerPrice} ${direction} ${alert.price_level} (User ${alert.user_id})`);
    
    // Build notification payload
    const notification = {
      alertId: alert.id,
      ticker: alert.ticker,
      triggerPrice: triggerPrice,
      priceLevel: parseFloat(alert.price_level),
      alertType: alert.alert_type,
      timeframe: alert.timeframe,
      description: alert.description,
      stdDevLevel: alert.std_dev_level,
      triggeredAt: triggeredAt,
      message: `${alert.ticker} ${direction} $${parseFloat(alert.price_level).toFixed(2)}${alert.description ? ` - ${alert.description}` : ''}`
    };
    
    // Mark alert as triggered and deactivate in database
    this.markAlertTriggered(alert.id, triggeredAt, triggerPrice);
    
    // Remove from active alerts index (deactivated)
    this.removeAlert(alert.id);
    
    // Send Pusher notification (async, don't wait)
    this.sendPusherNotification(alert.user_id, notification);
    
    // Queue database write (batched for efficiency)
    this.queueAlertLog(alert, triggerPrice, notification);
    
    // Send email notification if user has it enabled (async)
    this.sendEmailNotification(alert, triggerPrice, notification);
    
    // Send SMS if configured (async) - currently disabled
    // this.sendSmsNotification(alert, triggerPrice, notification);
  }

  /**
   * Mark alert as triggered in database
   */
  async markAlertTriggered(alertId, triggeredAt, triggerPrice) {
    try {
      await pool.query(`
        UPDATE trade_alerts 
        SET triggered_at = $1, is_active = false, updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
      `, [triggeredAt, alertId]);
      
      logger.info(`[AlertEngine] Alert ${alertId} marked as triggered and deactivated`);
    } catch (err) {
      logger.error(`[AlertEngine] Failed to mark alert as triggered:`, err.message);
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
      await pusher.trigger(channel, 'price-alert', notification);
      logger.info(`[AlertEngine] Pusher notification sent to channel ${channel}`);
    } catch (error) {
      logger.error(`[AlertEngine] Failed to send Pusher notification:`, error.message);
    }
  }

  /**
   * Queue alert log for batch write
   */
  queueAlertLog(alert, triggerPrice, notification) {
    this.pendingLogWrites.push({
      alert_id: alert.id,
      ticker: alert.ticker,
      trigger_price: triggerPrice,
      alert_type: alert.alert_type,
      triggered_at: new Date()
    });
  }

  /**
   * Start batch write timer
   */
  startBatchWriteTimer() {
    this.batchWriteTimer = setInterval(() => {
      this.flushPendingWrites();
    }, this.batchWriteIntervalMs);
    
    // Don't prevent Node.js from exiting
    if (this.batchWriteTimer.unref) {
      this.batchWriteTimer.unref();
    }
  }

  /**
   * Flush pending log writes to database
   */
  async flushPendingWrites() {
    if (this.pendingLogWrites.length === 0) return;
    
    const writes = this.pendingLogWrites.splice(0); // Take all pending writes
    
    try {
      // Batch insert
      const values = writes.map((w, i) => 
        `($${i*4+1}, $${i*4+2}, $${i*4+3}, $${i*4+4})`
      ).join(', ');
      
      const params = writes.flatMap(w => [
        w.alert_id,
        w.ticker,
        w.trigger_price,
        w.alert_type
      ]);
      
      await pool.query(`
        INSERT INTO alert_logs (alert_id, ticker, trigger_price, alert_type)
        VALUES ${values}
      `, params);
      
      logger.debug(`[AlertEngine] Flushed ${writes.length} alert logs to database`);
    } catch (error) {
      logger.error(`[AlertEngine] Failed to flush alert logs:`, error.message);
      // Put writes back for retry
      this.pendingLogWrites.unshift(...writes);
    }
  }

  /**
   * Send email notification if user has email alerts enabled
   */
  async sendEmailNotification(alert, triggerPrice, notification) {
    try {
      // Check if user has email alerts enabled
      const userResult = await pool.query(
        'SELECT email, email_alerts_enabled FROM users WHERE id = $1',
        [alert.user_id]
      );
      
      if (userResult.rows.length === 0) {
        logger.warn(`[AlertEngine] User ${alert.user_id} not found for email notification`);
        return;
      }
      
      const user = userResult.rows[0];
      
      if (!user.email_alerts_enabled) {
        logger.debug(`[AlertEngine] Email alerts disabled for user ${alert.user_id}, skipping`);
        return;
      }
      
      if (!user.email) {
        logger.warn(`[AlertEngine] User ${alert.user_id} has no email address`);
        return;
      }
      
      // Build and send email
      const { createTransport, buildPriceAlertEmail } = require('../config/email');
      
      const emailData = buildPriceAlertEmail({
        to: user.email,
        ticker: alert.ticker,
        alertType: alert.alert_type,
        priceLevel: alert.price_level,
        triggeredAt: notification.triggeredAt,
        description: alert.description
      });
      
      const transporter = createTransport();
      await transporter.sendMail(emailData);
      
      logger.info(`[AlertEngine] 📧 Email sent to ${user.email} for alert ${alert.id}`);
    } catch (error) {
      logger.error(`[AlertEngine] Failed to send email notification:`, error.message);
    }
  }

  /**
   * Send SMS notification (placeholder - uses existing AlertChecker logic)
   * Currently disabled - kept for future use
   */
  async sendSmsNotification(alert, triggerPrice, notification) {
    try {
      // Import existing SMS logic from alertChecker
      const AlertChecker = require('./alertChecker');
      const alertChecker = new AlertChecker();
      await alertChecker.sendSmsNotification(alert, triggerPrice, { id: notification.alertId });
    } catch (error) {
      logger.error(`[AlertEngine] Failed to send SMS:`, error.message);
    }
  }

  /**
   * Manually add/update an alert (called when user creates/updates alert)
   * This provides real-time updates without waiting for the 60-second reload
   */
  addOrUpdateAlert(alert) {
    // Remove old version if exists
    this.removeAlert(alert.id);
    
    // Add to indexes if active
    if (alert.is_active) {
      this.indexAlert(alert);
      logger.info(`[AlertEngine] ➕ Alert ${alert.id} added/updated: ${alert.ticker} ${alert.alert_type} ${alert.price_level}`);
      
      // Also trigger a background stream start for this user/symbol if not already running
      this.ensureStreamForAlert(alert);
    } else {
      logger.info(`[AlertEngine] Alert ${alert.id} is inactive, not indexing`);
    }
  }

  /**
   * Ensure a background stream is running for the alert's symbol.
   * 
   * IMPORTANT: We consolidate ALL symbols for a user into ONE quote stream.
   * If user already has a stream for some symbols, we stop it and create
   * a new one with all symbols combined to avoid duplicate streams.
   */
  async ensureStreamForAlert(alert) {
    try {
      const backgroundStreamManager = require('../utils/backgroundStreamManager');
      const newSymbol = alert.ticker.toUpperCase();
      const userId = alert.user_id;
      
      // Get all existing quote streams for this user
      const existingStreams = backgroundStreamManager.getStatus().streams || [];
      const userQuoteStreams = existingStreams.filter(s => 
        s.userId === userId && s.streamType === 'quotes'
      );
      
      // Check if the symbol is already covered by an existing stream
      const symbolAlreadyCovered = userQuoteStreams.some(s => {
        // Extract symbols from key (format: "userId|quotes|SYM1,SYM2,SYM3")
        const keyParts = s.key.split('|');
        const symbolsCsv = keyParts[2] || '';
        const symbols = symbolsCsv.split(',').map(sym => sym.trim().toUpperCase());
        return symbols.includes(newSymbol);
      });
      
      if (symbolAlreadyCovered) {
        return; // Symbol already in an active stream
      }
      
      // Collect all symbols from existing streams + the new one
      const allSymbols = new Set();
      allSymbols.add(newSymbol);
      
      for (const s of userQuoteStreams) {
        const keyParts = s.key.split('|');
        const symbolsCsv = keyParts[2] || '';
        symbolsCsv.split(',').forEach(sym => {
          if (sym.trim()) allSymbols.add(sym.trim().toUpperCase());
        });
      }
      
      // Stop all existing quote streams for this user (we'll create one consolidated stream)
      if (userQuoteStreams.length > 0) {
        logger.info(`[AlertEngine] Consolidating ${userQuoteStreams.length} quote stream(s) for user ${userId}`);
        await backgroundStreamManager.stopQuoteStreamsForUser(userId);
      }
      
      // Start a single consolidated stream with all symbols
      const consolidatedSymbols = [...allSymbols].sort().join(',');
      logger.info(`[AlertEngine] Starting consolidated quote stream for user ${userId}: ${consolidatedSymbols}`);
      await backgroundStreamManager.startStreamsForUser(userId, {
        quotes: [consolidatedSymbols]
      });
    } catch (err) {
      logger.error(`[AlertEngine] Failed to ensure stream for alert:`, err.message);
    }
  }

  /**
   * Remove an alert from indexes
   */
  removeAlert(alertId) {
    const alert = this.alertsById.get(alertId);
    if (!alert) return;
    
    logger.info(`[AlertEngine] ➖ Removing alert ${alertId} from indexes`);
    
    // Remove from symbol index
    const symbol = alert.ticker.toUpperCase();
    const symbolAlerts = this.alertsBySymbol.get(symbol);
    if (symbolAlerts) {
      const idx = symbolAlerts.findIndex(a => a.id === alertId);
      if (idx !== -1) {
        symbolAlerts.splice(idx, 1);
      }
      if (symbolAlerts.length === 0) {
        this.alertsBySymbol.delete(symbol);
      }
    }
    
    // Remove from user index
    const userAlerts = this.alertsByUser.get(alert.user_id);
    if (userAlerts) {
      userAlerts.delete(alertId);
    }
    
    // Remove from ID index
    this.alertsById.delete(alertId);
  }

  /**
   * Get engine statistics
   */
  getStats() {
    return {
      ...this.stats,
      activeAlerts: this.alertsById.size,
      uniqueSymbols: this.alertsBySymbol.size,
      uniqueUsers: this.alertsByUser.size,
      pendingWrites: this.pendingLogWrites.length,
      isRunning: this.isRunning
    };
  }

  /**
   * Get alerts for a specific symbol (for debugging)
   */
  getAlertsForSymbol(symbol) {
    return this.alertsBySymbol.get(symbol.toUpperCase()) || [];
  }
}

// Singleton instance
const alertEngine = new AlertEngine();

module.exports = alertEngine;

