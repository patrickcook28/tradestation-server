const pool = require('../db');

/**
 * Migration: Update trade_journal to JSONB and add trade_journal_templates
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Altering trade_journal to add user_id and entry JSONB...');

    await client.query(`
      ALTER TABLE trade_journal
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS entry JSONB;
    `);

    console.log('Backfilling existing rows into entry JSONB...');
    await client.query(`
      UPDATE trade_journal
      SET entry = jsonb_strip_nulls(jsonb_build_object(
        'tradeSetup', trade_setup,
        'tradeMistakes', CASE WHEN trade_mistakes IS NULL OR trade_mistakes = '' THEN '[]' ELSE to_jsonb(string_to_array(trade_mistakes, ',')) END,
        'tradeResults', CASE WHEN trade_results IS NULL OR trade_results = '' THEN '[]' ELSE to_jsonb(string_to_array(trade_results, ',')) END,
        'tradeRating', trade_rating,
        'tradeR', trade_r,
        'notes', notes,
        'imagePath', image_path
      )::jsonb)
      WHERE entry IS NULL;
    `);

    console.log('Creating trade_journal_templates table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS trade_journal_templates (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(100) NOT NULL DEFAULT 'Default',
        template JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trade_journal_templates_user_id ON trade_journal_templates(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trade_journal_entry ON trade_journal USING GIN (entry);
    `);

    console.log('✅ Migration complete');
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
    console.log('Dropping trade_journal_templates and entry index (keeping columns to avoid data loss)...');
    await client.query(`
      DROP INDEX IF EXISTS idx_trade_journal_templates_user_id;
    `);
    await client.query(`
      DROP INDEX IF EXISTS idx_trade_journal_entry;
    `);
    await client.query(`
      DROP TABLE IF EXISTS trade_journal_templates;
    `);
    console.log('✅ Rollback complete');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };


