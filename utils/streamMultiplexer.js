const fetch = require('node-fetch');
const { buildUrl, getUserAccessToken } = require('./tradestationProxy');
const { refreshAccessTokenForUserLocked } = require('./tokenRefresh');
const { getFetchOptionsWithAgent } = require('./httpAgent');

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
    /** @type {Map<string, { key: string, subscribers: Set<any>, upstream: any, readable: any, lastActivityAt: number, heartbeatTimer?: NodeJS.Timeout }>} */
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

  async ensureUpstream(userId, deps) {
    const key = this.makeKey(userId, deps);
    
    // CRITICAL: Wait for any pending cleanup to complete before opening new stream
    // This ensures we always get fresh data from TradeStation, not mid-stream
    const pendingCleanup = this.pendingCleanups.get(key);
    if (pendingCleanup) {
      console.log(`[${this.name}] Waiting for cleanup to complete for key=${key} before opening new stream...`);
      try { await pendingCleanup; } catch (_) {}
      console.log(`[${this.name}] Cleanup complete for key=${key}, proceeding with fresh stream open`);
    }
    
    const entry = this.keyToConnection.get(key);
    if (entry && entry.upstream) {
      const now = new Date().toISOString();
      console.log(`[${this.name}] [${now}] ♻️  Reusing upstream for key=${key}. Subscribers=${entry.subscribers.size}`);
      return entry;
    }

    const inFlight = this.pendingOpens.get(key);
    if (inFlight) {
      console.log(`[${this.name}] Awaiting pending upstream open for key=${key} ...`);
      try { await inFlight; } catch (e) { console.log(`[${this.name}] Pending open failed for key=${key}`, e && e.message); }
      const after = this.keyToConnection.get(key);
      if (after && after.upstream) {
        const now = new Date().toISOString();
        console.log(`[${this.name}] [${now}] ♻️  Reusing just-opened upstream for key=${key}`);
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

    let upstream;
    try {
      const openAttemptTime = Date.now();
      console.log(`[${this.name}] [${openAttemptTime}] Opening upstream for key=${key} url=${url}`);
      const fetchStartTime = Date.now();
      
      // Use 30 second timeout for initial connection (TradeStation can be slow)
      upstream = await fetch(url, getFetchOptionsWithAgent(url, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}` } }, 30000));
      
      const now = new Date().toISOString();
      console.log(`[${this.name}] [${now}] ✅ TradeStation API responded (status: ${upstream.status}) for key=${key}`);
      
      if (!upstream.ok && upstream.status === 401) {
        try {
          await refreshAccessTokenForUserLocked(userId);
          console.log(`[${this.name}] Retrying upstream open after token refresh for key=${key}`);
          upstream = await fetch(url, getFetchOptionsWithAgent(url, { method: 'GET', headers: { 'Authorization': `Bearer ${await getUserAccessToken(userId)}` } }, 15000));
        } catch (_) {}
      }
    } catch (networkErr) {
      const err = { __error: true, status: 502, response: { error: 'Bad Gateway', details: networkErr && networkErr.message }, message: 'Upstream fetch failed' };
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
        console.log(`[${this.name}] Abandoning stale upstream for key=${key} (lastKey changed to ${lastKey})`);
        try { upstream.body && upstream.body.destroy && upstream.body.destroy(); } catch (_) {}
        try { resolveLock(); } catch (_) {}
        this.pendingOpens.delete(key);
        return { __error: true, status: 409, response: { error: 'Stale upstream (key changed during open)' }, message: 'Stale upstream' };
      }
    } catch (_) {}

    const readable = upstream.body;
    const state = entry || { key, subscribers: new Set(), upstream: null, readable: null, lastActivityAt: Date.now(), heartbeatTimer: undefined, firstDataSent: false };
    state.upstream = upstream; state.readable = readable; state.lastActivityAt = Date.now();
    this.keyToConnection.set(key, state);

    readable.on('data', (chunk) => {
      try {
        state.lastActivityAt = Date.now();
        
        // Log first data packet sent to clients
        if (!state.firstDataSent) {
          state.firstDataSent = true;
          const now = new Date().toISOString();
          console.log(`[${this.name}] [${now}] 📤 First data sent to ${state.subscribers.size} client(s) for key=${key}`);
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
        console.error(`[${this.name}] Error handling data for key=${key}:`, error);
      }
    });

    const cleanup = (error) => {
      try {
        if (error) {
          console.error(`[${this.name}] Upstream error for key=${key}:`, error);
        }
        console.log(`[${this.name}] Upstream closing for key=${key}. Closing ${state.subscribers.size} subscriber(s).`);
        for (const res of state.subscribers) { try { res.end(); } catch (_) {} }
        state.subscribers.clear();
        try { if (state.heartbeatTimer) clearInterval(state.heartbeatTimer); } catch (_) {}
        
        // CRITICAL: Aggressively destroy the upstream connection and socket
        try {
          if (state.readable) {
            if (state.readable.destroy) state.readable.destroy();
            if (state.readable.close) state.readable.close();
          }
        } catch (_) {}
        
        // Also destroy the response body if different from readable
        try {
          if (state.upstream && state.upstream.body && state.upstream.body !== state.readable) {
            if (state.upstream.body.destroy) state.upstream.body.destroy();
            if (state.upstream.body.close) state.upstream.body.close();
          }
        } catch (_) {}
        
        this.keyToConnection.delete(key);
        console.log(`[${this.name}] Active upstreams: ${this.keyToConnection.size}`);
      } catch (cleanupError) {
        console.error(`[${this.name}] Error during cleanup for key=${key}:`, cleanupError);
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
      console.error(`[${this.name}] Error in addSubscriber for key=${key}:`, error);
      try { res.setHeader('Content-Type', 'application/json'); } catch (_) {}
      try { return res.status(500).json({ error: 'Internal server error', details: error.message }); } catch (_) { try { res.end(); } catch (_) {} return; }
    }
    
    // Check if this exact response object is already subscribed (shouldn't happen, but defensive)
    if (state.subscribers.has(res)) {
      console.log(`[${this.name}] ⚠️  Response object already subscribed for userId=${userId}, key=${key}. Ignoring duplicate.`);
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
    console.log(`[${this.name}] [${now}] ✅ Subscriber added for userId=${userId}, key=${key}. Subscribers=${state.subscribers.size}. Active upstreams=${this.keyToConnection.size} [connId=${connectionId}]`);

    let cleanupDone = false;
    const onClose = (reason) => {
      if (cleanupDone) return; // Prevent multiple cleanups from different events
      cleanupDone = true;
      
      const wasInSet = state.subscribers.has(res);
      try { state.subscribers.delete(res); } catch (_) {}
      
      if (wasInSet) {
        const now = new Date().toISOString();
        const duration = Date.now() - (res._subscribedAt || 0);
        console.log(`[${this.name}] [${now}] 🔌 Subscriber disconnected (${reason || 'close'}) for userId=${userId}, key=${key}. Remaining=${state.subscribers.size} [connId=${connectionId}, duration=${duration}ms]`);
      }
      
      if (state.subscribers.size === 0) {
        // Create cleanup promise to prevent race conditions on page refresh
        let resolveCleanup;
        const cleanupPromise = new Promise((resolve) => { resolveCleanup = resolve; });
        this.pendingCleanups.set(key, cleanupPromise);
        
        const now = new Date().toISOString();
        console.log(`[${this.name}] [${now}] 🧹 Closing upstream (no subscribers) for key=${key}`);
        try { 
          // Aggressively destroy all streams and underlying connections
          if (state.readable) {
            if (state.readable.destroy) state.readable.destroy();
            if (state.readable.close) state.readable.close();
            // Destroy the underlying socket if accessible
            if (state.readable.socket && state.readable.socket.destroy) {
              state.readable.socket.destroy();
            }
          }
          if (state.upstream && state.upstream.body && state.upstream.body !== state.readable) {
            if (state.upstream.body.destroy) state.upstream.body.destroy();
            if (state.upstream.body.close) state.upstream.body.close();
            if (state.upstream.body.socket && state.upstream.body.socket.destroy) {
              state.upstream.body.socket.destroy();
            }
          }
        } catch (err) {
          console.error(`[${this.name}] Error destroying upstream for key=${key}:`, err.message);
        }
        this.keyToConnection.delete(key);
        
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
      console.log(`[${this.name}] ⚠️  Request already aborted/destroyed at subscription time for key=${key} [connId=${connectionId}]`);
      onClose('already-closed');
      return;
    }
    
    // Defensive: Set a timeout to detect stale connections (no activity for 5 minutes = probably dead)
    const staleCheckInterval = setInterval(() => {
      if (res.writableEnded || res.finished || res.req?.destroyed) {
        clearInterval(staleCheckInterval);
        // Connection is already ended, make sure cleanup happened
        if (state.subscribers.has(res)) {
          console.log(`[${this.name}] ⚠️  Detected stale ended connection still in subscribers set for key=${key} [connId=${connectionId}]`);
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
          console.log(`[${this.name}] ⚠️  User ${userId} rapidly switching streams (${timeSinceLastSwitch}ms since last switch). Consider debouncing on frontend.`);
        } else {
          console.log(`[${this.name}] User ${userId} switching from key=${prevKey} to key=${nextKey}, closing old stream...`);
        }
        try { await this.closeKey(prevKey); } catch (e) {
          console.log(`[${this.name}] Error closing previous key=${prevKey}:`, e?.message);
        }
        this.userLastSwitch.set(userId, Date.now());
      }
      
      this.userToLastKey.set(userId, nextKey);
      return await this.addSubscriber(userId, deps, res);
    } catch (error) {
      console.error(`[${this.name}] Error in addExclusiveSubscriber for userId=${userId}:`, error);
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
    
    try {
      if (state.readable && state.readable.destroy) state.readable.destroy();
    } catch (_) {}
    try {
      for (const res of state.subscribers) { try { res.end(); } catch (_) {} }
    } catch (_) {}
    try { state.subscribers && state.subscribers.clear && state.subscribers.clear(); } catch (_) {}
    this.keyToConnection.delete(key);
    console.log(`[${this.name}] Force-closed upstream for key=${key}. Active upstreams=${this.keyToConnection.size}`);
    
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
        console.log(`[${this.name}] 🧹 Removed stale connection from subscribers set: ${connectionId} for key=${key}`);
      }
      
      // If no subscribers left after cleanup, close the upstream
      if (state.subscribers.size === 0 && stale.length > 0) {
        console.log(`[${this.name}] 🧹 No subscribers remaining after stale cleanup, closing upstream for key=${key}`);
        try {
          if (state.readable) {
            if (state.readable.destroy) state.readable.destroy();
            if (state.readable.close) state.readable.close();
          }
          if (state.upstream && state.upstream.body && state.upstream.body !== state.readable) {
            if (state.upstream.body.destroy) state.upstream.body.destroy();
            if (state.upstream.body.close) state.upstream.body.close();
          }
        } catch (_) {}
        this.keyToConnection.delete(key);
        upstreamsDestroyed++;
      }
    }
    
    if (removed > 0 || upstreamsDestroyed > 0) {
      console.log(`[${this.name}] 🧹 Cleaned up ${removed} stale connection(s) and ${upstreamsDestroyed} orphaned upstream(s). Active upstreams: ${this.keyToConnection.size}`);
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
    
    console.log(`[${this.name}] Starting periodic stale connection cleanup (every ${intervalMs}ms)`);
    
    this._cleanupInterval = setInterval(() => {
      try {
        const removed = this.cleanupStaleConnections();
        
        // Log warning if we have too many active upstreams
        const upstreamCount = this.keyToConnection.size;
        if (upstreamCount > 20) {
          console.log(`[${this.name}] ⚠️  HIGH UPSTREAM COUNT: ${upstreamCount} active upstreams. This may indicate a leak.`);
        }
      } catch (err) {
        console.error(`[${this.name}] Error during periodic cleanup:`, err);
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
      console.log(`[${this.name}] Stopped periodic cleanup`);
    }
  }
}

module.exports = { StreamMultiplexer };


