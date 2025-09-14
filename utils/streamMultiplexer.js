const fetch = require('node-fetch');
const { buildUrl, getUserAccessToken } = require('./tradestationProxy');
const { refreshAccessTokenForUserLocked } = require('./tokenRefresh');

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
    /**
     * Tracks the most recent key per user for streams that should be exclusive
     * (one active upstream per user). Used by addExclusiveSubscriber.
     * @type {Map<string, string>}
     */
    this.userToLastKey = new Map();
  }

  async ensureUpstream(userId, deps) {
    const key = this.makeKey(userId, deps);
    const entry = this.keyToConnection.get(key);
    if (entry && entry.upstream) {
      console.log(`[${this.name}] Reusing upstream for key=${key}. Subscribers=${entry.subscribers.size}`);
      return entry;
    }

    const inFlight = this.pendingOpens.get(key);
    if (inFlight) {
      console.log(`[${this.name}] Awaiting pending upstream open for key=${key} ...`);
      try { await inFlight; } catch (e) { console.log(`[${this.name}] Pending open failed for key=${key}`, e && e.message); }
      const after = this.keyToConnection.get(key);
      if (after && after.upstream) {
        console.log(`[${this.name}] Reusing just-opened upstream for key=${key}.`);
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
      console.log(`[${this.name}] Opening upstream for key=${key} url=${url}`);
      upstream = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${accessToken}` } });
      if (!upstream.ok && upstream.status === 401) {
        try {
          await refreshAccessTokenForUserLocked(userId);
          console.log(`[${this.name}] Retrying upstream open after token refresh for key=${key}`);
          upstream = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${await getUserAccessToken(userId)}` } });
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
      // If we are still unauthorized after a refresh attempt, purge stored credentials so UI can prompt reconnect
      if (status === 401) {
        try { await require('../db').query('DELETE FROM api_credentials WHERE user_id = $1', [userId]); } catch (_) {}
      }
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
    const state = entry || { key, subscribers: new Set(), upstream: null, readable: null, lastActivityAt: Date.now(), heartbeatTimer: undefined };
    state.upstream = upstream; state.readable = readable; state.lastActivityAt = Date.now();
    this.keyToConnection.set(key, state);

    readable.on('data', (chunk) => {
      try {
        state.lastActivityAt = Date.now();
        for (const res of state.subscribers) { try { res.write(chunk); } catch (_) {} }
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
    let state;
    try {
      // Prevent concurrent subscriber mutations for the same key
      if (!this.pendingOpens.has(key)) {
        this.pendingOpens.set(key, Promise.resolve());
      }
      const lock = this.pendingOpens.get(key);
      try { await lock; } catch (_) {}
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
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (state.subscribers.size > 0) {
      console.log(`[${this.name}] Replacing existing subscriber(s) for key=${key}.`);
      for (const existing of state.subscribers) { try { existing.end(); } catch (_) {} }
      state.subscribers.clear();
    }
    state.subscribers.add(res);
    console.log(`[${this.name}] Subscriber added for key=${key}. Subscribers=${state.subscribers.size}. Active upstreams=${this.keyToConnection.size}`);

    const onClose = () => {
      try { state.subscribers.delete(res); } catch (_) {}
      if (state.subscribers.size === 0) {
        try { state.readable && state.readable.destroy && state.readable.destroy(); } catch (_) {}
        this.keyToConnection.delete(key);
        console.log(`[${this.name}] Subscriber closed for key=${key}. Active upstreams=${this.keyToConnection.size}`);
      }
    };
    res.on('close', onClose);
    // Release lock
    try { this.pendingOpens.delete(key); } catch (_) {}
  }

  /**
   * Add a subscriber while enforcing only one active upstream per user.
   * If the computed key changes for this user, close the old upstream first.
   */
  async addExclusiveSubscriber(userId, deps, res) {
    try {
      const nextKey = this.makeKey(userId, deps);
      const prevKey = this.userToLastKey.get(userId);
      if (prevKey && prevKey !== nextKey) {
        try { this.closeKey(prevKey); } catch (_) {}
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
   */
  closeKey(key) {
    const state = this.keyToConnection.get(key);
    if (!state) return;
    try {
      if (state.readable && state.readable.destroy) state.readable.destroy();
    } catch (_) {}
    try {
      for (const res of state.subscribers) { try { res.end(); } catch (_) {} }
    } catch (_) {}
    try { state.subscribers && state.subscribers.clear && state.subscribers.clear(); } catch (_) {}
    this.keyToConnection.delete(key);
    console.log(`[${this.name}] Force-closed upstream for key=${key}. Active upstreams=${this.keyToConnection.size}`);
  }
}

module.exports = { StreamMultiplexer };


