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
    /** @type {Map<string, { key: string, subscribers: Set<any>, upstream: any, readable: any }>} */
    this.keyToConnection = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.pendingOpens = new Map();
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
      try { await inFlight; } catch (_) {}
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
    const accessToken = await getUserAccessToken(userId);
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
    } finally {}

    if (!upstream.ok) {
      const text = await upstream.text();
      let data; try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      const err = new Error('Upstream not OK');
      err.status = upstream.status; err.response = data;
      try { rejectLock(err); } catch (_) {}
      this.pendingOpens.delete(key);
      throw err;
    }

    const readable = upstream.body;
    const state = entry || { key, subscribers: new Set(), upstream: null, readable: null };
    state.upstream = upstream; state.readable = readable;
    this.keyToConnection.set(key, state);

    readable.on('data', (chunk) => {
      for (const res of state.subscribers) { try { res.write(chunk); } catch (_) {} }
    });

    const cleanup = () => {
      console.log(`[${this.name}] Upstream closing for key=${key}. Closing ${state.subscribers.size} subscriber(s).`);
      for (const res of state.subscribers) { try { res.end(); } catch (_) {} }
      state.subscribers.clear();
      this.keyToConnection.delete(key);
      console.log(`[${this.name}] Active upstreams: ${this.keyToConnection.size}`);
    };
    readable.on('end', cleanup);
    readable.on('error', cleanup);

    try { resolveLock(); } catch (_) {}
    this.pendingOpens.delete(key);
    return state;
  }

  async addSubscriber(userId, deps, res) {
    const key = this.makeKey(userId, deps);
    let state;
    try {
      state = await this.ensureUpstream(userId, deps);
    } catch (err) {
      const status = err && err.status ? err.status : 500;
      const payload = err && err.response ? err.response : { error: err && err.message ? err.message : 'Failed to start upstream' };
      try {
        res.setHeader('Content-Type', 'application/json');
      } catch (_) {}
      try {
        return res.status(status).json(payload);
      } catch (_) {
        try { res.end(); } catch (_) {}
        return;
      }
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
  }
}

module.exports = { StreamMultiplexer };


