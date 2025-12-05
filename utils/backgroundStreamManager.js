/**
 * BackgroundStreamManager
 * 
 * Manages background streams for users with alerts/loss features enabled.
 * These streams run 24/7 and don't require an active HTTP connection.
 * 
 * Key features:
 * - Internal subscribers (not HTTP-bound)
 * - Automatic reconnection on stream failure
 * - Health telemetry logged every minute
 * - Token refresh on 401/stream failure
 * - Coexists with user's active trading sessions
 */

const pool = require('../db');
const logger = require('../config/logging');

/**
 * InternalSubscriber - A subscriber that's not tied to an HTTP response.
 * Mimics the Express response interface so StreamMultiplexer can use it.
 */
class InternalSubscriber {
  constructor(options = {}) {
    this.id = `internal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.onData = options.onData || (() => {});
    this.onEnd = options.onEnd || (() => {});
    this.onError = options.onError || (() => {});
    
    this._headers = {};
    this._ended = false;
    this._buffer = '';
    
    // Mimic Express response properties
    this.writableEnded = false;
    this.finished = false;
    this.destroyed = false;
    
    // Event handlers storage
    this._eventHandlers = {
      close: [],
      finish: [],
      error: []
    };
    
    // Fake request object for compatibility
    this.req = {
      query: {},
      headers: {},
      aborted: false,
      destroyed: false,
      on: (event, handler) => {},
      _eventHandlers: { close: [], aborted: [] }
    };
  }
  
  // Express response interface
  setHeader(name, value) {
    this._headers[name] = value;
  }
  
  write(chunk) {
    if (this._ended) return false;
    
    try {
      const data = chunk.toString();
      this._buffer += data;
      
      // Parse NDJSON - each line is a separate JSON object
      const lines = this._buffer.split('\n');
      this._buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            this.onData(parsed);
          } catch (parseErr) {
            // Some lines might not be JSON (heartbeats as raw text, etc.)
            this.onData({ raw: line });
          }
        }
      }
      return true;
    } catch (err) {
      this.onError(err);
      return false;
    }
  }
  
  end() {
    if (this._ended) return;
    this._ended = true;
    this.writableEnded = true;
    this.finished = true;
    
    // Trigger close handlers
    for (const handler of this._eventHandlers.close) {
      try { handler(); } catch (_) {}
    }
    
    this.onEnd();
  }
  
  status(code) {
    this._statusCode = code;
    return this;
  }
  
  json(data) {
    this.write(JSON.stringify(data));
    this.end();
    return this;
  }
  
  on(event, handler) {
    if (this._eventHandlers[event]) {
      this._eventHandlers[event].push(handler);
    }
    return this;
  }
  
  removeAllListeners(event) {
    if (this._eventHandlers[event]) {
      this._eventHandlers[event] = [];
    }
    return this;
  }
  
  // Force close the subscriber
  destroy() {
    this.destroyed = true;
    this.req.destroyed = true;
    this.end();
  }
}

/**
 * BackgroundStream - Represents a single background stream with health tracking
 */
class BackgroundStream {
  constructor(manager, userId, streamType, deps) {
    this.manager = manager;
    this.userId = userId;
    this.streamType = streamType; // 'quotes', 'positions', 'orders'
    this.deps = deps; // Stream-specific dependencies (symbols, accountId, etc.)
    
    this.subscriber = null;
    this.startedAt = null;
    this.lastDataAt = null;
    this.messagesReceived = 0;
    this.status = 'stopped';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectBackoff = 1000; // Start with 1 second
    
    // Health logging interval
    this.healthInterval = null;
    this.healthLogIntervalMs = 60000; // Log every minute
  }
  
  async start() {
    if (this.status === 'alive') {
      logger.info(`[BackgroundStream] Already running: ${this.getKey()}`);
      return;
    }
    
    this.status = 'starting';
    this.startedAt = new Date();
    this.messagesReceived = 0;
    this.reconnectAttempts = 0;
    
    await this.logHealth('start', { message: 'Stream starting' });
    
    try {
      await this.connect();
      this.startHealthLogging();
    } catch (err) {
      logger.error(`[BackgroundStream] Failed to start ${this.getKey()}:`, err.message);
      this.status = 'error';
      await this.logHealth('error', { error: err.message });
      this.scheduleReconnect();
    }
  }
  
  async connect() {
    const mux = this.getMultiplexer();
    if (!mux) {
      throw new Error(`Unknown stream type: ${this.streamType}`);
    }
    
    // Create internal subscriber
    this.subscriber = new InternalSubscriber({
      onData: (data) => this.handleData(data),
      onEnd: () => this.handleEnd(),
      onError: (err) => this.handleError(err)
    });
    
    logger.info(`[BackgroundStream] Connecting: ${this.getKey()}`);
    
    // Use addBackgroundSubscriber (non-exclusive) to allow coexistence with user streams
    const addFn = mux.addBackgroundSubscriber || mux.addSubscriber;
    const result = await addFn(this.userId, this.deps, this.subscriber);
    
    // Check if we got an error response
    if (result && result.__error) {
      const error = new Error(result.message || 'Failed to connect');
      error.status = result.status;
      error.response = result.response;
      throw error;
    }
    
    this.status = 'alive';
    this.lastDataAt = new Date();
    logger.info(`[BackgroundStream] Connected: ${this.getKey()}`);
  }
  
  getMultiplexer() {
    switch (this.streamType) {
      case 'quotes':
        return require('./quoteStreamManager');
      case 'positions':
        return require('./positionsStreamManager');
      case 'orders':
        return require('./ordersStreamManager');
      default:
        return null;
    }
  }
  
  getKey() {
    return `${this.userId}|${this.streamType}|${JSON.stringify(this.deps)}`;
  }
  
  handleData(data) {
    this.messagesReceived++;
    this.lastDataAt = new Date();
    
    // Skip heartbeats for processing
    if (data.Heartbeat) {
      return;
    }
    
    // Emit data to manager for alert processing
    this.manager.emit('data', {
      userId: this.userId,
      streamType: this.streamType,
      data
    });
  }
  
  handleEnd() {
    logger.info(`[BackgroundStream] Stream ended: ${this.getKey()}`);
    this.status = 'disconnected';
    this.stopHealthLogging();
    this.logHealth('disconnected', { message: 'Stream ended' });
    this.scheduleReconnect();
  }
  
  handleError(err) {
    logger.error(`[BackgroundStream] Stream error: ${this.getKey()}`, err.message);
    
    const isTokenError = err.status === 401 || 
                         (err.message && err.message.includes('token')) ||
                         (err.message && err.message.includes('Unauthorized'));
    
    if (isTokenError) {
      this.status = 'token_expired';
      this.logHealth('token_expired', { error: err.message });
    } else {
      this.status = 'error';
      this.logHealth('error', { error: err.message });
    }
    
    this.stopHealthLogging();
    this.scheduleReconnect();
  }
  
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`[BackgroundStream] Max reconnect attempts reached: ${this.getKey()}`);
      this.status = 'failed';
      this.logHealth('failed', { message: 'Max reconnect attempts reached' });
      return;
    }
    
    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectBackoff * Math.pow(2, this.reconnectAttempts - 1),
      60000 // Max 60 seconds
    );
    
    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 1000;
    const totalDelay = delay + jitter;
    
    logger.info(`[BackgroundStream] Reconnecting in ${Math.round(totalDelay)}ms (attempt ${this.reconnectAttempts}): ${this.getKey()}`);
    this.status = 'reconnecting';
    this.logHealth('reconnecting', { 
      attempt: this.reconnectAttempts, 
      delayMs: Math.round(totalDelay) 
    });
    
    setTimeout(async () => {
      try {
        await this.connect();
        this.reconnectAttempts = 0; // Reset on successful reconnect
        this.startHealthLogging();
        this.logHealth('reconnected', { message: 'Successfully reconnected' });
      } catch (err) {
        logger.error(`[BackgroundStream] Reconnect failed: ${this.getKey()}`, err.message);
        this.scheduleReconnect();
      }
    }, totalDelay);
  }
  
  startHealthLogging() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
    }
    
    this.healthInterval = setInterval(() => {
      this.logHealth('heartbeat');
    }, this.healthLogIntervalMs);
    
    // Don't prevent Node.js from exiting
    if (this.healthInterval.unref) {
      this.healthInterval.unref();
    }
  }
  
  stopHealthLogging() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }
  
  async logHealth(eventType, eventDetails = null) {
    try {
      const uptimeSeconds = this.startedAt 
        ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000)
        : 0;
      
      await pool.query(`
        INSERT INTO stream_health_logs 
        (user_id, stream_type, stream_key, status, started_at, uptime_seconds, 
         event_type, event_details, last_data_at, messages_received)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        this.userId,
        this.streamType,
        this.getKey(),
        this.status,
        this.startedAt,
        uptimeSeconds,
        eventType,
        eventDetails ? JSON.stringify(eventDetails) : null,
        this.lastDataAt,
        this.messagesReceived
      ]);
      
      // Reset message counter after logging
      const logged = this.messagesReceived;
      this.messagesReceived = 0;
      
      if (eventType === 'heartbeat') {
        logger.debug(`[BackgroundStream] Health: ${this.getKey()} - uptime=${uptimeSeconds}s, msgs=${logged}`);
      }
    } catch (err) {
      logger.error(`[BackgroundStream] Failed to log health: ${err.message}`);
    }
  }
  
  async stop() {
    logger.info(`[BackgroundStream] Stopping: ${this.getKey()}`);
    this.stopHealthLogging();
    
    if (this.subscriber) {
      this.subscriber.destroy();
      this.subscriber = null;
    }
    
    this.status = 'stopped';
    await this.logHealth('stop', { message: 'Stream stopped' });
  }
  
  getStatus() {
    return {
      key: this.getKey(),
      userId: this.userId,
      streamType: this.streamType,
      status: this.status,
      startedAt: this.startedAt,
      lastDataAt: this.lastDataAt,
      uptimeSeconds: this.startedAt 
        ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) 
        : 0,
      reconnectAttempts: this.reconnectAttempts
    };
  }
}

/**
 * BackgroundStreamManager - Manages all background streams
 */
class BackgroundStreamManager {
  constructor() {
    this.streams = new Map(); // key -> BackgroundStream
    this.eventHandlers = new Map(); // eventName -> Set<handler>
    this.isRunning = false;
  }
  
  /**
   * Start background streams for a user
   */
  async startStreamsForUser(userId, config) {
    const { quotes = [], positions = [], orders = [] } = config;
    
    // Start quote streams
    for (const symbolsCsv of quotes) {
      const key = `${userId}|quotes|${symbolsCsv}`;
      if (!this.streams.has(key)) {
        const stream = new BackgroundStream(this, userId, 'quotes', symbolsCsv);
        this.streams.set(key, stream);
        await stream.start();
      }
    }
    
    // Start position streams (supports multiple account IDs)
    for (const { accountId, paperTrading } of positions) {
      const key = `${userId}|positions|${accountId}|${paperTrading ? 1 : 0}`;
      if (!this.streams.has(key)) {
        const stream = new BackgroundStream(this, userId, 'positions', { accountId, paperTrading });
        this.streams.set(key, stream);
        await stream.start();
      }
    }
    
    // Start order streams
    for (const { accountId, paperTrading } of orders) {
      const key = `${userId}|orders|${accountId}|${paperTrading ? 1 : 0}`;
      if (!this.streams.has(key)) {
        const stream = new BackgroundStream(this, userId, 'orders', { accountId, paperTrading });
        this.streams.set(key, stream);
        await stream.start();
      }
    }
    
    logger.info(`[BackgroundStreamManager] Started streams for user ${userId}: ${this.streams.size} total active`);
  }
  
  /**
   * Stop all streams for a user
   */
  async stopStreamsForUser(userId) {
    const userStreams = [...this.streams.entries()]
      .filter(([key]) => key.startsWith(`${userId}|`));
    
    for (const [key, stream] of userStreams) {
      await stream.stop();
      this.streams.delete(key);
    }
    
    logger.info(`[BackgroundStreamManager] Stopped ${userStreams.length} streams for user ${userId}`);
  }
  
  /**
   * Initialize from database - start streams for all users with alerts
   */
  async initializeFromDatabase() {
    if (this.isRunning) {
      logger.warn('[BackgroundStreamManager] Already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('[BackgroundStreamManager] Initializing from database...');
    
    try {
      // Find users with active alerts
      const alertsResult = await pool.query(`
        SELECT DISTINCT user_id, ticker 
        FROM trade_alerts 
        WHERE is_active = true
      `);
      
      // Group alerts by user
      const userAlerts = new Map();
      for (const row of alertsResult.rows) {
        if (!userAlerts.has(row.user_id)) {
          userAlerts.set(row.user_id, new Set());
        }
        userAlerts.get(row.user_id).add(row.ticker);
      }
      
      // Start quote streams for each user's alert tickers
      for (const [userId, tickers] of userAlerts) {
        const symbolsCsv = [...tickers].join(',');
        await this.startStreamsForUser(userId, {
          quotes: [symbolsCsv]
        });
      }
      
      logger.info(`[BackgroundStreamManager] Initialized with ${this.streams.size} streams for ${userAlerts.size} users`);
    } catch (err) {
      logger.error('[BackgroundStreamManager] Failed to initialize:', err.message);
      this.isRunning = false;
      throw err;
    }
  }
  
  /**
   * Shutdown all streams gracefully
   */
  async shutdown() {
    logger.info('[BackgroundStreamManager] Shutting down...');
    
    for (const [key, stream] of this.streams) {
      await stream.stop();
    }
    
    this.streams.clear();
    this.isRunning = false;
    
    logger.info('[BackgroundStreamManager] Shutdown complete');
  }
  
  /**
   * Event emitter interface
   */
  emit(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          logger.error(`[BackgroundStreamManager] Event handler error:`, err.message);
        }
      }
    }
  }
  
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event).add(handler);
    return this;
  }
  
  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
    return this;
  }
  
  /**
   * Get status of all streams
   */
  getStatus() {
    const streams = [];
    for (const [key, stream] of this.streams) {
      streams.push(stream.getStatus());
    }
    
    return {
      isRunning: this.isRunning,
      totalStreams: this.streams.size,
      streams
    };
  }
  
  /**
   * Get health history from database
   */
  async getHealthHistory(options = {}) {
    const { userId, streamType, hours = 24, limit = 1500 } = options;
    
    let query = `
      SELECT * FROM stream_health_logs 
      WHERE logged_at > NOW() - INTERVAL '${hours} hours'
    `;
    const params = [];
    
    if (userId) {
      params.push(userId);
      query += ` AND user_id = $${params.length}`;
    }
    
    if (streamType) {
      params.push(streamType);
      query += ` AND stream_type = $${params.length}`;
    }
    
    query += ` ORDER BY logged_at DESC LIMIT ${limit}`;
    
    const result = await pool.query(query, params);
    return result.rows;
  }
  
  /**
   * Get uptime summary for the last N hours
   */
  async getUptimeSummary(hours = 24) {
    const result = await pool.query(`
      WITH time_range AS (
        SELECT NOW() - INTERVAL '${hours} hours' as start_time, NOW() as end_time
      ),
      stream_stats AS (
        SELECT 
          stream_key,
          stream_type,
          user_id,
          COUNT(*) FILTER (WHERE event_type = 'heartbeat') as heartbeat_count,
          COUNT(*) FILTER (WHERE event_type = 'reconnect' OR event_type = 'reconnecting') as reconnect_count,
          COUNT(*) FILTER (WHERE event_type = 'token_expired') as token_expiry_count,
          COUNT(*) FILTER (WHERE event_type = 'error') as error_count,
          MIN(logged_at) as first_log,
          MAX(logged_at) as last_log,
          MAX(uptime_seconds) as max_uptime_seconds
        FROM stream_health_logs
        WHERE logged_at > NOW() - INTERVAL '${hours} hours'
        GROUP BY stream_key, stream_type, user_id
      )
      SELECT 
        *,
        -- Expected heartbeats if running continuously (1 per minute)
        ${hours * 60} as expected_heartbeats,
        -- Uptime percentage (heartbeats / expected)
        ROUND(heartbeat_count::numeric / ${hours * 60} * 100, 2) as uptime_percentage
      FROM stream_stats
      ORDER BY user_id, stream_type
    `);
    
    return result.rows;
  }
}

// Singleton instance
const manager = new BackgroundStreamManager();

module.exports = manager;

