const pool = require('../db');

/**
 * Migration: Add beta referral system
 * Adds beta_user and referral_code columns to users table
 * Creates referral_codes table for managing valid referral codes
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Adding beta referral system...');
    
    // Add beta_user and referral_code columns to users table
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS beta_user BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50);
    `);
    
    // Create referral_codes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS referral_codes (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        description VARCHAR(255),
        is_active BOOLEAN DEFAULT true,
        max_uses INTEGER,
        current_uses INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_beta_user ON users(beta_user);
      CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
      CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes(code);
      CREATE INDEX IF NOT EXISTS idx_referral_codes_active ON referral_codes(is_active);
    `);
    
    console.log('✅ Successfully added beta referral system');
    
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
    console.log('Removing beta referral system...');
    
    // Remove indexes
    await client.query(`
      DROP INDEX IF EXISTS idx_users_beta_user;
      DROP INDEX IF EXISTS idx_users_referral_code;
      DROP INDEX IF EXISTS idx_referral_codes_code;
      DROP INDEX IF EXISTS idx_referral_codes_active;
    `);
    
    // Drop referral_codes table
    await client.query(`
      DROP TABLE IF EXISTS referral_codes;
    `);
    
    // Remove columns from users table
    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS beta_user,
      DROP COLUMN IF EXISTS referral_code;
    `);
    
    console.log('✅ Successfully removed beta referral system');
    
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down }; 