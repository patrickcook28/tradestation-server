const pool = require('../db');

/**
 * Migration: Create account_snapshots table
 * 
 * account_snapshots: Stores daily snapshots of user account balances
 * Sensitive balance data is encrypted using AES-256-GCM
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Creating account_snapshots table...');

    // Table: account_snapshots
    // Stores daily snapshots of account balances for historical tracking
    await client.query(`
      CREATE TABLE IF NOT EXISTS account_snapshots (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id VARCHAR(255) NOT NULL,
        account_type VARCHAR(50) NOT NULL,
        snapshot_date DATE NOT NULL,
        snapshot_time TIME WITH TIME ZONE NOT NULL,
        
        -- Encrypted balance data (contains full balance JSON)
        balance_data_encrypted TEXT NOT NULL,
        
        -- Non-sensitive summary fields for quick queries (not encrypted)
        equity DECIMAL(15, 2),
        todays_profit_loss DECIMAL(15, 2),
        day_trades INTEGER,
        
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        
        -- Ensure one snapshot per account per day
        UNIQUE(user_id, account_id, snapshot_date)
      );
    `);
    console.log('✅ Created account_snapshots table');

    // Indexes for account_snapshots
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_account_snapshots_user ON account_snapshots(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_account_snapshots_account ON account_snapshots(user_id, account_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_account_snapshots_date ON account_snapshots(snapshot_date DESC);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_account_snapshots_user_date ON account_snapshots(user_id, snapshot_date DESC);
    `);
    console.log('✅ Created indexes for account_snapshots');

    console.log('✅ Successfully created account_snapshots table');
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
    console.log('Dropping account_snapshots table...');

    await client.query('DROP TABLE IF EXISTS account_snapshots CASCADE;');
    console.log('✅ Dropped account_snapshots table');

    console.log('✅ Successfully dropped account_snapshots table');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
