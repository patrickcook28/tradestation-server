const jwt = require("jsonwebtoken")
const fetch = require('node-fetch');
const pool = require("../db");
const {json} = require("express");
const { getCommonFuturesContracts, getContractSeries } = require('../utils/contractSymbols');
const { getUserAccessToken } = require('../utils/tradestationProxy');
const { getUserCredentials } = require('../utils/secureCredentials');
const { refreshAccessTokenForUserLocked } = require('../utils/tokenRefresh');
const { getFetchOptionsWithAgent } = require('../utils/httpAgent');

// Get historical orders from local database for performance analysis
const getLocalHistoricalOrders = async (req, res) => {
  try {
    const userId = req.user.id;
    const { startDate, endDate, limit = 1000 } = req.query;

    // Build query with optional date filtering
    let query = `
      SELECT order_data, order_id, parent_order_id, created_at
      FROM "order" 
      WHERE user_id = $1
    `;
    const params = [userId];
    let paramIndex = 2;

    if (startDate) {
      query += ` AND created_at >= $${paramIndex}`;
      params.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      query += ` AND created_at <= $${paramIndex}`;
      params.push(endDate);
      paramIndex++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    
    // Transform the data to match the expected format
    const orders = result.rows.map(row => ({
      ...row.order_data,
      OrderID: row.order_id,
      CreatedAt: row.created_at
    }));

    res.json({
      success: true,
      orders: orders,
      count: orders.length
    });

  } catch (error) {
    console.error('Error fetching historical orders:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch historical orders'
    });
  }
};

const handleOAuthCallback = async (req, res) => {
  const code = req.query.code;
  const token = req.query.state;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code received' });
  }

  if (!token) {
    return res.status(400).json({ error: 'No state token received' });
  }

  // Verify JWT token
  try {
    const user = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    req.user = user;
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }

  // Use the authorization code to request an access token
  const token_url = 'https://signin.tradestation.com/oauth/token';
  const data = {
    'grant_type': 'authorization_code',
    'client_id': process.env.TRADESTATION_CLIENT_ID,
    'client_secret': process.env.TRADESTATION_CLIENT_SECRET,
    'code': code,
    'redirect_uri': process.env.TRADESTATION_REDIRECT_URI
  };

  try {
    const response = await fetch(token_url, getFetchOptionsWithAgent(token_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    }));

    if (response.ok) {
      const json_response = await response.json();
      
      const access_token = json_response['access_token'];
      const refresh_token = json_response['refresh_token'];
      const expires_at = new Date(Date.now() + 1200 * 1000).toISOString();

      if (!access_token || !refresh_token) {
        return res.status(500).json({ error: 'Invalid response from TradeStation' });
      }

      // Save credentials to database (encrypted)
      try {
        const { setUserCredentials } = require('../utils/secureCredentials');
        await setUserCredentials(req.user.id, { access_token, refresh_token, expires_at });

        
        const redirectUrl = `${process.env.FRONTEND_URL}/trade`;
        console.log('Redirecting to:', redirectUrl);
        res.redirect(redirectUrl);
      } catch (dbError) {
        res.status(500).json({ error: 'Failed to save credentials', dbError: dbError.message });
      }
    } else {
      const errorResponse = await response.json();
      res.status(response.status).json({ 
        error: errorResponse, 
        message: 'could not get access token',
        status: response.status
      });
    }
  } catch (error) {
    res.status(500).json({ 
      error: error.message, 
      message: 'could not get access token' 
    });
  }
}

const refreshAccessToken = async (req, res) => {
  try {
    const result = await refreshAccessTokenForUserLocked(req.user.id);
    return res.json(result);
  } catch (error) {
    const status = error.status || 400;
    return res.status(status).json({ error: error.message || 'could not refresh token' });
  }
}

// Get stored API credentials for the authenticated user (sanitized: no tokens returned)
const getStoredCredentials = async (req, res) => {
  try {
    const creds = await getUserCredentials(req.user.id);
    if (!creds) return res.status(404).json({ error: 'No credentials found' });
    return res.json({
      hasCredentials: true,
      expires_at: creds.expires_at
    });
  } catch (error) {
    console.error('Error getting stored credentials:', error);
    return res.status(500).json({ success: false, error: 'Failed to retrieve stored credentials' });
  }
};

// Get ticker options for the UI
const getTickerOptions = async (req, res) => {
  try {
    const { search = '' } = req.query;
    
    // Get common futures with current contracts
    const futuresContracts = getCommonFuturesContracts();
    
    // Add some common stock symbols
    const commonStocks = [
      { symbol: 'AAPL', name: 'Apple Inc.' },
      { symbol: 'MSFT', name: 'Microsoft Corporation' },
      { symbol: 'GOOGL', name: 'Alphabet Inc.' },
      { symbol: 'AMZN', name: 'Amazon.com Inc.' },
      { symbol: 'TSLA', name: 'Tesla Inc.' },
      { symbol: 'NVDA', name: 'NVIDIA Corporation' },
      { symbol: 'META', name: 'Meta Platforms Inc.' },
      { symbol: 'SPY', name: 'SPDR S&P 500 ETF' },
      { symbol: 'QQQ', name: 'Invesco QQQ Trust' },
      { symbol: 'IWM', name: 'iShares Russell 2000 ETF' }
    ];
    
    // Combine all suggestions
    const allSuggestions = [
      ...futuresContracts.map(f => ({
        value: f.currentContract,
        label: `${f.currentContract} - ${f.name}`,
        type: 'futures'
      })),
      ...commonStocks.map(s => ({
        value: s.symbol,
        label: `${s.symbol} - ${s.name}`,
        type: 'stock'
      }))
    ];
    
    // Filter by search term if provided
    let filteredSuggestions = allSuggestions;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredSuggestions = allSuggestions.filter(suggestion => 
        suggestion.value.toLowerCase().includes(searchLower) ||
        suggestion.label.toLowerCase().includes(searchLower)
      );
    }
    
    // Limit results
    filteredSuggestions = filteredSuggestions.slice(0, 20);
    
    res.json({
      success: true,
      suggestions: filteredSuggestions
    });
    
  } catch (error) {
    console.error('Error getting ticker options:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get ticker options'
    });
  }
};

// Get available contracts for a ticker (e.g., MNQZ24, MNQH25, etc.)
const getTickerContracts = async (req, res) => {
  try {
    const { ticker } = req.params;
    const { count = 4 } = req.query;
    
    // Extract the base product (e.g., 'MNQ' from 'MNQZ24')
    const baseProduct = ticker.replace(/[A-Z]\d{2}$/, '').toUpperCase();
    
    const contracts = getContractSeries(baseProduct, parseInt(count));
    
    res.json({
      success: true,
      contracts: contracts.map(contract => ({
        value: contract,
        label: contract
      }))
    });
    
  } catch (error) {
    console.error('Error getting ticker contracts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get ticker contracts'
    });
  }
};

// Reusable function to refresh access token for a user
const refreshAccessTokenForUser = async (userId) => {
  // Get credentials from DB
  const result = await pool.query('SELECT * FROM api_credentials WHERE user_id = $1', [userId]);
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }
  const oauthCredentials = result.rows[0];
  const token_url = 'https://signin.tradestation.com/oauth/token';
  const data = {
    'grant_type': 'refresh_token',
    'client_id': process.env.TRADESTATION_CLIENT_ID,
    'client_secret': process.env.TRADESTATION_CLIENT_SECRET,
    'refresh_token': oauthCredentials.refresh_token
  };
  const response = await fetch(token_url, getFetchOptionsWithAgent(token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  }));
  if (!response.ok) {
    throw new Error('Attempt to refresh token failed due to Tradestation response');
  }
  const json_response = await response.json();
  const access_token = json_response['access_token'];
  const expires_at = new Date(Date.now() + 1200 * 1000).toISOString();
  // Update the access token and expiration time in the database
  await pool.query('UPDATE api_credentials SET access_token = $1, expires_at = $2 WHERE user_id = $3', [access_token, expires_at, userId]);
  return { access_token, expires_at };
};

const { respondWithTradestation } = require('../utils/tradestationProxy');
const { getMaintenanceStatus } = require('../utils/maintenance');

// Proxy: Get accounts from TradeStation using stored access token (no refresh logic)
const getAccounts = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  return respondWithTradestation(req, res, {
    method: 'GET',
    path: '/brokerage/accounts',
    paperTrading,
  });
};

// Proxy: Get balances for a specific account
const getBalances = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  const { accountId } = req.params;
  return respondWithTradestation(req, res, {
    method: 'GET',
    path: `/brokerage/accounts/${accountId}/balances`,
    paperTrading,
  });
};

// Proxy: Get positions for a specific account
const getPositions = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  const { accountId } = req.params;
  return respondWithTradestation(req, res, {
    method: 'GET',
    path: `/brokerage/accounts/${accountId}/positions`,
    paperTrading,
  });
};

// Proxy: Get orders for a specific account
const getOrders = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  const { accountId } = req.params;
  return respondWithTradestation(req, res, {
    method: 'GET',
    path: `/brokerage/accounts/${accountId}/orders`,
    paperTrading,
  });
};

// Proxy: Get historical orders (supports since, pageSize, nextToken)
const getHistoricalOrders = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  const { accountId } = req.params;
  const { since, pageSize, nextToken } = req.query;
  return respondWithTradestation(req, res, {
    method: 'GET',
    path: `/brokerage/accounts/${accountId}/historicalorders`,
    paperTrading,
    query: { since, pageSize, nextToken },
  });
};

// Proxy: Market data - ticker details
const getTickerDetails = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const { ticker } = req.params;
  // Market data uses live base; ignore paperTrading
  return respondWithTradestation(req, res, {
    method: 'GET',
    path: `/marketdata/symbols/${ticker}`,
    paperTrading: false,
  });
};

// Proxy: Market data - bar charts
const getBarCharts = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const { ticker } = req.params;
  const { interval, unit, barsback, sessiontemplate, lastdate, firstdate } = req.query;
  return respondWithTradestation(req, res, {
    method: 'GET',
    path: `/marketdata/barcharts/${ticker}`,
    paperTrading: false,
    // Support both basic paging (barsback) and time-bounded queries (lastdate/firstdate)
    query: { interval, unit, barsback, sessiontemplate, lastdate, firstdate },
  });
};

// Proxy: Order execution - create order
const createOrder = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  return respondWithTradestation(req, res, {
    method: 'POST',
    path: `/orderexecution/orders`,
    paperTrading,
    body: req.body,
  });
};

// Proxy: Order execution - get/update/delete a specific order
const getOrder = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  const { orderId } = req.params;
  return respondWithTradestation(req, res, {
    method: 'GET',
    path: `/orderexecution/orders/${orderId}`,
    paperTrading,
  });
};

const updateOrder = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  const { orderId } = req.params;
  return respondWithTradestation(req, res, {
    method: 'PUT',
    path: `/orderexecution/orders/${orderId}`,
    paperTrading,
    body: req.body,
  });
};

const cancelOrder = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  const { orderId } = req.params;
  return respondWithTradestation(req, res, {
    method: 'DELETE',
    path: `/orderexecution/orders/${orderId}`,
    paperTrading,
  });
};

// Proxy: Order execution - create order group (brackets)
const createOrderGroup = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  return respondWithTradestation(req, res, {
    method: 'POST',
    path: `/orderexecution/ordergroups`,
    paperTrading,
    body: req.body,
  });
};

// Stream: Market data - quotes (proxy streaming response to client)
const { streamTradestation } = require('../utils/tradestationProxy');
const quoteStreamManager = require('../utils/quoteStreamManager');
const { captureException, captureMessage } = require('../utils/errorReporting');

const streamQuotes = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const { symbols } = req.query;
  if (!symbols || String(symbols).trim().length === 0) {
    return res.status(400).json({ error: 'symbols query param is required' });
  }
  // Normalize and dedupe symbols before proxying
  const decoded = decodeURIComponent(String(symbols));
  const list = decoded.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const unique = Array.from(new Set(list));
  const joined = unique.join(',');
  // Ensure single upstream per user; broadcast to this client
  return quoteStreamManager.addSubscriber(String(req.user.id), joined, res).catch(err => {
    try { captureException(err, { route: 'streamQuotes', symbols: joined }); } catch (_) {}
    const status = err.status || 500;
    return res.status(status).json(err.response || { error: err.message || 'Failed to start quote stream' });
  });
};

// Stream: Brokerage positions per account (backend-proxied)
const positionsStreamManager = require('../utils/positionsStreamManager');
const streamPositions = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const { accountId } = req.params;
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  if (!accountId) {
    return res.status(400).json({ error: 'accountId is required' });
  }
  return positionsStreamManager.addSubscriber(String(req.user.id), { accountId, paperTrading }, res).catch(err => {
    try { captureException(err, { route: 'streamPositions', accountId, paperTrading }); } catch (_) {}
    const status = err.status || 500;
    return res.status(status).json(err.response || { error: err.message || 'Failed to start positions stream' });
  });
};

// Stream: Brokerage orders per account (backend-proxied)
const ordersStreamManager = require('../utils/ordersStreamManager');
const streamOrders = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const { accountId } = req.params;
  const paperTrading = String(req.query.paperTrading).toLowerCase() === 'true';
  if (!accountId) {
    return res.status(400).json({ error: 'accountId is required' });
  }
  return ordersStreamManager.addSubscriber(String(req.user.id), { accountId, paperTrading }, res).catch(err => {
    try { captureException(err, { route: 'streamOrders', accountId, paperTrading }); } catch (_) {}
    const status = err.status || 500;
    return res.status(status).json(err.response || { error: err.message || 'Failed to start orders stream' });
  });
};

// Stream: Bars (market data barcharts)
const barsStreamManager = require('../utils/barsStreamManager');
const streamBars = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const { ticker } = req.params;
  const { interval, unit, barsback, sessiontemplate } = req.query;
  if (!ticker || !interval || !unit) {
    return res.status(400).json({ error: 'ticker, interval, and unit are required' });
  }
  const params = { ticker, interval, unit, barsback, sessiontemplate };
  return barsStreamManager.addSubscriber(String(req.user.id), params, res).catch(err => {
    try { captureException(err, { route: 'streamBars', ...params }); } catch (_) {}
    const status = err.status || 500;
    return res.status(status).json(err.response || { error: err.message || 'Failed to start bars stream' });
  });
};

// Stream: Market depth aggregates (backend-proxied)
const marketAggregatesStreamManager = require('../utils/marketAggregatesStreamManager');
const streamMarketAggregates = async (req, res) => {
  const maint = await getMaintenanceStatus();
  if (maint.is_enabled) {
    return res.status(503).json({ error: 'Service unavailable (maintenance mode)', maintenance: maint });
  }
  const { ticker } = req.params;
  if (!ticker) {
    return res.status(400).json({ error: 'ticker is required' });
  }
  return marketAggregatesStreamManager.addSubscriber(String(req.user.id), { ticker }, res).catch(err => {
    try { captureException(err, { route: 'streamMarketAggregates', ticker }); } catch (_) {}
    const status = err.status || 500;
    return res.status(status).json(err.response || { error: err.message || 'Failed to start market aggregates stream' });
  });
};

module.exports = {
  handleOAuthCallback,
  refreshAccessToken,
  getStoredCredentials,
  getTickerOptions,
  getTickerContracts,
  refreshAccessTokenForUser,
  getAccounts,
  getBalances,
  getPositions,
  getOrders,
  getHistoricalOrders,
  getTickerDetails,
  getBarCharts,
  createOrder,
  getOrder,
  updateOrder,
  cancelOrder,
  createOrderGroup,
  streamQuotes,
  streamPositions,
  streamOrders,
  streamBars,
  streamMarketAggregates,
};