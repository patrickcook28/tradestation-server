const pool = require('../db');
const backgroundStreamManager = require('../utils/backgroundStreamManager');
const alertEngine = require('../workers/alertEngine');
const { createTransport } = require('../config/email');

/**
 * Health check endpoint for Railway/container orchestration
 * GET /health
 */
const health = async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: Date.now(),
    db: 'unknown',
    email: 'unknown'
  };
  
  // Check database
  try {
    await pool.query('SELECT 1');
    health.db = 'connected';
  } catch (err) {
    console.error('[Health] Database check failed:', err.message);
    health.db = 'disconnected';
    health.dbError = err.message;
    health.status = 'unhealthy';
  }
  
  // // Actually test SMTP connection
  // try {
  //   const transporter = createTransport();
  //   await transporter.verify();
  //   health.email = 'connected';
  //   transporter.close();
  // } catch (err) {
  //   console.error('[Health] Email check failed:', err.message);
  //   health.email = 'disconnected';
  //   health.emailError = err.message;
  //   // Don't mark unhealthy for email - it's not critical for app function
  // }
  
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
};

/**
 * HTML status page with DB status and users
 * GET /status
 */
const status = async (req, res) => {
  let dbStatus = 'Unknown';
  let users = [];
  try {
    await pool.query('SELECT 1');
    dbStatus = 'Connected';
    const result = await pool.query('SELECT id, email FROM users ORDER BY id');
    users = result.rows;
  } catch (err) {
    dbStatus = 'Error: ' + err.message;
  }
  res.render('status', { dbStatus, users });
};

/**
 * Consolidated debug endpoint - all diagnostics in one place
 * GET /debug
 */
const debug = async (req, res) => {
  try {
    const barsManager = require('../utils/barsStreamManager');
    const quotesManager = require('../utils/quoteStreamManager');
    const ordersManager = require('../utils/ordersStreamManager');
    const positionsManager = require('../utils/positionsStreamManager');
    const { getRequestStats } = require('../utils/requestMonitor');
    
    const debugInfo = {
      timestamp: new Date().toISOString(),
      server: getRequestStats ? getRequestStats() : {},
      streams: {
        bars: barsManager.getDebugInfo ? barsManager.getDebugInfo() : [],
        quotes: quotesManager.getDebugInfo ? quotesManager.getDebugInfo() : [],
        orders: ordersManager.getDebugInfo ? ordersManager.getDebugInfo() : [],
        positions: positionsManager.getDebugInfo ? positionsManager.getDebugInfo() : []
      },
      backgroundStreams: backgroundStreamManager.getStatus(),
      alertEngine: alertEngine.getStats()
    };
    
    res.json(debugInfo);
  } catch (error) {
    console.error('Error getting debug info:', error);
    res.status(500).json({ error: 'Failed to get debug info', message: error.message });
  }
};

/**
 * Manual cleanup of stale connections
 * POST /debug/cleanup
 */
const cleanup = async (req, res) => {
  try {
    const barsManager = require('../utils/barsStreamManager');
    const quotesManager = require('../utils/quoteStreamManager');
    const ordersManager = require('../utils/ordersStreamManager');
    const positionsManager = require('../utils/positionsStreamManager');
    const { destroyIdleSockets } = require('../utils/httpAgent');
    
    console.log('[Debug] Starting manual stream cleanup...');
    
    const results = {
      bars: barsManager.cleanupStaleConnections ? barsManager.cleanupStaleConnections() : 0,
      quotes: quotesManager.cleanupStaleConnections ? quotesManager.cleanupStaleConnections() : 0,
      orders: ordersManager.cleanupStaleConnections ? ordersManager.cleanupStaleConnections() : 0,
      positions: positionsManager.cleanupStaleConnections ? positionsManager.cleanupStaleConnections() : 0
    };
    
    const socketsDestroyed = destroyIdleSockets();
    results.idleSocketsDestroyed = socketsDestroyed;
    
    const total = results.bars + results.quotes + results.orders + results.positions;
    
    console.log(`[Debug] Cleanup complete: ${total} stale connections, ${socketsDestroyed} idle sockets`);
    
    res.json({
      message: `Cleaned up ${total} stale connection(s) and ${socketsDestroyed} idle socket(s)`,
      details: results
    });
  } catch (error) {
    console.error('Error cleaning up stale connections:', error);
    res.status(500).json({ error: 'Failed to cleanup stale connections', message: error.message });
  }
};

module.exports = {
  health,
  status,
  debug,
  cleanup
};

