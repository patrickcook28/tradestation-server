const pool = require('../db');

/**
 * Migration: Add is_paper_trading column to account_snapshots table
 * 
 * This allows tracking whether each snapshot is for a paper trading (SIM) or live account
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Adding is_paper_trading column to account_snapshots table...');

    // Add is_paper_trading column (default to false for existing records)
    await client.query(`
      ALTER TABLE account_snapshots
      ADD COLUMN IF NOT EXISTS is_paper_trading BOOLEAN NOT NULL DEFAULT false;
    `);

    // Update unique constraint to include is_paper_trading
    // Find and drop the existing unique constraint (PostgreSQL auto-generates constraint names)
    const constraintResult = await client.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'account_snapshots'::regclass
        AND contype = 'u'
    `);
    
    if (constraintResult.rows.length > 0) {
      for (const row of constraintResult.rows) {
        const constraintName = row.conname;
        await client.query(`
          ALTER TABLE account_snapshots
          DROP CONSTRAINT ${constraintName};
        `);
      }
    }

    // Add new constraint with is_paper_trading
    await client.query(`
      ALTER TABLE account_snapshots
      ADD CONSTRAINT account_snapshots_user_id_account_id_snapshot_date_paper_key
      UNIQUE (user_id, account_id, snapshot_date, is_paper_trading);
    `);

    // Add index for filtering by paper trading
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_account_snapshots_paper_trading 
      ON account_snapshots(user_id, is_paper_trading, snapshot_date DESC);
    `);

    console.log('✅ Added is_paper_trading column to account_snapshots table');

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
    console.log('Removing is_paper_trading column from account_snapshots table...');

    // Drop new constraint
    await client.query(`
      ALTER TABLE account_snapshots
      DROP CONSTRAINT IF EXISTS account_snapshots_user_id_account_id_snapshot_date_paper_key;
    `);

    // Restore old constraint
    await client.query(`
      ALTER TABLE account_snapshots
      ADD CONSTRAINT account_snapshots_user_id_account_id_snapshot_date_key
      UNIQUE (user_id, account_id, snapshot_date);
    `);

    // Drop index
    await client.query(`
      DROP INDEX IF EXISTS idx_account_snapshots_paper_trading;
    `);

    // Drop column
    await client.query(`
      ALTER TABLE account_snapshots
      DROP COLUMN IF EXISTS is_paper_trading;
    `);

    console.log('✅ Removed is_paper_trading column from account_snapshots table');

  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };
