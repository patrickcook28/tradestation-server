const pool = require('../db');

/**
 * Migration: Add early_access columns to users table
 * Replaces beta_user system with early_access system
 * - early_access: boolean flag for early access
 * - early_access_started_at: timestamp when early access was granted
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Adding early_access columns to users table...');
    
    // Add early_access column
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS early_access BOOLEAN DEFAULT FALSE;
    `);
    
    // Add early_access_started_at column
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS early_access_started_at TIMESTAMP;
    `);
    
    // Migrate existing beta users to early access
    // Any user with beta_user=true gets early_access=true
    await client.query(`
      UPDATE users 
      SET early_access = TRUE,
          early_access_started_at = COALESCE(
            (SELECT started_at FROM beta_tracking WHERE beta_tracking.user_id = users.id),
            CURRENT_TIMESTAMP
          )
      WHERE beta_user = TRUE;
    `);
    
    // Create index for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_early_access ON users(early_access);
    `);
    
    console.log('✅ Successfully added early_access columns to users table');
    console.log('✅ Migrated existing beta users to early access');
    
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
    console.log('Removing early_access columns from users table...');
    
    // Drop index
    await client.query(`
      DROP INDEX IF EXISTS idx_users_early_access;
    `);
    
    // Drop columns
    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS early_access,
      DROP COLUMN IF EXISTS early_access_started_at;
    `);
    
    console.log('✅ Successfully removed early_access columns from users table');
    
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };



