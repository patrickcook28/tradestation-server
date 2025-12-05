require('./instrument.js');
const express = require('express');
const pool = require('./db');
const path = require("path");
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require('cors');
const routes = require('./routes');
const { captureException, captureMessage } = require('./utils/errorReporting');
const Sentry = require('@sentry/node');
const Pusher = require("pusher");
const RealtimeAlertChecker = require('./workers/realtimeAlertChecker');
const backgroundStreamManager = require('./utils/backgroundStreamManager');
const alertEngine = require('./workers/alertEngine');
const logger = require('./config/logging');
const fs = require('fs');
const hbs = require('hbs');
const { authenticateToken } = require('./routes/auth');
const { setupStripeWebhook } = require('./utils/stripeWebhookHandler');

dotenv.config({ path: './.env'});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection at:', promise, 'reason:', reason);
  // Log the error but don't crash the server
  if (logger && logger.error) {
    logger.error('Unhandled Promise Rejection:', { reason, promise: promise.toString() });
  }
  try { captureException(reason, { type: 'unhandledRejection' }); } catch (_) {}
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  if (logger && logger.error) {
    logger.error('Uncaught Exception:', error);
  }
  // For uncaught exceptions, we should exit gracefully
  try { captureException(error, { type: 'uncaughtException' }); } catch (_) {}
  process.exit(1);
});

const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

if (!process.env.PUSHER_APP_ID || !process.env.PUSHER_KEY || !process.env.PUSHER_SECRET || !process.env.PUSHER_CLUSTER) {
  console.warn('[Server] Missing Pusher environment variables (PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER)');
}

const app = express();

// CORS configuration - allow all origins
app.use(cors({
  origin: true, // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400 // Cache preflight requests for 24 hours
}));

setupStripeWebhook(app);

const publicDir = path.join(__dirname, './public');

app.use(express.static(publicDir));
app.use(express.urlencoded({extended: 'false'}));
app.use(express.json());

// Request monitoring middleware (tracks pending requests and identifies bottlenecks)
const { trackRequestStart, statusEndpoint, startPeriodicMonitoring } = require('./utils/requestMonitor');
app.use(trackRequestStart);

// Central async error wrapper helper
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Toggleable HTTP request logger
if (logger.isHttpLoggingEnabled && logger.isHttpLoggingEnabled()) {
  app.use((req, res, next) => {
    try {
      const startedAt = Date.now();
      const method = req.method;
      const url = req.originalUrl || req.url;
      const query = Object.keys(req.query || {}).length ? ` query=${JSON.stringify(req.query)}` : '';
      // Avoid logging sensitive fields explicitly by redacting common keys
      const redactKeys = ['password', 'password_confirm', 'client_secret', 'token', 'access_token', 'refresh_token'];
      let body = req.body;
      if (body && typeof body === 'object') {
        body = JSON.parse(JSON.stringify(body));
        for (const key of redactKeys) {
          if (body[key] !== undefined) body[key] = '[REDACTED]';
        }
      }
      const bodyStr = body && Object.keys(body).length ? ` body=${JSON.stringify(body)}` : '';

      // Log on request start
      console.log(`[API] ${method} ${url}${query}${bodyStr}`);

      // Also log completion with status and duration
      res.on('finish', () => {
        const ms = Date.now() - startedAt;
        console.log(`[API] ${method} ${url} -> ${res.statusCode} ${ms}ms`);
      });
    } catch (e) {
      try { console.log('[API] request logging error:', e.message); } catch (_) {}
    }
    next();
  });
}

// Specific diagnostic log for positions stream route before auth middleware
app.use((req, res, next) => {
  try {
    const path = req.path || req.originalUrl || '';
    if (typeof path === 'string' && path.startsWith('/tradestation/stream/accounts/') && path.endsWith('/positions')) {
      console.log(`[Index] Pre-auth positions route hit: ${req.method} ${req.originalUrl}`);
    }
  } catch (_) {}
  next();
});

// Set up Handlebars as the view engine
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// Simple health check for Railway/container orchestration (responds immediately)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

app.get('/status', asyncHandler(async (req, res) => {
  let dbStatus = 'Unknown';
  let users = [];
  try {
    // Check DB connection
    await pool.query('SELECT 1');
    dbStatus = 'Connected';
    // Get users (id and email only)
    const result = await pool.query('SELECT id, email FROM users ORDER BY id');
    users = result.rows;
  } catch (err) {
    dbStatus = 'Error: ' + err.message;
  }
  res.render('status', { dbStatus, users });
}));

// Debug endpoint for monitoring server responsiveness
app.get('/debug/server-status', asyncHandler(statusEndpoint));

// Debug endpoint for stream diagnostics
app.get('/debug/streams', asyncHandler(async (req, res) => {
  try {
    const barsManager = require('./utils/barsStreamManager');
    const quotesManager = require('./utils/quoteStreamManager');
    const ordersManager = require('./utils/ordersStreamManager');
    const positionsManager = require('./utils/positionsStreamManager');
    
    const diagnostics = {
      timestamp: new Date().toISOString(),
      bars: barsManager.getDebugInfo ? barsManager.getDebugInfo() : [],
      quotes: quotesManager.getDebugInfo ? quotesManager.getDebugInfo() : [],
      orders: ordersManager.getDebugInfo ? ordersManager.getDebugInfo() : [],
      positions: positionsManager.getDebugInfo ? positionsManager.getDebugInfo() : []
    };
    
    res.json(diagnostics);
  } catch (error) {
    console.error('Error getting stream diagnostics:', error);
    res.status(500).json({ error: 'Failed to get stream diagnostics', message: error.message });
  }
}));

// Debug endpoint to cleanup stale connections
app.post('/debug/streams/cleanup', asyncHandler(async (req, res) => {
  try {
    const barsManager = require('./utils/barsStreamManager');
    const quotesManager = require('./utils/quoteStreamManager');
    const ordersManager = require('./utils/ordersStreamManager');
    const positionsManager = require('./utils/positionsStreamManager');
    const { destroyIdleSockets } = require('./utils/httpAgent');
    
    console.log('[Debug] Starting manual stream cleanup...');
    
    const results = {
      bars: barsManager.cleanupStaleConnections ? barsManager.cleanupStaleConnections() : 0,
      quotes: quotesManager.cleanupStaleConnections ? quotesManager.cleanupStaleConnections() : 0,
      orders: ordersManager.cleanupStaleConnections ? ordersManager.cleanupStaleConnections() : 0,
      positions: positionsManager.cleanupStaleConnections ? positionsManager.cleanupStaleConnections() : 0
    };
    
    // Also destroy idle sockets to free up resources
    const socketsDestroyed = destroyIdleSockets();
    results.idleSocketsDestroyed = socketsDestroyed;
    
    const total = results.bars + results.quotes + results.orders + results.positions;
    
    console.log(`[Debug] Cleanup complete: ${total} stale connections, ${socketsDestroyed} idle sockets`);
    
    res.json({
      message: `Cleaned up ${total} stale connection(s) and ${socketsDestroyed} idle socket(s)`,
      details: results
    });
  } catch (error) {
    console.error('Error cleaning up stale connections:', error);
    res.status(500).json({ error: 'Failed to cleanup stale connections', message: error.message });
  }
}));

// ===============================
// Background Stream Manager Status (for Admin UI)
// ===============================

app.get('/debug/background-streams', asyncHandler(async (req, res) => {
  try {
    const status = backgroundStreamManager.getStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting background stream status:', error);
    res.status(500).json({ error: 'Failed to get status', message: error.message });
  }
}));

// Alert engine stats endpoint
app.get('/debug/alert-engine', asyncHandler(async (req, res) => {
  try {
    const stats = alertEngine.getStats();
    res.json(stats);
  } catch (error) {
    console.error('Error getting alert engine stats:', error);
    res.status(500).json({ error: 'Failed to get stats', message: error.message });
  }
}));

// Auth routes
app.post("/auth/register", asyncHandler(routes.authRoutes.register));
app.post("/auth/login", asyncHandler(routes.authRoutes.login));
app.get("/auth/settings", authenticateToken, asyncHandler(routes.authRoutes.getUserSettings));
app.put("/auth/settings", authenticateToken, asyncHandler(routes.authRoutes.updateUserSettings));
app.post("/auth/apply_referral_code", authenticateToken, asyncHandler(routes.authRoutes.applyReferralCode));
app.get("/auth/cost_basis", authenticateToken, asyncHandler(routes.authRoutes.getCostBasisData));
app.put("/auth/cost_basis", authenticateToken, asyncHandler(routes.authRoutes.updateCostBasisData));
app.get("/auth/maintenance", asyncHandler(routes.authRoutes.getMaintenanceMode));
app.put("/auth/maintenance", authenticateToken, asyncHandler(routes.authRoutes.updateMaintenanceMode));
// Password reset routes (underscore style)
app.post('/auth/request_password_reset', routes.authRoutes.requestPasswordReset);
app.post('/auth/reset_password', routes.authRoutes.resetPassword);

// Ticker options routes
app.get('/ticker_options', asyncHandler(routes.tradeStationRoutes.getTickerOptions));
app.get('/ticker_contracts/:ticker', asyncHandler(routes.tradeStationRoutes.getTickerContracts));

app.get('/trade_alerts', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.getTradeAlerts));
app.post('/trade_alerts', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.createTradeAlert));
app.post('/std_dev_alerts', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.createStdDevAlert));
app.post('/indicator_alerts', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.createTechnicalIndicatorAlert));
app.put('/trade_alerts/:id', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.updateTradeAlert));
app.delete('/trade_alerts/:id', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.deleteTradeAlert));

app.get('/std_dev_levels/:ticker', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.getStdDevLevels));
app.post('/std_dev_levels/:ticker/update_all', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.updateAllTimeframesForTicker));
app.get('/alert_logs', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.getAlertLogs));
app.post('/run_alert_checker', authenticateToken, asyncHandler(routes.tradeAlertsRoutes.runAlertChecker));
app.get('/debug/credentials', asyncHandler(routes.tradeAlertsRoutes.debugCredentials));

// Client config routes
app.get('/client_config', authenticateToken, asyncHandler(routes.clientConfigRoutes.getInitialConfig));

// Add all tradestation routes
app.get('/', asyncHandler(routes.tradeStationRoutes.handleOAuthCallback));
app.get('/tradestation/credentials', authenticateToken, asyncHandler(routes.tradeStationRoutes.getStoredCredentials));
app.put('/tradestation/refresh_token', authenticateToken, asyncHandler(routes.tradeStationRoutes.refreshAccessToken));
app.get('/tradestation/accounts', authenticateToken, asyncHandler(routes.tradeStationRoutes.getAccounts));
app.get('/tradestation/accounts/:accountId/balances', authenticateToken, asyncHandler(routes.tradeStationRoutes.getBalances));
app.get('/tradestation/accounts/:accountId/positions', authenticateToken, asyncHandler(routes.tradeStationRoutes.getPositions));
app.get('/tradestation/accounts/:accountId/orders', authenticateToken, asyncHandler(routes.tradeStationRoutes.getOrders));
app.get('/tradestation/accounts/:accountId/historicalorders', authenticateToken, asyncHandler(routes.tradeStationRoutes.getHistoricalOrders));
app.get('/tradestation/marketdata/symbols/:ticker', authenticateToken, asyncHandler(routes.tradeStationRoutes.getTickerDetails));
app.get('/tradestation/marketdata/barcharts/:ticker', authenticateToken, asyncHandler(routes.tradeStationRoutes.getBarCharts));
app.post('/tradestation/orders', authenticateToken, asyncHandler(routes.tradeStationRoutes.createOrder));
app.get('/tradestation/orders/:orderId', authenticateToken, asyncHandler(routes.tradeStationRoutes.getOrder));
app.put('/tradestation/orders/:orderId', authenticateToken, asyncHandler(routes.tradeStationRoutes.updateOrder));
app.delete('/tradestation/orders/:orderId', authenticateToken, asyncHandler(routes.tradeStationRoutes.cancelOrder));
app.post('/tradestation/ordergroups', authenticateToken, asyncHandler(routes.tradeStationRoutes.createOrderGroup));
// Streaming market data - quotes
app.get('/tradestation/stream/quotes', authenticateToken, asyncHandler(routes.tradeStationRoutes.streamQuotes));
// Streaming brokerage data - positions and orders
app.get('/tradestation/stream/accounts/:accountId/positions', authenticateToken, asyncHandler(routes.tradeStationRoutes.streamPositions));
app.get('/tradestation/stream/accounts/:accountId/orders', authenticateToken, asyncHandler(routes.tradeStationRoutes.streamOrders));
app.get('/tradestation/marketdata/stream/barcharts/:ticker', authenticateToken, asyncHandler(routes.tradeStationRoutes.streamBars));
// Streaming market data - market depth aggregates
app.get('/tradestation/marketdata/stream/marketdepth/aggregates/:ticker', authenticateToken, asyncHandler(routes.tradeStationRoutes.streamMarketAggregates));

// Add referral routes
app.use('/referral', routes.referralRoutes);

// Contact routes
app.use('/contact', authenticateToken, routes.contactRoutes);

// Bug reports routes
app.use('/bug-reports', authenticateToken, routes.bugReportsRoutes);

// Watchlists routes (all require auth within router)
app.use('/', routes.watchlistsRouter);

// Trade journals routes (all require auth within router)
app.use('/', routes.tradeJournalsRouter);

// Analytics routes
const analyticsRoutes = require('./routes/analytics');
app.use('/analytics', analyticsRoutes);

// Loss limits routes (loss limit locks and alerts)
const lossLimitsRoutes = require('./routes/lossLimits');
app.use('/loss_limits', lossLimitsRoutes);

// Indicators proxy route (pass-through Alpha Vantage) and admin cache info
app.get('/api/indicators', authenticateToken, asyncHandler(routes.indicatorsRoutes.getIndicator));
app.get('/admin/cache', authenticateToken, asyncHandler(routes.indicatorsRoutes.getCacheInfo));

// Billing routes (Stripe integration)
const billingRoutes = require('./routes/billing');
// Initialize Stripe with secret key
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
billingRoutes.initializeStripe(stripe);
app.use('/billing', billingRoutes);

// Sentry error handler (v8 registers its own middleware)
Sentry.setupExpressErrorHandler(app);

// Central error handler (final)
app.use((err, req, res, _next) => {
  try { captureException(err, { path: req.originalUrl, method: req.method }); } catch (_) {}
  const status = err.status || 500;
  const payload = err.response || { error: err.message || 'Internal server error' };
  if (!res.headersSent) {
    res.status(status).json(payload);
  } else {
    try { res.end(); } catch (_) {}
  }
});

// Start the real-time alert checker - DISABLED
// const realtimeAlertChecker = new RealtimeAlertChecker();
// realtimeAlertChecker.start().catch(error => {
//   console.error('Failed to start realtime alert checker:', error);
// });

// app.locals.realtimeAlertChecker = realtimeAlertChecker;

const PORT = process.env.PORT || 3001;
console.log(`[Startup] PORT env var: ${process.env.PORT}, using port: ${PORT}`);

// SIMPLIFIED FOR RAILWAY - using app.listen() instead of custom http.createServer
// The custom server config was for advanced streaming, can re-enable after Railway works
const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server started on port ${PORT} (0.0.0.0)`);
  
  // Test database connection on startup
  console.log('[Startup] Testing database connection...');
  console.log('[Startup] DATABASE_URL exists:', !!process.env.DATABASE_URL);
  try {
    const dbResult = await pool.query('SELECT NOW() as time, current_database() as db');
    console.log('[Startup] ✅ Database connected! DB:', dbResult.rows[0].db);
  } catch (dbErr) {
    console.error('[Startup] ❌ Database connection failed:', dbErr.message);
  }
  console.log(`- Debug endpoint: http://localhost:${PORT}/debug/server-status`);
  console.log(`- Background streams: http://localhost:${PORT}/debug/background-streams`);
  
  // Periodic monitoring disabled - use debug endpoint instead
  // startPeriodicMonitoring(60000);
  
  // Periodic idle socket cleanup to prevent accumulation (every 5 minutes)
  const { destroyIdleSockets } = require('./utils/httpAgent');
  setInterval(() => {
    try {
      const destroyed = destroyIdleSockets();
      if (destroyed > 0) {
        console.log(`[Maintenance] Cleaned up ${destroyed} idle socket(s)`);
      }
    } catch (err) {
      console.error('[Maintenance] Error during idle socket cleanup:', err);
    }
  }, 300000); // Every 5 minutes
  
  // Auto-start background streams if enabled via environment variable
  // Set ENABLE_BACKGROUND_STREAMS=true to enable
  // IMPORTANT: Defer initialization to allow health checks to pass first
  if (process.env.ENABLE_BACKGROUND_STREAMS === 'true') {
    console.log('[BackgroundStreams] Will start in 5 seconds (allowing health checks to pass)...');
    setTimeout(async () => {
      console.log('[BackgroundStreams] Auto-starting background stream manager...');
      try {
        // Start alert engine first (it subscribes to stream data events)
        await alertEngine.start();
        console.log('[AlertEngine] Successfully started');
        
        // Then start background streams (they emit data events)
        await backgroundStreamManager.initializeFromDatabase();
        console.log('[BackgroundStreams] Successfully initialized');
      } catch (err) {
        console.error('[BackgroundStreams] Failed to initialize:', err.message);
        // Don't crash the server, just log the error
      }
    }, 5000); // Wait 5 seconds for health checks to pass
  } else {
    console.log('[BackgroundStreams] Disabled. Set ENABLE_BACKGROUND_STREAMS=true to enable.');
  }
});

// Export app for Vercel serverless functions
module.exports = app; 