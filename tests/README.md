# Trade Alert System Tests

This directory contains all test files for the Trade Alert System.

## Test Files

### `test_timeframe_alerts.js`
**Purpose**: Tests the new timeframe-based alert reset functionality
**What it tests**:
- Timeframe calculation logic (5min, 15min, 30min, 1hour, 4hour, daily)
- Alert state management and reset logic
- Real-time alert checking with mock data
- Integration with the RealtimeAlertChecker

**How to run**:
```bash
node tests/test_timeframe_alerts.js
```

### `test_std_dev_alert.js`
**Purpose**: Tests standard deviation alert creation and management
**What it tests**:
- Creating alerts based on standard deviation levels
- Database operations for std dev alerts
- API integration for alert creation

**How to run**:
```bash
node tests/test_std_dev_alert.js
```

### `test_sms.js`
**Purpose**: Tests SMS notification functionality via Twilio
**What it tests**:
- SMS message formatting
- Twilio API integration
- Alert notification delivery

**How to run**:
```bash
node tests/test_sms.js
```

### `test_stream_multiplexer.js`
**Purpose**: Comprehensive brute-force testing of the StreamMultiplexer
**What it tests**:
- Basic stream multiplexing (multiple subscribers to one upstream)
- Rate limiting (MAX_PENDING_OPENS)
- Max subscribers per key enforcement
- Late joiner notifications
- Exclusive subscriber switching
- Rapid reconnections
- Subscriber disconnections at various lifecycle stages
- Concurrent open attempts for same key
- Timeout handling (connection, initial data, activity)
- Cleanup and garbage collection
- Error condition handling (401, 403, 404, timeouts)
- Heavy load stress testing

**How to run**:
```bash
# Option 1: Create test_auth.json with credentials
cp tests/test_auth.json.example tests/test_auth.json
# Edit test_auth.json with your credentials
node tests/test_stream_multiplexer.js

# Option 2: Pass credentials as arguments
node tests/test_stream_multiplexer.js --user-id=123 --token=xyz --account-id=456
```

**Setup**:
1. Copy `test_auth.json.example` to `test_auth.json`
2. Fill in your credentials (userId, jwtToken, accountId)
3. The `test_auth.json` file is gitignored for security

### `test_concurrent_streams.js`
**Purpose**: Tests socket limit fix for concurrent streams
**What it tests**:
- Multiple concurrent stream connections
- Socket pool management
- Real trading session simulation

**How to run**:
```bash
node tests/test_concurrent_streams.js <JWT_TOKEN>
```

## Running Tests

### Run all tests (shows test menu):
```bash
npm test
```

### Run specific test:
```bash
node tests/test_timeframe_alerts.js
node tests/test_std_dev_alert.js
node tests/test_sms.js
node tests/test_stream_multiplexer.js
node tests/test_concurrent_streams.js <JWT_TOKEN>
```

## Prerequisites

Before running tests, ensure:

1. **Database is running** - PostgreSQL should be active
2. **API Credentials** - Valid TradeStation API credentials in the database
3. **Twilio Configuration** - For SMS tests, ensure Twilio is configured in `config/twilio.js`
4. **Dependencies** - All npm packages are installed (`npm install`)
5. **Server is running** - For stream tests, ensure the server is running on port 3001 (or set SERVER_HOST and SERVER_PORT env vars)
6. **Test Auth** - For stream multiplexer tests, create `tests/test_auth.json` with your credentials

## Test Data

- Tests create temporary data that gets cleaned up automatically
- Some tests may create test alerts in the database
- Check the console output for detailed test results

## Troubleshooting

### Common Issues:

1. **Database Connection Error**
   - Ensure PostgreSQL is running
   - Check database credentials in `db.js`

2. **API Authentication Error**
   - Verify TradeStation API credentials are valid
   - Check if access token needs refresh

3. **SMS Test Fails**
   - Verify Twilio credentials in `config/twilio.js`
   - Check phone number format (should include country code)

4. **Module Not Found Errors**
   - Ensure you're running tests from the project root directory
   - Check that all dependencies are installed

## Adding New Tests

When adding new test files:

1. Name them with `test_` prefix
2. Update the require paths to use `../` for parent directory
3. Add description to this README
4. Update `run_tests.js` if needed 