const pool = require('../db');

/**
 * Migration: Create session_lockouts table (DEPRECATED - renamed to trading_hours_restrictions)
 * 
 * This migration file exists for historical tracking purposes only.
 * The table was already created and has been migrated to trading_hours_restrictions.
 * This migration does nothing if the table already exists.
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Checking session_lockouts table (deprecated, will be migrated)...');

    // Check if table exists - if it does, do nothing (it was already created)
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'session_lockouts'
      );
    `);

    if (tableExists.rows[0].exists) {
      console.log('✅ session_lockouts table already exists (will be migrated in later migration)');
    } else {
      // If table doesn't exist, create it (for new installations)
      console.log('Creating session_lockouts table (will be migrated later)...');
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

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_session_lockouts_user ON session_lockouts(user_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_session_lockouts_expires ON session_lockouts(expires_at);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_session_lockouts_user_account ON session_lockouts(user_id, account_id);
      `);
      console.log('✅ Created session_lockouts table');
    }
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
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
