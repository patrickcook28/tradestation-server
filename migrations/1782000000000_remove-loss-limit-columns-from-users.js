const pool = require('../db');

/**
 * Migration: Remove loss limit columns from users table
 * 
 * Loss limits now ONLY live in loss_limit_locks table (single source of truth)
 * 
 * Removes from users table:
 * - max_loss_per_day, max_loss_per_day_enabled, max_loss_per_day_lock_expires_at
 * - max_loss_per_position, max_loss_per_position_enabled, max_loss_per_position_lock_expires_at
 * 
 * NOTE: Before running this migration, ensure all loss limits have been migrated to loss_limit_locks
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Removing loss limit columns from users table...');

    await client.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS max_loss_per_day,
      DROP COLUMN IF EXISTS max_loss_per_day_enabled,
      DROP COLUMN IF EXISTS max_loss_per_day_lock_expires_at,
      DROP COLUMN IF EXISTS max_loss_per_position,
      DROP COLUMN IF EXISTS max_loss_per_position_enabled,
      DROP COLUMN IF EXISTS max_loss_per_position_lock_expires_at,
      DROP COLUMN IF EXISTS max_loss_per_trade,
      DROP COLUMN IF EXISTS max_loss_per_trade_enabled,
      DROP COLUMN IF EXISTS max_loss_per_trade_lock_expires_at;
    `);

    console.log('✅ Successfully removed loss limit columns from users table');
    console.log('📝 Loss limits now exclusively stored in loss_limit_locks table');
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
    console.log('Restoring loss limit columns to users table...');

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS max_loss_per_day DECIMAL(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_loss_per_day_enabled BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS max_loss_per_day_lock_expires_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS max_loss_per_position DECIMAL(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_loss_per_position_enabled BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS max_loss_per_position_lock_expires_at TIMESTAMP;
    `);

    console.log('✅ Successfully restored loss limit columns (data will be empty)');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };











