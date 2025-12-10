// Native fetch is available in Node.js 18+
const { TTLCache } = require('../utils/ttlCache');
const { authenticateToken } = require('./auth');

// Allowed indicator functions for v1
const ALLOWED_FUNCTIONS = new Set(['SMA', 'EMA', 'VWAP', 'BBANDS', 'RSI', 'WMA', 'DEMA', 'TEMA', 'SAR', 'MACD', 'STOCH', 'CCI', 'ADX']);

// Whitelisted params per function (lowercased keys as in Alpha Vantage)
const PARAM_WHITELIST = {
  SMA: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'apikey'],
  EMA: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'apikey'],
  WMA: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'apikey'],
  DEMA: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'apikey'],
  TEMA: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'apikey'],
  VWAP: ['function', 'symbol', 'interval', 'apikey'],
  BBANDS: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'nbdevup', 'nbdevdn', 'ma_type', 'apikey'],
  SAR: ['function', 'symbol', 'interval', 'acceleration', 'maximum', 'apikey'],
  RSI: ['function', 'symbol', 'interval', 'series_type', 'time_period', 'apikey'],
  MACD: ['function', 'symbol', 'interval', 'series_type', 'fastperiod', 'slowperiod', 'signalperiod', 'apikey'],
  STOCH: ['function', 'symbol', 'interval', 'fastkperiod', 'slowkperiod', 'slowdperiod', 'slowkmatype', 'slowdmatype', 'apikey'],
  CCI: ['function', 'symbol', 'interval', 'time_period', 'apikey'],
  ADX: ['function', 'symbol', 'interval', 'time_period', 'apikey'],
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

function normalizeIntervalForAV(val) {
  if (!val) return val;
  try {
    const s = String(val).toLowerCase();
    if (s === '1hour' || s === '60' || s === '60m' || s === '60min') return '60min';
    if (s.endsWith('min')) return s;
    if (s === '1min' || s === '5min' || s === '15min' || s === '30min') return s;
    if (s === 'daily' || s === 'weekly' || s === 'monthly') return s;
    // TradeStation-style values
    if (s === 'minute') return '5min';
    if (s === 'daily' || s === 'weekly' || s === 'monthly') return s;
    // numeric minutes
    const n = Number(s);
    if (Number.isFinite(n)) {
      const allowed = [1, 5, 15, 30, 60];
      let pick = allowed[0];
      let best = Infinity;
      for (const a of allowed) {
        const d = Math.abs(a - n);
        if (d < best) { best = d; pick = a; }
      }
      return `${pick}min`;
    }
  } catch (_) {}
  return val;
}

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
    // Normalize interval if present or derive from TradeStation-style hints
    if (outgoing.interval) {
      outgoing.interval = normalizeIntervalForAV(outgoing.interval);
    } else if (req.query && (req.query.unit || req.query.ts_unit || req.query.chart_unit)) {
      const unit = String(req.query.unit || req.query.ts_unit || req.query.chart_unit).toLowerCase();
      const n = Number(req.query.interval || req.query.ts_interval || req.query.barsize || req.query.chart_interval);
      if (unit === 'minute') {
        outgoing.interval = normalizeIntervalForAV(Number.isFinite(n) ? `${n}` : '5');
      } else if (unit === 'daily' || unit === 'weekly' || unit === 'monthly') {
        outgoing.interval = unit;
      }
    }

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

    // Helper to summarize stream connections and detect true duplicates
    const summarizeManager = (mgr, name) => {
      const map = mgr && mgr.keyToConnection;
      const summary = { 
        name, 
        activeUpstreams: undefined, 
        uniqueKeys: 0,
        usersWithTrueDuplicates: 0, 
        trueDuplicates: [],
        userStreams: []
      };
      if (!map || typeof map.size !== 'number') return summary;
      summary.activeUpstreams = map.size;
      
      // Track all keys and detect true duplicates
      const keyOccurrences = new Map(); // key -> count
      const userToKeys = new Map(); // userId -> Set of keys
      
      try {
        for (const [key] of map.entries()) {
          const keyStr = String(key);
          const userId = keyStr.split('|')[0];
          
          // Count key occurrences for duplicate detection
          keyOccurrences.set(keyStr, (keyOccurrences.get(keyStr) || 0) + 1);
          
          // Track keys per user
          if (!userToKeys.has(userId)) {
            userToKeys.set(userId, new Set());
          }
          userToKeys.get(userId).add(keyStr);
        }
        
        // Count unique keys
        summary.uniqueKeys = keyOccurrences.size;
        
        // Find true duplicates (same exact key multiple times)
        const duplicateKeys = [];
        for (const [key, count] of keyOccurrences.entries()) {
          if (count > 1) {
            duplicateKeys.push({ key, count });
          }
        }
        
        // Process per-user information
        for (const [userId, keys] of userToKeys.entries()) {
          const keyArray = Array.from(keys);
          const hasDuplicate = keyArray.some(key => keyOccurrences.get(key) > 1);
          
          if (hasDuplicate) {
            summary.usersWithTrueDuplicates += 1;
          }
          
          // Add to userStreams list (show users with multiple different streams)
          if (keyArray.length > 1) {
            summary.userStreams.push({
              userId,
              streamCount: keyArray.length,
              keys: keyArray.map(k => k.split('|').slice(1).join('|')) // Remove userId prefix
            });
          }
        }
        
        // Add true duplicate information
        summary.trueDuplicates = duplicateKeys.map(d => ({
          key: d.key.split('|').slice(1).join('|'), // Remove userId prefix
          userId: d.key.split('|')[0],
          count: d.count
        }));
        
      } catch (_) {}
      
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


