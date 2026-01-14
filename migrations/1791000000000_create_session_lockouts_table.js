const pool = require('../db');

/**
 * Migration: Create session_lockouts table
 * 
 * session_lockouts: Tracks trading time windows when users are allowed to trade
 * Outside these windows, new trades are blocked (but position management is allowed)
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Creating session_lockouts table...');

    // Table: session_lockouts
    // Tracks when session lockout is enabled with custom trading time windows
    await client.query(`
      CREATE TABLE IF NOT EXISTS session_lockouts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id VARCHAR(255) NOT NULL,
        time_windows JSONB NOT NULL,
        enabled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(user_id, account_id)
      );
    `);
    console.log('✅ Created session_lockouts table');

    // Indexes for session_lockouts
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_lockouts_user ON session_lockouts(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_lockouts_expires ON session_lockouts(expires_at);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_lockouts_user_account ON session_lockouts(user_id, account_id);
    `);
    console.log('✅ Created indexes for session_lockouts');

    console.log('✅ Successfully created session_lockouts table');
  } catch (error) {
    console.error('❌ Error in migration:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function down() {
  const client = await pool.connect();
  try {
    console.log('Dropping session_lockouts table...');

    await client.query('DROP TABLE IF EXISTS session_lockouts CASCADE;');
    console.log('✅ Dropped session_lockouts table');

    console.log('✅ Successfully dropped session_lockouts table');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
