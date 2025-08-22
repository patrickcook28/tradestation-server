const fetch = require('node-fetch');
const { buildUrl, getUserAccessToken } = require('./tradestationProxy');
const { refreshAccessTokenForUserLocked } = require('./tokenRefresh');

class QuoteStreamManager {
  constructor() {
    /** @type {Map<string, { symbolsCsv: string, subscribers: Set<any>, upstream: any, readable: any }>} */
    this.userIdToConnection = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.pendingOpens = new Map();
  }

  /** Normalize symbols to uppercase, unique, comma-joined */
  static normalizeSymbolsCsv(csv) {
    const list = String(csv)
      .split(',')
      .map(s => s.trim().toUpperCase())
      .filter(Boolean);
    return Array.from(new Set(list)).join(',');
  }

  /** Ensure upstream exists for user with given symbols; recreate if symbols changed */
  async ensureUpstream(userId, symbolsCsv) {
    const normalized = QuoteStreamManager.normalizeSymbolsCsv(symbolsCsv);
    const entry = this.userIdToConnection.get(userId);
    if (entry && entry.symbolsCsv === normalized && entry.upstream) {
      console.log(`[Quotes] Reusing upstream for user=${userId} symbols=${normalized}. Subscribers=${entry.subscribers.size}`);
      return entry;
    }

    // If another creation is in-flight for this user, wait until it completes then re-check
    const inFlight = this.pendingOpens.get(userId);
    if (inFlight) {
      console.log(`[Quotes] Awaiting pending upstream open for user=${userId} ...`);
      try { await inFlight; } catch (_) {}
      const after = this.userIdToConnection.get(userId);
      if (after && after.symbolsCsv === normalized && after.upstream) {
        console.log(`[Quotes] Reusing just-opened upstream for user=${userId} symbols=${normalized}.`);
        return after;
      }
    }

    // Create a per-user creation lock BEFORE any async work
    let resolveLock, rejectLock;
    const creationLock = new Promise((resolve, reject) => {
      resolveLock = resolve; rejectLock = reject;
    });
    this.pendingOpens.set(userId, creationLock);

    // Tear down previous upstream if different symbols
    if (entry && entry.upstream) {
      try { entry.readable && entry.readable.destroy && entry.readable.destroy(); } catch (_) {}
      entry.upstream = null;
      entry.readable = null;
    }

    const accessToken = await getUserAccessToken(userId);
    const path = `/marketdata/stream/quotes/${normalized}`;
    const url = buildUrl(false, path);

    let upstream;
    try {
      console.log(`[Quotes] Opening upstream for user=${userId} url=${url}`);
      upstream = await fetch(url, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });

      if (!upstream.ok && upstream.status === 401) {
        // Attempt token refresh once, then retry
        try {
          await refreshAccessTokenForUserLocked(userId);
          console.log(`[Quotes] Retrying upstream open after token refresh for user=${userId}`);
          upstream = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${await getUserAccessToken(userId)}` },
          });
        } catch (e) {
          // Fall through to error path
        }
      }
    } finally {
      // Do not resolve/reject until after we validate response below
    }

    if (!upstream.ok) {
      const text = await upstream.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      const err = new Error('Upstream not OK');
      err.status = upstream.status;
      err.response = data;
      try { rejectLock(err); } catch (_) {}
      this.pendingOpens.delete(userId);
      throw err;
    }

    const readable = upstream.body;

    const state = entry || { symbolsCsv: normalized, subscribers: new Set(), upstream: null, readable: null };
    state.symbolsCsv = normalized;
    state.upstream = upstream;
    state.readable = readable;
    this.userIdToConnection.set(userId, state);

    readable.on('data', (chunk) => {
      // Broadcast raw chunk to all subscribers
      for (const res of state.subscribers) {
        try { res.write(chunk); } catch (_) {}
      }
    });

    const cleanup = () => {
      console.log(`[Quotes] Upstream closing for user=${userId}. Closing ${state.subscribers.size} subscriber(s).`);
      for (const res of state.subscribers) {
        try { res.end(); } catch (_) {}
      }
      state.subscribers.clear();
      this.userIdToConnection.delete(userId);
      console.log(`[Quotes] Active upstreams: ${this.userIdToConnection.size}`);
    };

    readable.on('end', cleanup);
    readable.on('error', cleanup);

    try { resolveLock(); } catch (_) {}
    this.pendingOpens.delete(userId);
    return state;
  }

  /** Add a client response as a subscriber; ensure headers are set and upstream exists */
  async addSubscriber(userId, symbolsCsv, res) {
    const state = await this.ensureUpstream(userId, symbolsCsv);

    // Set streaming headers
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Enforce single subscriber per user by replacing existing subscriber(s)
    if (state.subscribers.size > 0) {
      console.log(`[Quotes] Replacing existing subscriber(s) for user=${userId}.`);
      for (const existing of state.subscribers) {
        try { existing.end(); } catch (_) {}
      }
      state.subscribers.clear();
    }
    state.subscribers.add(res);
    console.log(`[Quotes] Subscriber added for user=${userId}. Subscribers=${state.subscribers.size}. Active upstreams=${this.userIdToConnection.size}`);

    // Remove on client close
    const onClose = () => {
      try { state.subscribers.delete(res); } catch (_) {}
      if (state.subscribers.size === 0) {
        // No subscribers: tear down upstream
        try { state.readable && state.readable.destroy && state.readable.destroy(); } catch (_) {}
        this.userIdToConnection.delete(userId);
        console.log(`[Quotes] Subscriber closed for user=${userId}. Active upstreams=${this.userIdToConnection.size}`);
      }
    };
    res.on('close', onClose);
  }
}

module.exports = new QuoteStreamManager();


