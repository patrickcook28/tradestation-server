const pool = require('../db');
const logger = require('../config/logging');

// Simplified maintenance mode - no middleware needed
// The frontend will check maintenance status directly via API

module.exports = maintenanceModeMiddleware; 