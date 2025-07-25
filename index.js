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
const { tradeStationRoutes, tradeAlertsRoutes } = require('./routes');
const { authenticateToken } = require('./routes/auth');
const referralRoutes = require('./routes/referral');

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

// Ticker options routes
app.get('/ticker_options', routes.tradeStationRoutes.getTickerOptions);
app.get('/ticker_contracts/:ticker', routes.tradeStationRoutes.getTickerContracts);

app.get('/trade_alerts', authenticateToken, tradeAlertsRoutes.getTradeAlerts);
app.post('/trade_alerts', authenticateToken, tradeAlertsRoutes.createTradeAlert);
app.post('/std_dev_alerts', authenticateToken, tradeAlertsRoutes.createStdDevAlert);
app.post('/indicator_alerts', authenticateToken, tradeAlertsRoutes.createTechnicalIndicatorAlert);
app.put('/trade_alerts/:id', authenticateToken, tradeAlertsRoutes.updateTradeAlert);
app.delete('/trade_alerts/:id', authenticateToken, tradeAlertsRoutes.deleteTradeAlert);

app.get('/std_dev_levels/:ticker', authenticateToken, tradeAlertsRoutes.getStdDevLevels);
app.post('/std_dev_levels/:ticker/update_all', authenticateToken, tradeAlertsRoutes.updateAllTimeframesForTicker);
app.get('/alert_logs', authenticateToken, tradeAlertsRoutes.getAlertLogs);
app.post('/run_alert_checker', authenticateToken, tradeAlertsRoutes.runAlertChecker);
app.get('/debug/credentials', tradeAlertsRoutes.debugCredentials);

// Add all tradestation routes
app.get('/', tradeStationRoutes.handleOAuthCallback);
app.get('/tradestation/credentials', authenticateToken, tradeStationRoutes.getStoredCredentials);
app.put('/tradestation/refresh_token', authenticateToken, tradeStationRoutes.refreshAccessToken);

// Add referral routes
app.use('/referral', referralRoutes);

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