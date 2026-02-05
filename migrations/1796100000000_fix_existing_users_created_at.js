const pool = require('../db');

/**
 * Migration: Fix created_at for existing users
 * If users have created_at set to today (likely from previous migration),
 * update them to use earliest activity or credentials date instead
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Fixing created_at for existing users...');

    // Update users where created_at is today or very recent (within last 24 hours)
    // Use earliest activity or credentials date as fallback
    const result = await client.query(`
      UPDATE users u
      SET created_at = COALESCE(
        (SELECT MIN(created_at) FROM analytics_events WHERE user_id = u.id),
        (SELECT MIN(created_at) FROM api_credentials WHERE user_id = u.id),
        u.created_at
      )
      WHERE u.created_at IS NOT NULL 
        AND u.created_at > NOW() - INTERVAL '24 hours';
    `);

    console.log(`✅ Updated ${result.rowCount} users with corrected created_at dates`);
  } catch (error) {
    console.error('❌ Error in migration:', error);
    throw error;
  } finally {
    client.release();
  }
}

async function down() {
  // No rollback needed - this is a data correction migration
  console.log('No rollback needed for data correction migration');
}

module.exports = { up, down };
