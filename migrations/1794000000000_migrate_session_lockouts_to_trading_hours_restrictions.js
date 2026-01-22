const pool = require('../db');

/**
 * Migration: Migrate session_lockouts table to trading_hours_restrictions
 * 
 * This migration:
 * 1. Migrates data from session_lockouts to trading_hours_restrictions (if old table exists)
 * 2. Drops the old session_lockouts table
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Migrating session_lockouts to trading_hours_restrictions...');

    // First, create the new table if it doesn't exist
    const newTableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'trading_hours_restrictions'
      );
    `);

    if (!newTableExists.rows[0].exists) {
      console.log('Creating trading_hours_restrictions table...');
      await client.query(`
        CREATE TABLE trading_hours_restrictions (
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

      // Create indexes
      await client.query(`
        CREATE INDEX idx_trading_hours_restrictions_user ON trading_hours_restrictions(user_id);
      `);
      await client.query(`
        CREATE INDEX idx_trading_hours_restrictions_expires ON trading_hours_restrictions(expires_at);
      `);
      await client.query(`
        CREATE INDEX idx_trading_hours_restrictions_user_account ON trading_hours_restrictions(user_id, account_id);
      `);
      console.log('✅ Created trading_hours_restrictions table');
    }

    // Check if old table exists
    const oldTableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'session_lockouts'
      );
    `);

    if (oldTableExists.rows[0].exists) {
      console.log('Old session_lockouts table found, migrating data...');

      // Migrate data from old table to new table (if new table doesn't have the data already)
      const migrateResult = await client.query(`
        INSERT INTO trading_hours_restrictions (user_id, account_id, time_windows, expires_at, enabled_at, created_at)
        SELECT user_id, account_id, time_windows, expires_at, enabled_at, created_at
        FROM session_lockouts
        WHERE NOT EXISTS (
          SELECT 1 FROM trading_hours_restrictions thr
          WHERE thr.user_id = session_lockouts.user_id
          AND thr.account_id = session_lockouts.account_id
        );
      `);

      console.log(`✅ Migrated ${migrateResult.rowCount} records from session_lockouts`);

      // Drop the old table
      await client.query('DROP TABLE IF EXISTS session_lockouts CASCADE;');
      console.log('✅ Dropped session_lockouts table');
    } else {
      console.log('No old session_lockouts table found, skipping data migration');
    }

    console.log('✅ Successfully migrated session_lockouts to trading_hours_restrictions');
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
    console.log('Rolling back migration: Recreating session_lockouts table...');

    // Recreate the old table structure
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

    // Migrate data back
    await client.query(`
      INSERT INTO session_lockouts (user_id, account_id, time_windows, expires_at, enabled_at, created_at)
      SELECT user_id, account_id, time_windows, expires_at, enabled_at, created_at
      FROM trading_hours_restrictions
      WHERE NOT EXISTS (
        SELECT 1 FROM session_lockouts sl
        WHERE sl.user_id = trading_hours_restrictions.user_id
        AND sl.account_id = trading_hours_restrictions.account_id
      );
    `);

    // Recreate indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_lockouts_user ON session_lockouts(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_lockouts_expires ON session_lockouts(expires_at);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_lockouts_user_account ON session_lockouts(user_id, account_id);
    `);

    console.log('✅ Successfully rolled back migration');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
