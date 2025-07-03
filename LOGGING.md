# Logging Configuration

This document describes the logging configuration for the TradeStation Alert System.

## Log Levels

The system uses the following log levels (from most to least verbose):

- **ERROR (0)**: Only error messages
- **WARN (1)**: Warnings and errors
- **INFO (2)**: Information, warnings, and errors (default)
- **DEBUG (3)**: All messages including debug information

## Current Configuration

The current log level is set to **INFO** in `config/logging.js`. This means you will see:

- ✅ Authentication requests and responses
- ✅ TradeStation API requests (URLs only)
- ✅ Alert triggers
- ✅ SMS notifications
- ✅ Server startup/shutdown messages
- ✅ Error messages
- ❌ Verbose debug information
- ❌ Detailed API response data
- ❌ Internal processing details

## What You'll See Now

With the current configuration, you should see logs like:

```
AUTH: PUT /trade_alerts/3 - Success - User: 1
TRADESTATION API: https://api.tradestation.com/v3/marketdata/barcharts/MNQU25?unit=Minute&interval=60&barsback=1000
server started on port 3001
Starting realtime alert checker (10-second intervals)...
Loaded 2 active alerts for 1 tickers
```

## Changing Log Levels

To change the log level, edit `config/logging.js` and modify the `CURRENT_LOG_LEVEL` constant:

```javascript
// For minimal logging (errors only)
const CURRENT_LOG_LEVEL = LOG_LEVELS.ERROR;

// For verbose logging (everything)
const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG;
```

## Log Categories

The logger provides specialized methods for different types of logging:

- `logger.auth(method, path, status, userId)` - Authentication events
- `logger.tradestation(url)` - TradeStation API requests
- `logger.api(url)` - General API requests
- `logger.info(message)` - General information
- `logger.error(message)` - Error messages
- `logger.debug(message)` - Debug information (only shown in DEBUG mode)

## Disabling Logging Completely

To disable all logging, set the log level to a value below ERROR:

```javascript
const CURRENT_LOG_LEVEL = -1;
```

## Environment-Specific Configuration

You can also make the log level configurable via environment variables by modifying `config/logging.js`:

```javascript
const CURRENT_LOG_LEVEL = process.env.LOG_LEVEL ? LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] : LOG_LEVELS.INFO;
```

Then set the environment variable:
```bash
LOG_LEVEL=DEBUG npm start
``` 