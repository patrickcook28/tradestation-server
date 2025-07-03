// Logging configuration
const LOG_LEVELS = {
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3
};

// Set this to control logging verbosity
const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG;

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
  
  // Special logging for authentication
  auth: (method, path, status, userId = null) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO) {
      const userInfo = userId ? ` - User: ${userId}` : '';
      console.log(`AUTH: ${method} ${path} - ${status}${userInfo}`);
    }
  },
  
  // Special logging for TradeStation API
  tradestation: (url) => {
    if (CURRENT_LOG_LEVEL >= LOG_LEVELS.INFO) {
      console.log(`TRADESTATION API: ${url}`);
    }
  }
};

module.exports = logger; 