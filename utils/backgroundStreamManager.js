/**
 * BackgroundStreamManager
 * 
 * Manages background quote streams for users with active alerts.
 * Runs 24/7, automatically reconnects on failure.
 * 
 * SIMPLIFIED DESIGN:
 * - Each BackgroundStream manages ONE upstream connection
 * - Uses generation counter to ignore stale callbacks
 * - Simple state: stopped | connecting | alive | failed
 * - Reconnects indefinitely (no max attempts) with exponential backoff capped at 60s
 */

const pool = require('../db');
const logger = require('../config/logging');

/**
 * InternalSubscriber - Mimics Express response for StreamMultiplexer compatibility
 */
class InternalSubscriber {
  constructor(onData, onEnd, onError) {
    this.id = `bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this._onData = onData;
    this._onEnd = onEnd;
    this._onError = onError;
    this._ended = false;
    this._buffer = '';
    
    // Express response compatibility
    this.writableEnded = false;
    this.finished = false;
    this.destroyed = false;
    this._eventHandlers = { close: [], finish: [], error: [] };
    this.req = { query: {}, headers: {}, aborted: false, destroyed: false, on: () => {} };
  }
  
  setHeader() {}
  status() { return this; }
  
  write(chunk) {
    if (this._ended) return false;
    
    this._buffer += chunk.toString();
    
    // Cap buffer at 64KB to prevent memory issues
    if (this._buffer.length > 65536) {
      const idx = this._buffer.indexOf('\n', this._buffer.length - 65536);
      this._buffer = idx !== -1 ? this._buffer.slice(idx + 1) : this._buffer.slice(-65536);
    }
    
    // Parse NDJSON lines
    const lines = this._buffer.split('\n');
    this._buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.trim()) {
        try {
          this._onData(JSON.parse(line));
        } catch (_) {
          this._onData({ raw: line });
        }
      }
    }
    return true;
  }
  
  end() {
    if (this._ended) return;
    this._ended = true;
    this.writableEnded = true;
    this.finished = true;
    this._eventHandlers.close.forEach(h => { try { h(); } catch (_) {} });
    this._onEnd();
  }
  
  json(data) {
    this.write(JSON.stringify(data));
    this.end();
  }
  
  on(event, handler) {
    if (this._eventHandlers[event]) this._eventHandlers[event].push(handler);
    return this;
  }
  
  removeAllListeners(event) {
    if (this._eventHandlers[event]) this._eventHandlers[event] = [];
    return this;
  }
  
  destroy() {
    this.destroyed = true;
    this.req.destroyed = true;
    // Clear callbacks to prevent memory leaks
    this._onData = () => {};
    this._onEnd = () => {};
    this._onError = () => {};
    this.end();
  }
}

/**
 * BackgroundStream - Single background stream with auto-reconnect
 */
class BackgroundStream {
  constructor(manager, userId, streamType, deps) {
    this.manager = manager;
    this.userId = userId;
    this.streamType = streamType;
    this.deps = deps;
    
    this.subscriber = null;
    this.status = 'stopped';
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.healthInterval = null;
    
    this.startedAt = null;
    this.lastDataAt = null;
    this.messagesReceived = 0;
    
    // CRITICAL: Distinguish between temporary disconnects (should reconnect) 
    // and permanent stops (user left, alert deleted - should NOT reconnect)
    this.permanentlyStopped = false;
  }
  
  getKey() {
    if (typeof this.deps === 'string') {
      return `${this.userId}|${this.streamType}|${this.deps}`;
    }
    if (this.deps?.accountId !== undefined) {
      return `${this.userId}|${this.streamType}|${this.deps.accountId}|${this.deps.paperTrading ? 1 : 0}`;
    }
    return `${this.userId}|${this.streamType}|${JSON.stringify(this.deps)}`;
  }
  
  async start() {
    if (this.status === 'alive' || this.status === 'connecting') {
      return;
    }
    
    this.startedAt = new Date();
    this.messagesReceived = 0;
    this.reconnectDelay = 1000;
    this.permanentlyStopped = false; // Reset on explicit start
    
    await this.connect();
  }
  
  async connect() {
    // Prevent concurrent connects
    if (this.status === 'connecting') {
      logger.debug(`[BackgroundStream] Already connecting, skipping: ${this.getKey()}`);
      return;
    }
    
    // Cancel any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Destroy old subscriber
    if (this.subscriber) {
      this.subscriber.destroy();
      this.subscriber = null;
    }
    
    this.status = 'connecting';
    logger.info(`[BackgroundStream] Connecting: ${this.getKey()}`);
    
    const mux = this.getMultiplexer();
    if (!mux) {
      logger.error(`[BackgroundStream] Unknown stream type: ${this.streamType}`);
      this.status = 'failed';
      return;
    }
    
    // Create subscriber - keep local reference for cleanup
    const subscriber = new InternalSubscriber(
      (data) => {
        // Only process if this is still the active subscriber
        if (this.subscriber !== subscriber) return;
        this.handleData(data);
      },
      () => {
        if (this.subscriber !== subscriber) return;
        this.handleEnd();
      },
      (err) => {
        if (this.subscriber !== subscriber) return;
        this.handleError(err);
      }
    );
    
    this.subscriber = subscriber;
    
    try {
      const addFn = mux.addBackgroundSubscriber || mux.addSubscriber;
      const result = await addFn(this.userId, this.deps, subscriber);
      
      // Check if this subscriber was replaced during await
      if (this.subscriber !== subscriber) {
        logger.debug(`[BackgroundStream] Subscriber replaced during connect, destroying stale`);
        subscriber.destroy();
        return;
      }
      
      if (result?.__error) {
        throw new Error(result.message || 'Failed to connect');
      }
      
      this.status = 'alive';
      this.lastDataAt = new Date();
      this.reconnectDelay = 1000; // Reset backoff on success
      this.startHealthLogging();
      logger.info(`[BackgroundStream] Connected: ${this.getKey()}`);
      
    } catch (err) {
      // Check if this subscriber was replaced
      if (this.subscriber !== subscriber) {
        subscriber.destroy();
        return;
      }
      
      logger.error(`[BackgroundStream] Connect failed: ${this.getKey()}`, err.message);
      this.scheduleReconnect();
    }
  }
  
  getMultiplexer() {
    switch (this.streamType) {
      case 'quotes': return require('./quoteStreamManager');
      case 'positions': return require('./positionsStreamManager');
      case 'orders': return require('./ordersStreamManager');
      default: return null;
    }
  }
  
  handleData(data) {
    this.messagesReceived++;
    this.lastDataAt = new Date();
    
    if (data.Heartbeat) return;
    
    // Include deps (accountId, paperTrading) in the event for position streams
    const eventData = {
      userId: this.userId,
      streamType: this.streamType,
      data
    };
    
    // For positions streams, include account info from deps
    if (this.streamType === 'positions' && this.deps) {
      eventData.accountId = this.deps.accountId;
      eventData.paperTrading = this.deps.paperTrading;
    }
    
    this.manager.emit('data', eventData);
  }
  
  handleEnd() {
    if (this.status === 'stopped') return;
    
    logger.info(`[BackgroundStream] Stream ended: ${this.getKey()}`);
    this.stopHealthLogging();
    this.scheduleReconnect();
  }
  
  handleError(err) {
    if (this.status === 'stopped') return;
    
    logger.error(`[BackgroundStream] Stream error: ${this.getKey()}`, err?.message || err);
    this.stopHealthLogging();
    this.scheduleReconnect();
  }
  
  scheduleReconnect() {
    // CRITICAL: Do NOT reconnect if stream was permanently stopped
    // This prevents memory leaks when users close the website or alerts are deleted
    if (this.permanentlyStopped) {
      logger.debug(`[BackgroundStream] Stream permanently stopped, not reconnecting: ${this.getKey()}`);
      return;
    }
    
    if (this.status === 'stopped') return;
    if (this.reconnectTimer) return; // Already scheduled
    
    this.status = 'reconnecting';
    
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
    const delay = Math.min(this.reconnectDelay, 60000);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
    
    logger.info(`[BackgroundStream] Reconnecting in ${delay}ms: ${this.getKey()}`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
  
  startHealthLogging() {
    this.stopHealthLogging();
    
    this.healthInterval = setInterval(() => {
      this.logHealth('heartbeat');
    }, 60000);
    
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
  
  async logHealth(eventType, details = null) {
    try {
      const uptime = this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : 0;
      
      await pool.query(`
        INSERT INTO stream_health_logs 
        (user_id, stream_type, stream_key, status, started_at, uptime_seconds, 
         event_type, event_details, last_data_at, messages_received)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        this.userId, this.streamType, this.getKey(), this.status,
        this.startedAt, uptime, eventType, details ? JSON.stringify(details) : null,
        this.lastDataAt, this.messagesReceived
      ]);
      
      this.messagesReceived = 0;
    } catch (err) {
      logger.error(`[BackgroundStream] Health log failed: ${err.message}`);
    }
  }
  
  async stop() {
    logger.info(`[BackgroundStream] Stopping permanently: ${this.getKey()}`);
    
    // Mark as permanently stopped to prevent reconnection
    // This is critical for preventing memory leaks when users close website or alerts are deleted
    this.permanentlyStopped = true;
    this.status = 'stopped';
    this.stopHealthLogging();
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.subscriber) {
      this.subscriber.destroy();
      this.subscriber = null;
    }
    
    await this.logHealth('stop');
  }
  
  getStatus() {
    return {
      key: this.getKey(),
      userId: this.userId,
      streamType: this.streamType,
      status: this.status,
      startedAt: this.startedAt,
      lastDataAt: this.lastDataAt,
      uptimeSeconds: this.startedAt ? Math.floor((Date.now() - this.startedAt.getTime()) / 1000) : 0
    };
  }
}

/**
 * BackgroundStreamManager - Manages all background streams
 */
class BackgroundStreamManager {
  constructor() {
    this.streams = new Map();
    this.eventHandlers = new Map();
    this.isRunning = false;
  }
  
  async startStreamsForUser(userId, config) {
    const { quotes = [], positions = [], orders = [] } = config;
    
    for (const symbolsCsv of quotes) {
      const key = `${userId}|quotes|${symbolsCsv}`;
      if (!this.streams.has(key)) {
        const stream = new BackgroundStream(this, userId, 'quotes', symbolsCsv);
        this.streams.set(key, stream);
        await stream.start();
      }
    }
    
    for (const { accountId, paperTrading } of positions) {
      const key = `${userId}|positions|${accountId}|${paperTrading ? 1 : 0}`;
      if (!this.streams.has(key)) {
        const stream = new BackgroundStream(this, userId, 'positions', { accountId, paperTrading });
        this.streams.set(key, stream);
        await stream.start();
      }
    }
    
    for (const { accountId, paperTrading } of orders) {
      const key = `${userId}|orders|${accountId}|${paperTrading ? 1 : 0}`;
      if (!this.streams.has(key)) {
        const stream = new BackgroundStream(this, userId, 'orders', { accountId, paperTrading });
        this.streams.set(key, stream);
        await stream.start();
      }
    }
    
    logger.info(`[BackgroundStreamManager] User ${userId} streams started. Total: ${this.streams.size}`);
  }
  
  async stopStreamsForUser(userId) {
    const toStop = [...this.streams.entries()].filter(([k]) => k.startsWith(`${userId}|`));
    
    for (const [key, stream] of toStop) {
      await stream.stop();
      this.streams.delete(key);
    }
    
    logger.info(`[BackgroundStreamManager] Stopped ${toStop.length} streams for user ${userId}`);
  }
  
  async stopQuoteStreamsForUser(userId) {
    const toStop = [...this.streams.entries()].filter(([k]) => k.startsWith(`${userId}|quotes|`));
    
    for (const [key, stream] of toStop) {
      await stream.stop();
      this.streams.delete(key);
    }
    
    return toStop.length;
  }
  
  async initializeFromDatabase() {
    if (this.isRunning) {
      logger.warn('[BackgroundStreamManager] Already running');
      return;
    }
    
    this.isRunning = true;
    logger.info('[BackgroundStreamManager] Initializing...');
    
    try {
      const result = await pool.query(`
        SELECT DISTINCT user_id, ticker FROM trade_alerts WHERE is_active = true
      `);
      
      // Group by user
      const userTickers = new Map();
      for (const row of result.rows) {
        if (!userTickers.has(row.user_id)) {
          userTickers.set(row.user_id, new Set());
        }
        userTickers.get(row.user_id).add(row.ticker);
      }
      
      // Start streams
      for (const [userId, tickers] of userTickers) {
        await this.startStreamsForUser(userId, {
          quotes: [[...tickers].sort().join(',')]
        });
      }
      
      logger.info(`[BackgroundStreamManager] Initialized ${this.streams.size} streams for ${userTickers.size} users`);
    } catch (err) {
      logger.error('[BackgroundStreamManager] Init failed:', err.message);
      this.isRunning = false;
      throw err;
    }
  }
  
  async shutdown() {
    logger.info('[BackgroundStreamManager] Shutting down...');
    
    for (const stream of this.streams.values()) {
      await stream.stop();
    }
    
    this.streams.clear();
    this.isRunning = false;
    
    logger.info('[BackgroundStreamManager] Shutdown complete');
  }
  
  emit(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try { handler(data); } catch (err) {
          logger.error(`[BackgroundStreamManager] Handler error:`, err.message);
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
    this.eventHandlers.get(event)?.delete(handler);
    return this;
  }
  
  getStatus() {
    return {
      isRunning: this.isRunning,
      totalStreams: this.streams.size,
      streams: [...this.streams.values()].map(s => s.getStatus())
    };
  }
  
  async getHealthHistory(options = {}) {
    const { userId, streamType, hours = 24, limit = 1000 } = options;
    
    let query = `SELECT * FROM stream_health_logs WHERE logged_at > NOW() - INTERVAL '${hours} hours'`;
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
    
    return (await pool.query(query, params)).rows;
  }
}

module.exports = new BackgroundStreamManager();
