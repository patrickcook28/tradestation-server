const pool = require('../db');

/**
 * Migration: Add email_alerts_enabled column to users table
 * 
 * When enabled, users will receive email notifications when their price alerts trigger.
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Adding email_alerts_enabled column to users...');

    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS email_alerts_enabled BOOLEAN DEFAULT false
    `);

    console.log('✅ Successfully added email_alerts_enabled column to users');
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
    console.log('Removing email_alerts_enabled column from users...');

    await client.query(`ALTER TABLE users DROP COLUMN IF EXISTS email_alerts_enabled`);

    console.log('✅ Successfully removed email_alerts_enabled column');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };






