const pool = require('../db');

/**
 * Migration: Add max loss settings and superuser to users table
 * Adds columns for daily and per-position loss limits with enable/disable flags
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Adding max loss settings columns to users table...');
    
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS max_loss_per_day DECIMAL(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_loss_per_day_enabled BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS max_loss_per_trade DECIMAL(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS max_loss_per_trade_enabled BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS superuser BOOLEAN DEFAULT false;
    `);
    
    console.log('✅ Successfully added max loss settings columns to users table');
    
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
    console.log('Removing max loss settings columns from users table...');
    
    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS max_loss_per_day,
      DROP COLUMN IF EXISTS max_loss_per_day_enabled,
      DROP COLUMN IF EXISTS max_loss_per_trade,
      DROP COLUMN IF EXISTS max_loss_per_trade_enabled,
      DROP COLUMN IF EXISTS superuser;
    `);
    
    console.log('✅ Successfully removed max loss settings columns from users table');
    
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down }; 