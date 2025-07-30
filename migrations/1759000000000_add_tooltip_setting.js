const pool = require('../db');

/**
 * Migration: Add tooltip setting
 * Adds tooltip column to users table to control tooltips
 */

async function up() {
  const client = await pool.connect();

  try {
    console.log('Adding tooltip setting to users table...');

    // Add tooltip column with default true (enabled)
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS show_tooltips BOOLEAN DEFAULT true;
    `);

    // Create index for faster queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_show_tooltips ON users(show_tooltips);
    `);

    console.log('✅ Successfully added tooltip setting to users table');

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
    console.log('Removing tooltip setting from users table...');

    // Remove index
    await client.query(`
      DROP INDEX IF EXISTS idx_users_show_tooltips;
    `);

    // Remove column
    await client.query(`
      ALTER TABLE users
        DROP COLUMN IF EXISTS show_tooltips;
    `);

    console.log('✅ Successfully removed tooltip setting from users table');

  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down }; 