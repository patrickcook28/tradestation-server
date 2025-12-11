// Native fetch is available in Node.js 18+
const { Readable } = require('stream');
const { buildUrl, getUserAccessToken } = require('./tradestationProxy');
const { refreshAccessTokenForUserLocked } = require('./tokenRefresh');
const logger = require('../config/logging');

class StreamMultiplexer {
  /**
   * @param {{
   *   name: string,
   *   makeKey: (userId: string, deps: any) => string,
   *   buildRequest: (userId: string, deps: any) => { path: string, paperTrading?: boolean, query?: Record<string, any> },
   * }} options
   */
  constructor({ name, makeKey, buildRequest }) {
    this.name = name;
    this.makeKey = makeKey;
    this.buildRequest = buildRequest;
    /** @type {Map<string, { key: string, subscribers: Set<any>, upstream: any, webStream: any, readable: any, abortController: AbortController|null, lastActivityAt: number, heartbeatTimer?: NodeJS.Timeout }>} */
    this.keyToConnection = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.pendingOpens = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.pendingCleanups = new Map();
    /**
     * Tracks the most recent key per user for streams that should be exclusive
     * (one active upstream per user). Used by addExclusiveSubscriber.
     * @type {Map<string, string>}
     */
    this.userToLastKey = new Map();
  }

  /**
   * Safely abort a fetch connection, handling race conditions where the connection
   * may already be destroyed. This prevents the "Cannot read properties of null" error.
   * @param {object} state - The connection state object
   * @param {string} key - The connection key (for logging)
   * @param {string} reason - The reason for aborting
   */
  _safeAbort(state, key, reason) {
    if (!state.abortController) {
      return;
    }
    
    // Check if already aborted to avoid duplicate abort calls
    if (state.abortController.signal.aborted) {
      state.abortController = null;
      return;
    }
    
    try {
      logger.debug(`[${this.name}] Aborting fetch connection for key=${key} (${reason})`);
      state.abortController.abort(reason);
    } catch (abortErr) {
      // Ignore abort errors - connection may already be destroyed by undici
      logger.debug(`[${this.name}] Abort error (ignored) for key=${key}:`, abortErr.message);
    } finally {
      state.abortController = null;
    }
  }

  async ensureUpstream(userId, deps) {
    const key = this.makeKey(userId, deps);
    
    // CRITICAL: Wait for any pending cleanup to complete before opening new stream
    // This ensures we always get fresh data from TradeStation, not mid-stream
    const pendingCleanup = this.pendingCleanups.get(key);
    if (pendingCleanup) {
      logger.debug(`[${this.name}] Waiting for cleanup to complete for key=${key} before opening new stream...`);
      try { await pendingCleanup; } catch (_) {}
      logger.debug(`[${this.name}] Cleanup complete for key=${key}, proceeding with fresh stream open`);
    }
    
    const entry = this.keyToConnection.get(key);
    if (entry && entry.upstream) {
      const now = new Date().toISOString();
      logger.debug(`[${this.name}] [${now}] ♻️  Reusing upstream for key=${key}. Subscribers=${entry.subscribers.size}`);
      return entry;
    }

    const inFlight = this.pendingOpens.get(key);
    if (inFlight) {
      logger.debug(`[${this.name}] Awaiting pending upstream open for key=${key} ...`);
      try { await inFlight; } catch (e) { logger.debug(`[${this.name}] Pending open failed for key=${key}`, e && e.message); }
      const after = this.keyToConnection.get(key);
      if (after && after.upstream) {
        const now = new Date().toISOString();
        logger.debug(`[${this.name}] [${now}] ♻️  Reusing just-opened upstream for key=${key}`);
        return after;
      }
    }

    let resolveLock, rejectLock;
    const creationLock = new Promise((resolve, reject) => { resolveLock = resolve; rejectLock = reject; });
    this.pendingOpens.set(key, creationLock);

    const { path, paperTrading = false, query } = this.buildRequest(userId, deps) || {};
    if (!path) {
      const err = { __error: true, status: 400, response: { error: 'Missing path for upstream request' }, message: 'Invalid upstream request' };
      try { rejectLock(err); } catch (_) {}
      this.pendingOpens.delete(key);
      return err;
    }
    let accessToken;
    try {
      accessToken = await getUserAccessToken(userId);
    } catch (tokenErr) {
      const err = { __error: true, status: 401, response: { error: 'Unauthorized', details: tokenErr && tokenErr.message }, message: 'Failed to acquire access token' };
      try { rejectLock(err); } catch (_) {}
      this.pendingOpens.delete(key);
      return err;
    }
    const url = buildUrl(!!paperTrading, path, query);

    // CORRECT: Use persistent AbortController to control entire stream lifecycle
    // Must be declared outside try block to be accessible for state storage
    const connectionAbort = new AbortController();
    
    let upstream;
    try {
      const openAttemptTime = Date.now();
      logger.debug(`[${this.name}] [${openAttemptTime}] Opening upstream for key=${key} url=${url}`);
      const fetchStartTime = Date.now();
      
      // Combine with timeout signal (AbortSignal.any is Node 18+)
      const timeoutSignal = AbortSignal.timeout(30000);
      const combinedSignal = AbortSignal.any([connectionAbort.signal, timeoutSignal]);
      
      upstream = await fetch(url, { 
        method: 'GET', 
        headers: { 'Authorization': `Bearer ${accessToken}` },
        signal: combinedSignal
      });
      
      const now = new Date().toISOString();
      logger.debug(`[${this.name}] [${now}] ✅ TradeStation API responded (status: ${upstream.status}) for key=${key}`);
      
      if (!upstream.ok && upstream.status === 401) {
        try {
          await refreshAccessTokenForUserLocked(userId);
          logger.debug(`[${this.name}] Retrying upstream open after token refresh for key=${key}`);
          
          // Use same persistent AbortController for retry
          const retryTimeoutSignal = AbortSignal.timeout(15000);
          const retrySignal = AbortSignal.any([connectionAbort.signal, retryTimeoutSignal]);
          
          upstream = await fetch(url, { 
            method: 'GET', 
            headers: { 'Authorization': `Bearer ${await getUserAccessToken(userId)}` },
            signal: retrySignal
          });
        } catch (_) {}
      }
    } catch (networkErr) {
      const isTimeout = networkErr.name === 'AbortError';
      const status = isTimeout ? 504 : 502;
      const errorType = isTimeout ? 'Gateway Timeout' : 'Bad Gateway';
      const err = { __error: true, status, response: { error: errorType, details: networkErr && networkErr.message }, message: `Upstream fetch failed: ${errorType}` };
      try { rejectLock(err); } catch (_) {}
      this.pendingOpens.delete(key);
      return err;
    }

    if (!upstream || !upstream.ok) {
      let text = '';
      try { text = upstream && upstream.text ? await upstream.text() : ''; } catch (_) {}
      let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      // Provide more helpful messages by status
      const status = upstream && typeof upstream.status === 'number' ? upstream.status : 500;
      const friendly = status === 403 ? 'Forbidden' : (status === 429 ? 'Rate limited' : (status === 404 ? 'Not found' : 'Upstream not OK'));
      const err = { __error: true, status: status, response: (data && Object.keys(data).length ? data : { error: friendly }), message: friendly };
      try { rejectLock(err); } catch (_) {}
      this.pendingOpens.delete(key);
      return err;
    }

    // If user's exclusive key changed while we were opening, abandon this upstream to avoid duplicate upstreams
    try {
      const lastKey = this.userToLastKey.get(userId);
      if (lastKey && lastKey !== key) {
        logger.debug(`[${this.name}] Abandoning stale upstream for key=${key} (lastKey changed to ${lastKey})`);
        try { upstream.body && upstream.body.destroy && upstream.body.destroy(); } catch (_) {}
        try { resolveLock(); } catch (_) {}
        this.pendingOpens.delete(key);
        return { __error: true, status: 409, response: { error: 'Stale upstream (key changed during open)' }, message: 'Stale upstream' };
      }
    } catch (_) {}

    // CRITICAL: Convert Web ReadableStream and store AbortController
    const webStream = upstream.body;
    const readable = Readable.fromWeb(webStream);
    
    const state = entry || { 
      key, 
      subscribers: new Set(), 
      upstream: null,
      webStream: null,
      readable: null,
      abortController: null,  // CRITICAL: Controls entire fetch connection lifecycle
      lastActivityAt: Date.now(), 
      heartbeatTimer: undefined, 
      firstDataSent: false 
    };
    state.upstream = upstream;
    state.webStream = webStream;
    state.readable = readable;
    state.abortController = connectionAbort;  // Store for cleanup
    state.lastActivityAt = Date.now();
    this.keyToConnection.set(key, state);

    readable.on('data', (chunk) => {
      try {
        state.lastActivityAt = Date.now();
        
        // Log first data packet sent to clients
        if (!state.firstDataSent) {
          state.firstDataSent = true;
          const now = new Date().toISOString();
          logger.debug(`[${this.name}] [${now}] 📤 First data sent to ${state.subscribers.size} client(s) for key=${key}`);
        }
        
        // Use setImmediate to avoid blocking the event loop when broadcasting to many subscribers
        setImmediate(() => {
          for (const res of state.subscribers) { 
            try { 
              res.write(chunk); 
            } catch (writeErr) {
              // Silently handle write errors (client disconnected, etc.)
            }
          }
        });
      } catch (error) {
        logger.error(`[${this.name}] Error handling data for key=${key}:`, error);
      }
    });

    const cleanup = (error) => {
      try {
        if (error) {
          logger.error(`[${this.name}] Upstream error for key=${key}:`, error);
        }
        logger.debug(`[${this.name}] Upstream closing for key=${key}. Closing ${state.subscribers.size} subscriber(s).`);
        for (const res of state.subscribers) { try { res.end(); } catch (_) {} }
        state.subscribers.clear();
        try { if (state.heartbeatTimer) clearInterval(state.heartbeatTimer); } catch (_) {}
        
        // CRITICAL STEP 1: Abort fetch connection via AbortController
        // This signals undici to release native buffers immediately
        this._safeAbort(state, key, error ? error.message : 'Stream closed');
        
        // CRITICAL STEP 2: Destroy Node.js wrapper stream (after abort)
        try {
          if (state.readable && state.readable.destroy) {
            state.readable.destroy(error);
          }
        } catch (_) {}
        
        // CRITICAL STEP 3: Nullify all references to help GC
        try {
          state.webStream = null;
          state.readable = null;
          state.upstream = null;
        } catch (_) {}
        
        this.keyToConnection.delete(key);
        logger.debug(`[${this.name}] Active upstreams: ${this.keyToConnection.size}`);
      } catch (cleanupError) {
        logger.error(`[${this.name}] Error during cleanup for key=${key}:`, cleanupError);
      }
    };
    readable.on('end', () => cleanup());
    readable.on('error', (error) => cleanup(error));

    try { resolveLock(); } catch (_) {}
    this.pendingOpens.delete(key);
    return state;
  }

  async addSubscriber(userId, deps, res) {
    const key = this.makeKey(userId, deps);
    
    // Extract stream epoch from query params for connection tracking
    const streamEpoch = res.req?.query?._epoch || res.req?.headers?.['x-stream-epoch'] || '0';
    const connectionId = `${userId}|${key}|${streamEpoch}|${Date.now()}`;
    
    // Check if upstream already exists BEFORE calling ensureUpstream
    const existingState = this.keyToConnection.get(key);
    const isJoiningExistingStream = existingState && existingState.upstream && existingState.firstDataSent;
    
    let state;
    try {
      state = await this.ensureUpstream(userId, deps);
      if (!state) {
        try { res.setHeader('Content-Type', 'application/json'); } catch (_) {}
        try { return res.status(500).json({ error: 'Failed to establish upstream' }); } catch (_) { try { res.end(); } catch (_) {} return; }
      }
      if (state && state.__error) {
        const status = state.status || 500;
        const payload = state.response || { error: state.message || 'Failed to start upstream' };
        try { res.setHeader('Content-Type', 'application/json'); } catch (_) {}
        try { return res.status(status).json(payload); } catch (_) { try { res.end(); } catch (_) {} return; }
      }
    } catch (error) {
      logger.error(`[${this.name}] Error in addSubscriber for key=${key}:`, error);
      try { res.setHeader('Content-Type', 'application/json'); } catch (_) {}
      try { return res.status(500).json({ error: 'Internal server error', details: error.message }); } catch (_) { try { res.end(); } catch (_) {} return; }
    }
    
    // Check if this exact response object is already subscribed (shouldn't happen, but defensive)
    if (state.subscribers.has(res)) {
      logger.debug(`[${this.name}] ⚠️  Response object already subscribed for userId=${userId}, key=${key}. Ignoring duplicate.`);
      return; // Don't add the same response twice
    }
    
    // Tag the response object for debugging
    res._connectionId = connectionId;
    res._subscribedAt = Date.now();
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add the new subscriber (supports multiple concurrent subscribers per key)
    state.subscribers.add(res);
    const now = new Date().toISOString();
    logger.debug(`[${this.name}] [${now}] ✅ Subscriber added for userId=${userId}, key=${key}. Subscribers=${state.subscribers.size}. Active upstreams=${this.keyToConnection.size} [connId=${connectionId}]`);
    
    // If joining an existing stream that has already sent data, notify the client to fetch historical data
    if (isJoiningExistingStream) {
      const lateJoinerNotification = JSON.stringify({ LateJoin: true }) + '\n';
      
      try {
        res.write(lateJoinerNotification);
        logger.debug(`[${this.name}] [${now}] 📢 Sent late joiner notification to subscriber for key=${key} [connId=${connectionId}]`);
      } catch (writeErr) {
        logger.error(`[${this.name}] Failed to send late joiner notification for key=${key}:`, writeErr.message);
      }
    }

    let cleanupDone = false;
    const onClose = (reason) => {
      if (cleanupDone) return; // Prevent multiple cleanups from different events
      cleanupDone = true;
      
      const wasInSet = state.subscribers.has(res);
      try { state.subscribers.delete(res); } catch (_) {}
      
      if (wasInSet) {
        const now = new Date().toISOString();
        const duration = Date.now() - (res._subscribedAt || 0);
        logger.debug(`[${this.name}] [${now}] 🔌 Subscriber disconnected (${reason || 'close'}) for userId=${userId}, key=${key}. Remaining=${state.subscribers.size} [connId=${connectionId}, duration=${duration}ms]`);
      }
      
      if (state.subscribers.size === 0) {
        // Create cleanup promise to prevent race conditions on page refresh
        let resolveCleanup;
        const cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
        this.pendingCleanups.set(key, cleanupPromise);
        
        const now = new Date().toISOString();
        logger.debug(`[${this.name}] [${now}] 🧹 Closing upstream (no subscribers) for key=${key}`);
        try { 
          // Abort fetch connection
          this._safeAbort(state, key, 'No subscribers remaining');
          
          // Destroy wrapper stream
          if (state.readable && state.readable.destroy) {
            state.readable.destroy();
          }
          
          // Nullify references
          state.webStream = null;
          state.readable = null;
          state.upstream = null;
        } catch (err) {
          logger.error(`[${this.name}] Error destroying upstream for key=${key}:`, err.message);
        }
        this.keyToConnection.delete(key);
        
        // MEMORY FIX: Clean up user tracking maps when user has no more connections
        this._cleanupUserMapsIfEmpty(key);
        
        // Resolve cleanup promise to unblock any waiting new connections, then remove it
        try { resolveCleanup(); } catch (_) {}
        this.pendingCleanups.delete(key);
      }
    };
    
    // Listen to multiple events to ensure cleanup happens
    res.on('close', () => onClose('close'));
    res.on('finish', () => onClose('finish'));
    res.on('error', (err) => onClose('error'));
    
    // CRITICAL: Also listen for the request being aborted/closed
    // This catches cases where the client aborts but the response events don't fire immediately
    if (res.req) {
      res.req.on('close', () => {
        // Only trigger cleanup if the request closed but response hasn't ended
        if (!res.writableEnded && !res.finished) {
          onClose('req-close');
        }
      });
      res.req.on('aborted', () => {
        if (!res.writableEnded && !res.finished) {
          onClose('req-aborted');
        }
      });
    }
    
    // Defensive: Check if connection is already closed/aborted at subscription time
    if (res.req?.aborted || res.req?.destroyed) {
      logger.debug(`[${this.name}] ⚠️  Request already aborted/destroyed at subscription time for key=${key} [connId=${connectionId}]`);
      onClose('already-closed');
      return;
    }
    
    // Defensive: Set a timeout to detect stale connections (no activity for 5 minutes = probably dead)
    const staleCheckInterval = setInterval(() => {
      if (res.writableEnded || res.finished || res.req?.destroyed) {
        clearInterval(staleCheckInterval);
        // Connection is already ended, make sure cleanup happened
        if (state.subscribers.has(res)) {
          logger.debug(`[${this.name}] ⚠️  Detected stale ended connection still in subscribers set for key=${key} [connId=${connectionId}]`);
          onClose('stale-detection');
        }
      }
    }, 60000); // Check every 60 seconds
    
    // Clear interval when connection closes
    const originalOnClose = onClose;
    const wrappedOnClose = (reason) => {
      clearInterval(staleCheckInterval);
      originalOnClose(reason);
    };
    
    // Replace the onClose references with wrapped version
    res.removeAllListeners('close');
    res.removeAllListeners('finish');
    res.removeAllListeners('error');
    res.on('close', () => wrappedOnClose('close'));
    res.on('finish', () => wrappedOnClose('finish'));
    res.on('error', (err) => wrappedOnClose('error'));
    if (res.req) {
      res.req.on('close', () => {
        if (!res.writableEnded && !res.finished) {
          wrappedOnClose('req-close');
        }
      });
      res.req.on('aborted', () => {
        if (!res.writableEnded && !res.finished) {
          wrappedOnClose('req-aborted');
        }
      });
    }
  }

  /**
   * Add a subscriber while enforcing only one active upstream per user.
   * If the computed key changes for this user, close the old upstream first.
   */
  async addExclusiveSubscriber(userId, deps, res) {
    try {
      const nextKey = this.makeKey(userId, deps);
      const prevKey = this.userToLastKey.get(userId);
      
      // Track last switch time to detect rapid reconnections
      if (!this.userLastSwitch) this.userLastSwitch = new Map();
      const lastSwitchTime = this.userLastSwitch.get(userId) || 0;
      const timeSinceLastSwitch = Date.now() - lastSwitchTime;
      
      if (prevKey && prevKey !== nextKey) {
        // Log warning if switching too rapidly (less than 500ms since last switch)
        if (timeSinceLastSwitch < 500) {
          logger.debug(`[${this.name}] ⚠️  User ${userId} rapidly switching streams (${timeSinceLastSwitch}ms since last switch). Consider debouncing on frontend.`);
        } else {
          logger.debug(`[${this.name}] User ${userId} switching from key=${prevKey} to key=${nextKey}, closing old stream...`);
        }
        try { await this.closeKey(prevKey); } catch (e) {
          logger.debug(`[${this.name}] Error closing previous key=${prevKey}:`, e?.message);
        }
        this.userLastSwitch.set(userId, Date.now());
      }
      
      this.userToLastKey.set(userId, nextKey);
      return await this.addSubscriber(userId, deps, res);
    } catch (error) {
      logger.error(`[${this.name}] Error in addExclusiveSubscriber for userId=${userId}:`, error);
      try { res.setHeader('Content-Type', 'application/json'); } catch (_) {}
      try { return res.status(500).json({ error: 'Internal server error', details: error.message }); } catch (_) { try { res.end(); } catch (_) {} return; }
    }
  }

  /**
   * Force-close a specific upstream by key, ending all subscribers.
   * Safe to call if key does not exist.
   * Returns a promise that resolves when cleanup is complete.
   */
  async closeKey(key) {
    const state = this.keyToConnection.get(key);
    if (!state) return;
    
    // Create cleanup promise for thread-safety
    let resolveCleanup;
    const cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
    this.pendingCleanups.set(key, cleanupPromise);
    
    // Abort fetch connection
    this._safeAbort(state, key, 'Force closed');
    
    // Destroy wrapper stream
    try {
      if (state.readable && state.readable.destroy) state.readable.destroy();
    } catch (_) {}
    
    // Close all subscribers
    try {
      for (const res of state.subscribers) { try { res.end(); } catch (_) {} }
    } catch (_) {}
    try { state.subscribers && state.subscribers.clear && state.subscribers.clear(); } catch (_) {}
    
    // Nullify references
    try {
      state.webStream = null;
      state.readable = null;
      state.upstream = null;
    } catch (_) {}
    
    this.keyToConnection.delete(key);
    logger.debug(`[${this.name}] Force-closed upstream for key=${key}. Active upstreams=${this.keyToConnection.size}`);
    
    // MEMORY FIX: Clean up user tracking maps when user has no more connections
    this._cleanupUserMapsIfEmpty(key);
    
    // Resolve cleanup promise to unblock any waiting new connections
    try { resolveCleanup(); } catch (_) {}
    
    // Wait a tick to ensure all cleanup events have propagated
    await new Promise(resolve => setImmediate(resolve));
    
    this.pendingCleanups.delete(key);
  }

  /**
   * Get diagnostic information about all active streams and their subscribers.
   * Useful for debugging connection leaks.
   * @returns {Array<{key: string, subscriberCount: number, subscribers: Array<{connectionId: string, duration: number, active: boolean}>}>}
   */
  getDebugInfo() {
    const info = [];
    for (const [key, state] of this.keyToConnection.entries()) {
      const subscribers = [];
      for (const res of state.subscribers) {
        const connectionId = res._connectionId || 'unknown';
        const subscribedAt = res._subscribedAt || 0;
        const duration = Date.now() - subscribedAt;
        const active = !(res.writableEnded || res.finished || res.destroyed || res.req?.destroyed);
        subscribers.push({ connectionId, duration, active });
      }
      info.push({
        key,
        subscriberCount: state.subscribers.size,
        subscribers
      });
    }
    return info;
  }

  /**
   * Clean up any stale/dead connections that are still in the subscribers set.
   * This is a defensive cleanup that shouldn't normally be needed, but can help
   * recover from connection tracking bugs.
   * @returns {number} Number of stale connections removed
   */
  cleanupStaleConnections() {
    let removed = 0;
    let upstreamsDestroyed = 0;
    
    for (const [key, state] of this.keyToConnection.entries()) {
      const stale = [];
      for (const res of state.subscribers) {
        // Consider a connection stale if it's been ended/destroyed but still in the set
        if (res.writableEnded || res.finished || res.destroyed || res.req?.destroyed || res.req?.aborted) {
          stale.push(res);
        }
      }
      
      for (const res of stale) {
        state.subscribers.delete(res);
        removed++;
        const connectionId = res._connectionId || 'unknown';
        logger.debug(`[${this.name}] 🧹 Removed stale connection from subscribers set: ${connectionId} for key=${key}`);
      }
      
      // If no subscribers left after cleanup, close the upstream
      if (state.subscribers.size === 0 && stale.length > 0) {
        logger.debug(`[${this.name}] 🧹 No subscribers remaining after stale cleanup, closing upstream for key=${key}`);
        try {
          // Abort fetch connection
          this._safeAbort(state, key, 'Stale cleanup');
          
          // Destroy wrapper stream
          if (state.readable && state.readable.destroy) {
            state.readable.destroy();
          }
          
          // Nullify references
          state.webStream = null;
          state.readable = null;
          state.upstream = null;
        } catch (_) {}
        this.keyToConnection.delete(key);
        upstreamsDestroyed++;
      }
    }
    
    if (removed > 0 || upstreamsDestroyed > 0) {
      logger.debug(`[${this.name}] 🧹 Cleaned up ${removed} stale connection(s) and ${upstreamsDestroyed} orphaned upstream(s). Active upstreams: ${this.keyToConnection.size}`);
    }
    
    return removed;
  }

  /**
   * Start periodic cleanup of stale connections (every 60 seconds)
   * This helps recover from any connection tracking issues automatically
   */
  startPeriodicCleanup(intervalMs = 60000) {
    if (this._cleanupInterval) {
      return; // Already started
    }
    
    logger.debug(`[${this.name}] Starting periodic stale connection cleanup (every ${intervalMs}ms)`);
    
    this._cleanupInterval = setInterval(() => {
      try {
        const removed = this.cleanupStaleConnections();
        
        // Log warning if we have too many active upstreams
        const upstreamCount = this.keyToConnection.size;
        if (upstreamCount > 20) {
          logger.debug(`[${this.name}] ⚠️  HIGH UPSTREAM COUNT: ${upstreamCount} active upstreams. This may indicate a leak.`);
        }
      } catch (err) {
        logger.error(`[${this.name}] Error during periodic cleanup:`, err);
      }
    }, intervalMs);
    
    // Don't prevent Node.js from exiting
    if (this._cleanupInterval.unref) {
      this._cleanupInterval.unref();
    }
  }

  /**
   * Stop periodic cleanup
   */
  stopPeriodicCleanup() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
      logger.debug(`[${this.name}] Stopped periodic cleanup`);
    }
  }

  /**
   * MEMORY FIX: Clean up user tracking maps when a user has no more active connections.
   * Extracts userId from key (format: "userId|...") and checks if any connections remain.
   * @param {string} closedKey - The key that was just closed
   */
  _cleanupUserMapsIfEmpty(closedKey) {
    try {
      // Extract userId from key (format is typically "userId|...")
      const userId = closedKey.split('|')[0];
      if (!userId) return;
      
      // Check if this user has any remaining active connections
      let hasActiveConnections = false;
      for (const key of this.keyToConnection.keys()) {
        if (key.startsWith(`${userId}|`)) {
          hasActiveConnections = true;
          break;
        }
      }
      
      // If no active connections, clean up user tracking maps
      if (!hasActiveConnections) {
        const hadLastKey = this.userToLastKey.has(userId);
        const hadLastSwitch = this.userLastSwitch && this.userLastSwitch.has(userId);
        
        this.userToLastKey.delete(userId);
        if (this.userLastSwitch) {
          this.userLastSwitch.delete(userId);
        }
        
        if (hadLastKey || hadLastSwitch) {
          logger.debug(`[${this.name}] 🧹 Cleaned up user tracking maps for userId=${userId} (no active connections)`);
        }
      }
    } catch (err) {
      // Don't let cleanup errors affect main flow
      logger.error(`[${this.name}] Error in _cleanupUserMapsIfEmpty:`, err.message);
    }
  }
}

module.exports = { StreamMultiplexer };


