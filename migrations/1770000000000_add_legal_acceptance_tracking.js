const pool = require('../db');

/**
 * Migration: Add legal acceptance tracking
 * Adds columns to track when users accept ToS, Privacy Policy, and Risk Disclosure
 * This is important for compliance and audit purposes
 */

async function up() {
  const client = await pool.connect();

  try {
    console.log('Adding legal acceptance tracking columns to users table...');

    // Add legal acceptance timestamp columns
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS tos_accepted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS privacy_policy_accepted_at TIMESTAMP,
      ADD COLUMN IF NOT EXISTS risk_disclosure_accepted_at TIMESTAMP;
    `);

    // Create indexes for potential queries/audits
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_tos_accepted_at ON users(tos_accepted_at);
      CREATE INDEX IF NOT EXISTS idx_users_privacy_policy_accepted_at ON users(privacy_policy_accepted_at);
      CREATE INDEX IF NOT EXISTS idx_users_risk_disclosure_accepted_at ON users(risk_disclosure_accepted_at);
    `);

    console.log('✅ Successfully added legal acceptance tracking columns to users table');

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
    console.log('Removing legal acceptance tracking columns from users table...');

    // Remove indexes
    await client.query(`
      DROP INDEX IF EXISTS idx_users_tos_accepted_at;
      DROP INDEX IF EXISTS idx_users_privacy_policy_accepted_at;
      DROP INDEX IF EXISTS idx_users_risk_disclosure_accepted_at;
    `);

    // Remove columns
    await client.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS tos_accepted_at,
      DROP COLUMN IF EXISTS privacy_policy_accepted_at,
      DROP COLUMN IF EXISTS risk_disclosure_accepted_at;
    `);

    console.log('✅ Successfully removed legal acceptance tracking columns from users table');

  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };

