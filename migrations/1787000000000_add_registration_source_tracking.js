const pool = require('../db');

/**
 * Migration: Add registration source tracking
 * Adds registration_source JSONB column to users table to track where users came from
 * Stores UTM parameters and custom source parameters from URL when user registers/logs in
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Adding registration_source column to users table...');
    
    // Add registration_source column as JSONB to store source tracking data
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS registration_source JSONB DEFAULT NULL;
    `);
    
    // Create index for performance (GIN index for JSONB queries)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_registration_source ON users USING GIN (registration_source);
    `);
    
    console.log('✅ Successfully added registration_source column to users table');
    
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
    console.log('Removing registration_source column from users table...');
    
    // Drop index first
    await client.query(`
      DROP INDEX IF EXISTS idx_users_registration_source;
    `);
    
    // Drop column
    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS registration_source;
    `);
    
    console.log('✅ Successfully removed registration_source column from users table');
    
  } catch (error) {
    console.error('❌ Error in migration rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
