// Native fetch is available in Node.js 18+
const { Readable } = require('stream');
const { buildUrl, getUserAccessToken } = require('./tradestationProxy');
const { refreshAccessTokenForUserLocked } = require('./tokenRefresh');
const logger = require('../config/logging');

// Only log verbose stream details if DEBUG_STREAMS=true
const VERBOSE_LOGGING = process.env.DEBUG_STREAMS === 'true';

// Configuration constants
const MAX_PENDING_OPENS = 10; // Maximum concurrent stream open attempts
const MAX_SUBSCRIBERS_PER_KEY = 100; // Maximum subscribers per upstream
const UPSTREAM_TIMEOUT_MS = 15000; // Timeout for opening upstream connection
const UPSTREAM_ACTIVITY_TIMEOUT_MS = 30000; // Close upstream if no data for 30 seconds
const INITIAL_DATA_TIMEOUT_MS = 10000; // Close if no initial data received within 10 seconds
const STALE_PENDING_THRESHOLD_MS = 20000; // Consider pending open stale after 20s
const PERIODIC_CLEANUP_INTERVAL_MS = 60000; // Run cleanup every 60 seconds

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
    
    /** @type {Map<string, { key: string, subscribers: Set<any>, upstream: any, webStream: any, readable: any, abortController: AbortController|null, timeoutController: AbortController|null, aborted: boolean, lastActivityAt: number, firstDataSent: boolean, activityCheckInterval?: NodeJS.Timeout, initialDataTimeout?: NodeJS.Timeout }>} */
    this.keyToConnection = new Map();
    
    /** @type {Map<string, Promise<void>>} */
    this.pendingOpens = new Map();
    
    /** @type {Map<string, number>} Timestamp when pending open started */
    this.pendingOpensTimestamps = new Map();
    
    /** @type {Map<string, Promise<void>>} */
    this.pendingCleanups = new Map();
    
    /**
     * Tracks the most recent key per user for streams that should be exclusive
     * (one active upstream per user). Used by addExclusiveSubscriber.
     * @type {Map<string, string>}
     */
    this.userToLastKey = new Map();
    
    /**
     * Tracks last switch time per user to detect rapid reconnections
     * @type {Map<string, number>}
     */
    this.userLastSwitch = new Map();
    
    /**
     * Atomic counter to prevent pending opens race condition
     * @type {number}
     */
    this.pendingOpensCount = 0;
  }

  /**
   * SIMPLIFIED CLEANUP: Single method to destroy a connection completely
   * Handles all cleanup logic in one place to prevent race conditions
   * @param {string} key - The connection key
   * @param {string} reason - Reason for destruction
   * @param {Error|null} error - Optional error that triggered cleanup
   */
  _destroyConnection(key, reason, error = null) {
    const state = this.keyToConnection.get(key);
    if (!state) {
      return; // Already cleaned up
    }
    
    // Determine if this is an expected termination or an actual error
    const isExpectedTermination = error && (
      error.message === 'terminated' ||
      error.code === 'ABORT_ERR' ||
      error.name === 'AbortError' ||
      (error.cause && error.cause.code === 'ERR_HTTP2_STREAM_ERROR')
    );
    
    if (error && !isExpectedTermination) {
      // Unexpected error - log as error
      logger.error(`[${this.name}] Destroying connection for key=${key}: ${reason}`, error);
    } else if (VERBOSE_LOGGING) {
      // Expected termination or normal close - log as debug
      if (error) {
        logger.debug(`[${this.name}] Destroying connection for key=${key}: ${reason} (expected: ${error.message})`);
      } else {
        logger.debug(`[${this.name}] Destroying connection for key=${key}: ${reason}`);
      }
    }
    
    // Step 1: Mark as aborted to prevent duplicate cleanup
    if (state.aborted) {
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Connection already aborted for key=${key}`);
      return;
    }
    state.aborted = true;
    
    // Step 2: Close all subscribers
    for (const res of state.subscribers) {
      try { res.end(); } catch (_) {}
    }
    state.subscribers.clear();
    
    // Step 3: Clear timers
    if (state.activityCheckInterval) {
      clearInterval(state.activityCheckInterval);
      state.activityCheckInterval = undefined;
    }
    if (state.initialDataTimeout) {
      clearTimeout(state.initialDataTimeout);
      state.initialDataTimeout = undefined;
    }
    
    // Step 4: Abort fetch connection FIRST via AbortController
    // CRITICAL: Abort BEFORE destroying streams to avoid undici race condition
    // If we destroy streams first, undici gets into inconsistent state and crashes with "Cannot read properties of null"
    // ALSO CRITICAL: Defer abort to next tick to allow undici's HTTP/2 internal state to update
    // Otherwise we get assertion failures: assert(client[kRunning] === 0)
    if (state.abortController && !state.abortController.signal.aborted) {
      try {
        // Defer abort to next tick to let undici update internal state
        // This prevents HTTP/2 GOAWAY race condition where kRunning > 0
        setImmediate(() => {
          try {
            if (!state.abortController.signal.aborted) {
              state.abortController.abort(reason);
            }
          } catch (deferredAbortErr) {
            // Ignore - connection might already be closed
            if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Deferred abort error (ignored) for key=${key}:`, deferredAbortErr.message);
          }
        });
      } catch (abortErr) {
        if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Abort error (ignored) for key=${key}:`, abortErr.message);
      }
    }
    
    // Step 5: Clean up manual timeout controller
    if (state.timeoutController && !state.timeoutController.signal.aborted) {
      try {
        state.timeoutController.abort();
      } catch (_) {}
    }
    
    // Step 6: Drain buffered data before destroying stream
    // This ensures underlying system (undici) can properly release buffers
    if (state.readable && !state.readable.destroyed) {
      try {
        // Remove all listeners first to stop broadcasting
        state.readable.removeAllListeners('data');
        state.readable.removeAllListeners('end');
        state.readable.removeAllListeners('error');
        
        // Resume stream to drain any buffered data (non-blocking)
        if (typeof state.readable.resume === 'function') {
          state.readable.resume();
        }
        
        // Now destroy the stream after resuming
        state.readable.destroy(error);
      } catch (drainErr) {
        if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Stream drain error (ignored) for key=${key}:`, drainErr.message);
      }
    }
    
    // Step 7: Try to cancel web stream if it's not locked (usually not needed after abort)
    if (state.webStream && typeof state.webStream.cancel === 'function') {
      try {
        if (!state.webStream.locked) {
          state.webStream.cancel();
        }
      } catch (cancelErr) {
        // Expected to fail if stream is locked - this is fine
      }
    }
    
    // Step 8: Nullify all references to help GC
    state.abortController = null;
    state.timeoutController = null;
    state.webStream = null;
    state.readable = null;
    state.upstream = null;
    
    // Step 9: Remove from connections map
    this.keyToConnection.delete(key);
    
    // Step 10: Clean up user tracking maps if user has no more connections
    this._cleanupUserMapsIfEmpty(key);
    
    if (VERBOSE_LOGGING) {
      logger.debug(`[${this.name}] Connection destroyed for key=${key}. Active upstreams: ${this.keyToConnection.size}`);
    }
  }

  async ensureUpstream(userId, deps) {
    const key = this.makeKey(userId, deps);
    
    // Wait for any pending cleanup to complete before opening new stream
    // CRITICAL: Add timeout to prevent infinite hang if cleanup promise never resolves
    const pendingCleanup = this.pendingCleanups.get(key);
    if (pendingCleanup) {
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Waiting for cleanup to complete for key=${key}...`);
      try {
        // Race cleanup promise against 2-second timeout
        await Promise.race([
          pendingCleanup,
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]);
      } catch (_) {}
      
      // If cleanup is still pending after timeout, force delete it
      if (this.pendingCleanups.has(key)) {
        logger.debug(`[${this.name}] ⚠️ Cleanup timed out for key=${key}, forcing cleanup promise deletion`);
        this.pendingCleanups.delete(key);
      }
      
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Cleanup complete for key=${key}`);
    }
    
    // Check if upstream already exists and is healthy
    const entry = this.keyToConnection.get(key);
    if (entry && entry.upstream && !entry.aborted) {
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Reusing upstream for key=${key}`);
      return entry;
    }
    
    // Wait for any in-flight open to complete
    const inFlight = this.pendingOpens.get(key);
    if (inFlight) {
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Awaiting pending upstream open for key=${key}`);
      try { 
        await inFlight; 
      } catch (e) { 
        if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Pending open failed for key=${key}:`, e && e.message);
        const after = this.keyToConnection.get(key);
        if (!after || !after.upstream || after.aborted) {
          return { __error: true, status: 503, response: { error: 'Service temporarily unavailable', details: 'Previous stream attempt failed' }, message: 'Pending open failed' };
        }
      }
      const after = this.keyToConnection.get(key);
      if (after && after.upstream && !after.aborted) {
        if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Reusing just-opened upstream for key=${key}`);
        return after;
      }
    }

    // ATOMIC RATE LIMIT PROTECTION
    if (this.pendingOpensCount >= MAX_PENDING_OPENS) {
      logger.debug(`[${this.name}] 🚫 Too many pending opens (${this.pendingOpensCount}), rejecting new request for key=${key}`);
      return { __error: true, status: 503, response: { error: 'Service temporarily unavailable', details: 'Too many concurrent stream requests' }, message: 'Rate limited' };
    }
    
    // Atomically increment pending opens counter
    this.pendingOpensCount++;
    
    let resolveLock, rejectLock;
    const creationLock = new Promise((resolve, reject) => { resolveLock = resolve; rejectLock = reject; });
    // Prevent unhandled rejection if no one awaits this promise
    creationLock.catch(() => {});
    this.pendingOpens.set(key, creationLock);
    this.pendingOpensTimestamps.set(key, Date.now());
    
    // Create AbortControllers before try block
    const connectionAbort = new AbortController();
    const timeoutAbort = new AbortController();
    const timeoutHandle = setTimeout(() => {
      timeoutAbort.abort('Connection timeout');
    }, UPSTREAM_TIMEOUT_MS);
    
    // CRITICAL: Safety timeout to force-fail stuck pending opens after 20 seconds
    // This prevents infinite hangs if fetch never returns
    const safetyTimeoutHandle = setTimeout(() => {
      logger.debug(`[${this.name}] 🚨 SAFETY TIMEOUT: Pending open stuck for 20s, force-aborting key=${key}`);
      try { connectionAbort.abort('Safety timeout'); } catch (_) {}
      try { timeoutAbort.abort('Safety timeout'); } catch (_) {}
    }, 20000);
    
    // CRITICAL: Use try-finally to GUARANTEE cleanup even if unexpected error occurs
    try {
      return await this._attemptStreamOpen(userId, deps, key, resolveLock, rejectLock, connectionAbort, timeoutAbort, timeoutHandle);
    } finally {
      // ALWAYS clean up pending state, even if exception thrown
      clearTimeout(safetyTimeoutHandle);
      this.pendingOpens.delete(key);
      this.pendingOpensTimestamps.delete(key);
      this.pendingOpensCount--;
    }
  }
  
  async _attemptStreamOpen(userId, deps, key, resolveLock, rejectLock, connectionAbort, timeoutAbort, timeoutHandle) {
    const { path, paperTrading = false, query } = this.buildRequest(userId, deps) || {};
    if (!path) {
      const err = { __error: true, status: 400, response: { error: 'Missing path for upstream request' }, message: 'Invalid upstream request' };
      try { rejectLock(err); } catch (_) {}
      return err;
    }
    
    let accessToken;
    try {
      accessToken = await getUserAccessToken(userId);
    } catch (tokenErr) {
      const err = { __error: true, status: 401, response: { error: 'Unauthorized', details: tokenErr && tokenErr.message }, message: 'Failed to acquire access token' };
      try { rejectLock(err); } catch (_) {}
      return err;
    }
    const url = buildUrl(!!paperTrading, path, query);
    
    let upstream;
    try {
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Opening upstream for key=${key}`);
      
      // Combine signals manually to avoid AbortSignal.any() leak
      const combinedSignal = connectionAbort.signal;
      const timeoutSignal = timeoutAbort.signal;
      
      // Listen to timeout signal to abort connection
      const timeoutListener = () => connectionAbort.abort('Timeout');
      timeoutSignal.addEventListener('abort', timeoutListener);
      
      try {
        upstream = await fetch(url, { 
          method: 'GET', 
          headers: { 'Authorization': `Bearer ${accessToken}` },
          signal: combinedSignal
        });
      } finally {
        // Clean up timeout immediately after fetch completes/fails
        clearTimeout(timeoutHandle);
        timeoutSignal.removeEventListener('abort', timeoutListener);
        timeoutAbort.abort(); // Clean up timeout controller
      }
      
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] TradeStation API responded (status: ${upstream.status}) for key=${key}`);
      
      // Handle 401 with token refresh and retry
      if (!upstream.ok && upstream.status === 401) {
        try {
          await refreshAccessTokenForUserLocked(userId);
          if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Retrying upstream open after token refresh for key=${key}`);
          
          // Create new timeout for retry
          const retryTimeoutAbort = new AbortController();
          const retryTimeoutHandle = setTimeout(() => {
            retryTimeoutAbort.abort('Retry timeout');
          }, UPSTREAM_TIMEOUT_MS);
          
          const retryTimeoutListener = () => connectionAbort.abort('Retry timeout');
          retryTimeoutAbort.signal.addEventListener('abort', retryTimeoutListener);
          
          try {
            upstream = await fetch(url, { 
              method: 'GET', 
              headers: { 'Authorization': `Bearer ${await getUserAccessToken(userId)}` },
              signal: connectionAbort.signal
            });
          } finally {
            clearTimeout(retryTimeoutHandle);
            retryTimeoutAbort.signal.removeEventListener('abort', retryTimeoutListener);
            retryTimeoutAbort.abort();
          }
        } catch (refreshErr) {
          // Token refresh failed, continue with original 401 response
        }
      }
    } catch (networkErr) {
      const isTimeout = networkErr.name === 'AbortError' || networkErr.name === 'TimeoutError' || networkErr.message?.includes('timeout');
      const status = isTimeout ? 504 : 502;
      const errorType = isTimeout ? 'Gateway Timeout' : 'Bad Gateway';
      
      // Log TradeStation API errors for debugging
      if (!isTimeout) {
        logger.debug(`[${this.name}] 🔴 TradeStation API error for key=${key}: ${networkErr.message} (name: ${networkErr.name}, code: ${networkErr.code}). Active: ${this.keyToConnection.size}, Pending: ${this.pendingOpensCount}`);
        
        // Special handling for "invalid_argument" - likely rate limit or temporary TradeStation issue
        if (networkErr.message === 'invalid_argument') {
          logger.debug(`[${this.name}] ⚠️  TradeStation returned "invalid_argument" - may be rate limited or temporary API issue. Will retry automatically on next attempt.`);
        }
      } else {
        logger.debug(`[${this.name}] ⏱️  Timeout opening upstream for key=${key}. Active: ${this.keyToConnection.size}, Pending: ${this.pendingOpensCount}`);
      }
      
      const err = { __error: true, status, response: { error: errorType, details: networkErr && networkErr.message }, message: `Upstream fetch failed: ${errorType}` };
      try { rejectLock(err); } catch (_) {}
      
      // Clean up abort controllers
      try { connectionAbort.abort('Fetch failed'); } catch (_) {}
      try { clearTimeout(timeoutHandle); timeoutAbort.abort(); } catch (_) {}
      
      return err;
    }

    if (!upstream || !upstream.ok) {
      let text = '';
      try { text = upstream && upstream.text ? await upstream.text() : ''; } catch (_) {}
      let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      const status = upstream && typeof upstream.status === 'number' ? upstream.status : 500;
      const friendly = status === 403 ? 'Forbidden' : (status === 429 ? 'Rate limited' : (status === 404 ? 'Not found' : 'Upstream not OK'));
      const err = { __error: true, status: status, response: (data && Object.keys(data).length ? data : { error: friendly }), message: friendly };
      try { rejectLock(err); } catch (_) {}
      
      // Clean up abort controllers
      try { connectionAbort.abort('Upstream not OK'); } catch (_) {}
      
      return err;
    }

    // Check if user's exclusive key changed while we were opening
    const lastKey = this.userToLastKey.get(userId);
    if (lastKey && lastKey !== key) {
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Abandoning stale upstream for key=${key}`);
      try { upstream.body && upstream.body.cancel && upstream.body.cancel(); } catch (_) {}
      try { connectionAbort.abort('Stale upstream'); } catch (_) {}
      try { resolveLock(); } catch (_) {}
      return { __error: true, status: 409, response: { error: 'Stale upstream (key changed during open)' }, message: 'Stale upstream' };
    }

    // Convert Web ReadableStream to Node.js stream
    const webStream = upstream.body;
    const readable = Readable.fromWeb(webStream);
    
    const state = { 
      key, 
      subscribers: new Set(), 
      upstream: upstream,
      webStream: webStream,
      readable: readable,
      abortController: connectionAbort,
      timeoutController: null, // Already cleaned up
      aborted: false,
      lastActivityAt: Date.now(), 
      firstDataSent: false 
    };
    this.keyToConnection.set(key, state);

    // Set up data handler - broadcast synchronously to avoid setImmediate queue buildup
    const dataHandler = (chunk) => {
      if (state.aborted) return;
      
      state.lastActivityAt = Date.now();
      
      if (!state.firstDataSent) {
        state.firstDataSent = true;
        // Clear initial data timeout since we received data
        if (state.initialDataTimeout) {
          clearTimeout(state.initialDataTimeout);
          state.initialDataTimeout = undefined;
        }
        if (VERBOSE_LOGGING) logger.debug(`[${this.name}] First data sent for key=${key}`);
      }
      
      // CRITICAL: Destroy immediately if no subscribers (zombie stream)
      // Don't waste cycles processing data that nobody is listening to
      if (state.subscribers.size === 0) {
        if (VERBOSE_LOGGING) {
          logger.debug(`[${this.name}] 🧟 Zombie detected in data handler (0 subscribers), destroying immediately: ${key}`);
        }
        // Destroy on next tick to avoid modifying state during event handler
        setImmediate(() => this._destroyConnection(key, 'Zombie - no subscribers in data handler'));
        return;
      }
      
      // DEBUG: Log position data for duplicate detection
      if (this.name === 'Positions' && process.env.DEBUG_POSITION_DUPLICATES === 'true') {
        try {
          const chunkStr = chunk.toString('utf8');
          const lines = chunkStr.split('\n').filter(line => line.trim());
          lines.forEach(line => {
            try {
              const data = JSON.parse(line);
              if (data.PositionID) {
                logger.debug(`[${this.name}] Broadcasting position update:`, {
                  PositionID: data.PositionID,
                  Symbol: data.Symbol,
                  Quantity: data.Quantity,
                  subscriberCount: state.subscribers.size,
                  key
                });
              }
            } catch (_) {}
          });
        } catch (_) {}
      }
      
      // Broadcast synchronously to all subscribers
      // Track dead subscribers to remove them after iteration
      const deadSubscribers = [];
      for (const res of state.subscribers) { 
        // Check if response is still writable before attempting write
        if (!res.writable || res.writableEnded || res.finished || res.destroyed) {
          deadSubscribers.push(res);
          continue;
        }
        
        try { 
          res.write(chunk); 
        } catch (writeErr) {
          // Write failed - subscriber is dead
          deadSubscribers.push(res);
        }
      }
      
      // Remove dead subscribers and trigger cleanup if needed
      if (deadSubscribers.length > 0) {
        for (const deadRes of deadSubscribers) {
          state.subscribers.delete(deadRes);
        }
        
        // If no subscribers left, destroy the upstream immediately
        if (state.subscribers.size === 0) {
          if (VERBOSE_LOGGING) {
            logger.debug(`[${this.name}] 🧹 Removed ${deadSubscribers.length} dead subscriber(s), closing upstream for key=${key}`);
          }
          // Destroy immediately to free up connection slot
          this._destroyConnection(key, 'All subscribers dead');
        } else if (VERBOSE_LOGGING) {
          logger.debug(`[${this.name}] Removed ${deadSubscribers.length} dead subscriber(s) for key=${key}, remaining=${state.subscribers.size}`);
        }
      }
    };
    
    // Set up cleanup handlers
    const endHandler = () => {
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Upstream ended for key=${key}`);
      this._destroyConnection(key, 'Upstream ended');
    };
    
    const errorHandler = (error) => {
      this._destroyConnection(key, 'Upstream error', error);
    };
    
    // Attach handlers
    readable.on('data', dataHandler);
    readable.once('end', endHandler);
    readable.once('error', errorHandler);
    
    // CRITICAL: Set timeout to detect streams that never send data (TradeStation accepts connection but doesn't stream)
    // This prevents accumulating zombie connections that count against rate limits
    state.initialDataTimeout = setTimeout(() => {
      if (!state.firstDataSent && !state.aborted) {
        logger.debug(`[${this.name}] ⏱️  No initial data received within ${INITIAL_DATA_TIMEOUT_MS}ms for key=${key}, closing (likely rate limited or invalid request)`);
        this._destroyConnection(key, 'No initial data timeout');
      }
    }, INITIAL_DATA_TIMEOUT_MS);
    
    // Don't prevent Node.js from exiting
    if (state.initialDataTimeout.unref) {
      state.initialDataTimeout.unref();
    }
    
    // Set up activity timeout check - destroy connection if no data for 30 seconds
    state.activityCheckInterval = setInterval(() => {
      if (state.aborted) {
        clearInterval(state.activityCheckInterval);
        return;
      }
      
      const idleTime = Date.now() - state.lastActivityAt;
      if (idleTime > UPSTREAM_ACTIVITY_TIMEOUT_MS) {
        logger.debug(`[${this.name}] ⏱️  Upstream idle for ${Math.round(idleTime / 1000)}s, closing key=${key}`);
        this._destroyConnection(key, 'Activity timeout');
      }
    }, 30000); // Check every 30 seconds
    
    // Don't prevent Node.js from exiting
    if (state.activityCheckInterval.unref) {
      state.activityCheckInterval.unref();
    }

    try { resolveLock(); } catch (_) {}
    return state;
  }

  async addSubscriber(userId, deps, res) {
    const key = this.makeKey(userId, deps);
    
    // Extract stream epoch for connection tracking
    const streamEpoch = res.req?.query?._epoch || res.req?.headers?.['x-stream-epoch'] || '0';
    const connectionId = `${userId}|${key}|${streamEpoch}|${Date.now()}`;
    
    // EARLY ABORT DETECTION: Check if request is already aborted
    if (res.req?.aborted || res.req?.destroyed || res.finished || res.writableEnded) {
      if (VERBOSE_LOGGING) logger.debug(`[${this.name}] ⚠️  Request already aborted at entry for key=${key}`);
      try { res.end(); } catch (_) {}
      return;
    }
    
    // Check if upstream already exists BEFORE calling ensureUpstream
    const existingState = this.keyToConnection.get(key);
    const isJoiningExistingStream = existingState && existingState.upstream && existingState.firstDataSent && !existingState.aborted;
    
    let state;
    try {
      state = await this.ensureUpstream(userId, deps);
      
      // Re-check if request was aborted during ensureUpstream
      if (res.req?.aborted || res.req?.destroyed || res.finished || res.writableEnded) {
        if (VERBOSE_LOGGING) logger.debug(`[${this.name}] ⚠️  Request aborted during ensureUpstream for key=${key}`);
        try { res.end(); } catch (_) {}
        return;
      }
      
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
    
    // Check if already subscribed (defensive)
    if (state.subscribers.has(res)) {
      logger.debug(`[${this.name}] ⚠️  Response already subscribed for key=${key}`);
      return;
    }
    
    // Enforce max subscribers per key
    if (state.subscribers.size >= MAX_SUBSCRIBERS_PER_KEY) {
      logger.debug(`[${this.name}] 🚫 Max subscribers (${MAX_SUBSCRIBERS_PER_KEY}) reached for key=${key}`);
      try { res.setHeader('Content-Type', 'application/json'); } catch (_) {}
      try { return res.status(503).json({ error: 'Too many subscribers for this stream' }); } catch (_) { try { res.end(); } catch (_) {} return; }
    }
    
    // Tag the response object for debugging
    res._connectionId = connectionId;
    res._subscribedAt = Date.now();
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add the new subscriber
    state.subscribers.add(res);
    if (VERBOSE_LOGGING) logger.debug(`[${this.name}] ✓ Subscriber added for key=${key}, total=${state.subscribers.size}`);
    
    // If joining an existing stream that has already sent data, notify client to fetch historical data
    if (isJoiningExistingStream) {
      const lateJoinerNotification = JSON.stringify({ LateJoin: true }) + '\n';
      try {
        res.write(lateJoinerNotification);
        if (VERBOSE_LOGGING) logger.debug(`[${this.name}] Sent late joiner notification for key=${key}`);
      } catch (writeErr) {
        logger.error(`[${this.name}] Failed to send late joiner notification for key=${key}:`, writeErr.message);
      }
    }

    // SIMPLIFIED CLEANUP: Single cleanup function called from all events
    let cleanupDone = false;
    const onClose = (reason) => {
      if (cleanupDone) return;
      cleanupDone = true;
      
      const wasInSet = state.subscribers.has(res);
      state.subscribers.delete(res);
      
      // Log subscriber disconnections to debug zombie streams
      if (wasInSet && VERBOSE_LOGGING) {
        logger.debug(`[${this.name}] Subscriber disconnected (${reason}) for key=${key}, remaining=${state.subscribers.size}`);
      }
      
      // If no subscribers left, destroy the upstream connection
      if (state.subscribers.size === 0) {
        // Atomic cleanup: Only proceed if not already cleaning up
        // Use _destroyConnection's idempotency (aborted flag) for thread-safety
        const existingCleanup = this.pendingCleanups.get(key);
        if (existingCleanup) {
          // Already cleaning up, wait for it
          return;
        }
        
        // Create cleanup promise to prevent race conditions with new connections
        let resolveCleanup;
        const cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
        this.pendingCleanups.set(key, cleanupPromise);
        
        // Log cleanup only in verbose mode (normal behavior)
        if (VERBOSE_LOGGING) {
          logger.debug(`[${this.name}] 🧹 No subscribers remaining, closing upstream for key=${key}`);
        }
        
        try {
          this._destroyConnection(key, 'No subscribers remaining');
        } finally {
          // CRITICAL: Always resolve and remove cleanup promise, even if _destroyConnection returns early
          // This prevents infinite hangs when reconnecting to the same stream
          try { resolveCleanup(); } catch (_) {}
          this.pendingCleanups.delete(key);
        }
      }
    };
    
    // Attach event listeners ONCE - don't remove all listeners
    res.once('close', () => onClose('close'));
    res.once('finish', () => onClose('finish'));
    res.once('error', (err) => onClose('error'));
    
    // Also listen for request being aborted/closed
    if (res.req) {
      res.req.once('close', () => {
        if (!res.writableEnded && !res.finished) {
          onClose('req-close');
        }
      });
      res.req.once('aborted', () => {
        if (!res.writableEnded && !res.finished) {
          onClose('req-aborted');
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
      const lastSwitchTime = this.userLastSwitch.get(userId) || 0;
      const timeSinceLastSwitch = Date.now() - lastSwitchTime;
      
      if (prevKey && prevKey !== nextKey) {
        if (timeSinceLastSwitch < 500) {
          logger.debug(`[${this.name}] ⚠️  User ${userId} rapidly switching streams (${timeSinceLastSwitch}ms since last switch)`);
        } else {
          logger.debug(`[${this.name}] User ${userId} switching from key=${prevKey} to key=${nextKey}`);
        }
        
        // Throttle rapid switches to prevent undici HTTP/2 race conditions
        // If switching too fast (< 100ms), wait a bit to let undici clean up
        const MIN_SWITCH_DELAY_MS = 100;
        if (timeSinceLastSwitch < MIN_SWITCH_DELAY_MS) {
          const waitTime = MIN_SWITCH_DELAY_MS - timeSinceLastSwitch;
          logger.debug(`[${this.name}] Throttling rapid switch, waiting ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
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
   * Returns a promise that resolves when cleanup is complete.
   */
  async closeKey(key) {
    const state = this.keyToConnection.get(key);
    if (!state) return;
    
    // Only proceed if no cleanup already in progress (atomic check)
    if (this.pendingCleanups.has(key)) {
      // Wait for existing cleanup with timeout to prevent hang
      try {
        await Promise.race([
          this.pendingCleanups.get(key),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]);
      } catch (_) {}
      
      // If cleanup is still pending after timeout, force delete it
      if (this.pendingCleanups.has(key)) {
        logger.debug(`[${this.name}] ⚠️ Cleanup timed out in closeKey for key=${key}, forcing deletion`);
        this.pendingCleanups.delete(key);
      }
      return;
    }
    
    // Create cleanup promise for thread-safety
    let resolveCleanup;
    const cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
    this.pendingCleanups.set(key, cleanupPromise);
    
    logger.debug(`[${this.name}] Force-closing upstream for key=${key}`);
    
    try {
      this._destroyConnection(key, 'Force closed');
      
      // Wait a bit longer to ensure all cleanup events have propagated and undici has settled
      // This prevents HTTP/2 GOAWAY race conditions (assert(client[kRunning] === 0))
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      // CRITICAL: Always resolve and remove cleanup promise
      try { resolveCleanup(); } catch (_) {}
      this.pendingCleanups.delete(key);
    }
  }

  /**
   * Get diagnostic information about all active streams and their subscribers.
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
        aborted: state.aborted,
        lastActivity: Date.now() - state.lastActivityAt,
        subscribers
      });
    }
    return info;
  }

  /**
   * Clean up any stale/dead connections that are still in the subscribers set.
   */
  cleanupStaleConnections() {
    let removed = 0;
    let upstreamsDestroyed = 0;
    
    for (const [key, state] of this.keyToConnection.entries()) {
      const stale = [];
      for (const res of state.subscribers) {
        if (res.writableEnded || res.finished || res.destroyed || res.req?.destroyed || res.req?.aborted) {
          stale.push(res);
        }
      }
      
      for (const res of stale) {
        state.subscribers.delete(res);
        removed++;
        const connectionId = res._connectionId || 'unknown';
        logger.debug(`[${this.name}] 🧹 Removed stale connection: ${connectionId} for key=${key}`);
      }
      
      // If no subscribers left after cleanup, destroy the upstream
      if (state.subscribers.size === 0 && stale.length > 0) {
        logger.debug(`[${this.name}] 🧹 No subscribers after stale cleanup, destroying upstream for key=${key}`);
        this._destroyConnection(key, 'Stale cleanup');
        upstreamsDestroyed++;
      }
    }
    
    if (removed > 0 || upstreamsDestroyed > 0) {
      logger.debug(`[${this.name}] 🧹 Cleaned up ${removed} stale connection(s), ${upstreamsDestroyed} upstream(s). Active: ${this.keyToConnection.size}`);
    }
    
    return removed;
  }

  /**
   * Clean up stale pending opens that have been stuck for too long
   */
  cleanupStalePendingOpens() {
    const now = Date.now();
    let removed = 0;
    
    for (const [key, timestamp] of this.pendingOpensTimestamps.entries()) {
      if (!this.pendingOpens.has(key)) {
        // Already cleaned up normally
        this.pendingOpensTimestamps.delete(key);
        continue;
      }
      
      if (now - timestamp > STALE_PENDING_THRESHOLD_MS) {
        logger.debug(`[${this.name}] 🧹 Removing stale pending open for key=${key} (stuck for ${Math.round((now - timestamp) / 1000)}s)`);
        this.pendingOpens.delete(key);
        this.pendingOpensTimestamps.delete(key);
        // Decrement counter to keep it accurate
        if (this.pendingOpensCount > 0) {
          this.pendingOpensCount--;
        }
        removed++;
      }
    }
    
    return removed;
  }

  /**
   * Start periodic cleanup of stale connections
   */
  startPeriodicCleanup(intervalMs = PERIODIC_CLEANUP_INTERVAL_MS) {
    if (this._cleanupInterval) {
      return; // Already started
    }
    
    logger.debug(`[${this.name}] Starting periodic cleanup (every ${intervalMs}ms)`);
    
    this._cleanupInterval = setInterval(() => {
      try {
        const removed = this.cleanupStaleConnections();
        const stalePending = this.cleanupStalePendingOpens();
        
        // CRITICAL: Clean up zombie upstreams (0 subscribers but still active)
        let zombiesRemoved = 0;
        for (const [key, state] of this.keyToConnection.entries()) {
          if (state.subscribers.size === 0) {
            // Destroy immediately - no grace period needed
            // These are taking up connection slots and causing rate limits
            logger.warn(`[${this.name}] 🧟 Destroying zombie upstream (0 subscribers): ${key}`);
            this._destroyConnection(key, 'Zombie cleanup - no subscribers');
            zombiesRemoved++;
          }
        }
        
        const upstreamCount = this.keyToConnection.size;
        const pendingCount = this.pendingOpensCount;
        
        // Only log concerning situations
        if (upstreamCount > 20) {
          logger.warn(`[${this.name}] ⚠️  HIGH UPSTREAM COUNT: ${upstreamCount} active upstreams (possible leak)`);
        }
        
        if (pendingCount > 5) {
          logger.warn(`[${this.name}] ⚠️  HIGH PENDING OPENS: ${pendingCount} pending opens (possible rate limit)`);
        }
        
        if (stalePending > 0) {
          logger.warn(`[${this.name}] 🧹 Cleaned up ${stalePending} stale pending open(s)`);
        }
        
        if (zombiesRemoved > 0) {
          logger.warn(`[${this.name}] 🧹 Cleaned up ${zombiesRemoved} zombie upstream(s)`);
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
   * Clean up user tracking maps when a user has no more active connections.
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
        const hadLastSwitch = this.userLastSwitch.has(userId);
        
        this.userToLastKey.delete(userId);
        this.userLastSwitch.delete(userId);
        
        if (hadLastKey || hadLastSwitch) {
          logger.debug(`[${this.name}] 🧹 Cleaned up user tracking maps for userId=${userId}`);
        }
      }
    } catch (err) {
      logger.error(`[${this.name}] Error in _cleanupUserMapsIfEmpty:`, err.message);
    }
  }
}

module.exports = { StreamMultiplexer };
