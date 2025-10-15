const fetch = require('node-fetch');
const logger = require('../config/logging');
const { getFetchOptionsWithAgent } = require('../utils/httpAgent');

// Map our timeframes to Alpha Vantage intervals
const timeframeToInterval = {
  '5min': '5min',
  '15min': '15min', 
  '30min': '30min',
  '1hour': '60min',
  'daily': 'daily',
  'weekly': 'weekly',
  'monthly': 'monthly'
};

// Get single technical indicator value from Alpha Vantage (for alerts)
const getAlphaVantageIndicatorValue = async (ticker, function_name, timeframe = '1hour', time_period = null, series_type = 'close') => {
  try {
    const ALPHA_VANTAGE_API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
    
    if (!ALPHA_VANTAGE_API_KEY) {
      throw new Error('Alpha Vantage API key not configured');
    }

    // Map timeframe to Alpha Vantage interval
    const interval = timeframeToInterval[timeframe] || '60min';

    const params = new URLSearchParams({
      function: function_name,
      symbol: ticker,
      interval: interval,
      series_type: series_type,
      apikey: ALPHA_VANTAGE_API_KEY
    });

    // Add time_period for indicators that need it
    if (time_period) {
      params.set('time_period', time_period.toString());
    }

    const url = `https://www.alphavantage.co/query?${params}`;
    logger.debug('Alpha Vantage API call for alert:', url);

    const response = await fetch(url, getFetchOptionsWithAgent(url, {}));
    if (!response.ok) {
      throw new Error(`Alpha Vantage API error: ${response.status}`);
    }

    const data = await response.json();

    // Check for API errors
    if (data['Error Message']) {
      throw new Error(data['Error Message']);
    }

    if (data['Note']) {
      logger.warn('Alpha Vantage API limit reached:', data['Note']);
      return null;
    }

    // Extract the latest value from technical analysis data
    const timeSeriesKey = Object.keys(data).find(key => key.includes('Technical Analysis'));
    if (!timeSeriesKey || !data[timeSeriesKey]) {
      throw new Error('No technical analysis data found');
    }

    const timeSeries = data[timeSeriesKey];
    const latestTime = Object.keys(timeSeries).sort().pop();
    const latestValue = parseFloat(timeSeries[latestTime][function_name]);

    return latestValue;

  } catch (error) {
    logger.error('Alpha Vantage API error:', error);
    return null;
  }
};

// Get RSI value for alerts
const getRSIValue = async (ticker, timeframe = '1hour') => {
  return await getAlphaVantageIndicatorValue(ticker, 'RSI', timeframe, '14');
};

// Get EMA value for alerts
const getEMAValue = async (ticker, timeframe = '1hour', period = 20) => {
  return await getAlphaVantageIndicatorValue(ticker, 'EMA', timeframe, period.toString());
};

module.exports = {
  getAlphaVantageIndicatorValue,
  getRSIValue,
  getEMAValue
}; 