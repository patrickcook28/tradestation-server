const fetch = require('node-fetch');
const pool = require('../db');
const logger = require('../config/logging');

const getTradeStationBaseUrl = (paperTrading) => {
  return paperTrading ? 'https://sim-api.tradestation.com/v3' : 'https://api.tradestation.com/v3';
};

const buildUrl = (paperTrading, path, query) => {
  const base = getTradeStationBaseUrl(paperTrading);
  let url = `${base}${path}`;
  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.append(key, String(value));
      }
    });
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
};

const getUserAccessToken = async (userId) => {
  const credResult = await pool.query('SELECT access_token FROM api_credentials WHERE user_id = $1', [userId]);
  if (credResult.rows.length === 0) {
    const err = new Error('No API credentials found');
    err.status = 404;
    throw err;
  }
  return credResult.rows[0].access_token;
};

// Generic TradeStation request by path/query/body with stored access token
const tradestationRequest = async (userId, {
  method = 'GET',
  path,
  paperTrading = false,
  query = undefined,
  body = undefined,
  headers = {},
} = {}) => {
  if (!path || !path.startsWith('/')) {
    throw new Error('tradestationRequest requires a path starting with "/"');
  }

  const accessToken = await getUserAccessToken(userId);
  const url = buildUrl(paperTrading, path, query);

  const fetchHeaders = {
    'Authorization': `Bearer ${accessToken}`,
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  };

  const options = {
    method,
    headers: fetchHeaders,
    ...(body !== undefined && body !== null ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  };

  // Optional: simple request logging for future enhancement
  try { logger && logger.tradestation && logger.tradestation(url); } catch (_) {}

  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }

  return { ok: response.ok, status: response.status, data };
};

// Standardized wrapper to execute a TradeStation request and write HTTP response
const respondWithTradestation = async (req, res, requestOptions) => {
  try {
    const result = await tradestationRequest(req.user.id, requestOptions);
    if (!result.ok) {
      return res.status(result.status).json(result.data);
    }
    return res.json(result.data);
  } catch (error) {
    // Centralized error logging/formatting
    try { logger && logger.error && logger.error('TradeStation proxy error:', error); } catch (_) { console.error('TradeStation proxy error:', error); }
    const status = error.status || 500;
    const message = error.message || 'Internal server error';
    return res.status(status).json({ error: message });
  }
};

module.exports = {
  tradestationRequest,
  getTradeStationBaseUrl,
  respondWithTradestation,
};


