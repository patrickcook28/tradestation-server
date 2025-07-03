# TradeStation Server - Trade Alert System

This Node.js/Express server provides a complete trade alert system with standard deviation analysis for futures contracts.

## Features

- **Trade Alerts**: Create, update, and delete price-based alerts
- **Standard Deviation Analysis**: Calculate ±1, ±1.5, and ±2 standard deviation bands based on candle body sizes
- **Background Alert Checking**: Automated monitoring of price levels every 5 minutes
- **Email Notifications**: Alert triggers with detailed email notifications (currently logged)
- **Alert Logging**: Complete history of all alert triggers
- **TradeStation API Integration**: Fetches market data and manages OAuth credentials

## Setup

### 1. Database Setup

Run the database schema to create the required tables:

```sql
-- Execute the contents of db_schema.sql in your PostgreSQL database
```

### 2. Environment Variables

Create a `.env` file with the following variables:

```env
# Database
DATABASE_HOST=localhost
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE=tradestation_trading_app

# JWT
JWT_SECRET=your_jwt_secret_here

# TradeStation API
TRADESTATION_CLIENT_ID=your_client_id
TRADESTATION_CLIENT_SECRET=your_client_secret
TRADESTATION_REDIRECT_URI=http://localhost:3001

# Frontend
REACT_PORT=3002

# Optional: Email service (for production)
SENDGRID_API_KEY=your_sendgrid_key
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
5. Sends email notifications (currently logged to console)

## Standard Deviation Calculation

The system calculates standard deviation bands based on:

- **Data Source**: 1-hour candle bars from TradeStation API
- **Calculation Method**: Candle body sizes (|open - close|)
- **Bands**: ±1, ±1.5, and ±2 standard deviations from current price
- **Caching**: Results are cached in the database and updated periodically

## Frontend Integration

The frontend can fetch std dev levels and display them on charts:

```javascript
// Fetch std dev levels
const response = await fetch(`http://localhost:3001/std_dev_levels/MNQ?timeframe=1hour`);
const levels = await response.json();

// Display on chart
// levels.plus_1_std, levels.plus_1_5_std, levels.plus_2_std
// levels.minus_1_std, levels.minus_1_5_std, levels.minus_2_std
```

## Production Considerations

1. **Email Service**: Implement actual email sending (SendGrid, AWS SES, etc.)
2. **Error Handling**: Add more robust error handling and retry logic
3. **Rate Limiting**: Implement API rate limiting for TradeStation calls
4. **Monitoring**: Add health checks and monitoring for the background worker
5. **Security**: Implement proper user authentication and authorization
6. **Scaling**: Consider using a job queue (Redis/Bull) for alert processing

## Troubleshooting

- **CORS Issues**: Ensure the frontend origin is included in CORS configuration
- **Database Connection**: Verify PostgreSQL is running and credentials are correct
- **TradeStation API**: Check that OAuth credentials are valid and not expired
- **Alert Checker**: Monitor console logs for background worker status 