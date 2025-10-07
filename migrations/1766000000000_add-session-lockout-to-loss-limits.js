const pool = require('../db');

/**
 * Migration: Add session lockout fields to max loss settings
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Adding session lockout fields to users...');

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS max_loss_per_day_lock_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS max_loss_per_trade_lock_expires_at TIMESTAMP;
    `);

    console.log('✅ Successfully added session lockout fields');
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
    console.log('Reverting session lockout fields...');

    await client.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS max_loss_per_day_lock_expires_at,
      DROP COLUMN IF EXISTS max_loss_per_trade_lock_expires_at;
    `);

    console.log('✅ Successfully reverted');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
