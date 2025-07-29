const pool = require('../db');

/**
 * Migration: Add trade confirmation setting
 * Adds trade_confirmation column to users table to control order confirmation modals
 */

async function up() {
  const client = await pool.connect();

  try {
    console.log('Adding trade_confirmation setting to users table...');

    // Add trade_confirmation column with default true (enabled)
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS trade_confirmation BOOLEAN DEFAULT true;
    `);

    // Create index for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_trade_confirmation ON users(trade_confirmation);
    `);

    console.log('✅ Successfully added trade_confirmation setting to users table');

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
    console.log('Removing trade_confirmation setting from users table...');

    // Remove index
    await client.query(`
      DROP INDEX IF EXISTS idx_users_trade_confirmation;
    `);

    // Remove column
    await client.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS trade_confirmation;
    `);

    console.log('✅ Successfully removed trade_confirmation setting from users table');

  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down }; 