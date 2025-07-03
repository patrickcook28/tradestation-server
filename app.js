const express = require('express');
const pool = require('./db');
const path = require("path")
const fetch = require('node-fetch');
const dotenv = require('dotenv')
const jwt = require("jsonwebtoken")
const bcrypt = require("bcryptjs")
const cors = require('cors');
const routes = require('./routes');
const Pusher = require("pusher");
const RealtimeAlertChecker = require('./workers/realtimeAlertChecker');
const logger = require('./config/logging');

dotenv.config({ path: './.env'})

const pusher = new Pusher({
  appId: "1800665",
  key: "ba14eb35edcc14c65a59",
  secret: "5db5eb33846b125fb196",
  cluster: "us3",
  useTLS: true
});

const app = express();

// Configure CORS properly for frontend on port 3002
app.use(cors({
  origin: ['http://localhost:3002', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

const publicDir = path.join(__dirname, './public')

app.use(express.static(publicDir))
app.use(express.urlencoded({extended: 'false'}))
app.use(express.json())

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) {
    logger.auth(req.method, req.path, 'Token Missing');
    return res.sendStatus(401); // if there isn't any token
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      logger.auth(req.method, req.path, 'Failed', null);
      return res.sendStatus(403);
    }
    logger.auth(req.method, req.path, 'Success', user.id);
    req.user = user;
    next();
  });
}

// create a webhook endpoint that transforms the data and sends it to Pusher
app.post('/webhook', (req, res) => {
  const data = req.body;
  pusher.trigger('trades', 'new-trade', data);
  res.json(data);
});

// Test route to see if server is working
app.get('/test', (req, res) => {
  res.json({ message: 'Server is working!' });
});

// Test route for trade alerts without auth
app.get('/test-trade-alerts', (req, res) => {
  res.json({ message: 'Trade alerts route is accessible!' });
});

app.post("/auth/register", (req, res) => {    
    const { email, password, password_confirm } = req.body

    pool.query('SELECT email FROM users WHERE email = $1', [email], async (error, result) => {
        if(error){
            return res.status(400).json({ error: 'Failed to check if user exists' })
        } else if( result.rows.length > 0 ) {
            return res.status(400).json({ error: 'Email is already in use' })
        } else if(password !== password_confirm) {
            return res.status(400).json({ error: 'Password Didn\'t Match!'})
        }

        let hashedPassword = await bcrypt.hash(password, 8)

        pool.query('INSERT INTO users (email, password) VALUES ($1, $2)',[email, hashedPassword], (error, result) => {
            if(error) {
                return res.status(400).json({ error: 'Failed to create new user' })
            } else {
                return res.json()
            }
        })        
    })
})

app.post("/auth/login", (req, res) => {
  const { email, password } = req.body

  pool.query('SELECT * FROM users WHERE email = $1', [email], async (error, result) => {
    if(error){
      return res.status(400).json({ error: 'Failed to check if user exists' })
    } else if( result.rows.length === 0 ) {
      return res.status(400).json({ error: 'User not found' })
    }

    let user = result.rows[0]

    let isMatch = await bcrypt.compare(password, user.password)

    if(!isMatch){
      return res.status(400).json({ error: 'Invalid credentials' })
    }

    let token = jwt.sign({ id: user.id }, process.env.JWT_SECRET)

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email
      }
    })
  })
})

// TradeStation routes
app.get('/', routes.tradeStationRoutes.fetchAccessToken);
app.put('/tradestation/refresh_token', authenticateToken, routes.tradeStationRoutes.refreshAccessToken);

// Ticker options routes
app.get('/ticker_options', routes.tradeStationRoutes.getTickerOptions);
app.get('/ticker_contracts/:ticker', routes.tradeStationRoutes.getTickerContracts);

// Trade Alerts routes
const tradeAlertsRoutes = require('./routes/tradeAlerts');

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

// Start the real-time alert checker
const realtimeAlertChecker = new RealtimeAlertChecker();
realtimeAlertChecker.start().catch(error => {
  console.error('Failed to start realtime alert checker:', error);
});

// Make the realtime checker available for refreshing alerts
app.locals.realtimeAlertChecker = realtimeAlertChecker;

const PORT = process.env.PORT || 3001;

app.listen(PORT, ()=> {
    logger.info(`server started on port ${PORT}`)
})
