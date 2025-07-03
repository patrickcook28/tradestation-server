const pool = require("../db");
const fetch = require('node-fetch');
const { calculateStdDevLevels } = require('../routes/tradeAlerts');
const logger = require('../config/logging');

class AlertChecker {
  constructor() {
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    logger.info('Starting alert checker...');
    
    // Run initial check
    await this.checkAlerts();
    
    // Set up interval to check every 5 minutes
    this.interval = setInterval(async () => {
      await this.checkAlerts();
    }, 5 * 60 * 1000);
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    logger.info('Alert checker stopped');
  }

  async checkAlerts() {
    try {
      // Get all active alerts
      const alertsQuery = 'SELECT * FROM trade_alerts WHERE is_active = true';
      const alertsResult = await pool.query(alertsQuery);
      const alerts = alertsResult.rows;
      
      if (alerts.length === 0) {
        return;
      }
      
      // Group alerts by ticker and user_id to minimize API calls
      const tickerUserGroups = {};
      alerts.forEach(alert => {
        const key = `${alert.ticker}_${alert.user_id}`;
        if (!tickerUserGroups[key]) {
          tickerUserGroups[key] = {
            ticker: alert.ticker,
            userId: alert.user_id,
            alerts: []
          };
        }
        tickerUserGroups[key].alerts.push(alert);
      });
      
      // Check each ticker-user combination
      for (const group of Object.values(tickerUserGroups)) {
        await this.checkTickerAlerts(group.ticker, group.alerts, group.userId);
      }
      
    } catch (error) {
      logger.error('Error checking alerts:', error);
    }
  }

  async checkTickerAlerts(ticker, alerts, userId) {
    try {
      // Get current price for the ticker using the user's credentials
      const currentPrice = await this.getCurrentPrice(ticker, userId);
      if (!currentPrice) {
        logger.error(`Could not get current price for ${ticker} using user ${userId} credentials`);
        return;
      }
      
      // Check each alert for this ticker
      for (const alert of alerts) {
        await this.checkSingleAlert(alert, currentPrice);
      }
      
    } catch (error) {
      logger.error(`Error checking alerts for ${ticker}:`, error);
    }
  }

  async checkSingleAlert(alert, currentPrice) {
    try {
      let shouldTrigger = false;
      
      if (alert.alert_type === 'above' && currentPrice >= alert.price_level) {
        shouldTrigger = true;
      } else if (alert.alert_type === 'below' && currentPrice <= alert.price_level) {
        shouldTrigger = true;
      }
      
      if (shouldTrigger) {
        // Check if we've already triggered this alert for the current timeframe
        // Use a longer interval based on the timeframe to prevent duplicates
        const timeframe = alert.timeframe || '1hour';
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
          await this.triggerAlert(alert, currentPrice);
        }
      }
      
    } catch (error) {
      logger.error(`Error checking alert ${alert.id}:`, error);
    }
  }

  async triggerAlert(alert, triggerPrice) {
    try {
      logger.info(`ALERT TRIGGERED: ${alert.ticker} ${alert.alert_type} ${alert.price_level} at ${triggerPrice}`);
      
      // Log the alert trigger
      const logQuery = `
        INSERT INTO alert_logs (alert_id, ticker, trigger_price, alert_type) 
        VALUES ($1, $2, $3, $4) 
        RETURNING *
      `;
      const logResult = await pool.query(logQuery, [alert.id, alert.ticker, triggerPrice, alert.alert_type]);
      
      // Send SMS notification
      await this.sendSmsNotification(alert, triggerPrice, logResult.rows[0]);
      
      // Update log with SMS sent status
      const updateQuery = 'UPDATE alert_logs SET sms_sent = true, sms_sent_at = CURRENT_TIMESTAMP WHERE id = $1';
      await pool.query(updateQuery, [logResult.rows[0].id]);
      
    } catch (error) {
      logger.error(`Error triggering alert ${alert.id}:`, error);
    }
  }

  async sendSmsNotification(alert, triggerPrice, logEntry) {
    try {
      // Load Twilio configuration
      const twilioConfig = require('../config/twilio');
      
      // Initialize Twilio client
      const twilio = require('twilio');
      const client = twilio(twilioConfig.accountSid, twilioConfig.authToken);

      // Create SMS message content using template
      const messageBody = twilioConfig.messageTemplate(alert, triggerPrice, logEntry.triggered_at);

      try {
        const message = await client.messages.create({
          body: messageBody,
          from: twilioConfig.fromNumber,
          to: twilioConfig.toNumber
        });
        
        logger.info('SMS SENT:', message.sid);
        
      } catch (twilioError) {
        logger.error('Twilio SMS Error:', twilioError);
      }
      
    } catch (error) {
      logger.error('Error sending SMS notification:', error);
    }
  }

  async getCurrentPrice(ticker, userId = 1) {
    try {
      // Get API credentials for the specific user
      const credentialsQuery = 'SELECT * FROM api_credentials WHERE user_id = $1 LIMIT 1';
      const credentialsResult = await pool.query(credentialsQuery, [userId]);
      
      if (credentialsResult.rows.length === 0) {
        logger.error(`No API credentials found for user ${userId}`);
        return null;
      }
      
      const credentials = credentialsResult.rows[0];
      
      // Fetch current quote from TradeStation API
      const quoteUrl = `https://api.tradestation.com/v3/marketdata/quotes/${ticker}`;
      const response = await fetch(quoteUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${credentials.access_token}`,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        logger.error(`Failed to fetch quote for ${ticker}:`, response.status, response.statusText);
        return null;
      }
      
      const data = await response.json();
      const quote = data.Quotes && data.Quotes[0];
      
      if (!quote) {
        logger.error(`No quote data received for ${ticker}`);
        return null;
      }
      
      // Return the last price
      return parseFloat(quote.Last);
      
    } catch (error) {
      logger.error(`Error getting current price for ${ticker}:`, error);
      return null;
    }
  }

  async updateStdDevLevels(ticker, timeframe = '1hour', userId = 1) {
    try {
      // This function would call the same logic as in routes/tradeAlerts.js
      // For now, we'll just log that it was called
      
    } catch (error) {
      logger.error(`Error updating std dev levels for ${ticker}:`, error);
    }
  }

  async updateAllTimeframesForTicker(ticker, userId = 1) {
    try {
      const timeframes = ['5min', '15min', '30min', '1hour', '4hour', 'daily'];
      
      for (const timeframe of timeframes) {
        await this.updateStdDevLevels(ticker, timeframe, userId);
      }
      
    } catch (error) {
      logger.error(`Error updating all timeframes for ${ticker}:`, error);
    }
  }
}

module.exports = AlertChecker; 