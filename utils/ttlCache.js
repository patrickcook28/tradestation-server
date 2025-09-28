/**
 * Simple in-memory TTL cache with stale-while-revalidate behavior.
 * - Entries have cachedAt and staleAt timestamps
 * - get(key) returns { data, cachedAt, staleAt, isStale }
 * - set(key, data, ttlMs) sets staleAt = now + ttlMs
 * - refreshInFlight map prevents stampedes
 * - info() returns summary for admin UI
 */

class TTLCache {
  constructor(name = 'cache') {
    this.name = name;
    /** @type {Map<string, { data: any, cachedAt: number, staleAt: number, meta?: any }>} */
    this.store = new Map();
    /** @type {Map<string, Promise<any>>} */
    this.refreshInFlight = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /** Normalize key as string */
  static normalizeKey(rawKey) {
    if (rawKey == null) return '';
    if (typeof rawKey === 'string') return rawKey;
    try { return JSON.stringify(rawKey); } catch (_) { return String(rawKey); }
  }

  /** Set entry with ttlMs and optional meta */
  set(key, data, ttlMs, meta) {
    const k = TTLCache.normalizeKey(key);
    const now = Date.now();
    const staleAt = now + Math.max(0, Number(ttlMs || 0));
    this.store.set(k, { data, cachedAt: now, staleAt, meta });
  }

  /** Get entry (might be stale). Returns null if not found. */
  get(key) {
    const k = TTLCache.normalizeKey(key);
    const entry = this.store.get(k);
    if (!entry) { this.misses++; return null; }
    this.hits++;
    const isStale = Date.now() >= entry.staleAt;
    return { ...entry, isStale };
  }

  /** Run a refresh function while preventing duplicate refreshes for the same key. */
  async refresh(key, fn) {
    const k = TTLCache.normalizeKey(key);
    const existing = this.refreshInFlight.get(k);
    if (existing) return existing;
    const p = (async () => {
      try { return await fn(); }
      finally { this.refreshInFlight.delete(k); }
    })();
    this.refreshInFlight.set(k, p);
    return p;
  }

  /** Delete key */
  delete(key) {
    const k = TTLCache.normalizeKey(key);
    this.store.delete(k);
  }

  /** Admin info */
  info() {
    const now = Date.now();
    const entries = [];
    for (const [key, value] of this.store.entries()) {
      entries.push({
        key,
        cachedAt: new Date(value.cachedAt).toISOString(),
        staleAt: new Date(value.staleAt).toISOString(),
        isStale: now >= value.staleAt,
        meta: value.meta || null
      });
    }
    return {
      name: this.name,
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      refreshing: Array.from(this.refreshInFlight.keys()),
      entries
    };
  }
}

module.exports = { TTLCache };


