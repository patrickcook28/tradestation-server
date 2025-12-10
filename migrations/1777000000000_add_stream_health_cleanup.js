const pool = require('../db');

/**
 * Migration: Add automatic cleanup for stream_health_logs
 * 
 * Creates a function that auto-deletes logs older than 7 days
 * to prevent unbounded growth.
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Creating automatic cleanup for stream_health_logs...');

    // Create function to clean up old logs
    await client.query(`
      CREATE OR REPLACE FUNCTION cleanup_old_stream_health_logs()
      RETURNS void AS $$
      BEGIN
        DELETE FROM stream_health_logs 
        WHERE logged_at < NOW() - INTERVAL '7 days';
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Create index on logged_at for efficient cleanup queries
    // Note: Partial index with NOW() is not allowed (NOW() is not IMMUTABLE)
    // Regular index on logged_at is sufficient for DELETE queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_health_logs_logged_at 
      ON stream_health_logs(logged_at);
    `);

    // Run initial cleanup
    await client.query(`SELECT cleanup_old_stream_health_logs();`);

    console.log('✅ Successfully added stream_health_logs cleanup');
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
    console.log('Removing stream_health_logs cleanup...');

    await client.query(`
      DROP INDEX IF EXISTS idx_stream_health_logs_logged_at;
    `);

    await client.query(`
      DROP FUNCTION IF EXISTS cleanup_old_stream_health_logs();
    `);

    console.log('✅ Successfully removed stream_health_logs cleanup');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };



