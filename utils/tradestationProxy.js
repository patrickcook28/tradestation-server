const fetch = require('node-fetch');
const pool = require('../db');
const { decryptToken } = require('./secureCredentials');
const logger = require('../config/logging');
const { captureException, captureMessage } = require('./errorReporting');

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
  try {
    return decryptToken(credResult.rows[0].access_token);
  } catch (e) {
    // Badly formatted encrypted token; purge creds to force reconnect
    try { await pool.query('DELETE FROM api_credentials WHERE user_id = $1', [userId]); } catch (_) {}
    const err = new Error('Unable to decrypt credentials, clearing credentials');
    err.status = 401;
    throw err;
  }
};

// Single-flight refresh control: only one refresh runs at a time per user
const inflightRefreshByUserId = new Map();

const refreshAccessTokenSingleFlight = async (userId) => {
  if (inflightRefreshByUserId.has(userId)) {
    return inflightRefreshByUserId.get(userId);
  }
  const promise = (async () => {
    try {
      const result = await pool.query('SELECT refresh_token FROM api_credentials WHERE user_id = $1', [userId]);
      if (result.rows.length === 0) {
        const err = new Error('User not found');
        err.status = 404;
        throw err;
      }
      const refresh_token = decryptToken(result.rows[0].refresh_token);
      const token_url = 'https://signin.tradestation.com/oauth/token';
      const data = {
        'grant_type': 'refresh_token',
        'client_id': process.env.TRADESTATION_CLIENT_ID,
        'client_secret': process.env.TRADESTATION_CLIENT_SECRET,
        'refresh_token': refresh_token
      };
      const response = await fetch(token_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!response.ok) {
        const text = await response.text();
        try { logger && logger.error && logger.error('Token refresh failed', response.status, text); } catch (_) {}
        // Only purge credentials when TradeStation explicitly returns 401 (invalid/expired refresh token)
        if (response.status === 401) {
          try { await pool.query('DELETE FROM api_credentials WHERE user_id = $1', [userId]); } catch (_) {}
        }
        const err = new Error('Attempt to refresh token failed due to Tradestation response');
        err.status = response.status || 401;
        throw err;
      }
      const json_response = await response.json();
      const access_token = json_response['access_token'];
      const expires_at = new Date(Date.now() + 1200 * 1000).toISOString();
      const { updateAccessToken } = require('./secureCredentials');
      await updateAccessToken(userId, access_token, expires_at);
      return { access_token, expires_at };
    } finally {
      inflightRefreshByUserId.delete(userId);
    }
  })();
  inflightRefreshByUserId.set(userId, promise);
  return promise;
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

  let accessToken = await getUserAccessToken(userId);
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
  // try { logger && logger.tradestation && logger.tradestation(url); } catch (_) {}

  let response = await fetch(url, options);
  let text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }

  // If unauthorized, perform single-flight refresh and retry once
  if (response.status === 401) {
    try {
      const refreshed = await refreshAccessTokenSingleFlight(userId);
      accessToken = refreshed.access_token;
      const retryHeaders = {
        ...fetchHeaders,
        'Authorization': `Bearer ${accessToken}`,
      };
      response = await fetch(url, { ...options, headers: retryHeaders });
      text = await response.text();
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    } catch (err) {
      // Propagate original 401 if refresh fails
      return { ok: false, status: 401, data };
    }
  }

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
    try { captureException(error, { scope: 'respondWithTradestation', path: requestOptions && requestOptions.path }); } catch (_) {}
    const status = error.status || 500;
    const message = error.message || 'Internal server error';
    return res.status(status).json({ error: message });
  }
};

module.exports = {
  tradestationRequest,
  getTradeStationBaseUrl,
  respondWithTradestation,
  buildUrl,
  getUserAccessToken,
  // Stream a TradeStation endpoint to the client using the stored access token
  /**
   * Proxies a streaming HTTP response from TradeStation to the client.
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {{ path: string, paperTrading?: boolean, query?: Record<string, any>, headers?: Record<string,string> }} options
   */
  streamTradestation: async (req, res, { path, paperTrading = false, query = undefined, headers = {} } = {}) => {
    try {
      if (!path || !path.startsWith('/')) {
        throw Object.assign(new Error('streamTradestation requires a path starting with "/"'), { status: 400 });
      }

      // Retrieve user access token
      const credResult = await pool.query('SELECT access_token FROM api_credentials WHERE user_id = $1', [req.user.id]);
      if (credResult.rows.length === 0) {
        return res.status(404).json({ error: 'No API credentials found' });
      }
      const accessToken = decryptToken(credResult.rows[0].access_token);

      // Build URL
      const url = buildUrl(paperTrading, path, query);

      // Initiate upstream streaming request
      const upstream = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          ...headers,
        },
      });

      if (!upstream.ok) {
        const text = await upstream.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
        try { captureMessage('Upstream TradeStation non-OK in stream', { path, status: upstream.status, data: JSON.stringify(data).slice(0, 500) }); } catch (_) {}
        return res.status(upstream.status).json(data);
      }

      // Prepare client response for streaming JSON
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const readable = upstream.body;

      const onClientClose = () => {
        try { readable && readable.destroy && readable.destroy(); } catch (_) {}
      };
      req.on('close', onClientClose);

      readable.on('data', (chunk) => {
        try { res.write(chunk); } catch (_) {}
      });

      readable.on('end', () => {
        try { res.end(); } catch (_) {}
      });

      readable.on('error', (err) => {
        try { captureException(err || new Error('Readable stream error'), { scope: 'streamTradestation', path }); } catch (_) {}
        if (!res.headersSent) {
          try { res.status(502).json({ error: 'Upstream stream error' }); } catch (_) {}
        } else {
          try { res.end(); } catch (_) {}
        }
      });
    } catch (error) {
      try { logger && logger.error && logger.error('TradeStation stream proxy error:', error); } catch (_) { console.error('TradeStation stream proxy error:', error); }
      try { captureException(error, { scope: 'streamTradestation', path }); } catch (_) {}
      const status = error.status || 500;
      const message = error.message || 'Internal server error';
      return res.status(status).json({ error: message });
    }
  },
};


