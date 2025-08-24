const express = require('express');
const pool = require('./db');
const path = require("path");
const fetch = require('node-fetch');
const dotenv = require('dotenv');
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const cors = require('cors');
const routes = require('./routes');
const Pusher = require("pusher");
const RealtimeAlertChecker = require('./workers/realtimeAlertChecker');
const logger = require('./config/logging');
const fs = require('fs');
const hbs = require('hbs');
const { authenticateToken } = require('./routes/auth');

dotenv.config({ path: './.env'});

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

const publicDir = path.join(__dirname, './public');

app.use(express.static(publicDir));
app.use(express.urlencoded({extended: 'false'}));
app.use(express.json());

// Simple request logger: method, url, query, and body
app.use((req, res, next) => {
  try {
    const method = req.method;
    const url = req.originalUrl || req.url;
    const query = Object.keys(req.query || {}).length ? ` query=${JSON.stringify(req.query)}` : '';
    // Avoid logging sensitive fields explicitly by redacting common keys
    const redactKeys = ['password', 'password_confirm', 'client_secret'];
    let body = req.body;
    if (body && typeof body === 'object') {
      body = JSON.parse(JSON.stringify(body));
      for (const key of redactKeys) {
        if (body[key] !== undefined) body[key] = '[REDACTED]';
      }
    }
    const bodyStr = body && Object.keys(body).length ? ` body=${JSON.stringify(body)}` : '';
    console.log(`[API] ${method} ${url}${query}${bodyStr}`);
  } catch (e) {
    try { console.log('[API] request logging error:', e.message); } catch (_) {}
  }
  next();
});

// Set up Handlebars as the view engine
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

app.get('/status', async (req, res) => {
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
});

// Auth routes
app.post("/auth/register", routes.authRoutes.register);
app.post("/auth/login", routes.authRoutes.login);
app.get("/auth/settings", authenticateToken, routes.authRoutes.getUserSettings);
app.put("/auth/settings", authenticateToken, routes.authRoutes.updateUserSettings);
app.post("/auth/apply_referral_code", authenticateToken, routes.authRoutes.applyReferralCode);
app.get("/auth/cost_basis", authenticateToken, routes.authRoutes.getCostBasisData);
app.put("/auth/cost_basis", authenticateToken, routes.authRoutes.updateCostBasisData);
app.get("/auth/maintenance", routes.authRoutes.getMaintenanceMode);
app.put("/auth/maintenance", authenticateToken, routes.authRoutes.updateMaintenanceMode);

// Ticker options routes
app.get('/ticker_options', routes.tradeStationRoutes.getTickerOptions);
app.get('/ticker_contracts/:ticker', routes.tradeStationRoutes.getTickerContracts);

app.get('/trade_alerts', authenticateToken, routes.tradeAlertsRoutes.getTradeAlerts);
app.post('/trade_alerts', authenticateToken, routes.tradeAlertsRoutes.createTradeAlert);
app.post('/std_dev_alerts', authenticateToken, routes.tradeAlertsRoutes.createStdDevAlert);
app.post('/indicator_alerts', authenticateToken, routes.tradeAlertsRoutes.createTechnicalIndicatorAlert);
app.put('/trade_alerts/:id', authenticateToken, routes.tradeAlertsRoutes.updateTradeAlert);
app.delete('/trade_alerts/:id', authenticateToken, routes.tradeAlertsRoutes.deleteTradeAlert);

app.get('/std_dev_levels/:ticker', authenticateToken, routes.tradeAlertsRoutes.getStdDevLevels);
app.post('/std_dev_levels/:ticker/update_all', authenticateToken, routes.tradeAlertsRoutes.updateAllTimeframesForTicker);
app.get('/alert_logs', authenticateToken, routes.tradeAlertsRoutes.getAlertLogs);
app.post('/run_alert_checker', authenticateToken, routes.tradeAlertsRoutes.runAlertChecker);
app.get('/debug/credentials', routes.tradeAlertsRoutes.debugCredentials);

// Client config routes
app.get('/client_config', authenticateToken, routes.clientConfigRoutes.getInitialConfig);

// Add all tradestation routes
app.get('/', routes.tradeStationRoutes.handleOAuthCallback);
app.get('/tradestation/credentials', authenticateToken, routes.tradeStationRoutes.getStoredCredentials);
app.put('/tradestation/refresh_token', authenticateToken, routes.tradeStationRoutes.refreshAccessToken);
app.get('/tradestation/accounts', authenticateToken, routes.tradeStationRoutes.getAccounts);
app.get('/tradestation/accounts/:accountId/balances', authenticateToken, routes.tradeStationRoutes.getBalances);
app.get('/tradestation/accounts/:accountId/positions', authenticateToken, routes.tradeStationRoutes.getPositions);
app.get('/tradestation/accounts/:accountId/orders', authenticateToken, routes.tradeStationRoutes.getOrders);
app.get('/tradestation/accounts/:accountId/historicalorders', authenticateToken, routes.tradeStationRoutes.getHistoricalOrders);
app.get('/tradestation/marketdata/symbols/:ticker', authenticateToken, routes.tradeStationRoutes.getTickerDetails);
app.get('/tradestation/marketdata/barcharts/:ticker', authenticateToken, routes.tradeStationRoutes.getBarCharts);
app.post('/tradestation/orders', authenticateToken, routes.tradeStationRoutes.createOrder);
app.get('/tradestation/orders/:orderId', authenticateToken, routes.tradeStationRoutes.getOrder);
app.put('/tradestation/orders/:orderId', authenticateToken, routes.tradeStationRoutes.updateOrder);
app.delete('/tradestation/orders/:orderId', authenticateToken, routes.tradeStationRoutes.cancelOrder);
app.post('/tradestation/ordergroups', authenticateToken, routes.tradeStationRoutes.createOrderGroup);
// Streaming market data - quotes
app.get('/tradestation/stream/quotes', authenticateToken, routes.tradeStationRoutes.streamQuotes);
// Streaming brokerage data - positions and orders
app.get('/tradestation/stream/accounts/:accountId/positions', authenticateToken, routes.tradeStationRoutes.streamPositions);
app.get('/tradestation/stream/accounts/:accountId/orders', authenticateToken, routes.tradeStationRoutes.streamOrders);
app.get('/tradestation/marketdata/stream/barcharts/:ticker', authenticateToken, routes.tradeStationRoutes.streamBars);

// Add referral routes
app.use('/referral', routes.referralRoutes);

// Watchlists routes (all require auth within router)
app.use('/', routes.watchlistsRouter);

// Trade journals routes (all require auth within router)
app.use('/', routes.tradeJournalsRouter);

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