// Logging configuration
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

// Resolve log level from env (LOG_LEVEL=ERROR|WARN|INFO|DEBUG), default to DEBUG for dev
const envLogLevel = process.env.LOG_LEVEL && LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()] !== undefined
  ? LOG_LEVELS[process.env.LOG_LEVEL.toUpperCase()]
  : (process.env.NODE_ENV === 'production' ? LOG_LEVELS.INFO : LOG_LEVELS.DEBUG);
const CURRENT_LOG_LEVEL = envLogLevel;

// Toggle HTTP request logging with LOG_HTTP or LOG_REQUESTS (true/1/on)
const HTTP_LOGGING_ENABLED = (() => {
  const raw = (process.env.LOG_HTTP || process.env.LOG_REQUESTS || '');
  const v = String(raw).toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || (process.env.NODE_ENV !== 'production' && v === '');
})();

const logger = {
  error: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.ERROR) {
      console.error(message, ...args);
    }
  },
  
  warn: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.WARN) {
      console.warn(message, ...args);
    }
  },
  
  info: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO) {
      console.log(message, ...args);
    }
  },
  
  debug: (message, ...args) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  },
  
  // Special logging for API requests
  api: (url) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO) {
      console.log(`API REQUEST: ${url}`);
    }
  },
  
  // Special logging for authentication (disabled - too noisy)
  auth: (method, path, status, userId = null) => {
    // Disabled - uncomment if needed for debugging
    // if (CURRENT_LOG_LEVEL >= LOG_LEVELS.DEBUG) {
    //   const userInfo = userId ? ` - User: ${userId}` : '';
    //   console.log(`AUTH: ${method} ${path} - ${status}${userInfo}`);
    // }
  },
  
  // Special logging for TradeStation API
  tradestation: (url) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO) {
      console.log(`TRADESTATION API: ${url}`);
    }
  }
};

logger.isHttpLoggingEnabled = () => HTTP_LOGGING_ENABLED;
logger.levels = LOG_LEVELS;

module.exports = logger; 