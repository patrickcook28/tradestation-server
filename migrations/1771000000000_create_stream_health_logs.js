const pool = require('../db');

/**
 * Migration: Create stream_health_logs table
 * 
 * Tracks background stream health for 24/7 monitoring.
 * Logs every minute per active stream to prove uptime.
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Creating stream_health_logs table...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS stream_health_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        stream_type VARCHAR(50) NOT NULL,
        stream_key VARCHAR(255) NOT NULL,
        status VARCHAR(50) NOT NULL,
        
        started_at TIMESTAMP WITH TIME ZONE,
        logged_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        uptime_seconds INTEGER,
        
        event_type VARCHAR(50),
        event_details JSONB,
        
        last_data_at TIMESTAMP WITH TIME ZONE,
        messages_received INTEGER DEFAULT 0,
        
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Index for querying recent health by user/stream
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_health_logs_user_stream 
      ON stream_health_logs(user_id, stream_type, logged_at DESC);
    `);

    // Index for querying by time range (for dashboard)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_health_logs_logged_at 
      ON stream_health_logs(logged_at DESC);
    `);

    // Index for finding streams by status
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_stream_health_logs_status 
      ON stream_health_logs(status, logged_at DESC);
    `);

    console.log('✅ Successfully created stream_health_logs table with indexes');
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
    console.log('Dropping stream_health_logs table...');

    await client.query(`
      DROP TABLE IF EXISTS stream_health_logs CASCADE;
    `);

    console.log('✅ Successfully dropped stream_health_logs table');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
