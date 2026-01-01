const pool = require('../db');

/**
 * Migration: Add archived_at column to loss_limit_alerts
 * 
 * Allows archiving alerts for audit trail while keeping them in the database.
 * Archived alerts are hidden from normal views but can be accessed for support/audit purposes.
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Adding archived_at column to loss_limit_alerts...');

    await client.query(`
      ALTER TABLE loss_limit_alerts 
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP WITH TIME ZONE DEFAULT NULL
    `);

    // Add index for querying non-archived alerts
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_loss_limit_alerts_archived 
      ON loss_limit_alerts(archived_at) WHERE archived_at IS NULL
    `);

    console.log('✅ Successfully added archived_at column to loss_limit_alerts');
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
    console.log('Removing archived_at column from loss_limit_alerts...');

    await client.query(`
      DROP INDEX IF EXISTS idx_loss_limit_alerts_archived
    `);

    await client.query(`
      ALTER TABLE loss_limit_alerts 
      DROP COLUMN IF EXISTS archived_at
    `);

    console.log('✅ Successfully removed archived_at column from loss_limit_alerts');
  } catch (error) {
    console.error('❌ Error in migration:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };


















