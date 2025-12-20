const pool = require('../db');

/**
 * Migration: Rename "trade loss" columns to "position loss" for clarity
 * - max_loss_per_trade -> max_loss_per_position
 * - max_loss_per_trade_enabled -> max_loss_per_position_enabled
 * - max_loss_per_trade_lock_expires_at -> max_loss_per_position_lock_expires_at
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Renaming trade loss columns to position loss...');

    // Rename columns
    await client.query(`
      ALTER TABLE users
      RENAME COLUMN max_loss_per_trade TO max_loss_per_position;
    `);

    await client.query(`
      ALTER TABLE users
      RENAME COLUMN max_loss_per_trade_enabled TO max_loss_per_position_enabled;
    `);

    await client.query(`
      ALTER TABLE users
      RENAME COLUMN max_loss_per_trade_lock_expires_at TO max_loss_per_position_lock_expires_at;
    `);

    console.log('✅ Successfully renamed trade loss columns to position loss');
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
    console.log('Reverting position loss columns back to trade loss...');

    // Rename columns back
    await client.query(`
      ALTER TABLE users
      RENAME COLUMN max_loss_per_position TO max_loss_per_trade;
    `);

    await client.query(`
      ALTER TABLE users
      RENAME COLUMN max_loss_per_position_enabled TO max_loss_per_trade_enabled;
    `);

    await client.query(`
      ALTER TABLE users
      RENAME COLUMN max_loss_per_position_lock_expires_at TO max_loss_per_trade_lock_expires_at;
    `);

    console.log('✅ Successfully reverted to trade loss columns');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };








