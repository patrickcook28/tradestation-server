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
const logger = require('./config/logging');
const fs = require('fs');
const hbs = require('hbs');
const { authenticateToken } = require('./routes/auth');

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
  appId: "1800665",
  key: "ba14eb35edcc14c65a59",
  secret: "5db5eb33846b125fb196",
  cluster: "us3",
  useTLS: true
});

const app = express();

// Configure CORS properly for frontend on port 3002
// app.use(cors({
//   origin: ['http://localhost:3002', 'http://localhost:3000'],
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization'],
//   credentials: true
// }));

app.use(cors());
// Sentry request handler (v8 no-op here; using setupExpressErrorHandler below)

const publicDir = path.join(__dirname, './public');

app.use(express.static(publicDir));
app.use(express.urlencoded({extended: 'false'}));
app.use(express.json());

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

// Watchlists routes (all require auth within router)
app.use('/', routes.watchlistsRouter);

// Trade journals routes (all require auth within router)
app.use('/', routes.tradeJournalsRouter);

// Indicators proxy route (pass-through Alpha Vantage) and admin cache info
app.get('/api/indicators', authenticateToken, asyncHandler(routes.indicatorsRoutes.getIndicator));
app.get('/admin/cache', authenticateToken, asyncHandler(routes.indicatorsRoutes.getCacheInfo));

// Sentry error handler (v8 registers its own middleware)
Sentry.setupExpressErrorHandler(app);

// Central error handler (final)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  try { captureException(err, { path: req.originalUrl, method: req.method }); } catch (_) {}
  const status = err.status || 500;
  const payload = err.response || { error: err.message || 'Internal server error' };
  if (!res.headersSent) {
    res.status(status).json(payload);
  } else {
    try { res.end(); } catch (_) {}
  }
});

// Start the real-time alert checker
const realtimeAlertChecker = new RealtimeAlertChecker();
realtimeAlertChecker.start().catch(error => {
  console.error('Failed to start realtime alert checker:', error);
});

app.locals.realtimeAlertChecker = realtimeAlertChecker;

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});

module.exports = app; 