# TradeStation Server - Trade Alert System

This Node.js/Express server provides a complete trade alert system with standard deviation analysis for futures contracts.

## Features

- **Trade Alerts**: Create, update, and delete price-based alerts
- **Standard Deviation Analysis**: Calculate ±1, ±1.5, and ±2 standard deviation bands based on candle body sizes
- **Background Alert Checking**: Automated monitoring of price levels every 5 minutes
- **SMS Notifications**: Alert triggers with SMS notifications via Twilio
- **Email Notifications**: Alert triggers with detailed email notifications (currently logged)
- **Alert Logging**: Complete history of all alert triggers
- **TradeStation API Integration**: Fetches market data and manages OAuth credentials

## Setup

### 1. Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Database Configuration
DATABASE_HOST=localhost
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE=tradestation_trading_app

# JWT Configuration
JWT_SECRET=your_jwt_secret_here

# TradeStation API Configuration
TRADESTATION_CLIENT_ID=your_client_id
TRADESTATION_CLIENT_SECRET=your_client_secret
TRADESTATION_REDIRECT_URI=http://localhost:3001

# Frontend Configuration
REACT_PORT=3002
FRONTEND_URL=https://your-frontend-domain.vercel.app

# Twilio SMS Configuration
TWILIO_ACCOUNT_SID=ACyour_account_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_FROM_NUMBER=+18883281705
TWILIO_TO_NUMBER=+18052070953
```

### 2. Database Setup

First, ensure PostgreSQL is installed and running. Then set up the database:

```bash
# Create the database (if it doesn't exist)
createdb tradestation_trading_app

# Run the database setup script
node setup_db.js
```

The `setup_db.js` script will automatically:
- Read the `db_schema.sql` file
- Execute all the SQL commands to create the required tables
- Set up the database schema for the trade alert system

Alternatively, you can manually run the schema:
```bash
psql -d tradestation_trading_app -f db_schema.sql
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Start the Server

```bash
npm start
```

The server will start on port 3001 and automatically begin the background alert checker.

## API Endpoints

### Trade Alerts
- `GET /trade_alerts` - Get all alerts for authenticated user
- `POST /trade_alerts` - Create a new alert
- `PUT /trade_alerts/:id` - Update an existing alert
- `DELETE /trade_alerts/:id` - Delete an alert

### Standard Deviation Levels
- `GET /std_dev_levels/:ticker?timeframe=1hour` - Get std dev levels for a ticker

### Alert Logs
- `GET /alert_logs` - Get alert trigger history for authenticated user

### Manual Operations
- `POST /run_alert_checker` - Manually trigger alert checking

### TradeStation Integration
- `GET /` - OAuth callback for TradeStation
- `PUT /tradestation/refresh_token` - Refresh access token

## Background Worker

The `AlertChecker` class runs automatically and:

1. Checks all active alerts every 5 minutes
2. Fetches current prices from TradeStation API
3. Triggers alerts when price conditions are met
4. Logs all triggers to the database
5. Sends SMS notifications via Twilio
6. Sends email notifications (currently logged to console)

## Standard Deviation Calculation

The system calculates standard deviation bands based on:

- **Data Source**: 1-hour candle bars from TradeStation API
- **Calculation Method**: Candle body sizes (|open - close|)
- **Bands**: ±1, ±1.5, and ±2 standard deviations from current price
- **Caching**: Results are cached in the database and updated periodically

# Password Reset and Email Setup

## Environment Variables

Add the following to your `.env` in `tradestation-server/`:

```
# App
APP_BASE_URL=http://localhost:3002
RESET_TOKEN_TTL_MINUTES=15
PASSWORD_RESET_RATE_LIMIT_PER_HOUR=5

# JWT (already present)
# JWT_SECRET=...

# Zoho SMTP (update with your Zoho info)
ZOHO_SMTP_HOST=smtp.zoho.com
ZOHO_SMTP_PORT=465
ZOHO_SMTP_SECURE=true
ZOHO_SMTP_USER=your-zoho-email@example.com
ZOHO_SMTP_PASS=your-zoho-app-password

# From address for emails
EMAIL_FROM=support@tradecraftapp.com
```

Notes:
- Use a Zoho App Password for `ZOHO_SMTP_PASS`.
- Keep `APP_BASE_URL` pointing to your frontend origin. The reset link uses `${APP_BASE_URL}/reset-password?token=...`.
- TTL is set to 15 minutes by default.

## Database Migration

Run the migration to create `password_resets`:

```
npm run migrate
```

## Endpoints

- `POST /auth/request_password_reset` `{ email }` → Always returns `{ success: true }`.
- `POST /auth/reset_password` `{ token, new_password }` → On success returns `{ success: true }`.

## Email Branding

- Emails are sent from `support@tradecraftapp.com`.
- The reset email uses a simple dark theme and pulls the logo from `${APP_BASE_URL}/images/tradestation-logo.png`.

## Frontend Routes

- `/forgot-password` → request reset link
- `/reset-password?token=...` → set new password