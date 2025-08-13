const express = require('express');
const router = express.Router();
const pool = require('../db');
const jwt = require('jsonwebtoken');

// Auth middleware (same pattern as referral.js)
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Helpers
const toUpperTicker = (t) => (t || '').trim().toUpperCase();

// Validate ownership of watchlist
async function ensureWatchlistOwnership(userId, watchlistId) {
  const result = await pool.query(
    'SELECT id FROM watchlists WHERE id = $1 AND user_id = $2',
    [watchlistId, userId]
  );
  return result.rows.length > 0;
}

// GET /watchlists
router.get('/watchlists', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, created_at, updated_at FROM watchlists WHERE user_id = $1 ORDER BY name ASC',
      [req.user.id]
    );
    res.json({ success: true, watchlists: result.rows });
  } catch (err) {
    console.error('Error fetching watchlists', err);
    res.status(500).json({ success: false, error: 'Failed to fetch watchlists' });
  }
});

// POST /watchlists { name }
router.post('/watchlists', authenticateToken, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    const trimmed = name.trim();
    // Create watchlist enforcing uniqueness per user
    const insertSql = `
      INSERT INTO watchlists(user_id, name)
      VALUES ($1, $2)
      ON CONFLICT (user_id, name) DO NOTHING
      RETURNING id, name, created_at, updated_at
    `;
    const result = await pool.query(insertSql, [req.user.id, trimmed]);
    if (result.rows.length === 0) {
      return res.status(409).json({ success: false, error: 'Watchlist name already exists' });
    }
    res.status(201).json({ success: true, watchlist: result.rows[0] });
  } catch (err) {
    console.error('Error creating watchlist', err);
    res.status(500).json({ success: false, error: 'Failed to create watchlist' });
  }
});

// PUT /watchlists/:id { name }
router.put('/watchlists/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'Name is required' });
    }
    const owns = await ensureWatchlistOwnership(req.user.id, id);
    if (!owns) return res.sendStatus(404);

    const updateSql = `
      UPDATE watchlists
      SET name = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = $2 AND user_id = $3
      RETURNING id, name, created_at, updated_at
    `;
    try {
      const result = await pool.query(updateSql, [name.trim(), id, req.user.id]);
      res.json({ success: true, watchlist: result.rows[0] });
    } catch (e) {
      // Unique constraint
      if (e.code === '23505') {
        return res.status(409).json({ success: false, error: 'Watchlist name already exists' });
      }
      throw e;
    }
  } catch (err) {
    console.error('Error renaming watchlist', err);
    res.status(500).json({ success: false, error: 'Failed to rename watchlist' });
  }
});

// DELETE /watchlists/:id
router.delete('/watchlists/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await ensureWatchlistOwnership(req.user.id, id);
    if (!owns) return res.sendStatus(404);
    await pool.query('DELETE FROM watchlists WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    return res.sendStatus(204);
  } catch (err) {
    console.error('Error deleting watchlist', err);
    res.status(500).json({ success: false, error: 'Failed to delete watchlist' });
  }
});

// GET /watchlists/:id/tickers
router.get('/watchlists/:id/tickers', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const owns = await ensureWatchlistOwnership(req.user.id, id);
    if (!owns) return res.sendStatus(404);
    const result = await pool.query(
      `SELECT ticker, position, created_at
       FROM watchlist_tickers
       WHERE watchlist_id = $1
       ORDER BY position NULLS LAST, ticker ASC`,
      [id]
    );
    res.json({ success: true, tickers: result.rows });
  } catch (err) {
    console.error('Error fetching watchlist tickers', err);
    res.status(500).json({ success: false, error: 'Failed to fetch tickers' });
  }
});

// POST /watchlists/:id/tickers { ticker }
router.post('/watchlists/:id/tickers', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { ticker } = req.body || {};
    if (!ticker || !ticker.trim()) {
      client.release();
      return res.status(400).json({ success: false, error: 'Ticker is required' });
    }
    const owns = await ensureWatchlistOwnership(req.user.id, id);
    if (!owns) {
      client.release();
      return res.sendStatus(404);
    }

    const normalized = toUpperTicker(ticker);

    // Optional: basic allowlist using existing suggestions list for quick validation in this pass
    // In a future pass, hit TradeStation symbol endpoint or reuse backend validation.

    await client.query('BEGIN');

    // Determine next position
    const posRes = await client.query(
      'SELECT COALESCE(MAX(position), 0) AS maxpos FROM watchlist_tickers WHERE watchlist_id = $1',
      [id]
    );
    const nextPos = Number(posRes.rows[0].maxpos || 0) + 1;

    const insertSql = `
      INSERT INTO watchlist_tickers(watchlist_id, ticker, position)
      VALUES ($1, $2, $3)
      ON CONFLICT (watchlist_id, ticker) DO NOTHING
      RETURNING ticker, position, created_at
    `;
    const result = await client.query(insertSql, [id, normalized, nextPos]);

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(409).json({ success: false, error: 'Ticker already exists in watchlist' });
    }

    await client.query('COMMIT');
    client.release();
    res.status(201).json({ success: true, ticker: result.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    console.error('Error adding ticker to watchlist', err);
    res.status(500).json({ success: false, error: 'Failed to add ticker' });
  }
});

// DELETE /watchlists/:id/tickers/:ticker
router.delete('/watchlists/:id/tickers/:ticker', authenticateToken, async (req, res) => {
  try {
    const { id, ticker } = req.params;
    const owns = await ensureWatchlistOwnership(req.user.id, id);
    if (!owns) return res.sendStatus(404);
    const normalized = toUpperTicker(decodeURIComponent(ticker));
    await pool.query(
      'DELETE FROM watchlist_tickers WHERE watchlist_id = $1 AND ticker = $2',
      [id, normalized]
    );
    return res.sendStatus(204);
  } catch (err) {
    console.error('Error removing ticker from watchlist', err);
    res.status(500).json({ success: false, error: 'Failed to remove ticker' });
  }
});

// PUT /watchlists/:id/tickers/reorder { items: [{ ticker, position }] }
router.put('/watchlists/:id/tickers/reorder', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { id } = req.params;
    const { items } = req.body || {};
    if (!Array.isArray(items)) {
      client.release();
      return res.status(400).json({ success: false, error: 'items array is required' });
    }
    const owns = await ensureWatchlistOwnership(req.user.id, id);
    if (!owns) {
      client.release();
      return res.sendStatus(404);
    }

    // Normalize and validate inputs
    const normalizedItems = items.map((it) => ({
      ticker: toUpperTicker(it.ticker),
      position: Number(it.position)
    }));

    await client.query('BEGIN');

    // Ensure all provided tickers exist for this watchlist
    const providedTickers = normalizedItems.map(i => i.ticker);
    if (providedTickers.length > 0) {
      const exRes = await client.query(
        'SELECT ticker FROM watchlist_tickers WHERE watchlist_id = $1 AND ticker = ANY($2)',
        [id, providedTickers]
      );
      const existing = new Set(exRes.rows.map(r => r.ticker));
      const missing = providedTickers.filter(t => !existing.has(t));
      if (missing.length) {
        await client.query('ROLLBACK');
        client.release();
        return res.status(400).json({ success: false, error: 'Some tickers do not belong to the watchlist', missing });
      }
    }

    // Rewrite positions to 1..N deterministically using provided order sorted by position
    const sorted = normalizedItems
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((it, idx) => ({ ticker: it.ticker, position: idx + 1 }));

    for (const it of sorted) {
      await client.query(
        'UPDATE watchlist_tickers SET position = $1 WHERE watchlist_id = $2 AND ticker = $3',
        [it.position, id, it.ticker]
      );
    }

    await client.query('COMMIT');
    client.release();
    return res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    console.error('Error reordering tickers', err);
    res.status(500).json({ success: false, error: 'Failed to reorder tickers' });
  }
});

module.exports = router;

