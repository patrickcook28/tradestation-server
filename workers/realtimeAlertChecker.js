const pool = require("../db");
const fetch = require('node-fetch');
const WebSocket = require('ws');
const logger = require('../config/logging');

class RealtimeAlertChecker {
  constructor() {
    this.isRunning = false;
    this.ws = null;
    this.alertCache = new Map(); // Cache alerts by ticker
    this.priceCache = new Map(); // Cache current prices
    this.alertStates = new Map(); // Track alert states: { alertId: { triggered: boolean, lastPrice: number, lastCandleTime: number } }
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.fastPollingInterval = null;
    
    // Add counters for tracking
    this.alertsChecked = 0;
    this.alertsTriggered = 0;
    this.lastSummaryTime = Date.now();
    this.summaryInterval = 60000; // Print summary every minute
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    logger.info('Starting realtime alert checker (10-second intervals)...');
    
    // Load initial alerts
    await this.loadAlerts();
    
    // Start fast polling for immediate alerts (every 10 seconds)
    this.fastPollingInterval = setInterval(async () => {
      await this.checkAlertsRealtime();
    }, 10000); // 10 seconds
    
    // Fallback: Still run background polling every 60 seconds as backup
    this.fallbackInterval = setInterval(async () => {
      await this.checkAlertsFallback();
    }, 60 * 1000);
  }

  async stop() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    
    if (this.fastPollingInterval) {
      clearInterval(this.fastPollingInterval);
      this.fastPollingInterval = null;
    }
    
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
    
    this.isRunning = false;
    logger.info('Realtime alert checker stopped');
  }

  async loadAlerts() {
    try {
      const alertsQuery = 'SELECT * FROM trade_alerts WHERE is_active = true';
      const alertsResult = await pool.query(alertsQuery);
      const alerts = alertsResult.rows;
      
      // Group alerts by ticker for efficient checking
      this.alertCache.clear();
      this.alertStates.clear();
      
      alerts.forEach(alert => {
        if (!this.alertCache.has(alert.ticker)) {
          this.alertCache.set(alert.ticker, []);
        }
        this.alertCache.get(alert.ticker).push(alert);
        
        // Initialize alert state
        this.alertStates.set(alert.id, {
          triggered: false,
          lastPrice: null,
          lastCandleTime: null
        });
      });
      
      logger.info(`Loaded ${alerts.length} active alerts for ${this.alertCache.size} tickers`);
      
    } catch (error) {
      logger.error('Error loading alerts:', error);
    }
  }

  async connectWebSocket() {
    try {
      // Start fast polling for immediate alerts (every 2 seconds)
      this.fastPollingInterval = setInterval(async () => {
        await this.checkAlertsRealtime();
      }, 2000);
      
    } catch (error) {
      console.error('Error connecting WebSocket:', error);
      this.scheduleReconnect();
    }
  }

  async subscribeToTickers(tickers) {
    try {
      // In a real implementation, you would subscribe to WebSocket streams
      // For now, we'll use fast polling as a practical solution
      
    } catch (error) {
      console.error('Error subscribing to tickers:', error);
    }
  }

  async checkAlertsRealtime() {
    try {
      // Reset counters for this run
      this.alertsChecked = 0;
      this.alertsTriggered = 0;
      
      // Group alerts by user and ticker to use appropriate credentials
      const userTickerGroups = new Map();
      
      for (const [ticker, alerts] of this.alertCache.entries()) {
        for (const alert of alerts) {
          const key = `${alert.user_id}_${ticker}`;
          if (!userTickerGroups.has(key)) {
            userTickerGroups.set(key, {
              userId: alert.user_id,
              ticker: ticker,
              alerts: []
            });
          }
          userTickerGroups.get(key).alerts.push(alert);
        }
      }
      
      // Check each user-ticker combination
      for (const group of userTickerGroups.values()) {
        const priceData = await this.getCurrentPriceData(group.ticker, group.userId);
        if (!priceData) continue;
        
        // Update price cache
        this.priceCache.set(group.ticker, priceData);
        
        // Check alerts for this ticker-user combination
        for (const alert of group.alerts) {
          this.alertsChecked++;
          const wasTriggered = await this.checkSingleAlertRealtime(alert, priceData);
          if (wasTriggered) {
            this.alertsTriggered++;
          }
        }
      }
      
      // Print summary for this run
      console.log(`📊 REALTIME ALERT SUMMARY: Checked ${this.alertsChecked} alerts, Triggered ${this.alertsTriggered} alerts`);
      
    } catch (error) {
      console.error('Error in realtime alert check:', error);
    }
  }

  // Get the current candle timestamp based on timeframe
  getCurrentCandleTime(timeframe) {
    const now = new Date();
    
    switch (timeframe) {
      case '5min':
        return Math.floor(now.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000);
      case '15min':
        return Math.floor(now.getTime() / (15 * 60 * 1000)) * (15 * 60 * 1000);
      case '30min':
        return Math.floor(now.getTime() / (30 * 60 * 1000)) * (30 * 60 * 1000);
      case '1hour':
        return Math.floor(now.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000);
      case '4hour':
        return Math.floor(now.getTime() / (4 * 60 * 60 * 1000)) * (4 * 60 * 60 * 1000);
      case 'daily':
        // Daily candles start at market open (9:30 AM ET)
        const etTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
        const marketOpen = new Date(etTime);
        marketOpen.setHours(9, 30, 0, 0);
        return marketOpen.getTime();
      default:
        return Math.floor(now.getTime() / (60 * 60 * 1000)) * (60 * 60 * 1000); // Default to 1 hour
    }
  }

  // Check if we should reset the alert based on timeframe
  shouldResetAlert(alert, alertState) {
    const timeframe = alert.timeframe || '1hour';
    const currentCandleTime = this.getCurrentCandleTime(timeframe);
    
    // Reset if this is a new candle
    if (alertState.lastCandleTime !== currentCandleTime) {
      return true;
    }
    
    return false;
  }

  async checkSingleAlertRealtime(alert, priceData) {
    try {
      const alertState = this.alertStates.get(alert.id);
      if (!alertState) return false;
      
      const timeframe = alert.timeframe || '1hour';
      const currentCandleTime = this.getCurrentCandleTime(timeframe);
      
      // Check if we should reset the alert based on timeframe
      if (this.shouldResetAlert(alert, alertState)) {
        alertState.triggered = false;
        alertState.lastCandleTime = currentCandleTime;
      }
      
      let shouldTrigger = false;
      let triggerPrice = null;
      
      // Check if price crossed the alert level
      if (alert.alert_type === 'above') {
        // For "above" alerts, check if current price crossed above the level
        // Only trigger if current price is above the level AND we haven't triggered yet
        if (priceData.lastPrice >= alert.price_level) {
          // Only trigger if we haven't triggered for this candle yet
          if (!alertState.triggered) {
            shouldTrigger = true;
            triggerPrice = priceData.lastPrice;
          }
        }
      } else if (alert.alert_type === 'below') {
        // For "below" alerts, check if current price crossed below the level
        if (priceData.lastPrice <= alert.price_level) {
          // Only trigger if we haven't triggered for this candle yet
          if (!alertState.triggered) {
            shouldTrigger = true;
            triggerPrice = priceData.lastPrice;
          }
        }
      }
      
      if (shouldTrigger) {
        // Check if we've already triggered this alert for the current timeframe
        // Use a longer interval based on the timeframe to prevent duplicates
        const intervalMap = {
          '5min': '5 minutes',
          '15min': '15 minutes', 
          '30min': '30 minutes',
          '1hour': '1 hour',
          '4hour': '4 hours',
          'daily': '1 day'
        };
        
        const checkInterval = intervalMap[timeframe] || '1 hour';
        const recentTriggerQuery = `
          SELECT * FROM alert_logs 
          WHERE alert_id = $1 
          AND triggered_at > NOW() - INTERVAL '${checkInterval}'
        `;
        const recentResult = await pool.query(recentTriggerQuery, [alert.id]);
        
        if (recentResult.rows.length === 0) {
          await this.triggerAlertRealtime(alert, triggerPrice);
          
          // Update alert state
          alertState.triggered = true;
          alertState.lastPrice = triggerPrice;
          alertState.lastCandleTime = currentCandleTime;
          
          return true; // Alert was triggered
        }
      } else {
        // Update last price (but don't reset triggered state - that's based on timeframe)
        alertState.lastPrice = priceData.lastPrice;
      }
      
      return false; // No alert triggered
      
    } catch (error) {
      console.error(`Error checking realtime alert ${alert.id}:`, error);
      return false;
    }
  }

  async triggerAlertRealtime(alert, triggerPrice) {
    try {
      const timeframe = alert.timeframe || '1hour';
      const description = alert.description ? ` - ${alert.description}` : '';
      const direction = alert.alert_type === 'above' ? 'crossed above' : 'crossed below';
      
      // Get current market price for accurate reporting
      const currentPriceData = await this.getCurrentPriceData(alert.ticker, alert.user_id);
      const currentPrice = currentPriceData ? currentPriceData.lastPrice : triggerPrice;
      
      // Determine if this is a std dev level or price level alert
      let levelDisplay;
      if (alert.std_dev_level) {
        // Format std dev level like "+1.5 Std Dev level"
        const stdDevMatch = alert.std_dev_level.match(/std_dev_(\d+(?:_\d+)?)_(upper|lower)/);
        if (stdDevMatch) {
          const level = stdDevMatch[1].replace('_', '.');
          const sign = stdDevMatch[2] === 'upper' ? '+' : '-';
          levelDisplay = `(${sign}${level} Std Dev level)`;
        } else {
          levelDisplay = `(${alert.std_dev_level})`;
        }
      } else {
        levelDisplay = '(price level)';
      }
      
      // Use the actual price level that was crossed
      const crossedLevel = alert.price_level;
      
      console.log(`🚨 PRICE ALERT: ${alert.ticker} ${currentPrice} ${direction} ${crossedLevel} ${levelDisplay} [${timeframe} timeframe]`);
      
      // Log the alert trigger
      const logQuery = `
        INSERT INTO alert_logs (alert_id, ticker, trigger_price, alert_type) 
        VALUES ($1, $2, $3, $4) 
        RETURNING *
      `;
      const logResult = await pool.query(logQuery, [alert.id, alert.ticker, triggerPrice, alert.alert_type]);
      
      // Send SMS notification immediately
      const AlertChecker = require('./alertChecker');
      const alertChecker = new AlertChecker();
      await alertChecker.sendSmsNotification(alert, currentPrice, logResult.rows[0]);
      
      // Update log with SMS sent status
      const updateQuery = 'UPDATE alert_logs SET sms_sent = true, sms_sent_at = CURRENT_TIMESTAMP WHERE id = $1';
      await pool.query(updateQuery, [logResult.rows[0].id]);
      
    } catch (error) {
      console.error(`Error triggering realtime alert ${alert.id}:`, error);
    }
  }

  async checkAlertsFallback() {
    try {
      // Reload alerts in case new ones were added
      await this.loadAlerts();
      
      // Fallback checking (less frequent)
      await this.checkAlertsRealtime();
      
    } catch (error) {
      console.error('Error in fallback alert check:', error);
    }
  }

  async getCurrentPriceData(ticker, userId) {
    try {
      // Get API credentials
      const credentialsQuery = 'SELECT * FROM api_credentials WHERE user_id = $1 LIMIT 1';
      const credentialsResult = await pool.query(credentialsQuery, [userId]);
      
      if (credentialsResult.rows.length === 0) {
        return null;
      }
      
      const credentials = credentialsResult.rows[0];
      
      // Fetch current quote from TradeStation API
      const quoteUrl = `https://api.tradestation.com/v3/marketdata/quotes/${ticker}`;
      const response = await fetch(quoteUrl, {
        headers: {
          'Authorization': `Bearer ${credentials.access_token}`
        }
      });
      
      if (!response.ok) {
        return null;
      }
      
      const data = await response.json();
      const quote = data.Quotes?.[0];
      
      if (!quote) {
        return null;
      }
      
      // Try different possible field names for last price
      const lastPrice = quote.Last || quote.LastPrice || quote.Close || quote.Price;
      const highPrice = quote.High || quote.DayHigh || lastPrice;
      const lowPrice = quote.Low || quote.DayLow || lastPrice;
      
      // Return high, low, and close prices
      return {
        high: parseFloat(highPrice) || 0,
        low: parseFloat(lowPrice) || 0,
        close: parseFloat(lastPrice) || 0,
        lastPrice: parseFloat(lastPrice) || 0
      };
      
    } catch (error) {
      console.error('Error getting current price data:', error);
      return null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Scheduling reconnect attempt ${this.reconnectAttempts}...`);
      
      setTimeout(() => {
        this.connectWebSocket();
      }, 5000 * this.reconnectAttempts); // Exponential backoff
    } else {
      console.error('Max reconnect attempts reached');
    }
  }

  // Method to refresh alerts when new ones are created
  async refreshAlerts() {
    await this.loadAlerts();
  }
}

module.exports = RealtimeAlertChecker; 