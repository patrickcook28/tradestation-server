const pool = require('../db');

/**
 * Migration: Add triggered_at column to trade_alerts
 * 
 * Tracks when an alert was last triggered.
 * When triggered, the alert is deactivated (is_active = false).
 * User can re-enable the alert to reset it.
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Adding triggered_at column to trade_alerts...');

    await client.query(`
      ALTER TABLE trade_alerts 
      ADD COLUMN IF NOT EXISTS triggered_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
    `);

    // Add index for querying triggered alerts
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trade_alerts_triggered_at 
      ON trade_alerts(triggered_at DESC) WHERE triggered_at IS NOT NULL
    `);

    console.log('✅ Successfully added triggered_at column to trade_alerts');
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
    console.log('Removing triggered_at column from trade_alerts...');

    await client.query(`DROP INDEX IF EXISTS idx_trade_alerts_triggered_at`);
    await client.query(`ALTER TABLE trade_alerts DROP COLUMN IF EXISTS triggered_at`);

    console.log('✅ Successfully removed triggered_at column');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };



