const pool = require('../db');

/**
 * Migration: Create analytics_events table
 * Tracks page views, user interactions, and custom events
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Creating analytics_events table...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id SERIAL PRIMARY KEY,
        event_type VARCHAR(100) NOT NULL,
        user_id INTEGER NULL,
        session_id VARCHAR(100) NOT NULL,
        event_data JSONB NOT NULL,
        user_agent TEXT NULL,
        referrer TEXT NULL,
        screen_resolution VARCHAR(50) NULL,
        viewport_size VARCHAR(50) NULL,
        ip_address VARCHAR(45) NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Create indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_event_type_created_at 
      ON analytics_events (event_type, created_at);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id_created_at 
      ON analytics_events (user_id, created_at);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_session_id_created_at 
      ON analytics_events (session_id, created_at);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at 
      ON analytics_events (created_at);
    `);

    // Create indexes for JSONB field queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_page_path 
      ON analytics_events ((event_data->>'page_path'));
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_journey_step 
      ON analytics_events ((event_data->>'journey_step'));
    `);

    // Create GIN index on the entire JSONB field for complex queries
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analytics_events_event_data_gin 
      ON analytics_events USING GIN (event_data);
    `);

    // Add foreign key constraint
    await client.query(`
      ALTER TABLE analytics_events 
      ADD CONSTRAINT fk_analytics_events_user_id 
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
    `);

    console.log('✅ Successfully created analytics_events table with indexes');
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
    console.log('Dropping analytics_events table...');

    await client.query(`
      DROP TABLE IF EXISTS analytics_events CASCADE;
    `);

    console.log('✅ Successfully dropped analytics_events table');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
