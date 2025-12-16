const pool = require('../db');

/**
 * Migration: Add 'manual' to loss_limit_locks limit_type CHECK constraint
 * 
 * The original constraint only allowed 'daily' and 'trade', but the backend
 * code supports 'manual' lockouts. This migration updates the constraint.
 */

async function up() {
  const client = await pool.connect();
  try {
    console.log('Adding "manual" to loss_limit_locks limit_type constraint...');

    // First, find all CHECK constraints on this table that involve limit_type
    const constraintResult = await client.query(`
      SELECT conname, pg_get_constraintdef(oid) as definition
      FROM pg_constraint 
      WHERE conrelid = 'loss_limit_locks'::regclass 
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%limit_type%'
    `);

    // Drop all found constraints
    for (const row of constraintResult.rows) {
      const constraintName = row.conname;
      console.log(`Found constraint: ${constraintName} (${row.definition})`);
      
      try {
        await client.query(`
          ALTER TABLE loss_limit_locks 
          DROP CONSTRAINT IF EXISTS ${constraintName}
        `);
        console.log(`✅ Dropped constraint: ${constraintName}`);
      } catch (err) {
        console.warn(`⚠️  Could not drop constraint ${constraintName}:`, err.message);
      }
    }

    // Add the new constraint that includes 'manual'
    // Use IF NOT EXISTS pattern by checking first
    const existingCheck = await client.query(`
      SELECT conname 
      FROM pg_constraint 
      WHERE conrelid = 'loss_limit_locks'::regclass 
      AND conname = 'loss_limit_locks_limit_type_check'
    `);

    if (existingCheck.rows.length === 0) {
      await client.query(`
        ALTER TABLE loss_limit_locks 
        ADD CONSTRAINT loss_limit_locks_limit_type_check 
        CHECK (limit_type IN ('daily', 'trade', 'manual'))
      `);
      console.log('✅ Added new constraint with "manual" support');
    } else {
      console.log('✅ Constraint already exists with correct definition');
    }

    console.log('✅ Successfully updated loss_limit_locks limit_type constraint');
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
    console.log('Reverting loss_limit_locks limit_type constraint...');

    // Drop the new constraint
    await client.query(`
      ALTER TABLE loss_limit_locks 
      DROP CONSTRAINT IF EXISTS loss_limit_locks_limit_type_check
    `);

    // Re-add the old constraint (only 'daily' and 'trade')
    await client.query(`
      ALTER TABLE loss_limit_locks 
      ADD CONSTRAINT loss_limit_locks_limit_type_check 
      CHECK (limit_type IN ('daily', 'trade'))
    `);

    console.log('✅ Successfully reverted constraint');
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down };

