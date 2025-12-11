require('./instrument.js');
const express = require('express');
const path = require("path");
const dotenv = require('dotenv');
const cors = require('cors');
const routes = require('./routes');
const { captureException } = require('./utils/errorReporting');
const Sentry = require('@sentry/node');
const Pusher = require("pusher");
const backgroundStreamManager = require('./utils/backgroundStreamManager');
const alertEngine = require('./workers/alertEngine');
const positionLossEngine = require('./workers/positionLossEngine');
const logger = require('./config/logging');
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
// Set up Handlebars as the view engine
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// Health, status, and debug routes
app.get('/health', asyncHandler(routes.debugRoutes.health));
app.get('/status', asyncHandler(routes.debugRoutes.status));
app.get('/debug', asyncHandler(routes.debugRoutes.debug));
app.get('/debug/memory', asyncHandler(routes.debugRoutes.memory));
app.post('/debug/cleanup', asyncHandler(routes.debugRoutes.cleanup));
app.post('/debug/gc', asyncHandler(routes.debugRoutes.forceGc));

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

const server = app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server started on port ${PORT}`);
  
  // Periodic idle socket cleanup (every 5 minutes)
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
  }, 300000);
  
  // Auto-start background streams if enabled
  if (process.env.ENABLE_BACKGROUND_STREAMS === 'true') {
    console.log('[BackgroundStreams] Starting...');
    try {
      await alertEngine.start();
      console.log('[AlertEngine] Started');
      
      await positionLossEngine.start();
      console.log('[PositionLossEngine] Started');
      
      await backgroundStreamManager.initializeFromDatabase();
      console.log('[BackgroundStreams] Initialized');
    } catch (err) {
      console.error('[BackgroundStreams] Failed to initialize:', err.message);
    }
  }
});

// Export app for Vercel serverless functions
module.exports = app; 