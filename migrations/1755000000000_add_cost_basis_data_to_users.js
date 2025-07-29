const pool = require('../db');

/**
 * Migration: Add cost basis data to users table
 * Adds a JSON field to store user-specific cost basis information for profit/loss calculations
 */

async function up() {
  const client = await pool.connect();
  
  try {
    console.log('Adding cost_basis_data column to users table...');
    
    await client.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS cost_basis_data JSONB DEFAULT '{}';
    `);
    
    // Create index for JSONB column for better query performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_cost_basis_data ON users USING GIN (cost_basis_data);
    `);
    
    console.log('✅ Successfully added cost_basis_data column to users table');
    
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
    console.log('Removing cost_basis_data column from users table...');
    
    // Remove index
    await client.query(`
      DROP INDEX IF EXISTS idx_users_cost_basis_data;
    `);
    
    // Remove column
    await client.query(`
      ALTER TABLE users 
      DROP COLUMN IF EXISTS cost_basis_data;
    `);
    
    console.log('✅ Successfully removed cost_basis_data column from users table');
    
  } catch (error) {
    console.error('❌ Error in rollback:', error);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { up, down }; 