const fetch = require('node-fetch');
const { TTLCache } = require('../utils/ttlCache');
const { authenticateToken } = require('./auth');

// Allowed indicator functions for v1
const ALLOWED_FUNCTIONS = new Set(['SMA', 'EMA', 'VWAP', 'BBANDS']);

// Whitelisted params per function (lowercased keys as in Alpha Vantage)
const PARAM_WHITELIST = {
  SMA: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'apikey'],
  EMA: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'apikey'],
  VWAP: ['function', 'symbol', 'interval', 'apikey'],
  BBANDS: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'nbdevup', 'nbdevdn', 'ma_type', 'apikey'],
};

// Interval-based TTL mapping
const INTERVAL_TTL_MS = {
  '1min': 60_000,
  '5min': 5 * 60_000,
  '15min': 15 * 60_000,
  '30min': 30 * 60_000,
  '60min': 60 * 60_000,
  'daily': 24 * 60 * 60_000,
  'weekly': 7 * 24 * 60 * 60_000,
  'monthly': 30 * 24 * 60 * 60_000,
};

function getTtlMs(interval) {
  if (!interval) return INTERVAL_TTL_MS['daily'];
  const i = String(interval).toLowerCase();
  if (INTERVAL_TTL_MS[i] != null) return INTERVAL_TTL_MS[i];
  // map common variants
  if (i === '1hour') return INTERVAL_TTL_MS['60min'];
  return INTERVAL_TTL_MS['daily'];
}

// Shared cache across users
const indicatorCache = new TTLCache('alphaVantageIndicators');

// Build normalized signature of query
function buildSignature(qs) {
  const entries = Object.entries(qs)
    .filter(([k]) => k != null)
    .map(([k, v]) => [String(k).toLowerCase(), v])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return entries.map(([k, v]) => `${k}=${String(v)}`).join('&');
}

// Express handler: GET /api/indicators (pass-through)
async function getIndicator(req, res) {
  try {
    const fnRaw = req.query.function;
    const fn = typeof fnRaw === 'string' ? fnRaw.toUpperCase() : '';
    if (!ALLOWED_FUNCTIONS.has(fn)) {
      return res.status(400).json({ error: 'Unsupported function' });
    }

    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Alpha Vantage API key not configured' });
    }

    // Build whitelisted query
    const allowedParams = new Set(PARAM_WHITELIST[fn] || []);
    const outgoing = {};
    for (const [k, v] of Object.entries(req.query || {})) {
      const key = String(k).toLowerCase();
      if (allowedParams.has(key)) {
        outgoing[key] = v;
      }
    }
    // Ensure required keys are present and set apikey
    outgoing['function'] = fn;
    outgoing['apikey'] = apiKey;

    const ttlMs = getTtlMs(outgoing.interval || 'daily');
    const signature = buildSignature(outgoing);

    // Try cache first
    const cached = indicatorCache.get(signature);
    if (cached && !cached.isStale) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached.data);
    }

    // Serve stale if present while refreshing in background
    if (cached && cached.isStale) {
      res.setHeader('X-Cache', 'STALE');
      try {
        indicatorCache.refresh(signature, async () => {
          const params = new URLSearchParams(outgoing);
          const url = `https://www.alphavantage.co/query?${params.toString()}`;
          const r = await fetch(url);
          if (!r.ok) throw new Error(`Alpha Vantage error ${r.status}`);
          const json = await r.json();
          indicatorCache.set(signature, json, ttlMs, { interval: outgoing.interval || 'daily', function: fn });
          return json;
        }).catch(() => {});
      } catch (_) {}
      return res.json(cached.data);
    }

    // No cache or first time -> fetch and cache
    const params = new URLSearchParams(outgoing);
    const url = `https://www.alphavantage.co/query?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Alpha Vantage request failed' });
    }
    const data = await response.json();
    indicatorCache.set(signature, data, ttlMs, { interval: outgoing.interval || 'daily', function: fn });
    res.setHeader('X-Cache', 'MISS');
    return res.json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error', details: error && error.message });
  }
}

// Superuser-only cache info endpoint: GET /admin/cache
async function getCacheInfo(req, res) {
  try {
    const userId = req.user && req.user.id;
    // Verify superuser from DB
    const pool = require('../db');
    const result = await pool.query('SELECT superuser FROM users WHERE id = $1', [userId]);
    if (!result.rows.length || !result.rows[0].superuser) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Helper to summarize duplicate upstreams per user for a stream manager
    const summarizeManager = (mgr, name) => {
      const map = mgr && mgr.keyToConnection;
      const summary = { name, activeUpstreams: undefined, usersWithMultiple: 0, duplicates: [] };
      if (!map || typeof map.size !== 'number') return summary;
      summary.activeUpstreams = map.size;
      const counts = new Map();
      try {
        for (const [key] of map.entries()) {
          const userId = String(key).split('|')[0];
          counts.set(userId, (counts.get(userId) || 0) + 1);
        }
      } catch (_) {}
      for (const [userId, count] of counts.entries()) {
        if (count > 1) {
          summary.usersWithMultiple += 1;
          summary.duplicates.push({ userId, count });
        }
      }
      return summary;
    };

    const streamCaches = [];
    try { const quotes = require('../utils/quoteStreamManager'); streamCaches.push(summarizeManager(quotes, 'Quotes')); } catch (_) {}
    try { const positions = require('../utils/positionsStreamManager'); streamCaches.push(summarizeManager(positions, 'Positions')); } catch (_) {}
    try { const orders = require('../utils/ordersStreamManager'); streamCaches.push(summarizeManager(orders, 'Orders')); } catch (_) {}
    try { const bars = require('../utils/barsStreamManager'); streamCaches.push(summarizeManager(bars, 'Bars')); } catch (_) {}
    try { const aggs = require('../utils/marketAggregatesStreamManager'); streamCaches.push(summarizeManager(aggs, 'MarketAggregates')); } catch (_) {}

    return res.json({
      indicators: indicatorCache.info(),
      streams: streamCaches
    });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error', details: error && error.message });
  }
}

module.exports = {
  authenticateToken,
  getIndicator,
  getCacheInfo,
  indicatorCache,
};


