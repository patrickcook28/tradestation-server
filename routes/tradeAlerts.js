const pool = require("../db");
const fetch = require('node-fetch');
const { getCurrentContractSymbol } = require('../utils/contractSymbols');
const logger = require('../config/logging');
const { roundStdDevLevels, roundToTickSize, roundToTwoDecimals } = require('../utils/tickSizeUtils');
const { refreshAccessTokenForUser } = require('./tradestation');

// Helper function to transform ticker to current contract if needed
const transformTickerToCurrentContract = (ticker) => {
  // Common futures products that need contract transformation
  const futuresProducts = ['MNQ', 'ES', 'NQ', 'YM', 'RTY', 'CL', 'GC', 'SI', 'ZB', 'ZN'];
  
  // Check if the ticker is a base futures product (no month/year suffix)
  const isBaseFutures = futuresProducts.some(product => ticker.toUpperCase() === product);
  
  if (isBaseFutures) {
    // Transform to current contract
    const currentContract = getCurrentContractSymbol(ticker.toUpperCase());
    return currentContract;
  }
  
  // Return as-is if not a base futures product
  return ticker.toUpperCase();
};

// Helper to get cached std dev levels
async function getCachedStdDevLevels(ticker, timeframe) {
  const cacheQuery = `
    SELECT * FROM std_dev_levels
    WHERE ticker = $1 AND timeframe = $2
      AND last_calculated > NOW() - INTERVAL '5 minutes'
    ORDER BY last_calculated DESC
    LIMIT 1
  `;
  const cacheResult = await pool.query(cacheQuery, [ticker, timeframe]);
  logger.debug('Cache query for', ticker, timeframe, 'result:', cacheResult.rows.length > 0 ? 'found' : 'not found');
  return cacheResult.rows[0] || null;
}

// Get all trade alerts for a user
const getTradeAlerts = async (req, res) => {
  try {
    const query = 'SELECT * FROM trade_alerts WHERE user_id = $1 ORDER BY created_at DESC';
    const result = await pool.query(query, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trade alerts:', error);
    res.status(500).json({ error: 'Failed to fetch trade alerts' });
  }
};

// Create a new trade alert
const createTradeAlert = async (req, res) => {
  try {
    const { ticker, alert_type, price_level, std_dev_level, timeframe } = req.body;
    
    if (!ticker || !alert_type) {
      return res.status(400).json({ error: 'Missing required fields: ticker, alert_type' });
    }
    
    // Transform ticker to current contract if needed
    const transformedTicker = transformTickerToCurrentContract(ticker);
    
    let finalPriceLevel = price_level;
    
    // If this is a std dev alert, get the price level from std dev levels
    if (std_dev_level) {
      // Get current std dev levels using the transformed ticker
      let levels = await getCachedStdDevLevels(transformedTicker, timeframe);
      
      if (levels) {
        logger.debug('Using cached std dev levels for', transformedTicker, timeframe);
      } else {
        // Calculate new levels if not cached
        logger.debug('Cache miss, calculating new std dev levels for', transformedTicker, timeframe);
        levels = await calculateStdDevLevels(transformedTicker, timeframe, req.user.id);
      }
      
      if (!levels) {
        return res.status(500).json({ error: 'Failed to calculate std dev levels' });
      }
      
      // Get the price level for the specified std dev level
      const priceLevelMap = {
        'std_dev_1_upper': levels.std_dev_1_upper,
        'std_dev_1_lower': levels.std_dev_1_lower,
        'std_dev_1_5_upper': levels.std_dev_1_5_upper,
        'std_dev_1_5_lower': levels.std_dev_1_5_lower,
        'std_dev_2_upper': levels.std_dev_2_upper,
        'std_dev_2_lower': levels.std_dev_2_lower
      };
      
      finalPriceLevel = priceLevelMap[std_dev_level];
      if (!finalPriceLevel) {
        return res.status(400).json({ error: 'Invalid std dev level' });
      }
    } else {
      // For regular price alerts, round to appropriate tick size
      finalPriceLevel = roundToTickSize(parseFloat(price_level), transformedTicker);
    }
    
    // Insert the alert
    const query = 'INSERT INTO trade_alerts (user_id, ticker, alert_type, price_level, std_dev_level, timeframe) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';
    const values = [req.user.id, transformedTicker, alert_type, finalPriceLevel, std_dev_level || null, timeframe || null];
    
    const result = await pool.query(query, values);
    
    res.json({
      success: true,
      alert: result.rows[0]
    });
    
  } catch (error) {
    logger.error('Error creating trade alert:', error);
    res.status(500).json({ error: 'Failed to create trade alert' });
  }
};

// Create a standard deviation alert (convenience function)
const createStdDevAlert = async (req, res) => {
  try {
    const { ticker, alert_type, std_dev_level, timeframe = '1hour' } = req.body;
    
    if (!ticker || !alert_type || !std_dev_level) {
      return res.status(400).json({ error: 'Missing required fields: ticker, alert_type, std_dev_level' });
    }
    
    if (!['above', 'below'].includes(alert_type)) {
      return res.status(400).json({ error: 'Alert type must be "above" or "below"' });
    }
    
    const validStdDevLevels = ['std_dev_1_upper', 'std_dev_1_lower', 'std_dev_1_5_upper', 'std_dev_1_5_lower', 'std_dev_2_upper', 'std_dev_2_lower'];
    if (!validStdDevLevels.includes(std_dev_level)) {
      return res.status(400).json({ error: 'Invalid std_dev_level. Must be one of: ' + validStdDevLevels.join(', ') });
    }
    
    // Transform ticker to current contract if needed
    const transformedTicker = transformTickerToCurrentContract(ticker);
    
    // Get current std dev levels using the transformed ticker
    let levels = await getCachedStdDevLevels(transformedTicker, timeframe);
    if (levels) {
      logger.debug('Using cached std dev levels for', transformedTicker, timeframe);
      const stdDevMap = {
        'std_dev_1_upper': levels.std_dev_1_upper,
        'std_dev_1_lower': levels.std_dev_1_lower,
        'std_dev_1_5_upper': levels.std_dev_1_5_upper,
        'std_dev_1_5_lower': levels.std_dev_1_5_lower,
        'std_dev_2_upper': levels.std_dev_2_upper,
        'std_dev_2_lower': levels.std_dev_2_lower
      };
      const priceLevel = stdDevMap[std_dev_level];
      
      const query = 'INSERT INTO trade_alerts (user_id, ticker, alert_type, price_level, std_dev_level, timeframe) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';
      const values = [req.user.id, transformedTicker, alert_type, priceLevel, std_dev_level, timeframe];
      const result = await pool.query(query, values);
      
      // Refresh the real-time alert checker with the new alert
      if (req.app.locals.realtimeAlertChecker) {
        await req.app.locals.realtimeAlertChecker.refreshAlerts();
      }
      
      res.status(201).json({
        ...result.rows[0],
        std_dev_level_name: std_dev_level,
        calculated_price: priceLevel
      });
    } else {
      logger.debug('Cache miss, calculating new std dev levels for', transformedTicker, timeframe);
      levels = await calculateStdDevLevels(transformedTicker, timeframe, req.user.id);
      if (!levels) {
        return res.status(500).json({ error: 'Failed to calculate std dev levels' });
      }
      
      // Map std_dev_level to the actual price level
      const stdDevMap = {
        'std_dev_1_upper': levels.std_dev_1_upper,
        'std_dev_1_lower': levels.std_dev_1_lower,
        'std_dev_1_5_upper': levels.std_dev_1_5_upper,
        'std_dev_1_5_lower': levels.std_dev_1_5_lower,
        'std_dev_2_upper': levels.std_dev_2_upper,
        'std_dev_2_lower': levels.std_dev_2_lower
      };
      
      const priceLevel = stdDevMap[std_dev_level];
      
      const query = 'INSERT INTO trade_alerts (user_id, ticker, alert_type, price_level, std_dev_level, timeframe) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *';
      const values = [req.user.id, transformedTicker, alert_type, priceLevel, std_dev_level, timeframe];
      const result = await pool.query(query, values);
      
      // Refresh the real-time alert checker with the new alert
      if (req.app.locals.realtimeAlertChecker) {
        await req.app.locals.realtimeAlertChecker.refreshAlerts();
      }
      
      res.status(201).json({
        ...result.rows[0],
        std_dev_level_name: std_dev_level,
        calculated_price: priceLevel
      });
    }
  } catch (error) {
    console.error('Error creating std dev alert:', error);
    res.status(500).json({ error: 'Failed to create std dev alert' });
  }
};

// Create a technical indicator alert
const createTechnicalIndicatorAlert = async (req, res) => {
  try {
    const { ticker, alert_type, indicator, threshold, timeframe = '1hour', period = null } = req.body;
    
    if (!ticker || !alert_type || !indicator || threshold === undefined) {
      return res.status(400).json({ error: 'Missing required fields: ticker, alert_type, indicator, threshold' });
    }
    
    if (!['above', 'below'].includes(alert_type)) {
      return res.status(400).json({ error: 'Alert type must be "above" or "below"' });
    }
    
    const validIndicators = ['rsi', 'ema'];
    if (!validIndicators.includes(indicator.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid indicator. Must be one of: rsi, ema' });
    }
    
    // Validate period for EMA
    if (indicator.toLowerCase() === 'ema' && !period) {
      return res.status(400).json({ error: 'Period is required for EMA alerts' });
    }
    
    // Transform ticker to current contract if needed
    const transformedTicker = transformTickerToCurrentContract(ticker);
    
    // Get current indicator value to validate the alert
    const { getRSIValue, getEMAValue } = require('./technicalIndicators');
    
    let currentValue = null;
    if (indicator.toLowerCase() === 'rsi') {
      currentValue = await getRSIValue(transformedTicker, timeframe);
    } else if (indicator.toLowerCase() === 'ema') {
      currentValue = await getEMAValue(transformedTicker, timeframe, parseInt(period));
    }
    
    if (currentValue === null) {
      return res.status(500).json({ error: 'Unable to get current indicator value' });
    }
    
    // Store the alert with the threshold value
    const query = `
      INSERT INTO trade_alerts 
      (user_id, ticker, alert_type, price_level, indicator_type, indicator_period, timeframe) 
      VALUES ($1, $2, $3, $4, $5, $6, $7) 
      RETURNING *
    `;
    const values = [
      req.user.id, 
      transformedTicker, 
      alert_type, 
      threshold, 
      indicator.toLowerCase(), 
      period, 
      timeframe
    ];
    
    const result = await pool.query(query, values);
    
    // Refresh the real-time alert checker with the new alert
    if (req.app.locals.realtimeAlertChecker) {
      await req.app.locals.realtimeAlertChecker.refreshAlerts();
    }
    
    res.status(201).json({
      ...result.rows[0],
      indicator_type: indicator.toLowerCase(),
      threshold: threshold,
      current_value: currentValue
    });
    
  } catch (error) {
    logger.error('Error creating technical indicator alert:', error);
    res.status(500).json({ error: 'Failed to create technical indicator alert' });
  }
};

// Update a trade alert
const updateTradeAlert = async (req, res) => {
  try {
    const { id } = req.params;
    const { ticker, alert_type, price_level, std_dev_level, timeframe, is_active } = req.body;
    
    // Debug logging
    logger.debug('Update trade alert request:', { id, ticker, alert_type, price_level, std_dev_level, timeframe, is_active });
    
    // Transform ticker to current contract if needed
    const transformedTicker = transformTickerToCurrentContract(ticker);
    
    // If std_dev_level is provided, calculate the price level from current std dev levels
    let finalPriceLevel = price_level;
    
    if (std_dev_level) {
      if (!timeframe) {
        return res.status(400).json({ error: 'Timeframe is required when using std_dev_level' });
      }
      
      // Validate std_dev_level format
      const validStdDevLevels = ['std_dev_1_upper', 'std_dev_1_lower', 'std_dev_1_5_upper', 'std_dev_1_5_lower', 'std_dev_2_upper', 'std_dev_2_lower'];
      if (!validStdDevLevels.includes(std_dev_level)) {
        logger.error('Invalid std_dev_level received:', std_dev_level);
        return res.status(400).json({ 
          error: 'Invalid std_dev_level. Must be one of: std_dev_1_upper, std_dev_1_lower, std_dev_1_5_upper, std_dev_1_5_lower, std_dev_2_upper, std_dev_2_lower',
          received: std_dev_level
        });
      }
      
      // Get current std dev levels using the transformed ticker
      let levels = await getCachedStdDevLevels(transformedTicker, timeframe);
      if (levels) {
        logger.debug('Using cached std dev levels for', transformedTicker, timeframe);
        const stdDevMap = {
          'std_dev_1_upper': levels.std_dev_1_upper,
          'std_dev_1_lower': levels.std_dev_1_lower,
          'std_dev_1_5_upper': levels.std_dev_1_5_upper,
          'std_dev_1_5_lower': levels.std_dev_1_5_lower,
          'std_dev_2_upper': levels.std_dev_2_upper,
          'std_dev_2_lower': levels.std_dev_2_lower
        };
        finalPriceLevel = stdDevMap[std_dev_level];
        if (!finalPriceLevel) {
          return res.status(400).json({ error: 'Invalid std_dev_level. Must be one of: std_dev_1_upper, std_dev_1_lower, std_dev_1_5_upper, std_dev_1_5_lower, std_dev_2_upper, std_dev_2_lower' });
        }
      } else {
        logger.debug('Cache miss, calculating new std dev levels for', transformedTicker, timeframe);
        levels = await calculateStdDevLevels(transformedTicker, timeframe, req.user.id);
        if (!levels) {
          return res.status(500).json({ error: 'Failed to calculate std dev levels' });
        }
        
        // Map std_dev_level to the actual price level
        const stdDevMap = {
          'std_dev_1_upper': levels.std_dev_1_upper,
          'std_dev_1_lower': levels.std_dev_1_lower,
          'std_dev_1_5_upper': levels.std_dev_1_5_upper,
          'std_dev_1_5_lower': levels.std_dev_1_5_lower,
          'std_dev_2_upper': levels.std_dev_2_upper,
          'std_dev_2_lower': levels.std_dev_2_lower
        };
        
        finalPriceLevel = stdDevMap[std_dev_level];
        if (!finalPriceLevel) {
          return res.status(400).json({ error: 'Invalid std_dev_level. Must be one of: std_dev_1_upper, std_dev_1_lower, std_dev_1_5_upper, std_dev_1_5_lower, std_dev_2_upper, std_dev_2_lower' });
        }
      }
    } else if (price_level) {
      // For regular price alerts, round to appropriate tick size and then to two decimal places
      finalPriceLevel = roundToTwoDecimals(roundToTickSize(parseFloat(price_level), transformedTicker));
    }
    
    const query = `
      UPDATE trade_alerts 
      SET ticker = $1, alert_type = $2, price_level = $3, std_dev_level = $4, timeframe = $5, is_active = $6, updated_at = CURRENT_TIMESTAMP 
      WHERE id = $7 AND user_id = $8 
      RETURNING *
    `;
    const values = [transformedTicker, alert_type, finalPriceLevel, std_dev_level || null, timeframe || null, is_active, id, req.user.id];
    const result = await pool.query(query, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trade alert not found' });
    }
    
    // Refresh the real-time alert checker with the updated alert
    if (req.app.locals.realtimeAlertChecker) {
      await req.app.locals.realtimeAlertChecker.refreshAlerts();
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Error updating trade alert:', error);
    res.status(500).json({ error: 'Failed to update trade alert' });
  }
};

// Delete a trade alert
const deleteTradeAlert = async (req, res) => {
  try {
    const { id } = req.params;
    
    const query = 'DELETE FROM trade_alerts WHERE id = $1 AND user_id = $2 RETURNING *';
    const result = await pool.query(query, [id, req.user.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trade alert not found' });
    }
    
    res.json({ message: 'Trade alert deleted successfully' });
  } catch (error) {
    console.error('Error deleting trade alert:', error);
    res.status(500).json({ error: 'Failed to delete trade alert' });
  }
};

// Get std dev levels for a ticker
const getStdDevLevels = async (req, res) => {
  try {
    const { ticker } = req.params;
    const { timeframe = '1hour' } = req.query;
    
    // Transform ticker to current contract if needed
    const transformedTicker = transformTickerToCurrentContract(ticker);
    
    console.error('Backend: Received request for std dev levels:', { ticker, transformedTicker, timeframe });
    
    // Check if we have recent data in cache (within last 5 minutes)
    const cacheQuery = `
      SELECT * FROM std_dev_levels 
      WHERE ticker = $1 AND timeframe = $2 
      AND last_calculated > NOW() - INTERVAL '5 minutes'
      ORDER BY last_calculated DESC 
      LIMIT 1
    `;
    
    const cacheResult = await pool.query(cacheQuery, [transformedTicker, timeframe]);
    
    if (cacheResult.rows.length > 0) {
      console.error('Backend: Returning cached std dev levels for', transformedTicker, timeframe);
      res.json(cacheResult.rows[0]);
      return;
    }
    
    // Calculate new levels using the transformed ticker
    console.error('Backend: Cache miss, calculating new std dev levels for', transformedTicker, timeframe);
    const levels = await calculateStdDevLevels(transformedTicker, timeframe, req.user.id);
    
    if (levels) {
      res.json(levels);
    } else {
      res.status(500).json({ error: 'Failed to calculate std dev levels' });
    }
  } catch (error) {
    console.error('Backend: Error in std_dev_levels endpoint:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get alert logs
const getAlertLogs = async (req, res) => {
  try {
    const query = `
      SELECT al.*, ta.ticker, ta.alert_type as alert_type_name 
      FROM alert_logs al 
      JOIN trade_alerts ta ON al.alert_id = ta.id 
      WHERE ta.user_id = $1 
      ORDER BY al.triggered_at DESC
    `;
    const result = await pool.query(query, [req.user.id]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching alert logs:', error);
    res.status(500).json({ error: 'Failed to fetch alert logs' });
  }
};

// Run alert checker manually
const runAlertChecker = async (req, res) => {
  try {
    // This would trigger the background process
    // For now, we'll just return success
    res.json({ message: 'Alert checker triggered successfully' });
  } catch (error) {
    console.error('Error running alert checker:', error);
    res.status(500).json({ error: 'Failed to run alert checker' });
  }
};

// Helper function to calculate standard deviation levels
const calculateStdDevLevels = async (ticker, timeframe = '1hour', userId = 1) => {
  try {
    // Get user credentials from api_credentials table
    const credentialsQuery = 'SELECT * FROM api_credentials WHERE user_id = $1 LIMIT 1';
    let credentialsResult = await pool.query(credentialsQuery, [userId]);
    if (credentialsResult.rows.length === 0) {
      logger.error(`No API credentials found for user ${userId}`);
      return null;
    }
    let credentials = credentialsResult.rows[0];

    // Check if access token is expired and refresh if needed
    if (credentials.expires_at && new Date(credentials.expires_at) < new Date()) {
      logger.error('Access token expired, refreshing...');
      // Call the refresh logic before continuing
      await refreshAccessTokenForUser(userId);
      // Re-fetch credentials after refresh
      credentialsResult = await pool.query(credentialsQuery, [userId]);
      credentials = credentialsResult.rows[0];
    }
    
    // Map timeframe to TradeStation API unit and barsback
    const timeframeConfig = {
      '5min': { unit: 'Minute', interval: 5, barsback: 1000 },
      '15min': { unit: 'Minute', interval: 15, barsback: 1000 },
      '30min': { unit: 'Minute', interval: 30, barsback: 1000 },
      '1hour': { unit: 'Minute', interval: 60, barsback: 5000 },
      '4hour': { unit: 'Minute', interval: 240, barsback: 1000 },
      'daily': { unit: 'Daily', interval: 1, barsback: 500 }
    };
    
    const config = timeframeConfig[timeframe];
    if (!config) {
      logger.error('Invalid timeframe:', timeframe);
      return null;
    }
    
    // Fetch market data from TradeStation API
    const barsUrl = `https://api.tradestation.com/v3/marketdata/barcharts/${ticker}`;
    
    // Use barsback parameter with proper unit mapping
    const params = new URLSearchParams({
      unit: config.unit,
      interval: config.interval.toString(),
      barsback: config.barsback.toString()
    });
    
    const fullUrl = `${barsUrl}?${params}`;
    logger.tradestation(fullUrl);
    
    const response = await fetch(fullUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${credentials.access_token}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Failed to fetch market data from TradeStation:', response.status, response.statusText);
      logger.error('Error response:', errorText);
      return null;
    }
    
    const data = await response.json();
    const bars = data.Bars || [];
    
    if (bars.length < 20) {
      logger.error('Insufficient data for std dev calculation. Got', bars.length, 'bars, need at least 20');
      return null;
    }
    
    // Calculate candle body sizes (open - close)
    const bodySizes = bars.map(bar => Math.abs(parseFloat(bar.Close) - parseFloat(bar.Open)));
    
    // Calculate mean body size
    const mean = bodySizes.reduce((sum, size) => sum + size, 0) / bodySizes.length;
    
    // Calculate standard deviation
    const variance = bodySizes.reduce((sum, size) => sum + Math.pow(size - mean, 2), 0) / bodySizes.length;
    const stdDev = Math.sqrt(variance);
    
    // Get the open price of the most recent bar as the stable reference price
    const referencePrice = parseFloat(bars[bars.length - 1].Open);
    
    // Calculate std dev levels (raw calculation first)
    const rawLevels = {
      ticker,
      timeframe,
      reference_price: referencePrice,
      mean_price: Math.round(mean * 100) / 100,
      std_dev: Math.round(stdDev * 100) / 100,
      std_dev_1_upper: referencePrice + stdDev,
      std_dev_1_lower: referencePrice - stdDev,
      std_dev_1_5_upper: referencePrice + (1.5 * stdDev),
      std_dev_1_5_lower: referencePrice - (1.5 * stdDev),
      std_dev_2_upper: referencePrice + (2 * stdDev),
      std_dev_2_lower: referencePrice - (2 * stdDev),
      bars_count: bars.length
    };
    
    // Round all levels to appropriate tick size for this ticker
    const levels = roundStdDevLevels(rawLevels, ticker);
    
    // Save to database
    const upsertQuery = `
      INSERT INTO std_dev_levels (ticker, timeframe, reference_price, mean_price, std_dev, std_dev_1_upper, std_dev_1_lower, std_dev_1_5_upper, std_dev_1_5_lower, std_dev_2_upper, std_dev_2_lower, bars_count)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (ticker, timeframe) 
      DO UPDATE SET 
        reference_price = EXCLUDED.reference_price,
        mean_price = EXCLUDED.mean_price,
        std_dev = EXCLUDED.std_dev,
        std_dev_1_upper = EXCLUDED.std_dev_1_upper,
        std_dev_1_lower = EXCLUDED.std_dev_1_lower,
        std_dev_1_5_upper = EXCLUDED.std_dev_1_5_upper,
        std_dev_1_5_lower = EXCLUDED.std_dev_1_5_lower,
        std_dev_2_upper = EXCLUDED.std_dev_2_upper,
        std_dev_2_lower = EXCLUDED.std_dev_2_lower,
        bars_count = EXCLUDED.bars_count,
        last_calculated = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `;
    
    await pool.query(upsertQuery, [
      levels.ticker, levels.timeframe, levels.reference_price, levels.mean_price, levels.std_dev,
      levels.std_dev_1_upper, levels.std_dev_1_lower, levels.std_dev_1_5_upper, levels.std_dev_1_5_lower,
      levels.std_dev_2_upper, levels.std_dev_2_lower, levels.bars_count
    ]);
    
    return levels;
  } catch (error) {
    logger.error('Error calculating std dev levels:', error);
    return null;
  }
};

// Debug endpoint to check API credentials
const debugCredentials = async (req, res) => {
  try {
    const credentialsQuery = 'SELECT user_id, access_token, refresh_token, expires_at FROM api_credentials WHERE user_id = $1 LIMIT 1';
    const credentialsResult = await pool.query(credentialsQuery, [req.user.id]);
    
    if (credentialsResult.rows.length === 0) {
      return res.json({ 
        error: `No API credentials found for user_id ${req.user.id}`,
        message: 'You need to authenticate with TradeStation first'
      });
    }
    
    const credentials = credentialsResult.rows[0];
    const hasToken = !!credentials.access_token;
    const tokenExpired = credentials.expires_at ? new Date(credentials.expires_at) < new Date() : false;
    
    res.json({
      hasCredentials: true,
      hasToken,
      tokenExpired,
      expiresAt: credentials.expires_at,
      message: hasToken && !tokenExpired ? 'Credentials look good' : 'Token missing or expired'
    });
  } catch (error) {
    console.error('Error checking credentials:', error);
    res.status(500).json({ error: 'Failed to check credentials' });
  }
};

// Update all timeframes for a ticker
const updateAllTimeframesForTicker = async (req, res) => {
  try {
    const { ticker } = req.params;
    const AlertChecker = require('../workers/alertChecker');
    const alertChecker = new AlertChecker();
    
    await alertChecker.updateAllTimeframesForTicker(ticker, req.user.id);
    
    res.json({ message: `Updated all timeframes for ${ticker}` });
  } catch (error) {
    console.error('Backend: Error updating all timeframes:', error);
    res.status(500).json({ error: error.message });
  }
};

// Test endpoint to trigger an email notification
const testEmailNotification = async (req, res) => {
  try {
    // This is just a test endpoint
    res.json({ message: 'Test email notification endpoint' });
  } catch (error) {
    console.error('Error in test email notification:', error);
    res.status(500).json({ error: 'Failed to test email notification' });
  }
};

module.exports = {
  getTradeAlerts,
  createTradeAlert,
  createStdDevAlert,
  createTechnicalIndicatorAlert,
  updateTradeAlert,
  deleteTradeAlert,
  getStdDevLevels,
  getAlertLogs,
  runAlertChecker,
  calculateStdDevLevels,
  debugCredentials,
  updateAllTimeframesForTicker,
  testEmailNotification
}; 