const pool = require('../db');

/**
 * Migration: Create email verification system
 * - Adds email_verification_codes table for 6-digit codes
 * - Adds email_verified column to users table
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Creating email verification system...');
    
    // Add email_verified column to users table
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMP;
    `);
    
    // Create email_verification_codes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS email_verification_codes (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        code VARCHAR(6) NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        verified BOOLEAN DEFAULT FALSE,
        verified_at TIMESTAMP,
        attempts INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(45)
      );
    `);
    
    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_verification_codes_email ON email_verification_codes(email);
      CREATE INDEX IF NOT EXISTS idx_verification_codes_code ON email_verification_codes(code);
      CREATE INDEX IF NOT EXISTS idx_verification_codes_expires ON email_verification_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified);
    `);
    
    // Mark all existing users as verified (grandfather them in)
    await client.query(`
      UPDATE users 
      SET email_verified = TRUE,
          email_verified_at = CURRENT_TIMESTAMP
      WHERE email_verified IS NULL OR email_verified = FALSE;
    `);
    
    console.log('✅ Successfully created email verification system');
    
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
    console.log('Removing email verification system...');
    
    // Drop indexes
    await client.query(`
      DROP INDEX IF EXISTS idx_verification_codes_email;
      DROP INDEX IF EXISTS idx_verification_codes_code;
      DROP INDEX IF EXISTS idx_verification_codes_expires;
      DROP INDEX IF EXISTS idx_users_email_verified;
    `);
    
    // Drop table
    await client.query(`
      DROP TABLE IF EXISTS email_verification_codes;
    `);
    
    // Remove columns from users table
    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS email_verified,
      DROP COLUMN IF EXISTS email_verified_at;
    `);
    
    console.log('✅ Successfully removed email verification system');
    
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };



