const pool = require('../db');

/**
 * Migration: Create loss limit locks and alerts tables
 * 
 * loss_limit_locks: Tracks when a limit setting is enabled and locked (can't be changed until expiry)
 * loss_limit_alerts: Tracks when thresholds are breached (for audit trail and user acknowledgment)
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Creating loss limit tables...');

    // Table: loss_limit_locks
    // Tracks when a limit is enabled and locked (user cannot change until expires_at)
    await client.query(`
      CREATE TABLE IF NOT EXISTS loss_limit_locks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id VARCHAR(255) NOT NULL,
        limit_type VARCHAR(20) NOT NULL CHECK (limit_type IN ('daily', 'trade')),
        threshold_amount DECIMAL(12, 2) NOT NULL,
        enabled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        UNIQUE(user_id, account_id, limit_type)
      );
    `);
    console.log('✅ Created loss_limit_locks table');

    // Indexes for loss_limit_locks
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_loss_limit_locks_user ON loss_limit_locks(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_loss_limit_locks_expires ON loss_limit_locks(expires_at);
    `);
    console.log('✅ Created indexes for loss_limit_locks');

    // Table: loss_limit_alerts
    // Tracks when thresholds are breached (created by backend detection)
    await client.query(`
      CREATE TABLE IF NOT EXISTS loss_limit_alerts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id VARCHAR(255) NOT NULL,
        alert_type VARCHAR(20) NOT NULL CHECK (alert_type IN ('daily', 'trade')),
        threshold_amount DECIMAL(12, 2) NOT NULL,
        loss_amount DECIMAL(12, 2) NOT NULL,
        position_snapshot JSONB,
        detected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        lockout_expires_at TIMESTAMP WITH TIME ZONE,
        acknowledged_at TIMESTAMP WITH TIME ZONE,
        user_action VARCHAR(50),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    console.log('✅ Created loss_limit_alerts table');

    // Indexes for loss_limit_alerts
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_loss_limit_alerts_user ON loss_limit_alerts(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_loss_limit_alerts_pending ON loss_limit_alerts(user_id) 
        WHERE acknowledged_at IS NULL;
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_loss_limit_alerts_account ON loss_limit_alerts(account_id);
    `);
    console.log('✅ Created indexes for loss_limit_alerts');

    console.log('✅ Successfully created all loss limit tables');
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
    console.log('Dropping loss limit tables...');

    await client.query('DROP TABLE IF EXISTS loss_limit_alerts CASCADE;');
    console.log('✅ Dropped loss_limit_alerts table');

    await client.query('DROP TABLE IF EXISTS loss_limit_locks CASCADE;');
    console.log('✅ Dropped loss_limit_locks table');

    console.log('✅ Successfully dropped all loss limit tables');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };








