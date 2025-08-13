const pool = require('../db');

/**
 * Migration: Add app_settings and account_defaults JSONB columns to users
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Adding app_settings and account_defaults columns to users...');

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS app_settings JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS account_defaults JSONB DEFAULT '{}'::jsonb;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_app_settings ON users USING GIN (app_settings);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_account_defaults ON users USING GIN (account_defaults);
    `);

    console.log('✅ Successfully added app_settings and account_defaults');
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
    console.log('Reverting app_settings and account_defaults columns...');

    await client.query(`
      DROP INDEX IF EXISTS idx_users_app_settings;
    `);
    await client.query(`
      DROP INDEX IF EXISTS idx_users_account_defaults;
    `);
    await client.query(`
      ALTER TABLE users
      DROP COLUMN IF EXISTS app_settings,
      DROP COLUMN IF EXISTS account_defaults;
    `);

    console.log('✅ Successfully reverted');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };

