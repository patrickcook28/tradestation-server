const pool = require('../db');

/**
 * Migration: Add watchlists and watchlist_tickers tables
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Creating watchlists and watchlist_tickers tables...');

    await client.query('BEGIN');

    // Create watchlists table
    await client.query(`
      CREATE TABLE IF NOT EXISTS watchlists (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_watchlists_user_name UNIQUE(user_id, name)
      );
    `);

    // Create indexes for watchlists
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id);
    `);

    // Create watchlist_tickers table
    await client.query(`
      CREATE TABLE IF NOT EXISTS watchlist_tickers (
        id SERIAL PRIMARY KEY,
        watchlist_id INTEGER REFERENCES watchlists(id) ON DELETE CASCADE,
        ticker VARCHAR(32) NOT NULL,
        position INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uq_watchlist_tickers UNIQUE(watchlist_id, ticker)
      );
    `);

    // Create indexes for watchlist_tickers
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_watchlist_tickers_watchlist ON watchlist_tickers(watchlist_id);
      CREATE INDEX IF NOT EXISTS idx_watchlist_tickers_ticker ON watchlist_tickers(ticker);
    `);

    await client.query('COMMIT');
    console.log('✅ Successfully created watchlists tables');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error in migration:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    console.log('Dropping watchlists and watchlist_tickers tables...');
    await client.query('BEGIN');

    await client.query(`
      DROP INDEX IF EXISTS idx_watchlist_tickers_ticker;
      DROP INDEX IF EXISTS idx_watchlist_tickers_watchlist;
    `);

    await client.query(`
      DROP TABLE IF EXISTS watchlist_tickers;
    `);

    await client.query(`
      DROP INDEX IF EXISTS idx_watchlists_user;
    `);

    await client.query(`
      DROP TABLE IF EXISTS watchlists;
    `);

    await client.query('COMMIT');
    console.log('✅ Successfully dropped watchlists tables');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };

