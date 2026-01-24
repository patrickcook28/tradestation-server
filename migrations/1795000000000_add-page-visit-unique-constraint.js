const pool = require('../db');

/**
 * Migration: Add unique constraint for page_visit events
 * Allows upsert operations to update page visits instead of creating duplicates
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Adding unique constraint and updated_at column for page_visit events...');

    // Add updated_at column if it doesn't exist
    await client.query(`
      ALTER TABLE analytics_events 
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
    `);

    // First, remove duplicate page_visit events, keeping only the most recent one per (session_id, page_path)
    console.log('Removing duplicate page_visit events...');
    const deleteResult = await client.query(`
      DELETE FROM analytics_events
      WHERE id IN (
        SELECT id
        FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY session_id, (event_data->>'page_path')
                   ORDER BY created_at DESC, id DESC
                 ) as rn
          FROM analytics_events
          WHERE event_type = 'page_visit'
        ) t
        WHERE rn > 1
      );
    `);
    console.log(`Removed ${deleteResult.rowCount} duplicate page_visit events`);

    // Create a unique index on (session_id, page_path) for page_visit events
    // This allows us to upsert page visits instead of creating duplicates
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_events_page_visit_unique
      ON analytics_events (session_id, (event_data->>'page_path'))
      WHERE event_type = 'page_visit';
    `);

    console.log('✅ Successfully added unique constraint and updated_at column');
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
    console.log('Removing unique constraint for page_visit events...');

    await client.query(`
      DROP INDEX IF EXISTS idx_analytics_events_page_visit_unique;
    `);

    console.log('✅ Successfully removed unique constraint');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
