/**
 * Request monitoring middleware to track pending requests and identify bottlenecks
 * 
 * This helps debug stuck/pending requests by tracking:
 * - Active requests in flight
 * - Request duration
 * - Slow requests (taking > threshold)
 * - Database pool status
 * - HTTP agent socket usage
 */

const pool = require('../db');
const logger = require('../config/logging');

// Track all active requests
const activeRequests = new Map();
const activeStreams = new Map(); // Track streaming connections separately
let requestIdCounter = 0;

// Streaming endpoints (expected to be long-running, should NOT trigger slow warnings)
const STREAMING_PATTERNS = [
  '/stream/',
  '/marketdata/stream/',
  '/brokerage/stream/'
];

function isStreamingEndpoint(url) {
  return STREAMING_PATTERNS.some(pattern => url.includes(pattern));
}

/**
 * Middleware to track request start
 */
function trackRequestStart(req, res, next) {
  const requestId = ++requestIdCounter;
  const startTime = Date.now();
  const method = req.method;
  const url = req.originalUrl || req.url;
  const isStreaming = isStreamingEndpoint(url);
  
  // Store request info
  const requestInfo = {
    id: requestId,
    method,
    url,
    startTime,
    userId: req.user?.id,
    isStreaming,
  };
  
  activeRequests.set(requestId, requestInfo);
  
  // Track streams separately for better monitoring
  if (isStreaming) {
    activeStreams.set(requestId, requestInfo);
  }
  
  // Attach requestId to request object
  req.requestId = requestId;
  
  // Clean up on response finish
  let cleanupDone = false;
  let staleCheckInterval = null;
  
  const cleanup = (reason) => {
    if (cleanupDone) return;
    cleanupDone = true;
    
    // Clear stale detection interval if it exists
    if (staleCheckInterval) {
      clearInterval(staleCheckInterval);
      staleCheckInterval = null;
    }
    
    activeRequests.delete(requestId);
    activeStreams.delete(requestId);
    
    // Log stream cleanup for debugging
    if (isStreaming) {
      const duration = Date.now() - startTime;
      logger.debug(`[RequestMonitor] Stream ${requestId} ended (${reason}) after ${duration}ms: ${url}`);
    }
  };
  
  // Listen to multiple events to ensure cleanup
  res.on('finish', () => cleanup('finish'));
  res.on('close', () => cleanup('close'));
  res.on('error', (err) => cleanup('error'));
  
  // CRITICAL: Also listen for request being aborted/closed
  // This catches cases where the client aborts but the response events don't fire
  if (req) {
    req.on('close', () => {
      if (!res.writableEnded && !res.finished) {
        cleanup('req-close');
      }
    });
    req.on('aborted', () => {
      if (!res.writableEnded && !res.finished) {
        cleanup('req-aborted');
      }
    });
  }
  
  // For streaming endpoints, add stale detection (defensive check every 60 seconds)
  if (isStreaming) {
    staleCheckInterval = setInterval(() => {
      const age = Date.now() - startTime;
      const isStale = res.writableEnded || res.finished || req.destroyed || req.aborted;
      
      if (isStale && activeStreams.has(requestId)) {
        logger.debug(`[RequestMonitor] ⚠️ Detected stale stream ${requestId} (age: ${age}ms): ${url}`);
        cleanup('stale-detection');
      }
    }, 60000);
  }
  
  next();
}

/**
 * Get HTTP agent socket status
 */
function getHttpAgentStatus() {
  try {
    const { httpAgent, httpsAgent } = require('./httpAgent');
    
    // Get socket counts for each host
    const httpsSockets = {};
    const httpFreeSockets = {};
    const httpsRequests = {};
    
    // Count active sockets by host
    if (httpsAgent.sockets) {
      Object.keys(httpsAgent.sockets).forEach(host => {
        httpsSockets[host] = httpsAgent.sockets[host].length;
      });
    }
    
    // Count free sockets by host
    if (httpsAgent.freeSockets) {
      Object.keys(httpsAgent.freeSockets).forEach(host => {
        httpFreeSockets[host] = httpsAgent.freeSockets[host].length;
      });
    }
    
    // Count pending requests by host
    if (httpsAgent.requests) {
      Object.keys(httpsAgent.requests).forEach(host => {
        httpsRequests[host] = httpsAgent.requests[host].length;
      });
    }
    
    // Note: maxSockets might show as null in some Node versions, but the actual value is stored in options
    const maxSockets = httpsAgent.maxSockets !== undefined ? httpsAgent.maxSockets : 
                       (httpsAgent.options && httpsAgent.options.maxSockets !== undefined ? httpsAgent.options.maxSockets : 'unknown');
    
    return {
      maxSockets: maxSockets,
      maxFreeSockets: httpsAgent.maxFreeSockets,
      sockets: httpsSockets,
      freeSockets: httpFreeSockets,
      requests: httpsRequests,
      totalActiveSockets: Object.values(httpsSockets).reduce((a, b) => a + b, 0),
      totalFreeSockets: Object.values(httpFreeSockets).reduce((a, b) => a + b, 0),
      totalPendingRequests: Object.values(httpsRequests).reduce((a, b) => a + b, 0),
      // Verification: If we have >5 sockets to same host, the fix is working
      isUnlimited: Object.values(httpsSockets).some(count => count > 5),
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Get current server status including active requests and resource usage
 */
async function getServerStatus() {
  const now = Date.now();
  
  // Get all active streams
  const streams = Array.from(activeStreams.values()).map(req => ({
    id: req.id,
    method: req.method,
    url: req.url,
    userId: req.userId,
  }));
  
  // Get non-streaming requests (these are the ones that might be stuck)
  const nonStreamRequests = Array.from(activeRequests.values())
    .filter(req => !req.isStreaming)
    .map(req => ({
      id: req.id,
      method: req.method,
      url: req.url,
      duration: now - req.startTime,
      userId: req.userId,
    }));
  
  // Get database pool status
  let dbStatus = null;
  try {
    dbStatus = {
      totalConnections: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount,
      maxConnections: pool.options.max,
    };
  } catch (err) {
    dbStatus = { error: err.message };
  }
  
  // Get HTTP agent status
  const httpAgentStatus = getHttpAgentStatus();
  
  return {
    timestamp: new Date().toISOString(),
    activeStreams: {
      total: streams.length,
      streams: streams.slice(0, 20), // Top 20 streams
    },
    activeRequests: {
      total: nonStreamRequests.length,
      requests: nonStreamRequests.slice(0, 10), // Top 10 non-streaming requests
    },
    database: dbStatus,
    httpAgent: httpAgentStatus,
    process: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
    },
  };
}

/**
 * Log current server status to console
 */
async function logServerStatus() {
  const status = await getServerStatus();
  
  logger.debug('\n=== Server Status ===');
  logger.debug(`Active Streams: ${status.activeStreams.total}`);
  logger.debug(`Active Requests: ${status.activeRequests.total}`);
  
  if (status.httpAgent && !status.httpAgent.error) {
    logger.debug(`\nHTTP Connections:`);
    const maxSocketsDisplay = status.httpAgent.maxSockets === Infinity ? 'Unlimited ✓' : 
                              status.httpAgent.maxSockets === null ? 'Unknown' : 
                              status.httpAgent.maxSockets;
    logger.debug(`- Max Sockets: ${maxSocketsDisplay}`);
    logger.debug(`- Active Sockets: ${status.httpAgent.totalActiveSockets}`);
    logger.debug(`- Free Sockets: ${status.httpAgent.totalFreeSockets}`);
    logger.debug(`- Pending Requests: ${status.httpAgent.totalPendingRequests}`);
    
    if (status.httpAgent.totalPendingRequests > 0) {
      logger.debug(`  ⚠️  WARNING: ${status.httpAgent.totalPendingRequests} requests waiting for socket!`);
    }
  }
  
  if (status.database && !status.database.error) {
    logger.debug(`\nDatabase Pool:`);
    logger.debug(`- Total: ${status.database.totalConnections}/${status.database.maxConnections}`);
    logger.debug(`- Idle: ${status.database.idleConnections}`);
    logger.debug(`- Waiting: ${status.database.waitingRequests}`);
  }
  
  if (status.activeStreams.total > 0) {
    logger.debug(`\nActive Streams:`);
    status.activeStreams.streams.slice(0, 5).forEach(stream => {
      const urlShort = stream.url.length > 80 ? stream.url.substring(0, 77) + '...' : stream.url;
      logger.debug(`  [${stream.id}] ${stream.method} ${urlShort}`);
    });
    if (status.activeStreams.total > 5) {
      logger.debug(`  ... and ${status.activeStreams.total - 5} more`);
    }
  }
  
  if (status.activeRequests.total > 0) {
    logger.debug(`\nActive Requests:`);
    status.activeRequests.requests.forEach(req => {
      logger.debug(`  [${req.id}] ${req.method} ${req.url} - ${req.duration}ms`);
    });
  }
  
  logger.debug('===================\n');
}

/**
 * Express endpoint to get server status as JSON
 */
async function statusEndpoint(req, res) {
  try {
    const status = await getServerStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * Periodically log status (disabled by default - streams are long-running by design)
 */
function startPeriodicMonitoring(intervalMs = 60000) {
  // Only log if there are issues (like pending socket requests or high DB wait count)
  setInterval(async () => {
    const status = await getServerStatus();
    const hasPendingSockets = status.httpAgent && status.httpAgent.totalPendingRequests > 0;
    const hasDbWaiting = status.database && status.database.waitingRequests > 0;
    const tooManyStreams = status.activeStreams.total > 20; // More than 20 concurrent streams might indicate a leak
    
    if (hasPendingSockets || hasDbWaiting || tooManyStreams) {
      await logServerStatus();
    }
  }, intervalMs);
}

module.exports = {
  trackRequestStart,
  getServerStatus,
  logServerStatus,
  statusEndpoint,
  startPeriodicMonitoring,
  activeRequests, // Export for inspection
};

