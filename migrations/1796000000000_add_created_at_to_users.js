const pool = require('../db');

/**
 * Migration: Add created_at column to users table
 * This allows tracking when users were created for the admin area
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Adding created_at column to users table...');

    // Add created_at column without default first (so existing rows get NULL)
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE;
    `);

    // For existing users without created_at, try to use earliest activity or credentials date as fallback
    // This gives us a better approximation than NULL
    await client.query(`
      UPDATE users u
      SET created_at = COALESCE(
        (SELECT MIN(created_at) FROM analytics_events WHERE user_id = u.id),
        (SELECT MIN(created_at) FROM api_credentials WHERE user_id = u.id),
        NULL
      )
      WHERE u.created_at IS NULL;
    `);

    // Now set default for future inserts
    await client.query(`
      ALTER TABLE users 
      ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
    `);

    console.log('✅ Successfully added created_at column to users table');
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
    console.log('Removing created_at column from users table...');

    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS created_at;
    `);

    console.log('✅ Successfully removed created_at column from users table');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
